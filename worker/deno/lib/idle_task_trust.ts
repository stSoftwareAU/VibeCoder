/**
 * The widened trust set shared by the `idle-task` scan and pickup content
 * integrity checks (Issue #2944).
 *
 * `idle-task` is the one work-trigger label the worker (and its fleet
 * siblings) may self-apply (Issue #2022), so the content-integrity check for
 * an `idle-task` issue must trust the same widened login set the idle-task
 * scan already trusts — `allowedAuthors` for this repo, unioned with the
 * fleet's own logins — not the narrower, human-only trust set every other
 * approval label verifies against. Without this, a worker- or sibling-filed
 * wrapper that the scan happily claimed at scan time would fail its own
 * pickup-time re-verification, since the pickup check otherwise reads the
 * plain `config.allowedAuthors`.
 *
 * Deliberately **not** folded into `fleet_authors.ts`: `trust_snapshot.ts`
 * already imports `fleet_authors.ts`, so this helper lives in its own module
 * above both to avoid feeding `fleet_authors.ts` back into `trust_snapshot.ts`
 * and creating a cycle.
 */

import type { WorkerConfig } from "../types.ts";
import { trustedAuthorsFor } from "./trust_snapshot.ts";
import { resolveFleetAuthors } from "./fleet_authors.ts";

/**
 * Build the config variant content-integrity checks use when verifying an
 * `idle-task` issue (Issue #2944).
 *
 * `allowedAuthors` is replaced with the union of this repository's trusted
 * authors (`trustedAuthorsFor`) and the fleet's own logins (this host plus
 * `fleet_pr_authors`) — the same set `collect_idle_task_candidates.ts`
 * resolves as `idleTaskTrustedAuthors`. `allowedAuthorsByRepo` is cleared so
 * this widened set is what actually gets read, rather than the per-repo map
 * (whose trust is already folded in via `trustedAuthorsFor`) taking priority.
 */
export function idleTaskIntegrityConfig(
  config: WorkerConfig,
  repo: string,
  githubUser: string,
): WorkerConfig {
  return {
    ...config,
    allowedAuthors: resolveFleetAuthors(
      githubUser,
      trustedAuthorsFor(config, repo),
      config.fleetPrAuthors,
    ),
    allowedAuthorsByRepo: undefined,
  };
}
