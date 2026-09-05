/**
 * Label tier outranks `nice` across the fleet (Issue #1063).
 *
 * The operator's decision, recorded on the issue: the **label tier** is the
 * primary ordering across the whole fleet — `top-priority` > `work-on` >
 * self-diagnostic > `low-priority` > `idle-task` — and `nice` orders repos
 * *within* a label tier. `nice` is a tie-breaker inside a priority band, not
 * a band of its own: urgency is expressed by the label, `nice` shapes
 * throughput between repos that are equally urgent.
 *
 * Before this change `nice` was the outermost partition (Issue #2773), so a
 * `nice=-20` repo's routine `work-on` backlog was drained ahead of a
 * `nice=-15` repo's `top-priority` issues — the live fleet symptom reported
 * on Issue #1063.
 *
 * The selection matrix below uses the reported live `nice` values (Ockham at
 * −20, VibeCoder at −15) and asserts the winner for every label combination
 * in both directions, because a change to the outermost grouping can silently
 * reorder cells nobody thought about.
 *
 * Australian English throughout (behaviour, prioritisation).
 */

import { assertEquals } from "@std/assert";
import { selectHighestPriority } from "../lib/issue_priority.ts";
import type { IssueCandidate, SelectionResult } from "../lib/issue_priority.ts";

/** The two live repos from the issue report, with their `nice` values. */
const LOW_NICE_REPO = "stSoftwareAU/NEAT-AI-Ockham"; // nice -20
const HIGH_NICE_REPO = "stSoftwareAU/VibeCoder"; // nice -15

const repoNice = (repo: string): number => (repo === LOW_NICE_REPO ? -20 : -15);

/** The label tiers under test, with the labelIndex each collector emits. */
type Tier = "configured-label" | "work-on" | "self-diagnostic" | "low-priority";

const LABEL_INDEX: Record<Tier, number> = {
  "configured-label": 0,
  "work-on": 99,
  "self-diagnostic": 150,
  "low-priority": 199,
};

function makeCandidate(
  overrides: Partial<IssueCandidate> = {},
): IssueCandidate {
  return {
    repo: LOW_NICE_REPO,
    number: 1,
    url: "https://github.com/owner/repo/issues/1",
    title: "Test issue",
    milestone: "",
    createdAt: "2024-01-01T00:00:00Z",
    labelIndex: 0,
    source: "configured-label",
    ...overrides,
  };
}

/** A candidate of `tier`, in `repo`, numbered so the winner is identifiable. */
function candidateFor(
  tier: Tier,
  repo: string,
  number: number,
  createdAt = "2024-01-01T00:00:00Z",
): IssueCandidate {
  return makeCandidate({
    repo,
    number,
    source: tier,
    labelIndex: LABEL_INDEX[tier],
    createdAt,
  });
}

/** Build a SelectionResult holding exactly the supplied candidates. */
function resultOf(candidates: IssueCandidate[]): SelectionResult {
  const bySource = (tier: Tier) => candidates.filter((c) => c.source === tier);
  return {
    selected: null,
    labelCandidates: bySource("configured-label"),
    workOnCandidates: bySource("work-on"),
    selfDiagnosticCandidates: bySource("self-diagnostic"),
    lowPriorityCandidates: bySource("low-priority"),
    idleTaskCandidates: candidates.filter((c) => c.source === "idle-task"),
    blockedEntries: [],
  };
}

// =============================================================================
// The selection matrix — every (tier @ low nice) × (tier @ high nice) cell
// =============================================================================

const TIERS: Tier[] = [
  "configured-label",
  "work-on",
  "self-diagnostic",
  "low-priority",
];

Deno.test(
  "selection matrix - label tier decides first; nice only breaks ties within a tier (Issue #1063)",
  () => {
    for (const lowNiceTier of TIERS) {
      for (const highNiceTier of TIERS) {
        const result = resultOf([
          // #1 lives in the LOWER-`nice` repo (worked sooner within a tier).
          candidateFor(lowNiceTier, LOW_NICE_REPO, 1),
          // #2 lives in the HIGHER-`nice` repo.
          candidateFor(highNiceTier, HIGH_NICE_REPO, 2),
        ]);
        const selected = selectHighestPriority(result, { repoNice });

        // Expected: the better label tier wins outright; on a tie the
        // lower-`nice` repo wins.
        const lowRank = TIERS.indexOf(lowNiceTier);
        const highRank = TIERS.indexOf(highNiceTier);
        const expected = highRank < lowRank ? 2 : 1;

        assertEquals(
          selected?.number,
          expected,
          `${lowNiceTier}@nice-20 vs ${highNiceTier}@nice-15 ` +
            `should select #${expected}, got #${selected?.number}`,
        );
      }
    }
  },
);

// =============================================================================
// The four rows the operator specified, asserted individually
// =============================================================================

Deno.test(
  "selection - top-priority at nice -15 beats work-on at nice -20 (Issue #1063)",
  () => {
    // The live symptom: six ordinary work-on issues at nice -20 outranked two
    // top-priority issues at nice -15. The label tier must decide.
    const result = resultOf([
      candidateFor("work-on", LOW_NICE_REPO, 1),
      candidateFor("configured-label", HIGH_NICE_REPO, 2),
    ]);
    const selected = selectHighestPriority(result, { repoNice });
    assertEquals(selected?.number, 2);
    assertEquals(selected?.repo, HIGH_NICE_REPO);
  },
);

Deno.test(
  "selection - top-priority at nice -20 beats top-priority at nice -15 (Issue #1063)",
  () => {
    // Same tier → `nice` orders the repos, unchanged.
    const result = resultOf([
      candidateFor("configured-label", LOW_NICE_REPO, 1),
      candidateFor("configured-label", HIGH_NICE_REPO, 2),
    ]);
    const selected = selectHighestPriority(result, { repoNice });
    assertEquals(selected?.number, 1);
    assertEquals(selected?.repo, LOW_NICE_REPO);
  },
);

Deno.test(
  "selection - work-on at nice -20 beats work-on at nice -15 (Issue #1063)",
  () => {
    const result = resultOf([
      candidateFor("work-on", LOW_NICE_REPO, 1),
      candidateFor("work-on", HIGH_NICE_REPO, 2),
    ]);
    const selected = selectHighestPriority(result, { repoNice });
    assertEquals(selected?.number, 1);
    assertEquals(selected?.repo, LOW_NICE_REPO);
  },
);

Deno.test(
  "selection - work-on at nice -15 beats low-priority at nice -20 (Issue #1063)",
  () => {
    const result = resultOf([
      candidateFor("low-priority", LOW_NICE_REPO, 1),
      candidateFor("work-on", HIGH_NICE_REPO, 2),
    ]);
    const selected = selectHighestPriority(result, { repoNice });
    assertEquals(selected?.number, 2);
    assertEquals(selected?.repo, HIGH_NICE_REPO);
  },
);

// =============================================================================
// `nice` still orders repos within a tier — the fix must not ignore `nice`
// =============================================================================

Deno.test(
  "selection - nice still orders repos when every candidate shares a tier (Issue #1063)",
  () => {
    // Three repos, three `nice` values, one work-on issue each. The newest
    // issue sits in the lowest-`nice` repo and must still win.
    const nice = (repo: string): number =>
      repo === "owner/a" ? -20 : repo === "owner/b" ? -15 : 0;
    const result = resultOf([
      candidateFor("work-on", "owner/c", 3, "2024-01-01T00:00:00Z"),
      candidateFor("work-on", "owner/b", 2, "2024-02-01T00:00:00Z"),
      candidateFor("work-on", "owner/a", 1, "2024-06-01T00:00:00Z"),
    ]);
    assertEquals(
      selectHighestPriority(result, { repoNice: nice })?.repo,
      "owner/a",
    );
  },
);

Deno.test(
  "selection - configured-label ordering outranks nice within tier 1 (Issue #1063)",
  () => {
    // Two configured discovery labels: labelIndex 0 outranks labelIndex 1 even
    // when the labelIndex-1 issue sits in a lower-`nice` repo. The label is
    // the urgency signal; `nice` only separates equally-urgent repos.
    const result: SelectionResult = {
      selected: null,
      labelCandidates: [
        makeCandidate({
          number: 1,
          repo: LOW_NICE_REPO,
          labelIndex: 1,
          createdAt: "2024-01-01T00:00:00Z",
        }),
        makeCandidate({
          number: 2,
          repo: HIGH_NICE_REPO,
          labelIndex: 0,
          createdAt: "2024-02-01T00:00:00Z",
        }),
      ],
      workOnCandidates: [],
      blockedEntries: [],
    };
    assertEquals(selectHighestPriority(result, { repoNice })?.number, 2);
  },
);

// =============================================================================
// Starvation direction — the failure the operator reported
// =============================================================================

Deno.test(
  "selection - an unbounded low-nice work-on backlog never starves a high-nice top-priority (Issue #1063)",
  () => {
    // 200 ordinary work-on issues in the lowest-`nice` repo, one top-priority
    // in the higher-`nice` repo. The top-priority issue is selected on every
    // pass, so no amount of routine backlog can starve it.
    const backlog = Array.from(
      { length: 200 },
      (_, i) =>
        candidateFor(
          "work-on",
          LOW_NICE_REPO,
          1000 + i,
          `2023-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        ),
    );
    const result = resultOf([
      ...backlog,
      candidateFor("configured-label", HIGH_NICE_REPO, 997),
    ]);
    for (const randomFn of [() => 0, () => 0.5, () => 0.99]) {
      const selected = selectHighestPriority(result, { repoNice, randomFn });
      assertEquals(selected?.number, 997);
      assertEquals(selected?.repo, HIGH_NICE_REPO);
    }
  },
);

// =============================================================================
// The idle-task fleet-global floor (Issue #2812) survives the re-ordering
// =============================================================================

Deno.test(
  "selection - idle-task in the lowest-nice repo still loses to real work anywhere (Issue #1063 / #2812)",
  () => {
    const result: SelectionResult = {
      selected: null,
      labelCandidates: [],
      workOnCandidates: [],
      selfDiagnosticCandidates: [],
      lowPriorityCandidates: [
        candidateFor("low-priority", HIGH_NICE_REPO, 2),
      ],
      idleTaskCandidates: [
        makeCandidate({
          number: 1,
          repo: LOW_NICE_REPO,
          source: "idle-task",
          labelIndex: 299,
        }),
      ],
      blockedEntries: [],
    };
    const selected = selectHighestPriority(result, { repoNice });
    assertEquals(selected?.number, 2);
    assertEquals(selected?.source, "low-priority");
  },
);

Deno.test(
  "selection - idle-task is selected once every real-work tier is drained fleet-wide (Issue #1063 / #2812)",
  () => {
    const result: SelectionResult = {
      selected: null,
      labelCandidates: [],
      workOnCandidates: [],
      selfDiagnosticCandidates: [],
      lowPriorityCandidates: [],
      idleTaskCandidates: [
        makeCandidate({
          number: 2,
          repo: HIGH_NICE_REPO,
          source: "idle-task",
          labelIndex: 299,
        }),
        makeCandidate({
          number: 1,
          repo: LOW_NICE_REPO,
          source: "idle-task",
          labelIndex: 299,
        }),
      ],
      blockedEntries: [],
    };
    const selected = selectHighestPriority(result, { repoNice });
    // Lowest `nice` first within the idle-task tier.
    assertEquals(selected?.number, 1);
    assertEquals(selected?.repo, LOW_NICE_REPO);
  },
);

// =============================================================================
// Suppression and blocking rules are unchanged by the re-ordering
// =============================================================================

Deno.test(
  "selection - a blocked top-priority still suppresses work-on in the same repo+milestone (Issue #1063)",
  () => {
    // The higher-`nice` repo's work-on is suppressed by its blocked
    // top-priority, so the lower-`nice` repo's work-on wins the tier.
    const result: SelectionResult = {
      selected: null,
      labelCandidates: [],
      workOnCandidates: [
        makeCandidate({
          number: 2,
          repo: HIGH_NICE_REPO,
          milestone: "v1",
          source: "work-on",
          labelIndex: 99,
        }),
        makeCandidate({
          number: 1,
          repo: LOW_NICE_REPO,
          source: "work-on",
          labelIndex: 99,
          createdAt: "2024-06-01T00:00:00Z",
        }),
      ],
      blockedEntries: [{ repo: HIGH_NICE_REPO, milestone: "v1" }],
    };
    const selected = selectHighestPriority(result, { repoNice });
    assertEquals(selected?.number, 1);
    assertEquals(selected?.repo, LOW_NICE_REPO);
  },
);

Deno.test(
  "selection - Issue #2164 repo suppression of low-priority survives the re-ordering (Issue #1063)",
  () => {
    // The lower-`nice` repo has an open (blocked) work-on, so its own
    // low-priority backlog is suppressed and the higher-`nice` repo's
    // low-priority is selected.
    const result: SelectionResult = {
      selected: null,
      labelCandidates: [],
      workOnCandidates: [
        makeCandidate({
          number: 1,
          repo: LOW_NICE_REPO,
          milestone: "v1",
          source: "work-on",
          labelIndex: 99,
        }),
      ],
      blockedEntries: [{ repo: LOW_NICE_REPO, milestone: "v1" }],
      lowPriorityCandidates: [
        candidateFor("low-priority", LOW_NICE_REPO, 2),
        candidateFor("low-priority", HIGH_NICE_REPO, 3),
      ],
      reposWithOpenWorkOn: new Set([LOW_NICE_REPO]),
    };
    const selected = selectHighestPriority(result, { repoNice });
    assertEquals(selected?.number, 3);
    assertEquals(selected?.repo, HIGH_NICE_REPO);
  },
);
