/**
 * The claim this whole extension rests on, checked against pi's own code rather
 * than against ours: an archived session stops being listed, because it is no
 * longer in the directory pi scans. Everything else in the extension is built on
 * that; if it were false, the rest would be decoration.
 *
 * Both SDK entry points are exercised - `SessionManager.listAll()` (the
 * all-projects scan, which is what pi's `/resume` uses) and
 * `SessionManager.list(cwd, sessionDir)` (the per-cwd scan).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeAgentDir, writeSessionFile, writeSubagentSessionFile } from "./test-helpers.mjs";

const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { archiveSessionTree, restoreSessionTree } = await import("./migrate.ts");
const { archiveRoot, sessionsRoot } = await import("./paths.ts");

const NOW = () => Date.parse("2026-09-24T12:00:00.000Z");

/** getAgentDir() is read from the environment, so point it at a temp dir. */
function withAgentDirEnv(t) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
}

test("pi's own all-projects scan stops listing an archived session", async (t) => {
  const agentDir = makeAgentDir(t);
  withAgentDirEnv(t);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  writeSessionFile(agentDir, { id: "keep", cwd: "/data/other" });

  const before = await SessionManager.listAll();
  assert.deepEqual(before.map((info) => info.id).sort(), ["keep", "p1"]);

  const result = await archiveSessionTree("p1", { agentDir, now: NOW });
  assert.equal(result.ok, true);

  // pi's own scan, unmodified: the archived session is simply not there.
  const after = await SessionManager.listAll();
  assert.deepEqual(after.map((info) => info.id), ["keep"], "pi no longer lists the archived session");

  const restored = await restoreSessionTree("p1", { agentDir, now: NOW });
  assert.equal(restored.ok, true);
  const back = await SessionManager.listAll();
  assert.deepEqual(back.map((info) => info.id).sort(), ["keep", "p1"], "and it comes back where it was");
});

test("pi's per-cwd scan agrees, and the archive root is listable on its own", async (t) => {
  const agentDir = makeAgentDir(t);
  withAgentDirEnv(t);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  await archiveSessionTree("p1", { agentDir, now: NOW });

  assert.deepEqual(await SessionManager.list("/data/proj", sessionsRoot(agentDir)), []);
  // The archive is not scanned by default, but it is a normal session directory.
  const inArchive = await SessionManager.listAll(archiveRoot(agentDir));
  assert.deepEqual(inArchive.map((info) => info.id), ["p1"]);
  assert.equal(inArchive[0].cwd, "/data/proj", "cwd survives, so the session can be restored or grouped");
});

test("a whole subagent cascade leaves pi's scan at once", async (t) => {
  const agentDir = makeAgentDir(t);
  withAgentDirEnv(t);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const parent = writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  writeSubagentSessionFile(agentDir, { id: "c1", parentId: "p1", parentPath: parent });
  writeSubagentSessionFile(agentDir, { id: "c2", parentId: "c1", parentPath: parent });
  writeSessionFile(agentDir, { id: "f1", cwd: "/data/proj" });

  await archiveSessionTree("p1", { agentDir, now: NOW });

  assert.deepEqual((await SessionManager.listAll()).map((info) => info.id), ["f1"], "the fork sibling stays put");
  const archived = await SessionManager.listAll(archiveRoot(agentDir));
  assert.deepEqual(archived.map((info) => info.id).sort(), ["c1", "c2", "p1"]);
});

test("the archive root really is outside everything pi scans by default", async (t) => {
  const agentDir = makeAgentDir(t);
  withAgentDirEnv(t);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  await archiveSessionTree("p1", { agentDir, now: NOW });

  // A sibling of sessions/, not a child: nothing walks up into it.
  assert.equal(path.dirname(archiveRoot(agentDir)), agentDir);
  assert.equal(path.dirname(sessionsRoot(agentDir)), agentDir);
  assert.equal(archiveRoot(agentDir).startsWith(`${sessionsRoot(agentDir)}/`), false);
  assert.equal(fs.existsSync(archiveRoot(agentDir)), true);
  // And the default scan, with no arguments, ignores it.
  assert.deepEqual(await SessionManager.listAll(), []);
});

test("a real pi session file round-trips through the archive unchanged", async (t) => {
  const agentDir = makeAgentDir(t);
  withAgentDirEnv(t);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Write something shaped like a real transcript: header, user, assistant, tool call.
  const dir = path.join(sessionsRoot(agentDir), "--data-proj--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "2026-09-24T10-00-00-000Z_real.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", version: 3, id: "real", timestamp: "2026-09-24T10:00:00.000Z", cwd: "/data/proj" }),
      JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-09-24T10:00:01.000Z", message: { role: "user", content: "hello", timestamp: 1758700801000 } }),
      JSON.stringify({ type: "message", id: "e2", parentId: "e1", timestamp: "2026-09-24T10:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], timestamp: 1758700802000 } }),
      "",
    ].join("\n"),
  );
  const original = fs.readFileSync(file, "utf8");
  // State the mtime, like the fixtures do: this file is old, not just written.
  const old = new Date(Date.parse("2026-09-24T09:00:00.000Z"));
  fs.utimesSync(file, old, old);

  const result = await archiveSessionTree("real", { agentDir, now: NOW });
  assert.equal(result.ok, true);
  const archived = path.join(archiveRoot(agentDir), path.basename(file));
  assert.equal(fs.readFileSync(archived, "utf8"), original, "the file moved byte for byte");

  const back = await restoreSessionTree("real", { agentDir, now: NOW });
  assert.equal(back.ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), original, "and back byte for byte");

  // pi can still open it afterwards, which is what "restored" has to mean.
  const reopened = SessionManager.open(file, undefined);
  assert.equal(reopened.getSessionId(), "real");
  // getEntries() excludes the header, so two messages remain.
  assert.deepEqual(reopened.getEntries().map((entry) => entry.type), ["message", "message"]);
});

test("a temp agent dir does not leak into the developer's real one", async (t) => {
  const agentDir = makeAgentDir(t);
  withAgentDirEnv(t);
  const realAgentDir = os.homedir();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeSessionFile(agentDir, { id: "p1", cwd: "/data/proj" });
  await archiveSessionTree("p1", { agentDir, now: NOW });
  assert.equal(fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_p1.jsonl")), true);
  assert.equal(fs.existsSync(path.join(archiveRoot(realAgentDir), "2026-09-24T10-00-00-000Z_p1.jsonl")), false);
});
