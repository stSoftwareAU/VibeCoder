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
 * (for `trustedAuthorsFor`) already imports `fleet_authors.ts`, so importing
 * `fleet_authors.ts` back from a module `trust_snapshot.ts` also feeds would
 * create a cycle. This module sits above both instead.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
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
 * the widened set is actually what gets read: the per-repo map, when
 * present, would otherwise take priority over the plain `allowedAuthors`
 * this function just set, and the per-repo trust is already folded into it
 * via `trustedAuthorsFor`.
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
