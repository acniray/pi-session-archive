import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { withMutationLock, isLockAbandoned, readOwnerForTest } = await import("./mutation-lock.ts");
const { mutationRoot } = await import("./paths.ts");

const T0 = Date.parse("2026-09-24T12:00:00.000Z");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function agentDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mutation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ownerFile = (dir) => path.join(mutationRoot(dir), "owner.json");

function writeOwner(dir, owner) {
  fs.mkdirSync(mutationRoot(dir), { recursive: true });
  fs.writeFileSync(ownerFile(dir), `${JSON.stringify(owner)}\n`);
}

test("work runs while the lease is held, and the lease is released afterwards", async (t) => {
  const dir = agentDir(t);
  let inside;
  const outcome = await withMutationLock({ agentDir: dir, now: () => T0 }, async () => {
    inside = readOwnerForTest(dir);
    assert.equal(inside.pid, process.pid);
    return "done";
  });
  assert.deepEqual(outcome, { ok: true, value: "done" });
  assert.match(inside.token, /[0-9a-f-]{8,}/);
  assert.equal(readOwnerForTest(dir), undefined, "our lease is gone");
});

test("two migrations serialise: the second waits rather than entering", async (t) => {
  const dir = agentDir(t);
  const order = [];
  const run = (tag, ms) =>
    withMutationLock({ agentDir: dir, now: () => T0, retries: 30, retryDelayMs: 5 }, async () => {
      order.push(`${tag}:in`);
      await sleep(ms);
      order.push(`${tag}:out`);
    });

  await Promise.all([run("a", 60), run("b", 0)]);
  assert.deepEqual(order, ["a:in", "a:out", "b:in", "b:out"]);
});

test("a holder that is alive is waited for, however old its heartbeat looks", async (t) => {
  const dir = agentDir(t);
  // 10 minutes since the last heartbeat, but the pid is this very process.
  writeOwner(dir, { token: "other", pid: process.pid, surface: "pi-web", heartbeatAt: T0 - 600_000, startedAt: T0 - 700_000 });

  let ran = false;
  const outcome = await withMutationLock(
    { agentDir: dir, now: () => T0, retries: 1, retryDelayMs: 1 },
    async () => {
      ran = true;
    },
  );
  assert.equal(ran, false, "we must not enter a live holder's section");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "mutation-unsafe", "and say why: stale but alive");
});

test("a provably dead holder is reclaimed", async (t) => {
  const dir = agentDir(t);
  // pid 2^22 is above the default max, so it cannot exist.
  writeOwner(dir, { token: "dead", pid: 4_194_303, surface: "pi-web", heartbeatAt: T0 - 600_000, startedAt: T0 - 700_000 });

  const outcome = await withMutationLock({ agentDir: dir, now: () => T0, retries: 2, retryDelayMs: 1 }, async () => "reclaimed");
  assert.deepEqual(outcome, { ok: true, value: "reclaimed" });
});

test("a holder we cannot identify is never stolen", () => {
  assert.equal(isLockAbandoned(undefined, T0, 1, () => false), false);
  assert.equal(isLockAbandoned(undefined, T0, 1, () => true), false, "unreadable is not abandoned");
});

test("a slow holder keeps its heartbeat, so it is not mistaken for a dead one", async (t) => {
  const dir = agentDir(t);
  const seen = [];
  // A real clock here: the point is that the heartbeat value on disk moves.
  await withMutationLock(
    { agentDir: dir, renewIntervalMs: 10, staleAfterMs: 5_000 },
    async () => {
      for (let index = 0; index < 4; index += 1) {
        await sleep(20);
        seen.push(readOwnerForTest(dir)?.heartbeatAt);
      }
    },
  );
  assert.ok(new Set(seen).size > 1, `the heartbeat advanced while working: ${JSON.stringify(seen)}`);
});

test("an old owner cannot delete the new owner's lease", async (t) => {
  const dir = agentDir(t);
  const released = [];

  // A starts, we replace its lease with one owned by "newcomer", then let A finish.
  const first = withMutationLock({ agentDir: dir, now: () => T0 }, async () => {
    writeOwner(dir, { token: "newcomer", pid: process.pid, surface: "pi-web", heartbeatAt: T0, startedAt: T0 });
    return "a done";
  });
  const outcome = await first;
  released.push(outcome);
  assert.equal(outcome.ok, true);

  // A's release must have left the newcomer alone.
  const current = readOwnerForTest(dir);
  if (current) assert.equal(current.token, "newcomer", "the surviving lease is the newcomer's");

  // And the newcomer can still release it normally.
  const second = await withMutationLock(
    { agentDir: dir, now: () => T0, retries: 0, isAlive: () => true, staleAfterMs: 1 },
    async () => "should not run",
  ).catch(() => ({ ok: false }));
  assert.equal(second.ok, false, "a live lease still blocks the next acquirer");
});

test("a throwing work still releases its own lease", async (t) => {
  const dir = agentDir(t);
  await assert.rejects(
    withMutationLock({ agentDir: dir, now: () => T0 }, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(readOwnerForTest(dir), undefined);
});
