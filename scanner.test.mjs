import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeAgentDir, projectDirFor, writeSessionFile, writeSubagentSessionFile } from "./test-helpers.mjs";

const {
  classifySessionFile,
  collectSubagentTree,
  buildRelationGraph,
  readSubagentMeta,
  scanSessionRoot,
} = await import("./scanner.ts");
const { archiveRoot, sessionsRoot } = await import("./paths.ts");

test("a well-formed session is classified with id and cwd from its header", async (t) => {
  const agentDir = makeAgentDir(t);
  const file = writeSessionFile(agentDir, { id: "s1", cwd: "/data/proj" });
  const { info, problem } = classifySessionFile(file);
  assert.equal(problem, undefined);
  assert.equal(info.id, "s1");
  assert.equal(info.cwd, "/data/proj");
  assert.equal(info.idFromFileName, false);
});

test("latest session_info from the tail wins, without turning rename time into activity", async (t) => {
  const agentDir = makeAgentDir(t);
  const conversationAt = "2026-09-04T10:00:00.000Z";
  const renameAt = "2026-09-26T19:23:58.411Z";
  const file = writeSessionFile(agentDir, {
    id: "renamed",
    cwd: "/data/proj",
    firstMessage: "original title",
    messageAt: conversationAt,
    mtime: conversationAt,
  });

  // Push the later session_info well beyond the old 64KB head window.
  fs.appendFileSync(
    file,
    [
      JSON.stringify({
        type: "message",
        id: "tool-noise",
        parentId: "e1",
        timestamp: "2026-09-04T10:00:01.000Z",
        message: { role: "toolResult", content: "x".repeat(80_000), timestamp: Date.parse(conversationAt) + 1_000 },
      }),
      JSON.stringify({
        type: "session_info",
        id: "rename-entry",
        parentId: "tool-noise",
        timestamp: renameAt,
        name: "补齐充值记录确认到账功能C1",
      }),
      "",
    ].join("\n"),
  );

  const renameTime = new Date(renameAt);
  fs.utimesSync(file, renameTime, renameTime);

  const { info, problem } = classifySessionFile(file);
  assert.equal(problem, undefined);
  assert.equal(info.name, "补齐充值记录确认到账功能C1");
  assert.equal(
    info.mtimeMs,
    Date.parse(conversationAt),
    "a later session_info/file mtime must not make an old conversation look recent",
  );
});

test("the newest session_info entry wins when a session is renamed more than once", async (t) => {
  const agentDir = makeAgentDir(t);
  const file = writeSessionFile(agentDir, { id: "rename-chain", cwd: "/data/proj" });
  fs.appendFileSync(
    file,
    [
      JSON.stringify({ type: "session_info", id: "n1", parentId: "e1", timestamp: "2026-09-25T10:00:00.000Z", name: "old name" }),
      JSON.stringify({ type: "session_info", id: "n2", parentId: "n1", timestamp: "2026-09-25T11:00:00.000Z", name: "new name" }),
      "",
    ].join("\n"),
  );

  const { info } = classifySessionFile(file);
  assert.equal(info.name, "new name");
});

test("a headerless fragment is reported, not silently dropped", async (t) => {
  const agentDir = makeAgentDir(t);
  const dir = path.join(archiveRoot(agentDir));
  fs.mkdirSync(dir, { recursive: true });
  // What a split write actually leaves behind: a bare entry, no session header.
  const fragment = path.join(dir, "2026-09-24T11-00-00-000Z_frag.jsonl");
  fs.writeFileSync(fragment, `${JSON.stringify({ type: "message", id: "e9", parentId: "e8" })}\n`);

  const { info, problem } = classifySessionFile(fragment);
  assert.equal(info, undefined);
  assert.equal(problem.kind, "headerless");

  // And the same file must be invisible to pi's own listing, which is exactly
  // why this module exists: it must not depend on SessionManager.list*.
  const { sessions, problems, complete } = scanSessionRoot(archiveRoot(agentDir), { flat: true });
  assert.equal(sessions.length, 0);
  assert.equal(problems.length, 1);
  // A fragment must be reported, but it must not freeze every operation. It
  // cannot hide a child session: it has no header and therefore no parent link,
  // and it is not a session anything can resume. Only a file we could not
  // *enumerate* can hide one - see the unreadable test below.
  assert.equal(complete, true);
  assert.equal(problems[0].severity, "advisory");
});

test("a file we cannot enumerate still makes the scan incomplete", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "s1", cwd: "/data/proj" });
  // A root that is a file, not a directory: readdir fails with ENOTDIR, which is
  // not the "nothing archived yet" case. The listing may be missing sessions.
  const notADir = path.join(agentDir, "sessions", "not-a-dir");
  fs.writeFileSync(notADir, "");
  const result = scanSessionRoot(notADir);
  assert.equal(result.complete, false);
  assert.equal(result.problems[0].kind, "unreadable");
  assert.equal(result.problems[0].severity, "blocking");
});

test("a header whose id disagrees with the file name is reported", async (t) => {
  const agentDir = makeAgentDir(t);
  const file = writeSessionFile(agentDir, { id: "s1" });
  const tampered = path.join(path.dirname(file), "2026-09-24T10-00-00-000Z_other.jsonl");
  fs.writeFileSync(tampered, fs.readFileSync(file, "utf8"));
  const { info, problem } = classifySessionFile(tampered);
  assert.equal(problem.kind, "id-mismatch");
  // The header is trustworthy even when the file name is not, so the session
  // is still listed - under the id pi will use to open it. Dropping it from the
  // listing is how a cascade would silently leave a real child behind.
  assert.equal(info.id, "s1");
  assert.equal(problem.severity, "advisory");
  const dir = path.dirname(tampered);
  const { sessions, problems, complete } = scanSessionRoot(dir, { flat: true });
  // Both files carry the header id `s1`; each is listed under it.
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((entry) => entry.id), ["s1", "s1"]);
  assert.equal(problems.length, 1);
  assert.equal(complete, true);
});

test("scanning finds the active layout and the flat archive layout", async (t) => {
  const agentDir = makeAgentDir(t);
  writeSessionFile(agentDir, { id: "a1", cwd: "/data/one" });
  writeSessionFile(agentDir, { id: "a2", cwd: "/data/two" });
  const archived = writeSessionFile(agentDir, { id: "z9", root: "archive" });

  const active = scanSessionRoot(sessionsRoot(agentDir));
  assert.equal(active.complete, true);
  assert.deepEqual(active.sessions.map((s) => s.id).sort(), ["a1", "a2"]);

  const archive = scanSessionRoot(archiveRoot(agentDir), { flat: true });
  assert.deepEqual(archive.sessions.map((s) => s.id), ["z9"]);
  assert.equal(archive.sessions[0].path, archived);
});

test("a missing root is empty-but-complete, an unreadable one is not", async (t) => {
  const agentDir = makeAgentDir(t);

  // Nothing archived yet is a normal state, not a problem.
  const missing = scanSessionRoot(path.join(agentDir, "does-not-exist"));
  assert.equal(missing.complete, true);
  assert.equal(missing.sessions.length, 0);

  // A root we cannot read is different: the listing may be short.
  // Deliberately not done with chmod 000 - root ignores permission bits, so that
  // version of this test passes for the wrong reason in a container.
  const broken = path.join(agentDir, "not-a-directory");
  fs.writeFileSync(broken, "I am a file where a sessions root should be\n");
  const result = scanSessionRoot(broken);
  assert.equal(result.complete, false, "a root that is not a directory cannot be listed");
  assert.equal(result.problems.at(0).kind, "unreadable");
});

test("subagent relation is read from the pi-web:subagent entry", async (t) => {
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  const child = writeSubagentSessionFile(agentDir, { id: "c1", parentId: "p1", parentPath: parent });

  const meta = await readSubagentMeta(child);
  assert.equal(meta.kind, "meta");
  assert.equal(meta.meta.parentSessionId, "p1");
  const noRelation = await readSubagentMeta(parent);
  assert.equal(noRelation.kind, "none");
  const missing = await readSubagentMeta(path.join(agentDir, "nope.jsonl"));
  assert.equal(missing.kind, "unreadable");
});

test("the descendant set is cascade-ordered and survives a move", async (t) => {
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  writeSubagentSessionFile(agentDir, { id: "c1", parentId: "p1", parentPath: parent });
  writeSubagentSessionFile(agentDir, { id: "c2", parentId: "c1", parentPath: parent });
  // A fork sibling: no relation entry, so it must never be dragged along.
  const forked = writeSessionFile(agentDir, { id: "f1", cwd: "/data/proj" });
  fs.writeFileSync(
    forked,
    `${fs.readFileSync(forked, "utf8").split("\n")[0]}\n${JSON.stringify({
      type: "session_info",
      id: "si",
      parentId: null,
      timestamp: "2026-09-24T10:00:03.000Z",
      name: "forked",
    })}\n`,
  );

  const { sessions } = scanSessionRoot(sessionsRoot(agentDir));
  const tree = await collectSubagentTree("p1", sessions);

  assert.equal(tree.complete, true);
  // True post-order: a parent never precedes its own descendants, and the root
  // is last. An interrupted archive must not leave a parent archived while a
  // child is still active.
  assert.deepEqual(tree.descendantsFirst, ["c2", "c1", "p1"]);
  assert.equal(tree.descendantsFirst.at(-1), "p1");
  // Restore order is a true pre-order: root first, and at every level a parent
  // before its own children.
  assert.deepEqual(tree.rootFirst, ["p1", "c1", "c2"]);
  assert.ok(!tree.descendantsFirst.includes("f1"));
  assert.ok(!tree.rootFirst.includes("f1"));
});

test("a parent/child cycle terminates instead of looping", async (t) => {
  const agentDir = makeAgentDir(t);
  const a = writeSubagentSessionFile(agentDir, { id: "a", parentId: "b", parentPath: "/x" });
  writeSubagentSessionFile(agentDir, { id: "b", parentId: "a", parentPath: a });
  const { sessions } = scanSessionRoot(sessionsRoot(agentDir));
  const tree = await collectSubagentTree("a", sessions);
  assert.deepEqual([...tree.descendantsFirst].sort(), ["a", "b"]);
});

test("an unreadable child file marks the tree incomplete", async (t) => {
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  const child = writeSubagentSessionFile(agentDir, { id: "c1", parentId: "p1", parentPath: parent });
  const { sessions } = scanSessionRoot(sessionsRoot(agentDir));
  fs.rmSync(child);
  // Re-read one stale info whose file is gone, to model a file that disappeared.
  const tree = await collectSubagentTree("p1", sessions);
  assert.equal(tree.complete, false);
  assert.equal(tree.problems.length, 1);
});

test("a relation entry larger than the head is still read, because a line is not cut in half", async (t) => {
  // pi-web writes the whole task, the prompt plan and the tool list into the
  // relation entry, and none of those have a length limit. So the entry's JSON
  // *line* can be far past the head window even though the entry itself is the
  // second line of the file. Reading a fixed prefix and parsing it as a line
  // silently found nothing, and the child was then archived away from under its
  // parent.
  const agentDir = makeAgentDir(t);
  const parent = writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  const child = path.join(projectDirFor(agentDir, "/data/proj"), "2026-09-24T10-00-00-000Z_child.jsonl");
  fs.writeFileSync(
    child,
    [
      JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" }),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-09-24T10:00:00.000Z", message: { role: "user", content: "go", timestamp: 1 } }),
      // ~600KB of task text inside the relation entry itself.
      JSON.stringify({
        type: "custom",
        id: "meta1",
        parentId: "e1",
        timestamp: "2026-09-24T10:00:02.000Z",
        customType: "pi-web:subagent",
        data: { version: 1, parentSessionId: "p1", parentSessionPath: parent, task: "T".repeat(600_000) },
      }),
      // ...and a file past the old 1MB streaming ceiling, which is what turned
      // "we did not look that far" into "this session has no parent".
      JSON.stringify({ type: "message", id: "e2", parentId: "meta1", timestamp: 1, message: { role: "assistant", content: "P".repeat(1_200_000), timestamp: 1 } }),
    ].join("\n") + "\n",
  );
  assert.ok(fs.statSync(child).size > 1024 * 1024, "past the old streaming ceiling");

  const found = await readSubagentMeta(child);
  assert.equal(found.kind, "meta", `expected the relation to be found: ${JSON.stringify(found)}`);
  assert.equal(found.meta.parentSessionId, "p1");
});

test("an unreadable line inside the window leaves the session unknown", async (t) => {
  // If we stop looking before the entry, "not found" is not an answer - it is
  // the absence of one, and it must not be reported as a session with no parent.
  const agentDir = makeAgentDir(t);
  const big = path.join(projectDirFor(agentDir, "/data/proj"), "2026-09-24T10-00-00-000Z_big.jsonl");
  fs.mkdirSync(path.dirname(big), { recursive: true });
  fs.writeFileSync(
    big,
    [
      JSON.stringify({ type: "session", version: 3, id: "big", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" }),
      // A first line past the 8MB per-line cap: we refuse to read it, and the
      // lines after it are then unseen. "Unknown", not "no relation".
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: 1, message: { role: "user", content: "x".repeat(9_000_000), timestamp: 1 } }),
    ].join("\n") + "\n",
  );
  const found = await readSubagentMeta(big);
  assert.equal(found.kind, "unverified", "not a verdict we may act on");

  // And a long line *inside* the cap is read like any other: size alone is not
  // a verdict, it is only a reason to stop reading.
  const readable = path.join(path.dirname(big), "2026-09-24T10-00-00-000Z_readable.jsonl");
  fs.writeFileSync(
    readable,
    [
      JSON.stringify({ type: "session", version: 3, id: "readable", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" }),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: 1, message: { role: "user", content: "x".repeat(3_000_000), timestamp: 1 } }),
    ].join("\n") + "\n",
  );
  assert.equal((await readSubagentMeta(readable)).kind, "none", "read within the cap: no relation");
});

test("a long header line is read whole, and one past the cap stays unknown", async (t) => {
  // Cutting the header mid-line and calling the file malformed would drop a real
  // session from the listing - the same trap as the relation entry, one line
  // earlier. Past the cap we do not classify it either way: unknown, and unknown
  // blocks a cascade.
  const agentDir = makeAgentDir(t);
  const dir = projectDirFor(agentDir, "/data/proj");
  fs.mkdirSync(dir, { recursive: true });
  const header = (id, padding) =>
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-09-24T10:00:00.000Z",
      cwd: "/data/proj",
      ...(padding ? { padding } : {}),
    });
  const message = `${JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: 1, message: { role: "user", content: "hi", timestamp: 1 } })}\n`;

  // Long, but inside the cap: read whole, and the session is a session.
  const long = path.join(dir, "2026-09-24T10-00-00-000Z_long.jsonl");
  fs.writeFileSync(long, `${header("long", "H".repeat(200_000))}\n${message}`);
  const longResult = classifySessionFile(long);
  assert.equal(longResult.problem, undefined, `a long header is not corruption: ${JSON.stringify(longResult.problem)}`);
  assert.equal(longResult.info?.id, "long");

  // Past the cap: not a session, not a non-session - unknown, and blocking.
  const huge = path.join(dir, "2026-09-24T10-00-00-000Z_huge.jsonl");
  fs.writeFileSync(huge, `${header("huge", "H".repeat(2_000_000))}\n${message}`);
  const hugeResult = classifySessionFile(huge);
  assert.equal(hugeResult.info, undefined);
  assert.equal(hugeResult.problem?.kind, "header-oversized");
  assert.equal(hugeResult.problem?.severity, "blocking");
});

test("a marker quoted in an ordinary message is not a relation, and does not block", async (t) => {
  // The sentence travels: a user or a tool quoting the entry's own text must not
  // turn every archive on this machine into "the listing is unknowable".
  const agentDir = makeAgentDir(t);
  const bystander = writeSessionFile(agentDir, { id: "bystander", cwd: "/data/other" });
  fs.appendFileSync(
    bystander,
    `${JSON.stringify({
      type: "message",
      id: "q1",
      parentId: "e1",
      timestamp: 1,
      message: {
        role: "user",
        content: 'why does {"type":"custom","customType":"pi-web:subagent","data":{"version":1}} show up?',
        timestamp: 1,
      },
    })}\n`,
  );
  assert.equal((await readSubagentMeta(bystander)).kind, "none", "a quote is not a declaration");
  const { sessions } = scanSessionRoot(sessionsRoot(agentDir));
  assert.equal((await buildRelationGraph(sessions)).readable, true);
});

test("the relation is looked for in the first four lines, and that is the contract", async (t) => {
  const agentDir = makeAgentDir(t);
  fs.mkdirSync(projectDirFor(agentDir, "/data/proj"), { recursive: true });
  const onLine4 = path.join(projectDirFor(agentDir, "/data/proj"), "2026-09-24T10-00-00-000Z_four.jsonl");
  const lines = [JSON.stringify({ type: "session", version: 3, id: "four", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" })];
  for (let i = 0; i < 2; i += 1) {
    lines.push(JSON.stringify({ type: "message", id: `m${i}`, parentId: null, timestamp: 1, message: { role: "user", content: "x", timestamp: 1 } }));
  }
  lines.push(JSON.stringify({ type: "custom", id: "meta1", parentId: "e1", timestamp: 2, customType: "pi-web:subagent", data: { version: 1, parentSessionId: "p1" } }));
  fs.writeFileSync(onLine4, lines.join("\n") + "\n");
  assert.equal((await readSubagentMeta(onLine4)).kind, "meta", "fourth line is inside the window");

  // A fifth line is outside the window, and the contract says the entry is never
  // written there - so this is a definite "no relation", not an unknown. The
  // contrast matters: a line *inside* the window that cannot be read leaves the
  // session unknown and refuses, and that is a different answer.
  const onLine5 = path.join(projectDirFor(agentDir, "/data/proj"), "2026-09-24T10-00-00-000Z_five.jsonl");
  // One more message pushes the relation entry onto line 5.
  fs.writeFileSync(
    onLine5,
    [
      lines[0],
      ...lines.slice(1, 3),
      JSON.stringify({ type: "message", id: "m9", parentId: null, timestamp: 1, message: { role: "user", content: "y", timestamp: 1 } }),
      lines[3],
    ].join("\n") + "\n",
  );
  assert.equal((await readSubagentMeta(onLine5)).kind, "none", "outside the window means no relation, by contract");
});

test("a line past the per-line cap is unknown, not 'no relation'", async (t) => {
  // Bound the memory, not the verdict: a single enormous line is not something we
  // can scan, and scanning nothing is not a proof.
  const agentDir = makeAgentDir(t);
  const huge = path.join(projectDirFor(agentDir, "/data/proj"), "2026-09-24T10-00-00-000Z_huge.jsonl");
  fs.mkdirSync(path.dirname(huge), { recursive: true });
  fs.writeFileSync(
    huge,
    [
      JSON.stringify({ type: "session", version: 3, id: "huge", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" }),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: 1, message: { role: "user", content: "Z".repeat(12_000_000), timestamp: 1 } }),
    ].join("\n") + "\n",
  );
  assert.equal((await readSubagentMeta(huge)).kind, "unverified");
});

test("two relations in one file are a conflict, not a first-wins answer", async (t) => {
  // Returning the first one cannot establish uniqueness, and a child with two
  // parents is exactly the case a cascade must not guess about.
  const agentDir = makeAgentDir(t);
  const file = path.join(projectDirFor(agentDir, "/data/proj"), "2026-09-24T10-00-00-000Z_two.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const meta = (id, parent) =>
    JSON.stringify({ type: "custom", id, parentId: "e1", timestamp: 2, customType: "pi-web:subagent", data: { version: 1, parentSessionId: parent } });
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", version: 3, id: "two", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" }),
      meta("m1", "p1"),
      meta("m2", "p2"),
    ].join("\n") + "\n",
  );
  const found = await readSubagentMeta(file);
  assert.equal(found.kind, "meta");
  assert.deepEqual(found.conflicts, ["p2"], "both parents are reported");
});

test("the window reads four lines and stops, and the cap is enforced while reading", async (t) => {
  // Resource behaviour, measured rather than asserted from the result kind: a
  // result of `none` is compatible with having read the whole file, and the
  // earlier implementation did exactly that - it pulled a fifth line of 20MB
  // through readline before checking anything, and buffered a whole 8MB+ line
  // before comparing it to the cap.
  const dir = projectDirFor(makeAgentDir(t), "/data/proj");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "2026-09-24T10-00-00-000Z_measured.jsonl");
  const line = (id, size) =>
    `${JSON.stringify({ type: "message", id, parentId: null, timestamp: 1, message: { role: "user", content: "x".repeat(size), timestamp: 1 } })}\n`;
  fs.writeFileSync(
    file,
    [
      `${JSON.stringify({ type: "session", version: 3, id: "measured", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" })}\n`,
      line("a", 10),
      line("b", 10),
      line("c", 10),
      // A fifth line the window must never reach.
      line("fifth", 20_000_000),
    ].join(""),
  );

  /** A real advancing reader, counting what it hands over. */
  const counting = (onBytes) => (target, chunkBytes) => {
    const fd = fs.openSync(target, "r");
    let position = 0;
    return (function* () {
      try {
        const buffer = Buffer.allocUnsafe(chunkBytes);
        for (;;) {
          const read = fs.readSync(fd, buffer, 0, chunkBytes, position);
          if (read <= 0) return;
          position += read;
          onBytes(read);
          yield buffer.subarray(0, read);
        }
      } finally {
        fs.closeSync(fd);
      }
    })();
  };
  let served = 0;
  const result = await readSubagentMeta(file, { readChunks: counting((n) => (served += n)) });
  assert.equal(result.kind, "none");

  // The same four lines, with a fifth line of one byte instead of 20MB. What the
  // window costs must not depend on the size of a line it never reads: both runs
  // stop at the same chunk.
  const small = path.join(dir, "2026-09-24T10-00-00-000Z_small.jsonl");
  fs.writeFileSync(
    small,
    [
      `${JSON.stringify({ type: "session", version: 3, id: "measured", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" })}\n`,
      line("a", 10),
      line("b", 10),
      line("c", 10),
      line("fifth", 1),
    ].join(""),
  );
  let servedSmall = 0;
  assert.equal((await readSubagentMeta(small, { readChunks: counting((n) => (servedSmall += n)) })).kind, "none");
  // One chunk is the most the window can cost, whatever follows it: 64KB against
  // a 20MB fifth line, and a whole short file in the other case.
  assert.ok(served <= 64 * 1024, `read ${served} bytes with a 20MB fifth line; the window must not chase it`);
  assert.ok(servedSmall <= 64 * 1024, `read ${servedSmall} bytes for the small file`);
  assert.ok(served < fs.statSync(file).size / 100, `read ${served} of ${fs.statSync(file).size} bytes`);

  // And a line longer than the cap stops the read *at* the cap rather than after
  // materialising the whole thing.
  const huge = path.join(dir, "2026-09-24T10-00-00-000Z_huge.jsonl");
  fs.writeFileSync(
    huge,
    [
      `${JSON.stringify({ type: "session", version: 3, id: "huge", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" })}\n`,
      line("big", 20_000_000),
    ].join(""),
  );
  let servedHuge = 0;
  const capped = await readSubagentMeta(huge, { readChunks: counting((n) => (servedHuge += n)) });
  assert.equal(capped.kind, "unverified", "a line past the cap is unknown");
  assert.ok(servedHuge <= 9 * 1024 * 1024, `read ${servedHuge} bytes; the cap must bound the read, not the verdict`);
});

test("a relation entry on the final line is read even without a trailing newline", async (t) => {
  const dir = projectDirFor(makeAgentDir(t), "/data/proj");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "2026-09-24T10-00-00-000Z_eof-child.jsonl");
  const header = JSON.stringify({ type: "session", version: 3, id: "eof-child", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" });
  const relation = JSON.stringify({
    type: "custom",
    id: "meta",
    parentId: null,
    timestamp: "2026-09-24T10:00:01.000Z",
    customType: "pi-web:subagent",
    data: { version: 1, parentSessionId: "parent-eof" },
  });
  fs.writeFileSync(file, `${header}\n${relation}`);

  const found = await readSubagentMeta(file);
  assert.equal(found.kind, "meta");
  assert.equal(found.meta.parentSessionId, "parent-eof");
});

test("a multibyte relation value survives a UTF-8 split between chunks", async (t) => {
  const dir = projectDirFor(makeAgentDir(t), "/data/proj");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "2026-09-24T10-00-00-000Z_utf-child.jsonl");
  const content = [
    JSON.stringify({ type: "session", version: 3, id: "utf-child", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" }),
    JSON.stringify({
      type: "custom",
      id: "meta",
      parentId: null,
      timestamp: "2026-09-24T10:00:01.000Z",
      customType: "pi-web:subagent",
      data: { version: 1, parentSessionId: "父会话" },
    }),
  ].join("\n") + "\n";
  fs.writeFileSync(file, content);

  const bytes = Buffer.from(content, "utf8");
  const multibyte = bytes.indexOf(Buffer.from("父", "utf8"));
  assert.ok(multibyte >= 0);
  const splitReader = () => [bytes.subarray(0, multibyte + 1), bytes.subarray(multibyte + 1)];

  const found = await readSubagentMeta(file, { readChunks: splitReader });
  assert.equal(found.kind, "meta");
  assert.equal(found.meta.parentSessionId, "父会话");
});
