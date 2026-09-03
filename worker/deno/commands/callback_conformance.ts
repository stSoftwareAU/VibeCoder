/**
 * `callback-conformance` command — the extension-facing proof of the post-run
 * callback contract (Issue #807, parent #796).
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-run --allow-env \
 *     mod.ts callback-conformance \
 *     [--success /opt/vibe-hooks/success.sh] \
 *     [--failure /opt/vibe-hooks/failure.sh] \
 *     [--always /opt/vibe-hooks/always.sh] \
 *     [--timeout-seconds 10]
 *
 * With no hook paths it proves the contract using its own portable `/bin/sh`
 * fixtures; with them it drives the extension's real executables through the
 * production runner. Exits non-zero when any check fails, so it is usable as a
 * gate in an extension's own CI.
 *
 * The contract itself is documented in `docs/CALLBACKS.md`.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult, Result } from "../types.ts";
import {
  type CallbackConformanceReport,
  type ConformanceHooks,
  formatConformanceReport,
  runCallbackConformance,
} from "../lib/callback_conformance.ts";
import {
  CALLBACK_EVENTS,
  type CallbacksConfig,
  parseCallbacksConfig,
} from "../lib/run_callbacks_config.ts";

/**
 * Validate the arguments through the **production** `callbacks` parser.
 *
 * The command must not invent its own, weaker path rules: a `--success` the
 * fixture accepts but `.config.json` would reject is a fixture that passes
 * for a configuration the worker refuses to load. The argument names map
 * one-to-one onto the block's keys, so the real parser judges them.
 */
function parseArguments(
  args: Record<string, unknown>,
): Result<CallbacksConfig, string> {
  const block: Record<string, unknown> = {};
  for (const event of CALLBACK_EVENTS) {
    if (args[event] !== undefined) block[event] = args[event];
  }
  if (args["timeout-seconds"] !== undefined) {
    block.timeout_seconds = args["timeout-seconds"];
  }
  const parsed = parseCallbacksConfig(block);
  if (parsed.ok) return parsed;
  // The parser speaks in config keys; the operator typed flags.
  return {
    ok: false,
    error: parsed.error
      .replace(/callbacks\.timeout_seconds/g, "--timeout-seconds")
      .replace(/callbacks\.(success|failure|always)/g, "--$1"),
  };
}

export const callbackConformanceCommand: Command = {
  name: "callback-conformance",
  description:
    "Prove the post-run callback contract holds here, optionally against your own hooks (Issue #807)",

  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<CallbackConformanceReport>> {
    if (Deno.build.os === "windows") {
      // Loud rather than silently green: the fixture drives POSIX hooks, and
      // the worker itself only ever runs inside the Linux container.
      return {
        success: false,
        message:
          "callback-conformance needs a POSIX shell; run it where the worker runs (inside the container).",
      };
    }

    const parsed = parseArguments(args);
    if (!parsed.ok) return { success: false, message: parsed.error };

    const hooks: ConformanceHooks = {};
    for (const event of CALLBACK_EVENTS) {
      const path = parsed.value[event];
      if (path !== undefined) hooks[event] = path;
    }

    const report = await runCallbackConformance({
      hooks,
      // Only an explicit --timeout-seconds overrides the fixture's own
      // budget; the parser's default is the contract's, not the fixture's.
      ...(args["timeout-seconds"] !== undefined
        ? { timeoutSeconds: parsed.value.timeoutSeconds }
        : {}),
    });

    return {
      success: report.passed,
      message: formatConformanceReport(report),
      data: report,
    };
  },
};
