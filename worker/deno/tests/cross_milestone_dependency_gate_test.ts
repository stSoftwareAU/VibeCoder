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
  type DependencyBlocker,
  describeDependencyBlockers,
  isDependencyBlocked,
} from "../lib/issue_finder_common.ts";
import { collectLowPriorityCandidates } from "../lib/collect_low_priority_candidates.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import type { WorkerConfig } from "../types.ts";

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
// Reporting the hold to a human (Issue #2533)
// ---------------------------------------------------------------------------

Deno.test("collected blockers name the milestone holding a closed dependency", async () => {
  const fetcher = makeFetcher(
    "Depends on #2170",
    { [`${REPO}#2170`]: { state: "CLOSED", milestone: "Foundation" } },
  );
  const blockers: DependencyBlocker[] = [];
  assertEquals(
    await isDependencyBlocked(
      REPO,
      CANDIDATE,
      fetcher,
      undefined,
      makeScope("Dependant", ["Foundation", "Dependant"]),
      blockers,
    ),
    true,
  );
  assertEquals(blockers, [{
    repo: REPO,
    number: 2170,
    kind: "depends-on",
    heldByMilestone: "Foundation",
  }]);
  assertEquals(
    describeDependencyBlockers(REPO, blockers),
    "held: dependency #2170 is closed but in open milestone 'Foundation'",
  );
});

Deno.test("an open sub-issue is collected as a child blocker", async () => {
  const fetcher: IssueFetcher = {
    ...makeFetcher("", { [`${REPO}#99`]: { state: "OPEN" } }),
    getSubIssues: () => Promise.resolve([99]),
  };
  const blockers: DependencyBlocker[] = [];
  assertEquals(
    await isDependencyBlocked(
      REPO,
      CANDIDATE,
      fetcher,
      undefined,
      undefined,
      blockers,
    ),
    true,
  );
  assertEquals(blockers, [{ repo: REPO, number: 99, kind: "child" }]);
  assertEquals(
    describeDependencyBlockers(REPO, blockers),
    "blocked by open sub-issue(s): #99",
  );
});

Deno.test("describeDependencyBlockers renders each blocker kind", () => {
  // Nothing held — the caller prints no reason at all.
  assertEquals(describeDependencyBlockers(REPO, []), "");
  assertEquals(
    describeDependencyBlockers(REPO, [
      { repo: REPO, number: 10, kind: "child" },
      { repo: REPO, number: 11, kind: "child" },
      { repo: REPO, number: 12, kind: "depends-on" },
      { repo: "org/dep", number: 7, kind: "depends-on" },
      {
        repo: REPO,
        number: 13,
        kind: "depends-on",
        heldByMilestone: "Foundation",
      },
    ]),
    "blocked by open sub-issue(s): #10, #11; " +
      "depends on #12 which is not resolved; " +
      "depends on org/dep#7 which is not resolved; " +
      "held: dependency #13 is closed but in open milestone 'Foundation'",
  );
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

Deno.test("a merged PR named as a dependency maps to CLOSED with no milestone", async () => {
  // Issue #3218: a dependency reference can be a PR number, and `gh issue
  // view` reports MERGED. The added `milestone` field must not turn that into
  // a cross-milestone hold when the PR carries no milestone.
  const gh = () =>
    Promise.resolve(JSON.stringify({
      number: 2171,
      state: "MERGED",
      title: "The fix",
      milestone: null,
    }));
  const state = await createIssueFetcher(gh).getIssueState(REPO, 2171);
  assertEquals(state.state, "CLOSED");
  assertEquals(state.milestone, null);
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

Deno.test("createOpenMilestoneLookup retries after a failed listing", async () => {
  let attempt = 0;
  const isOpen = createOpenMilestoneLookup(REPO, undefined, () => {
    attempt++;
    return attempt === 1
      ? Promise.reject(new Error("gh api failed"))
      : Promise.resolve(JSON.stringify([{ title: "Foundation" }]));
  });
  await assertRejects(() => Promise.resolve(isOpen("Foundation")));
  // A transient failure is not cached — the next candidate gets a real answer.
  assertEquals(await isOpen("Foundation"), true);
  assertEquals(attempt, 2);
});

// ---------------------------------------------------------------------------
// The scope is actually wired at a collector call site
// ---------------------------------------------------------------------------

/** A worker config with one repo and the low-priority label configured. */
function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: ["owner/repo"],
    allowedAuthors: ["alice"],
    shuffleRepos: false,
    workDir: Deno.makeTempDirSync({ prefix: "cross-milestone-workdir-" }),
  };
}

/**
 * A `gh` stub for one low-priority candidate in milestone "Dependant" whose
 * body names a closed dependency (#10) in milestone "Foundation". Every call
 * is recorded so the test can assert the gate adds no per-candidate call
 * beyond the dependency's own `issue view`.
 */
function createCollectorGh(openMilestones: string[], calls: string[]) {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    calls.push(command);
    if (command.includes("milestones?state=open")) {
      return Promise.resolve(
        JSON.stringify(
          openMilestones.map((title) => ({ title, closed_issues: 1 })),
        ),
      );
    }
    if (command.includes("sub_issues")) return Promise.resolve("[]");
    if (command.includes("issue list")) {
      return Promise.resolve(JSON.stringify([{
        number: 42,
        title: "Dependant work",
        url: "https://github.com/owner/repo/issues/42",
        assignees: [],
        labels: [{ name: "low-priority" }],
        createdAt: "2024-03-01T00:00:00Z",
        author: { login: "alice" },
        milestone: { title: "Dependant" },
      }]));
    }
    if (command.includes("timeline")) {
      return Promise.resolve(JSON.stringify([{
        event: "labeled",
        label: { name: "low-priority" },
        actor: { login: "alice" },
        created_at: "2024-03-01T00:00:00Z",
      }]));
    }
    if (command.includes("issue view 10")) {
      return Promise.resolve(JSON.stringify({
        number: 10,
        state: "CLOSED",
        title: "Foundation work",
        milestone: { title: "Foundation" },
      }));
    }
    if (command.includes("issue view")) {
      return Promise.resolve(JSON.stringify({
        title: "Dependant work",
        body: "Depends on #10",
      }));
    }
    return Promise.resolve("[]");
  };
}

async function collectWithOpenMilestones(
  openMilestones: string[],
  calls: string[],
) {
  const gh = createCollectorGh(openMilestones, calls);
  const cache = new IssueCache(
    Deno.makeTempDirSync({ prefix: "cross-milestone-cache-" }),
    600,
  );
  return await collectLowPriorityCandidates(
    "owner/repo",
    makeConfig(),
    { githubUser: "bot", ghCommandFn: gh, cache },
    [],
    [],
    createIssueFetcher(gh),
    [],
  );
}

Deno.test("a collector holds a candidate whose dependency's milestone is open", async () => {
  const calls: string[] = [];
  const result = await collectWithOpenMilestones(
    ["Foundation", "Dependant"],
    calls,
  );
  assertEquals(result.candidates.length, 0);
  // Exactly one open-milestone listing for the repo, not one per candidate.
  assertEquals(
    calls.filter((c) => c.includes("milestones?state=open")).length,
    1,
  );
});

Deno.test("the same collector releases the candidate once that milestone closes", async () => {
  const calls: string[] = [];
  const result = await collectWithOpenMilestones(["Dependant"], calls);
  assertEquals(result.candidates.length, 1);
  assertEquals(result.candidates[0]?.number, 42);
});
