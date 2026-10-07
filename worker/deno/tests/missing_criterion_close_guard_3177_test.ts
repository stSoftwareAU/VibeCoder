/**
 * A PR whose own closure block marks a criterion `missing` does not close its
 * issue (Issue #3177).
 *
 * On GRQ-AutoTrader#2459 and #2307/#2370 a milestone sub-PR said, in its own
 * `## Acceptance Criteria` block, that the issue's core deliverable was
 * `missing`. Milestone-branch PRs need no review, so each merged on green CI
 * and the worker closed the issue as completed. The rule "a missing core
 * deliverable is not a PR" was prose only.
 *
 * Two halves are pinned here, each with its positive path:
 *
 *  1. PR-body assembly: a summary with a `missing` entry produces a
 *     `Part of #N` body, never a `Closes #N` one; an all-`met` summary still
 *     closes.
 *  2. The merged-PR closers (`closeIssuesForMergedPrs`, the milestone
 *     auto-close, and `ensureIssueClosedIfPrMerged`, which the sweep and the
 *     recovery path use): a merged PR whose body marks a criterion `missing`
 *     leaves the issue open, labelled `needs-human`, with a comment naming
 *     the missing criteria; an all-`met` body still closes.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildMissingCriteriaHoldComment,
  findMissingCriteria,
  withholdIssueClose,
} from "../lib/missing_criterion_close_guard.ts";
import { assemblePrBody } from "../lib/pr_body_sync.ts";
import { hasClosingKeyword } from "../lib/pr_body.ts";
import { closeIssuesForMergedPrs } from "../lib/pr_issue_linking.ts";
import { ensureIssueClosedIfPrMerged } from "../lib/issue_lifecycle.ts";
import type { MergeLanding } from "../lib/merge_landing.ts";
import type { Logger } from "../types.ts";

const ISSUE = 2301;

/** A summary closing out four criteria, three of them `missing`. */
const MISSING_SUMMARY = [
  "## Summary",
  "",
  `Part of #${ISSUE}, not a close-out. Closes #${ISSUE}.`,
  "",
  "## Acceptance Criteria",
  "",
  "- **met** — policy doc written — evidence: `docs/policy.md` — reviewer: met",
  "- **missing** — `policy-check` CLI — reason: not started — reviewer: missing",
  "- **missing** — drift test — reason: needs the CLI — reviewer: missing",
  "- **missing** — agreement test — reason: needs the CLI — reviewer: missing",
  "",
  "## Standards Review",
  "",
  "- **pass** — nothing to report",
].join("\n");

/** The same summary with every criterion `met`. */
const MET_SUMMARY = [
  "## Summary",
  "",
  `Closes #${ISSUE}.`,
  "",
  "## Acceptance Criteria",
  "",
  "- **met** — policy doc written — evidence: `docs/policy.md` — reviewer: met",
  "- **met** — `policy-check` CLI — evidence: `cli/policy_check.ts` — reviewer: met",
].join("\n");

function makeLogger(lines: string[] = []): Logger {
  return {
    info: (m) => lines.push(`info:${m}`),
    warn: (m) => lines.push(`warn:${m}`),
    error: (m) => lines.push(`error:${m}`),
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

/** A landing on an open milestone route — the unreviewed path. */
const milestoneLanded = () =>
  Promise.resolve<MergeLanding>({
    landed: true,
    via: "milestone-route-open",
    mergeCommit: "abc123",
    baseRefName: "milestone/2285-policy",
  });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("findMissingCriteria names every `missing` entry and ignores met ones (Issue #3177)", () => {
  const missing = findMissingCriteria(MISSING_SUMMARY);
  assertEquals(missing.length, 3);
  assertStringIncludes(missing[0]!, "policy-check");
  assertEquals(findMissingCriteria(MET_SUMMARY), []);
  assertEquals(findMissingCriteria("## Summary\n\nNo block at all."), []);
});

Deno.test("withholdIssueClose rewrites only this issue's closing keywords (Issue #3177)", () => {
  const body = `Closes #${ISSUE}. Fixes #99. **Resolves #${ISSUE}**`;
  const out = withholdIssueClose(body, ISSUE);
  assertEquals(hasClosingKeyword(out, ISSUE), false);
  assertEquals(hasClosingKeyword(out, 99), true);
  assertStringIncludes(out, `Part of #${ISSUE}.`);
  assertStringIncludes(out, `**Part of #${ISSUE}**`);
});

// ---------------------------------------------------------------------------
// Half 1: PR-body assembly
// ---------------------------------------------------------------------------

Deno.test("assemblePrBody - a summary with a `missing` criterion does not produce a Closes #N PR (Issue #3177)", () => {
  const body = assemblePrBody({
    summaryContent: MISSING_SUMMARY,
    issueNumber: ISSUE,
    extraSections: "",
    footer: "",
    summaryDigest: "deadbeef",
  });
  assertEquals(hasClosingKeyword(body, ISSUE), false);
  assertStringIncludes(body, `Part of #${ISSUE}`);
  // The PR says why, and names what is missing.
  assertStringIncludes(body, `leaves #${ISSUE} open`);
  assertStringIncludes(body, "policy-check");
});

Deno.test("assemblePrBody - an all-met summary still closes the issue (Issue #3177)", () => {
  const body = assemblePrBody({
    summaryContent: MET_SUMMARY,
    issueNumber: ISSUE,
    extraSections: "",
    footer: "",
    summaryDigest: "deadbeef",
  });
  assertEquals(hasClosingKeyword(body, ISSUE), true);
  assertEquals(body.includes("leaves #"), false);
});

Deno.test("assemblePrBody - a `missing` summary with no keyword of its own gets none appended (Issue #3177)", () => {
  const body = assemblePrBody({
    summaryContent: MISSING_SUMMARY.replace(` Closes #${ISSUE}.`, ""),
    issueNumber: ISSUE,
    extraSections: "",
    footer: "",
    summaryDigest: "deadbeef",
    ensureReferences: (b, n) => `${b}\n\nCloses #${n}`,
  });
  assertEquals(hasClosingKeyword(body, ISSUE), false);
});

// ---------------------------------------------------------------------------
// Half 2: the merged-PR closers
// ---------------------------------------------------------------------------

interface World {
  closed: string[];
  labelled: string[];
  comments: string[];
  fn: (args: string[]) => Promise<string>;
}

/** Merged PR #2459 for issue #2301, into a milestone branch, with `prBody`. */
function world(prBody: string, issueLabels: string[] = []): World {
  const w: World = {
    closed: [],
    labelled: [],
    comments: [],
    fn: (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") {
        return Promise.resolve(JSON.stringify([{
          number: 2459,
          title: `Policy doc (Issue #${ISSUE})`,
          headRefName: `issue-${ISSUE}-policy`,
          mergedAt: "2026-10-03T21:00:00Z",
          body: prBody,
        }]));
      }
      if (args[0] === "pr" && args[1] === "view") {
        return Promise.resolve(JSON.stringify({
          state: "MERGED",
          headRefName: `issue-${ISSUE}-policy`,
          body: prBody,
        }));
      }
      if (args[0] === "issue" && args[1] === "view") {
        return Promise.resolve(JSON.stringify({
          state: "OPEN",
          labels: issueLabels.map((name) => ({ name })),
          createdAt: "2026-10-01T00:00:00Z",
          milestone: null,
        }));
      }
      if (args[0] === "api" && (args[1] ?? "").includes("/comments")) {
        return Promise.resolve("[]");
      }
      if (args[0] === "issue" && args[1] === "close") {
        w.closed.push(args[2]!);
      }
      if (args[0] === "issue" && args[1] === "edit") {
        const i = args.indexOf("--add-label");
        if (i >= 0) w.labelled.push(args[i + 1]!);
      }
      if (args[0] === "issue" && args[1] === "comment") {
        w.comments.push(args[args.indexOf("--body") + 1] ?? "");
      }
      return Promise.resolve("");
    },
  };
  return w;
}

async function runCloser(w: World): Promise<number> {
  return await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    w.fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: milestoneLanded, logger: makeLogger() },
  );
}

Deno.test("closeIssuesForMergedPrs - a milestone merge whose summary marks a criterion missing leaves the issue open for a human (Issue #3177)", async () => {
  const w = world(MISSING_SUMMARY);
  const count = await runCloser(w);
  assertEquals(w.closed, []);
  assertEquals(count, 0);
  assertEquals(w.labelled, ["needs-human"]);
  assertEquals(w.comments.length, 1);
  assertStringIncludes(w.comments[0]!, "#2459");
  assertStringIncludes(w.comments[0]!, "policy-check");
  assertStringIncludes(w.comments[0]!, "drift test");
});

Deno.test("closeIssuesForMergedPrs - an issue already handed to a human is not commented on again (Issue #3177)", async () => {
  const w = world(MISSING_SUMMARY, ["needs-human"]);
  await runCloser(w);
  assertEquals(w.closed, []);
  assertEquals(w.labelled, []);
  assertEquals(w.comments, []);
});

Deno.test("closeIssuesForMergedPrs - an all-met milestone merge still closes the issue (Issue #3177)", async () => {
  const w = world(MET_SUMMARY);
  const count = await runCloser(w);
  assertEquals(w.closed, [String(ISSUE)]);
  assertEquals(count, 1);
  assertEquals(w.labelled, []);
});

Deno.test("ensureIssueClosedIfPrMerged - a merged PR whose summary marks a criterion missing leaves the issue open (Issue #3177)", async () => {
  const w = world(MISSING_SUMMARY);
  const result = await ensureIssueClosedIfPrMerged(
    "owner/repo",
    ISSUE,
    2459,
    "bot-user",
    {
      ghCommandFn: w.fn,
      logger: makeLogger(),
      verifyMergeLandedFn: milestoneLanded,
    },
  );
  assert(result.ok);
  assertEquals(result.value.closed, false);
  assertStringIncludes(result.value.reason, "missing");
  assertEquals(w.closed, []);
  assertEquals(w.labelled, ["needs-human"]);
  assertEquals(w.comments.length, 1);
});

Deno.test("ensureIssueClosedIfPrMerged - an all-met merged PR still closes the issue (Issue #3177)", async () => {
  const w = world(MET_SUMMARY);
  const result = await ensureIssueClosedIfPrMerged(
    "owner/repo",
    ISSUE,
    2459,
    "bot-user",
    {
      ghCommandFn: w.fn,
      logger: makeLogger(),
      verifyMergeLandedFn: milestoneLanded,
    },
  );
  assert(result.ok);
  assertEquals(result.value.closed, true);
  assertEquals(w.closed, [String(ISSUE)]);
});

Deno.test("buildMissingCriteriaHoldComment names the PR, the branch and every missing criterion (Issue #3177)", () => {
  const comment = buildMissingCriteriaHoldComment({
    prNumber: 2459,
    baseRefName: "milestone/2285-policy",
    missing: ["- one", "- two"],
  });
  assertStringIncludes(comment, "PR #2459");
  assertStringIncludes(comment, "`milestone/2285-policy`");
  assertStringIncludes(comment, "one");
  assertStringIncludes(comment, "two");
  assertStringIncludes(comment, "needs-human");
});
