/**
 * End-to-end test: the worker auto-resolves automated review findings without
 * human follow-up (Issue #1860, part of #1854).
 *
 * Reproduces the private-repo-14 #2524 scenario at integration scope: a trusted
 * automated review bot leaves a "Useless conditional" line-level review
 * comment on a PR. The worker must:
 *
 *   - Path A (#1857): pick up the bot review comment via
 *     `findPrCommentsToFix` when no other triggering comment exists, and
 *   - Path B (#1858): when the trigger is an authorised human's
 *     "please resolve" comment, bundle the bot's unresolved review
 *     comments into the Claude prompt as an "Automated Review Comments"
 *     section.
 *
 * For both paths the test stubs the Claude invocation to capture the
 * prompt that would have been sent and asserts the bot finding is
 * present in the prompt. The neutral fallback "could not identify a
 * code change to apply" message must not be produced.
 *
 * Reference: private-repo-14#2524 — `https://github.com/stSoftwareAU/private-repo-14/pull/2524`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  findPrCommentsToFix,
  type PrScanOptions,
} from "../lib/pr_maintenance.ts";
import {
  type PrFeedbackInput,
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures matching the private-repo-14 #2524 finding shape
// ---------------------------------------------------------------------------

const REPO = "org/repo";
const PR_NUMBER = 2524;
const BRANCH = "issue-2524-fix";
const TRUSTED_BOT = "github-code-quality[bot]";
const HUMAN_TRIGGER = "alice";

const BOT_FINDING_BODY =
  "Useless conditional - This negation always evaluates to true. " +
  "Change `for (let i = 0; i < 30 && !caught; i++)` to " +
  "`for (let i = 0; i < 30; i++)`.";

const BOT_FILE_PATH = "src/runner.ts";
const BOT_FILE_LINE = 42;
const BOT_DIFF_HUNK = "@@ -40,5 +40,5 @@\n" +
  " function run() {\n" +
  "-  for (let i = 0; i < 30 && !caught; i++) {\n" +
  "+  for (let i = 0; i < 30; i++) {\n" +
  "     work();\n" +
  "   }\n";

const HUMAN_TRIGGER_BODY = "Please resolve the linter findings on this PR.";

const NO_CHANGES_FALLBACK = "could not identify a code change to apply";

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

interface CapturedPrompt {
  prompt?: string;
  systemPrompt?: string;
}

interface MockState {
  /** PR comment bodies posted via `gh pr comment ... --body <body>`. */
  prCommentBodies: string[];
  /** The captured Claude prompt and system prompt. */
  captured: CapturedPrompt;
}

/**
 * Build a mock `gh` command function that returns:
 *   - empty PR list passes through (the processor doesn't list PRs)
 *   - `pulls/{n}/comments` → the trusted-bot review comment fixture
 *   - `issues/{n}/comments` → the supplied issue-comment fixture
 *   - any other call → empty JSON
 *
 * Captures any `pr comment ... --body <body>` calls so the test can
 * verify the worker's outgoing PR comments.
 */
function makeMockGh(
  state: MockState,
  options: { issueCommentsJson: string; reviewCommentsJson: string },
): GitHubDeps["runGhCommand"] {
  return (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "comment") {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0) {
        const body = args[bodyIdx + 1];
        if (body !== undefined) state.prCommentBodies.push(body);
      }
      return Promise.resolve("");
    }

    const key = args.join(" ");

    // Filtered fetch used by `findPrCommentsToFix` via `fetchPrComments`.
    // The jq filter is `.reactions.eyes == 0 | {login,id,body,thumbs_up}`,
    // so we return the projected shape directly.
    if (
      key.includes(`pulls/${PR_NUMBER}/comments`) &&
      args.includes("--jq")
    ) {
      return Promise.resolve(options.reviewCommentsJson);
    }
    if (
      key.includes(`issues/${PR_NUMBER}/comments`) &&
      args.includes("--jq")
    ) {
      return Promise.resolve(options.issueCommentsJson);
    }

    // Unfiltered fetch used by `fetchTrustedBotReviewComments` — full
    // raw GitHub API shape.
    if (
      key.includes(`pulls/${PR_NUMBER}/comments`) &&
      !args.includes("--jq")
    ) {
      return Promise.resolve(JSON.stringify([
        {
          id: 9001,
          user: { login: TRUSTED_BOT },
          path: BOT_FILE_PATH,
          line: BOT_FILE_LINE,
          original_line: BOT_FILE_LINE,
          diff_hunk: BOT_DIFF_HUNK,
          body: BOT_FINDING_BODY,
          html_url:
            `https://github.com/${REPO}/pull/${PR_NUMBER}#discussion_r9001`,
          reactions: { eyes: 0 },
        },
      ]));
    }

    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify([
        { number: PR_NUMBER, headRefName: BRANCH, headRefOid: "sha2524" },
      ]));
    }

    return Promise.resolve("[]");
  };
}

/**
 * Build the Claude mock that captures the prompt and reports a normal
 * successful run — so the no-changes fallback path is not taken on the
 * basis of a Claude failure.
 */
function makeCapturingClaude(
  state: MockState,
): Partial<ClaudeDeps> {
  return {
    runClaudeWithRetry:
      ((options: { prompt: string; systemPrompt?: string }) => {
        state.captured.prompt = options.prompt;
        state.captured.systemPrompt = options.systemPrompt;
        return Promise.resolve({
          ok: true,
          value: { output: "Applied fix.", exitCode: 0, timedOut: false },
        });
      }) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
}

/**
 * Build a `commitAndPushPending` mock that simulates a successful push
 * so the processor takes the `replyWithResult` branch (success) rather
 * than `replyNoChanges`.
 */
function makeSuccessfulCommit(): Partial<GitDeps> {
  return {
    commitAndPushPending: (() =>
      Promise.resolve({
        ok: true,
        value: {
          committedNewChanges: false,
          commitsPushed: 1,
          finalUnpushedCount: 0,
        },
      })) as unknown as GitDeps["commitAndPushPending"],
  };
}

function makeProcessorDeps(
  state: MockState,
  options: { issueCommentsJson: string; reviewCommentsJson: string },
  workDir: string,
): PrFeedbackProcessorDeps {
  const deps = createMockDeps({
    claude: makeCapturingClaude(state),
    github: { runGhCommand: makeMockGh(state, options) },
    git: makeSuccessfulCommit(),
  });
  return {
    logger: makeSilentLogger(),
    deps,
    workDir,
    trustedReviewBots: [TRUSTED_BOT],
  };
}

// ---------------------------------------------------------------------------
// Path A — #1857: bot review comment selected as the actionable trigger
// ---------------------------------------------------------------------------

Deno.test(
  "e2e #1860 path A — trusted-bot review comment is selected as actionable when no other trigger exists",
  async () => {
    const reviewCommentsJson = JSON.stringify([
      {
        login: TRUSTED_BOT,
        id: 9001,
        body: BOT_FINDING_BODY,
        thumbs_up: 0,
      },
    ]);
    const issueCommentsJson = "[]";

    const state: MockState = {
      prCommentBodies: [],
      captured: {},
    };

    const scanOptions: PrScanOptions = {
      githubUser: "vibe-bot",
      repos: [REPO],
      logger: makeSilentLogger(),
      isRepoAllowed: () => true,
      // The bot is neither in authorisedCommenters nor providing a
      // thumbs-up — its trust must come solely from the
      // trustedReviewBots allowlist (Issue #1857).
      isAuthorisedCommenter: () => false,
      ghCommandFn: makeMockGh(state, { issueCommentsJson, reviewCommentsJson }),
      trustedReviewBots: [TRUSTED_BOT],
    };

    const result = await findPrCommentsToFix(scanOptions);
    assert(result.ok, "scan should succeed");
    assert(result.value !== null, "expected an actionable comment");
    assertEquals(result.value.commentType, "review");
    assertEquals(result.value.prNumber, PR_NUMBER);
    assertEquals(result.value.commentId, "9001");
    // Body is base64-encoded by encodeBase64 — decode and confirm.
    assertEquals(atob(result.value.encodedBody), BOT_FINDING_BODY);
  },
);

// ---------------------------------------------------------------------------
// Path B — #1858: human trigger plus bundled bot review context
// ---------------------------------------------------------------------------

Deno.test(
  "e2e #1860 path B — human 'please resolve' trigger bundles bot finding into the Claude prompt",
  async () => {
    const reviewCommentsJson = JSON.stringify([
      {
        login: TRUSTED_BOT,
        id: 9001,
        body: BOT_FINDING_BODY,
        thumbs_up: 0,
      },
    ]);
    const issueCommentsJson = JSON.stringify([
      {
        login: HUMAN_TRIGGER,
        id: 7001,
        body: HUMAN_TRIGGER_BODY,
        thumbs_up: 1,
      },
    ]);

    const state: MockState = {
      prCommentBodies: [],
      captured: {},
    };

    const tmpDir = await Deno.makeTempDir();
    try {
      const input: PrFeedbackInput = {
        repo: REPO,
        prNumber: PR_NUMBER,
        branchName: BRANCH,
        commentType: "issue",
        commentId: "7001",
        commentBody: HUMAN_TRIGGER_BODY,
      };

      const result = await processPrFeedback(
        input,
        makeProcessorDeps(
          state,
          { issueCommentsJson, reviewCommentsJson },
          tmpDir,
        ),
      );

      assert(result.ok, "processor should succeed");
      assert(state.captured.prompt, "expected Claude prompt to be captured");

      // The "Automated Review Comments" section from #1858 must be
      // present, anchored on the bot's path/line, and quote the
      // bot's finding body. We anchor on a unique fragment of the
      // bot body ("negation always evaluates to true") that the v7
      // prompt template does not itself contain, so a passing
      // assertion proves the bundling actually ran.
      assertStringIncludes(state.captured.prompt!, "Automated Review Comments");
      assertStringIncludes(state.captured.prompt!, TRUSTED_BOT);
      assertStringIncludes(
        state.captured.prompt!,
        `file="${BOT_FILE_PATH}" line="${BOT_FILE_LINE}"`,
      );
      assertStringIncludes(
        state.captured.prompt!,
        "negation always evaluates to true",
      );
      // The human trigger body still appears as the original PR
      // review comment, so the prompt carries both the trigger and
      // the structured bot context.
      assertStringIncludes(state.captured.prompt!, HUMAN_TRIGGER_BODY);

      // The neutral fallback must not have been posted.
      const fallbackPosted = state.prCommentBodies.some((b) =>
        b.includes(NO_CHANGES_FALLBACK)
      );
      assertEquals(
        fallbackPosted,
        false,
        `Path B: did not expect '${NO_CHANGES_FALLBACK}' in PR comments; got: ${
          state.prCommentBodies.join(" | ")
        }`,
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Path A end-to-end — bot trigger feeds processPrFeedback, prompt still
// contains the bot finding
// ---------------------------------------------------------------------------

Deno.test(
  "e2e #1860 path A end-to-end — bot-triggered feedback produces a prompt that includes the bot finding",
  async () => {
    const reviewCommentsJson = JSON.stringify([
      {
        login: TRUSTED_BOT,
        id: 9001,
        body: BOT_FINDING_BODY,
        thumbs_up: 0,
      },
    ]);
    const issueCommentsJson = "[]";

    const state: MockState = {
      prCommentBodies: [],
      captured: {},
    };

    const tmpDir = await Deno.makeTempDir();
    try {
      // When the bot is the actionable trigger, the processor receives
      // the bot's body directly as the comment body (decoded from the
      // base64 payload that `findPrCommentsToFix` emits). We supply
      // the same body here.
      const input: PrFeedbackInput = {
        repo: REPO,
        prNumber: PR_NUMBER,
        branchName: BRANCH,
        commentType: "review",
        commentId: "9001",
        commentBody: BOT_FINDING_BODY,
      };

      const result = await processPrFeedback(
        input,
        makeProcessorDeps(
          state,
          { issueCommentsJson, reviewCommentsJson },
          tmpDir,
        ),
      );

      assert(result.ok, "processor should succeed");
      assert(state.captured.prompt, "expected Claude prompt to be captured");

      // The bot's finding must appear in the prompt — either as the
      // trigger comment or as the bundled "Automated Review
      // Comments" section. In practice the processor includes both.
      // We anchor on the unique "negation always evaluates to true"
      // fragment because the literal "Useless conditional" appears
      // in the v7 prompt template itself.
      assertStringIncludes(
        state.captured.prompt!,
        "negation always evaluates to true",
      );
      assertStringIncludes(state.captured.prompt!, "Automated Review Comments");

      const fallbackPosted = state.prCommentBodies.some((b) =>
        b.includes(NO_CHANGES_FALLBACK)
      );
      assertEquals(
        fallbackPosted,
        false,
        `Path A: did not expect '${NO_CHANGES_FALLBACK}' in PR comments; got: ${
          state.prCommentBodies.join(" | ")
        }`,
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Regression check — if #1858's bundling is removed, the prompt loses
// the "Automated Review Comments" section. A test that asserts the
// section is present therefore fails as expected if the dependency is
// reverted.
// ---------------------------------------------------------------------------

Deno.test(
  "e2e #1860 regression — without trustedReviewBots configured, no bot bundling occurs",
  async () => {
    // This complements the positive tests above: it confirms that the
    // bundling is conditional on the trustedReviewBots config and not
    // an unconditional behaviour. Reverting #1858 removes the
    // bundling for all calls; reverting only the wiring removes it
    // when the config is set. Either way, the positive tests above
    // detect the regression — this test documents the negative case
    // explicitly.
    const reviewCommentsJson = JSON.stringify([
      {
        login: TRUSTED_BOT,
        id: 9001,
        body: BOT_FINDING_BODY,
        thumbs_up: 0,
      },
    ]);
    const issueCommentsJson = JSON.stringify([
      {
        login: HUMAN_TRIGGER,
        id: 7001,
        body: HUMAN_TRIGGER_BODY,
        thumbs_up: 1,
      },
    ]);

    const state: MockState = {
      prCommentBodies: [],
      captured: {},
    };

    const tmpDir = await Deno.makeTempDir();
    try {
      const deps = createMockDeps({
        claude: makeCapturingClaude(state),
        github: {
          runGhCommand: makeMockGh(state, {
            issueCommentsJson,
            reviewCommentsJson,
          }),
        },
        git: makeSuccessfulCommit(),
      });

      const processorDeps: PrFeedbackProcessorDeps = {
        logger: makeSilentLogger(),
        deps,
        workDir: tmpDir,
        // trustedReviewBots intentionally omitted.
      };

      const input: PrFeedbackInput = {
        repo: REPO,
        prNumber: PR_NUMBER,
        branchName: BRANCH,
        commentType: "issue",
        commentId: "7001",
        commentBody: HUMAN_TRIGGER_BODY,
      };

      const result = await processPrFeedback(input, processorDeps);
      assert(result.ok, "processor should succeed");
      assert(state.captured.prompt, "expected Claude prompt to be captured");

      // The phrase "Automated Review Comments" and "Useless
      // conditional" both appear in the v7 prompt template's
      // instructions even when no bot data is bundled, so we check
      // for a unique fragment of the bot finding ("negation always
      // evaluates to true") that only enters the prompt via the
      // bundled section.
      const uniqueFragment = "negation always evaluates to true";
      const hasFinding = state.captured.prompt!.includes(uniqueFragment);
      assertEquals(
        hasFinding,
        false,
        "When trustedReviewBots is unset, the bot's finding must not appear in the prompt",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);
