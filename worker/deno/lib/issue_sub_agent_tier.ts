/**
 * Resolver for the `issue_sub_agent_tier` config key (Issue #3401).
 *
 * The key is host-wide, with a same-named per-repository override under
 * `repo_config`. It selects the model tier — `"sonnet"` or `"haiku"` — of
 * the `issue`-phase executor sub-agents. Default `"sonnet"`; an invalid
 * value (wrong type, or a string outside the allowed set) is warned about
 * and replaced by the default, rather than failing `loadConfig`.
 */

import type { IssueSubAgentTier, RepoConfig, WorkerConfig } from "../types.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";

/** The only valid values for `issue_sub_agent_tier`. */
export const ISSUE_SUB_AGENT_TIERS: readonly IssueSubAgentTier[] = [
  "sonnet",
  "haiku",
];

/** Whether `value` is a recognised {@link IssueSubAgentTier}. */
export function isIssueSubAgentTier(
  value: unknown,
): value is IssueSubAgentTier {
  return typeof value === "string" &&
    (ISSUE_SUB_AGENT_TIERS as readonly string[]).includes(value);
}

/** Human-readable rendering of the allowed tiers, e.g. `"sonnet" | "haiku"`. */
const ALLOWED_TIERS_LABEL = ISSUE_SUB_AGENT_TIERS.map((tier) =>
  JSON.stringify(tier)
).join(" | ");

/**
 * Resolves the host-wide `issue_sub_agent_tier` value from a loaded config
 * file, warning and falling back to the default on an invalid value.
 *
 * @param value - The raw `issue_sub_agent_tier` value from `.config.json`
 * @param log - Warning sink, defaults to `console.warn`
 */
export function resolveHostIssueSubAgentTier(
  value: unknown,
  log: (message: string) => void = console.warn,
): IssueSubAgentTier {
  if (value === undefined) return OPERATIONAL_DEFAULTS.issueSubAgentTier;
  if (isIssueSubAgentTier(value)) return value;

  log(
    `[issue-sub-agent-tier] issue_sub_agent_tier ${
      JSON.stringify(value)
    } is not one of ${ALLOWED_TIERS_LABEL}; ignoring it and using the ` +
      `default ${JSON.stringify(OPERATIONAL_DEFAULTS.issueSubAgentTier)}.`,
  );
  return OPERATIONAL_DEFAULTS.issueSubAgentTier;
}

/**
 * Resolves the effective `issue_sub_agent_tier` for a repository.
 *
 * Resolution order (most specific wins):
 *   1. The repository's own `repo_config.<repo>.issue_sub_agent_tier`, if
 *      a recognised tier
 *   2. The host-wide `issueSubAgentTier` (re-validated here, because callers
 *      can hand-build a `WorkerConfig`)
 *
 * @param hostConfig - The slice of the loaded worker config carrying the tier
 * @param repoConfig - The active repository's `repo_config` entry, if any
 * @param log - Warning sink, defaults to `console.warn`
 */
export function resolveIssueSubAgentTier(
  hostConfig: Pick<WorkerConfig, "issueSubAgentTier">,
  repoConfig: RepoConfig | undefined,
  log: (message: string) => void = console.warn,
): IssueSubAgentTier {
  const hostTier = resolveHostIssueSubAgentTier(
    hostConfig.issueSubAgentTier,
    log,
  );

  const repoValue = repoConfig?.issueSubAgentTier;
  if (repoValue === undefined) return hostTier;
  if (isIssueSubAgentTier(repoValue)) return repoValue;

  log(
    `[issue-sub-agent-tier] repo_config issue_sub_agent_tier ${
      JSON.stringify(repoValue)
    } is not one of ${ALLOWED_TIERS_LABEL}; ignoring it and using the ` +
      `host-wide value ${JSON.stringify(hostTier)}.`,
  );
  return hostTier;
}
