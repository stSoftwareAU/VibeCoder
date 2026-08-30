/**
 * Tests for milestone emission from the PR CI fix processor (Issue #3753).
 *
 * A CI-fix run must leave a readable timeline in the heartbeat comment:
 * claim → diagnosis → fix pushed → released. These tests exercise the
 * wiring (`deps.crashHandling.recordMilestone`), not the storage layer.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
  PrDeps,
} from "../lib/issue_worker_wiring.ts";

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
  const annotations: CheckAnnotation[] = [
    { path: "tests/main_test.ts", start_line: 42, message: "Assertion failed" },
  ];
  return {
    repo: "org/repo",
    prNumber: 3644,
    branchName: "issue-42-fix-bug",
    checkRunId: "67890",
    checkName: "CI / test",
    encodedAnnotations: btoa(JSON.stringify(annotations)),
  };
}

/** Build deps whose `recordMilestone` records the emitted timeline. */
function makeDeps(
  milestones: string[],
  options: { milestoneThrows?: boolean } = {},
) {
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output: "Fixed CI", exitCode: 0, timedOut: false },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
  };
  const mockGithub: Partial<GitHubDeps> = {
    runGhCommand: () => Promise.resolve(""),
  };
  return createMockDeps({
    claude: mockClaude,
    github: mockGithub,
    git: {
      commitAndPushPending: (() =>
        Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: true,
            commitsPushed: 1,
            finalUnpushedCount: 0,
          },
        })) as unknown as GitDeps["commitAndPushPending"],
      captureBranchHead: (() =>
        Promise.resolve({
          ok: true,
          value: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        })) as unknown as GitDeps["captureBranchHead"],
    },
    pr: {
      enableAutoMerge: (() =>
        Promise.resolve()) as unknown as PrDeps["enableAutoMerge"],
    },
    crashHandling: {
      recordMilestone: (
        _workDir: string,
        _repo: string,
        _issueNumber: number,
        text: string,
      ) => {
        if (options.milestoneThrows) {
          return Promise.reject(new Error("milestone exploded"));
        }
        milestones.push(text);
        return Promise.resolve({ ok: true, value: undefined });
      },
    },
  });
}

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

Deno.test("processCiFailure records claim → diagnosis → pushed → released", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "ci-milestones-" });
  try {
    const milestones: string[] = [];
    const processorDeps: CiProcessorDeps = {
      logger: makeSilentLogger(),
      deps: makeDeps(milestones),
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);

    assertEquals(milestones.length >= 4, true);
    assertEquals(
      milestones[0],
      "Claimed PR #3644 (CI check `CI / test` failing)",
    );
    assertEquals(milestones[1]!.startsWith("Diagnosing `CI / test`"), true);
    assertEquals(milestones[1]!.includes("fix attempt 1 of"), true);
    assertEquals(
      milestones[2],
      "Fix pushed (`a1b2c3d`) — waiting on CI re-run",
    );
    assertEquals(milestones.at(-1)!.startsWith("Released — "), true);
    assertEquals(milestones.at(-1)!.includes("Pushed CI fix"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("a throwing recordMilestone never fails the CI fix", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "ci-milestones-" });
  try {
    const processorDeps: CiProcessorDeps = {
      logger: makeSilentLogger(),
      deps: makeDeps([], { milestoneThrows: true }),
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.changesPushed, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
