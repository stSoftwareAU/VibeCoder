/**
 * Resolver for the `issue_executor_split` config key (Issue #2341).
 *
 * The key is host-wide, with a same-named per-repository override under
 * `repo_config`. It is registered and resolvable here; nothing downstream
 * reads it yet, so with the key off — the default — the worker invokes the
 * coding agent exactly as it does today.
 */

import type { RepoConfig, WorkerConfig } from "../types.ts";

/** The only phase the split applies to. */
const SPLIT_PHASE = "issue";

/** The slice of {@link WorkerConfig} this resolver reads. */
type IssueExecutorSplitConfig = Pick<WorkerConfig, "issueExecutorSplit">;

/**
 * Whether the issue-executor split is enabled for a phase on a repository.
 *
 * Resolution order (most specific wins):
 *   1. The repository's own `repo_config.<repo>.issue_executor_split`
 *   2. The host-wide `issue_executor_split`
 *   3. `false` — an unconfigured host behaves exactly as it does today
 *
 * The key applies to **every** `issue`-phase run on the host, including
 * `failed-once` retries and milestone child issues; there is no per-issue
 * opt-out. Every other phase (`planning`, `pr_feedback`, `ci_fix`, …)
 * resolves `false` whatever the config says.
 *
 * A per-repository value that is not a boolean (`repo_config` is loosely
 * typed and not schema-validated) is refused loudly and the host value
 * stands, rather than a truthy string silently enabling the split.
 *
 * @param phase - Phase name the run is executing, e.g. `"issue"`
 * @param repoConfig - The active repository's `repo_config` entry, if any
 * @param config - The loaded worker config
 * @returns `true` only for an `issue`-phase run the config enables
 */
export function isIssueExecutorSplitEnabled(
  phase: string | undefined,
  repoConfig: RepoConfig | undefined,
  config: IssueExecutorSplitConfig,
): boolean {
  if (phase !== SPLIT_PHASE) return false;

  const repoValue = repoConfig?.issueExecutorSplit;
  if (repoValue !== undefined) {
    if (typeof repoValue === "boolean") return repoValue;
    console.warn(
      `[issue-executor-split] repo_config issue_executor_split must be a ` +
        `boolean, got ${typeof repoValue}; ignoring it and using the ` +
        `host-wide value.`,
    );
  }

  return config.issueExecutorSplit === true;
}
