/**
 * Finding a session file by id after a restore.
 *
 * pi's own resolver is not exposed to extensions, and a restored file keeps the
 * name it was archived with - `<timestamp>_<id>.jsonl` - so the name is a useful
 * hint. It stays a hint: the header decides, exactly as pi-web's own resolver
 * does, so a renamed or hand-copied file cannot send us to the wrong session.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sessionIdFromFileName, sessionsRoot } from "./paths.ts";
import { classifySessionFile } from "./scanner.ts";

/** Every filename in one directory that could plausibly refer to this id. */
function candidatesIn(dir: string, sessionId: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  // Exact-name files are legal in custom/manual layouts even though the normal
  // pi filename embeds a timestamp. Keep them first only as an I/O hint; the
  // header, not ordering, decides which file is the session.
  const exactName = `${sessionId}.jsonl`;
  const candidates = names
    .filter((name) => name === exactName || sessionIdFromFileName(join(dir, name)) === sessionId)
    .map((name) => join(dir, name));

  return [...new Set(candidates)];
}

/**
 * The path of a live session with this id, or undefined.
 *
 * A filename match is never enough. We inspect every plausible candidate and
 * return a path only when exactly one header claims the requested id. This
 * avoids two "first one wins" failure modes:
 *   - a misleading filename hiding the real restored session beside it;
 *   - two real files claiming the same id, where opening either one would be an
 *     arbitrary choice.
 *
 * Only the default active sessions root is searched here. A restore into a
 * custom external session directory is switched by its returned destination
 * path instead (the caller has that authoritative path).
 */
export function findSessionPathByIdHint(sessionId: string, agentDir: string): string | undefined {
  const root = sessionsRoot(agentDir);
  const dirs = [root];
  try {
    dirs.push(
      ...readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => join(root, entry.name)),
    );
  } catch {
    // The direct root may still have been readable enough to yield a candidate;
    // candidate classification below is the authority.
  }

  const candidates = [...new Set(dirs.flatMap((dir) => candidatesIn(dir, sessionId)))];
  const valid: string[] = [];
  for (const candidate of candidates) {
    const { info } = classifySessionFile(candidate);
    if (info?.id === sessionId) valid.push(candidate);
  }
  return valid.length === 1 ? valid[0] : undefined;
}
