/**
 * The two install routes, both checked with pi's own resource loader rather than
 * assumed: a package install, and a plain copy into the conventional directory.
 * A user should be able to follow the README on either path.
 */

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const EXTENSION_DIR = new URL("./", import.meta.url).pathname;

async function loadWith(agentDir, cwd) {
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
  await loader.reload();
  return loader.getExtensions();
}

test("copying the directory into ~/.pi/agent/extensions is enough - no install", async (t) => {
  const { DefaultPackageManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const agentDir = mkdtempSync(join(tmpdir(), "pi-archive-copy-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-archive-copycwd-"));
  t.after(() => {
    // temp dirs only
  });

  const destination = join(agentDir, "extensions", "pi-session-archive");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  cpSync(EXTENSION_DIR, destination, { recursive: true });

  const result = await loadWith(agentDir, cwd);
  const paths = (result.extensions ?? []).map((entry) => String(entry.path ?? ""));
  assert.ok(
    paths.some((path) => path.endsWith("pi-session-archive/index.ts")),
    `expected the copied extension to load, got ${JSON.stringify(paths)}`,
  );
  assert.deepEqual(result.errors ?? [], [], "and to load without errors");

  // Nothing was recorded, because nothing was installed.
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
  assert.deepEqual(packages.listConfiguredPackages(), [], "a copy is not an install");
});

test("the package route also loads it", async (t) => {
  const { DefaultPackageManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const agentDir = mkdtempSync(join(tmpdir(), "pi-archive-pkg-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-archive-pkgcwd-"));
  t.after(() => {
    // temp dirs only
  });

  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
  await packages.installAndPersist(EXTENSION_DIR);
  assert.ok(existsSync(join(agentDir, "settings.json")));

  const result = await loadWith(agentDir, cwd);
  const paths = (result.extensions ?? []).map((entry) => String(entry.path ?? ""));
  assert.ok(paths.some((path) => path.includes("pi-session-archive")));
  assert.deepEqual(result.errors ?? [], []);
});
