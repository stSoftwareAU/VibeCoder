/**
 * Issue #4061: the main loop's `processIssue` must hand the clarity phase the
 * authored comment rows its issue fetch already returned.
 *
 * The clarity phase counts clarification rounds from `issueCommentRows`
 * (Issue #1263 — authored rows only, never the untrusted `issueComments`
 * blob). The main loop built its context without them, so every issue logged
 * "No authored comment rows …", the count was always zero, and the
 * `maxClarificationRounds` escape could never trigger.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { captureContentSnapshot } from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { CLARIFICATION_HEADING } from "../lib/label_clarification.ts";
import { workOnIssueClarityPhase } from "../lib/phases/clarity_assessment_phase.ts";
import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../lib/issue_worker_types.ts";
import type { Logger } from "../types.ts";
import { envFrom } from "./support/env_lookup.ts";

const REPO = "org/repo";
const ISSUE = 42;
const USER = "fleet-bot";
// Vague on purpose: the heuristic alone would ask for clarification again.
const TITLE = "Improve things";
const BODY = "Make it better.";

function silentLogger(warnings: string[] = []): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: (message: string) => warnings.push(message),
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

async function runMainLoopClarity(rounds: number): Promise<{
  result: PhaseResult;
  state: PhaseState;
  warnings: string[];
}> {
  const root = await Deno.makeTempDir();
  const config = {
    ...buildDefaultWorkerConfig(),
    workDir: root,
    allowedAuthors: [USER],
  };
  const snapshot = await captureContentSnapshot(
    resolveContentApprovalStateDir(root),
    REPO,
    ISSUE,
    TITLE,
    BODY,
    USER,
  );
  assert(snapshot.ok);
  const comments = Array.from({ length: rounds }, (_, i) => ({
    author: { login: USER },
    body: `${CLARIFICATION_HEADING}\n\n- Round ${i + 1}: what is "better"?`,
  }));
  const warnings: string[] = [];
  const worker = createMockDeps({
    logger: silentLogger(warnings),
    github: {
      runGhCommand: () =>
        Promise.resolve(JSON.stringify({
          title: TITLE,
          body: BODY,
          author: { login: USER },
          labels: [{ name: "work-on" }],
          comments,
          state: "OPEN",
        })),
    },
  });
  let observed: { result: PhaseResult; state: PhaseState } | undefined;
  const production = await createProductionRunCoreDeps({
    repoDir: root,
    workDir: root,
    githubUser: USER,
    logger: silentLogger(),
    config,
    workerDeps: worker,
    env: envFrom({ HOME: root }),
    workOnIssue: async (ctx: IssueContext, deps) => {
      const state: PhaseState = {
        branchName: `issue-${ISSUE}-improve-things`,
        baseBranch: "main",
        defaultBranch: "main",
        repoPath: root,
        clarityStatus: "not_assessed",
        claudeOutput: "",
        executeStartTime: 0,
        baselineQualityPassed: true,
        baselineQualityOutput: "",
      };
      const result = await workOnIssueClarityPhase(ctx, state, deps!);
      observed = { result, state };
      return {
        success: true,
        category: "unknown" as const,
        expectedSkip: false,
        phase: "clarity",
        reason: "observed",
        timings: {},
      };
    },
  });
  try {
    const processed = await production.deps.processIssue({
      repo: REPO,
      issueNumber: ISSUE,
      issueTitle: TITLE,
      milestoneTitle: "",
    });
    assert(processed.ok);
  } finally {
    production.cleanup();
    await Deno.remove(root, { recursive: true });
  }
  assert(observed, "the main loop ran the clarity phase");
  return { ...observed, warnings };
}

const NO_ROWS_WARNING = "No authored comment rows";

Deno.test("main loop - fleet-authored rounds reach the max-rounds skip (Issue #4061)", async () => {
  const max = buildDefaultWorkerConfig().maxClarificationRounds;
  const { result, state, warnings } = await runMainLoopClarity(max);
  assertEquals(result.status, "continue");
  assertEquals(state.clarityStatus, "skipped");
  assertEquals(
    warnings.filter((w) => w.includes(NO_ROWS_WARNING)),
    [],
  );
});

Deno.test("main loop - below the limit the clarity gate stays on, without the no-rows warning (Issue #4061)", async () => {
  const max = buildDefaultWorkerConfig().maxClarificationRounds;
  const { state, warnings } = await runMainLoopClarity(max - 1);
  assert(state.clarityStatus !== "skipped");
  assertEquals(
    warnings.filter((w) => w.includes(NO_ROWS_WARNING)),
    [],
  );
});
