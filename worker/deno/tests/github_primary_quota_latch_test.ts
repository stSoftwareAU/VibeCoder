/**
 * Integration tests for the primary-GraphQL-quota latch at the `gh`
 * chokepoint (`runGhCommandRaw`, Issue #42).
 *
 * Drives the real chokepoint with an injected low-level runner
 * (`_setGhSpawnRunner`) so the latch's short-circuit, exemptions, and
 * self-latching on a live rate-limit failure are all exercised without
 * spawning `gh`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  _resetGhSpawnRunner,
  _setGhSpawnRunner,
  type GhSpawnResult,
} from "../lib/gh_spawn.ts";
import { runGhCommandRaw } from "../lib/github.ts";
import {
  clearPrimaryQuotaLatch,
  isPrimaryQuotaLatched,
  latchPrimaryQuota,
} from "../lib/primary_quota_latch.ts";
import { readRateLimitSignal } from "../lib/rate_limit_signal.ts";

const RATE_LIMIT_MSG = "GraphQL: API rate limit already exceeded for user";

function ok(stdout: string): GhSpawnResult {
  return { code: 0, success: true, stdout, stderr: "" };
}

function fail(stderr: string): GhSpawnResult {
  return { code: 1, success: false, stdout: "", stderr };
}

/** A rate_limit document whose GraphQL quota resets at `reset`. */
function rateLimitDoc(reset: number): string {
  return JSON.stringify({
    resources: { graphql: { reset, remaining: 0 }, core: { reset } },
  });
}

Deno.test("chokepoint - a latched GraphQL call short-circuits without spawning", async () => {
  clearPrimaryQuotaLatch();
  let spawned = 0;
  _setGhSpawnRunner((_args) => {
    spawned++;
    return Promise.resolve(ok("[]"));
  });
  try {
    // Latch far into the future so the call cannot slip through on timing.
    latchPrimaryQuota(Math.floor(Date.now() / 1000) + 3600);
    const err = await assertRejects(
      () => runGhCommandRaw(["issue", "list", "--repo", "o/r"]),
      Error,
    );
    // The skip message carries the primary-quota phrase so the scans' log
    // lines and the Issue #1780 pause still classify it correctly.
    assert(
      /api rate limit already exceeded/i.test(err.message),
      `skip message should name the primary quota: ${err.message}`,
    );
    assertEquals(spawned, 0, "a latched call must not spawn gh");
  } finally {
    _resetGhSpawnRunner();
    clearPrimaryQuotaLatch();
  }
});

Deno.test("chokepoint - `gh api rate_limit` stays callable while latched", async () => {
  clearPrimaryQuotaLatch();
  let spawned = 0;
  _setGhSpawnRunner((_args) => {
    spawned++;
    return Promise.resolve(ok(rateLimitDoc(1_000)));
  });
  try {
    latchPrimaryQuota(Math.floor(Date.now() / 1000) + 3600);
    const out = await runGhCommandRaw(["api", "rate_limit"]);
    assert(out.includes("graphql"), "the exempt call should return its body");
    assertEquals(spawned, 1, "the exempt call must actually spawn");
  } finally {
    _resetGhSpawnRunner();
    clearPrimaryQuotaLatch();
  }
});

Deno.test("chokepoint - a live primary-quota failure latches the process and signals the window", async () => {
  clearPrimaryQuotaLatch();
  const workDir = await Deno.makeTempDir({ prefix: "quota_latch_" });
  // The signal's directory is a parameter, not `WORK_DIR` set on the
  // process (Issue #966): a temp root no environment names, so a code path
  // that fell back to `Deno.env.get("WORK_DIR")` writes somewhere else and
  // the `readRateLimitSignal` below finds nothing.
  const nowSec = Math.floor(Date.now() / 1000);
  const resetAt = nowSec + 900;
  const seen: string[] = [];
  _setGhSpawnRunner((args) => {
    seen.push(args.join(" "));
    // The reset read (exempt) answers with the real reset; every other call
    // reports the primary-quota outage.
    if (args[0] === "api" && args.includes("rate_limit")) {
      return Promise.resolve(ok(rateLimitDoc(resetAt)));
    }
    return Promise.resolve(fail(RATE_LIMIT_MSG));
  });

  try {
    // The first live call fails with the primary-quota message …
    await assertRejects(
      () => runGhCommandRaw(["pr", "list", "--repo", "o/r"], { workDir }),
      Error,
      "already exceeded",
    );
    // … which latches the process.
    assert(isPrimaryQuotaLatched(nowSec), "the failure should latch");

    // The shared signal file now names the window, so the Issue #1780 pause
    // and sibling workers observe the same reset.
    const signal = await readRateLimitSignal(workDir);
    assert(signal.ok, "a signal file should be written");
    if (signal.ok) {
      assert(signal.value.waitSeconds > 0);
      assert(signal.value.waitSeconds <= 900);
    }

    // A subsequent GraphQL-backed call short-circuits — the runner sees only
    // the first failing call plus the one exempt rate_limit read.
    const spawnsBefore = seen.length;
    await assertRejects(
      () => runGhCommandRaw(["issue", "list", "--repo", "o/r"], { workDir }),
      Error,
    );
    assertEquals(
      seen.length,
      spawnsBefore,
      "a call behind the latch must not spawn",
    );
  } finally {
    _resetGhSpawnRunner();
    clearPrimaryQuotaLatch();
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("chokepoint - the rate-limit signal lands in the injected work dir, not the ambient one (Issue #966)", async () => {
  clearPrimaryQuotaLatch();
  const pointedAt = await Deno.makeTempDir({ prefix: "quota_signal_used_" });
  const decoy = await Deno.makeTempDir({ prefix: "quota_signal_decoy_" });
  const nowSec = Math.floor(Date.now() / 1000);
  _setGhSpawnRunner((args) => {
    if (args[0] === "api" && args.includes("rate_limit")) {
      return Promise.resolve(ok(rateLimitDoc(nowSec + 900)));
    }
    return Promise.resolve(fail(RATE_LIMIT_MSG));
  });
  try {
    await assertRejects(
      () =>
        runGhCommandRaw(["pr", "list", "--repo", "o/r"], {
          workDir: pointedAt,
        }),
      Error,
      "already exceeded",
    );

    // Written where it was told to write, and nowhere else: a fallback to
    // `Deno.env.get("WORK_DIR")` would leave this root empty.
    const signal = await readRateLimitSignal(pointedAt);
    assert(signal.ok && signal.value.waitSeconds > 0, "no signal was written");
    assertEquals([...Deno.readDirSync(decoy)], []);
  } finally {
    _resetGhSpawnRunner();
    clearPrimaryQuotaLatch();
    await Deno.remove(pointedAt, { recursive: true });
    await Deno.remove(decoy, { recursive: true });
  }
});

Deno.test("chokepoint - a REST claim release stays callable while latched (Issue #42 Defect 3)", async () => {
  clearPrimaryQuotaLatch();
  let spawned = 0;
  _setGhSpawnRunner((_args) => {
    spawned++;
    return Promise.resolve(ok(""));
  });
  try {
    latchPrimaryQuota(Math.floor(Date.now() / 1000) + 3600);
    // The REST assignees-DELETE release rides the core quota, so it must
    // pass through the latch and actually spawn.
    await runGhCommandRaw([
      "api",
      "-X",
      "DELETE",
      "repos/o/r/issues/5/assignees",
      "-f",
      "assignees[]=bot",
    ]);
    assertEquals(spawned, 1, "a REST release must spawn even while latched");
  } finally {
    _resetGhSpawnRunner();
    clearPrimaryQuotaLatch();
  }
});
