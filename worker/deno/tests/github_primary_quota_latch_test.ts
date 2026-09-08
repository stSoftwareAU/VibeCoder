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
  spawnGh,
} from "../lib/gh_spawn.ts";
import {
  runGhCommandRaw,
  SECONDARY_LIMIT_BACKOFF_SECONDS,
} from "../lib/github.ts";
import {
  clearPrimaryQuotaLatch,
  isPrimaryQuotaLatched,
  latchPrimaryQuota,
  primaryQuotaLatchedUntil,
} from "../lib/primary_quota_latch.ts";
import { readRateLimitSignal } from "../lib/rate_limit_signal.ts";
import { isGraphqlQuotaProbe } from "../lib/graphql_quota_probe.ts";

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

Deno.test("chokepoint - the latch trusts the GraphQL probe headers over a rate_limit document that reports an untouched bucket (Issue #1456)", async () => {
  // Observed in production: `gh api rate_limit` answered `used: 0` with a
  // reset exactly one hour out while the same token's GraphQL response
  // headers said the window was spent and reopened in fifteen minutes. The
  // old latch waited the hour; this one waits the fifteen minutes.
  clearPrimaryQuotaLatch();
  const workDir = await Deno.makeTempDir({ prefix: "quota_latch_probe_" });
  const nowSec = Math.floor(Date.now() / 1000);
  const trueReset = nowSec + 900;
  const lyingReset = nowSec + 3600;
  _setGhSpawnRunner((args) => {
    if (isGraphqlQuotaProbe(args)) {
      // GitHub's exhausted shape: headers name the reset, the body is an
      // error, and gh exits non-zero on that body.
      return Promise.resolve({
        code: 1,
        success: false,
        stdout: [
          "HTTP/2.0 200 OK",
          "X-Ratelimit-Limit: 5000",
          "X-Ratelimit-Remaining: 0",
          `X-Ratelimit-Reset: ${trueReset}`,
          "X-Ratelimit-Resource: graphql",
          "X-Ratelimit-Used: 5000",
          "",
          '{"errors":[{"type":"RATE_LIMITED","message":"API rate limit already exceeded for user ID 1."}]}',
        ].join("\r\n"),
        stderr: RATE_LIMIT_MSG,
      });
    }
    if (args[0] === "api" && args.includes("rate_limit")) {
      return Promise.resolve(ok(JSON.stringify({
        resources: {
          graphql: { limit: 5000, used: 0, remaining: 5000, reset: lyingReset },
          core: { limit: 5000, used: 0, remaining: 5000, reset: lyingReset },
        },
      })));
    }
    return Promise.resolve(fail(RATE_LIMIT_MSG));
  });
  try {
    await assertRejects(
      () => runGhCommandRaw(["pr", "list", "--repo", "o/r"], { workDir }),
      Error,
      "already exceeded",
    );
    assert(isPrimaryQuotaLatched(nowSec), "the failure should latch");
    assertEquals(
      primaryQuotaLatchedUntil(),
      trueReset,
      "the latch must hold until the headers' reset, not the REST guess",
    );
    const signal = await readRateLimitSignal(workDir);
    assert(signal.ok, "a signal file should be written");
    if (signal.ok) {
      assert(signal.value.waitSeconds > 0);
      assert(
        signal.value.waitSeconds <= 900,
        `the signal must carry the true wait, got ${signal.value.waitSeconds}s`,
      );
    }
  } finally {
    _resetGhSpawnRunner();
    clearPrimaryQuotaLatch();
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("chokepoint - a refusal with the hourly quota still available is a secondary limit: a one-minute cool-down, not an hour (Issue #1456)", async () => {
  // Observed in production: `gh pr list` answered "API rate limit already
  // exceeded" while the account held 4,700 of 5,000 points in a window that
  // had just opened. Latching until the hourly reset idled the host for
  // the rest of the hour over a burst limit that clears in a minute.
  clearPrimaryQuotaLatch();
  const workDir = await Deno.makeTempDir({ prefix: "quota_latch_burst_" });
  const nowSec = Math.floor(Date.now() / 1000);
  const hourlyReset = nowSec + 3500;
  _setGhSpawnRunner((args) => {
    if (isGraphqlQuotaProbe(args)) {
      return Promise.resolve(ok([
        "HTTP/2.0 200 OK",
        "X-Ratelimit-Limit: 5000",
        "X-Ratelimit-Remaining: 4700",
        `X-Ratelimit-Reset: ${hourlyReset}`,
        "X-Ratelimit-Resource: graphql",
        "X-Ratelimit-Used: 300",
        "",
        '{"data":{"rateLimit":{"limit":5000,"remaining":4700,"used":300}}}',
      ].join("\r\n")));
    }
    return Promise.resolve(fail(RATE_LIMIT_MSG));
  });
  try {
    await assertRejects(
      () => runGhCommandRaw(["pr", "list", "--repo", "o/r"], { workDir }),
      Error,
      "already exceeded",
    );
    const until = primaryQuotaLatchedUntil();
    assert(until !== null, "the refusal should still latch");
    assert(
      until <= nowSec + SECONDARY_LIMIT_BACKOFF_SECONDS + 1,
      `a burst limit must cool down briefly, latched ${until - nowSec}s`,
    );
    assert(until >= nowSec + SECONDARY_LIMIT_BACKOFF_SECONDS - 1);
    const signal = await readRateLimitSignal(workDir);
    assert(
      signal.ok && signal.value.waitSeconds <= SECONDARY_LIMIT_BACKOFF_SECONDS,
    );
    // The skip message names the cool-down and keeps the phrase the pause
    // path classifies on.
    const err = await assertRejects(
      () => runGhCommandRaw(["issue", "list", "--repo", "o/r"], { workDir }),
      Error,
    );
    assert(/secondary rate limit/i.test(err.message), err.message);
    assert(/api rate limit already exceeded/i.test(err.message), err.message);
  } finally {
    _resetGhSpawnRunner();
    clearPrimaryQuotaLatch();
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("chokepoint - a secondary limit honours a longer retry-after (Issue #1456)", async () => {
  clearPrimaryQuotaLatch();
  const workDir = await Deno.makeTempDir({ prefix: "quota_latch_retry_" });
  const nowSec = Math.floor(Date.now() / 1000);
  _setGhSpawnRunner((args) => {
    if (isGraphqlQuotaProbe(args)) {
      return Promise.resolve({
        code: 1,
        success: false,
        stdout: [
          "HTTP/2.0 403 Forbidden",
          "Retry-After: 120",
          "X-Ratelimit-Limit: 5000",
          "X-Ratelimit-Remaining: 4900",
          `X-Ratelimit-Reset: ${nowSec + 3000}`,
          "X-Ratelimit-Resource: graphql",
          "X-Ratelimit-Used: 100",
          "",
          '{"message":"You have exceeded a secondary rate limit."}',
        ].join("\r\n"),
        stderr: "gh: You have exceeded a secondary rate limit.",
      });
    }
    return Promise.resolve(fail(RATE_LIMIT_MSG));
  });
  try {
    await assertRejects(
      () => runGhCommandRaw(["pr", "list", "--repo", "o/r"], { workDir }),
      Error,
    );
    const until = primaryQuotaLatchedUntil();
    assert(
      until !== null && until >= nowSec + 119 && until <= nowSec + 121,
      `latched ${until}`,
    );
  } finally {
    _resetGhSpawnRunner();
    clearPrimaryQuotaLatch();
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("chokepoint - a refusal seen by a DIRECT spawnGh caller latches the process and signals the window (Issue #1540)", async () => {
  // Loading `github.ts` (imported above) registered the production hook.
  clearPrimaryQuotaLatch();
  const workDir = await Deno.makeTempDir({ prefix: "quota_latch_direct_" });
  const nowSec = Math.floor(Date.now() / 1000);
  const resetAt = nowSec + 900;
  const seen: string[] = [];
  _setGhSpawnRunner((args) => {
    seen.push(args.join(" "));
    if (args[0] === "api" && args.includes("rate_limit")) {
      return Promise.resolve(ok(rateLimitDoc(resetAt)));
    }
    return Promise.resolve(fail(RATE_LIMIT_MSG));
  });

  try {
    // The auto-merge shape: a module calling the chokepoint directly, not
    // through runGhCommandRaw, sees the refusal …
    const first = await spawnGh(["pr", "merge", "7", "--auto", "--squash"], {
      workDir,
    });
    assertEquals(first.success, false);
    // … and that alone latches the process and writes the signal.
    assert(isPrimaryQuotaLatched(nowSec), "a direct caller's refusal latches");
    const signal = await readRateLimitSignal(workDir);
    assert(signal.ok, "a signal file should be written");

    // Its retry — and every other module's GraphQL call — is now skipped
    // without a spawn.
    const spawnsBefore = seen.length;
    const retry = await spawnGh(["pr", "merge", "7", "--auto", "--squash"]);
    assertEquals(retry.success, false);
    assert(
      /gh command skipped/.test(retry.stderr),
      `the retry should be the latch's skip, got: ${retry.stderr}`,
    );
    assertEquals(seen.length, spawnsBefore, "no spawn behind the latch");
  } finally {
    _resetGhSpawnRunner();
    clearPrimaryQuotaLatch();
    await Deno.remove(workDir, { recursive: true });
  }
});
