/**
 * Tests for the idle-task cadence compliance report (Issue #4012).
 *
 * The cadence floor is best-effort — the filer's bias never preempts queued
 * `work-on` work — so a miss is only acceptable if it is visible. These tests
 * pin the behaviour named in the issue's Failure Detection section:
 *
 *   1. an all-fresh fleet reports `ok` for every pair and zero misses;
 *   2. a weekly miss, a monthly miss and a never-run pair each get their own
 *      verdict, and the fleet counts follow;
 *   3. an unreadable repo reports `unknown`, is listed, and is excluded from
 *      every met/missed count;
 *   4. a pre-stamp wrapper (no tier recorded) satisfies the weekly floor but
 *      never the monthly one, and the report says which;
 *   5. exactly 7.0 / 30.0 days old is a miss (inclusive boundary, matching
 *      `computeDueScans`);
 *   6. the `--json` payload and the `[idle-task-cadence] …` log line keep the
 *      shape downstream scraping depends on; and
 *   7. `--cadence` performs zero mutating `gh` calls.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildCadenceComplianceReport,
  type CadenceComplianceReport,
  cadenceLogLines,
  type CadencePairCompliance,
  formatCadenceComplianceReport,
} from "../lib/idle_task_cadence_report.ts";
import {
  type CadencePolicy,
  DEFAULT_CADENCE_POLICY,
  IMPORTANT_TEMPLATE_NAMES,
  NEVER_RUN_OVERDUE_DAYS,
} from "../lib/idle_task_cadence.ts";
import type { IdleTaskFreshnessEntry } from "../lib/idle_task_freshness.ts";
import {
  idleTaskFreshnessCommand,
  type IdleTaskFreshnessCommandData,
} from "../commands/idle_task_freshness.ts";
import { appendIdleTaskAttribution } from "../lib/idle_task_attribution.ts";
import type { WorkerConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-11T00:00:00Z");
const IMPORTANT = IMPORTANT_TEMPLATE_NAMES[0]!;
const BUSY_WORK = "dead-code";

/** ISO timestamp `days` before {@link NOW}. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * A freshness entry as the collector would produce it. `sonnetDaysAgo` /
 * `fableDaysAgo` populate the per-tier history; omitting both leaves a
 * pre-stamp (unstamped) wrapper.
 */
function entry(opts: {
  repo: string;
  template?: string;
  lastRunDaysAgo?: number | null;
  lastRunModel?: string | null;
  sonnetDaysAgo?: number;
  fableDaysAgo?: number;
  status?: IdleTaskFreshnessEntry["status"];
}): IdleTaskFreshnessEntry {
  const byModel: Record<string, string> = {};
  if (opts.sonnetDaysAgo !== undefined) {
    byModel["sonnet"] = daysAgo(opts.sonnetDaysAgo);
  }
  if (opts.fableDaysAgo !== undefined) {
    byModel["fable"] = daysAgo(opts.fableDaysAgo);
  }
  const lastRunAt = opts.lastRunDaysAgo === undefined ||
      opts.lastRunDaysAgo === null
    ? null
    : daysAgo(opts.lastRunDaysAgo);

  return {
    repo: opts.repo,
    template: opts.template ?? IMPORTANT,
    lastRunAt,
    ageDays: opts.lastRunDaysAgo ?? null,
    issueNumber: lastRunAt === null ? null : 1,
    outcome: lastRunAt === null ? null : "no-op",
    status: opts.status ??
      (lastRunAt === null ? "never-run" : "fresh"),
    lastRunModel: opts.lastRunModel ?? null,
    lastRunAtByModel: byModel,
  };
}

function pairFor(
  report: CadenceComplianceReport,
  repo: string,
  template = IMPORTANT,
): CadencePairCompliance {
  const found = report.pairs.find((p) =>
    p.repo === repo && p.template === template
  );
  assert(found !== undefined, `no pair for ${repo} / ${template}`);
  return found as CadencePairCompliance;
}

function configWith(repos: string[]): WorkerConfig {
  return {
    repos,
    idleTaskCadence: DEFAULT_CADENCE_POLICY,
  } as unknown as WorkerConfig;
}

// ---------------------------------------------------------------------------
// Per-pair verdicts
// ---------------------------------------------------------------------------

Deno.test("cadence compliance - an all-fresh fleet reports ok with zero misses", () => {
  const entries = ["owner/a", "owner/b"].flatMap((repo) =>
    IMPORTANT_TEMPLATE_NAMES.map((template) =>
      entry({
        repo,
        template,
        lastRunDaysAgo: 2,
        lastRunModel: "sonnet",
        sonnetDaysAgo: 2,
        fableDaysAgo: 9,
      })
    )
  );

  const report = buildCadenceComplianceReport(entries, NOW);

  assertEquals(report.summary.pairs, 6);
  assertEquals(report.summary.weeklyMet, 6);
  assertEquals(report.summary.weeklyMissed, 0);
  assertEquals(report.summary.monthlyMet, 6);
  assertEquals(report.summary.monthlyMissed, 0);
  assertEquals(report.summary.worstOffenders, []);
  for (const pair of report.pairs) assertEquals(pair.verdict, "ok");
});

Deno.test("cadence compliance - a lapsed weekly window is weekly-missed", () => {
  const report = buildCadenceComplianceReport([
    entry({
      repo: "owner/a",
      lastRunDaysAgo: 9,
      lastRunModel: "fable",
      fableDaysAgo: 9,
    }),
  ], NOW);

  const pair = pairFor(report, "owner/a");
  assertEquals(pair.weekly, "missed");
  assertEquals(pair.monthly, "met");
  assertEquals(pair.verdict, "weekly-missed");
  assertEquals(pair.weeklyOverdueDays, 2);
  assertEquals(pair.monthlyOverdueDays, 0);
  assertEquals(report.summary.weeklyMissed, 1);
  assertEquals(report.summary.monthlyMet, 1);
});

Deno.test("cadence compliance - a lapsed monthly window is monthly-missed even when the week is met", () => {
  const report = buildCadenceComplianceReport([
    entry({
      repo: "owner/a",
      lastRunDaysAgo: 1,
      lastRunModel: "sonnet",
      sonnetDaysAgo: 1,
      fableDaysAgo: 40,
    }),
  ], NOW);

  const pair = pairFor(report, "owner/a");
  assertEquals(pair.weekly, "met");
  assertEquals(pair.monthly, "missed");
  assertEquals(pair.verdict, "monthly-missed");
  assertEquals(pair.monthlyOverdueDays, 10);
  assertEquals(report.summary.monthlyMissed, 1);
  assertEquals(report.summary.weeklyMet, 1);
});

Deno.test("cadence compliance - both windows lapsed reports the monthly miss, since fable discharges both", () => {
  const report = buildCadenceComplianceReport([
    entry({
      repo: "owner/a",
      lastRunDaysAgo: 45,
      lastRunModel: "fable",
      fableDaysAgo: 45,
    }),
  ], NOW);

  const pair = pairFor(report, "owner/a");
  assertEquals(pair.weekly, "missed");
  assertEquals(pair.monthly, "missed");
  assertEquals(pair.verdict, "monthly-missed");
});

Deno.test("cadence compliance - a pair with no history at all is never-run, not merely missed", () => {
  const report = buildCadenceComplianceReport([
    entry({ repo: "owner/a", lastRunDaysAgo: null }),
  ], NOW);

  const pair = pairFor(report, "owner/a");
  assertEquals(pair.verdict, "never-run");
  assertEquals(pair.weekly, "missed");
  assertEquals(pair.monthly, "missed");
  assertEquals(pair.lastRunDays, null);
  assertEquals(pair.weeklyOverdueDays, NEVER_RUN_OVERDUE_DAYS);
  assertEquals(report.summary.neverRun, 1);
});

Deno.test("cadence compliance - an unreadable repo is listed as unknown and excluded from every count", () => {
  const report = buildCadenceComplianceReport([
    entry({
      repo: "owner/fresh",
      lastRunDaysAgo: 1,
      lastRunModel: "sonnet",
      fableDaysAgo: 3,
    }),
    entry({ repo: "owner/broken", lastRunDaysAgo: null, status: "unknown" }),
  ], NOW);

  const pair = pairFor(report, "owner/broken");
  assertEquals(pair.verdict, "unknown");
  assertEquals(pair.weekly, "unknown");
  assertEquals(pair.monthly, "unknown");
  assertEquals(pair.weeklyOverdueDays, null);

  // Listed, so the gap is visible — but never counted as met or missed.
  assertEquals(report.summary.pairs, 2);
  assertEquals(report.summary.unknown, 1);
  assertEquals(report.summary.weeklyMet + report.summary.weeklyMissed, 1);
  assertEquals(report.summary.monthlyMet + report.summary.monthlyMissed, 1);
  assert(
    report.caveats.some((c) => c.includes("excluded from every met/missed")),
    "the unknown-exclusion caveat must be stated",
  );
});

Deno.test("cadence compliance - a pre-stamp wrapper satisfies the week but never the month", () => {
  const report = buildCadenceComplianceReport([
    // Ran two days ago, but the wrapper predates the tier stamp (#4007), so it
    // appears under no key in lastRunAtByModel.
    entry({ repo: "owner/a", lastRunDaysAgo: 2, lastRunModel: null }),
  ], NOW);

  const pair = pairFor(report, "owner/a");
  assertEquals(pair.weekly, "met");
  assertEquals(pair.monthly, "missed");
  assertEquals(pair.lastMonthlyTierDays, null);
  assertEquals(pair.monthlyOverdueDays, NEVER_RUN_OVERDUE_DAYS);
  assertEquals(pair.weeklyMetByUnstampedWrapper, true);
  assertEquals(pair.verdict, "monthly-missed");

  // The report must say the tier is unknown rather than assume one.
  assertStringIncludes(cadenceLogLines(report)[0]!, "weekly_tier=unstamped");
});

Deno.test("cadence compliance - exactly 7 and 30 days old are misses (inclusive boundary)", () => {
  const report = buildCadenceComplianceReport([
    entry({
      repo: "owner/boundary",
      lastRunDaysAgo: 7,
      lastRunModel: "fable",
      fableDaysAgo: 30,
    }),
    entry({
      repo: "owner/inside",
      lastRunDaysAgo: 6.99,
      lastRunModel: "fable",
      fableDaysAgo: 29.99,
    }),
  ], NOW);

  const boundary = pairFor(report, "owner/boundary");
  assertEquals(boundary.weekly, "missed");
  assertEquals(boundary.monthly, "missed");

  const inside = pairFor(report, "owner/inside");
  assertEquals(inside.weekly, "met");
  assertEquals(inside.monthly, "met");
});

Deno.test("cadence compliance - busy-work templates carry no floor and are absent", () => {
  const report = buildCadenceComplianceReport([
    entry({ repo: "owner/a", template: BUSY_WORK, lastRunDaysAgo: 400 }),
    entry({ repo: "owner/a", lastRunDaysAgo: 1, fableDaysAgo: 1 }),
  ], NOW);

  assertEquals(report.summary.pairs, 1);
  assertEquals(report.pairs[0]?.template, IMPORTANT);
});

Deno.test("cadence compliance - honours the operator's configured windows and tiers", () => {
  const policy: CadencePolicy = {
    enabled: false,
    weeklyDays: 3,
    monthlyDays: 10,
    templates: {
      [IMPORTANT]: { weeklyModel: "haiku", monthlyModel: "opus" },
    },
  };

  const report = buildCadenceComplianceReport(
    [
      {
        ...entry({ repo: "owner/a", lastRunDaysAgo: 4, lastRunModel: "haiku" }),
        lastRunAtByModel: { opus: daysAgo(4) },
      },
    ],
    NOW,
    policy,
  );

  const pair = pairFor(report, "owner/a");
  assertEquals(pair.weeklyModel, "haiku");
  assertEquals(pair.monthlyModel, "opus");
  // 4 days old: past the 3-day weekly floor, inside the 10-day monthly one.
  assertEquals(pair.weekly, "missed");
  assertEquals(pair.monthly, "met");
  assert(
    report.caveats.some((c) => c.includes("cadence bias is disabled")),
    "a disabled kill switch must be stated, not silently read as compliance",
  );
});

Deno.test("cadence compliance - worst offenders are sorted most overdue first", () => {
  const report = buildCadenceComplianceReport([
    entry({ repo: "owner/mild", lastRunDaysAgo: 8, fableDaysAgo: 8 }),
    entry({ repo: "owner/bad", lastRunDaysAgo: 20, fableDaysAgo: 45 }),
    entry({ repo: "owner/fine", lastRunDaysAgo: 1, fableDaysAgo: 1 }),
  ], NOW);

  assertEquals(
    report.summary.worstOffenders.map((p) => p.repo),
    ["owner/bad", "owner/mild"],
  );
  assertEquals(report.summary.worstOffendersOmitted, 0);
});

Deno.test("cadence compliance - an unparseable timestamp fails loud rather than reading as fresh", () => {
  let threw = false;
  try {
    buildCadenceComplianceReport([
      { ...entry({ repo: "owner/a", lastRunDaysAgo: 1 }), lastRunAt: "later" },
    ], NOW);
  } catch {
    threw = true;
  }
  assert(threw, "a malformed timestamp must throw, not report compliance");
});

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

Deno.test("cadenceLogLines - keeps the documented scraping format", () => {
  const report = buildCadenceComplianceReport([
    entry({
      repo: "owner/a",
      lastRunDaysAgo: 2.5,
      lastRunModel: "sonnet",
      sonnetDaysAgo: 2.5,
      fableDaysAgo: 40.2,
    }),
  ], NOW);

  assertEquals(
    cadenceLogLines(report)[0],
    `[idle-task-cadence] repo=owner/a template=${IMPORTANT} weekly=met ` +
      `monthly=missed last_sonnet_days=2 last_fable_days=40 ` +
      `weekly_tier=sonnet`,
  );
});

Deno.test("cadenceLogLines - a never-run pair reports no reading on either clock", () => {
  const report = buildCadenceComplianceReport([
    entry({ repo: "owner/a", lastRunDaysAgo: null }),
  ], NOW);

  assertEquals(
    cadenceLogLines(report)[0],
    `[idle-task-cadence] repo=owner/a template=${IMPORTANT} weekly=missed ` +
      `monthly=missed last_sonnet_days=- last_fable_days=- weekly_tier=none`,
  );
});

Deno.test("formatCadenceComplianceReport - renders a row per pair, the fleet summary and the caveats", () => {
  const report = buildCadenceComplianceReport([
    entry({ repo: "owner/a", lastRunDaysAgo: 2, fableDaysAgo: 2 }),
    entry({ repo: "owner/b", lastRunDaysAgo: null }),
  ], NOW);

  const text = formatCadenceComplianceReport(report);
  assertStringIncludes(text, "Idle-task cadence compliance");
  assertStringIncludes(text, "owner/a");
  assertStringIncludes(text, "owner/b");
  assertStringIncludes(text, "never-run");
  assertStringIncludes(text, "Weekly: 1 met, 1 missed, 0 unknown");
  assertStringIncludes(text, "Monthly: 1 met, 1 missed, 0 unknown");
  assertStringIncludes(text, "Worst offenders");
  // The tier-stamp dependency must always be stated, so a missing-dependency
  // state is never mistaken for compliance.
  assertStringIncludes(text, "Issue #4007");
  assertStringIncludes(text, "[idle-task-cadence] repo=owner/a");
});

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

Deno.test("idle-task-freshness --cadence - prints per-pair compliance and a fleet summary", async () => {
  const result = await idleTaskFreshnessCommand.execute({
    cadence: true,
    __testDeps: {
      nowFn: () => NOW,
      fetchHistoryFn: () => Promise.resolve([]),
      fetchCloseSummaryFn: () => Promise.resolve(null),
    },
  }, configWith(["owner/a"]));

  assertEquals(result.success, true);
  // The plain staleness rows survive — busy-work templates keep their report.
  assertStringIncludes(result.message, "Idle-task scan freshness");
  assertStringIncludes(result.message, "Idle-task cadence compliance");
  assertStringIncludes(result.message, `[idle-task-cadence] repo=owner/a`);

  const data = result.data as IdleTaskFreshnessCommandData;
  assertEquals(data.cadence.summary.pairs, IMPORTANT_TEMPLATE_NAMES.length);
  assertEquals(data.cadence.summary.neverRun, IMPORTANT_TEMPLATE_NAMES.length);
});

Deno.test("idle-task-freshness --json - carries the cadence section structurally", async () => {
  const result = await idleTaskFreshnessCommand.execute({
    json: true,
    __testDeps: {
      nowFn: () => NOW,
      fetchHistoryFn: () => Promise.resolve([]),
      fetchCloseSummaryFn: () => Promise.resolve(null),
    },
  }, configWith(["owner/a"]));

  const parsed = JSON.parse(result.message) as {
    entries: unknown[];
    cadence: CadenceComplianceReport;
  };

  assert(parsed.entries.length > parsed.cadence.pairs.length);
  assertEquals(parsed.cadence.weeklyDays, 7);
  assertEquals(parsed.cadence.monthlyDays, 30);
  assert(parsed.cadence.caveats.length > 0);
  for (const pair of parsed.cadence.pairs) {
    // The fields downstream scraping depends on survive the JSON round trip.
    assertEquals(typeof pair.weekly, "string");
    assertEquals(typeof pair.monthly, "string");
    assertEquals(typeof pair.verdict, "string");
    assert("lastRunDays" in pair);
    assert("lastMonthlyTierDays" in pair);
    // A finite sentinel, so "never run on this clock" survives JSON.
    assertEquals(pair.monthlyOverdueDays, NEVER_RUN_OVERDUE_DAYS);
  }
});

Deno.test("idle-task-freshness --cadence - performs zero mutating gh calls", async () => {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(JSON.stringify([{
        number: 7,
        title: "Run a security scan",
        body: appendIdleTaskAttribution("Body.", {
          template: IMPORTANT,
          runId: "vibe-1-2",
          model: "sonnet",
        }),
        closedAt: daysAgo(3),
      }]));
    }
    return Promise.resolve(JSON.stringify({
      comments: [{ body: "no findings" }],
    }));
  };

  const result = await idleTaskFreshnessCommand.execute({
    cadence: true,
    __testDeps: { nowFn: () => NOW, ghCommandFn: gh },
  }, configWith(["owner/a"]));

  assertEquals(result.success, true);
  assert(calls.length > 0, "no gh calls were made — the test proves nothing");
  for (const args of calls) {
    const sub = args[1] ?? "";
    assert(
      !["create", "comment", "edit", "close", "reopen", "delete"].includes(sub),
      `mutating gh call: ${args.join(" ")}`,
    );
    for (const flag of ["-X", "--method", "-f", "--field", "--raw-field"]) {
      assert(!args.includes(flag), `write-shaped gh call: ${args.join(" ")}`);
    }
  }
});
