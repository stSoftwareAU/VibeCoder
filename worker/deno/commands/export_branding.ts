/**
 * export-branding command (Issue #4197).
 *
 * Applies the private-name → `VibeCoder` branding transform to a staged
 * export tree, in place, and prints the per-variant / per-file report.
 * `export-public.sh` runs it after staging and before the scrub gate.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env mod.ts \
 *     export-branding --tree DIR [--report FILE] [--check]
 *
 * Exits non-zero only on an I/O error (missing tree, unwritable report).
 * A reference to the private repository is reported — never rewritten — and
 * it is the scrub gate (#4196) that blocks on it, so this command's exit
 * code says nothing about whether the tree is publishable.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  type BrandingReport,
  formatBrandingReport,
  transformBrandingTree,
} from "../lib/export_branding.ts";

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

export const exportBrandingCommand: Command = {
  name: "export-branding",
  description:
    "Rewrite the private product name to VibeCoder across a staged export " +
    "tree and report every replacement (Issue #4197)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<BrandingReport>> {
    const tree = stringArg(args, "tree");
    if (tree === "") {
      return {
        success: false,
        message: "❌ export-branding: --tree DIR is required",
      };
    }
    const reportPath = stringArg(args, "report");
    const write = args["check"] !== true;

    let report: BrandingReport;
    try {
      const info = await Deno.stat(tree);
      if (!info.isDirectory) throw new Error("not a directory");
      report = await transformBrandingTree(tree, { write });
    } catch (error) {
      return {
        success: false,
        message: `❌ export-branding could not run over ${tree}: ` +
          `${(error as Error).message}`,
      };
    }

    const text = formatBrandingReport(report);
    if (reportPath !== "") {
      try {
        await Deno.writeTextFile(reportPath, text);
      } catch (error) {
        return {
          success: false,
          message: `❌ export-branding could not write the report to ` +
            `${reportPath}: ${(error as Error).message}`,
        };
      }
    }
    return { success: true, message: text, data: report };
  },
};
