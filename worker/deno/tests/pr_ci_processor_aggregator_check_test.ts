/**
 * The CI-fix processor skips a check that is downstream of another red
 * check on the same head (Issue #1878, part of #1861).
 *
 * The scan filters aggregators against the host's clone, which sits on
 * the default branch. A head that added or renamed the aggregator gets
 * past that filter, so the processor repeats the decision against the
 * branch it actually checked out: it posts nothing, runs no agent, and
 * records the check-run retry so the same check is not re-selected on
 * every cycle for ever.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { ClaudeDeps, GitHubDeps } from "../lib/issue_worker_wiring.ts";
import { getCiCheckRetryCount } from "../lib/pr_ci_checks.ts";
import type { Logger } from "../types.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

const REPO = "stSoftwareAU/NEAT-AI-Backpropagation";
const CHECK_RUN_ID = "5150";

/** The checked-out head's own `ci.yml` — the aggregator shape. */
const CI_YML = `name: CI
on:
  pull_request:
jobs:
  validation:
    name: Project Validation
    runs-on: ubuntu-latest
    steps:
      - run: echo validate
  ci-required:
    name: CI Required Checks
    if: always()
    needs: [validation]
    runs-on: ubuntu-latest
    steps:
      - run: echo gate
`;

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

function makeInput(overrides: Partial<CiFixInput> = {}): CiFixInput {
  return {
    repo: REPO,
    prNumber: 150,
    branchName: "issue-149-fix",
    checkRunId: CHECK_RUN_ID,
    checkName: "CI Required Checks",
    encodedAnnotations: btoa(JSON.stringify([])),
    siblingFailedCheckNames: ["CI Required Checks", "Project Validation"],
    ...overrides,
  };
}

/** Capture every `gh pr comment --body …` the processor posts. */
function makeCommentCapturingGh(bodies: string[]): GitHubDeps["runGhCommand"] {
  return ((args: string[]) => {
    if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
    if (args[0] === "pr" && args[1] === "comment") {
      const idx = args.indexOf("--body");
      const body = idx >= 0 ? args[idx + 1] : undefined;
      if (body !== undefined) bodies.push(body);
    }
    return Promise.resolve("");
  }) as GitHubDeps["runGhCommand"];
}

/**
 * Run the processor against a checkout containing {@link CI_YML}.
 *
 * Returns what the processor did: its result, the comments it posted and
 * how many times it ran the agent.
 */
async function runProcessor(input: CiFixInput) {
  const workDir = await Deno.makeTempDir({ prefix: "ci-aggregator-proc-" });
  const bodies: string[] = [];
  let agentRuns = 0;
  try {
    await Deno.mkdir(`${workDir}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(`${workDir}/.github/workflows/ci.yml`, CI_YML);

    const deps = createMockDeps({
      github: { runGhCommand: makeCommentCapturingGh(bodies) },
      claude: {
        runClaudeWithRetry: (() => {
          agentRuns++;
          return Promise.resolve({
            ok: true,
            value: { output: "fixed", exitCode: 0, timedOut: false },
          });
        }) as unknown as ClaudeDeps["runClaudeWithRetry"],
      },
    });

    const stateDir = `${workDir}/.ci_check_state`;
    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir,
      workDir,
      workRoot: workDir,
    };

    const result = await processCiFailure(input, processorDeps);
    const retries = await getCiCheckRetryCount(stateDir, REPO, CHECK_RUN_ID);
    return { result, bodies, agentRuns, retries };
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

Deno.test("processCiFailure - posts nothing for a downstream aggregator (Issue #1878)", async () => {
  const { result, bodies, agentRuns, retries } = await runProcessor(
    makeInput(),
  );

  assert(result.ok);
  if (result.ok) {
    assertEquals(result.value.processed, false);
    assertEquals(result.value.changesPushed, false);
  }
  assertEquals(bodies, [], "a downstream aggregator earns no PR comment");
  assertEquals(agentRuns, 0, "no agent runs for a check with no failure");
  assertEquals(
    retries,
    1,
    "the retry is recorded so the check is not re-selected for ever",
  );
});

Deno.test("processCiFailure - an aggregator red on its own is processed normally (Issue #1878)", async () => {
  const { result, agentRuns } = await runProcessor(
    makeInput({ siblingFailedCheckNames: ["CI Required Checks"] }),
  );

  assert(result.ok);
  assert(agentRuns > 0, "the agent must still run for a genuine failure");
});

Deno.test("processCiFailure - no sibling list means no filtering (Issue #1878)", async () => {
  const { result, agentRuns } = await runProcessor(
    makeInput({ siblingFailedCheckNames: undefined }),
  );

  assert(result.ok);
  assert(agentRuns > 0, "an unknown sibling list must not skip the fix");
});
