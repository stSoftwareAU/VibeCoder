/**
 * Answer sanitiser command for the Vibe Coder worker (Issue #913).
 *
 * Provides Claude output sanitisation via the Deno CLI (`deno run mod.ts <command>`).
 * Replaces worker/shared/answer_sanitiser.sh.
 *
 * Sub-operations (--operation):
 *   - sanitise: Remove meta-commentary from Claude's answer output
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { sanitiseAnswerOutput } from "../lib/answer_sanitiser.ts";

export const answerSanitiserCommand: Command = {
  name: "answer-sanitiser",
  description: "Claude output sanitisation (Issue #913)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "sanitise");

    switch (operation) {
      case "sanitise": {
        const rawOutput = String(args["raw-output"] ?? "");
        const sanitised = sanitiseAnswerOutput(rawOutput);
        return { success: true, message: sanitised };
      }

      default:
        return {
          success: false,
          message: `Unknown operation: ${operation}. Valid: sanitise`,
        };
    }
  },
};
