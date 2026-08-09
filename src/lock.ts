/**
 * Exclusive advisory lock over the data directory.
 *
 * The ledger append path is read-tail-then-append and the approval
 * store is read-modify-write; both were safe only while exactly one
 * process touched a data directory. That was never true in practice:
 * the gate `serve` process appends on every gated call while the
 * operator runs `buzz-axiru approve` from a second process, and the
 * two interleave. Measured consequences, not theoretical ones:
 * duplicated seq numbers, torn half-written lines that make
 * `syncTail` throw, and a chain that `verify` rejects forever. On the
 * approval store, a lost update can resurrect an approval that the
 * other process had already expired.
 *
 * So: one lockfile per data directory, held across each critical
 * section. O_EXCL create is the primitive because it is atomic on
 * every filesystem we care about and needs no dependency.
 *
 * Choices worth stating:
 *   - FAIL LOUDLY. On contention past the timeout this throws rather
 *     than proceeding unlocked. A spend gate that silently corrupts
 *     its own audit trail is worse than one that refuses to act.
 *   - Stale locks are reclaimed, because a killed gate must not wedge
 *     the operator's CLI forever: a lock whose owner pid is gone on
 *     this host, or whose heartbeat is older than STALE_AFTER_MS, is
 *     removed and the caller retries.
 *   - Reentrant within a process, so a future caller that nests two
 *     locked sections cannot deadlock against itself.
 *   - Synchronous, because the writers it protects are synchronous
 *     (appendFileSync, renameSync) and making them async would widen
 *     every window this exists to close.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export const LOCK_FILE_NAME = ".lock";
/** Held for the full lifetime of an enforcing gate, not just one write. */
export const SERVE_LOCK_FILE_NAME = ".serve.lock";

/** How long to wait for a contended lock before giving up loudly. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** A lock older than this with no live owner is treated as abandoned. */
const STALE_AFTER_MS = 60_000;
/** Poll interval while waiting. Short: critical sections are microseconds. */
const RETRY_MS = 5;

interface LockOwner {
  pid: number;
  host: string;
  at: number;
  token: string;
}

/**
 * Reentrancy bookkeeping, keyed by lock path. A process that already
 * holds the lock just counts deeper instead of blocking on itself.
 */
const held = new Map<string, number>();

/** Sleep without yielding to the event loop; the callers are sync. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockOwner>;
    if (typeof parsed.pid !== "number" || typeof parsed.at !== "number") return null;
    return {
      pid: parsed.pid,
      host: typeof parsed.host === "string" ? parsed.host : "",
      at: parsed.at,
      token: typeof parsed.token === "string" ? parsed.token : ""
    };
  } catch {
    // Unreadable or half-written: treat as unknown owner, not as free.
    return null;
  }
}

/** Signal 0 probes liveness without delivering anything. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStale(owner: LockOwner | null, now: number): boolean {
  if (owner === null) return false;
  // Never steal a lock from a live process on this host merely because
  // a slow filesystem kept its critical section open for a minute.
  if (owner.host === hostname()) return !pidAlive(owner.pid);
  return now - owner.at > STALE_AFTER_MS;
}

/** Create and durably identify one lock owner using O_CREAT|O_EXCL. */
function createOwnerFile(lockPath: string): LockOwner {
  const fd = openSync(lockPath, "wx", 0o600);
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    at: Date.now(),
    token: randomUUID()
  };
  let complete = false;
  try {
    writeFileSync(fd, JSON.stringify(owner), "utf8");
    fsyncSync(fd);
    complete = true;
  } finally {
    closeSync(fd);
    if (!complete) {
      // We created this path and never published a complete owner. No
      // conforming contender can have replaced it while it still exists.
      try {
        unlinkSync(lockPath);
      } catch {
        // Preserve the original write/fsync error.
      }
    }
  }
  return owner;
}

/**
 * Remove a stale owner's lock while holding a separate O_EXCL recovery
 * token (external 0.5 review). Serializing reclamation matters: without
 * it, two restarting processes can both classify the old owner as dead,
 * and the slower one then unlinks the FASTER process's newly created
 * lock, leaving two live writers inside one critical section. The owner
 * is re-read under the recovery token before the unlink.
 */
function tryReclaim(lockPath: string): boolean {
  const recoveryPath = `${lockPath}.reclaim`;
  let recoveryOwner: LockOwner;
  try {
    recoveryOwner = createOwnerFile(recoveryPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    const current = readOwner(lockPath);
    if (!isStale(current, Date.now())) return false;
    try {
      unlinkSync(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return true;
  } finally {
    release(recoveryPath, recoveryOwner);
  }
}

/** Acquire the lock, blocking until it is ours or the timeout expires. */
function acquire(lockPath: string, timeoutMs: number, longLived = false): LockOwner {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // "wx" is O_CREAT|O_EXCL: exactly one racer creates the file.
      return createOwnerFile(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const owner = readOwner(lockPath);
    if (isStale(owner, Date.now()) && tryReclaim(lockPath)) continue;
    if (Date.now() >= deadline) {
      const who =
        owner !== null ? `pid ${owner.pid} on ${owner.host || "an unknown host"}` : "an unknown process";
      throw new Error(
        longLived
          ? `buzz-axiru: another enforcing gate already owns this data directory (${lockPath} is held by ${who}). ` +
              "Two gates sharing one cap history can each authorize payments from a stale snapshot. Stop the " +
              "other gate or use a distinct --data-dir; delete the serving lock only after verifying its owner is gone."
          : `buzz-axiru: could not lock the data directory after ${timeoutMs}ms: ${lockPath} is held by ${who}. ` +
              "Refusing to write the ledger or the approval store unlocked, because concurrent writers corrupt " +
              "the hash chain. Stop the other buzz-axiru process, or delete the lock file if you are certain it is stale."
      );
    }
    sleepSync(RETRY_MS);
  }
}

/**
 * Claim exclusive ownership of one enforcing data directory for the
 * lifetime of a gate (external 0.5 review). The short critical-section
 * lock protects file integrity; this lease additionally guarantees at
 * most one gate serves a given cap history, so two gates cannot both
 * authorize against snapshots each is about to invalidate.
 */
export function acquireServingLease(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir, SERVE_LOCK_FILE_NAME);
  const owner = acquire(lockPath, 0, true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release(lockPath, owner);
  };
}

function release(lockPath: string, owner: LockOwner): void {
  try {
    // A stale-lock recovery may have replaced the path while this
    // process was paused. Only unlink the inode represented by our own
    // ownership token; never remove a newer process's lock.
    if (readOwner(lockPath)?.token !== owner.token) return;
    unlinkSync(lockPath);
  } catch {
    // Already gone (reclaimed as stale while we held it). Nothing to undo.
  }
}

/**
 * Run `fn` while holding the data directory's exclusive lock. The lock
 * is released even when `fn` throws, and the caller sees the original
 * error rather than a lock error.
 */
export function withDataDirLock<T>(dataDir: string, fn: () => T, timeoutMs = DEFAULT_TIMEOUT_MS): T {
  const lockPath = join(dataDir, LOCK_FILE_NAME);
  const depth = held.get(lockPath) ?? 0;
  if (depth > 0) {
    held.set(lockPath, depth + 1);
    try {
      return fn();
    } finally {
      held.set(lockPath, (held.get(lockPath) ?? 1) - 1);
    }
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const owner = acquire(lockPath, timeoutMs);
  held.set(lockPath, 1);
  try {
    return fn();
  } finally {
    held.set(lockPath, 0);
    release(lockPath, owner);
  }
}
