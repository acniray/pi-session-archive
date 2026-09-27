/**
 * Resolving which archived session a command refers to.
 *
 * Archiving an arbitrary session needs no choreography - there is no
 * cross-process ownership to coordinate - and the one case that needs care,
 * the session the host is running, is refused by the caller rather than handled
 * by switching away from it.
 */

import type { ArchivedSessionRow } from "./migrate.ts";

export interface TargetResolution {
  ok: boolean;
  row?: ArchivedSessionRow;
  message?: string;
}

/**
 * Exact id, then short id, then a unique text match. An ambiguous text match is
 * refused and names the candidates: restoring or exporting the wrong transcript
 * is not a small mistake.
 */
export function resolveArchivedTarget(
  rows: readonly ArchivedSessionRow[],
  target: string,
): TargetResolution {
  const needle = target.trim();
  if (needle === "") return { ok: false, message: "Which session? Pick one with /archived, or pass an id." };

  const exact = rows.filter((row) => row.session.id === needle);
  if (exact.length === 1) return { ok: true, row: exact[0] };
  if (exact.length > 1) {
    return {
      ok: false,
      message: `Session id ${needle} is claimed by ${exact.length} archived files. Run /archive-check before restoring or exporting it.`,
    };
  }

  const short = needle.startsWith("#") ? needle.slice(1) : needle;
  const byShortId = rows.filter((row) => row.session.id.startsWith(short));
  if (byShortId.length === 1) return { ok: true, row: byShortId[0] };
  if (byShortId.length > 1) {
    return {
      ok: false,
      message: `#${short} matches ${byShortId.length} session ids. Use a longer id prefix.`,
    };
  }

  const lowered = short.toLowerCase();
  const matches = rows.filter((row) =>
    `${row.session.name ?? ""} ${row.session.firstMessage ?? ""} ${row.cwd ?? row.session.cwd ?? ""}`
      .toLowerCase()
      .includes(lowered),
  );
  if (matches.length === 1) return { ok: true, row: matches[0] };
  if (matches.length === 0) {
    return { ok: false, message: `No archived session matches "${needle}". Pick one with /archived.` };
  }
  return {
    ok: false,
    message: `"${needle}" matches ${matches.length} sessions (${matches
      .slice(0, 3)
      .map((row) => `#${row.session.id.slice(0, 8)}`)
      .join(", ")}). Use the id.`,
  };
}
