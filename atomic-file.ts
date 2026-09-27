/**
 * Atomic file replacement with owner-only permissions.
 *
 * The extension cannot import pi-web's own helper (it must stay loadable from
 * `~/.pi/agent/extensions/`), so this is a small local copy. The decorative
 * archive index is written through here, so a crash can never leave a
 * half-written file behind.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function writeFileAtomicSync(filePath: string, contents: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(filePath)}-${randomUUID()}.tmp`);
  let failed = false;
  try {
    writeFileSync(tempPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
    renameSync(tempPath, filePath);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !failed) throw error;
    }
  }
}
