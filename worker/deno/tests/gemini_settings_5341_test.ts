/**
 * The Gemini per-run settings file (Issue #5341).
 *
 * Every expected value here is a literal, written out by hand; nothing is
 * computed by calling the implementation. The last group runs the real runner
 * against a stub that records the settings file the CLI would read, and asserts
 * the file's content, its modes, and that it is removed after the run.
 *
 * Australian English spelling throughout (behaviour, organisation, honour).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildGeminiToolSettings,
  GEMINI_SYSTEM_SETTINGS_ENV_VAR,
  writeGeminiRunSettings,
} from "../lib/gemini_settings.ts";
import {
  IMAGE_AGENT_PROVIDERS_ENV,
  type ToolDenialSettings,
} from "../lib/agent_provider.ts";
import {
  runClaudeWithTimeout,
  SUMMARISE_DISALLOWED_TOOLS,
} from "../lib/claude_runner.ts";
import { CLOSURE_VERDICT_DISALLOWED_TOOLS } from "../lib/closure_verdict_recovery.ts";
import { envFrom } from "./support/env_lookup.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

/** The tools a reviewer role denies (the orchestrator's reviewer list). */
const REVIEWER_TOOLS = [
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Bash",
  "Task",
  "Agent",
];

/** The exact bytes the settings file holds for the reviewer list. */
const REVIEWER_SETTINGS_FILE =
  '{\n  "tools": {\n    "exclude": [\n      "replace",\n      "write_file",\n      "run_shell_command"\n    ]\n  },\n  "experimental": {\n    "enableAgents": false\n  }\n}\n';

/** The Gemini success stream the stub replays (Gemini CLI 0.68.0 shape). */
const SUCCESS_STREAM = Deno.readTextFileSync(
  new URL(
    "./fixtures/agent_output/gemini-0.68.0-success.jsonl",
    import.meta.url,
  ),
);

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

/** The settings object the builder admits; fails the test on a refusal. */
function settingsOf(built: ToolDenialSettings): Record<string, unknown> {
  if (!built.ok) throw new Error(built.refusal.message);
  return built.settings;
}

Deno.test("the reviewer list maps to the exact settings object (Issue #5341)", () => {
  assertEquals(settingsOf(buildGeminiToolSettings(REVIEWER_TOOLS)), {
    tools: { exclude: ["replace", "write_file", "run_shell_command"] },
    experimental: { enableAgents: false },
  });
});

Deno.test("the reviewer settings file holds the exact literal content and is removed on cleanup (Issue #5341)", async () => {
  const root = await Deno.makeTempDir({ prefix: "gemini_settings_5341_a_" });
  try {
    const written = await writeGeminiRunSettings({
      disallowedTools: REVIEWER_TOOLS,
      env: envFrom({ TMPDIR: root }),
    });
    assert(written.ok, written.ok ? "" : written.error.message);
    const path = written.value.env[GEMINI_SYSTEM_SETTINGS_ENV_VAR];
    assert(path !== undefined, "the writer names the settings file in its env");
    assertEquals(written.value.env, {
      [GEMINI_SYSTEM_SETTINGS_ENV_VAR]: path,
    });
    assert(path.startsWith(`${root}/`), `path ${path} is inside ${root}`);
    assertEquals(await Deno.readTextFile(path), REVIEWER_SETTINGS_FILE);
    await written.value.cleanup();
    await written.value.cleanup();
    assertEquals(await exists(path), false);
    assertEquals(await exists(root), true);
    assertEquals([...Deno.readDirSync(root)].length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the executor list denies only sub-agents and writes no tools key (Issue #5341)", () => {
  assertEquals(settingsOf(buildGeminiToolSettings(["Task", "Agent"])), {
    experimental: { enableAgents: false },
  });
});

Deno.test("an unmapped denied tool is refused as missing_tool_support naming it (Issue #5341)", () => {
  // `Bash(git push *)` is not the `:*` prefix form (which a policy file
  // carries, PR #5524 review), so no Gemini setting enforces it.
  const refused = buildGeminiToolSettings(["Edit", "Bash(git push *)"]);
  assert(
    !refused.ok,
    "Bash(git push *) has no Gemini setting, so it is refused",
  );
  assertEquals(refused.refusal.kind, "missing_tool_support");
  assertStringIncludes(refused.refusal.message, "Bash(git push *)");
  // Control: the mapped name alone is admitted.
  assertEquals(settingsOf(buildGeminiToolSettings(["Edit"])), {
    tools: { exclude: ["replace"] },
  });
});

Deno.test("the default runner denials map to the plan-mode tools (Issue #5341)", () => {
  assertEquals(
    settingsOf(buildGeminiToolSettings(["EnterPlanMode", "ExitPlanMode"])),
    {
      tools: { exclude: ["enter_plan_mode", "exit_plan_mode"] },
    },
  );
});

Deno.test("the existing summarise and closure-verdict callers are enforced, not refused (Issue #5341)", () => {
  assertEquals(
    settingsOf(buildGeminiToolSettings(SUMMARISE_DISALLOWED_TOOLS)),
    {
      tools: {
        exclude: [
          "run_shell_command",
          "write_file",
          "replace",
          "web_fetch",
          "google_web_search",
          "enter_plan_mode",
          "exit_plan_mode",
        ],
      },
      experimental: { enableAgents: false },
    },
  );
  assertEquals(
    settingsOf(buildGeminiToolSettings(CLOSURE_VERDICT_DISALLOWED_TOOLS)),
    {
      tools: {
        exclude: [
          "write_file",
          "replace",
          "web_fetch",
          "google_web_search",
          "enter_plan_mode",
          "exit_plan_mode",
        ],
      },
      experimental: { enableAgents: false },
    },
  );
});

Deno.test("an empty denial list builds an empty settings object (Issue #5341)", () => {
  assertEquals(settingsOf(buildGeminiToolSettings([])), {});
});

Deno.test({
  name:
    "runClaudeWithTimeout - a Gemini run reads a per-run settings file that denies the reviewer tools, and removes it after (Issue #5341)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "gemini_settings_5341_root_",
    });
    try {
      // The stub records what the CLI would see, then replays a success stream.
      const body = `settings="$GEMINI_CLI_SYSTEM_SETTINGS_PATH"
dir="$(dirname "$0")"
printf '%s\\n' "$settings" > "$dir/recorded-path"
cat "$settings" > "$dir/recorded-content"
ls -ld "$settings" > "$dir/recorded-file"
ls -ld "$(dirname "$settings")" > "$dir/recorded-dir"
: > "$dir/ran"
cat <<'AGENT_FIXTURE_EOF'
${SUCCESS_STREAM}AGENT_FIXTURE_EOF
exit 0
`;
      const evidence = await withAgentStub(
        body,
        async (stub) => {
          const result = await runClaudeWithTimeout({
            clock: fakeClock(),
            prompt: "test",
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            agentProvider: "gemini",
            agentBinaryPath: stub.path,
            env: envFrom({
              [IMAGE_AGENT_PROVIDERS_ENV]: "claude,gemini",
              TMPDIR: root,
            }),
            parentEnv: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
            disallowedTools: REVIEWER_TOOLS,
          });
          return {
            result,
            path: (await Deno.readTextFile(`${stub.dir}/recorded-path`)).trim(),
            content: await Deno.readTextFile(`${stub.dir}/recorded-content`),
            file: (await Deno.readTextFile(`${stub.dir}/recorded-file`)).trim(),
            dir: (await Deno.readTextFile(`${stub.dir}/recorded-dir`)).trim(),
          };
        },
        { prefix: "gemini_settings_5341_" },
      );
      assert(
        evidence.result.ok,
        evidence.result.ok ? "" : evidence.result.error.message,
      );
      assert(
        evidence.path.startsWith(`${root}/`),
        `the CLI was pointed at ${evidence.path}, outside ${root}`,
      );
      assertEquals(evidence.content, REVIEWER_SETTINGS_FILE);
      assert(
        evidence.file.startsWith("-rw-------"),
        `file mode was ${evidence.file}`,
      );
      assert(
        evidence.dir.startsWith("drwx------"),
        `directory mode was ${evidence.dir}`,
      );
      assertEquals(await exists(evidence.path), false);
      assertEquals([...Deno.readDirSync(root)].length, 0);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - a Gemini run whose settings directory is missing is refused before the agent starts (Issue #5341)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "gemini_settings_5341_missing_",
    });
    const missing = `${root}/missing`;
    try {
      const body = `: > "$(dirname "$0")/ran"\nexit 0\n`;
      const outcome = await withAgentStub(
        body,
        async (stub) => {
          const result = await runClaudeWithTimeout({
            clock: fakeClock(),
            prompt: "test",
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            agentProvider: "gemini",
            agentBinaryPath: stub.path,
            env: envFrom({
              [IMAGE_AGENT_PROVIDERS_ENV]: "claude,gemini",
              TMPDIR: missing,
            }),
            parentEnv: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
            disallowedTools: REVIEWER_TOOLS,
          });
          return { result, ran: await exists(`${stub.dir}/ran`) };
        },
        { prefix: "gemini_settings_5341_" },
      );
      assertEquals(outcome.result.ok, false);
      if (outcome.result.ok) return;
      const message = outcome.result.error.message;
      assertStringIncludes(message, "Refused to start the agent");
      assertStringIncludes(message, missing);
      assertStringIncludes(message, "No such file or directory");
      assertEquals(outcome.ran, false, "the agent never started");
      assertEquals([...Deno.readDirSync(root)].length, 0);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - a Gemini run asking for a tool with no Gemini setting is refused before the agent starts (Issue #5341)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "gemini_settings_5341_unmapped_",
    });
    try {
      const body = `: > "$(dirname "$0")/ran"\nexit 0\n`;
      const outcome = await withAgentStub(
        body,
        async (stub) => {
          const result = await runClaudeWithTimeout({
            clock: fakeClock(),
            prompt: "test",
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            agentProvider: "gemini",
            agentBinaryPath: stub.path,
            env: envFrom({
              [IMAGE_AGENT_PROVIDERS_ENV]: "claude,gemini",
              TMPDIR: root,
            }),
            parentEnv: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
            disallowedTools: ["Bash(git push *)"],
          });
          return { result, ran: await exists(`${stub.dir}/ran`) };
        },
        { prefix: "gemini_settings_5341_" },
      );
      assertEquals(outcome.result.ok, false);
      if (outcome.result.ok) return;
      assertStringIncludes(
        outcome.result.error.message,
        "Refused to start the agent",
      );
      assertStringIncludes(outcome.result.error.message, "Bash(git push *)");
      assertEquals(outcome.ran, false, "the agent never started");
      assertEquals([...Deno.readDirSync(root)].length, 0);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
