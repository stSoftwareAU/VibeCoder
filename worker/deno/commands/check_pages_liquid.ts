/**
 * check-pages-liquid command (Issue #1601).
 *
 * Validates that every published Markdown file (AGENTS.md, README.md,
 * SECURITY.md, docs/**\/*.md) parses as valid Liquid AFTER the same
 * preprocessing step the Pages workflow uses. Catches the class of
 * regression that broke the Pages build in #1599.
 *
 * Usage:
 *   deno run --allow-read --allow-run --allow-write \
 *     mod.ts check-pages-liquid [--script-dir /repo/root]
 *
 * Skips with a clear reason when Ruby + Liquid is not available so
 * contributors without the Pages toolchain are not blocked.
 *
 * Australian English spelling used throughout.
 */

import type { Command, CommandResult } from "../types.ts";
import {
  type PagesLiquidCheckResult,
  runPagesLiquidCheck,
} from "../lib/pages_liquid_check.ts";

export const checkPagesLiquidCommand: Command = {
  name: "check-pages-liquid",
  description:
    "Validate that published Markdown parses as valid Liquid after Pages preprocessing (Issue #1601)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<PagesLiquidCheckResult>> {
    const scriptDir = typeof args["script-dir"] === "string"
      ? args["script-dir"] as string
      : Deno.cwd();

    const result = await runPagesLiquidCheck(scriptDir);

    return {
      // SKIPPED is treated as success at the command level — the
      // quality gate's strict-mode evaluation decides whether a skip
      // counts as failure overall.
      success: result.status !== "FAILED",
      message: result.output,
      data: result,
    };
  },
};
