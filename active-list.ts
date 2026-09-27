/**
 * The active-session list, as the archive picker needs it: roots only.
 *
 * Archiving is a list action, not a "whatever I am in" action. A subagent child
 * is folded into its parent while that parent is present on the same storage
 * side. If the parent is missing (a split left by an interrupted/old/manual
 * operation), the child is shown as a recovery root so the UI never hides the
 * only handle the user has to repair it.
 */

import {
  type RawSessionInfo,
  type RelationGraph,
  buildRelationGraph,
  scanSessionRoots,
} from "./scanner.ts";
import { basename } from "node:path";
import { sessionsRoot } from "./paths.ts";

export interface ActiveSessionRow {
  session: RawSessionInfo;
  /** Direct subagent children. */
  childCount: number;
  /** Every descendant, which is the number that would be archived with it. */
  descendantCount: number;
  hasChildren: boolean;
  /** Parent id when this is only a root because its parent is not active. */
  splitParentId?: string;
}

export interface ActiveListResult {
  rows: ActiveSessionRow[];
  /** False when the scan could not be completed, so the list may be short. */
  complete: boolean;
  problems: Array<{ path: string; kind: string; message: string }>;
}

function countDescendants(graph: RelationGraph, id: string): number {
  const seen = new Set<string>([id]);
  const visit = (parent: string): number => {
    let total = 0;
    for (const child of graph.childrenByParent.get(parent) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      total += 1 + visit(child);
    }
    return total;
  };
  return visit(id);
}

export interface ActiveListDeps {
  agentDir?: string;
  /**
   * Directories that may hold this host's sessions. `getSessionDir()` is the
   * session's own project directory rather than the root, so the host's
   * candidates and the default root both go in.
   */
  sessionRoots?: readonly string[];
  scanActive?: () => ReturnType<typeof scanSessionRoots>;
}

/** Roots, newest first, each annotated with the subagent sessions it carries. */
export async function listActiveRoots(deps: ActiveListDeps = {}): Promise<ActiveListResult> {
  const scan = deps.scanActive ?? (() => scanSessionRoots(deps.sessionRoots ?? [sessionsRoot(deps.agentDir)]));
  const active = scan();
  const graph = await buildRelationGraph(active.sessions);

  const rows: ActiveSessionRow[] = [];
  const presentIds = new Set(active.sessions.map((session) => session.id));
  for (const session of active.sessions) {
    const parentId = graph.parentOf.get(session.id);
    if (parentId && presentIds.has(parentId)) continue; // folded into its parent row
    const children = graph.childrenByParent.get(session.id) ?? [];
    rows.push({
      session,
      childCount: children.length,
      descendantCount: countDescendants(graph, session.id),
      hasChildren: children.length > 0,
      ...(parentId ? { splitParentId: parentId } : {}),
    });
  }
  rows.sort((a, b) => b.session.mtimeMs - a.session.mtimeMs || a.session.path.localeCompare(b.session.path));

  // `complete` here means "every file in the tree was classified", which is what a
  // list needs. Whether every *relation* was proven is a separate question, and
  // it is answered by the graph, not by this flag.
  return {
    rows,
    problems: [...active.problems, ...graph.problems],
    complete: active.complete && graph.readable,
  };
}

function relativeTime(iso: string | undefined, nowMs: number): string {
  if (!iso) return "";
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return "";
  const minutes = Math.max(0, Math.round((nowMs - stamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(stamp).toISOString().slice(0, 10);
}

/** The title a person would use for it: its name, else what was said first. */
export function rowTitle(row: ActiveSessionRow): string {
  return row.session.name?.trim() || row.session.firstMessage?.trim() || row.session.id;
}

/**
 * One line, packed so a picker row is self-explanatory:
 *   title · 2d ago (2026-09-24 10:00) · 42 msgs · [+3 subagent] · last: "…"
 * The trailing preview is what makes two same-titled conversations tellable apart.
 */
export function describeActiveRow(
  row: ActiveSessionRow,
  nowMs: number,
  idToken = row.session.id.slice(0, 8),
  current = false,
): string {
  const title = rowTitle(row).replace(/\s+/g, " ").slice(0, 72);
  const when = relativeTime(new Date(row.session.mtimeMs).toISOString(), nowMs);
  const project = row.session.cwd ? basenameOf(row.session.cwd) : "unknown project";
  const parts = [title, project, when];
  if (current) parts.push("current session");
  if (row.splitParentId) parts.push(`split child of #${row.splitParentId.slice(0, 8)}`);
  if (row.hasChildren) parts.push(`${row.descendantCount} subagent${row.descendantCount === 1 ? "" : "s"}`);
  parts.push(`#${idToken}`);
  return parts.join(" · ");
}

/**
 * Shortest stable id prefix that is unique among the ids currently shown.
 *
 * Eight characters keeps ordinary rows compact. When two ids share that
 * prefix, only those rows grow. If one id is itself a prefix of another, the
 * full shorter id is returned; callers resolve exact ids before prefixes.
 */
export function uniqueIdPrefixes(ids: readonly string[], minLength = 8): Map<string, string> {
  const distinct = [...new Set(ids)];
  const result = new Map<string, string>();
  for (const id of distinct) {
    let length = Math.min(minLength, id.length);
    while (length < id.length) {
      const prefix = id.slice(0, length);
      if (!distinct.some((other) => other !== id && other.startsWith(prefix))) break;
      length += 1;
    }
    result.set(id, id.slice(0, length));
  }
  return result;
}

/**
 * The id token embedded at the end of a row label.
 *
 * Deliberately shape-agnostic: the token is whatever the row printed, so a
 * session id format we did not anticipate still round-trips.
 */
export function idFromLabel(label: string): string | undefined {
  return /#(\S+)$/.exec(label)?.[1];
}

function basenameOf(path: string): string {
  // node:path knows the separator for the platform we are running on; splitting
  // on "/" mangles a Windows path like C:\repo\foo.
  return basename(path) || path;
}
