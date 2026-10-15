/**
 * Tests for bounded open-milestone pagination (Issue #3609).
 *
 * The unit tests drive `fetchOpenMilestonePages` directly. The integration
 * tests drive `checkAndHandleMilestoneCompletions` so the completion scan is
 * shown to reach a milestone that sits on the second page.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  checkAndHandleMilestoneCompletions,
  type MilestoneCompletionDeps,
} from "../lib/milestone_completion.ts";
import {
  buildOpenMilestonesPageArgs,
  fetchOpenMilestonePages,
  MAX_MILESTONE_PAGES,
  MILESTONES_PER_PAGE,
} from "../lib/open_milestone_pages.ts";

/** A JSON array of `n` milestone objects numbered from `start`. */
function milestonePage(n: number, start = 1): string {
  return JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      title: `m${start + i}`,
      number: start + i,
      open_issues: 1,
      closed_issues: 0,
      state: "open",
    })),
  );
}

/** A gh stub that serves the given pages in order and records the args. */
function pagingGh(pages: string[]) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const match = /[?&]page=(\d+)/.exec(args[1] ?? "");
    const index = match ? Number(match[1]) - 1 : 0;
    return Promise.resolve(pages[index] ?? "[]");
  };
  return { fn, calls };
}

/** The page numbers a `pagingGh` stub was asked for, in call order. */
function requestedPages(calls: string[][]): number[] {
  return calls.map((args) => {
    const match = /[?&]page=(\d+)/.exec(args[1] ?? "");
    return match ? Number(match[1]) : NaN;
  });
}

Deno.test("open_milestone_pages - buildOpenMilestonesPageArgs requests open milestones at the page size", () => {
  const args = buildOpenMilestonesPageArgs("owner/repo", 3);
  assertEquals(args[0], "api");
  assertEquals(
    args[1],
    `repos/owner/repo/milestones?state=open&per_page=${MILESTONES_PER_PAGE}&page=3`,
  );
  assertStringIncludes(args[1] ?? "", "state=open");
  assertStringIncludes(args[1] ?? "", "per_page=100");
  assertStringIncludes(args[1] ?? "", "page=3");
});

Deno.test("open_milestone_pages - single short page returns its milestones after one call", async () => {
  const { fn, calls } = pagingGh([milestonePage(2)]);
  const logs: string[] = [];
  const milestones = await fetchOpenMilestonePages(
    "owner/repo",
    fn,
    (m) => logs.push(m),
  );
  assertEquals(milestones.length, 2);
  assertEquals(calls.length, 1, "a short page is the last page");
  assertEquals(logs, []);
});

Deno.test("open_milestone_pages - follows pages until a short page, in order", async () => {
  const { fn, calls } = pagingGh([
    milestonePage(MILESTONES_PER_PAGE, 1),
    milestonePage(3, MILESTONES_PER_PAGE + 1),
  ]);
  const milestones = await fetchOpenMilestonePages(
    "owner/repo",
    fn,
    () => {},
  );
  const numbers = milestones.map((m) => (m as { number: number }).number);
  assertEquals(numbers.length, MILESTONES_PER_PAGE + 3);
  assertEquals(
    numbers,
    Array.from({ length: MILESTONES_PER_PAGE + 3 }, (_, i) => i + 1),
  );
  assertEquals(calls.length, 2);
  assertEquals(requestedPages(calls), [1, 2]);
});

Deno.test("open_milestone_pages - cap stops at MAX_MILESTONE_PAGES and logs one WARNING", async () => {
  const fullPage = milestonePage(MILESTONES_PER_PAGE);
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    return Promise.resolve(fullPage);
  };
  const logs: string[] = [];
  const milestones = await fetchOpenMilestonePages(
    "owner/repo",
    fn,
    (m) => logs.push(m),
  );
  assertEquals(milestones.length, MAX_MILESTONE_PAGES * MILESTONES_PER_PAGE);
  assertEquals(
    calls.length,
    MAX_MILESTONE_PAGES,
    "must never request page MAX + 1",
  );
  const warnings = logs.filter((line) => line.includes("WARNING"));
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0] ?? "", "owner/repo");
  assertStringIncludes(warnings[0] ?? "", "Issue #3609");
});

Deno.test("open_milestone_pages - empty body on page 1 returns no milestones", async () => {
  const { fn, calls } = pagingGh(["   \n"]);
  const milestones = await fetchOpenMilestonePages(
    "owner/repo",
    fn,
    () => {},
  );
  assertEquals(milestones, []);
  assertEquals(calls.length, 1);
});

Deno.test("open_milestone_pages - non-array body is rejected", async () => {
  const { fn } = pagingGh([`{"message":"Not Found"}`]);
  await assertRejects(
    () => fetchOpenMilestonePages("owner/repo", fn, () => {}),
    Error,
    "Expected a milestones array",
  );
});

Deno.test("open_milestone_pages - a failed second page rejects rather than returning the partial listing", async () => {
  const fullPage = milestonePage(MILESTONES_PER_PAGE);
  const fn = (args: string[]): Promise<string> => {
    if (/[?&]page=2\b/.test(args[1] ?? "")) {
      return Promise.reject(new Error("gh failed on page 2"));
    }
    return Promise.resolve(fullPage);
  };
  await assertRejects(
    () => fetchOpenMilestonePages("owner/repo", fn, () => {}),
    Error,
    "gh failed on page 2",
  );
});

// ============================================================================
// Integration: the completion scan reaches a milestone on page 2 (Issue #3609)
// ============================================================================

/**
 * Serve the two fresh authoritative open-children reads added in Issue #3908:
 * `GET repos/<repo>/milestones/<n>` and
 * `GET repos/<repo>/issues?milestone=<n>&state=open`.
 *
 * Returns null when `key` is neither, so a stub can fall through to its own
 * branches. Defaults describe a milestone GitHub agrees is complete. The
 * milestone-close PATCH (`api -X PATCH .../milestones/<n> -f state=closed`)
 * does not match — only the bare GET does.
 */
function authoritativeStub(
  key: string,
  openIssues = 0,
  children: unknown[] = [],
): string | null {
  if (key.includes("/issues?milestone=")) return JSON.stringify(children);
  if (/api repos\/[^ ]+\/milestones\/\d+$/.test(key)) {
    return JSON.stringify({ open_issues: openIssues });
  }
  return null;
}

function createMockDeps(
  overrides: Partial<MilestoneCompletionDeps> = {},
): MilestoneCompletionDeps {
  return {
    repos: ["owner/repo"],
    ghCommandFn: async (_args: string[]) => "[]",
    log: (_msg: string) => {},
    authorOptions: { fleetAuthors: ["bot"] },
    ...overrides,
  };
}

/** Whether a `gh` call is the open-milestones list (any page, or unpaged). */
function isMilestoneListKey(key: string): boolean {
  return /\/milestones\?/.test(key) || key.endsWith("/milestones");
}

Deno.test(
  "checkAndHandleMilestoneCompletions - processes a milestone on the second page of open milestones (Issue #3609)",
  async () => {
    const createdIssues: { title: string }[] = [];
    const createdPrs: { title: string }[] = [];

    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      const authoritative = authoritativeStub(key);
      if (authoritative !== null) return authoritative;

      if (isMilestoneListKey(key)) {
        if (key.includes("page=2")) {
          return JSON.stringify([
            {
              title: "v2.0",
              number: 3,
              open_issues: 0,
              closed_issues: 1,
              state: "open",
            },
          ]);
        }
        // Page 1: a full page of idle-task milestones with open issues, which
        // the scan skips, so the completable milestone is only on page 2.
        return JSON.stringify(
          Array.from({ length: MILESTONES_PER_PAGE }, (_, i) => ({
            title: `idle-task: filler-${i}`,
            number: 100 + i,
            open_issues: 1,
            closed_issues: 0,
            state: "open",
          })),
        );
      }
      if (key.includes("api repos/") && key.includes(".default_branch")) {
        return "main";
      }
      if (
        key.includes("issue list") && key.includes("--state open") &&
        key.includes("--milestone")
      ) {
        return "[]";
      }
      if (key.includes("issue list") && key.includes("--state closed")) {
        return JSON.stringify([
          { number: 11, title: "real work", milestone: { title: "v2.0" } },
        ]);
      }
      if (
        key.includes("issue list") && key.includes("--state all") &&
        key.includes("--milestone")
      ) {
        return "[]";
      }
      if (key.includes("pr list") && key.includes("--state all")) {
        return "[]";
      }
      if (key.includes("api") && key.includes("/branches/milestone")) {
        return JSON.stringify({ name: "milestone/v2-0" });
      }
      if (key.includes("issue create")) {
        const titleIdx = args.indexOf("--title");
        createdIssues.push({ title: args[titleIdx + 1] ?? "" });
        return "https://github.com/owner/repo/issues/300";
      }
      if (key.includes("pr create")) {
        const titleIdx = args.indexOf("--title");
        createdPrs.push({ title: args[titleIdx + 1] ?? "" });
        return "https://github.com/owner/repo/pull/301";
      }
      if (key.includes("issue close")) {
        return "";
      }
      return "[]";
    };

    const deps = createMockDeps({ ghCommandFn: ghFn });
    const result = await checkAndHandleMilestoneCompletions(deps);
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.summaryPrsCreated, 1);
    assertEquals(createdPrs.length, 1);
    assertStringIncludes(createdPrs[0]?.title ?? "", "v2.0");
    assertEquals(createdIssues.length, 1);
  },
);

Deno.test(
  "checkAndHandleMilestoneCompletions - a failed open-milestone listing is logged and the scan returns ok (Issue #3609)",
  async () => {
    const logs: string[] = [];
    const ghFn = async (args: string[]): Promise<string> => {
      const key = args.join(" ");
      const authoritative = authoritativeStub(key);
      if (authoritative !== null) return authoritative;

      if (isMilestoneListKey(key)) {
        throw new Error("HTTP 500 from milestones endpoint");
      }
      if (key.includes("api repos/") && key.includes(".default_branch")) {
        return "main";
      }
      return "[]";
    };

    const deps = createMockDeps({
      ghCommandFn: ghFn,
      log: (msg: string) => logs.push(msg),
    });
    const result = await checkAndHandleMilestoneCompletions(deps);
    assertEquals(result.ok, true);
    assertEquals(
      logs.some((line) =>
        line.includes("could not list open milestones for owner/repo")
      ),
      true,
    );
  },
);
