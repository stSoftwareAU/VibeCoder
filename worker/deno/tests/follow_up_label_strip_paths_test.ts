/**
 * Path coverage for the reserved-label strip on model-created follow-up issues
 * (Issue #3708, SEC-6403af1e8b72).
 *
 * The escape hatch is documented for PR feedback, CI fix *and* issue work, but
 * the strip had a single call site in `pr_feedback_processor.ts`. These tests
 * pin the two paths that were uncovered: a CI-fix run and an issue-work run
 * that hand off must both end with the follow-up's reserved label removed, and
 * neither may strip a label from the issue/PR the run is working on.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import { type IssueContext, workOnIssue } from "../lib/issue_worker.ts";
import type { WorkOnIssueResult } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import type {
  ClaudeDeps,
  ConfigDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type {
  GitHubClient,
  GitHubIssue,
  Logger,
  WorkerConfig,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESERVED = "top-priority";

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

interface StripCapture {
  /** Labels the strip removed, in order. */
  removed: Array<{ repo: string; issue: number; label: string }>;
  /** Labels each issue carries, keyed by `"repo#number"`. */
  labels: Record<string, string[]>;
  /**
   * Issues that do not exist, keyed by `"repo#number"` (Issue #210): reading
   * one fails with the GraphQL wording `gh` returns for a bogus number.
   */
  missing?: string[];
}

/**
 * A `createClient` stub backed by `capture.labels` so the strip runs offline.
 * Only `getIssue`/`removeLabel` are used by the strip; the rest are no-ops so
 * the surrounding processor flow is unaffected.
 */
function makeStripClient(capture: StripCapture): GitHubClient {
  return {
    getIssue(repo: string, issueNumber: number): Promise<GitHubIssue> {
      if ((capture.missing ?? []).includes(`${repo}#${issueNumber}`)) {
        return Promise.reject(
          new Error(
            "gh command failed (exit 1): GraphQL: Could not resolve to an " +
              `issue or pull request with the number of ${issueNumber}. ` +
              "(repository.issue)",
          ),
        );
      }
      return Promise.resolve({
        number: issueNumber,
        title: "follow-up",
        body: "",
        labels: capture.labels[`${repo}#${issueNumber}`] ?? [],
        author: "worker",
        assignees: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    },
    removeLabel(repo: string, issueNumber: number, label: string) {
      capture.removed.push({ repo, issue: issueNumber, label });
      return Promise.resolve();
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

function makeGithubDeps(capture: StripCapture): Partial<GitHubDeps> {
  return {
    createClient: (_logger: Logger) => makeStripClient(capture),
    runGhCommand: (args: string[]) => {
      if (args[0] === "label" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      return Promise.resolve("");
    },
  };
}

function configDeps(repos: string[]): Partial<ConfigDeps> {
  return {
    loadConfig: (() =>
      Promise.resolve({
        ...buildDefaultWorkerConfig(),
        repos,
      } as WorkerConfig)) as ConfigDeps["loadConfig"],
  };
}

// ---------------------------------------------------------------------------
// CI fix path
// ---------------------------------------------------------------------------

function makeCiInput(): CiFixInput {
  const annotations: CheckAnnotation[] = [
    { path: "src/x.ts", start_line: 1, message: "test failed" },
  ];
  return {
    repo: "org/repo",
    prNumber: 99,
    branchName: "issue-99-fix",
    checkRunId: "111",
    checkName: "test",
    encodedAnnotations: btoa(JSON.stringify(annotations)),
  };
}

/** Run a CI fix whose `.pr_response_message` is `message`. */
async function runCiFix(
  message: string,
  labels: Record<string, string[]>,
): Promise<StripCapture> {
  const tmpDir = await Deno.makeTempDir({ prefix: "ci-follow-up-strip-" });
  try {
    await Deno.writeTextFile(`${tmpDir}/.pr_response_message`, message);
    const capture: StripCapture = { removed: [], labels };

    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "", exitCode: 0, timedOut: false },
          })) as unknown as ClaudeDeps["runClaudeWithRetry"],
      },
      github: makeGithubDeps(capture),
      config: configDeps(["org/repo", "org/dep"]),
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
      logger: silentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
    };

    const result = await processCiFailure(makeCiInput(), processorDeps);
    assertEquals(result.ok, true);
    return capture;
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("processCiFailure - strips a reserved label from the follow-up the CI fix handed off to", async () => {
  const capture = await runCiFix(
    "Fixing this properly is out of scope for the CI failure. I've opened " +
      "follow-up issue org/repo#701 capturing the analysis.",
    { "org/repo#701": [RESERVED, "bug"] },
  );

  assertEquals(capture.removed, [
    { repo: "org/repo", issue: 701, label: RESERVED },
  ]);
});

Deno.test("processCiFailure - an ordinary CI reply strips nothing", async () => {
  const capture = await runCiFix(
    "I've pushed a fix for the failing test in src/x.ts.",
    { "org/repo#701": [RESERVED] },
  );

  assertEquals(capture.removed, []);
});

Deno.test("processCiFailure - never strips a label from the PR the run is fixing", async () => {
  // The hand-off text names the PR itself (#99). Stripping there would remove
  // a human-applied reserved label from live work.
  const capture = await runCiFix(
    "This is out of scope — see the follow-up issue discussion on #99.",
    { "org/repo#99": [RESERVED] },
  );

  assertEquals(capture.removed, []);
});

// ---------------------------------------------------------------------------
// Issue work path
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: "Fix login bug",
    issueBody: "The login button on `src/auth/login.ts:45` does not work.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
    ...overrides,
  };
}

/** Run a full issue-work pipeline whose Claude output is `claudeOutput`. */
async function runIssueWork(
  claudeOutput: string,
  labels: Record<string, string[]>,
  options: { missing?: string[]; logger?: Partial<Logger> } = {},
): Promise<{ capture: StripCapture; result: WorkOnIssueResult }> {
  const capture: StripCapture = {
    removed: [],
    labels,
    ...(options.missing ? { missing: options.missing } : {}),
  };

  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: claudeOutput, exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    },
    github: makeGithubDeps(capture),
    config: configDeps(["org/repo"]),
    git: {
      runGitCommand: ((args: string[]) => {
        if (
          args[0] === "log" && typeof args[1] === "string" &&
          args[1].includes("..HEAD")
        ) {
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "abc123 Fix login", stderr: "" },
          });
        }
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        });
      }) as unknown as GitDeps["runGitCommand"],
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
    },
    ...(options.logger ? { logger: options.logger } : {}),
  });

  const result = await workOnIssue(makeContext(), deps);
  assert(result.success, `issue work should succeed, got: ${result.reason}`);
  return { capture, result };
}

Deno.test({
  name:
    "workOnIssue - strips a reserved label from the follow-up the run handed off to",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { capture } = await runIssueWork(
      "The root cause is broader than this issue, so this is out of scope. " +
        "I opened follow-up issue org/repo#808 with the analysis.",
      { "org/repo#808": [RESERVED, "enhancement"] },
    );

    assertEquals(capture.removed, [
      { repo: "org/repo", issue: 808, label: RESERVED },
    ]);
  },
});

Deno.test({
  name: "workOnIssue - never strips a label from the issue it is working on",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Claude's summary names the issue under work (#42) alongside hand-off
    // wording. The run must not remove the human-applied `top-priority` that
    // queued that issue.
    const { capture } = await runIssueWork(
      "Handed off the remaining scope; see the follow-up issue noted in #42.",
      { "org/repo#42": [RESERVED] },
    );

    assertEquals(capture.removed, []);
  },
});

// ---------------------------------------------------------------------------
// A follow-up reference that does not exist (Issue #210)
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "workOnIssue - a follow-up reference that does not resolve is stated on the release comment, with no ERROR (Issue #210)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // The shape that burned NEAT-AI-Lamarck#187: the hand-off names #3952,
    // a number from another repo's series that does not exist here.
    const errors: string[] = [];
    const warnings: string[] = [];
    const { capture, result } = await runIssueWork(
      "This is out of scope for this run — see follow-up issue #3952.",
      {},
      {
        missing: ["org/repo#3952"],
        logger: {
          error: (msg: string) => errors.push(msg),
          warn: (msg: string) => warnings.push(msg),
        },
      },
    );

    // Nothing was mutated and nothing failed loud about an issue that cannot
    // exist — the reported ERROR is gone.
    assertEquals(capture.removed, []);
    assertEquals(
      errors.filter((e) => e.includes("Reserved-label strip")),
      [],
    );
    assertEquals(
      warnings.filter((w) => w.includes("Retrying reserved-label strip")),
      [],
      "a bogus reference must not be retried",
    );
    // …and the real outcome reaches the human on the claim-release comment.
    assertEquals(
      result.outcome?.notes,
      ["follow-up reference #3952 not found in this repo"],
    );
  },
});
