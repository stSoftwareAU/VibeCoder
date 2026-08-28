/**
 * A fix cannot predate the thing it fixes (Issue #482).
 *
 * # The incident
 *
 * On 2026-08-28 the worker closed a brand-new issue that had nothing to do
 * with the PR that triggered the close:
 *
 * | Time (UTC) | Event |
 * |---|---|
 * | 06:44:21 | PR #476 merges, titled `... (Issue #477)` — issue #477 did not exist |
 * | 06:53:49 | Issue #477 is filed, on an unrelated subject |
 * | 07:00:44 | `stservice` closes issue #477 |
 *
 * `closeIssuesForMergedPrs` reads an issue number out of a merged PR's title
 * and closes it. Both halves were behaving as designed; nothing checked that
 * the issue could possibly be the PR's subject. Because issues and PRs share
 * one number sequence in a repository, a stale or invented reference in an
 * already-merged PR is a standing instruction to close whatever later takes
 * that number.
 *
 * The damage is silent: the issue is closed with no fix behind it and nobody
 * is told, so the work is simply lost.
 *
 * # What these tests pin
 *
 * The ordering invariant, and the fail-safe direction when the ordering
 * cannot be established. An unknown ordering must hold the PR back for the
 * next cycle rather than guess — closing an issue is destructive and
 * unprompted, while a deferred close costs one cycle.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { closeIssuesForMergedPrs } from "../lib/pr_issue_linking.ts";
import { alwaysLanded } from "./fixtures/merge_landing_stub.ts";

const PR_MERGED_AT = "2026-08-28T06:44:21Z";

/** A merged PR whose title names `#477`, exactly as #476 did. */
function mergedPrList(mergedAt: string | null): string {
  return JSON.stringify([
    {
      number: 476,
      title: "fix: an unreadable milestone route must defer (Issue #477)",
      headRefName: "issue-477",
      ...(mergedAt === null ? {} : { mergedAt }),
    },
  ]);
}

interface Harness {
  closed: string[];
  closeArgs: string[][];
  fn: (args: string[]) => Promise<string>;
}

function harness(
  issueView: Record<string, unknown>,
  mergedAt: string | null,
): Harness {
  const closed: string[] = [];
  const closeArgs: string[][] = [];
  return {
    closed,
    closeArgs,
    fn: (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "list") {
        return Promise.resolve(mergedPrList(mergedAt));
      }
      if (args[0] === "issue" && args[1] === "view") {
        return Promise.resolve(JSON.stringify(issueView));
      }
      if (args[0] === "issue" && args[1] === "close") {
        closed.push(args[2]!);
        closeArgs.push(args);
      }
      return Promise.resolve("");
    },
  };
}

Deno.test("closeIssuesForMergedPrs - an issue filed after the PR merged is never closed (Issue #482)", async () => {
  // The exact #476/#477 ordering: the issue is nine minutes younger than the
  // merge that names its number.
  const h = harness(
    { state: "OPEN", labels: [], createdAt: "2026-08-28T06:53:49Z" },
    PR_MERGED_AT,
  );

  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    h.fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: alwaysLanded },
  );

  assertEquals(
    h.closed,
    [],
    "an issue that did not exist when the PR merged cannot be that PR's " +
      "subject, and closing it destroys unrelated work (Issue #482)",
  );
  assertEquals(count, 0);
});

Deno.test("closeIssuesForMergedPrs - an issue filed before the PR merged still closes (Issue #482)", async () => {
  const h = harness(
    { state: "OPEN", labels: [], createdAt: "2026-08-27T10:00:00Z" },
    PR_MERGED_AT,
  );

  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    h.fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: alwaysLanded },
  );

  assertEquals(
    h.closed,
    ["477"],
    "the ordering guard must not break the ordinary close path",
  );
  assertEquals(count, 1);
});

Deno.test("closeIssuesForMergedPrs - the close comment names the PR that caused it (Issue #482)", async () => {
  const h = harness(
    { state: "OPEN", labels: [], createdAt: "2026-08-27T10:00:00Z" },
    PR_MERGED_AT,
  );

  await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    h.fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: alwaysLanded },
  );

  const comment = h.closeArgs[0]?.[h.closeArgs[0].length - 1] ?? "";
  assert(
    comment.includes("476"),
    `a wrong close must be traceable to the PR that caused it without ` +
      `reading the worker's logs; got: ${comment}`,
  );
});

Deno.test("closeIssuesForMergedPrs - an unknown merge time defers rather than guesses (Issue #482)", async () => {
  // A cache entry written before `mergedAt` was collected. Closing is
  // destructive and unprompted; deferring costs one cycle.
  const h = harness(
    { state: "OPEN", labels: [], createdAt: "2026-08-27T10:00:00Z" },
    null,
  );

  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    h.fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: alwaysLanded },
  );

  assertEquals(h.closed, [], "an unestablished ordering must not close");
  assertEquals(count, 0);
});

Deno.test("closeIssuesForMergedPrs - an unknown issue creation time defers rather than guesses (Issue #482)", async () => {
  const h = harness({ state: "OPEN", labels: [] }, PR_MERGED_AT);

  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    h.fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: alwaysLanded },
  );

  assertEquals(h.closed, [], "an unestablished ordering must not close");
  assertEquals(count, 0);
});

Deno.test("closeIssuesForMergedPrs - an unparseable timestamp defers rather than guesses (Issue #482)", async () => {
  const h = harness(
    { state: "OPEN", labels: [], createdAt: "not-a-date" },
    PR_MERGED_AT,
  );

  const count = await closeIssuesForMergedPrs(
    ["owner/repo"],
    "bot-user",
    h.fn,
    "planning",
    undefined,
    { verifyMergeLandedFn: alwaysLanded },
  );

  assertEquals(h.closed, []);
  assertEquals(count, 0);
});
