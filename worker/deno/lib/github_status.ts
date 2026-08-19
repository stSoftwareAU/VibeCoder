/**
 * GitHub user status management for the Vibe Coder worker.
 *
 * Updates the authenticated user's GitHub profile status to indicate what
 * the worker is currently doing. This gives a quick at-a-glance view:
 *   - Working on an issue or PR
 *   - Idle / waiting for work
 *   - Successfully completed work
 *   - Failed to complete work
 *
 * This is optional and controlled by UPDATE_GH_USER_STATUS (default: false).
 * Requires the `user` scope on the GitHub token. If the scope is missing,
 * the feature gracefully degrades (continues working without status updates).
 *
 * Migrated from worker/shared/github_status.sh (Issue #905, Issue #409).
 * Uses Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import type { Result } from "../types.ts";
import { spawnGh } from "./gh_spawn.ts";

/** Maximum length for GitHub status messages. */
const GH_STATUS_MAX_LENGTH = 80;

/** Valid status states. */
export type StatusState = "working" | "idle" | "success" | "failure";

/**
 * Result of a status update operation.
 */
export interface StatusUpdateResult {
  /** Whether the update was attempted. */
  attempted: boolean;
  /** Whether the update succeeded. */
  succeeded: boolean;
  /** Human-readable message. */
  message: string;
  /** The emoji that was set. */
  emoji?: string;
  /** The status text that was set. */
  statusText?: string;
}

/**
 * Select a GitHub emoji shortcode for the given state.
 *
 * @param state - The status state
 * @returns GitHub emoji shortcode (e.g., ":robot:")
 */
export function selectGhStatusEmoji(state: StatusState | string): string {
  switch (state) {
    case "working":
      return ":hammer_and_wrench:";
    case "idle":
      return ":zzz:";
    case "success":
      return ":white_check_mark:";
    case "failure":
      return ":face_with_thermometer:";
    default:
      return ":robot:";
  }
}

/**
 * Build a human-readable status message.
 *
 * @param state - The status state
 * @param repo - Optional repository (e.g., "owner/repo")
 * @param number - Optional issue/PR number
 * @param title - Optional issue/PR title
 * @returns Status message, truncated to GH_STATUS_MAX_LENGTH
 */
export function buildGhStatusMessage(
  state: StatusState | string,
  repo?: string,
  number?: string,
  title?: string,
): string {
  let message = "";

  switch (state) {
    case "working":
      if (repo && number) {
        message = `Working on ${repo}#${number}`;
        if (title) message = `${message}: ${title}`;
      } else {
        message = "Working on something...";
      }
      break;
    case "idle":
      message = "Idle - waiting for work";
      break;
    case "success":
      if (repo && number) {
        message = `Completed ${repo}#${number}`;
        if (title) message = `${message}: ${title}`;
      } else {
        message = "Just completed some work!";
      }
      break;
    case "failure":
      if (repo && number) {
        message = `Struggling with ${repo}#${number}`;
        if (title) message = `${message}: ${title}`;
      } else {
        message = "Hit a snag on recent work";
      }
      break;
    default:
      message = "Vibe Coding";
      break;
  }

  // Truncate to maximum length
  if (message.length > GH_STATUS_MAX_LENGTH) {
    message = message.substring(0, GH_STATUS_MAX_LENGTH - 3) + "...";
  }

  return message;
}

/**
 * Set the GitHub user status via the GraphQL API.
 *
 * Only runs when updateGhUserStatus is true. Non-fatal — if the API call
 * fails, it returns a result indicating failure but does not throw.
 *
 * @param state - Status state: "working", "idle", "success", "failure"
 * @param options - Additional options
 * @param runGraphql - Optional GraphQL runner override for testing
 * @returns Result with update details
 */
export async function setGhUserStatus(
  state: StatusState | string,
  options?: {
    updateGhUserStatus?: boolean;
    repo?: string;
    number?: string;
    title?: string;
  },
  runGraphql?: (
    query: string,
    variables: Record<string, string>,
  ) => Promise<void>,
): Promise<Result<StatusUpdateResult>> {
  if (!options?.updateGhUserStatus) {
    return {
      ok: true,
      value: {
        attempted: false,
        succeeded: false,
        message: "GitHub status updates disabled",
      },
    };
  }

  const emoji = selectGhStatusEmoji(state);
  const statusText = buildGhStatusMessage(
    state,
    options.repo,
    options.number,
    options.title,
  );
  const busy = state === "working" ? "true" : "false";

  const runner = runGraphql ?? defaultRunGraphql;

  try {
    await runner(
      `mutation($emoji: String!, $message: String!, $busy: Boolean!) {
        changeUserStatus(input: {emoji: $emoji, message: $message, limitedAvailability: $busy}) {
          status { emoji message }
        }
      }`,
      { emoji, message: statusText, busy },
    );

    return {
      ok: true,
      value: {
        attempted: true,
        succeeded: true,
        message: `Status updated: ${statusText}`,
        emoji,
        statusText,
      },
    };
  } catch {
    return {
      ok: true,
      value: {
        attempted: true,
        succeeded: false,
        message: "Failed to update GitHub user status (missing 'user' scope?)",
        emoji,
        statusText,
      },
    };
  }
}

/**
 * Clear the GitHub user status.
 *
 * Only runs when updateGhUserStatus is true. Non-fatal.
 *
 * @param updateGhUserStatus - Whether status updates are enabled
 * @param runGraphql - Optional GraphQL runner override for testing
 * @returns Result with update details
 */
export async function clearGhUserStatus(
  updateGhUserStatus?: boolean,
  runGraphql?: (
    query: string,
    variables: Record<string, string>,
  ) => Promise<void>,
): Promise<Result<StatusUpdateResult>> {
  if (!updateGhUserStatus) {
    return {
      ok: true,
      value: {
        attempted: false,
        succeeded: false,
        message: "GitHub status updates disabled",
      },
    };
  }

  const runner = runGraphql ?? defaultRunGraphql;

  try {
    await runner(
      `mutation {
        changeUserStatus(input: {}) {
          status { emoji message }
        }
      }`,
      {},
    );

    return {
      ok: true,
      value: {
        attempted: true,
        succeeded: true,
        message: "GitHub user status cleared",
      },
    };
  } catch {
    return {
      ok: true,
      value: {
        attempted: true,
        succeeded: false,
        message: "Failed to clear GitHub user status",
      },
    };
  }
}

/**
 * Check if GitHub status updates are available.
 *
 * Returns true if UPDATE_GH_USER_STATUS is true and the gh CLI is available.
 *
 * @param updateGhUserStatus - Whether status updates are enabled
 * @param runCommand - Optional command runner override for testing
 * @returns Whether status updates are available
 */
export async function checkGhStatusAvailable(
  updateGhUserStatus?: boolean,
  runCommand?: (args: string[]) => Promise<{ code: number; output: string }>,
): Promise<boolean> {
  if (!updateGhUserStatus) return false;

  const runner = runCommand ?? defaultRunGhAuthStatus;

  try {
    const { code, output } = await runner(["auth", "status"]);
    if (code !== 0) return false;

    // Check if the token has the 'user' scope
    if (output.includes("token scopes") && !output.includes("'user'")) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Default GraphQL runner using gh api graphql.
 */
async function defaultRunGraphql(
  query: string,
  variables: Record<string, string>,
): Promise<void> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (key === "busy") {
      args.push("-F", `${key}=${value}`);
    } else {
      args.push("-f", `${key}=${value}`);
    }
  }

  const { code } = await spawnGh(args, { stdout: "null", stderr: "null" });
  if (code !== 0) {
    throw new Error(`gh api graphql failed with exit code ${code}`);
  }
}

/**
 * Default implementation that runs `gh auth status`.
 */
async function defaultRunGhAuthStatus(
  args: string[],
): Promise<{ code: number; output: string }> {
  const { code, stdout, stderr } = await spawnGh(args);
  return { code, output: `${stdout}\n${stderr}`.trim() };
}
