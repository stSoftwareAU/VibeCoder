/**
 * Issue #4625: no lane publishes agent work unless the target repository's own
 * gate ran and passed on the committed head.
 *
 * The issue completion phase asks `validatePublication` on the head about to
 * be pushed, after the fast changed-file gate (and never when that gate says
 * nothing is ahead of base). A `failed` verdict earns the one in-run repair
 * turn (Issue #4128) and the checks re-run; an `unavailable` gate is
 * infrastructure, so it is retried and never pushed. The last-currency push of
 * a merged head is validated the same way, and only a pass publishes it.
 *
 * Drives `workOnIssueCompletion` with the git and gate seams mocked, as
 * tests/completion_phase_last_currency_test.ts does. Australian English used
 * throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  PublicationRequest,
  PublicationValidation,
} from "../lib/publication_validation.ts";
import {
  PRE_PUSH_GATE_MARKER,
  PRE_PUSH_LOOKUP_FAILED_MARKER,
} from "../lib/failure_diagnosis.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import type { GitHubClient, RepoConfig, WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 4625;
const BRANCH = "issue-4625-publication-validation-test";
const BASE_BRANCH = "main";
const HEAD = "1f0c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c";

/** Output a failed repository gate reports; quoted back to the agent. */
const FAILING_OUTPUT =
  "FAILED check: deno test tests/widget_test.ts (2 failed)";
/** Reason an unavailable repository gate reports; never sent to the agent. */
const UNAVAILABLE_REASON = "failed_missing_tools: deno was not found on PATH";

const SUMMARY = "## Summary\n\nPublication validation. Closes #4625.\n\n" +
  "**Branch outcomes:** none added\n";

const FAILED: PublicationValidation = {
  status: "failed",
  head: HEAD,
  output: FAILING_OUTPUT,
};
const PASSED_RAN: PublicationValidation = {
  status: "passed",
  head: HEAD,
  gate: "ran",
};
const UNAVAILABLE: PublicationValidation = {
  status: "unavailable",
  head: HEAD,
  reason: UNAVAILABLE_REASON,
};

interface Script {
  /** Validation answers, consumed in call order; the last one repeats. */
  answers: PublicationValidation[];
  /** What the fast changed-file gate reports; `noop` means nothing ahead. */
  fastKind?: "passed" | "noop";
  /** Behind-count answered to each drift check (merge when non-zero). */
  behindOnCall?: (call: number) => number;
  repoConfig?: Record<string, RepoConfig>;
}

interface Run {
  /** The phase result; `category` and `reason` are set on a failure. */
  result: { status: string; category?: string; reason?: string };
  /** Ordered: "validate", "push", "merge", "agent", "create". */
  events: string[];
  /** Every request the completion phase made to `validatePublication`. */
  requests: PublicationRequest[];
  /** Every agent prompt, in order. */
  prompts: string[];
  warnings: string[];
  infos: string[];
  repoPath: string;
}

function stubClient(): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub: getIssue not implemented");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

async function runPhase(script: Script): Promise<Run> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`,
    SUMMARY,
  );
  const config: WorkerConfig = buildDefaultWorkerConfig();
  // The in-run infrastructure retry must not sleep its real backoff.
  config.infraRetryBackoffMs = 1;
  if (script.repoConfig) config.repoConfig = script.repoConfig;
  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Publish only what the repository's own gate passed",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: BRANCH,
    baseBranch: BASE_BRANCH,
    defaultBranch: BASE_BRANCH,
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const events: string[] = [];
  const requests: PublicationRequest[] = [];
  const prompts: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const behindOnCall = script.behindOnCall ?? (() => 0);
  let driftChecks = 0;
  try {
    const result = await workOnIssueCompletion(
      ctx,
      state,
      createMockDeps({
        logger: {
          info: (message: string) => infos.push(message),
          warn: (message: string) => warnings.push(message),
          error: () => undefined,
          debug: () => undefined,
        } as never,
        claude: {
          runClaudeWithRetry: (runOptions: RunClaudeOptions) => {
            events.push("agent");
            prompts.push(runOptions.prompt);
            return Promise.resolve({
              ok: true as const,
              value: { exitCode: 0, output: "mock", timedOut: false },
            });
          },
        },
        github: {
          createClient: () => stubClient(),
          runGhCommand: (args: string[]) => {
            if (args[0] === "pr" && args[1] === "create") events.push("create");
            return Promise.resolve(
              `https://github.com/${REPO}/pull/${ISSUE}`,
            );
          },
        },
        git: {
          reconcileHeadToBranch: () =>
            Promise.resolve({
              ok: true as const,
              value: { action: "already-on-branch" as const, fromRef: BRANCH },
            }),
          gateUnpushedCommits: () =>
            Promise.resolve(
              script.fastKind === "noop"
                ? { ok: true as const, value: { kind: "noop" as const } }
                : {
                  ok: true as const,
                  value: { kind: "passed" as const, checksRun: [] },
                },
            ),
          validatePublication: (request: PublicationRequest) => {
            events.push("validate");
            requests.push(request);
            const index = Math.min(
              requests.length - 1,
              script.answers.length - 1,
            );
            const answer = script.answers[index];
            assert(answer !== undefined, "a validation answer was scripted");
            return Promise.resolve(answer);
          },
          pushUnpushedCommits: () => {
            events.push("push");
            return Promise.resolve({ ok: true as const, value: 1 });
          },
          runGitCommand: (args: string[]) => {
            const joined = args.join(" ");
            let stdout = "";
            if (args[0] === "rev-list" && joined.includes("--left-right")) {
              driftChecks++;
              stdout = `${behindOnCall(driftChecks)} 1\n`;
            } else if (args[0] === "merge" && args[1] === "--no-edit") {
              events.push("merge");
            } else if (
              args[0] === "rev-parse" && joined.includes("--verify") &&
              joined.includes("^{commit}")
            ) {
              stdout = "a".repeat(40) + "\n";
            }
            return Promise.resolve({
              ok: true as const,
              value: { code: 0, stdout, stderr: "" },
            });
          },
        },
        pr: {
          findExistingPrForIssue: () =>
            Promise.resolve({ ok: false, error: new Error("No PR found") }),
          findExistingPrForBranch: () =>
            Promise.resolve({ ok: false, error: new Error("No PR found") }),
        },
      }),
    );
    return {
      result: result as Run["result"],
      events,
      requests,
      prompts,
      warnings,
      infos,
      repoPath,
    };
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
}

function count(events: string[], name: string): number {
  return events.filter((event) => event === name).length;
}

// (a) A failed gate gets one repair turn; the re-run still fails; no push.
Deno.test("a failed publication check earns one repair turn, then fails closed with no push (Issue #4625)", async () => {
  const run = await runPhase({ answers: [FAILED, FAILED] });
  assertEquals(run.result.status, "failure");
  assertEquals(run.result.category, "pre_push_gate");
  assertStringIncludes(run.result.reason ?? "", PRE_PUSH_GATE_MARKER);
  assertStringIncludes(run.result.reason ?? "", FAILING_OUTPUT);
  assertEquals(
    run.requests.length,
    2,
    "the check ran once, then again after the repair turn",
  );
  assertEquals(
    run.prompts.filter((prompt) => prompt.includes(FAILING_OUTPUT)).length,
    1,
    "the agent was resumed exactly once with the failing output",
  );
  assertEquals(
    count(run.events, "push"),
    0,
    `events: ${run.events.join(", ")}`,
  );
});

// (b) A failed gate, repaired, then passes: the push happens.
Deno.test("a failed publication check that passes after the repair turn is published (Issue #4625)", async () => {
  const run = await runPhase({ answers: [FAILED, PASSED_RAN] });
  assertEquals(run.result.status, "continue");
  assertEquals(run.requests.length, 2);
  assertEquals(
    run.prompts.filter((prompt) => prompt.includes(FAILING_OUTPUT)).length,
    1,
  );
  assertEquals(
    count(run.events, "push"),
    1,
    `events: ${run.events.join(", ")}`,
  );
  assert(
    run.events.indexOf("validate") < run.events.indexOf("push") &&
      run.events.lastIndexOf("validate") > run.events.indexOf("agent"),
    `the push follows the re-run: ${run.events.join(", ")}`,
  );
});

// (c) An unavailable gate is infrastructure: retried, never pushed, no repair turn.
Deno.test("an unavailable publication check is a push failure, never pushed and no repair turn (Issue #4625)", async () => {
  const run = await runPhase({ answers: [UNAVAILABLE] });
  assertEquals(run.result.status, "failure");
  assertEquals(run.result.category, "push_failure");
  assertStringIncludes(
    run.result.reason ?? "",
    PRE_PUSH_LOOKUP_FAILED_MARKER,
  );
  assertStringIncludes(run.result.reason ?? "", UNAVAILABLE_REASON);
  // The in-run infrastructure retry (existing behaviour) runs the completion
  // body once more, so the check runs once per attempt. Neither is a verdict.
  assertEquals(run.requests.length, 2, "one check per attempt");
  assertEquals(
    count(run.events, "push"),
    0,
    `events: ${run.events.join(", ")}`,
  );
  assertEquals(
    run.prompts.filter((prompt) => prompt.includes(UNAVAILABLE_REASON)).length,
    0,
    "no repair turn was given for an infrastructure fault",
  );
  assertEquals(run.prompts.length, 0, "no agent turn ran at all");
});

// (d) A passed check publishes, whatever the gate kind.
for (const gate of ["ran", "absent", "opted-out"] as const) {
  Deno.test(`a publication check that passed with gate "${gate}" publishes (Issue #4625)`, async () => {
    const run = await runPhase({
      answers: [{ status: "passed", head: HEAD, gate }],
    });
    assertEquals(run.result.status, "continue");
    assertEquals(run.requests.length, 1);
    assertEquals(
      count(run.events, "push"),
      1,
      `events: ${run.events.join(", ")}`,
    );
    assertEquals(run.prompts.length, 0, "no repair turn for a pass");
    assert(
      run.infos.some((line) =>
        line.includes(`Publication check passed on ${HEAD}`) &&
        line.includes(`(repository gate: ${gate})`)
      ),
      `the outcome is logged at info: ${run.infos.join(" | ")}`,
    );
  });
}

// (e) Nothing ahead of base: no publication check is run.
Deno.test("a branch with nothing ahead of base does not run the publication check (Issue #4625)", async () => {
  const run = await runPhase({ answers: [PASSED_RAN], fastKind: "noop" });
  assertEquals(run.result.status, "continue");
  assertEquals(run.requests.length, 0, "validatePublication was not called");
  assertEquals(
    run.events.includes("validate"),
    false,
    `events: ${run.events.join(", ")}`,
  );
});

// (f) The merged head from the last-currency push is validated before it is pushed.
Deno.test("a merged head whose publication check fails is not pushed, and the PR is raised on the earlier head (Issue #4625)", async () => {
  const run = await runPhase({
    answers: [PASSED_RAN, FAILED],
    behindOnCall: (call) => (call === 1 ? 0 : 1),
  });
  assertEquals(run.result.status, "continue");
  assertEquals(run.requests.length, 2, "the merged head was checked");
  assertEquals(
    count(run.events, "push"),
    1,
    `only the earlier head was pushed: ${run.events.join(", ")}`,
  );
  const create = run.events.lastIndexOf("create");
  assert(create > 0, `the PR was raised: ${run.events.join(", ")}`);
  const before = run.events.slice(0, create);
  assertEquals(before.at(-1), "validate", `events: ${run.events.join(", ")}`);
  assertEquals(before.at(-2), "merge", `events: ${run.events.join(", ")}`);
  assert(
    run.warnings.some((line) =>
      line.includes("repository checks failed on the merged head") &&
      line.includes("raised on the earlier head")
    ),
    `the skipped push is logged at warn: ${run.warnings.join(" | ")}`,
  );
});

Deno.test("a merged head whose publication check passes is pushed before the PR is raised (Issue #4625)", async () => {
  const run = await runPhase({
    answers: [PASSED_RAN, PASSED_RAN],
    behindOnCall: (call) => (call === 1 ? 0 : 1),
  });
  assertEquals(run.result.status, "continue");
  assertEquals(run.requests.length, 2);
  assertEquals(
    count(run.events, "push"),
    2,
    `events: ${run.events.join(", ")}`,
  );
  const create = run.events.lastIndexOf("create");
  const before = run.events.slice(0, create);
  assertEquals(before.at(-1), "push", `events: ${run.events.join(", ")}`);
  assertEquals(before.at(-2), "validate", `events: ${run.events.join(", ")}`);
  assertEquals(before.at(-3), "merge", `events: ${run.events.join(", ")}`);
});

// (g) The check is told which checkout, repository and configuration to use.
Deno.test("the publication check receives the checkout, repository and repo config (Issue #4625)", async () => {
  const repoConfig = { [REPO]: { qualityCommand: "scripts/check.sh" } };
  const run = await runPhase({ answers: [PASSED_RAN], repoConfig });
  assertEquals(run.requests[0], {
    cwd: run.repoPath,
    repo: REPO,
    repoConfigs: repoConfig,
  });
});
