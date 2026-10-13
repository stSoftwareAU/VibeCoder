/**
 * Nice-derived per-repo polling cadence (Issue #3667).
 *
 * The Priority 1.x passes walk every monitored repo every 2–3 minute cycle,
 * so the deprioritised repos cost as much GitHub API as the priority ones and
 * the shared fleet account keeps tripping GitHub's burst limit. The cadence
 * polls a `nice > 0` repo every few cycles instead — slower upkeep, never
 * none (the Issue #2776 "must not rot" invariant) — and a burst refusal holds
 * the low-priority tier for one more cycle, bounded so it can never starve.
 *
 * Uses Australian English throughout (behaviour, prioritised, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createRepoPollCadence,
  formatRepoPollCadenceLine,
  repoPollCadence,
  type RepoPollCadenceConfig,
} from "../lib/repo_poll_cadence.ts";

const CONFIG: RepoPollCadenceConfig = {
  lowCycles: 3,
  parkCycles: 10,
  parkNice: 99,
};

/** The production fleet's shape: priority repos, one nice-10, three nice-99. */
const NICE: Record<string, number> = {
  "o/AutoTrader": -16,
  "o/VibeCoder": -15,
  "o/GRQ": 0,
  "o/extract-score": 10,
  "o/TagsTS": 99,
  "o/template-rust": 99,
  "o/Examples": 99,
};
const REPOS = Object.keys(NICE);
const niceOf = (repo: string) => NICE[repo] ?? 0;

/** Run `cycles` cycles; return each repo's list of polled cycle numbers. */
function pollHistory(
  cycles: number,
  burstOn: (cycle: number) => boolean = () => false,
  config: RepoPollCadenceConfig = CONFIG,
): Map<string, number[]> {
  const cadence = createRepoPollCadence(config);
  const history = new Map<string, number[]>(REPOS.map((r) => [r, []]));
  for (let cycle = 0; cycle < cycles; cycle++) {
    const selection = cadence.select(REPOS, niceOf, burstOn(cycle));
    assertEquals(
      [...selection.due, ...selection.deferred].sort(),
      [...REPOS].sort(),
      "every repo is either due or deferred — none lost",
    );
    for (const repo of selection.due) history.get(repo)!.push(cycle);
  }
  return history;
}

function gaps(polls: number[]): number[] {
  return polls.slice(1).map((c, i) => c - polls[i]!);
}

Deno.test("repoPollCadence - nice <= 0 every cycle, low tier every lowCycles, park tier every parkCycles (Issue #3667)", () => {
  assertEquals(repoPollCadence(-16, CONFIG), 1);
  assertEquals(repoPollCadence(0, CONFIG), 1);
  assertEquals(repoPollCadence(1, CONFIG), 3);
  assertEquals(repoPollCadence(98, CONFIG), 3);
  assertEquals(repoPollCadence(99, CONFIG), 10);
  assertEquals(repoPollCadence(500, CONFIG), 10);
});

Deno.test("repoPollCadence - a missing or malformed cadence fails open to every cycle (Issue #3667)", () => {
  for (const bad of [undefined, Number.NaN, 0, -2, 2.5]) {
    const config = {
      lowCycles: bad,
      parkCycles: bad,
      parkNice: 99,
    } as unknown as RepoPollCadenceConfig;
    assertEquals(repoPollCadence(10, config), 1, `lowCycles=${bad}`);
    assertEquals(repoPollCadence(99, config), 1, `parkCycles=${bad}`);
  }
});

Deno.test("cadence - priority repos (nice <= 0) are polled every cycle, even under a burst limit (Issue #3667)", () => {
  const history = pollHistory(30, () => true);
  for (const repo of ["o/AutoTrader", "o/VibeCoder", "o/GRQ"]) {
    assertEquals(
      history.get(repo)!.length,
      30,
      `${repo} must never be deferred`,
    );
  }
});

Deno.test("cadence - low-priority repos are polled on their cadence, not every cycle (Issue #3667)", () => {
  const history = pollHistory(30);
  assertEquals(history.get("o/extract-score")!.length, 10);
  assert(gaps(history.get("o/extract-score")!).every((g) => g === 3));
  for (const repo of ["o/TagsTS", "o/template-rust", "o/Examples"]) {
    assertEquals(
      history.get(repo)!.length,
      3,
      `${repo} polled every 10th cycle`,
    );
    assert(gaps(history.get(repo)!).every((g) => g === 10));
  }
});

Deno.test("cadence - every low-priority repo is polled within its first cadence window (Issue #3667)", () => {
  const history = pollHistory(10);
  for (const repo of REPOS) {
    const first = history.get(repo)![0];
    assert(
      first !== undefined && first < repoPollCadence(niceOf(repo), CONFIG),
      `${repo} first polled at cycle ${first}`,
    );
  }
});

Deno.test("cadence - park-tier repos are staggered, not polled in one burst (Issue #3667)", () => {
  const history = pollHistory(10);
  const firsts = ["o/TagsTS", "o/template-rust", "o/Examples"].map((r) =>
    history.get(r)![0]
  );
  assertEquals(new Set(firsts).size, 3, `first polls ${firsts} must differ`);
});

Deno.test("cadence - a burst limit holds a due low-priority repo for another cycle (Issue #3667)", () => {
  const calm = pollHistory(30).get("o/extract-score")!;
  const burstCycle = calm[1]!;
  const held = pollHistory(30, (c) => c === burstCycle).get("o/extract-score")!;
  assert(!held.includes(burstCycle), "deferred on the burst cycle");
  assert(held.includes(burstCycle + 1), "polled the cycle after");
});

Deno.test("cadence - a burst limit every cycle never starves a low-priority repo (Issue #3667)", () => {
  const history = pollHistory(60, () => true);
  for (
    const repo of [
      "o/extract-score",
      "o/TagsTS",
      "o/template-rust",
      "o/Examples",
    ]
  ) {
    const polls = history.get(repo)!;
    const cadence = repoPollCadence(niceOf(repo), CONFIG);
    assert(polls.length > 0, `${repo} must still be polled`);
    assert(
      gaps(polls).every((g) => g <= 2 * cadence),
      `${repo} gaps ${gaps(polls)} must stay within twice its cadence`,
    );
  }
});

Deno.test("cadence - cycles of 1 turn the cadence off: every repo every cycle (Issue #3667)", () => {
  const history = pollHistory(5, () => true, {
    lowCycles: 1,
    parkCycles: 1,
    parkNice: 99,
  });
  for (const repo of REPOS) assertEquals(history.get(repo)!.length, 5);
});

Deno.test("cadence - a repo added mid-launch joins the cadence (Issue #3667)", () => {
  const cadence = createRepoPollCadence(CONFIG);
  for (let i = 0; i < 5; i++) cadence.select(["o/VibeCoder"], niceOf, false);
  let polled = 0;
  for (let i = 0; i < 10; i++) {
    const { due } = cadence.select(["o/VibeCoder", "o/TagsTS"], niceOf, false);
    if (due.includes("o/TagsTS")) polled++;
  }
  assertEquals(polled, 1);
});

Deno.test("formatRepoPollCadenceLine - names the deferred repos, or says nothing when none are (Issue #3667)", () => {
  assertEquals(
    formatRepoPollCadenceLine({ due: ["a"], deferred: [], burstHeld: false }),
    null,
  );
  const line = formatRepoPollCadenceLine({
    due: ["a", "b"],
    deferred: ["c", "d"],
    burstHeld: true,
  });
  assert(line !== null);
  assert(line.startsWith("poll-cadence: polling 2 of 4 repo(s) this cycle"));
  assert(line.includes("c, d"));
  assert(line.includes("burst"));
});
