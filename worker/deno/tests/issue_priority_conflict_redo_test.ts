/**
 * Merge-conflict abandon-and-redo is the next pickup in its repo
 * (Issue #3034).
 *
 * An issue re-queued by merge-conflict abandon-and-redo (whose redo has not
 * yet raised a PR) must be worked next *in its repo* ahead of every other
 * candidate there — including `top-priority` — through pickup ordering, not
 * a label. The lift is scoped to the repo the ordinary tier ladder has
 * already chosen: it never displaces another repo's winner, and week-pace
 * (Issue #1885) still refuses a low-priority/idle-task redo exactly as it
 * refuses those tiers today.
 *
 * Australian English throughout (behaviour, prioritisation).
 */

import { assertEquals } from "@std/assert";
import {
  orderCandidatesByNiceTier,
  selectFairWithinTier,
  selectHighestPriority,
} from "../lib/issue_priority.ts";
import type { IssueCandidate, SelectionResult } from "../lib/issue_priority.ts";

type Tier =
  | "configured-label"
  | "work-on"
  | "self-diagnostic"
  | "low-priority"
  | "idle-task";

const LABEL_INDEX: Record<Tier, number> = {
  "configured-label": 0,
  "work-on": 99,
  "self-diagnostic": 150,
  "low-priority": 199,
  "idle-task": 299,
};

/** Build a candidate, defaulting to a `configured-label` tier-1 issue. */
function makeCandidate(
  overrides: Partial<IssueCandidate> = {},
): IssueCandidate {
  return {
    repo: "owner/repo",
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

/** A plain (non-redo) candidate of `tier`, in `repo`. */
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

/** A conflict-redo candidate of `tier`, in `repo`. */
function redoFor(
  tier: Tier,
  repo: string,
  number: number,
  restartedAt: string,
  createdAt = "2024-01-01T00:00:00Z",
): IssueCandidate {
  return makeCandidate({
    repo,
    number,
    source: tier,
    labelIndex: LABEL_INDEX[tier],
    createdAt,
    conflictRedo: { restartedAt },
  });
}

/** Build a SelectionResult holding exactly the supplied candidates. */
function resultOf(
  candidates: IssueCandidate[],
  extra: Partial<SelectionResult> = {},
): SelectionResult {
  const bySource = (tier: Tier) => candidates.filter((c) => c.source === tier);
  return {
    selected: null,
    labelCandidates: bySource("configured-label"),
    workOnCandidates: bySource("work-on"),
    selfDiagnosticCandidates: bySource("self-diagnostic"),
    lowPriorityCandidates: bySource("low-priority"),
    idleTaskCandidates: bySource("idle-task"),
    blockedEntries: [],
    ...extra,
  };
}

Deno.test(
  "selectHighestPriority - redo work-on beats an older top-priority in the same repo (Issue #3034)",
  () => {
    const repo = "owner/repo";
    const result = resultOf([
      candidateFor("configured-label", repo, 1, "2023-01-01T00:00:00Z"),
      redoFor("work-on", repo, 2, "2024-06-01T00:00:00Z"),
    ]);
    const selected = selectHighestPriority(result);
    assertEquals(selected?.number, 2);
  },
);

Deno.test(
  "selectHighestPriority - redo idle-task beats a work-on in the same repo (Issue #3034)",
  () => {
    const repo = "owner/repo";
    const result = resultOf([
      candidateFor("work-on", repo, 1),
      redoFor("idle-task", repo, 2, "2024-06-01T00:00:00Z"),
    ]);
    const selected = selectHighestPriority(result);
    assertEquals(selected?.number, 2);
  },
);

Deno.test(
  "selectHighestPriority - redo low-priority beats a work-on in the same repo (Issue #3034)",
  () => {
    const repo = "owner/repo";
    const result = resultOf([
      candidateFor("work-on", repo, 1),
      redoFor("low-priority", repo, 2, "2024-06-01T00:00:00Z"),
    ]);
    const selected = selectHighestPriority(result);
    assertEquals(selected?.number, 2);
  },
);

Deno.test(
  "selectHighestPriority - redo idle-task is selected despite reposWithOpenWorkOn/LowPriority suppression (Issue #3034)",
  () => {
    const repo = "owner/repo";
    const result = resultOf(
      [redoFor("idle-task", repo, 1, "2024-06-01T00:00:00Z")],
      {
        reposWithOpenWorkOn: new Set([repo]),
        reposWithOpenLowPriority: new Set([repo]),
      },
    );
    const selected = selectHighestPriority(result);
    assertEquals(selected?.number, 1);
  },
);

Deno.test(
  "selectHighestPriority - the oldest restartedAt redo wins even when its createdAt is newer (Issue #3034)",
  () => {
    const repo = "owner/repo";
    const result = resultOf([
      candidateFor("work-on", repo, 1),
      redoFor(
        "idle-task",
        repo,
        2,
        "2024-03-01T00:00:00Z",
        "2024-09-01T00:00:00Z",
      ),
      redoFor(
        "low-priority",
        repo,
        3,
        "2024-01-01T00:00:00Z",
        "2024-01-15T00:00:00Z",
      ),
    ]);
    const selected = selectHighestPriority(result);
    assertEquals(selected?.number, 3);
  },
);

Deno.test(
  "selectHighestPriority - a redo in repo A does not displace a top-priority winner in repo B (Issue #3034)",
  () => {
    const repoA = "owner/a";
    const repoB = "owner/b";
    const result = resultOf([
      candidateFor("configured-label", repoB, 1, "2024-01-01T00:00:00Z"),
      redoFor("idle-task", repoA, 2, "2024-06-01T00:00:00Z"),
    ]);
    const selected = selectHighestPriority(result);
    assertEquals(selected?.number, 1);
    assertEquals(selected?.repo, repoB);
  },
);

Deno.test(
  "selectHighestPriority - week-pace still refuses an idle-task redo and keeps the work-on winner (Issue #1885, #3034)",
  () => {
    const repo = "owner/repo";
    const result = resultOf([
      candidateFor("work-on", repo, 1),
      redoFor("idle-task", repo, 2, "2024-06-01T00:00:00Z"),
    ]);
    const selected = selectHighestPriority(result, { weekPaceEngaged: true });
    assertEquals(selected?.number, 1);
  },
);

Deno.test(
  "selectFairWithinTier - returns the redo ahead of an older same-repo candidate in the same tier (Issue #3034)",
  () => {
    const repo = "owner/repo";
    const candidates = [
      candidateFor("work-on", repo, 1, "2023-01-01T00:00:00Z"),
      redoFor("work-on", repo, 2, "2024-06-01T00:00:00Z"),
    ];
    const selected = selectFairWithinTier(candidates);
    assertEquals(selected?.number, 2);
  },
);

Deno.test(
  "orderCandidatesByNiceTier - first entry is the redo ahead of an older same-repo candidate (Issue #3034)",
  () => {
    const repo = "owner/repo";
    const candidates = [
      candidateFor("work-on", repo, 1, "2023-01-01T00:00:00Z"),
      redoFor("work-on", repo, 2, "2024-06-01T00:00:00Z"),
    ];
    const ordered = orderCandidatesByNiceTier(candidates);
    assertEquals(ordered[0]?.number, 2);
  },
);

Deno.test(
  "selectHighestPriority - without any conflictRedo, selection matches today's behaviour (Issue #3034)",
  () => {
    const repo = "owner/repo";
    const result = resultOf([
      candidateFor("configured-label", repo, 1, "2023-01-01T00:00:00Z"),
      candidateFor("configured-label", repo, 2, "2024-06-01T00:00:00Z"),
    ]);
    const selected = selectHighestPriority(result);
    assertEquals(selected?.number, 1);
  },
);
