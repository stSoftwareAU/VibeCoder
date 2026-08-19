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
import { createIssueFetcher } from "../lib/issue_finder_common.ts";
import { checkParentBlocked } from "../lib/issue_dependencies.ts";

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
