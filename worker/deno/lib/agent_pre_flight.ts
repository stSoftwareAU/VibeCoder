/**
 * Registry of per-repo pre-flight commands for agent spawns (Issue #3394).
 *
 * The agent runner installs a git pre-push hook so the agent's own
 * `git push` runs the repo's pre-flight. Resolving the commands here, keyed
 * by `owner/repo`, avoids threading config through every runner caller.
 * `loadConfig` is the producer: it registers the validated `repoConfig`.
 *
 * Australian English spelling throughout.
 */

import type { RepoConfig } from "../types.ts";
import { getPreFlightCommands } from "./repo_config.ts";

let registered: Record<string, RepoConfig> | undefined;

/** Store the repo configs the agent runner resolves pre-flight from. */
export function registerAgentPreFlightConfigs(
  repoConfigs: Record<string, RepoConfig> | undefined,
): void {
  registered = repoConfigs;
}

/** Pre-flight commands for `repo`, or `[]` when unknown or unregistered. */
export function agentPreFlightCommands(
  repo: string | undefined,
): readonly string[] {
  if (repo === undefined || registered === undefined) return [];
  return getPreFlightCommands(registered, repo);
}

/** Clear the registry between tests. */
export function resetAgentPreFlightConfigsForTest(): void {
  registered = undefined;
}
