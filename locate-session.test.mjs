import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeAgentDir, projectDirFor, writeSessionFile } from "./test-helpers.mjs";

const { findSessionPathByIdHint } = await import("./locate-session.ts");

test("locates the one live session whose header matches the requested id", (t) => {
  const agentDir = makeAgentDir(t);
  const wanted = writeSessionFile(agentDir, { id: "wanted", cwd: "/data/proj" });
  assert.equal(findSessionPathByIdHint("wanted", agentDir), wanted);
});

test("a misleading filename does not hide a valid candidate beside it", (t) => {
  const agentDir = makeAgentDir(t);
  const dir = projectDirFor(agentDir, "/data/proj");
  fs.mkdirSync(dir, { recursive: true });

  // This sorts/appears as a perfectly plausible filename for `wanted`, but its
  // header belongs to somebody else.
  const misleading = path.join(dir, "2026-09-20T00-00-00-000Z_wanted.jsonl");
  fs.writeFileSync(
    misleading,
    `${JSON.stringify({ type: "session", version: 3, id: "other", timestamp: "2026-09-20T00:00:00.000Z", cwd: "/data/proj" })}\n`,
  );

  // A second plausible filename really is the requested session. The old
  // implementation examined only the first filename-convention match and gave
  // up after seeing the mismatch.
  const wanted = path.join(dir, "2026-09-21T00-00-00-000Z_wanted.jsonl");
  fs.writeFileSync(
    wanted,
    `${JSON.stringify({ type: "session", version: 3, id: "wanted", timestamp: "2026-09-21T00:00:00.000Z", cwd: "/data/proj" })}\n`,
  );

  assert.equal(findSessionPathByIdHint("wanted", agentDir), wanted);
});

test("two header-valid candidates with the same id are ambiguous, not first-wins", (t) => {
  const agentDir = makeAgentDir(t);
  const first = writeSessionFile(agentDir, { id: "dup", cwd: "/data/one" });
  const firstBytes = fs.readFileSync(first);
  const secondDir = projectDirFor(agentDir, "/data/two");
  fs.mkdirSync(secondDir, { recursive: true });
  const second = path.join(secondDir, "2026-09-25T00-00-00-000Z_dup.jsonl");
  fs.writeFileSync(second, firstBytes);

  assert.equal(findSessionPathByIdHint("dup", agentDir), undefined);
});
