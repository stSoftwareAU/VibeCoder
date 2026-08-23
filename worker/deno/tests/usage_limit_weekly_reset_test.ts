/**
 * Parsing the weekly usage-limit reset (Issue #333).
 *
 * The real message on 2026-08-23 was:
 *
 *   You've hit your weekly limit · resets Aug 25, 1am (UTC)
 *
 * `parseUsageLimitReset` only matched a bare clock after `resets`, so the
 * dated form returned null and the worker logged "(no reset time in the
 * message; default hour)" against a message that plainly contained one.
 *
 * The retry cadence is deliberately unchanged: the quota may be extended
 * before the stated reset, so the worker re-probes about hourly rather than
 * sleeping for two days. The reset is *information*, not a sleep duration.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { parseUsageLimitReset } from "../lib/claude_executor.ts";

/** The message, verbatim from worker-20260823-063503.log. */
const WEEKLY = "You've hit your weekly limit · resets Aug 25, 1am (UTC)";
/** 06:33:26Z on 2026-08-23, when it was logged. */
const NOW = Date.parse("2026-08-23T06:33:26Z");

Deno.test("#333 - the real weekly message parses to its stated reset", () => {
  assertEquals(
    parseUsageLimitReset(WEEKLY, NOW, "UTC"),
    Date.parse("2026-08-25T01:00:00Z"),
  );
});

Deno.test("#333 - an explicit (UTC) wins over the host zone", () => {
  // A host in Australia/Sydney reading `1am (UTC)` as local would be ten
  // hours out — and every fleet host but one is not in UTC.
  assertEquals(
    parseUsageLimitReset(WEEKLY, NOW, "Australia/Sydney"),
    Date.parse("2026-08-25T01:00:00Z"),
  );
});

Deno.test("#333 - a dated reset already past this year rolls to next year", () => {
  // A December message naming a January reset must not resolve into the past.
  const dec = Date.parse("2026-12-30T12:00:00Z");
  assertEquals(
    parseUsageLimitReset("weekly limit · resets Jan 2, 1am (UTC)", dec, "UTC"),
    Date.parse("2027-01-02T01:00:00Z"),
  );
});

Deno.test("#333 - the dated form is tried before the bare clock", () => {
  // The bug this guards: a bare-clock match on the `1am` would give
  // 2026-08-24T01:00Z — the next 1am, a full day before the real reset.
  const parsed = parseUsageLimitReset(WEEKLY, NOW, "UTC");
  assertEquals(parsed !== Date.parse("2026-08-24T01:00:00Z"), true);
});

Deno.test("#333 - day suffixes and a 24-hour time are accepted", () => {
  assertEquals(
    parseUsageLimitReset("resets Aug 25th, 13:30 (UTC)", NOW, "UTC"),
    Date.parse("2026-08-25T13:30:00Z"),
  );
});

Deno.test("#333 - pm is applied to a dated reset", () => {
  assertEquals(
    parseUsageLimitReset("resets Aug 25, 9pm (UTC)", NOW, "UTC"),
    Date.parse("2026-08-25T21:00:00Z"),
  );
});

// ---------------------------------------------------------------------------
// The pre-existing forms must keep working
// ---------------------------------------------------------------------------

Deno.test("#333 - the machine-readable epoch form still wins", () => {
  assertEquals(
    parseUsageLimitReset("usage limit reached|1787000000", NOW, "UTC"),
    1787000000 * 1000,
  );
});

Deno.test("#333 - bare clock forms are unchanged (5-hour window)", () => {
  assertEquals(
    parseUsageLimitReset("resets at 3pm", NOW, "UTC"),
    Date.parse("2026-08-23T15:00:00Z"),
  );
  assertEquals(
    parseUsageLimitReset("resets 1am", NOW, "UTC"),
    Date.parse("2026-08-24T01:00:00Z"),
  );
  assertEquals(
    parseUsageLimitReset("reset at 14:30", NOW, "UTC"),
    Date.parse("2026-08-23T14:30:00Z"),
  );
});

Deno.test("#333 - a message with no reset time still returns null", () => {
  assertEquals(parseUsageLimitReset("You've hit your weekly limit", NOW), null);
  assertEquals(parseUsageLimitReset("", NOW), null);
});

Deno.test("#333 - an unknown month is not a date", () => {
  // Must fall through rather than resolve to a wrong month.
  assertEquals(
    parseUsageLimitReset("resets Smarch 25, 1am (UTC)", NOW, "UTC"),
    null,
  );
});

// ---------------------------------------------------------------------------
// Reporting: days, not thousands of minutes (Issue #333)
// ---------------------------------------------------------------------------

Deno.test("#333 - a multi-day reset is reported in days and hours", async () => {
  const { formatCoarseDuration } = await import("../lib/rate_limit_wait.ts");
  // The real case: 2026-08-23T06:33Z → 2026-08-25T01:00Z. The existing
  // minutes-only formatter would render this as "2547m 00s".
  const secs = (Date.parse("2026-08-25T01:00:00Z") - NOW) / 1000;
  assertEquals(formatCoarseDuration(secs), "1d 18h");
});

Deno.test("#333 - shorter windows drop to hours, then minutes", async () => {
  const { formatCoarseDuration } = await import("../lib/rate_limit_wait.ts");
  assertEquals(formatCoarseDuration(4 * 3600 + 12 * 60), "4h 12m");
  assertEquals(formatCoarseDuration(12 * 60), "12m");
  assertEquals(formatCoarseDuration(0), "0m");
  assertEquals(formatCoarseDuration(-5), "0m");
});

// ---------------------------------------------------------------------------
// A multi-day outage must be visible on the health report (Issue #333)
// ---------------------------------------------------------------------------

Deno.test("#333 - the signal carries the true reset, not just the capped wait", async () => {
  const { writeRateLimitSignal, readQuotaOutage } = await import(
    "../lib/rate_limit_signal.ts"
  );
  const dir = await Deno.makeTempDir();
  try {
    const reset = Date.parse("2026-08-25T01:00:00Z");
    // waitSeconds is the capped retry interval; resetEpochMs is the truth.
    await writeRateLimitSignal(dir, 3600, reset);
    const outage = await readQuotaOutage(dir, NOW);
    assertEquals(outage?.resetEpochMs, reset);
    assertEquals(outage?.remainingSeconds, Math.ceil((reset - NOW) / 1000));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("#333 - a reset already in the past is not an outage", async () => {
  const { writeRateLimitSignal, readQuotaOutage } = await import(
    "../lib/rate_limit_signal.ts"
  );
  const dir = await Deno.makeTempDir();
  try {
    await writeRateLimitSignal(dir, 3600, NOW - 60_000);
    assertEquals(await readQuotaOutage(dir, NOW), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("#333 - an older signal without the reset still parses", async () => {
  // Back-compatibility: a signal written before this change must not throw.
  const { rateLimitSignalPath, readQuotaOutage } = await import(
    "../lib/rate_limit_signal.ts"
  );
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      rateLimitSignalPath(dir),
      JSON.stringify({ timestamp: 1, waitSeconds: 3600 }),
    );
    assertEquals(await readQuotaOutage(dir, NOW), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("#333 - a missing or corrupt signal is not an outage", async () => {
  const { rateLimitSignalPath, readQuotaOutage } = await import(
    "../lib/rate_limit_signal.ts"
  );
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await readQuotaOutage(dir, NOW), null);
    await Deno.writeTextFile(rateLimitSignalPath(dir), "{not json");
    assertEquals(await readQuotaOutage(dir, NOW), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Formats the merged #339 parser did not cover (from PR #341)
// ---------------------------------------------------------------------------

Deno.test("#333 - day-first dates parse (resets on 25 Aug 2026 at 13:30)", () => {
  assertEquals(
    parseUsageLimitReset("resets on 25 Aug 2026 at 13:30 (UTC)", NOW, "UTC"),
    Date.parse("2026-08-25T13:30:00Z"),
  );
});

Deno.test("#333 - a full month name and an explicit year parse", () => {
  assertEquals(
    parseUsageLimitReset("resets September 1, 12:30pm (UTC)", NOW, "UTC"),
    Date.parse("2026-09-01T12:30:00Z"),
  );
});

Deno.test("#333 - an abbreviated month with a full stop parses", () => {
  assertEquals(
    parseUsageLimitReset("resets Aug. 25, 1am (UTC)", NOW, "UTC"),
    Date.parse("2026-08-25T01:00:00Z"),
  );
});

Deno.test("#333 - an impossible date is rejected, not overflowed", () => {
  // `Date.UTC(2026, 1, 31)` silently becomes 3 March. A reset that cannot
  // exist must not resolve to a real time five weeks out.
  assertEquals(
    parseUsageLimitReset("resets Feb 31, 1am (UTC)", NOW, "UTC"),
    null,
  );
});

Deno.test("#333 - with no zone in the message the caller's zone is honoured", () => {
  // 1am on 25 Aug in Sydney is 15:00 on 24 Aug UTC. The first cut of this
  // parser built non-UTC dates with `new Date(y, m, d, …)`, which uses the
  // *process* zone and ignored the caller's argument entirely.
  assertEquals(
    parseUsageLimitReset("resets Aug 25, 1am", NOW, "Australia/Sydney"),
    Date.parse("2026-08-24T15:00:00Z"),
  );
});
