/**
 * GitHub CLI authentication command for the Vibe Coder worker.
 *
 * Provides authentication verification callable from shell via deno_bridge.sh.
 * Supports sub-operations:
 *   - check-auth: Verify gh CLI authentication is valid
 *   - is-auth-error: Check if error output indicates an auth failure
 *   - actionable-message: Get human-readable fix instructions
 *
 * Migrated from worker/shared/gh_auth.sh (Issue #905, Issue #587).
 * Uses Australian English spelling throughout (authorisation, behaviour, etc.)
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type AuthCheckResult,
  checkGhAuth,
  getGhTokenScopes,
  ghAuthActionableMessage,
  type GhTokenScopes,
  isGhAuthError,
} from "../lib/gh_auth.ts";

/** Combined result type for the gh-auth command. */
type GhAuthData =
  | AuthCheckResult
  | { isAuthError: boolean }
  | { message: string }
  | GhTokenScopes;

/**
 * GH auth command implementation.
 *
 * Args:
 *   --operation <string>   Operation: check-auth, is-auth-error, actionable-message
 *   --error-output <string> Error output to check (for is-auth-error)
 *   --gh-config-dir <string> GH_CONFIG_DIR value (for actionable-message)
 *   --skip-auth-check <boolean> Whether to skip the auth check (for check-auth)
 */
export const ghAuthCommand: Command = {
  name: "gh-auth",
  description: "GitHub CLI authentication verification",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<GhAuthData>> {
    const operation = String(args["operation"] ?? "check-auth");

    switch (operation) {
      case "check-auth": {
        const skipAuthCheck = args["skip-auth-check"] === true ||
          args["skip-auth-check"] === "true";
        const ghConfigDir = args["gh-config-dir"]
          ? String(args["gh-config-dir"])
          : undefined;

        const result = await checkGhAuth({
          skipAuthCheck,
          ghConfigDir,
        });

        if (!result.ok) {
          return {
            success: false,
            message: result.error.message,
          };
        }

        const { valid, message } = result.value;
        return {
          success: valid,
          message: valid ? "AUTH_VALID" : `AUTH_FAILED: ${message}`,
          data: result.value,
        };
      }

      case "is-auth-error": {
        const errorOutput = String(args["error-output"] ?? "");
        const isAuth = isGhAuthError(errorOutput);
        return {
          success: true,
          message: isAuth ? "IS_AUTH_ERROR" : "NOT_AUTH_ERROR",
          data: { isAuthError: isAuth },
        };
      }

      case "actionable-message": {
        const ghConfigDir = args["gh-config-dir"]
          ? String(args["gh-config-dir"])
          : undefined;
        const msg = ghAuthActionableMessage(ghConfigDir);
        return {
          success: true,
          message: msg,
          data: { message: msg },
        };
      }

      case "check-scopes": {
        // Detect the OAuth scopes attached to the active gh token at startup
        // so the operator (and any tooling that reads this) has ground truth
        // about whether the worker can push workflow files, etc. Historically
        // the worker has falsely escalated workflow-file issues to needs-human
        // claiming "no workflow scope" — this gives an authoritative answer.
        const result = await getGhTokenScopes();
        if (!result.ok) {
          return {
            success: false,
            message: `SCOPE_DETECTION_FAILED: ${result.error.message}`,
          };
        }
        const { scopes, hasWorkflowScope, hasRepoScope, isAppAuth } =
          result.value;
        const summary = isAppAuth
          ? "scopes=<github-app> (OAuth scopes not applicable)"
          : `scopes=${scopes.join(",") || "<none>"} workflow=${
            hasWorkflowScope ? "yes" : "NO"
          } repo=${hasRepoScope ? "yes" : "NO"}`;
        return {
          success: true,
          message: summary,
          data: result.value,
        };
      }

      default:
        return {
          success: false,
          message: `Unknown gh-auth operation: ${operation}`,
        };
    }
  },
};
