/**
 * Tests for cross-repo forward dependencies (Issue #222).
 *
 * A deferred issue records `Depends on owner/repo#N`. The gate must resolve
 * that reference against **its own** repo: before this change the cross-repo
 * form matched nothing at all, so a blocked issue was re-claimed immediately.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  extractDependencyReferences,
  extractDependencyReferencesDetailed,
} from "../lib/issue_dependencies.ts";
import type { IssueFetcher, IssueState } from "../lib/issue_dependencies.ts";
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
