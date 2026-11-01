/**
 * Tests for the ready-to-merge gate on the auto-merge sweep's branch update
 * (Issue #4613). On a strict base with no merge queue, an armed PR that has
 * fallen behind its base is updated only once it could merge (review satisfied
 * and checks passed), and only one PR per base is updated at a time: the next
 * waits until the one in flight has merged or failed.
 *
 * The harness follows `auto_merge_sweep_merge_queue_test.ts`: the real sweep
 * runs against stubbed seams, and each pass records what it read and did.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { type SweepablePr, sweepAutoMerge } from "../lib/auto_merge_sweep.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { PrLiveStateReading } from "../lib/pr_live_state.ts";
import type { Result } from "../types.ts";

const REPO = "stSoftwareAU/VibeCoder";
const FLEET = ["VibeCoderST"];

type OpenReading = Extract<PrLiveStateReading, { open: true }>;

/** An open reading built from its fields alone (no key is added for an absent one). */
function openReading(fields: Omit<OpenReading, "open">): PrLiveStateReading {
  return { open: true, ...fields };
}

/** Armed, behind and ready: approved, checks passed. */
const READY = {
  mergeable: "MERGEABLE",
  armed: true,
  behind: true,
  reviewSatisfied: true,
  checks: "passed",
} as const;

interface Fake {
  /** The repo's open-PR listing as the sweep sees it. */
  listing: SweepablePr[];
  /** Each PR's live reading, by PR number. */
  readings: Map<number, PrLiveStateReading>;
  /** Bases that sit behind a GitHub merge queue. */
  queuedBases: Set<string>;
  /** PR numbers whose branch update GitHub refuses. */
  refusedUpdates: Set<number>;
}

function makeFake(
  listing: SweepablePr[],
  readings: Record<number, PrLiveStateReading>,
  extras: Partial<Pick<Fake, "queuedBases" | "refusedUpdates">> = {},
): Fake {
  return {
    listing,
    readings: new Map<number, PrLiveStateReading>(
      Object.entries(readings).map(([n, r]) => [Number(n), r] as const),
    ),
    queuedBases: extras.queuedBases ?? new Set(),
    refusedUpdates: extras.refusedUpdates ?? new Set(),
  };
}

interface LogLine {
  message: string;
  context?: Record<string, unknown>;
}

/** What one sweep pass did, in order. */
interface Pass {
  /** One entry per `prLiveState` call, by PR number. */
  reads: number[];
  updated: number[];
  attempted: number[];
  recorded: { prNumber: number; result: AutoMergeResult }[];
  infos: LogLine[];
  warns: string[];
}

/** Run one real sweep pass over the fake and record what it did. */
async function runPass(f: Fake): Promise<Pass> {
  const pass: Pass = {
    reads: [],
    updated: [],
    attempted: [],
    recorded: [],
    infos: [],
    warns: [],
  };
  const result = await sweepAutoMerge({
    repos: [REPO],
    isRepoAllowed: () => true,
    fleetAuthors: FLEET,
    listOpenPrs: () => Promise.resolve([...f.listing]),
    prLiveState: (
      _repo: string,
      pr: SweepablePr,
    ): Promise<PrLiveStateReading> => {
      pass.reads.push(pr.number);
      const reading: PrLiveStateReading = f.readings.get(pr.number) ?? {
        unknown: true,
        error: `no reading for #${pr.number}`,
      };
      return Promise.resolve(reading);
    },
    updateBranchFn: (
      _repo: string,
      prNumber: number,
    ): Promise<Result<void>> => {
      pass.updated.push(prNumber);
      return Promise.resolve(
        f.refusedUpdates.has(prNumber)
          ? { ok: false, error: new Error("refused by GitHub") }
          : { ok: true, value: undefined },
      );
    },
    isMergeQueueBase: (_repo: string, baseRefName: string) =>
      Promise.resolve(f.queuedBases.has(baseRefName)),
    checkBaseIntegrity: () =>
      Promise.resolve({ action: "proceed" as const, disarmed: false }),
    attemptMerge: (_repo: string, pr: SweepablePr) => {
      pass.attempted.push(pr.number);
      return Promise.resolve({
        result: AutoMergeResult.MergedDirectly,
        message: `merged #${pr.number}`,
      });
    },
    recordOutcome: (
      _repo: string,
      prNumber: number,
      outcome: { result: AutoMergeResult },
    ) => {
      pass.recorded.push({ prNumber, result: outcome.result });
    },
    invalidateOpenPrCache: () => Promise.resolve(),
    logger: {
      info: (message: string, context?: Record<string, unknown>) => {
        pass.infos.push({ message, context });
      },
      warn: (message: string) => {
        pass.warns.push(message);
      },
    },
  });
  assert(result.ok, "the sweep itself must succeed");
  return pass;
}

/** True when an info line names `needle` and carries `prNumber`. */
function hasLine(pass: Pass, needle: string, prNumber: number): boolean {
  return pass.infos.some((line) =>
    line.message.includes(needle) && line.context?.prNumber === prNumber
  );
}

// ---------------------------------------------------------------------------
// (i) Review gate
// ---------------------------------------------------------------------------

Deno.test("Issue #4613: a behind, armed PR awaiting review gets no update and no merge attempt", async () => {
  const pass = await runPass(makeFake(
    [{ number: 1, baseRefName: "main" }],
    {
      // No reviewSatisfied key at all: the review is not known to be satisfied.
      1: openReading({
        mergeable: "MERGEABLE",
        armed: true,
        behind: true,
        checks: "passed",
      }),
    },
  ));

  assertEquals(pass.updated, []);
  assertEquals(pass.attempted, []);
  assert(
    hasLine(pass, "review not satisfied", 1),
    `expected a 'review not satisfied' line, got: ${
      JSON.stringify(pass.infos)
    }`,
  );
});

// ---------------------------------------------------------------------------
// (ii) Checks gate
// ---------------------------------------------------------------------------

Deno.test("Issue #4613: a behind, armed PR approved but without passed checks gets no update, and the reason is logged", async () => {
  const cases: [string, PrLiveStateReading][] = [
    [
      "checks pending on its current head",
      openReading({ ...READY, checks: "pending" }),
    ],
    [
      "checks failed on its current head",
      openReading({ ...READY, checks: "failed" }),
    ],
    [
      "checks unreadable on its current head",
      openReading({
        mergeable: "MERGEABLE",
        armed: true,
        behind: true,
        reviewSatisfied: true,
      }),
    ],
  ];
  for (const [reason, reading] of cases) {
    const pass = await runPass(makeFake(
      [{ number: 1, baseRefName: "main" }],
      { 1: reading },
    ));

    assertEquals(pass.updated, [], reason);
    assertEquals(pass.attempted, [], reason);
    assert(
      hasLine(pass, reason, 1),
      `expected a '${reason}' line, got: ${JSON.stringify(pass.infos)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// (iii) The ready PR is updated, once
// ---------------------------------------------------------------------------

Deno.test("Issue #4613: an approved, green, behind, armed PR is updated exactly once and the update is recorded", async () => {
  const pass = await runPass(makeFake(
    [{ number: 1, baseRefName: "main" }],
    { 1: openReading({ ...READY }) },
  ));

  assertEquals(pass.updated, [1]);
  assertEquals(pass.attempted, []);
  assertEquals(pass.recorded, [{
    prNumber: 1,
    result: AutoMergeResult.BranchUpdateRequested,
  }]);
});

// ---------------------------------------------------------------------------
// (iv) Two ready PRs on one base, one after the other
// ---------------------------------------------------------------------------

Deno.test("Issue #4613: two ready PRs on one base: the first is updated, the second waits, then follows once the first has merged", async () => {
  const f = makeFake(
    [
      { number: 1, baseRefName: "main" },
      { number: 2, baseRefName: "main" },
    ],
    {
      1: openReading({ ...READY }),
      2: openReading({ ...READY }),
    },
  );

  // Pass 1: #1 is updated. #2 is held back by the per-pass set.
  const first = await runPass(f);
  assertEquals(first.updated, [1], "only the first ready PR is updated");
  assertEquals(first.attempted, []);
  assertEquals(first.reads, [1, 2], "each PR is read exactly once");
  assert(
    hasLine(first, "was already updated this pass", 2),
    `expected the per-pass skip for #2, got: ${JSON.stringify(first.infos)}`,
  );

  // Pass 2: #1 is armed, up to date, approved, and its checks are pending, so
  // it is in flight. #2 is still behind and ready, and must wait for it.
  f.readings.set(
    1,
    openReading({
      mergeable: "MERGEABLE",
      armed: true,
      behind: false,
      reviewSatisfied: true,
      checks: "pending",
    }),
  );
  const second = await runPass(f);
  assertEquals(
    second.updated,
    [],
    "#2 must not be updated while #1 is in flight",
  );
  assertEquals(second.reads, [1, 2], "each PR is read exactly once");
  const inFlightLine = second.infos.find((line) =>
    line.message.includes("on the same base is ready and already up to date")
  );
  assert(
    inFlightLine !== undefined,
    `expected an in-flight line, got: ${JSON.stringify(second.infos)}`,
  );
  assert(
    inFlightLine.message.includes("#1 on the same base"),
    "the in-flight line must name #1",
  );
  assertEquals(inFlightLine.context?.prNumber, 2);
  assertEquals(inFlightLine.context?.inFlightPrNumber, 1);

  // Pass 3: #1 has merged and is no longer listed. #2 is now updated.
  f.listing = [{ number: 2, baseRefName: "main" }];
  f.readings.delete(1);
  const third = await runPass(f);
  assertEquals(third.updated, [2], "#2 is updated once #1 has merged");
  assertEquals(third.reads, [2]);
});

// ---------------------------------------------------------------------------
// (v) Different bases are independent
// ---------------------------------------------------------------------------

Deno.test("Issue #4613: two ready PRs on different bases are both updated in one pass", async () => {
  const pass = await runPass(makeFake(
    [
      { number: 1, baseRefName: "main" },
      { number: 2, baseRefName: "develop" },
    ],
    {
      1: openReading({ ...READY }),
      2: openReading({ ...READY }),
    },
  ));

  assertEquals(pass.updated, [1, 2]);
  assertEquals(pass.attempted, []);
});

// ---------------------------------------------------------------------------
// (vi) Only an in-flight PR blocks: a failed check or an unreviewed PR does not
// ---------------------------------------------------------------------------

Deno.test("Issue #4613: an up-to-date PR whose checks failed does not block the other PR on its base", async () => {
  const pass = await runPass(makeFake(
    [
      { number: 1, baseRefName: "main" },
      { number: 2, baseRefName: "main" },
    ],
    {
      1: openReading({
        mergeable: "MERGEABLE",
        armed: true,
        behind: false,
        reviewSatisfied: true,
        checks: "failed",
      }),
      2: openReading({ ...READY }),
    },
  ));

  assertEquals(pass.updated, [2]);
});

Deno.test("Issue #4613: an up-to-date PR awaiting review does not block the other PR on its base", async () => {
  const pass = await runPass(makeFake(
    [
      { number: 1, baseRefName: "main" },
      { number: 2, baseRefName: "main" },
    ],
    {
      // No reviewSatisfied: not approved, so not in flight.
      1: openReading({
        mergeable: "MERGEABLE",
        armed: true,
        behind: false,
        checks: "passed",
      }),
      2: openReading({ ...READY }),
    },
  ));

  assertEquals(pass.updated, [2]);
});

// ---------------------------------------------------------------------------
// (vii) A failed update does not stop the next ready PR in the same pass
// ---------------------------------------------------------------------------

Deno.test("Issue #4613: a refused first update does not stop the second ready PR on the base from trying in the same pass", async () => {
  const pass = await runPass(makeFake(
    [
      { number: 1, baseRefName: "main" },
      { number: 2, baseRefName: "main" },
    ],
    {
      1: openReading({ ...READY }),
      2: openReading({ ...READY }),
    },
    { refusedUpdates: new Set([1]) },
  ));

  assertEquals(pass.updated, [1, 2]);
  assertEquals(pass.recorded, [
    { prNumber: 1, result: AutoMergeResult.Failed },
    { prNumber: 2, result: AutoMergeResult.BranchUpdateRequested },
  ]);
});

// ---------------------------------------------------------------------------
// (viii) A merge-queue base is left to its queue
// ---------------------------------------------------------------------------

Deno.test("Issue #4613: on a merge-queue base neither ready PR is updated, and each PR is read exactly once", async () => {
  const pass = await runPass(makeFake(
    [
      { number: 1, baseRefName: "main" },
      { number: 2, baseRefName: "main" },
    ],
    {
      1: openReading({ ...READY }),
      2: openReading({ ...READY }),
    },
    { queuedBases: new Set(["main"]) },
  ));

  assertEquals(pass.updated, []);
  assertEquals(pass.attempted, []);
  assertEquals(
    pass.reads,
    [1, 2],
    "no in-flight scan is needed on a queued base",
  );
  assert(
    pass.infos.some((line) => line.message.includes("merge queue")),
    "the queued skip must be logged",
  );
});

// ---------------------------------------------------------------------------
// (ix) Read once per pass, even when the in-flight scan looks at other PRs
// ---------------------------------------------------------------------------

Deno.test("Issue #4613: in-flight checks read each PR exactly once in a pass", async () => {
  const pass = await runPass(makeFake(
    [
      { number: 1, baseRefName: "main" },
      { number: 2, baseRefName: "main" },
      { number: 3, baseRefName: "main" },
    ],
    {
      // #1 is in flight, so the scan for #2 stops at it and never reaches #3.
      1: openReading({
        mergeable: "MERGEABLE",
        armed: true,
        behind: false,
        reviewSatisfied: true,
        checks: "pending",
      }),
      2: openReading({ ...READY }),
      3: openReading({ ...READY }),
    },
  ));

  assertEquals(pass.reads, [1, 2, 3], "each PR is read exactly once");
  assertEquals(pass.updated, []);
});
