/**
 * pi-session-archive: archive sessions by moving them out of the active tree.
 *
 * What it does:
 *   pi scans `<agentDir>/sessions/<project>/*.jsonl`. The archive root is a flat
 *   sibling of that directory, so moving a file removes it from the active
 *   catalogue. The extension owns every mutation. Hosts may either use its
 *   interactive commands or call the stable `/archive --ids ...` integration
 *   form; PI WEB's optional native archive controls use the latter.
 *
 * Ownership, matching pi's own rule for deleting a session: you may not archive
 * the session this runtime is using, and nothing else is checked. pi does not
 * look at whether another process has a session open either, so neither do we -
 * two runtimes on one session both carry on typing, as they would without us.
 *
 * Where each entry point actually works, as host facts rather than wishes:
 *   - `/archive` and Ctrl+Shift+A open a multi-select archive picker. The
 *     shortcut fires from the prompt editor, which is the only place pi routes
 *     extension keys to; it does not fire inside the built-in `/resume` list.
 *   - `/archive --ids <id[,id...]>` is the non-interactive host integration
 *     path. It deliberately bypasses picker UI but uses the same migration code.
 *   - `/archived` lists archived roots in a human-readable picker. Subagent
 *     children are folded into their root, while a stable trailing #id keeps the
 *     selection unambiguous.
 *   - Archiving a root archives its subagent descendants; a child is never an
 *     operation root of its own, in either direction.
 *
 * Honest limits:
 *   - The session this runtime is currently using is never archived.
 *   - Cascades contain the durable child sessions that exist at the decisive
 *     lock-time scan. The extension does not infer hypothetical future files.
 *   - `/archive-check` reports damaged/split state but diagnostics do not become
 *     a global write gate for unrelated sessions.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { resolveArchivedTarget } from "./archive-flow.ts";
import { describeReachability, exportArchivedSessionHtml } from "./export-html.ts";
import { describeActiveRow, listActiveRoots, rowTitle, uniqueIdPrefixes } from "./active-list.ts";
import { selectMany, selectPaged } from "./picker.ts";
import { findSessionPathByIdHint } from "./locate-session.ts";
import {
  archiveSessionTree,
  listArchivedSessions,
  restoreSessionTree,
  type ArchivedSessionRow,
  type MigrationDeps,
  type OperationResult,
} from "./migrate.ts";
import { reconcileArchive } from "./reconcile.ts";
import { pathKey, sessionRootsFrom } from "./paths.ts";
import { classifySessionFile, scanSessionRoots } from "./scanner.ts";
import { describeSession } from "./session-summary.ts";

/** Modes with a usable UI; print and json have no dialogs at all. */
const INTERACTIVE_MODES = new Set(["tui", "rpc"]);

/** Command handlers get a richer context than lifecycle handlers. */
type CommandContext = ExtensionContext & {
  waitForIdle: () => Promise<void>;
  newSession?: (options?: {
    parentSession?: string;
    withSession?: (fresh: unknown) => Promise<void>;
  }) => Promise<{ cancelled: boolean }>;
  switchSession?: (sessionPath: string) => Promise<{ cancelled: boolean }>;
};

export default function sessionArchiveExtension(pi: ExtensionAPI): void {

  const agentDir = (): string | undefined => {
    try {
      return getAgentDir();
    } catch {
      return undefined; // A host without an agent dir gets no archive at all.
    }
  };

  const homeDir = (): string => {
    try {
      return homedir();
    } catch {
      return "";
    }
  };

  const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
    ctx.ui.notify?.(message, level);
  };

  const report = (ctx: ExtensionContext, result: OperationResult, successVerb: "Archived" | "Restored") => {
    if (result.ok) {
      notify(ctx, `${successVerb} ${result.affected.length} session(s).`, "info");
      for (const warning of result.warnings ?? []) notify(ctx, warning, "warning");
      return;
    }
    notify(ctx, result.message, "warning");
    for (const id of result.blockers ?? []) notify(ctx, `  blocked: ${id}`, "warning");
    // A failed rollback leaves the tree in a state we could not undo; the
    // operator needs to know where every file actually is.
    for (const [id, path] of Object.entries(result.actualPaths ?? {})) {
      notify(ctx, `  ${id}: ${path}`, "warning");
    }
  };

  /** The cwds of live sessions, which is what pi-web's file tree is built from. */
  const activeCwds = (ctx: ExtensionContext): string[] => {
    const dir = agentDir();
    if (!dir) return [];
    try {
      return scanSessionRoots(sessionRootsFrom(ctx, dir)).sessions
        .map((session) => session.cwd)
        .filter((cwd): cwd is string => typeof cwd === "string");
    } catch {
      return [];
    }
  };

  /** Switch to a live session. Returns false when the host cannot. */
  const switchToSession = async (
    ctx: ExtensionContext,
    sessionId: string,
    preferredPath?: string,
  ): Promise<boolean> => {
    const command = ctx as CommandContext;
    const dir = agentDir();
    if (typeof command.switchSession !== "function" || !dir) return false;

    // A v2 archive index remembers the exact source path. That is authoritative
    // for custom --session-dir layouts that are outside the default sessions
    // tree and therefore cannot be rediscovered by filename scanning. Still
    // verify the header before handing the path to the host.
    let path: string | undefined;
    if (preferredPath) {
      const { info } = classifySessionFile(preferredPath);
      if (info?.id === sessionId) path = preferredPath;
    }
    path ??= findSessionPathByIdHint(sessionId, dir);
    if (!path) return false;
    try {
      return !(await command.switchSession(path)).cancelled;
    } catch {
      return false;
    }
  };

  /**
   * The file this runtime is running, if it has one on disk.
   *
   * This is the only ownership fact the extension needs, and it is compared by
   * path: the path is what actually gets moved, it behaves the same under a
   * custom session dir, and it does not depend on how two sessions are named.
   * It matches pi's own rule - you may not delete the session you are sitting
   * in, and nothing stops you from deleting any other one, even if some other
   * process has it open.
   */
  const hostActiveFile = (ctx: ExtensionContext): string | undefined => {
    const file = (ctx.sessionManager as { getSessionFile?: () => string | undefined }).getSessionFile?.();
    return file && file.length > 0 ? file : undefined;
  };

  const isHostActiveFile = (ctx: ExtensionContext) => (sessionPath: string): boolean => {
    const active = hostActiveFile(ctx);
    return active !== undefined && pathKey(active) === pathKey(sessionPath);
  };


  /**
   * Run an operation and turn anything thrown into a reported failure.
   *
   * The operations return failures rather than raising, but the filesystem still
   * gets a vote - a permission error, a path that is a file where a directory
   * should be. An exception escaping a command handler does not just fail that
   * command: it abandons the picker loop the person is standing in, with nothing
   * said. So the boundary catches, and the refusal is reported like any other.
   */
  const run = async <T>(ctx: ExtensionContext, what: string, operation: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await operation();
    } catch (error) {
      notify(ctx, `${what} failed: ${String(error)}`, "error");
      return undefined;
    }
  };

  const migrationDeps = (ctx: ExtensionContext): MigrationDeps => ({
    agentDir: agentDir(),
    sessionRoots: sessionRootsFrom(ctx, agentDir() ?? ""),
    isHostActiveFile: isHostActiveFile(ctx),
  });

  interface ArchiveBatchSummary {
    rootsArchived: number;
    sessionsMoved: number;
    failed: number;
  }

  /**
   * Archive stable root ids through the same migration path used by the
   * interactive picker. Each root performs its own lock-time rescan, so a
   * selection made from a stale UI can never become filesystem authority.
   */
  const archiveSessionIds = async (
    ctx: ExtensionContext,
    ids: readonly string[],
  ): Promise<ArchiveBatchSummary> => {
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    let rootsArchived = 0;
    let sessionsMoved = 0;
    let failed = 0;

    for (const id of uniqueIds) {
      const result = await run(ctx, "Archive", () => archiveSessionTree(id, migrationDeps(ctx)));
      if (!result) {
        failed += 1;
        continue;
      }
      if (!result.ok) {
        failed += 1;
        report(ctx, result, "Archived");
        continue;
      }
      rootsArchived += 1;
      sessionsMoved += result.affected.length;
      for (const warning of result.warnings ?? []) notify(ctx, warning, "warning");
    }

    if (rootsArchived > 0) {
      notify(
        ctx,
        `Archived ${rootsArchived} root session(s) (${sessionsMoved} session file(s)).`,
        "info",
      );
    }
    if (failed > 0) {
      notify(ctx, `${failed} selected session(s) were not archived.`, "warning");
    }

    return { rootsArchived, sessionsMoved, failed };
  };

  /**
   * Pi Web integration form. Kept inside the existing archive command so the
   * browser owns only presentation; all archive semantics remain here.
   */
  const directArchiveIds = (raw: string | undefined): string[] | undefined => {
    const match = /^--ids(?:\\s+(.+))?$/i.exec((raw ?? "").trim());
    if (!match) return undefined;
    return (match[1] ?? "")
      .split(/[\\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean);
  };

  /**
   * Interactive archive picker.
   *
   * TUI uses one true multi-select component. RPC keeps a selection basket as a
   * compatibility fallback; Pi Web's native session-list integration calls the
   * --ids form and never shows this picker.
   */
  const archivePickedSession = async (ctx: ExtensionContext, filter?: string): Promise<void> => {
    const directIds = directArchiveIds(filter);
    if (directIds !== undefined) {
      if (directIds.length === 0) {
        notify(ctx, "Usage: /archive --ids <session-id[,session-id...]>", "warning");
        return;
      }
      await archiveSessionIds(ctx, directIds);
      return;
    }

    if (!INTERACTIVE_MODES.has(ctx.mode)) {
      notify(ctx, "Archiving needs a terminal or web session.", "warning");
      return;
    }

    const needle = (filter ?? "").trim().toLowerCase();
    const listed = await run(ctx, "Archive picker", () =>
      listActiveRoots({
        agentDir: agentDir(),
        sessionRoots: sessionRootsFrom(ctx, agentDir() ?? ""),
      }),
    );
    if (!listed) return;

    if (listed.problems.length > 0) {
      notify(ctx, `Session scan found ${listed.problems.length} issue(s); /archive-check has details.`, "warning");
    }

    const matching = listed.rows.filter(
      (row) =>
        needle === ""
        || `${rowTitle(row)} ${row.session.cwd ?? ""} ${row.session.id}`.toLowerCase().includes(needle),
    );
    if (matching.length === 0) {
      notify(
        ctx,
        listed.rows.length === 0
          ? "No sessions to archive."
          : `No active session matches "${filter?.trim() ?? ""}".`,
        "warning",
      );
      return;
    }

    const nowMs = Date.now();
    const idTokens = uniqueIdPrefixes(matching.map((row) => row.session.id));
    const selectedIds = await selectMany(
      ctx,
      "Archive sessions",
      matching.map((row) => {
        const current = isHostActiveFile(ctx)(row.session.path);
        return {
          value: row.session.id,
          label: describeActiveRow(row, nowMs, idTokens.get(row.session.id), current),
          disabled: current,
          disabledReason: current ? "current session" : undefined,
        };
      }),
      {
        pageSize: 20,
        titleSuffix: needle ? `matching "${filter}"` : undefined,
        emptyLabel: "No sessions to archive.",
        commitVerb: "Archive",
      },
    );

    if (selectedIds.length === 0) return;
    await archiveSessionIds(ctx, selectedIds);
  };

  /**
   * Export a session and say something the user can act on: a name they can
   * recognise, and where to click. A bare `/tmp/<uuid>.html` was not usable.
   */
  const exportSession = (ctx: ExtensionContext, row: ArchivedSessionRow, explicitDir?: string): void => {
    const exported = exportArchivedSessionHtml(row.session.path, {
      outDir: explicitDir,
      label: row.session.name?.trim() || row.session.firstMessage?.trim() || row.session.id,
      archivedAt: row.archivedAt,
    });
    if (!exported.ok) {
      notify(ctx, exported.message, "error");
      return;
    }
    const dir = dirname(exported.outputPath);
    const reachability = describeReachability(dir, activeCwds(ctx), homeDir());
    notify(ctx, `Exported ${basename(exported.outputPath)} to ${dir}`, "info");
    notify(ctx, reachability.message, reachability.browsable ? "info" : "warning");
  };

  /**
   * A key to open the archive picker.
   *
   * pi routes extension shortcuts to the prompt editor, which is why this fires
   * while typing and not inside the built-in `/resume` list (that list has no
   * extension hook at all).
   */
  pi.registerShortcut(Key.ctrlShift("a"), {
    description: "Select sessions to archive (with their subagent sessions)",
    handler: async (ctx) => archivePickedSession(ctx),
  });

  pi.registerCommand("archive", {
    description: "Archive one or more sessions with their subagents (usage: /archive [filter])",
    handler: async (args, ctx) => archivePickedSession(ctx, args),
  });

  pi.registerCommand("archived", {
    description: "List archived sessions and restore or export one",
    handler: async (args, ctx) => {
      if (!INTERACTIVE_MODES.has(ctx.mode)) {
        notify(ctx, "The archive list needs a terminal or web session.", "warning");
        return;
      }
      const needle = args.trim().toLowerCase();
      const listed = await run(ctx, "List archived sessions", () =>
        listArchivedSessions({ agentDir: agentDir(), sessionRoots: sessionRootsFrom(ctx, agentDir() ?? "") }),
      );
      if (!listed) return;
      const { rows, problems } = listed;
      if (problems.length > 0) notify(ctx, `${problems.length} archive diagnostic issue(s); /archive-check has details.`, "warning");

      const matching = rows.filter(
        (row) =>
          needle === "" ||
          `${row.session.name ?? ""} ${row.session.firstMessage ?? ""} ${row.cwd ?? row.session.cwd ?? ""} ${row.session.id}`
            .toLowerCase()
            .includes(needle),
      );
      if (matching.length === 0) {
        notify(
          ctx,
          rows.length === 0 ? "Nothing archived yet." : `No archived session matches "${args.trim()}".`,
          "warning",
        );
        return;
      }

      // Paged, and the label maps back to the row exactly.
      const idTokens = uniqueIdPrefixes(matching.map((row) => row.session.id));
      const entries = matching.map((row) => ({
        row,
        label: describeSession(row, idTokens.get(row.session.id)),
      }));
      // A corrupt archive can contain two files with the same session id. Their
      // human labels may then still be identical even after id-prefix expansion.
      // Keep the picker selection path-safe: only the colliding rows gain a
      // filename suffix, so export can never silently choose the first file.
      const labelCounts = new Map<string, number>();
      for (const entry of entries) labelCounts.set(entry.label, (labelCounts.get(entry.label) ?? 0) + 1);
      for (const entry of entries) {
        if ((labelCounts.get(entry.label) ?? 0) > 1) {
          entry.label = `${entry.label} · file ${basename(entry.row.session.path)}`;
        }
      }
      const picked = await selectPaged(ctx, "Archived sessions", entries.map((entry) => entry.label), {
        pageSize: 20,
        titleSuffix: needle ? `matching "${args.trim()}"` : undefined,
        emptyLabel: "Nothing archived.",
      });
      if (!picked.value) return;
      const chosen = entries.find((entry) => entry.label === picked.value);
      if (!chosen) {
        notify(ctx, "That archived session is no longer in the list.", "warning");
        return;
      }

      const action = await ctx.ui.select(chosen.label, [
        "Restore and open it here",
        "Restore it (stay where you are)",
        "Export to HTML - read it without restoring",
      ]);
      if (!action) return;

      if (action.startsWith("Export")) {
        exportSession(ctx, chosen.row);
        return;
      }

      const result = await run(ctx, "Restore", () => restoreSessionTree(chosen.row.session.id, migrationDeps(ctx)));
      if (!result) return;
      report(ctx, result, "Restored");
      if (!result.ok || !action.startsWith("Restore and open")) return;
      // Opening it right here is the point of "restore": otherwise it is a session
      // nobody can find. pi-web cancels every switch, so this degrades to a hint
      // rather than an error.
      if (!(await switchToSession(ctx, chosen.row.session.id, chosen.row.originalPath))) {
        notify(ctx, "Restored. It is back in the session list; open it from /resume.", "info");
      }
    },
  });

  /**
   * What the archive looks like right now: what is in it, and - the part that
   * matters - whether any subagent session is still active while its parent is
   * archived, or whether one session exists in both places.
   */
  pi.registerCommand("archive-check", {
    description: "Check the archive for splits: subagent sessions left behind, or a session in two places",
    handler: async (_args, ctx) => {
      const checked = await run(ctx, "Archive check", () =>
        reconcileArchive({ agentDir: agentDir(), sessionRoots: sessionRootsFrom(ctx, agentDir() ?? "") }),
      );
      if (!checked) return;
      const report = checked;
      if (report.diagnostics.length === 0) {
        notify(ctx, `Archive looks consistent: ${report.archived.length} archived session(s), no splits.`, "info");
        return;
      }
      for (const diagnostic of report.diagnostics) {
        notify(ctx, `${diagnostic.kind}: ${diagnostic.message}`, diagnostic.kind === "stray-file" ? "warning" : "error");
      }
      notify(ctx, `${report.diagnostics.length} thing(s) to look at. Split children are shown as recovery roots in /archive or /archived.`, "warning");
    },
  });

  pi.registerCommand("unarchive", {
    description: "Restore an archived session by id (usage: /unarchive <id>)",
    handler: async (args, ctx) => {
      if (!INTERACTIVE_MODES.has(ctx.mode)) {
        notify(ctx, "Restoring needs a terminal or web session.", "warning");
        return;
      }
      const listed = await run(ctx, "List archived sessions", () =>
        listArchivedSessions({ agentDir: agentDir(), sessionRoots: sessionRootsFrom(ctx, agentDir() ?? "") }),
      );
      if (!listed) return;
      const resolved = resolveArchivedTarget(listed.rows, args);
      if (!resolved.ok || !resolved.row) {
        notify(ctx, resolved.message ?? "Nothing to restore.", "warning");
        return;
      }
      const target = resolved.row.session.id;
      const restored = await run(ctx, "Restore", () => restoreSessionTree(target, migrationDeps(ctx)));
      if (restored) report(ctx, restored, "Restored");
    },
  });

  pi.registerCommand("archived-export", {
    description: "Export a session to HTML without restoring it (usage: /archived-export <id-or-text> [--in <directory>])",
    handler: async (args, ctx) => {
      // `--in <dir>` names the output directory explicitly, so a multi-word target is
      // never mistaken for one; everything else is the target, spaces included.
      // A directory is named explicitly, because a multi-word target and
      // "target plus directory" are otherwise indistinguishable.
      const trimmed = args.trim();
      // The output directory is a trailing option so the target may itself
      // contain spaces: `/archived-export fix the auth --in /tmp/reports`.
      const dirMatch = /^(.*?)\s+--in\s+(.+?)\s*$/.exec(trimmed);
      const target = (dirMatch?.[1] ?? trimmed).replace(/\s+/g, " ").trim();
      const explicitDir = dirMatch?.[2]?.trim();
      const listed = await run(ctx, "List archived sessions", () =>
        listArchivedSessions({ agentDir: agentDir(), sessionRoots: sessionRootsFrom(ctx, agentDir() ?? "") }),
      );
      if (!listed) return;
      const { rows } = listed;
      if (rows.length === 0) {
        notify(ctx, "Nothing archived yet.", "warning");
        return;
      }
      const resolved = resolveArchivedTarget(rows, target ?? "");
      if (!resolved.ok || !resolved.row) {
        notify(ctx, resolved.message ?? "Nothing to export.", "warning");
        return;
      }
      exportSession(ctx, resolved.row, explicitDir);
    },
  });
}
