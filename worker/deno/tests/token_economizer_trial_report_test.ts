/**
 * Tests for the TokenEconomizer trial report section (Issue #4958).
 *
 * Fixture run records are hand-written and fed to the real report builder and
 * command. The command tests use temporary directories only.
 *
 * Australian English spelling used throughout.
 */

import {
  summariseTokenEconomizerRun,
  tokenEconomizerCallbackBlock,
} from "../lib/token_economizer_run_stats.ts";
import { recordTokenEconomizerStop } from "../lib/token_economizer_plugin.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildTokenEconomizerTrialReport,
  formatTokenEconomizerTrialSection,
  type PrState,
  type PrStateLookup,
  type TrialReportOptions,
} from "../lib/token_economizer_trial_report.ts";
import { createTokenEconomizerReportCommand } from "../commands/token_economizer_report.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const OPTIONS: TrialReportOptions = {
  trialHost: "trial",
  windowStart: "2026-11-08T00:00:00Z",
  windowEnd: "2026-11-15T00:00:00Z",
  recordedSince: "2026-10-30T00:00:00Z",
};

interface Spec {
  host?: string;
  repository?: string;
  result?: "success" | "failure";
  finishedAt: string;
  provider?: string | null;
  mode?: string;
  cost?: number;
  pr?: number;
  rtk?: boolean;
  absent?: string;
  block?: Record<string, unknown>;
}

function rec(spec: Spec): Record<string, unknown> {
  const record: Record<string, unknown> = {
    host: spec.host ?? "trial",
    repository: spec.repository ?? "org/a",
    result: spec.result ?? "success",
    finishedAt: spec.finishedAt,
    mode: spec.mode ?? "work-on",
    rtk: { enabled: spec.rtk ?? false, status: "off" },
  };
  if (spec.provider !== null) record.provider = spec.provider ?? "claude";
  if (spec.cost !== undefined) {
    record.telemetry = { estimatedCostUsd: spec.cost };
  }
  if (spec.absent !== undefined) record.telemetryAbsentReason = spec.absent;
  if (spec.pr !== undefined) record.outcome = { prNumber: spec.pr };
  if (spec.block !== undefined) record.tokenEconomizer = spec.block;
  return record;
}

const onBlock = (runCostUsd?: number, persistence = "unavailable") => ({
  enabled: true,
  status: "on",
  persistence,
  ...(runCostUsd === undefined ? {} : { runCostUsd }),
});

const STATES: Record<string, PrState | undefined> = {
  "org/a#1": "merged",
  "org/a#2": "closed",
  "org/solo#3": "open",
  "org/a#10": "merged",
  "org/a#20": "merged",
  "org/a#21": undefined,
};
const lookup: PrStateLookup = (repo, pr) =>
  Promise.resolve(STATES[`${repo}#${pr}`]);

function fixture(): unknown[] {
  const W = "2026-11-10T00:00:00Z";
  return [
    // Switched on: 6 runs, 5 completed, costs 1 + 3 + 2 + 1 + 1 + 2 = 10.
    rec({ finishedAt: W, cost: 99, pr: 1, block: onBlock(1, "available") }),
    rec({
      finishedAt: W,
      result: "failure",
      block: onBlock(3, "available"),
    }),
    rec({ finishedAt: W, pr: 2, block: onBlock(2) }),
    rec({ finishedAt: W, repository: "org/solo", pr: 3, block: onBlock(1) }),
    // Trial host window runs that are counted but in no comparison.
    rec({
      finishedAt: W,
      cost: 1,
      block: {
        enabled: true,
        status: "fallback",
        pluginCostUsd: 0,
        persistence: "unavailable",
      },
    }),
    rec({
      finishedAt: W,
      cost: 2,
      block: {
        enabled: true,
        status: "stopped",
        pluginCostUsd: 0,
        persistence: "unavailable",
      },
    }),
    // Before: trial host, switch off, 14 days before the window.
    rec({ finishedAt: "2026-11-01T00:00:00Z", cost: 4, pr: 10 }),
    rec({
      finishedAt: "2026-11-01T00:00:00Z",
      result: "failure",
      cost: 2,
    }),
    // Unflagged: no block and recorded before recordedSince.
    rec({ finishedAt: "2026-10-28T00:00:00Z", cost: 1 }),
    // Concurrent controls.
    rec({ finishedAt: W, host: "other", cost: 3, pr: 20 }),
    rec({ finishedAt: W, host: "other", cost: 5, pr: 21 }),
    rec({
      finishedAt: W,
      host: "other",
      repository: "org/only-other",
      cost: 1,
    }),
    // A host with a different RTK setting.
    rec({ finishedAt: W, host: "rtkhost", cost: 1, rtk: true }),
    // Non-claude and no provider.
    rec({ finishedAt: W, provider: "codex", cost: 1 }),
    rec({ finishedAt: W, host: "other", provider: null, cost: 1 }),
    // Not an implementation run.
    rec({ finishedAt: W, mode: "pr-feedback", cost: 1 }),
    // Malformed.
    { host: "x" },
    "not an object",
  ];
}

Deno.test("report computes populations and metrics for both comparisons", async () => {
  const report = await buildTokenEconomizerTrialReport(
    fixture(),
    OPTIONS,
    lookup,
  );

  const on = report.switchedOn;
  assertEquals([on.runs, on.completed, on.successRate], [6, 5, 5 / 6]);
  assert(on.cost.available);
  assertEquals(on.cost.totalUsd, 10);
  assertEquals(on.merge, {
    merged: 1,
    closed: 1,
    known: 2,
    open: 1,
    unknown: 0,
    noPr: 3,
    rate: 0.5,
  });

  assertEquals([report.before.runs, report.before.completed], [2, 1]);
  assert(report.before.cost.available);
  assertEquals(report.before.cost.perCompletedUsd, 6);
  assertEquals(report.before.merge, {
    merged: 1,
    closed: 0,
    known: 1,
    open: 0,
    unknown: 0,
    noPr: 1,
    rate: 1,
  });

  assertEquals(
    [report.concurrentOn.runs, report.concurrentOn.completed],
    [5, 4],
  );
  assert(report.concurrentOn.cost.available);
  assertEquals(report.concurrentOn.cost.perCompletedUsd, 2.25);
  assertEquals(report.concurrent.runs, 2);
  assert(report.concurrent.cost.available);
  assertEquals(report.concurrent.cost.perCompletedUsd, 4);
  assertEquals(report.concurrent.merge, {
    merged: 1,
    closed: 0,
    known: 1,
    open: 0,
    unknown: 1,
    noPr: 0,
    rate: 1,
  });
  assertEquals(report.concurrentHosts, ["other"]);

  assert(report.beforeDifference.available);
  assertEquals(
    Math.round(report.beforeDifference.percent * 10) / 10,
    -66.7,
  );
  assert(report.concurrentDifference.available);
  assertEquals(report.concurrentDifference.percent, -43.75);

  const ex = report.exclusions;
  assertEquals(ex.malformed, 2);
  assertEquals(ex.unflagged, 1);
  assertEquals(ex.nonClaude, 2);
  assertEquals(ex.otherMode, 1);
  assertEquals([ex.onRuns, ex.onPersisted], [6, 2]);
  assertEquals(ex.onByStatus, {
    on: 4,
    fallback: 1,
    stopped: 1,
    "not-run": 0,
  });
  assertEquals(ex.trialHostOff, 0);
  assertEquals(ex.trialHostRtk, "disabled");
  assertEquals(ex.rtkMismatchHosts, ["rtkhost"]);
  assertEquals(ex.rtkMismatchRecords, 1);
  assertEquals(ex.oneSidedRepositories, 2);
  assertEquals(ex.oneSidedRepositoryNames, ["org/only-other", "org/solo"]);
});

Deno.test("rendered section shows explicit populations and no verdict", async () => {
  const report = await buildTokenEconomizerTrialReport(
    fixture(),
    OPTIONS,
    lookup,
  );
  const text = formatTokenEconomizerTrialSection(report);
  assert(text.startsWith("## TokenEconomizer trial comparison"));
  assertStringIncludes(text, "| Runs | 6 | 2 |");
  assertStringIncludes(
    text,
    "| Success rate | 83.3% (5 of 6) | 50.0% (1 of 2) |",
  );
  assertStringIncludes(text, "$2.00 ($10.00 over 5 completed)");
  assertStringIncludes(
    text,
    "50.0% (1 of 2 final; 1 merged, 1 closed, 1 open, 0 unknown; 3 runs with no PR)",
  );
  assertStringIncludes(
    text,
    "100.0% (1 of 1 final; 1 merged, 0 closed, 0 open, 1 unknown; 0 runs with no PR)",
  );
  assertStringIncludes(text, "on vs before): -66.7%");
  assertStringIncludes(text, "on vs concurrent): -43.8%");
  assertStringIncludes(text, "persisted 2 of 6");
  assertStringIncludes(
    text,
    "6 runs, by status 4 on, 1 fallback, 1 stopped, 0 not-run",
  );
  assertStringIncludes(
    text,
    "no advisor/executor-split setting, so that section 5 exclusion cannot be applied",
  );
  assertStringIncludes(
    text,
    "no other-trial-window flag, so that section 5 exclusion cannot be applied",
  );
  assertStringIncludes(text, "Malformed records excluded: 2");
  assertStringIncludes(text, "(no flag, before 2026-10-30T00:00:00.000Z): 1");
  assertStringIncludes(text, "Non-claude or no-provider runs excluded: 2");
  assertStringIncludes(text, "different RTK setting: rtkhost (1 records)");
  assertStringIncludes(text, "one side only): 2 (org/only-other, org/solo)");
  assertStringIncludes(
    text,
    "This section reports figures only; the verdict section that follows applies the bar.",
  );
  for (
    const word of [
      /\bkeep\b/i,
      /\bpurge\b/i,
      /passed the bar/i,
      /\bfail(ed)?\b/i,
    ]
  ) {
    assert(!word.test(text), `unexpected verdict wording ${word}`);
  }
});

Deno.test("a run with no cost makes cost unavailable with a lower bound", async () => {
  const W = "2026-11-10T00:00:00Z";
  const report = await buildTokenEconomizerTrialReport(
    [
      rec({ finishedAt: W, block: onBlock(2) }),
      rec({ finishedAt: W, block: onBlock() }),
      rec({ finishedAt: W, result: "failure", block: onBlock(1) }),
    ],
    OPTIONS,
    lookup,
  );
  assertEquals(report.switchedOn.cost, {
    available: false,
    reason: "1 of 3 runs have no cost",
    missingCostRuns: 1,
    lowerBoundPerCompletedUsd: 1.5,
  });
  assertEquals(report.beforeDifference, {
    available: false,
    reason: "switched-on cost is unavailable",
  });
  const text = formatTokenEconomizerTrialSection(report);
  assertStringIncludes(text, "unavailable — 1 of 3 runs have no cost; ≥ $1.50");
  assertStringIncludes(text, "unavailable (switched-on cost is unavailable)");
  assertStringIncludes(text, "| Runs | 3 | 0 |");
});

Deno.test("switched-on population keeps failed and not-run attempts but not another provider's plugin-off run", async () => {
  const W = "2026-11-10T00:00:00Z";
  const report = await buildTokenEconomizerTrialReport(
    [
      rec({ finishedAt: W, block: onBlock(1, "available") }),
      rec({
        finishedAt: W,
        result: "failure",
        cost: 4,
        block: {
          enabled: true,
          status: "not-run",
          pluginCostUsd: 0,
          persistence: "unavailable",
        },
      }),
      rec({
        finishedAt: W,
        result: "failure",
        cost: 2,
        block: { enabled: true, status: "off", persistence: "unavailable" },
      }),
      // Switch off: not in the population.
      rec({
        finishedAt: W,
        cost: 9,
        block: { enabled: false, status: "off", persistence: "unavailable" },
      }),
    ],
    OPTIONS,
    lookup,
  );
  assertEquals(report.exclusions.onRuns, 2);
  assertEquals(report.exclusions.onByStatus, {
    on: 1,
    fallback: 0,
    stopped: 0,
    "not-run": 1,
  });
  assertEquals(report.exclusions.otherProviderOff, 1);
  assertEquals(report.exclusions.trialHostOff, 1);
  assertEquals(report.exclusions.onPersisted, 1);
  assert(report.switchedOn.cost.available);
  // The other provider's run (cost 2) is not summed in: 1 + 4 only.
  assertEquals(report.switchedOn.cost.totalUsd, 5);
  assertEquals(report.switchedOn.runs, 2);
  assertEquals(report.switchedOn.completed, 1);
  assertEquals(report.switchedOn.successRate, 1 / 2);
  assertEquals(report.concurrentOn.runs, 0);
  const text = formatTokenEconomizerTrialSection(report);
  assertStringIncludes(
    text,
    "Trial host runs served by another provider (plugin off; in no comparison): 1",
  );
  assertStringIncludes(text, "cannot be excluded from the archive");
});

Deno.test("run cost rule: agent_not_invoked is 0, plugin spend without a run cost is unavailable", async () => {
  const W = "2026-11-10T00:00:00Z";
  const report = await buildTokenEconomizerTrialReport(
    [
      // No agent ran: 0 even though the block has no cost.
      rec({ finishedAt: W, absent: "agent_not_invoked", block: onBlock() }),
      // Plugin recorded no spend and is not on: telemetry cost.
      rec({
        finishedAt: W,
        cost: 5,
        block: {
          enabled: true,
          status: "fallback",
          pluginCostUsd: 0,
          persistence: "unavailable",
        },
      }),
      // Plugin recorded spend but no run cost: unavailable.
      rec({
        finishedAt: W,
        cost: 6,
        block: {
          enabled: true,
          status: "stopped",
          persistence: "unavailable",
          pluginCostUsd: 0.5,
        },
      }),
      // Status on with no run cost: unavailable.
      rec({ finishedAt: W, cost: 7, block: onBlock() }),
      // Off side: agent_not_invoked is 0 as well.
      rec({
        finishedAt: "2026-11-01T00:00:00Z",
        absent: "agent_not_invoked",
      }),
      rec({ finishedAt: "2026-11-01T00:00:00Z", cost: 3 }),
    ],
    OPTIONS,
    lookup,
  );
  assertEquals(report.switchedOn.cost, {
    available: false,
    reason: "2 of 4 runs have no cost",
    missingCostRuns: 2,
    lowerBoundPerCompletedUsd: 4.5,
  });
  assert(report.before.cost.available);
  assertEquals(report.before.cost.totalUsd, 3);
  assertEquals(report.before.cost.perCompletedUsd, 1.5);
  assertStringIncludes(
    formatTokenEconomizerTrialSection(report),
    "unavailable — 2 of 4 runs have no cost; ≥ $4.50",
  );
});

Deno.test("runs with no pull request are outside the merge-rate denominator", async () => {
  const W = "2026-11-10T00:00:00Z";
  const report = await buildTokenEconomizerTrialReport(
    [
      rec({ finishedAt: W, pr: 1, block: onBlock(1) }),
      rec({ finishedAt: W, block: onBlock(1) }),
      rec({ finishedAt: W, block: onBlock(1) }),
      rec({ finishedAt: W, repository: "org/solo", pr: 3, block: onBlock(1) }),
    ],
    OPTIONS,
    lookup,
  );
  assertEquals(report.switchedOn.merge, {
    merged: 1,
    closed: 0,
    known: 1,
    open: 1,
    unknown: 0,
    noPr: 2,
    rate: 1,
  });
});

Deno.test("no completed runs makes cost unavailable, never zero", async () => {
  const report = await buildTokenEconomizerTrialReport(
    [rec({
      finishedAt: "2026-11-10T00:00:00Z",
      result: "failure",
      block: onBlock(2),
    })],
    OPTIONS,
    lookup,
  );
  assertEquals(report.switchedOn.cost, {
    available: false,
    reason: "no completed runs",
    missingCostRuns: 0,
  });
});

Deno.test("an unknown trial host RTK setting is stated, not guessed", async () => {
  const W = "2026-11-10T00:00:00Z";
  const report = await buildTokenEconomizerTrialReport(
    [
      rec({ finishedAt: W, block: onBlock(1), rtk: true }),
      rec({ finishedAt: W, block: onBlock(1), rtk: false }),
      rec({ finishedAt: W, host: "other", cost: 1, rtk: true }),
    ],
    OPTIONS,
    lookup,
  );
  assertEquals(report.exclusions.trialHostRtk, "mixed-or-unknown");
  assertEquals(report.exclusions.rtkMismatchHosts, []);
  assertStringIncludes(
    formatTokenEconomizerTrialSection(report),
    "mixed or unknown; concurrent hosts were not screened for RTK",
  );
});

Deno.test("each pull request is looked up once and a failing lookup is unknown", async () => {
  const W = "2026-11-10T00:00:00Z";
  const calls: string[] = [];
  const report = await buildTokenEconomizerTrialReport(
    [
      rec({ finishedAt: W, pr: 7, block: onBlock(1) }),
      rec({ finishedAt: W, pr: 7, block: onBlock(1) }),
    ],
    OPTIONS,
    (repo, pr) => {
      calls.push(`${repo}#${pr}`);
      return Promise.reject(new Error("offline"));
    },
  );
  assertEquals(calls, ["org/a#7"]);
  assertEquals(report.switchedOn.merge.unknown, 1);
  assertEquals(report.switchedOn.merge.rate, undefined);
});

Deno.test("windowEnd defaults to the injected clock", async () => {
  const report = await buildTokenEconomizerTrialReport(
    [],
    {
      trialHost: "trial",
      windowStart: "2026-11-08T00:00:00Z",
      recordedSince: "2026-10-30T00:00:00Z",
      now: () => new Date("2026-11-12T00:00:00Z"),
    },
    lookup,
  );
  assertEquals(report.windowEnd, "2026-11-12T00:00:00.000Z");
});

function config() {
  return buildDefaultWorkerConfig();
}

async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "te-report-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const BASE_ARGS = {
  "trial-host": "trial",
  "window-start": "2026-11-08T00:00:00Z",
  "window-end": "2026-11-15T00:00:00Z",
  "recorded-since": "2026-10-30T00:00:00Z",
};

Deno.test("command fails loud on a missing archive directory", async () => {
  await withTemp(async (dir) => {
    const command = createTokenEconomizerReportCommand({ lookup });
    const missing = `${dir}/absent`;
    const result = await command.execute(
      { ...BASE_ARGS, archive: missing },
      config(),
    );
    assertEquals(result.success, false);
    assertStringIncludes(
      result.message,
      `Archive ${missing} could not be read`,
    );
  });
});

Deno.test("command fails on an empty archive and on missing or bad options", async () => {
  await withTemp(async (dir) => {
    const command = createTokenEconomizerReportCommand({ lookup });
    const empty = await command.execute(
      { ...BASE_ARGS, archive: dir },
      config(),
    );
    assertEquals(empty.success, false);
    assertStringIncludes(empty.message, "holds no *.json run records");

    const noArchive = await command.execute(BASE_ARGS, config());
    assertEquals(noArchive.message, "Argument --archive is required.");

    const noSince = await command.execute(
      { archive: dir, "trial-host": "t", "window-start": "2026-11-08" },
      config(),
    );
    assertEquals(noSince.message, "Argument --recorded-since is required.");

    const bad = await command.execute(
      { ...BASE_ARGS, archive: dir, "window-start": "yesterday" },
      config(),
    );
    assertEquals(
      bad.message,
      "Argument --window-start must be an ISO 8601 date or time.",
    );
  });
});

Deno.test("command reads a temp archive recursively and renders the section", async () => {
  await withTemp(async (dir) => {
    await Deno.mkdir(`${dir}/2026/11`, { recursive: true });
    const records = fixture();
    await Deno.writeTextFile(
      `${dir}/2026/11/a.json`,
      JSON.stringify(records.slice(0, 5)),
    );
    await Deno.writeTextFile(
      `${dir}/b.json`,
      JSON.stringify(records[5]),
    );
    for (let i = 6; i < records.length; i++) {
      await Deno.writeTextFile(`${dir}/r${i}.json`, JSON.stringify(records[i]));
    }
    await Deno.writeTextFile(`${dir}/broken.json`, "{not json");
    await Deno.writeTextFile(`${dir}/ignored.txt`, "{}");
    await Deno.symlink(`${dir}/b.json`, `${dir}/link.json`);

    const command = createTokenEconomizerReportCommand({ lookup });
    const result = await command.execute(
      { ...BASE_ARGS, archive: dir },
      config(),
    );
    assertEquals(result.success, true);
    assert(result.message.startsWith("## TokenEconomizer trial comparison"));
    assertStringIncludes(result.message, "| Runs | 6 | 2 |");
    // Two malformed fixtures plus the unparsable file.
    assertStringIncludes(result.message, "Malformed records excluded: 3");

    const json = await command.execute(
      { ...BASE_ARGS, archive: dir, format: "json" },
      config(),
    );
    assertEquals(json.success, true);
    assertEquals(JSON.parse(json.message).switchedOn.runs, 6);
  });
});

Deno.test("command applies --stop-rule and refuses an unknown rule", async () => {
  await withTemp(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/a.json`,
      JSON.stringify(fixture().slice(0, 4)),
    );
    const command = createTokenEconomizerReportCommand({ lookup });
    const stopped = await command.execute(
      { ...BASE_ARGS, archive: dir, "stop-rule": "cross-repo-fact" },
      config(),
    );
    assertEquals(stopped.success, true);
    assertStringIncludes(stopped.message, "**Verdict: stopped (failed).**");
    const bogus = await command.execute(
      { ...BASE_ARGS, archive: dir, "stop-rule": "bogus" },
      config(),
    );
    assertEquals(bogus.success, false);
    assertEquals(
      bogus.message,
      "Argument --stop-rule must be one of secret-in-learnings, cross-repo-fact, plugin-run-failure, unreadable-stop-record.",
    );
  });
});

Deno.test("stopped corrupt accounting stays unavailable through summariser callback and report", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/home/repos/k/claude`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/home/repos/k/claude/ledger.jsonl`,
      "{broken",
    );
    await recordTokenEconomizerStop(dir, {
      rule: "plugin-run-failure",
      reason: "failed",
    });
    const stats = await summariseTokenEconomizerRun({
      enabled: true,
      eligible: true,
      workDir: dir,
      stateHomes: [`${dir}/home`],
    });
    const report = await buildTokenEconomizerTrialReport(
      [rec({
        finishedAt: "2026-11-10T00:00:00Z",
        cost: 6,
        block: { ...tokenEconomizerCallbackBlock(stats, 6) },
      })],
      OPTIONS,
      lookup,
    );
    assertEquals(report.switchedOn.cost, {
      available: false,
      reason: "1 of 1 runs have no cost",
      missingCostRuns: 1,
      lowerBoundPerCompletedUsd: 6,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("merge rate counts distinct PRs while cost and success retain every run", async () => {
  const report = await buildTokenEconomizerTrialReport(
    [1, 1, 2, 2].map((pr) =>
      rec({
        finishedAt: "2026-11-10T00:00:00Z",
        pr,
        block: onBlock(1),
      })
    ),
    OPTIONS,
    lookup,
  );
  assertEquals(report.switchedOn.runs, 4);
  assertEquals(report.switchedOn.completed, 4);
  assertEquals(report.switchedOn.merge, {
    merged: 1,
    closed: 1,
    known: 2,
    open: 0,
    unknown: 0,
    noPr: 0,
    rate: 0.5,
  });
});
