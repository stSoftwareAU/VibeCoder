/**
 * Tests for the CI-fix base-branch deferral (Issue #1880, parent #1861).
 *
 * When the agent reports the failure as pre-existing on the base branch by
 * ending its `.pr_response_message` with a `Depends on owner/repo#N` line,
 * and the base branch's own latest run of the same check is red **and** its log
 * shows this pull request's own failure (Issue #4680), the worker must post the
 * diagnosis **once**, record a deferral marker, apply no `needs-human` and
 * charge no attempt. A red base whose log shows some other failure is charged,
 * not held. A green base refutes the claim and
 * charges an attempt. A claim that cannot be verified (no run of the check
 * from the same workflow, a stale run, an unreadable API) is held as
 * `base-unverified`: the diagnosis is posted with a hold marker, no attempt is
 * charged, and after two holds the ordinary charged path runs (Issue #4680).
 * A prior deferral whose blocker has since closed falls through to the
 * ordinary no-changes path, which charges an attempt.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { parseCiFixAttemptMarkers } from "../lib/ci_fix_attempt_markers.ts";
import type { GitHubComment, Logger } from "../types.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import {
  type ActionsLogOptions,
  fetchGithubActionsLogExcerpt,
} from "../lib/github_actions_log_fetcher.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The fleet login whose markers on the pull request count as the record. */
const FLEET_LOGIN = "vibe-bot";

/** The blocker the agent names. */
const BLOCKER = "org/upstream#149";

/** The agent's `.pr_response_message` for a base-branch failure. */
const AGENT_MESSAGE = [
  "No change required for semgrep — the finding is in the base branch, not " +
  "in this pull request's diff.",
  "",
  "**Inspected:** the semgrep annotation, `lib/some_regex.ts`, and the base " +
  "branch's own run of the same check.",
  "",
  `Depends on ${BLOCKER}`,
].join("\n");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Everything a scenario run recorded. */
interface Captured {
  comments: string[];
  labelsAdded: string[];
  errors: string[];
  warnings: string[];
  /** Reads of the base branch's (`develop`) check runs (Issue #3141). */
  baseCheckRunReads?: number;
}

/** The base branch head the stubbed `develop` resolves to (Issue #4680). */
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

/** A commit on the pull request itself, never the base head. */
const PR_HEAD_SHA = "89abcdef0123456789abcdef0123456789abcdef";

/** An older commit the base's run may have been recorded against. */
const STALE_SHA = "fedcba9876543210fedcba9876543210fedcba98";

/** The GitHub App that ran the checks. */
const APP = "github-actions";

/** The workflow the failing check and the same-named base run belong to. */
const CI_WORKFLOW = ".github/workflows/ci.yml";

/** A different workflow that happens to carry a check of the same name. */
const OTHER_WORKFLOW = ".github/workflows/lint.yml";

/** The run the failing check belongs to, on the pull request. */
const FAILING_RUN_ID = 900;

/** The base branch's run of the same check, from the same workflow. */
const BASE_RUN_ID = 700;

/** The check run id of the base branch's run (Issue #4680). */
const BASE_CHECK_ID = 7;

/** The check run id of the merged pull request's run, a tree-equivalent stand-in. */
const MERGED_CHECK_ID = 8;

/** The annotation message makeInput carries for the failing semgrep check. */
const SEMGREP_MESSAGE =
  "semgrep: blocking code rules fired - detect-non-literal-regexp (possible ReDoS)";

/** The workflow path each run id resolves to, unless a scenario overrides it. */
const DEFAULT_RUN_PATHS: Record<string, string> = {
  [String(FAILING_RUN_ID)]: CI_WORKFLOW,
  [String(BASE_RUN_ID)]: CI_WORKFLOW,
  "701": OTHER_WORKFLOW,
  "703": CI_WORKFLOW,
};

/** How the stubbed GitHub answers the base-branch and issue-state reads. */
interface StubOptions {
  /** Failing pull request job's log, when supplied. */
  failingLog?: string;
  /** Raw `check-runs` body for the base branch, or a thrower. */
  baseCheckRuns?: string | "error";
  /** Name of the failing check, which its identity payload carries. */
  checkName?: string;
  /** Makes the failing check's identity read fail (Issue #4680). */
  identity?: "error";
  /** Workflow path per run id, overriding {@link DEFAULT_RUN_PATHS}. */
  runPaths?: Record<string, string>;
  /**
   * A pull request merged as the base head (Issue #4680): its head commit, the
   * tree that commit and the base head carry, and the conclusion of the same
   * workflow's run on that commit.
   */
  mergedPr?: { treeMatches: boolean; conclusion: string; runPath?: string };
  /**
   * The base run's Actions job log (Issue #4680): the text it printed, or
   * `"error"` when the log cannot be fetched. Defaults to the failing check's
   * own annotation messages, so the base run shares this pull request's failure.
   */
  baseLog?: string | "error";
  /**
   * The merged pull request's Actions job log, for a tree-equivalent red
   * (Issue #4680). Defaults like {@link baseLog}.
   */
  mergedLog?: string | "error";
  /** Collects each call the base run's log fetch makes (Issue #4680). */
  logCalls?: ActionsLogOptions[];
  /** State the blocking issue reports. */
  blockerState?: "OPEN" | "CLOSED";
  /** Comments already on the pull request. */
  existingComments?: GitHubComment[];
}

/** A `check-runs` payload with no run of any check on the base branch. */
const NO_BASE_RUNS = JSON.stringify({ check_runs: [] });

/**
 * A `check-runs` payload naming one completed run of `name`, in the REST
 * shape `ci_base_branch_check.ts` reads: id, name, status, conclusion,
 * head_sha, app_slug and details_url.
 */
function baseCheckRunsPayload(
  conclusion: string,
  name = "semgrep",
  row: { headSha?: string; runId?: number; app?: string; checkId?: number } =
    {},
): string {
  const checkId = row.checkId ?? BASE_CHECK_ID;
  return JSON.stringify({
    check_runs: [
      {
        id: checkId,
        name,
        status: "completed",
        conclusion,
        head_sha: row.headSha ?? BASE_SHA,
        app_slug: row.app ?? APP,
        details_url: `https://github.com/org/repo/actions/runs/${
          row.runId ?? BASE_RUN_ID
        }/job/${checkId}`,
      },
    ],
  });
}

/** A job log printing each message as a workflow error line (Issue #4680). */
function jobLog(messages: string[]): string {
  return [
    "##[group]Run the check",
    "##[endgroup]",
    ...messages.map((message) => `##[error]${message}`),
    "##[error]Process completed with exit code 1.",
  ].join("\n");
}

/** The messages of a CI-fix input's annotations. */
function annotationMessages(input: CiFixInput): string[] {
  const annotations = JSON.parse(
    atob(input.encodedAnnotations),
  ) as CheckAnnotation[];
  return annotations.map((annotation) => annotation.message);
}

/** A job-log reply: the text, or a failed fetch when `log` is `"error"`. */
function logReply(log: string | "error"): Promise<string> {
  return log === "error"
    ? Promise.reject(new Error("HTTP 404: Not Found"))
    : Promise.resolve(log);
}

/** The attempt outcomes a comment's markers carry, in order. */
function attemptOutcomes(body: string): string[] {
  return parseCiFixAttemptMarkers(body).map((marker) => marker.outcome);
}

function makeRecordingLogger(captured: Captured): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: (message: string) => captured.warnings.push(message),
    error: (message: string) => captured.errors.push(message),
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/**
 * One `gh` runner serving every call the processor makes: it captures the
 * comment bodies and labels, and answers the base-branch check-run and
 * issue-state reads the deferral depends on.
 */
function makeGhRunner(
  captured: Captured,
  options: StubOptions,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");

    // The endpoint is the `repos/` argument: the log fetcher passes
    // `--allow-escape-sequences` ahead of it (Issue #4680).
    const endpoint = args[0] === "api"
      ? String(args.find((arg) => arg.startsWith("repos/")) ?? args[1] ?? "")
      : "";

    // The base branch's head commit: the commit its check runs must be on.
    if (endpoint === "repos/org/repo/commits/develop") {
      return Promise.resolve(`${BASE_SHA}\n`);
    }

    // The base branch's own runs of the failing check.
    if (endpoint.includes("/commits/develop/check-runs")) {
      captured.baseCheckRunReads = (captured.baseCheckRunReads ?? 0) + 1;
      if (options.baseCheckRuns === "error") {
        return Promise.reject(new Error("HTTP 502: Bad Gateway"));
      }
      return Promise.resolve(
        options.baseCheckRuns ??
          baseCheckRunsPayload("failure", options.checkName ?? "semgrep"),
      );
    }

    // Tree-equivalent evidence from the PR merged as the base head (#4680).
    if (options.mergedPr !== undefined) {
      const merged = options.mergedPr;
      if (endpoint === `repos/org/repo/commits/${BASE_SHA}/pulls?per_page=5`) {
        return Promise.resolve(JSON.stringify([{ head_sha: PR_HEAD_SHA }]));
      }
      if (endpoint === `repos/org/repo/commits/${BASE_SHA}`) {
        return Promise.resolve(`${"1".repeat(40)}\n`);
      }
      if (endpoint === `repos/org/repo/commits/${PR_HEAD_SHA}`) {
        const tree = merged.treeMatches ? "1" : "2";
        return Promise.resolve(`${tree.repeat(40)}\n`);
      }
      if (
        endpoint ===
          `repos/org/repo/commits/${PR_HEAD_SHA}/check-runs?per_page=100`
      ) {
        return Promise.resolve(
          baseCheckRunsPayload(
            merged.conclusion,
            options.checkName ?? "semgrep",
            {
              headSha: PR_HEAD_SHA,
              runId: 703,
              checkId: MERGED_CHECK_ID,
            },
          ),
        );
      }
    }

    // The failing check run's identity: its name, app and run (Issue #4680).
    if (endpoint === "repos/org/repo/check-runs/111") {
      if (options.identity === "error") {
        return Promise.reject(new Error("HTTP 404: Not Found"));
      }
      return Promise.resolve(JSON.stringify({
        name: options.checkName ?? "semgrep",
        app_slug: APP,
        details_url:
          `https://github.com/org/repo/actions/runs/${FAILING_RUN_ID}/job/111`,
      }));
    }

    // The base run's check run, read by the log fetcher for its job (Issue
    // #4680): the Actions app and the job the run's details URL names.
    if (endpoint === `repos/org/repo/check-runs/${BASE_CHECK_ID}`) {
      return Promise.resolve(JSON.stringify({
        app: { slug: APP },
        details_url:
          `https://github.com/org/repo/actions/runs/${BASE_RUN_ID}/job/${BASE_CHECK_ID}`,
      }));
    }
    if (endpoint === `repos/org/repo/check-runs/${MERGED_CHECK_ID}`) {
      return Promise.resolve(JSON.stringify({
        app: { slug: APP },
        details_url:
          `https://github.com/org/repo/actions/runs/703/job/${MERGED_CHECK_ID}`,
      }));
    }

    if (
      endpoint === "repos/org/repo/actions/jobs/111/logs" &&
      options.failingLog !== undefined
    ) {
      return logReply(options.failingLog);
    }
    // The base run's job log and the merged run's job log (Issue #4680).
    if (endpoint === `repos/org/repo/actions/jobs/${BASE_CHECK_ID}/logs`) {
      return logReply(options.baseLog ?? jobLog([SEMGREP_MESSAGE]));
    }
    if (endpoint === `repos/org/repo/actions/jobs/${MERGED_CHECK_ID}/logs`) {
      return logReply(options.mergedLog ?? jobLog([SEMGREP_MESSAGE]));
    }

    // The workflow path a run was created from (`--jq .path`, Issue #4680).
    if (endpoint.startsWith("repos/org/repo/actions/runs/")) {
      const runId = endpoint.slice("repos/org/repo/actions/runs/".length);
      const paths: Record<string, string> = {
        ...DEFAULT_RUN_PATHS,
        ...options.runPaths,
      };
      const path = paths[runId];
      if (path === undefined) {
        return Promise.reject(new Error(`HTTP 404: run ${runId} not found`));
      }
      return Promise.resolve(`${path}\n`);
    }

    // The state of the issue a prior deferral names.
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({
        number: 149,
        state: options.blockerState ?? "OPEN",
        title: "Base branch is red",
      }));
    }

    if (args[0] === "pr" && args[1] === "comment") {
      const idx = args.indexOf("--body");
      if (idx >= 0 && args[idx + 1] !== undefined) {
        captured.comments.push(args[idx + 1] as string);
      }
    }

    // escalateToHuman posts its comment and label through the REST shim.
    if (args[0] === "api" && args.includes("-X")) {
      const xIdx = args.indexOf("-X");
      if (args[xIdx + 1] === "POST") {
        const endpoint = String(args[xIdx + 2] ?? "");
        for (let i = 0; i < args.length - 1; i++) {
          if (args[i] !== "-f") continue;
          const field = args[i + 1] ?? "";
          if (endpoint.includes("/labels") && field.startsWith("labels[]=")) {
            captured.labelsAdded.push(field.slice("labels[]=".length));
          }
          if (endpoint.includes("/comments") && field.startsWith("body=")) {
            captured.comments.push(field.slice("body=".length));
          }
        }
      }
    }

    if (args[0] === "issue" && args[1] === "edit") {
      const idx = args.indexOf("--add-label");
      if (idx >= 0 && args[idx + 1] !== undefined) {
        captured.labelsAdded.push(args[idx + 1] as string);
      }
    }

    if (args[0] === "label" && args[1] === "list") return Promise.resolve("[]");
    return Promise.resolve("");
  };
}

function makeInput(): CiFixInput {
  const annotations: CheckAnnotation[] = [
    {
      path: "worker/deno/lib/some_regex.ts",
      start_line: 42,
      message: SEMGREP_MESSAGE,
    },
  ];
  return {
    repo: "org/repo",
    prNumber: 150,
    branchName: "issue-150-fix",
    checkRunId: "111",
    checkName: "semgrep",
    encodedAnnotations: btoa(JSON.stringify(annotations)),
    baseRef: "develop",
  };
}

/**
 * Run a no-changes CI-fix scenario: Claude pushes nothing and leaves
 * `responseMessage` in `.pr_response_message`, exactly as the agent would.
 */
async function runDeferralScenario(
  responseMessage: string | undefined,
  options: StubOptions = {},
  input: CiFixInput = makeInput(),
): Promise<Captured> {
  const tmpDir = await Deno.makeTempDir();
  try {
    if (responseMessage !== undefined) {
      await Deno.writeTextFile(
        `${tmpDir}/.pr_response_message`,
        responseMessage,
      );
    }
    const captured: Captured = {
      comments: [],
      labelsAdded: [],
      errors: [],
      warnings: [],
    };
    // The fixture's first annotation describes the job failure; notices are
    // not automatically copied into the job log.
    const ownLog = jobLog(annotationMessages(input).slice(0, 1));
    const runGh = makeGhRunner(captured, {
      checkName: input.checkName,
      failingLog: ownLog,
      baseLog: ownLog,
      mergedLog: ownLog,
      ...options,
    });

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };

    const github: Partial<GitHubDeps> = {
      runGhCommand: runGh,
      createClient: (() => ({
        ...createMockDeps().github.createClient({} as Logger),
        getIssueComments: () => Promise.resolve(options.existingComments ?? []),
      })) as unknown as GitHubDeps["createClient"],
    };

    const deps = createMockDeps({
      claude: mockClaude,
      github,
      git: {
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 0,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeRecordingLogger(captured),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      workRoot: tmpDir,
      ghCommandFn: runGh,
      fleetLogins: [FLEET_LOGIN],
      ...(options.logCalls !== undefined
        ? {
          actionsLogFn: (opts: ActionsLogOptions) => {
            options.logCalls?.push(opts);
            return fetchGithubActionsLogExcerpt(opts);
          },
        }
        : {}),
    };

    const result = await processCiFailure(input, processorDeps);
    assertEquals(result.ok, true);
    return captured;
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("processCiFailure - a Depends on line with a red base defers once, charging no attempt (Issue #1880)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE);

  assertEquals(
    captured.comments.length,
    1,
    `expected exactly one comment; got ${captured.comments.length}`,
  );
  const body = captured.comments[0] ?? "";
  // The agent's own diagnosis, verbatim, naming the blocking issue.
  assertStringIncludes(body, "the finding is in the base branch");
  assertStringIncludes(body, BLOCKER);
  // The classifier trailer still shows how the failure was categorised.
  assertStringIncludes(body, "**Classifier reason:**");
  // The deferral is recorded for the next host to read.
  assertStringIncludes(body, `<!-- vibe-ci-fix-deferred `);
  assertStringIncludes(body, `depends-on="${BLOCKER}"`);
  // No attempt is charged, and no human is paged.
  assertEquals(body.includes("<!-- vibe-ci-fix-attempt "), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processCiFailure - a Depends on line with a green base takes the ordinary path and charges an attempt (Issue #1880)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: baseCheckRunsPayload("success"),
  });

  assertEquals(captured.comments.length >= 1, true);
  const body = captured.comments.at(-1) ?? "";
  // The agent's message is still posted verbatim (Issue #1876) …
  assertStringIncludes(body, "the finding is in the base branch");
  // … but the failure was not deferred: an attempt is charged. Issue #4304:
  // the `code-fix-required` classification is retried, never handed to a
  // human.
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  // A verified green base is a charged attempt, never a hold (Issue #4680).
  assertEquals(attemptOutcomes(body).includes("base-unverified"), false);
});

Deno.test("processCiFailure - a base-branch lookup error holds the claim unverified: posts once, charges no attempt, logs loudly (Issue #1880, #4680)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: "error",
  });

  assertEquals(
    captured.comments.length,
    1,
    `expected exactly one comment; got ${captured.comments.length}`,
  );
  const body = captured.comments[0] ?? "";
  assertStringIncludes(body, "the finding is in the base branch");
  assertStringIncludes(body, "could not be verified");
  // The hold is recorded as unverified, never as a charged attempt.
  assertEquals(attemptOutcomes(body), ["base-unverified"]);
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  assertEquals(
    captured.errors.some((line) =>
      line.includes("Could not read the base branch's checks")
    ),
    true,
    `expected a loud error about the failed lookup; got: ${
      captured.errors.join(" | ")
    }`,
  );
});

Deno.test("processCiFailure - no base ref means the claim cannot be verified, so the ordinary path runs (Issue #1880)", async () => {
  const { baseRef: _dropped, ...withoutBase } = makeInput();
  const captured = await runDeferralScenario(
    AGENT_MESSAGE,
    {},
    withoutBase as CiFixInput,
  );

  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
});

Deno.test("processCiFailure - a prior deferral on a still-open blocker posts nothing (Issue #1880)", async () => {
  // The marker the first run wrote, fed back as the pull request's history.
  const first = await runDeferralScenario(AGENT_MESSAGE);
  const priorBody = first.comments[0] ?? "";

  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    blockerState: "OPEN",
    existingComments: [
      { id: 1, author: FLEET_LOGIN, body: priorBody, createdAt: "" },
    ] as unknown as GitHubComment[],
  });

  assertEquals(
    captured.comments.length,
    0,
    `expected no second copy of the diagnosis; got: ${
      captured.comments.join(" | ")
    }`,
  );
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processCiFailure - a prior deferral whose blocker has closed falls through to the ordinary path (Issue #1880)", async () => {
  const first = await runDeferralScenario(AGENT_MESSAGE);
  const priorBody = first.comments[0] ?? "";

  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    blockerState: "CLOSED",
    existingComments: [
      { id: 1, author: FLEET_LOGIN, body: priorBody, createdAt: "" },
    ] as unknown as GitHubComment[],
  });

  // Not deferred a second time: the loop fails loud through the attempt cap.
  assertEquals(captured.comments.length >= 1, true);
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
  assertEquals(
    captured.warnings.some((line) =>
      line.includes("is closed and the failure is still here")
    ),
    true,
    `expected the loop-guard warning; got: ${captured.warnings.join(" | ")}`,
  );
});

Deno.test("processCiFailure - no Depends on line is never deferred, however red the base is (Issue #1880)", async () => {
  const captured = await runDeferralScenario(
    "No change required for semgrep — the annotation matches intended behaviour.",
  );

  const body = captured.comments.at(-1) ?? "";
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
});

Deno.test("processCiFailure - a bare #N in the Depends on line resolves to the pull request's own repo (Issue #1880)", async () => {
  const captured = await runDeferralScenario(
    [
      "No change required for semgrep — the finding is in the base branch.",
      "",
      "Depends on #149",
    ].join("\n"),
  );

  assertEquals(captured.comments.length, 1);
  const body = captured.comments[0] ?? "";
  // The marker must carry the full `owner/repo#N` form the dependency gate
  // and the next host both read.
  assertStringIncludes(body, 'depends-on="org/repo#149"');
  assertEquals(body.includes("<!-- vibe-ci-fix-attempt "), false);
});

Deno.test("processCiFailure - a prior deferral whose own blocker has closed falls through even when the agent names a different issue (Issue #1880)", async () => {
  const first = await runDeferralScenario(AGENT_MESSAGE);
  const priorBody = first.comments[0] ?? "";

  // The prior deferral names org/upstream#149; this run names a different
  // issue. The prior blocker is closed, so the deferral did not hold and the
  // pull request must not be parked again.
  const captured = await runDeferralScenario(
    AGENT_MESSAGE.replace(BLOCKER, "org/upstream#900"),
    {
      blockerState: "CLOSED",
      existingComments: [
        { id: 1, author: FLEET_LOGIN, body: priorBody, createdAt: "" },
      ] as unknown as GitHubComment[],
    },
  );

  assertEquals(captured.comments.length >= 1, true);
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
  assertEquals(
    captured.warnings.some((line) =>
      line.includes("is closed and the failure is still here")
    ),
    true,
    `expected the loop-guard warning; got: ${captured.warnings.join(" | ")}`,
  );
});

Deno.test("processCiFailure - a deferral comment that fails to post is never reported as a deferral (Issue #1880)", async () => {
  // The comment is the deferral's only record; a post that failed leaves the
  // pull request with no marker, so the run must not claim it deferred.
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/.pr_response_message`, AGENT_MESSAGE);
    const captured: Captured = {
      comments: [],
      labelsAdded: [],
      errors: [],
      warnings: [],
    };
    const inner = makeGhRunner(captured, {
      failingLog: jobLog([SEMGREP_MESSAGE]),
    });
    const runGh = (args: string[]): Promise<string> => {
      if (args[0] === "pr" && args[1] === "comment") {
        return Promise.reject(new Error("HTTP 403: Forbidden"));
      }
      return inner(args);
    };

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "", exitCode: 0, timedOut: false },
          })) as unknown as ClaudeDeps["runClaudeWithRetry"],
      },
      github: { runGhCommand: runGh },
      git: {
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 0,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const result = await processCiFailure(makeInput(), {
      promptsDir: PROMPTS_DIR,
      logger: makeRecordingLogger(captured),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      workRoot: tmpDir,
      ghCommandFn: runGh,
      fleetLogins: [FLEET_LOGIN],
    });

    assertEquals(result.ok, true);
    assertEquals(result.ok && result.value.processed, false);
    assertEquals(
      result.ok && result.value.summary.includes("could not be posted"),
      true,
    );
    assertEquals(
      captured.errors.some((line) =>
        line.includes("deferral comment could not be posted")
      ),
      true,
      `expected a loud error; got: ${captured.errors.join(" | ")}`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Dependency-audit checks are never deferred (Issue #3141)
// ---------------------------------------------------------------------------

/** The agent's message for an audit failure it blames on the base branch. */
const AUDIT_AGENT_MESSAGE = [
  "No change required for audit — the advisory is in the base branch's " +
  "lockfile, not in this pull request's diff.",
  "",
  `Depends on ${BLOCKER}`,
].join("\n");

/** A CI-fix input for `checkName` with one annotation reading `message`. */
function makeCheckInput(checkName: string, message: string): CiFixInput {
  const annotations: CheckAnnotation[] = [
    { path: "deno.lock", start_line: 1, message },
  ];
  return {
    ...makeInput(),
    checkName,
    encodedAnnotations: btoa(JSON.stringify(annotations)),
  };
}

Deno.test("processCiFailure - an audit check with a Depends on line and a red base is not deferred and charges an attempt (Issue #3141)", async () => {
  const checkName = "audit (Deno Audit)";
  const captured = await runDeferralScenario(
    AUDIT_AGENT_MESSAGE,
    { baseCheckRuns: baseCheckRunsPayload("failure", checkName) },
    makeCheckInput(checkName, "deno audit: 1 vulnerability found"),
  );

  assertEquals(captured.comments.length >= 1, true);
  assertEquals(
    captured.comments.some((c) => c.includes("<!-- vibe-ci-fix-deferred ")),
    false,
    `an audit check must never be deferred; got: ${
      captured.comments.join(" | ")
    }`,
  );
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
  // Refused before the base branch is ever consulted.
  assertEquals(captured.baseCheckRunReads ?? 0, 0);
  assertEquals(
    captured.warnings.some((line) =>
      line.includes("dependency-audit check is never deferred") &&
      line.includes(checkName) && line.includes(BLOCKER)
    ),
    true,
    `expected the refusal warning; got: ${captured.warnings.join(" | ")}`,
  );
});

Deno.test("processCiFailure - a non-audit check whose failure text names a GHSA advisory is not deferred (Issue #3141)", async () => {
  const captured = await runDeferralScenario(
    AGENT_MESSAGE,
    { baseCheckRuns: baseCheckRunsPayload("failure", "test") },
    makeCheckInput("test", "vulnerable dependency GHSA-vfj7-8cjw-p6xm"),
  );

  assertEquals(
    captured.comments.some((c) => c.includes("<!-- vibe-ci-fix-deferred ")),
    false,
  );
  assertStringIncludes(
    captured.comments.at(-1) ?? "",
    "<!-- vibe-ci-fix-attempt ",
  );
  assertEquals(captured.baseCheckRunReads ?? 0, 0);
  assertEquals(
    captured.warnings.some((line) => line.includes("GHSA-vfj7-8cjw-p6xm")),
    true,
    `expected the warning to name the advisory; got: ${
      captured.warnings.join(" | ")
    }`,
  );
});

Deno.test("processCiFailure - a non-audit check with a Depends on line and a red base is still deferred (Issue #3141)", async () => {
  const captured = await runDeferralScenario(
    AGENT_MESSAGE,
    { baseCheckRuns: baseCheckRunsPayload("failure", "lint") },
    makeCheckInput("lint", "lint: no-unused-vars"),
  );

  assertEquals(captured.comments.length, 1);
  const body = captured.comments[0] ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-deferred ");
  assertEquals(body.includes("<!-- vibe-ci-fix-attempt "), false);
  assertEquals(captured.baseCheckRunReads, 1);
});

// ---------------------------------------------------------------------------
// Verified and unverified base-branch claims (Issue #4680)
// ---------------------------------------------------------------------------

Deno.test("processCiFailure - a PR-only workflow with no base run is held unverified, charges no attempt and pages no human (Issue #4680)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: NO_BASE_RUNS,
  });

  assertEquals(captured.comments.length, 1);
  const body = captured.comments[0] ?? "";
  assertStringIncludes(body, "the finding is in the base branch");
  assertStringIncludes(body, "could not be verified");
  // The hold names the claimed blocker and the base state it found.
  assertStringIncludes(body, `Depends on ${BLOCKER}`);
  assertStringIncludes(body, "check state is `no-run`");
  assertEquals(attemptOutcomes(body), ["base-unverified"]);
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processCiFailure - a same-named check from another workflow on a green base is held as no-run, neither refused as green nor deferred (Issue #4680)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: baseCheckRunsPayload("success", "semgrep", { runId: 701 }),
  });

  assertEquals(captured.comments.length, 1);
  const body = captured.comments[0] ?? "";
  assertEquals(attemptOutcomes(body), ["base-unverified"]);
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processCiFailure - a red run on another pull request's head is not base-branch evidence, so it is held and not deferred (Issue #4680)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: baseCheckRunsPayload("failure", "semgrep", {
      headSha: PR_HEAD_SHA,
    }),
  });

  assertEquals(captured.comments.length, 1);
  const body = captured.comments[0] ?? "";
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertEquals(attemptOutcomes(body), ["base-unverified"]);
});

Deno.test("processCiFailure - a base run recorded against an older commit is stale and held unverified (Issue #4680)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: baseCheckRunsPayload("failure", "semgrep", {
      headSha: STALE_SHA,
      runId: 703,
    }),
  });

  assertEquals(captured.comments.length, 1);
  const body = captured.comments[0] ?? "";
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertStringIncludes(body, `Depends on ${BLOCKER}`);
  assertStringIncludes(body, "check state is `stale`");
  assertEquals(attemptOutcomes(body), ["base-unverified"]);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processCiFailure - an unreadable identity of the failing check is held unverified and logged loudly (Issue #4680)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    identity: "error",
  });

  assertEquals(captured.comments.length, 1);
  const body = captured.comments[0] ?? "";
  assertEquals(attemptOutcomes(body), ["base-unverified"]);
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertEquals(
    captured.errors.some((line) =>
      line.includes("Could not read the base branch's checks")
    ),
    true,
    `expected a loud error; got: ${captured.errors.join(" | ")}`,
  );
});

Deno.test("processCiFailure - two holds already on the pull request exhaust the hold bound and the ordinary charged path runs (Issue #4680)", async () => {
  // The hold the first scan posted, fed back twice as the pull request's
  // history: the fleet has already held this failure twice.
  const first = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: NO_BASE_RUNS,
  });
  const holdBody = first.comments[0] ?? "";

  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: NO_BASE_RUNS,
    existingComments: [
      { id: 1, author: FLEET_LOGIN, body: holdBody, createdAt: "" },
      { id: 2, author: FLEET_LOGIN, body: holdBody, createdAt: "" },
    ] as unknown as GitHubComment[],
  });

  assertEquals(captured.comments.length, 1);
  const body = captured.comments[0] ?? "";
  // Charged: the attempt is recorded as a substantive outcome, not a hold.
  assertEquals(attemptOutcomes(body).length, 1);
  assertEquals(attemptOutcomes(body).includes("base-unverified"), false);
  assertEquals(
    captured.warnings.some((line) =>
      line.includes("still unverified after 2 holds")
    ),
    true,
    `expected the hold-bound warning; got: ${captured.warnings.join(" | ")}`,
  );
});

Deno.test("processCiFailure - after a hold, a later scan that finds the base run red grants the deferral (Issue #4680)", async () => {
  const held = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: NO_BASE_RUNS,
  });

  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: baseCheckRunsPayload("failure"),
    existingComments: [
      {
        id: 1,
        author: FLEET_LOGIN,
        body: held.comments[0] ?? "",
        createdAt: "",
      },
    ] as unknown as GitHubComment[],
  });

  assertEquals(captured.comments.length, 1);
  const body = captured.comments[0] ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-deferred ");
  assertStringIncludes(body, `depends-on="${BLOCKER}"`);
  assertEquals(attemptOutcomes(body), []);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processCiFailure - a PR-only workflow red on the merged PR's identical tree defers, charging no attempt and paging no human (Issue #4680)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: NO_BASE_RUNS,
    mergedPr: { treeMatches: true, conclusion: "failure" },
  });

  assertEquals(captured.comments.length, 1);
  const body = captured.comments[0] ?? "";
  // The existing dependency mechanism: the deferral marker the scanner reads
  // back, and so resumes from once the blocker closes (Issue #1881).
  assertStringIncludes(body, "<!-- vibe-ci-fix-deferred ");
  assertStringIncludes(body, `depends-on="${BLOCKER}"`);
  assertEquals(attemptOutcomes(body), []);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processCiFailure - a PR-only workflow green on the merged PR's identical tree refutes the claim and takes the ordinary charged path (Issue #4680)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: NO_BASE_RUNS,
    mergedPr: { treeMatches: true, conclusion: "success" },
  });

  const body = captured.comments[0] ?? "";
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertEquals(attemptOutcomes(body).includes("base-unverified"), false);
});

Deno.test("processCiFailure - a merged PR whose tree differs from the base head is not evidence, so the PR-only claim is held (Issue #4680)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: NO_BASE_RUNS,
    mergedPr: { treeMatches: false, conclusion: "failure" },
  });

  const body = captured.comments[0] ?? "";
  assertEquals(attemptOutcomes(body), ["base-unverified"]);
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
});

// ---------------------------------------------------------------------------
// A red base must show this failure, not merely a red conclusion (Issue #4680)
// ---------------------------------------------------------------------------

Deno.test("processCiFailure - a red base whose log shows a different failure takes the ordinary charged path, neither deferred nor held (Issue #4680)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseLog: jobLog(["lint: an unrelated finding in another file"]),
  });

  assertEquals(captured.comments.length >= 1, true);
  const body = captured.comments.at(-1) ?? "";
  // The base failed for another reason: the claim is not verified as this
  // failure, so an attempt is charged and nothing is deferred or held.
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertEquals(attemptOutcomes(body).includes("base-unverified"), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processCiFailure - unrelated test failures sharing runner output are charged", async () => {
  const input = makeInput();
  input.encodedAnnotations = btoa(
    JSON.stringify([{
      path: "test.ts",
      start_line: 1,
      message: "parser - parse header ... FAILED\nnpm error command failed",
    }]),
  );
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseLog: jobLog([
      "parser - render footer ... FAILED",
      "npm error command failed",
    ]),
  }, input);
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertEquals(attemptOutcomes(body).includes("base-unverified"), false);
});

Deno.test("processCiFailure - same test failure with different tallies is deferred", async () => {
  const input = makeInput();
  input.encodedAnnotations = btoa(
    JSON.stringify([{
      path: "test.ts",
      start_line: 1,
      message:
        "parser - parse header ... FAILED\nAssertionError: expected header to be valid\nFAILED | 1407 passed | 1 failed (2m14s)",
    }]),
  );
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseLog: jobLog([
      "parser - parse header ... FAILED",
      "AssertionError: expected header to be valid",
      "FAILED | 1405 passed | 1 failed (2m31s)",
    ]),
  }, input);
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-deferred ");
  assertEquals(body.includes("<!-- vibe-ci-fix-attempt "), false);
});

Deno.test("processCiFailure - a runner notice absent from the job logs does not prevent deferral", async () => {
  const input = makeInput();
  input.encodedAnnotations = btoa(JSON.stringify([
    {
      path: "test.ts",
      start_line: 1,
      message: "AssertionError: invalid header value",
    },
    {
      path: "runner",
      start_line: 1,
      message:
        "The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026.",
    },
  ]));
  const log = jobLog(["AssertionError: invalid header value"]);
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    failingLog: log,
    baseLog: log,
  }, input);
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-deferred ");
  assertEquals(body.includes("<!-- vibe-ci-fix-attempt "), false);
});

Deno.test("processCiFailure - the base run's log is read for the failing check's name (Issue #4680)", async () => {
  const logCalls: ActionsLogOptions[] = [];
  await runDeferralScenario(AGENT_MESSAGE, { logCalls });

  // The failing check's own log is read too; pick the base run's read.
  const baseReads = logCalls.filter((call) =>
    call.checkRunId === String(BASE_CHECK_ID)
  );
  assertEquals(baseReads.length, 1);
  assertEquals(baseReads[0]?.repo, "org/repo");
  assertEquals(baseReads[0]?.checkName, "semgrep");
});

Deno.test("processCiFailure - a red base whose log cannot be fetched is held unverified: posts once, charges no attempt, pages no human (Issue #4680)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseLog: "error",
  });

  assertEquals(
    captured.comments.length,
    1,
    `expected exactly one comment; got ${captured.comments.length}`,
  );
  const body = captured.comments[0] ?? "";
  assertStringIncludes(body, "the finding is in the base branch");
  assertStringIncludes(body, "could not be compared");
  assertEquals(attemptOutcomes(body), ["base-unverified"]);
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  assertEquals(
    captured.errors.some((line) =>
      line.includes("Could not compare the base branch's red run")
    ),
    true,
    `expected a loud error about the failed comparison; got: ${
      captured.errors.join(" | ")
    }`,
  );
});

Deno.test("processCiFailure - a tree-equivalent red whose merged run's log shows a different failure takes the ordinary charged path (Issue #4680)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: NO_BASE_RUNS,
    mergedPr: { treeMatches: true, conclusion: "failure" },
    mergedLog: jobLog(["lint: an unrelated finding in another file"]),
  });

  assertEquals(captured.comments.length >= 1, true);
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertEquals(attemptOutcomes(body).includes("base-unverified"), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processCiFailure - an unreadable red base after two holds takes the ordinary charged path (Issue #4680)", async () => {
  // The hold the first scan posted, fed back twice as the pull request's
  // history: the fleet has already held this failure twice.
  const first = await runDeferralScenario(AGENT_MESSAGE, {
    baseLog: "error",
  });
  const holdBody = first.comments[0] ?? "";

  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseLog: "error",
    existingComments: [
      { id: 1, author: FLEET_LOGIN, body: holdBody, createdAt: "" },
      { id: 2, author: FLEET_LOGIN, body: holdBody, createdAt: "" },
    ] as unknown as GitHubComment[],
  });

  assertEquals(captured.comments.length, 1);
  const body = captured.comments[0] ?? "";
  // Charged: the attempt is recorded as a substantive outcome, not a hold.
  assertEquals(attemptOutcomes(body).length, 1);
  assertEquals(attemptOutcomes(body).includes("base-unverified"), false);
  assertEquals(
    captured.warnings.some((line) =>
      line.includes("still unverified after 2 holds")
    ),
    true,
    `expected the hold-bound warning; got: ${captured.warnings.join(" | ")}`,
  );
});

/** A semgrep job log naming `rule`, which prints no failure word (Issue #4680). */
function semgrepLog(rule: string, line = 42): string {
  return [
    "##[group]Run semgrep ci --config auto",
    "semgrep ci --config auto",
    "##[endgroup]",
    "┌────────────────┐",
    "│ 1 Code Finding │",
    "└────────────────┘",
    "    worker/deno/lib/some_regex.ts",
    `   ❯❱ ${rule}`,
    "          RegExp() called with a variable; this may allow ReDoS.",
    `           ${line}┆ const re = new RegExp(input);`,
    "BLOCKING CODE RULES FIRED:",
    `  ${rule}`,
    "##[error]Process completed with exit code 1.",
  ].join("\n");
}

const SEMGREP_RULE = "javascript.lang.security.audit.detect-non-literal-regexp";

/** An input whose only annotation is the runner's generic exit line. */
function exitLineInput(): CiFixInput {
  const input = makeInput();
  input.encodedAnnotations = btoa(JSON.stringify([{
    path: ".github",
    start_line: 1,
    message: "Process completed with exit code 1.",
  }]));
  return input;
}

Deno.test("processCiFailure - a semgrep failure with no failure word in its output is deferred when the base log shows the same rule (Issue #4680)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    failingLog: semgrepLog(SEMGREP_RULE, 57),
    baseLog: semgrepLog(SEMGREP_RULE, 42),
  }, exitLineInput());

  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-deferred ");
  assertEquals(body.includes("<!-- vibe-ci-fix-attempt "), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processCiFailure - a semgrep failure whose base log names another rule is charged, neither deferred nor held (Issue #4680)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    failingLog: semgrepLog(SEMGREP_RULE),
    baseLog: semgrepLog(
      "javascript.lang.security.audit.detect-eval-with-expression",
    ),
  }, exitLineInput());

  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertEquals(attemptOutcomes(body).includes("base-unverified"), false);
});

Deno.test("processCiFailure - output a passing test prints and changing test tallies do not stop the deferral (Issue #4680)", async () => {
  const failure = [
    "##[group]Run deno task test",
    "##[endgroup]",
    "parser - parse header => ./tests/parser_test.ts:10:6",
    "error: AssertionError: expected header to be valid",
  ];
  const prLog = [
    "##[group]Run deno task test",
    "##[endgroup]",
    "new test ...",
    "------- output -------",
    "ERROR worktree retry failed after 3 attempts: simulated outage",
    "----- output end -----",
    "ok (1ms)",
    ...failure.slice(2),
    "FAILED | 1407 passed | 1 failed (2m14s)",
    "1 failed, 42 passed, 3 warnings in 0.31s",
    "##[error]Process completed with exit code 1.",
  ].join("\n");
  const baseLog = [
    ...failure,
    "FAILED | 1405 passed | 1 failed (2m31s)",
    "1 failed, 41 passed, 2 warnings in 0.28s",
    "##[error]Process completed with exit code 1.",
  ].join("\n");
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    failingLog: prLog,
    baseLog,
  }, exitLineInput());

  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-deferred ");
  assertEquals(body.includes("<!-- vibe-ci-fix-attempt "), false);
});
