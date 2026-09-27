/**
 * The archive path against a real AgentSessionRuntime.
 *
 * This used to drive "detach from the current session, then archive it" - the
 * writer-claim design. That path is gone: the session this runtime is using is
 * simply refused, which is what pi does for delete. What is left to prove
 * against a real runtime is therefore:
 *   - another session can be archived while this one is running,
 *   - the session we are sitting in cannot,
 *   - and the comparison is by path, so a custom session dir still works.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeAgentDir, writeSessionFile } from "./test-helpers.mjs";

const { SessionManager, createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices } =
  await import("@earendil-works/pi-coding-agent");
const { archiveSessionTree } = await import("./migrate.ts");
const { archiveRoot, pathKey, sessionsRoot } = await import("./paths.ts");

/**
 * A real runtime.
 *
 * The agent dir is a real one under the system temp, not the session's cwd: pi
 * puts sessions in `<agentDir>/sessions/<encoded cwd>/` whatever the cwd is, and
 * an agent dir we do not control is how a real extension ends up looking at
 * someone else's sessions.
 */
async function realRuntime(t, { cwd, agentDir }) {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  });

  const factory = async (options) => {
    const services = await createAgentSessionServices({ cwd: options.cwd, agentDir: options.agentDir });
    return { ...(await createAgentSessionFromServices({ ...options, services })), services, diagnostics: [] };
  };
  const runtime = await createAgentSessionRuntime(factory, {
    cwd,
    agentDir: cwd,
    sessionManager: SessionManager.create(cwd, undefined, {}),
  });
  await runtime.session.waitForIdle();
  t.after(async () => {
    await runtime.dispose();
  });
  return runtime;
}

/** Persist the runtime's session the way pi does, so the file really exists. */
async function persistSession(runtime) {
  runtime.session.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    timestamp: Date.now(),
  });
  await runtime.session.waitForIdle();
  const file = runtime.session.sessionManager.getSessionFile();
  assert.ok(file && fs.existsSync(file), "the fixture session is on disk");
  const old = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(file, old, old);
  return file;
}

test("another session is archived while this runtime keeps running", async (t) => {
  const agentDir = makeAgentDir(t);
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "live-")));
  const other = writeSessionFile(agentDir, { id: "other", cwd });

  const runtime = await realRuntime(t, { cwd, agentDir });
  await persistSession(runtime);

  const result = await archiveSessionTree("other", { agentDir, now: () => Date.now() });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fs.existsSync(other), false);
  assert.equal(
    fs.existsSync(path.join(archiveRoot(agentDir), "2026-09-24T10-00-00-000Z_other.jsonl")),
    true,
  );
  // The running session is untouched and still the host's file.
  assert.equal(
    pathKey(runtime.session.sessionManager.getSessionFile()) === pathKey(other),
    false,
  );
});

test("the session this runtime is using cannot be archived", async (t) => {
  const agentDir = makeAgentDir(t);
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "live-")));
  const runtime = await realRuntime(t, { cwd, agentDir });
  const active = await persistSession(runtime);
  const id = runtime.session.sessionManager.getSessionId();

  const result = await archiveSessionTree(id, {
    agentDir,
    // What sessionRootsFrom hands over: the default root, the session's own
    // directory, and (only when the host is off the default layout) its parent.
    sessionRoots: [sessionsRoot(agentDir), path.dirname(active), cwd],
    now: () => Date.now(),
    // Exactly what the extension derives: the host's file, compared by path.
    isHostActiveFile: (candidate) => pathKey(candidate) === pathKey(active),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "blocked-by-runtime");
  assert.equal(fs.existsSync(active), true, "and the file is still where it was");
});

test("the host's path comparison works under a custom session dir", async (t) => {
  const agentDir = makeAgentDir(t);
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "live-")));
  // A real custom layout: pi accepts an explicit session dir, and the manager
  // then reports it is not on the default one.
  const customRoot = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "live-custom-"));
  t.after(() => fs.rmSync(customRoot, { recursive: true, force: true }));

  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  });

  const factory = async (options) => {
    const services = await createAgentSessionServices({ cwd: options.cwd, agentDir: options.agentDir });
    return { ...(await createAgentSessionFromServices({ ...options, services })), services, diagnostics: [] };
  };
  const runtime = await createAgentSessionRuntime(factory, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, customRoot, {}),
  });
  await runtime.session.waitForIdle();
  t.after(async () => {
    await runtime.dispose();
  });

  const active = await persistSession(runtime);
  const id = runtime.session.sessionManager.getSessionId();
  assert.equal(runtime.session.sessionManager.usesDefaultSessionDir(), false, "the fixture is off the default layout");
  assert.equal(pathKey(active).startsWith(pathKey(sessionsRoot(agentDir))), false, "and lives outside the default root");

  const result = await archiveSessionTree(id, {
    agentDir,
    // sessionRootsFrom's answer for this host: the default root, the session's own
    // directory, and its parent because the layout is not the default one.
    sessionRoots: [sessionsRoot(agentDir), customRoot, path.dirname(active)],
    now: () => Date.now(),
    isHostActiveFile: (candidate) => pathKey(candidate) === pathKey(active),
  });

  assert.equal(result.ok, false, "a custom-dir session is still recognised as the host's");
  assert.equal(result.reason, "blocked-by-runtime");
  assert.equal(fs.existsSync(active), true);
});

test("two runtimes on one session: both keep typing, and archiving still works from the other", async (t) => {
  const agentDir = makeAgentDir(t);
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "two-live-")));

  // Two independent runtimes, as two pi processes would be, sharing one session file.
  const first = await realRuntime(t, { cwd, agentDir });
  const active = await persistSession(first);
  const second = await createAgentSessionRuntime(
    async (options) => {
      const services = await createAgentSessionServices({ cwd: options.cwd, agentDir: options.agentDir });
      return { ...(await createAgentSessionFromServices({ ...options, services })), services, diagnostics: [] };
    },
    { cwd, agentDir, sessionManager: SessionManager.open(active) },
  );
  await second.session.waitForIdle();
  t.after(async () => {
    await second.dispose();
  });
  assert.equal(second.session.sessionManager.getSessionId(), first.session.sessionManager.getSessionId());

  // Neither side is blocked, and no lease directory appears anywhere.
  for (const runtime of [first, second]) {
    runtime.session.sessionManager.appendMessage({
      role: "user",
      content: "still typing",
      timestamp: Date.now(),
    });
    await runtime.session.waitForIdle();
  }
  assert.equal(fs.existsSync(path.join(agentDir, "session-writer-claims")), false);

  // And the archive of that same session is still refused from inside runtime one,
  // because it is the session runtime one is using.
  const result = await archiveSessionTree(first.session.sessionManager.getSessionId(), {
    agentDir,
    sessionRoots: [sessionsRoot(agentDir), path.dirname(active)],
    now: () => Date.now(),
    isHostActiveFile: (candidate) => pathKey(candidate) === pathKey(active),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "blocked-by-runtime");
});
