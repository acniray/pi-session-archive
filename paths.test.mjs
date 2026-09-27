import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeAgentDir, projectDirFor, writeSessionFile } from "./test-helpers.mjs";

const {
  ARCHIVE_SUBDIR,
  MUTATION_RENEW_INTERVAL_MS,
  MUTATION_SUBDIR,
  archiveDestination,
  archiveIndexPath,
  archiveRoot,
  isActiveSessionPath,
  isArchivedPath,
  mutationRoot,
  sessionIdFromFileName,
  sessionsRoot,
} = await import("./paths.ts");

test("the archive root is a sibling of the sessions root, never a child", async (t) => {
  const agentDir = makeAgentDir(t);
  assert.equal(sessionsRoot(agentDir), path.join(agentDir, "sessions"));
  assert.equal(archiveRoot(agentDir), path.join(agentDir, ARCHIVE_SUBDIR));
  assert.equal(mutationRoot(agentDir), path.join(agentDir, MUTATION_SUBDIR));
  assert.equal(archiveIndexPath(agentDir), path.join(agentDir, ARCHIVE_SUBDIR, "index.json"));
  assert.equal(MUTATION_RENEW_INTERVAL_MS, 30_000);
});

test("only a .jsonl directly in the archive root counts as archived", async (t) => {
  const agentDir = makeAgentDir(t);
  const archived = archiveDestination("/anywhere/2026_x.jsonl", agentDir);
  assert.equal(isArchivedPath(archived, agentDir), true);
  // Flat by construction: a nested directory is not an archive entry.
  assert.equal(isArchivedPath(path.join(agentDir, ARCHIVE_SUBDIR, "sub", "x.jsonl"), agentDir), false);
  // The decorative index is not a session.
  assert.equal(isArchivedPath(archiveIndexPath(agentDir), agentDir), false);
});

test("an active session is exactly <sessionDir>/<project>/<file>.jsonl", async (t) => {
  const agentDir = makeAgentDir(t);
  const root = path.join(agentDir, "sessions");
  const active = writeSessionFile(agentDir, { id: "s1", cwd: "/data/proj" });
  assert.equal(isActiveSessionPath(active, [root]), true);
  assert.equal(isActiveSessionPath(archiveDestination(active, agentDir), [root]), false);
  assert.equal(isActiveSessionPath("/elsewhere/sessions/p/s.jsonl", [root]), false);
  // Deeper nesting is refused rather than guessed at.
  assert.equal(isActiveSessionPath(path.join(root, "p", "nested", "s.jsonl"), [root]), false);
  assert.equal(isActiveSessionPath(path.join(projectDirFor(agentDir, "/data/proj"), "notes.txt"), [root]), false);
  // A custom --session-dir is honoured, and the default root is then foreign.
  const custom = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "paths-sessiondir-"));
  t.after(() => fs.rmSync(custom, { recursive: true, force: true }));
  fs.mkdirSync(path.join(custom, "proj"), { recursive: true });
  const elsewhere = path.join(custom, "proj", "s.jsonl");
  fs.writeFileSync(elsewhere, "{}\n");
  assert.equal(isActiveSessionPath(elsewhere, [custom]), true);
  assert.equal(isActiveSessionPath(elsewhere, [root]), false, "the default root no longer owns it");
});

test("archiveDestination keeps the file name so the id stays recoverable", async (t) => {
  const agentDir = makeAgentDir(t);
  const active = writeSessionFile(agentDir, { id: "01a0cfb5", cwd: "/data/proj" });
  const destination = archiveDestination(active, agentDir);
  assert.equal(path.dirname(destination), archiveRoot(agentDir));
  assert.equal(sessionIdFromFileName(destination), "01a0cfb5");
  assert.equal(sessionIdFromFileName(destination), sessionIdFromFileName(active));
});

test("sessionIdFromFileName rejects files that do not carry an id", () => {
  assert.equal(sessionIdFromFileName("/x/2026-09-24T10-00-00-000Z_abc.jsonl"), "abc");
  assert.equal(sessionIdFromFileName("/x/notes.jsonl"), undefined);
  assert.equal(sessionIdFromFileName("/x/archive.zip"), undefined);
});
