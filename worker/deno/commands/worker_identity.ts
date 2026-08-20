/**
 * Worker identity command for the Vibe Coder worker.
 *
 * Provides worker identity information (display name, unique ID, footer)
 * callable from shell via the Deno CLI (`deno run mod.ts <command>`).
 *
 * Migrated from worker/shared/worker_identity.sh (Issue #900).
 * Issue #436: Add worker name to issue comments and PR descriptions.
 * Issue #604: Add unique worker ID for multi-worker claim tie-breaking.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  buildWorkerFooter,
  getWorkerDisplayName,
  getWorkerUniqueId,
  type WorkerIdentityData,
} from "../lib/worker_identity.ts";

/**
 * Worker identity command implementation.
 *
 * Args:
 *   --github-user <string>  GitHub username (fallback for display name)
 *   --action <string>       One of: display-name, unique-id, footer (default: display-name)
 */
export const workerIdentityCommand: Command = {
  name: "worker-identity",
  description:
    "Get worker identity information (display name, unique ID, footer)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<WorkerIdentityData>> {
    const githubUser = typeof args["github-user"] === "string"
      ? args["github-user"]
      : "";
    const action = typeof args["action"] === "string"
      ? args["action"]
      : "display-name";

    const options = {
      workerName: config.workerName,
      githubUser,
    };

    const displayName = getWorkerDisplayName(options);
    const uniqueId = getWorkerUniqueId(config.workerName);
    const footer = buildWorkerFooter(options);

    let message: string;
    switch (action) {
      case "unique-id":
        message = uniqueId;
        break;
      case "footer":
        message = footer;
        break;
      case "display-name":
      default:
        message = displayName;
        break;
    }

    return {
      success: true,
      message,
      data: {
        displayName,
        uniqueId,
        footer,
      },
    };
  },
};
