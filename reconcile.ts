/**
 * Diagnostics for states the archive can end up in that nobody asked for.
 *
 * This module never moves a file. Everything here is "look and report", because
 * a session that is mid-write is not safe to relocate on the strength of an
 * observation - see the B4/B6 notes in the design: a parent being archived does
 * not prove its children stopped, and a load-time write can happen before any
 * extension exists.
 *
 * What it reports:
 *   split-session          an active-root file whose id is already archived, or a
 *                          second copy of an archived id
 *   unclassified-fragment  a `.jsonl` under the active root (or the archive root)
 *                          that pi's own scan would skip - a bare entry with no
 *                          session header, i.e. the residue of a split write
 *   incomplete-cascade     a parent/child tree is split between active and
 *                          archive storage
 *   stray-file             something in the archive root that is not a session
 */

import { basename } from "node:path";
import { archiveRoot, isArchivedPath, sessionsRoot } from "./paths.ts";
import { buildRelationGraph, scanSessionRoot, scanSessionRoots, type RawSessionInfo, type ScanProblem } from "./scanner.ts";

export type DiagnosticKind =
  | "split-session"
  | "unclassified-fragment"
  | "incomplete-cascade"
  | "stray-file"
  /** A well-formed session whose subagent relation could not be read. Not a
   *  damaged file and not a stray one: a session we know exists and know nothing
   *  about, which is the one state a cascade may not act on. */
  | "relation-unknown";

export interface ArchiveDiagnostic {
  kind: DiagnosticKind;
  /** Session ids involved, when they could be attributed. */
  sessionIds: string[];
  paths: string[];
  message: string;
}

export interface ReconcileReport {
  /** The archive, as it stands. */
  archived: RawSessionInfo[];
  active: RawSessionInfo[];
  diagnostics: ArchiveDiagnostic[];
  /** False when the scan itself could not be completed. */
  complete: boolean;
  scanProblems: ScanProblem[];
}

function describeKind(kind: DiagnosticKind, detail: string): string {
  switch (kind) {
    case "split-session":
      return `A session exists in two places. ${detail} Nothing was merged automatically - restore one side and check the other.`;
    case "unclassified-fragment":
      return `A file pi does not recognise as a session sits next to the sessions. ${detail} It is usually the residue of a write that raced a move.`;
    case "relation-unknown":
      return `A session is readable but its subagent relation is not. ${detail} The diagnostic is incomplete around this file; unrelated archive operations are unaffected.`;
    case "incomplete-cascade":
      return `A subagent tree is split between active and archive storage. ${detail} Reunite the tree by archiving or restoring the corresponding side.`;
    case "stray-file":
      return `Something in the archive root is not a session. ${detail}`;
  }
}

export interface ReconcileOptions {
  agentDir?: string;
  /** Directories that may hold this host's sessions (see paths.sessionRootsFrom). */
  sessionRoots?: readonly string[];
}

/** Inspect both roots and report what looks wrong. Moves nothing. */
export async function reconcileArchive(options: ReconcileOptions = {}): Promise<ReconcileReport> {
  const diagnostics: ArchiveDiagnostic[] = [];
  let relationProblems: ScanProblem[] = [];

  const activeScan = scanSessionRoots(options.sessionRoots ?? [sessionsRoot(options.agentDir)]);
  const archiveScan = scanSessionRoot(archiveRoot(options.agentDir), { flat: true });

  const archivedIds = new Set(archiveScan.sessions.map((session) => session.id));
  const activeIds = new Set(activeScan.sessions.map((session) => session.id));

  // A fragment left where a session used to be: pi skips these, so nothing else
  // would ever surface them.
  for (const problem of [...activeScan.problems, ...archiveScan.problems]) {
    if (problem.kind === "headerless" || problem.kind === "malformed-header") {
      diagnostics.push({
        kind: "unclassified-fragment",
        sessionIds: [],
        paths: [problem.path],
        message: describeKind("unclassified-fragment", `${basename(problem.path)}: ${problem.message}`),
      });
    } else {
      diagnostics.push({
        kind: "stray-file",
        sessionIds: [],
        paths: [problem.path],
        message: describeKind("stray-file", `${problem.path}: ${problem.message}`),
      });
    }
  }

  // A file in the active root whose id is already archived: the classic split.
  for (const session of activeScan.sessions) {
    if (!archivedIds.has(session.id)) continue;
    diagnostics.push({
      kind: "split-session",
      sessionIds: [session.id],
      paths: [session.path],
      message: describeKind(
        "split-session",
        `${session.id} is active at ${session.path} and also archived. A writer appended to the old path after it was moved.`,
      ),
    });
  }

  const activeGraph = await buildRelationGraph(activeScan.sessions);
  const archivedGraph = await buildRelationGraph(archiveScan.sessions);
  // The relation layer's own problems belong in the report. Without them this
  // check shared the parser it is meant to be a check on: a session whose
  // relation could not be read was invisible to it, and it answered "the archive
  // looks consistent" about a tree it had not been able to see. A diagnostic is
  // not an independent verdict on the parser - it is a verdict on the outcome -
  // and it has to be able to say so.
  relationProblems = [
    ...activeGraph.problems.map((problem) => ({ ...problem, side: "active" as const })),
    // The archived side is where a restore would read it, so an unreadable
    // relation there is exactly as unknown. Checking only the active side is how
    // this report came to describe a conflicted archive as "consistent".
    ...archivedGraph.problems.map((problem) => ({ ...problem, side: "archived" as const })),
  ];
  for (const problem of relationProblems) {
    diagnostics.push({
      kind: "relation-unknown",
      sessionIds: [],
      paths: [problem.path],
      message: describeKind(
        "relation-unknown",
        `${problem.path} is a readable session whose subagent relation could not be read (${problem.message}), so the tree around it is unknown.`,
      ),
    });
  }
  for (const [childId, parentId] of activeGraph.parentOf) {
    if (!archivedIds.has(parentId)) continue;
    const child = activeScan.sessions.find((session) => session.id === childId);
    diagnostics.push({
      kind: "incomplete-cascade",
      sessionIds: [childId, parentId],
      paths: child ? [child.path] : [],
      message: describeKind(
        "incomplete-cascade",
        `${childId} belongs to ${parentId}, which is archived, so the durable tree is split across active and archive storage.`,
      ),
    });
  }
  for (const [childId, parentId] of archivedGraph.parentOf) {
    if (!activeIds.has(parentId)) continue;
    const child = archiveScan.sessions.find((session) => session.id === childId);
    diagnostics.push({
      kind: "incomplete-cascade",
      sessionIds: [childId, parentId],
      paths: child ? [child.path] : [],
      message: describeKind(
        "incomplete-cascade",
        `${childId} is archived but belongs to active parent ${parentId}, so the durable tree is split across storage states.`,
      ),
    });
  }

  // Anything under the archive root that is not a `.jsonl` we recognise.
  for (const session of archiveScan.sessions) {
    if (!isArchivedPath(session.path, options.agentDir)) {
      diagnostics.push({
        kind: "stray-file",
        sessionIds: [session.id],
        paths: [session.path],
        message: describeKind("stray-file", `${session.path} is not directly in the archive root.`),
      });
    }
  }

  return {
    archived: archiveScan.sessions,
    active: activeScan.sessions,
    diagnostics,
    // A relation we could not read is a session we know nothing about, so it
    // counts against completeness exactly like a file we could not open.
    complete: activeScan.complete && archiveScan.complete && relationProblems.length === 0,
    scanProblems: [...activeScan.problems, ...archiveScan.problems, ...relationProblems],
  };
}

/** One-line summary for a notification. */
export function summarizeDiagnostics(report: ReconcileReport): string {
  if (report.diagnostics.length === 0) return "Archive looks consistent.";
  const counts = new Map<DiagnosticKind, number>();
  for (const diagnostic of report.diagnostics) {
    counts.set(diagnostic.kind, (counts.get(diagnostic.kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ");
}

