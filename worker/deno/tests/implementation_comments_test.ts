/**
 * Which of an issue's comments the implementation prompt carries
 * (`lib/implementation_comments.ts`, Issue #1910).
 *
 * A resumed issue carries the worker's own run-stats and claim-release
 * bookkeeping; a public repository can carry a flood of untrusted ones. Both
 * used to be moot because the implementation prompt carried no comments at
 * all — now that it does, these tests pin what survives selection and in what
 * order.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildImplementationCommentContext,
  IMPLEMENTATION_COMMENT_LIMITS,
  isWorkerNoiseComment,
  selectImplementationComments,
} from "../lib/implementation_comments.ts";
import type { IssueComment } from "../lib/issue_data.ts";

const TRUST = {
  allowedAuthors: ["maintainer"],
  authorisedCommenters: ["reviewer"],
};

function comment(author: string, body: string): IssueComment {
  return { author, body };
}

Deno.test("comment selection - worker run-stats and release comments are dropped (#1910)", () => {
  const selection = selectImplementationComments([
    comment(
      "vibe-coder",
      '<!-- vibe-issue-run-stats run="abc" -->\n## Execute run model stats\n- cost',
    ),
    comment(
      "vibe-coder",
      "Released on schedule: usage limit — the branch is preserved.",
    ),
    comment("maintainer", "Narrow this to the parser only."),
  ], { workerLogin: "vibe-coder" });

  assertEquals(selection.selected.length, 1);
  assertEquals(selection.selected[0]!.author, "maintainer");
  assertEquals(selection.droppedNoise, 2);
});

Deno.test("comment selection - worker comments do not crowd out a maintainer's reply (#1910)", () => {
  const chatter = Array.from(
    { length: 40 },
    (_, i) => comment("vibe-coder", `Attempted: ${"y".repeat(1000)} (${i})`),
  );
  const selection = selectImplementationComments([
    comment("maintainer", "Scope: only the leap-year branch."),
    ...chatter,
  ], { workerLogin: "vibe-coder" });

  assert(
    selection.selected.some((c) =>
      c.body === "Scope: only the leap-year branch."
    ),
    "the maintainer's comment was crowded out by worker chatter",
  );
});

Deno.test("comment selection - an untrusted flood cannot evict a maintainer's direction (#1910)", () => {
  const flood = Array.from(
    { length: 40 },
    (_, i) => comment(`drive-by-${i}`, `noise ${"n".repeat(1000)}`),
  );
  const selection = selectImplementationComments([
    comment("maintainer", "Scope: only the leap-year branch."),
    ...flood,
  ], { workerLogin: "vibe-coder", ...TRUST });

  assert(
    selection.selected.some((c) =>
      c.body === "Scope: only the leap-year branch."
    ),
    "a trusted author's comment was evicted by newer untrusted comments",
  );
});

Deno.test("comment selection - the newest comments win the budget (#1910)", () => {
  const thread = Array.from(
    { length: 60 },
    (_, i) => comment("maintainer", `comment-${i} ${"z".repeat(1000)}`),
  );
  const selection = selectImplementationComments(thread, {
    workerLogin: "vibe-coder",
  });

  const total = selection.selected.reduce((n, c) => n + c.body.length, 0);
  assert(
    total <= IMPLEMENTATION_COMMENT_LIMITS.maxTotalChars,
    `selected ${total} characters, over the budget`,
  );
  assert(
    selection.selected.length <= IMPLEMENTATION_COMMENT_LIMITS.maxComments,
    "more comments than the cap were selected",
  );
  assert(
    selection.selected.at(-1)!.body.startsWith("comment-59"),
    "the newest comment must be selected",
  );
  assert(selection.droppedForBudget > 0, "the surplus must be reported");
  // What survives is the newest run of the thread, still in the order it was
  // posted — admission walks backwards, the result must not.
  assertEquals(
    selection.selected.map((c) => c.body),
    thread.slice(thread.length - selection.selected.length).map((c) => c.body),
    "selection must return the newest comments in chronological order",
  );
});

Deno.test("comment selection - an empty thread selects nothing (#1910)", () => {
  const selection = selectImplementationComments([], {});
  assertEquals(selection.selected.length, 0);
  assertEquals(selection.droppedNoise, 0);
  assertEquals(selection.droppedForBudget, 0);
  assertEquals(buildImplementationCommentContext([], TRUST).issueComments, "");
});

Deno.test("comment selection - no trust configuration still bounds the blob (#1910)", () => {
  const context = buildImplementationCommentContext(
    Array.from({ length: 50 }, () => comment("drive-by", "q".repeat(2000))),
    { allowedAuthors: [], authorisedCommenters: [] },
  );

  assertEquals(context.commentBoundaryId, undefined);
  assert(
    context.issueComments.length <=
      IMPLEMENTATION_COMMENT_LIMITS.maxTotalChars * 2,
    "the untrusted blob is unbounded without trust configuration",
  );
});

Deno.test("isWorkerNoiseComment - a maintainer's prose is never noise (#1910)", () => {
  assertEquals(isWorkerNoiseComment("Narrow this to the parser only."), false);
  assertEquals(isWorkerNoiseComment(""), false);
  assertEquals(
    isWorkerNoiseComment("## Execute run model stats\n- cost: ~$1.20"),
    true,
  );
});

Deno.test("comment selection - one oversized comment cannot evict the ones that fit (#1910)", () => {
  const huge = comment("drive-by", "H".repeat(40_000));
  const selection = selectImplementationComments([
    comment("maintainer", "Scope: only the leap-year branch."),
    comment("reviewer", "Add a regression test for the empty string."),
    huge,
  ], {
    workerLogin: "vibe-coder",
    allowedAuthors: [],
    authorisedCommenters: [],
  });

  assertEquals(
    selection.selected.map((c) => c.body),
    [
      "Scope: only the leap-year branch.",
      "Add a regression test for the empty string.",
    ],
    "the oversized newest comment must not consume the whole budget",
  );
  assertEquals(selection.droppedForBudget, 1);
});

Deno.test("comment selection - an all-oversized thread still carries the newest (#1910)", () => {
  const selection = selectImplementationComments([
    comment("drive-by", "A".repeat(30_000)),
    comment("maintainer", `newest ${"B".repeat(30_000)}`),
  ], { workerLogin: "vibe-coder" });

  assertEquals(selection.selected.length, 1);
  assert(
    selection.selected[0]!.body.startsWith("newest"),
    "nothing fits, so the newest comment rides and is truncated downstream",
  );
});

Deno.test("comment selection - claim locks are dropped before they spend a slot (#1910)", () => {
  const selection = selectImplementationComments([
    comment("vibe-coder", "<!-- CLAIM_LOCK: host=a epoch=1 -->"),
    comment("vibe-coder", "## Automated Processing Failed\n\nsee the log"),
    comment("maintainer", "Only the parser."),
  ], { workerLogin: "vibe-coder" });

  assertEquals(selection.droppedNoise, 2);
  assertEquals(selection.selected.length, 1);
  assertEquals(isWorkerNoiseComment("<!-- CLAIM_LOCK: host=a -->"), true);
});
