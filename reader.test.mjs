import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";

import { assertUnchanged, makeAgentDir, snapshot, writeSessionFile } from "./test-helpers.mjs";

const { UnreadableSessionError, readSessionNoWrite } = await import("./reader.ts");
const { CURRENT_SESSION_VERSION, SessionManager } = await import("@earendil-works/pi-coding-agent");

test("reading a session that lacks a trailing newline does not modify it", (t) => {
  const agentDir = makeAgentDir(t);
  const file = writeSessionFile(agentDir, { id: "s1", trailingNewline: false });
  const before = snapshot(file);

  const { entries, header, manager } = readSessionNoWrite(file);

  assert.equal(header.id, "s1");
  assert.equal(header.cwd, "/data/proj");
  assert.equal(entries.length, 2, "header + message were parsed");

  // getEntries() excludes the header, and an in-memory manager has no file, so
  // callers must fall back to the path they already know (pi-web's detail route
  // does `sm.getSessionFile() || resolvedPath`).
  assert.deepEqual(manager.getEntries().map((entry) => entry.type), ["message"]);
  assert.equal(manager.getSessionId(), "s1");
  assert.equal(manager.getSessionFile(), undefined);
  assert.equal(manager.getLeafId(), "e1");
  assertUnchanged(file, before, "readSessionNoWrite (no trailing newline)");
});

test("a v2 session is migrated in memory and left alone on disk", (t) => {
  const agentDir = makeAgentDir(t);
  // v2 stored extension messages under `hookMessage`; v3 renamed the role to `custom`.
  const file = writeSessionFile(agentDir, { id: "s2", version: 2, role: "hookMessage" });
  const before = snapshot(file);

  const { header, entries, migrated } = readSessionNoWrite(file);

  assert.equal(migrated, true);
  // Migration mutates the parsed header in place, so what we hand back is the
  // post-migration state while the file on disk still says version 2.
  assert.equal(header.version, CURRENT_SESSION_VERSION);
  const message = entries.find((entry) => entry.type === "message" && "message" in entry);
  assert.equal(message.message.role, "custom", "hookMessage was renamed to custom in memory");
  assert.match(before.bytes.toString("utf8"), /"version":2/, "the file was not upgraded on disk");
  assertUnchanged(file, before, "readSessionNoWrite (v2 migration)");
});

test("CONTROL: SessionManager.open() does write these files, which is why we do not use it", (t) => {
  const agentDir = makeAgentDir(t);
  const file = writeSessionFile(agentDir, { id: "s3", trailingNewline: false });
  const before = snapshot(file);

  SessionManager.open(file);

  // If pi ever stops repairing the file on load, this control fails - that is the
  // signal to reconsider the adapter, and it should be noticed rather than ignored.
  const after = snapshot(file);
  assert.ok(!after.bytes.equals(before.bytes), "expected SessionManager.open() to append a newline");
  assert.ok(after.mtimeMs > before.mtimeMs, "expected the file to be rewritten on load");
});

test("an unreadable or headerless file raises a typed error", (t) => {
  const agentDir = makeAgentDir(t);
  assert.throws(() => readSessionNoWrite(`${agentDir}/missing.jsonl`), UnreadableSessionError);

  const noHeader = `${agentDir}/broken.jsonl`;
  writeFileSync(noHeader, '{"type":"message"}\n');
  assert.throws(() => readSessionNoWrite(noHeader), UnreadableSessionError);
});
