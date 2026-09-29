/**
 * Tests for merge_conflict_stall_watchdog.ts — a PR that has carried
 * `merge-conflict` for hours with no attempt ever concluding (Issue #1112).
 *
 * The detection keys on **wall-clock time since the label went on**, not on
 * attempt records, because the failure being detected is precisely that no
 * attempt record exists. The three tests the issue names as its earliest
 * failure detection points are here: the boundary table (with the open,
 * unconcluded attempt row), the cross-host dedupe, and the assertion that this
 * path never applies `needs-human`.
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
  buildConflictStallComment,
  CONFLICT_STALL_REPAIR_MARKER,
  type ConflictStallObservation,
  DEFAULT_CONFLICT_STALL_THRESHOLD_HOURS,
  detectConflictQueueStall,
  listedOpenPrs,
  repairConflictQueueStall,
  scanConflictQueueStalls,
} from "../lib/merge_conflict_stall_watchdog.ts";
import {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  CONFLICT_RESOLVED_MARKER,
  MERGE_CONFLICT_LABEL,
} from "../lib/pr_merge_conflict_scan.ts";
import {
  conflictParkedMarker,
  conflictRungFailedMarker,
} from "../lib/merge_conflict_markers.ts";
import {
  type AbandonRestartDeps,
  type AbandonRestartOutcome,
  type AbandonRestartRequest,
  conflictRestartMarker,
} from "../lib/conflict_abandon_restart.ts";
import type { ConflictIssueContext } from "../lib/conflict_issue_context.ts";
import type { RepoLease } from "../lib/maintenance_lane.ts";

const HOUR = 3600_000;
const NOW = Date.parse("2026-09-05T09:00:00Z");
const REPO = "org/repo";
const PR = 116;
/** The fleet login every trusted fixture comment is authored by. */
const FLEET = "vibe-coder-bot";
const isTrustedAuthor = (login: string) => login === FLEET;

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
      name: "labelled 9h ago with no attempt at all",
      labelAgeHours: 9,
      comments: [],
      detected: true,
      openAttempt: false,
    },
    {
      name: "labelled 9h ago with one concluded attempt",
      labelAgeHours: 9,
      comments: [
        comment(`${CONFLICT_ATTEMPT_MARKER} n="1" -->`, 8),
        comment(`${CONFLICT_FAILED_MARKER} n="1" -->`, 7),
      ],
      detected: false,
    },
    {
      name: "labelled 9h ago with one open, unconcluded attempt",
      labelAgeHours: 9,
      comments: [comment(`${CONFLICT_ATTEMPT_MARKER} n="1" -->`, 8)],
      detected: true,
      openAttempt: true,
    },
    {
      name: "labelled 3h ago, inside the threshold",
      labelAgeHours: 3,
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
    observation(9, [comment(CONFLICT_RESOLVED_MARKER, 6)]),
  );
  assertEquals(stall, null);
});

Deno.test("detectConflictQueueStall - a conclusion predating the label does not count", () => {
  // The label went on 9h ago; the conclusion is from the conflict before it.
  const stall = detect(
    observation(9, [comment(`${CONFLICT_FAILED_MARKER} n="1" -->`, 30)]),
  );
  assert(stall !== null);
  assertEquals(stall.labelAgeMs, 9 * HOUR);
});

Deno.test("detectConflictQueueStall - a conclusion starts a fresh clock", () => {
  // Labelled 20h ago, one attempt concluded 9h ago, silence since: the PR is
  // back in the ordinary ladder, and that ladder has stopped moving too.
  const stalled = detect(
    observation(20, [
      comment(`${CONFLICT_ATTEMPT_MARKER} n="1" -->`, 10),
      comment(`${CONFLICT_FAILED_MARKER} n="1" -->`, 9),
    ]),
  );
  assert(stalled !== null);
  assertEquals(stalled.stalledMs, 9 * HOUR);
  assertEquals(stalled.labelAgeMs, 20 * HOUR);
  assertEquals(stalled.lastConclusionAtMs, NOW - 9 * HOUR);
  assertEquals(stalled.openAttempt, false);

  // …and the fresh clock is a real clock: a conclusion 7h ago is inside it.
  assertEquals(
    detect(
      observation(20, [comment(`${CONFLICT_FAILED_MARKER} n="1" -->`, 7)]),
    ),
    null,
  );
});

Deno.test("detectConflictQueueStall - a trip before the last conclusion does not suppress", () => {
  // The previous stall was tripped, an attempt then concluded, and the queue
  // stopped again: that is a new stall, and it gets its own repair.
  const stall = detect(
    observation(30, [
      comment(`${CONFLICT_STALL_REPAIR_MARKER} trip="1" -->\nstalled`, 20),
      comment(`${CONFLICT_FAILED_MARKER} n="1" -->`, 12),
    ]),
  );
  assert(stall !== null);
  assertEquals(stall.stalledMs, 12 * HOUR);
});

Deno.test("detectConflictQueueStall - a forged conclusion cannot silence the watchdog", () => {
  // Any account may write a marker into a comment body on a public repo, so
  // an untrusted conclusion is ignored: the fail direction is towards saying
  // something, never towards silence.
  const stall = detect(
    observation(9, [
      comment(`${CONFLICT_FAILED_MARKER} n="1" -->`, 5, "drive-by"),
    ]),
  );
  assert(stall !== null);
});

Deno.test("detectConflictQueueStall - parked PRs are excluded", () => {
  const parked: [string, ConflictStallObservation][] = [
    [
      "needs-human",
      observation(9, [], {
        labels: [MERGE_CONFLICT_LABEL, "needs-human"],
      }),
    ],
    ["closed", observation(9, [], { closed: true })],
    // The label is not removed when a conflict clears by other means, so a
    // labelled PR that now merges cleanly is a stale label, not a stall.
    [
      "stale label — no longer conflicting",
      observation(9, [], {
        mergeableState: "MERGEABLE",
      }),
    ],
    [
      "mergeable state unknown",
      observation(9, [], {
        mergeableState: undefined,
      }),
    ],
    ["not in the queue", observation(9, [], { labels: [] })],
    ["label age unknown", observation(9, [], { labelledAtMs: undefined })],
  ];
  for (const [name, obs] of parked) {
    assertEquals(detect(obs), null, name);
  }
});

// ---------------------------------------------------------------------------
// Parked on the base tip (Issue #2312)
// ---------------------------------------------------------------------------

/** The base tip a park marker names in these fixtures. */
const PARKED_BASE = "1111111111111111111111111111111111111111";
/** The base tip after somebody pushed to the base branch. */
const MOVED_BASE = "2222222222222222222222222222222222222222";

Deno.test("detectConflictQueueStall - a parked PR on an unmoved base is not a stall", () => {
  // The park marker is what *follows* the label: the fleet has spent this
  // issue's restarts and is waiting on the base tip, which is the opposite of
  // the silence this watchdog reports.
  assertEquals(
    detect(
      observation(20, [comment(conflictParkedMarker(PARKED_BASE), 10)], {
        baseRefOid: PARKED_BASE,
      }),
    ),
    null,
  );
});

Deno.test("detectConflictQueueStall - a parked PR whose base moved is judged the usual way", () => {
  // The suppression is narrow on purpose: once the base moves, the scan owes
  // this PR an attempt again, so a park must not buy permanent silence.
  const stall = detect(
    observation(20, [comment(conflictParkedMarker(PARKED_BASE), 10)], {
      baseRefOid: MOVED_BASE,
    }),
  );
  assert(stall !== null);
});

Deno.test("detectConflictQueueStall - an outsider's park marker cannot silence the watchdog", () => {
  const stall = detect(
    observation(20, [
      comment(conflictParkedMarker(PARKED_BASE), 10, "drive-by"),
    ], { baseRefOid: PARKED_BASE }),
  );
  assert(stall !== null);
});

Deno.test("detectConflictQueueStall - a conclusion after a park ends the park", () => {
  // An attempt that concluded after the park means the PR was un-parked and
  // worked on; the park no longer describes what is happening.
  const stall = detect(
    observation(30, [
      comment(conflictParkedMarker(PARKED_BASE), 20),
      comment(`${CONFLICT_FAILED_MARKER} n="1" -->`, 12),
    ], { baseRefOid: PARKED_BASE }),
  );
  assert(stall !== null);
  assertEquals(stall.stalledMs, 12 * HOUR);
});

Deno.test("detectConflictQueueStall - the threshold is eight hours (Issue #2305)", () => {
  assertEquals(DEFAULT_CONFLICT_STALL_THRESHOLD_HOURS, 8);
  assertEquals(detect(observation(7.9)), null);
  assert(detect(observation(8.1)) !== null);
  // …and is configurable.
  assert(
    detectConflictQueueStall(observation(3), {
      nowMs: NOW,
      isTrustedAuthor,
      thresholdHours: 2,
    }) !== null,
  );
});

Deno.test("buildConflictStallComment - names the age, the silence and the skip reasons", () => {
  const stall = detect(
    observation(9, [], {
      skipReasons: [
        { kind: "budget-spent", attemptsSpent: 2, maxAttempts: 2 },
        { kind: "repo-leased", deferralStreak: 4 },
      ],
    }),
  );
  assert(stall !== null);
  const body = buildConflictStallComment(stall);
  assertStringIncludes(body, `${CONFLICT_STALL_REPAIR_MARKER} trip="1" -->`);
  assertStringIncludes(body, "9 hours");
  assertStringIncludes(body, "budget-spent");
  assertStringIncludes(body, "attemptsSpent");
  assertStringIncludes(body, "repo-leased");
  assertStringIncludes(body, "deferralStreak");
});

// ---------------------------------------------------------------------------
// Repair — rerun the ladder once, then abandon-and-redo (Issue #2803)
// ---------------------------------------------------------------------------

/** The head sha the ladder's wait markers name in these fixtures. */
const HEAD = "abcdef1";

/** A fake GitHub holding one PR's thread, shared by every simulated host. */
function fakeGitHub(
  prComments: Record<string, unknown>[] = [],
  mergeableState = "CONFLICTING",
) {
  const calls: string[][] = [];
  const deleted: number[] = [];
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
      }]));
    }
    if (verb === "pr" && noun === "view") {
      return Promise.resolve(
        JSON.stringify({ headRefName: "issue-7-branch", baseRefName: "main" }),
      );
    }
    if (verb === "api" && args[1] === "-X" && args[2] === "DELETE") {
      const id = /\/comments\/(\d+)$/.exec(args[3] ?? "")?.[1];
      if (id !== undefined) deleted.push(Number(id));
      return Promise.resolve("");
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

  return { calls, deleted, prComments, gh };
}

/** A recording `abandonAndRestart` seam and a lease that is always granted. */
function fakeRepair(
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

/** A trip marker comment, as the first trip posts it. */
const tripComment = (agoHours: number, login = FLEET) =>
  comment(
    `${CONFLICT_STALL_REPAIR_MARKER} trip="1" -->\nrerunning`,
    agoHours,
    login,
  );

/**
 * Neither trip files an issue, labels the PR `escalated`, or applies the
 * `needs-human` veto (Issues #569, #2803). Comment bodies are exempt: they
 * explain in prose, and are not mutations.
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
  assert(
    !mutations.some((call) => call.some((arg) => arg.includes("needs-human"))),
    `needs-human must never be applied by this path: ${
      JSON.stringify(mutations)
    }`,
  );
}

async function repair(
  github: ReturnType<typeof fakeGitHub>,
  fake: ReturnType<typeof fakeRepair>,
  stall = detect(observation(9)),
) {
  assert(stall !== null);
  return await repairConflictQueueStall(stall, {
    ghCommandFn: github.gh,
    logger,
    isTrustedAuthor,
    nowMs: NOW,
    abandon: fake.abandon,
    acquireLease: fake.acquireLease,
  });
}

Deno.test("repairConflictQueueStall - the first trip reruns the ladder once and does not abandon", async () => {
  const github = fakeGitHub([
    { id: 501, ...comment(conflictRungFailedMarker("abandon", HEAD), 5) },
    // An outsider's wait marker is not the ladder's, so it is left alone.
    {
      id: 502,
      ...comment(conflictRungFailedMarker("abandon", HEAD), 4, "drive-by"),
    },
    // A rebase-rung failure is not the wait the rerun needs cleared.
    { id: 503, ...comment(conflictRungFailedMarker("rebase", HEAD), 3) },
  ]);
  const fake = fakeRepair();

  assertEquals(await repair(github, fake), "first-trip");

  assertEquals(github.deleted, [501], "only the ladder's own wait is cleared");
  const posted = postedComments(github.calls);
  assertEquals(posted.length, 1);
  assertStringIncludes(
    posted[0] ?? "",
    `${CONFLICT_STALL_REPAIR_MARKER} trip="1" -->`,
  );
  assertEquals(fake.abandoned, [], "the first trip never abandons");
  assertNoEscalation(github.calls);
  assertEquals(fake.released(), 1);
});

Deno.test("repairConflictQueueStall - inside the window after the first trip it waits", async () => {
  const github = fakeGitHub([tripComment(2)]);
  const fake = fakeRepair();

  assertEquals(await repair(github, fake), "awaiting-second-check");

  assertEquals(postedComments(github.calls), []);
  assertEquals(fake.abandoned, []);
  assertNoEscalation(github.calls);
});

Deno.test("repairConflictQueueStall - the second trip abandons and redoes exactly once", async () => {
  const github = fakeGitHub([tripComment(8.5)]);
  const fake = fakeRepair();

  assertEquals(await repair(github, fake), "abandoned");

  assertEquals(fake.abandoned.length, 1);
  const request = fake.abandoned[0]!;
  assertEquals(request.repo, REPO);
  assertEquals(request.prNumber, PR);
  assertEquals(request.branchName, "issue-7-branch");
  assertEquals(request.baseBranch, "main");
  assertEquals(request.reason?.kind, "stalled");
  assertEquals(postedComments(github.calls), [], "no second trip comment");
  assertNoEscalation(github.calls);
  assertEquals(fake.released(), 1);
});

Deno.test("repairConflictQueueStall - a declined or failed abandon is reported, never swallowed", async () => {
  const declined = fakeRepair({
    outcome: "declined",
    reason: {
      kind: "already-restarted",
      issueNumber: 7,
      samePr: true,
      restartCount: 2,
    },
  });
  assertEquals(
    await repair(fakeGitHub([tripComment(8.5)]), declined),
    "abandon-declined",
  );

  const failed = fakeRepair({
    outcome: "failed",
    step: "pr-close",
    message: "gh pr close failed",
  });
  assertEquals(await repair(fakeGitHub([tripComment(8.5)]), failed), "failed");
});

Deno.test("repairConflictQueueStall - a second trip on an issue already redone twice adds needs-human and one comment (Issue #2804)", async () => {
  const ISSUE = 7;
  const github = fakeGitHub([tripComment(8.5)]);
  const issue = {
    labels: ["work-on"],
    comments: [
      comment(conflictRestartMarker(REPO, 61), 48),
      comment(conflictRestartMarker(REPO, 62), 24),
    ],
  };
  const issuePath = `/issues/${ISSUE}/`;
  const gh = (args: string[]): Promise<string> => {
    const path = args.find((arg) => arg.includes(issuePath)) ?? "";
    if (args[0] === "issue" && args[1] === "view") {
      github.calls.push(args);
      return Promise.resolve(JSON.stringify({
        state: "OPEN",
        labels: issue.labels.map((name) => ({ name })),
      }));
    }
    if (path === "") return github.gh(args);
    github.calls.push(args);
    if (args[1] !== "-X") {
      return Promise.resolve(
        path.includes("page=1") ? JSON.stringify(issue.comments) : "[]",
      );
    }
    const field = args[5] ?? "";
    if (path.endsWith("/labels")) {
      issue.labels.push(field.replace(/^labels\[\]=/, ""));
    } else if (path.endsWith("/comments")) {
      issue.comments.push(comment(field.replace(/^body=/, ""), 0));
    }
    return Promise.resolve("");
  };
  const context: ConflictIssueContext = {
    repo: REPO,
    prNumber: PR,
    prSide: {
      resolved: true,
      signal: "branch",
      issue: {
        number: ISSUE,
        title: "Fix it",
        state: "OPEN",
        body: "",
        bodyTruncated: false,
      },
    },
    baseSide: [],
    truncation: {
      commitCapPaths: [],
      issueCapHit: false,
      textTruncatedIssues: [],
      ghCallCapHit: false,
    },
    ghCallsUsed: 0,
    warnings: [],
  };
  const stall = detect(observation(9, [tripComment(8.5)]));
  assert(stall !== null);
  const run = () =>
    repairConflictQueueStall(stall, {
      ghCommandFn: gh,
      logger,
      isTrustedAuthor,
      nowMs: NOW,
      trustedAuthors: [FLEET],
      acquireLease: () => ({ release: noop }),
      abandonDeps: {
        resolveContext: () => Promise.resolve(context),
        findOtherPrs: () => Promise.resolve([]),
      },
    });

  assertEquals(await run(), "abandon-declined");

  assertEquals(issue.labels, ["work-on", "needs-human"]);
  assertEquals(issue.comments.length, 3);
  assertStringIncludes(String(issue.comments[2]?.body), `${REPO}#${PR}`);
  assert(
    !github.calls.some((call) => call[0] === "pr" && call[1] === "close"),
    "no third redo closes the PR",
  );

  // A later check finds needs-human already there and says nothing more.
  assertEquals(await run(), "abandon-declined");
  assertEquals(issue.comments.length, 3);
});

Deno.test("repairConflictQueueStall - an untrusted or pre-label trip marker is not a trip", async () => {
  // A forged marker must not skip straight to closing the PR, and a trip from
  // an earlier stall — before the label last went on — belongs to that stall.
  for (const trip of [tripComment(8.5, "drive-by"), tripComment(20)]) {
    const github = fakeGitHub([trip]);
    const fake = fakeRepair();
    assertEquals(await repair(github, fake), "first-trip");
    assertEquals(fake.abandoned, []);
  }
});

Deno.test("repairConflictQueueStall - a conclusion after the trip starts the ladder over", async () => {
  // The rerun concluded, then the queue stalled again: that is a fresh stall,
  // and it gets its own first trip rather than an abandon.
  const github = fakeGitHub([
    tripComment(30),
    comment(`${CONFLICT_FAILED_MARKER} n="1" -->`, 12),
  ]);
  const fake = fakeRepair();
  const stall = detect(
    observation(40, [...github.prComments]),
  );

  assertEquals(await repair(github, fake, stall), "first-trip");
  assertEquals(fake.abandoned, []);
});

Deno.test("repairConflictQueueStall - a held maintenance lease defers the repair", async () => {
  const github = fakeGitHub();
  const fake = fakeRepair();
  const stall = detect(observation(9));
  assert(stall !== null);

  const action = await repairConflictQueueStall(stall, {
    ghCommandFn: github.gh,
    logger,
    isTrustedAuthor,
    nowMs: NOW,
    abandon: fake.abandon,
    acquireLease: () => null,
  });

  assertEquals(action, "skipped-lease-held");
  assertEquals(github.calls, []);
});

// ---------------------------------------------------------------------------
// Scan — cross-host dedupe and the label assertion (Issue #1112)
// ---------------------------------------------------------------------------

const scanOptions = (
  github: ReturnType<typeof fakeGitHub>,
  fake: ReturnType<typeof fakeRepair>,
) => ({
  repos: [REPO],
  ghCommandFn: github.gh,
  abandon: fake.abandon,
  acquireLease: fake.acquireLease,
  isTrustedAuthor,
  nowMs: () => NOW,
  logger,
});

Deno.test("scanConflictQueueStalls - two hosts in one window trip once", async () => {
  const github = fakeGitHub();
  const fake = fakeRepair();

  const hostA = await scanConflictQueueStalls(scanOptions(github, fake));
  const hostB = await scanConflictQueueStalls(scanOptions(github, fake));

  assertEquals(hostA.length, 1);
  // The second host still sees the stall, but reads the first host's trip
  // marker off the PR itself, so it neither trips again nor abandons.
  assertEquals(hostB.length, 1);
  assertEquals(postedComments(github.calls).length, 1);
  assertEquals(fake.abandoned, []);
});

Deno.test("scanConflictQueueStalls - files no issue and adds no label on either trip", async () => {
  const github = fakeGitHub();
  const fake = fakeRepair();

  // First trip, then the next check once the window has passed again.
  await scanConflictQueueStalls(scanOptions(github, fake));
  await scanConflictQueueStalls({
    ...scanOptions(github, fake),
    nowMs: () => NOW + 9 * HOUR,
  });

  assertEquals(postedComments(github.calls).length, 1);
  assertEquals(fake.abandoned.length, 1, "the second trip abandons once");
  assertNoEscalation(github.calls);
  assertEquals(
    github.calls.filter((call) => call.includes("--add-label")),
    [],
  );
});

Deno.test("scanConflictQueueStalls - a concluded attempt after a trip is not abandoned", async () => {
  const github = fakeGitHub();
  const fake = fakeRepair();

  await scanConflictQueueStalls(scanOptions(github, fake));
  // The rerun happens: an attempt runs and concludes.
  github.prComments.push(comment(`${CONFLICT_ATTEMPT_MARKER} n="1" -->`, 0));
  github.prComments.push(comment(`${CONFLICT_FAILED_MARKER} n="1" -->`, 0));

  const next = await scanConflictQueueStalls(scanOptions(github, fake));

  assertEquals(next.length, 0);
  assertEquals(fake.abandoned, []);
});

Deno.test("scanConflictQueueStalls - carries this cycle's skip reasons into the comment", async () => {
  const github = fakeGitHub();
  const fake = fakeRepair();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, fake),
    decisions: [{
      repo: REPO,
      prNumber: PR,
      outcome: "skipped",
      reason: { kind: "repo-leased", deferralStreak: 6 },
    }],
  });

  assertEquals(scan[0]?.skipReasons.length, 1);
  const body = postedComments(github.calls)[0] ?? "";
  assertStringIncludes(body, "repo-leased");
  assertStringIncludes(body, "deferralStreak=6");
});

Deno.test("scanConflictQueueStalls - a stale label on a mergeable PR is not repaired", async () => {
  const github = fakeGitHub([], "MERGEABLE");
  const fake = fakeRepair();

  const scan = await scanConflictQueueStalls(scanOptions(github, fake));

  assertEquals(scan.length, 0);
  // Not even read: the listing already said the queue is not real.
  assertEquals(postedComments(github.calls).length, 0);
  assertEquals(
    github.calls.filter((call) => call[0] === "api").length,
    0,
  );
});

Deno.test("scanConflictQueueStalls - an uncomputed mergeable state is re-read, not assumed", async () => {
  // GitHub computes mergeability lazily, so the listing can answer UNKNOWN for
  // a PR that genuinely conflicts. Dropping it there would be the silence this
  // watchdog exists to remove.
  const github = fakeGitHub([], "UNKNOWN");
  const fake = fakeRepair();
  const withView = (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve("CONFLICTING\n");
    }
    return github.gh(args);
  };

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, fake),
    ghCommandFn: withView,
  });

  assertEquals(scan.length, 1);
  assertEquals(postedComments(github.calls).length, 1);
});

Deno.test("scanConflictQueueStalls - a state that stays uncomputed repairs nothing", async () => {
  const github = fakeGitHub([], "UNKNOWN");
  const fake = fakeRepair();
  const warnings: string[] = [];
  const withView = (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve("UNKNOWN");
    }
    return github.gh(args);
  };

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, fake),
    ghCommandFn: withView,
    logger: { ...logger, warn: (message: string) => warnings.push(message) },
  });

  assertEquals(scan.length, 0);
  assertEquals(postedComments(github.calls).length, 0);
  // Loud, not silent: an unestablished state is exactly what went unnoticed.
  assert(
    warnings.some((message) => message.includes("mergeable state")),
    `expected a warning about the unestablished state: ${warnings.join(" | ")}`,
  );
});

Deno.test("scanConflictQueueStalls - repeated identical skip reasons are collapsed", async () => {
  const github = fakeGitHub();
  const fake = fakeRepair();
  const leased = {
    repo: REPO,
    prNumber: PR,
    outcome: "skipped" as const,
    reason: { kind: "repo-leased" as const, deferralStreak: 4 },
  };

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, fake),
    // The drain calls the scan once per PR it takes, so one held-back PR is
    // decided on several times in a cycle.
    decisions: [leased, leased, leased],
  });

  assertEquals(scan[0]?.skipReasons.length, 1);
  const body = postedComments(github.calls)[0] ?? "";
  assertEquals(body.split("`repo-leased`").length - 1, 1);
});

Deno.test("scanConflictQueueStalls - a repo outside the allowlist is not touched", async () => {
  const github = fakeGitHub();
  const fake = fakeRepair();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, fake),
    isRepoAllowed: () => false,
  });

  assertEquals(scan.length, 0);
  assertEquals(github.calls.length, 0);
});

Deno.test("scanConflictQueueStalls - an unreadable PR does not stop the pass", async () => {
  const github = fakeGitHub();
  const fake = fakeRepair();
  const failing = (args: string[]) => {
    if (args[0] === "api" && args[1]?.includes("/comments")) {
      return Promise.reject(new Error("comments unavailable"));
    }
    return github.gh(args);
  };

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, fake),
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
//
// Live measurement, 2026-09-20: `graphql-shapes:` showed
// `20×[pr list --json --label --repo --state]` on every cycle — this watchdog
// asking each of 20 repositories for its open PRs carrying `merge-conflict`,
// every ~3 minutes, almost always to learn "none". The fleet was exhausting
// its GraphQL quota ~25 minutes into every hour. A stall is eight hours long;
// learning that a PR gained the label ten minutes late costs nothing.
// =============================================================================

const prListCalls = (calls: readonly string[][]) =>
  calls.filter((c) => c[0] === "pr" && c[1] === "list").length;

Deno.test("scanConflictQueueStalls - a complete cached listing with no labelled PR means no live listing (Issue #2409)", async () => {
  const github = fakeGitHub();
  const fake = fakeRepair();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, fake),
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
  const fake = fakeRepair();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, fake),
    listOpenPrLabels: () =>
      Promise.resolve([{ number: PR, labels: [MERGE_CONFLICT_LABEL] }]),
  });

  assertEquals(prListCalls(github.calls), 1);
  assertEquals(scan.length, 1, "the stall is found exactly as before");
});

Deno.test("scanConflictQueueStalls - a full cached listing cannot prove absence, so the repository is asked (Issue #2409)", async () => {
  const github = fakeGitHub();
  const fake = fakeRepair();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, fake),
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
  const fake = fakeRepair();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, fake),
    listOpenPrLabels: () => Promise.reject(new Error("cache unreadable")),
  });

  assertEquals(prListCalls(github.calls), 1);
  assertEquals(scan.length, 1);
});

Deno.test("scanConflictQueueStalls - without a cached listing it lists every repository, exactly as before (Issue #2409)", async () => {
  const github = fakeGitHub();
  const fake = fakeRepair();
  await scanConflictQueueStalls({
    ...scanOptions(github, fake),
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
  const fake = fakeRepair();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, fake),
    // Exactly how production builds it: the mapper refuses the old row.
    listOpenPrLabels: () => Promise.resolve(listedOpenPrs([{ number: 1 }])),
  });

  assertEquals(prListCalls(github.calls), 1);
  assertEquals(scan.length, 1);
});
