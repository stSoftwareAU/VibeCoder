/**
 * Tests for issue_priority.ts (Issue #910).
 */

import { assertEquals } from "@std/assert";
import {
  formatCandidateOutput,
  orderCandidatesByNiceTier,
  selectFairWithinTier,
  selectHighestPriority,
  selectOldestCandidate,
  sortCandidatesByAge,
} from "../lib/issue_priority.ts";
import type {
  IssueCandidate,
  SelectionOptions,
  SelectionResult,
} from "../lib/issue_priority.ts";

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

// =============================================================================
// selectOldestCandidate tests
// =============================================================================

Deno.test("issue_priority - selectOldestCandidate returns null for empty list", () => {
  assertEquals(selectOldestCandidate([]), null);
});

Deno.test("issue_priority - selectOldestCandidate returns oldest by createdAt", () => {
  const candidates = [
    makeCandidate({ number: 3, createdAt: "2024-03-01T00:00:00Z" }),
    makeCandidate({ number: 1, createdAt: "2024-01-01T00:00:00Z" }),
    makeCandidate({ number: 2, createdAt: "2024-02-01T00:00:00Z" }),
  ];
  const result = selectOldestCandidate(candidates);
  assertEquals(result?.number, 1);
});

Deno.test("issue_priority - selectOldestCandidate prefers lower labelIndex", () => {
  const candidates = [
    makeCandidate({
      number: 2,
      labelIndex: 1,
      createdAt: "2024-01-01T00:00:00Z",
    }),
    makeCandidate({
      number: 1,
      labelIndex: 0,
      createdAt: "2024-02-01T00:00:00Z",
    }),
  ];
  const result = selectOldestCandidate(candidates);
  assertEquals(result?.number, 1); // Lower label index takes priority
});

// =============================================================================
// sortCandidatesByAge tests
// =============================================================================

Deno.test("issue_priority - sortCandidatesByAge sorts oldest first", () => {
  const candidates = [
    makeCandidate({ number: 3, createdAt: "2024-03-01T00:00:00Z" }),
    makeCandidate({ number: 1, createdAt: "2024-01-01T00:00:00Z" }),
    makeCandidate({ number: 2, createdAt: "2024-02-01T00:00:00Z" }),
  ];
  const result = sortCandidatesByAge(candidates);
  assertEquals(result[0]?.number, 1);
  assertEquals(result[1]?.number, 2);
  assertEquals(result[2]?.number, 3);
});

// =============================================================================
// selectHighestPriority tests
// =============================================================================

Deno.test("issue_priority - selectHighestPriority prefers label candidates", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [makeCandidate({ number: 1, source: "configured-label" })],
    workOnCandidates: [makeCandidate({ number: 2, source: "work-on" })],
    blockedEntries: [],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 1);
});

Deno.test("issue_priority - selectHighestPriority falls back to work-on when no label candidates", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [makeCandidate({ number: 2, source: "work-on" })],
    blockedEntries: [],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 2);
});

Deno.test("issue_priority - selectHighestPriority blocks work-on in same repo+milestone", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [
      makeCandidate({
        number: 1,
        repo: "owner/repo",
        milestone: "v1.0",
        source: "work-on",
      }),
      makeCandidate({
        number: 2,
        repo: "owner/repo2",
        milestone: "",
        source: "work-on",
      }),
    ],
    blockedEntries: [{ repo: "owner/repo", milestone: "v1.0" }],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 2); // Selects unblocked candidate
});

Deno.test("issue_priority - selectHighestPriority returns null when all work-on blocked", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [
      makeCandidate({
        number: 1,
        repo: "owner/repo",
        milestone: "v1.0",
        source: "work-on",
      }),
    ],
    blockedEntries: [{ repo: "owner/repo", milestone: "v1.0" }],
  };
  assertEquals(selectHighestPriority(result), null);
});

// Cross-repo regression tests (Issue #1720). Mirror the production
// pattern where candidates from different repos arrive in a single
// SelectionResult, so we can guarantee tier ordering across repos.

Deno.test(
  "selectHighestPriority - cross-repo: top-priority in repo A wins over work-on in repo B",
  () => {
    const result: SelectionResult = {
      selected: null,
      labelCandidates: [
        makeCandidate({
          number: 1,
          repo: "owner/repo-a",
          source: "configured-label",
          labelIndex: 0,
          // Newer than the work-on candidate to prove createdAt is irrelevant.
          createdAt: "2024-06-01T00:00:00Z",
        }),
      ],
      workOnCandidates: [
        makeCandidate({
          number: 2,
          repo: "owner/repo-b",
          source: "work-on",
          labelIndex: 99,
          createdAt: "2024-01-01T00:00:00Z",
        }),
      ],
      blockedEntries: [],
    };
    const selected = selectHighestPriority(result);
    assertEquals(selected?.number, 1);
    assertEquals(selected?.repo, "owner/repo-a");
    assertEquals(selected?.source, "configured-label");
  },
);

Deno.test(
  "selectHighestPriority - cross-repo: top-priority blocked in repo A allows work-on in repo B",
  () => {
    // No surviving label candidate; a blocked entry is recorded for repo A
    // (e.g. the configured-label issue in repo A is dependency-blocked).
    // The blocked entry is repo+milestone scoped, so it must NOT suppress
    // the work-on candidate sitting in a different repo.
    const result: SelectionResult = {
      selected: null,
      labelCandidates: [],
      workOnCandidates: [
        makeCandidate({
          number: 2,
          repo: "owner/repo-b",
          milestone: "",
          source: "work-on",
          labelIndex: 99,
          createdAt: "2024-02-01T00:00:00Z",
        }),
      ],
      blockedEntries: [{ repo: "owner/repo-a", milestone: "" }],
    };
    const selected = selectHighestPriority(result);
    assertEquals(selected?.number, 2);
    assertEquals(selected?.repo, "owner/repo-b");
    assertEquals(selected?.source, "work-on");
  },
);

Deno.test(
  "selectHighestPriority - across labels: top-priority (labelIndex 0) beats help wanted (labelIndex 1) beats claude (labelIndex 2)",
  () => {
    // All three configured-label tiers in the same repo. labelIndex
    // ordering must dominate createdAt — the top-priority candidate is
    // newest but still wins.
    const topPriority = makeCandidate({
      number: 10,
      source: "configured-label",
      labelIndex: 0,
      createdAt: "2024-06-01T00:00:00Z",
    });
    const helpWanted = makeCandidate({
      number: 20,
      source: "configured-label",
      labelIndex: 1,
      createdAt: "2024-03-01T00:00:00Z",
    });
    const claude = makeCandidate({
      number: 30,
      source: "configured-label",
      labelIndex: 2,
      createdAt: "2024-01-01T00:00:00Z",
    });

    // All three present: top-priority wins.
    let selected = selectHighestPriority({
      selected: null,
      labelCandidates: [claude, helpWanted, topPriority],
      workOnCandidates: [],
      blockedEntries: [],
    });
    assertEquals(selected?.number, 10);

    // Drop top-priority: help-wanted wins over claude.
    selected = selectHighestPriority({
      selected: null,
      labelCandidates: [claude, helpWanted],
      workOnCandidates: [],
      blockedEntries: [],
    });
    assertEquals(selected?.number, 20);

    // Drop help-wanted as well: claude is the only survivor.
    selected = selectHighestPriority({
      selected: null,
      labelCandidates: [claude],
      workOnCandidates: [],
      blockedEntries: [],
    });
    assertEquals(selected?.number, 30);
  },
);

Deno.test("issue_priority - selectHighestPriority returns null for empty lists", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [],
    blockedEntries: [],
  };
  assertEquals(selectHighestPriority(result), null);
});

// =============================================================================
// formatCandidateOutput tests
// =============================================================================

Deno.test("issue_priority - formatCandidateOutput creates pipe-delimited string", () => {
  const candidate = makeCandidate({
    repo: "owner/repo",
    number: 42,
    url: "https://github.com/owner/repo/issues/42",
    milestone: "v1.0",
    title: "Fix the bug",
  });
  assertEquals(
    formatCandidateOutput(candidate),
    "owner/repo|42|https://github.com/owner/repo/issues/42|v1.0|Fix the bug",
  );
});

Deno.test("issue_priority - formatCandidateOutput handles empty milestone", () => {
  const candidate = makeCandidate({ milestone: "" });
  const output = formatCandidateOutput(candidate);
  // Should have empty field for milestone
  const parts = output.split("|");
  assertEquals(parts[3], "");
});

// =============================================================================
// Randomised selection tests (Issue #1089)
// =============================================================================

Deno.test("issue_priority - selectOldestCandidate with randomFn selects randomly within same priority", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      labelIndex: 0,
      createdAt: "2024-01-01T00:00:00Z",
    }),
    makeCandidate({
      number: 2,
      labelIndex: 0,
      createdAt: "2024-02-01T00:00:00Z",
    }),
    makeCandidate({
      number: 3,
      labelIndex: 0,
      createdAt: "2024-03-01T00:00:00Z",
    }),
  ];

  // randomFn returns 0.99, which should select a candidate other than the oldest
  // when randomPoolSize allows multiple candidates in the pool
  const opts: SelectionOptions = {
    randomFn: () => 0.99,
    randomPoolSize: 3,
  };
  const result = selectOldestCandidate(candidates, opts);
  // With randomFn returning 0.99, floor(0.99 * 3) = 2, so index 2 → number 3
  assertEquals(result?.number, 3);
});

Deno.test("issue_priority - selectOldestCandidate with randomFn=0 selects oldest (first in pool)", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      labelIndex: 0,
      createdAt: "2024-01-01T00:00:00Z",
    }),
    makeCandidate({
      number: 2,
      labelIndex: 0,
      createdAt: "2024-02-01T00:00:00Z",
    }),
    makeCandidate({
      number: 3,
      labelIndex: 0,
      createdAt: "2024-03-01T00:00:00Z",
    }),
  ];

  const opts: SelectionOptions = {
    randomFn: () => 0,
    randomPoolSize: 3,
  };
  const result = selectOldestCandidate(candidates, opts);
  assertEquals(result?.number, 1);
});

Deno.test("issue_priority - selectOldestCandidate preserves priority ordering with randomisation", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      labelIndex: 1,
      createdAt: "2024-01-01T00:00:00Z",
    }),
    makeCandidate({
      number: 2,
      labelIndex: 0,
      createdAt: "2024-03-01T00:00:00Z",
    }),
    makeCandidate({
      number: 3,
      labelIndex: 0,
      createdAt: "2024-02-01T00:00:00Z",
    }),
  ];

  // Even with randomisation, labelIndex 0 candidates are always chosen over labelIndex 1
  const opts: SelectionOptions = {
    randomFn: () => 0.99,
    randomPoolSize: 5,
  };
  const result = selectOldestCandidate(candidates, opts);
  // Only labelIndex 0 candidates are in the pool (numbers 2 and 3)
  // Sorted by age: 3 (Feb), 2 (Mar). Pool size 5 but only 2 candidates.
  // floor(0.99 * 2) = 1, so index 1 → number 2
  assertEquals(result?.number, 2);
});

Deno.test("issue_priority - selectOldestCandidate randomPoolSize limits the random pool", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      labelIndex: 0,
      createdAt: "2024-01-01T00:00:00Z",
    }),
    makeCandidate({
      number: 2,
      labelIndex: 0,
      createdAt: "2024-02-01T00:00:00Z",
    }),
    makeCandidate({
      number: 3,
      labelIndex: 0,
      createdAt: "2024-03-01T00:00:00Z",
    }),
    makeCandidate({
      number: 4,
      labelIndex: 0,
      createdAt: "2024-04-01T00:00:00Z",
    }),
    makeCandidate({
      number: 5,
      labelIndex: 0,
      createdAt: "2024-05-01T00:00:00Z",
    }),
  ];

  // Pool size 2 means only the 2 oldest (numbers 1 and 2) are eligible
  const opts: SelectionOptions = {
    randomFn: () => 0.99,
    randomPoolSize: 2,
  };
  const result = selectOldestCandidate(candidates, opts);
  // floor(0.99 * 2) = 1, so index 1 → number 2
  assertEquals(result?.number, 2);
});

Deno.test("issue_priority - selectOldestCandidate without options behaves deterministically", () => {
  const candidates = [
    makeCandidate({ number: 3, createdAt: "2024-03-01T00:00:00Z" }),
    makeCandidate({ number: 1, createdAt: "2024-01-01T00:00:00Z" }),
    makeCandidate({ number: 2, createdAt: "2024-02-01T00:00:00Z" }),
  ];
  // Without options, should still pick oldest (backward compatible)
  const result = selectOldestCandidate(candidates);
  assertEquals(result?.number, 1);
});

Deno.test("issue_priority - selectHighestPriority passes through selection options", () => {
  // Issue #2773: selection now rotates fairly *by repo* within the winning
  // tier rather than across the N oldest issues globally. With every
  // candidate in one repo there is only one repo to pick, so oldest-first
  // holds within that repo and the oldest (number 1) is selected
  // regardless of randomFn (previously this returned number 3).
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [
      makeCandidate({
        number: 1,
        source: "configured-label",
        createdAt: "2024-01-01T00:00:00Z",
      }),
      makeCandidate({
        number: 2,
        source: "configured-label",
        createdAt: "2024-02-01T00:00:00Z",
      }),
      makeCandidate({
        number: 3,
        source: "configured-label",
        createdAt: "2024-03-01T00:00:00Z",
      }),
    ],
    workOnCandidates: [],
    blockedEntries: [],
  };

  const opts: SelectionOptions = {
    randomFn: () => 0.99,
    randomPoolSize: 3,
  };
  const selected = selectHighestPriority(result, opts);
  assertEquals(selected?.number, 1);
});

Deno.test("issue_priority - selectHighestPriority rotates work-on candidates by repo", () => {
  // Issue #2773: both work-on candidates live in the same repo, so
  // oldest-first holds within that repo — the oldest (number 1) is
  // selected regardless of randomFn (previously this returned number 2).
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [
      makeCandidate({
        number: 1,
        source: "work-on",
        createdAt: "2024-01-01T00:00:00Z",
      }),
      makeCandidate({
        number: 2,
        source: "work-on",
        createdAt: "2024-02-01T00:00:00Z",
      }),
    ],
    blockedEntries: [],
  };

  const opts: SelectionOptions = {
    randomFn: () => 0.99,
    randomPoolSize: 5,
  };
  const selected = selectHighestPriority(result, opts);
  assertEquals(selected?.number, 1);
});

Deno.test("issue_priority - selectOldestCandidate single candidate always returns it regardless of randomFn", () => {
  const candidates = [
    makeCandidate({ number: 42, createdAt: "2024-01-01T00:00:00Z" }),
  ];
  const opts: SelectionOptions = {
    randomFn: () => 0.99,
    randomPoolSize: 5,
  };
  const result = selectOldestCandidate(candidates, opts);
  assertEquals(result?.number, 42);
});

// =============================================================================
// Tier 3 (low-priority) selection tests (Issue #1725)
// =============================================================================

Deno.test("selectHighestPriority - tier 3 chosen only when label and work-on tiers are empty", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [],
    blockedEntries: [],
    lowPriorityCandidates: [
      makeCandidate({
        number: 7,
        repo: "owner/lp-repo",
        source: "low-priority",
        labelIndex: 199,
        createdAt: "2024-05-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 7);
  assertEquals(selected?.source, "low-priority");
});

Deno.test("selectHighestPriority - tier 3 suppressed by configured-label candidate in any repo", () => {
  // Configured-label candidate in repo A; low-priority candidate in repo B.
  // The cross-repo configured-label candidate must suppress the
  // low-priority candidate everywhere.
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [
      makeCandidate({
        number: 1,
        repo: "owner/repo-a",
        source: "configured-label",
        labelIndex: 0,
        createdAt: "2024-03-01T00:00:00Z",
      }),
    ],
    workOnCandidates: [],
    blockedEntries: [],
    lowPriorityCandidates: [
      makeCandidate({
        number: 99,
        repo: "owner/repo-b",
        source: "low-priority",
        labelIndex: 199,
        createdAt: "2024-01-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 1);
  assertEquals(selected?.source, "configured-label");
});

Deno.test("selectHighestPriority - tier 3 suppressed by work-on candidate in any repo", () => {
  // Work-on candidate in repo A; low-priority candidate in repo B.
  // The cross-repo work-on candidate must suppress the low-priority
  // candidate everywhere.
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [
      makeCandidate({
        number: 5,
        repo: "owner/repo-a",
        source: "work-on",
        labelIndex: 99,
        createdAt: "2024-03-01T00:00:00Z",
      }),
    ],
    blockedEntries: [],
    lowPriorityCandidates: [
      makeCandidate({
        number: 99,
        repo: "owner/repo-b",
        source: "low-priority",
        labelIndex: 199,
        createdAt: "2024-01-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 5);
  assertEquals(selected?.source, "work-on");
});

Deno.test("selectHighestPriority - tier 3 chosen by oldest-first when only low-priority candidates exist", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [],
    blockedEntries: [],
    lowPriorityCandidates: [
      makeCandidate({
        number: 30,
        repo: "owner/repo-c",
        source: "low-priority",
        labelIndex: 199,
        createdAt: "2024-04-01T00:00:00Z",
      }),
      makeCandidate({
        number: 10,
        repo: "owner/repo-a",
        source: "low-priority",
        labelIndex: 199,
        createdAt: "2024-01-01T00:00:00Z",
      }),
      makeCandidate({
        number: 20,
        repo: "owner/repo-b",
        source: "low-priority",
        labelIndex: 199,
        createdAt: "2024-02-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 10);
  assertEquals(selected?.source, "low-priority");
});

// =============================================================================
// Tier 4 (idle-task) selection tests (Issue #1961)
// =============================================================================

Deno.test("selectHighestPriority - idle-task chosen only when every other tier is empty", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [],
    blockedEntries: [],
    lowPriorityCandidates: [],
    idleTaskCandidates: [
      makeCandidate({
        number: 42,
        repo: "owner/idle-repo",
        source: "idle-task",
        labelIndex: 299,
        createdAt: "2024-04-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 42);
  assertEquals(selected?.source, "idle-task");
});

Deno.test("selectHighestPriority - low-priority candidate beats idle-task candidate", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [],
    blockedEntries: [],
    lowPriorityCandidates: [
      makeCandidate({
        number: 5,
        repo: "owner/lp-repo",
        source: "low-priority",
        labelIndex: 199,
        // Newer than the idle-task candidate to prove tier dominates age.
        createdAt: "2024-06-01T00:00:00Z",
      }),
    ],
    idleTaskCandidates: [
      makeCandidate({
        number: 99,
        repo: "owner/idle-repo",
        source: "idle-task",
        labelIndex: 299,
        createdAt: "2024-01-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 5);
  assertEquals(selected?.source, "low-priority");
});

Deno.test("selectHighestPriority - idle-task suppressed by configured-label in any repo", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [
      makeCandidate({
        number: 1,
        repo: "owner/repo-a",
        source: "configured-label",
        labelIndex: 0,
        createdAt: "2024-03-01T00:00:00Z",
      }),
    ],
    workOnCandidates: [],
    blockedEntries: [],
    idleTaskCandidates: [
      makeCandidate({
        number: 99,
        repo: "owner/repo-b",
        source: "idle-task",
        labelIndex: 299,
        createdAt: "2024-01-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 1);
  assertEquals(selected?.source, "configured-label");
});

Deno.test("selectHighestPriority - idle-task suppressed by work-on candidate in any repo", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [
      makeCandidate({
        number: 5,
        repo: "owner/repo-a",
        source: "work-on",
        labelIndex: 99,
        createdAt: "2024-03-01T00:00:00Z",
      }),
    ],
    blockedEntries: [],
    idleTaskCandidates: [
      makeCandidate({
        number: 99,
        repo: "owner/repo-b",
        source: "idle-task",
        labelIndex: 299,
        createdAt: "2024-01-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 5);
  assertEquals(selected?.source, "work-on");
});

Deno.test("selectHighestPriority - idle-task chosen when low-priority empty and work-on blocked", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [
      makeCandidate({
        number: 11,
        repo: "owner/repo-a",
        milestone: "v1.0",
        source: "work-on",
        labelIndex: 99,
      }),
    ],
    blockedEntries: [{ repo: "owner/repo-a", milestone: "v1.0" }],
    lowPriorityCandidates: [],
    idleTaskCandidates: [
      makeCandidate({
        number: 77,
        repo: "owner/repo-b",
        source: "idle-task",
        labelIndex: 299,
        createdAt: "2024-01-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 77);
  assertEquals(selected?.source, "idle-task");
});

Deno.test("selectHighestPriority - idle-task chosen by oldest-first among idle-task candidates", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [],
    blockedEntries: [],
    lowPriorityCandidates: [],
    idleTaskCandidates: [
      makeCandidate({
        number: 30,
        repo: "owner/repo-c",
        source: "idle-task",
        labelIndex: 299,
        createdAt: "2024-04-01T00:00:00Z",
      }),
      makeCandidate({
        number: 10,
        repo: "owner/repo-a",
        source: "idle-task",
        labelIndex: 299,
        createdAt: "2024-01-01T00:00:00Z",
      }),
      makeCandidate({
        number: 20,
        repo: "owner/repo-b",
        source: "idle-task",
        labelIndex: 299,
        createdAt: "2024-02-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 10);
  assertEquals(selected?.source, "idle-task");
});

Deno.test("selectHighestPriority - low-priority chosen over idle-task when work-on blocked", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [
      makeCandidate({
        number: 11,
        repo: "owner/repo-a",
        milestone: "v1.0",
        source: "work-on",
        labelIndex: 99,
      }),
    ],
    blockedEntries: [{ repo: "owner/repo-a", milestone: "v1.0" }],
    lowPriorityCandidates: [
      makeCandidate({
        number: 55,
        repo: "owner/repo-b",
        source: "low-priority",
        labelIndex: 199,
        createdAt: "2024-04-01T00:00:00Z",
      }),
    ],
    idleTaskCandidates: [
      makeCandidate({
        number: 77,
        repo: "owner/repo-c",
        source: "idle-task",
        labelIndex: 299,
        createdAt: "2024-01-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 55);
  assertEquals(selected?.source, "low-priority");
});

Deno.test("selectHighestPriority - tier 3 chosen when all work-on are blocked and no label candidates", () => {
  // Work-on candidates exist but every one is in a blocked repo+milestone.
  // After suppression the eligible work-on tier is empty, so tier 3 fires.
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [
      makeCandidate({
        number: 11,
        repo: "owner/repo-a",
        milestone: "v1.0",
        source: "work-on",
        labelIndex: 99,
      }),
    ],
    blockedEntries: [{ repo: "owner/repo-a", milestone: "v1.0" }],
    lowPriorityCandidates: [
      makeCandidate({
        number: 77,
        repo: "owner/repo-b",
        source: "low-priority",
        labelIndex: 199,
        createdAt: "2024-01-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 77);
  assertEquals(selected?.source, "low-priority");
});

// =============================================================================
// Issue #2164 — repo-level work-on suppression of low-priority/idle-task
// =============================================================================

Deno.test(
  "selectHighestPriority - low-priority in repo with open work-on is suppressed (Issue #2164)",
  () => {
    // Reproduces the original bug:
    //   - VibeCoder has a work-on issue (#2160) that is dependency-blocked
    //     by another open issue and so never reaches `workOnCandidates`.
    //   - VibeCoder also has a low-priority issue (#2163) with no blockers.
    // Before the fix, the worker would pick the low-priority issue from the
    // same repo even though an open work-on issue existed. The fix suppresses
    // low-priority candidates from any repo present in `reposWithOpenWorkOn`.
    const result: SelectionResult = {
      selected: null,
      labelCandidates: [],
      // No work-on candidate survived per-issue eligibility filters.
      workOnCandidates: [],
      blockedEntries: [],
      lowPriorityCandidates: [
        makeCandidate({
          number: 2163,
          repo: "stSoftwareAU/VibeCoder",
          source: "low-priority",
          labelIndex: 199,
          createdAt: "2026-05-21T23:43:22Z",
        }),
      ],
      reposWithOpenWorkOn: new Set(["stSoftwareAU/VibeCoder"]),
    };
    assertEquals(selectHighestPriority(result), null);
  },
);

Deno.test(
  "selectHighestPriority - low-priority in a different repo than the open work-on is still selectable (Issue #2164)",
  () => {
    // Per-repo suppression — work-on in repo A must not suppress
    // low-priority in repo B (different work streams).
    const result: SelectionResult = {
      selected: null,
      labelCandidates: [],
      workOnCandidates: [],
      blockedEntries: [],
      lowPriorityCandidates: [
        makeCandidate({
          number: 7,
          repo: "owner/repo-b",
          source: "low-priority",
          labelIndex: 199,
          createdAt: "2024-01-01T00:00:00Z",
        }),
      ],
      reposWithOpenWorkOn: new Set(["owner/repo-a"]),
    };
    const selected = selectHighestPriority(result);
    assertEquals(selected?.number, 7);
    assertEquals(selected?.repo, "owner/repo-b");
    assertEquals(selected?.source, "low-priority");
  },
);

Deno.test(
  "selectHighestPriority - idle-task in repo with open work-on is suppressed (Issue #2164)",
  () => {
    const result: SelectionResult = {
      selected: null,
      labelCandidates: [],
      workOnCandidates: [],
      blockedEntries: [],
      lowPriorityCandidates: [],
      idleTaskCandidates: [
        makeCandidate({
          number: 42,
          repo: "owner/repo-a",
          source: "idle-task",
          labelIndex: 299,
          createdAt: "2024-04-01T00:00:00Z",
        }),
      ],
      reposWithOpenWorkOn: new Set(["owner/repo-a"]),
    };
    assertEquals(selectHighestPriority(result), null);
  },
);

Deno.test(
  "selectHighestPriority - idle-task in repo with open low-priority is suppressed (Issue #2164)",
  () => {
    const result: SelectionResult = {
      selected: null,
      labelCandidates: [],
      workOnCandidates: [],
      blockedEntries: [],
      lowPriorityCandidates: [],
      idleTaskCandidates: [
        makeCandidate({
          number: 42,
          repo: "owner/repo-a",
          source: "idle-task",
          labelIndex: 299,
          createdAt: "2024-04-01T00:00:00Z",
        }),
      ],
      reposWithOpenLowPriority: new Set(["owner/repo-a"]),
    };
    assertEquals(selectHighestPriority(result), null);
  },
);

Deno.test(
  "selectHighestPriority - blocked configured-label fall-through still respects work-on suppression (Issue #2164)",
  () => {
    // Hybrid scenario — blocked configured-label triggers the fall-through
    // path; low-priority is in the same repo as an open work-on; idle-task is
    // in a different repo. The fall-through should pick the idle-task in the
    // unaffected repo, not the suppressed low-priority.
    const result: SelectionResult = {
      selected: null,
      labelCandidates: [],
      workOnCandidates: [
        makeCandidate({
          number: 1,
          repo: "owner/repo-a",
          milestone: "v1.0",
          source: "work-on",
          labelIndex: 99,
        }),
      ],
      blockedEntries: [{ repo: "owner/repo-a", milestone: "v1.0" }],
      lowPriorityCandidates: [
        makeCandidate({
          number: 2,
          repo: "owner/repo-a",
          source: "low-priority",
          labelIndex: 199,
          createdAt: "2024-01-01T00:00:00Z",
        }),
      ],
      idleTaskCandidates: [
        makeCandidate({
          number: 3,
          repo: "owner/repo-b",
          source: "idle-task",
          labelIndex: 299,
          createdAt: "2024-02-01T00:00:00Z",
        }),
      ],
      reposWithOpenWorkOn: new Set(["owner/repo-a"]),
    };
    const selected = selectHighestPriority(result);
    // Work-on in repo-a is fully blocked, low-priority in repo-a is
    // suppressed by Issue #2164, so the idle-task in repo-b survives.
    assertEquals(selected?.number, 3);
    assertEquals(selected?.repo, "owner/repo-b");
    assertEquals(selected?.source, "idle-task");
  },
);

// =============================================================================
// nice-tier gating + fair within-tier repo rotation (Issue #2773)
// =============================================================================

Deno.test("selectFairWithinTier - empty list returns null", () => {
  assertEquals(selectFairWithinTier([]), null);
});

Deno.test("selectFairWithinTier - no randomFn returns globally-best (parity)", () => {
  const candidates = [
    makeCandidate({
      number: 3,
      repo: "owner/a",
      createdAt: "2024-03-01T00:00:00Z",
    }),
    makeCandidate({
      number: 1,
      repo: "owner/b",
      createdAt: "2024-01-01T00:00:00Z",
    }),
    makeCandidate({
      number: 2,
      repo: "owner/a",
      createdAt: "2024-02-01T00:00:00Z",
    }),
  ];
  // Deterministic path: oldest overall (number 1), identical to
  // selectOldestCandidate with no options.
  assertEquals(selectFairWithinTier(candidates)?.number, 1);
  assertEquals(selectOldestCandidate(candidates)?.number, 1);
});

Deno.test("selectFairWithinTier - rotates by repo, oldest-first within the chosen repo", () => {
  const candidates = [
    // repo-a holds the two oldest issues; repo-b has fresher work.
    makeCandidate({
      number: 1,
      repo: "owner/a",
      createdAt: "2024-01-01T00:00:00Z",
    }),
    makeCandidate({
      number: 2,
      repo: "owner/a",
      createdAt: "2024-02-01T00:00:00Z",
    }),
    makeCandidate({
      number: 3,
      repo: "owner/b",
      createdAt: "2024-03-01T00:00:00Z",
    }),
  ];
  // Distinct repos in oldest-first appearance order: [owner/a, owner/b].
  // randomFn 0 → repo index 0 (owner/a) → oldest within it = number 1.
  assertEquals(
    selectFairWithinTier(candidates, { randomFn: () => 0 })?.number,
    1,
  );
  // randomFn 0.99 → floor(0.99*2)=1 → repo index 1 (owner/b) → number 3.
  // The old N-oldest-pool bias could never reach repo-b's fresh work.
  assertEquals(
    selectFairWithinTier(candidates, { randomFn: () => 0.99 })?.number,
    3,
  );
});

Deno.test("selectFairWithinTier - only the winning labelIndex sub-tier is eligible", () => {
  const candidates = [
    makeCandidate({
      number: 1,
      repo: "owner/a",
      labelIndex: 1,
      createdAt: "2024-01-01T00:00:00Z",
    }),
    makeCandidate({
      number: 2,
      repo: "owner/b",
      labelIndex: 0,
      createdAt: "2024-02-01T00:00:00Z",
    }),
  ];
  // Even with randomFn driving toward a higher index, only labelIndex 0
  // (number 2) is in the sub-tier, so it is always chosen.
  assertEquals(
    selectFairWithinTier(candidates, { randomFn: () => 0.99 })?.number,
    2,
  );
});

Deno.test("selectHighestPriority - default nice everywhere is parity with no randomFn", () => {
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [
      makeCandidate({
        number: 3,
        repo: "owner/a",
        createdAt: "2024-03-01T00:00:00Z",
      }),
      makeCandidate({
        number: 1,
        repo: "owner/b",
        createdAt: "2024-01-01T00:00:00Z",
      }),
      makeCandidate({
        number: 2,
        repo: "owner/a",
        createdAt: "2024-02-01T00:00:00Z",
      }),
    ],
    workOnCandidates: [],
    blockedEntries: [],
  };
  // No repoNice, no randomFn → identical to current behaviour (oldest).
  assertEquals(selectHighestPriority(result)?.number, 1);
});

Deno.test("selectHighestPriority - lower-nice repo is drained before any higher-nice repo", () => {
  const repoNice = (repo: string) => (repo === "owner/low" ? 0 : 10);
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [
      // higher-nice repo holds the globally-oldest work-on issue ...
      makeCandidate({
        number: 1,
        repo: "owner/high",
        source: "work-on",
        createdAt: "2024-01-01T00:00:00Z",
      }),
      // ... but the lower-nice repo must still win.
      makeCandidate({
        number: 2,
        repo: "owner/low",
        source: "work-on",
        createdAt: "2024-06-01T00:00:00Z",
      }),
    ],
    blockedEntries: [],
  };
  const selected = selectHighestPriority(result, { repoNice });
  assertEquals(selected?.number, 2);
  assertEquals(selected?.repo, "owner/low");
});

Deno.test("selectHighestPriority - higher-nice tier reached only when lower-nice yields nothing", () => {
  const repoNice = (repo: string) => (repo === "owner/low" ? 0 : 10);
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    // The low-nice repo's only work-on is blocked, so its tier yields
    // nothing selectable; the high-nice repo's work-on is then reached.
    workOnCandidates: [
      makeCandidate({
        number: 1,
        repo: "owner/low",
        milestone: "v1",
        source: "work-on",
        createdAt: "2024-01-01T00:00:00Z",
      }),
      makeCandidate({
        number: 2,
        repo: "owner/high",
        source: "work-on",
        createdAt: "2024-02-01T00:00:00Z",
      }),
    ],
    blockedEntries: [{ repo: "owner/low", milestone: "v1" }],
  };
  const selected = selectHighestPriority(result, { repoNice });
  assertEquals(selected?.number, 2);
  assertEquals(selected?.repo, "owner/high");
});

Deno.test("selectHighestPriority - label tier gates nice across repos (Issue #1063)", () => {
  // A configured-label (tier 1) issue lives in a high-nice repo; a work-on
  // (tier 2) issue lives in a low-nice repo.
  //
  // Business-logic change (Issue #1063, superseding Issue #2773): the LABEL
  // TIER is now the outermost grouping and `nice` orders repos within a tier,
  // so the configured-label issue wins despite its repo's higher `nice`. This
  // test previously asserted the inverse ("nice tier gates higher priority
  // across repos") — the operator's recorded decision is that `nice` is a
  // tie-breaker inside a priority band, never a band of its own.
  const repoNice = (repo: string) => (repo === "owner/low" ? 0 : 10);
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [
      makeCandidate({
        number: 1,
        repo: "owner/high",
        source: "configured-label",
        createdAt: "2024-01-01T00:00:00Z",
      }),
    ],
    workOnCandidates: [
      makeCandidate({
        number: 2,
        repo: "owner/low",
        source: "work-on",
        createdAt: "2024-02-01T00:00:00Z",
      }),
    ],
    blockedEntries: [],
  };
  const selected = selectHighestPriority(result, { repoNice });
  assertEquals(selected?.number, 1);
  assertEquals(selected?.repo, "owner/high");
});

Deno.test("selectHighestPriority - fair repo rotation distributes across repos within a nice tier", () => {
  // Three repos at the same nice (0) each hold a configured-label issue;
  // repo-a additionally holds the globally-oldest issue. Under a controlled
  // randomFn the selection rotates across repos rather than always taking
  // repo-a's old work.
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [
      makeCandidate({
        number: 1,
        repo: "owner/a",
        createdAt: "2024-01-01T00:00:00Z",
      }),
      makeCandidate({
        number: 2,
        repo: "owner/a",
        createdAt: "2024-02-01T00:00:00Z",
      }),
      makeCandidate({
        number: 3,
        repo: "owner/b",
        createdAt: "2024-03-01T00:00:00Z",
      }),
      makeCandidate({
        number: 4,
        repo: "owner/c",
        createdAt: "2024-04-01T00:00:00Z",
      }),
    ],
    workOnCandidates: [],
    blockedEntries: [],
  };
  // Distinct repos in oldest-first order: [a, b, c].
  // randomFn 0 → repo a → oldest within a = number 1.
  assertEquals(
    selectHighestPriority(result, { randomFn: () => 0 })?.repo,
    "owner/a",
  );
  // randomFn 0.5 → floor(0.5*3)=1 → repo b → number 3.
  assertEquals(
    selectHighestPriority(result, { randomFn: () => 0.5 })?.number,
    3,
  );
  // randomFn 0.99 → floor(0.99*3)=2 → repo c → number 4.
  assertEquals(
    selectHighestPriority(result, { randomFn: () => 0.99 })?.number,
    4,
  );
});

Deno.test("selectHighestPriority - milestone priority preserved within the chosen repo", () => {
  // Within one repo and one nice tier, milestone priority (#1237) still
  // orders selection: priority-high (1) before normal (2) before low (3).
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [
      makeCandidate({
        number: 1,
        repo: "owner/a",
        milestone: "v1",
        milestonePriority: 3,
        createdAt: "2024-01-01T00:00:00Z",
      }),
      makeCandidate({
        number: 2,
        repo: "owner/a",
        milestone: "v1",
        milestonePriority: 1,
        createdAt: "2024-05-01T00:00:00Z",
      }),
    ],
    workOnCandidates: [],
    blockedEntries: [],
  };
  // Single repo → randomFn picks it, then priority-high (number 2) wins
  // despite being newer.
  assertEquals(
    selectHighestPriority(result, { randomFn: () => 0 })?.number,
    2,
  );
});

Deno.test("selectHighestPriority - Issue #2164 suppression still applies within a nice tier", () => {
  // low-nice tier: repo-low has a blocked work-on and a low-priority issue.
  // The low-priority is suppressed (repo has open work-on), so the low-nice
  // tier yields nothing and the high-nice work-on is reached.
  const repoNice = (repo: string) => (repo === "owner/low" ? 0 : 10);
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [
      makeCandidate({
        number: 1,
        repo: "owner/low",
        milestone: "v1",
        source: "work-on",
        createdAt: "2024-01-01T00:00:00Z",
      }),
      makeCandidate({
        number: 2,
        repo: "owner/high",
        source: "work-on",
        createdAt: "2024-02-01T00:00:00Z",
      }),
    ],
    blockedEntries: [{ repo: "owner/low", milestone: "v1" }],
    lowPriorityCandidates: [
      makeCandidate({
        number: 3,
        repo: "owner/low",
        source: "low-priority",
        labelIndex: 199,
        createdAt: "2024-01-01T00:00:00Z",
      }),
    ],
    reposWithOpenWorkOn: new Set(["owner/low"]),
  };
  const selected = selectHighestPriority(result, { repoNice });
  assertEquals(selected?.number, 2);
  assertEquals(selected?.repo, "owner/high");
});

// =============================================================================
// idle-task is a fleet-global floor across nice tiers (Issue #2812)
// =============================================================================

Deno.test("selectHighestPriority - low-nice idle-task loses to high-nice work-on (Issue #2812)", () => {
  // The idle-task scan repo sits in the lowest nice tier; a real work-on
  // issue lives in a higher nice tier. Before #2812 the low-nice tier-4
  // idle-task would be selected ahead of the high-nice tier-2 work-on. Now
  // idle-task is a fleet-global floor, so the work-on must win.
  const repoNice = (repo: string) => (repo === "owner/idle" ? 0 : 10);
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [
      makeCandidate({
        number: 2,
        repo: "owner/work",
        source: "work-on",
        createdAt: "2024-02-01T00:00:00Z",
      }),
    ],
    blockedEntries: [],
    idleTaskCandidates: [
      makeCandidate({
        number: 1,
        repo: "owner/idle",
        source: "idle-task",
        labelIndex: 299,
        createdAt: "2024-01-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result, { repoNice });
  assertEquals(selected?.number, 2);
  assertEquals(selected?.repo, "owner/work");
  assertEquals(selected?.source, "work-on");
});

Deno.test("selectHighestPriority - low-nice idle-task loses to high-nice low-priority (Issue #2812)", () => {
  // Even tier-3 low-priority in a higher nice tier outranks a lower-nice
  // idle-task: idle-task is strictly below every real-work tier fleet-wide.
  const repoNice = (repo: string) => (repo === "owner/idle" ? 0 : 10);
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [],
    blockedEntries: [],
    lowPriorityCandidates: [
      makeCandidate({
        number: 2,
        repo: "owner/work",
        source: "low-priority",
        labelIndex: 199,
        createdAt: "2024-02-01T00:00:00Z",
      }),
    ],
    idleTaskCandidates: [
      makeCandidate({
        number: 1,
        repo: "owner/idle",
        source: "idle-task",
        labelIndex: 299,
        createdAt: "2024-01-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result, { repoNice });
  assertEquals(selected?.number, 2);
  assertEquals(selected?.source, "low-priority");
});

Deno.test("selectHighestPriority - idle-task selected only when every real-work tier is empty across all nice tiers (Issue #2812)", () => {
  // No real work anywhere across two nice tiers — idle-task is now eligible,
  // and the lowest-nice tier with an idle-task candidate is drained first.
  const repoNice = (repo: string) => repo === "owner/idle-low" ? 0 : 10;
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [],
    blockedEntries: [],
    idleTaskCandidates: [
      makeCandidate({
        number: 1,
        repo: "owner/idle-high",
        source: "idle-task",
        labelIndex: 299,
        createdAt: "2024-01-01T00:00:00Z",
      }),
      makeCandidate({
        number: 2,
        repo: "owner/idle-low",
        source: "idle-task",
        labelIndex: 299,
        createdAt: "2024-02-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result, { repoNice });
  // Lowest-nice tier (owner/idle-low, nice 0) wins despite being newer.
  assertEquals(selected?.number, 2);
  assertEquals(selected?.repo, "owner/idle-low");
  assertEquals(selected?.source, "idle-task");
});

Deno.test("selectHighestPriority - default nice idle-task unaffected when real work is exhausted (Issue #2812)", () => {
  // Backward-compat: with the default single tier, idle-task is still chosen
  // once configured-label, work-on and low-priority are all empty.
  const result: SelectionResult = {
    selected: null,
    labelCandidates: [],
    workOnCandidates: [],
    blockedEntries: [],
    idleTaskCandidates: [
      makeCandidate({
        number: 9,
        repo: "owner/repo",
        source: "idle-task",
        labelIndex: 299,
        createdAt: "2024-01-01T00:00:00Z",
      }),
    ],
  };
  const selected = selectHighestPriority(result);
  assertEquals(selected?.number, 9);
  assertEquals(selected?.source, "idle-task");
});

// =============================================================================
// orderCandidatesByNiceTier tests (Issue #2775)
// =============================================================================

Deno.test("issue_priority - orderCandidatesByNiceTier returns [] for empty input", () => {
  assertEquals(orderCandidatesByNiceTier([]), []);
});

Deno.test("issue_priority - orderCandidatesByNiceTier emits lower-`nice` tier first", () => {
  const candidates = [
    // older but higher nice
    makeCandidate({
      repo: "owner/high",
      number: 1,
      createdAt: "2024-01-01T00:00:00Z",
    }),
    // newer but lower nice
    makeCandidate({
      repo: "owner/low",
      number: 2,
      createdAt: "2024-06-01T00:00:00Z",
    }),
  ];
  const nice: Record<string, number> = { "owner/high": 10, "owner/low": 0 };

  const ordered = orderCandidatesByNiceTier(candidates, {
    repoNice: (repo) => nice[repo] ?? 0,
    randomFn: () => 0,
  });

  assertEquals(ordered[0]?.repo, "owner/low");
  assertEquals(ordered[1]?.repo, "owner/high");
});

Deno.test("issue_priority - orderCandidatesByNiceTier rotates fairly within an equal tier", () => {
  const candidates = [
    makeCandidate({
      repo: "owner/a",
      number: 1,
      createdAt: "2024-01-01T00:00:00Z",
    }),
    makeCandidate({
      repo: "owner/b",
      number: 2,
      createdAt: "2024-06-01T00:00:00Z",
    }),
  ];
  const opts: SelectionOptions = { repoNice: () => 0 };

  const first = orderCandidatesByNiceTier(candidates, {
    ...opts,
    randomFn: () => 0,
  });
  assertEquals(first[0]?.repo, "owner/a");

  const second = orderCandidatesByNiceTier(candidates, {
    ...opts,
    randomFn: () => 0.99,
  });
  assertEquals(second[0]?.repo, "owner/b");
});

Deno.test("issue_priority - orderCandidatesByNiceTier preserves every candidate", () => {
  const candidates = [
    makeCandidate({
      repo: "owner/a",
      number: 1,
      createdAt: "2024-01-01T00:00:00Z",
    }),
    makeCandidate({
      repo: "owner/a",
      number: 2,
      createdAt: "2024-02-01T00:00:00Z",
    }),
    makeCandidate({
      repo: "owner/b",
      number: 3,
      createdAt: "2024-03-01T00:00:00Z",
    }),
  ];
  const ordered = orderCandidatesByNiceTier(candidates, {
    repoNice: () => 0,
    randomFn: () => 0,
  });
  assertEquals(ordered.length, 3);
  assertEquals(new Set(ordered.map((c) => c.number)), new Set([1, 2, 3]));
});

Deno.test("issue_priority - orderCandidatesByNiceTier default repoNice keeps oldest-first", () => {
  const candidates = [
    makeCandidate({
      repo: "owner/a",
      number: 1,
      createdAt: "2024-03-01T00:00:00Z",
    }),
    makeCandidate({
      repo: "owner/b",
      number: 2,
      createdAt: "2024-01-01T00:00:00Z",
    }),
  ];
  // No options → deterministic, single tier, globally-oldest leads.
  const ordered = orderCandidatesByNiceTier(candidates);
  assertEquals(ordered[0]?.number, 2);
});
