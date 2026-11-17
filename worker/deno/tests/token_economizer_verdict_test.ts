/**
 * Tests for the TokenEconomizer keep-or-purge verdict (Issue #4959).
 *
 * Reports come from the real report builder over hand-written run records;
 * every expected value is a literal.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildTokenEconomizerTrialReport,
  type PrStateLookup,
  type TokenEconomizerTrialReport,
} from "../lib/token_economizer_trial_report.ts";
import {
  compareAgainst,
  decideTokenEconomizerVerdict,
  formatTokenEconomizerVerdict,
  isTokenEconomizerStopRule,
  type TokenEconomizerVerdict,
} from "../lib/token_economizer_verdict.ts";

const START = Date.parse("2026-11-01T00:00:00Z");
const DAY = 86_400_000;
const NOW = new Date("2026-11-20T00:00:00Z");

// A pull request number of 900 to 999 (modulo 1000) is closed; others merge.
const lookup: PrStateLookup = (_repo, pr) =>
  Promise.resolve(pr % 1000 >= 900 ? "closed" : "merged");

interface Population {
  /** Completed runs. */
  n: number;
  /** Cost of each completed run, in dollars. */
  cost: number;
  /** How many of the completed runs raised a closed pull request. */
  closed?: number;
  /** Extra failed runs, at no cost and with no pull request. */
  failed?: number;
}

interface Scenario {
  days?: number;
  on: Population;
  control?: Population;
  before?: Population;
  extra?: unknown[];
}

function runs(
  p: Population,
  base: number,
  make: (
    i: number,
    result: "success" | "failure",
    pr: number | undefined,
  ) => Record<string, unknown>,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < p.n; i++) {
    const pr = base + ((i < (p.closed ?? 0)) ? 900 + i : i + 1);
    out.push(make(i, "success", pr));
  }
  for (let i = 0; i < (p.failed ?? 0); i++) {
    out.push(make(p.n + i, "failure", undefined));
  }
  return out;
}

function record(
  host: string,
  finishedAt: string,
  result: "success" | "failure",
  pr: number | undefined,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    host,
    repository: "org/a",
    result,
    finishedAt,
    mode: "work-on",
    provider: "claude",
    rtk: { enabled: false, status: "off" },
    ...(pr === undefined ? {} : { outcome: { prNumber: pr } }),
    ...extra,
  };
}

const IN_WINDOW = "2026-11-01T12:00:00Z";
const IN_BEFORE = "2026-10-20T12:00:00Z";

function report(s: Scenario): Promise<TokenEconomizerTrialReport> {
  const records: unknown[] = [
    ...runs(
      s.on,
      0,
      (_i, result, pr) =>
        record("trial", IN_WINDOW, result, pr, {
          tokenEconomizer: {
            enabled: true,
            status: "on",
            persistence: "available",
            runCostUsd: result === "success" ? s.on.cost : 0,
          },
        }),
    ),
    ...(s.control === undefined ? [] : runs(
      s.control,
      10_000,
      (_i, result, pr) =>
        record("other", IN_WINDOW, result, pr, {
          telemetry: {
            estimatedCostUsd: result === "success" ? s.control!.cost : 0,
          },
        }),
    )),
    ...(s.before === undefined ? [] : runs(
      s.before,
      20_000,
      (_i, result, pr) =>
        record("trial", IN_BEFORE, result, pr, {
          telemetry: {
            estimatedCostUsd: result === "success" ? s.before!.cost : 0,
          },
        }),
    )),
    ...(s.extra ?? []),
  ];
  return buildTokenEconomizerTrialReport(
    records,
    {
      trialHost: "trial",
      windowStart: "2026-11-01T00:00:00Z",
      windowEnd: new Date(START + (s.days ?? 10) * DAY).toISOString(),
      recordedSince: "2026-10-01T00:00:00Z",
    },
    lookup,
  );
}

async function decide(
  s: Scenario,
  stopRule?: "secret-in-learnings",
): Promise<TokenEconomizerVerdict> {
  return decideTokenEconomizerVerdict(await report(s), {
    now: NOW,
    stopRule,
  });
}

Deno.test("keep: concurrent comparison meets the bar", async () => {
  const v = await decide({
    on: { n: 60, cost: 80 },
    control: { n: 60, cost: 100 },
    before: { n: 60, cost: 100 },
  });
  assertEquals(v.kind, "keep");
  assert(v.kind === "keep");
  assertEquals(v.disagreement, false);
  assertEquals(v.concurrent, {
    cost: "pass",
    success: "pass",
    merge: "pass",
    costPercent: -20,
    outcome: "pass",
  });
});

Deno.test("purge: only 5% cheaper misses the cost clause", async () => {
  const v = await decide({
    on: { n: 60, cost: 95 },
    control: { n: 60, cost: 100 },
    before: { n: 60, cost: 100 },
  });
  assertEquals(v.kind, "purge");
  assert(v.kind === "purge");
  assertEquals(v.concurrent.cost, "miss");
  assertEquals(v.concurrent.success, "pass");
  assertEquals(
    v.reason,
    "the concurrent comparison misses the bar on cost",
  );
});

Deno.test("boundary: exactly 10% cheaper is a keep", async () => {
  const v = await decide({
    on: { n: 60, cost: 90 },
    control: { n: 60, cost: 100 },
    before: { n: 60, cost: 100 },
  });
  assertEquals(v.kind, "keep");
  assert(v.kind === "keep");
  assertEquals(v.concurrent.costPercent, -10);
});

Deno.test("purge on a merge or success miss while cost passes", async () => {
  const merge = await decide({
    on: { n: 60, cost: 80, closed: 10 },
    control: { n: 60, cost: 100 },
  });
  assert(merge.kind === "purge");
  assertEquals(merge.concurrent.cost, "pass");
  assertEquals(merge.concurrent.merge, "miss");
  assertEquals(merge.concurrent.success, "pass");
  assertEquals(
    merge.reason,
    "the concurrent comparison misses the bar on merge rate",
  );

  const success = await decide({
    on: { n: 60, cost: 80, failed: 5 },
    control: { n: 60, cost: 100 },
  });
  assert(success.kind === "purge");
  assertEquals(success.concurrent.cost, "pass");
  assertEquals(success.concurrent.success, "miss");
  assertEquals(success.concurrent.merge, "pass");
  assertEquals(
    success.reason,
    "the concurrent comparison misses the bar on success rate",
  );
});

Deno.test("disagreement: before misses, concurrent passes, concurrent decides", async () => {
  const v = await decide({
    on: { n: 60, cost: 90 },
    control: { n: 60, cost: 100 },
    before: { n: 60, cost: 90 },
  });
  assert(v.kind === "keep");
  assertEquals(v.before.cost, "miss");
  assertEquals(v.before.outcome, "miss");
  assertEquals(v.concurrent.outcome, "pass");
  assertEquals(v.disagreement, true);
});

Deno.test("not due: too few completed runs or too few days", async () => {
  const fewRuns = await decide({ days: 8, on: { n: 59, cost: 80 } });
  assertEquals(fewRuns, {
    kind: "not-due",
    reason:
      "the window is 8.0 of 7 days old and has 59 of 60 completed switched-on runs",
    nextCheck: "2026-11-21T00:00:00.000Z",
    elapsedDays: 8,
    completedRuns: 59,
  });

  const fewDays = await decide({ days: 6, on: { n: 70, cost: 80 } });
  assertEquals(fewDays, {
    kind: "not-due",
    reason:
      "the window is 6.0 of 7 days old and has 70 of 60 completed switched-on runs",
    nextCheck: "2026-11-21T00:00:00.000Z",
    elapsedDays: 6,
    completedRuns: 70,
  });

  const slow = await decide({ days: 3, on: { n: 12, cost: 80 } });
  assertEquals(slow, {
    kind: "not-due",
    reason:
      "the window is 3.0 of 7 days old and has 12 of 60 completed switched-on runs",
    nextCheck: "2026-11-27T00:00:00.000Z",
    elapsedDays: 3,
    completedRuns: 12,
  });
});

Deno.test("stopped overrides the window, by option and by a stopped record", async () => {
  const small: Scenario = { days: 1, on: { n: 2, cost: 80 } };
  // Positive control: without a stop the same fixture is not due.
  assertEquals((await decide(small)).kind, "not-due");

  assertEquals(await decide(small, "secret-in-learnings"), {
    kind: "stopped",
    reason: "stop rule secret-in-learnings was reported",
  });

  const viaRecord = await decide({
    ...small,
    extra: [
      record("trial", IN_WINDOW, "failure", undefined, {
        telemetry: { estimatedCostUsd: 1 },
        tokenEconomizer: {
          enabled: true,
          status: "stopped",
          pluginCostUsd: 0,
          persistence: "unavailable",
        },
      }),
    ],
  });
  assertEquals(viaRecord, {
    kind: "stopped",
    reason: "1 switched-on run(s) recorded the plugin status stopped",
  });
});

Deno.test("undetermined while the concurrent comparison is unavailable, purge after day 28", async () => {
  const waiting = await decide({
    days: 10,
    on: { n: 60, cost: 80 },
    before: { n: 60, cost: 100 },
  });
  assert(waiting.kind === "undetermined");
  assertEquals(waiting.nextCheck, "2026-11-27T00:00:00.000Z");
  assertEquals(waiting.concurrent.outcome, "unavailable");
  assertEquals(waiting.before.outcome, "pass");

  const late = await decide({
    days: 28,
    on: { n: 60, cost: 80 },
    before: { n: 60, cost: 100 },
  });
  assert(late.kind === "purge");
  assertEquals(
    late.reason,
    "missing data is not a successful trial: cost, success rate, merge rate unavailable on the concurrent comparison after 28.0 days",
  );
  assertEquals(late.disagreement, true);
});

Deno.test("compareAgainst treats a miss as a miss even beside unavailable clauses", async () => {
  const r = await report({
    on: { n: 60, cost: 95 },
    control: { n: 60, cost: 100 },
  });
  const v = compareAgainst(r.switchedOn, r.before, r.beforeDifference);
  assertEquals(v, {
    cost: "unavailable",
    success: "unavailable",
    merge: "unavailable",
    outcome: "unavailable",
  });
  assertEquals(
    compareAgainst(r.concurrentOn, r.concurrent, r.concurrentDifference)
      .outcome,
    "miss",
  );
});

Deno.test("isTokenEconomizerStopRule accepts the four rules only", () => {
  assert(isTokenEconomizerStopRule("cross-repo-fact"));
  assert(isTokenEconomizerStopRule("unreadable-stop-record"));
  assert(!isTokenEconomizerStopRule("bogus"));
  assert(!isTokenEconomizerStopRule(undefined));
});

Deno.test("formatted verdicts carry the bold line, next check and disagreement", async () => {
  const keep = formatTokenEconomizerVerdict(
    await decide({
      on: { n: 60, cost: 90 },
      control: { n: 60, cost: 100 },
      before: { n: 60, cost: 90 },
    }),
  );
  assert(keep.startsWith("## TokenEconomizer trial verdict"));
  assertStringIncludes(keep, "**Verdict: keep.**");
  assertStringIncludes(keep, "| Clause | Concurrent (decides) | Before |");
  assertStringIncludes(
    keep,
    "| Cost (≥ 10% lower) | pass (-10.0%) | miss (+0.0%) |",
  );
  assertStringIncludes(
    keep,
    "The before and concurrent comparisons disagree; the concurrent comparison decides.",
  );
  assertStringIncludes(keep, "the advisor/executor split, other trial windows");

  const purge = formatTokenEconomizerVerdict(
    await decide({
      on: { n: 60, cost: 95 },
      control: { n: 60, cost: 100 },
      before: { n: 60, cost: 100 },
    }),
  );
  assertStringIncludes(purge, "**Verdict: purge.**");
  assertStringIncludes(
    purge,
    "| Cost (≥ 10% lower) | miss (-5.0%) | miss (-5.0%) |",
  );
  assert(!purge.includes("disagree"));

  const notDue = formatTokenEconomizerVerdict(
    await decide({ days: 8, on: { n: 59, cost: 80 } }),
  );
  assertStringIncludes(notDue, "**Verdict: not due.**");
  assertStringIncludes(notDue, "Next check: 2026-11-21T00:00:00.000Z.");
  assertStringIncludes(notDue, "the provider that served a control run");

  const stopped = formatTokenEconomizerVerdict(
    await decide({ days: 1, on: { n: 2, cost: 80 } }, "secret-in-learnings"),
  );
  assertStringIncludes(stopped, "**Verdict: stopped (failed).**");
  assertStringIncludes(stopped, "section 8 purge");
  assert(!stopped.includes("Next check"));

  const undetermined = formatTokenEconomizerVerdict(
    await decide({ on: { n: 60, cost: 80 } }),
  );
  assertStringIncludes(undetermined, "**Verdict: undetermined.**");
  assertStringIncludes(undetermined, "after day 28 of the window");
  assertStringIncludes(undetermined, "Next check: 2026-11-27T00:00:00.000Z.");
});
