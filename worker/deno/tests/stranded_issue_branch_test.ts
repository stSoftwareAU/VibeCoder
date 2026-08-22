/**
 * Tests for stranded-work detection in the merged-PR pre-check (Issue #174).
 *
 * The pre-check closes an issue whenever the linker finds a merged PR for it.
 * On VibeCoder#42 that PR was a human's partial one and the real work sat
 * unpublished on a pushed branch — and because the pre-check runs on every
 * claim, re-opening the issue by hand got it closed again.
 *
 * This module is the guard. It fails **safe toward not closing**: every
 * lookup failure reports the branch as possibly stranded, because the cost of
 * being wrong that way is one issue left open, against commits discarded in
 * the other.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  describeStrandedBranches,
  findStrandedIssueBranches,
  isIssueBranchRef,
} from "../lib/stranded_issue_branch.ts";

const OURS = "issue-42-primary-graphql-quota-exhaustion-is-swallowed-by-t";

/** A scripted `gh` whose replies are chosen by matching the argv. */
function gh(routes: { match: RegExp; reply: string | Error }[]) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    for (const r of routes) {
      if (r.match.test(joined)) {
        return r.reply instanceof Error
          ? Promise.reject(r.reply)
          : Promise.resolve(r.reply);
      }
    }
    return Promise.reject(new Error(`unrouted gh call: ${joined}`));
  };
  return { fn, calls };
}

const DEFAULT_BRANCH = { match: /repo view/, reply: "main" };

// ===========================================================================
// isIssueBranchRef
// ===========================================================================

Deno.test("isIssueBranchRef - matches the bare and slugged forms", () => {
  assert(isIssueBranchRef("refs/heads/issue-42", 42));
  assert(isIssueBranchRef("refs/heads/issue-42-some-slug", 42));
  assert(isIssueBranchRef("issue-42-some-slug", 42));
});

Deno.test("isIssueBranchRef - does not match a longer issue number (Issue #174)", () => {
  // `matching-refs/heads/issue-42` returns issue-420 too; a plain prefix
  // test would treat another issue's work as this issue's.
  assert(!isIssueBranchRef("refs/heads/issue-420", 42));
  assert(!isIssueBranchRef("refs/heads/issue-420-other", 42));
});

Deno.test("isIssueBranchRef - does not match an unrelated branch", () => {
  assert(!isIssueBranchRef("refs/heads/main", 42));
  assert(!isIssueBranchRef("refs/heads/fix-issue-42", 42));
});

// ===========================================================================
// findStrandedIssueBranches
// ===========================================================================

Deno.test("stranded #174 - a branch ahead of base with no open PR is stranded", () => {
  const { fn } = gh([
    { match: /matching-refs/, reply: `refs/heads/${OURS}` },
    DEFAULT_BRANCH,
    { match: /compare/, reply: "3" },
    { match: /pr list/, reply: "[]" },
  ]);
  return findStrandedIssueBranches({ repo: "o/r", issueNumber: 42, ghFn: fn })
    .then((s) => {
      assertEquals(s.length, 1);
      assertEquals(s[0]?.branch, OURS);
      assertEquals(s[0]?.aheadBy, 3);
      assertEquals(s[0]?.reason, "ahead-with-no-open-pr");
    });
});

Deno.test("stranded - a branch level with base is not stranded", async () => {
  const { fn } = gh([
    { match: /matching-refs/, reply: `refs/heads/${OURS}` },
    DEFAULT_BRANCH,
    { match: /compare/, reply: "0" },
  ]);
  assertEquals(
    (await findStrandedIssueBranches({
      repo: "o/r",
      issueNumber: 42,
      ghFn: fn,
    }))
      .length,
    0,
  );
});

Deno.test("stranded - a branch that already has an open PR is not stranded", async () => {
  const { fn } = gh([
    { match: /matching-refs/, reply: `refs/heads/${OURS}` },
    DEFAULT_BRANCH,
    { match: /compare/, reply: "3" },
    { match: /pr list/, reply: '[{"number":176}]' },
  ]);
  assertEquals(
    (await findStrandedIssueBranches({
      repo: "o/r",
      issueNumber: 42,
      ghFn: fn,
    }))
      .length,
    0,
  );
});

Deno.test("stranded - no branches at all means nothing to protect", async () => {
  const { fn } = gh([{ match: /matching-refs/, reply: "" }]);
  assertEquals(
    (await findStrandedIssueBranches({
      repo: "o/r",
      issueNumber: 42,
      ghFn: fn,
    }))
      .length,
    0,
  );
});

Deno.test("stranded - a failed compare reports the branch, it does not clear it", async () => {
  const warnings: string[] = [];
  const { fn } = gh([
    { match: /matching-refs/, reply: `refs/heads/${OURS}` },
    DEFAULT_BRANCH,
    { match: /compare/, reply: new Error("HTTP 502") },
  ]);
  const s = await findStrandedIssueBranches({
    repo: "o/r",
    issueNumber: 42,
    ghFn: fn,
    warn: (m) => warnings.push(m),
  });
  assertEquals(s.length, 1);
  assertEquals(s[0]?.reason, "comparison-failed");
  assert(warnings.some((w) => w.includes("could not compare")));
});

Deno.test("stranded - a failed open-PR check does not read as 'there is a PR'", async () => {
  const { fn } = gh([
    { match: /matching-refs/, reply: `refs/heads/${OURS}` },
    DEFAULT_BRANCH,
    { match: /compare/, reply: "2" },
    { match: /pr list/, reply: new Error("HTTP 403") },
  ]);
  const s = await findStrandedIssueBranches({
    repo: "o/r",
    issueNumber: 42,
    ghFn: fn,
  });
  assertEquals(s.length, 1, "unproven must not clear the branch");
});

Deno.test("stranded - an unresolvable default branch reports every candidate", async () => {
  const { fn } = gh([
    {
      match: /matching-refs/,
      reply: `refs/heads/${OURS}\nrefs/heads/issue-42-b`,
    },
    { match: /repo view/, reply: new Error("no such repo") },
  ]);
  const s = await findStrandedIssueBranches({
    repo: "o/r",
    issueNumber: 42,
    ghFn: fn,
  });
  assertEquals(s.length, 2);
  assert(s.every((b) => b.reason === "comparison-failed"));
});

Deno.test("stranded - a failed branch listing clears nothing and closes nothing", async () => {
  // Distinct from "no branches": we could not look, so we report none and the
  // caller proceeds. Logged, never silent.
  const warnings: string[] = [];
  const { fn } = gh([{ match: /matching-refs/, reply: new Error("HTTP 500") }]);
  const s = await findStrandedIssueBranches({
    repo: "o/r",
    issueNumber: 42,
    ghFn: fn,
    warn: (m) => warnings.push(m),
  });
  assertEquals(s.length, 0);
  assert(warnings.some((w) => w.includes("could not list branches")));
});

Deno.test("stranded - a supplied base branch skips the repo lookup", async () => {
  const { fn, calls } = gh([
    { match: /matching-refs/, reply: `refs/heads/${OURS}` },
    { match: /compare/, reply: "1" },
    { match: /pr list/, reply: "[]" },
  ]);
  await findStrandedIssueBranches({
    repo: "o/r",
    issueNumber: 42,
    baseBranch: "Develop",
    ghFn: fn,
  });
  assert(!calls.some((c) => c.join(" ").includes("repo view")));
  assert(calls.some((c) => c.join(" ").includes("Develop...")));
});

Deno.test("describeStrandedBranches - names each branch and its state", () => {
  const line = describeStrandedBranches([
    { branch: OURS, aheadBy: 3, reason: "ahead-with-no-open-pr" },
    { branch: "issue-42-b", aheadBy: null, reason: "comparison-failed" },
  ]);
  assertEquals(line, `${OURS} (+3), issue-42-b (comparison failed)`);
});
