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
  addReportedGapSectionOnSync,
  buildSyncFollowUpFiling,
  parseSyncParentIssue,
  summaryReportsGap,
  SYNC_PARENT_ISSUE_FIELDS,
  type SyncFollowUpFiling,
} from "../lib/pr_body_sync_follow_up.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { captureContentSnapshot } from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import type { Logger, Result, WorkerConfig } from "../types.ts";

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

Deno.test("buildSyncFollowUpFiling - a parent issue whose content matches its approval snapshot is not blocked (Issue #3678)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "sync-follow-up-test-" });
  // The approval baseline sits beside `workDir`, not inside it (Issue #3717).
  const stateDir = resolveContentApprovalStateDir(workDir);
  try {
    const title = "Move the data";
    const body = "## Acceptance Criteria\n\n- the export works\n";
    const captured = await captureContentSnapshot(
      stateDir,
      "owner/repo",
      42,
      title,
      body,
      "owner",
    );
    assert(captured.ok, `snapshot not captured: ${JSON.stringify(captured)}`);
    const config: WorkerConfig = {
      ...buildDefaultWorkerConfig(),
      workDir,
      workOnLabel: "work-on",
    };
    const filing = buildSyncFollowUpFiling(config, "this-host");
    const outcome = await filing.verifyIssueContent("owner/repo", 42, {
      title,
      body,
      labels: ["work-on"],
      author: "owner",
    });
    assertEquals(outcome, { blocked: false });
  } finally {
    await Deno.remove(workDir, { recursive: true });
    await Deno.remove(stateDir, { recursive: true }).catch((err) => {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    });
  }
});

// --- parseSyncParentIssue edge cases (Issue #3678) ---------------------------

Deno.test("parseSyncParentIssue - throws when the output is not a JSON object (Issue #3678)", () => {
  assertThrows(() => parseSyncParentIssue("null"), Error, "not a JSON object");
});

Deno.test("parseSyncParentIssue - keeps only label entries whose name is a string (Issue #3678)", () => {
  const parsed = parseSyncParentIssue(JSON.stringify({
    title: "t",
    body: "b",
    labels: [{ name: "a" }, { name: 5 }, null],
    author: null,
    milestone: null,
  }));
  assertEquals(parsed.labels, ["a"]);
});

Deno.test("parseSyncParentIssue - reads no labels when labels is not an array (Issue #3678)", () => {
  const parsed = parseSyncParentIssue(
    JSON.stringify({ title: "t", body: "b", labels: { name: "a" } }),
  );
  assertEquals(parsed.labels, []);
});

Deno.test("parseSyncParentIssue - an absent author is the empty login (Issue #3678)", () => {
  const parsed = parseSyncParentIssue(
    JSON.stringify({ title: "t", body: "b", labels: [] }),
  );
  assertEquals(parsed.author, "");
});

// --- addReportedGapSectionOnSync (Issue #3678) -------------------------------

const noop = () => {};
const logger: Logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  skipReason: noop,
  timing: noop,
  scanSummary: noop,
  workerSummary: noop,
};

const REPO = "owner/repo";
const PR_NUMBER = 7;
const ISSUE_NUMBER = 42;

/** The parent issue as the sync reads it; its body states both criteria. */
const GAP_PARENT = {
  title: "Move the data",
  body: "## Acceptance Criteria\n\n- the export works\n- the import works\n",
  labels: ["work-on"],
  author: "owner",
};

/** The rebuilt PR body: its closure block marks the import criterion partial. */
const REBUILT_BODY = `## Summary\n\nDid it. Closes #${ISSUE_NUMBER}.\n\n` +
  `## Acceptance Criteria\n\n` +
  `- **met** — the export works — evidence: \`worker/deno/tests/x_test.ts\` — reviewer: met\n` +
  `- **partial** — the import works — reviewer: partial\n`;

/** A fake follow-up filer whose content check and label ensure both pass by default. */
function fakeFiling(
  verifyIssueContent: SyncFollowUpFiling["verifyIssueContent"] = () =>
    Promise.resolve({ blocked: false }),
): SyncFollowUpFiling {
  return {
    verifyIssueContent,
    ensureLabelExists: () => Promise.resolve({ ok: true, value: undefined }),
    fleetAuthors: ["vibe-bot"],
  };
}

/**
 * A recording fake `gh`. It lists no open issues, answers `issue create` with
 * a new issue's URL, and rejects with the error `fail` returns for a call.
 */
function recordingGh(
  fail: (args: string[]) => Error | undefined = () => undefined,
) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const error = fail(args);
    if (error) return Promise.reject(error);
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve("[]");
    }
    if (args[0] === "issue" && args[1] === "create") {
      return Promise.resolve("https://github.com/owner/repo/issues/99\n");
    }
    return Promise.resolve("");
  };
  return { calls, gh };
}

/** The failure message of a result, or "" when it is ok. */
function errorText(result: Result<string>): string {
  return result.ok ? "" : result.error.message;
}

Deno.test("addReportedGapSectionOnSync - a failed human hand-off fails loudly and adds no section (Issue #3678)", async () => {
  const { calls, gh } = recordingGh((args) =>
    args[0] === "issue" && args[1] === "edit" && args.includes("--add-label")
      ? new Error("gh: HTTP 403 label write forbidden")
      : undefined
  );
  const result = await addReportedGapSectionOnSync({
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    prNumber: PR_NUMBER,
    body: REBUILT_BODY,
    issue: {
      ...GAP_PARENT,
      body: `${GAP_PARENT.body}\n<!-- finding-id: degraded-follow-up-12 -->\n`,
    },
    filing: fakeFiling(),
    gh,
    runId: "run-hand-off",
    logger,
  });
  assertEquals(result.ok, false);
  const message = errorText(result);
  assertStringIncludes(message, "HTTP 403 label write forbidden");
  assertStringIncludes(message, "PR #7");
  assertEquals(
    calls.some((args) => args[0] === "issue" && args[1] === "create"),
    false,
    "must not file a follow-up after a failed hand-off",
  );
});

Deno.test("addReportedGapSectionOnSync - a verifier that throws fails loudly naming the cause (Issue #3678)", async () => {
  const { calls, gh } = recordingGh();
  const result = await addReportedGapSectionOnSync({
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    prNumber: PR_NUMBER,
    body: REBUILT_BODY,
    issue: GAP_PARENT,
    filing: fakeFiling(() =>
      Promise.reject(new Error("snapshot store unreadable"))
    ),
    gh,
    runId: "run-verifier",
    logger,
  });
  assertEquals(result.ok, false);
  assertStringIncludes(errorText(result), "snapshot store unreadable");
  assertEquals(calls, [], "gh must not be called once the check throws");
});

Deno.test("addReportedGapSectionOnSync - a parent with no milestone files the follow-up without one (Issue #3678)", async () => {
  const { calls, gh } = recordingGh();
  const result = await addReportedGapSectionOnSync({
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    prNumber: PR_NUMBER,
    body: REBUILT_BODY,
    issue: GAP_PARENT,
    filing: fakeFiling(),
    gh,
    runId: "run-no-milestone",
    logger,
  });
  assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
  const create = calls.find((args) =>
    args[0] === "issue" && args[1] === "create"
  );
  assert(create, "gh issue create must run");
  assertEquals(create.includes("--milestone"), false);
});

Deno.test("addReportedGapSectionOnSync - a parent with a milestone files the follow-up on it (Issue #3678)", async () => {
  const { calls, gh } = recordingGh();
  const result = await addReportedGapSectionOnSync({
    repo: REPO,
    issueNumber: ISSUE_NUMBER,
    prNumber: PR_NUMBER,
    body: REBUILT_BODY,
    issue: { ...GAP_PARENT, milestoneTitle: "M1" },
    filing: fakeFiling(),
    gh,
    runId: "run-milestone",
    logger,
  });
  assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
  const create = calls.find((args) =>
    args[0] === "issue" && args[1] === "create"
  );
  assert(create, "gh issue create must run");
  const at = create.indexOf("--milestone");
  assert(at !== -1, "gh issue create must carry --milestone");
  assertEquals(create[at + 1], "M1");
});
