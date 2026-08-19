/**
 * Failure diagnosis command for the Vibe Coder worker.
 *
 * Context-aware failure categorisation and diagnosis messaging.
 * Callable from shell via deno_bridge.sh.
 *
 * Sub-operations (--operation):
 *   - detect-category: Analyse failure message and return category
 *   - is-infrastructure: Check if category is transient/infrastructure
 *   - get-category-display: Map category to user-facing display name
 *   - get-diagnosis: Return category-specific diagnosis text
 *   - get-diagnosis-oneliner: Return brief one-line cause summary
 *   - extract-key-errors: Extract key error lines from text
 *
 * Migrated from worker/shared/failure_diagnosis.sh (Issue #909).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  type ClarityStatus,
  detectFailureCategory,
  extractKeyErrorLines,
  formatZeroOutputDiagnostics,
  getFailureCategoryDisplay,
  getFailureDiagnosis,
  getFailureDiagnosisOneliner,
  isInfrastructureFailure,
  normaliseFailureCategory,
} from "../lib/failure_diagnosis.ts";

export const failureDiagnosisCommand: Command = {
  name: "failure-diagnosis",
  description: "Context-aware failure categorisation and diagnosis messaging",

  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "detect-category");

    switch (operation) {
      case "detect-category": {
        const message = String(args["message"] ?? "");
        const category = detectFailureCategory(message);
        return {
          success: true,
          message: category,
          data: { category },
        };
      }

      case "is-infrastructure": {
        const category = String(args["category"] ?? "unknown");
        const result = isInfrastructureFailure(
          category as ReturnType<typeof detectFailureCategory>,
        );
        return {
          success: true,
          message: result ? "true" : "false",
          data: { isInfrastructure: result },
        };
      }

      case "get-category-display": {
        const category = String(args["category"] ?? "unknown");
        const display = getFailureCategoryDisplay(
          category as ReturnType<typeof detectFailureCategory>,
        );
        return {
          success: true,
          message: display,
          data: { display },
        };
      }

      case "get-diagnosis": {
        const category = String(args["category"] ?? "unknown");
        const clarityStatus = String(
          args["clarity-status"] ?? "not_assessed",
        ) as ClarityStatus;
        const diagnosticContext = String(args["diagnostic-context"] ?? "");
        const diagnosis = getFailureDiagnosis(
          normaliseFailureCategory(category),
          clarityStatus,
          diagnosticContext,
        );
        return {
          success: true,
          message: diagnosis,
          data: { diagnosis },
        };
      }

      case "get-diagnosis-oneliner": {
        const category = String(args["category"] ?? "unknown");
        const clarityStatus = String(
          args["clarity-status"] ?? "not_assessed",
        ) as ClarityStatus;
        const oneliner = getFailureDiagnosisOneliner(
          normaliseFailureCategory(category),
          clarityStatus,
        );
        return {
          success: true,
          message: oneliner,
          data: { oneliner },
        };
      }

      case "extract-key-errors": {
        const text = String(args["text"] ?? "");
        const lines = extractKeyErrorLines(text);
        return {
          success: true,
          message: lines,
          data: { lines },
        };
      }

      case "format-zero-output-diagnostics": {
        const context = String(args["diagnostic-context"] ?? "");
        const formatted = formatZeroOutputDiagnostics(context);
        return {
          success: true,
          message: formatted,
          data: { formatted },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown failure-diagnosis operation: ${operation}`,
        };
    }
  },
};
