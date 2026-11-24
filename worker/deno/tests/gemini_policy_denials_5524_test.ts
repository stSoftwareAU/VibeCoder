/**
 * Gemini carries command-prefix denials in a policy file (PR #5524 review).
 *
 * The `pr_review` feedback run and the best-practices scan deny shell commands
 * by prefix (`Bash(git push:*)`, `Bash(cargo:*)`). Before this change a Gemini
 * host refused both runs before the agent started. These tests run the real
 * `processPrFeedback` and the real `defaultRunScan` with Gemini active against
 * a stub CLI, and assert the stub was started and read a settings file that
 * names a policy file holding exactly those denials.
 *
 * Every expected value is a literal. The builder tests are pure; the runner
 * tests copy the per-run settings directory from inside the stub, as the CLI
 * would see it, because the directory is removed when the run ends.
 *
 * Australian English spelling throughout (behaviour, organisation, honour).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildGeminiToolSettings,
  writeGeminiRunSettings,
} from "../lib/gemini_settings.ts";
import {
  IMAGE_AGENT_PROVIDERS_ENV,
  type ToolDenialSettings,
} from "../lib/agent_provider.ts";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import {
  type PrFeedbackInput,
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
import { defaultRunScan } from "../lib/idle_task_templates/best_practices_template.ts";
import type { runIdleTaskClaude } from "../lib/idle_task_claude_budget.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import { envFrom } from "./support/env_lookup.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";
import { openPrGh } from "./support/pr_live_state_stub.ts";

/** The Gemini success stream the stub replays (Gemini CLI 0.68.0 shape). */
const SUCCESS_STREAM = Deno.readTextFileSync(
  new URL(
    "./fixtures/agent_output/gemini-0.68.0-success.jsonl",
    import.meta.url,
  ),
);

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The policy file for the three `pr_review` prefixes, byte for byte. */
const PR_REVIEW_POLICY = `[[rule]]
toolName = "run_shell_command"
commandPrefix = ["git push", "gh pr merge", "gh api"]
decision = "deny"
priority = 999
denyMessage = "Denied by the worker for this run."
`;

/** The settings object the builder admits; fails the test on a refusal. */
function admitted(built: ToolDenialSettings) {
  if (!built.ok) throw new Error(built.refusal.message);
  return built;
}

/** What the stub CLI saw: the settings it was pointed at and the policy tree. */
interface SeenByCli {
  settings: Record<string, unknown>;
  settingsDir: string;
  policy: string;
}

/** Runs `body` with a Gemini stub that records the per-run settings tree. */
async function withGeminiStub<T>(
  root: string,
  run: (
    stub: { path: string; dir: string },
    env: ReturnType<typeof envFrom>,
  ) => Promise<T>,
): Promise<{ value: T; ran: boolean; seen?: SeenByCli }> {
  // Each spawn copies its settings tree to `runs/<n>`; `runs/0` is the first.
  const body = `settings="$GEMINI_CLI_SYSTEM_SETTINGS_PATH"
dir="$(dirname "$0")"
n="$(ls "$dir/runs" 2>/dev/null | wc -l | tr -d ' ')"
mkdir -p "$dir/runs/$n"
cp -R "$(dirname "$settings")/." "$dir/runs/$n/"
printf '%s\\n' "$(dirname "$settings")" > "$dir/runs/$n/settings-dir"
: > "$dir/ran"
cat <<'AGENT_FIXTURE_EOF'
${SUCCESS_STREAM}AGENT_FIXTURE_EOF
exit 0
`;
  const env = envFrom({
    [IMAGE_AGENT_PROVIDERS_ENV]: "claude,gemini",
    TMPDIR: root,
  });
  return await withAgentStub(body, async (stub) => {
    const value = await run(stub, env);
    const ran = await exists(`${stub.dir}/ran`);
    if (!ran) return { value, ran };
    const seen: SeenByCli = {
      settings: JSON.parse(
        await Deno.readTextFile(`${stub.dir}/runs/0/settings.json`),
      ),
      settingsDir: (await Deno.readTextFile(`${stub.dir}/runs/0/settings-dir`))
        .trim(),
      policy: await Deno.readTextFile(`${stub.dir}/runs/0/policy/deny.toml`),
    };
    return { value, ran, seen };
  }, { prefix: "gemini_policy_5524_" });
}

/** Whether a path exists on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** The run options a caller built, re-pointed at the Gemini stub. */
function onGemini(
  options: Parameters<typeof runClaudeWithTimeout>[0],
  stubPath: string,
  env: ReturnType<typeof envFrom>,
): Parameters<typeof runClaudeWithTimeout>[0] {
  return {
    ...options,
    clock: fakeClock(),
    timeoutSeconds: 30,
    killAfterSeconds: 2,
    agentProvider: "gemini",
    agentBinaryPath: stubPath,
    env,
    parentEnv: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
  };
}

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

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

Deno.test("buildGeminiToolSettings - command-prefix denials become one deny rule and need no tools.exclude (PR #5524 review)", () => {
  const built = admitted(buildGeminiToolSettings([
    "Bash(git push:*)",
    "Bash(gh pr merge:*)",
    "Bash(gh api:*)",
  ]));
  assertEquals(built.settings, {});
  assertEquals(built.policy, PR_REVIEW_POLICY);
});

Deno.test("buildGeminiToolSettings - prefixes keep first-appearance order, once, beside a mapped tool (PR #5524 review)", () => {
  const built = admitted(buildGeminiToolSettings([
    "Edit",
    "Bash(cargo:*)",
    "Bash(cargo-clippy:*)",
    "Bash(cargo:*)",
  ]));
  assertEquals(built.settings, { tools: { exclude: ["replace"] } });
  assertStringIncludes(
    built.policy ?? "",
    'commandPrefix = ["cargo", "cargo-clippy"]',
  );
});

Deno.test("buildGeminiToolSettings - a list with no prefix denial carries no policy (PR #5524 review)", () => {
  const built = admitted(buildGeminiToolSettings(["Edit", "Bash"]));
  assertEquals(built.policy, undefined);
});

Deno.test("buildGeminiToolSettings - a Bash form that is not a plain prefix is still refused naming it (PR #5524 review)", () => {
  // Each probe is a Bash(...) the prefix rule must not admit; the control
  // below shows the same shape with a legal prefix is admitted.
  for (
    const tool of [
      "Bash(git push *)", // glob, not Claude's `:*` prefix form
      'Bash(git "push":*)', // a quote would break out of the TOML string
      "Bash( git push:*)", // leading space
      "Bash(git push :*)", // trailing space
      "Bash(:*)", // empty prefix
    ]
  ) {
    const refused = buildGeminiToolSettings(["Edit", tool]);
    assert(!refused.ok, `${tool} must be refused`);
    assertEquals(refused.refusal.kind, "missing_tool_support");
    assertStringIncludes(refused.refusal.message, tool);
  }
  assert(buildGeminiToolSettings(["Edit", "Bash(git push:*)"]).ok);
});

Deno.test({
  name:
    "writeGeminiRunSettings - the policy file is written beside the settings, named by policyPaths, and removed on cleanup (PR #5524 review)",
  permissions: { read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "gemini_policy_5524_w_" });
    try {
      const written = await writeGeminiRunSettings({
        disallowedTools: [
          "Bash(git push:*)",
          "Bash(gh pr merge:*)",
          "Bash(gh api:*)",
        ],
        env: envFrom({ TMPDIR: root }),
      });
      assert(written.ok, written.ok ? "" : written.error.message);
      const settingsPath = written.value.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!;
      const dir = settingsPath.slice(0, settingsPath.lastIndexOf("/"));
      assertEquals(
        JSON.parse(await Deno.readTextFile(settingsPath)),
        { policyPaths: [`${dir}/policy`] },
      );
      assertEquals(
        await Deno.readTextFile(`${dir}/policy/deny.toml`),
        PR_REVIEW_POLICY,
      );
      await written.value.cleanup();
      assertEquals(await exists(dir), false);
      assertEquals([...Deno.readDirSync(root)].length, 0);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

// ---------------------------------------------------------------------------
// The two callers the review named, on Gemini
// ---------------------------------------------------------------------------

/** A `pr_review` input: a CHANGES_REQUESTED review the run answers. */
function reviewInput(): PrFeedbackInput {
  return {
    repo: "org/repo",
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    commentType: "pr_review",
    commentId: "123",
    commentBody: "Please fix the typo on line 10",
  };
}

Deno.test({
  name:
    "processPrFeedback - a pr_review run on Gemini starts the agent with its push, merge and api denials in a policy file (PR #5524 review)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "gemini_policy_5524_pr_" });
    const workDir = await Deno.makeTempDir({
      prefix: "gemini_policy_5524_wd_",
    });
    try {
      const outcome = await withGeminiStub(root, async (stub, env) => {
        const mockClaude: Partial<ClaudeDeps> = {
          // The production processor builds the options; the provider and the
          // CLI binary are pointed at the stub. The system prompt is dropped
          // because Gemini takes its prompt as one argv element, which the
          // fixture prompt plus the real system prompt would exceed, and the
          // browser MCP entry is dropped so the settings file holds only the
          // denials; neither changes the denials under test.
          runClaudeWithRetry:
            ((options: Parameters<typeof runClaudeWithTimeout>[0]) =>
              runClaudeWithTimeout(
                onGemini(
                  { ...options, systemPrompt: "", mcpConfig: undefined },
                  stub.path,
                  env,
                ),
              )) as unknown as ClaudeDeps["runClaudeWithRetry"],
        };
        const mockGithub: Partial<GitHubDeps> = {
          runGhCommand: openPrGh((args: string[]) => {
            if (
              args[0] === "pr" && args[1] === "view" &&
              args.includes("baseRefName")
            ) {
              return Promise.resolve("main");
            }
            return Promise.resolve("");
          }),
        };
        const deps = createMockDeps({
          claude: mockClaude,
          github: mockGithub,
          git: {
            runGitCommand: (() =>
              Promise.resolve({
                ok: true,
                value: { code: 0, stdout: "", stderr: "" },
              })) as unknown as GitDeps["runGitCommand"],
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
          workRoot: "/tmp/test-work-root",
          verifyPushFn: () =>
            Promise.resolve({
              landed: true,
              localSha: "f".repeat(40),
              remoteSha: "f".repeat(40),
              reason: "verified in test",
            }),
          qualityInstructions: "",
        };
        return await processPrFeedback(reviewInput(), processorDeps);
      });
      assert(
        outcome.ran,
        "the Gemini agent was never started, so the run was refused",
      );
      assert(outcome.seen);
      assertEquals(outcome.seen.policy, PR_REVIEW_POLICY);
      assertEquals(outcome.seen.settings, {
        policyPaths: [`${outcome.seen.settingsDir}/policy`],
      });
      assertEquals(await exists(outcome.seen.settingsDir), false);
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(workDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "defaultRunScan - the best-practices scan on Gemini starts the agent with its build-tool denials in a policy file (PR #5524 review)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir({ prefix: "gemini_policy_5524_scan_" });
    const workDir = await Deno.makeTempDir({
      prefix: "gemini_policy_5524_sw_",
    });
    try {
      const outcome = await withGeminiStub(root, async (stub, env) => {
        // The production scan builds the options; the fake runner only
        // re-points them at the Gemini stub.
        const runOnGemini: typeof runIdleTaskClaude = (options) =>
          runClaudeWithTimeout(onGemini(options, stub.path, env));
        return await defaultRunScan(
          {
            repo: "org/repo",
            workDir,
            bucket: "typescript",
            knownOpenFindingIds: [],
            openIssueTitles: [],
            suppressedIds: [],
          },
          () => Promise.resolve({ ok: true, value: "scan {{BUCKET_GUIDE}}" }),
          () => Promise.resolve("guide"),
          runOnGemini,
        );
      });
      assert(
        outcome.ran,
        "the Gemini agent was never started, so the scan was refused",
      );
      assert(outcome.seen);
      assertEquals(outcome.value.ok, true);
      assertEquals(outcome.seen.settings, {
        tools: {
          exclude: [
            "write_file",
            "replace",
            "enter_plan_mode",
            "exit_plan_mode",
          ],
        },
        policyPaths: [`${outcome.seen.settingsDir}/policy`],
      });
      assertEquals(
        outcome.seen.policy,
        `[[rule]]
toolName = "run_shell_command"
commandPrefix = ["cargo", "rustc", "rustup", "rustdoc", "clippy-driver", "cargo-clippy"]
decision = "deny"
priority = 999
denyMessage = "Denied by the worker for this run."
`,
      );
      assertEquals(await exists(outcome.seen.settingsDir), false);
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(workDir, { recursive: true });
    }
  },
});
