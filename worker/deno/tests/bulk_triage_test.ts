/**
 * Tests for the bulk security/supply-chain triage sweep (Issue #2403).
 *
 * The sweep walks every monitored repo, finds open issues carrying any
 * of the configured findings labels, and applies a pickup label in bulk
 * with severity + age filters. Tests pin:
 *   1. Unlabelled finding triggers an addLabel call.
 *   2. Issue already carrying the pickup label is skipped.
 *   3. Severity filter excludes non-matching issues.
 *   4. Minimum-age filter excludes too-young issues.
 *   5. Max cap stops further writes within a single run.
 *   6. Dry-run emits would_label events and never calls addLabel.
 *   7. A failing repo lookup is captured and the sweep continues.
 *   8. An issue carrying multiple findings labels is processed once.
 *   9. Custom apply-label and findings-labels work.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  ageInDays,
  type BulkTriageEvent,
  classifySeverity,
  formatBulkTriageEvent,
  formatBulkTriageSummary,
  runBulkTriage,
} from "../lib/bulk_triage.ts";
import type { Result } from "../types.ts";

interface StubLabelCall {
  repo: string;
  number: number;
  label: string;
}

function makeStubAddLabel(): {
  fn: (
    repo: string,
    issueNumber: number,
    label: string,
  ) => Promise<Result<void>>;
  calls: StubLabelCall[];
} {
  const calls: StubLabelCall[] = [];
  return {
    calls,
    fn: (repo, issueNumber, label) => {
      calls.push({ repo, number: issueNumber, label });
      return Promise.resolve({ ok: true, value: undefined });
    },
  };
}

interface IssueRow {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: string[];
}

/**
 * Build a gh stub that returns issues per `--label` query. Issues
 * appearing under multiple labels are returned once per matching
 * label, mirroring real gh behaviour, so we can prove the sweep dedups.
 */
function makeGhStub(perLabel: Record<string, IssueRow[]>): {
  fn: (args: string[]) => Promise<string>;
  queries: Array<{ repo: string; label: string }>;
} {
  const queries: Array<{ repo: string; label: string }> = [];
  return {
    queries,
    fn: (args) => {
      const repoIdx = args.indexOf("--repo");
      const labelIdx = args.indexOf("--label");
      const repo = repoIdx >= 0 ? args[repoIdx + 1] ?? "" : "";
      const label = labelIdx >= 0 ? args[labelIdx + 1] ?? "" : "";
      queries.push({ repo, label });
      const rows = perLabel[label] ?? [];
      const json = rows.map((r) => ({
        number: r.number,
        title: r.title,
        url: r.url,
        createdAt: r.createdAt,
        labels: r.labels.map((name) => ({ name })),
      }));
      return Promise.resolve(JSON.stringify(json));
    },
  };
}

const REPO = "stSoftwareAU/VibeCoder";

Deno.test("classifySeverity - returns highest severity present", () => {
  assertEquals(
    classifySeverity(["severity:high", "security"]),
    "severity:high",
  );
  assertEquals(
    classifySeverity(["security", "severity:medium"]),
    "severity:medium",
  );
  assertEquals(classifySeverity(["security"]), undefined);
});

Deno.test("ageInDays - returns whole days, clamped to 0", () => {
  const now = new Date("2026-05-29T00:00:00Z");
  assertEquals(ageInDays("2026-05-29T00:00:00Z", now), 0);
  assertEquals(ageInDays("2026-05-28T00:00:00Z", now), 1);
  assertEquals(ageInDays("2026-05-20T00:00:00Z", now), 9);
  // Future-dated rows clamp to 0 rather than going negative.
  assertEquals(ageInDays("2026-06-01T00:00:00Z", now), 0);
  // Malformed timestamps yield 0 so they cannot impersonate ancient rows.
  assertEquals(ageInDays("not-a-date", now), 0);
});

Deno.test("runBulkTriage - labels an unlabelled finding", async () => {
  const issue: IssueRow = {
    number: 101,
    title: "Finding 1",
    url: "https://github.com/x/y/issues/101",
    createdAt: "2026-05-01T00:00:00Z",
    labels: ["security", "severity:high"],
  };
  const gh = makeGhStub({ security: [issue] });
  const label = makeStubAddLabel();
  const events: BulkTriageEvent[] = [];

  const summary = await runBulkTriage({
    repos: [REPO],
    findingsLabels: ["security"],
    ghCommandFn: gh.fn,
    addLabelFn: (repo, n, l) => label.fn(repo, n, l),
    log: (e) => events.push(e),
  });

  assertEquals(summary.labelled, 1);
  assertEquals(summary.errors, 0);
  assertEquals(label.calls.length, 1);
  assertEquals(label.calls[0]?.label, "work-on");
  assertEquals(label.calls[0]?.number, 101);
  assert(events.some((e) => e.kind === "labelled"));
});

Deno.test("runBulkTriage - skips issues already carrying the pickup label", async () => {
  const issue: IssueRow = {
    number: 102,
    title: "Already triaged",
    url: "https://example/issues/102",
    createdAt: "2026-05-01T00:00:00Z",
    labels: ["security", "work-on"],
  };
  const gh = makeGhStub({ security: [issue] });
  const label = makeStubAddLabel();

  const summary = await runBulkTriage({
    repos: [REPO],
    findingsLabels: ["security"],
    ghCommandFn: gh.fn,
    addLabelFn: (repo, n, l) => label.fn(repo, n, l),
  });

  assertEquals(summary.labelled, 0);
  assertEquals(summary.alreadyLabelled, 1);
  assertEquals(label.calls.length, 0);
});

Deno.test("runBulkTriage - severity filter excludes non-matching issues", async () => {
  const high: IssueRow = {
    number: 201,
    title: "high",
    url: "u/201",
    createdAt: "2026-05-01T00:00:00Z",
    labels: ["security", "severity:high"],
  };
  const low: IssueRow = {
    number: 202,
    title: "low",
    url: "u/202",
    createdAt: "2026-05-02T00:00:00Z",
    labels: ["security", "severity:low"],
  };
  const gh = makeGhStub({ security: [high, low] });
  const label = makeStubAddLabel();

  const summary = await runBulkTriage({
    repos: [REPO],
    findingsLabels: ["security"],
    severities: ["severity:high"],
    ghCommandFn: gh.fn,
    addLabelFn: (repo, n, l) => label.fn(repo, n, l),
  });

  assertEquals(summary.labelled, 1);
  assertEquals(summary.skippedSeverity, 1);
  assertEquals(label.calls.length, 1);
  assertEquals(label.calls[0]?.number, 201);
});

Deno.test("runBulkTriage - severity filter rejects issues with no severity label", async () => {
  const issue: IssueRow = {
    number: 203,
    title: "no severity",
    url: "u/203",
    createdAt: "2026-05-01T00:00:00Z",
    labels: ["security"],
  };
  const gh = makeGhStub({ security: [issue] });
  const label = makeStubAddLabel();

  const summary = await runBulkTriage({
    repos: [REPO],
    findingsLabels: ["security"],
    severities: ["severity:high"],
    ghCommandFn: gh.fn,
    addLabelFn: (repo, n, l) => label.fn(repo, n, l),
  });

  assertEquals(summary.labelled, 0);
  assertEquals(summary.skippedSeverity, 1);
  assertEquals(label.calls.length, 0);
});

Deno.test("runBulkTriage - min-age-days excludes too-young issues", async () => {
  const young: IssueRow = {
    number: 301,
    title: "young",
    url: "u/301",
    // Created today — 0 days old.
    createdAt: "2026-05-29T00:00:00Z",
    labels: ["security"],
  };
  const old: IssueRow = {
    number: 302,
    title: "old",
    url: "u/302",
    createdAt: "2026-05-20T00:00:00Z",
    labels: ["security"],
  };
  const gh = makeGhStub({ security: [young, old] });
  const label = makeStubAddLabel();
  const now = () => new Date("2026-05-29T00:00:00Z");

  const summary = await runBulkTriage({
    repos: [REPO],
    findingsLabels: ["security"],
    minAgeDays: 3,
    now,
    ghCommandFn: gh.fn,
    addLabelFn: (repo, n, l) => label.fn(repo, n, l),
  });

  assertEquals(summary.labelled, 1);
  assertEquals(summary.skippedAge, 1);
  assertEquals(label.calls.length, 1);
  assertEquals(label.calls[0]?.number, 302);
});

Deno.test("runBulkTriage - max cap stops further writes once reached", async () => {
  const a: IssueRow = {
    number: 1,
    title: "a",
    url: "u/1",
    createdAt: "2026-05-01T00:00:00Z",
    labels: ["security"],
  };
  const b: IssueRow = {
    number: 2,
    title: "b",
    url: "u/2",
    createdAt: "2026-05-02T00:00:00Z",
    labels: ["security"],
  };
  const c: IssueRow = {
    number: 3,
    title: "c",
    url: "u/3",
    createdAt: "2026-05-03T00:00:00Z",
    labels: ["security"],
  };
  const gh = makeGhStub({ security: [a, b, c] });
  const label = makeStubAddLabel();

  const summary = await runBulkTriage({
    repos: [REPO],
    findingsLabels: ["security"],
    max: 2,
    ghCommandFn: gh.fn,
    addLabelFn: (repo, n, l) => label.fn(repo, n, l),
  });

  assertEquals(summary.labelled, 2);
  assertEquals(summary.skippedCap, 1);
  // Oldest two are labelled (1 and 2) — the cap drops the youngest (3).
  assertEquals(label.calls.map((c) => c.number), [1, 2]);
});

Deno.test("runBulkTriage - dry-run emits would_label and skips writes", async () => {
  const issue: IssueRow = {
    number: 401,
    title: "would",
    url: "u/401",
    createdAt: "2026-05-01T00:00:00Z",
    labels: ["security", "severity:high"],
  };
  const gh = makeGhStub({ security: [issue] });
  const label = makeStubAddLabel();
  const events: BulkTriageEvent[] = [];

  const summary = await runBulkTriage({
    repos: [REPO],
    findingsLabels: ["security"],
    dryRun: true,
    ghCommandFn: gh.fn,
    addLabelFn: (repo, n, l) => label.fn(repo, n, l),
    log: (e) => events.push(e),
  });

  assertEquals(summary.labelled, 0);
  assertEquals(summary.wouldLabel, 1);
  assertEquals(label.calls.length, 0);
  assert(events.some((e) => e.kind === "would_label"));
  assertEquals(summary.dryRun, true);
});

Deno.test("runBulkTriage - gh failure captured, sweep continues to next repo", async () => {
  const issue: IssueRow = {
    number: 501,
    title: "ok",
    url: "u/501",
    createdAt: "2026-05-01T00:00:00Z",
    labels: ["security"],
  };
  const label = makeStubAddLabel();
  let callCount = 0;
  const gh = (args: string[]) => {
    callCount++;
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1] : "";
    if (repo === "broken/repo") {
      return Promise.reject(new Error("HTTP 502 from gh"));
    }
    return Promise.resolve(
      JSON.stringify([{
        number: issue.number,
        title: issue.title,
        url: issue.url,
        createdAt: issue.createdAt,
        labels: issue.labels.map((name) => ({ name })),
      }]),
    );
  };

  const events: BulkTriageEvent[] = [];
  const summary = await runBulkTriage({
    repos: ["broken/repo", REPO],
    findingsLabels: ["security"],
    ghCommandFn: gh,
    addLabelFn: (repo, n, l) => label.fn(repo, n, l),
    log: (e) => events.push(e),
  });

  assertEquals(summary.errors, 1);
  assertEquals(summary.labelled, 1);
  assertEquals(label.calls[0]?.repo, REPO);
  assert(callCount >= 2);
  assert(events.some((e) => e.kind === "error"));
});

Deno.test("runBulkTriage - issue carrying multiple findings labels is processed once", async () => {
  const dual: IssueRow = {
    number: 601,
    title: "dual",
    url: "u/601",
    createdAt: "2026-05-01T00:00:00Z",
    labels: [
      "security",
      "supply-chain-readiness",
      "severity:high",
    ],
  };
  // Both queries return the same row — the sweep must dedup.
  const gh = makeGhStub({
    "security": [dual],
    "supply-chain-readiness": [dual],
  });
  const label = makeStubAddLabel();

  const summary = await runBulkTriage({
    repos: [REPO],
    findingsLabels: ["security", "supply-chain-readiness"],
    ghCommandFn: gh.fn,
    addLabelFn: (repo, n, l) => label.fn(repo, n, l),
  });

  assertEquals(summary.labelled, 1);
  assertEquals(label.calls.length, 1);
  // Both per-label gh queries fire — that's how the dedup gets its input.
  assertEquals(
    gh.queries.map((q) => q.label).sort(),
    ["security", "supply-chain-readiness"],
  );
});

Deno.test("runBulkTriage - custom apply-label and findings-labels honoured", async () => {
  const issue: IssueRow = {
    number: 701,
    title: "custom",
    url: "u/701",
    createdAt: "2026-05-01T00:00:00Z",
    labels: ["custom-finding"],
  };
  const gh = makeGhStub({ "custom-finding": [issue] });
  const label = makeStubAddLabel();

  const summary = await runBulkTriage({
    repos: [REPO],
    applyLabel: "top-priority",
    findingsLabels: ["custom-finding"],
    ghCommandFn: gh.fn,
    addLabelFn: (repo, n, l) => label.fn(repo, n, l),
  });

  assertEquals(summary.labelled, 1);
  assertEquals(label.calls[0]?.label, "top-priority");
});

Deno.test("runBulkTriage - addLabel failure counted as error", async () => {
  const issue: IssueRow = {
    number: 801,
    title: "fail",
    url: "u/801",
    createdAt: "2026-05-01T00:00:00Z",
    labels: ["security"],
  };
  const gh = makeGhStub({ security: [issue] });

  const summary = await runBulkTriage({
    repos: [REPO],
    findingsLabels: ["security"],
    ghCommandFn: gh.fn,
    addLabelFn: () =>
      Promise.resolve({
        ok: false,
        error: new Error("permission denied"),
      }),
  });

  assertEquals(summary.labelled, 0);
  assertEquals(summary.errors, 1);
});

Deno.test("formatBulkTriageEvent - renders each event variant", () => {
  assertEquals(
    formatBulkTriageEvent({
      kind: "labelled",
      repo: "a/b",
      number: 1,
      appliedLabel: "work-on",
      matchedLabel: "security",
      severity: "severity:high",
    }),
    "[bulk-triage] repo=a/b issue=1 action=labelled label=work-on matched=security severity=severity:high",
  );
  assertEquals(
    formatBulkTriageEvent({
      kind: "would_label",
      repo: "a/b",
      number: 2,
      appliedLabel: "work-on",
      matchedLabel: "security",
    }),
    "[bulk-triage] repo=a/b issue=2 action=would_label label=work-on matched=security",
  );
  assertEquals(
    formatBulkTriageEvent({
      kind: "skipped_already_labelled",
      repo: "a/b",
      number: 3,
      appliedLabel: "work-on",
    }),
    "[bulk-triage] repo=a/b issue=3 action=skipped reason=already_labelled label=work-on",
  );
  assertEquals(
    formatBulkTriageEvent({
      kind: "skipped_severity",
      repo: "a/b",
      number: 4,
      severities: ["severity:high"],
    }),
    "[bulk-triage] repo=a/b issue=4 action=skipped reason=severity allowed=severity:high",
  );
  assertEquals(
    formatBulkTriageEvent({
      kind: "skipped_age",
      repo: "a/b",
      number: 5,
      ageDays: 0,
      minAgeDays: 3,
    }),
    "[bulk-triage] repo=a/b issue=5 action=skipped reason=age age_days=0 min_age_days=3",
  );
  assertEquals(
    formatBulkTriageEvent({
      kind: "skipped_cap",
      repo: "a/b",
      number: 6,
      max: 10,
    }),
    "[bulk-triage] repo=a/b issue=6 action=skipped reason=cap max=10",
  );
  assertEquals(
    formatBulkTriageEvent({
      kind: "error",
      repo: "a/b",
      message: "boom",
    }),
    "[bulk-triage] repo=a/b action=error reason=boom",
  );
});

Deno.test("formatBulkTriageSummary - renders applied and dry-run modes", () => {
  assertEquals(
    formatBulkTriageSummary({
      labelled: 5,
      wouldLabel: 0,
      alreadyLabelled: 2,
      skippedSeverity: 1,
      skippedAge: 0,
      skippedCap: 3,
      errors: 1,
      dryRun: false,
    }),
    "[bulk-triage] action=summary mode=applied " +
      "labelled=5 would_label=0 already=2 skipped_severity=1 " +
      "skipped_age=0 skipped_cap=3 errors=1",
  );
  assertEquals(
    formatBulkTriageSummary({
      labelled: 0,
      wouldLabel: 5,
      alreadyLabelled: 2,
      skippedSeverity: 1,
      skippedAge: 0,
      skippedCap: 3,
      errors: 0,
      dryRun: true,
    }),
    "[bulk-triage] action=summary mode=dry_run " +
      "labelled=0 would_label=5 already=2 skipped_severity=1 " +
      "skipped_age=0 skipped_cap=3 errors=0",
  );
});

Deno.test("runBulkTriage - empty repos list yields zero work", async () => {
  const gh = makeGhStub({});
  const label = makeStubAddLabel();
  const summary = await runBulkTriage({
    repos: [],
    ghCommandFn: gh.fn,
    addLabelFn: (repo, n, l) => label.fn(repo, n, l),
  });
  assertEquals(summary.labelled, 0);
  assertEquals(summary.errors, 0);
  assertEquals(gh.queries.length, 0);
});

Deno.test("runBulkTriage - malformed gh JSON counted as error", async () => {
  const gh = () => Promise.resolve("not-json{");
  const label = makeStubAddLabel();
  const events: BulkTriageEvent[] = [];

  const summary = await runBulkTriage({
    repos: [REPO],
    findingsLabels: ["security"],
    ghCommandFn: gh,
    addLabelFn: (repo, n, l) => label.fn(repo, n, l),
    log: (e) => events.push(e),
  });
  assertEquals(summary.errors, 1);
  assertEquals(label.calls.length, 0);
  assert(
    events.some((e) => e.kind === "error" && e.message.includes("malformed")),
  );
});

// =============================================================================
// Exhaustiveness guard (Issue #2533)
// =============================================================================

Deno.test(
  "formatBulkTriageEvent - assertNever throws on an unknown event kind",
  () => {
    // Simulate a value of the wrong shape reaching the switch (e.g. a future
    // variant added without a matching case). The assertNever default branch
    // must throw rather than silently returning undefined.
    const bogus = {
      kind: "totally_unknown",
      repo: "org/repo",
    } as unknown as BulkTriageEvent;
    assertThrows(
      () => formatBulkTriageEvent(bogus),
      Error,
      "Unreachable",
    );
  },
);
