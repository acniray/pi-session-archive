/**
 * Protocol constants and path predicates for the session archive.
 *
 * The archive is defined by *where the file is*, never by a flag inside it:
 * pi persists by appending to a path, so a file that has been moved out of
 * the active root can no longer be written into by accident, while an
 * in-file marker could only ever be appended (and would bump mtime, which
 * pi-web sorts the session list by).
 *
 * Layout under the agent directory:
 *   sessions/<--encoded-cwd-->/<timestamp>_<id>.jsonl      active
 *   session-archive/<timestamp>_<id>.jsonl                 archived (flat sibling)
 *   session-archive/index.json                              decorative only
 *   session-archive-mutation/owner.json                     cross-process barrier
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { basename, dirname, join } from "node:path";

export const ARCHIVE_SUBDIR = "session-archive";
export const MUTATION_SUBDIR = "session-archive-mutation";

/** How often the mutation lease refreshes its heartbeat while work is running. */
export const MUTATION_RENEW_INTERVAL_MS = 30_000;


/**
 * The on-disk index version. v2 added the origin fields so a restore does not
 * have to re-derive where a file came from.
 */
export const ARCHIVE_INDEX_VERSION = 2;

export function agentDirOrDefault(agentDir?: string): string {
  return agentDir ?? getAgentDir();
}

export function sessionsRoot(agentDir?: string): string {
  return join(agentDirOrDefault(agentDir), "sessions");
}

/**
 * The archive root is a *sibling* of `sessions/`, never a child. pi's default
 * scan only looks at immediate subdirectories of `sessions/` holding immediate
 * `.jsonl` files, so a sibling is invisible to it without any core change - and
 * that invisibility is what makes archived sessions disappear from `/resume`.
 */
export function archiveRoot(agentDir?: string): string {
  return join(agentDirOrDefault(agentDir), ARCHIVE_SUBDIR);
}

export function mutationRoot(agentDir?: string): string {
  return join(agentDirOrDefault(agentDir), MUTATION_SUBDIR);
}

export function archiveIndexPath(agentDir?: string): string {
  return join(archiveRoot(agentDir), "index.json");
}

/** Case- and separator-insensitive comparison, matching pi-web's sessionPathKey. */
export function pathKey(filePath: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = platform === "win32" ? filePath.replace(/\//g, "\\") : filePath;
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Archived = a `.jsonl` sitting directly in the archive root. Flat by construction. */
export function isArchivedPath(filePath: string, agentDir?: string): boolean {
  if (!filePath.endsWith(".jsonl")) return false;
  return pathKey(dirname(filePath)) === pathKey(archiveRoot(agentDir));
}

/**
 * Active = exactly `<agentDir>/sessions/<one directory>/<file>.jsonl`: the file
 * must sit immediately inside a project directory whose parent is the sessions
 * root. Anything else - a foreign root, the archive itself, a deeper nesting -
 * is not something we are willing to move.
 */
/**
 * Is this file one of the host's active sessions?
 *
 * Accepts both layouts the scanner accepts: `<root>/<project>/<file>` and, when
 * a session dir was configured to hold files directly, `<root>/<file>`. Requiring
 * the two-level shape would reject a legitimate custom layout.
 */
export function isActiveSessionPath(filePath: string, roots: readonly string[]): boolean {
  if (!filePath.endsWith(".jsonl")) return false;
  const dir = dirname(filePath);
  if (basename(dir) === "" || basename(dir) === ".") return false;
  const rootKeys = new Set(roots.map((root) => pathKey(root)));
  return rootKeys.has(pathKey(dir)) || rootKeys.has(pathKey(dirname(dir)));
}

export function archiveDestination(filePath: string, agentDir?: string): string {
  return join(archiveRoot(agentDir), basename(filePath));
}

/**
 * The file name carries the session id: `<timestamp>_<id>.jsonl`. pi-web
 * already relies on this convention to resolve an id to a path, so parsing it
 * keeps a moved session findable without rewriting its header. A name without
 * the timestamp separator carries no id and is refused.
 */
export function sessionIdFromFileName(filePath: string): string | undefined {
  const name = basename(filePath);
  if (!name.endsWith(".jsonl")) return undefined;
  const stem = name.slice(0, -".jsonl".length);
  const separator = stem.lastIndexOf("_");
  if (separator <= 0) return undefined;
  const id = stem.slice(separator + 1);
  return id.length > 0 ? id : undefined;
}

/**
 * Every directory that could hold this host's active sessions.
 *
 * The trap here is that `getSessionDir()` is **this session's own project
 * directory** (`<root>/<encoded-cwd>/`), not the sessions root - it is where
 * `newSession` writes (`session-manager.js:711-714, 774`). Treating it as the
 * root makes the scan find no project directories at all, i.e. an empty list.
 *
 * So we ask for both, and never guess between them:
 *   - the default root, which pi uses unless a session dir is configured;
 *   - the session's own directory, so the current project is always visible;
 *   - its parent, only when the host says it is *not* on the default layout -
 *     that is our best evidence of a custom root.
 *
 * `getSessionDir` is not in the published `ReadonlySessionManager` type though
 * the object has it at runtime, so this is a feature check plus a narrow cast,
 * not a claim that the type is safe.
 */
export function sessionRootsFrom(ctx: { sessionManager: unknown }, agentDir: string): string[] {
  const roots = new Set<string>([sessionsRoot(agentDir)]);
  const manager = ctx.sessionManager as
    | { getSessionDir?: () => string; usesDefaultSessionDir?: () => boolean }
    | undefined;
  if (typeof manager?.getSessionDir !== "function") return [...roots];
  try {
    const dir = manager.getSessionDir();
    if (typeof dir !== "string" || dir.length === 0) return [...roots];
    roots.add(dir);
    if (typeof manager.usesDefaultSessionDir === "function" && !manager.usesDefaultSessionDir()) {
      roots.add(dirname(dir));
    }
  } catch {
    // Could not ask: the default root still stands.
  }
  return [...roots];
}
