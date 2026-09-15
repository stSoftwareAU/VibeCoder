/**
 * The repair rung's prompt and its budget (Issue #1965).
 *
 * A repair run answers a verification failure, not a conflicted tree, so its
 * prompt must say so: the gate's failing command and output, the merged-in
 * commits' subjects, and the never-side-pick contract unchanged — all of the
 * repository-produced text inside this run's untrusted fence. And it is a
 * second run against the cycle's single grant, so it is refused by name when
 * that grant no longer covers one.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type MergeConflictAgentRequest,
  runMergeConflictAgent,
} from "../lib/merge_conflict_agent.ts";
import { bindMilestoneConflictAgent } from "../lib/milestone_conflict_agent_binding.ts";
import {
  isGateRepairBudgetExhausted,
  MIN_GATE_REPAIR_SECONDS,
} from "../lib/milestone_gate_repair.ts";
import type { ClaudeRunResult } from "../lib/claude_runner.ts";
import type { Logger, Result, WorkerConfig } from "../types.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

function silentLogger(): Logger {
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

type RunAgent = MergeConflictAgentRequest["runAgent"];
type RunAgentOptions = Parameters<RunAgent>[0];

interface Captured {
  prompts: string[];
  options: RunAgentOptions[];
}

function makeRunner(captured: Captured): RunAgent {
  return (options: RunAgentOptions): Promise<Result<ClaudeRunResult>> => {
    captured.prompts.push(options.prompt);
    captured.options.push(options);
    return Promise.resolve({
      ok: true,
      value: {
        output: "repaired",
        exitCode: 0,
        timedOut: false,
      } as ClaudeRunResult,
    });
  };
}

/** The gate failure the repair answers, in the shape the gate reports it. */
const REPAIR = {
  round: 1,
  maxRounds: 2,
  failingCommand: "deno task check in /work/repo failed (exit 1)",
  output: "error[E0046]: not all trait items implemented, missing: " +
    "`find_by_client_order_id`",
  mergedCommitSubjects: ["Issue #284: add find_by_client_order_id to Broker"],
} as const;

Deno.test("merge conflict prompt - a repair run carries the gate output, fenced, and reframes the merge as committed (Issue #1965)", async () => {
  const captured: Captured = { prompts: [], options: [] };
  const outcome = await runMergeConflictAgent({
    repo: "stSoftwareAU/GRQ-AutoTrader",
    target: { kind: "branch", intoBranch: "milestone/168-execution" },
    baseBranch: "Develop",
    conflictedFiles: ["docs/development.md"],
    workDir: "/tmp/nonexistent-gate-repair",
    promptsDir: PROMPTS_DIR,
    logger: silentLogger(),
    repair: {
      ...REPAIR,
      mergedCommitSubjects: [...REPAIR.mergedCommitSubjects],
    },
    runAgent: makeRunner(captured),
  });

  assertEquals(outcome.ok, true);
  const prompt = captured.prompts[0]!;
  assertStringIncludes(prompt, "Repair Mode");
  assertStringIncludes(prompt, "repair round 1 of 2");
  assertStringIncludes(prompt, "already resolved and committed");
  assertStringIncludes(prompt, "the verification the worker runs before it");
  assertStringIncludes(prompt, REPAIR.output);
  assertStringIncludes(prompt, REPAIR.failingCommand);
  assertStringIncludes(prompt, REPAIR.mergedCommitSubjects[0]);
  assertStringIncludes(
    prompt,
    "the failed verification output and merged commit subjects quoted below",
    "the boundary instruction covers the new fence",
  );
  assertStringIncludes(
    prompt,
    "both sides survive",
    "the never-side-pick contract is unchanged",
  );
  assertEquals(
    /\{\{[A-Z_]+\}\}/.test(prompt),
    false,
    "no placeholder is left unrendered",
  );

  // The gate output and the commit subjects are repository text: both belong
  // inside this run's fence, never spliced into the worker's own prose.
  const id = prompt.match(/BOUNDARY_([0-9a-f]{12})/)?.[1];
  assert(id, "the prompt carries a boundary id");
  const start = `---BEGIN UNTRUSTED USER CONTENT BOUNDARY_${id}---`;
  const end = `---END UNTRUSTED USER CONTENT BOUNDARY_${id}---`;
  const fenced: string[] = [];
  let cursor = 0;
  while (true) {
    const open = prompt.indexOf(start, cursor);
    if (open === -1) break;
    const close = prompt.indexOf(end, open);
    if (close === -1) break;
    fenced.push(prompt.slice(open + start.length, close));
    cursor = close + end.length;
  }
  assert(
    fenced.some((region) => region.includes(REPAIR.output)),
    "the compiler output is fenced",
  );
  assert(
    fenced.some((region) =>
      region.includes(REPAIR.mergedCommitSubjects[0] as string)
    ),
    "the merged commit subjects are fenced",
  );
});

Deno.test("merge conflict prompt - an ordinary resolution renders no repair block (Issue #1965)", async () => {
  const captured: Captured = { prompts: [], options: [] };
  await runMergeConflictAgent({
    repo: "stSoftwareAU/GRQ-AutoTrader",
    target: { kind: "branch", intoBranch: "milestone/168-execution" },
    baseBranch: "Develop",
    conflictedFiles: ["docs/development.md"],
    workDir: "/tmp/nonexistent-gate-repair",
    promptsDir: PROMPTS_DIR,
    logger: silentLogger(),
    runAgent: makeRunner(captured),
  });

  const prompt = captured.prompts[0]!;
  assertEquals(prompt.includes("Repair Mode"), false);
  assertStringIncludes(prompt, "already in progress in your working tree");
  assertEquals(/\{\{[A-Z_]+\}\}/.test(prompt), false);
});

/** A config carrying only what the binding reads. */
function config(claudeTimeout: number): WorkerConfig {
  return {
    claudeTimeout,
    claudeNoOutputTimeout: 300,
    maxRateLimitRetries: 3,
    repoConfig: {},
  } as unknown as WorkerConfig;
}

Deno.test("bindMilestoneConflictAgent - a repair gets what is left of the cycle's grant (Issue #1965)", async () => {
  const captured: Captured = { prompts: [], options: [] };
  let nowMs = 1_000_000;
  const agentFn = bindMilestoneConflictAgent({
    repo: "stSoftwareAU/GRQ-AutoTrader",
    grant: { agentAllowed: true, agentTimeoutSeconds: 900 },
    config: config(3600),
    logger: silentLogger(),
    promptsDir: PROMPTS_DIR,
    runAgent: makeRunner(captured),
    now: () => nowMs,
  });
  assert(agentFn, "an allowed grant binds the rung");

  const request = {
    conflictedFiles: ["docs/development.md"],
    milestoneBranch: "milestone/168-execution",
    defaultBranch: "Develop",
    workDir: "/tmp/nonexistent-gate-repair",
  };
  await agentFn(request);
  assertEquals(
    captured.options[0]!.timeoutSeconds,
    900,
    "the first run gets the whole grant, exactly as before",
  );

  // Ten minutes of agent run and verification later.
  nowMs += 600_000;
  await agentFn({
    ...request,
    repair: { ...REPAIR, mergedCommitSubjects: [] },
  });
  assertEquals(
    captured.options[1]!.timeoutSeconds,
    300,
    "the repair gets what the first run and the gate left, not a fresh grant",
  );
  assertStringIncludes(captured.prompts[1]!, "Repair Mode");
});

Deno.test("bindMilestoneConflictAgent - a repair the grant cannot cover is refused by name (Issue #1965)", async () => {
  const captured: Captured = { prompts: [], options: [] };
  let nowMs = 1_000_000;
  const agentFn = bindMilestoneConflictAgent({
    repo: "stSoftwareAU/GRQ-AutoTrader",
    grant: { agentAllowed: true, agentTimeoutSeconds: 600 },
    config: config(3600),
    logger: silentLogger(),
    promptsDir: PROMPTS_DIR,
    runAgent: makeRunner(captured),
    now: () => nowMs,
  })!;

  const request = {
    conflictedFiles: ["docs/development.md"],
    milestoneBranch: "milestone/168-execution",
    defaultBranch: "Develop",
    workDir: "/tmp/nonexistent-gate-repair",
  };
  await agentFn(request);
  nowMs += 590_000;
  const repair = await agentFn({
    ...request,
    repair: { ...REPAIR, mergedCommitSubjects: [] },
  });

  assertEquals(repair.ok, false);
  assert(
    !repair.ok && isGateRepairBudgetExhausted(repair.error),
    "the refusal is the budget one, so the sync reports a repair never run",
  );
  assert(
    !repair.ok && repair.error.message.includes(`${MIN_GATE_REPAIR_SECONDS}s`),
    `the refusal says what a repair needs: ${
      !repair.ok && repair.error.message
    }`,
  );
  assertEquals(captured.options.length, 1, "no agent run was started");
});

Deno.test("bindMilestoneConflictAgent - an unbounded pass keeps the configured timeout on both runs (Issue #1965)", async () => {
  const captured: Captured = { prompts: [], options: [] };
  const agentFn = bindMilestoneConflictAgent({
    repo: "stSoftwareAU/GRQ-AutoTrader",
    grant: { agentAllowed: true },
    config: config(1800),
    logger: silentLogger(),
    promptsDir: PROMPTS_DIR,
    runAgent: makeRunner(captured),
  })!;

  const request = {
    conflictedFiles: ["docs/development.md"],
    milestoneBranch: "milestone/168-execution",
    defaultBranch: "Develop",
    workDir: "/tmp/nonexistent-gate-repair",
  };
  await agentFn(request);
  const repair = await agentFn({
    ...request,
    repair: { ...REPAIR, mergedCommitSubjects: [] },
  });

  assertEquals(repair.ok, true, "a pass with no deadline refuses no repair");
  assertEquals(captured.options[0]!.timeoutSeconds, 1800);
  assertEquals(captured.options[1]!.timeoutSeconds, 1800);
});
