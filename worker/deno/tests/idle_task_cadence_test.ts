/**
 * Tests for the idle-task cadence policy (Issues #4003, #4008).
 *
 * The policy module decides which (repo, template) pairs are **overdue** for a
 * guaranteed scan and at which model tier. These cases pin the behaviour named
 * in the issue's Failure Detection section:
 *
 *   1. classification — exactly three important templates, busy work never
 *      appears in the output however stale it is;
 *   2. the rolling windows — fresh pairs are absent, an 8-day-stale pair is due
 *      at `sonnet`, a 31-day-since-fable pair is due at `fable`;
 *   3. tier dedup — a pair overdue on both windows yields exactly one entry, at
 *      `fable` (the expensive tier discharges both obligations);
 *   4. boundary — exactly 7.0 / 30.0 days counts as due (`>=`);
 *   5. `never-run` is due and sorts first; `unknown` yields nothing (fail-open);
 *   6. a pre-stamp (tierless) wrapper satisfies the week but not the month; and
 *   7. the module is pure — no I/O imports, no `Deno.Command`.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CadencePolicy,
  computeDueScans,
  DEFAULT_CADENCE_POLICY,
  IMPORTANT_TEMPLATE_NAMES,
  isImportantTemplate,
  MONTHLY_WINDOW_DAYS,
  NEVER_RUN_OVERDUE_DAYS,
  WEEKLY_WINDOW_DAYS,
} from "../lib/idle_task_cadence.ts";
import type { IdleTaskFreshnessEntry } from "../lib/idle_task_freshness.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-11T00:00:00Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** ISO timestamp `days` before {@link NOW}, fractional days allowed. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();
}

/**
 * Build a freshness entry with the shape the freshness module emits.
 *
 * `lastRunDaysAgo` drives the overall (any-tier) clock; `byModel` drives the
 * per-tier clock, so a caller can express "ran 3 days ago, but never on fable".
 */
function entry(opts: {
  repo?: string;
  template: string;
  lastRunDaysAgo?: number | null;
  byModel?: Record<string, number>;
  status?: IdleTaskFreshnessEntry["status"];
}): IdleTaskFreshnessEntry {
  const lastRunDaysAgo = opts.lastRunDaysAgo ?? null;
  const lastRunAt = lastRunDaysAgo === null ? null : daysAgo(lastRunDaysAgo);
  const lastRunAtByModel: Record<string, string> = {};
  for (const [model, days] of Object.entries(opts.byModel ?? {})) {
    lastRunAtByModel[model] = daysAgo(days);
  }
  const status = opts.status ??
    (lastRunAt === null
      ? "never-run"
      : lastRunDaysAgo !== null && lastRunDaysAgo >= 30
      ? "stale"
      : "fresh");
  return {
    repo: opts.repo ?? "stSoftwareAU/VibeCoder",
    template: opts.template,
    lastRunAt,
    ageDays: lastRunDaysAgo === null ? null : Math.floor(lastRunDaysAgo),
    issueNumber: lastRunAt === null ? null : 42,
    outcome: lastRunAt === null ? null : "no-op",
    status,
    lastRunModel: null,
    lastRunAtByModel,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

Deno.test("isImportantTemplate - exactly the three important templates", () => {
  assertEquals([...IMPORTANT_TEMPLATE_NAMES], [
    "security-scan",
    "supply-chain-readiness",
    "github-actions-audit",
  ]);
  for (const name of IMPORTANT_TEMPLATE_NAMES) {
    assert(isImportantTemplate(name), `${name} should be important`);
  }
  for (const busy of ["dead-code", "doc-coverage", "format-drift", ""]) {
    assertEquals(isImportantTemplate(busy), false, `${busy} is busy work`);
  }
});

Deno.test("isImportantTemplate - honours a supplied policy", () => {
  const policy: CadencePolicy = {
    ...DEFAULT_CADENCE_POLICY,
    templates: { "dead-code": { weeklyModel: "haiku", monthlyModel: "opus" } },
  };
  assertEquals(isImportantTemplate("dead-code", policy), true);
  assertEquals(isImportantTemplate("security-scan", policy), false);
});

Deno.test("computeDueScans - busy-work templates never appear, however stale", () => {
  const due = computeDueScans([
    entry({ template: "dead-code", lastRunDaysAgo: 900 }),
    entry({ template: "doc-coverage", lastRunDaysAgo: null }),
  ], NOW);
  assertEquals(due, []);
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

Deno.test("computeDueScans - a fresh pair is not due", () => {
  const due = computeDueScans([
    entry({
      template: "security-scan",
      lastRunDaysAgo: 2,
      byModel: { sonnet: 2, fable: 3 },
    }),
  ], NOW);
  assertEquals(due, []);
});

Deno.test("computeDueScans - 8 days since any scan is due at sonnet", () => {
  const due = computeDueScans([
    entry({
      template: "security-scan",
      lastRunDaysAgo: 8,
      byModel: { sonnet: 8, fable: 9 },
    }),
  ], NOW);
  assertEquals(due.length, 1);
  assertEquals(due[0]?.repo, "stSoftwareAU/VibeCoder");
  assertEquals(due[0]?.template, "security-scan");
  assertEquals(due[0]?.tier, "sonnet");
  assertEquals(due[0]?.overdueDays, 1);
});

Deno.test("computeDueScans - 31 days since fable with a fresh sonnet is due at fable only", () => {
  const due = computeDueScans([
    entry({
      template: "supply-chain-readiness",
      lastRunDaysAgo: 2,
      byModel: { sonnet: 2, fable: 31 },
    }),
  ], NOW);
  assertEquals(due.length, 1);
  assertEquals(due[0]?.tier, "fable");
  assertEquals(due[0]?.overdueDays, 1);
});

Deno.test("computeDueScans - overdue on both windows yields a single fable entry", () => {
  const due = computeDueScans([
    entry({
      template: "github-actions-audit",
      lastRunDaysAgo: 40,
      byModel: { sonnet: 40, fable: 45 },
    }),
  ], NOW);
  assertEquals(due.length, 1);
  assertEquals(due[0]?.tier, "fable");
  assertEquals(due[0]?.overdueDays, 15);
});

// ---------------------------------------------------------------------------
// Boundaries — exactly 7.0 / 30.0 days is due (`>=`)
// ---------------------------------------------------------------------------

Deno.test("computeDueScans - exactly 7.0 days old is due at sonnet", () => {
  const due = computeDueScans([
    entry({
      template: "security-scan",
      lastRunDaysAgo: WEEKLY_WINDOW_DAYS,
      byModel: { sonnet: WEEKLY_WINDOW_DAYS, fable: 8 },
    }),
  ], NOW);
  assertEquals(due.length, 1);
  assertEquals(due[0]?.tier, "sonnet");
  assertEquals(due[0]?.overdueDays, 0);
});

Deno.test("computeDueScans - just inside 7 days is not due", () => {
  const due = computeDueScans([
    entry({
      template: "security-scan",
      lastRunDaysAgo: 6.99,
      byModel: { sonnet: 6.99, fable: 8 },
    }),
  ], NOW);
  assertEquals(due, []);
});

Deno.test("computeDueScans - exactly 30.0 days since fable is due at fable", () => {
  const due = computeDueScans([
    entry({
      template: "security-scan",
      lastRunDaysAgo: 1,
      byModel: { sonnet: 1, fable: MONTHLY_WINDOW_DAYS },
    }),
  ], NOW);
  assertEquals(due.length, 1);
  assertEquals(due[0]?.tier, "fable");
  assertEquals(due[0]?.overdueDays, 0);
});

Deno.test("computeDueScans - just inside 30 days since fable is not due", () => {
  const due = computeDueScans([
    entry({
      template: "security-scan",
      lastRunDaysAgo: 1,
      byModel: { sonnet: 1, fable: 29.99 },
    }),
  ], NOW);
  assertEquals(due, []);
});

// ---------------------------------------------------------------------------
// never-run, unknown, pre-stamp wrappers
// ---------------------------------------------------------------------------

Deno.test("computeDueScans - never-run is due at fable and sorts first", () => {
  const due = computeDueScans([
    entry({
      repo: "stSoftwareAU/beta",
      template: "security-scan",
      lastRunDaysAgo: 40,
      byModel: { sonnet: 40, fable: 40 },
    }),
    entry({
      repo: "stSoftwareAU/alpha",
      template: "security-scan",
      lastRunDaysAgo: null,
    }),
  ], NOW);
  assertEquals(due.length, 2);
  assertEquals(due[0]?.repo, "stSoftwareAU/alpha");
  assertEquals(due[0]?.tier, "fable");
  assertEquals(due[0]?.overdueDays, NEVER_RUN_OVERDUE_DAYS);
  assertEquals(due[1]?.repo, "stSoftwareAU/beta");
});

Deno.test("computeDueScans - unknown freshness yields no due entry (fail-open)", () => {
  const due = computeDueScans([
    entry({
      template: "security-scan",
      lastRunDaysAgo: null,
      status: "unknown",
    }),
  ], NOW);
  assertEquals(due, []);
});

Deno.test("computeDueScans - a pre-stamp wrapper satisfies the week but not the month", () => {
  const due = computeDueScans([
    entry({ template: "security-scan", lastRunDaysAgo: 3, byModel: {} }),
  ], NOW);
  assertEquals(due.length, 1);
  assertEquals(due[0]?.tier, "fable");
  assertEquals(
    due[0]?.overdueDays,
    NEVER_RUN_OVERDUE_DAYS,
    "no fable run on record is maximally overdue on the monthly window",
  );
});

Deno.test("computeDueScans - a missing lastRunAtByModel field is treated as no tier history", () => {
  const bare = entry({ template: "security-scan", lastRunDaysAgo: 3 }) as
    & Omit<IdleTaskFreshnessEntry, "lastRunAtByModel">
    & { lastRunAtByModel?: Record<string, string> };
  delete bare.lastRunAtByModel;
  const due = computeDueScans([bare as IdleTaskFreshnessEntry], NOW);
  assertEquals(due.length, 1);
  assertEquals(due[0]?.tier, "fable");
});

// ---------------------------------------------------------------------------
// Ordering, policy overrides, and input validation
// ---------------------------------------------------------------------------

Deno.test("computeDueScans - output is sorted most-overdue first", () => {
  const due = computeDueScans([
    entry({
      repo: "stSoftwareAU/a",
      template: "security-scan",
      lastRunDaysAgo: 9,
      byModel: { sonnet: 9, fable: 9 },
    }),
    entry({
      repo: "stSoftwareAU/b",
      template: "security-scan",
      lastRunDaysAgo: 60,
      byModel: { sonnet: 60, fable: 60 },
    }),
    entry({
      repo: "stSoftwareAU/c",
      template: "security-scan",
      lastRunDaysAgo: 20,
      byModel: { sonnet: 20, fable: 20 },
    }),
  ], NOW);
  assertEquals(due.map((d) => d.repo), [
    "stSoftwareAU/b",
    "stSoftwareAU/c",
    "stSoftwareAU/a",
  ]);
  assertEquals(due.map((d) => d.tier), ["fable", "sonnet", "sonnet"]);
  assertEquals(due.map((d) => d.overdueDays), [30, 13, 2]);
});

Deno.test("computeDueScans - ties break deterministically by repo then template", () => {
  const stale = (repo: string, template: string) =>
    entry({
      repo,
      template,
      lastRunDaysAgo: 10,
      byModel: { sonnet: 10, fable: 10 },
    });
  const due = computeDueScans([
    stale("stSoftwareAU/z", "security-scan"),
    stale("stSoftwareAU/a", "supply-chain-readiness"),
    stale("stSoftwareAU/a", "github-actions-audit"),
  ], NOW);
  assertEquals(due.map((d) => `${d.repo}/${d.template}`), [
    "stSoftwareAU/a/github-actions-audit",
    "stSoftwareAU/a/supply-chain-readiness",
    "stSoftwareAU/z/security-scan",
  ]);
});

Deno.test("computeDueScans - a disabled policy produces no due scans", () => {
  const due = computeDueScans(
    [
      entry({ template: "security-scan", lastRunDaysAgo: null }),
    ],
    NOW,
    { ...DEFAULT_CADENCE_POLICY, enabled: false },
  );
  assertEquals(due, []);
});

Deno.test("computeDueScans - a custom policy drives windows and tiers", () => {
  const policy: CadencePolicy = {
    enabled: true,
    weeklyDays: 2,
    monthlyDays: 14,
    templates: { "dead-code": { weeklyModel: "haiku", monthlyModel: "opus" } },
  };
  const due = computeDueScans(
    [
      entry({
        template: "dead-code",
        lastRunDaysAgo: 3,
        byModel: { haiku: 3, opus: 5 },
      }),
      entry({ template: "security-scan", lastRunDaysAgo: 400 }),
    ],
    NOW,
    policy,
  );
  assertEquals(due.length, 1);
  assertEquals(due[0]?.template, "dead-code");
  assertEquals(due[0]?.tier, "haiku");
  assertEquals(due[0]?.overdueDays, 1);
});

Deno.test("computeDueScans - an unparseable timestamp fails loud", () => {
  const broken = entry({ template: "security-scan", lastRunDaysAgo: 3 });
  broken.lastRunAt = "not-a-date";
  let message = "";
  try {
    computeDueScans([broken], NOW);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(message, "unparseable");
  assertStringIncludes(message, "security-scan");
});

Deno.test("computeDueScans - a nonsensical window policy fails loud", () => {
  let message = "";
  try {
    computeDueScans(
      [entry({ template: "security-scan", lastRunDaysAgo: 3 })],
      NOW,
      { ...DEFAULT_CADENCE_POLICY, weeklyDays: 0 },
    );
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(message, "weeklyDays");
});

// ---------------------------------------------------------------------------
// Structural — the module stays pure (no I/O)
// ---------------------------------------------------------------------------

Deno.test("idle_task_cadence.ts imports nothing that performs I/O", async () => {
  const source = await Deno.readTextFile(
    new URL("../lib/idle_task_cadence.ts", import.meta.url),
  );
  const imports = source.match(/^import[\s\S]*?from\s+"[^"]+";$/gm) ?? [];
  assert(imports.length > 0, "expected at least the freshness type import");
  for (const statement of imports) {
    assert(
      statement.startsWith("import type"),
      `non type-only import in a pure module: ${statement}`,
    );
  }
  assertEquals(
    source.includes("Deno.Command"),
    false,
    "a pure policy module must not spawn processes",
  );
  for (const io of ["github.ts", "Deno.readTextFile", "Deno.writeTextFile"]) {
    assertEquals(source.includes(io), false, `unexpected I/O surface: ${io}`);
  }
});
