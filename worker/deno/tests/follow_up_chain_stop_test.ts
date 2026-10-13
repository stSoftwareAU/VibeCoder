/**
 * A healthy run on a partial-delivery follow-up files no nested follow-up
 * (PR #3676 review).
 *
 * Every healthy run whose summary marks a criterion `partial` or `missing`
 * files an `idle-task` follow-up (Issue #3506). Keyed on its immediate
 * parent, a run on follow-up F1 would file `Finish #F1: Finish #N: …`, and an
 * item no run can deliver would chain fleet runs without end. Pinned here:
 *
 *  1. The pure helpers: recognising a follow-up body, the chain-stop PR
 *     section and its re-derivation.
 *  2. The merged-PR closers leave a chain-stop PR's issue open, labelled
 *     `needs-human`, even when its gaps are `partial` rather than `missing`.
 *
 * The completion-phase half lives in
 * `completion_phase_degraded_delivery_test.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  assessReportedGaps,
  buildDegradedFollowUpIssue,
  buildFollowUpChainStopSection,
  FOLLOW_UP_CHAIN_STOP_MARKER,
  FOLLOW_UP_CHAIN_STOP_SECTION_HEADING,
  isPartialDeliveryFollowUp,
  rederiveFollowUpChainStopSection,
} from "../lib/degraded_delivery.ts";
import { hasFollowUpChainStop } from "../lib/missing_criterion_close_guard.ts";
import { closeIssuesForMergedPrs } from "../lib/pr_issue_linking.ts";
import { ensureIssueClosedIfPrMerged } from "../lib/issue_lifecycle.ts";
import type { MergeLanding } from "../lib/merge_landing.ts";
import type { Logger } from "../types.ts";

const ISSUE = 3701;

const FOLLOW_UP_BODY = buildDegradedFollowUpIssue({
  parentNumber: 3506,
  parentTitle: "Cross-repo switch",
  verdict: {
    degraded: false,
    delivered: [],
    shortfalls: [{ criterion: "Switch the sibling repo.", status: "missing" }],
  },
  runId: "run-1",
}).body;

const ISSUE_BODY = [
  "## Acceptance Criteria",
  "",
  "- [ ] The router sends planning to opus.",
  "- [ ] The docs table lists opus for planning.",
].join("\n");

/** A healthy summary closing out one criterion as `partial`. */
const PARTIAL_SUMMARY = [
  "## Summary",
  "",
  `Closes #${ISSUE}.`,
  "",
  "## Acceptance Criteria",
  "",
  "- **partial** — The router sends planning to opus. — reason: one route left — reviewer: partial",
  "- **met** — The docs table lists opus for planning. — evidence: `docs/x.md` — reviewer: met",
].join("\n");

const MET_SUMMARY = [
  "## Summary",
  "",
  `Closes #${ISSUE}.`,
  "",
  "## Acceptance Criteria",
  "",
  "- **met** — The router sends planning to opus. — evidence: `lib/r.ts` — reviewer: met",
  "- **met** — The docs table lists opus for planning. — evidence: `docs/x.md` — reviewer: met",
].join("\n");

function makeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

const landed = () =>
  Promise.resolve<MergeLanding>({
    landed: true,
    via: "milestone-route-open",
    mergeCommit: "abc123",
    baseRefName: "milestone/3506-switch",
  });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("isPartialDeliveryFollowUp recognises a body the follow-up filer wrote (PR #3676 review)", () => {
  assert(isPartialDeliveryFollowUp(FOLLOW_UP_BODY));
  assert(!isPartialDeliveryFollowUp(ISSUE_BODY));
  assert(
    !isPartialDeliveryFollowUp("<!-- finding-id: other-finding-12 -->"),
    "another finding id is not a partial-delivery follow-up",
  );
});

Deno.test("buildFollowUpChainStopSection names the gaps, the marker and the hand-off (PR #3676 review)", () => {
  const verdict = assessReportedGaps(ISSUE_BODY, PARTIAL_SUMMARY);
  const section = buildFollowUpChainStopSection(verdict, ISSUE);
  assert(section.startsWith(FOLLOW_UP_CHAIN_STOP_SECTION_HEADING));
  assertStringIncludes(section, FOLLOW_UP_CHAIN_STOP_MARKER);
  assertStringIncludes(section, "**partial** — The router sends planning");
  assertStringIncludes(section, "`needs-human`");
  assert(!section.includes("The docs table lists"), "met items not listed");
});

Deno.test("rederiveFollowUpChainStopSection keeps the section while a gap remains and drops it once none does (PR #3676 review)", () => {
  const kept = rederiveFollowUpChainStopSection({
    issueNumber: ISSUE,
    issueBody: ISSUE_BODY,
    prBody: PARTIAL_SUMMARY,
  });
  assertStringIncludes(kept, FOLLOW_UP_CHAIN_STOP_MARKER);
  assertEquals(
    rederiveFollowUpChainStopSection({
      issueNumber: ISSUE,
      issueBody: ISSUE_BODY,
      prBody: MET_SUMMARY,
    }),
    "",
  );
});

// ---------------------------------------------------------------------------
// The merged-PR closers
// ---------------------------------------------------------------------------

interface World {
  closed: string[];
  labelled: string[];
  comments: string[];
  fn: (args: string[]) => Promise<string>;
}

function world(prBody: string, issueLabels: string[] = []): World {
  const w: World = {
    closed: [],
    labelled: [],
    comments: [],
    fn: (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") {
        return Promise.resolve(JSON.stringify([{
          number: 3702,
          title: `Finish the switch (Issue #${ISSUE})`,
          headRefName: `issue-${ISSUE}-switch`,
          mergedAt: "2026-10-13T21:00:00Z",
          body: prBody,
        }]));
      }
      if (args[0] === "pr" && args[1] === "view") {
        return Promise.resolve(JSON.stringify({
          state: "MERGED",
          headRefName: `issue-${ISSUE}-switch`,
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

const CHAIN_STOP_PR_BODY = buildFollowUpChainStopSection(
  assessReportedGaps(ISSUE_BODY, PARTIAL_SUMMARY),
  ISSUE,
) + PARTIAL_SUMMARY;

Deno.test("hasFollowUpChainStop reads the marker only (PR #3676 review)", () => {
  assert(hasFollowUpChainStop(CHAIN_STOP_PR_BODY));
  assert(!hasFollowUpChainStop(PARTIAL_SUMMARY));
});

Deno.test("closeIssuesForMergedPrs - a chain-stop PR with only partial gaps leaves the follow-up open (PR #3676 review)", async () => {
  const w = world(CHAIN_STOP_PR_BODY, ["needs-human"]);
  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    w.fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: landed, logger: makeLogger() },
  );
  assertEquals(count, 0);
  assertEquals(w.closed, []);
  assertEquals(w.labelled, [], "already labelled when the PR was raised");
  assertEquals(w.comments, []);
});

Deno.test("closeIssuesForMergedPrs - a chain-stop follow-up whose label was removed is labelled again (PR #3676 review)", async () => {
  const w = world(CHAIN_STOP_PR_BODY);
  await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    w.fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: landed, logger: makeLogger() },
  );
  assertEquals(w.closed, []);
  assertEquals(w.labelled, ["needs-human"]);
});

Deno.test("closeIssuesForMergedPrs - the same partial PR without the chain-stop section still closes (PR #3676 review)", async () => {
  const w = world(PARTIAL_SUMMARY);
  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    w.fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: landed, logger: makeLogger() },
  );
  assertEquals(count, 1);
  assertEquals(w.closed, [String(ISSUE)]);
});

Deno.test("ensureIssueClosedIfPrMerged - a chain-stop PR leaves the follow-up open (PR #3676 review)", async () => {
  const w = world(CHAIN_STOP_PR_BODY);
  const result = await ensureIssueClosedIfPrMerged(
    "owner/repo",
    ISSUE,
    3702,
    "bot-user",
    {
      ghCommandFn: w.fn,
      logger: makeLogger(),
      verifyMergeLandedFn: landed,
    },
  );
  assert(result.ok);
  assertEquals(result.value.closed, false);
  assertStringIncludes(result.value.reason, "partial-delivery follow-up");
  assertEquals(w.closed, []);
  assertEquals(w.labelled, ["needs-human"]);
});
