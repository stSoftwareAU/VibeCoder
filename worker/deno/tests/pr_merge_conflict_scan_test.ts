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
  countDisruptedAttempts,
  DEFAULT_CONFLICT_COOLDOWN_HOURS,
  findConflictingPr,
  type FindConflictingPrOptions,
  hasExhaustedConflictAttempts,
  hasExhaustedDisruptedAttempts,
  isConflictAttemptDue,
  MERGE_CONFLICT_LABEL,
  parseConflictAttempts,
} from "../lib/pr_merge_conflict_scan.ts";
import type { Logger } from "../types.ts";

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

interface FakeRepoState {
  /** PRs the listing returns. */
  prs: Array<{ number: number; headRefName: string; baseRefName: string }>;
  /** Mergeable state per PR number. */
  mergeable: Record<number, string>;
  /** Labels per PR number. */
  labels: Record<number, string[]>;
  /** Comment thread per PR number. */
  comments: Record<number, Array<{ body: string; created_at: string }>>;
}

interface FakeGh {
  ghCommandFn: (args: string[]) => Promise<string>;
  labelsAdded: Array<{ prNumber: number; label: string }>;
  commentsPosted: Array<{ prNumber: number; body: string }>;
  calls: string[][];
}

/** A `gh` stub that answers exactly the calls this scan issues. */
function makeFakeGh(state: FakeRepoState): FakeGh {
  const labelsAdded: Array<{ prNumber: number; label: string }> = [];
  const commentsPosted: Array<{ prNumber: number; body: string }> = [];
  const calls: string[][] = [];

  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);

    if (args[0] === "pr" && args[1] === "list") {
      return Promise.resolve(JSON.stringify(state.prs));
    }

    // Batched branch-state GraphQL query: answer with each PR's mergeable.
    if (args[0] === "api" && args[1] === "graphql") {
      const repository: Record<string, unknown> = {};
      state.prs.forEach((pr, index) => {
        repository[`p${index}`] = {
          number: pr.number,
          mergeable: state.mergeable[pr.number] ?? "MERGEABLE",
          headRef: { compare: { aheadBy: 1, behindBy: 0 } },
        };
      });
      return Promise.resolve(JSON.stringify({ data: { repository } }));
    }

    if (args[0] === "pr" && args[1] === "view" && args.includes("labels")) {
      const prNumber = Number(args[2]);
      return Promise.resolve((state.labels[prNumber] ?? []).join("\n"));
    }

    // Comment pages: `api repos/<repo>/issues/<n>/comments?...`
    if (args[0] === "api" && String(args[1]).includes("/comments")) {
      const match = /issues\/(\d+)\/comments/.exec(String(args[1]));
      const prNumber = Number(match?.[1] ?? 0);
      return Promise.resolve(JSON.stringify(state.comments[prNumber] ?? []));
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

  return { ghCommandFn, labelsAdded, commentsPosted, calls };
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
    nowMs: () => Date.parse("2026-08-20T12:00:00Z"),
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
    isConflictAttemptDue(
      { count: 0, disruptedCount: 0, pendingAttempt: false },
      Date.now(),
    ),
    true,
  );
});

Deno.test("isConflictAttemptDue - honours the cooldown window", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  const oneHourAgo = new Date(now - 3600_000).toISOString();
  const sixHoursAgo = new Date(now - 6 * 3600_000).toISOString();
  const history = (lastAttemptAt: string) => ({
    count: 1,
    disruptedCount: 0,
    pendingAttempt: false,
    lastAttemptAt,
  });

  assertEquals(isConflictAttemptDue(history(oneHourAgo), now), false);
  assertEquals(isConflictAttemptDue(history(sixHoursAgo), now), true);
  assertEquals(isConflictAttemptDue(history(oneHourAgo), now, 0.5), true);
});

Deno.test("isConflictAttemptDue - an unparseable timestamp holds the PR back", () => {
  assertEquals(
    isConflictAttemptDue({
      count: 1,
      disruptedCount: 0,
      pendingAttempt: false,
      lastAttemptAt: "not-a-date",
    }, Date.now()),
    false,
  );
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
  assertEquals(result.value?.prNumber, 48);
  assertEquals(result.value?.branchName, "issue-16-fix");
  assertEquals(result.value?.baseBranch, "main");
  assertEquals(result.value?.attemptCount, 0);
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
  assertEquals(result.value, null);
  assertEquals(fake.labelsAdded.length, 0);
});

Deno.test("findConflictingPr - does not re-add a label the PR already carries", async () => {
  const state = makeState({ labels: { 48: [MERGE_CONFLICT_LABEL] } });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value?.prNumber, 48);
  assertEquals(fake.labelsAdded.length, 0);
});

Deno.test("findConflictingPr - skips a PR a human already owns, but still labels it", async () => {
  const state = makeState({ labels: { 48: ["needs-human"] } });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value, null);
  assertEquals(fake.labelsAdded, [{
    prNumber: 48,
    label: MERGE_CONFLICT_LABEL,
  }]);
});

Deno.test("findConflictingPr - holds a PR back inside its cooldown", async () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  const state = makeState({
    comments: {
      48: [{
        body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`,
        created_at: new Date(now - 3600_000).toISOString(),
      }],
    },
  });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value, null);
});

Deno.test("findConflictingPr - returns a PR whose cooldown has elapsed, carrying its attempt count", async () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  // Issue #395: the attempt only counts once it concluded, so the fixture
  // carries the failure conclusion the processor now posts.
  const elapsed = new Date(
    now - (DEFAULT_CONFLICT_COOLDOWN_HOURS + 1) * 3600_000,
  ).toISOString();
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
  assertEquals(result.value?.attemptCount, 1);
  assertEquals(result.value?.disruptedCount, 0);
});

Deno.test("findConflictingPr - refuses a PR that has spent its attempt budget", async () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  const old = new Date(now - 48 * 3600_000).toISOString();
  const state = makeState({
    // Issue #395: a spent budget is only a quiet skip once the PR is visibly
    // a human's — the escalation the last attempt posted is in the thread.
    labels: { 48: ["needs-human"] },
    comments: {
      48: [
        { body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`, created_at: old },
        { body: `${CONFLICT_FAILED_MARKER} n="1" -->`, created_at: old },
        { body: `${CONFLICT_ATTEMPT_MARKER} n="2" -->`, created_at: old },
        { body: `${CONFLICT_FAILED_MARKER} n="2" -->`, created_at: old },
      ],
    },
  });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value, null);
  assertEquals(fake.commentsPosted.length, 0);
});

Deno.test("findConflictingPr - a spent budget with no needs-human is escalated, not stalled", async () => {
  // Issue #395: the last attempt escalates from the processor, so a failure
  // there (or a run cut short between the conclusion and the escalation)
  // left the PR conflicting, out of budget, and owned by nobody — skipped
  // silently on every scan for ever. The scan is the backstop.
  const now = Date.parse("2026-08-20T12:00:00Z");
  const old = new Date(now - 48 * 3600_000).toISOString();
  const state = makeState({
    comments: {
      48: [
        { body: `${CONFLICT_ATTEMPT_MARKER} n="1" -->`, created_at: old },
        { body: `${CONFLICT_FAILED_MARKER} n="1" -->`, created_at: old },
        { body: `${CONFLICT_ATTEMPT_MARKER} n="2" -->`, created_at: old },
        { body: `${CONFLICT_FAILED_MARKER} n="2" -->`, created_at: old },
      ],
    },
  });
  const fake = makeFakeGh(state);

  const result = await findConflictingPr(makeOptions(fake));

  assert(result.ok);
  assertEquals(result.value, null);
  assertEquals(
    fake.labelsAdded.some((l) =>
      l.prNumber === 48 && l.label === "needs-human"
    ),
    true,
  );

  const escalation = fake.commentsPosted.at(-1)?.body ?? "";
  assertStringIncludes(escalation, "2");
  assertStringIncludes(escalation, "**Next step:**");
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
  assertEquals(result.value?.prNumber, 48);
  assertEquals(result.value?.attemptCount, 0);
  assertEquals(result.value?.disruptedCount, 2);
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
  assertEquals(result.value, null);
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
  assertEquals(result.value, null);
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
  assertEquals(result.value, null);
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
  assertEquals(result.value?.prNumber, 48);
});
