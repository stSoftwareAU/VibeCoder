/**
 * Terminal title command for the Vibe Coder worker.
 *
 * Sets the terminal window title to indicate the current task.
 * Callable from shell via the Deno CLI (`deno run mod.ts <command>`).
 *
 * Migrated from worker/shared/terminal_title.sh (Issue #900).
 * Issue #263: Set window title to the task currently being worked on.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { type EnvLookup, processEnvLookup } from "../lib/env_lookup.ts";
import {
  resetWindowTitle,
  setWindowTitle,
  setWindowTitleForIssue,
  setWindowTitleForPr,
  type TerminalTitleData,
} from "../lib/terminal_title.ts";

/**
 * The command, plus the environment seam it reads `SET_WINDOW_TITLE`
 * through (Issue #965).
 *
 * Declared as a widening of {@link Command} — the extra parameter is
 * optional and defaults to the process environment, so the registry and
 * `mod.ts` see the interface they always did.
 */
export interface TerminalTitleCommand extends Command {
  execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
    env?: EnvLookup,
  ): Promise<CommandResult<TerminalTitleData>>;
}

/**
 * Terminal title command implementation.
 *
 * Args:
 *   --action <string>  One of: set, reset, issue, pr (default: set)
 *   --title <string>   Title text (for "set" action)
 *   --repo <string>    Repository (for "issue" and "pr" actions)
 *   --number <string>  Issue or PR number (for "issue" and "pr" actions)
 *   --description <string>  Issue title or task description
 */
export const terminalTitleCommand: TerminalTitleCommand = {
  name: "terminal-title",
  description: "Set the terminal window title for current task visibility",

  /**
   * @param args - The action and its inputs.
   * @param _config - The worker configuration, which no action reads.
   * @param env - Where `SET_WINDOW_TITLE` is read from (Issue #965).
   *   Defaults to the process environment, so shell callers are unchanged;
   *   a test states whether titles are enabled instead of setting the
   *   variable on the process.
   */
  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
    env: EnvLookup = processEnvLookup,
  ): Promise<CommandResult<TerminalTitleData>> {
    const action = typeof args["action"] === "string" ? args["action"] : "set";

    // Check SET_WINDOW_TITLE env var for backward compatibility with shell
    const envEnabled = env("SET_WINDOW_TITLE") === "true";
    const options = { enabled: envEnabled };

    let sequence: string;
    let title: string;

    switch (action) {
      case "reset": {
        sequence = resetWindowTitle(options);
        title = "VibeCoder";
        break;
      }
      case "issue": {
        const repo = typeof args["repo"] === "string" ? args["repo"] : "";
        const number = typeof args["number"] === "string"
          ? args["number"]
          : String(args["number"] ?? "");
        const description = typeof args["description"] === "string"
          ? args["description"]
          : "";
        title = `VibeCoder: ${repo} #${number} - ${description}`;
        sequence = setWindowTitleForIssue(repo, number, description, options);
        break;
      }
      case "pr": {
        const repo = typeof args["repo"] === "string" ? args["repo"] : "";
        const number = typeof args["number"] === "string"
          ? args["number"]
          : String(args["number"] ?? "");
        const description = typeof args["description"] === "string"
          ? args["description"]
          : "";
        title = `VibeCoder: ${repo} PR #${number} - ${description}`;
        sequence = setWindowTitleForPr(repo, number, description, options);
        break;
      }
      case "set":
      default: {
        title = typeof args["title"] === "string" ? args["title"] : "";
        sequence = setWindowTitle(title, options);
        break;
      }
    }

    // Output the sequence to stdout so the terminal picks it up
    if (sequence.length > 0) {
      const encoder = new TextEncoder();
      await Deno.stdout.write(encoder.encode(sequence));
    }

    return {
      success: true,
      message: envEnabled ? `Title set: ${title}` : "Title setting disabled",
      data: {
        title,
        sequence,
        enabled: envEnabled,
      },
    };
  },
};
