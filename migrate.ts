/**
 * Archiving and restoring, with the failure semantics the design requires.
 *
 * Ordering is load-bearing, not cosmetic:
 *   archive - descendants first, root last
 *   restore - root first, descendants after
 * An interrupted archive therefore leaves the root active; an interrupted
 * restore leaves the root usable.
 *
 * This is about *our own* operations racing each other - two archives touching
 * the same files, the archive root and the index at once - and nothing to do
 * with whether some other pi process has a session open. It is deliberately
 * kept separate from that question: pi does not police it either.
 *
 * What this module deliberately does NOT promise:
 *   - that a rollback succeeds. A failed rollback reports `recovery-required`
 *     with where each file actually is, rather than claiming it restored.
 *   - that a crash reports anything.
 *   - that a plain rename stops a process outside the protocol from recreating
 *     a path. "Never overwrite" holds only for participants of the barrier.
 * All moves go through the header-derived destination, so a session always lands
 * back in the directory its own `cwd` implies.
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomicSync } from "./atomic-file.ts";
import { withMutationLock, type MutationLockOptions } from "./mutation-lock.ts";
import {
  ARCHIVE_INDEX_VERSION,
  archiveDestination,
  archiveIndexPath,
  archiveRoot,
  isActiveSessionPath,
  isArchivedPath,
  sessionsRoot,
} from "./paths.ts";
import { readHeaderNoWrite } from "./reader.ts";
import {
  type RawSessionInfo,
  type SubagentMetaResult,
  buildRelationGraph,
  collectSubagentTree,
  scanSessionRoot,
  scanSessionRoots,
} from "./scanner.ts";

export type OperationFailure =
  | "not-found"
  | "not-archived"
  | "unsupported-layout"
  | "not-a-root"
  | "blocked-by-runtime"
  | "destination-exists"
  | "cross-device"
  | "io-failure"
  | "cascade-unverified"
  | "recovery-required"
  | "mutation-busy"
  /** Two files claim one session id, so the graph's node is a half-truth. */
  | "duplicate-id";

export interface OperationSuccess {
  ok: true;
  affected: string[];
  warnings: string[];
}

export type OperationResult =
  | OperationSuccess
  | {
      ok: false;
      reason: OperationFailure;
      message: string;
      blockers?: string[];
      conflictPath?: string;
      moved?: string[];
      actualPaths?: Record<string, string | "unknown">;
    };

export interface MigrationDeps extends MutationLockOptions {
  now?: () => number;
  /**
   * How a session's subagent relation is read. Injectable so the state that
   * matters most - "this session exists and we cannot say whose child it is" -
   * can be produced on demand instead of only by breaking the filesystem.
   */
  readSubagentMeta?: (sessionPath: string) => Promise<SubagentMetaResult>;
  /**
   * Directories that may hold this host's active sessions - the default root plus
   * whatever the host reports. Note `getSessionDir()` is the session's own
   * project directory, so passing it *as* the root scans nothing; both are passed
   * and merged instead.
   */
  sessionRoots?: readonly string[];

  /** Set when the host can tell us it is holding the session open itself. */
  /**
   * The only ownership check: is this file the one the host is running right
   * now? Compared by canonical path, not by session id, because the path is what
   * actually gets moved, it works with a custom session dir, and it does not
   * depend on how two sessions happen to be named.
   *
   * Deliberately the *only* check. pi's own delete refuses just the session the
   * current runtime is using and moves on for every other one, so matching that
   * is the point: the archive does not get stricter than pi about a session
   * some other process might have open.
   */
  isHostActiveFile?: (sessionPath: string) => boolean;
  /** Overridable so the failure paths can be exercised. */
  renameFile?: (from: string, to: string) => void;
  scanActive?: () => ReturnType<typeof scanSessionRoot>;
  scanArchive?: () => ReturnType<typeof scanSessionRoot>;
}

interface Resolved {
  now: () => number;
  agentDir?: string;
  /** Where active sessions may live for this host. */
  sessionRoots: readonly string[];
  renameFile: (from: string, to: string) => void;
  /**
   * How a session's subagent relation is read. Injectable so the state that
   * matters most - "this session exists and we cannot say whose child it is" -
   * can be produced on demand instead of only by breaking the filesystem.
   */
  readSubagentMeta?: (sessionPath: string) => Promise<SubagentMetaResult>;
  /** Is this file the one the host is running right now? */
  isHostActiveFile: (sessionPath: string) => boolean;
  scanActive: () => ReturnType<typeof scanSessionRoot>;
  scanArchive: () => ReturnType<typeof scanSessionRoot>;
}

function resolvedSessionRoots(deps: MigrationDeps): readonly string[] {
  return deps.sessionRoots ?? [sessionsRoot(deps.agentDir)];
}

function resolveDeps(deps: MigrationDeps): Resolved {
  const now = deps.now ?? (() => Date.now());
  return {
    now,
    agentDir: deps.agentDir,
    readSubagentMeta: deps.readSubagentMeta,
    sessionRoots: deps.sessionRoots ?? [sessionsRoot(deps.agentDir)],
    renameFile: deps.renameFile ?? ((from, to) => renameSync(from, to)),
    isHostActiveFile: deps.isHostActiveFile ?? (() => false),
    scanActive: deps.scanActive ?? (() => scanSessionRoots(resolvedSessionRoots(deps))),
    scanArchive: deps.scanArchive ?? (() => scanSessionRoot(archiveRoot(deps.agentDir), { flat: true })),
  };
}

const fail =
  (reason: OperationFailure) =>
  (message: string, extra: Partial<Extract<OperationResult, { ok: false }>> = {}): OperationResult => ({
    ok: false,
    reason,
    message,
    ...extra,
  });

interface MoveStep {
  id: string;
  from: string;
  to: string;
}

/**
 * Execute a move plan, attempting a reverse rollback when one step fails.
 * Returns a failure result; success is signalled by `undefined`.
 */
function executePlan(plan: readonly MoveStep[], deps: Resolved): OperationResult | undefined {
  const moved: MoveStep[] = [];
  for (const step of plan) {
    try {
      deps.renameFile(step.from, step.to);
      moved.push(step);
    } catch (error) {
      let clean = true;
      for (let index = moved.length - 1; index >= 0; index -= 1) {
        try {
          deps.renameFile(moved[index].to, moved[index].from);
        } catch {
          clean = false;
        }
      }
      if (clean) {
        const reason = (error as NodeJS.ErrnoException).code === "EXDEV" ? "cross-device" : "io-failure";
        return fail(reason)(String(error));
      }
      const actualPaths: Record<string, string | "unknown"> = {};
      // Report every member of the plan, not only the ones that moved: an
      // operator reconciling the state needs to know where the untouched ones
      // are too, otherwise "unknown" gaps have to be re-derived by hand.
      for (const step of plan) {
        actualPaths[step.id] = existsSync(step.to) ? step.to : existsSync(step.from) ? step.from : "unknown";
      }
      return {
        ok: false,
        reason: "recovery-required",
        message: `move failed and the rollback did not complete: ${String(error)}`,
        moved: moved.map((step3) => step3.id),
        actualPaths,
      };
    }
  }
  return undefined;
}

/**
 * Which members cannot be moved: the ones the host itself is running. Nothing
 * else - no claims, no freshness heuristic - because pi does not check whether
 * another process has a session open either.
 */
function runtimeBlockers(paths: ReadonlyMap<string, string>, deps: Resolved): string[] {
  const blockers: string[] = [];
  for (const [id, path] of paths) {
    if (deps.isHostActiveFile(path)) blockers.push(id);
  }
  return blockers;
}

function findSession(sessions: readonly RawSessionInfo[], id: string): RawSessionInfo | undefined {
  return sessions.find((session) => session.id === id);
}

function withBarrier<R>(deps: MigrationDeps, resolved: Resolved, work: () => Promise<R>): Promise<R | OperationResult> {
  return withMutationLock({ agentDir: resolved.agentDir, ...deps }, work).then((outcome) =>
    outcome.ok ? outcome.value : fail("mutation-busy")(outcome.detail),
  );
}

/** A target-local view of one durable session tree. */
type TreePreflight =
  | {
      ok: true;
      paths: Map<string, string>;
      descendantsFirst: string[];
      rootFirst: string[];
    }
  | {
      ok: false;
      reason: OperationFailure;
      message: string;
    };

/**
 * Build only the durable tree reachable from `rootId`.
 *
 * This deliberately does not turn unrelated damage into a global gate. An
 * unreadable or contradictory session elsewhere is a diagnostic for
 * `/archive-check`; it is not evidence that this target tree is unsafe. The
 * operation refuses only when the target itself, or a node actually reached
 * from it, is contradictory/unreadable.
 */
async function evaluateTargetTree(
  rootId: string,
  sessions: readonly RawSessionInfo[],
  resolved: Resolved,
): Promise<TreePreflight> {
  const root = findSession(sessions, rootId);
  if (!root) return { ok: false, reason: "not-found", message: `no session with id ${rootId}` };

  const graphOptions = resolved.readSubagentMeta ? { readSubagentMeta: resolved.readSubagentMeta } : {};
  const graph = await buildRelationGraph(sessions, graphOptions);

  // If the selected file itself cannot tell us whether it is a child, it must
  // not be offered as an independent root. This is local to the selected file;
  // an unreadable relation in an unrelated session does not freeze the world.
  if (graph.status[root.path] !== "verified") {
    return {
      ok: false,
      reason: "cascade-unverified",
      message: "the selected session's subagent relation could not be read",
    };
  }

  const parentId = graph.parentOf.get(rootId);
  if (parentId && sessions.some((session) => session.id === parentId)) {
    return {
      ok: false,
      reason: "not-a-root",
      message: "this is a subagent child whose parent is on the same side; handle it together with its root session",
    };
  }
  // If the recorded parent is absent from this storage side, the tree is already
  // split. Treat this child as a recovery root so archive/restore can repair the
  // split instead of reporting it forever with no safe UI action.

  const tree = await collectSubagentTree(rootId, sessions, { ...graphOptions, graph });
  const ids = new Set(tree.descendantsFirst);

  // Ambiguity matters only if the contradictory node is in the requested tree.
  // The graph links a multi-parent child to every declared parent, so a conflict
  // reachable from this root is necessarily present in `ids`.
  const conflict = graph.ambiguous.find((entry) => ids.has(entry.id));
  if (conflict) {
    return {
      ok: false,
      reason: "duplicate-id",
      message:
        `session id ${conflict.id} is claimed by ${conflict.paths.length > 1 ? "more than one file" : "more than one parent"}: ` +
        conflict.paths.join(" | ") +
        (conflict.parents ? ` (parents: ${conflict.parents.join(", ")})` : ""),
    };
  }

  const paths = new Map<string, string>();
  for (const id of tree.descendantsFirst) {
    const candidates = sessions.filter((session) => session.id === id);
    if (candidates.length !== 1) {
      return {
        ok: false,
        reason: candidates.length === 0 ? "not-found" : "duplicate-id",
        message:
          candidates.length === 0
            ? `cascade member ${id} is not on disk`
            : `session id ${id} is claimed by more than one file`,
      };
    }
    const session = candidates[0]!;
    if (graph.status[session.path] !== "verified") {
      return {
        ok: false,
        reason: "cascade-unverified",
        message: `the relation for cascade member ${id} could not be read`,
      };
    }
    paths.set(id, session.path);
  }

  return {
    ok: true,
    paths,
    descendantsFirst: tree.descendantsFirst,
    rootFirst: tree.rootFirst,
  };
}

function destinationConflict(
  ids: readonly string[],
  paths: ReadonlyMap<string, string>,
  destinationOf: (id: string, from: string) => string,
): { id: string; path: string } | undefined {
  for (const id of ids) {
    const from = paths.get(id);
    if (!from) continue;
    const to = destinationOf(id, from);
    if (existsSync(to)) return { id, path: to };
  }
  return undefined;
}

/** Move a session and its already-persisted subagent descendants into the archive. */
export async function archiveSessionTree(rootId: string, deps: MigrationDeps = {}): Promise<OperationResult> {
  const resolved = resolveDeps(deps);

  const outcome = await withBarrier(deps, resolved, async (): Promise<OperationResult> => {
    // The mutation lease is acquired before the decisive scan. A child that has
    // actually reached disk before this point is therefore part of the durable
    // graph and comes along; a hypothetical future child is not guessed at.
    const active = resolved.scanActive();
    const root = findSession(active.sessions, rootId);
    if (!root) return fail("not-found")(`no active session with id ${rootId}`);
    if (!isActiveSessionPath(root.path, resolved.sessionRoots)) {
      return fail("unsupported-layout")(`not in an active sessions root: ${root.path}`);
    }

    const tree = await evaluateTargetTree(rootId, active.sessions, resolved);
    if (!tree.ok) return fail(tree.reason)(`${tree.message}; nothing was moved`);

    const blockers = runtimeBlockers(tree.paths, resolved);
    if (blockers.length > 0) {
      return fail("blocked-by-runtime")(
        `${blockers.length} session(s) in this tree include the one this runtime is using`,
        { blockers },
      );
    }

    const conflict = destinationConflict(
      tree.descendantsFirst,
      tree.paths,
      (_id, from) => archiveDestination(from, resolved.agentDir),
    );
    if (conflict) {
      return fail("destination-exists")(`${conflict.id} already has an archived file`, {
        conflictPath: conflict.path,
      });
    }

    try {
      mkdirSync(archiveRoot(resolved.agentDir), { recursive: true });
    } catch (error) {
      return fail("io-failure")(
        `the archive directory could not be created (${String(error)}); nothing was moved`,
      );
    }

    const plan: MoveStep[] = tree.descendantsFirst.map((id) => ({
      id,
      from: tree.paths.get(id)!,
      to: archiveDestination(tree.paths.get(id)!, resolved.agentDir),
    }));

    const moved = executePlan(plan, resolved);
    if (moved !== undefined) return moved;

    const recorded = recordArchived(plan, resolved);
    return {
      ok: true,
      affected: plan.map((step) => step.id),
      warnings: recorded.saved ? [] : [`archived, but the index was left alone: ${recorded.reason ?? "unknown reason"}`],
    };
  });

  return outcome;
}

/** Restore a session and its archived, already-persisted subagent descendants. */
export async function restoreSessionTree(rootId: string, deps: MigrationDeps = {}): Promise<OperationResult> {
  const resolved = resolveDeps(deps);

  const outcome = await withBarrier(deps, resolved, async (): Promise<OperationResult> => {
    const archived = resolved.scanArchive();
    const root = findSession(archived.sessions, rootId);
    if (!root) return fail("not-archived")(`${rootId} is not in the archive`);
    if (!isArchivedPath(root.path, resolved.agentDir)) {
      return fail("unsupported-layout")(`not directly in the archive root: ${root.path}`);
    }

    const tree = await evaluateTargetTree(rootId, archived.sessions, resolved);
    if (!tree.ok) return fail(tree.reason)(`${tree.message}; nothing was moved`);

    const index = loadArchiveIndex(resolved.agentDir).entries;
    const destinations = new Map<string, string>();
    for (const id of tree.rootFirst) {
      const from = tree.paths.get(id);
      if (!from) return fail("not-found")(`cascade member ${id} is not in the archive`);
      const recorded = index.get(id);
      if (recorded?.originalPath) {
        destinations.set(id, recorded.originalPath);
        continue;
      }

      const session = findSession(archived.sessions, id);
      let cwd = recorded?.cwd || session?.cwd;
      if (!cwd) {
        try {
          cwd = readHeaderNoWrite(from).cwd;
        } catch (error) {
          return fail("not-found")(`cannot tell where ${id} belongs: ${String(error)}`);
        }
      }
      const encoded = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
      destinations.set(id, join(sessionsRoot(resolved.agentDir), encoded, basename(from)));
    }

    for (const id of tree.rootFirst) {
      const to = destinations.get(id)!;
      if (existsSync(to)) {
        return fail("destination-exists")(`a session already exists at the restore destination for ${id}`, {
          conflictPath: to,
        });
      }
    }

    // Create destination directories only after every destination has been
    // validated, so a refused restore leaves no partial directory side effects.
    try {
      for (const to of destinations.values()) mkdirSync(dirname(to), { recursive: true });
    } catch (error) {
      return fail("io-failure")(`a restore directory could not be created (${String(error)}); nothing was moved`);
    }

    const plan: MoveStep[] = tree.rootFirst.map((id) => ({
      id,
      from: tree.paths.get(id)!,
      to: destinations.get(id)!,
    }));

    const moved = executePlan(plan, resolved);
    if (moved !== undefined) return moved;

    const dropped = dropArchived(plan.map((step) => step.id), resolved);
    return {
      ok: true,
      affected: plan.map((step) => step.id),
      warnings: dropped.changed || !dropped.reason ? [] : [`restored, but the index was left alone: ${dropped.reason}`],
    };
  });

  return outcome;
}

export interface ArchivedSessionRow {
  session: RawSessionInfo;
  archivedAt?: string;
  cwd?: string;
  /** Exact live path recorded when archived, when the v2 index has it. */
  originalPath?: string;
  /** Direct subagent children, folded into this row. */
  childCount: number;
  /** Every descendant, which is what the archived count actually was. */
  descendantCount: number;
  hasChildren: boolean;
  /** Parent id when this row is an orphan/split recovery root. */
  splitParentId?: string;
}

/** Rows for the `/archived` view. Children are folded into their root's row. */
export interface ArchivedListResult {
  rows: ArchivedSessionRow[];
  problems: Array<{ path: string; kind: string; message: string }>;
}

export async function listArchivedSessions(deps: MigrationDeps = {}): Promise<ArchivedListResult> {
  const resolved = resolveDeps(deps);
  const archived = resolved.scanArchive();
  const graph = await buildRelationGraph(archived.sessions);
  const index = loadArchiveIndex(resolved.agentDir).entries;

  const countDescendants = (id: string): number => {
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
  };

  const rows: ArchivedSessionRow[] = [];
  const presentIds = new Set(archived.sessions.map((session) => session.id));
  for (const session of archived.sessions) {
    const parentId = graph.parentOf.get(session.id);
    if (parentId && presentIds.has(parentId)) continue; // folded into its parent row
    const children = graph.childrenByParent.get(session.id) ?? [];
    const entry = index.get(session.id);
    rows.push({
      session,
      archivedAt: entry?.archivedAt,
      cwd: entry?.cwd ?? session.cwd,
      originalPath: entry?.originalPath,
      childCount: children.length,
      descendantCount: countDescendants(session.id),
      hasChildren: children.length > 0,
      ...(parentId ? { splitParentId: parentId } : {}),
    });
  }
  rows.sort((a, b) => {
    const aArchived = Date.parse(a.archivedAt ?? "");
    const bArchived = Date.parse(b.archivedAt ?? "");
    const aTime = Number.isFinite(aArchived) ? aArchived : a.session.mtimeMs;
    const bTime = Number.isFinite(bArchived) ? bArchived : b.session.mtimeMs;
    return bTime - aTime || a.session.path.localeCompare(b.session.path);
  });
  return { rows, problems: [...archived.problems, ...graph.problems] };
}

/** Decorative index. The file location is the truth; this only records when and from where. */
export interface ArchiveIndexEntry {
  archivedAt: string;
  cwd: string;
  /**
   * Where the file came from. Recorded rather than re-derived from `cwd`,
   * because the encoding of a cwd into a directory name is pi's business and
   * can change; and because a session may legitimately live somewhere a
   * derivation would get wrong.
   */
  originalPath?: string;
  /** The sessions root in force when it was archived (`--session-dir` aware). */
  originalSessionDir?: string;
}

export type LoadedArchiveIndex =
  | { writable: true; entries: Map<string, ArchiveIndexEntry> }
  | { writable: false; reason: string; entries: Map<string, ArchiveIndexEntry> };

/**
 * Read the index.
 *
 * An unknown or corrupt schema is *readable* - the archive files themselves are
 * the truth and must stay reachable - but not writable. Treating it as an empty
 * v1 would let the next archive overwrite a future version's file, which is how
 * an upgrade of pi-web loses another tool's metadata.
 */
export function loadArchiveIndex(agentDir?: string): LoadedArchiveIndex {
  const entries = new Map<string, ArchiveIndexEntry>();
  const file = archiveIndexPath(agentDir);
  if (!existsSync(file)) return { writable: true, entries };

  let parsed: { version?: unknown; entries?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; entries?: unknown };
  } catch (error) {
    return { writable: false, reason: `index is not readable JSON: ${String(error)}`, entries };
  }
  if (typeof parsed?.version !== "number" || typeof parsed.entries !== "object" || !parsed.entries) {
    return { writable: false, reason: `index has no usable entries field (version ${String(parsed?.version)})`, entries };
  }
  // A newer schema is read best-effort - the fields we understand are still
  // useful, and the archive files themselves are the truth - but never written.
  const fromNewer = typeof parsed.version === "number" && parsed.version > ARCHIVE_INDEX_VERSION;

  // v1 entries simply have no originalPath; they stay readable and the restore
  // path falls back to deriving it from the cwd.
  for (const [id, value] of Object.entries(parsed.entries as Record<string, unknown>)) {
    const entry = value as Partial<ArchiveIndexEntry>;
    if (
      typeof entry?.archivedAt !== "string" ||
      !Number.isFinite(Date.parse(entry.archivedAt)) ||
      typeof entry?.cwd !== "string"
    ) {
      continue;
    }
    entries.set(id, {
      archivedAt: entry.archivedAt,
      cwd: entry.cwd,
      ...(typeof entry.originalPath === "string" ? { originalPath: entry.originalPath } : {}),
      ...(typeof entry.originalSessionDir === "string" ? { originalSessionDir: entry.originalSessionDir } : {}),
    });
  }

  if (fromNewer) {
    return {
      writable: false,
      reason: `index was written by a newer version (${parsed.version} > ${ARCHIVE_INDEX_VERSION})`,
      entries,
    };
  }
  return { writable: true, entries };
}

function saveArchiveIndex(entries: Map<string, ArchiveIndexEntry>, agentDir?: string): { saved: boolean; reason?: string } {
  const loaded = loadArchiveIndex(agentDir);
  if (!loaded.writable) return { saved: false, reason: loaded.reason };
  try {
    mkdirSync(archiveRoot(agentDir), { recursive: true });
    writeFileAtomicSync(
      archiveIndexPath(agentDir),
      `${JSON.stringify({ version: ARCHIVE_INDEX_VERSION, entries: Object.fromEntries(entries) }, null, 2)}\n`,
    );
    return { saved: true };
  } catch (error) {
    return { saved: false, reason: String(error) };
  }
}

function recordArchived(plan: readonly MoveStep[], deps: Resolved): { saved: boolean; reason?: string } {
  const loaded = loadArchiveIndex(deps.agentDir);
  if (!loaded.writable) return { saved: false, reason: loaded.reason };
  const entries = loaded.entries;
  const archivedAt = new Date(deps.now()).toISOString();
  for (const step of plan) {
    let cwd = "";
    try {
      cwd = readHeaderNoWrite(step.to).cwd;
    } catch {
      // The file just moved; if its header cannot be read the index entry is
      // still useful, it just will not carry a cwd.
    }
    entries.set(step.id, {
      archivedAt,
      cwd,
      originalPath: step.from,
      originalSessionDir: dirname(step.from),
    });
  }
  return saveArchiveIndex(entries, deps.agentDir);
}

function dropArchived(ids: readonly string[], deps: Resolved): { changed: boolean; reason?: string } {
  const loaded = loadArchiveIndex(deps.agentDir);
  if (!loaded.writable) return { changed: false, reason: loaded.reason };
  let changed = false;
  for (const id of ids) changed = loaded.entries.delete(id) || changed;
  if (!changed) return { changed: false };
  const saved = saveArchiveIndex(loaded.entries, deps.agentDir);
  return saved.saved ? { changed: true } : { changed: false, reason: saved.reason };
}
