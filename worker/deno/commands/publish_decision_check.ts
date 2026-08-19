/**
 * publish-decision-check command (Issue #4200).
 *
 * Checks the Phase 4 publish-decision dossier (`docs/PUBLISH-DECISION.md`)
 * so an incomplete dossier can never read as a GO: every condition must have
 * a verdict and cite an artefact, the document verdict must be dated, and
 * GO requires every condition MET.
 *
 * Usage:
 *   deno run --allow-read mod.ts publish-decision-check \
 *     [--repo /path/to/repo] [--dossier docs/PUBLISH-DECISION.md]
 *
 * Exits non-zero when the dossier is missing or has any problem.
 *
 * Australian English spelling used throughout (behaviour, artefact).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  checkPublishDecision,
  type PublishDecisionCheck,
} from "../lib/publish_decision_check.ts";

/** Default dossier path, relative to the repository root. */
export const DEFAULT_DOSSIER = "docs/PUBLISH-DECISION.md";

function stringArg(
  args: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function resolve(repoDir: string, path: string): string {
  return path.startsWith("/") ? path : `${repoDir}/${path}`;
}

/** Render the check as operator-facing lines. */
export function renderPublishDecisionCheck(
  result: PublishDecisionCheck,
  dossierPath: string,
): string {
  const lines = [
    `Dossier: ${dossierPath}`,
    `Verdict: ${result.verdict ?? "(missing)"}${
      result.dated ? ` (dated ${result.dated})` : ""
    }`,
    ...result.conditions.map((c) =>
      `  Condition ${c.number}: ${
        c.verdict ?? "(no verdict)"
      } — ${c.evidencePaths.length} artefact(s) cited`
    ),
  ];
  if (result.problems.length > 0) {
    lines.push("Problems:");
    lines.push(...result.problems.map((p) => `  - ${p}`));
  }
  return lines.join("\n");
}

export const publishDecisionCheckCommand: Command = {
  name: "publish-decision-check",
  description:
    "Check the Phase 4 publish-decision dossier: every condition needs a " +
    "verdict and a cited artefact; GO needs every condition MET (Issue #4200)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<PublishDecisionCheck>> {
    const repoDir = stringArg(args, "repo", Deno.cwd());
    const dossierPath = resolve(
      repoDir,
      stringArg(args, "dossier", DEFAULT_DOSSIER),
    );
    let text: string;
    try {
      text = await Deno.readTextFile(dossierPath);
    } catch (error) {
      return {
        success: false,
        message: `❌ Publish-decision dossier could not be read at ` +
          `${dossierPath}: ${(error as Error).message}`,
      };
    }
    const result = checkPublishDecision(text);
    const rendered = renderPublishDecisionCheck(result, dossierPath);
    if (result.problems.length > 0) {
      return {
        success: false,
        message: `❌ Publish-decision dossier has ${result.problems.length} ` +
          `problem(s) — it cannot be relied on\n${rendered}`,
        data: result,
      };
    }
    return {
      success: true,
      message:
        `✅ Publish-decision dossier is well-formed: ${result.verdict}\n${rendered}`,
      data: result,
    };
  },
};
