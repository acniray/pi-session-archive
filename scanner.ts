/**
 * Enumerating session files and building the subagent relation graph.
 *
 * This is deliberately independent of pi's `SessionManager.list*()`: those
 * return `null` for any file whose first entry is not a session header
 * (`session-manager.js:509-513`), so a split fragment - exactly the thing we
 * must be able to *see* - would be invisible to them. We enumerate raw paths and
 * classify them ourselves.
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionIdFromFileName } from "./paths.ts";

/** Written by pi-web's own subagent runtime into each child session file. */
export const SUBAGENT_META_TYPE = "pi-web:subagent";

/**
 * Bounded read of the head of a file.
 *
 * `readFileSync` then `slice(0, N)` reads the whole file and throws the rest away:
 * with hundreds of multi-megabyte sessions that is hundreds of megabytes of I/O
 * to look at one header. This reads at most `maxBytes` and stops.
 */
export function readHead(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Enough for the header, the first message and, in practice, the relation entry. */
const HEADER_READ_BYTES = 64 * 1024;
/**
 * How many lines of a session file are searched for the relation entry.
 *
 * The bound is on line *position*, not on bytes, and that distinction is the
 * whole design. pi-web appends the relation entry before it creates the child
 * session, so the entry is written second; measured on 117 real child sessions,
 * all 117 carry it on line 2 and none anywhere else. So a child that pi-web
 * wrote cannot hide past the fourth line, and reading four lines settles it for
 * every file regardless of how large the file is.
 *
 * Bytes would have been the wrong axis, twice over. A byte window says nothing
 * about where a *line* ends - the entry carries the whole task and the prompt
 * plan, so its line routinely runs past any fixed size - and a window that is
 * large enough to hold a real entry is also large enough to run into ordinary
 * messages that merely mention the marker.
 */
const RELATION_SCAN_LINES = 4;

/**
 * The longest single line we will read while looking for the relation.
 *
 * This bounds memory, and it is a statement about the line, not about the
 * verdict: a line longer than this is one we did not scan, so the session stays
 * *unknown*. The caller can report that uncertainty without turning unrelated
 * sessions into a global veto. It is deliberately far above anything pi writes.
 */
const RELATION_LINE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The same statement about the header line: a session header we could not read
 * to its end is a session we do not know, not a file we have ruled out.
 */
const HEADER_LINE_MAX_BYTES = 1024 * 1024;


/** Latest session name found in the bounded head, for a list label. */
function sessionNameFromHead(head: string): string | undefined {
  let name: string | undefined;
  for (const line of head.split("\n").slice(1)) {
    if (!line.includes('"type":"session_info"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; name?: unknown };
      if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim();
    } catch {
      // A malformed line is not a usable name.
    }
  }
  return name;
}

function firstUserMessage(head: string): string | undefined {
  for (const line of head.split("\n").slice(1)) {
    if (!line.includes('"role":"user"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const text = messageText(entry.message.content);
      if (text) return text;
    } catch {
      // A malformed line simply is not the preview.
    }
  }
  return undefined;
}

export interface RawSessionInfo {
  /** From the file header when readable, otherwise derived from the file name. */
  id: string;
  path: string;
  cwd?: string;
  /** Display name from the latest `session_info` entry, if the session has one. */
  name?: string;
  /** First user message, for a list preview. Read from the bounded head. */
  firstMessage?: string;
  mtimeMs: number;
  size: number;
  /** True when the id came from the file name because the header was unusable. */
  idFromFileName: boolean;
}

export type ScanProblemKind =
  | "unreadable"
  | "headerless"
  | "malformed-header"
  | "id-mismatch"
  /** A header line too long to read whole: a session we cannot classify, and so
   *  must not report as a non-session. */
  | "header-oversized";

export interface ScanProblem {
  path: string;
  kind: ScanProblemKind;
  message: string;
  /**
   * Whether this problem makes the listing untrustworthy.
   *
   * `blocking` - we could not enumerate or classify the candidate. The scan is
   * incomplete and diagnostics should say so. This is not a global archive
   * veto: a mutation decides only from the durable target tree it can actually
   * reach.
   *
   * `advisory` - we read the file and it is simply not a well-formed session: a
   * split-write fragment, a corrupt first line, a header whose id disagrees with
   * its file name. Such a file cannot hide a child, because the cascade follows
   * parent links and this one has none; it is reported, and it must not freeze
   * every other operation.
   */
  severity: "blocking" | "advisory";
}

export interface ScanResult {
  /**
   * False when any candidate could not be read or classified. Callers must
   * surface this: a partial scan must never be presented as the full set.
   */
  complete: boolean;
  sessions: RawSessionInfo[];
  problems: ScanProblem[];
}

/** Did we fail to enumerate something? Only that can make a listing untrustworthy. */
function isBlocking(problem: ScanProblem): boolean {
  return problem.severity === "blocking";
}

export interface SubagentMeta {
  parentSessionId: string;
  parentSessionPath?: string;
}

function readHeaderLine(filePath: string): {
  /** The bounded head, which also carries the first message for the preview. */
  head: string;
  /** The header line on its own, read whole. */
  firstLine: string;
  truncated: boolean;
  oversize?: boolean;
} {
  // Bounded for real: a whole-file read here costs hundreds of megabytes across
  // a large session set, to look at one header line.
  const head = readHead(filePath, HEADER_READ_BYTES);
  const newline = head.indexOf("\n");
  if (newline >= 0) return { head, firstLine: head.slice(0, newline), truncated: false };
  // No newline in the window: the header line is either longer than the window
  // or the file has no newline at all. Keep reading up to a much larger cap
  // before calling it anything - a header cut in half is a session we have not
  // read, not a file we have ruled out.
  if (statSync(filePath).size <= HEADER_READ_BYTES) return { head, firstLine: head, truncated: false };
  const longer = readHead(filePath, HEADER_LINE_MAX_BYTES);
  const laterNewline = longer.indexOf("\n");
  if (laterNewline >= 0) {
    return { head, firstLine: longer.slice(0, laterNewline), truncated: false };
  }
  return { head, firstLine: head, truncated: true, oversize: true };
}

/** Classify one `.jsonl` file. Never throws; failures become problems. */
export function classifySessionFile(filePath: string, stats?: { mtimeMs: number; size: number }): {
  info?: RawSessionInfo;
  problem?: ScanProblem;
} {
  let stat = stats;
  try {
    stat ??= statSync(filePath);
  } catch (error) {
    return { problem: { path: filePath, kind: "unreadable", message: String(error), severity: "blocking" } };
  }
  const fromName = sessionIdFromFileName(filePath);
  const base = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size };
  try {
    const { head, firstLine, truncated, oversize } = readHeaderLine(filePath);
    if (oversize) {
      return {
        problem: {
          ...base,
          kind: "header-oversized",
          message: `the header line is longer than ${Math.round(HEADER_LINE_MAX_BYTES / 1024)}KB, so this session is unknown rather than malformed`,
          severity: "blocking",
        },
      };
    }
    if (!firstLine.trim()) {
      return { problem: { ...base, kind: "headerless", message: "first line is empty", severity: "advisory" } };
    }
    let header: unknown;
    try {
      header = JSON.parse(firstLine);
    } catch (error) {
      // A fragment from a split write lands here: a bare entry, no header.
      return {
        problem: {
          ...base,
          kind: "malformed-header",
          message: truncated ? "header line truncated" : `header is not JSON: ${String(error)}`,
          severity: "advisory",
        },
      };
    }
    const record = header as { type?: unknown; id?: unknown; cwd?: unknown };
    if (record?.type !== "session" || typeof record.id !== "string") {
      return {
        problem: {
          ...base,
          kind: "headerless",
          message: `first entry is ${JSON.stringify(record?.type) ?? "unknown"}, not a session header`,
          severity: "advisory",
        },
      };
    }
    // The header is authoritative even when the file name disagrees: pi opens
    // sessions by the id inside the header, so that is the id to list and to
    // cascade on. Dropping the file would hide a real session - and a child -
    // from the graph, which is the one failure mode a cascade cannot survive.
    const info: RawSessionInfo = {
      ...base,
      id: record.id,
      cwd: typeof record.cwd === "string" ? record.cwd : undefined,
      name: sessionNameFromHead(head),
      firstMessage: firstUserMessage(head),
      idFromFileName: false,
    };
    if (fromName && fromName !== record.id) {
      return {
        info,
        problem: {
          ...base,
          kind: "id-mismatch",
          message: `header id ${record.id} != file name id ${fromName}`,
          severity: "advisory",
        },
      };
    }
    return { info };
  } catch (error) {
    return { problem: { ...base, kind: "unreadable", message: String(error), severity: "blocking" } };
  }
}

/** List the immediate project directories of a sessions root.
 *  A missing root is not a problem - nothing archived yet is a normal state -
 *  but a root we cannot read means the listing may be incomplete. */
function projectDirs(root: string): { dirs: string[]; problems: ScanProblem[] } {
  try {
    return {
      dirs: readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => join(root, entry.name)),
      problems: [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { dirs: [], problems: [] };
    return {
      dirs: [],
      problems: [{ path: root, kind: "unreadable", message: String(error), severity: "blocking" }],
    };
  }
}

/**
 * Scan one root for `.jsonl` files at the layout pi uses
 * (`<root>/<project>/<file>.jsonl`). `flat: true` scans a root whose files sit
 * directly inside it, which is the archive layout.
 */
/**
 * Scan several candidate roots at once.
 *
 * A root may be either a sessions root whose children are project directories,
 * or a project directory whose files sit directly inside - and from the host we
 * get both kinds, because `getSessionDir()` is the second kind. Both layouts
 * are scanned and merged by path, so nothing depends on telling them apart.
 */
export function scanSessionRoots(roots: readonly string[]): ScanResult {
  const sessions = new Map<string, RawSessionInfo>();
  const problems: ScanProblem[] = [];
  for (const root of roots) {
    for (const flat of [false, true]) {
      const result = scanSessionRoot(root, { flat });
      for (const session of result.sessions) sessions.set(session.path, session);
      problems.push(...result.problems);
    }
  }
  const list = [...sessions.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return { complete: !problems.some(isBlocking), sessions: list, problems };
}

export function scanSessionRoot(root: string, options: { flat?: boolean } = {}): ScanResult {
  const { dirs, problems: rootProblems } = options.flat ? { dirs: [root], problems: [] } : projectDirs(root);
  const sessions: RawSessionInfo[] = [];
  const problems: ScanProblem[] = [...rootProblems];

  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch (error) {
      // A directory that is simply not there yet holds no sessions. Only a
      // genuine read failure makes the scan incomplete.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        problems.push({ path: dir, kind: "unreadable", message: String(error), severity: "blocking" });
      }
      continue;
    }
    for (const name of names) {
      const filePath = join(dir, name);
      const { info, problem } = classifySessionFile(filePath);
      // Not `else if`: a file can be listed *and* carry a problem (an id that
      // disagrees with its file name), and dropping that problem would hide the
      // disagreement from every diagnostic that reads this result.
      if (info) sessions.push(info);
      if (problem) problems.push(problem);
    }
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return { complete: !problems.some(isBlocking), sessions, problems };
}

/**
 * Read the subagent relation entry. Distinguishes "not a subagent child" from
 * "could not be read", because the second one means the descendant set may be
 * incomplete and callers must not present it as complete.
 */
export type SubagentMetaResult =
  | { kind: "meta"; meta: SubagentMeta; conflicts: string[] }
  | { kind: "none" }
  | { kind: "unverified"; reason: string }
  | { kind: "unreadable"; error: unknown };

export async function readSubagentMeta(
  filePath: string,
  options: { readChunks?: ChunkReader } = {},
): Promise<SubagentMetaResult> {
  try {
    const found = await findSubagentMetaInWindow(
      filePath,
      RELATION_SCAN_LINES,
      RELATION_LINE_MAX_BYTES,
      options.readChunks ?? readChunksFromFile,
    );
    if (found.kind === "meta") return found;
    if (found.kind === "line-too-long") {
      return { kind: "unverified", reason: "a line in the first four is too long to scan" };
    }
    if (found.kind === "unreadable-marker") {
      return { kind: "unverified", reason: "a line mentions the relation entry but cannot be read as one" };
    }
    // Four whole lines, no declaration: this session is a root. That is an
    // answer, and it rests on the writer's ordering rather than on a guess.
    return { kind: "none" };
  } catch (error) {
    return { kind: "unreadable", error };
  }
}

/**
 * Read the first `lines` whole lines and decide what they say about the relation.
 *
 * Every outcome is distinguished, because "we looked and it is not there" and
 * "we stopped looking" must never look alike:
 *
 *  - `meta`        a relation entry, with any *other* parents it declares
 *  - `none`        four whole lines, no declaration
 *  - `line-too-long` a line we did not read, so the remaining lines are unseen
 *  - `unreadable-marker` the marker text is there but the line is not a readable
 *                      relation entry
 */
async function findSubagentMetaInWindow(
  filePath: string,
  lines: number,
  lineCapBytes: number,
  reader: ChunkReader = readChunksFromFile,
): Promise<
  | { kind: "meta"; meta: SubagentMeta; conflicts: string[] }
  | { kind: "none" }
  | { kind: "line-too-long" }
  | { kind: "unreadable-marker" }
> {
  const parents: string[] = [];
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let completed = 0;

  const finish = ():
    | { kind: "meta"; meta: SubagentMeta; conflicts: string[] }
    | { kind: "none" } => {
    if (parents.length === 0) return { kind: "none" };
    const [first, ...rest] = parents;
    return { kind: "meta", meta: { parentSessionId: first }, conflicts: [...new Set(rest)] };
  };

  const inspectLine = (bytes: Buffer) => {
    const complete = bytes.toString("utf8");
    completed += 1;
    if (complete.includes(SUBAGENT_META_TYPE)) {
      const parsed = parseSubagentMetaLine(complete);
      if (parsed.kind === "relation") parents.push(parsed.meta.parentSessionId);
      else if (parsed.kind === "unreadable") return { kind: "unreadable-marker" } as const;
    }
    return undefined;
  };

  for (const chunk of reader(filePath, CHUNK_BYTES)) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline < 0 ? chunk.length : newline;
      const piece = chunk.subarray(start, end);
      pendingBytes += piece.length;
      if (pendingBytes > lineCapBytes) return { kind: "line-too-long" };
      if (piece.length > 0) pending.push(Buffer.from(piece));

      if (newline < 0) break;

      const line = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      start = newline + 1;
      const verdict = inspectLine(line);
      if (verdict) return verdict;
      if (completed >= lines) return finish();
    }
    if (completed >= lines) return finish();
  }

  // A JSONL writer normally terminates each entry with a newline, but a complete
  // final entry without one is still a complete entry. Treating it as invisible
  // loses a valid relation exactly at EOF.
  if (pendingBytes > 0 && completed < lines) {
    const line = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
    const verdict = inspectLine(line);
    if (verdict) return verdict;
  }

  return finish();
}

/** How the window reads. Injectable so a test can measure what was read. */
export type ChunkReader = (filePath: string, chunkBytes: number) => Iterable<Buffer>;

/** How much is pulled per read. Large enough to be efficient, small enough that
 *  a single chunk is never the reason a file becomes expensive. */
const CHUNK_BYTES = 64 * 1024;

function* readChunksFromFile(filePath: string, chunkBytes: number): Generator<Buffer> {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(chunkBytes);
    for (;;) {
      const read = readSync(fd, buffer, 0, chunkBytes, null);
      if (read <= 0) return;
      yield buffer.subarray(0, read);
    }
  } finally {
    closeSync(fd);
  }
}

function parseSubagentMetaLine(line: string):
  | { kind: "relation"; meta: SubagentMeta }
  | { kind: "not-a-relation" }
  | { kind: "unreadable" } {
  let entry: {
    type?: unknown;
    customType?: unknown;
    data?: { version?: unknown; parentSessionId?: unknown; parentSessionPath?: unknown };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    // The marker text is in here and the line is not valid JSON. It may be a
    // damaged entry or a message with the text pasted into it; neither is
    // evidence of anything, so it is reported rather than assumed.
    return { kind: "unreadable" };
  }
  // Valid JSON that is not a relation entry - a user or a tool quoting it. The
  // marker travels, and on real data it has travelled into 15 results from
  // `bash` and `edit` alone.
  if (entry.type !== "custom" || entry.customType !== SUBAGENT_META_TYPE) return { kind: "not-a-relation" };
  const data = entry.data;
  // It claims to be the entry, so the claim is not honoured - and it is not read
  // as the absence of one either.
  if (data?.version !== 1 || typeof data.parentSessionId !== "string") return { kind: "unreadable" };
  return {
    kind: "relation",
    meta: {
      parentSessionId: data.parentSessionId,
      parentSessionPath: typeof data.parentSessionPath === "string" ? data.parentSessionPath : undefined,
    },
  };
}

export interface SubagentTree {
  /** Post-order: every descendant before its parent. Archive order. */
  descendantsFirst: string[];
  /**
   * Pre-order: every parent before its own descendants. Restore order. Keeping
   * this a true pre-order is what stops an interrupted restore from leaving a
   * child active while its parent is still archived.
   */
  rootFirst: string[];
  problems: ScanProblem[];
  /** Every relation in the scanned set could be read. Diagnostic metadata. */
  complete: boolean;
}

/**
 * How far we got reading a session's relation entry. These are two different
 * things and are kept apart deliberately: a caller must not have to remember
 * what "complete" meant to decide whether it may move files.
 *
 *  - `verified`   - the head held no relation and that is the answer, because
 *                   the writer puts the relation first (see `readSubagentMeta`)
 *  - `unreadable` - the file could not be read at all, so it may be a child we
 *                   never saw
 */
export type RelationScanStatus = "verified" | "unreadable";

/** One session id claimed by more than one file, or given two different parents. */
export interface AmbiguousId {
  id: string;
  /** Every file that claims this id, so the refusal can name all of them. */
  paths: string[];
  /** The conflicting parents, when two files disagree rather than duplicate. */
  parents?: string[];
}

export interface RelationGraph {
  /** sessionId -> parentSessionId, for sessions that declare a relation. */
  parentOf: Map<string, string>;
  childrenByParent: Map<string, string[]>;
  /** Every relation in the scanned set could be read. Used for diagnostics and
   * list completeness, not as a global mutation gate. */
  readable: boolean;
  /**
   * Ids that two files claim, or that two files give different parents.
   *
   * The graph is keyed by id, so such an id is a node whose edges are a
   * half-truth: one file is picked arbitrarily downstream and the other is
   * never moved. Nothing here is a judgement call - a caller that is about to
   * move these ids must refuse and name the files.
   */
  ambiguous: AmbiguousId[];
  problems: ScanProblem[];
  status: Record<string, RelationScanStatus>;
}

/**
 * Build the id-keyed relation graph from raw session files.
 *
 * Keying by id (not by path) is what lets the graph survive a move: an archived
 * child is still discovered as a child once the tree is rebuilt from the archive
 * root, with no header rewrite.
 */
export async function buildRelationGraph(
  sessions: readonly RawSessionInfo[],
  options: { readSubagentMeta?: (path: string) => Promise<SubagentMetaResult>; readChunks?: ChunkReader } = {},
): Promise<RelationGraph> {
  const injected = options.readSubagentMeta;
  const readMeta = injected
    ? (path: string) => injected(path)
    : (path: string) => readSubagentMeta(path, options.readChunks ? { readChunks: options.readChunks } : {});
  const parentOf = new Map<string, string>();
  const childrenByParent = new Map<string, string[]>();
  const problems: ScanProblem[] = [];
  // Ids claimed by more than one file, and ids given two different parents. The
  // graph cannot represent either, so they are collected here and refused by
  // the caller rather than resolved by picking a winner.
  const pathsById = new Map<string, string[]>();
  const parentsById = new Map<string, Set<string>>();

  for (const session of sessions) {
    const claimed = pathsById.get(session.id);
    if (claimed) claimed.push(session.path);
    else pathsById.set(session.id, [session.path]);
    const result = await readMeta(session.path);
    if (result.kind === "unverified") {
      problems.push({
        path: session.path,
        kind: "unreadable",
        message: `subagent relation unknown: ${result.reason}`,
        // We know a session is here and cannot place it in the durable graph.
        // Target-local callers decide whether that uncertainty touches the tree
        // they are operating on; unrelated damage is diagnostic only.
        severity: "blocking",
      });
      continue;
    }
    if (result.kind === "unreadable") {
      problems.push({
        path: session.path,
        kind: "unreadable",
        message: `cannot read subagent relation: ${String(result.error)}`,
        // The session is listed but we cannot tell whether it has a parent.
        // Keep that uncertainty explicit for target-local gates and diagnostics.
        severity: "blocking",
      });
      continue;
    }
    // The whole file was read and it has no relation entry: a root session.
    if (result.kind === "none") continue;
    const parents = parentsById.get(session.id) ?? new Set<string>();
    parents.add(result.meta.parentSessionId);
    for (const other of result.conflicts) parents.add(other);
    parentsById.set(session.id, parents);
    parentOf.set(session.id, result.meta.parentSessionId);
    // An edge to *every* declared parent, not just the first. Linking only the
    // first meant a child that named two parents was invisible to the second
    // one's cascade: that parent was archived, the child stayed, and the tree
    // split - the exact outcome this exists to prevent. Multi-parent sessions are
    // refused by the caller (see `ambiguous`); linking them all is what makes
    // the refusal reachable from either parent.
    for (const parent of parents) {
      const siblings = childrenByParent.get(parent) ?? [];
      if (!siblings.includes(session.id)) siblings.push(session.id);
      childrenByParent.set(parent, siblings);
    }
  }

  const ambiguous: AmbiguousId[] = [];
  for (const [id, paths] of pathsById) {
    if (paths.length > 1) ambiguous.push({ id, paths });
  }
  for (const [id, parents] of parentsById) {
    if (parents.size > 1) {
      const existing = ambiguous.find((entry) => entry.id === id);
      if (existing) existing.parents = [...parents];
      else ambiguous.push({ id, paths: pathsById.get(id) ?? [], parents: [...parents] });
    }
  }

  // One diagnostic question: could we read every relation? Mutation callers do
  // not use this as a global gate; they inspect only the requested durable tree.
  const readable = problems.length === 0;
  const status: Record<string, RelationScanStatus> = {};
  for (const problem of problems) status[problem.path] = "unreadable";
  for (const session of sessions) {
    if (status[session.path]) continue;
    status[session.path] = "verified";
  }
  return { parentOf, childrenByParent, readable, ambiguous, problems, status };
}

/**
 * Collect the subagent descendants of `rootId` in cascade order.
 *
 * This is a true post-order: a session is recorded only after all of its own
 * descendants. That invariant is what makes the archive order safe - every
 * descendant is moved before its parent, so an interrupted archive can never
 * leave a parent archived while one of its children is still active.
 */
export async function collectSubagentTree(
  rootId: string,
  sessions: readonly RawSessionInfo[],
  options: { readSubagentMeta?: (path: string) => Promise<SubagentMetaResult>; graph?: RelationGraph } = {},
): Promise<SubagentTree> {
  // A caller that already built the graph hands it over: building it twice reads
  // every session's first four lines twice, and a second observation of moving
  // files is a second answer rather than the same one.
  const graph = options.graph ?? (await buildRelationGraph(sessions, options));

  const postOrder: string[] = [];
  const preOrder: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return; // cycle guard, marked before recursing
    seen.add(id);
    preOrder.push(id);
    for (const child of graph.childrenByParent.get(id) ?? []) visit(child);
    if (id !== rootId) postOrder.push(id);
  };
  visit(rootId);

  // The tree's own completeness mirrors the graph's, and is spelled the same way
  // so nobody has to learn two vocabularies for one idea.
  return {
    descendantsFirst: [...postOrder, rootId],
    rootFirst: preOrder,
    problems: graph.problems,
    complete: graph.readable,
  };
}

/**
 * The bits a list row needs: name, length, and both ends of the conversation.
 *
 * Separate from the scan because it costs a full read of each file, and a picker
 * only needs it for the rows it is about to show. Never writes: it goes through
 * the no-write reader.
 */
function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text);
      return "";
    })
    .join(" ")
    .trim();
}
