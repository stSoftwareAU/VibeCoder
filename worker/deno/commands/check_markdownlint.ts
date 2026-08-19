/**
 * check-markdownlint command (Issue #1685).
 *
 * Validates Markdown structural quality across published docs by
 * driving `markdownlint-cli2`. Used by the quality gate so the broader
 * class of Markdown breakage missed by `pages-liquid` and `mermaid` —
 * malformed tables, broken heading hierarchies, missing-space ATX
 * headings, empty links — is caught before merge.
 *
 * Usage:
 *   deno run --allow-read --allow-run mod.ts check-markdownlint \
 *     [--script-dir /repo/root]
 *
 * Skips with a clear reason when `markdownlint-cli2` is not available
 * locally, mirroring the pages-liquid/check-pages-liquid pattern.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  type MarkdownlintCheckResult,
  runMarkdownlintCheck,
} from "../lib/markdownlint_check.ts";

export const checkMarkdownlintCommand: Command = {
  name: "check-markdownlint",
  description:
    "Validate Markdown structural quality via markdownlint-cli2 (Issue #1685)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<MarkdownlintCheckResult>> {
    const scriptDir = typeof args["script-dir"] === "string"
      ? (args["script-dir"] as string)
      : Deno.cwd();

    const result = await runMarkdownlintCheck(scriptDir);

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
