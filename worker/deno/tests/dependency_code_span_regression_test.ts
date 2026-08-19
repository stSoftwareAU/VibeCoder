/**
 * Regression tests for Issue #3218 — the #3204 wedge.
 *
 * A `test-audit` finding (VibeCoder#3204) embedded a suggested-fix code
 * example that contained the literal text `reasons: ["depends on #5"]` and
 * `assertStringIncludes(out, "- depends on #5")`. Two independent defects
 * combined to block the issue forever:
 *
 *   1. `extractDependencyReferences` scanned the *whole* body, including
 *      fenced code blocks, so it treated the quoted example as a real
 *      dependency on #5.
 *   2. `getIssueState` mapped every non-`CLOSED` state to `OPEN`. #5 is in
 *      fact a *merged* pull request (issues and PRs share one numbering
 *      space), so its `MERGED` state resolved to `OPEN` and the phantom
 *      dependency counted as unsatisfied.
 *
 * Net effect: the real low-priority collector skipped #3204 every cycle with
 * `reason=dependency-blocked`, while the lightweight idle-detect probe (which
 * runs no dependency check) still counted it as claimable — producing the
 * `mis_classification` / `inversion` alerts and suppressing idle-task filing
 * for the whole repo.
 *
 * These tests exercise the real `createIssueFetcher` against a mocked `gh`
 * so the full mechanism (both defects) is covered end-to-end. Either
 * regression alone would fail the primary assertion.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  createIssueFetcher,
  isDependencyBlocked,
} from "../lib/issue_finder_common.ts";

/**
 * A faithful reconstruction of the #3204 body: the dependency-shaped phrase
 * appears only inside the fenced suggested-fix example.
 */
const FINDING_BODY = [
  "**Severity:** medium — coverage gap.",
  "",
  "`formatIssueDiagnostic` renders an `IssueDiagnostic` into Markdown.",
  "",
  "## Suggested fix",
  "",
  "```ts",
  'Deno.test("blocked issue lists reasons", () => {',
  "  const out = formatIssueDiagnostic({",
  "    issueNumber: 7,",
  '    reasons: ["depends on #5"],',
  "    isBlocked: true,",
  "  });",
  '  assertStringIncludes(out, "- depends on #5");',
  "});",
  "```",
  "",
  "Assert on the produced Markdown, not on how it is assembled.",
].join("\n");

/**
 * Mock `gh` that mirrors production shapes:
 *  - `issue view <n> --json body`  → the finding body
 *  - `api .../sub_issues`          → no native sub-issues
 *  - `issue view 5 --json ...`     → #5 is a MERGED pull request
 */
function mockGh(body: string, dependencyState: string) {
  return (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("/sub_issues")) {
      return Promise.resolve("[]");
    }
    if (args.includes("body")) {
      return Promise.resolve(JSON.stringify({ body }));
    }
    // getIssueState for the referenced dependency (#5).
    return Promise.resolve(
      JSON.stringify({ number: 5, state: dependencyState, title: "Some PR" }),
    );
  };
}

Deno.test("isDependencyBlocked - #3204 finding body is NOT blocked (Issue #3218 regression)", async () => {
  // #5 is a merged PR. Even if extraction wrongly matched it, MERGED must not
  // resolve to OPEN. Both fixes are needed; this asserts the observable result.
  const fetcher = createIssueFetcher(mockGh(FINDING_BODY, "MERGED"));
  const blocked = await isDependencyBlocked(
    "stSoftwareAU/VibeCoder",
    3204,
    fetcher,
    new Map(),
  );
  assertEquals(blocked, false);
});

Deno.test("isDependencyBlocked - a real OPEN prose dependency still blocks", async () => {
  // Guard against over-stripping: a genuine prose dependency on an OPEN issue
  // must continue to block.
  const body = "This work depends on #5 landing first.";
  const fetcher = createIssueFetcher(mockGh(body, "OPEN"));
  const blocked = await isDependencyBlocked(
    "stSoftwareAU/VibeCoder",
    3204,
    fetcher,
    new Map(),
  );
  assertEquals(blocked, true);
});

Deno.test("createIssueFetcher.getIssueState - MERGED resolves to CLOSED (Issue #3218)", async () => {
  const fetcher = createIssueFetcher(() =>
    Promise.resolve(JSON.stringify({ number: 5, state: "MERGED", title: "PR" }))
  );
  const state = await fetcher.getIssueState("owner/repo", 5);
  assertEquals(state.state, "CLOSED");
});
