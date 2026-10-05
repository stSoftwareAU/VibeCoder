/**
 * The backtracking regexes Issue #3164 and Issue #3186 left outside their
 * scope each get a hostile case (Issue #3206).
 *
 * PR #3188 found the overlapping-quantifier shape in three modules it did not
 * own. Each pattern below reads untrusted text, and each backtracked
 * super-linearly on a long run of a character two of its quantifiers share,
 * followed by a character the pattern rejects:
 *
 *   - `issue_lifecycle.ts` — `commitMessagesReferenceIssue` reads commit
 *     messages with `\bissue\s*:?\s*#?(\d+)` and a closing-keyword branch
 *     ending `\s*:?\s*#(\d+)`. The two whitespace runs split one run of spaces
 *     in every possible way: quadratic, about 0.36 s and 0.16 s at 20 000
 *     spaces.
 *   - `milestone_partial_rollup.ts` — `CLOSING_KEYWORD_PATTERN` scans the
 *     partial-rollup body, which carries the milestone branch name.
 *     `[\w.-]*\/?[\w.-]*#` splits a run of name characters the same way (about
 *     0.22 s at 20 000), and a branch repeating `fix.` restarts the search at
 *     every keyword and rescans to the end each time: cubic, about 0.4 s for
 *     only 500 repeats.
 *   - `planning_processor.ts` — `listSubIssuesViaIssueList` reads sub-issue
 *     bodies with `parent\s*:?\s*` followed by `\s*#`: three whitespace runs,
 *     cubic, about 1.3 s at 2 000 spaces.
 *
 * Nothing here reads a clock (CODING-STANDARDS.md, "Guard super-linearity by
 * behaviour first"). Each case feeds the hostile text and asserts what the
 * parser produces: the near miss is not taken for a match, and a real match
 * after it is still found, so a rewrite cannot buy speed by dropping the
 * match. On the unfixed patterns each case does not return in any time a test
 * run would wait for.
 *
 * Uses Australian English throughout (behaviour, recognise).
 */

import { assertEquals } from "@std/assert";
import { commitMessagesReferenceIssue } from "../lib/issue_lifecycle.ts";
import {
  createPartialRollup,
  type GhCommandFn,
} from "../lib/milestone_partial_rollup.ts";
import { listSubIssuesViaIssueList } from "../lib/planning_processor.ts";

/** Long enough that a quadratic tail never returns in a test run. */
const RUN = 199_000;

/** A run of spaces, then a character no reference accepts. */
const PADDING = `${" ".repeat(RUN)}x`;

Deno.test("3206 - commit message `issue` reference: a padded near miss is skipped and a real reference still read", () => {
  assertEquals(
    commitMessagesReferenceIssue(`issue${PADDING}\nIssue :  #42`, 42),
    true,
  );
  assertEquals(commitMessagesReferenceIssue(`issue${PADDING}`, 42), false);
});

Deno.test("3206 - commit message closing keyword: a padded near miss is skipped and a real reference still read", () => {
  assertEquals(
    commitMessagesReferenceIssue(`fixes${PADDING}\nFixes :  #42`, 42),
    true,
  );
  assertEquals(commitMessagesReferenceIssue(`fixes${PADDING}`, 42), false);
});

const TIP = "abcdef1234567890abcdef1234567890abcdef12";

/** Just enough of `gh` for `createPartialRollup` to reach the PR create. */
function fakeGh(): { gh: GhCommandFn; bodies: string[] } {
  const bodies: string[] = [];
  const gh: GhCommandFn = (args) => {
    const path = args[1] ?? "";
    if (args[0] === "pr" && args[1] === "list") return Promise.resolve("[]");
    if (args[0] === "pr" && args[1] === "create") {
      bodies.push(args[args.indexOf("--body") + 1] ?? "");
      return Promise.resolve("https://github.com/owner/repo/pull/1\n");
    }
    if (args[0] === "api" && args[2] === "POST") return Promise.resolve("{}");
    if (args[0] === "api" && path.includes("/git/ref/heads/")) {
      return Promise.resolve(`${TIP}\n`);
    }
    if (args[0] === "api" && path.includes("/compare/")) {
      return Promise.resolve(
        JSON.stringify({ behind_by: 0, ahead_by: 1, files: 1 }),
      );
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
  return { gh, bodies };
}

function rollup(milestone: string, milestoneBranch: string, ghFn: GhCommandFn) {
  return createPartialRollup({
    repo: "owner/repo",
    milestone,
    milestoneBranch,
    defaultBranch: "main",
    ghFn,
    authorOptions: { fleetAuthors: ["bot"] },
    log: () => {},
  });
}

Deno.test("3206 - partial-rollup closing keyword: a branch padded after `fix.` is not a reference", async () => {
  const { gh, bodies } = fakeGh();
  const result = await rollup(
    "Deadlock Breaker",
    `milestone/fix.${"a".repeat(RUN)}`,
    gh,
  );
  assertEquals(result.outcome, "created");
  assertEquals(bodies.length, 1);
});

Deno.test("3206 - partial-rollup closing keyword: a branch repeating `fix.` is not a reference", async () => {
  const { gh, bodies } = fakeGh();
  const result = await rollup(
    "Deadlock Breaker",
    `milestone/${"fix.".repeat(RUN / 4)}`,
    gh,
  );
  assertEquals(result.outcome, "created");
  assertEquals(bodies.length, 1);
});

Deno.test("3206 - partial-rollup closing keyword: a real reference in the title is still refused", async () => {
  for (const title of ["fixes owner/repo#12", "Closes :  #12", "fixes /r#12"]) {
    const { gh, bodies } = fakeGh();
    const result = await rollup(title, "milestone/x", gh);
    assertEquals(result.outcome, "failed", title);
    assertEquals(bodies, [], title);
  }
});

Deno.test("3206 - sub-issue `parent` link: a padded near miss is skipped and a real link still read", async () => {
  const issues = [
    {
      number: 131,
      url: "https://github.com/org/repo/issues/131",
      body: `Parent${PADDING}\nPart of #130`,
      author: { login: "testbot" },
    },
    {
      number: 132,
      url: "https://github.com/org/repo/issues/132",
      body: `parent${PADDING}`,
      author: { login: "testbot" },
    },
    {
      number: 133,
      url: "https://github.com/org/repo/issues/133",
      body: "Parent :  #130",
      author: { login: "testbot" },
    },
  ];
  const result = await listSubIssuesViaIssueList(
    "org/repo",
    130,
    () => Promise.resolve(JSON.stringify(issues)),
    { fleetAuthors: ["testbot"] },
  );
  assertEquals(result, {
    ok: true,
    value: [
      "https://github.com/org/repo/issues/131",
      "https://github.com/org/repo/issues/133",
    ],
  });
});
