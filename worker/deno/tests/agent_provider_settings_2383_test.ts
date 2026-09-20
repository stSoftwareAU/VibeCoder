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

import { assert, assertEquals } from "@std/assert";
import {
  CLAUDE_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";

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
