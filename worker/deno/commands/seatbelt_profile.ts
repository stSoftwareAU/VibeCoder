/**
 * seatbelt-profile command (Issue #4300).
 *
 * Writes the macOS Seatbelt containment profile for a `seatbelt`-mode run
 * and prints its path on stdout, so `run.sh` can wrap the native driver in
 * `sandbox-exec -f <profile>` without composing profile syntax in shell.
 *
 * The allowlist derives from the same host paths container mode mounts —
 * base dir, work dir, logs, run-config, credentials — plus HOME's tool
 * caches and TMPDIR. Stdout carries exactly the path and nothing else.
 *
 * Usage:
 *   deno run --allow-env --allow-read --allow-write mod.ts seatbelt-profile \
 *     --base-dir <checkout> [--out <file>]
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { buildSeatbeltProfile } from "../lib/seatbelt_profile.ts";
import {
  type ContainerLaunchHostPaths,
  resolveContainerLaunchHostPaths,
} from "../lib/container_launch.ts";

export interface SeatbeltProfileResult {
  /** Where the profile was written (the string printed on stdout). */
  profilePath: string;
}

export const seatbeltProfileCommand: Command = {
  name: "seatbelt-profile",
  description:
    "Write the macOS Seatbelt containment profile for a seatbelt-mode run and print its path (Issue #4300)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<SeatbeltProfileResult>> {
    if (Deno.build.os !== "darwin") {
      return {
        success: false,
        message:
          `seatbelt-profile: seatbelt mode is macOS-only (this host is ${Deno.build.os}); use run_mode container or native`,
      };
    }
    const baseDir = typeof args["base-dir"] === "string"
      ? args["base-dir"]
      : "";
    if (!baseDir) {
      return {
        success: false,
        message: "seatbelt-profile: --base-dir is required",
      };
    }
    // The SAME resolver the container plan uses for its mount sources
    // (HOME/WORK_DIR/CONFIG_PATH/VIBE_CREDENTIAL_DIR), so the Seatbelt
    // allowlist and the container mount set cannot drift apart.
    let hostPaths: ContainerLaunchHostPaths;
    try {
      hostPaths = resolveContainerLaunchHostPaths(
        baseDir,
        (name) => Deno.env.get(name),
      );
    } catch (err) {
      return {
        success: false,
        message: `seatbelt-profile: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    void config;
    const tmpDir = Deno.env.get("TMPDIR") || "/private/tmp";
    // The config file's own directory is a read grant too: CONFIG_PATH may
    // point outside the staged run-config dir (the launcher tests do).
    const configFileDir = hostPaths.configFile.replace(/\/[^/]+$/, "");
    // Deno's module cache must be readable for --frozen runs; the launcher
    // harness points DENO_DIR at the real cache outside HOME.
    const denoDir = Deno.env.get("DENO_DIR");

    // The mounted set must exist before the profile is applied — Seatbelt
    // grants are matched against kernel paths, and the launcher's own
    // mkdir would otherwise happen *inside* the sandbox against a path the
    // profile could not resolve.
    for (
      const dir of [
        hostPaths.workDir,
        hostPaths.logDir,
        hostPaths.configStageDir,
        hostPaths.credentialDir,
      ]
    ) {
      await Deno.mkdir(dir, { recursive: true }).catch(() => undefined);
    }

    let profile: string;
    try {
      profile = buildSeatbeltProfile({
        baseDir: hostPaths.baseDir,
        workDir: hostPaths.workDir,
        logDir: hostPaths.logDir,
        configDir: hostPaths.configStageDir,
        credentialsDir: hostPaths.credentialDir,
        homeDir: hostPaths.homeDir,
        tmpDir,
        extraReadable: [
          configFileDir,
          ...(denoDir ? [denoDir] : []),
        ],
        // The record dir the launcher tests' stub deno writes to, and any
        // operator-declared extras. Never HOME wholesale.
        extraWritable: [
          ...(denoDir ? [denoDir] : []),
          ...(Deno.env.get("VIBE_SEATBELT_EXTRA_WRITABLE")?.split(":")
            .filter(Boolean) ?? []),
        ],
      });
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const profilePath = typeof args["out"] === "string" && args["out"]
      ? args["out"]
      : `${hostPaths.configStageDir}/vibe-seatbelt.sb`;
    await Deno.writeTextFile(profilePath, profile);
    return {
      success: true,
      message: profilePath,
      data: { profilePath },
    };
  },
};
