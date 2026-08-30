/**
 * A head a sibling fleet host moved mid-run is rebased onto and pushed —
 * not handed to a human (Issue #211).
 *
 * Reproduces the NEAT-AI-core #557 shape at processor scope: the final-mile
 * push leaves commits behind because the branch moved under us. The worker
 * must rebase onto the new head and push, report the fix as pushed, and post
 * no "please check the branch status" comment. When the rebase genuinely
 * cannot be recovered, the comment must carry the failing step and git's own
 * words rather than a bare instruction to go and look.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";

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

function makeInput(): CiFixInput {
  return {
    repo: "stSoftwareAU/NEAT-AI-core",
    prNumber: 557,
    branchName: "issue-556-quality",
    checkRunId: "67890",
    checkName: "Quality Checks",
    encodedAnnotations: btoa(JSON.stringify([])),
  };
}

/** Capture every `gh pr comment --body …` the processor posts. */
function makeCommentCapturingGh(
  bodies: string[],
): GitHubDeps["runGhCommand"] {
  return ((args: string[]) => {
    if (args[0] === "pr" && args[1] === "comment") {
      const idx = args.indexOf("--body");
      if (idx >= 0 && args[idx + 1] !== undefined) bodies.push(args[idx + 1]!);
    }
    return Promise.resolve("");
  }) as GitHubDeps["runGhCommand"];
}

const claudeFixed: Partial<ClaudeDeps> = {
  runClaudeWithRetry: (() =>
    Promise.resolve({
      ok: true,
      value: {
        output: "Fixed the quality issues",
        exitCode: 0,
        timedOut: false,
      },
    })) as unknown as ClaudeDeps["runClaudeWithRetry"],
};

/**
 * Issue #579: a claim that the push landed is now made against the REMOTE,
 * not against local state. Tests that assert a successful push therefore say
 * so explicitly — clean local state, and a moved HEAD, are no longer
 * sufficient evidence on their own.
 */
const REMOTE_CONFIRMS_PUSH = () =>
  Promise.resolve({
    landed: true,
    localSha: "f".repeat(40),
    remoteSha: "f".repeat(40),
    reason: "verified in test",
  });

Deno.test("processCiFailure - rebases onto the moved head, pushes, and posts no 'check the branch' comment (Issue #211)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const bodies: string[] = [];
  try {
    let commitCall = 0;
    let recoveryCalled = false;
    const deps = createMockDeps({
      claude: claudeFixed,
      github: { runGhCommand: makeCommentCapturingGh(bodies) },
      git: {
        commitAndPushPending: (() => {
          commitCall++;
          // First call: the sibling's push means our commit did not land.
          // Second call (after the rebase): it lands cleanly.
          return Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: commitCall === 1,
              commitsPushed: commitCall === 1 ? 0 : 1,
              finalUnpushedCount: commitCall === 1 ? 1 : 0,
            },
          });
        }) as unknown as GitDeps["commitAndPushPending"],
        recoverFromPushRejection: (() => {
          recoveryCalled = true;
          return Promise.resolve({
            ok: true,
            value: "Push succeeded after rebase recovery",
          });
        }) as unknown as GitDeps["recoverFromPushRejection"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processCiFailure(makeInput(), processorDeps);

    assert(result.ok);
    assertEquals(recoveryCalled, true, "the moved head must trigger a rebase");
    if (result.ok) {
      assertEquals(
        result.value.changesPushed,
        true,
        "a fix that landed after the rebase counts as pushed",
      );
    }
    assertEquals(
      bodies.some((b) => b.includes("Please check the branch status")),
      false,
      "a recovered push must not ask a human to check the branch",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - an unrecoverable push names the failing step in the comment (Issue #211)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const bodies: string[] = [];
  try {
    const deps = createMockDeps({
      claude: claudeFixed,
      github: { runGhCommand: makeCommentCapturingGh(bodies) },
      git: {
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: true,
              commitsPushed: 0,
              finalUnpushedCount: 1,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
        recoverFromPushRejection: (() =>
          Promise.resolve({
            ok: false,
            error: new Error(
              "Push recovery failed at step 'force-with-lease': stale info",
            ),
          })) as unknown as GitDeps["recoverFromPushRejection"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assert(result.ok);
    if (result.ok) assertEquals(result.value.changesPushed, false);

    const pushFailedComment = bodies.find((b) =>
      b.includes("Please check the branch status")
    );
    assert(pushFailedComment, "expected the push-failure comment");
    assert(
      pushFailedComment.includes("force-with-lease"),
      `the comment must name the failing step, got: ${pushFailedComment}`,
    );
    assert(
      pushFailedComment.includes("stale info"),
      `the comment must carry git's stderr, got: ${pushFailedComment}`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
