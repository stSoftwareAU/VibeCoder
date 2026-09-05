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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Logger, Result } from "../types.ts";
import {
  buildConflictStallComment,
  CONFLICT_STALL_SUMMARY,
  type ConflictStallObservation,
  DEFAULT_CONFLICT_STALL_THRESHOLD_HOURS,
  detectConflictQueueStall,
  escalateConflictQueueStall,
  scanConflictQueueStalls,
} from "../lib/merge_conflict_stall_watchdog.ts";
import {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  CONFLICT_RESOLVED_MARKER,
  MERGE_CONFLICT_LABEL,
} from "../lib/pr_merge_conflict_scan.ts";
import {
  ESCALATED_AS_WORK_LABEL,
  type WorkEscalation,
  workEscalationMarker,
} from "../lib/escalate_as_work.ts";

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

Deno.test("detectConflictQueueStall - an escalation before the last conclusion does not suppress", () => {
  // The previous stall was escalated, an attempt then concluded, and the queue
  // stopped again: that is a new stall, and it gets its own escalation.
  const stall = detect(
    observation(30, [
      comment(`${workEscalationMarker(REPO, PR)}\nstalled`, 20),
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
    [
      "already escalated for this stall",
      observation(9, [
        comment(`${workEscalationMarker(REPO, PR)}\nstalled`, 2),
      ]),
    ],
  ];
  for (const [name, obs] of parked) {
    assertEquals(detect(obs), null, name);
  }
});

Deno.test("detectConflictQueueStall - the threshold defaults to twice the cooldown", () => {
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
        { kind: "cooldown", msUntilDue: 900_000 },
        { kind: "repo-leased", deferralStreak: 4 },
      ],
    }),
  );
  assert(stall !== null);
  const body = buildConflictStallComment(stall);
  assertStringIncludes(body, workEscalationMarker(REPO, PR));
  assertStringIncludes(body, "9 hours");
  assertStringIncludes(body, "cooldown");
  assertStringIncludes(body, "msUntilDue");
  assertStringIncludes(body, "repo-leased");
  assertStringIncludes(body, "deferralStreak");
});

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/** A fake GitHub holding one PR's thread, shared by every simulated host. */
function fakeGitHub(
  prComments: Record<string, unknown>[] = [],
  mergeableState = "CONFLICTING",
) {
  const calls: string[][] = [];
  const labelled: string[] = [];
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

  return {
    calls,
    labelled,
    prComments,
    gh,
    labelPr: (_repo: string, _prNumber: number, label: string) => {
      labelled.push(label);
      return Promise.resolve({ ok: true, value: undefined } as Result<void>);
    },
  };
}

/** A recording `escalateAsWork` seam. */
function fakeEscalateWork(fail = false) {
  const filed: WorkEscalation[] = [];
  return {
    filed,
    escalateWork: (escalation: WorkEscalation) => {
      filed.push(escalation);
      return Promise.resolve(
        fail
          ? { ok: false, error: new Error("gh issue create failed") } as Result<
            { issueNumber: number; filed: boolean }
          >
          : { ok: true, value: { issueNumber: 900, filed: true } } as Result<
            { issueNumber: number; filed: boolean }
          >,
      );
    },
  };
}

Deno.test("escalateConflictQueueStall - files the stall as work and marks the PR", async () => {
  const github = fakeGitHub();
  const work = fakeEscalateWork();
  const stall = detect(observation(9));
  assert(stall !== null);

  const result = await escalateConflictQueueStall(stall, {
    ghCommandFn: github.gh,
    labelPr: github.labelPr,
    escalateWork: work.escalateWork,
    logger,
  });

  assert(result.ok);
  assertEquals(result.value.issueNumber, 900);
  assertEquals(work.filed.length, 1);
  assertEquals(work.filed[0]?.summary, CONFLICT_STALL_SUMMARY);
  assertStringIncludes(work.filed[0]?.reason ?? "", REPO);
  assertStringIncludes(work.filed[0]?.reason ?? "", "9 hours");
  // One comment on the PR, carrying the dedup marker.
  const comments = postedComments(github.calls);
  assertEquals(comments.length, 1);
  assertStringIncludes(comments[0] ?? "", workEscalationMarker(REPO, PR));
  assertEquals(github.labelled, [ESCALATED_AS_WORK_LABEL]);
});

Deno.test("escalateConflictQueueStall - a failed filing is reported, never swallowed", async () => {
  const github = fakeGitHub();
  const work = fakeEscalateWork(true);
  const stall = detect(observation(9));
  assert(stall !== null);

  const result = await escalateConflictQueueStall(stall, {
    ghCommandFn: github.gh,
    labelPr: github.labelPr,
    escalateWork: work.escalateWork,
    logger,
  });

  assert(!result.ok);
  assertStringIncludes(result.error.message, "gh issue create failed");
  // No marker comment: the next pass must retry rather than find a dedup
  // marker standing in for an escalation that never landed.
  assertEquals(postedComments(github.calls).length, 0);
});

Deno.test("escalateConflictQueueStall - a comment that fails after filing names both", async () => {
  const github = fakeGitHub();
  const work = fakeEscalateWork();
  const stall = detect(observation(9));
  assert(stall !== null);

  const result = await escalateConflictQueueStall(stall, {
    ghCommandFn: (args: string[]) =>
      args[0] === "pr" && args[1] === "comment"
        ? Promise.reject(new Error("comment rejected"))
        : github.gh(args),
    labelPr: github.labelPr,
    escalateWork: work.escalateWork,
    logger,
  });

  assert(!result.ok);
  // The filed issue is named, so the failure is diagnosable rather than a bare
  // "could not comment".
  assertStringIncludes(result.error.message, "900");
  assertStringIncludes(result.error.message, "comment rejected");
});

// ---------------------------------------------------------------------------
// Scan — cross-host dedupe and the label assertion (Issue #1112)
// ---------------------------------------------------------------------------

const scanOptions = (
  github: ReturnType<typeof fakeGitHub>,
  work: ReturnType<typeof fakeEscalateWork>,
) => ({
  repos: [REPO],
  ghCommandFn: github.gh,
  labelPr: github.labelPr,
  escalateWork: work.escalateWork,
  isTrustedAuthor,
  nowMs: () => NOW,
  logger,
});

Deno.test("scanConflictQueueStalls - two hosts in one window escalate once", async () => {
  const github = fakeGitHub();
  const work = fakeEscalateWork();

  const hostA = await scanConflictQueueStalls(scanOptions(github, work));
  const hostB = await scanConflictQueueStalls(scanOptions(github, work));

  assertEquals(hostA.length, 1);
  // The second host reads the first host's marker off the PR itself, so it
  // finds no stall to escalate.
  assertEquals(hostB.length, 0);
  assertEquals(work.filed.length, 1);
  assertEquals(postedComments(github.calls).length, 1);
});

Deno.test("scanConflictQueueStalls - applies escalated, never needs-human", async () => {
  const github = fakeGitHub();
  const work = fakeEscalateWork();

  const scan = await scanConflictQueueStalls(scanOptions(github, work));

  assertEquals(scan.length, 1);
  assertEquals(github.labelled, [ESCALATED_AS_WORK_LABEL]);
  assert(!github.labelled.includes("needs-human"));
  // No `gh` call asks for the veto label either. Comment *bodies* are exempt:
  // the comment explains, in prose, that the stall deliberately does not get
  // one. Issue #569: a mechanical stall is work, not a decision.
  const mutations = github.calls.map((call) => {
    const body = call.indexOf("--body");
    return body === -1
      ? call
      : [...call.slice(0, body), ...call.slice(body + 2)];
  });
  assert(
    !mutations.some((call) => call.some((arg) => arg.includes("needs-human"))),
    `needs-human must never be applied by this path: ${
      JSON.stringify(mutations)
    }`,
  );
});

Deno.test("scanConflictQueueStalls - a concluded attempt after an escalation is not re-escalated", async () => {
  const github = fakeGitHub();
  const work = fakeEscalateWork();

  await scanConflictQueueStalls(scanOptions(github, work));
  // The stalled queue moves again: an attempt runs and concludes.
  github.prComments.push(comment(`${CONFLICT_ATTEMPT_MARKER} n="1" -->`, 0));
  github.prComments.push(comment(`${CONFLICT_FAILED_MARKER} n="1" -->`, 0));

  const next = await scanConflictQueueStalls(scanOptions(github, work));

  assertEquals(next.length, 0);
  assertEquals(work.filed.length, 1);
});

Deno.test("scanConflictQueueStalls - carries this cycle's skip reasons into the comment", async () => {
  const github = fakeGitHub();
  const work = fakeEscalateWork();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, work),
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

Deno.test("scanConflictQueueStalls - a stale label on a mergeable PR is not escalated", async () => {
  const github = fakeGitHub([], "MERGEABLE");
  const work = fakeEscalateWork();

  const scan = await scanConflictQueueStalls(scanOptions(github, work));

  assertEquals(scan.length, 0);
  assertEquals(work.filed.length, 0);
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
  const work = fakeEscalateWork();
  const withView = (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve("CONFLICTING\n");
    }
    return github.gh(args);
  };

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, work),
    ghCommandFn: withView,
  });

  assertEquals(scan.length, 1);
  assertEquals(work.filed.length, 1);
});

Deno.test("scanConflictQueueStalls - a state that stays uncomputed escalates nothing", async () => {
  const github = fakeGitHub([], "UNKNOWN");
  const work = fakeEscalateWork();
  const warnings: string[] = [];
  const withView = (args: string[]) => {
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve("UNKNOWN");
    }
    return github.gh(args);
  };

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, work),
    ghCommandFn: withView,
    logger: { ...logger, warn: (message: string) => warnings.push(message) },
  });

  assertEquals(scan.length, 0);
  assertEquals(work.filed.length, 0);
  // Loud, not silent: an unestablished state is exactly what went unnoticed.
  assert(
    warnings.some((message) => message.includes("mergeable state")),
    `expected a warning about the unestablished state: ${warnings.join(" | ")}`,
  );
});

Deno.test("scanConflictQueueStalls - repeated identical skip reasons are collapsed", async () => {
  const github = fakeGitHub();
  const work = fakeEscalateWork();
  const cooldown = {
    repo: REPO,
    prNumber: PR,
    outcome: "skipped" as const,
    reason: { kind: "cooldown" as const, msUntilDue: 900_000 },
  };

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, work),
    // The drain calls the scan once per PR it takes, so one held-back PR is
    // decided on several times in a cycle.
    decisions: [cooldown, cooldown, cooldown],
  });

  assertEquals(scan[0]?.skipReasons.length, 1);
  const body = postedComments(github.calls)[0] ?? "";
  assertEquals(body.split("`cooldown`").length - 1, 1);
});

Deno.test("scanConflictQueueStalls - a repo outside the allowlist is not touched", async () => {
  const github = fakeGitHub();
  const work = fakeEscalateWork();

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, work),
    isRepoAllowed: () => false,
  });

  assertEquals(scan.length, 0);
  assertEquals(github.calls.length, 0);
});

Deno.test("scanConflictQueueStalls - an unreadable PR does not stop the pass", async () => {
  const github = fakeGitHub();
  const work = fakeEscalateWork();
  const failing = (args: string[]) => {
    if (args[0] === "api" && args[1]?.includes("/comments")) {
      return Promise.reject(new Error("comments unavailable"));
    }
    return github.gh(args);
  };

  const scan = await scanConflictQueueStalls({
    ...scanOptions(github, work),
    ghCommandFn: failing,
  });

  assertEquals(scan.length, 0);
  assertEquals(work.filed.length, 0);
});
