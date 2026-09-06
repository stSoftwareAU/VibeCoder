/**
 * Tests for the idle-task scan freshness report (Issue #3864).
 *
 * The report answers "when did each (repo, template) pair last actually
 * run?" from closed wrapper issues, so an operator can decide which repo
 * warrants a full sweep with data rather than a hunch. These tests pin the
 * load-bearing behaviour named in the issue's Failure Detection section:
 *
 *   1. a closed wrapper carrying an `appendIdleTaskAttribution` footer
 *      resolves to the right (repo, template, date, outcome);
 *   2. a pair with no history renders as never-run, distinct from stale;
 *   3. the ordering is strictly by staleness with never-run first;
 *   4. `--json` round-trips through `JSON.parse` and carries one entry per
 *      configured repo × registered template;
 *   5. an unreadable repo history degrades to `unknown` plus a warning
 *      rather than failing the whole report;
 *   6. the report enumerates exactly the registered template set (drift
 *      guard); and
 *   7. the command performs zero mutating `gh` calls.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { appendIdleTaskAttribution } from "../lib/idle_task_attribution.ts";
import {
  classifyScanOutcome,
  collectIdleTaskFreshness,
  formatFreshnessReport,
  type IdleTaskWrapperRecord,
  parseAttributionTemplate,
  parseWrapperHistory,
} from "../lib/idle_task_freshness.ts";
import { NEWLY_FILED_UNKNOWN_SUMMARY } from "../lib/idle_task_snapshot.ts";
import { idleTaskFreshnessCommand } from "../commands/idle_task_freshness.ts";
import { listTemplates } from "../lib/idle_task_template.ts";
import type { WorkerConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-07T00:00:00Z");
/** The fleet whose close comments these tests trust (Issue #1249). */
const FLEET_OPTIONS = { fleetAuthors: ["vibe-bot"] };

const nowFn = () => NOW;

/** Registered template names, resolved through the production registry. */
function registeredTemplateNames(): string[] {
  return listTemplates().map((t) => t.name);
}

/**
 * Build a closed wrapper record whose body carries a real attribution
 * footer — produced by `appendIdleTaskAttribution` itself, never a
 * hand-written copy, so a format change on either side fails here.
 */
function wrapperRecord(
  opts: {
    number: number;
    template: string;
    closedAt: string;
    title?: string;
    /** Model tier to stamp; omitted stamps a pre-#4007 (unstamped) footer. */
    model?: string;
  },
): IdleTaskWrapperRecord {
  return {
    number: opts.number,
    title: opts.title ?? `Run a ${opts.template} scan`,
    body: appendIdleTaskAttribution(`Scan ${opts.template}.`, {
      template: opts.template,
      runId: `vibe-run-${opts.number}`,
      ...(opts.model === undefined ? {} : { model: opts.model }),
    }),
    closedAt: opts.closedAt,
  };
}

/** Minimal config stub carrying just the repos list the command reads. */
function configWith(repos: string[]): WorkerConfig {
  return { repos } as unknown as WorkerConfig;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("parseAttributionTemplate - reads a footer built by appendIdleTaskAttribution", () => {
  const body = appendIdleTaskAttribution("Run a test audit.", {
    template: "test-audit",
    runId: "vibe-lkz3p9x-1a2b3c",
  });

  assertEquals(parseAttributionTemplate(body), "test-audit");
});

Deno.test("parseAttributionTemplate - returns null when no footer is present", () => {
  assertEquals(parseAttributionTemplate("A plain issue body."), null);
});

Deno.test("classifyScanOutcome - distinguishes findings, no-op and unknown", () => {
  assertEquals(
    classifyScanOutcome("Dead-code scan complete. Filed 3 issues: #1, #2, #3"),
    "findings",
  );
  assertEquals(classifyScanOutcome("no findings"), "no-op");
  assertEquals(classifyScanOutcome("idle-task processed"), "unknown");
  assertEquals(classifyScanOutcome(null), "unknown");
});

// Issue #1105: a scan whose snapshot lookup failed closes its wrapper with
// NEWLY_FILED_UNKNOWN_SUMMARY. The freshness report must read that as
// `unknown`, never as the clean `no-op` the old "0 findings." summary gave it.
Deno.test("classifyScanOutcome - an unknown newly-filed count is not a no-op", () => {
  assertEquals(classifyScanOutcome(NEWLY_FILED_UNKNOWN_SUMMARY), "unknown");
});

Deno.test("parseWrapperHistory - throws on a malformed payload rather than reporting an empty history", () => {
  let threw = false;
  try {
    parseWrapperHistory("not json", "owner/repo");
  } catch {
    threw = true;
  }
  assert(
    threw,
    "a malformed gh payload must fail loud, not read as no history",
  );
});

// ---------------------------------------------------------------------------
// Collection behaviour
// ---------------------------------------------------------------------------

Deno.test("collectIdleTaskFreshness - a closed wrapper resolves to template, date and outcome", async () => {
  const template = registeredTemplateNames()[0]!;

  const report = await collectIdleTaskFreshness({
    repos: ["owner/repo"],
    nowFn,
    fetchHistoryFn: () =>
      Promise.resolve([
        wrapperRecord({
          number: 42,
          template,
          closedAt: "2026-08-01T12:00:00Z",
        }),
      ]),
    fetchCloseSummaryFn: () =>
      Promise.resolve("Scan complete. Filed 2 issues: #7, #9"),
  });

  const entry = report.entries.find((e) => e.template === template);
  assert(entry, `no entry for template ${template}`);
  assertEquals(entry.repo, "owner/repo");
  assertEquals(entry.lastRunAt, "2026-08-01T12:00:00Z");
  assertEquals(entry.issueNumber, 42);
  assertEquals(entry.outcome, "findings");
  assertEquals(entry.ageDays, 5);
  assertEquals(entry.status, "fresh");
});

Deno.test("collectIdleTaskFreshness - a no-op scan is recorded distinctly from a findings scan", async () => {
  const template = registeredTemplateNames()[0]!;

  const report = await collectIdleTaskFreshness({
    repos: ["owner/repo"],
    nowFn,
    fetchHistoryFn: () =>
      Promise.resolve([
        wrapperRecord({
          number: 11,
          template,
          closedAt: "2026-08-05T00:00:00Z",
        }),
      ]),
    fetchCloseSummaryFn: () => Promise.resolve("no findings"),
  });

  const entry = report.entries.find((e) => e.template === template)!;
  assertEquals(entry.outcome, "no-op");
});

Deno.test("collectIdleTaskFreshness - the most recent wrapper wins for a pair", async () => {
  const template = registeredTemplateNames()[0]!;

  const report = await collectIdleTaskFreshness({
    repos: ["owner/repo"],
    nowFn,
    fetchHistoryFn: () =>
      Promise.resolve([
        wrapperRecord({
          number: 1,
          template,
          closedAt: "2026-01-01T00:00:00Z",
        }),
        wrapperRecord({
          number: 2,
          template,
          closedAt: "2026-07-01T00:00:00Z",
        }),
      ]),
    fetchCloseSummaryFn: () => Promise.resolve("no findings"),
  });

  const entry = report.entries.find((e) => e.template === template)!;
  assertEquals(entry.issueNumber, 2);
  assertEquals(entry.lastRunAt, "2026-07-01T00:00:00Z");
});

Deno.test("collectIdleTaskFreshness - a pair with no history is never-run, not stale", async () => {
  const names = registeredTemplateNames();
  const ran = names[0]!;
  const neverRan = names[1]!;

  const report = await collectIdleTaskFreshness({
    repos: ["owner/repo"],
    nowFn,
    staleAfterDays: 30,
    fetchHistoryFn: () =>
      Promise.resolve([
        wrapperRecord({
          number: 5,
          template: ran,
          // 100 days before NOW — comfortably stale.
          closedAt: "2026-04-29T00:00:00Z",
        }),
      ]),
    fetchCloseSummaryFn: () => Promise.resolve("no findings"),
  });

  const stale = report.entries.find((e) => e.template === ran)!;
  const never = report.entries.find((e) => e.template === neverRan)!;

  assertEquals(stale.status, "stale");
  assertEquals(never.status, "never-run");
  assertEquals(never.lastRunAt, null);
  assertEquals(never.ageDays, null);
  assertEquals(never.outcome, null);
});

Deno.test("collectIdleTaskFreshness - entries are sorted by staleness with never-run first", async () => {
  const names = registeredTemplateNames();
  const recent = names[0]!;
  const older = names[1]!;

  const report = await collectIdleTaskFreshness({
    repos: ["owner/repo"],
    nowFn,
    fetchHistoryFn: () =>
      Promise.resolve([
        wrapperRecord({
          number: 1,
          template: recent,
          closedAt: "2026-08-05T00:00:00Z",
        }),
        wrapperRecord({
          number: 2,
          template: older,
          closedAt: "2026-05-05T00:00:00Z",
        }),
      ]),
    fetchCloseSummaryFn: () => Promise.resolve("no findings"),
  });

  const neverRunCount = names.length - 2;
  const head = report.entries.slice(0, neverRunCount);
  for (const entry of head) {
    assertEquals(entry.status, "never-run");
  }

  const dated = report.entries.slice(neverRunCount);
  assertEquals(dated.map((e) => e.template), [older, recent]);

  // Strictly non-increasing staleness across the whole list.
  for (let i = 1; i < dated.length; i++) {
    const prev = dated[i - 1]!.ageDays!;
    const cur = dated[i]!.ageDays!;
    assert(prev >= cur, `entry ${i} is fresher than its predecessor`);
  }
});

Deno.test("collectIdleTaskFreshness - an unreadable repo history degrades to unknown with a warning", async () => {
  const warnings: string[] = [];

  const report = await collectIdleTaskFreshness({
    repos: ["owner/broken", "owner/fine"],
    nowFn,
    warn: (m) => warnings.push(m),
    fetchHistoryFn: (repo) => {
      if (repo === "owner/broken") {
        return Promise.reject(new Error("gh exploded"));
      }
      return Promise.resolve([]);
    },
    fetchCloseSummaryFn: () => Promise.resolve("no findings"),
  });

  const broken = report.entries.filter((e) => e.repo === "owner/broken");
  const fine = report.entries.filter((e) => e.repo === "owner/fine");

  assertEquals(broken.length, registeredTemplateNames().length);
  for (const entry of broken) {
    assertEquals(entry.status, "unknown");
  }
  // The readable repo is unaffected — one bad repo never fails the report.
  for (const entry of fine) {
    assertEquals(entry.status, "never-run");
  }

  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0]!, "owner/broken");
  assertStringIncludes(warnings[0]!, "history_read_failed");
  assertStringIncludes(warnings[0]!, "gh exploded");
});

Deno.test("collectIdleTaskFreshness - a close-summary failure degrades that pair's outcome to unknown", async () => {
  const template = registeredTemplateNames()[0]!;
  const warnings: string[] = [];

  const report = await collectIdleTaskFreshness({
    repos: ["owner/repo"],
    nowFn,
    warn: (m) => warnings.push(m),
    fetchHistoryFn: () =>
      Promise.resolve([
        wrapperRecord({
          number: 3,
          template,
          closedAt: "2026-08-06T00:00:00Z",
        }),
      ]),
    fetchCloseSummaryFn: () => Promise.reject(new Error("comments 404")),
  });

  const entry = report.entries.find((e) => e.template === template)!;
  // The date still resolves — only the outcome is unknown.
  assertEquals(entry.lastRunAt, "2026-08-06T00:00:00Z");
  assertEquals(entry.outcome, "unknown");
  assertEquals(entry.status, "fresh");
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0]!, "outcome_read_failed");
});

Deno.test("collectIdleTaskFreshness - covers every repo × registered template pair", async () => {
  const repos = ["owner/a", "owner/b", "owner/c"];
  const names = registeredTemplateNames();

  const report = await collectIdleTaskFreshness({
    repos,
    nowFn,
    fetchHistoryFn: () => Promise.resolve([]),
    fetchCloseSummaryFn: () => Promise.resolve(null),
  });

  assertEquals(report.entries.length, repos.length * names.length);
  for (const repo of repos) {
    const forRepo = report.entries.filter((e) => e.repo === repo)
      .map((e) => e.template).sort();
    assertEquals(forRepo, [...names].sort());
  }
});

// ---------------------------------------------------------------------------
// Template-registry drift guard
// ---------------------------------------------------------------------------

Deno.test("collectIdleTaskFreshness - reports exactly the templates registered under idle_task_templates/", async () => {
  const dir = new URL("../lib/idle_task_templates/", import.meta.url);
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith("_template.ts")) {
      files.push(entry.name);
    }
  }

  const report = await collectIdleTaskFreshness({
    repos: ["owner/repo"],
    nowFn,
    fetchHistoryFn: () => Promise.resolve([]),
    fetchCloseSummaryFn: () => Promise.resolve(null),
  });

  const reported = new Set(report.entries.map((e) => e.template));
  assertEquals(
    reported.size,
    files.length,
    `${files.length} template files under idle_task_templates/ but ` +
      `${reported.size} templates in the freshness report — a template was ` +
      `added without freshness coverage`,
  );
  assertEquals(reported, new Set(registeredTemplateNames()));
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

Deno.test("formatFreshnessReport - renders one row per pair plus a warning block", async () => {
  const template = registeredTemplateNames()[0]!;
  const report = await collectIdleTaskFreshness({
    repos: ["owner/repo"],
    nowFn,
    warn: () => {},
    fetchHistoryFn: () =>
      Promise.resolve([
        wrapperRecord({
          number: 8,
          template,
          closedAt: "2026-08-01T00:00:00Z",
        }),
      ]),
    fetchCloseSummaryFn: () => Promise.resolve("no findings"),
  });

  const text = formatFreshnessReport(report);
  const rows = text.split("\n").filter((l) => l.includes("owner/repo"));
  assertEquals(rows.length, registeredTemplateNames().length);
  assertStringIncludes(text, "never-run");
  assertStringIncludes(text, "2026-08-01");
  assertStringIncludes(text, template);
});

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

Deno.test("idle-task-freshness - --json output round-trips through JSON.parse", async () => {
  const names = registeredTemplateNames();
  const repos = ["owner/a", "owner/b"];

  const result = await idleTaskFreshnessCommand.execute({
    json: true,
    __testDeps: {
      nowFn,
      fetchHistoryFn: () => Promise.resolve([]),
      fetchCloseSummaryFn: () => Promise.resolve(null),
    },
  }, configWith(repos));

  assertEquals(result.success, true);
  const parsed = JSON.parse(result.message) as {
    entries: Array<{ repo: string; template: string; status: string }>;
    warnings: string[];
    staleAfterDays: number;
  };

  assertEquals(parsed.entries.length, repos.length * names.length);
  assertEquals(parsed.warnings, []);
  assertEquals(typeof parsed.staleAfterDays, "number");
  for (const entry of parsed.entries) {
    assertEquals(entry.status, "never-run");
  }
});

Deno.test("idle-task-freshness - honours a configurable stale threshold", async () => {
  const template = registeredTemplateNames()[0]!;

  const result = await idleTaskFreshnessCommand.execute({
    json: true,
    "stale-days": 3,
    __testDeps: {
      nowFn,
      fetchHistoryFn: () =>
        Promise.resolve([
          wrapperRecord({
            number: 9,
            template,
            // 5 days before NOW — fresh at 30 days, stale at 3.
            closedAt: "2026-08-02T00:00:00Z",
          }),
        ]),
      fetchCloseSummaryFn: () => Promise.resolve("no findings"),
    },
  }, configWith(["owner/repo"]));

  const parsed = JSON.parse(result.message) as {
    staleAfterDays: number;
    entries: Array<{ template: string; status: string }>;
  };
  assertEquals(parsed.staleAfterDays, 3);
  const entry = parsed.entries.find((e) => e.template === template)!;
  assertEquals(entry.status, "stale");
});

Deno.test("idle-task-freshness - fails loud when no repos are configured", async () => {
  const result = await idleTaskFreshnessCommand.execute(
    {},
    configWith([]),
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "repos");
});

Deno.test("idle-task-freshness - performs zero mutating gh calls", async () => {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(JSON.stringify([{
        number: 4,
        title: "Run a security scan",
        body: appendIdleTaskAttribution("Body.", {
          template: registeredTemplateNames()[0]!,
          runId: "vibe-1-2",
        }),
        closedAt: "2026-08-01T00:00:00Z",
      }]));
    }
    return Promise.resolve(JSON.stringify({
      comments: [{
        body: "no findings",
        author: { login: "vibe-bot" },
        createdAt: "2026-08-01T00:00:00Z",
      }],
    }));
  };

  const result = await idleTaskFreshnessCommand.execute({
    json: true,
    __testDeps: { nowFn, ghCommandFn: gh, authorOptions: FLEET_OPTIONS },
  }, configWith(["owner/repo"]));

  assertEquals(result.success, true);
  assert(calls.length > 0, "no gh calls were made — the test proves nothing");

  const mutatingVerbs = [
    "create",
    "close",
    "reopen",
    "comment",
    "edit",
    "delete",
    "transfer",
    "pin",
    "lock",
    "merge",
  ];
  for (const args of calls) {
    const sub = args[1] ?? "";
    assert(
      !mutatingVerbs.includes(sub),
      `mutating gh call: ${args.join(" ")}`,
    );
    for (const flag of ["-X", "--method", "-f", "--field", "--raw-field"]) {
      assert(
        !args.includes(flag),
        `mutating gh api call: ${args.join(" ")}`,
      );
    }
    assert(
      !args.includes("--comment"),
      `mutating gh call: ${args.join(" ")}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Per-model-tier history (Issue #4007)
// ---------------------------------------------------------------------------

Deno.test(
  "collectIdleTaskFreshness - mixed stamped and unstamped history yields per-tier timestamps",
  async () => {
    const template = registeredTemplateNames()[0]!;

    const report = await collectIdleTaskFreshness({
      repos: ["owner/repo"],
      nowFn,
      fetchHistoryFn: () =>
        Promise.resolve([
          wrapperRecord({
            number: 1,
            template,
            model: "sonnet",
            closedAt: "2026-07-20T00:00:00Z",
          }),
          wrapperRecord({
            number: 2,
            template,
            model: "fable",
            closedAt: "2026-08-06T00:00:00Z",
          }),
          // Pre-#4007 wrapper: contributes to lastRunAt but to no tier key.
          wrapperRecord({
            number: 3,
            template,
            closedAt: "2026-08-01T00:00:00Z",
          }),
        ]),
      fetchCloseSummaryFn: () => Promise.resolve("no findings"),
    });

    const entry = report.entries.find((e) => e.template === template)!;
    // Newest overall wins for the undifferentiated reading, as before.
    assertEquals(entry.lastRunAt, "2026-08-06T00:00:00Z");
    assertEquals(entry.issueNumber, 2);
    assertEquals(entry.lastRunModel, "fable");
    // One key per stamped tier; the unstamped wrapper appears under none.
    assertEquals(entry.lastRunAtByModel, {
      sonnet: "2026-07-20T00:00:00Z",
      fable: "2026-08-06T00:00:00Z",
    });
  },
);

Deno.test(
  "collectIdleTaskFreshness - an unstamped newest wrapper is not coerced to a tier",
  async () => {
    const template = registeredTemplateNames()[0]!;

    const report = await collectIdleTaskFreshness({
      repos: ["owner/repo"],
      nowFn,
      fetchHistoryFn: () =>
        Promise.resolve([
          wrapperRecord({
            number: 1,
            template,
            model: "sonnet",
            closedAt: "2026-07-20T00:00:00Z",
          }),
          wrapperRecord({
            number: 2,
            template,
            closedAt: "2026-08-06T00:00:00Z",
          }),
        ]),
      fetchCloseSummaryFn: () => Promise.resolve("no findings"),
    });

    const entry = report.entries.find((e) => e.template === template)!;
    assertEquals(entry.lastRunAt, "2026-08-06T00:00:00Z");
    // Unknown tier stays unknown — it must not satisfy a sonnet cadence floor.
    assertEquals(entry.lastRunModel, null);
    assertEquals(entry.lastRunAtByModel, { sonnet: "2026-07-20T00:00:00Z" });
  },
);

Deno.test(
  "collectIdleTaskFreshness - the newest run per tier wins, not the newest overall",
  async () => {
    const template = registeredTemplateNames()[0]!;

    const report = await collectIdleTaskFreshness({
      repos: ["owner/repo"],
      nowFn,
      fetchHistoryFn: () =>
        Promise.resolve([
          wrapperRecord({
            number: 1,
            template,
            model: "sonnet",
            closedAt: "2026-08-05T00:00:00Z",
          }),
          wrapperRecord({
            number: 2,
            template,
            model: "sonnet",
            closedAt: "2026-06-01T00:00:00Z",
          }),
        ]),
      fetchCloseSummaryFn: () => Promise.resolve("no findings"),
    });

    const entry = report.entries.find((e) => e.template === template)!;
    assertEquals(entry.lastRunAtByModel, { sonnet: "2026-08-05T00:00:00Z" });
  },
);

Deno.test(
  "collectIdleTaskFreshness - pre-stamp-only and never-run pairs carry no tier data",
  async () => {
    const names = registeredTemplateNames();
    const ran = names[0]!;
    const neverRan = names[1]!;

    const report = await collectIdleTaskFreshness({
      repos: ["owner/repo"],
      nowFn,
      fetchHistoryFn: () =>
        Promise.resolve([
          wrapperRecord({
            number: 1,
            template: ran,
            closedAt: "2026-08-01T00:00:00Z",
          }),
        ]),
      fetchCloseSummaryFn: () => Promise.resolve("no findings"),
    });

    const preStamp = report.entries.find((e) => e.template === ran)!;
    assertEquals(preStamp.lastRunAt, "2026-08-01T00:00:00Z");
    assertEquals(preStamp.lastRunModel, null);
    assertEquals(preStamp.lastRunAtByModel, {});

    const never = report.entries.find((e) => e.template === neverRan)!;
    assertEquals(never.lastRunModel, null);
    assertEquals(never.lastRunAtByModel, {});
  },
);

Deno.test(
  "collectIdleTaskFreshness - an unreadable repo reports no tier data",
  async () => {
    const report = await collectIdleTaskFreshness({
      repos: ["owner/broken"],
      nowFn,
      warn: () => {},
      fetchHistoryFn: () => Promise.reject(new Error("gh exploded")),
      fetchCloseSummaryFn: () => Promise.resolve(null),
    });

    for (const entry of report.entries) {
      assertEquals(entry.status, "unknown");
      assertEquals(entry.lastRunModel, null);
      assertEquals(entry.lastRunAtByModel, {});
    }
  },
);

Deno.test("formatFreshnessReport - shows the tier of the most recent scan", async () => {
  const template = registeredTemplateNames()[0]!;
  const report = await collectIdleTaskFreshness({
    repos: ["owner/repo"],
    nowFn,
    fetchHistoryFn: () =>
      Promise.resolve([
        wrapperRecord({
          number: 8,
          template,
          model: "fable",
          closedAt: "2026-08-01T00:00:00Z",
        }),
      ]),
    fetchCloseSummaryFn: () => Promise.resolve("no findings"),
  });

  const text = formatFreshnessReport(report);
  assertStringIncludes(text, "MODEL");
  assertStringIncludes(text, "fable");
});
