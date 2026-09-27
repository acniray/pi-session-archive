/**
 * Reading a session file *without* modifying it.
 *
 * `SessionManager.open()` is not safe for archived files: on load it appends a
 * missing trailing newline (`session-manager.js:366-367`) and rewrites the file
 * when the version is older than current (`:718-724`). Both are writes, which
 * would violate "archived means read-only" the first time somebody looked at a
 * session. So we parse in memory and hand the entries to an in-memory manager.
 */

import {
  CURRENT_SESSION_VERSION,
  type FileEntry,
  type SessionHeader,
  SessionManager,
  migrateSessionEntries,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

export interface ReadSessionResult {
  entries: FileEntry[];
  header: SessionHeader;
  manager: SessionManager;
  /** True when the entries were migrated in memory (v1/v2 -> current). */
  migrated: boolean;
}

export class UnreadableSessionError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(`cannot read session file: ${filePath}`);
    this.name = "UnreadableSessionError";
    this.filePath = filePath;
    this.cause = cause;
  }
}

/**
 * Parse a session file into an in-memory manager. Never writes to the file -
 * the caller can assert on the bytes and mtime before and after.
 */
export function readSessionNoWrite(filePath: string): ReadSessionResult {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new UnreadableSessionError(filePath, error);
  }

  const entries = parseSessionEntries(content);
  const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
  if (!header || typeof header.id !== "string") {
    throw new UnreadableSessionError(filePath, new Error("no session header in file"));
  }

  const version = typeof header.version === "number" ? header.version : 1;
  const migrated = version < CURRENT_SESSION_VERSION;
  if (migrated) migrateSessionEntries(entries); // in memory only

  const manager = SessionManager.inMemory(header.cwd, undefined, entries);
  return { entries, header, manager, migrated };
}

/** Header-only read for places that need cwd/id but not the transcript. */
export function readHeaderNoWrite(filePath: string): SessionHeader {
  return readSessionNoWrite(filePath).header;
}
