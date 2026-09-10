/**
 * Tests for the GitHub half of a milestone roll-back (Issue #1781).
 *
 * After the mechanics revert the children that were in the way, this module
 * reopens those issues, posts the roll-back marker, closes their open PRs
 * and the summary PR, and posts exactly one notice. A roll-back that could
 * not merge escalates once, with `needs-human`, and never files an issue.
 *
 * Every test injects `gh`. No live GitHub, no live git.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildRollbackFailedComment,
  buildRollbackNotice,
  escalateRollbackFailure,
  requeueRolledBackChildren,
  resolveIssueForRevertedPr,
} from "../lib/milestone_rollback_requeue.ts";
import { buildRollbackMarker } from "../lib/milestone_rollback_marker.ts";
import { ROLLBACK_MARKER } from "../lib/milestone_rollback_marker.ts";

const REPO = "owner/repo";
const BRANCH = "milestone/1730-ledger";
const REVERT_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Record every gh argv and answer from a script. */
function ghStub(
  calls: string[][],
  script: (args: string[]) => string | Error = () => "",
): (args: string[]) => Promise<string> {
  return (args) => {
    calls.push([...args]);
    const answer = script(args);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  };
}

Deno.test("resolveIssueForRevertedPr - the branch shape wins over the body", () => {
  assertEquals(
    resolveIssueForRevertedPr("issue-45-do-the-thing", "Closes #99"),
    45,
  );
});

Deno.test("resolveIssueForRevertedPr - a body closing keyword is the fallback", () => {
  assertEquals(
    resolveIssueForRevertedPr("sync/unrelated", "Fixes #77 and mentions #1"),
    77,
  );
});

Deno.test("resolveIssueForRevertedPr - no branch and no closing keyword is nowhere", () => {
  assertEquals(resolveIssueForRevertedPr(undefined, "See #12"), null);
  assertEquals(resolveIssueForRevertedPr("feature/no-number", ""), null);
});

Deno.test("buildRollbackNotice - names the reverted PRs, reopened issues and the checklist", () => {
  const body = buildRollbackNotice({
    milestoneBranch: BRANCH,
    defaultBranch: "main",
    rollbacks: 2,
    attempts: 3,
    reverted: [{ prNumber: 12, issueNumber: 45, revertSha: REVERT_SHA }],
    reopened: [45],
    needsTrustedRelabel: [45],
  });
  assertStringIncludes(body, BRANCH);
  assertStringIncludes(body, "PR #12");
  assertStringIncludes(body, "#45");
  assertStringIncludes(body, REVERT_SHA.slice(0, 7));
  assertStringIncludes(body, "roll-back #2");
  assertStringIncludes(body, "- [ ] #45");
  assert(!body.toLowerCase().includes("needs-human"));
});

Deno.test("buildRollbackFailedComment - names the reason and asks for a human", () => {
  const body = buildRollbackFailedComment({
    milestoneBranch: BRANCH,
    defaultBranch: "main",
    reason: "nothing left to revert",
  });
  assertStringIncludes(body, "nothing left to revert");
  assertStringIncludes(body, "needs-human");
  assertStringIncludes(body, BRANCH);
});

Deno.test("requeueRolledBackChildren - reopens a closed child, posts the marker, closes its PR and the summary, one notice (Issue #1781)", async () => {
  const calls: string[][] = [];
  const result = await requeueRolledBackChildren({
    repo: REPO,
    milestoneTitle: "#1730 Ledger",
    milestoneNumber: 52,
    milestoneBranch: BRANCH,
    defaultBranch: "main",
    rollbacks: 1,
    attempts: 3,
    reverted: [{
      prNumber: 12,
      sha: REVERT_SHA,
      headRefName: "issue-45-child",
      title: "The child",
    }],
    ghCommandFn: ghStub(calls, (args) => {
      const key = args.join(" ");
      if (key.includes("pr view") && key.includes("12")) {
        return JSON.stringify({
          body: "Closes #45",
          headRefName: "issue-45-child",
        });
      }
      if (key.includes("issue view") && key.includes("45")) {
        return JSON.stringify({
          state: "CLOSED",
          labels: [{ name: "idle-task" }],
        });
      }
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 12,
            headRefName: "issue-45-child",
            baseRefName: BRANCH,
            body: "Closes #45",
            state: "OPEN",
          },
          {
            number: 99,
            headRefName: BRANCH,
            baseRefName: "main",
            body: "Milestone summary",
            state: "OPEN",
          },
        ]);
      }
      return "";
    }),
    log: () => undefined,
  });

  assertEquals(result.reopened, [45]);
  assertEquals(result.closedPrs, [12]);
  assertEquals(result.closedSummaryPr, 99);
  assertEquals(result.needsTrustedRelabel, []);
  assertEquals(result.noticeIssue, 1730);

  const commentBodies = calls
    .filter((c) => c[0] === "issue" && c[1] === "comment")
    .map((c) => c[c.length - 1] ?? "");
  assertEquals(commentBodies.length, 2, "marker on the child, one notice");
  assert(
    commentBodies.some((b) => b.includes(ROLLBACK_MARKER) && b.includes("12")),
    `no marker comment: ${JSON.stringify(commentBodies)}`,
  );
  assert(
    commentBodies.some((b) => b.includes("roll-back #1") && b.includes("#45")),
    `no notice: ${JSON.stringify(commentBodies)}`,
  );

  assert(
    calls.some((c) =>
      c[0] === "issue" && c[1] === "reopen" && c.includes("45")
    ),
    "the closed child is reopened",
  );
  assert(
    calls.some((c) =>
      c[0] === "issue" && c.includes("--add-label") && c.includes("idle-task")
    ),
    "idle-task is re-applied",
  );
  assert(
    calls.some((c) => c[0] === "pr" && c[1] === "close" && c.includes("12")),
    "the child's open PR is closed",
  );
  assert(
    calls.some((c) => c[0] === "pr" && c[1] === "close" && c.includes("99")),
    "the summary PR is closed",
  );
  assert(
    !calls.some((c) => c.includes("--add-label") && c.includes("needs-human")),
    "the success notice must not add needs-human",
  );
});

Deno.test("requeueRolledBackChildren - a work-on child is reopened without it and listed for a trusted re-label (Issue #1781)", async () => {
  const calls: string[][] = [];
  const result = await requeueRolledBackChildren({
    repo: REPO,
    milestoneTitle: "#1730 Ledger",
    milestoneNumber: 52,
    milestoneBranch: BRANCH,
    defaultBranch: "main",
    rollbacks: 1,
    attempts: 3,
    reverted: [{
      prNumber: 8,
      sha: REVERT_SHA,
      headRefName: "issue-20-work",
      title: "Work-on child",
    }],
    ghCommandFn: ghStub(calls, (args) => {
      const key = args.join(" ");
      if (key.includes("issue view") && key.includes("20")) {
        return JSON.stringify({
          state: "CLOSED",
          labels: [{ name: "work-on" }],
        });
      }
      if (args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([]);
      }
      return "";
    }),
    log: () => undefined,
  });

  assertEquals(result.reopened, [20]);
  assertEquals(result.needsTrustedRelabel, [20]);
  assert(
    calls.some((c) => c.includes("--remove-label") && c.includes("work-on")),
    "work-on is stripped so the worker does not leave a label it cannot apply",
  );
  assert(
    !calls.some((c) => c.includes("--add-label") && c.includes("work-on")),
    "work-on must never be re-applied",
  );
  const notice = calls.find((c) =>
    c[0] === "issue" && c[1] === "comment" &&
    (c[c.length - 1] ?? "").includes("trusted re-label")
  );
  assert(notice, "the notice lists the checklist");
  assertStringIncludes(notice[notice.length - 1] ?? "", "- [ ] #20");
});

Deno.test("requeueRolledBackChildren - an untouched sibling is never reopened or labelled", async () => {
  const calls: string[][] = [];
  await requeueRolledBackChildren({
    repo: REPO,
    milestoneTitle: "#1730 Ledger",
    milestoneNumber: 52,
    milestoneBranch: BRANCH,
    defaultBranch: "main",
    rollbacks: 1,
    attempts: 3,
    reverted: [{
      prNumber: 8,
      sha: REVERT_SHA,
      headRefName: "issue-20-work",
      title: "Only this one",
    }],
    ghCommandFn: ghStub(calls, (args) => {
      const key = args.join(" ");
      if (key.includes("issue view") && key.includes("20")) {
        return JSON.stringify({ state: "CLOSED", labels: [] });
      }
      if (args[0] === "pr" && args[1] === "list") return JSON.stringify([]);
      return "";
    }),
    log: () => undefined,
  });

  const reopens = calls
    .filter((c) => c[0] === "issue" && c[1] === "reopen")
    .map((c) => c[2]);
  assert(reopens.includes("20"), "the reverted child is reopened");
  assert(
    !reopens.includes("21") && !reopens.includes("22"),
    `touched a sibling: ${JSON.stringify(reopens)}`,
  );
});

Deno.test("escalateRollbackFailure - one needs-human comment on the parent, and a second call posts nothing (Issue #1781)", async () => {
  const calls: string[][] = [];
  const script = (args: string[]): string => {
    const key = args.join(" ");
    if (key.includes("issue view") && key.includes("state")) return "CLOSED";
    return "";
  };
  const first = await escalateRollbackFailure({
    repo: REPO,
    milestoneTitle: "#1730 Ledger",
    milestoneNumber: 52,
    milestoneBranch: BRANCH,
    defaultBranch: "main",
    reason: "nothing left to revert",
    alreadyEscalated: false,
    ghCommandFn: ghStub(calls, script),
    log: () => undefined,
  });
  assertEquals(first.posted, true);
  assertEquals(first.issue, 1730);

  const second = await escalateRollbackFailure({
    repo: REPO,
    milestoneTitle: "#1730 Ledger",
    milestoneNumber: 52,
    milestoneBranch: BRANCH,
    defaultBranch: "main",
    reason: "nothing left to revert",
    alreadyEscalated: true,
    ghCommandFn: ghStub(calls, script),
    log: () => undefined,
  });
  assertEquals(second.posted, false);

  const comments = calls.filter((c) => c[0] === "issue" && c[1] === "comment");
  assertEquals(comments.length, 1, "exactly one comment across both cycles");
  assertStringIncludes(
    comments[0]![comments[0]!.length - 1] ?? "",
    "needs-human",
  );
  assert(
    calls.some((c) => c.includes("--add-label") && c.includes("needs-human")),
    "the parent is labelled needs-human",
  );
  assert(
    !calls.some((c) => c[0] === "issue" && c[1] === "create"),
    "no new issue is filed",
  );
});

Deno.test("escalateRollbackFailure - nowhere to post is one log line and counts as escalated", async () => {
  const logs: string[] = [];
  const calls: string[][] = [];
  const result = await escalateRollbackFailure({
    repo: REPO,
    milestoneTitle: "No number here",
    milestoneNumber: 52,
    milestoneBranch: BRANCH,
    defaultBranch: "main",
    reason: "nothing left to revert",
    alreadyEscalated: false,
    ghCommandFn: ghStub(calls, (args) => {
      if (args[0] === "issue" && args[1] === "list") return "[]";
      return "";
    }),
    log: (m) => logs.push(m),
  });
  assertEquals(result.posted, false);
  assertEquals(result.issue, null);
  assertEquals(result.countedAsEscalated, true);
  assertEquals(calls.filter((c) => c[1] === "comment").length, 0);
  assert(
    logs.some((l) => l.includes("nowhere") || l.includes("no open issue")),
    `expected a nowhere line, got ${JSON.stringify(logs)}`,
  );
});

Deno.test("buildRollbackMarker - the requeue comment carries a parseable marker", () => {
  const marker = buildRollbackMarker({
    prNumber: 12,
    revertSha: REVERT_SHA,
    branch: BRANCH,
  });
  assertStringIncludes(marker, ROLLBACK_MARKER);
  assertStringIncludes(marker, `pr="12"`);
});
