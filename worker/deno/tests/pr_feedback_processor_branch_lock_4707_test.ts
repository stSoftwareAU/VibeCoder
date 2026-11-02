/**
 * Issue #4707: PR feedback must not edit a PR whose branch-update lock another
 * fleet worker (the fleet PR babysitter) holds — it defers before claiming.
 */
import { assertEquals } from "@std/assert";
import {
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubDeps } from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

const silent = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

function depsWith(
  locked: boolean,
  writes: string[][],
  lockReads: Array<[string, number]>,
): PrFeedbackProcessorDeps {
  const github: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) => {
      if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
      // `gh pr comment` (the claim) and a `gh api` call with a method or a
      // field (`-f` implies POST) are writes.
      if (
        (args[0] === "pr" && args[1] === "comment") ||
        (args[0] === "api" &&
          ["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"]
            .some((flag) => args.includes(flag)))
      ) writes.push(args);
      return Promise.resolve("[]");
    },
  };
  return {
    promptsDir: new URL("../../../prompts", import.meta.url).pathname,
    logger: silent,
    deps: createMockDeps({ github }),
    workDir: "/tmp/test",
    workRoot: "/tmp/test-work-root",
    workerId: "my-worker",
    prUpdateLockHeldFn: (repo, prNumber) => {
      lockReads.push([repo, prNumber]);
      return Promise.resolve(locked);
    },
  };
}

const input = {
  repo: "owner/repo",
  prNumber: 5060,
  branchName: "feature",
  commentType: "pr_review" as const,
  commentId: "123",
  commentBody: "Please revert the unrelated rewrite.",
};

Deno.test("PR feedback defers without claiming while another worker holds the branch lock", async () => {
  const writes: string[][] = [];
  const lockReads: Array<[string, number]> = [];
  const result = await processPrFeedback(
    input,
    depsWith(true, writes, lockReads),
  );
  assertEquals(lockReads, [["owner/repo", 5060]]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.processed, false);
    assertEquals(result.value.changesPushed, false);
    assertEquals(result.value.summary.includes("branch-update lock"), true);
  }
  assertEquals(writes, []);
});

Deno.test("PR feedback goes on to claim when no branch lock is held", async () => {
  const writes: string[][] = [];
  const lockReads: Array<[string, number]> = [];
  await processPrFeedback(input, depsWith(false, writes, lockReads));
  assertEquals(lockReads, [["owner/repo", 5060]]);
  assertEquals(
    writes.some((args) =>
      args.join(" ").includes("PR_COMMENT_CLAIM:my-worker:123")
    ),
    true,
  );
});
