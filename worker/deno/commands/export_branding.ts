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
 * `--check` reports without touching the tree. The default is the in-place
 * rewrite, so an option the command does not recognise — a `--dry-run`, or a
 * `--check=true` the parser splits differently — is refused rather than
 * ignored (Issue #1266).
 *
 * Exits non-zero on an I/O error (missing tree, unwritable report) or an
 * unreadable option.
 * A reference to the private repository is reported — never rewritten — and
 * it is the scrub gate (#4196) that blocks on it, so this command's exit
 * code says nothing about whether the tree is publishable.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult } from "../types.ts";
import { coerceBooleanFlag, findUnknownOptions } from "../lib/command_args.ts";
import {
  type BrandingReport,
  formatBrandingReport,
  transformBrandingTree,
} from "../lib/export_branding.ts";

/**
 * Options this command accepts (Issue #1266).
 *
 * The command rewrites the tree in place by default, so an option it does
 * not recognise is refused rather than dropped: `--dry-run`, or a `--check`
 * written as `--check=true`, would otherwise be ignored and the tree would
 * be rewritten when the operator asked for a report only. This is the
 * discipline `commands/export_scrub_gate.ts` already applies.
 */
const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  "tree",
  "report",
  "check",
]);

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
    const unknown = findUnknownOptions(args, KNOWN_OPTIONS);
    if (unknown.length > 0) {
      return {
        success: false,
        message: `❌ export-branding: unknown option(s) ` +
          `${unknown.map((k) => `--${k}`).join(", ")} — refused rather than ` +
          `ignored; it accepts only --tree, --report, --check`,
      };
    }
    const tree = stringArg(args, "tree");
    if (tree === "") {
      return {
        success: false,
        message: "❌ export-branding: --tree DIR is required",
      };
    }
    const reportPath = stringArg(args, "report");
    // `--check` asks for a report without touching the tree. An `=== true`
    // test mapped every other shape to "write", so a --check the parser
    // could not read rewrote the tree in place (Issue #1266).
    const checkResult = coerceBooleanFlag(args["check"], "check", false);
    if (!checkResult.ok) {
      return {
        success: false,
        message: `❌ export-branding: ${checkResult.error.message}`,
      };
    }
    const write = !checkResult.value;

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
