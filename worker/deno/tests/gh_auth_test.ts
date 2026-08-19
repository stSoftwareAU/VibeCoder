/**
 * Tests for gh_auth.ts — GitHub CLI authentication verification.
 *
 * Issue #905: Migrate gh_auth.sh to Deno TypeScript.
 * Covers: isGhAuthError, ghAuthActionableMessage, checkGhAuth.
 *
 * Australian English spelling throughout (authorisation, behaviour, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  checkGhAuth,
  getGhTokenScopes,
  ghAuthActionableMessage,
  isGhAuthError,
  parseGhAuthScopes,
} from "../lib/gh_auth.ts";
import { type FetchFn, resetTokenCache } from "../lib/github_app_auth.ts";

// =============================================================================
// isGhAuthError — Auth Error Detection
// =============================================================================

Deno.test("gh_auth - isGhAuthError detects HTTP 401", () => {
  assertEquals(isGhAuthError("HTTP 401 Unauthorized"), true);
});

Deno.test("gh_auth - isGhAuthError detects 'authentication' keyword", () => {
  assertEquals(isGhAuthError("authentication required"), true);
});

Deno.test("gh_auth - isGhAuthError detects 'auth token' keyword", () => {
  assertEquals(isGhAuthError("auth token has expired"), true);
});

Deno.test("gh_auth - isGhAuthError detects 'not logged in'", () => {
  assertEquals(
    isGhAuthError("You are not logged in to any GitHub hosts"),
    true,
  );
});

Deno.test("gh_auth - isGhAuthError detects 'credential' keyword", () => {
  assertEquals(isGhAuthError("credential error"), true);
});

Deno.test("gh_auth - isGhAuthError is case-insensitive", () => {
  assertEquals(isGhAuthError("AUTHENTICATION REQUIRED"), true);
  assertEquals(isGhAuthError("Auth Token Expired"), true);
});

Deno.test("gh_auth - isGhAuthError returns false for non-auth errors", () => {
  assertEquals(isGhAuthError("HTTP 404 Not Found"), false);
  assertEquals(isGhAuthError("rate limit exceeded"), false);
  assertEquals(isGhAuthError("connection timeout"), false);
});

Deno.test("gh_auth - isGhAuthError returns false for empty string", () => {
  assertEquals(isGhAuthError(""), false);
});

// =============================================================================
// ghAuthActionableMessage — Human-Readable Fix Instructions
// =============================================================================

Deno.test("gh_auth - actionable message without GH_CONFIG_DIR", () => {
  const msg = ghAuthActionableMessage();
  assertEquals(msg, "gh auth expired — run: gh auth refresh");
});

Deno.test("gh_auth - actionable message with GH_CONFIG_DIR", () => {
  const msg = ghAuthActionableMessage("/path/to/gh-config");
  assertEquals(
    msg,
    "gh auth expired in GH_CONFIG_DIR=/path/to/gh-config — run: GH_CONFIG_DIR=/path/to/gh-config gh auth refresh",
  );
});

// =============================================================================
// checkGhAuth — Authentication Verification
// =============================================================================

Deno.test("gh_auth - checkGhAuth skips check when skipAuthCheck is true", async () => {
  const result = await checkGhAuth({ skipAuthCheck: true });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.valid, true);
    assertEquals(result.value.message, "Auth check skipped");
  }
});

Deno.test("gh_auth - checkGhAuth returns valid when gh auth status succeeds", async () => {
  const result = await checkGhAuth({
    runCommand: async () => ({ code: 0, output: "Logged in to github.com" }),
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.valid, true);
  }
});

Deno.test("gh_auth - checkGhAuth returns invalid when gh auth status fails", async () => {
  const result = await checkGhAuth({
    runCommand: async () => ({
      code: 1,
      output: "You are not logged in",
    }),
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.valid, false);
    assertEquals(
      result.value.message,
      "gh auth expired — run: gh auth refresh",
    );
  }
});

Deno.test("gh_auth - checkGhAuth includes GH_CONFIG_DIR in message when set", async () => {
  const result = await checkGhAuth({
    ghConfigDir: "/service/gh-config",
    runCommand: async () => ({
      code: 1,
      output: "auth failed",
    }),
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.valid, false);
    assertEquals(
      result.value.message.includes("GH_CONFIG_DIR=/service/gh-config"),
      true,
    );
  }
});

Deno.test("gh_auth - checkGhAuth returns error when command throws", async () => {
  const result = await checkGhAuth({
    runCommand: async () => {
      throw new Error("command not found: gh");
    },
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message.includes("Failed to run gh auth status"),
      true,
    );
  }
});

// =============================================================================
// checkGhAuth — GitHub App Token Fallback (Issue #959)
// =============================================================================

Deno.test("gh_auth - checkGhAuth validates via App token when App config is present", async () => {
  resetTokenCache();

  const tmpFile = await Deno.makeTempFile({ suffix: ".pem" });
  try {
    // Write a test PEM key
    await Deno.writeTextFile(
      tmpFile,
      `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDGqkt46j7Fr/zi
UWl7LQB7z8vPqGA+2V9LKsqW0uGDbTJsm5GEWaaFKaLAhaTIY0GEIINMIGIhgO4N
HMAiHRZ7+yw6sEP/bm1LY3Owg8yH7u7YhrpJ3WSocNqBQ32gQsxgt1V5XwHH2KfN
DqZyCnew+9P0c8kjTTdaXLd4ZGKUw+g+6efPi2zyqO1igu9mSuJOn4mNoP9LEvRi
pe/QHF07uOxW8lAbc5Qby+lPJs/sEqXZDVu6VQIoRKKacYjlRZ1Vi0vVW4HQKJVD
5ZdIpMSi55tfL6MHvfH70cLxCZUxBO5rJjfQQ/XVi0RD+cyv3S52i8MjDkemA4LD
dBtN+AXXAgMBAAECggEADQ7NN/AqZ0ZlmF9b6Ya2gDmf3p3lXy9c17OP7h3qSLMs
T0svMCqcV8BToqFy7uDnQehixbKTM9SMaqKeVlLguXSm6yybkfYPvpbI2EWxc3XW
9eoISinNH4bBz4em6DO7yNedowUFnvC0oGiU51LQAmGeN6d5a8j75gQvr8my8q6L
Rwu8vbgzwMnesf/QN1dIrNfIBkAneaIolhc0EfGQpY7oxcVhsUSeMF3yTkAZncFw
Bgw2bfAO1/BfCK4IWLBqlsJX0lPP5JUiRdPpVKPlNvfkZQA22yZADBEiAf2deV+o
a/31N9XZUtrlkjtI1E9gYzO5pC5+C5mieDKEgK7xsQKBgQDteS7h2wbZh3funMfB
smENdu/NC4MsKfVp6ZT/9oNpOxcdIUQZy21fMw3MK3749CnQiVWRte9fxiVAOa43
B0TWYNLUfDyeNj+miajDwEReCUcBAARi/S367fHN4CiXkfEOQ77atsRy/ObXloZR
4pmDq84w2TY5TjR2kxgM/GIQQwKBgQDWKgkOMFHOewvAYPqvMPWxUdjbmZ3IFojt
8ZQf64T5MHa9IFkRtnZ9czraTf48IGbchWeaD2wHsxCu1l7kyE0s8GLgYVf//DeX
MIoiltQPVFyIxmXnbvsIuL+rqajln9GQZWb1fXF23vPYUjYJmaSpqf/2wRN47k3d
5CK5VX5U3QKBgGvzirxhNNvuGTb/Tk9fJ39XcetkMF0DNezPokw5Y8OSeQ9k7/BJ
6Y49RyhpHW9OjzOdOqjia8695HEtx2R8iW5q1WyCjYveXVD3gyB5ZprY3M43k8bs
ENrhD+rm240LaulxInGKZANhtA6M/sJ6oA6bK0BJfbzPMEo209gTYwDBAoGBAL76
mTyn5iulGmOhl6rmlBJeFG4v3L3zKoRVa2vTkK7OgvRAhmz/M0bHnPHTnyVrF48K
/8ooeoObMQNYcyK9Y+TxMJs680h5V/Fg/a2+prhM2H+3vGPXWdD7PyELmGu8Sxri
8h90j9wbEYQUO8/vzSDnUjRvFLhAefunVzfCf3eZAoGAcEtTt0UfyrQLQVNRu4d9
TkNx4bMoIg7iIRD2Hw7nllhL8WVS4G622MinPoe4O3haL2EF0cyv84wnTF7Xb1ns
I6FIlFPYaHl3OQczlTCpqnGDWJXSoFYHAcvQbg8NOF4fX1vjqBUlQSpxs3ImdjOi
EueUFZ2YucK5tRacK+eBAvU=
-----END PRIVATE KEY-----`,
    );

    const mockFetch: FetchFn = async (_url, _init) => {
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      return new Response(
        JSON.stringify({ token: "ghs_app_token", expires_at: expiresAt }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await checkGhAuth({
      githubAppId: "12345",
      githubAppInstallationId: "67890",
      githubAppPrivateKeyPath: tmpFile,
      fetchFn: mockFetch,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.valid, true);
      assertEquals(result.value.message, "GitHub App authentication is valid");
    }
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("gh_auth - checkGhAuth returns invalid when App token generation fails", async () => {
  resetTokenCache();

  const result = await checkGhAuth({
    githubAppId: "12345",
    githubAppInstallationId: "67890",
    githubAppPrivateKeyPath: "/nonexistent/key.pem",
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.valid, false);
    assertEquals(result.value.message.includes("GitHub App auth failed"), true);
  }
});

// =============================================================================
// parseGhAuthScopes — Token Scope Parsing
// =============================================================================

Deno.test("gh_auth - parseGhAuthScopes parses single-account output with workflow scope", () => {
  const output = `github.com
  ✓ Logged in to github.com account worker-bot (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo', 'workflow'`;
  const scopes = parseGhAuthScopes(output);
  assertEquals(scopes, [
    "admin:public_key",
    "gist",
    "read:org",
    "repo",
    "workflow",
  ]);
});

Deno.test("gh_auth - parseGhAuthScopes parses output without workflow scope", () => {
  const output = `github.com
  ✓ Logged in to github.com account nigel (keyring)
  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'`;
  const scopes = parseGhAuthScopes(output);
  assertEquals(scopes, ["admin:public_key", "gist", "read:org", "repo"]);
});

Deno.test("gh_auth - parseGhAuthScopes handles double-quoted scopes", () => {
  const output = `  - Token scopes: "repo", "workflow"`;
  const scopes = parseGhAuthScopes(output);
  assertEquals(scopes, ["repo", "workflow"]);
});

Deno.test("gh_auth - parseGhAuthScopes returns empty list when scopes line absent", () => {
  const output = `Logged in via GitHub App installation 12345`;
  const scopes = parseGhAuthScopes(output);
  assertEquals(scopes, []);
});

Deno.test("gh_auth - parseGhAuthScopes returns empty list for empty input", () => {
  assertEquals(parseGhAuthScopes(""), []);
});

Deno.test("gh_auth - parseGhAuthScopes uses active account when multiple present", () => {
  const output = `github.com
  ✓ Logged in to github.com account other-user (keyring)
  - Active account: false
  - Token scopes: 'repo'

  ✓ Logged in to github.com account worker-bot (keyring)
  - Active account: true
  - Token scopes: 'repo', 'workflow', 'read:org'`;
  const scopes = parseGhAuthScopes(output);
  assertEquals(scopes, ["repo", "workflow", "read:org"]);
});

// =============================================================================
// getGhTokenScopes — Scope Detection at Startup
// =============================================================================

Deno.test("gh_auth - getGhTokenScopes returns scopes including workflow", async () => {
  const result = await getGhTokenScopes({
    runCommand: async () => ({
      code: 0,
      output: `github.com
  ✓ Logged in to github.com account worker-bot (keyring)
  - Active account: true
  - Token scopes: 'repo', 'workflow', 'read:org'`,
    }),
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.scopes, ["repo", "workflow", "read:org"]);
    assertEquals(result.value.hasWorkflowScope, true);
    assertEquals(result.value.hasRepoScope, true);
  }
});

Deno.test("gh_auth - getGhTokenScopes flags missing workflow scope", async () => {
  const result = await getGhTokenScopes({
    runCommand: async () => ({
      code: 0,
      output: `  - Token scopes: 'repo', 'read:org'`,
    }),
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.hasWorkflowScope, false);
    assertEquals(result.value.hasRepoScope, true);
  }
});

Deno.test("gh_auth - getGhTokenScopes returns ok=false when gh command fails", async () => {
  const result = await getGhTokenScopes({
    runCommand: async () => ({ code: 1, output: "not logged in" }),
  });
  assertEquals(result.ok, false);
});

Deno.test("gh_auth - getGhTokenScopes returns empty scopes for App auth", async () => {
  const result = await getGhTokenScopes({
    runCommand: async () => ({
      code: 0,
      output: `Logged in via GitHub App installation 12345`,
    }),
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.scopes, []);
    assertEquals(result.value.hasWorkflowScope, false);
    assertEquals(result.value.isAppAuth, true);
  }
});

Deno.test("gh_auth - checkGhAuth falls back to gh auth status when App not configured", async () => {
  // No App config — should use runCommand fallback
  const result = await checkGhAuth({
    runCommand: async () => ({ code: 0, output: "Logged in" }),
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.valid, true);
    assertEquals(result.value.message, "gh auth is valid");
  }
});
