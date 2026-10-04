/**
 * The three agent PR passes stand down from a ruleset-gated head (Issue #1679).
 *
 * `stSoftwareAU/GRQ#4702` is the case: its head is a `milestone/**` branch
 * under a `required_status_checks` ruleset, so every direct push was refused
 * with GH013 — once per worker run, spending a merge-conflict attempt and a
 * CI-fix retry on a push that could never land. These tests assert the pass
 * stops before the agent runs and before its budget is spent.
 *
 * Issue #2907 changed the CI-fix pass so a gated head is no longer a
 * permanent dead end: with no fix PR yet in flight it now pushes the fix to
 * a `milestone-fix/**` side branch and raises a PR into the gated head
 * instead of giving up. The CI-fix test below covers the remaining
 * stand-down case — a fix PR already in flight — so a second attempt spends
 * no retry rather than raising a duplicate.
 *
 * Issue #3031 did the same for the merge-conflict pass: a milestone head is
 * handed to the conflict takeover in the same cycle rather than stood down.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { processSpellingFailure } from "../lib/pr_spelling_processor.ts";
import {
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import {
  type MergeConflictProcessorDeps,
  processMergeConflict,
} from "../lib/pr_merge_conflict_processor.ts";
import type { ConflictTakeoverPr } from "../lib/conflict_takeover.ts";
import { resetGatedHeadReportsForTest } from "../lib/gated_head_guard.ts";
import { milestoneFixPrefixFor } from "../lib/milestone_fix_pr.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import type { ClaudeDeps, GitHubDeps } from "../lib/issue_worker_wiring.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const GATED_HEAD = "milestone/4690-bug-sampler-enospc";
const GATED_HEAD_SHA = "4690000000000000000000000000000000000abc";

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

/** What the pass did to GitHub and to the agent. */
interface Observed {
  ghCalls: string[][];
  agentRuns: number;
}

/**
 * Mock deps whose repo answers with a `required_status_checks` ruleset on the
 * milestone head — GRQ's ruleset 21835388, in effect.
 */
function makeDeps(observed: Observed) {
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) => {
      if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
      observed.ghCalls.push(args);
      const joined = args.join(" ");
      if (joined.includes("rules/branches")) {
        return Promise.resolve(
          JSON.stringify([{ type: "required_status_checks" }]),
        );
      }
      if (joined.includes("pr view")) {
        // Issue #3031: the merge-conflict pass reads the head sha it hands
        // to the conflict takeover.
        return Promise.resolve(
          JSON.stringify({ comments: [], headRefOid: GATED_HEAD_SHA }),
        );
      }
      // Issue #2907: the CI-fix pass looks for an already-open milestone-fix
      // PR before it stands down. Answering with one in flight (rather than
      // leaving the default "" — no open PR) exercises the "already in
      // flight, no new attempt" branch instead of the "no fix PR yet, so
      // raise one" branch this mock deliberately does not model.
      if (args[0] === "pr" && args[1] === "list") {
        return Promise.resolve(JSON.stringify([{
          number: 9001,
          url: "https://github.com/org/repo/pull/9001",
          headRefName: `${milestoneFixPrefixFor(GATED_HEAD, 4702)}ci-1`,
        }]));
      }
      return Promise.resolve("");
    },
  };
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() => {
      observed.agentRuns++;
      return Promise.resolve({
        ok: true,
        value: { output: "ran", exitCode: 0, timedOut: false },
      });
    }) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  return createMockDeps({ github: mockGithub, claude: mockClaude });
}

/** True when any `gh` call was a write beyond the stand-down comment. */
function wroteAnythingElse(observed: Observed): boolean {
  return observed.ghCalls.some((args) =>
    !(args[0] === "pr" &&
      (args[1] === "comment" || args[1] === "view" || args[1] === "list")) &&
    !args.join(" ").includes("rules/branches")
  );
}

function standDownComments(observed: Observed): string[] {
  return observed.ghCalls
    .filter((args) => args[0] === "pr" && args[1] === "comment")
    .map((args) => args[args.indexOf("--body") + 1] ?? "");
}

Deno.test("spelling pass - stands down from a gated head without running the agent (Issue #1679)", async () => {
  resetGatedHeadReportsForTest();
  const observed: Observed = { ghCalls: [], agentRuns: 0 };

  const result = await processSpellingFailure({
    repo: "org/repo",
    prNumber: 4702,
    branchName: GATED_HEAD,
    checkRunId: "1",
    checkName: "cspell",
    encodedAnnotations: btoa(JSON.stringify([])),
  }, {
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps: makeDeps(observed),
    workDir: "/tmp/test-repo",
    workRoot: "/tmp/test-work-root",
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.processed, false);
    assertEquals(result.value.changesPushed, false);
    assertStringIncludes(result.value.summary, "refuses direct pushes");
  }
  assertEquals(observed.agentRuns, 0, "the agent must not run on a gated head");
  assertEquals(wroteAnythingElse(observed), false);
  const comments = standDownComments(observed);
  assertEquals(comments.length, 1, "one comment names the rule");
  assertStringIncludes(comments[0]!, "required_status_checks");
});

Deno.test("CI-fix pass - a gated head with a fix already in flight spends no retry (Issues #1679, #2907)", async () => {
  resetGatedHeadReportsForTest();
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-gated-ci-" });
  try {
    const observed: Observed = { ghCalls: [], agentRuns: 0 };
    const stateDir = `${tmpDir}/.ci_check_state`;
    let renewals = 0;

    const result = await processCiFailure({
      repo: "org/repo",
      prNumber: 4702,
      branchName: GATED_HEAD,
      checkRunId: "67890",
      checkName: "CI / test",
      encodedAnnotations: btoa(JSON.stringify([])),
    }, {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps: makeDeps(observed),
      stateDir,
      workDir: tmpDir,
      workRoot: tmpDir,
      // Production runs the pass under the cross-host lock, so the test does
      // too — the stand-down has to hold on the path the worker takes.
      workerId: "worker-1",
      acquireLockFn: (() =>
        Promise.resolve({
          ok: true,
          value: { acquired: true, lockCommentId: 1 },
        })) as unknown as CiProcessorDeps["acquireLockFn"],
      releaseLockFn: (() =>
        Promise.resolve({
          ok: true,
          value: undefined,
        })) as unknown as CiProcessorDeps["releaseLockFn"],
      startLockRenewalFn: (() => {
        renewals++;
        return { stop: () => {} };
      }) as unknown as CiProcessorDeps["startLockRenewalFn"],
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, false);
      assertEquals(
        result.value.retryCount,
        0,
        "a fix PR already in flight must not spend another CI-fix retry",
      );
      assertStringIncludes(result.value.summary, "already in flight");
    }
    assertEquals(observed.agentRuns, 0);
    assertEquals(wroteAnythingElse(observed), false);
    // Issue #2907: reusing an already-open fix PR stands down silently — the
    // fix PR itself carries the explanation, so no duplicate comment is
    // posted on the milestone PR (unlike the spelling pass above, which
    // still posts one).
    assertEquals(standDownComments(observed).length, 0);
    assertEquals(renewals, 1, "the lock is taken and released as usual");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("merge-conflict pass - a milestone head goes to the conflict takeover, never a stand-down (Issues #1679, #3031)", async () => {
  // The merge-conflict pass no longer stands down on a `milestone/**` head
  // (Issue #1772's stand-down is retired): it hands the PR to the conflict
  // takeover in the same cycle, which resolves on a `milestone-fix/**`
  // branch. The pass itself never checks the head out, runs its own agent,
  // takes its own lock or posts a stand-down comment.
  resetGatedHeadReportsForTest();
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-gated-merge-" });
  try {
    const observed: Observed = { ghCalls: [], agentRuns: 0 };
    let lockAttempts = 0;
    const takeovers: ConflictTakeoverPr[] = [];

    const result = await processMergeConflict({
      repo: "org/repo",
      prNumber: 4702,
      branchName: GATED_HEAD,
      baseBranch: "Develop",
      attemptCount: 0,
    }, {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps: makeDeps(observed),
      workDir: tmpDir,
      workRoot: tmpDir,
      workerId: "worker-1",
      trustedAuthors: ["vibe-bot"],
      acquireLockFn: (() => {
        lockAttempts++;
        return Promise.resolve({
          ok: true,
          value: { acquired: true, lockCommentId: 1 },
        });
      }) as unknown as MergeConflictProcessorDeps["acquireLockFn"],
      takeoverResolvers: {
        resolveViaLadder: () => {
          throw new Error("unused: the takeover is stubbed");
        },
        resolveOnFixBranch: () => {
          throw new Error("unused: the takeover is stubbed");
        },
      },
      takeoverFn: (pr) => {
        takeovers.push(pr);
        return Promise.resolve({
          kind: "fix-pr-raised",
          fixPr: {
            number: 9100,
            url: "https://github.com/org/repo/pull/9100",
            opened: true,
          },
          fixBranch: `${milestoneFixPrefixFor(GATED_HEAD, 4702)}takeover-x`,
        });
      },
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, true);
      assertEquals(result.value.merged, false);
      assertEquals(result.value.escalated, false);
    }
    assertEquals(takeovers.length, 1);
    assertEquals(takeovers[0]!.headRefName, GATED_HEAD);
    assertEquals(takeovers[0]!.headSha, GATED_HEAD_SHA);
    assertEquals(observed.agentRuns, 0);
    assertEquals(wroteAnythingElse(observed), false);
    assertEquals(
      lockAttempts,
      0,
      "the takeover owns the cross-host lock, so the pass takes none of its own",
    );
    assertEquals(
      standDownComments(observed),
      [],
      "no stand-down comment is posted on a milestone head",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
