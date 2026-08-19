/**
 * Tests for the reserved-label strip helpers (Issue #2822).
 *
 *   - `filterReservedLabelsWithWarning` (creation-time, `github.ts`)
 *   - `stripReservedLabelsFromIssues`  (post-creation, `reserved_label_strip.ts`)
 *
 * Modelled on `planning_degraded_label_test.ts`. Verifies that reserved labels
 * are stripped + warned, that `idle-task`/descriptive labels survive, that both
 * helpers read the one `RESERVED_LABELS` constant, and that the post-creation
 * helper is non-fatal (read/remove failures are logged, never thrown).
 *
 * Issue #3662 adds the destination-allowlist cases: a ref naming a repo that is
 * neither the current repo nor monitored is skipped before any mutation, so a
 * model-supplied (untrusted) cross-repo sub-issue URL cannot strip reserved
 * labels off an arbitrary issue.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { GitHubIssue, Logger } from "../types.ts";
import {
  filterReservedLabels,
  filterReservedLabelsWithWarning,
} from "../lib/github.ts";
import {
  stripReservedLabelsFromIssueRefs,
  stripReservedLabelsFromIssues,
} from "../lib/reserved_label_strip.ts";
import { RESERVED_LABELS } from "../lib/config_defaults.ts";
import { extractSubIssueRefs } from "../lib/planning_processor.ts";

/** A logger that records warn calls (message + context) for assertions. */
function recordingLogger(): {
  logger: Logger;
  warnings: Array<{ msg: string; context?: Record<string, unknown> }>;
} {
  const warnings: Array<{ msg: string; context?: Record<string, unknown> }> =
    [];
  const noop = () => {};
  const logger: Logger = {
    info: noop,
    warn: (msg: string, context?: Record<string, unknown>) =>
      warnings.push({ msg, context }),
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
  return { logger, warnings };
}

/** A reserved label guaranteed to exist in the single source of truth. */
const RESERVED = "top-priority";
const RESERVED_2 = "work-on";

function assertReserved(label: string) {
  assert(
    RESERVED_LABELS.includes(label),
    `test precondition: '${label}' must be a reserved label`,
  );
}

/**
 * A fake GitHub client recording each `removeLabel` call. `labelsByIssue`
 * seeds the labels returned by `getIssue`. `failRemove`/`failRead` inject
 * non-fatal failures.
 */
function fakeClient(opts: {
  labelsByIssue: Record<number, string[]>;
  failRemove?: boolean;
  failRead?: boolean;
}) {
  const removeCalls: Array<{ issue: number; label: string }> = [];
  const ghClient = {
    getIssue(repo: string, issueNumber: number): Promise<GitHubIssue> {
      void repo;
      if (opts.failRead) return Promise.reject(new Error("read failed"));
      return Promise.resolve({
        number: issueNumber,
        title: "t",
        body: "",
        labels: opts.labelsByIssue[issueNumber] ?? [],
        author: "a",
        assignees: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    },
    removeLabel(
      _repo: string,
      issueNumber: number,
      label: string,
    ): Promise<void> {
      if (opts.failRemove) return Promise.reject(new Error("remove failed"));
      removeCalls.push({ issue: issueNumber, label });
      return Promise.resolve();
    },
  };
  return { ghClient, removeCalls };
}

// ---------------------------------------------------------------------------
// filterReservedLabelsWithWarning
// ---------------------------------------------------------------------------

Deno.test("filterReservedLabelsWithWarning - returns same result as filterReservedLabels", () => {
  assertReserved(RESERVED);
  const input = [RESERVED, "idle-task", "enhancement", RESERVED_2];
  const { logger } = recordingLogger();
  const got = filterReservedLabelsWithWarning(input, "owner/repo path", logger);
  assertEquals(got, filterReservedLabels(input));
  assertEquals(got, ["idle-task", "enhancement"]);
});

Deno.test("filterReservedLabelsWithWarning - logs one WARNING per dropped label with context", () => {
  assertReserved(RESERVED);
  assertReserved(RESERVED_2);
  const { logger, warnings } = recordingLogger();
  filterReservedLabelsWithWarning(
    [RESERVED, "idle-task", RESERVED_2],
    "owner/repo idle-task filer",
    logger,
  );
  // One warning per stripped reserved label (two), none for idle-task.
  assertEquals(warnings.length, 2);
  const dropped = warnings.map((w) => w.context?.label).sort();
  assertEquals(dropped, [RESERVED, RESERVED_2].sort());
  for (const w of warnings) {
    assertEquals(w.context?.context, "owner/repo idle-task filer");
  }
});

Deno.test("filterReservedLabelsWithWarning - idle-task and descriptive labels survive without logging", () => {
  const { logger, warnings } = recordingLogger();
  const got = filterReservedLabelsWithWarning(
    ["idle-task", "degraded-model", "enhancement"],
    "ctx",
    logger,
  );
  assertEquals(got, ["idle-task", "degraded-model", "enhancement"]);
  assertEquals(warnings.length, 0);
});

// ---------------------------------------------------------------------------
// stripReservedLabelsFromIssues
// ---------------------------------------------------------------------------

Deno.test("stripReservedLabelsFromIssues - removes each reserved label and warns once", async () => {
  assertReserved(RESERVED);
  assertReserved(RESERVED_2);
  const { ghClient, removeCalls } = fakeClient({
    labelsByIssue: { 100: [RESERVED, "enhancement", RESERVED_2] },
  });
  const { logger, warnings } = recordingLogger();

  await stripReservedLabelsFromIssues({
    repo: "owner/repo",
    issueNumbers: [100],
    ghClient,
    logger,
  });

  // Both reserved labels removed, enhancement untouched.
  const removed = removeCalls.map((c) => c.label).sort();
  assertEquals(removed, [RESERVED, RESERVED_2].sort());
  for (const c of removeCalls) assertEquals(c.issue, 100);

  // One "Stripped reserved label" warning per removal.
  const stripWarnings = warnings.filter((w) =>
    w.msg.includes("Stripped reserved label")
  );
  assertEquals(stripWarnings.length, 2);
});

Deno.test("stripReservedLabelsFromIssues - idle-task and descriptive labels survive", async () => {
  const { ghClient, removeCalls } = fakeClient({
    labelsByIssue: { 5: ["idle-task", "degraded-model", "enhancement"] },
  });
  const { logger, warnings } = recordingLogger();

  await stripReservedLabelsFromIssues({
    repo: "owner/repo",
    issueNumbers: [5],
    ghClient,
    logger,
  });

  assertEquals(removeCalls.length, 0);
  assertEquals(warnings.length, 0);
});

Deno.test("stripReservedLabelsFromIssues - de-duplicates issue numbers", async () => {
  assertReserved(RESERVED);
  const { ghClient, removeCalls } = fakeClient({
    labelsByIssue: { 7: [RESERVED] },
  });
  const { logger } = recordingLogger();

  await stripReservedLabelsFromIssues({
    repo: "owner/repo",
    issueNumbers: [7, 7, 7],
    ghClient,
    logger,
  });

  // Scrubbed once despite the duplicate issue numbers.
  assertEquals(removeCalls.length, 1);
});

Deno.test("stripReservedLabelsFromIssues - removeLabel failure is logged, not thrown", async () => {
  assertReserved(RESERVED);
  const { ghClient } = fakeClient({
    labelsByIssue: { 8: [RESERVED] },
    failRemove: true,
  });
  const { logger, warnings } = recordingLogger();

  // Must not throw.
  await stripReservedLabelsFromIssues({
    repo: "owner/repo",
    issueNumbers: [8],
    ghClient,
    logger,
  });

  assert(
    warnings.some((w) => w.msg.includes("Failed to strip reserved label")),
    "expected a non-fatal remove-failure warning",
  );
});

Deno.test("stripReservedLabelsFromIssues - getIssue failure is logged, not thrown, continues", async () => {
  assertReserved(RESERVED);
  const { ghClient, removeCalls } = fakeClient({
    labelsByIssue: { 9: [RESERVED] },
    failRead: true,
  });
  const { logger, warnings } = recordingLogger();

  await stripReservedLabelsFromIssues({
    repo: "owner/repo",
    issueNumbers: [9],
    ghClient,
    logger,
  });

  assertEquals(removeCalls.length, 0);
  assert(
    warnings.some((w) => w.msg.includes("Failed to read labels")),
    "expected a non-fatal read-failure warning",
  );
});

Deno.test("stripReservedLabelsFromIssues - strips non-lower-case reserved labels (Issue #3088)", async () => {
  // GitHub treats label names case-insensitively, so a canonical reserved
  // label stored as `Top-Priority` / `Work-On` must still be stripped.
  const { ghClient, removeCalls } = fakeClient({
    labelsByIssue: { 12: ["Top-Priority", "Work-On", "enhancement"] },
  });
  const { logger } = recordingLogger();

  await stripReservedLabelsFromIssues({
    repo: "owner/repo",
    issueNumbers: [12],
    ghClient,
    logger,
  });

  const removed = removeCalls.map((c) => c.label).sort();
  assertEquals(removed, ["Top-Priority", "Work-On"].sort());
});

Deno.test("filterReservedLabelsWithWarning - strips non-lower-case reserved labels (Issue #3088)", () => {
  const { logger, warnings } = recordingLogger();
  const got = filterReservedLabelsWithWarning(
    ["Planning", "idle-task", "WORK-ON"],
    "ctx",
    logger,
  );
  assertEquals(got, ["idle-task"]);
  assertEquals(warnings.length, 2);
});

// ---------------------------------------------------------------------------
// stripReservedLabelsFromIssueRefs — cross-repo scrub (Issue #3575)
// ---------------------------------------------------------------------------

/**
 * A repo-aware fake recording each `removeLabel` call with its repo, so a
 * cross-repo scrub can be asserted per-repository. `labelsByRef` is keyed by
 * `"owner/repo#number"`.
 */
function fakeRefClient(labelsByRef: Record<string, string[]>) {
  const removeCalls: Array<{ repo: string; issue: number; label: string }> = [];
  const ghClient = {
    getIssue(repo: string, issueNumber: number): Promise<GitHubIssue> {
      return Promise.resolve({
        number: issueNumber,
        title: "t",
        body: "",
        labels: labelsByRef[`${repo}#${issueNumber}`] ?? [],
        author: "a",
        assignees: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    },
    removeLabel(
      repo: string,
      issueNumber: number,
      label: string,
    ): Promise<void> {
      removeCalls.push({ repo, issue: issueNumber, label });
      return Promise.resolve();
    },
  };
  return { ghClient, removeCalls };
}

// Issue #3662: this test previously passed no allowlist and asserted that an
// arbitrary `other/child` repo was scrubbed. Cross-repo scrubbing (the Issue
// #3575 behaviour) is preserved, but now only for *monitored* repos, so the
// case supplies the allowlist that the planning path threads through.
Deno.test("stripReservedLabelsFromIssueRefs - strips reserved labels across multiple allowlisted repos", async () => {
  assertReserved(RESERVED_2);
  const { ghClient, removeCalls } = fakeRefClient({
    "owner/parent#10": [RESERVED_2, "enhancement"],
    "other/child#3489": [RESERVED_2, "bug"],
  });
  const { logger } = recordingLogger();

  await stripReservedLabelsFromIssueRefs({
    refs: [
      { repo: "owner/parent", number: 10 },
      { repo: "other/child", number: 3489 },
    ],
    currentRepo: "owner/parent",
    allowedRepos: ["owner/parent", "other/child"],
    ghClient,
    logger,
  });

  // The cross-repo sub-issue (other/child#3489) is scrubbed too — the gap
  // Issue #3575 fixes.
  assert(
    removeCalls.some((c) => c.repo === "other/child" && c.issue === 3489),
    "expected the cross-repo sub-issue to be scrubbed",
  );
  assert(
    removeCalls.some((c) => c.repo === "owner/parent" && c.issue === 10),
    "expected the parent-repo sub-issue to be scrubbed",
  );
  assertEquals(removeCalls.length, 2);
  for (const c of removeCalls) assertEquals(c.label, RESERVED_2);
});

Deno.test("stripReservedLabelsFromIssueRefs - de-duplicates same ref across repo casing", async () => {
  assertReserved(RESERVED);
  const { ghClient, removeCalls } = fakeRefClient({
    "Owner/Repo#7": [RESERVED],
  });
  const { logger } = recordingLogger();

  await stripReservedLabelsFromIssueRefs({
    refs: [
      { repo: "Owner/Repo", number: 7 },
      { repo: "owner/repo", number: 7 },
    ],
    currentRepo: "owner/repo",
    ghClient,
    logger,
  });

  // Same issue in two casings → scrubbed once.
  assertEquals(removeCalls.length, 1);
});

// ---------------------------------------------------------------------------
// stripReservedLabelsFromIssueRefs — destination allowlist (Issue #3662)
// ---------------------------------------------------------------------------

Deno.test("stripReservedLabelsFromIssueRefs - skips a repo that is not the current repo or allowlisted", async () => {
  assertReserved(RESERVED_2);
  const { ghClient, removeCalls } = fakeRefClient({
    "owner/parent#10": [RESERVED_2],
    "victim/repo#99": [RESERVED_2, "needs-human"],
  });
  const { logger, warnings } = recordingLogger();

  await stripReservedLabelsFromIssueRefs({
    refs: [
      { repo: "owner/parent", number: 10 },
      { repo: "victim/repo", number: 99 },
    ],
    currentRepo: "owner/parent",
    allowedRepos: ["owner/parent", "other/child"],
    ghClient,
    logger,
  });

  assertEquals(removeCalls.length, 1);
  assertEquals(removeCalls[0]?.repo, "owner/parent");
  assert(
    warnings.some((w) => w.context?.repo === "victim/repo"),
    "expected a warning naming the skipped off-allowlist repo",
  );
});

Deno.test("stripReservedLabelsFromIssueRefs - denies cross-repo by default when no allowlist is given", async () => {
  assertReserved(RESERVED);
  const { ghClient, removeCalls } = fakeRefClient({
    "owner/parent#10": [RESERVED],
    "other/child#3489": [RESERVED],
  });
  const { logger } = recordingLogger();

  await stripReservedLabelsFromIssueRefs({
    refs: [
      { repo: "owner/parent", number: 10 },
      { repo: "other/child", number: 3489 },
    ],
    currentRepo: "owner/parent",
    ghClient,
    logger,
  });

  assertEquals(removeCalls.length, 1);
  assertEquals(removeCalls[0]?.repo, "owner/parent");
});

Deno.test("stripReservedLabelsFromIssueRefs - allowlist match is case-insensitive", async () => {
  assertReserved(RESERVED);
  const { ghClient, removeCalls } = fakeRefClient({
    "Other/Child#3489": [RESERVED],
  });
  const { logger } = recordingLogger();

  await stripReservedLabelsFromIssueRefs({
    refs: [{ repo: "Other/Child", number: 3489 }],
    currentRepo: "owner/parent",
    allowedRepos: ["other/child"],
    ghClient,
    logger,
  });

  assertEquals(removeCalls.length, 1);
});

Deno.test("stripReservedLabelsFromIssueRefs - an empty allowlist entry never matches", async () => {
  assertReserved(RESERVED);
  const { ghClient, removeCalls } = fakeRefClient({ "#5": [RESERVED] });
  const { logger } = recordingLogger();

  await stripReservedLabelsFromIssueRefs({
    refs: [{ repo: "  ", number: 5 }],
    currentRepo: "owner/parent",
    allowedRepos: ["", "   "],
    ghClient,
    logger,
  });

  assertEquals(removeCalls.length, 0);
});

Deno.test("stripReservedLabelsFromIssueRefs - model-supplied foreign sub-issue URL is not scrubbed", async () => {
  assertReserved(RESERVED_2);
  // Planning output as the model emits it: one genuine sub-issue in the repo
  // under work, plus an injected reference to an unrelated repository.
  const claudeOutput = [
    "Created https://github.com/owner/parent/issues/10",
    "Created https://github.com/victim/repo/issues/99",
  ].join("\n");
  const { ghClient, removeCalls } = fakeRefClient({
    "owner/parent#10": [RESERVED_2],
    "victim/repo#99": [RESERVED_2],
  });
  const { logger } = recordingLogger();

  await stripReservedLabelsFromIssueRefs({
    refs: extractSubIssueRefs(claudeOutput),
    currentRepo: "owner/parent",
    allowedRepos: ["owner/parent", "other/child"],
    ghClient,
    logger,
  });

  assertEquals(removeCalls.length, 1);
  assertEquals(removeCalls[0]?.repo, "owner/parent");
});

Deno.test("stripReservedLabelsFromIssues - no reserved labels logs nothing", async () => {
  const { ghClient, removeCalls } = fakeClient({
    labelsByIssue: { 11: ["enhancement", "idle-task"] },
  });
  const { logger, warnings } = recordingLogger();

  await stripReservedLabelsFromIssues({
    repo: "owner/repo",
    issueNumbers: [11],
    ghClient,
    logger,
  });

  assertEquals(removeCalls.length, 0);
  assertEquals(warnings.length, 0);
});

// ---------------------------------------------------------------------------
// Issue #3708 (SEC-3fb85d0e61ca) — the strip reports whether it applied
// ---------------------------------------------------------------------------

Deno.test("stripReservedLabelsFromIssues - a successful strip returns the labels it removed", async () => {
  assertReserved(RESERVED);
  const { ghClient } = fakeClient({
    labelsByIssue: { 7: [RESERVED, "bug"] },
  });
  const { logger } = recordingLogger();

  const result = await stripReservedLabelsFromIssues({
    repo: "owner/repo",
    issueNumbers: [7],
    ghClient,
    logger,
  });

  assert(result.ok, "a clean strip must report success");
  assertEquals(result.value.stripped, [
    { repo: "owner/repo", issueNumber: 7, label: RESERVED },
  ]);
  assertEquals(result.value.failures, []);
});

Deno.test("stripReservedLabelsFromIssues - a removal failure comes back as an error, not just a warning", async () => {
  assertReserved(RESERVED);
  const { ghClient } = fakeClient({
    labelsByIssue: { 8: [RESERVED] },
    failRemove: true,
  });
  const { logger } = recordingLogger();

  const result = await stripReservedLabelsFromIssues({
    repo: "owner/repo",
    issueNumbers: [8],
    ghClient,
    logger,
  });

  assert(!result.ok, "a reserved label left in place must not report success");
  const failure = result.error.summary.failures[0];
  assertEquals(failure?.stage, "remove");
  assertEquals(failure?.repo, "owner/repo");
  assertEquals(failure?.issueNumber, 8);
  assertEquals(failure?.label, RESERVED);
  assertStringIncludes(result.error.message, "remove failed");
});

Deno.test("stripReservedLabelsFromIssues - a read failure comes back as an error", async () => {
  const { ghClient } = fakeClient({
    labelsByIssue: { 9: [RESERVED] },
    failRead: true,
  });
  const { logger } = recordingLogger();

  const result = await stripReservedLabelsFromIssues({
    repo: "owner/repo",
    issueNumbers: [9],
    ghClient,
    logger,
  });

  assert(!result.ok, "an unreadable issue means the guard did not apply");
  assertEquals(result.error.summary.failures[0]?.stage, "read");
});

Deno.test("stripReservedLabelsFromIssueRefs - one failing issue does not stop the next, and both are reported", async () => {
  assertReserved(RESERVED);
  // Issue 1 fails to read; issue 2 must still be scrubbed.
  const removeCalls: Array<{ repo: string; issue: number }> = [];
  const ghClient = {
    getIssue(_repo: string, issueNumber: number): Promise<GitHubIssue> {
      if (issueNumber === 1) return Promise.reject(new Error("read failed"));
      return Promise.resolve({
        number: issueNumber,
        title: "t",
        body: "",
        labels: [RESERVED],
        author: "a",
        assignees: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    },
    removeLabel(repo: string, issue: number): Promise<void> {
      removeCalls.push({ repo, issue });
      return Promise.resolve();
    },
  };
  const { logger } = recordingLogger();

  const result = await stripReservedLabelsFromIssueRefs({
    refs: [{ repo: "owner/repo", number: 1 }, {
      repo: "owner/repo",
      number: 2,
    }],
    currentRepo: "owner/repo",
    ghClient,
    logger,
  });

  assertEquals(removeCalls, [{ repo: "owner/repo", issue: 2 }]);
  assert(!result.ok, "the failed issue must be reported");
  assertEquals(result.error.summary.failures.length, 1);
  assertEquals(result.error.summary.stripped.length, 1);
});

Deno.test("stripReservedLabelsFromIssueRefs - an off-allowlist skip is a refusal, not a failure", async () => {
  const { ghClient } = fakeClient({ labelsByIssue: {} });
  const { logger } = recordingLogger();

  const result = await stripReservedLabelsFromIssueRefs({
    refs: [{ repo: "victim/repo", number: 5 }],
    currentRepo: "owner/repo",
    allowedRepos: ["owner/repo"],
    ghClient,
    logger,
  });

  assert(result.ok, "a deliberate allowlist refusal is not a strip failure");
  assertEquals(result.value.skipped, [{ repo: "victim/repo", number: 5 }]);
  assertEquals(result.value.stripped, []);
});
