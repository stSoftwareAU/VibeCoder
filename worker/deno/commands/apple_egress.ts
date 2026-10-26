/**
 * apple-egress command (Issue #4051).
 *
 * The launcher's entry point to the Apple `container` egress lifecycle in
 * `lib/apple_egress.ts`. `up` brings the containment up before the worker
 * container starts and writes the worker's `--network` and `--env` arguments to
 * a NUL-delimited file. `down` removes the proxy and its network afterwards.
 *
 * The verb is a flag, `--action up|down`, not a positional word: `mod.ts`
 * `parseArgs` drops positional words after the command name, and its tests pin
 * that behaviour.
 *
 * Usage:
 *   deno run ... mod.ts apple-egress --action up --runtime container \
 *     --image <ref> --name vibe-coder-<pid> --base-dir <dir> \
 *     --workdir <in-container checkout> --config <.config.json> \
 *     --report-dir <dir> --out <args file>
 *   deno run ... mod.ts apple-egress --action down --runtime container \
 *     --name vibe-coder-<pid> [--proxy-log <file>]
 *
 * Exit statuses:
 *   0   up: containment is up and the args file is written. down: always.
 *   1   up: containment could not be brought up, or the args file was not
 *       written.
 *   2   bad arguments or egress settings.
 *   10  up: the runtime is not Apple `container`. Nothing was done.
 *
 * The args file holds one `arg=<value>` token per worker argument, each
 * terminated by a NUL byte. The stdout summary is not the contract.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type AppleEgressDeps,
  AppleEgressError,
  appleEgressNames,
  type AppleEgressOptions,
  bringUpAppleEgress,
  resolveAppleEgressSettings,
  tearDownAppleEgress,
} from "../lib/apple_egress.ts";
import { createAppleEgressDeps } from "../lib/apple_egress_host.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import { CONTAINER_RUNTIMES } from "../lib/container_runtime.ts";
import { dialectForExecutable } from "../lib/container_watchdog.ts";
import { type EnvLookup, processEnvLookup } from "../lib/env_lookup.ts";
import {
  type HostEgressAllowlist,
  readHostEgressAllowlist,
} from "../lib/egress_host_allowlist.ts";

/** Exit status: the runtime is not Apple `container`, so nothing was done. */
export const APPLE_EGRESS_NOT_APPLICABLE_EXIT = 10;

/** Exit status: containment could not be brought up. */
const APPLE_EGRESS_FAILED_EXIT = 1;

/** Exit status: bad arguments. */
const APPLE_EGRESS_ARGUMENT_EXIT = 2;

/** The flags `up` requires, besides `--runtime`. */
const UP_FLAGS = [
  "image",
  "name",
  "base-dir",
  "workdir",
  "config",
  "report-dir",
  "out",
] as const;

/** The seams of the command. Each defaults to the production behaviour. */
export interface AppleEgressCommandSeams {
  /** The side effects for one runtime. Defaults to the production set. */
  createDeps?: (runtime: string) => AppleEgressDeps;
  /** The bring-up. Defaults to `bringUpAppleEgress`. */
  bringUp?: typeof bringUpAppleEgress;
  /** The allowlist for one launch. Defaults to the manifest and config read. */
  resolveAllowlist?: (input: {
    baseDir: string;
    configFile: string;
    env: EnvLookup;
  }) => Promise<HostEgressAllowlist>;
  /** The environment lookup. Defaults to the process environment. */
  env?: EnvLookup;
}

export interface AppleEgressCommand extends Command {
  execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
    seams?: AppleEgressCommandSeams,
  ): Promise<CommandResult>;
}

/** A flag's value when it is a non-empty string, otherwise undefined. */
function textArg(
  args: Record<string, unknown>,
  flag: string,
): string | undefined {
  const value = args[flag];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function argumentError(message: string): CommandResult {
  return {
    success: false,
    exitCode: APPLE_EGRESS_ARGUMENT_EXIT,
    message: `apple-egress: ${message}`,
  };
}

/** Error text whatever was thrown. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when the executable is Apple's `container` CLI.
 *
 * An executable the launchers do not support is not Apple's either.
 */
export function isAppleContainerRuntime(runtime: string): boolean {
  try {
    return dialectForExecutable(runtime) ===
      CONTAINER_RUNTIMES["apple-container"].dialect;
  } catch {
    return false;
  }
}

/**
 * Render the worker arguments as the NUL-delimited args file.
 *
 * @param workerArgs - The `--network` and `--env` arguments, in order
 * @returns One `arg=<value>` token per argument, each followed by a NUL byte
 * @throws Error when an argument contains a NUL byte, which would truncate it
 */
export function renderAppleWorkerArgs(workerArgs: readonly string[]): string {
  return workerArgs.map((arg) => {
    if (arg.includes("\0")) {
      throw new Error(
        `worker argument ${
          JSON.stringify(arg)
        } contains a NUL byte, which the args file framing would truncate`,
      );
    }
    return `arg=${arg}\0`;
  }).join("");
}

/** The allowlist for one launch: installed providers from the manifest. */
async function resolveLaunchAllowlist(input: {
  baseDir: string;
  configFile: string;
  env: EnvLookup;
}): Promise<HostEgressAllowlist> {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(`${input.baseDir}/container/tools.json`),
  );
  return readHostEgressAllowlist({
    configFile: input.configFile,
    installedProviders: manifest.installedProviders,
    env: input.env,
  });
}

async function runUp(
  args: Record<string, unknown>,
  seams: AppleEgressCommandSeams,
): Promise<CommandResult> {
  const runtime = textArg(args, "runtime");
  if (runtime === undefined) {
    return argumentError("--action up requires --runtime <executable>");
  }
  if (!isAppleContainerRuntime(runtime)) {
    return {
      success: true,
      exitCode: APPLE_EGRESS_NOT_APPLICABLE_EXIT,
      message: `[egress] apple-egress: not applicable to ${runtime}`,
    };
  }

  const values: Record<string, string | undefined> = {};
  for (const flag of UP_FLAGS) values[flag] = textArg(args, flag);
  const missing = UP_FLAGS.filter((flag) => values[flag] === undefined);
  if (missing.length > 0) {
    return argumentError(
      `--action up requires ${missing.map((flag) => `--${flag}`).join(", ")}`,
    );
  }
  const flag = (name: (typeof UP_FLAGS)[number]): string => values[name] ?? "";

  const env = seams.env ?? processEnvLookup;
  let settings: ReturnType<typeof resolveAppleEgressSettings>;
  try {
    settings = resolveAppleEgressSettings(env);
  } catch (error) {
    return argumentError(errorMessage(error));
  }

  const deps = (seams.createDeps ?? productionDeps)(runtime);
  const bringUp = seams.bringUp ?? bringUpAppleEgress;
  const resolveAllowlist = seams.resolveAllowlist ?? resolveLaunchAllowlist;
  try {
    const allowlist = await resolveAllowlist({
      baseDir: flag("base-dir"),
      configFile: flag("config"),
      env,
    });
    const options: AppleEgressOptions = {
      runtime,
      image: flag("image"),
      workerContainerName: flag("name"),
      baseDir: flag("base-dir"),
      workdir: flag("workdir"),
      homeDir: env("HOME") ?? "",
      allowlist,
      mode: settings.mode,
      recoveryAttempts: settings.recoveryAttempts,
      readyTries: settings.readyTries,
      readyIntervalMs: settings.readyIntervalMs,
      reportDir: flag("report-dir"),
    };
    const up = await bringUp(deps, options);
    try {
      await Deno.writeTextFile(
        flag("out"),
        renderAppleWorkerArgs(up.workerArgs),
      );
    } catch (error) {
      // Containment is up, but the launch cannot read its arguments. Remove it
      // here rather than leave it running for the launcher to find; the write
      // error is still the one reported.
      const problems = await tearDownAppleEgress(
        deps,
        appleEgressNames(flag("name")),
      );
      for (const problem of problems) {
        console.error(`[egress] warning: ${problem}`);
      }
      throw error;
    }
    return {
      success: true,
      message:
        `[egress] apple-egress: containment up on attempt ${up.attempts}; worker arguments written to ${
          flag("out")
        }`,
    };
  } catch (error) {
    if (error instanceof AppleEgressError) {
      console.error(`[egress] apple-egress: ${error.message}`);
      for (const line of error.diagnostics) console.error(line);
    } else {
      console.error(`[egress] apple-egress: ${errorMessage(error)}`);
    }
    return {
      success: false,
      exitCode: APPLE_EGRESS_FAILED_EXIT,
      message: "apple-egress: containment was not brought up (see stderr)",
    };
  }
}

async function runDown(
  args: Record<string, unknown>,
  seams: AppleEgressCommandSeams,
): Promise<CommandResult> {
  const runtime = textArg(args, "runtime");
  const name = textArg(args, "name");
  if (runtime === undefined || name === undefined) {
    return argumentError(
      "--action down requires --runtime <executable> and --name <worker container name>",
    );
  }
  let names: ReturnType<typeof appleEgressNames>;
  try {
    names = appleEgressNames(name);
  } catch (error) {
    return argumentError(errorMessage(error));
  }
  const proxyLog = textArg(args, "proxy-log");

  // Cleanup never masks the launch outcome, so every failure is a warning.
  try {
    const deps = (seams.createDeps ?? productionDeps)(runtime);
    const problems = await tearDownAppleEgress(
      deps,
      names,
      proxyLog === undefined ? undefined : { proxyLogPath: proxyLog },
    );
    for (const problem of problems) {
      console.error(`[egress] warning: ${problem}`);
    }
    return {
      success: true,
      message: problems.length === 0
        ? "[egress] apple-egress: containment torn down"
        : `[egress] apple-egress: torn down with ${problems.length} problem(s); see the warnings above`,
    };
  } catch (error) {
    console.error(
      `[egress] warning: apple-egress cleanup failed: ${errorMessage(error)}`,
    );
    return {
      success: true,
      message: "[egress] apple-egress: cleanup failed; see the warnings above",
    };
  }
}

/** The production deps for one runtime. */
function productionDeps(runtime: string): AppleEgressDeps {
  return createAppleEgressDeps({ runtime });
}

export const appleEgressCommand: AppleEgressCommand = {
  name: "apple-egress",
  description:
    "Bring Apple container egress containment up before a worker launch, or tear it down after (Issue #4051)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
    seams: AppleEgressCommandSeams = {},
  ): Promise<CommandResult> {
    const action = textArg(args, "action");
    if (action === "up") return runUp(args, seams);
    if (action === "down") return runDown(args, seams);
    return argumentError("--action must be up or down");
  },
};
