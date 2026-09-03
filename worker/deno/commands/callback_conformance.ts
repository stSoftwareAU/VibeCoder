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
  type CallbackEvent,
  MAX_CALLBACK_TIMEOUT_SECONDS,
} from "../lib/run_callbacks_config.ts";

/** An argument that was not supplied at all. */
const ABSENT = Symbol("absent");

/** Read one optional hook path argument, applying the contract's path rules. */
function readHookPath(
  args: Record<string, unknown>,
  event: CallbackEvent,
): Result<string | typeof ABSENT, string> {
  const value = args[event];
  if (value === undefined) return { ok: true, value: ABSENT };
  if (typeof value !== "string" || value.trim() === "") {
    return {
      ok: false,
      error: `--${event} must be a path to an executable`,
    };
  }
  if (!value.startsWith("/")) {
    return {
      ok: false,
      error: `--${event} must be an absolute path, as the contract requires`,
    };
  }
  return { ok: true, value };
}

/** Read `--timeout-seconds`, or say what was wrong with it. */
function readTimeout(
  args: Record<string, unknown>,
): Result<number | typeof ABSENT, string> {
  const raw = args["timeout-seconds"];
  if (raw === undefined) return { ok: true, value: ABSENT };
  const value = typeof raw === "number" ? raw : Number(raw);
  if (
    !Number.isInteger(value) || value <= 0 ||
    value > MAX_CALLBACK_TIMEOUT_SECONDS
  ) {
    return {
      ok: false,
      error:
        `--timeout-seconds must be a whole number of seconds between 1 and ${MAX_CALLBACK_TIMEOUT_SECONDS}`,
    };
  }
  return { ok: true, value };
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

    const hooks: ConformanceHooks = {};
    const faults: string[] = [];
    for (const event of CALLBACK_EVENTS) {
      const parsed = readHookPath(args, event);
      if (!parsed.ok) faults.push(parsed.error);
      else if (parsed.value !== ABSENT) hooks[event] = parsed.value;
    }
    const timeout = readTimeout(args);
    if (!timeout.ok) faults.push(timeout.error);
    if (faults.length > 0) {
      return { success: false, message: faults.join("\n") };
    }

    const report = await runCallbackConformance({
      hooks,
      ...(timeout.ok && timeout.value !== ABSENT
        ? { timeoutSeconds: timeout.value }
        : {}),
    });

    return {
      success: report.passed,
      message: formatConformanceReport(report),
      data: report,
    };
  },
};
