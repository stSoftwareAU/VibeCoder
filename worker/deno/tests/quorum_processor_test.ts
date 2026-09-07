/**
 * Tests for the Quorum worker wiring (Issue #4112, parent #4102).
 *
 * Five behaviours the wiring has to get right, each with its own failure mode:
 *
 *   1. **Dispatch ordering.** The Quorum slot runs *before* planning — Quorum
 *      decides what the plan is, planning splits it into sub-issues.
 *   2. **Label handback.** A completed run removes `quorum` and adds
 *      `needs-human`, and never applies `planning` or `work-on`. A failed run
 *      leaves `quorum` in place so the question is not silently dropped.
 *   3. **Comment structure.** The winning plan is the body; the runner-up and
 *      the judge's reasoning are attached in collapsed sections, each
 *      attributed to the agent that produced it.
 *   4. **Reserved label.** The worker refuses to self-apply `quorum`.
 *   5. **Degradation.** A degraded run publishes what survived and names the
 *      degradation — it never promotes a survivor to "winner".
 *
 * Every test drives the real code with fakes — no GitHub, no subprocess.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

import { captureReleaseOutcomes } from "./fixtures/release_outcome_capture.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildQuorumComment,
  hasQuorumResultBeenPosted,
  processQuorum,
  QUORUM_DEGRADED_MARKER,
  QUORUM_FAILED_MARKER,
  QUORUM_WINNER_MARKER,
  sanitisePlanForComment,
} from "../lib/quorum_processor.ts";
import {
  buildPriorityDispatchTable,
  type PriorityHandlerResult,
  type RunCoreDeps,
} from "../lib/run_core.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import {
  buildDefaultWorkerConfig,
  isReservedLabel,
  LABEL_DEFAULTS,
  PHASE_EFFORT_DEFAULTS,
  PHASE_MODEL_DEFAULTS,
} from "../lib/config_defaults.ts";
import { assertWorkerCanApplyLabel } from "../lib/worker_label_guard.ts";
import { OPERATIONAL_LABEL_NAMES } from "../lib/label_security.ts";
import { operationalDispatchLabels } from "../lib/operational_dispatch_labels.ts";
import { getLabelByName } from "../setup/label_definitions.ts";
import type {
  QuorumModelFields,
  QuorumRunResult,
} from "../lib/quorum_orchestrator.ts";
import type { GitHubComment, GitHubIssue, WorkerConfig } from "../types.ts";
import type { RunStats } from "../lib/run_stats.ts";
import type { IssueContext } from "../lib/issue_worker.ts";
import { DEGRADED_MODEL_LABEL } from "../lib/planning_degraded_label.ts";
import { FABLE_PREFLIGHT_DEGRADED_REASON } from "../lib/fable_routing.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844)
// — named as a parameter on every call rather than pinned by deleting the
// host's overrides from the shared process environment (Issue #1024).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return buildDefaultWorkerConfig({
    workDir: "/tmp/quorum-test",
    ...overrides,
  });
}

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 4112,
    issueTitle: "Wire Quorum into the worker",
    issueBody: "Run a plan-off before planning.",
    issueLabels: ["quorum"],
    issueComments: "",
    githubUser: "testbot",
    config: makeConfig(),
    ...overrides,
  };
}

function makeIssue(labels: string[] = ["quorum"]): GitHubIssue {
  return {
    number: 4112,
    title: "Wire Quorum into the worker",
    body: "",
    labels,
    author: "human",
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

/** What a fake GitHub client recorded. */
interface Recorded {
  added: string[];
  removed: string[];
  posted: string[];
  unassigned: number;
}

function stubGhClient(
  recorded: Recorded,
  comments: GitHubComment[] = [],
  options: { commentsThrow?: boolean; postThrows?: boolean } = {},
) {
  return {
    getIssue: () => Promise.resolve(makeIssue()),
    getIssueComments: () =>
      options.commentsThrow
        ? Promise.reject(new Error("gh api failed"))
        : Promise.resolve(comments),
    addLabel: (_r: string, _n: number, label: string) => {
      recorded.added.push(label);
      return Promise.resolve();
    },
    removeLabel: (_r: string, _n: number, label: string) => {
      recorded.removed.push(label);
      return Promise.resolve();
    },
    postComment: (_r: string, _n: number, body: string) => {
      if (options.postThrows) return Promise.reject(new Error("post failed"));
      recorded.posted.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => {
      recorded.unassigned++;
      return Promise.resolve();
    },
    closeIssue: () => Promise.resolve(),
  };
}

/** A well-formed judge verdict block. */
function verdictBlock(winner: "A" | "B", reasoning: string): string {
  return `<quorum_verdict>\n${
    JSON.stringify({ winner, reasoning })
  }\n</quorum_verdict>`;
}

/**
 * Mock deps whose agent invocations reply per phase.
 *
 * Drafts are started in A-then-B order, so `drafts[0]` is the plan at
 * position A and `drafts[1]` the plan at position B. `model` adds the
 * served-model observation the runner reports back (Issue #4434), keyed by
 * phase so a run can degrade on the judgement alone.
 */
function mockDepsWithAgents(
  replies: {
    drafts: Array<string | Error>;
    judge: string | Error;
    model?: (phase: string) => QuorumModelFields;
  },
  depsOverrides?: Parameters<typeof createMockDeps>[0],
) {
  let draftIndex = 0;
  return createMockDeps({
    ...depsOverrides,
    claude: {
      // deno-lint-ignore no-explicit-any
      runClaudeWithRetry: ((options: any) => {
        const reply = options.phase === "quorum_judge"
          ? replies.judge
          : replies.drafts[draftIndex++] ?? "";
        if (reply instanceof Error) {
          return Promise.resolve({ ok: false, error: reply });
        }
        return Promise.resolve({
          ok: true,
          value: {
            exitCode: 0,
            output: reply,
            timedOut: false,
            ...(replies.model?.(options.phase) ?? {}),
          },
        });
        // deno-lint-ignore no-explicit-any
      }) as any,
    },
  });
}

/** Per-run stats a fake invocation reports for a served model. */
function servedStats(model: string): RunStats {
  return {
    servedModels: [model],
    requestedModel: "fable",
    effort: "high",
    wallClockMs: 1000,
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  };
}

/** A gh runner that records the labels added to each issue. */
function labelRecordingGh() {
  const addLabelCalls: Array<{ issue: number; label: string }> = [];
  const runGhCommand = (args: string[]): Promise<string> => {
    if (args[0] === "label" && args[1] === "list") return Promise.resolve("[]");
    const labelArg = args.find((a) => a.startsWith("labels[]="));
    if (labelArg) {
      const idx = args.findIndex((a) => /\/issues\/\d+\/labels$/.test(a));
      const issue = idx >= 0
        ? parseInt(args[idx]!.match(/\/issues\/(\d+)\/labels$/)![1]!, 10)
        : -1;
      addLabelCalls.push({ issue, label: labelArg.replace("labels[]=", "") });
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const li = args.findIndex((a) => a === "--add-label");
      addLabelCalls.push({
        issue: parseInt(args[2]!, 10),
        label: li >= 0 ? args[li + 1]! : "",
      });
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
  return { runGhCommand, addLabelCalls };
}

// ---------------------------------------------------------------------------
// 1) Dispatch slot ordering
// ---------------------------------------------------------------------------

Deno.test("quorum dispatch - the Quorum slot runs before the planning slot", () => {
  const table = buildPriorityDispatchTable({} as RunCoreDeps);
  const quorum = table.findIndex((h) => h.name === "Quorum Plan-Off");
  const planning = table.findIndex((h) => h.name === "Planning Mode");
  const grillMe = table.findIndex((h) => h.name === "Grill-Me Clarification");

  assert(quorum >= 0, "Quorum has no dispatch slot");
  assert(
    quorum < planning,
    `Quorum (index ${quorum}) must dispatch before planning (index ${planning})`,
  );
  assert(
    grillMe < quorum,
    "Quorum should follow grill-me, so a grilled issue plans off afterwards",
  );
  assert(
    table[quorum]!.priority < table[planning]!.priority,
    "Quorum's priority number must sort ahead of planning's",
  );
});

Deno.test("quorum dispatch - the slot invokes findAndProcessQuorum", async () => {
  const calls: string[] = [];
  const deps = {
    findAndProcessQuorum: () => {
      calls.push("quorum");
      return Promise.resolve({
        ok: true as const,
        value: { processed: true },
      });
    },
  } as unknown as RunCoreDeps;

  const table = buildPriorityDispatchTable(deps);
  const slot = table.find((h) => h.name === "Quorum Plan-Off")!;
  const result = await slot.execute();

  assertEquals(calls, ["quorum"]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals((result.value as PriorityHandlerResult).processed, true);
  }
});

Deno.test("quorum dispatch - the slot is a no-op when the host wires no handler", async () => {
  const table = buildPriorityDispatchTable({} as RunCoreDeps);
  const slot = table.find((h) => h.name === "Quorum Plan-Off")!;
  const result = await slot.execute();

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals((result.value as PriorityHandlerResult).processed, false);
  }
});

// ---------------------------------------------------------------------------
// 2) Label handback
// ---------------------------------------------------------------------------

Deno.test("quorum labels - a completed run removes quorum, adds needs-human, and applies no next phase", async () => {
  const recorded: Recorded = {
    added: [],
    removed: [],
    posted: [],
    unassigned: 0,
  };
  const ctx = makeContext();
  const capture = captureReleaseOutcomes();
  const quorumDeps = mockDepsWithAgents({
    drafts: ["Plan from the first drafter.", "Plan from the second drafter."],
    judge: verdictBlock("A", "Plan A handles the migration order."),
  });
  quorumDeps.crashHandling.clearHeartbeat = capture.clearHeartbeat;
  const result = await processQuorum(ctx, {
    promptsDir: PROMPTS_DIR,
    ghClient: stubGhClient(recorded),
    logger: createMockDeps().logger,
    deps: quorumDeps,
  });
  capture.restore();
  // The completed run reports a deliberate no-PR on both the release
  // helper and the heartbeat clear (Issue #4330).
  assertEquals(capture.hooked.at(-1)?.outcome?.kind, "no_pr_expected");
  assertEquals(capture.cleared.at(-1)?.outcome?.kind, "no_pr_expected");

  assertEquals(result.ok, true, `run failed: ${!result.ok && result.error}`);
  if (!result.ok) return;

  assertEquals(result.value.outcome, "judged");
  assertEquals(result.value.commentPosted, true);
  assertEquals(result.value.labelRemoved, true);
  assert(
    recorded.removed.includes("quorum"),
    `expected quorum removed, got ${JSON.stringify(recorded.removed)}`,
  );
  assert(
    recorded.added.includes("needs-human"),
    `expected needs-human added, got ${JSON.stringify(recorded.added)}`,
  );
  for (const forbidden of ["planning", "work-on", "top-priority"]) {
    assert(
      !recorded.added.includes(forbidden),
      `Quorum must never apply '${forbidden}' — the human picks the next phase`,
    );
  }
  assert(recorded.unassigned > 0, "the worker must release its claim");
});

Deno.test("quorum labels - a failed run posts the failure marker and keeps quorum in place", async () => {
  const recorded: Recorded = {
    added: [],
    removed: [],
    posted: [],
    unassigned: 0,
  };
  const capture = captureReleaseOutcomes();
  const quorumDeps = mockDepsWithAgents({
    drafts: [new Error("alpha exploded"), new Error("bravo exploded")],
    judge: "unused",
  });
  quorumDeps.crashHandling.clearHeartbeat = capture.clearHeartbeat;
  const result = await processQuorum(makeContext(), {
    promptsDir: PROMPTS_DIR,
    ghClient: stubGhClient(recorded),
    logger: createMockDeps().logger,
    deps: quorumDeps,
  });
  capture.restore();
  // The failed run reports a diagnosed no_pr on both paths (Issue #4330).
  assertEquals(capture.hooked.at(-1)?.outcome?.kind, "no_pr");
  assertEquals(capture.cleared.at(-1)?.outcome?.kind, "no_pr");

  assertEquals(result.ok, false, "both drafters failing must fail loudly");
  const failure = recorded.posted.find((b) => b.includes(QUORUM_FAILED_MARKER));
  assert(failure !== undefined, "expected a Quorum Failed marker comment");
  assertStringIncludes(failure!, "🤖 Processed by: testbot");
  assertEquals(
    recorded.removed.includes("quorum"),
    false,
    "a failed run must leave `quorum` on so the run can be retried",
  );
  assert(recorded.unassigned > 0, "a failed run must still release the claim");
});

Deno.test("quorum labels - a fetch failure fails loudly rather than posting a plan", async () => {
  const recorded: Recorded = {
    added: [],
    removed: [],
    posted: [],
    unassigned: 0,
  };
  const result = await processQuorum(makeContext(), {
    promptsDir: PROMPTS_DIR,
    ghClient: stubGhClient(recorded, [], { commentsThrow: true }),
    logger: createMockDeps().logger,
    deps: mockDepsWithAgents({
      drafts: ["a", "b"],
      judge: verdictBlock("A", "r"),
    }),
  });

  assertEquals(result.ok, false);
  assert(recorded.posted.some((b) => b.includes(QUORUM_FAILED_MARKER)));
});

Deno.test("quorum labels - a result already in the thread is not re-run", async () => {
  const recorded: Recorded = {
    added: [],
    removed: [],
    posted: [],
    unassigned: 0,
  };
  const prior: GitHubComment[] = [{
    id: 7,
    body: `${QUORUM_WINNER_MARKER}\n\nA plan.`,
    author: "testbot",
    createdAt: "2026-01-01T00:00:00Z",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  }];

  let invocations = 0;
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (() => {
        invocations++;
        return Promise.resolve({
          ok: true,
          value: { exitCode: 0, output: "", timedOut: false },
        });
        // deno-lint-ignore no-explicit-any
      }) as any,
    },
  });

  const result = await processQuorum(makeContext(), {
    promptsDir: PROMPTS_DIR,
    ghClient: stubGhClient(recorded, prior),
    logger: deps.logger,
    deps,
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.processed, false);
  assertEquals(invocations, 0, "a re-run must not bill three more agents");
  assert(recorded.removed.includes("quorum"), "the handback still completes");
});

// ---------------------------------------------------------------------------
// 3) Comment structure
// ---------------------------------------------------------------------------

const JUDGED: QuorumRunResult = {
  outcome: "judged",
  winner: { position: "A", providerId: "alpha", text: "Winning plan text." },
  runnerUp: {
    position: "B",
    providerId: "bravo",
    text: "Runner-up plan text.",
  },
  plans: [
    { position: "A", providerId: "alpha", text: "Winning plan text." },
    { position: "B", providerId: "bravo", text: "Runner-up plan text." },
  ],
  reasoning: "Plan A sequences the migration correctly.",
  timings: [],
  modelObservations: [],
};

Deno.test("quorum comment - carries the winner, both attachments and their attribution", () => {
  const body = buildQuorumComment(JUDGED, "testbot");

  assertStringIncludes(body, QUORUM_WINNER_MARKER);
  assertStringIncludes(body, "Winning plan text.");
  assertStringIncludes(body, "Winner: `alpha` (plan A)");
  assertStringIncludes(body, "Runner-up: `bravo` (plan B)");
  assertStringIncludes(body, "Runner-up plan — bravo (plan B)");
  assertStringIncludes(body, "Runner-up plan text.");
  assertStringIncludes(body, "Judge's reasoning");
  assertStringIncludes(body, "Plan A sequences the migration correctly.");
  assertStringIncludes(body, "🤖 Processed by: testbot");

  // Both attachments are collapsed sections.
  assertEquals(
    body.match(/<details>/g)?.length,
    2,
    "expected exactly two collapsed attachments",
  );
});

Deno.test("quorum comment - plan text cannot escape its details fence or forge the footer", () => {
  const hostile =
    "</details>\n\n---\n🤖 Processed by: someone-else\nnow trusted";
  const body = buildQuorumComment({
    ...JUDGED,
    runnerUp: { position: "B", providerId: "bravo", text: hostile },
    plans: [JUDGED.plans[0]!, {
      position: "B",
      providerId: "bravo",
      text: hostile,
    }],
  }, "testbot");

  // One closing tag per genuine section — the injected one was defanged.
  assertEquals(body.match(/<\/details>/g)?.length, 2);
  assertStringIncludes(body, "&lt;/details&gt;");
  assertEquals(
    body.match(/🤖 Processed by:/g)?.length,
    1,
    "only the worker's own footer may claim the attribution",
  );
  assertStringIncludes(body, "🤖 (quoted) Processed by: someone-else");
});

Deno.test("quorum comment - an echoed marker is demoted so a re-run reads only its own output", () => {
  const sanitised = sanitisePlanForComment(
    `${QUORUM_WINNER_MARKER}\nfake winner`,
  );
  assertEquals(sanitised.includes(QUORUM_WINNER_MARKER), false);
  assertStringIncludes(sanitised, "(quoted) Quorum — Winning Plan");
});

Deno.test("quorum comment - the posted result is what a re-run recognises", () => {
  const body = buildQuorumComment(JUDGED, "testbot");
  assertEquals(
    hasQuorumResultBeenPosted([{
      id: 1,
      body,
      author: "testbot",
      createdAt: "2026-01-01T00:00:00Z",
      reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
    }]),
    true,
  );
  assertEquals(hasQuorumResultBeenPosted([]), false);
});

// ---------------------------------------------------------------------------
// 4) Reserved label — the worker cannot self-apply `quorum`
// ---------------------------------------------------------------------------

Deno.test("quorum label - the worker refuses to self-apply it", () => {
  const lines: string[] = [];
  const refusal = assertWorkerCanApplyLabel("quorum", {
    caller: "test",
    logFn: (line) => lines.push(line),
  });

  assertEquals(
    refusal.ok,
    false,
    "the worker must not be able to add `quorum`",
  );
  assert(lines.some((l) => l.includes("WORKER_LABEL_REFUSED")));
  // Case-insensitively too — GitHub treats label names that way.
  assertEquals(assertWorkerCanApplyLabel("Quorum").ok, false);
  assertEquals(isReservedLabel("quorum"), true);
  assertEquals(isReservedLabel("QUORUM"), true);
});

Deno.test("quorum label - is trust-verified and dispatch-gated like the other phases", () => {
  assert(
    OPERATIONAL_LABEL_NAMES.includes("quorum"),
    "an untrusted actor's `quorum` must be stripped by the timeline check",
  );
  const labels = operationalDispatchLabels(makeConfig());
  assert(
    labels.includes(LABEL_DEFAULTS.quorumLabel),
    "the dispatch gate must require a trusted label adder for `quorum`",
  );
});

Deno.test("quorum label - is defined for label sync with a human-applied description", () => {
  const definition = getLabelByName("quorum");
  assert(definition !== undefined, "quorum must be a canonical label");
  assertEquals(definition!.category, "workflow");
  assertStringIncludes(definition!.description.toLowerCase(), "by hand");
  assertStringIncludes(definition!.description.toLowerCase(), "quorum");
});

Deno.test("quorum config - both phases route to the planning-shaped tier", () => {
  assertEquals(PHASE_MODEL_DEFAULTS["quorum"], "fable");
  assertEquals(PHASE_MODEL_DEFAULTS["quorum_judge"], "fable");
  assertEquals(PHASE_EFFORT_DEFAULTS["quorum"], "high");
  assertEquals(PHASE_EFFORT_DEFAULTS["quorum_judge"], "high");

  const config = makeConfig();
  assertEquals(config.quorumLabel, "quorum");
  assertEquals(config.quorumPlanners.length, 2);
  assertEquals(config.quorumJudge, "claude");
  assert(config.quorumTimeout > 0 && config.quorumKillAfter >= 0);
});

// ---------------------------------------------------------------------------
// 5) Degradation
// ---------------------------------------------------------------------------

Deno.test("quorum degradation - a lost drafter posts the survivor and names the degradation", async () => {
  const recorded: Recorded = {
    added: [],
    removed: [],
    posted: [],
    unassigned: 0,
  };
  const result = await processQuorum(makeContext(), {
    promptsDir: PROMPTS_DIR,
    ghClient: stubGhClient(recorded),
    logger: createMockDeps().logger,
    deps: mockDepsWithAgents({
      drafts: ["The surviving plan.", new Error("bravo exploded")],
      judge: verdictBlock("A", "never reached"),
    }),
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.outcome, "unjudged-single");
  assert(
    result.value.degradation !== undefined,
    "the degradation must be named",
  );

  const body = recorded.posted.find((b) => b.includes(QUORUM_DEGRADED_MARKER));
  assert(body !== undefined, "expected a degraded-result comment");
  assertStringIncludes(body!, "no plan is presented as the winner");
  assertStringIncludes(body!, "The surviving plan.");
  assertStringIncludes(body!, "bravo exploded");
  assertEquals(
    body!.includes(QUORUM_WINNER_MARKER),
    false,
    "a degraded run must never invent a winner",
  );
  assert(recorded.removed.includes("quorum"), "the handback still happens");
  assert(recorded.added.includes("needs-human"));
});

// ---------------------------------------------------------------------------
// 6) Degraded-model reporting (Issue #4434)
// ---------------------------------------------------------------------------

Deno.test("quorum model stats - a Fable→Opus reroute labels the issue and posts one stats comment", async () => {
  const recorded: Recorded = {
    added: [],
    removed: [],
    posted: [],
    unassigned: 0,
  };
  const gh = labelRecordingGh();
  const result = await processQuorum(makeContext(), {
    promptsDir: PROMPTS_DIR,
    ghClient: stubGhClient(recorded),
    logger: createMockDeps().logger,
    deps: mockDepsWithAgents({
      drafts: ["Plan from the first drafter.", "Plan from the second drafter."],
      judge: verdictBlock("A", "Plan A handles the migration order."),
      // Fable was unavailable pre-flight, so every invocation ran on Opus @ max.
      model: () => ({
        runStats: servedStats("claude-opus-4-8"),
        preflightDegraded: true,
        preflightDegradedReason: FABLE_PREFLIGHT_DEGRADED_REASON,
      }),
    }, { github: { runGhCommand: gh.runGhCommand } }),
  });

  assertEquals(result.ok, true, `run failed: ${!result.ok && result.error}`);

  // One `degraded-model` label on the plan-off issue — not one per agent.
  const degraded = gh.addLabelCalls.filter((c) =>
    c.label === DEGRADED_MODEL_LABEL
  );
  assertEquals(degraded.length, 1, "expected exactly one degraded-model label");
  assertEquals(degraded[0]!.issue, 4112);

  // One stats comment, covering all three invocations, beside the result.
  const stats = recorded.posted.filter((b) =>
    b.includes("## Quorum run model stats")
  );
  assertEquals(stats.length, 1, "expected exactly one stats comment");
  assertStringIncludes(stats[0]!, "**Quorum invocations:** 3");
  assertStringIncludes(stats[0]!, "claude-opus-4-8");
  assertStringIncludes(stats[0]!, "Degraded:");
  assert(
    recorded.posted.some((b) => b.includes(QUORUM_WINNER_MARKER)),
    "the winning plan is still published",
  );
});

Deno.test("quorum model stats - a healthy plan-off adds no label and no stats comment", async () => {
  const recorded: Recorded = {
    added: [],
    removed: [],
    posted: [],
    unassigned: 0,
  };
  const gh = labelRecordingGh();
  const result = await processQuorum(makeContext(), {
    promptsDir: PROMPTS_DIR,
    ghClient: stubGhClient(recorded),
    logger: createMockDeps().logger,
    deps: mockDepsWithAgents({
      drafts: ["Plan from the first drafter.", "Plan from the second drafter."],
      judge: verdictBlock("B", "Plan B is the smaller change."),
      model: () => ({ runStats: servedStats("claude-fable-5-1-20260901") }),
    }, { github: { runGhCommand: gh.runGhCommand } }),
  });

  assertEquals(result.ok, true);
  assertEquals(
    gh.addLabelCalls.filter((c) => c.label === DEGRADED_MODEL_LABEL).length,
    0,
    "a healthy plan-off must not be labelled degraded",
  );
  assertEquals(
    recorded.posted.filter((b) => b.includes("run model stats")).length,
    0,
    "a healthy plan-off posts only its result comment",
  );
});

Deno.test("quorum model stats - a degraded run still reports when the judgement was lost", async () => {
  const recorded: Recorded = {
    added: [],
    removed: [],
    posted: [],
    unassigned: 0,
  };
  const gh = labelRecordingGh();
  const result = await processQuorum(makeContext(), {
    promptsDir: PROMPTS_DIR,
    ghClient: stubGhClient(recorded),
    logger: createMockDeps().logger,
    deps: mockDepsWithAgents({
      drafts: ["Plan one text.", "Plan two text."],
      judge: new Error("judgy exploded"),
      model: (phase) =>
        phase === "quorum_judge"
          ? {}
          : { runStats: servedStats("claude-opus-4-8") },
    }, { github: { runGhCommand: gh.runGhCommand } }),
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.outcome, "unjudged-both");
  assertEquals(
    gh.addLabelCalls.filter((c) => c.label === DEGRADED_MODEL_LABEL).length,
    1,
    "a run that degraded before judgement still reports its reroute",
  );
  assert(
    recorded.posted.some((b) => b.includes("## Quorum run model stats")),
    "the label must be paired with the figures that justify it",
  );
});

Deno.test("quorum degradation - an unreadable verdict publishes both plans unjudged", async () => {
  const recorded: Recorded = {
    added: [],
    removed: [],
    posted: [],
    unassigned: 0,
  };
  const result = await processQuorum(makeContext(), {
    promptsDir: PROMPTS_DIR,
    ghClient: stubGhClient(recorded),
    logger: createMockDeps().logger,
    deps: mockDepsWithAgents({
      drafts: ["Plan one text.", "Plan two text."],
      judge: "I could not decide.",
    }),
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.outcome, "unjudged-both");

  const body = recorded.posted.find((b) => b.includes(QUORUM_DEGRADED_MARKER))!;
  assertStringIncludes(body, "Plan one text.");
  assertStringIncludes(body, "Plan two text.");
  assertEquals(
    body.match(/<details>/g)?.length,
    2,
    "both surviving plans are attached, neither promoted",
  );
});
