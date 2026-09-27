/**
 * Human-readable one-line descriptions for the archived-session picker.
 *
 * Identity is deliberately included as a stable trailing #id token: the text is
 * for people, the token is for resolving the selection without depending on a
 * relative timestamp or duplicated title.
 */

import { basename } from "node:path";
import type { ArchivedSessionRow } from "./migrate.ts";

function relativeTime(iso?: string): string {
  if (!iso) return "time unknown";
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return "time unknown";
  const minutes = Math.max(0, Math.round((Date.now() - stamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(stamp).toISOString().slice(0, 10);
}

export function describeSession(row: ArchivedSessionRow, idToken = row.session.id.slice(0, 8)): string {
  const title = (row.session.name?.trim() || row.session.firstMessage?.trim() || "(untitled session)")
    .replace(/\s+/g, " ")
    .slice(0, 72);
  const project = row.cwd ? basename(row.cwd) || row.cwd : "unknown project";
  const parts = [title, project, `archived ${relativeTime(row.archivedAt)}`];
  if (row.splitParentId) parts.push(`split child of #${row.splitParentId.slice(0, 8)}`);
  if (row.hasChildren) {
    parts.push(`${row.descendantCount} subagent${row.descendantCount === 1 ? "" : "s"}`);
  }
  parts.push(`#${idToken}`);
  return parts.join(" · ");
}
