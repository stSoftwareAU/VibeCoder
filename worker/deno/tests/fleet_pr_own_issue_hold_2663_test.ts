/**
 * An issue whose own fleet PR is open is never claimable again, whatever the
 * slot cap (Issue #2663).
 *
 * Before #2663 any open fleet PR on the default-branch stream held every
 * non-milestone issue, so an issue could not be re-claimed while its own PR
 * waited for CI or review. The per-slot cap made a lone PR hold nothing, and
 * the backlog-to-done harness then re-claimed each issue while its PR was
 * still open (`acme/app#1 was claimed again`). This pins the hard hold that
 * the cap must never lift, in both directions.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { getBlockingPRForIssue, type OpenPR } from "../lib/issue_query.ts";

const FLEET = ["vibe-bot"];

function pr(
  number: number,
  title: string,
  head: string,
  base = "main",
): OpenPR {
  return {
    number,
    title,
    headRefName: head,
    baseRefName: base,
    author: "vibe-bot",
  };
}

Deno.test("own PR by title holds its issue below the cap (Issue #2663)", () => {
  const prs = [pr(10, "Fix the thing (#1)", "some-branch")];
  const held = getBlockingPRForIssue(prs, "", FLEET, 8, 1);
  assertEquals(held?.number, 10);
  assertEquals(held?.fleetPrCap, undefined, "held by its own PR, not the cap");
});

Deno.test("own PR by (Issue #N) title or issue-N branch holds its issue", () => {
  assertEquals(
    getBlockingPRForIssue([pr(11, "Do it (Issue #7)", "x")], "", FLEET, 8, 7)
      ?.number,
    11,
  );
  assertEquals(
    getBlockingPRForIssue(
      [pr(12, "untitled", "issue-7-do-it")],
      "",
      FLEET,
      8,
      7,
    )
      ?.number,
    12,
  );
});

Deno.test("an unrelated fleet PR below the cap holds nothing (Issue #2663)", () => {
  const prs = [pr(10, "Fix the thing (#1)", "issue-1-fix")];
  assertEquals(getBlockingPRForIssue(prs, "", FLEET, 8, 2), null);
  // issue-17 must not read as issue-1's branch.
  assertEquals(
    getBlockingPRForIssue([pr(13, "x", "issue-17-other")], "", FLEET, 8, 1),
    null,
  );
});

Deno.test("own PR on a milestone branch still holds its issue", () => {
  const prs = [pr(14, "Part (#3)", "issue-3-part", "milestone/9-area")];
  assertEquals(getBlockingPRForIssue(prs, "", FLEET, 8, 3)?.number, 14);
});

Deno.test("a human's PR for the issue does not hold it (Issue #4133)", () => {
  const human: OpenPR = {
    ...pr(15, "Mine (#4)", "issue-4-mine"),
    author: "a-human",
  };
  assertEquals(getBlockingPRForIssue([human], "", FLEET, 8, 4), null);
});

Deno.test("no issue number keeps the cap-only behaviour", () => {
  const prs = [pr(10, "Fix (#1)", "issue-1-fix")];
  assert(getBlockingPRForIssue(prs, "", FLEET, 8) === null);
  assertEquals(getBlockingPRForIssue(prs, "", FLEET, 1)?.fleetPrCap, {
    open: 1,
    cap: 1,
  });
});
