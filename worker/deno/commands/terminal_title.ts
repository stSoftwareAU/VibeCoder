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
import {
  resetWindowTitle,
  setWindowTitle,
  setWindowTitleForIssue,
  setWindowTitleForPr,
  type TerminalTitleData,
} from "../lib/terminal_title.ts";

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
export const terminalTitleCommand: Command = {
  name: "terminal-title",
  description: "Set the terminal window title for current task visibility",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<TerminalTitleData>> {
    const action = typeof args["action"] === "string" ? args["action"] : "set";

    // Check SET_WINDOW_TITLE env var for backward compatibility with shell
    const envEnabled = Deno.env.get("SET_WINDOW_TITLE") === "true";
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
