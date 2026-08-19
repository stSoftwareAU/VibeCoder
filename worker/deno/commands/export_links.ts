/**
 * export-links command (Issues #4197, #4198).
 *
 * Make the staged export self-contained: unlink relative Markdown links
 * whose target the export withheld (label kept, link dropped, each one
 * reported) and report links that are broken in the private tree too.
 * `export-public.sh` runs it after the redaction stage and before the scrub
 * gate.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env mod.ts \
 *     export-links --tree DIR --source DIR [--report FILE]
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  type LinkReport,
  relinkTree,
  renderLinkReport,
} from "../lib/export_links.ts";

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

export const exportLinksCommand: Command = {
  name: "export-links",
  description:
    "Unlink Markdown links to documents the export withheld and report links " +
    "broken in the source tree, so the staged export is self-contained " +
    "(Issues #4197, #4198)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<LinkReport>> {
    const tree = stringArg(args, "tree");
    const source = stringArg(args, "source");
    if (tree === "" || source === "") {
      return {
        success: false,
        message: "❌ export-links: --tree DIR and --source DIR are required",
      };
    }
    const reportPath = stringArg(args, "report");
    let report: LinkReport;
    try {
      for (const dir of [tree, source]) {
        const info = await Deno.stat(dir);
        if (!info.isDirectory) throw new Error(`${dir} is not a directory`);
      }
      report = await relinkTree(tree, { sourceDir: source });
    } catch (error) {
      return {
        success: false,
        message: `❌ export-links could not run over ${tree}: ${
          (error as Error).message
        }`,
      };
    }
    const text = renderLinkReport(report);
    if (reportPath !== "") {
      try {
        await Deno.writeTextFile(reportPath, text);
      } catch (error) {
        return {
          success: false,
          message:
            `❌ export-links could not write the report to ${reportPath}: ${
              (error as Error).message
            }`,
        };
      }
    }
    return { success: true, message: text, data: report };
  },
};
