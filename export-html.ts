/**
 * Exporting an archived session to a standalone HTML file.
 *
 * This is how you *read* an archived session without restoring it. Two rules:
 *
 *   1. Never write to the archived file. pi's own `exportFromFile` opens the
 *      session with `SessionManager.open()`, which appends a missing newline and
 *      rewrites old versions - so we build the HTML from an in-memory copy of the
 *      entries instead, and assert the source is untouched.
 *   2. Say where the file went. The output lands in a directory the user chose
 *      (or a temp dir), and the path is the deliverable.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readSessionNoWrite, type ReadSessionResult } from "./reader.ts";
import { sessionIdFromFileName } from "./paths.ts";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text);
      if (part && typeof part === "object" && "type" in part) return `[${String((part as { type: unknown }).type)}]`;
      return "";
    })
    .join("");
}

/** Render the transcript. Tool calls and results are shown, not dropped. */
export function renderHtml(session: ReadSessionResult, title: string): string {
  const rows: string[] = [];
  for (const entry of session.entries) {
    if (entry.type !== "message" || !("message" in entry)) continue;
    const message = entry.message as { role?: string; content?: unknown; toolName?: string };
    const role = message.role ?? "unknown";
    let body = "";
    if (role === "toolResult" || role === "tool") {
      body = escapeHtml(message.toolName ? `${message.toolName}\n${textOf(message.content)}` : textOf(message.content));
    } else {
      body = escapeHtml(textOf(message.content));
    }
    rows.push(
      `<section class="msg ${escapeHtml(role)}"><header>${escapeHtml(role)}</header><pre>${body}</pre></section>`,
    );
  }
  if (rows.length === 0) rows.push('<p class="empty">This session has no messages.</p>');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0 auto; max-width: 60rem; padding: 2rem 1rem; }
  h1 { font-size: 1.1rem; }
  .meta { color: #666; margin-bottom: 2rem; }
  .msg { border-left: 3px solid #ccc; padding: .25rem 0 .25rem .75rem; margin: 1rem 0; }
  .msg.user { border-color: #4a90d9; }
  .msg.assistant { border-color: #67c23a; }
  .msg.toolResult, .msg.tool { border-color: #999; }
  header { color: #666; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; }
  pre { white-space: pre-wrap; word-break: break-word; margin: .25rem 0 0; }
  .empty { color: #666; }
</style></head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">Session ${escapeHtml(session.header.id)} · cwd ${escapeHtml(session.header.cwd ?? "?")} · ${session.entries.length} entries${session.migrated ? " · migrated from an older format in memory" : ""}</p>
${rows.join("\n")}
</body></html>
`;
}

export interface ExportOptions {
  /** Where to write. Defaults to the session's own cwd, so the file appears in
   *  pi-web's file tree for that project rather than in a temp directory. */
  outDir?: string;
  /** Human label for the file name (a session name or its first message). */
  label?: string;
  /** ISO stamp used in the name; defaults to now. */
  archivedAt?: string;
}

function slug(value: string, max = 48): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return cleaned || "session";
}

/**
 * A name a person can recognise. The previous `<id>.html` in a temp directory
 * forced anyone without the picker to read a uuid back out of a notification.
 */
export function suggestExportName(options: { label?: string; sessionId: string; archivedAt?: string }): string {
  const stamp = (options.archivedAt ?? new Date().toISOString()).slice(0, 10);
  const label = options.label?.trim();
  return label ? `${stamp}-${slug(label)}.html` : `${stamp}-${options.sessionId}.html`;
}

export interface ExportResult {
  ok: true;
  outputPath: string;
  entries: number;
}

export interface ExportFailure {
  ok: false;
  message: string;
}

export type ExportOutcome = ExportResult | ExportFailure;

/**
 * Write the transcript to `outDir` (or the session's own cwd). The archived file
 * is only ever read.
 */
export function exportArchivedSessionHtml(
  archivedFile: string,
  options: ExportOptions = {},
): ExportOutcome {
  const id = sessionIdFromFileName(archivedFile) ?? basename(archivedFile, ".jsonl");
  let session: ReadSessionResult;
  try {
    session = readSessionNoWrite(archivedFile);
  } catch (error) {
    return { ok: false, message: `Cannot read the archived session: ${String(error)}` };
  }
  const directory =
    options.outDir ?? headerCwd(session) ?? mkdtempSync(join(tmpdir(), "pi-session-archive-export-"));
  const base = suggestExportName({ label: options.label, sessionId: id, archivedAt: options.archivedAt });
  try {
    mkdirSync(directory, { recursive: true });
    // Never overwrite an earlier export: `wx` and a numbered suffix, in that order.
    let outputPath = join(directory, base);
    for (let attempt = 2; existsSync(outputPath) && attempt < 100; attempt += 1) {
      outputPath = join(directory, base.replace(/\.html$/, `-${attempt}.html`));
    }
    writeFileSync(outputPath, renderHtml(session, `Archived session ${id}`), { encoding: "utf8", flag: "wx" });
    return { ok: true, outputPath, entries: session.entries.length };
  } catch (error) {
    return { ok: false, message: `Cannot write the export: ${String(error)}` };
  }
}

function headerCwd(session: ReadSessionResult): string | undefined {
  return typeof session.header.cwd === "string" && session.header.cwd ? session.header.cwd : undefined;
}

/**
 * Can a browser actually reach this directory?
 *
 * pi-web builds its file-access roots from the *live* session list plus
 * `~/pi-cwd-*`, and it has no URL parameter that opens a file directly - a
 * browser user reaches an export by clicking it in the file tree. So the useful
 * question is not "does the file exist" but "will the tree still show this
 * directory", and that is answerable from what we can see: it needs a live
 * session in the same cwd, or a `~/pi-cwd-*` directory.
 */
export function describeReachability(
  directory: string,
  activeCwds: readonly string[],
  homeDir: string,
): { browsable: boolean; message: string } {
  const normalized = directory.replace(/\/+$/, "");
  const home = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^${home}/pi-cwd-\\d{8}$`).test(normalized)) {
    return { browsable: true, message: `Open it from the file tree (${basename(directory)}).` };
  }
  if (activeCwds.some((cwd) => cwd.replace(/\/+$/, "") === normalized)) {
    return { browsable: true, message: `Open it from the file tree of ${normalized}.` };
  }
  return {
    browsable: false,
    message:
      `No live session uses ${normalized} any more, so pi-web's file tree will not show it. ` +
      "The file is still on disk; pass a directory to write it somewhere browsable.",
  };
}

/** Read the exported file back, so callers can confirm it is real HTML. */
export function readExport(path: string): string {
  return readFileSync(path, "utf8");
}
