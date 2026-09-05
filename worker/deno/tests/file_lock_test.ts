/**
 * Cross-process lock behaviour (Issue #491).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { FileLockTimeoutError, withFileLock } from "../lib/file_lock.ts";

/** A temp directory and the lock path inside it. */
async function tempLock(): Promise<{ dir: string; lock: string }> {
  const dir = await Deno.makeTempDir({ prefix: "file-lock-" });
  return { dir, lock: `${dir}/x.lock` };
}

Deno.test("withFileLock - holders never overlap", async () => {
  const { dir, lock } = await tempLock();
  try {
    let inside = 0;
    let maxInside = 0;
    const body = async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 5));
      inside--;
      return true;
    };
    await Promise.all(
      Array.from({ length: 8 }, () => withFileLock(lock, body, { pollMs: 1 })),
    );
    assertEquals(maxInside, 1, "two callers were inside the lock at once");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withFileLock - releases the lock when the body throws", async () => {
  const { dir, lock } = await tempLock();
  try {
    await assertRejects(() =>
      withFileLock(lock, () => Promise.reject(new Error("boom")))
    );
    // Still takeable: a lock leaked on the failure path would wedge every
    // later writer until it went stale.
    const took = await withFileLock(lock, () => Promise.resolve("taken"));
    assertEquals(took, "taken");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withFileLock - times out rather than writing behind a live holder", async () => {
  const { dir, lock } = await tempLock();
  try {
    // A holder that is this very process, so the liveness check says alive.
    await Deno.writeTextFile(
      lock,
      JSON.stringify({
        token: "someone-else",
        pid: Deno.pid,
        acquiredAt: new Date().toISOString(),
      }),
    );
    const error = await assertRejects(
      () =>
        withFileLock(lock, () => Promise.resolve(), {
          timeoutMs: 150,
          pollMs: 5,
        }),
      FileLockTimeoutError,
    );
    assert(error.message.includes(lock));
    // The holder's lock is left exactly as it was.
    const held = JSON.parse(await Deno.readTextFile(lock));
    assertEquals(held.token, "someone-else");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withFileLock - breaks a lock abandoned by a dead holder", async () => {
  const { dir, lock } = await tempLock();
  try {
    await Deno.writeTextFile(
      lock,
      JSON.stringify({
        token: "gone",
        // pid 0 is never a live process, so this cannot depend on the
        // host happening not to have recycled a real pid.
        pid: 0,
        acquiredAt: new Date(0).toISOString(),
      }),
    );
    const old = new Date(Date.now() - 600_000);
    await Deno.utime(lock, old, old);

    const took = await withFileLock(lock, () => Promise.resolve("taken"), {
      timeoutMs: 500,
      pollMs: 5,
    });
    assertEquals(took, "taken");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withFileLock - never releases a lock that was retaken", async () => {
  const { dir, lock } = await tempLock();
  try {
    await withFileLock(lock, async () => {
      // Simulate this hold being broken as abandoned and retaken by
      // another process while the body was still running.
      await Deno.writeTextFile(
        lock,
        JSON.stringify({
          token: "new-owner",
          pid: Deno.pid,
          acquiredAt: new Date().toISOString(),
        }),
      );
    });
    const survivor = JSON.parse(await Deno.readTextFile(lock));
    assertEquals(survivor.token, "new-owner", "evicted the new owner");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withFileLock - a long-dead lock is broken even when its pid was recycled", async () => {
  const { dir, lock } = await tempLock();
  try {
    // Pids are namespaced per container, so a lock left by a killed run can
    // name a pid a later container has reissued. This process's own pid
    // stands in for that: alive, and not the holder.
    await Deno.writeTextFile(
      lock,
      JSON.stringify({
        token: "long-dead",
        pid: Deno.pid,
        acquiredAt: new Date(0).toISOString(),
      }),
    );
    const ancient = new Date(Date.now() - 3_600_000);
    await Deno.utime(lock, ancient, ancient);

    const took = await withFileLock(lock, () => Promise.resolve("taken"), {
      timeoutMs: 500,
      pollMs: 5,
    });
    assertEquals(took, "taken", "a wedged audit trail needs a human — a bug");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withFileLock - breaks a fresh lock whose holder is provably dead", async () => {
  const { dir, lock } = await tempLock();
  // A pid that really did exist and really is gone: the shape a run
  // killed mid-append leaves behind (Issue #1074). This runs under the
  // same granular permissions as the worker — no `--allow-all`, so
  // `/proc` is unreadable — which is exactly the case where the old
  // liveness check silently answered "assume alive" and left the audit
  // lock wedged.
  const child = new Deno.Command("sleep", {
    args: ["30"],
    stdout: "null",
    stderr: "null",
  }).spawn();
  const deadPid = child.pid;
  child.kill("SIGKILL");
  await child.status;
  try {
    await Deno.writeTextFile(
      lock,
      JSON.stringify({
        token: "killed-run",
        pid: deadPid,
        acquiredAt: new Date().toISOString(),
      }),
    );

    // Seconds old, not minutes: waiting out the stale age used to block
    // the next run's audit sweep until it timed out.
    const started = Date.now();
    const took = await withFileLock(lock, () => Promise.resolve("taken"), {
      timeoutMs: 2_000,
      pollMs: 5,
    });
    assertEquals(took, "taken");
    assert(
      Date.now() - started < 1_000,
      "a provably dead holder should not be waited out",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withFileLock - a lock with no record yet is left alone", async () => {
  const { dir, lock } = await tempLock();
  try {
    // The window between a holder's `O_EXCL` create and its first write.
    // Breaking on "no record" would evict a lock a millisecond old.
    await Deno.writeTextFile(lock, "");
    await assertRejects(
      () =>
        withFileLock(lock, () => Promise.resolve(), {
          timeoutMs: 150,
          pollMs: 5,
        }),
      FileLockTimeoutError,
    );
    assertEquals(await Deno.readTextFile(lock), "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
