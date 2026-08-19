/**
 * GitHub App authentication command for the Vibe Coder worker.
 *
 * Issue #959: Provides GitHub App token operations callable from shell
 * via deno_bridge.sh. Supports sub-operations:
 *   - ensure-token: Generate/refresh an App installation token (outputs to stdout)
 *   - check-auth: Validate that App token generation works
 *
 * Uses Australian English spelling throughout (authorisation, behaviour, etc.)
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  ensureValidToken,
  isGitHubAppConfigured,
  resetTokenCache,
} from "../lib/github_app_auth.ts";

/** Data returned by the github-app-auth command. */
interface GitHubAppAuthData {
  configured: boolean;
  token?: string;
  valid?: boolean;
  message: string;
}

/**
 * GitHub App auth command implementation.
 *
 * Args:
 *   --operation <string>   Operation: ensure-token, check-auth
 *   --app-id <string>      GitHub App ID (falls back to GITHUB_APP_ID env var)
 *   --installation-id <string>  Installation ID (falls back to GITHUB_APP_INSTALLATION_ID env var)
 *   --private-key-path <string> Private key path (falls back to GITHUB_APP_PRIVATE_KEY_PATH env var)
 */
export const githubAppAuthCommand: Command = {
  name: "github-app-auth",
  description: "GitHub App authentication token management",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<GitHubAppAuthData>> {
    const operation = String(args["operation"] ?? "check-auth");

    const appId = String(
      args["app-id"] ?? Deno.env.get("GITHUB_APP_ID") ?? "",
    );
    const installationId = String(
      args["installation-id"] ??
        Deno.env.get("GITHUB_APP_INSTALLATION_ID") ?? "",
    );
    const privateKeyPath = String(
      args["private-key-path"] ??
        Deno.env.get("GITHUB_APP_PRIVATE_KEY_PATH") ?? "",
    );

    if (!isGitHubAppConfigured({ appId, installationId, privateKeyPath })) {
      return {
        success: true,
        message: "GITHUB_APP_NOT_CONFIGURED",
        data: {
          configured: false,
          message: "GitHub App authentication is not configured",
        },
      };
    }

    switch (operation) {
      case "ensure-token": {
        try {
          const token = await ensureValidToken(
            appId,
            installationId,
            privateKeyPath,
          );
          return {
            success: true,
            message: token,
            data: {
              configured: true,
              token,
              valid: true,
              message: "Token generated successfully",
            },
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            message: `GITHUB_APP_TOKEN_FAILED: ${msg}`,
            data: {
              configured: true,
              valid: false,
              message: msg,
            },
          };
        }
      }

      case "check-auth": {
        try {
          // Reset cache to force a fresh token generation for validation
          resetTokenCache();
          await ensureValidToken(appId, installationId, privateKeyPath);
          return {
            success: true,
            message: "GITHUB_APP_AUTH_VALID",
            data: {
              configured: true,
              valid: true,
              message: "GitHub App authentication is valid",
            },
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            message: `GITHUB_APP_AUTH_FAILED: ${msg}`,
            data: {
              configured: true,
              valid: false,
              message: msg,
            },
          };
        }
      }

      default:
        return {
          success: false,
          message: `Unknown github-app-auth operation: ${operation}`,
        };
    }
  },
};
