/**
 * Shared fixtures for the extension's tests. Colocated `.test.mjs` files import
 * from here, exactly like the rest of the repository (no build step: the tests
 * import the `.ts` sources through `node --experimental-strip-types`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A throwaway agent directory. `PI_CODING_AGENT_DIR` is irrelevant here: every
 *  function under test takes an explicit agentDir, which is what makes the
 *  fixtures hermetic. */
export function makeAgentDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-archive-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** pi encodes a cwd into a directory name: `/data/x` -> `--data-x--`. */
export function encodeProjectDir(cwd) {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function projectDirFor(agentDir, cwd) {
  return path.join(agentDir, "sessions", encodeProjectDir(cwd));
}

/** Default mtime for fixtures: deliberately older than any injected clock, so
 *  "was this file written recently?" is a fact the test states, not an accident
 *  of when the suite ran. */
export const OLD_MTIME = "2026-09-24T09:00:00.000Z";

/**
 * Write a session file. Defaults produce a valid v3 session with one user
 * message; `trailingNewline: false` and `version: 2` reproduce the two shapes
 * that make `SessionManager.open()` write to the file.
 */
export function writeSessionFile(
  agentDir,
  {
    id,
    cwd = "/data/proj",
    root = "active",
    extraEntries = [],
    version = 3,
    trailingNewline = true,
    role = "user",
    mtime = OLD_MTIME,
    firstMessage = "hello",
    /** When the message was written. Real sessions move it with the mtime, so
     *  fixtures that vary one should vary both. */
    messageAt = "2026-09-24T10:00:01.000Z",
  } = {},
) {
  const dir =
    root === "active" ? projectDirFor(agentDir, cwd) : path.join(agentDir, "session-archive");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-09-24T10-00-00-000Z_${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version, id, timestamp: "2026-09-24T10:00:00.000Z", cwd }),
    JSON.stringify({
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: messageAt,
      message: { role, content: firstMessage, timestamp: Date.parse(messageAt) },
    }),
    ...extraEntries,
  ];
  fs.writeFileSync(file, lines.join("\n") + (trailingNewline ? "\n" : ""));
  const when = new Date(mtime);
  fs.utimesSync(file, when, when);
  return file;
}

/** A child session file carrying pi-web's subagent relation entry. */
export function writeSubagentSessionFile(
  agentDir,
  { id, parentId, parentPath, cwd = "/data/proj", root = "active", mtime = OLD_MTIME },
) {
  return writeSessionFile(agentDir, {
    id,
    cwd,
    root,
    mtime,
    extraEntries: [
      JSON.stringify({
        type: "custom",
        id: "meta1",
        parentId: "e1",
        timestamp: "2026-09-24T10:00:02.000Z",
        customType: "pi-web:subagent",
        data: { version: 1, parentSessionId: parentId, parentSessionPath: parentPath },
      }),
    ],
  });
}

/** Bytes + mtime, for asserting that a read or a move changed nothing. */
export function snapshot(file) {
  return { bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs };
}

export function assertUnchanged(file, before, label) {
  const after = snapshot(file);
  if (!after.bytes.equals(before.bytes)) {
    throw new Error(`${label}: file bytes changed (${before.bytes.length} -> ${after.bytes.length})`);
  }
  if (after.mtimeMs !== before.mtimeMs) {
    throw new Error(`${label}: mtime changed (${before.mtimeMs} -> ${after.mtimeMs})`);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
