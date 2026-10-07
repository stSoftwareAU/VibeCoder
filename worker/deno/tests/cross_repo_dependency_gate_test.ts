/**
 * Tests for cross-repo forward dependencies (Issue #222).
 *
 * A deferred issue records `Depends on owner/repo#N`. The gate must resolve
 * that reference against **its own** repo: before this change the cross-repo
 * form matched nothing at all, so a blocked issue was re-claimed immediately.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkParentBlocked,
  extractDependencyReferences,
  extractDependencyReferencesDetailed,
  formatParentBlockedMessage,
} from "../lib/issue_dependencies.ts";
import type {
  DependencyBlocker,
  IssueFetcher,
  IssueState,
} from "../lib/issue_dependencies.ts";
import {
  isDependencyBlocked,
  memoiseIssueFetcher,
} from "../lib/issue_finder_common.ts";

const REPO = "stSoftwareAU/NEAT-AI-Backpropagation";

/** Fetcher over a fixed `repo#number → state` table. */
function makeFetcher(
  body: string,
  states: Record<string, "OPEN" | "CLOSED">,
  calls: string[] = [],
): IssueFetcher {
  return {
    getIssueBody: () => Promise.resolve(body),
    getSubIssues: () => Promise.resolve([]),
    getIssueState: (repo: string, issueNumber: number) => {
      const key = `${repo}#${issueNumber}`;
      calls.push(key);
      const state = states[key];
      if (!state) return Promise.reject(new Error(`no such issue: ${key}`));
      const value: IssueState = { number: issueNumber, state, title: key };
      return Promise.resolve(value);
    },
  };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

Deno.test("extractDependencyReferencesDetailed keeps the repo of a cross-repo ref", () => {
  const refs = extractDependencyReferencesDetailed(
    "Body.\n\nDepends on stSoftwareAU/NEAT-AI-core#560\nBlocked by #12\n",
  );
  assertEquals(refs.length, 2);
  assertEquals(refs[0], { repo: "stSoftwareAU/NEAT-AI-core", number: 560 });
  assertEquals(refs[1], { number: 12 });
});

Deno.test("extractDependencyReferences still returns same-repo numbers only", () => {
  const numbers = extractDependencyReferences(
    "Depends on stSoftwareAU/NEAT-AI-core#560\nDepends on #12\n",
  );
  // 560 lives in another repo — it must NOT be resolved as this repo's #560.
  assertEquals(numbers, [12]);
});

Deno.test("extractDependencyReferencesDetailed de-duplicates repeated refs", () => {
  const refs = extractDependencyReferencesDetailed(
    "Depends on org/dep#5\nBlocked by org/dep#5\nDepends on #5\n",
  );
  assertEquals(refs, [{ repo: "org/dep", number: 5 }, { number: 5 }]);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

Deno.test("isDependencyBlocked blocks on an OPEN cross-repo dependency", async () => {
  const calls: string[] = [];
  const fetcher = makeFetcher(
    "Depends on stSoftwareAU/NEAT-AI-core#560",
    { "stSoftwareAU/NEAT-AI-core#560": "OPEN" },
    calls,
  );
  assertEquals(await isDependencyBlocked(REPO, 94, fetcher), true);
  // Resolved against the dependency's own repo, not the claimed one.
  assertEquals(calls, ["stSoftwareAU/NEAT-AI-core#560"]);
});

Deno.test("isDependencyBlocked releases once the cross-repo dependency closes", async () => {
  const fetcher = makeFetcher(
    "Depends on stSoftwareAU/NEAT-AI-core#560",
    { "stSoftwareAU/NEAT-AI-core#560": "CLOSED" },
  );
  assertEquals(await isDependencyBlocked(REPO, 94, fetcher), false);
});

Deno.test("isDependencyBlocked fails safe when a cross-repo dependency cannot be read", async () => {
  const fetcher = makeFetcher("Depends on org/private#7", {});
  assertEquals(await isDependencyBlocked(REPO, 94, fetcher), true);
});

Deno.test("isDependencyBlocked still uses the cached open-state map for same-repo refs", async () => {
  const calls: string[] = [];
  const fetcher = makeFetcher("Depends on #12", {}, calls);
  const openStateMap = new Map<number, "OPEN">([[12, "OPEN"]]);
  assertEquals(
    await isDependencyBlocked(REPO, 94, fetcher, openStateMap),
    true,
  );
  // Served from the map — no per-issue fetch.
  assertEquals(calls, []);
});

Deno.test("a same-repo open-state map never answers for another repo's issue", async () => {
  const calls: string[] = [];
  const fetcher = makeFetcher(
    "Depends on org/dep#12",
    { "org/dep#12": "CLOSED" },
    calls,
  );
  const openStateMap = new Map<number, "OPEN">([[12, "OPEN"]]);
  assertEquals(
    await isDependencyBlocked(REPO, 94, fetcher, openStateMap),
    false,
  );
  assertEquals(calls, ["org/dep#12"]);
});

Deno.test("memoiseIssueFetcher keys its cache by repo as well as number", async () => {
  const calls: string[] = [];
  const fetcher = memoiseIssueFetcher(
    makeFetcher(
      "",
      { "org/a#5": "OPEN", "org/b#5": "CLOSED" },
      calls,
    ),
  );
  assertEquals((await fetcher.getIssueState("org/a", 5)).state, "OPEN");
  assertEquals((await fetcher.getIssueState("org/b", 5)).state, "CLOSED");
  // Cached per repo — a repeat call adds no fetch.
  assertEquals((await fetcher.getIssueState("org/a", 5)).state, "OPEN");
  assertEquals(calls, ["org/a#5", "org/b#5"]);
});

// ---------------------------------------------------------------------------
// checkParentBlocked — a native sub-issue in another repository (Issue #3319)
// ---------------------------------------------------------------------------

/**
 * Fetcher for a single parent `owner/app#1` with one native child
 * `{repo:"other/lib", number:5}`. `states` is keyed `repo#number`, just as
 * in {@link makeFetcher}.
 */
function makeCrossRepoParentFetcher(
  states: Record<string, "OPEN" | "CLOSED">,
): IssueFetcher {
  return {
    getIssueBody: () => Promise.resolve(""),
    getSubIssues: (repo: string, issueNumber: number) => {
      if (repo === "owner/app" && issueNumber === 1) {
        return Promise.resolve([{ repo: "other/lib", number: 5 }]);
      }
      return Promise.resolve([]);
    },
    getIssueState: (repo: string, issueNumber: number) => {
      const key = `${repo}#${issueNumber}`;
      const state = states[key];
      if (!state) return Promise.reject(new Error(`no such issue: ${key}`));
      const value: IssueState = { number: issueNumber, state, title: key };
      return Promise.resolve(value);
    },
  };
}

Deno.test("checkParentBlocked resolves a cross-repo child against its own repo, not the parent's same-numbered issue", async () => {
  // owner/app#5 is OPEN but is a different issue from the actual child,
  // other/lib#5, which is CLOSED. The child must not block the parent.
  const fetcher = makeCrossRepoParentFetcher({
    "owner/app#5": "OPEN",
    "other/lib#5": "CLOSED",
  });
  const result = await checkParentBlocked(fetcher, "owner/app", 1);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.isBlocked, false);
});

Deno.test("checkParentBlocked blocks on an open cross-repo child, and the message names its own repo", async () => {
  // owner/app#5 is CLOSED, but the real child, other/lib#5, is OPEN — the
  // parent must be blocked, resolved against the child's own repo.
  const fetcher = makeCrossRepoParentFetcher({
    "owner/app#5": "CLOSED",
    "other/lib#5": "OPEN",
  });
  const result = await checkParentBlocked(fetcher, "owner/app", 1);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.isBlocked, true);
  assertEquals(result.value.openChildren, [{ repo: "other/lib", number: 5 }]);
  const message = formatParentBlockedMessage(1, result.value, "owner/app");
  assertStringIncludes(message, "other/lib#5");
});

Deno.test("checkParentBlocked's same-repo open-state map never answers for a cross-repo child", async () => {
  // The cached open-state map has #5 as open — but that cache is this
  // repo's own issue numbers (Issue #1808); the real child lives in
  // other/lib and is CLOSED there, so the parent must not be blocked.
  const fetcher = makeCrossRepoParentFetcher({
    "other/lib#5": "CLOSED",
  });
  const openStateMap = new Map<number, "OPEN">([[5, "OPEN"]]);
  const result = await checkParentBlocked(
    fetcher,
    "owner/app",
    1,
    openStateMap,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.isBlocked, false);
});

// ---------------------------------------------------------------------------
// isDependencyBlocked blockers — a cross-repo native child (Issue #3319)
// ---------------------------------------------------------------------------

Deno.test("isDependencyBlocked records a cross-repo child blocker with the child's own repo", async () => {
  const fetcher = makeCrossRepoParentFetcher({
    "owner/app#5": "CLOSED",
    "other/lib#5": "OPEN",
  });
  const blockers: DependencyBlocker[] = [];
  const blocked = await isDependencyBlocked(
    "owner/app",
    1,
    fetcher,
    undefined,
    undefined,
    blockers,
  );
  assertEquals(blocked, true);
  assertEquals(blockers, [{ repo: "other/lib", number: 5, kind: "child" }]);
});
