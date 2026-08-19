/**
 * container-build-heal command (VibeCoder #1, formerly Issue #4441).
 *
 * Called by `run.sh` / `run.ps1` when `container build` fails. It classifies
 * the build's own output and, when the builder's storage is what failed —
 * ENOSPC, a builder VM that remounted itself read-only, BuildKit's
 * `ResourceExhausted` — restarts the runtime's build helper so the launcher
 * can retry the build once.
 *
 * Usage:
 *   deno run --allow-env --allow-read --allow-run \
 *     mod.ts container-build-heal --runtime container \
 *     --log /tmp/vibe-build.log [--attempt 1]
 *
 * Exit statuses, which are the launcher's instructions:
 *
 *   0  healed — retry the build once
 *   3  not a healable failure — fail exactly as before, do not retry
 *   1  the failure was healable but the heal did not work — do not retry
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  type BuilderHealAction,
  createBuildHealDeps,
  healBuilderStorage,
  readBuildLogTail,
} from "../lib/container_build_heal.ts";
import { dialectForExecutable } from "../lib/container_watchdog.ts";

/**
 * Exit status meaning "this build did not fail on builder storage".
 *
 * Kept in step with the launchers by the launcher tests: `run.sh` and
 * `run.ps1` read it to tell "nothing to heal" apart from a heal that failed.
 */
export const BUILD_NOT_HEALABLE_EXIT = 3;

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(optionalString(value));
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

/** What the command reports back to the launcher. */
export interface ContainerBuildHealResult {
  /** True when the build output carried a builder-storage signature. */
  healable: boolean;
  /** The signature that matched, when one did. */
  signature?: string;
  /** Which remedy was performed, when one was. */
  action?: BuilderHealAction;
  /** Whether the builder is usable again. */
  healed: boolean;
}

export const containerBuildHealCommand: Command = {
  name: "container-build-heal",
  description:
    "Restart the container runtime's builder after a storage failure, " +
    "host-side (VibeCoder #1, formerly Issue #4441)",

  execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<ContainerBuildHealResult>> {
    return healBuild(args);
  },
};

/** Do the work. Separated so the tests can call it without the registry. */
export async function healBuild(
  args: Record<string, unknown>,
): Promise<CommandResult<ContainerBuildHealResult>> {
  const runtime = optionalString(args["runtime"]);
  if (!runtime) {
    return {
      success: false,
      message: "container-build-heal requires --runtime <executable>",
    };
  }

  const logPath = optionalString(args["log"]);
  if (!logPath) {
    return {
      success: false,
      message: "container-build-heal requires --log <file>",
    };
  }

  let dialect;
  try {
    dialect = dialectForExecutable(runtime);
  } catch (error) {
    return { success: false, message: (error as Error).message };
  }

  let buildLog: string;
  try {
    buildLog = await readBuildLogTail(logPath);
  } catch (error) {
    // An unreadable log cannot be classified, and guessing either way is
    // worse than saying so (Issue #3234).
    return { success: false, message: (error as Error).message };
  }

  const outcome = await healBuilderStorage(createBuildHealDeps(runtime), {
    buildLog,
    attempt: optionalNumber(args["attempt"]) ?? 1,
    restartArgs: dialect.builderRestartArgs,
    recreateArgs: dialect.builderRecreateArgs,
  });

  const data: ContainerBuildHealResult = {
    healable: outcome.healable,
    ...(outcome.signature ? { signature: outcome.signature } : {}),
    ...(outcome.action ? { action: outcome.action } : {}),
    healed: outcome.ok,
  };

  if (!outcome.healable) {
    // A correct answer, not a failure: the build broke for a reason the
    // launcher must surface unchanged. Exit 3 so it can tell the two apart.
    return {
      success: true,
      exitCode: BUILD_NOT_HEALABLE_EXIT,
      message: outcome.detail ??
        "the build did not fail on builder storage — nothing to heal",
      data,
    };
  }

  if (!outcome.ok) {
    return {
      success: false,
      message: `could not heal the ${runtime} builder: ` +
        `${outcome.detail ?? "no reason reported"}`,
      data,
    };
  }

  return {
    success: true,
    message: `${runtime} builder ${outcome.action} complete after a ` +
      `${outcome.signature} build failure — the build may be retried`,
    data,
  };
}
