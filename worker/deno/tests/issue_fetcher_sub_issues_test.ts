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
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  createIssueFetcher,
  ISSUE_SUB_ISSUES_CACHE_PREFIX,
} from "../lib/issue_finder_common.ts";
import { checkParentBlocked } from "../lib/issue_dependencies.ts";
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
            {
              number: 101,
              repository_url: "https://api.github.com/repos/owner/repo",
            },
            {
              number: 102,
              repository_url: "https://api.github.com/repos/owner/repo",
            },
          ]) + "\n",
        );
      }
      return Promise.resolve(JSON.stringify({ body: "" }));
    };

    const fetcher = createIssueFetcher(ghFn);
    const subIssues = await fetcher.getSubIssues("owner/repo", 100);

    assertEquals(
      subIssues.sort((a, b) => a.number - b.number),
      [
        { repo: "owner/repo", number: 101 },
        { repo: "owner/repo", number: 102 },
      ],
    );
  },
);

Deno.test(
  "getSubIssues - returns [] when the API call fails",
  async () => {
    const ghFn = (_args: string[]): Promise<string> => {
      return Promise.reject(new Error("404 Not Found"));
    };

    const fetcher = createIssueFetcher(ghFn);
    const subIssues = await fetcher.getSubIssues("owner/repo", 100);

    assertEquals(subIssues, []);
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
        return Promise.resolve(
          JSON.stringify([
            {
              number: 200,
              repository_url: "https://api.github.com/repos/owner/repo",
            },
          ]) + "\n",
        );
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
      assertEquals(result.value.openChildren, [
        { repo: "owner/repo", number: 200 },
      ]);
    }
  },
);

Deno.test(
  "checkParentBlocked - a parent with more than 30 children is not truncated, across paginated pages (Issue #3319)",
  async () => {
    // `--paginate` makes `gh` itself issue the follow-up requests and apply
    // the `--jq` filter per page, so the stdout this fetcher sees is already
    // the full multi-line payload — one JSON array per page. Thirty-five
    // children split across two page lines (#101-#130, then #131-#135)
    // exercises both "more than the old 30-item default page" and "more
    // than one page line to merge".
    const page1 = JSON.stringify(
      Array.from({ length: 30 }, (_, i) => ({
        number: 101 + i,
        repository_url: "https://api.github.com/repos/owner/repo",
      })),
    );
    const page2 = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({
        number: 131 + i,
        repository_url: "https://api.github.com/repos/owner/repo",
      })),
    );

    const subIssuesCalls: string[][] = [];
    const ghFn = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      if (command.includes("/sub_issues")) {
        subIssuesCalls.push(args);
        return Promise.resolve(`${page1}\n${page2}\n`);
      }
      if (command.includes("issue view") && command.includes("body")) {
        return Promise.resolve(JSON.stringify({ body: "Parent issue" }));
      }
      if (command.includes("number,state,title")) {
        const n = Number(args[2]);
        // #101-#134 closed, #135 the lone open child.
        const state = n === 135 ? "OPEN" : "CLOSED";
        return Promise.resolve(
          JSON.stringify({ number: n, state, title: `Child ${n}` }),
        );
      }
      return Promise.resolve("[]");
    };

    const fetcher = createIssueFetcher(ghFn);
    const result = await checkParentBlocked(fetcher, "owner/repo", 1);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.isBlocked, true);
      assertEquals(result.value.openChildren, [
        { repo: "owner/repo", number: 135 },
      ]);
      assertEquals(result.value.totalChildren, 35);
    }

    assertEquals(subIssuesCalls.length, 1);
    const argv = subIssuesCalls[0]!;
    assertEquals(argv.includes("--paginate"), true);
    assertEquals(argv.some((a) => a.includes("per_page=100")), true);
  },
);

// ---------------------------------------------------------------------------
// getSubIssues — a malformed/old-shaped cache entry is never trusted
// (Issue #3325: the payload moved from number[] to SubIssueRef[], so a
// cache entry a relaunching worker's old code wrote before the cache key
// was bumped must not be read back and handed to checkParentBlocked).
// ---------------------------------------------------------------------------

Deno.test(
  "getSubIssues - a v1-shaped (number[]) cache hit under the current key is rejected, forcing a live read",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      const cache = new IssueCache(dir, 600);
      // Simulate a stale/corrupt entry: the old shape, written under the
      // (hypothetically reused) current key.
      await cache.write(
        "owner/repo",
        `${ISSUE_SUB_ISSUES_CACHE_PREFIX}300`,
        [7, 8],
      );

      let liveCalls = 0;
      const ghFn = (args: string[]): Promise<string> => {
        if (args.join(" ").includes("/sub_issues")) {
          liveCalls++;
          return Promise.resolve(
            JSON.stringify([
              {
                number: 9,
                repository_url: "https://api.github.com/repos/owner/repo",
              },
            ]) + "\n",
          );
        }
        return Promise.resolve(JSON.stringify({ body: "" }));
      };

      const fetcher = createIssueFetcher(ghFn, cache);
      const subIssues = await fetcher.getSubIssues("owner/repo", 300);

      assertEquals(liveCalls, 1, "the malformed hit must not be trusted");
      assertEquals(subIssues, [{ repo: "owner/repo", number: 9 }]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "checkParentBlocked - still blocks on an open child when the sub-issues cache holds a v1-shaped entry",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      const cache = new IssueCache(dir, 600);
      await cache.write(
        "owner/repo",
        `${ISSUE_SUB_ISSUES_CACHE_PREFIX}400`,
        [500],
      );

      const ghFn = (args: string[]): Promise<string> => {
        const command = args.join(" ");
        if (command.includes("/sub_issues")) {
          return Promise.resolve(
            JSON.stringify([
              {
                number: 500,
                repository_url: "https://api.github.com/repos/owner/repo",
              },
            ]) + "\n",
          );
        }
        if (command.includes("issue view") && command.includes("body")) {
          return Promise.resolve(JSON.stringify({ body: "Parent issue" }));
        }
        if (command.includes("number,state,title")) {
          return Promise.resolve(
            JSON.stringify({ number: 500, state: "OPEN", title: "Child" }),
          );
        }
        return Promise.resolve("[]");
      };

      const fetcher = createIssueFetcher(ghFn, cache);
      const result = await checkParentBlocked(fetcher, "owner/repo", 400);

      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value.isBlocked, true);
        assertEquals(result.value.openChildren, [
          { repo: "owner/repo", number: 500 },
        ]);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
