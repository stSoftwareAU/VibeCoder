/**
 * Haiku sub-agent degradation for `issue`-phase runs (Issue #3405).
 *
 * When an `issue`-phase run resolved `issue_sub_agent_tier: "haiku"` but the
 * API served a previous-generation Haiku (e.g. `claude-haiku-4-5`) and no
 * current Haiku, the issue is labelled `degraded-model` and the run-stats
 * comment names both models, so a trial result is never silently measured on
 * the wrong model. Tier `sonnet` never triggers it.
 *
 * Issue runs do not reach `reportPhaseDegradation`, so this is wired on the
 * issue-run wrap-up paths directly. Labelling is non-fatal: it reuses
 * {@link applyDegradedModelLabel}, which logs and never throws.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { IssueSubAgentTier, Logger } from "../types.ts";
import { previousGenerationOf } from "./current_models.ts";
import type { PhaseClaudeResult } from "./phase_run_stats.ts";
import { applyDegradedModelLabel } from "./planning_degraded_label.ts";
import { parseClaudeModernVersion } from "./token_usage.ts";

/** What a haiku-tier run expected against what the API served. */
export interface IssueSubAgentDegradation {
  /** The current Haiku model a haiku-tier run expected (CURRENT_TIER_MODELS haiku row). */
  requested: string;
  /** The distinct previous-generation Haiku models the API served, first-seen order. */
  served: string[];
}

/**
 * Decide whether a haiku-tier issue run was served a stale Haiku.
 *
 * Lenient, like `assessPreviousGeneration`: one current (or newer) Haiku among
 * the served models keeps the run healthy.
 *
 * @returns The degradation, or undefined when the run is healthy or not haiku-tier
 */
export function assessIssueSubAgentDegradation(args: {
  tier: IssueSubAgentTier;
  claudeResults: readonly PhaseClaudeResult[];
}): IssueSubAgentDegradation | undefined {
  if (args.tier !== "haiku") return undefined;

  const served: string[] = [];
  for (const result of args.claudeResults) {
    for (const model of result.runStats?.servedModels ?? []) {
      if (!served.includes(model)) served.push(model);
    }
  }

  const stale = served.filter((model) =>
    previousGenerationOf(model)?.tier === "haiku"
  );
  if (stale.length === 0) return undefined;

  const currentHaikuServed = served.some((model) =>
    !stale.includes(model) &&
    parseClaudeModernVersion(model.trim().toLowerCase())?.tier === "haiku"
  );
  if (currentHaikuServed) return undefined;

  const requested = previousGenerationOf(stale[0] ?? "")?.current;
  return requested ? { requested, served: stale } : undefined;
}

/** Allow-list sanitiser: model ids are API-sourced, so no markdown can ride in. */
function sanitiseModelId(model: string): string {
  return model.replace(/[^A-Za-z0-9._:@/-]/g, "");
}

/**
 * Render the stats-comment line naming the requested and served Haiku models.
 *
 * @returns The bullet line, or `""` when there is no degradation
 */
export function buildIssueSubAgentDegradationLine(
  degradation?: IssueSubAgentDegradation,
): string {
  if (!degradation) return "";
  const served = degradation.served
    .map((model) => `\`${sanitiseModelId(model)}\``)
    .join(", ");
  return `- **Haiku sub-agents degraded:** requested \`${
    sanitiseModelId(degradation.requested)
  }\` (\`issue_sub_agent_tier: haiku\`), served ${served}`;
}

/**
 * Assess the run and, when degraded, warn and apply the `degraded-model` label.
 *
 * A healthy or non-haiku run makes no GitHub call. Never throws.
 *
 * @returns The assessment, for the stats comment to render
 */
export async function reportIssueSubAgentDegradation(args: {
  repo: string;
  issueNumber: number;
  tier: IssueSubAgentTier;
  claudeResults: readonly PhaseClaudeResult[];
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
  cacheDir?: string;
}): Promise<IssueSubAgentDegradation | undefined> {
  const degradation = assessIssueSubAgentDegradation({
    tier: args.tier,
    claudeResults: args.claudeResults,
  });
  if (!degradation) return undefined;

  args.logger.warn(
    "Haiku sub-agent tier was served a previous-generation Haiku — " +
      "labelling degraded-model (Issue #3405)",
    {
      repo: args.repo,
      issueNumber: args.issueNumber,
      requested: degradation.requested,
      served: degradation.served,
    },
  );
  await applyDegradedModelLabel({
    repo: args.repo,
    parentIssueNumber: args.issueNumber,
    subIssueNumbers: [],
    ghCommandFn: args.ghCommandFn,
    logger: args.logger,
    ...(args.cacheDir ? { cacheDir: args.cacheDir } : {}),
  });
  return degradation;
}
