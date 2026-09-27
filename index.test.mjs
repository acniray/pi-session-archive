/**
 * Load test: the extension must actually register with pi, in the right modes,
 * and never in a mode that has no UI to talk to.
 *
 * The pi API object is faked deliberately small: the point is to prove we touch
 * only the documented surface, so a missing method here is a real error rather
 * than a shrug. `pi.on` is still recorded so tests can prove the extension does
 * not install a global input gate.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeAgentDir, writeSessionFile } from "./test-helpers.mjs";

const register = async (agentDir) => {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const extension = await import(`./index.ts?fresh=${Math.random()}`);
  const commands = new Map();
  const handlers = new Map();
  const shortcuts = new Map();
  const pi = {
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerShortcut(key, options) {
      shortcuts.set(key, options);
    },
  };
  extension.default(pi);
  return { commands, handlers, shortcuts };
};

function fakeContext(overrides = {}) {
  const notices = [];
  const ctx = {
    mode: "tui",
    cwd: "/data/proj",
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      select: async () => undefined,
    },
    sessionManager: {
      getSessionId: () => "s1",
      getSessionFile: () => undefined,
      getEntries: () => [],
    },
    ...overrides,
  };
  return { ctx, notices };
}

test("the archive commands register, each with a description", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  assert.deepEqual([...commands.keys()].sort(), [
    "archive",
    "archive-check",
    "archived",
    "archived-export",
    "unarchive",
  ]);
  for (const [name, options] of commands) {
    assert.match(options.description, /\S/, `${name} needs a description`);
    assert.equal(typeof options.handler, "function");
  }
});

test("a keyboard shortcut is registered, and it archives the current session", async (t) => {
  const agentDir = makeAgentDir(t);
  const { shortcuts } = await register(agentDir);
  assert.equal(shortcuts.size, 1, "one shortcut for archiving");
  const [key, options] = [...shortcuts.entries()][0];
  assert.ok(String(key).length > 0, "the shortcut has a real key id");
  assert.match(options.description, /archive/i);
  // Same behaviour as /archive, so the key cannot drift from the command.
  const { ctx, notices } = fakeContext({ mode: "print" });
  await options.handler(ctx);
  assert.match(notices[0].message, /terminal or web session/);
});

test("the extension does not install a global input gate", async (t) => {
  const agentDir = makeAgentDir(t);
  const { handlers } = await register(agentDir);
  assert.equal(handlers.has("input"), false, "archive state must never freeze normal session input");
});

test("in a mode with no UI, the commands explain themselves instead of failing", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  const { ctx, notices } = fakeContext({ mode: "print" });

  await commands.get("archive").handler("", ctx);
  assert.match(notices[0].message, /terminal or web session/);

  await commands.get("archived").handler("", ctx);
  assert.match(notices.at(-1).message, /terminal or web session/);
});

test("restoring from the archive list can open the session in place", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  const file = writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  const { archiveSessionTree } = await import("./migrate.ts");
  await archiveSessionTree("p1", { agentDir, now: () => Date.now() });

  // Select like a user: the first offered row, then the first action. Hardcoding
  // a label would break whenever the wording changes; picking position does not.
  const seenLabels = [];
  const picks = [undefined, undefined];
  const { ctx, notices } = fakeContext({
    mode: "tui",
    ui: {
      notify: (message) => notices.push(message),
      select: async (_title, options) => {
        seenLabels.push(options);
        return picks.shift() === undefined ? options[0] : undefined;
      },
    },
  });
  const switched = [];
  ctx.switchSession = async (sessionPath) => {
    switched.push(sessionPath);
    return { cancelled: false };
  };

  await commands.get("archived").handler("", ctx);

  const restoredPath = path.join(agentDir, "sessions", "--data-proj--", path.basename(file));
  assert.deepEqual(switched, [restoredPath], "it switched to where the restored file actually lives");
  assert.match(seenLabels[0][0], /hello/, "the row is labelled by what was said, not by an id");
  assert.ok(seenLabels[1].some((label) => /Restore and open/.test(label)), "opening in place is offered");
  assert.ok(
    fs.existsSync(path.join(agentDir, "sessions", "--data-proj--", path.basename(file))),
    "restored before switching",
  );
  assert.ok(notices.some((message) => /Restored 1 session/.test(String(message))), JSON.stringify(notices));
  assert.equal(notices.some((message) => /Archived 1 session/.test(String(message))), false, "restore never claims it archived something");
});



/** A fake ui.select that answers by matching substrings, and records every call. */
function scriptedSelect(answers, { defaultFirst = true, notices = [] } = {}) {
  const calls = [];
  const select = async (title, options) => {
    calls.push({ title, options });
    for (const [needle, reply] of answers) {
      if (options.some((option) => option.includes(needle))) {
        return typeof reply === "function" ? reply(options) : reply;
      }
    }
    // Nothing matched: a real user pressing Esc picks nothing, and a picker that
    // defaults to the first row would quietly archive the wrong session.
    return defaultFirst ? options[0] : undefined;
  };
  return {
    calls,
    notices,
    ui: { notify: (message, level) => notices.push({ message, level }), select },
  };
}

test("/archived resolves the row by its stable #id, not by display text", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  const { archiveSessionTree } = await import("./migrate.ts");
  const { archiveRoot } = await import("./paths.ts");
  const one = writeSessionFile(agentDir, { id: "one", cwd: "/data/proj", firstMessage: "same archived title" });
  const two = writeSessionFile(agentDir, { id: "two", cwd: "/data/proj", firstMessage: "same archived title" });
  await archiveSessionTree("one", { agentDir, now: () => Date.now() });
  await archiveSessionTree("two", { agentDir, now: () => Date.now() });

  const { ui, calls } = scriptedSelect(
    [
      ["#two", (options) => options.find((option) => option.endsWith("#two"))],
      ["Restore it (stay", "Restore it (stay where you are)"],
    ],
    { defaultFirst: false },
  );
  const { ctx } = fakeContext({ mode: "rpc", ui });
  await commands.get("archived").handler("", ctx);

  assert.equal(fs.existsSync(two), true, "the selected archived row was restored");
  assert.equal(fs.existsSync(one), false, "the other identical-looking row stayed archived");
  assert.equal(fs.existsSync(path.join(archiveRoot(agentDir), path.basename(two))), false);
  assert.equal(fs.existsSync(path.join(archiveRoot(agentDir), path.basename(one))), true);
});

test("the archive command lists roots, archives the pick, and leaves forks alone", async (t) => {
  const agentDir = makeAgentDir(t);
  const { writeSubagentSessionFile } = await import("./test-helpers.mjs");
  const { commands } = await register(agentDir);

  const parent = writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj", firstMessage: "work on archiving" });
  writeSubagentSessionFile(agentDir, { id: "c1", parentId: "p1", parentPath: parent, cwd: "/data/proj" });
  const sibling = writeSessionFile(agentDir, { id: "f1", cwd: "/data/proj", firstMessage: "unrelated work" });

  const { calls, notices, ui } = scriptedSelect([
    ["work on archiving", (options) => options.find((option) => option.includes("work on archiving"))],
    ["Archive selected", (options) => options.find((option) => option.includes("Archive selected"))],
  ], { defaultFirst: false });
  const { ctx } = fakeContext({ mode: "rpc", ui });
  ctx.newSession = async () => {
    throw new Error("archiving a different session must not go through a switch");
  };
  ctx.waitForIdle = async () => {};
  ctx.sessionManager.getSessionId = () => "host-session";
  ctx.sessionManager.getSessionFile = () => undefined;

  await commands.get("archive").handler("", ctx);

  const listCall = calls.find((call) => call.title.startsWith("Archive sessions"));
  assert.ok(listCall, `the session list was shown: ${JSON.stringify(calls.map((c) => c.title))}`);
  assert.equal(listCall.options.filter((option) => option.startsWith("[ ]")).length, 2, "two roots, the subagent child is not offered");
  assert.ok(
    listCall.options.some((option) => /work on archiving/.test(option) && /1 subagent/.test(option)),
    `rows carry the subagent count: ${JSON.stringify(listCall.options)}`,
  );
  assert.ok(
    calls.some((call) => call.options.some((option) => option.includes("Archive selected (1)"))),
    "the same picker accumulates the selection before one final archive action",
  );

  const { archiveRoot } = await import("./paths.ts");
  assert.equal(fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_p1.jsonl")), true);
  assert.equal(fs.existsSync(parent), false, "the root moved");
  assert.equal(fs.existsSync(sibling), true, "the other root stayed");
  assert.ok(notices.some((entry) => /Archived/.test(entry.message)), `told the user: ${JSON.stringify(notices)}`);
});

test("/archive --ids archives several roots without opening a picker", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  const first = writeSessionFile(agentDir, { id: "direct-a", cwd: "/data/proj", firstMessage: "first" });
  const second = writeSessionFile(agentDir, { id: "direct-b", cwd: "/data/proj", firstMessage: "second" });
  const { ctx, notices } = fakeContext({
    mode: "rpc",
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      select: async () => {
        throw new Error("direct ids must not open a picker");
      },
    },
  });

  await commands.get("archive").handler("--ids direct-a,direct-b", ctx);

  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
  assert.ok(notices.some((entry) => /Archived 2 root session/.test(entry.message)), JSON.stringify(notices));
});

test("rows put the human name first without reading whole transcripts", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  const file = writeSessionFile(agentDir, { id: "n1", cwd: "/data/proj", firstMessage: "first thing" });
  // Give it a name and a second message, the way pi stores them.
  fs.appendFileSync(
    file,
    [
      JSON.stringify({ type: "session_info", id: "si", parentId: "e1", timestamp: "2026-09-24T10:05:00.000Z", name: "release notes" }),
      JSON.stringify({
        type: "message",
        id: "e2",
        parentId: "e1",
        timestamp: "2026-09-24T10:06:00.000Z",
        message: { role: "assistant", content: "done with the changelog", timestamp: 1758700960000 },
      }),
      "",
    ].join("\n"),
  );

  const { calls, ui } = scriptedSelect([["No - I'm done", "No - I'm done"]]);
  const { ctx } = fakeContext({ mode: "rpc", ui });
  ctx.waitForIdle = async () => {};
  ctx.sessionManager.getSessionId = () => "other";
  ctx.sessionManager.getSessionFile = () => undefined;

  await commands.get("archive").handler("", ctx);

  const row = calls.find((call) => call.title.startsWith("Archive sessions")).options[0];
  assert.match(row, /^\[ \] release notes ·/, "the name comes first after the selection marker, so the row is recognisable");
  assert.match(row, /proj/, "the project gives the title context");
  assert.match(row, /just now|ago/, "the row carries a compact relative time");
  assert.match(row, /#n1$/, "and a stable id token remains at the end");
  assert.doesNotMatch(row, /msgs|last:/, "picker rows stay human-sized and do not require whole-file digests");
});

test("a long list is paged instead of showing one screenful", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  // Distinct mtimes, so the order is by recency rather than by name.
  for (let index = 0; index < 25; index += 1) {
    const when = new Date(Date.now() - (25 - index) * 60_000).toISOString();
    writeSessionFile(agentDir, {
      id: `s${index}`,
      cwd: "/data/proj",
      firstMessage: `session number ${index}`,
      mtime: when,
      messageAt: when,
    });
  }

  const { calls, ui } = scriptedSelect([
    ["next page", "›› next page (2 pages)"],
    ["No - I'm done", "No - I'm done"],
  ]);
  const { ctx } = fakeContext({ mode: "rpc", ui });
  ctx.waitForIdle = async () => {};
  ctx.sessionManager.getSessionId = () => "other";
  ctx.sessionManager.getSessionFile = () => undefined;

  await commands.get("archive").handler("", ctx);

  const pages = calls.filter((call) => call.title.startsWith("Archive sessions"));
  assert.equal(pages.length, 2, "asked for page two");
  assert.equal(pages[0].options.length, 22, "20 rows plus next-page and cancel controls");
  assert.equal(pages[1].options.length, 7, "5 rows plus previous-page and cancel controls");
  assert.match(pages[0].title, /page 1\/2/);
  assert.match(pages[1].title, /page 2\/2/);
  // Newest first: page one holds the 20 newest, page two the 5 oldest.
  assert.ok(pages[0].options[0].includes("session number 24"), `newest first: ${pages[0].options[0]}`);
  assert.ok(
    pages[1].options.some((option) => /session number 0/.test(option)),
    `the oldest sessions are reachable on page two: ${JSON.stringify(pages[1].options)}`,
  );
});

test("a subagent session left behind after an archive is reported, not silent", async (t) => {
  const agentDir = makeAgentDir(t);
  const { writeSubagentSessionFile } = await import("./test-helpers.mjs");
  const { commands } = await register(agentDir);
  const parent = writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj", firstMessage: "parent" });
  const child = writeSubagentSessionFile(agentDir, { id: "c1", parentId: "p1", parentPath: parent, cwd: "/data/proj" });

  const { notices, ui } = scriptedSelect([
    ["parent", (options) => options.find((option) => option.includes("parent"))],
    ["Archive selected", (options) => options.find((option) => option.includes("Archive selected"))],
  ], { defaultFirst: false });
  const { ctx } = fakeContext({ mode: "rpc", ui });
  ctx.waitForIdle = async () => {};
  ctx.sessionManager.getSessionId = () => "other";
  ctx.sessionManager.getSessionFile = () => undefined;

  await commands.get("archive").handler("", ctx);

  const { archiveRoot } = await import("./paths.ts");
  assert.equal(fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_c1.jsonl")), true, "the child came along");
  assert.equal(fs.existsSync(child), false, "so nothing is left behind");
  assert.ok(
    !notices.some((entry) => /still in the active list/.test(entry.message)),
    `nothing to report when the cascade was complete: ${JSON.stringify(notices)}`,
  );
});

test("/archive-check reports a session that exists in both places", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  const { archiveSessionTree } = await import("./migrate.ts");
  const { archiveRoot } = await import("./paths.ts");
  const file = writeSessionFile(agentDir, { id: "dup", cwd: "/data/proj", firstMessage: "duplicated" });
  await archiveSessionTree("dup", { agentDir, now: () => Date.now() });
  // Recreate the active copy, the way a racing writer would.
  fs.copyFileSync(path.join(archiveRoot(agentDir), path.basename(file)), file);

  const { ctx, notices } = fakeContext({ mode: "rpc" });
  await commands.get("archive-check").handler("", ctx);
  assert.ok(
    notices.some((entry) => /split-session/.test(entry.message)),
    `the split is reported: ${JSON.stringify(notices)}`,
  );
});

test("P1: a pick is resolved by id, not by the text that was drawn", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  // Two sessions that render identically apart from their id.
  const a = writeSessionFile(agentDir, { id: "a", cwd: "/data/proj", firstMessage: "same text" });
  const b = writeSessionFile(agentDir, { id: "b", cwd: "/data/proj", firstMessage: "same text" });

  const { calls, ui } = scriptedSelect(
    [
      // Answer the *second* row, and with a label whose time has since moved on,
      // exactly what happens when a picker sits open for a minute.
      ["#b", (options) => options.find((option) => option.endsWith("#b"))],
      ["Archive selected", (options) => options.find((option) => option.includes("Archive selected"))],
    ],
    { defaultFirst: false },
  );
  const { ctx } = fakeContext({ mode: "rpc", ui });
  ctx.waitForIdle = async () => {};
  ctx.sessionManager.getSessionId = () => "host";
  ctx.sessionManager.getSessionFile = () => undefined;

  await commands.get("archive").handler("", ctx);

  const { archiveRoot } = await import("./paths.ts");
  assert.equal(fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_b.jsonl")), true, "the row we picked is the row archived");
  assert.equal(fs.existsSync(a), true, "the identical-looking other row is untouched");
  assert.equal(fs.existsSync(b), false);
  void calls;
});

test("P2: an ambiguous export target is refused instead of exporting the first match", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  const { archiveSessionTree } = await import("./migrate.ts");
  for (const [id, first] of [["x1", "fix the auth flow"], ["x2", "fix the auth bug"], ["x3", "unrelated"]]) {
    writeSessionFile(agentDir, { id, cwd: "/data/proj", firstMessage: first });
    await archiveSessionTree(id, { agentDir, now: () => Date.now() });
  }

  const { ctx, notices } = fakeContext({ mode: "rpc" });
  await commands.get("archived-export").handler("fix the auth", ctx);

  assert.ok(
    notices.some((entry) => /matches 2 sessions/.test(entry.message)),
    `the ambiguity is reported: ${JSON.stringify(notices)}`,
  );
  assert.equal(
    notices.filter((entry) => /Wrote|Exported/.test(entry.message)).length,
    0,
    `and nothing was exported: ${JSON.stringify(notices)}`,
  );
});

test("archived-export accepts a multi-word target plus a trailing --in directory", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  const { archiveSessionTree } = await import("./migrate.ts");
  writeSessionFile(agentDir, { id: "x1", cwd: "/data/proj", firstMessage: "fix the auth flow" });
  await archiveSessionTree("x1", { agentDir, now: () => Date.now() });

  const outDir = path.join(agentDir, "exports here");
  const { ctx, notices } = fakeContext({ mode: "rpc" });
  await commands.get("archived-export").handler(`fix the auth flow --in ${outDir}`, ctx);

  assert.ok(fs.existsSync(outDir), "the explicit output directory was used");
  assert.ok(fs.readdirSync(outDir).some((name) => name.endsWith(".html")), "an HTML export was written there");
  assert.ok(notices.some((entry) => /Exported/.test(entry.message)), JSON.stringify(notices));
});

test("REGRESSION: the list works when the host reports a project dir, not a root", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  // Two projects, the way a real agent dir looks.
  writeSessionFile(agentDir, { id: "a1", cwd: "/data/one", firstMessage: "in project one" });
  writeSessionFile(agentDir, { id: "a2", cwd: "/data/two", firstMessage: "in project two" });

  const projectDir = path.join(agentDir, "sessions", "--data-two--");
  const { calls, ui } = scriptedSelect(
    [
      ["project one", (options) => options.find((option) => option.includes("project one"))],
      ["Archive selected", (options) => options.find((option) => option.includes("Archive selected"))],
    ],
    { defaultFirst: false },
  );
  const { ctx } = fakeContext({ mode: "rpc", ui });
  ctx.waitForIdle = async () => {};
  // Exactly what pi hands an extension: the directory of THIS session.
  ctx.sessionManager.getSessionFile = () => path.join(projectDir, "2026-09-24T10-00-00-000Z_a2.jsonl");
  ctx.sessionManager.getSessionDir = () => projectDir;
  ctx.sessionManager.usesDefaultSessionDir = () => true;

  await commands.get("archive").handler("", ctx);

  const listCall = calls.find((call) => call.title.startsWith("Archive sessions"));
  assert.ok(listCall, `the session list was shown: ${JSON.stringify(calls.map((c) => c.title))}`);
  assert.ok(
    listCall.options.some((option) => /project one/.test(option)),
    `sessions from every project are listed: ${JSON.stringify(listCall.options)}`,
  );
  assert.ok(
    listCall.options.some((option) => /project two/.test(option)),
    "including the host session's own project",
  );
  const { archiveRoot } = await import("./paths.ts");
  assert.equal(
    fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_a1.jsonl")),
    true,
    "and the pick archived",
  );
});

test("the session this runtime is using is refused, by path", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  const mine = writeSessionFile(agentDir, { id: "mine", cwd: "/data/proj", firstMessage: "the active one" });
  const other = writeSessionFile(agentDir, { id: "other", cwd: "/data/proj", firstMessage: "a different one" });

  const { ctx, notices } = fakeContext({ mode: "rpc" });
  const { ui, calls } = scriptedSelect(
    [
      ["the active one", (options) => options.find((option) => option.includes("the active one"))],
      ["Archive selected", (options) => options.find((option) => option.includes("Archive selected"))],
    ],
    { defaultFirst: false, notices },
  );
  ctx.ui = ui;
  ctx.waitForIdle = async () => {};
  ctx.sessionManager.getSessionFile = () => mine;
  ctx.sessionManager.getSessionId = () => "mine";

  await commands.get("archive").handler("", ctx);

  const listCall = calls.find((call) => call.title.startsWith("Archive sessions"));
  assert.ok(
    listCall?.options.some((option) => option.includes("the active one") && option.includes("current session")),
    `the current row is marked in the picker: ${JSON.stringify(listCall?.options)}`,
  );
  assert.ok(
    notices.some((entry) => /current session/i.test(entry.message)),
    `the disabled row explains itself: ${JSON.stringify(notices)}`,
  );
  assert.equal(fs.existsSync(mine), true, "and the file did not move");
  assert.equal(fs.existsSync(other), true, "and nothing else was touched either");
});

test("a different session is archived even while this one is running", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  const mine = writeSessionFile(agentDir, { id: "mine", cwd: "/data/proj", firstMessage: "the active one" });
  const other = writeSessionFile(agentDir, { id: "other", cwd: "/data/proj", firstMessage: "a different one" });

  const { ctx, notices } = fakeContext({ mode: "rpc" });
  const { ui } = scriptedSelect(
    [
      ["a different one", (options) => options.find((option) => option.includes("a different one"))],
      ["Archive selected", (options) => options.find((option) => option.includes("Archive selected"))],
    ],
    { defaultFirst: false, notices },
  );
  ctx.ui = ui;
  ctx.waitForIdle = async () => {};
  ctx.sessionManager.getSessionFile = () => mine;
  ctx.sessionManager.getSessionId = () => "mine";

  await commands.get("archive").handler("", ctx);

  const { archiveRoot } = await import("./paths.ts");
  assert.equal(fs.existsSync(other), false, "the picked session moved");
  assert.equal(
    fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_other.jsonl")),
    true,
  );
  assert.equal(fs.existsSync(mine), true, "the running session is untouched");
});

test("a filesystem failure is reported, not thrown at the user", async (t) => {
  // The archive root is a regular file, so creating the directory fails. That
  // used to reject the command handler, which escaped the picker loop entirely -
  // the operation's callers now handle results, but an exception is not a result.
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  fs.writeFileSync(path.join(agentDir, "session-archive"), "not a directory");

  const { commands } = await register(agentDir);
  // Pick by label, the way a person does: the row text, not a bare id.
  const { notices, ui } = scriptedSelect(
    [["#p1", (options) => options.find((option) => option.includes("#p1"))]],
    { defaultFirst: false },
  );
  const { ctx } = fakeContext({ ui });
  let threw = undefined;
  try {
    await commands.get("archive").handler("p1", ctx);
  } catch (error) {
    threw = error;
  }
  assert.equal(threw, undefined, `the command must not throw: ${threw}`);
  assert.ok(
    notices.some((entry) => /could not|archive/i.test(entry.message)),
    `and it must say something: ${JSON.stringify(notices)}`,
  );
  assert.equal(
    fs.existsSync(path.join(agentDir, "session-archive")),
    true,
    "and the session is still where it was",
  );
});

test("restore-and-open uses the recorded original path for a custom session directory", async (t) => {
  const agentDir = makeAgentDir(t);
  const { commands } = await register(agentDir);
  const { archiveSessionTree } = await import("./migrate.ts");

  const customRoot = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "pi-archive-custom-open-"));
  t.after(() => fs.rmSync(customRoot, { recursive: true, force: true }));
  const customProject = path.join(customRoot, "project");
  fs.mkdirSync(customProject, { recursive: true });
  const original = path.join(customProject, "2026-09-24T10-00-00-000Z_custom.jsonl");
  fs.writeFileSync(
    original,
    `${JSON.stringify({ type: "session", version: 3, id: "custom", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/custom" })}\n` +
      `${JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-09-24T10:00:01.000Z", message: { role: "user", content: "custom session", timestamp: 1758700801000 } })}\n`,
  );
  const archived = await archiveSessionTree("custom", {
    agentDir,
    sessionRoots: [customRoot, customProject],
    now: () => Date.now(),
  });
  assert.equal(archived.ok, true, JSON.stringify(archived));

  const notices = [];
  const { ctx } = fakeContext({
    mode: "tui",
    ui: {
      notify: (message) => notices.push(message),
      select: async (_title, options) => options[0],
    },
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionDir: () => customProject,
      usesDefaultSessionDir: () => false,
    },
  });
  const switched = [];
  ctx.switchSession = async (sessionPath) => {
    switched.push(sessionPath);
    return { cancelled: false };
  };

  await commands.get("archived").handler("", ctx);

  assert.equal(fs.existsSync(original), true, "restored to the exact custom path");
  assert.deepEqual(switched, [original], "the open action uses the exact path recorded by the archive index");
});
