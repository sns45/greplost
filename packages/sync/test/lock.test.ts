/**
 * greplost:sync advisory lock tests (leaf 1.3.2, tech spec 7.4).
 *
 * The lock is what makes a git hook, a Claude `Stop` hook and a human all able
 * to run `greplost update` at the same time without two writers racing on
 * `.greplost/`. It has to fail in exactly two directions: never let a second
 * live writer in, and never let a dead one keep the door shut forever.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ARTIFACT_DIR, ARTIFACT_PATHS } from "@greplost/core/schema";

import { LOCK_STALE_MS, isLocked, withLock } from "../src/lock.ts";

const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** A bare directory with a `.greplost/` in it; the lock needs nothing else. */
function repo(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-lock-${label}-`));
  temporaries.push(dir);
  mkdirSync(path.join(dir, ARTIFACT_DIR), { recursive: true });
  return dir;
}

function lockFile(root: string): string {
  return path.join(root, ARTIFACT_DIR, ARTIFACT_PATHS.lock);
}

function writeLock(root: string, contents: string): void {
  writeFileSync(lockFile(root), contents);
}

/** A pid that is certainly not running, so `process.kill(pid, 0)` throws ESRCH. */
function deadPid(): number {
  for (let pid = 65000; pid > 20000; pid--) {
    try {
      process.kill(pid, 0);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no dead pid available on this machine");
}

describe("lock", () => {
  test("runs the callback, returns its value and removes the lock", async () => {
    const root = repo("basic");

    const result = await withLock(root, async () => {
      expect(existsSync(lockFile(root))).toBe(true);
      expect(isLocked(root)).toBe(true);
      return 41 + 1;
    });

    expect(result).toBe(42);
    expect(existsSync(lockFile(root))).toBe(false);
    expect(isLocked(root)).toBe(false);
  });

  test("records the holder's pid and a timestamp", async () => {
    const root = repo("payload");

    await withLock(root, async () => {
      const held = JSON.parse(readFileSync(lockFile(root), "utf8")) as { pid: number; ts: number };
      expect(held.pid).toBe(process.pid);
      expect(Math.abs(Date.now() - held.ts)).toBeLessThan(LOCK_STALE_MS);
      return undefined;
    });
  });

  test("creates .greplost/ when it does not exist yet", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "greplost-lock-fresh-"));
    temporaries.push(dir);

    const ran = await withLock(dir, async () => "ran");

    expect(ran).toBe("ran");
    expect(existsSync(path.join(dir, ARTIFACT_DIR))).toBe(true);
  });

  test("a live holder blocks: the callback never runs and undefined comes back", async () => {
    const root = repo("live");
    writeLock(root, JSON.stringify({ pid: process.pid, ts: Date.now() }));

    let ran = false;
    const result = await withLock(root, async () => {
      ran = true;
      return "should not happen";
    });

    expect(result).toBeUndefined();
    expect(ran).toBe(false);
    expect(isLocked(root)).toBe(true);
    // The blocked caller must not delete a lock it never owned.
    expect(existsSync(lockFile(root))).toBe(true);
  });

  test("is not re-entrant: a nested acquisition is blocked, and the outer lock survives it", async () => {
    const root = repo("nested");

    const result = await withLock(root, async () => {
      const inner = await withLock(root, async () => "inner ran");
      expect(inner).toBeUndefined();
      expect(existsSync(lockFile(root))).toBe(true);
      return "outer done";
    });

    expect(result).toBe("outer done");
    expect(existsSync(lockFile(root))).toBe(false);
  });

  test("reclaims a lock whose pid is dead", async () => {
    const root = repo("deadpid");
    const pid = deadPid();
    writeLock(root, JSON.stringify({ pid, ts: Date.now() }));

    expect(isLocked(root)).toBe(false);

    const result = await withLock(root, async () => {
      const held = JSON.parse(readFileSync(lockFile(root), "utf8")) as { pid: number };
      expect(held.pid).toBe(process.pid);
      return "reclaimed";
    });

    expect(result).toBe("reclaimed");
    expect(existsSync(lockFile(root))).toBe(false);
  });

  test("reclaims a lock older than the stale window even when its pid is alive", async () => {
    const root = repo("stale");
    writeLock(root, JSON.stringify({ pid: process.pid, ts: Date.now() - LOCK_STALE_MS - 1_000 }));

    expect(isLocked(root)).toBe(false);
    expect(await withLock(root, async () => "reclaimed")).toBe("reclaimed");
    expect(existsSync(lockFile(root))).toBe(false);
  });

  test("keeps a fresh lock held by a live process, right up to the stale window", async () => {
    const root = repo("fresh");
    writeLock(root, JSON.stringify({ pid: process.pid, ts: Date.now() - (LOCK_STALE_MS - 5_000) }));

    expect(isLocked(root)).toBe(true);
    expect(await withLock(root, async () => "should not run")).toBeUndefined();
  });

  test("reclaims a lock file it cannot make sense of", async () => {
    for (const [label, contents] of [
      ["garbage", "not json at all"],
      ["empty", ""],
      ["wrongshape", JSON.stringify({ owner: "someone" })],
      ["negativepid", JSON.stringify({ pid: -1, ts: Date.now() })],
      ["zeropid", JSON.stringify({ pid: 0, ts: Date.now() })],
    ] as const) {
      const root = repo(`bogus-${label}`);
      writeLock(root, contents);

      expect(isLocked(root)).toBe(false);
      expect(await withLock(root, async () => label)).toBe(label);
      expect(existsSync(lockFile(root))).toBe(false);
    }
  });

  test("removes the lock when the callback throws, and lets the error through", async () => {
    const root = repo("throws");

    await expect(withLock(root, async () => {
      throw new Error("greplost: boom");
    })).rejects.toThrow("greplost: boom");

    expect(existsSync(lockFile(root))).toBe(false);
    expect(isLocked(root)).toBe(false);

    // And the next run is not blocked by the wreckage of the last one.
    expect(await withLock(root, async () => "next")).toBe("next");
  });

  test("does not delete a lock that was reclaimed from under it", async () => {
    const root = repo("stolen");

    const result = await withLock(root, async () => {
      // Another process decided this lock was stale and took it. Its token
      // differs from ours (a later timestamp), which is what release checks.
      writeLock(root, JSON.stringify({ pid: process.pid, ts: Date.now() + 5_000 }));
      return "done";
    });

    expect(result).toBe("done");
    expect(existsSync(lockFile(root))).toBe(true);
    expect(isLocked(root)).toBe(true);
  });

  test("isLocked reports false when there is no lock at all", () => {
    const root = repo("unlocked");
    expect(isLocked(root)).toBe(false);
    expect(isLocked(path.join(root, "nope"))).toBe(false);
  });
});
