/**
 * Quality gate phase command for the Vibe Coder worker (Issue #1228).
 *
 * Wraps the quality gate phase orchestration: Docker image detection,
 * missing tool detection, quality check execution (Docker or native),
 * failure classification, and output formatting. Callable from shell
 * via the Deno CLI (`deno run mod.ts <command>`).
 *
 * Arguments:
 *   --repo                      Repository in "owner/repo" format
 *   --quality-script            Path to quality script (default: ./quality.sh)
 *   --baseline-quality-passed   Whether baseline quality passed — `true`,
 *                               `false`, or omitted for true. A value that
 *                               is neither is refused (Issue #1266).
 *   --baseline-quality-output   Baseline quality output (default: "")
 *   --timeout-seconds           Default timeout in seconds (default: 600)
 *
 * Output: JSON with the phase result:
 *   { action, qualityOutput, retryPrompt?, failureMessage?, dockerImage? }
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { coerceBooleanFlag } from "../lib/command_args.ts";
import {
  buildFinalFailureMessage,
  type QualityGateRunResult,
  runQualityGateCheck,
} from "../lib/quality_gate_phase.ts";

/** Data returned by the quality gate phase command. */
interface QualityGatePhaseData extends QualityGateRunResult {
  /** Formatted final failure message (for post-retry failures). */
  finalFailureMessage?: string;
}

export const qualityGatePhaseCommand: Command = {
  name: "quality-gate-phase",
  description:
    "Quality gate phase — Docker/native quality check execution with failure classification (Issue #1228)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<QualityGatePhaseData>> {
    const repo = String(args["repo"] ?? "");
    const qualityScript = String(args["quality-script"] ?? "./quality.sh");
    // Compared against the string "false" this flag could never be turned
    // off, so a red baseline was always reported as green and its failures
    // were attributed to the change under test (Issue #1266).
    const baselineQualityPassedResult = coerceBooleanFlag(
      args["baseline-quality-passed"],
      "baseline-quality-passed",
      true,
    );
    if (!baselineQualityPassedResult.ok) {
      return {
        success: false,
        message: baselineQualityPassedResult.error.message,
      };
    }
    const baselineQualityPassed = baselineQualityPassedResult.value;
    const baselineQualityOutput = String(args["baseline-quality-output"] ?? "");
    const timeoutSeconds = Number(args["timeout-seconds"] ?? 600);

    // Validate required arguments
    if (!repo) {
      return { success: false, message: "Missing required argument: --repo" };
    }

    const result = await runQualityGateCheck({
      repo,
      qualityScript,
      repoConfigs: config.repoConfig,
      baselineQualityPassed,
      baselineQualityOutput: baselineQualityOutput || undefined,
      defaultTimeoutSeconds: timeoutSeconds,
    });

    // For actions that are terminal failures, also build the final failure message
    const data: QualityGatePhaseData = { ...result };
    if (
      result.action === "failed_missing_command" ||
      result.action === "failed_docker_infra" ||
      result.action === "failed_missing_tools"
    ) {
      // These already have failureMessage set
    } else if (result.action === "failed") {
      data.finalFailureMessage = buildFinalFailureMessage(
        result.qualityOutput,
        baselineQualityPassed ? true : false,
        baselineQualityOutput || undefined,
      );
    }

    const success = result.action === "passed" || result.action === "skipped";

    // Output JSON for shell parsing
    return {
      success,
      message: JSON.stringify(data),
      data,
    };
  },
};
