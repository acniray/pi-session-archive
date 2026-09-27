import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertUnchanged, makeAgentDir, snapshot, writeSessionFile } from "./test-helpers.mjs";

const { escapeHtml, exportArchivedSessionHtml, readExport, renderHtml } = await import("./export-html.ts");
const { readSessionNoWrite } = await import("./reader.ts");
const { archiveSessionTree } = await import("./migrate.ts");

const NOW = () => Date.parse("2026-09-24T12:00:00.000Z");

test("exporting writes real HTML and never touches the archived file", async (t) => {
  const agentDir = makeAgentDir(t);
  const file = writeSessionFile(agentDir, { id: "s1", cwd: "/data/proj" });
  await archiveSessionTree("s1", { agentDir, now: NOW });
  const archived = path.join(agentDir, "session-archive", path.basename(file));
  const before = snapshot(archived);

  const outDir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "export-"));
  const result = exportArchivedSessionHtml(archived, outDir);

  assert.equal(result.ok, true);
  assert.equal(result.entries, 2);
  const html = readExport(result.outputPath);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /hello/);
  assert.match(html, /Session s1/);
  assertUnchanged(archived, before, "export must not modify the archived session");
});

test("an archived file that pi would rewrite on load still exports untouched", async (t) => {
  const agentDir = makeAgentDir(t);
  // The two shapes that make SessionManager.open() write: no trailing newline,
  // and an old version.
  const file = writeSessionFile(agentDir, { id: "s2", trailingNewline: false, version: 2, role: "hookMessage" });
  const archived = path.join(agentDir, "session-archive", path.basename(file));
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.renameSync(file, archived);
  const archivedBefore = snapshot(archived);

  const result = exportArchivedSessionHtml(archived, fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "export-")));

  assert.equal(result.ok, true);
  assert.match(readExport(result.outputPath), /<html/i);
  assertUnchanged(archived, archivedBefore, "an old-format archived session must not be upgraded on disk");
});

test("exporting something unreadable fails with a message, not a crash", () => {
  const result = exportArchivedSessionHtml("/nonexistent/session.jsonl");
  assert.equal(result.ok, false);
  assert.match(result.message, /Cannot read/);
});

test("the transcript keeps tool results rather than dropping them", () => {
  const html = renderHtml(
    {
      entries: [
        { type: "session", version: 3, id: "x", cwd: "/w" },
        { type: "message", message: { role: "user", content: "do <it>" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "sure" }] } },
        { type: "message", message: { role: "toolResult", content: "exit 0" } },
      ],
      header: { type: "session", version: 3, id: "x", cwd: "/w" },
      manager: {},
      migrated: false,
    },
    "t",
  );
  assert.match(html, /do &lt;it&gt;/, "user text is escaped, not injected");
  assert.match(html, /sure/);
  assert.match(html, /toolResult/);
  assert.match(html, /exit 0/);
});

test("an empty session still exports something readable", () => {
  const session = readSessionNoWrite; // referenced for clarity; rendering is pure
  assert.equal(typeof session, "function");
  const html = renderHtml(
    { entries: [{ type: "session", version: 3, id: "e", cwd: "/w" }], header: { type: "session", version: 3, id: "e", cwd: "/w" }, manager: {}, migrated: false },
    "empty",
  );
  assert.match(html, /no messages/);
});

test("escapeHtml covers the characters that would break the document", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("an export gets a name a person can recognise, not a uuid", async () => {
  const { suggestExportName } = await import("./export-html.ts");
  assert.equal(
    suggestExportName({ label: "Fix the login bug", sessionId: "01a0", archivedAt: "2026-09-24T10:00:00.000Z" }),
    "2026-09-24-fix-the-login-bug.html",
  );
  assert.equal(
    suggestExportName({ label: "修复登录问题 / retry", sessionId: "01a0", archivedAt: "2026-09-24T10:00:00.000Z" }),
    "2026-09-24-retry.html",
  );
  // Without a label it still has a date, so files sort sensibly.
  assert.equal(suggestExportName({ sessionId: "01a0", archivedAt: "2026-09-24T10:00:00.000Z" }), "2026-09-24-01a0.html");
});

test("the export lands in the session's own cwd by default, so a file tree can show it", async (t) => {
  const agentDir = makeAgentDir(t);
  const cwd = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "export-cwd-"));
  const file = writeSessionFile(agentDir, { id: "s9", cwd });
  await archiveSessionTree("s9", { agentDir, now: NOW });

  const { describeReachability, exportArchivedSessionHtml } = await import("./export-html.ts");
  const archived = path.join(agentDir, "session-archive", path.basename(file));
  const result = exportArchivedSessionHtml(archived, { label: "chat about archiving" });
  assert.equal(result.ok, true);
  assert.equal(path.dirname(result.outputPath), cwd, "written next to the work it belongs to");
  assert.equal(path.basename(result.outputPath), `${new Date().toISOString().slice(0, 10)}-chat-about-archiving.html`);

  // A cwd that a live session still uses is reachable in pi-web's file tree.
  assert.equal(describeReachability(cwd, [cwd], "/home/someone").browsable, true);
  // One that no live session uses is not, and the message says so.
  const orphan = describeReachability("/data/gone", [cwd], "/home/someone");
  assert.equal(orphan.browsable, false);
  assert.match(orphan.message, /will not show it/);
});

test("a ~/pi-cwd-* destination counts as browsable", async () => {
  const { describeReachability } = await import("./export-html.ts");
  assert.equal(describeReachability("/home/someone/pi-cwd-20260924", [], "/home/someone").browsable, true);
});

test("exporting twice never overwrites the first file", async (t) => {
  const agentDir = makeAgentDir(t);
  const { archiveSessionTree } = await import("./migrate.ts");
  const file = writeSessionFile(agentDir, { id: "s1", cwd: "/data/proj" });
  await archiveSessionTree("s1", { agentDir, now: () => Date.now() });
  const archived = path.join(agentDir, "session-archive", path.basename(file));
  const outDir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "export-twice-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const first = exportArchivedSessionHtml(archived, { outDir, label: "same name" });
  const second = exportArchivedSessionHtml(archived, { outDir, label: "same name" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.outputPath, second.outputPath, "the second export got its own file");
  assert.equal(fs.existsSync(first.outputPath), true, "and the first is still there");
  assert.match(path.basename(second.outputPath), /-2\.html$/);
});
