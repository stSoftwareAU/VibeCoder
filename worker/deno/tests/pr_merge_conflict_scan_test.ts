/**
 * Tests for pr_merge_conflict_scan.ts (Issue #84).
 *
 * The scan is the missing receiver for the #4373 hand-off: it finds PRs
 * stuck at `mergeable == CONFLICTING`, labels them so the queue is visible,
 * and hands exactly one due candidate to the resolution processor while the
 * attempt bound holds everything else back.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  CONFLICT_RESOLVED_MARKER,
  conflictPrKey,
  countDisruptedAttempts,
  DEFAULT_MAX_CONFLICT_ATTEMPTS,
  DEFAULT_MAX_DISRUPTED_ATTEMPTS,
  findConflictingPr,
  type FindConflictingPrOptions,
  hasExhaustedConflictAttempts,
  hasExhaustedDisruptedAttempts,
  isConflictAttemptDue,
  MERGE_CONFLICT_LABEL,
  parseConflictAttempts,
} from "../lib/pr_merge_conflict_scan.ts";
import {
  type AbandonRestartRequest,
  type AbandonStep,
  CONFLICT_RESTART_MARKER,
  conflictRestartMarker,
} from "../lib/conflict_abandon_restart.ts";
import type { MergeFallbackFiling } from "../lib/merge_fallback_issue.ts";
import type { LogContext, Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
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
}

/** The worker's own login — the fleet identity every fixture comment carries. */
const FLEET = "vibe-bot";
/** An account with no fleet privileges at all — the attacker (Issue #1247). */
const OUTSIDER = "drive-by";

/** Message prefix of a per-PR decision record (Issue #1109). */
const DECISION_PREFIX = "merge_conflict_decision=";
/** Message prefix of the pass-level summary record (Issue #1109). */
const SUMMARY_PREFIX = "merge_conflict_pass=";

/** One captured log line. */
interface LogEntry {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  context?: LogContext;
}

interface RecordingLogger extends Logger {
  entries: LogEntry[];
}

/** A logger that keeps what it was told, so the records can be asserted. */
function makeRecordingLogger(): RecordingLogger {
  const entries: LogEntry[] = [];
  const capture =
    (level: LogEntry["level"]) => (message: string, context?: LogContext) => {
      entries.push({ level, message, ...(context ? { context } : {}) });
    };
  return {
    entries,
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
    debug: capture("debug"),
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

interface FakeRepoState {
  /** PRs the listing returns. */
  prs: Array<{
    number: number;
    headRefName: string;
    baseRefName: string;
    /** Present only when the listing carried an author (Issue #1109). */
    author?: { login: string };
  }>;
  /** Mergeable state per PR number. */
  mergeable: Record<number, string>;
  /** Labels per PR number. */
  labels: Record<number, string[]>;
  /**
   * Comment thread per PR number.
   *
   * `user` is what makes a marker attributable (Issue #1247); a fixture that
   * omits it is one of the worker's own comments and is stamped {@link FLEET}.
   */
  comments: Record<
    number,
    Array<{ body: string; created_at: string; user?: { login: string } }>
  >;
  /** PR numbers the batched state query answers for nothing (Issue #1109). */
  omitState?: number[];
  /** PR numbers whose label lookup fails (Issue #1109). */
  failLabels?: number[];
  /** PR numbers whose comment lookup fails (Issue #1109). */
  failComments?: number[];
  /**
   * Originating issues the abandon-and-restart rung can resolve (Issue #1115).
   * Absent means `gh issue view` answers nothing, which is the "no originating
   * issue" case the rung must decline on.
   */
  issues?: Record<number, { title: string; state: string; labels: string[] }>;
  /** PRs `findExistingPrForIssue` sees, keyed by PR state (Issue #1115). */
  prsByState?: Record<string, Array<{ number: number; title: string }>>;
  /** Args prefix (joined with a space) whose call must throw (Issue #1115). */
  failOn?: string;
  /** Files `gh pr view --json files` reports per PR (Issue #2310). */
  prFiles?: Record<
    number,
    Array<{ path: string; additions: number; deletions: number }>
  >;
  /** Issue number `gh issue create` reports for a filed flag (Issue #2310). */
  createdIssueNumber?: number;
}

interface FakeGh {
  ghCommandFn: (args: string[]) => Promise<string>;
  labelsAdded: Array<{ prNumber: number; label: string }>;
  commentsPosted: Array<{ prNumber: number; body: string }>;
  /** Issues `gh issue create` was asked to file (Issue #2310). */
  issuesCreated: Array<{ title: string; body: string; labels: string[] }>;
  calls: string[][];
}

/** A `gh` stub that answers exactly the calls this scan issues. */
function makeFakeGh(state: FakeRepoState): FakeGh {
  const labelsAdded: Array<{ prNumber: number; label: string }> = [];
  const commentsPosted: Array<{ prNumber: number; body: string }> = [];
  const issuesCreated: Array<
    { title: string; body: string; labels: string[] }
  > = [];
  const calls: string[][] = [];

  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    if (state.failOn && joined.startsWith(state.failOn)) {
      return Promise.reject(new Error(`gh refused: ${state.failOn}`));
    }

    if (args[0] === "pr" && args[1] === "list") {
      // The scan's own listing asks for the branch names; the abandon rung's
      // existing-PR check (Issue #1115) does not.
      const fields = String(args[args.indexOf("--json") + 1] ?? "");
      if (fields.includes("headRefName")) {
        return Promise.resolve(JSON.stringify(state.prs));
      }
      const prState = String(args[args.indexOf("--state") + 1] ?? "open");
      return Promise.resolve(JSON.stringify(
        (state.prsByState?.[prState] ?? []).map((pr) => ({
          ...pr,
          url: `https://github.com/org/repo/pull/${pr.number}`,
          body: "",
        })),
      ));
    }

    // The `merge-fallback` flag issue (Issue #2310) — filed, and deduped by
    // the title search that runs before it.
    if (args[0] === "issue" && args[1] === "create") {
      const labels: string[] = [];
      args.forEach((arg, index) => {
        if (arg === "--label") labels.push(String(args[index + 1] ?? ""));
      });
      issuesCreated.push({
        title: String(args[args.indexOf("--title") + 1] ?? ""),
        body: String(args[args.indexOf("--body") + 1] ?? ""),
        labels,
      });
      const number = state.createdIssueNumber ?? 900;
      return Promise.resolve(`https://github.com/org/repo/issues/${number}\n`);
    }
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve("[]");
    }

    // How far behind the base the head is, for the flag (Issue #2310).
    if (args[0] === "api" && String(args[1]).includes("/compare/")) {
      return Promise.resolve("41\n");
    }

    // The queue label's own `labeled` event, for the flag (Issue #2310).
    if (args[0] === "api" && String(args[1]).includes("/timeline")) {
      return Promise.resolve(JSON.stringify([{
        event: "labeled",
        label: { name: MERGE_CONFLICT_LABEL },
        actor: { login: FLEET },
        created_at: "2026-08-18T09:30:00Z",
      }]));
    }

    // The originating issue, for the abandon rung (Issue #1115).
    if (args[0] === "issue" && args[1] === "view") {
      const issue = state.issues?.[Number(args[2])];
      if (!issue) return Promise.resolve("");
      const fields = String(args[args.indexOf("--json") + 1] ?? "");
      return Promise.resolve(JSON.stringify(
        fields.includes("labels")
          ? {
            state: issue.state,
            labels: issue.labels.map((name) => ({ name })),
          }
          : {
            number: Number(args[2]),
            title: issue.title,
            state: issue.state,
            body: "",
          },
      ));
    }

    // A comment posted through the CLI — on the PR, or on the issue, where
    // the restart marker lives (Issue #1115).
    if (
      (args[0] === "issue" || args[0] === "pr") && args[1] === "comment"
    ) {
      const number = Number(args[2]);
      const body = String(args[args.indexOf("--body") + 1] ?? "");
      commentsPosted.push({ prNumber: number, body });
      (state.comments[number] ??= []).push({
        body,
        created_at: "2026-08-20T12:00:00Z",
      });
      return Promise.resolve("");
    }

    // Batched branch-state GraphQL query: answer with each PR's mergeable.
    if (args[0] === "api" && args[1] === "graphql") {
      const repository: Record<string, unknown> = {};
      state.prs.forEach((pr, index) => {
        if (state.omitState?.includes(pr.number)) return;
        repository[`p${index}`] = {
          number: pr.number,
          mergeable: state.mergeable[pr.number] ?? "MERGEABLE",
          headRef: { compare: { aheadBy: 1, behindBy: 0 } },
        };
      });
      return Promise.resolve(JSON.stringify({ data: { repository } }));
    }

    // The abandoned PR's diff summary (Issue #2310).
    if (args[0] === "pr" && args[1] === "view" && args.includes("files")) {
      return Promise.resolve(JSON.stringify({
        files: state.prFiles?.[Number(args[2])] ?? [],
      }));
    }

    if (args[0] === "pr" && args[1] === "view" && args.includes("labels")) {
      const prNumber = Number(args[2]);
      if (state.failLabels?.includes(prNumber)) {
        return Promise.reject(new Error("label lookup exploded"));
      }
      return Promise.resolve((state.labels[prNumber] ?? []).join("\n"));
    }

    // Comment pages: `api repos/<repo>/issues/<n>/comments?...`
    if (args[0] === "api" && String(args[1]).includes("/comments")) {
      const match = /issues\/(\d+)\/comments/.exec(String(args[1]));
      const prNumber = Number(match?.[1] ?? 0);
      if (state.failComments?.includes(prNumber)) {
        return Promise.reject(new Error("comment lookup exploded"));
      }
      return Promise.resolve(JSON.stringify(
        (state.comments[prNumber] ?? []).map((c) => ({
          ...c,
          user: c.user ?? { login: FLEET },
        })),
      ));
    }

    // Label creation, the guarded label add, and escalation comments.
    if (args[0] === "api" && args.includes("POST")) {
      const endpoint = String(args[args.indexOf("-X") + 2] ?? "");
      const labelMatch = /issues\/(\d+)\/labels/.exec(endpoint);
      if (labelMatch) {
        const flag = args[args.indexOf("-f") + 1] ?? "";
        labelsAdded.push({
          prNumber: Number(labelMatch[1]),
          label: String(flag).replace("labels[]=", ""),
        });
      }
      const commentMatch = /issues\/(\d+)\/comments/.exec(endpoint);
      if (commentMatch) {
        const flag = String(args[args.indexOf("-f") + 1] ?? "");
        commentsPosted.push({
          prNumber: Number(commentMatch[1]),
          body: flag.startsWith("body=") ? flag.slice("body=".length) : flag,
        });
      }
      return Promise.resolve("");
    }

    if (args[0] === "label" && args[1] === "list") return Promise.resolve("[]");

    return Promise.resolve("");
  };

  return { ghCommandFn, labelsAdded, commentsPosted, issuesCreated, calls };
}

function makeOptions(
  fake: FakeGh,
  overrides?: Partial<FindConflictingPrOptions>,
): FindConflictingPrOptions {
  return {
    githubUser: "vibe-bot",
    repos: ["org/repo"],
    logger: makeSilentLogger(),
    isRepoAllowed: () => true,
    ghCommandFn: fake.ghCommandFn,
    ...overrides,
  };
}

function makeState(overrides?: Partial<FakeRepoState>): FakeRepoState {
  return {
    prs: [{ number: 48, headRefName: "issue-16-fix", baseRefName: "main" }],
    mergeable: { 48: "CONFLICTING" },
    labels: { 48: [] },
    comments: { 48: [] },
    ...overrides,
  };
}

/**
 * Marker pairs for `count` attempts that each opened and concluded as failed
 * — the shape that spends the budget (Issue #395), sized from the budget
 * itself so the fixtures track {@link DEFAULT_MAX_CONFLICT_ATTEMPTS}
 * (Issue #1766).
 */
function concludedFailures(
  count: number,
  createdAt: string,
): { body: string; created_at: string }[] {
  return Array.from({ length: count }, (_, i) => i + 1).flatMap((n) => [
    { body: `${CONFLICT_ATTEMPT_MARKER} n="${n}" -->`, created_at: createdAt },
    { body: `${CONFLICT_FAILED_MARKER} n="${n}" -->`, created_at: createdAt },
  ]);
}

// ---------------------------------------------------------------------------
// Attempt history
// ---------------------------------------------------------------------------

Deno.test("parseConflictAttempts - counts concluded attempts and tracks the latest", () => {
  // Issue #395 changed what "an attempt" means: only an attempt that reached
  // a conclusion spends the budget, so each opening marker is paired with a
  // failure conclusion here.
  const history = parseConflictAttempts([
    { body: "unrelated chatter", created_at: "2026-08-19T10:00:00Z" },
    {
      body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->\nattempt 1`,
      created_at: "2026-08-19T11:00:00Z",
    },
    {
      body: `${CONFLICT_FAILED_MARKER} n="1" -->\nfailed`,
      created_at: "2026-08-19T11:30:00Z",
    },
    {
      body: `${CONFLICT_ATTEMPT_MARKER} n="2" -->\nattempt 2`,
      created_at: "2026-08-19T15:00:00Z",
    },
    {
      body: `${CONFLICT_FAILED_MARKER} n="2" -->\nfailed`,
      created_at: "2026-08-19T15:30:00Z",
    },
  ]);

  assertEquals(history.count, 2);
  assertEquals(history.disruptedCount, 0);
  assertEquals(history.pendingAttempt, false);
  assertEquals(history.lastAttemptAt, "2026-08-19T15:00:00Z");
});

Deno.test("parseConflictAttempts - an attempt with no conclusion is disrupted, not spent", () => {
  // The GRQ#4408/#4409 shape: "attempt 1 of 2" and then silence.
  const history = parseConflictAttempts([
    {
      body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->\nattempt 1`,
      created_at: "2026-08-19T11:00:00Z",
    },
  ]);

  assertEquals(history.count, 0);
  assertEquals(history.pendingAttempt, true);
  assertEquals(countDisruptedAttempts(history), 1);
});

Deno.test("parseConflictAttempts - a new attempt marks an unconcluded one disrupted", () => {
  const history = parseConflictAttempts([
    {
      body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`,
      created_at: "2026-08-19T11:00:00Z",
    },
    {
      body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`,
      created_at: "2026-08-19T16:00:00Z",
    },
    {
      body: `${CONFLICT_FAILED_MARKER} n="1" -->\nfailed`,
      created_at: "2026-08-19T16:30:00Z",
    },
  ]);

  assertEquals(history.count, 1);
  assertEquals(history.disruptedCount, 1);
  assertEquals(history.pendingAttempt, false);
  assertEquals(countDisruptedAttempts(history), 1);
});

Deno.test("parseConflictAttempts - a resolved marker resets both budgets", () => {
  // Issue #395: the trailing attempt is open, not spent — count is 0 until it
  // concludes, and the pre-merge history is discarded entirely.
  const history = parseConflictAttempts([
    {
      body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`,
      created_at: "2026-06-01T09:00:00Z",
    },
    {
      body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`,
      created_at: "2026-06-01T10:00:00Z",
    },
    {
      body: `${CONFLICT_RESOLVED_MARKER}\nmerged`,
      created_at: "2026-06-01T11:00:00Z",
    },
    {
      body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`,
      created_at: "2026-08-19T11:00:00Z",
    },
  ]);

  assertEquals(history.count, 0);
  assertEquals(history.disruptedCount, 0);
  assertEquals(history.pendingAttempt, true);
  assertEquals(history.lastAttemptAt, "2026-08-19T11:00:00Z");
});

Deno.test("parseConflictAttempts - ignores malformed comment entries", () => {
  const history = parseConflictAttempts([null, 42, { body: 7 }, "text"]);
  assertEquals(history.count, 0);
  assertEquals(history.disruptedCount, 0);
  assertEquals(history.pendingAttempt, false);
  assertEquals(history.lastAttemptAt, undefined);
});

Deno.test("isConflictAttemptDue - no history is always due", () => {
  assertEquals(
    isConflictAttemptDue({
      count: 0,
      disruptedCount: 0,
      pendingAttempt: false,
    }),
    true,
  );
});

Deno.test("isConflictAttemptDue - a concluded attempt is due again at once (Issue #2305)", () => {
  // The cooldown is gone: a failure concluded one second ago is due on the
  // very next pass, which is what this asserts against the old four-hour wait.
  const justNow = new Date().toISOString();
  assertEquals(
    isConflictAttemptDue({
      count: 1,
      disruptedCount: 0,
      pendingAttempt: false,
      lastAttemptAt: justNow,
    }),
    true,
  );
});

Deno.test("isConflictAttemptDue - an attempt still open is not due (Issue #2305)", () => {
  assertEquals(
    isConflictAttemptDue({
      count: 0,
      disruptedCount: 0,
      pendingAttempt: true,
      lastAttemptAt: new Date().toISOString(),
    }),
    false,
  );
});

Deno.test("DEFAULT_MAX_CONFLICT_ATTEMPTS - two runs per conflict (Issue #2305)", () => {
  assertEquals(DEFAULT_MAX_CONFLICT_ATTEMPTS, 2);
});

Deno.test("hasExhaustedConflictAttempts - binds at the configured budget", () => {
  assertEquals(hasExhaustedConflictAttempts(1, 2), false);
  assertEquals(hasExhaustedConflictAttempts(2, 2), true);
  assertEquals(hasExhaustedConflictAttempts(3, 2), true);
});

Deno.test("hasExhaustedDisruptedAttempts - binds disrupted retries separately", () => {
  assertEquals(hasExhaustedDisruptedAttempts(2, 3), false);
  assertEquals(hasExhaustedDisruptedAttempts(3, 3), true);
  assertEquals(hasExhaustedDisruptedAttempts(4, 3), true);
});

Deno.test("countDisruptedAttempts - an open attempt counts as disrupted", () => {
  assertEquals(
    countDisruptedAttempts({
      count: 1,
      disruptedCount: 1,
      pendingAttempt: true,
    }),
    2,
  );
  assertEquals(
    countDisruptedAttempts({
      count: 1,
      disruptedCount: 1,
      pendingAttempt: false,
    }),
    1,
  );
});

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

Deno.test("findConflictingPr - returns the conflicting PR and labels it", async () => {
  const state = makeState();
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value.selected?.prNumber, 48);
  assertEquals(result.value.selected?.branchName, "issue-16-fix");
  assertEquals(result.value.selected?.baseBranch, "main");
  assertEquals(result.value.selected?.attemptCount, 0);
  assertEquals(fake.labelsAdded, [{
    prNumber: 48,
    label: MERGE_CONFLICT_LABEL,
  }]);
});

Deno.test("findConflictingPr - a mergeable PR is neither returned nor labelled", async () => {
  const state = makeState({ mergeable: { 48: "MERGEABLE" } });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value.selected, null);
  assertEquals(fake.labelsAdded.length, 0);
});

Deno.test("findConflictingPr - does not re-add a label the PR already carries", async () => {
  const state = makeState({ labels: { 48: [MERGE_CONFLICT_LABEL] } });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value.selected?.prNumber, 48);
  assertEquals(fake.labelsAdded.length, 0);
});

Deno.test("findConflictingPr - skips a PR a human already owns, but still labels it", async () => {
  const state = makeState({ labels: { 48: ["needs-human"] } });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value.selected, null);
  assertEquals(fake.labelsAdded, [{
    prNumber: 48,
    label: MERGE_CONFLICT_LABEL,
  }]);
});

Deno.test("findConflictingPr - a minute-old failure is due on the very next pass (Issue #2305)", async () => {
  // The cooldown is gone: one concluded failure a minute ago left one attempt
  // in the budget, and the PR is handed straight back rather than held for
  // four hours.
  const now = Date.parse("2026-08-20T12:00:00Z");
  const recent = new Date(now - 60_000).toISOString();
  const state = makeState({
    comments: {
      48: [
        { body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`, created_at: recent },
        { body: `${CONFLICT_FAILED_MARKER} n="1" -->`, created_at: recent },
      ],
    },
  });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value.selected?.prNumber, 48);
  assertEquals(result.value.selected?.attemptCount, 1);
});

Deno.test("findConflictingPr - returns a PR with budget left, carrying its attempt count", async () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  // Issue #395: the attempt only counts once it concluded, so the fixture
  // carries the failure conclusion the processor now posts.
  const elapsed = new Date(now - 5 * 3600_000).toISOString();
  const state = makeState({
    comments: {
      48: [
        { body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`, created_at: elapsed },
        { body: `${CONFLICT_FAILED_MARKER} n="1" -->`, created_at: elapsed },
      ],
    },
  });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value.selected?.attemptCount, 1);
  assertEquals(result.value.selected?.disruptedCount, 0);
});

Deno.test("findConflictingPr - refuses a PR that has spent its attempt budget", async () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  const old = new Date(now - 48 * 3600_000).toISOString();
  const state = makeState({
    // Issue #395: a spent budget is only a quiet skip once the PR is visibly
    // a human's — the escalation the last attempt posted is in the thread.
    labels: { 48: ["needs-human"] },
    comments: {
      48: concludedFailures(DEFAULT_MAX_CONFLICT_ATTEMPTS, old),
    },
  });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value.selected, null);
  assertEquals(fake.commentsPosted.length, 0);
});

Deno.test("findConflictingPr - one concluded failure still buys the second attempt (Issue #2305)", async () => {
  // The budget is two, so a PR one judged failure in is handed back for the
  // retry — and only that one.
  const now = Date.parse("2026-08-20T12:00:00Z");
  const old = new Date(now - 48 * 3600_000).toISOString();
  const state = makeState({
    comments: {
      48: concludedFailures(DEFAULT_MAX_CONFLICT_ATTEMPTS - 1, old),
    },
  });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value.selected?.prNumber, 48);
  assertEquals(
    result.value.selected?.attemptCount,
    DEFAULT_MAX_CONFLICT_ATTEMPTS - 1,
  );
  assertEquals(
    fake.labelsAdded.some((l) =>
      l.prNumber === 48 && l.label === "needs-human"
    ),
    false,
    "a PR with budget left is never handed to a human",
  );
});

Deno.test("findConflictingPr - a spent budget falls back rather than stalling (Issue #2310)", async () => {
  // Issue #395: the last attempt concludes from the processor, so a failure
  // there (or a run cut short between the conclusion and the escalation)
  // left the PR conflicting, out of budget, and owned by nobody — skipped
  // silently on every scan for ever. The scan is still that backstop; what it
  // does now is the fallback, not a hand-off to a person.
  const now = Date.parse("2026-08-20T12:00:00Z");
  const old = new Date(now - 48 * 3600_000).toISOString();
  const state = makeState({
    comments: {
      48: concludedFailures(DEFAULT_MAX_CONFLICT_ATTEMPTS, old),
    },
  });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value.selected, null);
  assertNoNeedsHumanWrites(fake);
  assertEquals(
    fake.calls.filter((c) => c[0] === "pr" && c[1] === "close").length,
    1,
    "the PR is closed by the fallback",
  );
  assertEquals(fake.issuesCreated.length, 1, "and the fallback is flagged");
});

Deno.test("findConflictingPr - a disrupted attempt is re-attempted, not counted as spent", async () => {
  // The GRQ#4408/#4409 regression: two attempts posted their marker and went
  // silent. Under the old rule the PR was out of budget and stalled with no
  // conclusion on it; it must now be handed back for another attempt.
  const now = Date.parse("2026-08-20T12:00:00Z");
  const old = new Date(now - 48 * 3600_000).toISOString();
  const state = makeState({
    comments: {
      48: [
        { body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`, created_at: old },
        { body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`, created_at: old },
      ],
    },
  });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value.selected?.prNumber, 48);
  assertEquals(result.value.selected?.attemptCount, 0);
  assertEquals(result.value.selected?.disruptedCount, 2);
  assertEquals(
    fake.labelsAdded.some((l) => l.label === "needs-human"),
    false,
  );
});

Deno.test("findConflictingPr - repeated disruption escalates loudly instead of stalling", async () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  const old = new Date(now - 48 * 3600_000).toISOString();
  const state = makeState({
    comments: {
      48: [
        { body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`, created_at: old },
        { body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`, created_at: old },
        { body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`, created_at: old },
      ],
    },
  });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value.selected, null);
  assertEquals(
    fake.labelsAdded.some((l) =>
      l.prNumber === 48 && l.label === "needs-human"
    ),
    true,
  );

  const escalation = fake.commentsPosted.at(-1)?.body ?? "";
  assertStringIncludes(escalation, "disrupted");
  assertStringIncludes(escalation, "**Next step:**");
});

Deno.test("findConflictingPr - the disruption bound is configurable", async () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  const old = new Date(now - 48 * 3600_000).toISOString();
  const state = makeState({
    comments: {
      48: [{ body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`, created_at: old }],
    },
  });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(
    makeOptions(fake, { maxDisruptedAttempts: 1 }),
  );

  assert(result.ok);
  assertEquals(result.value.selected, null);
  assertEquals(
    fake.labelsAdded.some((l) => l.label === "needs-human"),
    true,
  );
});

Deno.test("findConflictingPr - a disallowed repo is never listed", async () => {
  const state = makeState();
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(
    makeOptions(fake, { isRepoAllowed: () => false }),
  );

  assert(result.ok);
  assertEquals(result.value.selected, null);
  assertEquals(fake.calls.length, 0);
});

Deno.test("findConflictingPr - a repo whose listing fails does not stall the scan", async () => {
  const state = makeState();
  const fake = makeFakeGh(state);
  const failingFirst = (args: string[]) => {
    if (args[0] === "pr" && args[1] === "list" && args[3] === "org/broken") {
      return Promise.reject(new Error("gh exploded"));
    }
    return fake.ghCommandFn(args);
  };

  const result = await findConflictingPr(
    makeOptions(fake, {
      repos: ["org/broken", "org/repo"],
      ghCommandFn: failingFirst,
    }),
  );

  assert(result.ok);
  assertEquals(result.value.selected?.prNumber, 48);
});

// ---------------------------------------------------------------------------
// The drain's exclusion set (Issue #561). The pass now calls this scan
// repeatedly within one cycle; without an exclusion the second call returns
// the PR the first one just took.
// ---------------------------------------------------------------------------

Deno.test("findConflictingPr - an excluded PR is passed over for the next due one", async () => {
  const fake = makeFakeGh(makeState({
    prs: [
      { number: 10, headRefName: "issue-10", baseRefName: "main" },
      { number: 11, headRefName: "issue-11", baseRefName: "main" },
    ],
    mergeable: { 10: "CONFLICTING", 11: "CONFLICTING" },
    labels: { 10: [], 11: [] },
    comments: { 10: [], 11: [] },
  }));

  const first = await findConflictingPr(makeOptions(fake));
  assert(first.ok);
  assertEquals(first.value.selected?.prNumber, 10);

  const second = await findConflictingPr(
    makeOptions(fake, { exclude: new Set(["org/repo#10"]) }),
  );
  assert(second.ok);
  assertEquals(second.value.selected?.prNumber, 11);

  const third = await findConflictingPr(
    makeOptions(fake, { exclude: new Set(["org/repo#10", "org/repo#11"]) }),
  );
  assert(third.ok);
  assertEquals(third.value.selected, null);
});

Deno.test("conflictPrKey - the exclusion key names repo and number", () => {
  assertEquals(conflictPrKey("org/repo", 42), "org/repo#42");
});

// ---------------------------------------------------------------------------
// Decision records (Issue #1109)
//
// The #1076 symptom was "the label went on and then silence": a skipped PR
// produced nothing, or an unstructured line, so a stalled fleet and a fleet
// correctly waiting out a cooldown read the same. Every exit below must now
// yield exactly one reason from the closed taxonomy, with its operands.
// ---------------------------------------------------------------------------

/** The reason recorded against a PR, or undefined when none was. */
function reasonFor(
  log: RecordingLogger,
  prNumber: number,
): string | undefined {
  const entry = log.entries.find((e) =>
    e.context?.prNumber === prNumber && e.message.startsWith(DECISION_PREFIX)
  );
  return entry?.context?.reason as string | undefined;
}

/** The whole record for one PR. */
function recordFor(log: RecordingLogger, prNumber: number): LogEntry {
  const entry = log.entries.find((e) =>
    e.context?.prNumber === prNumber && e.message.startsWith(DECISION_PREFIX)
  );
  assert(entry, `no decision record for PR #${prNumber}`);
  return entry;
}

/** The pass-level summary the scan closes with. */
function summaryOf(log: RecordingLogger): LogEntry {
  const entry = log.entries.find((e) => e.message.startsWith(SUMMARY_PREFIX));
  assert(entry, "the pass emitted no summary record");
  return entry;
}

/** Run the scan with a recording logger. */
async function scanWith(
  fake: FakeGh,
  overrides?: Partial<FindConflictingPrOptions>,
) {
  const log = makeRecordingLogger();
  const result = await findConflictingPr(
    makeOptions(fake, { logger: log, ...overrides }),
  );
  assert(result.ok);
  return { result, log };
}

Deno.test("findConflictingPr - the selected PR is recorded as attempted", async () => {
  const fake = makeFakeGh(makeState());

  const { result, log } = await scanWith(fake);

  assertEquals(result.value.selected?.prNumber, 48);
  assertEquals(result.value.decisions, [
    { repo: "org/repo", prNumber: 48, outcome: "attempted" },
  ]);
  assertEquals(reasonFor(log, 48), "attempted");
});

Deno.test("findConflictingPr - a mergeable PR records not-conflicting with its state", async () => {
  const fake = makeFakeGh(makeState({ mergeable: { 48: "MERGEABLE" } }));

  const { result, log } = await scanWith(fake);

  assertEquals(result.value.decisions, [{
    repo: "org/repo",
    prNumber: 48,
    outcome: "skipped",
    reason: { kind: "not-conflicting", mergeableState: "MERGEABLE" },
  }]);
  assertEquals(recordFor(log, 48).context?.mergeableState, "MERGEABLE");
});

Deno.test("findConflictingPr - an unreadable mergeable state is an error, not a clean bill of health", async () => {
  // Reporting a failed state lookup as "not conflicting" would hide a whole
  // repository's backlog behind a DEBUG line — the silence this instrument
  // exists to remove.
  const fake = makeFakeGh(makeState({ omitState: [48] }));

  const { result, log } = await scanWith(fake);

  assertEquals(result.value.selected, null);
  assertEquals(reasonFor(log, 48), "scan-error");
  assertEquals(recordFor(log, 48).context?.stage, "mergeable-state");
  assertEquals(recordFor(log, 48).level, "info");
});

Deno.test("findConflictingPr - a PR outside the maintenance set records its author", async () => {
  const fake = makeFakeGh(makeState({
    prs: [{
      number: 48,
      headRefName: "issue-16-fix",
      baseRefName: "main",
      author: { login: "outside-contributor" },
    }],
  }));

  const { result, log } = await scanWith(fake);

  assertEquals(result.value.selected, null);
  assertEquals(reasonFor(log, 48), "out-of-scope-author");
  assertEquals(recordFor(log, 48).context?.author, "outside-contributor");
  // The pass pushes to the head branch, so it must not touch an uninvited
  // author's PR — and must not label it either.
  assertEquals(fake.labelsAdded.length, 0);
});

Deno.test("findConflictingPr - a fleet author is matched however the listing cases it", async () => {
  const fake = makeFakeGh(makeState({
    prs: [{
      number: 48,
      headRefName: "issue-16-fix",
      baseRefName: "main",
      author: { login: "VIBE-BOT" },
    }],
  }));

  const { result } = await scanWith(fake);

  assertEquals(
    result.value.selected?.prNumber,
    48,
    "GitHub logins are case-insensitive — casing must not push a fleet PR " +
      "out of scope",
  );
});

Deno.test("findConflictingPr - a PR this cycle already took records already-handled", async () => {
  const fake = makeFakeGh(makeState());

  const { log } = await scanWith(fake, {
    exclude: new Set([conflictPrKey("org/repo", 48)]),
  });

  assertEquals(reasonFor(log, 48), "already-handled");
});

Deno.test("findConflictingPr - a failed label lookup records the stage that failed", async () => {
  const fake = makeFakeGh(makeState({ failLabels: [48] }));

  const { log } = await scanWith(fake);

  assertEquals(reasonFor(log, 48), "scan-error");
  assertEquals(recordFor(log, 48).context?.stage, "labels");
});

Deno.test("findConflictingPr - a failed history lookup records the stage that failed", async () => {
  const fake = makeFakeGh(makeState({ failComments: [48] }));

  const { log } = await scanWith(fake);

  assertEquals(reasonFor(log, 48), "scan-error");
  assertEquals(recordFor(log, 48).context?.stage, "attempt-history");
});

Deno.test("findConflictingPr - a PR a human owns records needs-human", async () => {
  const fake = makeFakeGh(makeState({ labels: { 48: ["needs-human"] } }));

  const { log } = await scanWith(fake);

  assertEquals(reasonFor(log, 48), "needs-human");
  assertEquals(recordFor(log, 48).context?.label, "needs-human");
});

Deno.test("findConflictingPr - an attempt open a minute ago is re-attempted, not paced (Issue #2305)", async () => {
  // The old rule recorded `cooldown` here and waited four hours. The marker is
  // read as one disrupted attempt instead, and the PR is attempted at once.
  const now = Date.parse("2026-08-20T12:00:00Z");
  const fake = makeFakeGh(makeState({
    comments: {
      48: [{
        body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`,
        created_at: new Date(now - 60_000).toISOString(),
      }],
    },
  }));

  const { result, log } = await scanWith(fake);

  assertEquals(result.value.selected?.prNumber, 48);
  assertEquals(result.value.selected?.disruptedCount, 1);
  assertEquals(reasonFor(log, 48), "attempted");
});

Deno.test("findConflictingPr - the budget-spent record carries the attempts and the cap", async () => {
  // `budget-spent` is what remains when the fallback itself will not run — the
  // one-restart-per-issue bound, here (Issue #2310).
  const fake = makeFakeGh(makeState({
    comments: {
      48: concludedFailures(
        DEFAULT_MAX_CONFLICT_ATTEMPTS,
        "2026-08-19T11:00:00Z",
      ),
    },
  }));

  const { log } = await scanWith(fake, {
    abandonRestart: () =>
      Promise.resolve({
        outcome: "declined",
        reason: { kind: "already-restarted", issueNumber: 16, samePr: false },
      }),
  });

  assertEquals(reasonFor(log, 48), "budget-spent");
  assertEquals(
    recordFor(log, 48).context?.attemptsSpent,
    DEFAULT_MAX_CONFLICT_ATTEMPTS,
  );
  assertEquals(
    recordFor(log, 48).context?.maxAttempts,
    DEFAULT_MAX_CONFLICT_ATTEMPTS,
  );
});

Deno.test("findConflictingPr - the disrupted-bound record carries the disruption count", async () => {
  const fake = makeFakeGh(makeState({
    comments: {
      48: [1, 2, 3].map((n) => ({
        body: `${CONFLICT_ATTEMPT_MARKER} n="${n}" -->`,
        created_at: `2026-08-1${n}T11:00:00Z`,
      })),
    },
  }));

  const { log } = await scanWith(fake);

  assertEquals(reasonFor(log, 48), "disrupted-bound");
  assertEquals(recordFor(log, 48).context?.disruptedCount, 3);
  assertEquals(
    recordFor(log, 48).context?.maxDisruptedAttempts,
    DEFAULT_MAX_DISRUPTED_ATTEMPTS,
  );
});

Deno.test("findConflictingPr - every labelled PR gets a record, plus one summary", async () => {
  // Three conflicting PRs, each skipped for a different reason, so the pass
  // walks the whole labelled set rather than stopping at a selection.
  const fake = makeFakeGh(makeState({
    prs: [10, 11, 12].map((number) => ({
      number,
      headRefName: `issue-${number}`,
      baseRefName: "main",
    })),
    mergeable: { 10: "CONFLICTING", 11: "CONFLICTING", 12: "CONFLICTING" },
    labels: { 10: ["needs-human"], 11: [], 12: ["needs-human"] },
    comments: {
      10: [],
      // Issue #2305: a spent budget, not a cooldown — the wait is gone, so
      // the only thing that holds a PR with an unconcluded marker back is
      // the budget itself.
      11: concludedFailures(
        DEFAULT_MAX_CONFLICT_ATTEMPTS,
        "2026-08-20T11:00:00Z",
      ),
      12: [],
    },
  }));

  const { result, log } = await scanWith(fake, {
    // The bound declines the fallback for #11, so its record stays
    // `budget-spent` (Issue #2310).
    abandonRestart: () =>
      Promise.resolve({
        outcome: "declined",
        reason: { kind: "already-restarted", issueNumber: 16, samePr: false },
      }),
  });

  assertEquals(result.value.selected, null);
  assertEquals(result.value.decisions.length, 3);
  assertEquals(reasonFor(log, 10), "needs-human");
  assertEquals(reasonFor(log, 11), "budget-spent");
  assertEquals(reasonFor(log, 12), "needs-human");

  const summary = summaryOf(log);
  assertEquals(summary.context?.labelled, 3);
  assertEquals(summary.context?.attempted, 0);
  assertEquals(summary.context?.byReason, {
    "needs-human": 2,
    "budget-spent": 1,
  });
  assertEquals(summary.context?.reposScanned, 1);
});

Deno.test("findConflictingPr - the summary counts the repos the pass never got into", async () => {
  // The allowlist exit knows no PR to key a decision on, so it is counted
  // rather than dropped (Issue #1109).
  const fake = makeFakeGh(makeState());

  const { log } = await scanWith(fake, {
    repos: ["org/denied", "org/repo"],
    isRepoAllowed: (repo: string) => repo !== "org/denied",
  });

  const summary = summaryOf(log);
  assertEquals(summary.context?.reposNotAllowed, 1);
  assertEquals(summary.context?.reposScanned, 1);
  assertEquals(summary.context?.reposListFailed, 0);
});

Deno.test("findConflictingPr - the records cost no extra gh calls", async () => {
  // Issue #1109 runs every ~2.5-minute cycle across every monitored repo: a
  // record built by re-fetching would be correct and still burn the fleet's
  // rate limit. One listing, one batched state query, one label read and one
  // comment page — exactly what the pass fetched before the records existed.
  // Already labelled, so the pass makes no label writes and every call left
  // is a read the decision needs.
  const fake = makeFakeGh(
    makeState({ labels: { 48: [MERGE_CONFLICT_LABEL] } }),
  );

  const { log } = await scanWith(fake);

  assertEquals(reasonFor(log, 48), "attempted");
  assertEquals(fake.calls.map((call) => `${call[0]} ${call[1]}`), [
    // The PR listing, the batched mergeable state, the labels, the comment
    // timeline the attempt history is read from. Nothing is fetched twice.
    "pr list",
    "api graphql",
    "pr view",
    "api repos/org/repo/issues/48/comments?per_page=100&page=1",
  ]);
});

// ---------------------------------------------------------------------------
// The deferral cursor (Issue #1111)
//
// The drain hands back the PRs its lease, deadline or cap dropped. The scan
// must offer them first, without loosening a single gate.
// ---------------------------------------------------------------------------

Deno.test("findConflictingPr - a deferred PR is offered before the rest of its repo", async () => {
  const state = makeState({
    prs: [
      { number: 48, headRefName: "issue-16-fix", baseRefName: "main" },
      { number: 61, headRefName: "issue-30-fix", baseRefName: "main" },
    ],
    mergeable: { 48: "CONFLICTING", 61: "CONFLICTING" },
    labels: { 48: [], 61: [] },
    comments: { 48: [], 61: [] },
  });

  // Without a cursor the listing order stands.
  const plain = await scanWith(makeFakeGh(state));
  assertEquals(plain.result.value.selected?.prNumber, 48);

  // With one, the PR a previous pass deferred leads.
  const preferred = await scanWith(makeFakeGh(state), {
    prefer: ["org/repo#61"],
  });
  assertEquals(preferred.result.value.selected?.prNumber, 61);
});

Deno.test("findConflictingPr - the cursor reorders, it never re-opens a closed gate", async () => {
  // The deferred PR is out of attempts, so being offered first must change
  // nothing about whether it is due: it is still skipped, and the healthy PR
  // behind it is still selected.
  const state = makeState({
    prs: [
      { number: 48, headRefName: "issue-16-fix", baseRefName: "main" },
      { number: 61, headRefName: "issue-30-fix", baseRefName: "main" },
    ],
    mergeable: { 48: "CONFLICTING", 61: "CONFLICTING" },
    labels: { 48: [], 61: ["needs-human"] },
    comments: { 48: [], 61: [] },
  });

  const { result, log } = await scanWith(makeFakeGh(state), {
    prefer: ["org/repo#61"],
  });

  assertEquals(result.value.selected?.prNumber, 48);
  assertEquals(reasonFor(log, 61), "needs-human");
});

Deno.test("findConflictingPr - the cursor moves the repository too", async () => {
  // A PR cannot lead the pass if its repository is scanned last.
  const fake = makeFakeGh(makeState());
  const { result } = await scanWith(fake, {
    repos: ["org/first", "org/repo"],
    prefer: ["org/repo#48"],
  });

  assertEquals(result.value.selected?.repo, "org/repo");
  const listed = fake.calls
    .filter((call) => call[0] === "pr" && call[1] === "list")
    .map((call) => call[call.indexOf("--repo") + 1]);
  assertEquals(listed[0], "org/repo");
});

// ---------------------------------------------------------------------------
// Abandon-and-restart — the last automatic rung (Issue #1115)
// ---------------------------------------------------------------------------

/** A PR whose every concluded attempt has failed — the budget is spent. */
function exhaustedComments() {
  const old = new Date(
    Date.parse("2026-08-20T12:00:00Z") - 48 * 3600_000,
  ).toISOString();
  return Array.from(
    { length: DEFAULT_MAX_CONFLICT_ATTEMPTS },
    (_, i) => i + 1,
  ).flatMap((n) => [
    { body: `${CONFLICT_ATTEMPT_MARKER} n="${n}" -->`, created_at: old },
    {
      body: [
        `${CONFLICT_FAILED_MARKER} n="${n}" -->`,
        `attempt ${n} tripped on the same constant`,
        "",
        "Conflicted files:",
        "- `worker/deno/lib/limits.ts`",
      ].join("\n"),
      created_at: old,
    },
  ]);
}

/** The exhausted PR, with an originating issue the rung can re-queue. */
function exhaustedState(overrides?: Partial<FakeRepoState>): FakeRepoState {
  return makeState({
    comments: { 48: exhaustedComments() },
    issues: {
      16: {
        title: "Raise the per-path commit cap",
        state: "OPEN",
        labels: ["work-on"],
      },
    },
    prsByState: {
      open: [{ number: 48, title: "Raise the cap (#16)" }],
      merged: [],
      closed: [],
    },
    ...overrides,
  });
}

/** True when the scan handed this PR to a human. */
function escalatedToHuman(fake: FakeGh, prNumber: number): boolean {
  return fake.labelsAdded.some((l) =>
    l.prNumber === prNumber && l.label === "needs-human"
  );
}

/**
 * No `gh` call this pass made names `needs-human` at all (Issue #2310).
 *
 * Every stubbed call is captured argument by argument — label adds, comment
 * bodies, label creation — so an escalation reaching *any* of them fails here
 * rather than in production. This is the assertion that fails against the old
 * route, where a spent budget ended at a `needs-human` label and comment.
 */
function assertNoNeedsHumanWrites(fake: FakeGh): void {
  const offending = fake.calls.find((args) =>
    args.some((arg) => arg.includes("needs-human"))
  );
  assertEquals(
    offending,
    undefined,
    `no conflict outcome may name needs-human: ${JSON.stringify(offending)}`,
  );
}

Deno.test("findConflictingPr - an exhausted PR with a known issue is abandoned, not escalated", async () => {
  const fake = makeFakeGh(exhaustedState());

  const { result, log } = await scanWith(fake);

  // Not selected for another attempt, and not handed to a human.
  assertEquals(result.value.selected, null);
  assertEquals(escalatedToHuman(fake, 48), false);

  assertEquals(reasonFor(log, 48), "abandoned-restarted");
  assertEquals(recordFor(log, 48).context?.issueNumber, 16);
  assertEquals(
    recordFor(log, 48).context?.attemptsSpent,
    DEFAULT_MAX_CONFLICT_ATTEMPTS,
  );

  // Closed, not merged, and the branch is left where it is.
  const closes = fake.calls.filter((c) => c[0] === "pr" && c[1] === "close");
  assertEquals(closes.length, 1);
  assert(!(closes[0] ?? []).includes("--delete-branch"));
  assertEquals(
    fake.calls.filter((c) => c[0] === "pr" && c[1] === "merge").length,
    0,
  );

  // The issue carries the restart marker, so a second host declines.
  const claim = fake.commentsPosted.find((c) => c.prNumber === 16);
  assert(claim, "the originating issue was never commented on");
  assertStringIncludes(claim.body, CONFLICT_RESTART_MARKER);
});

Deno.test("findConflictingPr - an abandoned PR leaves one merge-fallback flag behind (Issue #2310)", async () => {
  // The fallback undoes work. Until #2304 it undid it silently, so the next
  // attempt started from the same blank page and could walk into the same
  // conflict again. This is the PR path's wiring to that record.
  const fake = makeFakeGh(exhaustedState());

  const { log } = await scanWith(fake);

  assertEquals(reasonFor(log, 48), "abandoned-restarted");
  assertEquals(recordFor(log, 48).context?.flagIssueNumber, 900);

  assertEquals(fake.issuesCreated.length, 1, "one flag per fallback");
  const flag = fake.issuesCreated[0];
  // Not the re-do item here: the originating issue was re-queued, so the flag
  // is a record and carries no pickup label.
  assertEquals(flag?.labels, ["merge-fallback"]);
  assertStringIncludes(flag?.title ?? "", "org/repo PR #48");
  assertStringIncludes(flag?.body ?? "", "tripped on the same constant");
  assertStringIncludes(flag?.body ?? "", "worker/deno/lib/limits.ts");
  assertStringIncludes(flag?.body ?? "", "41");
  assertStringIncludes(flag?.body ?? "", "2026-08-18T09:30:00.000Z");
  assertStringIncludes(flag?.body ?? "", "re-queued issue #16");

  // The close comment carries the link, so the closed PR stays traceable.
  const link = fake.commentsPosted.find((c) =>
    c.prNumber === 48 && c.body.includes("#900")
  );
  assert(link, "the closed PR does not link its flag issue");
  assertNoNeedsHumanWrites(fake);
});

Deno.test("findConflictingPr - a flag that cannot be filed warns and leaves the abandon standing (Issue #2310)", async () => {
  // The PR is already closed and the issue already re-queued by the time the
  // flag is filed, so a filing failure must not undo either — it is said out
  // loud and the fallback stands.
  const fake = makeFakeGh(exhaustedState());

  const { log } = await scanWith(fake, {
    fileFallbackFlag: () =>
      Promise.resolve({ ok: false, error: new Error("gh: 503") }),
  });

  assertEquals(reasonFor(log, 48), "abandoned-restarted");
  assertEquals(recordFor(log, 48).context?.issueNumber, 16);
  assertEquals(recordFor(log, 48).context?.flagIssueNumber, undefined);
  assertEquals(
    fake.calls.filter((c) => c[0] === "pr" && c[1] === "close").length,
    1,
    "the close must stand",
  );
  const warned = log.entries.find((entry) =>
    entry.level === "warn" && entry.message.includes("could not be filed")
  );
  assert(warned, "a flag that could not be filed was not warned about");
  assertNoNeedsHumanWrites(fake);
});

Deno.test("findConflictingPr - the flag filer is handed both runs' analyses, timings and hosts (Issue #2310)", async () => {
  const filings: MergeFallbackFiling[] = [];
  const timed = exhaustedComments().map((comment) =>
    comment.body.includes(CONFLICT_FAILED_MARKER)
      ? {
        ...comment,
        body: `${comment.body}\n\nTimings (host \`mel-01\`): agent 212s`,
      }
      : comment
  );
  const fake = makeFakeGh(exhaustedState({ comments: { 48: timed } }));

  await scanWith(fake, {
    fileFallbackFlag: (filing) => {
      filings.push(filing);
      return Promise.resolve({
        ok: true,
        value: { issueNumber: 900, url: "", appended: false },
      });
    },
  });

  assertEquals(filings.length, 1);
  const filing = filings[0];
  assertEquals(filing?.requestIdleTask, undefined);
  assertEquals(filing?.runs?.length, DEFAULT_MAX_CONFLICT_ATTEMPTS);
  assertEquals(filing?.runs?.[0]?.host, "mel-01");
  assertEquals(filing?.runs?.[0]?.timings, [{ stage: "agent", seconds: 212 }]);
  assertEquals(filing?.behindBy, 41);
  assertEquals(filing?.conflictedFiles, ["worker/deno/lib/limits.ts"]);
  // The PR path's own flag is a record, not the re-do item, so no diff summary
  // is read for it — that read is the no-originating-issue route's.
  assertEquals(filing?.diffSummary, undefined);
});

Deno.test("findConflictingPr - an exhausted PR with no originating issue is closed and flagged (Issue #2310)", async () => {
  // This used to fall through to a human, and nobody came: the PR sat
  // conflicting, out of budget and unowned. It is closed now, and the
  // `merge-fallback` flag — `idle-task`, with the PR's diff summary — is the
  // re-do item the fleet picks up instead.
  const fake = makeFakeGh(exhaustedState({
    prs: [{ number: 48, headRefName: "hotfix/no-issue", baseRefName: "main" }],
    issues: {},
    prFiles: {
      48: [{ path: "worker/deno/lib/limits.ts", additions: 9, deletions: 2 }],
    },
  }));

  const { result, log } = await scanWith(fake);

  assertEquals(result.value.selected, null);
  assertEquals(reasonFor(log, 48), "abandoned-restarted");
  assertEquals(recordFor(log, 48).context?.issueNumber, 900);
  assertEquals(escalatedToHuman(fake, 48), false);
  assertEquals(
    fake.calls.filter((c) => c[0] === "pr" && c[1] === "close").length,
    1,
  );

  // Exactly one flag, carrying `idle-task` and the diff summary.
  assertEquals(fake.issuesCreated.length, 1);
  const flag = fake.issuesCreated[0];
  assertEquals(flag?.labels, ["merge-fallback", "idle-task"]);
  assertStringIncludes(flag?.title ?? "", "PR #48");
  assertStringIncludes(flag?.body ?? "", "What the PR changed");
  assertStringIncludes(flag?.body ?? "", "worker/deno/lib/limits.ts");
  assertStringIncludes(flag?.body ?? "", "(+9/-2)");
  assertStringIncludes(flag?.body ?? "", "41");

  // The close comment points at it.
  const closeComment = fake.commentsPosted.find((c) =>
    c.prNumber === 48 && c.body.includes("#900")
  );
  assert(closeComment, "the close comment does not name the flag issue");
  assertNoNeedsHumanWrites(fake);
});

Deno.test("findConflictingPr - a restarted issue exhausting again asks no human (Issue #2310)", async () => {
  // The bound: one abandon per originating issue. The marker is on the issue
  // because the PR that replaced the abandoned one is a different PR.
  const state = exhaustedState({
    prs: [{ number: 61, headRefName: "issue-16-fix-2", baseRefName: "main" }],
    mergeable: { 61: "CONFLICTING" },
    labels: { 61: [] },
    comments: {
      61: exhaustedComments(),
      16: [{
        body: conflictRestartMarker("org/repo", 48),
        created_at: "2026-08-19T09:00:00Z",
      }],
    },
    prsByState: {
      open: [{ number: 61, title: "Raise the cap (#16)" }],
      merged: [],
      closed: [],
    },
  });
  const fake = makeFakeGh(state);

  const { log } = await scanWith(fake);

  assertEquals(reasonFor(log, 61), "budget-spent");
  // The bound still holds — one restart per originating issue — but it no
  // longer ends at a person (Issue #2310): the replacement PR is left open,
  // and what happens to it next is the following rung's business.
  assertEquals(escalatedToHuman(fake, 61), false);
  assertEquals(
    fake.calls.filter((c) => c[0] === "pr" && c[1] === "close").length,
    0,
  );
  assertNoNeedsHumanWrites(fake);
});

Deno.test("findConflictingPr - a failed abandon step is recorded, not escalated (Issue #2310)", async () => {
  // A partial abandon must never be silent — but it is no longer a person's
  // problem either. The step lands in the structured record, not in a
  // `needs-human` comment.
  const fake = makeFakeGh(exhaustedState({ failOn: "pr close" }));

  const { log } = await scanWith(fake);

  assertEquals(reasonFor(log, 48), "budget-spent");
  assertEquals(escalatedToHuman(fake, 48), false);
  assertNoNeedsHumanWrites(fake);

  const warned = log.entries.find((entry) =>
    entry.level === "warn" && entry.context?.step === "pr-close"
  );
  assert(warned, "the failing step was not recorded in the log");
  assertEquals(warned.context?.route, "abandon-failed");
});

Deno.test("findConflictingPr - the abandon seam receives the PR's failure thread", async () => {
  // The abandon quotes what the attempts recorded, so the scan must hand it
  // the thread it already fetched rather than making it re-read the PR.
  const seen: AbandonRestartRequest[] = [];
  const fake = makeFakeGh(exhaustedState());

  await scanWith(fake, {
    abandonRestart: (request) => {
      seen.push(request);
      return Promise.resolve({
        outcome: "abandoned",
        issueNumber: 16,
        label: { kept: "work-on" },
      });
    },
  });

  assertEquals(seen.length, 1);
  assertEquals(seen[0]?.prNumber, 48);
  assertEquals(seen[0]?.branchName, "issue-16-fix");
  assertEquals(seen[0]?.baseBranch, "main");
  assertEquals(seen[0]?.prComments?.length, exhaustedComments().length);
});

Deno.test("findConflictingPr - a failure at any abandon step is named in the record, never escalated (Issue #2310)", async () => {
  // The Failure Detection clause of Issue #1115, as Issue #2310 leaves it:
  // every step still names itself, and none of them asks a person. The
  // dangerous state — PR closed, issue not re-queued — is a late step, so the
  // late steps matter most here.
  const steps: AbandonStep[] = [
    "originating-issue",
    "issue-state",
    "restart-marker",
    "existing-pr",
    "pr-thread",
    "issue-comment",
    "pr-comment",
    "pr-close",
    "issue-reopen",
    "issue-label",
    "fallback-flag",
  ];

  for (const step of steps) {
    const fake = makeFakeGh(exhaustedState());
    const { log } = await scanWith(fake, {
      abandonRestart: () =>
        Promise.resolve({
          outcome: "failed",
          step,
          message: `${step} blew up`,
        }),
    });

    assertEquals(reasonFor(log, 48), "budget-spent", `${step} record`);
    assertEquals(escalatedToHuman(fake, 48), false, `${step} needs-human`);
    assertNoNeedsHumanWrites(fake);
    const warned = log.entries.find((entry) =>
      entry.level === "warn" && entry.context?.step === step
    );
    assert(warned, `${step}: the step was not recorded`);
  }
});

// ---------------------------------------------------------------------------
// Who wrote the attempt history (Issue #1247, SEC-1216-06)
// ---------------------------------------------------------------------------

Deno.test("findConflictingPr - planted failure markers cannot close a PR", async () => {
  // The exploit: `CONFLICT_FAILED_MARKER` is exported and published, and a PR
  // comment is writable by any GitHub account. Two planted comments spent the
  // whole merge budget, and a spent budget hands the PR to `abandonRestart`,
  // which CLOSES it and re-queues its issue — a destructive write driven
  // entirely by unauthenticated text.
  const abandons: AbandonRestartRequest[] = [];
  const fake = makeFakeGh(exhaustedState({
    comments: {
      48: exhaustedComments().map((c) => ({
        ...c,
        user: { login: OUTSIDER },
      })),
    },
  }));

  const { result, log } = await scanWith(fake, {
    abandonRestart: (request) => {
      abandons.push(request);
      return Promise.resolve({
        outcome: "abandoned",
        issueNumber: 16,
        label: { kept: "work-on" },
      });
    },
  });

  // Nothing was abandoned, nothing was escalated: with no fleet-authored
  // attempt on the thread the budget is untouched, so the PR is simply due.
  assertEquals(abandons, []);
  assertEquals(escalatedToHuman(fake, 48), false);
  assertEquals(reasonFor(log, 48), "attempted");
  assertEquals(result.value.selected?.prNumber, 48);
  assertEquals(result.value.selected?.attemptCount, 0);
});

Deno.test("findConflictingPr - an abandon that applied idle-task reads as re-queued (Issue #2277)", async () => {
  // The issue carried no pickup label, so the rung applied `idle-task` — the
  // decision record still reads as re-queued, and no human is waiting on it.
  const fake = makeFakeGh(exhaustedState());

  const { result, log } = await scanWith(fake, {
    abandonRestart: () =>
      Promise.resolve({
        outcome: "abandoned",
        issueNumber: 16,
        label: { applied: "idle-task" },
      }),
  });

  assertEquals(result.value.selected, null);
  assertEquals(reasonFor(log, 48), "abandoned-restarted");
  assertEquals(recordFor(log, 48).context?.issueNumber, 16);
  assertEquals(escalatedToHuman(fake, 48), false);
});

Deno.test("findConflictingPr - the fleet's own failure markers still spend the budget", async () => {
  // The other direction: filtering must not stop a genuine exhausted PR
  // reaching the abandon rung.
  const fake = makeFakeGh(exhaustedState());

  const { result, log } = await scanWith(fake);

  assertEquals(result.value.selected, null);
  assertEquals(reasonFor(log, 48), "abandoned-restarted");
});

Deno.test("findConflictingPr - the abandon seam is handed the fleet's comments only", async () => {
  // The abandon comment quotes this thread verbatim, so an outsider's
  // invented "attempt" must not reach it.
  const seen: AbandonRestartRequest[] = [];
  const planted = {
    body: `${CONFLICT_FAILED_MARKER} n="9" -->\nplanted by a stranger`,
    created_at: "2026-08-19T09:00:00Z",
    user: { login: OUTSIDER },
  };
  const fake = makeFakeGh(exhaustedState({
    comments: { 48: [planted, ...exhaustedComments()] },
  }));

  await scanWith(fake, {
    abandonRestart: (request) => {
      seen.push(request);
      return Promise.resolve({
        outcome: "abandoned",
        issueNumber: 16,
        label: { kept: "work-on" },
      });
    },
  });

  assertEquals(seen.length, 1);
  assertEquals(seen[0]?.prComments?.length, exhaustedComments().length);
  assert(
    !JSON.stringify(seen[0]?.prComments).includes("planted by a stranger"),
    "an outsider's comment reached the abandon rung",
  );
});

Deno.test("findConflictingPr - an unresolved fleet identity spends no budget", async () => {
  // Nothing can be attributed, so no marker counts. The PR is attempted
  // rather than abandoned: fewer counted attempts is the harmless direction
  // for a rung that closes PRs.
  const fake = makeFakeGh(exhaustedState());

  const { result, log } = await scanWith(fake, { trustedAuthors: [] });

  assertEquals(escalatedToHuman(fake, 48), false);
  assertEquals(reasonFor(log, 48), "attempted");
  assertEquals(result.value.selected?.attemptCount, 0);
});
