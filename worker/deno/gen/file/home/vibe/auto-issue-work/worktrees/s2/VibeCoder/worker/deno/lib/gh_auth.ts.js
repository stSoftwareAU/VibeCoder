/**
 * GitHub CLI authentication verification (Issue #905).
 *
 * Detects gh auth token expiry at startup and during the scan loop,
 * providing actionable error messages instead of burning retries.
 *
 * Migrated from worker/shared/gh_auth.sh (Issue #587).
 * Uses Australian English spelling throughout (behaviour, authorisation, etc.)
 */ import { ensureValidToken, isGitHubAppConfigured } from "./github_app_auth.ts";
import { spawnGh } from "./gh_spawn.ts";
/**
 * AUTH_ERROR_PATTERNS — Case-insensitive patterns that indicate a
 * GitHub CLI authentication or authorisation failure.
 */ const AUTH_ERROR_PATTERNS = [
  "401",
  "authentication",
  "auth token",
  "not logged in",
  "credential"
];
/**
 * Check whether error output from a gh CLI call indicates an
 * authentication or authorisation failure.
 *
 * Matches HTTP 401, "authentication", "auth token", "credential", and
 * "not logged in" patterns (case-insensitive).
 *
 * @param errorOutput - The stderr/stdout text from a failed gh command
 * @returns true if the output looks like an auth error
 */ export function isGhAuthError(errorOutput) {
  if (!errorOutput) return false;
  const lower = errorOutput.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((pattern)=>lower.includes(pattern));
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
 */ export function ghAuthActionableMessage(ghConfigDir) {
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
 */ export async function checkGhAuth(options) {
  // Allow CI/testing to bypass
  if (options?.skipAuthCheck) {
    return {
      ok: true,
      value: {
        valid: true,
        message: "Auth check skipped"
      }
    };
  }
  // Issue #959: Check if GitHub App is configured
  const appId = options?.githubAppId ?? Deno.env.get("GITHUB_APP_ID");
  const installationId = options?.githubAppInstallationId ?? Deno.env.get("GITHUB_APP_INSTALLATION_ID");
  const privateKeyPath = options?.githubAppPrivateKeyPath ?? Deno.env.get("GITHUB_APP_PRIVATE_KEY_PATH");
  const appConfig = {
    appId,
    installationId,
    privateKeyPath
  };
  if (isGitHubAppConfigured(appConfig)) {
    return await checkGhAuthViaApp(appConfig.appId, appConfig.installationId, appConfig.privateKeyPath, options?.fetchFn);
  }
  // Fall back to OAuth-based `gh auth status`
  const runCommand = options?.runCommand ?? defaultRunGhAuthStatus;
  try {
    const { code, output } = await runCommand([
      "auth",
      "status"
    ]);
    if (code !== 0) {
      const actionable = ghAuthActionableMessage(options?.ghConfigDir);
      return {
        ok: true,
        value: {
          valid: false,
          message: actionable,
          rawOutput: output
        }
      };
    }
    return {
      ok: true,
      value: {
        valid: true,
        message: "gh auth is valid",
        rawOutput: output
      }
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(`Failed to run gh auth status: ${msg}`)
    };
  }
}
/**
 * Validate authentication via GitHub App token generation.
 *
 * Issue #959: Validates by generating a fresh installation token.
 * If token generation succeeds, auth is valid.
 */ async function checkGhAuthViaApp(appId, installationId, privateKeyPath, fetchFn) {
  try {
    await ensureValidToken(appId, installationId, privateKeyPath, fetchFn);
    return {
      ok: true,
      value: {
        valid: true,
        message: "GitHub App authentication is valid"
      }
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: true,
      value: {
        valid: false,
        message: `GitHub App auth failed: ${msg}`
      }
    };
  }
}
/**
 * Default implementation that runs `gh auth status`.
 */ async function defaultRunGhAuthStatus(args) {
  const { code, stdout, stderr } = await spawnGh(args);
  return {
    code,
    output: `${stdout}\n${stderr}`.trim()
  };
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
 */ export function parseGhAuthScopes(output) {
  if (!output) return [];
  const lines = output.split("\n");
  const scopeLineRegex = /^\s*-\s*Token scopes:\s*(.+)$/i;
  let activeScopes = null;
  let firstScopes = null;
  let currentBlockIsActive = false;
  for (const line of lines){
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
  return chosen.split(",").map((s)=>s.trim().replace(/^['"]|['"]$/g, "")).filter((s)=>s.length > 0);
}
/**
 * The OAuth scopes the fleet's token needs (Issue #2690): `repo` to clone,
 * push and open PRs, `workflow` to push `.github/workflows/` changes, and
 * `read:org` for team and organisation reads.
 */ export const FLEET_TOKEN_SCOPES = [
  "repo",
  "workflow",
  "read:org"
];
/** Broader scopes that carry a required one (GitHub's scope hierarchy). */ const SCOPE_CARRIED_BY = {
  "read:org": [
    "write:org",
    "admin:org"
  ]
};
/**
 * Which of {@link FLEET_TOKEN_SCOPES} the token `gh auth status` describes
 * lacks (Issue #2690).
 *
 * A fine-grained PAT (`github_pat_`) or an app token (`ghs_`, `ghu_`) has
 * no scope list — GitHub grants it per-repository permissions instead — so
 * it is never reported as missing every scope. Only the masked prefix `gh`
 * prints is read; the token itself never is.
 */ export function assessFleetTokenScopes(output) {
  if (/Token:\s*(github_pat_|ghs_|ghu_)/.test(output)) {
    return {
      kind: "fine-grained"
    };
  }
  if (!/Token scopes:/i.test(output)) return {
    kind: "unknown"
  };
  const scopes = new Set(parseGhAuthScopes(output).filter((s)=>s.toLowerCase() !== "none"));
  const missing = FLEET_TOKEN_SCOPES.filter((scope)=>!scopes.has(scope) && !(SCOPE_CARRIED_BY[scope] ?? []).some((broader)=>scopes.has(broader)));
  return {
    kind: "scoped",
    missing
  };
}
/**
 * The exact command that adds `missing` to the fleet's token (Issue #2690),
 * pointed at its gh config directory when it has its own.
 */ export function fleetTokenScopeRefreshCommand(missing, ghConfigDir) {
  const command = `gh auth refresh -h github.com -s ${missing.join(",")}`;
  return ghConfigDir ? `GH_CONFIG_DIR="${ghConfigDir}" ${command}` : command;
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
 */ export async function getGhTokenScopes(options) {
  const runCommand = options?.runCommand ?? defaultRunGhAuthStatus;
  try {
    const { code, output } = await runCommand([
      "auth",
      "status"
    ]);
    if (code !== 0) {
      return {
        ok: false,
        error: new Error(`gh auth status failed: ${output}`)
      };
    }
    const scopes = parseGhAuthScopes(output);
    const isAppAuth = scopes.length === 0 && /GitHub App installation/i.test(output);
    return {
      ok: true,
      value: {
        scopes,
        hasWorkflowScope: scopes.includes("workflow"),
        hasRepoScope: scopes.includes("repo"),
        isAppAuth,
        rawOutput: output
      }
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(`Failed to detect gh token scopes: ${msg}`)
    };
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9hdXRoLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogR2l0SHViIENMSSBhdXRoZW50aWNhdGlvbiB2ZXJpZmljYXRpb24gKElzc3VlICM5MDUpLlxuICpcbiAqIERldGVjdHMgZ2ggYXV0aCB0b2tlbiBleHBpcnkgYXQgc3RhcnR1cCBhbmQgZHVyaW5nIHRoZSBzY2FuIGxvb3AsXG4gKiBwcm92aWRpbmcgYWN0aW9uYWJsZSBlcnJvciBtZXNzYWdlcyBpbnN0ZWFkIG9mIGJ1cm5pbmcgcmV0cmllcy5cbiAqXG4gKiBNaWdyYXRlZCBmcm9tIHdvcmtlci9zaGFyZWQvZ2hfYXV0aC5zaCAoSXNzdWUgIzU4NykuXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGF1dGhvcmlzYXRpb24sIGV0Yy4pXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7XG4gIGVuc3VyZVZhbGlkVG9rZW4sXG4gIHR5cGUgRmV0Y2hGbixcbiAgaXNHaXRIdWJBcHBDb25maWd1cmVkLFxufSBmcm9tIFwiLi9naXRodWJfYXBwX2F1dGgudHNcIjtcbmltcG9ydCB7IHNwYXduR2ggfSBmcm9tIFwiLi9naF9zcGF3bi50c1wiO1xuXG4vKipcbiAqIEFVVEhfRVJST1JfUEFUVEVSTlMg4oCUIENhc2UtaW5zZW5zaXRpdmUgcGF0dGVybnMgdGhhdCBpbmRpY2F0ZSBhXG4gKiBHaXRIdWIgQ0xJIGF1dGhlbnRpY2F0aW9uIG9yIGF1dGhvcmlzYXRpb24gZmFpbHVyZS5cbiAqL1xuY29uc3QgQVVUSF9FUlJPUl9QQVRURVJOUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIFwiNDAxXCIsXG4gIFwiYXV0aGVudGljYXRpb25cIixcbiAgXCJhdXRoIHRva2VuXCIsXG4gIFwibm90IGxvZ2dlZCBpblwiLFxuICBcImNyZWRlbnRpYWxcIixcbl07XG5cbi8qKlxuICogUmVzdWx0IG9mIGFuIGF1dGhlbnRpY2F0aW9uIGNoZWNrLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEF1dGhDaGVja1Jlc3VsdCB7XG4gIC8qKiBXaGV0aGVyIGF1dGhlbnRpY2F0aW9uIGlzIHZhbGlkLiAqL1xuICB2YWxpZDogYm9vbGVhbjtcbiAgLyoqIEh1bWFuLXJlYWRhYmxlIHN0YXR1cyBtZXNzYWdlLiAqL1xuICBtZXNzYWdlOiBzdHJpbmc7XG4gIC8qKiBSYXcgb3V0cHV0IGZyb20gYGdoIGF1dGggc3RhdHVzYCwgaWYgYXZhaWxhYmxlLiAqL1xuICByYXdPdXRwdXQ/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogQ2hlY2sgd2hldGhlciBlcnJvciBvdXRwdXQgZnJvbSBhIGdoIENMSSBjYWxsIGluZGljYXRlcyBhblxuICogYXV0aGVudGljYXRpb24gb3IgYXV0aG9yaXNhdGlvbiBmYWlsdXJlLlxuICpcbiAqIE1hdGNoZXMgSFRUUCA0MDEsIFwiYXV0aGVudGljYXRpb25cIiwgXCJhdXRoIHRva2VuXCIsIFwiY3JlZGVudGlhbFwiLCBhbmRcbiAqIFwibm90IGxvZ2dlZCBpblwiIHBhdHRlcm5zIChjYXNlLWluc2Vuc2l0aXZlKS5cbiAqXG4gKiBAcGFyYW0gZXJyb3JPdXRwdXQgLSBUaGUgc3RkZXJyL3N0ZG91dCB0ZXh0IGZyb20gYSBmYWlsZWQgZ2ggY29tbWFuZFxuICogQHJldHVybnMgdHJ1ZSBpZiB0aGUgb3V0cHV0IGxvb2tzIGxpa2UgYW4gYXV0aCBlcnJvclxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNHaEF1dGhFcnJvcihlcnJvck91dHB1dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghZXJyb3JPdXRwdXQpIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBsb3dlciA9IGVycm9yT3V0cHV0LnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBBVVRIX0VSUk9SX1BBVFRFUk5TLnNvbWUoKHBhdHRlcm4pID0+IGxvd2VyLmluY2x1ZGVzKHBhdHRlcm4pKTtcbn1cblxuLyoqXG4gKiBSZXR1cm4gYSBodW1hbi1yZWFkYWJsZSBtZXNzYWdlIHRlbGxpbmcgdGhlIG9wZXJhdG9yIGhvdyB0byBmaXggYW5cbiAqIGV4cGlyZWQgZ2ggYXV0aCB0b2tlbi5cbiAqXG4gKiBXaGVuIGdoQ29uZmlnRGlyIGlzIHNldCAoc2VydmljZSBhY2NvdW50KSwgdGhlIG1lc3NhZ2UgaW5jbHVkZXMgdGhlXG4gKiBlbnZpcm9ubWVudCB2YXJpYWJsZSBzbyB0aGUgb3BlcmF0b3IgY2FuIGNvcHktcGFzdGUgdGhlIGZpeCBjb21tYW5kLlxuICpcbiAqIEBwYXJhbSBnaENvbmZpZ0RpciAtIE9wdGlvbmFsIEdIX0NPTkZJR19ESVIgdmFsdWVcbiAqIEByZXR1cm5zIEFjdGlvbmFibGUgZXJyb3IgbWVzc2FnZVxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2hBdXRoQWN0aW9uYWJsZU1lc3NhZ2UoZ2hDb25maWdEaXI/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoZ2hDb25maWdEaXIpIHtcbiAgICByZXR1cm4gYGdoIGF1dGggZXhwaXJlZCBpbiBHSF9DT05GSUdfRElSPSR7Z2hDb25maWdEaXJ9IOKAlCBydW46IEdIX0NPTkZJR19ESVI9JHtnaENvbmZpZ0Rpcn0gZ2ggYXV0aCByZWZyZXNoYDtcbiAgfVxuICByZXR1cm4gXCJnaCBhdXRoIGV4cGlyZWQg4oCUIHJ1bjogZ2ggYXV0aCByZWZyZXNoXCI7XG59XG5cbi8qKlxuICogVmVyaWZ5IHRoYXQgZ2ggQ0xJIGF1dGhlbnRpY2F0aW9uIGlzIHZhbGlkLlxuICpcbiAqIElzc3VlICM5NTk6IFdoZW4gR2l0SHViIEFwcCBpcyBjb25maWd1cmVkLCB2YWxpZGF0ZXMgYnkgY2FsbGluZ1xuICogZW5zdXJlVmFsaWRUb2tlbigpIGluc3RlYWQgb2YgYGdoIGF1dGggc3RhdHVzYC4gRmFsbHMgYmFjayB0b1xuICogT0F1dGgtYmFzZWQgYGdoIGF1dGggc3RhdHVzYCB3aGVuIEFwcCBjb25maWcgaXMgYWJzZW50LlxuICpcbiAqIEhvbm91cnMgVklCRV9TS0lQX0FVVEhfQ0hFQ0sgZm9yIENJL3Rlc3RpbmcgZW52aXJvbm1lbnRzLlxuICpcbiAqIEBwYXJhbSBvcHRpb25zIC0gT3B0aW9uYWwgb3ZlcnJpZGVzIGZvciB0ZXN0aW5nXG4gKiBAcmV0dXJucyBSZXN1bHQgd2l0aCBhdXRoIGNoZWNrIGRldGFpbHNcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNoZWNrR2hBdXRoKG9wdGlvbnM/OiB7XG4gIHNraXBBdXRoQ2hlY2s/OiBib29sZWFuO1xuICBnaENvbmZpZ0Rpcj86IHN0cmluZztcbiAgLyoqIEdpdEh1YiBBcHAgSUQgKGZhbGxzIGJhY2sgdG8gR0lUSFVCX0FQUF9JRCBlbnYgdmFyKS4gKi9cbiAgZ2l0aHViQXBwSWQ/OiBzdHJpbmc7XG4gIC8qKiBHaXRIdWIgQXBwIGluc3RhbGxhdGlvbiBJRCAoZmFsbHMgYmFjayB0byBHSVRIVUJfQVBQX0lOU1RBTExBVElPTl9JRCBlbnYgdmFyKS4gKi9cbiAgZ2l0aHViQXBwSW5zdGFsbGF0aW9uSWQ/OiBzdHJpbmc7XG4gIC8qKiBQYXRoIHRvIEdpdEh1YiBBcHAgcHJpdmF0ZSBrZXkgKGZhbGxzIGJhY2sgdG8gR0lUSFVCX0FQUF9QUklWQVRFX0tFWV9QQVRIIGVudiB2YXIpLiAqL1xuICBnaXRodWJBcHBQcml2YXRlS2V5UGF0aD86IHN0cmluZztcbiAgLyoqIE92ZXJyaWRlIGNvbW1hbmQgcnVubmVyIGZvciB0ZXN0aW5nIChhdm9pZHMgcmVhbCBgZ2hgIGNhbGxzKS4gKi9cbiAgcnVuQ29tbWFuZD86IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTx7IGNvZGU6IG51bWJlcjsgb3V0cHV0OiBzdHJpbmcgfT47XG4gIC8qKiBPdmVycmlkZSBmZXRjaCBmb3IgdGVzdGluZyBHaXRIdWIgQXBwIHRva2VuIGV4Y2hhbmdlLiAqL1xuICBmZXRjaEZuPzogRmV0Y2hGbjtcbn0pOiBQcm9taXNlPFJlc3VsdDxBdXRoQ2hlY2tSZXN1bHQ+PiB7XG4gIC8vIEFsbG93IENJL3Rlc3RpbmcgdG8gYnlwYXNzXG4gIGlmIChvcHRpb25zPy5za2lwQXV0aENoZWNrKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IHsgdmFsaWQ6IHRydWUsIG1lc3NhZ2U6IFwiQXV0aCBjaGVjayBza2lwcGVkXCIgfSxcbiAgICB9O1xuICB9XG5cbiAgLy8gSXNzdWUgIzk1OTogQ2hlY2sgaWYgR2l0SHViIEFwcCBpcyBjb25maWd1cmVkXG4gIGNvbnN0IGFwcElkID0gb3B0aW9ucz8uZ2l0aHViQXBwSWQgPz8gRGVuby5lbnYuZ2V0KFwiR0lUSFVCX0FQUF9JRFwiKTtcbiAgY29uc3QgaW5zdGFsbGF0aW9uSWQgPSBvcHRpb25zPy5naXRodWJBcHBJbnN0YWxsYXRpb25JZCA/P1xuICAgIERlbm8uZW52LmdldChcIkdJVEhVQl9BUFBfSU5TVEFMTEFUSU9OX0lEXCIpO1xuICBjb25zdCBwcml2YXRlS2V5UGF0aCA9IG9wdGlvbnM/LmdpdGh1YkFwcFByaXZhdGVLZXlQYXRoID8/XG4gICAgRGVuby5lbnYuZ2V0KFwiR0lUSFVCX0FQUF9QUklWQVRFX0tFWV9QQVRIXCIpO1xuXG4gIGNvbnN0IGFwcENvbmZpZyA9IHsgYXBwSWQsIGluc3RhbGxhdGlvbklkLCBwcml2YXRlS2V5UGF0aCB9O1xuICBpZiAoaXNHaXRIdWJBcHBDb25maWd1cmVkKGFwcENvbmZpZykpIHtcbiAgICByZXR1cm4gYXdhaXQgY2hlY2tHaEF1dGhWaWFBcHAoXG4gICAgICBhcHBDb25maWcuYXBwSWQsXG4gICAgICBhcHBDb25maWcuaW5zdGFsbGF0aW9uSWQsXG4gICAgICBhcHBDb25maWcucHJpdmF0ZUtleVBhdGgsXG4gICAgICBvcHRpb25zPy5mZXRjaEZuLFxuICAgICk7XG4gIH1cblxuICAvLyBGYWxsIGJhY2sgdG8gT0F1dGgtYmFzZWQgYGdoIGF1dGggc3RhdHVzYFxuICBjb25zdCBydW5Db21tYW5kID0gb3B0aW9ucz8ucnVuQ29tbWFuZCA/PyBkZWZhdWx0UnVuR2hBdXRoU3RhdHVzO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgeyBjb2RlLCBvdXRwdXQgfSA9IGF3YWl0IHJ1bkNvbW1hbmQoW1wiYXV0aFwiLCBcInN0YXR1c1wiXSk7XG5cbiAgICBpZiAoY29kZSAhPT0gMCkge1xuICAgICAgY29uc3QgYWN0aW9uYWJsZSA9IGdoQXV0aEFjdGlvbmFibGVNZXNzYWdlKG9wdGlvbnM/LmdoQ29uZmlnRGlyKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICB2YWx1ZToge1xuICAgICAgICAgIHZhbGlkOiBmYWxzZSxcbiAgICAgICAgICBtZXNzYWdlOiBhY3Rpb25hYmxlLFxuICAgICAgICAgIHJhd091dHB1dDogb3V0cHV0LFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZTogeyB2YWxpZDogdHJ1ZSwgbWVzc2FnZTogXCJnaCBhdXRoIGlzIHZhbGlkXCIsIHJhd091dHB1dDogb3V0cHV0IH0sXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICBjb25zdCBtc2cgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoYEZhaWxlZCB0byBydW4gZ2ggYXV0aCBzdGF0dXM6ICR7bXNnfWApLFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBhdXRoZW50aWNhdGlvbiB2aWEgR2l0SHViIEFwcCB0b2tlbiBnZW5lcmF0aW9uLlxuICpcbiAqIElzc3VlICM5NTk6IFZhbGlkYXRlcyBieSBnZW5lcmF0aW5nIGEgZnJlc2ggaW5zdGFsbGF0aW9uIHRva2VuLlxuICogSWYgdG9rZW4gZ2VuZXJhdGlvbiBzdWNjZWVkcywgYXV0aCBpcyB2YWxpZC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY2hlY2tHaEF1dGhWaWFBcHAoXG4gIGFwcElkOiBzdHJpbmcsXG4gIGluc3RhbGxhdGlvbklkOiBzdHJpbmcsXG4gIHByaXZhdGVLZXlQYXRoOiBzdHJpbmcsXG4gIGZldGNoRm4/OiBGZXRjaEZuLFxuKTogUHJvbWlzZTxSZXN1bHQ8QXV0aENoZWNrUmVzdWx0Pj4ge1xuICB0cnkge1xuICAgIGF3YWl0IGVuc3VyZVZhbGlkVG9rZW4oYXBwSWQsIGluc3RhbGxhdGlvbklkLCBwcml2YXRlS2V5UGF0aCwgZmV0Y2hGbik7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IHtcbiAgICAgICAgdmFsaWQ6IHRydWUsXG4gICAgICAgIG1lc3NhZ2U6IFwiR2l0SHViIEFwcCBhdXRoZW50aWNhdGlvbiBpcyB2YWxpZFwiLFxuICAgICAgfSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIGNvbnN0IG1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZToge1xuICAgICAgICB2YWxpZDogZmFsc2UsXG4gICAgICAgIG1lc3NhZ2U6IGBHaXRIdWIgQXBwIGF1dGggZmFpbGVkOiAke21zZ31gLFxuICAgICAgfSxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogRGVmYXVsdCBpbXBsZW1lbnRhdGlvbiB0aGF0IHJ1bnMgYGdoIGF1dGggc3RhdHVzYC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZGVmYXVsdFJ1bkdoQXV0aFN0YXR1cyhcbiAgYXJnczogc3RyaW5nW10sXG4pOiBQcm9taXNlPHsgY29kZTogbnVtYmVyOyBvdXRwdXQ6IHN0cmluZyB9PiB7XG4gIGNvbnN0IHsgY29kZSwgc3Rkb3V0LCBzdGRlcnIgfSA9IGF3YWl0IHNwYXduR2goYXJncyk7XG4gIHJldHVybiB7IGNvZGUsIG91dHB1dDogYCR7c3Rkb3V0fVxcbiR7c3RkZXJyfWAudHJpbSgpIH07XG59XG5cbi8qKlxuICogUGFyc2UgdGhlIE9BdXRoIHNjb3BlIGxpc3QgZnJvbSBgZ2ggYXV0aCBzdGF0dXNgIG91dHB1dC5cbiAqXG4gKiBgZ2ggYXV0aCBzdGF0dXNgIGVtaXRzIGEgbGluZSBsaWtlOlxuICogICBgICAtIFRva2VuIHNjb3BlczogJ2FkbWluOnB1YmxpY19rZXknLCAnZ2lzdCcsICdyZXBvJywgJ3dvcmtmbG93J2BcbiAqXG4gKiBXaGVuIHRoZSB1c2VyIGlzIGxvZ2dlZCBpbnRvIG11bHRpcGxlIGFjY291bnRzIHRoZSBvdXRwdXQgY29udGFpbnMgb25lXG4gKiBzY29wZXMgbGluZSBwZXIgYWNjb3VudDsgdGhlIGFjdGl2ZSBhY2NvdW50IChgQWN0aXZlIGFjY291bnQ6IHRydWVgKSBpc1xuICogcHJlZmVycmVkLiBJZiBubyBhY3RpdmUgbWFya2VyIGlzIGZvdW5kLCB0aGUgZmlyc3Qgc2NvcGVzIGxpbmUgd2lucy5cbiAqXG4gKiBSZXR1cm5zIGFuIGVtcHR5IGFycmF5IHdoZW4gbm8gYFRva2VuIHNjb3BlczpgIGxpbmUgaXMgcHJlc2VudCAoZS5nLlxuICogR2l0SHViIEFwcCBpbnN0YWxsYXRpb24gYXV0aCwgd2hlcmUgT0F1dGggc2NvcGVzIGRvbid0IGFwcGx5KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlR2hBdXRoU2NvcGVzKG91dHB1dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBpZiAoIW91dHB1dCkgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IGxpbmVzID0gb3V0cHV0LnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCBzY29wZUxpbmVSZWdleCA9IC9eXFxzKi1cXHMqVG9rZW4gc2NvcGVzOlxccyooLispJC9pO1xuXG4gIGxldCBhY3RpdmVTY29wZXM6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgZmlyc3RTY29wZXM6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgY3VycmVudEJsb2NrSXNBY3RpdmUgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICBpZiAoL15cXHMq4pyTXFxzKkxvZ2dlZCBpbi9pLnRlc3QobGluZSkgfHwgL15naXRodWJcXC5jb21cXHMqJC9pLnRlc3QobGluZSkpIHtcbiAgICAgIGN1cnJlbnRCbG9ja0lzQWN0aXZlID0gZmFsc2U7XG4gICAgfVxuICAgIGlmICgvQWN0aXZlIGFjY291bnQ6XFxzKnRydWUvaS50ZXN0KGxpbmUpKSB7XG4gICAgICBjdXJyZW50QmxvY2tJc0FjdGl2ZSA9IHRydWU7XG4gICAgfVxuICAgIGNvbnN0IG1hdGNoID0gbGluZS5tYXRjaChzY29wZUxpbmVSZWdleCk7XG4gICAgY29uc3QgY2FwdHVyZWQgPSBtYXRjaD8uWzFdO1xuICAgIGlmIChjYXB0dXJlZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCByYXcgPSBjYXB0dXJlZC50cmltKCk7XG4gICAgICBpZiAoZmlyc3RTY29wZXMgPT09IG51bGwpIGZpcnN0U2NvcGVzID0gcmF3O1xuICAgICAgaWYgKGN1cnJlbnRCbG9ja0lzQWN0aXZlICYmIGFjdGl2ZVNjb3BlcyA9PT0gbnVsbCkgYWN0aXZlU2NvcGVzID0gcmF3O1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGNob3NlbiA9IGFjdGl2ZVNjb3BlcyA/PyBmaXJzdFNjb3BlcztcbiAgaWYgKGNob3NlbiA9PT0gbnVsbCkgcmV0dXJuIFtdO1xuXG4gIHJldHVybiBjaG9zZW5cbiAgICAuc3BsaXQoXCIsXCIpXG4gICAgLm1hcCgocykgPT4gcy50cmltKCkucmVwbGFjZSgvXlsnXCJdfFsnXCJdJC9nLCBcIlwiKSlcbiAgICAuZmlsdGVyKChzKSA9PiBzLmxlbmd0aCA+IDApO1xufVxuXG4vKipcbiAqIFRva2VuIHNjb3BlIGluZm9ybWF0aW9uIGZvciB0aGUgYWN0aXZlIGdoIGF1dGggYWNjb3VudC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBHaFRva2VuU2NvcGVzIHtcbiAgLyoqIE9BdXRoIHNjb3BlcyBncmFudGVkIHRvIHRoZSB0b2tlbiAoZW1wdHkgZm9yIEdpdEh1YiBBcHAgYXV0aCkuICovXG4gIHNjb3Blczogc3RyaW5nW107XG4gIC8qKiBDb252ZW5pZW5jZSBmbGFnIOKAlCB0cnVlIGlmIGB3b3JrZmxvd2Agc2NvcGUgaXMgcHJlc2VudC4gKi9cbiAgaGFzV29ya2Zsb3dTY29wZTogYm9vbGVhbjtcbiAgLyoqIENvbnZlbmllbmNlIGZsYWcg4oCUIHRydWUgaWYgYHJlcG9gIHNjb3BlIGlzIHByZXNlbnQuICovXG4gIGhhc1JlcG9TY29wZTogYm9vbGVhbjtcbiAgLyoqIFRydWUgd2hlbiB0aGUgdG9rZW4gYXBwZWFycyB0byBiZSBhIEdpdEh1YiBBcHAgaW5zdGFsbGF0aW9uIHRva2VuLiAqL1xuICBpc0FwcEF1dGg6IGJvb2xlYW47XG4gIC8qKiBSYXcgYGdoIGF1dGggc3RhdHVzYCBvdXRwdXQgKHVzZWZ1bCBmb3IgZGlhZ25vc3RpY3MgaW4gbG9ncykuICovXG4gIHJhd091dHB1dDogc3RyaW5nO1xufVxuXG4vKipcbiAqIFRoZSBPQXV0aCBzY29wZXMgdGhlIGZsZWV0J3MgdG9rZW4gbmVlZHMgKElzc3VlICMyNjkwKTogYHJlcG9gIHRvIGNsb25lLFxuICogcHVzaCBhbmQgb3BlbiBQUnMsIGB3b3JrZmxvd2AgdG8gcHVzaCBgLmdpdGh1Yi93b3JrZmxvd3MvYCBjaGFuZ2VzLCBhbmRcbiAqIGByZWFkOm9yZ2AgZm9yIHRlYW0gYW5kIG9yZ2FuaXNhdGlvbiByZWFkcy5cbiAqL1xuZXhwb3J0IGNvbnN0IEZMRUVUX1RPS0VOX1NDT1BFUyA9IFtcInJlcG9cIiwgXCJ3b3JrZmxvd1wiLCBcInJlYWQ6b3JnXCJdIGFzIGNvbnN0O1xuXG4vKiogQnJvYWRlciBzY29wZXMgdGhhdCBjYXJyeSBhIHJlcXVpcmVkIG9uZSAoR2l0SHViJ3Mgc2NvcGUgaGllcmFyY2h5KS4gKi9cbmNvbnN0IFNDT1BFX0NBUlJJRURfQlk6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IHN0cmluZ1tdPj4gPSB7XG4gIFwicmVhZDpvcmdcIjogW1wid3JpdGU6b3JnXCIsIFwiYWRtaW46b3JnXCJdLFxufTtcblxuLyoqIFdoYXQge0BsaW5rIGFzc2Vzc0ZsZWV0VG9rZW5TY29wZXN9IGZvdW5kLiAqL1xuZXhwb3J0IHR5cGUgRmxlZXRUb2tlblNjb3BlQXNzZXNzbWVudCA9XG4gIC8qKiBBIGNsYXNzaWMgb3IgT0F1dGggdG9rZW4sIHdpdGggdGhlIHJlcXVpcmVkIHNjb3BlcyBpdCBsYWNrcy4gKi9cbiAgfCB7IGtpbmQ6IFwic2NvcGVkXCI7IG1pc3Npbmc6IHN0cmluZ1tdIH1cbiAgLyoqIEEgZmluZS1ncmFpbmVkIFBBVCBvciBHaXRIdWIgQXBwIHRva2VuOiBwZXJtaXNzaW9ucywgbm90IHNjb3Blcy4gKi9cbiAgfCB7IGtpbmQ6IFwiZmluZS1ncmFpbmVkXCIgfVxuICAvKiogTm8gc2NvcGUgbGluZSBhdCBhbGwgKGFuIG9sZGVyIGdoKTogbm90aGluZyBjYW4gYmUgc2FpZC4gKi9cbiAgfCB7IGtpbmQ6IFwidW5rbm93blwiIH07XG5cbi8qKlxuICogV2hpY2ggb2Yge0BsaW5rIEZMRUVUX1RPS0VOX1NDT1BFU30gdGhlIHRva2VuIGBnaCBhdXRoIHN0YXR1c2AgZGVzY3JpYmVzXG4gKiBsYWNrcyAoSXNzdWUgIzI2OTApLlxuICpcbiAqIEEgZmluZS1ncmFpbmVkIFBBVCAoYGdpdGh1Yl9wYXRfYCkgb3IgYW4gYXBwIHRva2VuIChgZ2hzX2AsIGBnaHVfYCkgaGFzXG4gKiBubyBzY29wZSBsaXN0IOKAlCBHaXRIdWIgZ3JhbnRzIGl0IHBlci1yZXBvc2l0b3J5IHBlcm1pc3Npb25zIGluc3RlYWQg4oCUIHNvXG4gKiBpdCBpcyBuZXZlciByZXBvcnRlZCBhcyBtaXNzaW5nIGV2ZXJ5IHNjb3BlLiBPbmx5IHRoZSBtYXNrZWQgcHJlZml4IGBnaGBcbiAqIHByaW50cyBpcyByZWFkOyB0aGUgdG9rZW4gaXRzZWxmIG5ldmVyIGlzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXNzRmxlZXRUb2tlblNjb3BlcyhcbiAgb3V0cHV0OiBzdHJpbmcsXG4pOiBGbGVldFRva2VuU2NvcGVBc3Nlc3NtZW50IHtcbiAgaWYgKC9Ub2tlbjpcXHMqKGdpdGh1Yl9wYXRffGdoc198Z2h1XykvLnRlc3Qob3V0cHV0KSkge1xuICAgIHJldHVybiB7IGtpbmQ6IFwiZmluZS1ncmFpbmVkXCIgfTtcbiAgfVxuICBpZiAoIS9Ub2tlbiBzY29wZXM6L2kudGVzdChvdXRwdXQpKSByZXR1cm4geyBraW5kOiBcInVua25vd25cIiB9O1xuICBjb25zdCBzY29wZXMgPSBuZXcgU2V0KFxuICAgIHBhcnNlR2hBdXRoU2NvcGVzKG91dHB1dCkuZmlsdGVyKChzKSA9PiBzLnRvTG93ZXJDYXNlKCkgIT09IFwibm9uZVwiKSxcbiAgKTtcbiAgY29uc3QgbWlzc2luZyA9IEZMRUVUX1RPS0VOX1NDT1BFUy5maWx0ZXIoKHNjb3BlKSA9PlxuICAgICFzY29wZXMuaGFzKHNjb3BlKSAmJlxuICAgICEoU0NPUEVfQ0FSUklFRF9CWVtzY29wZV0gPz8gW10pLnNvbWUoKGJyb2FkZXIpID0+IHNjb3Blcy5oYXMoYnJvYWRlcikpXG4gICk7XG4gIHJldHVybiB7IGtpbmQ6IFwic2NvcGVkXCIsIG1pc3NpbmcgfTtcbn1cblxuLyoqXG4gKiBUaGUgZXhhY3QgY29tbWFuZCB0aGF0IGFkZHMgYG1pc3NpbmdgIHRvIHRoZSBmbGVldCdzIHRva2VuIChJc3N1ZSAjMjY5MCksXG4gKiBwb2ludGVkIGF0IGl0cyBnaCBjb25maWcgZGlyZWN0b3J5IHdoZW4gaXQgaGFzIGl0cyBvd24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmbGVldFRva2VuU2NvcGVSZWZyZXNoQ29tbWFuZChcbiAgbWlzc2luZzogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGdoQ29uZmlnRGlyPzogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgY29tbWFuZCA9IGBnaCBhdXRoIHJlZnJlc2ggLWggZ2l0aHViLmNvbSAtcyAke21pc3Npbmcuam9pbihcIixcIil9YDtcbiAgcmV0dXJuIGdoQ29uZmlnRGlyID8gYEdIX0NPTkZJR19ESVI9XCIke2doQ29uZmlnRGlyfVwiICR7Y29tbWFuZH1gIDogY29tbWFuZDtcbn1cblxuLyoqXG4gKiBEZXRlY3QgdGhlIE9BdXRoIHNjb3BlcyBhdHRhY2hlZCB0byB0aGUgYWN0aXZlIGdoIENMSSB0b2tlbi5cbiAqXG4gKiBDYWxsZWQgZnJvbSBgcnVuX2NvcmUuc2hgIGF0IHN0YXJ0dXAgc28gdGhlIG9wZXJhdG9yIGNhbiBzZWUgaW4gdGhlIGxvZ1xuICogZXhhY3RseSB3aGljaCBzY29wZXMgdGhlIHdvcmtlciBoYXMg4oCUIGhpc3RvcmljYWxseSB0aGUgd29ya2VyIGhhcyBtYWRlXG4gKiBmYWxzZSBjbGFpbXMgYWJvdXQgbGFja2luZyBgd29ya2Zsb3dgIHNjb3BlIGJhc2VkIG9uIHN0YWxlIHByb21wdCB0ZXh0LFxuICogbGVhZGluZyB0byBpbmNvcnJlY3QgYG5lZWRzLWh1bWFuYCBlc2NhbGF0aW9ucyBvbiB3b3JrZmxvdy1maWxlIGNoYW5nZXMuXG4gKlxuICogUmV0dXJucyBgb2s6IGZhbHNlYCB3aGVuIHRoZSB1bmRlcmx5aW5nIGBnaCBhdXRoIHN0YXR1c2AgY2FsbCBmYWlscyAodGhlXG4gKiBjYWxsZXIgd2lsbCBhbHJlYWR5IGhhdmUgbG9nZ2VkIGFuIGF1dGggZXJyb3IgdmlhIGBjaGVja0doQXV0aGApLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0R2hUb2tlblNjb3BlcyhvcHRpb25zPzoge1xuICBydW5Db21tYW5kPzogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHsgY29kZTogbnVtYmVyOyBvdXRwdXQ6IHN0cmluZyB9Pjtcbn0pOiBQcm9taXNlPFJlc3VsdDxHaFRva2VuU2NvcGVzPj4ge1xuICBjb25zdCBydW5Db21tYW5kID0gb3B0aW9ucz8ucnVuQ29tbWFuZCA/PyBkZWZhdWx0UnVuR2hBdXRoU3RhdHVzO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgeyBjb2RlLCBvdXRwdXQgfSA9IGF3YWl0IHJ1bkNvbW1hbmQoW1wiYXV0aFwiLCBcInN0YXR1c1wiXSk7XG4gICAgaWYgKGNvZGUgIT09IDApIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihgZ2ggYXV0aCBzdGF0dXMgZmFpbGVkOiAke291dHB1dH1gKSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3Qgc2NvcGVzID0gcGFyc2VHaEF1dGhTY29wZXMob3V0cHV0KTtcbiAgICBjb25zdCBpc0FwcEF1dGggPSBzY29wZXMubGVuZ3RoID09PSAwICYmXG4gICAgICAvR2l0SHViIEFwcCBpbnN0YWxsYXRpb24vaS50ZXN0KG91dHB1dCk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZToge1xuICAgICAgICBzY29wZXMsXG4gICAgICAgIGhhc1dvcmtmbG93U2NvcGU6IHNjb3Blcy5pbmNsdWRlcyhcIndvcmtmbG93XCIpLFxuICAgICAgICBoYXNSZXBvU2NvcGU6IHNjb3Blcy5pbmNsdWRlcyhcInJlcG9cIiksXG4gICAgICAgIGlzQXBwQXV0aCxcbiAgICAgICAgcmF3T3V0cHV0OiBvdXRwdXQsXG4gICAgICB9LFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgY29uc3QgbXNnID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKGBGYWlsZWQgdG8gZGV0ZWN0IGdoIHRva2VuIHNjb3BlczogJHttc2d9YCksXG4gICAgfTtcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7OztDQVFDLEdBR0QsU0FDRSxnQkFBZ0IsRUFFaEIscUJBQXFCLFFBQ2hCLHVCQUF1QjtBQUM5QixTQUFTLE9BQU8sUUFBUSxnQkFBZ0I7QUFFeEM7OztDQUdDLEdBQ0QsTUFBTSxzQkFBeUM7RUFDN0M7RUFDQTtFQUNBO0VBQ0E7RUFDQTtDQUNEO0FBY0Q7Ozs7Ozs7OztDQVNDLEdBQ0QsT0FBTyxTQUFTLGNBQWMsV0FBbUI7RUFDL0MsSUFBSSxDQUFDLGFBQWEsT0FBTztFQUV6QixNQUFNLFFBQVEsWUFBWSxXQUFXO0VBQ3JDLE9BQU8sb0JBQW9CLElBQUksQ0FBQyxDQUFDLFVBQVksTUFBTSxRQUFRLENBQUM7QUFDOUQ7QUFFQTs7Ozs7Ozs7O0NBU0MsR0FDRCxPQUFPLFNBQVMsd0JBQXdCLFdBQW9CO0VBQzFELElBQUksYUFBYTtJQUNmLE9BQU8sQ0FBQyxpQ0FBaUMsRUFBRSxZQUFZLHNCQUFzQixFQUFFLFlBQVksZ0JBQWdCLENBQUM7RUFDOUc7RUFDQSxPQUFPO0FBQ1Q7QUFFQTs7Ozs7Ozs7Ozs7Q0FXQyxHQUNELE9BQU8sZUFBZSxZQUFZLE9BYWpDO0VBQ0MsNkJBQTZCO0VBQzdCLElBQUksU0FBUyxlQUFlO0lBQzFCLE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTztRQUFFLE9BQU87UUFBTSxTQUFTO01BQXFCO0lBQ3REO0VBQ0Y7RUFFQSxnREFBZ0Q7RUFDaEQsTUFBTSxRQUFRLFNBQVMsZUFBZSxLQUFLLEdBQUcsQ0FBQyxHQUFHLENBQUM7RUFDbkQsTUFBTSxpQkFBaUIsU0FBUywyQkFDOUIsS0FBSyxHQUFHLENBQUMsR0FBRyxDQUFDO0VBQ2YsTUFBTSxpQkFBaUIsU0FBUywyQkFDOUIsS0FBSyxHQUFHLENBQUMsR0FBRyxDQUFDO0VBRWYsTUFBTSxZQUFZO0lBQUU7SUFBTztJQUFnQjtFQUFlO0VBQzFELElBQUksc0JBQXNCLFlBQVk7SUFDcEMsT0FBTyxNQUFNLGtCQUNYLFVBQVUsS0FBSyxFQUNmLFVBQVUsY0FBYyxFQUN4QixVQUFVLGNBQWMsRUFDeEIsU0FBUztFQUViO0VBRUEsNENBQTRDO0VBQzVDLE1BQU0sYUFBYSxTQUFTLGNBQWM7RUFFMUMsSUFBSTtJQUNGLE1BQU0sRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLEdBQUcsTUFBTSxXQUFXO01BQUM7TUFBUTtLQUFTO0lBRTVELElBQUksU0FBUyxHQUFHO01BQ2QsTUFBTSxhQUFhLHdCQUF3QixTQUFTO01BQ3BELE9BQU87UUFDTCxJQUFJO1FBQ0osT0FBTztVQUNMLE9BQU87VUFDUCxTQUFTO1VBQ1QsV0FBVztRQUNiO01BQ0Y7SUFDRjtJQUVBLE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTztRQUFFLE9BQU87UUFBTSxTQUFTO1FBQW9CLFdBQVc7TUFBTztJQUN2RTtFQUNGLEVBQUUsT0FBTyxPQUFnQjtJQUN2QixNQUFNLE1BQU0saUJBQWlCLFFBQVEsTUFBTSxPQUFPLEdBQUcsT0FBTztJQUM1RCxPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sSUFBSSxNQUFNLENBQUMsOEJBQThCLEVBQUUsS0FBSztJQUN6RDtFQUNGO0FBQ0Y7QUFFQTs7Ozs7Q0FLQyxHQUNELGVBQWUsa0JBQ2IsS0FBYSxFQUNiLGNBQXNCLEVBQ3RCLGNBQXNCLEVBQ3RCLE9BQWlCO0VBRWpCLElBQUk7SUFDRixNQUFNLGlCQUFpQixPQUFPLGdCQUFnQixnQkFBZ0I7SUFDOUQsT0FBTztNQUNMLElBQUk7TUFDSixPQUFPO1FBQ0wsT0FBTztRQUNQLFNBQVM7TUFDWDtJQUNGO0VBQ0YsRUFBRSxPQUFPLE9BQWdCO0lBQ3ZCLE1BQU0sTUFBTSxpQkFBaUIsUUFBUSxNQUFNLE9BQU8sR0FBRyxPQUFPO0lBQzVELE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTztRQUNMLE9BQU87UUFDUCxTQUFTLENBQUMsd0JBQXdCLEVBQUUsS0FBSztNQUMzQztJQUNGO0VBQ0Y7QUFDRjtBQUVBOztDQUVDLEdBQ0QsZUFBZSx1QkFDYixJQUFjO0VBRWQsTUFBTSxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLEdBQUcsTUFBTSxRQUFRO0VBQy9DLE9BQU87SUFBRTtJQUFNLFFBQVEsR0FBRyxPQUFPLEVBQUUsRUFBRSxRQUFRLENBQUMsSUFBSTtFQUFHO0FBQ3ZEO0FBRUE7Ozs7Ozs7Ozs7OztDQVlDLEdBQ0QsT0FBTyxTQUFTLGtCQUFrQixNQUFjO0VBQzlDLElBQUksQ0FBQyxRQUFRLE9BQU8sRUFBRTtFQUV0QixNQUFNLFFBQVEsT0FBTyxLQUFLLENBQUM7RUFDM0IsTUFBTSxpQkFBaUI7RUFFdkIsSUFBSSxlQUE4QjtFQUNsQyxJQUFJLGNBQTZCO0VBQ2pDLElBQUksdUJBQXVCO0VBRTNCLEtBQUssTUFBTSxRQUFRLE1BQU87SUFDeEIsSUFBSSxxQkFBcUIsSUFBSSxDQUFDLFNBQVMsb0JBQW9CLElBQUksQ0FBQyxPQUFPO01BQ3JFLHVCQUF1QjtJQUN6QjtJQUNBLElBQUksMEJBQTBCLElBQUksQ0FBQyxPQUFPO01BQ3hDLHVCQUF1QjtJQUN6QjtJQUNBLE1BQU0sUUFBUSxLQUFLLEtBQUssQ0FBQztJQUN6QixNQUFNLFdBQVcsT0FBTyxDQUFDLEVBQUU7SUFDM0IsSUFBSSxhQUFhLFdBQVc7TUFDMUIsTUFBTSxNQUFNLFNBQVMsSUFBSTtNQUN6QixJQUFJLGdCQUFnQixNQUFNLGNBQWM7TUFDeEMsSUFBSSx3QkFBd0IsaUJBQWlCLE1BQU0sZUFBZTtJQUNwRTtFQUNGO0VBRUEsTUFBTSxTQUFTLGdCQUFnQjtFQUMvQixJQUFJLFdBQVcsTUFBTSxPQUFPLEVBQUU7RUFFOUIsT0FBTyxPQUNKLEtBQUssQ0FBQyxLQUNOLEdBQUcsQ0FBQyxDQUFDLElBQU0sRUFBRSxJQUFJLEdBQUcsT0FBTyxDQUFDLGdCQUFnQixLQUM1QyxNQUFNLENBQUMsQ0FBQyxJQUFNLEVBQUUsTUFBTSxHQUFHO0FBQzlCO0FBa0JBOzs7O0NBSUMsR0FDRCxPQUFPLE1BQU0scUJBQXFCO0VBQUM7RUFBUTtFQUFZO0NBQVcsQ0FBVTtBQUU1RSx5RUFBeUUsR0FDekUsTUFBTSxtQkFBZ0U7RUFDcEUsWUFBWTtJQUFDO0lBQWE7R0FBWTtBQUN4QztBQVdBOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxTQUFTLHVCQUNkLE1BQWM7RUFFZCxJQUFJLG1DQUFtQyxJQUFJLENBQUMsU0FBUztJQUNuRCxPQUFPO01BQUUsTUFBTTtJQUFlO0VBQ2hDO0VBQ0EsSUFBSSxDQUFDLGlCQUFpQixJQUFJLENBQUMsU0FBUyxPQUFPO0lBQUUsTUFBTTtFQUFVO0VBQzdELE1BQU0sU0FBUyxJQUFJLElBQ2pCLGtCQUFrQixRQUFRLE1BQU0sQ0FBQyxDQUFDLElBQU0sRUFBRSxXQUFXLE9BQU87RUFFOUQsTUFBTSxVQUFVLG1CQUFtQixNQUFNLENBQUMsQ0FBQyxRQUN6QyxDQUFDLE9BQU8sR0FBRyxDQUFDLFVBQ1osQ0FBQyxDQUFDLGdCQUFnQixDQUFDLE1BQU0sSUFBSSxFQUFFLEVBQUUsSUFBSSxDQUFDLENBQUMsVUFBWSxPQUFPLEdBQUcsQ0FBQztFQUVoRSxPQUFPO0lBQUUsTUFBTTtJQUFVO0VBQVE7QUFDbkM7QUFFQTs7O0NBR0MsR0FDRCxPQUFPLFNBQVMsOEJBQ2QsT0FBMEIsRUFDMUIsV0FBb0I7RUFFcEIsTUFBTSxVQUFVLENBQUMsaUNBQWlDLEVBQUUsUUFBUSxJQUFJLENBQUMsTUFBTTtFQUN2RSxPQUFPLGNBQWMsQ0FBQyxlQUFlLEVBQUUsWUFBWSxFQUFFLEVBQUUsU0FBUyxHQUFHO0FBQ3JFO0FBRUE7Ozs7Ozs7Ozs7Q0FVQyxHQUNELE9BQU8sZUFBZSxpQkFBaUIsT0FFdEM7RUFDQyxNQUFNLGFBQWEsU0FBUyxjQUFjO0VBRTFDLElBQUk7SUFDRixNQUFNLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxHQUFHLE1BQU0sV0FBVztNQUFDO01BQVE7S0FBUztJQUM1RCxJQUFJLFNBQVMsR0FBRztNQUNkLE9BQU87UUFDTCxJQUFJO1FBQ0osT0FBTyxJQUFJLE1BQU0sQ0FBQyx1QkFBdUIsRUFBRSxRQUFRO01BQ3JEO0lBQ0Y7SUFFQSxNQUFNLFNBQVMsa0JBQWtCO0lBQ2pDLE1BQU0sWUFBWSxPQUFPLE1BQU0sS0FBSyxLQUNsQywyQkFBMkIsSUFBSSxDQUFDO0lBRWxDLE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTztRQUNMO1FBQ0Esa0JBQWtCLE9BQU8sUUFBUSxDQUFDO1FBQ2xDLGNBQWMsT0FBTyxRQUFRLENBQUM7UUFDOUI7UUFDQSxXQUFXO01BQ2I7SUFDRjtFQUNGLEVBQUUsT0FBTyxPQUFnQjtJQUN2QixNQUFNLE1BQU0saUJBQWlCLFFBQVEsTUFBTSxPQUFPLEdBQUcsT0FBTztJQUM1RCxPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sSUFBSSxNQUFNLENBQUMsa0NBQWtDLEVBQUUsS0FBSztJQUM3RDtFQUNGO0FBQ0YifQ==
// denoCacheMetadata=857229286662556352,13812149516037113590