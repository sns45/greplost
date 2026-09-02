/**
 * The advisory update lock (tech spec 7.4, sync spec "Lock").
 *
 * Four things can decide to rebuild the map at the same moment: a git hook
 * after a commit, another git hook after the merge that commit triggered, the
 * plugin's `Stop` hook, and a human typing `greplost update`. Only one of them
 * may write `.greplost/`, and the losers must not queue, retry or block — a
 * hook that waits is a hook that makes the shell feel broken. So the contract
 * is deliberately lossy: whoever gets the lock does the work, everyone else
 * returns immediately and the next trigger catches up. That is safe because an
 * update is a full rebuild of the map from the checkout, not a patch: skipping
 * one can never leave the map half-applied.
 *
 * The failure that matters is the opposite one. A process killed between
 * acquiring and releasing (a power cut, a `kill -9`, a laptop lid) leaves a
 * file behind, and a lock file that outlives its owner would silently freeze
 * every future update. Hence two independent staleness tests — a dead pid and
 * a timestamp that has stopped moving — either of which reclaims the lock. The
 * pid test catches the crash straight away; the timestamp catches the cases the
 * pid test cannot (a recycled pid, a container where pids mean nothing, a lock
 * copied in from somewhere else).
 *
 * The timestamp only means "not abandoned" because the holder keeps rewriting
 * it. A fixed acquisition time would make the staleness rule fire on exactly
 * the run that most needs protecting — an update of a repository big enough to
 * take longer than the window — so the holder heartbeats, and the rule becomes
 * "no refresh for a minute" rather than "started over a minute ago".
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ARTIFACT_DIR, ARTIFACT_PATHS, stableStringify } from "@greplost/core/schema";

/** A lock that has not been refreshed within this window is reclaimed. */
export const LOCK_STALE_MS = 60_000;

/**
 * How often a holder rewrites its timestamp.
 *
 * A quarter of the stale window, so three consecutive refreshes can be lost —
 * to a stopped-world GC pause, a suspended laptop, a loaded CI box — before
 * anyone else considers the lock abandoned. Without a heartbeat the staleness
 * rule punishes exactly the run that most needs the lock: an update of a large
 * repository that legitimately takes longer than a minute would be declared
 * dead by the next hook and have its artifact directory written underneath it.
 */
export const LOCK_HEARTBEAT_MS = 15_000;

/** What `.greplost/.lock` holds. */
export interface LockInfo {
  pid: number;
  /** Epoch milliseconds of the acquisition or the last heartbeat. */
  ts: number;
}

/** True when a live, non-stale holder owns the lock (the current process counts). */
export function isLocked(root: string): boolean {
  const held = readLock(lockPath(root));
  return held !== undefined && !isStaleLock(held);
}

/**
 * Run `fn` while holding the update lock; return its value, or `undefined`
 * when another live process holds the lock.
 *
 * `undefined` is therefore ambiguous with a callback that itself returns
 * `undefined`. That is the spec'd signature and it costs nothing in practice:
 * the one caller that needs to tell the two apart (`update`) returns a result
 * object, never `undefined`.
 *
 * The lock is released in `finally`, so a throwing callback does not leave one
 * behind — but only if this call still owns it. A lock reclaimed as stale by
 * someone else while `fn` ran belongs to that someone else now, and deleting
 * it would hand a third process a lock the second one thinks it holds.
 */
export async function withLock<T>(
  root: string,
  fn: () => Promise<T>,
  opts: WithLockOptions = {},
): Promise<T | undefined> {
  const file = lockPath(root);
  const holder = acquire(file);
  if (holder === undefined) return undefined;

  // `unref` so a held lock cannot keep a CLI process alive past its work, and
  // an interval rather than a timer chain so a long `fn` that never yields to
  // the loop is no worse off than one that does.
  const beat = setInterval(() => refresh(file, holder), opts.heartbeatMs ?? LOCK_HEARTBEAT_MS);
  beat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(beat);
    release(file, holder.token);
  }
}

export interface WithLockOptions {
  /**
   * Heartbeat period in milliseconds. Defaults to `LOCK_HEARTBEAT_MS`; the
   * tests use a short one to watch a refresh actually land.
   */
  heartbeatMs?: number;
}

/** The lock this process holds: the bytes it wrote, so it can prove they are still its own. */
interface Holder {
  token: string;
}

function lockPath(root: string): string {
  return path.join(path.resolve(root), ARTIFACT_DIR, ARTIFACT_PATHS.lock);
}

/**
 * Take the lock, reclaiming a stale one. Returns the exact bytes written (the
 * ownership token), or `undefined` when a live holder is in the way.
 *
 * `wx` is the whole mutual-exclusion mechanism: `open(O_CREAT|O_EXCL)` is
 * atomic on every filesystem greplost runs on, so two processes reaching this
 * line together cannot both succeed. The retry loop exists only for the
 * reclaim path — after unlinking a stale lock, a third process may have
 * created a fresh one in the gap, and that one wins.
 */
function acquire(file: string): Holder | undefined {
  const token = stableStringify({ pid: process.pid, ts: Date.now() });

  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch (cause) {
    throw new Error(`greplost: cannot create ${ARTIFACT_DIR}/: ${reasonOf(cause)}`);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, token, { flag: "wx" });
      return { token };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`greplost: cannot create ${ARTIFACT_DIR}/${ARTIFACT_PATHS.lock}: ${reasonOf(cause)}`);
      }
    }

    const held = readLock(file);
    if (held !== undefined && !isStaleLock(held)) return undefined;

    // Stale, or unreadable rubbish where a lock should be: either way nothing
    // alive is relying on it.
    try {
      rmSync(file, { force: true });
    } catch {
      // Gone already, or not ours to remove; the next `wx` says which.
    }
  }

  return undefined;
}

/**
 * Rewrite the timestamp, proving the holder is still alive.
 *
 * Through a temporary and a `rename`, never a truncating write: a reader that
 * caught a half-written lock file would parse nothing, conclude the lock is
 * rubbish and reclaim it — turning the mechanism that protects a long update
 * into the one that breaks it. `rename` swaps the directory entry in one step,
 * so a reader sees either the old timestamp or the new one.
 *
 * A lock that is no longer ours is left alone and the heartbeat gives up: it
 * belongs to whoever reclaimed it, and stamping our own timestamp on it would
 * hand two processes the same lock.
 */
function refresh(file: string, holder: Holder): void {
  let current: string;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (current !== holder.token) return;

  const token = stableStringify({ pid: process.pid, ts: Date.now() });
  const temporary = `${path.join(path.dirname(file), `.${path.basename(file)}`)}.${process.pid}.0.tmp`;
  try {
    writeFileSync(temporary, token);
    renameSync(temporary, file);
    holder.token = token;
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Swept by the next update; nothing reads a `.tmp`.
    }
  }
}

/** Release the lock, but only while the file still holds our own token. */
function release(file: string, token: string): void {
  let current: string;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (current !== token) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // A lock we cannot remove goes stale in `LOCK_STALE_MS` and is reclaimed.
  }
}

/**
 * Parse a lock file. `undefined` for anything that is not a plausible lock —
 * absent, empty, truncated by a crash mid-write, or holding a pid that could
 * never be signalled. Callers treat all of those as "reclaimable".
 */
function readLock(file: string): LockInfo | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const { pid, ts } = parsed as { pid?: unknown; ts?: unknown };
  // pid 0 addresses the whole process group and negative pids a group by id;
  // signalling either to test liveness would be a real signal to real
  // processes, so a lock naming one is rubbish, not a holder.
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;

  return { pid, ts };
}

/**
 * Is this lock reclaimable?
 *
 * Three ways to be. Its holder is gone (a dead pid). It has not been refreshed
 * within the stale window, which after the heartbeat means the holder is
 * wedged rather than merely slow. Or its timestamp is more than a window in the
 * *future*, which no live holder can produce: that is a clock that has been
 * moved (a VM resumed from a snapshot, a container with a skewed host, an NTP
 * step) and, left alone, would pin the lock until the wall clock caught up.
 *
 * `now` is a parameter so the predicate can be tested without waiting a minute.
 */
export function isStaleLock(held: LockInfo, now: number = Date.now()): boolean {
  const age = now - held.ts;
  return age > LOCK_STALE_MS || age < -LOCK_STALE_MS || !isAlive(held.pid);
}

/**
 * Is `pid` a running process?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. `ESRCH` is the only answer that means "no such process": `EPERM`
 * means the process exists and belongs to someone else, which is precisely the
 * case where the lock must be respected.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
