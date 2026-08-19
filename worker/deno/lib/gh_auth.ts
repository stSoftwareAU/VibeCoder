/**
 * GitHub CLI authentication verification (Issue #905).
 *
 * Detects gh auth token expiry at startup and during the scan loop,
 * providing actionable error messages instead of burning retries.
 *
 * Migrated from worker/shared/gh_auth.sh (Issue #587).
 * Uses Australian English spelling throughout (behaviour, authorisation, etc.)
 */

import type { Result } from "../types.ts";
import {
  ensureValidToken,
  type FetchFn,
  isGitHubAppConfigured,
} from "./github_app_auth.ts";
import { spawnGh } from "./gh_spawn.ts";

/**
 * AUTH_ERROR_PATTERNS — Case-insensitive patterns that indicate a
 * GitHub CLI authentication or authorisation failure.
 */
const AUTH_ERROR_PATTERNS: readonly string[] = [
  "401",
  "authentication",
  "auth token",
  "not logged in",
  "credential",
];

/**
 * Result of an authentication check.
 */
export interface AuthCheckResult {
  /** Whether authentication is valid. */
  valid: boolean;
  /** Human-readable status message. */
  message: string;
  /** Raw output from `gh auth status`, if available. */
  rawOutput?: string;
}

/**
 * Check whether error output from a gh CLI call indicates an
 * authentication or authorisation failure.
 *
 * Matches HTTP 401, "authentication", "auth token", "credential", and
 * "not logged in" patterns (case-insensitive).
 *
 * @param errorOutput - The stderr/stdout text from a failed gh command
 * @returns true if the output looks like an auth error
 */
export function isGhAuthError(errorOutput: string): boolean {
  if (!errorOutput) return false;

  const lower = errorOutput.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Return a human-readable message telling the operator how to fix an
 * expired gh auth token.
 *
 * When ghConfigDir is set (service account), the message includes the
 * environment variable so the operator can copy-paste the fix command.
 *
 * @param ghConfigDir - Optional GH_CONFIG_DIR value
 * @returns Actionable error message
 */
export function ghAuthActionableMessage(ghConfigDir?: string): string {
  if (ghConfigDir) {
    return `gh auth expired in GH_CONFIG_DIR=${ghConfigDir} — run: GH_CONFIG_DIR=${ghConfigDir} gh auth refresh`;
  }
  return "gh auth expired — run: gh auth refresh";
}

/**
 * Verify that gh CLI authentication is valid.
 *
 * Issue #959: When GitHub App is configured, validates by calling
 * ensureValidToken() instead of `gh auth status`. Falls back to
 * OAuth-based `gh auth status` when App config is absent.
 *
 * Honours VIBE_SKIP_AUTH_CHECK for CI/testing environments.
 *
 * @param options - Optional overrides for testing
 * @returns Result with auth check details
 */
export async function checkGhAuth(options?: {
  skipAuthCheck?: boolean;
  ghConfigDir?: string;
  /** GitHub App ID (falls back to GITHUB_APP_ID env var). */
  githubAppId?: string;
  /** GitHub App installation ID (falls back to GITHUB_APP_INSTALLATION_ID env var). */
  githubAppInstallationId?: string;
  /** Path to GitHub App private key (falls back to GITHUB_APP_PRIVATE_KEY_PATH env var). */
  githubAppPrivateKeyPath?: string;
  /** Override command runner for testing (avoids real `gh` calls). */
  runCommand?: (args: string[]) => Promise<{ code: number; output: string }>;
  /** Override fetch for testing GitHub App token exchange. */
  fetchFn?: FetchFn;
}): Promise<Result<AuthCheckResult>> {
  // Allow CI/testing to bypass
  if (options?.skipAuthCheck) {
    return {
      ok: true,
      value: { valid: true, message: "Auth check skipped" },
    };
  }

  // Issue #959: Check if GitHub App is configured
  const appId = options?.githubAppId ?? Deno.env.get("GITHUB_APP_ID");
  const installationId = options?.githubAppInstallationId ??
    Deno.env.get("GITHUB_APP_INSTALLATION_ID");
  const privateKeyPath = options?.githubAppPrivateKeyPath ??
    Deno.env.get("GITHUB_APP_PRIVATE_KEY_PATH");

  const appConfig = { appId, installationId, privateKeyPath };
  if (isGitHubAppConfigured(appConfig)) {
    return await checkGhAuthViaApp(
      appConfig.appId,
      appConfig.installationId,
      appConfig.privateKeyPath,
      options?.fetchFn,
    );
  }

  // Fall back to OAuth-based `gh auth status`
  const runCommand = options?.runCommand ?? defaultRunGhAuthStatus;

  try {
    const { code, output } = await runCommand(["auth", "status"]);

    if (code !== 0) {
      const actionable = ghAuthActionableMessage(options?.ghConfigDir);
      return {
        ok: true,
        value: {
          valid: false,
          message: actionable,
          rawOutput: output,
        },
      };
    }

    return {
      ok: true,
      value: { valid: true, message: "gh auth is valid", rawOutput: output },
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(`Failed to run gh auth status: ${msg}`),
    };
  }
}

/**
 * Validate authentication via GitHub App token generation.
 *
 * Issue #959: Validates by generating a fresh installation token.
 * If token generation succeeds, auth is valid.
 */
async function checkGhAuthViaApp(
  appId: string,
  installationId: string,
  privateKeyPath: string,
  fetchFn?: FetchFn,
): Promise<Result<AuthCheckResult>> {
  try {
    await ensureValidToken(appId, installationId, privateKeyPath, fetchFn);
    return {
      ok: true,
      value: {
        valid: true,
        message: "GitHub App authentication is valid",
      },
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: true,
      value: {
        valid: false,
        message: `GitHub App auth failed: ${msg}`,
      },
    };
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

/**
 * Parse the OAuth scope list from `gh auth status` output.
 *
 * `gh auth status` emits a line like:
 *   `  - Token scopes: 'admin:public_key', 'gist', 'repo', 'workflow'`
 *
 * When the user is logged into multiple accounts the output contains one
 * scopes line per account; the active account (`Active account: true`) is
 * preferred. If no active marker is found, the first scopes line wins.
 *
 * Returns an empty array when no `Token scopes:` line is present (e.g.
 * GitHub App installation auth, where OAuth scopes don't apply).
 */
export function parseGhAuthScopes(output: string): string[] {
  if (!output) return [];

  const lines = output.split("\n");
  const scopeLineRegex = /^\s*-\s*Token scopes:\s*(.+)$/i;

  let activeScopes: string | null = null;
  let firstScopes: string | null = null;
  let currentBlockIsActive = false;

  for (const line of lines) {
    if (/^\s*✓\s*Logged in/i.test(line) || /^github\.com\s*$/i.test(line)) {
      currentBlockIsActive = false;
    }
    if (/Active account:\s*true/i.test(line)) {
      currentBlockIsActive = true;
    }
    const match = line.match(scopeLineRegex);
    const captured = match?.[1];
    if (captured !== undefined) {
      const raw = captured.trim();
      if (firstScopes === null) firstScopes = raw;
      if (currentBlockIsActive && activeScopes === null) activeScopes = raw;
    }
  }

  const chosen = activeScopes ?? firstScopes;
  if (chosen === null) return [];

  return chosen
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter((s) => s.length > 0);
}

/**
 * Token scope information for the active gh auth account.
 */
export interface GhTokenScopes {
  /** OAuth scopes granted to the token (empty for GitHub App auth). */
  scopes: string[];
  /** Convenience flag — true if `workflow` scope is present. */
  hasWorkflowScope: boolean;
  /** Convenience flag — true if `repo` scope is present. */
  hasRepoScope: boolean;
  /** True when the token appears to be a GitHub App installation token. */
  isAppAuth: boolean;
  /** Raw `gh auth status` output (useful for diagnostics in logs). */
  rawOutput: string;
}

/**
 * Detect the OAuth scopes attached to the active gh CLI token.
 *
 * Called from `run_core.sh` at startup so the operator can see in the log
 * exactly which scopes the worker has — historically the worker has made
 * false claims about lacking `workflow` scope based on stale prompt text,
 * leading to incorrect `needs-human` escalations on workflow-file changes.
 *
 * Returns `ok: false` when the underlying `gh auth status` call fails (the
 * caller will already have logged an auth error via `checkGhAuth`).
 */
export async function getGhTokenScopes(options?: {
  runCommand?: (args: string[]) => Promise<{ code: number; output: string }>;
}): Promise<Result<GhTokenScopes>> {
  const runCommand = options?.runCommand ?? defaultRunGhAuthStatus;

  try {
    const { code, output } = await runCommand(["auth", "status"]);
    if (code !== 0) {
      return {
        ok: false,
        error: new Error(`gh auth status failed: ${output}`),
      };
    }

    const scopes = parseGhAuthScopes(output);
    const isAppAuth = scopes.length === 0 &&
      /GitHub App installation/i.test(output);

    return {
      ok: true,
      value: {
        scopes,
        hasWorkflowScope: scopes.includes("workflow"),
        hasRepoScope: scopes.includes("repo"),
        isAppAuth,
        rawOutput: output,
      },
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(`Failed to detect gh token scopes: ${msg}`),
    };
  }
}
