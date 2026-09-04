/**
 * Trusted-author set for the escape-hatch follow-up gate (Issue #185,
 * SEC-8f21c4a0e7b3).
 *
 * `verifyFollowUpIssueExists` accepts a hand-off only when GitHub reports the
 * follow-up issue as filed by a login the worker actually trusts. This module
 * answers "which logins are those?" in one place, so the answer cannot drift
 * between call sites:
 *
 * - the worker's own login (`GITHUB_USER`) — the run that filed the follow-up,
 * - sibling fleet hosts (`fleet_pr_authors`),
 * - trusted humans (`allowed_authors`, `authorized_commenters`).
 *
 * A prompt-injected message can name any pre-existing issue number, but it
 * cannot change who GitHub recorded as that issue's author — that is the
 * unforgeable signal the gate turns on.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import { resolveFleetAuthors } from "./fleet_authors.ts";

/** Configuration inputs that define "a login the worker trusts to file a follow-up". */
export interface TrustedFollowUpAuthorInput {
  /** The worker's own GitHub login. */
  githubUser: string;
  /** Trusted issue authors (`allowed_authors`). */
  allowedAuthors?: readonly string[];
  /** Sibling fleet logins (`fleet_pr_authors`). */
  fleetPrAuthors?: readonly string[];
  /** Humans authorised to instruct the worker (`authorized_commenters`). */
  authorisedCommenters?: readonly string[];
}

/**
 * Resolve the trusted follow-up author set from its configuration inputs.
 *
 * Blank entries are dropped and duplicates removed case-insensitively (GitHub
 * logins are case-insensitive) by the shared {@link resolveFleetAuthors}
 * helper, so the set stays in step with the fleet author resolution the rest
 * of the worker uses.
 *
 * @param input - The configured author inputs.
 * @returns Deduplicated trusted login list (may be empty when nothing is
 *          configured — the caller must then fail closed).
 */
export function resolveTrustedFollowUpAuthors(
  input: TrustedFollowUpAuthorInput,
): string[] {
  return resolveFleetAuthors(
    input.githubUser,
    [...(input.allowedAuthors ?? []), ...(input.authorisedCommenters ?? [])],
    [...(input.fleetPrAuthors ?? [])],
  );
}

/**
 * Load the trusted follow-up author set from the worker config and env.
 *
 * On a config failure the set narrows to the worker's own login — never
 * widens — and is empty when no login is resolvable at all, which
 * `verifyFollowUpIssueExists` treats as "cannot verify" and rejects. The
 * failure is logged at ERROR so an unreadable config is never mistaken for a
 * clean run.
 *
 * @param deps - Worker dependencies providing `config.loadConfig`.
 * @param logger - Logger for the loud failure.
 * @param githubUser - The run's resolved worker login. Preferred over the
 *        `GITHUB_USER` env var, which is only a fallback for callers that
 *        have not resolved it (the env var can be unset in the worker
 *        container, which would otherwise fail the gate closed on a
 *        legitimate self-filed follow-up).
 * @param env - Where `GITHUB_USER` and `CONFIG_PATH` are read from
 *        (Issue #965). Defaults to the process environment, so every
 *        production caller behaves exactly as before; a test states the
 *        ambient identity instead of setting it on the process.
 * @returns The trusted logins, or `[]` when they could not be resolved.
 */
export async function loadTrustedFollowUpAuthors(
  deps: WorkerDeps,
  logger: Logger,
  githubUser?: string,
  env: EnvLookup = processEnvLookup,
): Promise<string[]> {
  const workerLogin = (githubUser ?? "").trim() ||
    (env("GITHUB_USER") ?? "");
  try {
    const configPath = env("CONFIG_PATH") ?? ".config.json";
    const config = await deps.config.loadConfig(configPath);
    return resolveTrustedFollowUpAuthors({
      githubUser: workerLogin,
      allowedAuthors: config.allowedAuthors,
      fleetPrAuthors: config.fleetPrAuthors,
      authorisedCommenters: config.authorisedCommenters,
    });
  } catch (err) {
    logger.error(
      "Could not load the trusted-author allowlist for the escape-hatch " +
        "follow-up gate — the hand-off will be rejected (Issue #185)",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return resolveTrustedFollowUpAuthors({ githubUser: workerLogin });
  }
}
