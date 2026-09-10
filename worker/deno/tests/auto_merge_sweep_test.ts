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
import {
  resetAnnouncedDraftsForTest,
  type SweepablePr,
  sweepAutoMerge,
} from "../lib/auto_merge_sweep.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { PrLiveStateReading } from "../lib/pr_live_state.ts";
import type { Logger } from "../types.ts";

const REPOS = [
  "stSoftwareAU/VibeCoder",
  "stSoftwareAU/NEAT-AI-Ockham",
  "stSoftwareAU/GRQ-GTC",
];
const FLEET = ["VibeCoderST", "stservice"];

const warnings: { message: string }[] = [];
const infos: { message: string; context?: Record<string, unknown> }[] = [];
const logger: Pick<Logger, "info" | "warn"> = {
  info: (message: string, context?: Record<string, unknown>) => {
    infos.push({ message, context });
  },
  warn: (message: string) => {
    warnings.push({ message });
  },
};

interface Harness {
  listed: { repo: string; authors: readonly string[] }[];
  /** PRs whose live state was re-read at the claim point (Issue #1774). */
  stateReads: { repo: string; prNumber: number }[];
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
    prLiveState?: (
      repo: string,
      pr: SweepablePr,
    ) => Promise<PrLiveStateReading>;
  } = {},
) {
  const state: Harness = {
    listed: [],
    stateReads: [],
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
    prLiveState: (repo: string, pr: SweepablePr) => {
      state.stateReads.push({ repo, prNumber: pr.number });
      return overrides.prLiveState
        ? overrides.prLiveState(repo, pr)
        : Promise.resolve({ open: true } as PrLiveStateReading);
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

// ---------------------------------------------------------------------------
// The sweep records what it saw (Issue #1136)
//
// A whole pass used to produce one line — the priority's name. "No candidates"
// and "refused every candidate" therefore looked identical from outside, which
// is why an unarmed PR went unnoticed for five instances in a day.
// ---------------------------------------------------------------------------

Deno.test("a repo with no open fleet PR is logged as having no candidates", async () => {
  infos.length = 0;
  const { options } = harness({
    "stSoftwareAU/VibeCoder": [{ number: 1 }],
  });

  const result = await sweepAutoMerge(options);

  assert(result.ok);
  // Two of the three monitored repos had nothing to act on, and both said so.
  assertEquals(result.value.reposWithNoCandidates, [
    "stSoftwareAU/NEAT-AI-Ockham",
    "stSoftwareAU/GRQ-GTC",
  ]);
  const noCandidateRepos = infos
    .filter((i) => i.message.includes("no candidates"))
    .map((i) => i.context?.repo);
  assertEquals(noCandidateRepos, [
    "stSoftwareAU/NEAT-AI-Ockham",
    "stSoftwareAU/GRQ-GTC",
  ]);
});

Deno.test("a sweep that finds nothing anywhere still says so", async () => {
  infos.length = 0;
  const { state, options } = harness({});

  const result = await sweepAutoMerge(options);

  assert(result.ok);
  assertEquals(state.attempted, []);
  assertEquals(result.value.prsAttempted, 0);
  assertEquals(result.value.reposWithNoCandidates, REPOS);
  assertEquals(
    infos.filter((i) => i.message.includes("no candidates")).length,
    REPOS.length,
  );
});

Deno.test("the candidates a repo contributes are named before they are attempted", async () => {
  infos.length = 0;
  const { options } = harness({
    "stSoftwareAU/VibeCoder": [{ number: 1133 }, { number: 1134 }],
  });

  const result = await sweepAutoMerge(options);

  assert(result.ok);
  const candidateLine = infos.find((i) => i.message.includes("candidates:"));
  assert(candidateLine, `expected a candidate line: ${JSON.stringify(infos)}`);
  assertEquals(candidateLine.context?.repo, "stSoftwareAU/VibeCoder");
  assertEquals(candidateLine.context?.prNumbers, "1133, 1134");
});

// ---------------------------------------------------------------------------
// Issue #1515: one quota exhaustion is one line, not one per repository
// ---------------------------------------------------------------------------

Deno.test("an exhausted quota costs one listing and one warning, and skips the remaining repos (Issue #1515)", async () => {
  const before = warnings.length;
  const { state, options } = harness({}, {
    listOpenPrs: () =>
      Promise.reject(
        new Error(
          "gh command skipped: GraphQL primary quota exhausted (API rate limit already exceeded) — in 7m",
        ),
      ),
  });

  const result = await sweepAutoMerge(options);

  assert(result.ok);
  assertEquals(state.listed.length, 1, "the first refusal is the last call");
  assertEquals(result.value.reposVisited, [REPOS[0]]);
  const mine = warnings.slice(before).map((w) => w.message);
  assertEquals(mine.length, 1, mine.join("\n"));
  assert(mine[0]!.startsWith("Auto-merge sweep: GraphQL quota exhausted"));
  assert(mine[0]!.includes("skipped 3 of 3 repo(s)"));
});

// ---------------------------------------------------------------------------
// Issue #1774 — the cached listing is not proof the PR is still open
// ---------------------------------------------------------------------------

Deno.test("a PR closed since the cached listing receives no merge attempt", async () => {
  const { state, options } = harness(
    { "stSoftwareAU/VibeCoder": [{ number: 1732 }] },
    { prLiveState: () => Promise.resolve({ open: false, state: "CLOSED" }) },
  );

  const before = infos.length;
  const result = await sweepAutoMerge(options);

  assert(result.ok);
  assertEquals(state.attempted, [], "a closed PR must receive no write");
  assertEquals(state.recorded, []);
  assertEquals(state.invalidated, []);
  assertEquals(result.value.prsAttempted, 0);
  assertEquals(result.value.prsSkippedNotOpen, 1);
  assert(
    infos.slice(before).some((entry) =>
      entry.message.includes("skipped: PR closed") &&
      entry.context?.repo === "stSoftwareAU/VibeCoder" &&
      entry.context?.prNumber === 1732
    ),
    "the skip must name the repo and the PR number",
  );
});

Deno.test("a PR merged since the cached listing receives no merge attempt", async () => {
  const { state, options } = harness(
    { "stSoftwareAU/GRQ-GTC": [{ number: 305 }] },
    { prLiveState: () => Promise.resolve({ open: false, state: "MERGED" }) },
  );

  const before = infos.length;
  const result = await sweepAutoMerge(options);

  assert(result.ok);
  assertEquals(state.attempted, []);
  assert(
    infos.slice(before).some((entry) =>
      entry.message.includes("skipped: PR merged")
    ),
  );
});

Deno.test("an unreadable PR state is skipped this cycle, never attempted", async () => {
  const { state, options } = harness(
    { "stSoftwareAU/VibeCoder": [{ number: 9 }] },
    {
      prLiveState: () =>
        Promise.resolve({ unknown: true, error: "gh: exit 1" }),
    },
  );

  const before = warnings.length;
  const result = await sweepAutoMerge(options);

  assert(result.ok);
  assertEquals(state.attempted, [], "unknown must never be treated as open");
  assertEquals(result.value.prsSkippedNotOpen, 1);
  assert(
    warnings.slice(before).some((entry) =>
      entry.message.includes("skipped: PR state unknown")
    ),
    "an unreadable state must be loud, not silent",
  );
});

Deno.test("an open PR is attempted exactly as before, after one state read", async () => {
  const { state, options } = harness({
    "stSoftwareAU/VibeCoder": [{ number: 42 }],
  });

  const result = await sweepAutoMerge(options);

  assert(result.ok);
  assertEquals(state.stateReads, [{
    repo: "stSoftwareAU/VibeCoder",
    prNumber: 42,
  }]);
  assertEquals(state.attempted, [{
    repo: "stSoftwareAU/VibeCoder",
    prNumber: 42,
  }]);
  assertEquals(result.value.prsAttempted, 1);
  assertEquals(result.value.prsSkippedNotOpen, 0);
});

// ---------------------------------------------------------------------------
// Draft PRs (Issue #1800)
// ---------------------------------------------------------------------------

Deno.test("a draft PR is skipped: no attempt, no outcome, announced once per process (Issue #1800)", async () => {
  resetAnnouncedDraftsForTest();
  infos.length = 0;
  warnings.length = 0;
  const { state, options } = harness({
    "stSoftwareAU/VibeCoder": [
      { number: 1794, headRefName: "sync/1786-milestone-1653", isDraft: true },
      { number: 1792, headRefName: "issue-1753-x", isDraft: false },
    ],
  });

  const first = await sweepAutoMerge(options);
  assert(first.ok);
  assertEquals(state.attempted.map((a) => a.prNumber), [1792]);
  assertEquals(state.recorded.map((r) => r.prNumber), [1792]);
  assertEquals(first.value.prsAttempted, 1);
  const announced = () =>
    infos.filter((i) => i.message.includes("skipping draft PR"));
  assertEquals(announced().length, 1);
  assertEquals(announced()[0]!.context?.prNumber, 1794);
  assertEquals(warnings.length, 0);

  // The next sweep in the same process skips it silently.
  const second = await sweepAutoMerge(options);
  assert(second.ok);
  assertEquals(state.attempted.map((a) => a.prNumber), [1792, 1792]);
  assertEquals(announced().length, 1);
  resetAnnouncedDraftsForTest();
});

Deno.test("a PR whose draft state is unknown (older cache entry) is attempted as before (Issue #1800)", async () => {
  resetAnnouncedDraftsForTest();
  const { state, options } = harness({
    "stSoftwareAU/VibeCoder": [{ number: 7, headRefName: "issue-7-x" }],
  });
  const result = await sweepAutoMerge(options);
  assert(result.ok);
  assertEquals(state.attempted.map((a) => a.prNumber), [7]);
});
