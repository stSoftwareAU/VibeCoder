/**
 * Batch API command — assess eligibility and estimate savings (Issue #1264).
 *
 * Provides a CLI entry point for the batch API module, supporting:
 *   - Phase eligibility assessment (`--assess-phases`)
 *   - Cost savings estimation (`--estimate-savings`)
 *
 * Usage:
 *   deno run mod.ts batch-api --assess-phases
 *   deno run mod.ts batch-api --estimate-savings --input-tokens 1000 --output-tokens 500 --model claude-haiku-4-5
 *
 * Uses Australian English throughout.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type BatchPhaseEligibility,
  type BatchSavingsEstimate,
  estimateBatchSavings,
  getBatchEligiblePhases,
  isBatchEligiblePhase,
} from "../lib/batch_api.ts";

/** Typed data returned by the batch-api command. */
export interface BatchApiCommandData {
  /** Phase eligibility assessments (when --assess-phases is used). */
  phases?: BatchPhaseEligibility[];
  /** Cost savings estimate (when --estimate-savings is used). */
  savings?: BatchSavingsEstimate;
  /** Single phase eligibility check (when --check-phase is used). */
  phaseEligible?: boolean;
}

/**
 * Batch API command implementation.
 */
export const batchApiCommand: Command = {
  name: "batch-api",
  description:
    "Assess batch API phase eligibility and estimate cost savings (Issue #1264)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<BatchApiCommandData>> {
    // Sub-command: assess phases
    if (args["assess-phases"] === true) {
      const phases = getBatchEligiblePhases();
      const eligible = phases.filter((p) => p.eligible);
      const ineligible = phases.filter((p) => !p.eligible);

      const lines: string[] = [
        "Batch API Phase Eligibility Assessment (Issue #1264)",
        "====================================================",
        "",
        `Eligible phases (${eligible.length}):`,
      ];

      for (const p of eligible) {
        lines.push(`  ✓ ${p.phase} — ${p.reason}`);
      }

      lines.push("");
      lines.push(`Ineligible phases (${ineligible.length}):`);

      for (const p of ineligible) {
        lines.push(`  ✗ ${p.phase} — ${p.reason}`);
      }

      return {
        success: true,
        message: lines.join("\n"),
        data: { phases },
      };
    }

    // Sub-command: estimate savings
    if (args["estimate-savings"] === true) {
      const inputTokens = Number(args["input-tokens"] ?? 0);
      const outputTokens = Number(args["output-tokens"] ?? 0);
      const model = (args["model"] as string) ?? "claude-haiku-4-5";

      if (inputTokens <= 0 && outputTokens <= 0) {
        return {
          success: false,
          message:
            "Provide --input-tokens and/or --output-tokens for savings estimation",
          data: {},
        };
      }

      const savings = estimateBatchSavings({
        inputTokens,
        outputTokens,
        model,
      });

      const lines = [
        `Batch API Savings Estimate (model: ${model})`,
        `  Standard cost: $${savings.standardCost.toFixed(6)}`,
        `  Batch cost:    $${savings.batchCost.toFixed(6)}`,
        `  Savings:       $${
          savings.savings.toFixed(6)
        } (${savings.discountPercentage}% discount)`,
      ];

      return {
        success: true,
        message: lines.join("\n"),
        data: { savings },
      };
    }

    // Sub-command: check single phase
    if (args["check-phase"] !== undefined) {
      const phase = args["check-phase"] as string;
      const eligible = isBatchEligiblePhase(phase);

      return {
        success: true,
        message: `Phase '${phase}' is ${
          eligible ? "eligible" : "not eligible"
        } for batch processing`,
        data: { phaseEligible: eligible },
      };
    }

    // No sub-command specified
    return {
      success: false,
      message:
        "Specify a sub-command: --assess-phases, --estimate-savings, or --check-phase <phase>",
      data: {},
    };
  },
};
