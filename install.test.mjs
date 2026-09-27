/**
 * Installation, end to end, with pi's own machinery.
 *
 * The question this answers is the one a user actually has: after installing,
 * does a real pi session have the commands and the shortcut? So nothing here is
 * stubbed - a real package install into a throwaway agent dir, a real
 * AgentSessionRuntime, and the session's own command and shortcut registries.
 *
 * It also pins the documented install routes, so a change to pi's package or
 * resource discovery cannot quietly break "pi install ./extensions/...".
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const EXTENSION_DIR = new URL("./", import.meta.url).pathname;
const EXPECTED_COMMANDS = ["archive", "archived", "unarchive", "archived-export"];

async function installedSession(t) {
  const {
    DefaultPackageManager,
    SessionManager,
    SettingsManager,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
  } = await import("@earendil-works/pi-coding-agent");

  const agentDir = mkdtempSync(join(tmpdir(), "pi-session-archive-install-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-session-archive-installcwd-"));
  const settingsManager = SettingsManager.create(cwd, agentDir);

  // The route the README documents.
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  await packages.installAndPersist(EXTENSION_DIR);
  assert.ok(existsSync(join(agentDir, "settings.json")), "the install is recorded in settings");

  const factory = async (options) => {
    const services = await createAgentSessionServices({ cwd: options.cwd, agentDir: options.agentDir });
    return { ...(await createAgentSessionFromServices({ ...options, services })), services, diagnostics: [] };
  };
  const runtime = await createAgentSessionRuntime(factory, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, undefined, {}),
  });
  await runtime.session.waitForIdle();
  t.after(async () => {
    await runtime.dispose();
  });
  return { agentDir, cwd, runtime };
}

test("after installing, a real session exposes the archive commands", async (t) => {
  const { runtime } = await installedSession(t);
  const names = runtime.session.extensionRunner
    .getRegisteredCommands()
    .map((command) => command.invocationName ?? command.name);

  for (const expected of EXPECTED_COMMANDS) {
    assert.ok(
      names.some((name) => name === expected || name === `/${expected}`),
      `expected /${expected} among ${JSON.stringify(names)}`,
    );
  }
});

test("the archive shortcut is registered with a real key id", async (t) => {
  const { runtime } = await installedSession(t);
  const runner = runtime.session.extensionRunner;
  // getShortcuts resolves against a keybinding config; an empty one still lists
  // extension-declared keys.
  const shortcuts = runner.getShortcuts({});
  assert.ok(shortcuts.size >= 1, "at least the archive shortcut is registered");
  const descriptions = [...shortcuts.values()].map((shortcut) => shortcut.description ?? "");
  assert.ok(
    descriptions.some((description) => /archive/i.test(description)),
    `expected an archive shortcut, got ${JSON.stringify(descriptions)}`,
  );
});
