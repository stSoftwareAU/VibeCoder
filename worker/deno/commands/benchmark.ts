/**
 * Benchmark command (Issue #4299).
 *
 * Runs the fixed container-vs-native workload and prints a table plus one
 * JSON line for fleet telemetry.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type BenchmarkReport,
  formatBenchmarkTable,
  runBenchmark,
} from "../lib/benchmark.ts";
import { runningInContainerImage } from "../lib/container_stamp.ts";
import { type EnvLookup, processEnvLookup } from "../lib/env_lookup.ts";

/**
 * The run environment label recorded in the report (Issue #1493).
 *
 * An explicit `--mode` wins, then `VIBE_RUN_MODE`. Only then does the
 * container image stamp decide, and it decides by *value*: a blank
 * `VIBE_IMAGE_AGENT_PROVIDERS` is a host run, so the label is `"unknown"`
 * rather than a fleet telemetry row that claims a container that was never
 * there. Reporting only — nothing branches on it.
 *
 * @param modeArg - The `--mode` argument, if the operator passed one.
 * @param env - Environment lookup (defaults to the process environment).
 * @returns The mode label.
 */
export function resolveBenchmarkMode(
  modeArg: unknown,
  env: EnvLookup = processEnvLookup,
): string {
  if (typeof modeArg === "string" && modeArg) return modeArg;
  return env("VIBE_RUN_MODE") ??
    (runningInContainerImage(env) ? "container" : "unknown");
}

/**
 * Args:
 *   --work-dir <string>   Scratch root (defaults to config.workDir / WORK_DIR).
 *   --mode <string>       Label: container | native (default: VIBE_RUN_MODE or "unknown").
 *   --entry <string>      Worker entry to type-check (default: this mod.ts).
 *   --only <a,b,c>        Subset of steps.
 *   --json                Print only the JSON line.
 */
export const benchmarkCommand: Command = {
  name: "benchmark",
  description:
    "Run the fixed container-vs-native workload and report wall times (Issue #4299)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<BenchmarkReport>> {
    const workDir =
      typeof args["work-dir"] === "string" && args["work-dir"].length > 0
        ? args["work-dir"]
        : (config.workDir || Deno.env.get("WORK_DIR") || "");
    if (!workDir) {
      return {
        success: false,
        message:
          "benchmark: --work-dir is required (no config.workDir or WORK_DIR env var)",
      };
    }
    const mode = resolveBenchmarkMode(args["mode"]);
    const entryPath = typeof args["entry"] === "string" && args["entry"]
      ? args["entry"]
      : new URL("../mod.ts", import.meta.url).pathname;
    let host = "unknown";
    try {
      host = Deno.env.get("VIBE_HOST_ID") ?? Deno.hostname();
    } catch {
      // hostname permission may be absent — keep the placeholder
    }
    const only = typeof args["only"] === "string" && args["only"]
      ? args["only"].split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    const report = await runBenchmark({
      workDir,
      entryPath,
      mode,
      host,
      ...(only ? { only } : {}),
    });

    const json = JSON.stringify(report);
    const message = args["json"]
      ? json
      : `${formatBenchmarkTable(report)}\n${json}`;
    return { success: report.steps.every((s) => s.ok), message, data: report };
  },
};
