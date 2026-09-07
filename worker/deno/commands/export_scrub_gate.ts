/**
 * export-scrub-gate command (Issue #4196).
 *
 * Scans a staged export tree for private identifiers and fails on any
 * finding the reviewed allowlist does not cover. `export-public.sh` runs it
 * after the branding transform and before the staged commit; a failure
 * leaves the staging tree unpublished.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env mod.ts \
 *     export-scrub-gate --tree DIR --identifiers FILE \
 *       [--allowlist FILE] [--report FILE]
 *
 * Exits non-zero on any unallowlisted finding, on an identifiers/allowlist
 * error (an entry without a justifying comment, an unknown class), on a
 * missing input, or on an I/O error. There is deliberately **no** flag that
 * lets a finding through: an unrecognised option is itself an error, so a
 * `--force`, `--skip` or similar can never be quietly ignored.
 *
 * A staged file the gate cannot decode as UTF-8 text is a blocking
 * `binary-unscanned` finding (Issue #1265), not a silent skip: the gate
 * reports PASS only over a tree it examined in full, so such a file must be
 * dropped from the export or carry a reviewed allowlist entry naming it.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult } from "../types.ts";
import { findUnknownOptions } from "../lib/command_args.ts";
import {
  formatGateReport,
  gatePasses,
  type GateReport,
  scanTree,
} from "../lib/export_scrub_gate.ts";

const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  "tree",
  "identifiers",
  "allowlist",
  "report",
]);

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

export const exportScrubGateCommand: Command = {
  name: "export-scrub-gate",
  description:
    "Block a staged export on any private identifier, e-mail, key shape, " +
    "operator path or private-repo reference (Issue #4196)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<GateReport>> {
    const unknown = findUnknownOptions(args, KNOWN_OPTIONS);
    if (unknown.length > 0) {
      return {
        success: false,
        message: `❌ export-scrub-gate: unknown option(s) ` +
          `${unknown.map((k) => `--${k}`).join(", ")} — the gate has no ` +
          `bypass; it accepts only --tree, --identifiers, --allowlist, --report`,
      };
    }
    const tree = stringArg(args, "tree");
    if (tree === "") {
      return {
        success: false,
        message: "❌ export-scrub-gate: --tree DIR is required",
      };
    }
    const identifiersPath = stringArg(args, "identifiers");
    if (identifiersPath === "") {
      return {
        success: false,
        message: "❌ export-scrub-gate: --identifiers FILE is required " +
          "(the operator identifiers the gate blocks)",
      };
    }
    const allowlistPath = stringArg(args, "allowlist");
    const reportPath = stringArg(args, "report");

    let report: GateReport;
    try {
      const info = await Deno.stat(tree);
      if (!info.isDirectory) throw new Error(`${tree} is not a directory`);
      const identifiersText = await Deno.readTextFile(identifiersPath);
      const allowlistText = allowlistPath === ""
        ? undefined
        : await Deno.readTextFile(allowlistPath);
      report = await scanTree({ tree, identifiersText, allowlistText });
    } catch (error) {
      // Fail loud — a gate that could not run is not a gate that passed.
      return {
        success: false,
        message: `❌ export-scrub-gate could not run: ` +
          `${(error as Error).message}`,
      };
    }

    const text = formatGateReport(report);
    if (reportPath !== "") {
      try {
        await Deno.writeTextFile(reportPath, text);
      } catch (error) {
        return {
          success: false,
          message: `❌ export-scrub-gate could not write the report to ` +
            `${reportPath}: ${(error as Error).message}\n\n${text}`,
        };
      }
    }
    const ok = gatePasses(report);
    return {
      success: ok,
      message: ok ? text : `❌ Scrub gate blocked the export\n\n${text}`,
      data: report,
    };
  },
};
