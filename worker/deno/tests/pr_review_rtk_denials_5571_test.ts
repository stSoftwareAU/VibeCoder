/**
 * RTK's hook cannot rewrite a `pr_review` run past its denials (Issue #5571).
 *
 * RTK's PreToolUse hook (`rtk hook claude`) rewrites `git push` to
 * `rtk git push` before the command runs, and a `Bash(git push:*)` prefix rule
 * does not match a command that starts `rtk`. These tests run the real
 * `processPrFeedback` with RTK wired and assert the review run denies each
 * forbidden command both as typed and in its rewritten form, that an ordinary
 * comment run denies neither, and (where the binary is installed) that the
 * real hook's output is denied.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert } from "@std/assert";
import {
  PR_REVIEW_DISALLOWED_BASH_TOOLS,
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
import { openPrGh } from "./support/pr_live_state_stub.ts";
import { healthyRtkSeam } from "./support/rtk_seam.ts";
import {
  assertCarriesRtkHook,
  type SpawnOptions,
} from "./support/rtk_wiring_asserts.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

const SIX_DENIALS = [
  "Bash(git push:*)",
  "Bash(gh pr merge:*)",
  "Bash(gh api:*)",
  "Bash(rtk git push:*)",
  "Bash(rtk gh pr merge:*)",
  "Bash(rtk gh api:*)",
];

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

/**
 * Claude Code's documented `Bash(<prefix>:*)` semantic: a command, or each
 * sub-command split on `&&`, `||`, `;` and `|`, is denied when it equals the
 * prefix or starts with the prefix and a space.
 */
function deniedBy(command: string, disallowedTools: readonly string[]) {
  const prefixes = disallowedTools
    .map((tool) => /^Bash\((.*):\*\)$/.exec(tool)?.[1])
    .filter((prefix): prefix is string => prefix !== undefined);
  return command.split(/&&|\|\||;|\|/).map((part) => part.trim()).some((
    part,
  ) => prefixes.some((p) => part === p || part.startsWith(`${p} `)));
}

/** Run one RTK-wired feedback round and return the agent's spawn options. */
async function spawnFor(commentType: "pr_review" | "review") {
  const workDir = await Deno.makeTempDir({ prefix: "rtk_5571_wd_" });
  const workRoot = await Deno.makeTempDir({ prefix: "rtk_5571_wr_" });
  try {
    const spawns: SpawnOptions[] = [];
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: ((options: SpawnOptions) => {
        spawns.push(options);
        return Promise.resolve({
          ok: true,
          value: { output: "Fixed the typo", exitCode: 0, timedOut: false },
        });
      }) as unknown as ClaudeDeps["runClaudeWithRetry"],
      prepareRtkRun: healthyRtkSeam(100, 140).prepare,
      rtkProviderId: () => "claude",
    };
    const mockGithub: Partial<GitHubDeps> = { runGhCommand: openPrGh() };
    const deps = createMockDeps({
      claude: mockClaude,
      github: mockGithub,
      git: {
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
    });
    const processorDeps: PrFeedbackProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: silentLogger(),
      deps,
      workDir,
      workRoot,
      rtkOutputEnabled: true,
      verifyPushFn: () =>
        Promise.resolve({
          landed: true,
          localSha: "f".repeat(40),
          remoteSha: "f".repeat(40),
          reason: "verified in test",
        }),
    };
    const result = await processPrFeedback({
      repo: "org/repo",
      prNumber: 42,
      branchName: "issue-42-fix-bug",
      commentType,
      commentId: "123",
      commentBody: "Please fix the typo on line 10",
    }, processorDeps);
    assert(result.ok, "the feedback run must complete");
    assert(spawns.length >= 1, "the agent must be spawned");
    return spawns[0];
  } finally {
    await Deno.remove(workDir, { recursive: true });
    await Deno.remove(workRoot, { recursive: true });
  }
}

Deno.test("pr_review with RTK wired denies each push, merge and api prefix as typed and as RTK rewrites it (Issue #5571)", async () => {
  const spawn = await spawnFor("pr_review");
  assertCarriesRtkHook(spawn);
  const denied = spawn?.disallowedTools as string[];
  for (const entry of SIX_DENIALS) {
    assert(denied.includes(entry), `missing denial ${entry}`);
  }

  for (
    const command of [
      "rtk git push origin foo",
      "rtk gh pr merge 5",
      "rtk gh api repos/x/y",
      "rtk git add -A && rtk git commit -m x && rtk git push",
      "git push origin foo",
      "gh pr merge 5",
      "gh api repos/x/y",
    ]
  ) {
    assert(deniedBy(command, denied), `${command} must be denied`);
  }
  for (const command of ["rtk git status", "rtk git commit -m x"]) {
    assert(!deniedBy(command, denied), `${command} must stay allowed`);
  }
});

Deno.test("an ordinary comment run with RTK wired carries none of the push, merge or api denials (Issue #5571)", async () => {
  const spawn = await spawnFor("review");
  assertCarriesRtkHook(spawn);
  const denied = (spawn?.disallowedTools ?? []) as string[];
  for (const entry of SIX_DENIALS) {
    assert(!denied.includes(entry), `unexpected denial ${entry}`);
  }
});

async function rewrite(command: string): Promise<string> {
  const child = new Deno.Command("rtk", {
    args: ["hook", "claude"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    ),
  );
  await writer.close();
  const { success, code, stdout, stderr } = await child.output();
  if (!success) {
    throw new Error(
      `rtk hook claude exited ${code}: ${new TextDecoder().decode(stderr)}`,
    );
  }
  const text = new TextDecoder().decode(stdout).trim();
  if (text === "") return command;
  const parsed = JSON.parse(text);
  return parsed.hookSpecificOutput?.updatedInput?.command ?? command;
}

const rtkOnPath = (() => {
  try {
    return new Deno.Command("rtk", {
      args: ["--version"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
})();

Deno.test({
  name:
    "the real rtk hook's rewrite of push, merge and api is denied (Issue #5571) (skipped where the rtk binary is not installed)",
  ignore: !rtkOnPath,
  permissions: { run: true },
  async fn() {
    for (
      const command of [
        "git push origin b",
        "gh pr merge 5",
        "gh api repos/x/y",
      ]
    ) {
      const rewritten = await rewrite(command);
      assert(
        deniedBy(rewritten, PR_REVIEW_DISALLOWED_BASH_TOOLS),
        `${command} became ${rewritten}, which is not denied`,
      );
      assert(deniedBy(command, PR_REVIEW_DISALLOWED_BASH_TOOLS));
    }
  },
});
