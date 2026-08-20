/**
 * Shuffle repos command for the Vibe Coder worker.
 *
 * Conditionally shuffles or preserves repo scan order, callable from
 * shell via the Deno CLI (`deno run mod.ts <command>`).
 *
 * Migrated from worker/shared/array_utils.sh (Issue #901).
 * Issue #271: Randomise repo scan order for fair work distribution.
 * Issue #435: Conditional shuffle based on configuration.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { maybeShuffleRepos } from "../lib/array_utils.ts";

/** Data returned by the shuffle-repos command. */
export interface ShuffleReposData {
  repos: string[];
  shuffled: boolean;
}

/**
 * Shuffle repos command implementation.
 *
 * Args:
 *   --repos <string>  Comma-separated list of repos (e.g., "org/repo1,org/repo2")
 *   --shuffle <bool>  Whether to shuffle (default: true, reads from config if omitted)
 *
 * Output:
 *   Each repo on its own line, in the resolved order.
 */
export const shuffleReposCommand: Command = {
  name: "shuffle-repos",
  description: "Conditionally shuffle or preserve repo scan order (Issue #435)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<ShuffleReposData>> {
    // Parse repos from comma-separated string or JSON array
    let repos: string[] = [];
    const reposArg = args["repos"];
    if (typeof reposArg === "string") {
      repos = reposArg
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
    } else if (Array.isArray(reposArg)) {
      repos = reposArg.filter(
        (r): r is string => typeof r === "string" && r.length > 0,
      );
    }

    // Determine shuffle behaviour: explicit arg > config > default (true)
    let shuffle: boolean;
    if (typeof args["shuffle"] === "boolean") {
      shuffle = args["shuffle"];
    } else if (typeof args["shuffle"] === "string") {
      shuffle = args["shuffle"] !== "false";
    } else {
      shuffle = config.shuffleRepos;
    }

    const result = maybeShuffleRepos({ repos, shuffle });

    if (!result.ok) {
      return { success: false, message: result.error.message };
    }

    // Output each repo on its own line (matches shell convention)
    const message = result.value.join("\n");

    return {
      success: true,
      message,
      data: { repos: result.value, shuffled: shuffle },
    };
  },
};
