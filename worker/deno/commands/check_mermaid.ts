/**
 * check-mermaid command (Issue #1683).
 *
 * Validates every Mermaid block in every `.md` file in the repository.
 * Used by the quality gate so syntax regressions like Issue #1663 are
 * caught before they ship.
 *
 * Usage:
 *   deno run --allow-read mod.ts check-mermaid [--script-dir /repo/root]
 *
 * Exits non-zero when any block fails. Reports file path, opening-fence
 * line number, diagram type, and validator error per failure.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  type MermaidCheckResult,
  runMermaidCheck,
} from "../lib/mermaid_check.ts";

export const checkMermaidCommand: Command = {
  name: "check-mermaid",
  description:
    "Validate every Mermaid block in every .md file in the repo (Issue #1683)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<MermaidCheckResult>> {
    const scriptDir = typeof args["script-dir"] === "string"
      ? (args["script-dir"] as string)
      : Deno.cwd();

    const result = await runMermaidCheck(scriptDir);

    return {
      // SKIPPED is treated as success at the command level — strict mode
      // in the quality gate decides whether a skip counts as failure.
      success: result.status !== "FAILED",
      message: result.output,
      data: result,
    };
  },
};
