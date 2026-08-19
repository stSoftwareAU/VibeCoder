/**
 * export-redact command (Issues #4196, #4197).
 *
 * Replace operator identifiers and private repository names in a STAGED
 * export tree with deterministic placeholders, driven by the private
 * `export/scrub-redactions.txt`, and write a report beside the tree.
 * `export-public.sh` runs it after the branding transform and before the
 * scrub gate; it is never a bypass of the gate — whatever the mapping does
 * not express is still a gate finding.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env mod.ts \
 *     export-redact --tree DIR --redactions FILE --identifiers FILE \
 *       [--report FILE]
 *
 * `rename:` rules also rename files and directories (case-preserving), so the
 * fleet-health module ships under its public name and imports keep resolving.
 *
 * `--identifiers` is the scrub-gate identifiers file: its `public-repo:`
 * declarations are the repositories the private-repository mapping leaves
 * alone.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  parseRedactions,
  type RedactionReport,
  redactTree,
  renderRedactionReport,
} from "../lib/export_redact.ts";
import { parseIdentifiers } from "../lib/export_scrub_gate.ts";

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

export const exportRedactCommand: Command = {
  name: "export-redact",
  description:
    "Replace operator identifiers and private repository names in a staged " +
    "export tree with deterministic placeholders and report every " +
    "replacement (Issues #4196, #4197)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<RedactionReport>> {
    const tree = stringArg(args, "tree");
    const redactionsPath = stringArg(args, "redactions");
    const identifiersPath = stringArg(args, "identifiers");
    if (tree === "" || redactionsPath === "" || identifiersPath === "") {
      return {
        success: false,
        message:
          "❌ export-redact: --tree DIR, --redactions FILE and --identifiers FILE are required",
      };
    }
    const reportPath = stringArg(args, "report");

    let redactionsText: string;
    let identifiersText: string;
    try {
      const info = await Deno.stat(tree);
      if (!info.isDirectory) throw new Error(`${tree} is not a directory`);
      redactionsText = await Deno.readTextFile(redactionsPath);
      identifiersText = await Deno.readTextFile(identifiersPath);
    } catch (error) {
      return {
        success: false,
        message: `❌ export-redact could not read its inputs: ${
          (error as Error).message
        }`,
      };
    }
    const redactions = parseRedactions(redactionsText);
    const identifiers = parseIdentifiers(identifiersText);
    const errors = [...redactions.errors, ...identifiers.errors];
    if (errors.length > 0) {
      return {
        success: false,
        message: `❌ export-redact: configuration errors —\n  ${
          errors.join("\n  ")
        }`,
      };
    }

    let report: RedactionReport;
    try {
      report = await redactTree(tree, {
        rules: redactions.rules,
        privateRepoTemplate: redactions.privateRepoTemplate,
        publicRepos: identifiers.publicRepos,
        repoPolicy: identifiers.repoPolicy,
        renames: redactions.renames,
      });
    } catch (error) {
      return {
        success: false,
        message: `❌ export-redact could not run over ${tree}: ${
          (error as Error).message
        }`,
      };
    }

    const text = renderRedactionReport(report);
    if (reportPath !== "") {
      try {
        await Deno.writeTextFile(reportPath, text);
      } catch (error) {
        return {
          success: false,
          message:
            `❌ export-redact could not write the report to ${reportPath}: ${
              (error as Error).message
            }`,
        };
      }
    }
    return { success: true, message: text, data: report };
  },
};
