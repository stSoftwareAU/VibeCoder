/**
 * Tests for the per-spawn `--settings` payload (Issue #2383, part of #2328).
 *
 * A run installs its Claude Code hooks by handing the CLI one settings object
 * on the command line, so nothing is written to `~/.claude/settings.json` and
 * the container image stays hook-free. Two failure modes are held here:
 *
 *   - **A run with no settings must spawn the argv it always did.** An empty
 *     or absent payload that still emitted `--settings` would change every
 *     spawn on every host, including the ones with every accelerator off.
 *   - **DeepSeek must not receive it.** DeepSeek is the Claude Code CLI
 *     pointed at an Anthropic-compatible endpoint that implements no hook
 *     support, so the flag is stripped there rather than forwarded.
 *
 * Every test calls the real functions with real data.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  CLAUDE_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";

import { buildCodexArgs } from "../lib/codex_executor.ts";

/** The Claude descriptor, which carries the flag. */
const claude = resolveAgentProvider(CLAUDE_PROVIDER_ID);

/** The DeepSeek descriptor, which shares the CLI but strips the flag. */
const deepseek = resolveAgentProvider(DEEPSEEK_PROVIDER_ID);

/** One settings payload, the shape RTK's Bash hook produces. */
const SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "rtk hook claude" }],
      },
    ],
  },
});

Deno.test("claude invocation - carries --settings with the payload when one is supplied (Issue #2383)", () => {
  const args = claude.buildInvocation({
    prompt: "P",
    model: "m",
    settingsJson: SETTINGS,
  });
  const i = args.indexOf("--settings");
  assert(i >= 0, `expected --settings in ${args.join(" ")}`);
  assertEquals(args[i + 1], SETTINGS);
  // The payload is a flag, not prompt text: it precedes the prompt.
  assert(i < args.indexOf("-p"), "expected --settings before the prompt");
});

Deno.test("claude invocation - omits --settings entirely when no payload is set (Issue #2383)", () => {
  const args = claude.buildInvocation({ prompt: "P", model: "m" });
  assertEquals(args.includes("--settings"), false);
});

Deno.test("claude invocation - an empty payload emits no flag (Issue #2383)", () => {
  const args = claude.buildInvocation({
    prompt: "P",
    model: "m",
    settingsJson: "",
  });
  assertEquals(args.includes("--settings"), false);
});

Deno.test("claude invocation - the settings payload is the only difference from an unset run (Issue #2383)", () => {
  const plain = claude.buildInvocation({ prompt: "P", model: "m" });
  const withSettings = claude.buildInvocation({
    prompt: "P",
    model: "m",
    settingsJson: SETTINGS,
  });
  assertEquals(
    withSettings.filter((a) => a !== "--settings" && a !== SETTINGS),
    plain,
  );
});

Deno.test("deepseek invocation - strips --settings: the endpoint implements no hooks (Issue #2383)", () => {
  const args = deepseek.buildInvocation({
    prompt: "P",
    model: "deepseek-v4-pro",
    settingsJson: SETTINGS,
  });
  assertEquals(args.includes("--settings"), false);
  assertEquals(args.includes(SETTINGS), false);
});

Deno.test("codex invocation - translates command hooks for fresh runs", () => {
  const args = resolveAgentProvider("codex").buildInvocation({
    prompt: "P",
    model: "m",
    settingsJson: SETTINGS,
  });
  assert(args.includes("--dangerously-bypass-hook-trust"));
  assert(args.includes("features.hooks=true"));
  const config =
    'hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="rtk hook claude"}]}]';
  assert(args.includes(config));
  assertEquals(args.includes("--settings"), false);
});

Deno.test("codex invocation - hook configuration survives resume and stdin transport", () => {
  const args = buildCodexArgs({
    prompt: "P",
    promptViaStdin: true,
    resumeSessionId: "thread-4121",
    settingsJson: SETTINGS,
  });
  assertEquals(args.slice(0, 3), ["exec", "resume", "thread-4121"]);
  assert(args.includes("--dangerously-bypass-hook-trust"));
  assert(args.some((arg) => arg.startsWith("hooks.PreToolUse=")));
  assertEquals(args.at(-1), "-");
});

Deno.test("codex invocation - empty hook settings do not grant hook trust", () => {
  const plain = buildCodexArgs({ prompt: "P" });
  for (
    const settingsJson of ["", JSON.stringify({ hooks: { PreToolUse: [] } })]
  ) {
    assertEquals(buildCodexArgs({ prompt: "P", settingsJson }), plain);
  }
});

Deno.test("codex invocation - quotes command strings and preserves multiple hooks", () => {
  const args = buildCodexArgs({
    prompt: "P",
    settingsJson: JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [
            { type: "command", command: 'printf "hello"\nrtk hook claude' },
            { type: "command", command: "second" },
          ],
        }, {
          matcher: "Write",
          hooks: [{ type: "command", command: "guard" }],
        }],
      },
    }),
  });
  assertEquals(
    args.find((arg) => arg.startsWith("hooks.PreToolUse=")),
    String
      .raw`hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="printf \"hello\"\nrtk hook claude"},{type="command",command="second"}]},{matcher="Write",hooks=[{type="command",command="guard"}]}]`,
  );
});

Deno.test("codex invocation - malformed hook settings fail with the violated contract", () => {
  for (const settings of [null, {}, { hooks: { PreToolUse: {} } }]) {
    assertThrows(
      () =>
        buildCodexArgs({ prompt: "P", settingsJson: JSON.stringify(settings) }),
      Error,
      "Codex hook settings require a PreToolUse array",
    );
  }
  for (
    const group of [null, { matcher: 1, hooks: [] }, {
      matcher: "Bash",
      hooks: {},
    }]
  ) {
    assertThrows(
      () =>
        buildCodexArgs({
          prompt: "P",
          settingsJson: JSON.stringify({ hooks: { PreToolUse: [group] } }),
        }),
      Error,
      "Codex PreToolUse requires a matcher and hooks array",
    );
  }
  for (
    const hook of [null, { type: "prompt", command: "x" }, {
      type: "command",
      command: 1,
    }]
  ) {
    assertThrows(
      () =>
        buildCodexArgs({
          prompt: "P",
          settingsJson: JSON.stringify({
            hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hook] }] },
          }),
        }),
      Error,
      "Codex PreToolUse requires command hooks with a string command",
    );
  }
});
