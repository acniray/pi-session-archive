/**
 * The cross-process barrier around "check the claims, then move the files".
 *
 * A directory whose mtime says "older than five minutes" is not evidence that
 * its owner died - a slow operation holds the lock just as long, and the moment
 * it finishes its `finally` would `rmdir` the *new* owner's lock, letting a third
 * process in while two are still working. So the lock is a lease, not a
 * timestamp:
 *
 *   acquire  - create `owner.json` with O_EXCL (atomic: exactly one winner)
 *   renew    - rewrite the same file with a fresh heartbeat while working
 *   reclaim  - only when the heartbeat is stale **and** the owner is provably gone
 *   release  - only if the file still carries our token
 *
 * A stale heartbeat with a live owner is reported as `mutation-unsafe` rather
 * than stolen: a lock that is never wrongly broken is worth more than one that
 * is reclaimed eagerly.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MUTATION_RENEW_INTERVAL_MS, mutationRoot } from "./paths.ts";

export const DEFAULT_STALE_AFTER_MS = 300_000;

/**
 * Same-host liveness probe, used to tell "the lock holder died" from "the lock
 * holder is quiet". EPERM means the process exists but belongs to someone else.
 *
 * This lives here rather than in a shared module because it is the only thing
 * the mutation lease needs it for.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const OWNER_FILE = "owner.json";

export interface MutationOwner {
  token: string;
  pid: number;
  surface: string;
  heartbeatAt: number;
  startedAt: number;
}

export interface MutationLockOptions {
  agentDir?: string;
  surface?: string;
  now?: () => number;
  staleAfterMs?: number;
  renewIntervalMs?: number;
  retries?: number;
  retryDelayMs?: number;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export type MutationLockFailure =
  | { ok: false; reason: "mutation-busy"; detail: string; owner?: MutationOwner }
  | { ok: false; reason: "mutation-unsafe"; detail: string; owner?: MutationOwner };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function ownerPath(agentDir?: string): string {
  return join(mutationRoot(agentDir), OWNER_FILE);
}

function readOwner(agentDir: string | undefined): MutationOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(ownerPath(agentDir), "utf8")) as Partial<MutationOwner>;
    if (
      typeof parsed?.token === "string" &&
      typeof parsed?.pid === "number" &&
      typeof parsed?.heartbeatAt === "number"
    ) {
      return parsed as MutationOwner;
    }
  } catch {
    // Missing or half-written: treated as "unknown holder", never as free.
  }
  return undefined;
}

/** True only when we can be sure nobody is holding it. */
export function isLockAbandoned(
  owner: MutationOwner | undefined,
  nowMs: number,
  staleAfterMs: number,
  isAlive: (pid: number) => boolean,
): boolean {
  if (!owner) return false; // Unreadable is not the same as abandoned.
  if (nowMs - owner.heartbeatAt <= staleAfterMs) return false;
  return !isAlive(owner.pid);
}

export type MutationLockOutcome<R> = { ok: true; value: R } | MutationLockFailure;

export async function withMutationLock<R>(
  options: MutationLockOptions,
  work: () => Promise<R>,
): Promise<MutationLockOutcome<R>> {
  const now = options.now ?? (() => Date.now());
  const isAlive = options.isAlive ?? isPidAlive;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const renewIntervalMs = options.renewIntervalMs ?? MUTATION_RENEW_INTERVAL_MS;
  const retries = options.retries ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  const token = randomUUID();
  const root = mutationRoot(options.agentDir);
  const path = ownerPath(options.agentDir);

  const startedAt = now();
  const ownContent = (): string =>
    `${JSON.stringify({
      token,
      pid: process.pid,
      surface: options.surface ?? "unknown",
      heartbeatAt: now(),
      startedAt,
    } satisfies MutationOwner)}\n`;

  /** Renewal only: replace our own file atomically so a reader never sees half. */
  const renew = (): void => {
    if (readOwner(options.agentDir)?.token !== token) return; // reclaimed: never stomp
    const temp = join(root, `.owner-${token}.tmp`);
    writeFileSync(temp, ownContent(), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  };

  let acquired = false;
  let unsafe = false;
  let detail = "";
  let holder: MutationOwner | undefined;

  try {
    mkdirSync(root, { recursive: true });
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        // O_EXCL with the full content: the winner writes its complete lease in
        // one open, so there is no window where the file exists but is empty.
        writeFileSync(path, ownContent(), { flag: "wx", mode: 0o600 });
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        holder = readOwner(options.agentDir);
        if (isLockAbandoned(holder, now(), staleAfterMs, isAlive)) {
          // Only a provably dead owner may be reclaimed.
          try {
            unlinkSync(path);
          } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
          }
          continue;
        }
        if (holder) unsafe = true;
        detail = holder
          ? `held by pid ${holder.pid} (heartbeat ${Math.round((now() - holder.heartbeatAt) / 1000)}s ago)`
          : "held, and the holder could not be identified";
      }
      if (attempt < retries) await sleep(options.retryDelayMs ?? 50);
    }
  } catch (error) {
    return { ok: false, reason: "mutation-busy", detail: String(error) };
  }

  if (!acquired) {
    return unsafe
      ? { ok: false, reason: "mutation-unsafe", detail, owner: holder }
      : { ok: false, reason: "mutation-busy", detail, owner: holder };
  }

  // Renew while working, so a slow operation is never mistaken for a dead one.
  const timer = setInterval(() => {
    try {
      renew();
    } catch {
      // Nothing useful to do: the release below still checks ownership.
    }
  }, renewIntervalMs);
  timer.unref?.();

  try {
    return { ok: true, value: await work() };
  } finally {
    clearInterval(timer);
    // Release only our own lock: a blind unlink here would delete a lock that a
    // reclaimer already handed to somebody else.
    const current = readOwner(options.agentDir);
    if (current?.token === token) {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // The directory itself stays: rmdir is not atomic and would race the
    // next acquirer. Nothing scans it, and an empty one costs nothing.
  }
}

/** Read the current lease, for tests and diagnostics. Never writes. */
export function readOwnerForTest(agentDir?: string): MutationOwner | undefined {
  return readOwner(agentDir);
}
