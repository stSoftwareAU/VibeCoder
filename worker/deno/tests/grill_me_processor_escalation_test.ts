/**
 * Regression tests for grill_me_processor.ts routing every `needs-human`
 * application through the shared `escalateToHuman` helper (Issue #2209).
 *
 * Every code path that adds `needs-human` must EITHER:
 *   (a) post a fresh `## Needs human attention` (or `## Grill-Me Escalation`)
 *       explanation comment in the same run, OR
 *   (b) honour an existing matching `dedupKey` marker / "additional dedup
 *       marker" (the Round N / Ready comment that already explains the
 *       state) and skip the duplicate comment while still re-applying
 *       the label.
 *
 * Reproduces the bug reported on
 * https://github.com/stSoftwareAU/private-repo-9/issues/406#issuecomment-4527545438
 * — silent re-application of `needs-human` after the user adds `work-on`
 * — by asserting that the Ready-already-posted defence-in-depth path
 * routes through the shared helper with the expected reason / next step
 * and dedup key.
 *
 * Australian English used throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  GRILL_ME_FAILED_MARKER,
  GRILL_ME_READY_MARKER,
  GRILL_ME_ROUND_MARKER,
  processGrillMe,
} from "../lib/grill_me_processor.ts";
import { buildDedupMarker } from "../lib/needs_human_escalation.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { GitHubComment, GitHubIssue, WorkerConfig } from "../types.ts";
import type { IssueContext } from "../lib/issue_worker.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844)
// — named as a parameter on every call rather than pinned by deleting the
// host's overrides from the shared process environment (Issue #1024).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Helpers (mirror grill_me_processor_test.ts shapes for consistency)
// ---------------------------------------------------------------------------

function makeComment(overrides?: Partial<GitHubComment>): GitHubComment {
  return {
    id: 1,
    body: "",
    author: "user1",
    createdAt: "2026-01-01T00:00:00Z",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return {
    ...(buildDefaultWorkerConfig()),
    maxGrillMeRounds: 3,
    ...overrides,
  };
}

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: "Add reporting dashboard",
    issueBody: "Build a reporting dashboard with charts.",
    issueLabels: ["grill-me"],
    issueComments: "",
    githubUser: "testbot",
    config: makeConfig(),
    ...overrides,
  };
}

function makeIssue(overrides?: Partial<GitHubIssue>): GitHubIssue {
  return {
    number: 42,
    title: "Add reporting dashboard",
    body: "",
    labels: ["grill-me"],
    author: "user1",
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function stubGhClient(overrides: {
  getIssueComments?: () => Promise<GitHubComment[]>;
  getIssue?: () => Promise<GitHubIssue>;
  postComment?: (
    repo: string,
    issueNumber: number,
    body: string,
  ) => Promise<GitHubComment | undefined>;
  addLabel?: (
    repo: string,
    issueNumber: number,
    label: string,
  ) => Promise<void>;
  removeLabel?: (
    repo: string,
    issueNumber: number,
    label: string,
  ) => Promise<void>;
  unassignIssue?: (
    repo: string,
    issueNumber: number,
    assignees: string[],
  ) => Promise<void>;
} = {}) {
  return {
    getIssue: overrides.getIssue ?? (() => Promise.resolve(makeIssue())),
    getIssueComments: overrides.getIssueComments ?? (() => Promise.resolve([])),
    addLabel: overrides.addLabel ?? (() => Promise.resolve()),
    removeLabel: overrides.removeLabel ?? (() => Promise.resolve()),
    postComment: overrides.postComment ?? (() => Promise.resolve(undefined)),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: overrides.unassignIssue ?? (() => Promise.resolve()),
    closeIssue: () => Promise.resolve(),
  };
}

// ============================================================================
// 1) Consecutive-failures escalation posts an explanation comment
// ============================================================================

Deno.test(
  "Issue #2209: consecutive-failures escalation posts explanation comment alongside label",
  async () => {
    const ctx = makeContext();
    const priorComments: GitHubComment[] = [
      makeComment({
        id: 1,
        author: "testbot",
        body: `${GRILL_ME_FAILED_MARKER} previous failure 1`,
      }),
      makeComment({
        id: 2,
        author: "testbot",
        body: `${GRILL_ME_FAILED_MARKER} previous failure 2`,
      }),
    ];

    const addedLabels: string[] = [];
    const postedBodies: string[] = [];

    const ghClient = stubGhClient({
      getIssueComments: () => Promise.resolve(priorComments),
      addLabel: (_r, _n, label) => {
        addedLabels.push(label);
        return Promise.resolve();
      },
      postComment: (_r, _n, body) => {
        postedBodies.push(body);
        return Promise.resolve(undefined);
      },
    });

    const deps = createMockDeps();
    const result = await processGrillMe(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient,
      logger: deps.logger,
      deps,
    });
    assertEquals(result.ok, true);
    if (!result.ok) return;

    assertEquals(result.value.escalatedToHuman, true);
    assert(addedLabels.includes("needs-human"));

    // The shared helper posted a Needs human attention comment with Why
    // and Next step lines (or used the Grill-Me Escalation heading).
    const escalationComment = postedBodies.find((b) =>
      b.includes("## Needs human attention") ||
      b.includes("## Grill-Me Escalation")
    );
    assert(
      escalationComment !== undefined,
      `Expected an escalation comment; got bodies: ${postedBodies.join(" | ")}`,
    );
    assertStringIncludes(escalationComment, "**Why:**");
    assertStringIncludes(escalationComment, "**Next step:**");
    assertStringIncludes(
      escalationComment,
      "consecutive grill-me rounds failed",
    );
    assertStringIncludes(escalationComment, "🤖 Processed by: testbot");
  },
);

// ============================================================================
// 2) The stop rule (Issue #1933): a productive grilling runs on, an
//    unproductive one gets one forced final round, and only a forced round
//    that posts no Ready escalates.
// ============================================================================

/** A round comment whose `### Questions` section carries `stems`. */
function roundBody(roundNumber: number, ...stems: string[]): string {
  const questions = stems
    .map((stem, i) => `${i + 1}. ${stem}\n   - [x] yes\n   - [ ] other`)
    .join("\n\n");
  return [
    `${GRILL_ME_ROUND_MARKER}${roundNumber}`,
    "",
    "**TL;DR:** a round",
    "",
    "### Questions",
    "",
    questions,
    "",
    "**⏳ Awaiting your reply.**",
  ].join("\n");
}

/** `rounds` answered rounds, each asking a stem no earlier round asked. */
function productiveGrilling(rounds: number): GitHubComment[] {
  const comments: GitHubComment[] = [];
  for (let n = 1; n <= rounds; n++) {
    comments.push(
      makeComment({
        id: n * 2 - 1,
        author: "testbot",
        body: roundBody(n, `Question ${n}?`),
        createdAt: `2026-01-0${n}T00:00:00Z`,
      }),
    );
    comments.push(
      makeComment({
        id: n * 2,
        author: "user1",
        body: `reply ${n}`,
        createdAt: `2026-01-0${n}T01:00:00Z`,
      }),
    );
  }
  return comments;
}

Deno.test(
  "Issue #1933: five answered productive rounds run Round 6 instead of escalating (GRQ#4754)",
  async () => {
    // The reported bug: the developer answered five rounds in 2.5 hours, every
    // round asked something new, and the fixed cap escalated anyway.
    const ctx = makeContext({ config: makeConfig({ maxGrillMeRounds: 20 }) });
    const priorComments = productiveGrilling(5);
    const addedLabels: string[] = [];
    const postedBodies: string[] = [];
    let capturedPrompt = "";

    const ghClient = stubGhClient({
      getIssueComments: () => Promise.resolve(priorComments),
      getIssue: () => Promise.resolve(makeIssue({ labels: ["grill-me"] })),
      addLabel: (_r, _n, label) => {
        addedLabels.push(label);
        return Promise.resolve();
      },
      postComment: (_r, _n, body) => {
        postedBodies.push(body);
        return Promise.resolve(undefined);
      },
    });

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (opts: { prompt: string }) => {
          capturedPrompt = opts.prompt;
          return Promise.resolve({
            ok: true,
            value: {
              output: `${GRILL_ME_ROUND_MARKER}6`,
              exitCode: 0,
              timedOut: false,
            },
          });
        },
      },
    });

    const result = await processGrillMe(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient,
      logger: deps.logger,
      deps,
    });
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assertEquals(result.value.processed, true);
    assertEquals(result.value.roundNumber, 6);
    assertEquals(result.value.escalatedToHuman, false);
    assertEquals(result.value.isFinalRound, false);
    // No forced-final signal in the prompt — this is an ordinary round.
    assertEquals(
      capturedPrompt.includes("This round is a forced final round"),
      false,
    );
    assertEquals(capturedPrompt.includes("Forced final round:"), false);
    const escalation = postedBodies.find((b) =>
      b.includes("## Grill-Me Escalation")
    );
    assertEquals(
      escalation,
      undefined,
      `A productive grilling must not escalate; got: ${
        postedBodies.join(" | ")
      }`,
    );
  },
);

Deno.test(
  "Issue #1933: a stalled round forces a final round that posts Ready with the trigger line",
  async () => {
    const ctx = makeContext({ config: makeConfig({ maxGrillMeRounds: 20 }) });
    // Round 3 repeats every stem Rounds 1-2 already asked.
    const priorComments: GitHubComment[] = [
      ...productiveGrilling(2),
      makeComment({
        id: 90,
        author: "testbot",
        body: roundBody(3, "Question 1?", "*Question  2!*"),
        createdAt: "2026-01-03T00:00:00Z",
      }),
      makeComment({
        id: 91,
        author: "user1",
        body: "reply 3",
        createdAt: "2026-01-03T01:00:00Z",
      }),
    ];
    const postedBodies: string[] = [];
    let capturedPrompt = "";

    const ghClient = stubGhClient({
      getIssueComments: () => Promise.resolve(priorComments),
      getIssue: () => Promise.resolve(makeIssue({ labels: ["grill-me"] })),
      postComment: (_r, _n, body) => {
        postedBodies.push(body);
        return Promise.resolve(undefined);
      },
    });

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (opts: { prompt: string }) => {
          capturedPrompt = opts.prompt;
          return Promise.resolve({
            ok: true,
            value: {
              output: GRILL_ME_READY_MARKER,
              exitCode: 0,
              timedOut: false,
            },
          });
        },
      },
    });

    const result = await processGrillMe(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient,
      logger: deps.logger,
      deps,
    });
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assertEquals(result.value.processed, true);
    assertEquals(result.value.isFinalRound, true);
    assertEquals(result.value.escalatedToHuman, false);
    // The prompt must demand the Ready comment and name the trigger line the
    // Ready comment carries under its TL;DR.
    assertStringIncludes(capturedPrompt, "This round is a forced final round");
    assertStringIncludes(
      capturedPrompt,
      "Forced final round: stall guard tripped at Round 3",
    );
    assertStringIncludes(capturedPrompt, "named assumption");
    // Ready was posted, so no escalation comment.
    const escalation = postedBodies.find((b) =>
      b.includes("## Grill-Me Escalation")
    );
    assertEquals(
      escalation,
      undefined,
      `A forced round that posted Ready must not escalate; got: ${
        postedBodies.join(" | ")
      }`,
    );
  },
);

Deno.test(
  "Issue #1933: the ceiling round is itself the forced final round",
  async () => {
    // Two productive rounds and a ceiling of three: the next round is the
    // third, so it is forced even though nothing has stalled.
    const ctx = makeContext({ config: makeConfig({ maxGrillMeRounds: 3 }) });
    const priorComments = productiveGrilling(2);
    let capturedPrompt = "";

    const ghClient = stubGhClient({
      getIssueComments: () => Promise.resolve(priorComments),
      getIssue: () => Promise.resolve(makeIssue({ labels: ["grill-me"] })),
    });

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (opts: { prompt: string }) => {
          capturedPrompt = opts.prompt;
          return Promise.resolve({
            ok: true,
            value: {
              output: GRILL_ME_READY_MARKER,
              exitCode: 0,
              timedOut: false,
            },
          });
        },
      },
    });

    const result = await processGrillMe(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient,
      logger: deps.logger,
      deps,
    });
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assertEquals(result.value.roundNumber, 3);
    assertEquals(result.value.isFinalRound, true);
    assertStringIncludes(
      capturedPrompt,
      "Forced final round: round ceiling (3) reached",
    );
  },
);

Deno.test(
  "Issue #1933: a forced final round that posts a round comment instead escalates, naming the trigger",
  async () => {
    const ctx = makeContext({ config: makeConfig({ maxGrillMeRounds: 3 }) });
    const priorComments = productiveGrilling(2);
    const addedLabels: string[] = [];
    const postedBodies: string[] = [];

    const ghClient = stubGhClient({
      getIssueComments: () => Promise.resolve(priorComments),
      getIssue: () => Promise.resolve(makeIssue({ labels: ["grill-me"] })),
      addLabel: (_r, _n, label) => {
        addedLabels.push(label);
        return Promise.resolve();
      },
      postComment: (_r, _n, body) => {
        postedBodies.push(body);
        return Promise.resolve(undefined);
      },
    });

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: () =>
          Promise.resolve({
            ok: true,
            value: {
              output: `${GRILL_ME_ROUND_MARKER}3`,
              exitCode: 0,
              timedOut: false,
            },
          }),
      },
    });

    const result = await processGrillMe(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient,
      logger: deps.logger,
      deps,
    });
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assertEquals(result.value.escalatedToHuman, true);
    assert(addedLabels.includes("needs-human"));

    const escalation = postedBodies.find((b) =>
      b.includes("## Grill-Me Escalation")
    );
    assert(
      escalation !== undefined,
      `Expected a Grill-Me Escalation comment; got: ${
        postedBodies.join(" | ")
      }`,
    );
    assertStringIncludes(escalation, "**Why:**");
    assertStringIncludes(escalation, "**Next step:**");
    // Names the trigger and that no Ready comment followed.
    assertStringIncludes(escalation, "round ceiling (3) reached");
    assertStringIncludes(escalation, GRILL_ME_READY_MARKER);
    assertStringIncludes(escalation, "planning");
    assertStringIncludes(escalation, "work-on");
  },
);

Deno.test(
  "Issue #1933: a forced final round that posts nothing escalates as well as failing loudly",
  async () => {
    const ctx = makeContext({ config: makeConfig({ maxGrillMeRounds: 3 }) });
    const priorComments = productiveGrilling(2);
    const addedLabels: string[] = [];
    const postedBodies: string[] = [];

    const ghClient = stubGhClient({
      getIssueComments: () => Promise.resolve(priorComments),
      getIssue: () => Promise.resolve(makeIssue({ labels: ["grill-me"] })),
      addLabel: (_r, _n, label) => {
        addedLabels.push(label);
        return Promise.resolve();
      },
      postComment: (_r, _n, body) => {
        postedBodies.push(body);
        return Promise.resolve(undefined);
      },
    });

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: () =>
          Promise.resolve({
            ok: true,
            value: { output: "no marker at all", exitCode: 0, timedOut: false },
          }),
      },
    });

    const result = await processGrillMe(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient,
      logger: deps.logger,
      deps,
    });
    // The round genuinely failed, so the Result is an error — the escalation
    // is in addition to the failure marker, never instead of it.
    assertEquals(result.ok, false);
    assert(addedLabels.includes("needs-human"));
    const escalation = postedBodies.find((b) =>
      b.includes("## Grill-Me Escalation")
    );
    assert(
      escalation !== undefined,
      `Expected a Grill-Me Escalation comment; got: ${
        postedBodies.join(" | ")
      }`,
    );
    assertStringIncludes(escalation, "round ceiling (3) reached");
    assertStringIncludes(escalation, "no comment was posted");
    const failure = postedBodies.find((b) =>
      b.includes(GRILL_ME_FAILED_MARKER)
    );
    assert(
      failure !== undefined,
      "the failure marker must still be posted so consecutive failures count",
    );
  },
);

// ============================================================================
// 3) Ready-already-posted DiD: posts explanation when no prior dedup
//    marker exists; bug from private-repo-9#406 cannot recur
// ============================================================================

Deno.test(
  "Issue #2209: Ready-already-posted defence-in-depth posts an explanation when no dedup marker exists (private-repo-9#406 regression)",
  async () => {
    // The user previously added `work-on` and the verifier stripped
    // `needs-human`. The Ready marker is in the comment history but
    // `needs-human` is missing. The defence-in-depth must:
    //   - re-add `needs-human`
    //   - post the "## Needs human attention" explanation explaining
    //     why, with a Next step naming `planning` / `work-on` /
    //     `top-priority`.
    // Crucially, the explanation must NOT be silent — the original
    // bug was that the label was re-added without any user-visible
    // explanation, so the user felt the worker was ignoring their
    // `work-on` label.
    const ctx = makeContext();
    const priorComments: GitHubComment[] = [
      makeComment({
        id: 1,
        author: "testbot",
        body: `${GRILL_ME_READY_MARKER}\n\nReady — please choose next phase`,
      }),
      makeComment({ id: 2, author: "user1", body: "I added work-on" }),
    ];
    const addedLabels: string[] = [];
    const postedBodies: string[] = [];

    const ghClient = stubGhClient({
      getIssueComments: () => Promise.resolve(priorComments),
      // grill-me already removed by Claude, needs-human absent.
      getIssue: () => Promise.resolve(makeIssue({ labels: [] })),
      addLabel: (_r, _n, label) => {
        addedLabels.push(label);
        return Promise.resolve();
      },
      postComment: (_r, _n, body) => {
        postedBodies.push(body);
        return Promise.resolve(undefined);
      },
    });

    const deps = createMockDeps();
    const result = await processGrillMe(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient,
      logger: deps.logger,
      deps,
    });
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assertEquals(result.value.needsHumanAdded, true);
    assert(
      addedLabels.includes("needs-human"),
      "needs-human must be re-applied",
    );

    // A fresh explanation comment was posted alongside the label.
    const escalationComment = postedBodies.find((b) =>
      b.includes("## Needs human attention")
    );
    assert(
      escalationComment !== undefined,
      "Issue #2209: Ready-already-posted DiD must post an explanation " +
        `comment, not silently re-apply the label. Bodies: ${
          postedBodies.join(" | ")
        }`,
    );
    assertStringIncludes(
      escalationComment,
      "Ready for Next Phase",
    );
    assertStringIncludes(escalationComment, "planning");
    assertStringIncludes(escalationComment, "work-on");
    assertStringIncludes(escalationComment, "top-priority");
    // dedupKey marker for grill-me-ready-${issueNumber} is present.
    assertStringIncludes(
      escalationComment,
      buildDedupMarker("grill-me-ready-42"),
    );
  },
);

Deno.test(
  "Issue #2209: Ready-already-posted DiD honours dedup — no duplicate comment when an earlier escalation was posted",
  async () => {
    // Simulate the second iteration after the previous one already
    // posted the escalation comment with the dedup marker. The
    // helper must skip a fresh comment but still re-apply the label.
    const ctx = makeContext();
    const earlierEscalation = makeComment({
      id: 99,
      author: "testbot",
      body:
        `## Needs human attention\n\n**Why:** earlier\n\n**Next step:** earlier\n\n${
          buildDedupMarker("grill-me-ready-42")
        }`,
      createdAt: new Date().toISOString(),
    });
    const priorComments: GitHubComment[] = [
      makeComment({
        id: 1,
        author: "testbot",
        body: `${GRILL_ME_READY_MARKER}\n\nReady`,
      }),
      earlierEscalation,
    ];
    const addedLabels: string[] = [];
    const postedBodies: string[] = [];

    const ghClient = stubGhClient({
      getIssueComments: () => Promise.resolve(priorComments),
      getIssue: () => Promise.resolve(makeIssue({ labels: [] })),
      addLabel: (_r, _n, label) => {
        addedLabels.push(label);
        return Promise.resolve();
      },
      postComment: (_r, _n, body) => {
        postedBodies.push(body);
        return Promise.resolve(undefined);
      },
    });

    const deps = createMockDeps();
    const result = await processGrillMe(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient,
      logger: deps.logger,
      deps,
    });
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assert(
      addedLabels.includes("needs-human"),
      "label must still be re-applied even when comment is deduped",
    );
    const freshEscalation = postedBodies.find((b) =>
      b.includes("## Needs human attention")
    );
    assertEquals(
      freshEscalation,
      undefined,
      `Expected the helper to dedup against the earlier marker; got: ${
        postedBodies.join(" | ")
      }`,
    );
  },
);

// ============================================================================
// 4) Awaiting-reply DiD: posts explanation comment with the round number
// ============================================================================

Deno.test(
  "Issue #2209: awaiting-reply defence-in-depth posts an explanation comment naming the round",
  async () => {
    const ctx = makeContext();
    const priorComments: GitHubComment[] = [
      makeComment({
        id: 1,
        author: "testbot",
        body: `${GRILL_ME_ROUND_MARKER}2\n\nQuestions...`,
      }),
    ];
    const addedLabels: string[] = [];
    const postedBodies: string[] = [];

    const ghClient = stubGhClient({
      getIssueComments: () => Promise.resolve(priorComments),
      getIssue: () => Promise.resolve(makeIssue({ labels: ["grill-me"] })),
      addLabel: (_r, _n, label) => {
        addedLabels.push(label);
        return Promise.resolve();
      },
      postComment: (_r, _n, body) => {
        postedBodies.push(body);
        return Promise.resolve(undefined);
      },
    });

    const deps = createMockDeps();
    const result = await processGrillMe(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient,
      logger: deps.logger,
      deps,
    });
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assert(result.value.needsHumanAdded, "label must be added");
    assert(addedLabels.includes("needs-human"));

    const escalationComment = postedBodies.find((b) =>
      b.includes("## Needs human attention")
    );
    assert(
      escalationComment !== undefined,
      `Expected explanation comment; bodies: ${postedBodies.join(" | ")}`,
    );
    assertStringIncludes(escalationComment, "Round 1 is still waiting");
    assertStringIncludes(escalationComment, "remove `needs-human`");
    // dedupKey marker for grill-me-awaiting-${issueNumber}-round-${priorRounds}.
    assertStringIncludes(
      escalationComment,
      buildDedupMarker("grill-me-awaiting-42-round-1"),
    );
  },
);

Deno.test(
  "Issue #2209: awaiting-reply DiD honours dedup when an earlier escalation for the same round exists",
  async () => {
    const ctx = makeContext();
    const earlierEscalation = makeComment({
      id: 99,
      author: "testbot",
      body:
        `## Needs human attention\n\n**Why:** prior\n\n**Next step:** prior\n\n${
          buildDedupMarker("grill-me-awaiting-42-round-1")
        }`,
      createdAt: new Date().toISOString(),
    });
    const priorComments: GitHubComment[] = [
      makeComment({
        id: 1,
        author: "testbot",
        body: `${GRILL_ME_ROUND_MARKER}3`,
      }),
      earlierEscalation,
    ];
    const addedLabels: string[] = [];
    const postedBodies: string[] = [];

    const ghClient = stubGhClient({
      getIssueComments: () => Promise.resolve(priorComments),
      getIssue: () => Promise.resolve(makeIssue({ labels: ["grill-me"] })),
      addLabel: (_r, _n, label) => {
        addedLabels.push(label);
        return Promise.resolve();
      },
      postComment: (_r, _n, body) => {
        postedBodies.push(body);
        return Promise.resolve(undefined);
      },
    });

    const deps = createMockDeps();
    const result = await processGrillMe(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient,
      logger: deps.logger,
      deps,
    });
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assert(addedLabels.includes("needs-human"));
    const freshEscalation = postedBodies.find((b) =>
      b.includes("## Needs human attention")
    );
    assertEquals(
      freshEscalation,
      undefined,
      `Helper must dedup against the earlier marker; got: ${
        postedBodies.join(" | ")
      }`,
    );
  },
);

// ============================================================================
// 5) Post-Ready DiD (in-run): the Ready marker just posted IS the
//    explanation — additionalDedupMarkers must suppress a duplicate
// ============================================================================

Deno.test(
  "Issue #2209: post-Ready DiD treats the Ready marker as the explanation and only ensures the label",
  async () => {
    const ctx = makeContext();
    let claudeRound: GitHubComment | null = null;
    const addedLabels: string[] = [];
    const postedBodies: string[] = [];

    const ghClient = stubGhClient({
      // grill-me removed by Claude itself, needs-human is absent.
      getIssue: () => Promise.resolve(makeIssue({ labels: [] })),
      addLabel: (_r, _n, label) => {
        addedLabels.push(label);
        return Promise.resolve();
      },
      postComment: (_r, _n, body) => {
        postedBodies.push(body);
        return Promise.resolve(undefined);
      },
    });
    ghClient.getIssueComments = () => {
      if (claudeRound === null) return Promise.resolve([]);
      return Promise.resolve([claudeRound]);
    };

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: () => {
          claudeRound = makeComment({
            id: 50,
            author: "testbot",
            body: `${GRILL_ME_READY_MARKER}\n\nReady for next phase`,
          });
          return Promise.resolve({
            ok: true,
            value: {
              output: GRILL_ME_READY_MARKER,
              exitCode: 0,
              timedOut: false,
            },
          });
        },
      },
    });

    const result = await processGrillMe(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient,
      logger: deps.logger,
      deps,
    });
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assert(addedLabels.includes("needs-human"));
    // No "## Needs human attention" escalation comment — the Ready
    // marker IS the explanation.
    const escalationComment = postedBodies.find((b) =>
      b.includes("## Needs human attention")
    );
    assertEquals(
      escalationComment,
      undefined,
      "Post-Ready DiD must skip the duplicate comment; the Ready marker " +
        `is the explanation. Got bodies: ${postedBodies.join(" | ")}`,
    );
  },
);

// ============================================================================
// 6) Post-Round-N DiD (in-run): the Round N comment is the explanation
// ============================================================================

Deno.test(
  "Issue #2209: post-Round-N DiD treats the Round N comment as the explanation and only ensures the label",
  async () => {
    const ctx = makeContext();
    let fetchCallCount = 0;
    const addedLabels: string[] = [];
    const postedBodies: string[] = [];

    const ghClient = stubGhClient({
      getIssue: () => Promise.resolve(makeIssue({ labels: ["grill-me"] })),
      addLabel: (_r, _n, label) => {
        addedLabels.push(label);
        return Promise.resolve();
      },
      postComment: (_r, _n, body) => {
        postedBodies.push(body);
        return Promise.resolve(undefined);
      },
    });
    ghClient.getIssueComments = () => {
      fetchCallCount++;
      return Promise.resolve([]);
    };

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: () =>
          Promise.resolve({
            ok: true,
            value: {
              output: `Posted ${GRILL_ME_ROUND_MARKER}1 with three questions.`,
              exitCode: 0,
              timedOut: false,
            },
          }),
      },
    });

    const result = await processGrillMe(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient,
      logger: deps.logger,
      deps,
    });
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assert(addedLabels.includes("needs-human"));
    // No "## Needs human attention" escalation comment — the Round N
    // comment IS the explanation.
    const escalationComment = postedBodies.find((b) =>
      b.includes("## Needs human attention")
    );
    assertEquals(
      escalationComment,
      undefined,
      "Post-Round-N DiD must skip the duplicate comment; the Round N " +
        "comment Claude just posted is the explanation. Got: " +
        postedBodies.join(" | "),
    );
    // Read budget unchanged — Issue #1843: prefetchedComments avoids
    // an extra getIssueComments call from the dedup scan.
    assertEquals(
      fetchCallCount,
      2,
      `Expected 2 fetches (initial + race-guard); got ${fetchCallCount}`,
    );
  },
);

// ============================================================================
// 7) Escalation routes through the shared helper — observed via behaviour,
//    not the source text of the module-under-test (Issue #2512).
//
// These replace two earlier source-text grep tests that read
// `grill_me_processor.ts` and asserted on its implementation text (no
// `addLabel(needsHumanLabel)` line, no private `escalateToHuman`
// declaration). Those were HOW-tests: renaming an internal binding or the
// private helper broke them with zero behavioural regression. The genuine
// acceptance criterion — every escalation applies `needs-human` exactly
// once and pairs it with a single explanation comment from the shared
// helper — is observable, so we drive `processGrillMe` and assert on the
// `addLabel`/`postComment` side effects instead. The cross-module "no
// direct addLabel(needsHumanLabel) outside the chokepoint" rule is already
// enforced architecturally by `needs_human_helper_only_test.ts`.
// ============================================================================

Deno.test(
  "Issue #2512: escalation applies the needs-human label exactly once (behaviour, not source text)",
  async () => {
    const ctx = makeContext();
    // Two prior failure markers → the next run escalates on the
    // consecutive-failures path, which must go through the shared helper.
    const priorComments: GitHubComment[] = [
      makeComment({
        id: 1,
        author: "testbot",
        body: `${GRILL_ME_FAILED_MARKER} previous failure 1`,
      }),
      makeComment({
        id: 2,
        author: "testbot",
        body: `${GRILL_ME_FAILED_MARKER} previous failure 2`,
      }),
    ];

    const addedLabels: string[] = [];

    const ghClient = stubGhClient({
      getIssueComments: () => Promise.resolve(priorComments),
      addLabel: (_r, _n, label) => {
        addedLabels.push(label);
        return Promise.resolve();
      },
    });

    const deps = createMockDeps();
    const result = await processGrillMe(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient,
      logger: deps.logger,
      deps,
    });
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assertEquals(result.value.escalatedToHuman, true);

    // The behavioural guarantee: `needs-human` is applied exactly once.
    // A reintroduced direct call site alongside the shared helper would
    // apply it twice and fail here — regardless of internal naming.
    const needsHumanCount = addedLabels.filter(
      (label) => label === "needs-human",
    ).length;
    assertEquals(
      needsHumanCount,
      1,
      `Expected needs-human applied exactly once; got labels: ${
        addedLabels.join(", ")
      }`,
    );
  },
);

Deno.test(
  "Issue #2512: escalation posts exactly one shared-helper explanation comment (behaviour, not source text)",
  async () => {
    const ctx = makeContext();
    const priorComments: GitHubComment[] = [
      makeComment({
        id: 1,
        author: "testbot",
        body: `${GRILL_ME_FAILED_MARKER} previous failure 1`,
      }),
      makeComment({
        id: 2,
        author: "testbot",
        body: `${GRILL_ME_FAILED_MARKER} previous failure 2`,
      }),
    ];

    const postedBodies: string[] = [];

    const ghClient = stubGhClient({
      getIssueComments: () => Promise.resolve(priorComments),
      postComment: (_r, _n, body) => {
        postedBodies.push(body);
        return Promise.resolve(undefined);
      },
    });

    const deps = createMockDeps();
    const result = await processGrillMe(ctx, {
      promptsDir: PROMPTS_DIR,
      ghClient,
      logger: deps.logger,
      deps,
    });
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assertEquals(result.value.escalatedToHuman, true);

    // The shared helper produces the canonical explanation shape (heading
    // + Why + Next step). We assert on that observable output, not on
    // whichever internal function or variable name produced it.
    const escalationComments = postedBodies.filter((b) =>
      (b.includes("## Needs human attention") ||
        b.includes("## Grill-Me Escalation")) &&
      b.includes("**Why:**") &&
      b.includes("**Next step:**")
    );
    assertEquals(
      escalationComments.length,
      1,
      `Expected exactly one shared-helper explanation comment; got bodies: ${
        postedBodies.join(" | ")
      }`,
    );
  },
);
