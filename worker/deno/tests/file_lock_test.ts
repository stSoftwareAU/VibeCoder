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
        // Same pid namespace as this process, which is what makes the
        // recorded pid one this process may look up at all.
        host: Deno.hostname(),
      }),
    );

    // Seconds old, not minutes. The timeout is two orders of magnitude
    // below `DEFAULT_STALE_MS`, so taking the lock at all is the proof:
    // waiting the stale age out would raise `FileLockTimeoutError` here,
    // which is what blocked the next run's audit sweep.
    const took = await withFileLock(lock, () => Promise.resolve("taken"), {
      timeoutMs: 2_000,
      pollMs: 5,
    });
    assertEquals(took, "taken");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Replaces "an ownerless lock is broken on a second look" (Issue #1074).
// That test pinned a heuristic this change removes: a lock file naming
// nobody was broken on its second sighting, on the reasoning that the op
// creating and filling it was too narrow to survive two polls. It is not.
// `Deno.writeFile(…, { createNew: true })` creates the file and writes its
// record in separate syscalls, and a holder descheduled between them is
// observably ownerless for as long as it is off the CPU — 265 of 961
// sightings in a straight measurement, and far wider under load. Two polls
// a millisecond apart therefore both land in that window, and the "proof"
// broke a *live* holder's lock. The behaviour is deliberately reversed
// below: an empty lock file is now waited out, never taken early.
Deno.test("withFileLock - an empty lock file is never broken early", async () => {
  const { dir, lock } = await tempLock();
  try {
    // Exactly what a live holder looks like mid-create. Indistinguishable
    // from a holder killed in that window, so the safe reading is the one
    // that never puts two writers in one journal.
    await Deno.writeTextFile(lock, "");
    await assertRejects(
      () =>
        withFileLock(lock, () => Promise.resolve("taken"), {
          timeoutMs: 150,
          pollMs: 1,
        }),
      FileLockTimeoutError,
    );
    // Untouched: the contender waited rather than stealing it.
    assertEquals(await Deno.readTextFile(lock), "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withFileLock - an empty lock file is still aged out", async () => {
  const { dir, lock } = await tempLock();
  try {
    // The case the removed heuristic was reaching for: a genuinely
    // abandoned ownerless lock must not wedge writers for ever. The age
    // rule already covers it, without having to guess about a live holder.
    await Deno.writeTextFile(lock, "");
    const took = await withFileLock(lock, () => Promise.resolve("taken"), {
      timeoutMs: 2_000,
      pollMs: 5,
      staleMs: 50,
      now: () => Date.now() + 10_000,
    });
    assertEquals(took, "taken");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withFileLock - the lock file is never seen without its record", async () => {
  const { dir, lock } = await tempLock();
  try {
    // The property that makes the ownerless case unreachable rather than
    // merely tolerated: once the lock file exists, it already carries the
    // record naming its holder.
    let ownerless = 0;
    let sightings = 0;
    let watching = true;
    // Reads the file the way the lock breaker does, because that is the
    // observation the safety of a break rests on: a present lock file whose
    // record will not parse is what "ownerless" actually means.
    const watcher = (async () => {
      while (watching) {
        let raw: string;
        try {
          raw = await Deno.readTextFile(lock);
        } catch {
          continue; // Between holders; nothing to see.
        }
        sightings++;
        try {
          const parsed = JSON.parse(raw) as { token?: unknown };
          if (typeof parsed?.token !== "string") ownerless++;
        } catch {
          ownerless++;
        }
      }
    })();

    await Promise.all(
      Array.from(
        { length: 40 },
        () => withFileLock(lock, () => Promise.resolve(true), { pollMs: 1 }),
      ),
    );
    watching = false;
    await watcher;

    assertEquals(ownerless, 0, "a lock file was visible without its record");
    assert(sightings > 0, "the watcher never saw the lock file at all");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withFileLock - a lock from another host is never broken early", async () => {
  const { dir, lock } = await tempLock();
  try {
    // Pids are namespaced, so a record written elsewhere names a pid this
    // process cannot look up. Believing a `ps` miss there would steal a
    // live holder's lock and put two writers in one journal.
    await Deno.writeTextFile(
      lock,
      JSON.stringify({
        token: "elsewhere",
        pid: 999_999,
        acquiredAt: new Date().toISOString(),
        host: "some-other-container",
      }),
    );
    await assertRejects(
      () =>
        withFileLock(lock, () => Promise.resolve(), {
          timeoutMs: 150,
          pollMs: 5,
        }),
      FileLockTimeoutError,
    );
    const held = JSON.parse(await Deno.readTextFile(lock));
    assertEquals(held.token, "elsewhere");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("withFileLock - a contender does not break the lock of whoever won the race", async () => {
  const { dir, lock } = await tempLock();
  // Two contenders can condemn the same dead holder at the same time.
  // Deciding is not instant — the liveness probe spawns `ps` — so by the
  // time the loser acts, the winner may already hold a fresh lock of its
  // own. Removing the lock "at that path" rather than the lock that was
  // judged is how the second contender evicts the first and two writers
  // land in one journal (Issue #1074).
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
        token: "the-dead-holder",
        pid: deadPid,
        acquiredAt: new Date().toISOString(),
        host: Deno.hostname(),
      }),
    );

    let inside = 0;
    let maxInside = 0;
    const body = async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 20));
      inside--;
      return true;
    };
    // Every contender condemns the same record before any of them acts.
    await Promise.all(
      Array.from(
        { length: 6 },
        () => withFileLock(lock, body, { timeoutMs: 5_000, pollMs: 1 }),
      ),
    );
    assertEquals(maxInside, 1, "a contender evicted the winner of the race");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
