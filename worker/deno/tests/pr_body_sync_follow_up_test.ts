/**
 * Tests for `pr_body_sync_follow_up.ts` — the parent-issue read, the trigger
 * and the production follow-up filer a fix run's sync uses (Issue #3678).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  buildSyncFollowUpFiling,
  parseSyncParentIssue,
  summaryReportsGap,
  SYNC_PARENT_ISSUE_FIELDS,
} from "../lib/pr_body_sync_follow_up.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

// --- parseSyncParentIssue ---------------------------------------------------

Deno.test("parseSyncParentIssue - reads the observed gh shape (Issue #3678)", () => {
  const parsed = parseSyncParentIssue(JSON.stringify({
    title: "Move the data",
    body: "## Acceptance Criteria\n\n- the export works\n",
    author: { login: "x", is_bot: false },
    labels: [{ name: "work-on", color: "0E8A16" }, { color: "ffffff" }],
    milestone: { title: "M", number: 1 },
  }));
  assertEquals(parsed, {
    title: "Move the data",
    body: "## Acceptance Criteria\n\n- the export works\n",
    labels: ["work-on"],
    author: "x",
    milestoneTitle: "M",
  });
});

Deno.test("parseSyncParentIssue - a null milestone is no milestone (Issue #3678)", () => {
  const parsed = parseSyncParentIssue(JSON.stringify({
    title: "t",
    body: "b",
    author: null,
    labels: [],
    milestone: null,
  }));
  assertEquals(parsed, { title: "t", body: "b", labels: [], author: "" });
  assertEquals("milestoneTitle" in parsed, false);
});

Deno.test("parseSyncParentIssue - throws naming the body when it is missing (Issue #3678)", () => {
  assertThrows(
    () => parseSyncParentIssue(JSON.stringify({ title: "t" })),
    Error,
    "body",
  );
});

Deno.test("parseSyncParentIssue - throws naming the title when it is not a string (Issue #3678)", () => {
  assertThrows(
    () => parseSyncParentIssue(JSON.stringify({ title: 7, body: "b" })),
    Error,
    "title",
  );
});

Deno.test("SYNC_PARENT_ISSUE_FIELDS - requests the fields the parser reads (Issue #3678)", () => {
  assertEquals(SYNC_PARENT_ISSUE_FIELDS, "title,body,labels,author,milestone");
});

// --- summaryReportsGap -------------------------------------------------------

const ONE_CRITERION = (status: string) =>
  `## Summary\n\nDid it. Closes #42.\n\n` +
  `## Acceptance Criteria\n\n` +
  `- **${status}** — the export works — evidence: \`worker/deno/tests/x_test.ts\` — reviewer: ${status}\n`;

Deno.test("summaryReportsGap - true when an entry is partial (Issue #3678)", () => {
  assertEquals(summaryReportsGap(ONE_CRITERION("partial")), true);
});

Deno.test("summaryReportsGap - true when an entry is missing (Issue #3678)", () => {
  assertEquals(summaryReportsGap(ONE_CRITERION("missing")), true);
});

Deno.test("summaryReportsGap - false when every entry is met (Issue #3678)", () => {
  assertEquals(summaryReportsGap(ONE_CRITERION("met")), false);
});

Deno.test("summaryReportsGap - false when there is no closure block (Issue #3678)", () => {
  assertEquals(summaryReportsGap("## Summary\n\nDid it.\n"), false);
});

// --- buildSyncFollowUpFiling -------------------------------------------------

Deno.test("buildSyncFollowUpFiling - fleet authors include this host and the configured fleet and service logins (Issue #3678)", () => {
  const config: WorkerConfig = {
    ...buildDefaultWorkerConfig(),
    workDir: "/tmp/sync-follow-up-unused",
    fleetPrAuthors: ["fleet-a"],
    serviceAccounts: ["svc-b"],
  };
  const filing = buildSyncFollowUpFiling(config, "this-host");
  assert(filing.fleetAuthors.includes("this-host"));
  assert(filing.fleetAuthors.includes("fleet-a"));
  assert(filing.fleetAuthors.includes("svc-b"));
});

Deno.test("buildSyncFollowUpFiling - a parent issue with no approval snapshot is blocked, not filed (Issue #3678)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "sync-follow-up-test-" });
  try {
    const config: WorkerConfig = {
      ...buildDefaultWorkerConfig(),
      workDir,
      workOnLabel: "work-on",
    };
    const filing = buildSyncFollowUpFiling(config, "this-host");
    const issue = parseSyncParentIssue(JSON.stringify({
      title: "Move the data",
      body: "## Acceptance Criteria\n\n- the export works\n",
      author: { login: "owner" },
      labels: [{ name: "work-on" }],
      milestone: null,
    }));
    const outcome = await filing.verifyIssueContent("owner/repo", 42, issue);
    assertEquals(outcome, { blocked: true, reason: "no-approval-snapshot" });
    assertStringIncludes(JSON.stringify(outcome), "no-approval-snapshot");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
