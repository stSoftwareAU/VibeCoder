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
    const mode = typeof args["mode"] === "string" && args["mode"]
      ? args["mode"]
      : (Deno.env.get("VIBE_RUN_MODE") ??
        (Deno.env.get("VIBE_IMAGE_AGENT_PROVIDERS") ? "container" : "unknown"));
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
