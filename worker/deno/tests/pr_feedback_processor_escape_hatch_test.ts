/**
 * Escape-hatch handling tests for pr_feedback_processor.ts (Issue #1826).
 *
 * Verifies that when Claude writes a `.pr_response_message` containing a
 * follow-up issue link, the processor:
 *   - Treats the run as a successful resolution (`processed: true`).
 *   - Posts Claude's own message as the PR reply rather than the neutral
 *     "no changes" classifier message.
 *   - Surfaces `needs-human` in the run summary when requested.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type PrFeedbackInput,
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, GitHubIssue, Logger } from "../types.ts";
import type {
  ClaudeDeps,
  ConfigDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { WorkerConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedLog {
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

function makeCapturingLogger(captured: CapturedLog[]): Logger {
  const record =
    (level: string) => (message: string, context?: Record<string, unknown>) => {
      captured.push({ level, message, context });
    };
  const noop = () => {};
  return {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

interface CapturedGh {
  comments: string[];
  labelsAdded: string[];
  /** Reserved-label strip removals on follow-up issues (Issue #2824). */
  labelsRemoved: Array<{ repo: string; issue: number; label: string }>;
  /** Labels the follow-up issue carries, keyed by `"repo#number"`. */
  followUpLabels: Record<string, string[]>;
  /**
   * When set, `getIssue` rejects with this message — used to model a
   * follow-up issue that does not exist (Issue #3661).
   */
  getIssueError?: string;
  /**
   * Login `getIssue` reports as the follow-up issue's author (Issue #185).
   * Defaults to the worker itself; a different login models the decoy issue
   * a prompt-injected hand-off message names.
   */
  followUpAuthor: string;
}

/** The worker's own login in these fixtures — a trusted follow-up author. */
const WORKER_LOGIN = "worker";

/**
 * A `createClient` stub backed by `captured.followUpLabels` so the escape-hatch
 * follow-up strip (Issue #2824) runs offline instead of hitting real `gh`.
 * Only `getIssue`/`removeLabel` are exercised by the strip; the rest throw.
 */
function makeMockClient(captured: CapturedGh): GitHubClient {
  const notUsed = (m: string) =>
    Promise.reject<never>(new Error(`mock client: ${m} not used`));
  return {
    getIssue(repo: string, issueNumber: number): Promise<GitHubIssue> {
      if (captured.getIssueError) {
        return Promise.reject(new Error(captured.getIssueError));
      }
      return Promise.resolve({
        number: issueNumber,
        title: "follow-up",
        body: "",
        labels: captured.followUpLabels[`${repo}#${issueNumber}`] ?? [],
        author: captured.followUpAuthor,
        assignees: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    },
    removeLabel(
      repo: string,
      issueNumber: number,
      label: string,
    ): Promise<void> {
      captured.labelsRemoved.push({ repo, issue: issueNumber, label });
      return Promise.resolve();
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => notUsed("addLabel"),
    postComment: () => notUsed("postComment"),
    editIssue: () => notUsed("editIssue"),
    assignIssue: () => notUsed("assignIssue"),
    unassignIssue: () => notUsed("unassignIssue"),
    closeIssue: () => notUsed("closeIssue"),
  };
}

function makeMockGithub(captured: CapturedGh): Partial<GitHubDeps> {
  return {
    createClient: (_logger: Logger) => makeMockClient(captured),
    runGhCommand: (args: string[]) => {
      if (args[0] === "pr" && args[1] === "comment") {
        const idx = args.indexOf("--body");
        if (idx >= 0 && args[idx + 1] !== undefined) {
          captured.comments.push(args[idx + 1] as string);
        }
      }
      if (args[0] === "issue" && args[1] === "edit") {
        const idx = args.indexOf("--add-label");
        if (idx >= 0 && args[idx + 1] !== undefined) {
          captured.labelsAdded.push(args[idx + 1] as string);
        }
      }
      if (args[0] === "label" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      return Promise.resolve("");
    },
  };
}

function makeInput(overrides?: Partial<PrFeedbackInput>): PrFeedbackInput {
  return {
    repo: "stSoftwareAU/foo",
    prNumber: 42,
    branchName: "issue-42-fix",
    commentType: "review",
    commentId: "555",
    commentBody: "Please refactor the entire data layer to support sharding.",
    ...overrides,
  };
}

async function runWithResponseMessage(
  message: string,
  inputOverrides?: Partial<PrFeedbackInput>,
  followUpLabels: Record<string, string[]> = {},
  configRepos?: string[],
  getIssueError?: string,
  followUpAuthor: string = WORKER_LOGIN,
): Promise<{
  captured: CapturedGh;
  logs: CapturedLog[];
  result: Awaited<ReturnType<typeof processPrFeedback>>;
}> {
  const tmpDir = await Deno.makeTempDir({ prefix: "escape-hatch-test-" });
  try {
    await Deno.writeTextFile(`${tmpDir}/.pr_response_message`, message);

    const captured: CapturedGh = {
      comments: [],
      labelsAdded: [],
      labelsRemoved: [],
      followUpLabels,
      getIssueError,
      followUpAuthor,
    };
    const logs: CapturedLog[] = [];

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };

    const deps = createMockDeps({
      claude: mockClaude,
      github: makeMockGithub(captured),
      // Issue #3074: the cross-repo follow-up strip allowlist is the configured
      // `repos`. Override `loadConfig` so the test controls that allowlist.
      // Issue #185: the same config supplies the trusted follow-up authors, so
      // the worker login must be on the allowlist for a genuine hand-off.
      config: {
        loadConfig: (() =>
          Promise.resolve(
            {
              repos: configRepos ?? [],
              allowedAuthors: [WORKER_LOGIN],
            } as WorkerConfig,
          )) as ConfigDeps["loadConfig"],
      },
      git: {
        // Escape-hatch scenario — no local changes, no push.
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

    const processorDeps: PrFeedbackProcessorDeps = {
      logger: makeCapturingLogger(logs),
      deps,
      workDir: tmpDir,
    };

    const result = await processPrFeedback(
      makeInput(inputOverrides),
      processorDeps,
    );
    return { captured, logs, result };
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("processPrFeedback - escape hatch with same-repo follow-up posts Claude's message", async () => {
  const message = "This refactor is out of scope of the current PR. " +
    "I've opened follow-up issue stSoftwareAU/foo#101 capturing the analysis. " +
    "See that issue for the proposed solution.";

  const { captured, logs, result } = await runWithResponseMessage(message);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.processed, true);
  assertEquals(result.value.changesPushed, false);
  assertStringIncludes(result.value.summary, "escape hatch");
  assertStringIncludes(result.value.summary, "stSoftwareAU/foo#101");

  // Claude's own message should be the PR reply — not the "no changes" fallback.
  assertEquals(captured.comments.length, 1);
  assertStringIncludes(captured.comments[0]!, "stSoftwareAU/foo#101");
  assertStringIncludes(captured.comments[0]!, "out of scope");
  assertEquals(
    captured.comments[0]!.includes("could not identify a code change"),
    false,
  );

  // Escape-hatch invocation should be logged.
  const escapeLog = logs.find((l) =>
    l.message === "PR feedback escape hatch invoked"
  );
  assertEquals(escapeLog !== undefined, true);
  assertEquals(escapeLog?.context?.issueRef, "stSoftwareAU/foo#101");
});

Deno.test("processPrFeedback - escape hatch surfaces needs-human in summary log", async () => {
  const message = "This change is out of scope — opened follow-up issue " +
    "stSoftwareAU/foo#202. Adding `needs-human` so a person can triage.";

  const { logs, result } = await runWithResponseMessage(message);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertStringIncludes(result.value.summary, "needs-human");

  const escapeLog = logs.find((l) =>
    l.message === "PR feedback escape hatch invoked"
  );
  assertEquals(escapeLog?.context?.needsHuman, true);
});

Deno.test("processPrFeedback - escape hatch strips a reserved label from the follow-up (Issue #2824)", async () => {
  const message =
    "This refactor is out of scope. I've opened follow-up issue " +
    "stSoftwareAU/foo#303 capturing the analysis.";

  // Claude self-applied a reserved `top-priority` label (plus a descriptive
  // `bug`) to the follow-up it created — the worker must strip the reserved one.
  const { captured, result } = await runWithResponseMessage(
    message,
    undefined,
    { "stSoftwareAU/foo#303": ["top-priority", "bug"] },
  );

  assertEquals(result.ok, true);
  if (!result.ok) return;

  // The reserved label is stripped from the follow-up; `bug` is preserved.
  assertEquals(captured.labelsRemoved, [
    { repo: "stSoftwareAU/foo", issue: 303, label: "top-priority" },
  ]);
  assert(
    !captured.labelsRemoved.some((c) => c.label === "bug"),
    "descriptive labels must be preserved",
  );
});

Deno.test("processPrFeedback - escape hatch does NOT strip an off-allowlist cross-repo follow-up (Issue #3074)", async () => {
  // A prompt-injection payload steers Claude to emit a cross-repo ref to a
  // victim repo the worker is not configured for. The strip must be skipped —
  // even though the (simulated) victim issue carries a reserved label.
  const message = "This work is out of scope, so I've opened follow-up issue " +
    "victim/repo#404 capturing the analysis.";

  const { captured, result } = await runWithResponseMessage(
    message,
    undefined,
    { "victim/repo#404": ["top-priority", "bug"] },
    ["stSoftwareAU/foo"], // allowlist excludes victim/repo
  );

  assertEquals(result.ok, true);
  if (!result.ok) return;
  // The hand-off still succeeds...
  assertStringIncludes(result.value.summary, "escape hatch");
  // ...but no label is removed from the off-allowlist victim repo.
  assertEquals(captured.labelsRemoved, []);
});

Deno.test("processPrFeedback - escape hatch strips an allowlisted cross-repo follow-up (Issue #3074)", async () => {
  // A legitimate internal cross-repo hand-off (#2942) to a configured repo is
  // still stripped of any self-applied reserved label.
  const message =
    "This belongs in the dependency. I've opened follow-up issue " +
    "stSoftwareAU/bar#77 capturing the analysis.";

  const { captured, result } = await runWithResponseMessage(
    message,
    undefined,
    { "stSoftwareAU/bar#77": ["top-priority", "enhancement"] },
    ["stSoftwareAU/foo", "stSoftwareAU/bar"], // allowlist includes the target
  );

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(captured.labelsRemoved, [
    { repo: "stSoftwareAU/bar", issue: 77, label: "top-priority" },
  ]);
});

Deno.test("processPrFeedback - non-escape-hatch no-changes still uses neutral reply", async () => {
  // A regular .pr_response_message that just acknowledges the comment but
  // doesn't open a follow-up — must still go through the no-changes path.
  const message = "I reviewed the comment and the existing code is correct.";

  const { captured, result } = await runWithResponseMessage(message);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  // Summary should NOT mention escape hatch.
  assertEquals(result.value.summary.includes("escape hatch"), false);
  // Reply should be the neutral "could not identify a code change" message.
  assertEquals(captured.comments.length, 1);
  assertStringIncludes(
    captured.comments[0]!,
    "could not identify a code change",
  );
});

// ---------------------------------------------------------------------------
// Issue #3661 (SEC-6287d379587c): the hand-off claim must be backed by an
// issue that actually exists, not just by prose the model wrote.
// ---------------------------------------------------------------------------

Deno.test("processPrFeedback - a hand-off naming a non-existent follow-up is rejected", async () => {
  const message = "This refactor is out of scope of the current PR. " +
    "I've opened follow-up issue stSoftwareAU/foo#999999 capturing the analysis.";

  const { captured, result } = await runWithResponseMessage(
    message,
    undefined,
    {},
    undefined,
    "gh: Not Found (HTTP 404)",
  );

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.summary.includes("escape hatch"),
    false,
    "an unverifiable hand-off must not be recorded as a resolution",
  );
  assertEquals(captured.comments.length, 1);
  assertStringIncludes(
    captured.comments[0]!,
    "could not identify a code change",
  );
});

// ---------------------------------------------------------------------------
// Issue #185 (SEC-8f21c4a0e7b3): existence is forgeable — the named issue must
// also have been *filed by* the worker or an allowlisted author.
// ---------------------------------------------------------------------------

Deno.test("processPrFeedback - a hand-off naming an existing issue filed by an untrusted author is rejected (Issue #185)", async () => {
  // The attack: injected PR-review text steers the run's own message into
  // citing a real decoy issue the attacker opened. It exists, so the #3661
  // existence check passes — only authorship exposes it.
  const message = "This work is tracked separately in stSoftwareAU/foo#4321, " +
    "so it is out of scope here.";

  const { captured, result, logs } = await runWithResponseMessage(
    message,
    undefined,
    { "stSoftwareAU/foo#4321": ["top-priority"] },
    undefined,
    undefined,
    "drive-by-reviewer",
  );

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.value.summary.includes("escape hatch"),
    false,
    "a forged hand-off must not be recorded as a resolution",
  );
  // The ordinary reply path runs instead of the hand-off reply...
  assertEquals(captured.comments.length, 1);
  assertStringIncludes(
    captured.comments[0]!,
    "could not identify a code change",
  );
  // ...and no label is mutated on the attacker-named issue.
  assertEquals(captured.labelsRemoved, []);
  assert(
    logs.some((l) =>
      l.level === "error" && l.message.includes("not filed by the worker")
    ),
    "the rejection must be logged loudly",
  );
});

Deno.test("processPrFeedback - a transient lookup failure still accepts the hand-off", async () => {
  const message = "This refactor is out of scope of the current PR. " +
    "I've opened follow-up issue stSoftwareAU/foo#101 capturing the analysis.";

  const { result } = await runWithResponseMessage(
    message,
    undefined,
    {},
    undefined,
    "dial tcp: i/o timeout",
  );

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertStringIncludes(result.value.summary, "escape hatch");
});
