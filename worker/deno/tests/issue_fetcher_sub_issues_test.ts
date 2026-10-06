/**
 * Tests for the GitHub `IssueFetcher.getSubIssues` adapter
 * (`createIssueFetcher` in `issue_finder_common.ts`).
 *
 * Regression coverage for Issue #2470: `getSubIssues` must call the
 * native GitHub sub-issues API, not parse the issue body. Parsing the
 * body re-derived the same task-list references that `checkParentBlocked`
 * already extracts, which silently bypassed the `hasBackReference`
 * guard (FLEET#1472) and mis-blocked work-on issues whose body contained a
 * plain `- [ ] #N` acceptance-criteria checkbox.
 *
 * Also covers Issue #3321: a sub-issues lookup failure (the `gh` call
 * rejecting, empty/unparseable output, or a non-array response) must
 * *reject* rather than answer `[]`, so the parent/child gate fails
 * closed instead of silently reading an unreadable child list as "no
 * children".
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  createIssueFetcher,
  describeDependencyBlockers,
  isDependencyBlocked,
  ISSUE_SUB_ISSUES_CACHE_PREFIX,
} from "../lib/issue_finder_common.ts";
import { checkParentBlocked } from "../lib/issue_dependencies.ts";
import type { DependencyBlocker } from "../lib/issue_dependencies.ts";
import { IssueCache } from "../lib/issue_cache.ts";

// ---------------------------------------------------------------------------
// getSubIssues — uses the native sub-issues API
// ---------------------------------------------------------------------------

Deno.test(
  "getSubIssues - returns [] when the native sub-issues API reports no children, even if the body has task-list checkboxes",
  async () => {
    const calls: string[] = [];
    const ghFn = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      calls.push(command);
      // Native sub-issues API endpoint — no real children.
      if (command.includes("/sub_issues")) {
        return Promise.resolve("[]");
      }
      // The plain issue endpoint carries an acceptance-criteria checkbox
      // that must NOT be treated as a sub-issue.
      return Promise.resolve(
        JSON.stringify({
          body: "- [ ] #484 artefact pipeline still produces valid SVG output",
        }),
      );
    };

    const fetcher = createIssueFetcher(ghFn);
    const subIssues = await fetcher.getSubIssues("owner/repo", 522);

    assertEquals(subIssues, []);
    // Confirms we hit the sub-issues endpoint, not the body-parsing path.
    assertEquals(
      calls.some((c) => c.includes("repos/owner/repo/issues/522/sub_issues")),
      true,
    );
  },
);

Deno.test(
  "getSubIssues - returns the numbers reported by the native sub-issues API",
  async () => {
    const ghFn = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      if (command.includes("/sub_issues")) {
        return Promise.resolve(
          JSON.stringify([
            { number: 101, title: "Child A" },
            { number: 102, title: "Child B" },
          ]),
        );
      }
      return Promise.resolve(JSON.stringify({ body: "" }));
    };

    const fetcher = createIssueFetcher(ghFn);
    const subIssues = await fetcher.getSubIssues("owner/repo", 100);

    assertEquals(subIssues.sort((a, b) => a - b), [101, 102]);
  },
);

Deno.test(
  "getSubIssues - a genuine [] response still returns []",
  async () => {
    const ghFn = (_args: string[]): Promise<string> => Promise.resolve("[]");

    const fetcher = createIssueFetcher(ghFn);
    const subIssues = await fetcher.getSubIssues("owner/repo", 100);

    assertEquals(subIssues, []);
  },
);

Deno.test(
  "getSubIssues - rejects naming the repo#issue when the API call fails (Issue #3321)",
  async () => {
    const ghFn = (_args: string[]): Promise<string> => {
      return Promise.reject(new Error("404 Not Found"));
    };

    const fetcher = createIssueFetcher(ghFn);

    await assertRejects(
      () => fetcher.getSubIssues("owner/repo", 100),
      Error,
      "owner/repo#100",
    );
  },
);

Deno.test(
  "getSubIssues - rejects naming the repo#issue on empty output",
  async () => {
    const ghFn = (_args: string[]): Promise<string> => Promise.resolve("");

    const fetcher = createIssueFetcher(ghFn);

    await assertRejects(
      () => fetcher.getSubIssues("owner/repo", 101),
      Error,
      "owner/repo#101",
    );
  },
);

Deno.test(
  "getSubIssues - rejects naming the repo#issue on whitespace-only output",
  async () => {
    const ghFn = (_args: string[]): Promise<string> => Promise.resolve("  \n");

    const fetcher = createIssueFetcher(ghFn);

    await assertRejects(
      () => fetcher.getSubIssues("owner/repo", 102),
      Error,
      "owner/repo#102",
    );
  },
);

Deno.test(
  "getSubIssues - rejects naming the repo#issue on unparseable output",
  async () => {
    const ghFn = (_args: string[]): Promise<string> =>
      Promise.resolve("not json");

    const fetcher = createIssueFetcher(ghFn);

    await assertRejects(
      () => fetcher.getSubIssues("owner/repo", 103),
      Error,
      "owner/repo#103",
    );
  },
);

Deno.test(
  "getSubIssues - rejects naming the repo#issue on a non-array JSON response",
  async () => {
    const ghFn = (_args: string[]): Promise<string> =>
      Promise.resolve(JSON.stringify({ message: "Not Found" }));

    const fetcher = createIssueFetcher(ghFn);

    await assertRejects(
      () => fetcher.getSubIssues("owner/repo", 104),
      Error,
      "owner/repo#104",
    );
  },
);

Deno.test(
  "getSubIssues - a failed lookup is not cached; the next call re-fetches (Issue #3321)",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      const cache = new IssueCache(dir, 600);
      let callCount = 0;
      const ghFn = (args: string[]): Promise<string> => {
        const command = args.join(" ");
        if (command.includes("/sub_issues")) {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error("transient 502"));
          }
          return Promise.resolve(JSON.stringify([{ number: 5 }]));
        }
        return Promise.resolve("[]");
      };

      const fetcher = createIssueFetcher(ghFn, cache);

      await assertRejects(() => fetcher.getSubIssues("owner/repo", 300));
      assertEquals(callCount, 1);

      // Nothing was written by the failed call.
      assertEquals(
        await cache.read("owner/repo", `${ISSUE_SUB_ISSUES_CACHE_PREFIX}300`),
        null,
      );

      const subIssues = await fetcher.getSubIssues("owner/repo", 300);
      assertEquals(subIssues, [5]);
      assertEquals(callCount, 2, "the failure was not cached — re-fetched");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// checkParentBlocked — the end-to-end private-repo-18#522 scenario
// ---------------------------------------------------------------------------

Deno.test(
  "checkParentBlocked - work-on issue with only a task-list checkbox and no native children is NOT blocked (Issue #2470)",
  async () => {
    // Reproduces stSoftwareAU/private-repo-18#522: body has a single
    // acceptance-criteria checkbox `- [ ] #484 …`, but #484 is not a
    // genuine sub-issue (no back-reference) and the native sub-issues
    // API reports no children.
    const body522 =
      "## Acceptance criteria\n- [ ] #484 artefact pipeline still produces valid SVG output";
    const body484 = "Some unrelated issue with no back-reference to #522.";

    const ghFn = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      // Native sub-issues API: #522 has no real children.
      if (command.includes("/sub_issues")) {
        return Promise.resolve("[]");
      }
      // getIssueBody(repo, 522) and getIssueBody(repo, 484).
      if (command.includes("issue view") && command.includes("body")) {
        if (command.includes("484")) {
          return Promise.resolve(JSON.stringify({ body: body484 }));
        }
        return Promise.resolve(JSON.stringify({ body: body522 }));
      }
      // getIssueState — #484 happens to be open, but it is not a child.
      if (command.includes("number,state,title")) {
        return Promise.resolve(
          JSON.stringify({ number: 484, state: "OPEN", title: "Not a child" }),
        );
      }
      return Promise.resolve("[]");
    };

    const fetcher = createIssueFetcher(ghFn);
    const result = await checkParentBlocked(fetcher, "owner/repo", 522);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.isBlocked, false);
      assertEquals(result.value.openChildren, []);
      assertEquals(result.value.totalChildren, 0);
    }
  },
);

Deno.test(
  "checkParentBlocked - genuine parent with an open native child IS blocked",
  async () => {
    const ghFn = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      if (command.includes("/sub_issues")) {
        return Promise.resolve(JSON.stringify([{ number: 200 }]));
      }
      if (command.includes("issue view") && command.includes("body")) {
        return Promise.resolve(JSON.stringify({ body: "Parent issue" }));
      }
      if (command.includes("number,state,title")) {
        return Promise.resolve(
          JSON.stringify({ number: 200, state: "OPEN", title: "Child" }),
        );
      }
      return Promise.resolve("[]");
    };

    const fetcher = createIssueFetcher(ghFn);
    const result = await checkParentBlocked(fetcher, "owner/repo", 199);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.isBlocked, true);
      assertEquals(result.value.openChildren, [200]);
    }
  },
);

// ---------------------------------------------------------------------------
// isDependencyBlocked — the parent/child gate fails closed on an unreadable
// sub-issues lookup (Issue #3321)
// ---------------------------------------------------------------------------

/** A fetcher whose body carries no dependency references at all. */
function noDependencyGhFn(
  subIssuesFn: (args: string[]) => Promise<string>,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (command.includes("/sub_issues")) {
      return subIssuesFn(args);
    }
    if (command.includes("issue view") && command.includes("body")) {
      return Promise.resolve(
        JSON.stringify({ body: "No dependencies here." }),
      );
    }
    return Promise.resolve("[]");
  };
}

Deno.test(
  "isDependencyBlocked - reports blocked when the parent's sub-issues call throws (Issue #3321)",
  async () => {
    const ghFn = noDependencyGhFn(() =>
      Promise.reject(new Error("502 Bad Gateway"))
    );
    const fetcher = createIssueFetcher(ghFn);

    assertEquals(await isDependencyBlocked("owner/repo", 522, fetcher), true);
  },
);

Deno.test(
  "isDependencyBlocked - reports blocked when the parent's sub-issues call returns empty output (Issue #3321)",
  async () => {
    const ghFn = noDependencyGhFn(() => Promise.resolve(""));
    const fetcher = createIssueFetcher(ghFn);

    assertEquals(await isDependencyBlocked("owner/repo", 522, fetcher), true);
  },
);

Deno.test(
  "isDependencyBlocked - a genuine [] sub-issues response with no dependencies is NOT blocked (control for the regression above)",
  async () => {
    const ghFn = noDependencyGhFn(() => Promise.resolve("[]"));
    const fetcher = createIssueFetcher(ghFn);

    assertEquals(await isDependencyBlocked("owner/repo", 522, fetcher), false);
  },
);

Deno.test(
  "isDependencyBlocked - collects an 'unreadable-children' blocker when blockers[] is supplied, and describeDependencyBlockers names it (Issue #3321)",
  async () => {
    const ghFn = noDependencyGhFn(() =>
      Promise.reject(new Error("502 Bad Gateway"))
    );
    const fetcher = createIssueFetcher(ghFn);

    const blockers: DependencyBlocker[] = [];
    const blocked = await isDependencyBlocked(
      "owner/repo",
      522,
      fetcher,
      undefined,
      undefined,
      blockers,
    );

    assertEquals(blocked, true);
    assertEquals(blockers, [
      { repo: "owner/repo", number: 522, kind: "unreadable-children" },
    ]);

    const description = describeDependencyBlockers("owner/repo", blockers);
    assertEquals(description.includes("could not be read"), true);
    assertEquals(description.includes("#522"), true);
  },
);
