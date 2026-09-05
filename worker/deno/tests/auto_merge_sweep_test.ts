/**
 * Tests for the priority 1.65 auto-merge sweep (Issue #1082).
 *
 * Two invariants, both learnt from live deadlocks: the sweep is driven by the
 * monitored repo list rather than by claimable work (so a repo blocked by its
 * own PR is still visited), and it covers every push-capable fleet author
 * rather than this host's own login (so a sibling account's PR is not left
 * unattended, as `GRQ-GTC#305` was for five days).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { type SweepablePr, sweepAutoMerge } from "../lib/auto_merge_sweep.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { Logger } from "../types.ts";

const REPOS = [
  "stSoftwareAU/VibeCoder",
  "stSoftwareAU/NEAT-AI-Ockham",
  "stSoftwareAU/GRQ-GTC",
];
const FLEET = ["VibeCoderST", "stservice"];

const warnings: { message: string }[] = [];
const logger: Pick<Logger, "warn"> = {
  warn: (message: string) => {
    warnings.push({ message });
  },
};

interface Harness {
  listed: { repo: string; authors: readonly string[] }[];
  attempted: { repo: string; prNumber: number }[];
  recorded: { repo: string; prNumber: number; result: AutoMergeResult }[];
  invalidated: string[];
}

function harness(
  prsByRepo: Record<string, SweepablePr[]>,
  overrides: {
    listOpenPrs?: (
      repo: string,
      authors: readonly string[],
    ) => Promise<readonly SweepablePr[]>;
    attemptMerge?: (repo: string, pr: SweepablePr) => Promise<{
      result: AutoMergeResult;
      message: string;
    }>;
  } = {},
) {
  const state: Harness = {
    listed: [],
    attempted: [],
    recorded: [],
    invalidated: [],
  };

  const options = {
    repos: REPOS,
    isRepoAllowed: (_repo: string) => true,
    fleetAuthors: FLEET,
    listOpenPrs: (repo: string, authors: readonly string[]) => {
      state.listed.push({ repo, authors });
      return overrides.listOpenPrs
        ? overrides.listOpenPrs(repo, authors)
        : Promise.resolve(prsByRepo[repo] ?? []);
    },
    attemptMerge: (repo: string, pr: SweepablePr) => {
      state.attempted.push({ repo, prNumber: pr.number });
      return overrides.attemptMerge
        ? overrides.attemptMerge(repo, pr)
        : Promise.resolve({
          result: AutoMergeResult.MergedDirectly,
          message: `merged #${pr.number}`,
        });
    },
    recordOutcome: (
      repo: string,
      prNumber: number,
      outcome: { result: AutoMergeResult },
    ) => {
      state.recorded.push({ repo, prNumber, result: outcome.result });
    },
    invalidateOpenPrCache: (repo: string) => {
      state.invalidated.push(repo);
      return Promise.resolve();
    },
    logger,
  };

  return { state, options };
}

// ---------------------------------------------------------------------------
// The deadlock case — a repo with no claimable work is still visited
// ---------------------------------------------------------------------------

Deno.test("the sweep visits every monitored repo, including one with no claimable work", async () => {
  // NEAT-AI-Ockham has one open PR and, because that PR blocks every one of
  // its `work-on` issues, no claimable work at all. A work-driven sweep would
  // never revisit it and the block would be permanent.
  const { state, options } = harness({
    "stSoftwareAU/NEAT-AI-Ockham": [{ number: 116, baseRefName: "Develop" }],
  });

  const result = await sweepAutoMerge(options);

  assert(result.ok);
  assertEquals(result.value.reposVisited, REPOS);
  assertEquals(state.attempted, [{
    repo: "stSoftwareAU/NEAT-AI-Ockham",
    prNumber: 116,
  }]);
});

Deno.test("a repo outside the allowlist is skipped", async () => {
  const { state, options } = harness({
    "stSoftwareAU/GRQ-GTC": [{ number: 305 }],
  });
  options.isRepoAllowed = (repo: string) => repo !== "stSoftwareAU/GRQ-GTC";

  const result = await sweepAutoMerge(options);

  assert(result.ok);
  assertEquals(
    result.value.reposVisited.includes("stSoftwareAU/GRQ-GTC"),
    false,
  );
  assertEquals(state.attempted, []);
});

// ---------------------------------------------------------------------------
// Author coverage — a sibling fleet account's PR is not invisible
// ---------------------------------------------------------------------------

Deno.test("the sweep lists PRs for every fleet author, not just this host", async () => {
  const { state, options } = harness({});

  const result = await sweepAutoMerge(options);

  assert(result.ok);
  for (const listing of state.listed) {
    assertEquals([...listing.authors], FLEET);
  }
  assertEquals(state.listed.length, REPOS.length);
});

Deno.test("a sibling account's PR is attempted like any other", async () => {
  const { state, options } = harness({
    // Authored by `stservice` while the scanning host is `VibeCoderST`.
    "stSoftwareAU/GRQ-GTC": [{ number: 305, baseRefName: "Develop" }],
  });

  const result = await sweepAutoMerge(options);

  assert(result.ok);
  assertEquals(state.attempted, [{
    repo: "stSoftwareAU/GRQ-GTC",
    prNumber: 305,
  }]);
  assertEquals(result.value.prsAttempted, 1);
});

// ---------------------------------------------------------------------------
// Outcomes are recorded, failures are loud, and one bad repo is not fatal
// ---------------------------------------------------------------------------

Deno.test("every attempt's outcome is recorded", async () => {
  const { state, options } = harness({
    "stSoftwareAU/VibeCoder": [{ number: 1 }, { number: 2 }],
  });
  options.attemptMerge = (_repo, pr) =>
    Promise.resolve({
      result: pr.number === 1
        ? AutoMergeResult.MergedDirectly
        : AutoMergeResult.Deferred,
      message: "outcome",
    });

  const result = await sweepAutoMerge(options);

  assert(result.ok);
  assertEquals(state.recorded.map((r) => r.result), [
    AutoMergeResult.MergedDirectly,
    AutoMergeResult.Deferred,
  ]);
});

Deno.test("a repo whose PR listing fails is logged and the sweep continues", async () => {
  warnings.length = 0;
  const { state, options } = harness({
    "stSoftwareAU/GRQ-GTC": [{ number: 305 }],
  }, {
    listOpenPrs: (repo: string) => {
      if (repo === "stSoftwareAU/NEAT-AI-Ockham") {
        return Promise.reject(new Error("HTTP 502"));
      }
      return Promise.resolve(
        repo === "stSoftwareAU/GRQ-GTC" ? [{ number: 305 }] : [],
      );
    },
  });

  const result = await sweepAutoMerge(options);

  assert(result.ok);
  assertEquals(state.attempted, [{
    repo: "stSoftwareAU/GRQ-GTC",
    prNumber: 305,
  }]);
  assert(
    warnings.some((w) => w.message.includes("could not list open PRs")),
    "the skipped repo must be reported, not swallowed",
  );
});

Deno.test("a throwing merge attempt is logged and the next PR still runs", async () => {
  warnings.length = 0;
  const { state, options } = harness({
    "stSoftwareAU/VibeCoder": [{ number: 1 }, { number: 2 }],
  }, {
    attemptMerge: (_repo, pr) => {
      if (pr.number === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve({
        result: AutoMergeResult.Enabled,
        message: "armed",
      });
    },
  });

  const result = await sweepAutoMerge(options);

  assert(result.ok);
  assertEquals(state.recorded.map((r) => r.prNumber), [2]);
  assert(warnings.some((w) => w.message.includes("Auto-merge attempt threw")));
});

Deno.test("the open-PR cache is invalidated only for repos an attempt touched", async () => {
  const { state, options } = harness({
    "stSoftwareAU/VibeCoder": [{ number: 1 }],
  });

  const result = await sweepAutoMerge(options);

  assert(result.ok);
  assertEquals(state.invalidated, ["stSoftwareAU/VibeCoder"]);
});
