/**
 * container-runtime-detect command (Issue #4063).
 *
 * Resolves the container runtime this host must use and prints its executable,
 * so `run.sh` and `run.ps1` consume the decision as data instead of each
 * embedding per-platform, per-runtime special cases.
 *
 * Usage:
 *   deno run --allow-run --allow-env mod.ts container-runtime-detect
 *   OUTPUT_JSON=true deno run … container-runtime-detect --platform linux
 *
 * Prints the runtime executable on stdout; the full descriptor (kind, dialect,
 * runtimes probed) is available as JSON with `OUTPUT_JSON=true`. When no
 * supported runtime answers its probe the command exits non-zero with a message
 * naming the platform, every runtime probed, and how to install one — there is
 * no native fallback.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  type ContainerRuntimeDialect,
  type ContainerRuntimeKind,
  type ContainerRuntimeProbe,
  detectContainerRuntime,
  type HostPlatform,
} from "../lib/container_runtime.ts";

/** The runtime decision, as the launchers consume it. */
export interface ContainerRuntimeDetectResult {
  /** Platform the decision was made for. */
  platform: HostPlatform;
  /** Selected runtime. */
  kind: ContainerRuntimeKind;
  /** Executable path (or command name) to invoke. */
  executable: string;
  /** Human-readable runtime name. */
  displayName: string;
  /** Argument dialect the launchers must use. */
  dialect: ContainerRuntimeDialect;
  /** Runtimes probed, in order, up to the one selected. */
  probed: ContainerRuntimeKind[];
}

/** Options for {@link detectContainerRuntimeForCommand}. */
export interface DetectForCommandOptions {
  /** Platform override; defaults to the host platform. */
  platform?: string;
  /** Probe override; defaults to the real probe. */
  probe?: ContainerRuntimeProbe;
}

/**
 * Run detection and shape it as a command result.
 *
 * Separate from `execute` so the platform and probe stay injectable — the
 * tests exercise every branch without a runtime installed.
 *
 * @param options - Platform and probe overrides
 * @returns Success with the descriptor, or a loud failure message
 */
export async function detectContainerRuntimeForCommand(
  options: DetectForCommandOptions = {},
): Promise<CommandResult<ContainerRuntimeDetectResult>> {
  try {
    const descriptor = await detectContainerRuntime(options);
    return {
      success: true,
      message: descriptor.executable,
      data: {
        platform: descriptor.platform,
        kind: descriptor.kind,
        executable: descriptor.executable,
        displayName: descriptor.displayName,
        dialect: descriptor.dialect,
        probed: descriptor.probed,
      },
    };
  } catch (error) {
    // Fail loud: the caller sees the platform, the probes and the install
    // hints — never a "run natively instead" outcome (Issue #3234).
    return { success: false, message: (error as Error).message };
  }
}

export const containerRuntimeDetectCommand: Command = {
  name: "container-runtime-detect",
  description:
    "Resolve and validate the host's container runtime (Issue #4063)",
  execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<ContainerRuntimeDetectResult>> {
    const platform = typeof args["platform"] === "string"
      ? (args["platform"] as string)
      : undefined;

    return detectContainerRuntimeForCommand({ platform });
  },
};
