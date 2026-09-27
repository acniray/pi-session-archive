/**
 * Can pi actually find and load this extension as a package?
 *
 * Every other test imports `index.ts` directly, which proves the factory works
 * but says nothing about whether `pi install` would ever see it. This asks pi's
 * own discovery instead: install the directory as a package, resolve the
 * configured sources through the package manager, and load it through the
 * resource loader - the path a terminal actually takes.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const EXTENSION_DIR = new URL("./", import.meta.url).pathname;

test("the manifest declares the entry pi looks for, and peers the SDK", () => {
  const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert.ok(existsSync(join(EXTENSION_DIR, "index.ts")), "the declared entry exists");
  // pi supplies the SDK at runtime; a peer keeps a published copy from bundling
  // its own, which would give it a second module root and a second session class.
  assert.deepEqual(manifest.peerDependencies, { "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-tui": "*" });
});

test("pi installs the directory and resolves it as an enabled extension", async (t) => {
  const { DefaultPackageManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const agentDir = mkdtempSync(join(tmpdir(), "pi-session-archive-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-session-archive-cwd-"));
  t.after(() => {
    /* temp dirs are left to the OS */
  });

  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  // installAndPersist is the variant a CLI install uses: it records the source
  // in settings, which is what makes discovery find it again.
  await packages.installAndPersist(EXTENSION_DIR);

  assert.ok(packages.listConfiguredPackages().length > 0, "the package source was recorded");

  const resolved = await packages.resolve();
  const extensions = resolved.extensions ?? [];
  const ours = extensions.filter((entry) => entry.path.includes("pi-session-archive"));
  assert.equal(ours.length, 1, `expected exactly our extension, got ${JSON.stringify(extensions.map((e) => e.path))}`);
  assert.equal(ours[0].enabled, true, "a local path install is enabled by default");
  assert.match(ours[0].path, /pi-session-archive[/\\]index\.ts$/);
});

test("the resource loader loads the extension and its factory runs", async (t) => {
  const { DefaultPackageManager, DefaultResourceLoader, SettingsManager } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const agentDir = mkdtempSync(join(tmpdir(), "pi-session-archive-load-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-session-archive-loadcwd-"));
  t.after(() => {
    /* temp dirs are left to the OS */
  });

  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  await packages.installAndPersist(EXTENSION_DIR);

  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload();
  const result = loader.getExtensions();
  const paths = (result.extensions ?? []).map((entry) => entry.path ?? String(entry));
  assert.ok(
    paths.some((path) => path.includes("pi-session-archive")),
    `expected the extension among the loaded ones, got: ${JSON.stringify(paths)}`,
  );
  // And the factory is callable: a registration bug must fail here, not in a
  // user's terminal.
  assert.ok(result.errors === undefined || result.errors.length === 0, `load errors: ${JSON.stringify(result.errors)}`);
});
