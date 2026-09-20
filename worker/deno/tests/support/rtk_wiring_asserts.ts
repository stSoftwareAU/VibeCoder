/**
 * Shared assertions for the RTK wiring tests (Issue #2384, part of #2328).
 *
 * Four processors carry the same hook under the same contract, so the four
 * `<processor>_rtk_test.ts` files assert it with the same words: what a spawn
 * that carries the hook looks like, what one that does not looks like, and
 * that the switch changes nothing else about the invocation.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  RTK_HOOK_COMMAND,
  RTK_HOOK_MATCHER,
  RTK_PROMPT_LINE,
} from "../../lib/rtk_output.ts";

/** The options one agent invocation was handed. */
export type SpawnOptions = Record<string, unknown>;

/**
 * A prompt with its per-run random boundary ids made stable.
 *
 * The prompt builders fence untrusted content behind a fresh random id on
 * every build, so two runs of the same input never produce the same bytes.
 * Everything *else* must match, and this is what lets a test say so.
 */
export function stablePrompt(prompt: unknown): string {
  return String(prompt).replace(
    /(?<![0-9a-f])[0-9a-f]{12}(?![0-9a-f])/g,
    "<id>",
  );
}

/** Assert one spawn carries RTK's hook and ends with its prompt line. */
export function assertCarriesRtkHook(spawn: SpawnOptions | undefined): void {
  assert(spawn, "expected an agent invocation");
  assert(
    typeof spawn.settingsJson === "string",
    "expected a --settings payload",
  );
  const parsed = JSON.parse(spawn.settingsJson) as {
    hooks?: { PreToolUse?: unknown[] };
  };
  assertEquals(parsed.hooks?.PreToolUse, [{
    matcher: RTK_HOOK_MATCHER,
    hooks: [{ type: "command", command: RTK_HOOK_COMMAND }],
  }]);

  const prompt = String(spawn.prompt);
  assertEquals(prompt.split(RTK_PROMPT_LINE).length - 1, 1, "the line, once");
  assert(
    prompt.endsWith(`\n\n${RTK_PROMPT_LINE}`),
    "the line goes outermost: it is the last thing the agent reads",
  );
}

/** Assert one spawn carries neither half of the pair. */
export function assertNoRtkHook(spawn: SpawnOptions | undefined): void {
  assert(spawn, "expected an agent invocation");
  assertEquals(
    Object.hasOwn(spawn, "settingsJson"),
    false,
    "no hook must mean no --settings flag at all, not an empty one",
  );
  assertEquals(
    String(spawn.prompt).includes(RTK_PROMPT_LINE),
    false,
    "no hook means no line: the agent is never told output is filtered",
  );
}

/**
 * Assert the switch changed nothing about a spawn but the pair itself.
 *
 * `off` is today's invocation. `on` must be that invocation plus exactly one
 * option (`settingsJson`) and exactly one prompt suffix — which is what makes
 * the off run byte-identical to a host that never had the switch.
 */
export function assertOnlyRtkDiffers(
  on: SpawnOptions | undefined,
  off: SpawnOptions | undefined,
): void {
  assert(on && off, "expected an on and an off invocation to compare");
  assertEquals(
    stablePrompt(on.prompt),
    `${stablePrompt(off.prompt)}\n\n${RTK_PROMPT_LINE}`,
  );
  assertEquals(
    Object.keys(on).filter((key) => key !== "settingsJson").sort(),
    Object.keys(off).sort(),
  );
}

/**
 * Assert RTK's pair sits beside CodeGraph's without disturbing it.
 *
 * The two accelerators are independent switches, so a host with both on must
 * get both: CodeGraph's MCP entry and line exactly as before, and RTK's line
 * after it — outermost, the last thing the agent reads.
 */
export function assertRtkOutsideCodegraph(
  spawn: SpawnOptions | undefined,
  codegraphLine: string,
): void {
  assertCarriesRtkHook(spawn);
  assert(spawn && Object.hasOwn(spawn, "mcpConfig"), "CodeGraph's entry stays");
  const prompt = String(spawn.prompt);
  const codegraphAt = prompt.indexOf(codegraphLine);
  assert(codegraphAt >= 0, "CodeGraph's line stays");
  assert(
    prompt.indexOf(RTK_PROMPT_LINE) > codegraphAt,
    "RTK's line is applied outside CodeGraph's",
  );
}
