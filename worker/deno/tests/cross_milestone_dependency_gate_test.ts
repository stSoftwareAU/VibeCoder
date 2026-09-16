/**
 * Tests for the cross-milestone dependency gate (Issue #2173).
 *
 * A sub-issue in milestone A may declare `Depends on #N` where #N is a
 * sub-issue of milestone B. Closing #N is not enough: its code only reaches
 * the default branch — and so the dependant's milestone branch — once
 * milestone B itself closes (its final PR merged). The gate therefore holds
 * the dependant until B is no longer an open milestone. A dependency with no
 * milestone, or one in the candidate's own milestone, is satisfied on close
 * exactly as before.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { IssueFetcher, IssueState } from "../lib/issue_dependencies.ts";
import {
  createIssueFetcher,
  createOpenMilestoneLookup,
  isDependencyBlocked,
} from "../lib/issue_finder_common.ts";

const REPO = "stSoftwareAU/VibeCoder";
const CANDIDATE = 2173;

/** One row of the fetcher's fixed dependency table. */
interface StateRow {
  state: "OPEN" | "CLOSED";
  milestone?: string | null;
}

/** Fetcher over a fixed `repo#number → state/milestone` table. */
function makeFetcher(
  body: string,
  states: Record<string, StateRow>,
  calls: string[] = [],
): IssueFetcher {
  return {
    getIssueBody: () => Promise.resolve(body),
    getSubIssues: () => Promise.resolve([]),
    getIssueState: (repo: string, issueNumber: number) => {
      const key = `${repo}#${issueNumber}`;
      calls.push(key);
      const row = states[key];
      if (!row) return Promise.reject(new Error(`no such issue: ${key}`));
      const value: IssueState = {
        number: issueNumber,
        state: row.state,
        title: key,
        ...(row.milestone === undefined ? {} : { milestone: row.milestone }),
      };
      return Promise.resolve(value);
    },
  };
}

/** A milestone scope over a fixed open-milestone set, recording lookups. */
function makeScope(
  candidateMilestone: string,
  openMilestones: string[],
  lookups: string[] = [],
) {
  return {
    candidateMilestone,
    isMilestoneOpen: (title: string) => {
      lookups.push(title);
      return openMilestones.includes(title);
    },
  };
}

// ---------------------------------------------------------------------------
// The cross-milestone hold
// ---------------------------------------------------------------------------

Deno.test("a closed dependency in another open milestone still blocks", async () => {
  const lookups: string[] = [];
  const fetcher = makeFetcher(
    "Depends on #2170",
    { [`${REPO}#2170`]: { state: "CLOSED", milestone: "Foundation" } },
  );
  assertEquals(
    await isDependencyBlocked(
      REPO,
      CANDIDATE,
      fetcher,
      undefined,
      makeScope("Dependant", ["Foundation", "Dependant"], lookups),
    ),
    true,
  );
  assertEquals(lookups, ["Foundation"]);
});

Deno.test("the dependant is eligible once the dependency's milestone closes", async () => {
  const lookups: string[] = [];
  const fetcher = makeFetcher(
    "Depends on #2170",
    { [`${REPO}#2170`]: { state: "CLOSED", milestone: "Foundation" } },
  );
  // "Foundation" is no longer in the open-milestone set — it has closed.
  assertEquals(
    await isDependencyBlocked(
      REPO,
      CANDIDATE,
      fetcher,
      undefined,
      makeScope("Dependant", ["Dependant"], lookups),
    ),
    false,
  );
  assertEquals(lookups, ["Foundation"]);
});

Deno.test("a closed dependency in the candidate's own milestone does not block", async () => {
  const lookups: string[] = [];
  const fetcher = makeFetcher(
    "Depends on #2170",
    { [`${REPO}#2170`]: { state: "CLOSED", milestone: "Dependant" } },
  );
  assertEquals(
    await isDependencyBlocked(
      REPO,
      CANDIDATE,
      fetcher,
      undefined,
      makeScope("Dependant", ["Dependant"], lookups),
    ),
    false,
  );
  // Same milestone — the open-milestone listing is never consulted.
  assertEquals(lookups, []);
});

Deno.test("a closed dependency with no milestone does not block", async () => {
  const lookups: string[] = [];
  const fetcher = makeFetcher(
    "Depends on #2170",
    { [`${REPO}#2170`]: { state: "CLOSED", milestone: null } },
  );
  assertEquals(
    await isDependencyBlocked(
      REPO,
      CANDIDATE,
      fetcher,
      undefined,
      makeScope("Dependant", ["Foundation"], lookups),
    ),
    false,
  );
  assertEquals(lookups, []);
});

Deno.test("a dependency whose milestone the fetcher does not report does not block", async () => {
  const lookups: string[] = [];
  // No `milestone` field at all — an older cached state entry.
  const fetcher = makeFetcher(
    "Depends on #2170",
    { [`${REPO}#2170`]: { state: "CLOSED" } },
  );
  assertEquals(
    await isDependencyBlocked(
      REPO,
      CANDIDATE,
      fetcher,
      undefined,
      makeScope("Dependant", ["Foundation"], lookups),
    ),
    false,
  );
  assertEquals(lookups, []);
});

Deno.test("without a milestone scope the gate keeps today's behaviour", async () => {
  const fetcher = makeFetcher(
    "Depends on #2170",
    { [`${REPO}#2170`]: { state: "CLOSED", milestone: "Foundation" } },
  );
  assertEquals(await isDependencyBlocked(REPO, CANDIDATE, fetcher), false);
});

Deno.test("an OPEN dependency blocks without consulting the milestone listing", async () => {
  const lookups: string[] = [];
  const fetcher = makeFetcher(
    "Depends on #2170",
    { [`${REPO}#2170`]: { state: "OPEN", milestone: "Foundation" } },
  );
  assertEquals(
    await isDependencyBlocked(
      REPO,
      CANDIDATE,
      fetcher,
      undefined,
      makeScope("Dependant", ["Foundation"], lookups),
    ),
    true,
  );
  assertEquals(lookups, []);
});

Deno.test("a candidate with no dependencies never consults the milestone listing", async () => {
  const lookups: string[] = [];
  const calls: string[] = [];
  const fetcher = makeFetcher("No dependencies here.", {}, calls);
  assertEquals(
    await isDependencyBlocked(
      REPO,
      CANDIDATE,
      fetcher,
      undefined,
      makeScope("Dependant", ["Foundation"], lookups),
    ),
    false,
  );
  assertEquals(lookups, []);
  assertEquals(calls, []);
});

Deno.test("a failed open-milestone lookup fails safe — blocked", async () => {
  const fetcher = makeFetcher(
    "Depends on #2170",
    { [`${REPO}#2170`]: { state: "CLOSED", milestone: "Foundation" } },
  );
  assertEquals(
    await isDependencyBlocked(REPO, CANDIDATE, fetcher, undefined, {
      candidateMilestone: "Dependant",
      isMilestoneOpen: () => Promise.reject(new Error("gh api failed")),
    }),
    true,
  );
});

Deno.test("a cross-repo dependency is not measured against this repo's milestones", async () => {
  const lookups: string[] = [];
  const fetcher = makeFetcher(
    "Depends on org/dep#7",
    { "org/dep#7": { state: "CLOSED", milestone: "Foundation" } },
  );
  // "Foundation" is an open milestone *here*, but the dependency's milestone
  // belongs to another repository's milestone namespace.
  assertEquals(
    await isDependencyBlocked(
      REPO,
      CANDIDATE,
      fetcher,
      undefined,
      makeScope("Dependant", ["Foundation"], lookups),
    ),
    false,
  );
  assertEquals(lookups, []);
});

// ---------------------------------------------------------------------------
// The fetcher carries the milestone
// ---------------------------------------------------------------------------

Deno.test("createIssueFetcher maps the dependency's milestone title", async () => {
  const args: string[][] = [];
  const gh = (a: string[]) => {
    args.push(a);
    return Promise.resolve(JSON.stringify({
      number: 2170,
      state: "CLOSED",
      title: "Foundation work",
      milestone: { title: "Foundation" },
    }));
  };
  const state = await createIssueFetcher(gh).getIssueState(REPO, 2170);
  assertEquals(state.milestone, "Foundation");
  assertEquals(state.state, "CLOSED");
  // The milestone rides the existing per-dependency `issue view` call.
  assertEquals(args.length, 1);
  assertEquals(args[0]?.includes("number,state,title,milestone"), true);
});

Deno.test("createIssueFetcher maps a milestone-less dependency to null", async () => {
  const gh = () =>
    Promise.resolve(JSON.stringify({
      number: 2170,
      state: "CLOSED",
      title: "No milestone",
      milestone: null,
    }));
  const state = await createIssueFetcher(gh).getIssueState(REPO, 2170);
  assertEquals(state.milestone, null);
});

// ---------------------------------------------------------------------------
// The open-milestone lookup
// ---------------------------------------------------------------------------

Deno.test("createOpenMilestoneLookup lists open milestones at most once", async () => {
  const args: string[][] = [];
  const gh = (a: string[]) => {
    args.push(a);
    return Promise.resolve(JSON.stringify([
      { title: "Foundation", closed_issues: 2 },
      { title: "Dependant", closed_issues: 0 },
    ]));
  };
  const isOpen = createOpenMilestoneLookup(REPO, undefined, gh);
  assertEquals(await isOpen("Foundation"), true);
  assertEquals(await isOpen("Dependant"), true);
  assertEquals(await isOpen("Retired"), false);
  assertEquals(args.length, 1);
});

Deno.test("createOpenMilestoneLookup propagates a failed listing", async () => {
  const isOpen = createOpenMilestoneLookup(
    REPO,
    undefined,
    () => Promise.reject(new Error("gh api failed")),
  );
  await assertRejects(() => Promise.resolve(isOpen("Foundation")));
});
