/**
 * Parsing and operator-config validation for worker-side idle-task seeding
 * requests (Issue #3860).
 *
 * Background — a capability regression. Seeding the full set of idle-task
 * wrappers on another monitored repo used to be reachable from an agent run
 * (the #3634 sweep). Since the agent-subprocess `gh` guard (#3643) the agent's
 * baked allowlist carries only the claimed issue's own repo, so every
 * `gh issue create` against the target repo is refused with
 * `[SECURITY] [WRITE_REPO_BLOCKED]` and the request dies in a `needs-human`
 * hand-off.
 *
 * The fix is not to widen the agent's allowlist — that would erode the #3311
 * exfiltration boundary. Instead the **worker** recognises the request before
 * the agent is spawned and performs the seeding itself, so every write flows
 * through the `spawnGh` chokepoint and lands in the audit journal.
 *
 * This module is the safety-critical half of that path: it turns the request
 * into a target repo that is guaranteed to come from operator-controlled
 * config.
 *
 * - {@link parseSeedIdleTasksTitle} reads the slug from the **issue title**
 *   only — never the body, never agent output.
 * - {@link resolveMonitoredRepo} matches that slug case-insensitively against
 *   the fleet `.config.json` `repos` list and returns the **config entry**,
 *   not the parsed text. An unmatched repo returns `null` and is refused by
 *   the caller.
 *
 * The value that reaches `registerWriteRepo` / `createAllIdleTaskWrappers` is
 * therefore always a string an operator put in `.config.json`; the issue text
 * only selects which of those entries is used.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { REPO_SLUG_PATTERN } from "./config.ts";

/**
 * Title prefix marking an issue as a full idle-task wrapper sweep request,
 * e.g. `seed-idle-tasks: stSoftwareAU/private-repo-14`. Matched case-insensitively,
 * in the same `.startsWith()` style as `ADD_REPO_PREFIX`.
 */
export const SEED_IDLE_TASKS_PREFIX = "seed-idle-tasks:";

/** Cheap title-prefix test (case-insensitive), matching the parser below. */
export function isSeedIdleTasksTitle(title: string): boolean {
  return title.trim().toLowerCase().startsWith(SEED_IDLE_TASKS_PREFIX);
}

/**
 * Parse a `seed-idle-tasks:`-prefixed issue title into a validated slug.
 *
 * Returns `{ repo }` when the title carries the prefix and the suffix is a
 * syntactically valid `owner/repo` slug. Returns `null` (never throws) for a
 * title without the prefix, with an empty slug, or with a slug failing
 * `REPO_SLUG_PATTERN`. Syntactic validity is not authorisation — the slug
 * must still be resolved against operator config by
 * {@link resolveMonitoredRepo} before it reaches any `gh` call.
 *
 * @param title - The raw issue title.
 * @returns The parsed slug, or `null` when the title does not qualify.
 */
export function parseSeedIdleTasksTitle(
  title: string,
): { repo: string } | null {
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  if (!trimmed.toLowerCase().startsWith(SEED_IDLE_TASKS_PREFIX)) return null;
  const slug = trimmed.slice(SEED_IDLE_TASKS_PREFIX.length).trim();
  if (slug.length === 0) return null;
  if (!REPO_SLUG_PATTERN.test(slug)) return null;
  return { repo: slug };
}

/**
 * Resolve a requested slug to its entry in the operator-controlled monitored
 * repo list.
 *
 * The comparison is case-insensitive (GitHub slugs are), but the value
 * returned is always the **config** entry — so the repo the worker writes to
 * is operator-authored text, never issue- or agent-authored text.
 *
 * @param requested - Slug parsed from the issue title.
 * @param monitoredRepos - The fleet `.config.json` `repos` list.
 * @returns The matching config entry, or `null` when the repo is not
 *          monitored.
 */
export function resolveMonitoredRepo(
  requested: string,
  monitoredRepos: readonly string[],
): string | null {
  const wanted = requested.trim().toLowerCase();
  if (wanted.length === 0) return null;
  for (const entry of monitoredRepos) {
    if (typeof entry !== "string") continue;
    if (entry.trim().toLowerCase() === wanted) return entry.trim();
  }
  return null;
}
