/**
 * Tests for merge_conflict_stall_watchdog.ts — the single 2-hour owner check
 * on a `merge-conflict` queue (Issue #3001, part of #2965).
 *
 * The clock starts at the LATEST of the label event, the newest trusted
 * stand-down, the newest trusted resolution attempt, and the PR's last head
 * change. Two hours after that with nothing since, the watchdog fixes
 * forward: a takeover while the shared budget remains, a guarded abandon once
 * it is spent.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { Logger } from "../types.ts";
import {
  conflictStallClockStart,
  type ConflictStallObservation,
  detectConflictQueueStall,
  listedOpenPrs,
  repairConflictQueueStall,
  scanConflictQueueStalls,
} from "../lib/merge_conflict_stall_watchdog.ts";
import { MERGE_CONFLICT_LABEL } from "../lib/pr_merge_conflict_scan.ts";
import {
  conflictAttemptMarker,
  conflictFailedMarker,
  conflictParkedMarker,
  conflictResolvedMarker,
} from "../lib/merge_conflict_markers.ts";
import { gatedHeadMarker } from "../lib/gated_head_guard.ts";
import type {
  AbandonRestartDeps,
  AbandonRestartOutcome,
  AbandonRestartRequest,
} from "../lib/conflict_abandon_restart.ts";
import type {
  ConflictTakeoverDeps,
  ConflictTakeoverOutcome,
  ConflictTakeoverPr,
} from "../lib/conflict_takeover.ts";
import type { RepoLease } from "../lib/maintenance_lane.ts";

const HOUR = 3600_000;
const NOW = Date.parse("2026-09-05T09:00:00Z");
const REPO = "org/repo";
const PR = 116;
/** The fleet login every trusted fixture comment is authored by. */
const FLEET = "vibe-coder-bot";
const isTrustedAuthor = (login: string) => login === FLEET;
const HEAD_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const OTHER_HEAD_SHA = "1234567890abcdef1234567890abcdef12345678";

/** A silent logger — the tests assert on effects, not on log lines. */
const noop = () => {};
const logger: Logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  skipReason: noop,
  timing: noop,
  scanSummary: noop,
  workerSummary: noop,
};

/** The `--body` of every `gh pr comment` call recorded. */
function postedComments(calls: readonly string[][]): string[] {
  return calls
    .filter((call) => call[0] === "pr" && call[1] === "comment")
    .map((call) => call[call.indexOf("--body") + 1] ?? "");
}

/** One raw REST comment, in the shape the GitHub API returns. */
function comment(
  body: string,
  agoHours: number,
  login = FLEET,
): Record<string, unknown> {
  return {
    body,
    created_at: new Date(NOW - agoHours * HOUR).toISOString(),
    user: { login },
  };
}

/** An observation of a PR labelled `agoHours` ago, with the given thread. */
function observation(
  agoHours: number,
  comments: readonly unknown[] = [],
  overrides: Partial<ConflictStallObservation> = {},
): ConflictStallObservation {
  return {
    repo: REPO,
    prNumber: PR,
    labels: [MERGE_CONFLICT_LABEL],
    mergeableState: "CONFLICTING",
    labelledAtMs: NOW - agoHours * HOUR,
    comments,
    ...overrides,
  };
}

const detect = (observation: ConflictStallObservation) =>
  detectConflictQueueStall(observation, { nowMs: NOW, isTrustedAuthor });

// ---------------------------------------------------------------------------
// Boundary table — the earliest failure-detection point (Issue #1112)
// ---------------------------------------------------------------------------

Deno.test("detectConflictQueueStall - the four boundary states", () => {
  const cases: {
    name: string;
    labelAgeHours: number;
    comments: unknown[];
    detected: boolean;
    openAttempt?: boolean;
  }[] = [
    {
      name: "labelled 3h ago with no attempt at all",
      labelAgeHours: 3,
      comments: [],
      detected: true,
      openAttempt: false,
    },
    {
      name: "labelled 3h ago with one concluded attempt just now",
      labelAgeHours: 3,
      comments: [
        comment(conflictAttemptMarker(1, "ladder", HEAD_SHA), 2.5),
        comment(conflictFailedMarker(1, "ladder", HEAD_SHA), 1),
      ],
      detected: false,
    },
    {
      name: "labelled 3h ago with one open, unconcluded attempt",
      labelAgeHours: 3,
      comments: [comment(conflictAttemptMarker(1, "ladder", HEAD_SHA), 2.5)],
      detected: true,
      openAttempt: true,
    },
    {
      name: "labelled 1h ago, inside the window",
      labelAgeHours: 1,
      comments: [],
      detected: false,
    },
  ];

  for (const row of cases) {
    const stall = detect(observation(row.labelAgeHours, row.comments));
    assertEquals(stall !== null, row.detected, row.name);
    if (stall === null) continue;
    assertEquals(stall.repo, REPO, row.name);
    assertEquals(stall.prNumber, PR, row.name);
    assertEquals(stall.labelAgeMs, row.labelAgeHours * HOUR, row.name);
    assertEquals(stall.openAttempt, row.openAttempt, row.name);
  }
});

Deno.test("detectConflictQueueStall - a merge that resolved the conflict is not a stall", () => {
  const stall = detect(
    observation(3, [comment(conflictResolvedMarker("ladder", HEAD_SHA), 1)]),
  );
  assertEquals(stall, null);
});

Deno.test("detectConflictQueueStall - an attempt starts a fresh clock", () => {
  // Labelled 10h ago, one attempt concluded 1h59m ago: inside the window.
  assertEquals(
    detect(
      observation(10, [
        comment(conflictFailedMarker(1, "ladder", HEAD_SHA), 1 + 59 / 60),
      ]),
    ),
    null,
  );
  // At exactly 2h since the attempt, it trips, and names "attempt".
  const stall = detect(
    observation(10, [
      comment(conflictFailedMarker(1, "ladder", HEAD_SHA), 2),
    ]),
  );
  assert(stall !== null);
  assertEquals(stall.clockStart, "attempt");
  assertEquals(stall.lastAttemptAtMs, NOW - 2 * HOUR);
});

Deno.test("detectConflictQueueStall - a forged conclusion cannot silence the watchdog", () => {
  // Any account may write a marker into a comment body on a public repo, so
  // an untrusted attempt is ignored: the fail direction is towards saying
  // something, never towards silence.
  const stall = detect(
    observation(3, [
      comment(conflictFailedMarker(1, "ladder", HEAD_SHA), 1, "drive-by"),
    ]),
  );
  assert(stall !== null);
  assertEquals(stall.clockStart, "label");
});

Deno.test("detectConflictQueueStall - parked on needs-human/closed/stale/unknown/unlabelled/unknown-age is excluded", () => {
  const parked: [string, ConflictStallObservation][] = [
    [
      "needs-human",
      observation(3, [], {
        labels: [MERGE_CONFLICT_LABEL, "needs-human"],
      }),
    ],
    ["closed", observation(3, [], { closed: true })],
    // The label is not removed when a conflict clears by other means, so a
    // labelled PR that now merges cleanly is a stale label, not a stall.
    [
      "stale label — no longer conflicting",
      observation(3, [], {
        mergeableState: "MERGEABLE",
      }),
    ],
    [
      "mergeable state unknown",
      observation(3, [], {
        mergeableState: undefined,
      }),
    ],
    ["not in the queue", observation(3, [], { labels: [] })],
    ["label age unknown", observation(3, [], { labelledAtMs: undefined })],
  ];
  for (const [name, obs] of parked) {
    assertEquals(detect(obs), null, name);
  }
});

Deno.test("detectConflictQueueStall - the window is two hours (Issue #2996)", () => {
  assertEquals(detect(observation(1.9833)), null); // 1h59m
  assert(detect(observation(2)) !== null);
});

// ---------------------------------------------------------------------------
// Clock start — stand-down, head change, future head change (Issue #3001)
// ---------------------------------------------------------------------------

Deno.test("detectConflictQueueStall - head unchanged 1h59m after a trusted stand-down is not a stall; at 2h it is", () => {
  const standDownAgoAtAlmostTwoHours = (agoHours: number) =>
    observation(10, [
      comment(gatedHeadMarker("milestone/x", NOW - agoHours * HOUR), agoHours),
    ]);

  assertEquals(detect(standDownAgoAtAlmostTwoHours(1.9833)), null);
  const stall = detect(standDownAgoAtAlmostTwoHours(2));
  assert(stall !== null);
  assertEquals(stall.clockStart, "stand-down");
  assertEquals(stall.standDownAtMs, NOW - 2 * HOUR);
});

Deno.test("detectConflictQueueStall - a head change after a stand-down resets the clock", () => {
  const comments = [
    comment(gatedHeadMarker("milestone/x", NOW - 10 * HOUR), 10),
  ];
  // The head changed 1h ago — inside the window.
  assertEquals(
    detect(
      observation(20, comments, { headChangedAtMs: NOW - 1 * HOUR }),
    ),
    null,
  );
  // The head changed exactly 2h ago — the window has elapsed.
  const stall = detect(
    observation(20, comments, { headChangedAtMs: NOW - 2 * HOUR }),
  );
  assert(stall !== null);
  assertEquals(stall.clockStart, "head-change");
  assertEquals(stall.headChangedAtMs, NOW - 2 * HOUR);
});

Deno.test("detectConflictQueueStall - a future headChangedAtMs is ignored", () => {
  const stall = detect(
    observation(3, [], { headChangedAtMs: NOW + HOUR }),
  );
  assert(stall !== null);
  assertEquals(stall.clockStart, "label");
  assertEquals(stall.headChangedAtMs, NOW + HOUR, "kept on the stall record");
});

Deno.test("detectConflictQueueStall - untrusted attempt/stand-down markers do not move the clock", () => {
  const stall = detect(
    observation(3, [
      comment(gatedHeadMarker("milestone/x", NOW - 1 * HOUR), 1, "drive-by"),
      comment(
        conflictFailedMarker(1, "ladder", HEAD_SHA),
        1,
        "drive-by",
      ),
    ]),
  );
  assert(stall !== null);
  assertEquals(stall.clockStart, "label");
  assertEquals(stall.standDownAtMs, undefined);
  assertEquals(stall.lastAttemptAtMs, undefined);
});

Deno.test("conflictStallClockStart - the latest of label, stand-down, attempt and head-change wins", () => {
  const labelledAtMs = NOW - 20 * HOUR;
  const comments = [
    comment(gatedHeadMarker("milestone/x", NOW - 15 * HOUR), 15),
    comment(conflictFailedMarker(1, "ladder", HEAD_SHA), 10),
  ];
  const result = conflictStallClockStart(
    comments,
    labelledAtMs,
    NOW - 5 * HOUR,
    NOW,
    isTrustedAuthor,
  );
  assertEquals(result.cause, "head-change");
  assertEquals(result.startMs, NOW - 5 * HOUR);
  assertEquals(result.standDownAtMs, NOW - 15 * HOUR);
  assertEquals(result.lastAttemptAtMs, NOW - 10 * HOUR);
});

// ---------------------------------------------------------------------------
// Parked on the base tip (Issue #2312) — suppressed only while budget remains
// ---------------------------------------------------------------------------

/** The base tip a park marker names in these fixtures. */
const PARKED_BASE = "1111111111111111111111111111111111111111";
/** The base tip after somebody pushed to the base branch. */
const MOVED_BASE = "2222222222222222222222222222222222222222";

Deno.test("detectConflictQueueStall - a parked PR on an unmoved base with budget remaining is not a stall", () => {
  assertEquals(
    detect(
      observation(10, [comment(conflictParkedMarker(PARKED_BASE), 5)], {
        baseRefOid: PARKED_BASE,
      }),
    ),
    null,
  );
});

Deno.test("detectConflictQueueStall - a parked PR whose base moved is judged the usual way", () => {
  const stall = detect(
    observation(10, [comment(conflictParkedMarker(PARKED_BASE), 5)], {
      baseRefOid: MOVED_BASE,
    }),
  );
  assert(stall !== null);
});

Deno.test("detectConflictQueueStall - an outsider's park marker cannot silence the watchdog", () => {
  const stall = detect(
    observation(10, [
      comment(conflictParkedMarker(PARKED_BASE), 5, "drive-by"),
    ], { baseRefOid: PARKED_BASE }),
  );
  assert(stall !== null);
});

Deno.test("detectConflictQueueStall - a parked PR with the budget spent still trips", () => {
  const stall = detect(
    observation(10, [
      comment(conflictFailedMarker(1, "ladder", HEAD_SHA), 9),
      comment(conflictFailedMarker(2, "ladder", HEAD_SHA), 8),
      comment(conflictFailedMarker(3, "ladder", HEAD_SHA), 3),
      comment(conflictParkedMarker(PARKED_BASE), 2.5),
    ], { baseRefOid: PARKED_BASE }),
  );
  assert(stall !== null);
  assertEquals(stall.budgetSpent, true);
  assertEquals(stall.attemptsSpent, 3);
});

Deno.test("detectConflictQueueStall - a conclusion after a park ends the park", () => {
  // A trusted failed conclusion after the park means the PR was un-parked
  // and worked on. The park no longer suppresses the stall, even though the
  // shared budget still has attempts left (Issue #3001 review).
  const stall = detect(
    observation(30, [
      comment(conflictParkedMarker(PARKED_BASE), 20),
      comment(conflictFailedMarker(1, "ladder", HEAD_SHA), 12),
    ], { baseRefOid: PARKED_BASE }),
  );
  assert(stall !== null);
  assertEquals(stall.budgetSpent, false);
  assertEquals(stall.clockStart, "attempt");
  assertEquals(stall.stalledMs, 12 * HOUR);
});

// ---------------------------------------------------------------------------
// Repair — fix forward: takeover while budget remains, else guarded abandon
// ---------------------------------------------------------------------------

/** A fake GitHub holding one PR's thread, shared by every simulated host. */
function fakeGitHub(
  prComments: Record<string, unknown>[] = [],
  mergeableState = "CONFLICTING",
  headRefOid = HEAD_SHA,
) {
  const calls: string[][] = [];
  const timeline = [{
    event: "labeled",
    label: { name: MERGE_CONFLICT_LABEL },
    actor: { login: FLEET },
    created_at: new Date(NOW - 9 * HOUR).toISOString(),
  }];

  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    const [verb, noun] = args;
    if (verb === "pr" && noun === "list") {
      return Promise.resolve(JSON.stringify([{
        number: PR,
        labels: [{ name: MERGE_CONFLICT_LABEL }],
        mergeable: mergeableState,
        headRefOid,
      }]));
    }
    if (verb === "pr" && noun === "view") {
      return Promise.resolve(
        JSON.stringify({
          headRefName: "issue-7-branch",
          baseRefName: "main",
          headRefOid,
        }),
      );
    }
    if (verb === "api" && args[1]?.includes("/commits/")) {
      return Promise.resolve(new Date(NOW - 9 * HOUR).toISOString());
    }
    if (verb === "api" && args[1]?.includes("/timeline")) {
      // Page 2 onwards is empty — one short page ends the pagination.
      return Promise.resolve(
        args[1].includes("page=1") ? JSON.stringify(timeline) : "[]",
      );
    }
    if (verb === "api" && args[1]?.includes("/comments")) {
      return Promise.resolve(
        args[1].includes("page=1") ? JSON.stringify(prComments) : "[]",
      );
    }
    if (verb === "pr" && noun === "comment") {
      prComments.push(comment(args[args.indexOf("--body") + 1] ?? "", 0));
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };

  return { calls, prComments, gh };
}

/** A recording `abandonAndRestart` seam and a lease that is always granted. */
function fakeAbandon(
  outcome: AbandonRestartOutcome = {
    outcome: "abandoned",
    issueNumber: 7,
    label: { kept: "low-priority" },
  },
) {
  const abandoned: AbandonRestartRequest[] = [];
  let released = 0;
  return {
    abandoned,
    released: () => released,
    abandon: (request: AbandonRestartRequest, _deps: AbandonRestartDeps) => {
      abandoned.push(request);
      return Promise.resolve(outcome);
    },
    acquireLease: (): RepoLease => ({ release: () => void released++ }),
  };
}

/** A recording takeover seam. */
function fakeTakeover(
  outcome: ConflictTakeoverOutcome = { kind: "resolved" },
) {
  const calls: { pr: ConflictTakeoverPr; deps: ConflictTakeoverDeps }[] = [];
  return {
    calls,
    takeover: (pr: ConflictTakeoverPr, deps: ConflictTakeoverDeps) => {
      calls.push({ pr, deps });
      return Promise.resolve(outcome);
    },
  };
}

/** Three trusted failed attempts — the budget spent, in the thread. */
const budgetSpentComments = [
  comment(conflictFailedMarker(1, "ladder", HEAD_SHA), 9),
  comment(conflictFailedMarker(2, "ladder", HEAD_SHA), 8),
  comment(conflictFailedMarker(3, "ladder", HEAD_SHA), 3),
];

const takeoverResolvers = {
  resolveViaLadder: () => Promise.resolve({ resolved: true, detail: "" }),
  resolveOnFixBranch: () => Promise.resolve({ resolved: true, detail: "" }),
};

/**
 * Neither the takeover nor the abandon path files an issue, labels the PR
 * `escalated`, or applies the `needs-human` veto directly (Issues #569,
 * #2803). Comment bodies are exempt: they explain in prose, and are not
 * mutations.
 */
function assertNoEscalation(calls: readonly string[][]): void {
  const mutations = calls.map((call) => {
    const body = call.indexOf("--body");
    return body === -1
      ? call
      : [...call.slice(0, body), ...call.slice(body + 2)];
  });
  assertEquals(
    mutations.filter((call) => call[0] === "issue" && call[1] === "create"),
    [],
    "a stall files no issue",
  );
  assert(
    !mutations.some((call) =>
      call.some((arg, i) =>
        arg === "--add-label" && call[i + 1] === "escalated"
      )
    ),
    `a stall adds no escalated label: ${JSON.stringify(mutations)}`,
  );
}

/** No `gh` call this watchdog makes ever names `needs-human`. */
function assertNoNeedsHuman(calls: readonly string[][]): void {
  assert(
    !calls.some((call) => call.some((arg) => arg.includes("needs-human"))),
    `needs-human must never be applied by this path: ${JSON.stringify(calls)}`,
  );
}

Deno.test("repairConflictQueueStall - budget remains: takeover is called once, abandon is not", async () => {
  const github = fakeGitHub();
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();
  const stall = detect(observation(3));
  assert(stall !== null);

  const action = await repairConflictQueueStall(stall, {
    ghCommandFn: github.gh,
    logger,
    isTrustedAuthor,
    nowMs: NOW,
    abandon: abandon.abandon,
    acquireLease: abandon.acquireLease,
    takeover: takeover.takeover,
    takeoverResolvers,
    trustedAuthors: [FLEET],
  });

  assertEquals(action, "taken-over");
  assertEquals(takeover.calls.length, 1);
  assertEquals(takeover.calls[0]!.pr, {
    repo: REPO,
    number: PR,
    headRefName: "issue-7-branch",
    baseRefName: "main",
    headSha: HEAD_SHA,
  });
  assertEquals(abandon.abandoned, []);
  assertNoEscalation(github.calls);
  assertNoNeedsHuman(github.calls);
  assertEquals(abandon.released(), 1);
});

Deno.test("repairConflictQueueStall - budget spent: abandon is called with reason merge-conflict, takeover is not", async () => {
  const github = fakeGitHub(budgetSpentComments.slice());
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();
  const stall = detect(observation(10, budgetSpentComments));
  assert(stall !== null);
  assertEquals(stall.budgetSpent, true);

  const action = await repairConflictQueueStall(stall, {
    ghCommandFn: github.gh,
    logger,
    isTrustedAuthor,
    nowMs: NOW,
    abandon: abandon.abandon,
    acquireLease: abandon.acquireLease,
    takeover: takeover.takeover,
    takeoverResolvers,
    trustedAuthors: [FLEET],
  });

  assertEquals(action, "abandoned");
  assertEquals(takeover.calls, []);
  assertEquals(abandon.abandoned.length, 1);
  const request = abandon.abandoned[0]!;
  assertEquals(request.repo, REPO);
  assertEquals(request.prNumber, PR);
  assertEquals(request.branchName, "issue-7-branch");
  assertEquals(request.baseBranch, "main");
  assertEquals(request.reason, { kind: "merge-conflict" });
  assertNoEscalation(github.calls);
  assertNoNeedsHuman(github.calls);
  assertEquals(abandon.released(), 1);
});

Deno.test("repairConflictQueueStall - a parked PR with budget spent reaches abandon end-to-end through the scan", async () => {
  const github = fakeGitHub(budgetSpentComments.concat([
    comment(conflictParkedMarker(PARKED_BASE), 2.5),
  ]));
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();

  const scan = await scanConflictQueueStalls({
    repos: [REPO],
    ghCommandFn: (args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        return Promise.resolve(JSON.stringify([{
          number: PR,
          labels: [{ name: MERGE_CONFLICT_LABEL }],
          mergeable: "CONFLICTING",
          baseRefOid: PARKED_BASE,
          headRefOid: HEAD_SHA,
        }]));
      }
      return github.gh(args);
    },
    isTrustedAuthor,
    nowMs: () => NOW,
    logger,
    abandon: abandon.abandon,
    acquireLease: abandon.acquireLease,
    takeover: takeover.takeover,
    takeoverResolvers,
    trustedAuthors: [FLEET],
  });

  assertEquals(scan.length, 1);
  assertEquals(scan[0]!.budgetSpent, true);
  assertEquals(abandon.abandoned.length, 1);
  assertEquals(takeover.calls, []);
});

Deno.test("repairConflictQueueStall - budget remains with no takeoverResolvers injected fails loudly", async () => {
  const github = fakeGitHub();
  const stall = detect(observation(3));
  assert(stall !== null);
  const takeover = fakeTakeover();

  const action = await repairConflictQueueStall(stall, {
    ghCommandFn: github.gh,
    logger,
    isTrustedAuthor,
    nowMs: NOW,
    acquireLease: () => ({ release: noop }),
    takeover: takeover.takeover,
    trustedAuthors: [FLEET],
  });

  assertEquals(action, "failed");
  assertEquals(takeover.calls, []);
});

Deno.test("repairConflictQueueStall - a held maintenance lease defers the repair", async () => {
  const github = fakeGitHub();
  const stall = detect(observation(3));
  assert(stall !== null);

  const action = await repairConflictQueueStall(stall, {
    ghCommandFn: github.gh,
    logger,
    isTrustedAuthor,
    nowMs: NOW,
    acquireLease: () => null,
  });

  assertEquals(action, "skipped-lease-held");
  assertEquals(github.calls, []);
});

Deno.test("repairConflictQueueStall - under-lease re-check: a newer trusted attempt marker means no-longer-stalled", async () => {
  const github = fakeGitHub([
    comment(conflictFailedMarker(1, "ladder", HEAD_SHA), 0.1),
  ]);
  const stall = detect(observation(3));
  assert(stall !== null);
  const takeover = fakeTakeover();

  const action = await repairConflictQueueStall(stall, {
    ghCommandFn: github.gh,
    logger,
    isTrustedAuthor,
    nowMs: NOW,
    acquireLease: () => ({ release: noop }),
    takeover: takeover.takeover,
    takeoverResolvers,
    trustedAuthors: [FLEET],
  });

  assertEquals(action, "no-longer-stalled");
  assertEquals(takeover.calls, []);
});

Deno.test("repairConflictQueueStall - under-lease re-check: a different live head means no-longer-stalled", async () => {
  const github = fakeGitHub([], "CONFLICTING", OTHER_HEAD_SHA);
  const stall = detect(observation(3, [], { headRefOid: HEAD_SHA }));
  assert(stall !== null);
  const takeover = fakeTakeover();

  const action = await repairConflictQueueStall(stall, {
    ghCommandFn: github.gh,
    logger,
    isTrustedAuthor,
    nowMs: NOW,
    acquireLease: () => ({ release: noop }),
    takeover: takeover.takeover,
    takeoverResolvers,
    trustedAuthors: [FLEET],
  });

  assertEquals(action, "no-longer-stalled");
  assertEquals(takeover.calls, []);
});

Deno.test("repairConflictQueueStall - a declined or failed abandon is reported, never swallowed", async () => {
  const declined = fakeAbandon({
    outcome: "declined",
    reason: {
      kind: "already-restarted",
      issueNumber: 7,
      samePr: true,
      restartCount: 2,
    },
  });
  const github1 = fakeGitHub(budgetSpentComments.slice());
  const stall1 = detect(observation(10, budgetSpentComments));
  assert(stall1 !== null);
  assertEquals(
    await repairConflictQueueStall(stall1, {
      ghCommandFn: github1.gh,
      logger,
      isTrustedAuthor,
      nowMs: NOW,
      abandon: declined.abandon,
      acquireLease: declined.acquireLease,
      trustedAuthors: [FLEET],
    }),
    "abandon-declined",
  );

  const failed = fakeAbandon({
    outcome: "failed",
    step: "pr-close",
    message: "gh pr close failed",
  });
  const github2 = fakeGitHub(budgetSpentComments.slice());
  const stall2 = detect(observation(10, budgetSpentComments));
  assert(stall2 !== null);
  assertEquals(
    await repairConflictQueueStall(stall2, {
      ghCommandFn: github2.gh,
      logger,
      isTrustedAuthor,
      nowMs: NOW,
      abandon: failed.abandon,
      acquireLease: failed.acquireLease,
      trustedAuthors: [FLEET],
    }),
    "failed",
  );
});

Deno.test("repairConflictQueueStall - a declined-budget takeover outcome is reported, not treated as taken-over", async () => {
  const github = fakeGitHub();
  const stall = detect(observation(3));
  assert(stall !== null);
  const takeover = fakeTakeover({ kind: "declined-budget", attemptsSpent: 3 });

  const action = await repairConflictQueueStall(stall, {
    ghCommandFn: github.gh,
    logger,
    isTrustedAuthor,
    nowMs: NOW,
    acquireLease: () => ({ release: noop }),
    takeover: takeover.takeover,
    takeoverResolvers,
    trustedAuthors: [FLEET],
  });

  assertEquals(action, "takeover-declined");
});

// ---------------------------------------------------------------------------
// Scan (Issue #1112, #1515, #2409)
// ---------------------------------------------------------------------------

const scanOptions = (
  github: ReturnType<typeof fakeGitHub>,
  abandon: ReturnType<typeof fakeAbandon>,
  takeover: ReturnType<typeof fakeTakeover>,
) => ({
  repos: [REPO],
  ghCommandFn: github.gh,
  abandon: abandon.abandon,
  acquireLease: abandon.acquireLease,
  takeover: takeover.takeover,
  takeoverResolvers,
  trustedAuthors: [FLEET],
  isTrustedAuthor,
  nowMs: () => NOW,
  logger,
});

Deno.test("scanConflictQueueStalls - reads headRefOid from the listing and the commit date, trips on takeover", async () => {
  const github = fakeGitHub();
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();

  const scan = await scanConflictQueueStalls(
    scanOptions(github, abandon, takeover),
  );

  assertEquals(scan.length, 1);
  assertEquals(scan[0]!.headRefOid, HEAD_SHA);
  assertEquals(takeover.calls.length, 1);
  assertEquals(abandon.abandoned, []);
  assert(
    github.calls.some((call) =>
      call[0] === "api" && (call[1] ?? "").includes(`/commits/${HEAD_SHA}`)
    ),
    "the commit date is fetched for the head sha",
  );
});

Deno.test("scanConflictQueueStalls - an unreadable commit date still trips on the other events", async () => {
  const github = fakeGitHub();
  const warnings: string[] = [];
  const withFailingCommit = (args: string[]) => {
    if (args[0] === "api" && args[1]?.includes("/commits/")) {
      return Promise.reject(new Error("commit unavailable"));
    }
    return github.gh(args);
  };
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, abandon, takeover),
    ghCommandFn: withFailingCommit,
    logger: { ...logger, warn: (message: string) => warnings.push(message) },
  });

  assertEquals(scan.length, 1);
  assertEquals(scan[0]!.headChangedAtMs, undefined);
  assertEquals(scan[0]!.clockStart, "label");
  assert(
    warnings.some((message) => message.includes("head commit date")),
    `expected a warning about the unreadable commit date: ${
      warnings.join(" | ")
    }`,
  );
});

Deno.test("scanConflictQueueStalls - files no issue and never names needs-human on either repair path", async () => {
  const github = fakeGitHub();
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();

  await scanConflictQueueStalls(scanOptions(github, abandon, takeover));
  assertNoEscalation(github.calls);
  assertNoNeedsHuman(github.calls);

  const spentGithub = fakeGitHub(budgetSpentComments.slice());
  const spentAbandon = fakeAbandon();
  const spentTakeover = fakeTakeover();
  await scanConflictQueueStalls(
    scanOptions(spentGithub, spentAbandon, spentTakeover),
  );
  assertNoEscalation(spentGithub.calls);
  assertNoNeedsHuman(spentGithub.calls);
  assertEquals(spentAbandon.abandoned.length, 1);
});

Deno.test("scanConflictQueueStalls - carries this cycle's skip reasons into the stall record", async () => {
  const github = fakeGitHub();
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, abandon, takeover),
    decisions: [{
      repo: REPO,
      prNumber: PR,
      outcome: "skipped",
      reason: { kind: "repo-leased", deferralStreak: 6 },
    }],
  });

  assertEquals(scan[0]?.skipReasons.length, 1);
  assertEquals(scan[0]?.skipReasons[0]?.kind, "repo-leased");
});

Deno.test("scanConflictQueueStalls - a stale label on a mergeable PR is not repaired", async () => {
  const github = fakeGitHub([], "MERGEABLE");
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();

  const scan = await scanConflictQueueStalls(
    scanOptions(github, abandon, takeover),
  );

  assertEquals(scan.length, 0);
  assertEquals(postedComments(github.calls).length, 0);
  assertEquals(
    github.calls.filter((call) => call[0] === "api").length,
    0,
  );
});

Deno.test("scanConflictQueueStalls - an uncomputed mergeable state is re-read, not assumed", async () => {
  const github = fakeGitHub([], "UNKNOWN");
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();
  const withView = (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve("CONFLICTING\n");
    }
    return github.gh(args);
  };

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, abandon, takeover),
    ghCommandFn: withView,
  });

  assertEquals(scan.length, 1);
});

Deno.test("scanConflictQueueStalls - a state that stays uncomputed repairs nothing", async () => {
  const github = fakeGitHub([], "UNKNOWN");
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();
  const warnings: string[] = [];
  const withView = (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve("UNKNOWN");
    }
    return github.gh(args);
  };

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, abandon, takeover),
    ghCommandFn: withView,
    logger: { ...logger, warn: (message: string) => warnings.push(message) },
  });

  assertEquals(scan.length, 0);
  // Loud, not silent: an unestablished state is exactly what went unnoticed.
  assert(
    warnings.some((message) => message.includes("mergeable state")),
    `expected a warning about the unestablished state: ${warnings.join(" | ")}`,
  );
});

Deno.test("scanConflictQueueStalls - a repo outside the allowlist is not touched", async () => {
  const github = fakeGitHub();
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, abandon, takeover),
    isRepoAllowed: () => false,
  });

  assertEquals(scan.length, 0);
  assertEquals(github.calls.length, 0);
});

Deno.test("scanConflictQueueStalls - an unreadable PR does not stop the pass", async () => {
  const github = fakeGitHub();
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();
  const failing = (args: string[]) => {
    if (args[0] === "api" && args[1]?.includes("/comments")) {
      return Promise.reject(new Error("comments unavailable"));
    }
    return github.gh(args);
  };

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, abandon, takeover),
    ghCommandFn: failing,
  });

  assertEquals(scan.length, 0);
  assertEquals(postedComments(github.calls).length, 0);
});

// ---------------------------------------------------------------------------
// Issue #1515: one quota exhaustion is one line, not one per repository
// ---------------------------------------------------------------------------

const QUOTA_REFUSED =
  "gh command failed (exit 1): GraphQL: API rate limit already exceeded for user ID 1.";

function capturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      ...logger,
      warn: (message: string) => {
        warnings.push(message);
      },
    },
  };
}

Deno.test("scanConflictQueueStalls - an exhausted quota costs one call and one line, and skips the rest (Issue #1515)", async () => {
  const listed: string[] = [];
  const captured = capturingLogger();
  const repos = Array.from({ length: 19 }, (_, i) => `org/repo-${i}`);

  const stalls = await scanConflictQueueStalls({
    repos,
    ghCommandFn: (args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        listed.push(args[args.indexOf("--repo") + 1] ?? "");
      }
      return Promise.reject(new Error(QUOTA_REFUSED));
    },
    isTrustedAuthor,
    nowMs: () => NOW,
    logger: captured.logger,
  });

  assertEquals(stalls, []);
  assertEquals(listed.length, 1, "the first refusal is the last call");
  assertEquals(captured.warnings.length, 1, captured.warnings.join("\n"));
  assertStringIncludes(
    captured.warnings[0]!,
    "Merge-conflict stall watchdog: GraphQL quota exhausted",
  );
  assertStringIncludes(captured.warnings[0]!, "skipped 19 of 19 repo(s)");
});

Deno.test("scanConflictQueueStalls - an ordinary listing failure is still reported per repository (Issue #1515)", async () => {
  const captured = capturingLogger();
  const listed: string[] = [];

  await scanConflictQueueStalls({
    repos: ["org/a", "org/b"],
    ghCommandFn: (args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        listed.push(args[args.indexOf("--repo") + 1] ?? "");
      }
      return Promise.reject(new Error("HTTP 404: Not Found"));
    },
    isTrustedAuthor,
    nowMs: () => NOW,
    logger: captured.logger,
  });

  assertEquals(listed, ["org/a", "org/b"], "every repository is still visited");
  assertEquals(captured.warnings.length, 2);
  assertStringIncludes(captured.warnings[0]!, "failed to list labelled PRs");
});

// =============================================================================
// The label listing is gated on the listing the scan already holds (#2409)
// =============================================================================

const prListCalls = (calls: readonly string[][]) =>
  calls.filter((c) => c[0] === "pr" && c[1] === "list").length;

Deno.test("scanConflictQueueStalls - a complete cached listing with no labelled PR means no live listing (Issue #2409)", async () => {
  const github = fakeGitHub();
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, abandon, takeover),
    listOpenPrLabels: () =>
      Promise.resolve([
        { number: 1, labels: ["enhancement"] },
        { number: 2, labels: [] },
      ]),
  });

  assertEquals(scan, []);
  assertEquals(prListCalls(github.calls), 0, "the cached listing proved none");
});

Deno.test("scanConflictQueueStalls - a cached listing that shows the label still takes the LIVE listing, for the live merge state (Issue #2409)", async () => {
  const github = fakeGitHub();
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, abandon, takeover),
    listOpenPrLabels: () =>
      Promise.resolve([{ number: PR, labels: [MERGE_CONFLICT_LABEL] }]),
  });

  assertEquals(prListCalls(github.calls), 1);
  assertEquals(scan.length, 1, "the stall is found exactly as before");
});

Deno.test("scanConflictQueueStalls - a full cached listing cannot prove absence, so the repository is asked (Issue #2409)", async () => {
  const github = fakeGitHub();
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, abandon, takeover),
    listOpenPrLabels: () =>
      Promise.resolve([{ number: 1, labels: [] }, { number: 2, labels: [] }]),
    // The listing came back full: a labelled PR may sit beyond it.
    openPrListingLimit: 2,
  });

  assertEquals(prListCalls(github.calls), 1);
  assertEquals(scan.length, 1);
});

Deno.test("scanConflictQueueStalls - a cached listing that cannot be read falls back to the live listing (Issue #2409)", async () => {
  const github = fakeGitHub();
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, abandon, takeover),
    listOpenPrLabels: () => Promise.reject(new Error("cache unreadable")),
  });

  assertEquals(prListCalls(github.calls), 1);
  assertEquals(scan.length, 1);
});

Deno.test("scanConflictQueueStalls - without a cached listing it lists every repository, exactly as before (Issue #2409)", async () => {
  const github = fakeGitHub();
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();
  await scanConflictQueueStalls({
    ...scanOptions(github, abandon, takeover),
    repos: [REPO, "org/other"],
  });
  assertEquals(prListCalls(github.calls), 2);
});

Deno.test("listedOpenPrs - a row with no labels field is a listing that cannot answer, never 'no labels' (Issue #2409)", () => {
  // A cache entry written before the listing asked for labels.
  assertThrows(
    () => listedOpenPrs([{ number: 1, labels: [] }, { number: 2 }]),
    Error,
    "labels",
  );
  assertEquals(
    listedOpenPrs([{ number: 1, labels: ["merge-conflict"] }, {
      number: 2,
      labels: [],
    }]),
    [{ number: 1, labels: ["merge-conflict"] }, { number: 2, labels: [] }],
  );
  assertEquals(listedOpenPrs([]), []);
});

Deno.test("scanConflictQueueStalls - a pre-labels cache entry falls back to the live listing (Issue #2409)", async () => {
  const github = fakeGitHub();
  const abandon = fakeAbandon();
  const takeover = fakeTakeover();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, abandon, takeover),
    // Exactly how production builds it: the mapper refuses the old row.
    listOpenPrLabels: () => Promise.resolve(listedOpenPrs([{ number: 1 }])),
  });

  assertEquals(prListCalls(github.calls), 1);
  assertEquals(scan.length, 1);
});
