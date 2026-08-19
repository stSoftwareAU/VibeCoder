/**
 * Tests for github_app_auth.ts — GitHub App JWT and installation token generation.
 *
 * Issue #958: Implement GitHub App JWT and installation token generation.
 * Covers: generateAppJWT, getInstallationToken, ensureValidToken.
 *
 * Australian English spelling throughout (behaviour, authorisation, etc.)
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  APP_AUTH_FALLBACK_EVENT,
  type AuthEventLogger,
  ensureValidToken,
  type FetchFn,
  generateAppJWT,
  getGhTokenForSubprocess,
  getInstallationToken,
  isGitHubAppConfigured,
  resetTokenCache,
} from "../lib/github_app_auth.ts";

/** Capture security events emitted during a call. */
function captureSecurityEvents(): {
  logger: AuthEventLogger;
  events: Array<{ event: string; details: string }>;
} {
  const events: Array<{ event: string; details: string }> = [];
  return {
    logger: {
      security: (event: string, details: string) => {
        events.push({ event, details });
      },
    },
    events,
  };
}

// =============================================================================
// Test RSA Key Pair (2048-bit, generated for testing only — not a real secret)
// =============================================================================

// PKCS#8 test key — generated for unit tests only, not a real secret.
const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
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
-----END PRIVATE KEY-----`;

// =============================================================================
// generateAppJWT — JWT Creation
// =============================================================================

Deno.test("github_app_auth - generateAppJWT produces a valid three-part JWT", async () => {
  const jwt = await generateAppJWT("12345", TEST_PRIVATE_KEY_PEM);
  const parts = jwt.split(".");
  assertEquals(parts.length, 3, "JWT must have three dot-separated parts");
});

Deno.test("github_app_auth - generateAppJWT header specifies RS256 and typ JWT", async () => {
  const jwt = await generateAppJWT("12345", TEST_PRIVATE_KEY_PEM);
  const headerJson = JSON.parse(atob(base64urlToBase64(jwt.split(".")[0]!)));
  assertEquals(headerJson.alg, "RS256");
  assertEquals(headerJson.typ, "JWT");
});

Deno.test("github_app_auth - generateAppJWT payload contains correct issuer", async () => {
  const jwt = await generateAppJWT("99999", TEST_PRIVATE_KEY_PEM);
  const payloadJson = JSON.parse(atob(base64urlToBase64(jwt.split(".")[1]!)));
  assertEquals(payloadJson.iss, "99999");
});

Deno.test("github_app_auth - generateAppJWT payload has iat 60 seconds before now", async () => {
  const before = Math.floor(Date.now() / 1000) - 60;
  const jwt = await generateAppJWT("12345", TEST_PRIVATE_KEY_PEM);
  const payloadJson = JSON.parse(atob(base64urlToBase64(jwt.split(".")[1]!)));
  const after = Math.floor(Date.now() / 1000) - 60;
  // iat should be within a small window
  assertEquals(payloadJson.iat >= before && payloadJson.iat <= after + 1, true);
});

Deno.test("github_app_auth - generateAppJWT payload has exp 10 minutes from now", async () => {
  const before = Math.floor(Date.now() / 1000) + 600;
  const jwt = await generateAppJWT("12345", TEST_PRIVATE_KEY_PEM);
  const payloadJson = JSON.parse(atob(base64urlToBase64(jwt.split(".")[1]!)));
  const after = Math.floor(Date.now() / 1000) + 600;
  // exp should be within a small window
  assertEquals(
    payloadJson.exp >= before - 1 && payloadJson.exp <= after + 1,
    true,
  );
});

Deno.test("github_app_auth - generateAppJWT rejects invalid PEM key", async () => {
  await assertRejects(
    () => generateAppJWT("12345", "not-a-valid-pem"),
    Error,
    "private key",
  );
});

Deno.test("github_app_auth - generateAppJWT rejects empty appId", async () => {
  await assertRejects(
    () => generateAppJWT("", TEST_PRIVATE_KEY_PEM),
    Error,
    "appId",
  );
});

// =============================================================================
// getInstallationToken — Token Exchange (mocked fetch)
// =============================================================================

Deno.test("github_app_auth - getInstallationToken returns token and expiry from API response", async () => {
  const expiresAt = "2026-04-07T12:00:00Z";
  const mockFetch: FetchFn = async (_url, _init) => {
    return new Response(
      JSON.stringify({ token: "ghs_test_token_123", expires_at: expiresAt }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  };

  const result = await getInstallationToken(
    "fake.jwt.token",
    "67890",
    mockFetch,
  );
  assertEquals(result.token, "ghs_test_token_123");
  assertEquals(
    result.expiresAt.toISOString(),
    new Date(expiresAt).toISOString(),
  );
});

Deno.test("github_app_auth - getInstallationToken rejects on non-201 response", async () => {
  const mockFetch: FetchFn = async (_url, _init) => {
    return new Response(
      JSON.stringify({ message: "Bad credentials" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  };

  await assertRejects(
    () => getInstallationToken("fake.jwt.token", "67890", mockFetch),
    Error,
    "401",
  );
});

Deno.test("github_app_auth - getInstallationToken rejects on missing token in response", async () => {
  const mockFetch: FetchFn = async (_url, _init) => {
    return new Response(
      JSON.stringify({ expires_at: "2026-04-07T12:00:00Z" }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  };

  await assertRejects(
    () => getInstallationToken("fake.jwt.token", "67890", mockFetch),
    Error,
    "token",
  );
});

Deno.test("github_app_auth - getInstallationToken sends correct URL and headers", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};

  const mockFetch: FetchFn = async (url, init) => {
    capturedUrl = url.toString();
    const headers = init?.headers as Record<string, string> | undefined;
    capturedHeaders = headers ?? {};
    return new Response(
      JSON.stringify({ token: "ghs_test", expires_at: "2026-04-07T12:00:00Z" }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  };

  await getInstallationToken("my.jwt.here", "42", mockFetch);
  assertStringIncludes(capturedUrl, "/app/installations/42/access_tokens");
  assertStringIncludes(
    capturedHeaders["Authorization"] ?? "",
    "Bearer my.jwt.here",
  );
  assertEquals(capturedHeaders["Accept"], "application/vnd.github+json");
});

Deno.test("github_app_auth - getInstallationToken rejects empty installationId", async () => {
  const mockFetch: FetchFn = async (_url, _init) => {
    return new Response("{}", { status: 201 });
  };

  await assertRejects(
    () => getInstallationToken("fake.jwt", "", mockFetch),
    Error,
    "installationId",
  );
});

// =============================================================================
// ensureValidToken — Token Caching and Auto-Refresh
// =============================================================================

Deno.test("github_app_auth - ensureValidToken reads private key from path and returns token", async () => {
  resetTokenCache();

  // Write a temp PEM file
  const tmpFile = await Deno.makeTempFile({ suffix: ".pem" });
  try {
    await Deno.writeTextFile(tmpFile, TEST_PRIVATE_KEY_PEM);

    const mockFetch: FetchFn = async (_url, _init) => {
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      return new Response(
        JSON.stringify({ token: "ghs_cached_token", expires_at: expiresAt }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const token = await ensureValidToken("12345", "67890", tmpFile, mockFetch);
    assertEquals(token, "ghs_cached_token");
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("github_app_auth - ensureValidToken returns cached token when still valid", async () => {
  resetTokenCache();

  const tmpFile = await Deno.makeTempFile({ suffix: ".pem" });
  let fetchCallCount = 0;

  try {
    await Deno.writeTextFile(tmpFile, TEST_PRIVATE_KEY_PEM);

    const mockFetch: FetchFn = async (_url, _init) => {
      fetchCallCount++;
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      return new Response(
        JSON.stringify({
          token: `ghs_token_${fetchCallCount}`,
          expires_at: expiresAt,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const token1 = await ensureValidToken("12345", "67890", tmpFile, mockFetch);
    const token2 = await ensureValidToken("12345", "67890", tmpFile, mockFetch);
    assertEquals(token1, "ghs_token_1");
    assertEquals(token2, "ghs_token_1"); // Same token returned — cached
    assertEquals(fetchCallCount, 1); // Only one API call
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("github_app_auth - ensureValidToken refreshes token when near expiry", async () => {
  resetTokenCache();

  const tmpFile = await Deno.makeTempFile({ suffix: ".pem" });
  let fetchCallCount = 0;

  try {
    await Deno.writeTextFile(tmpFile, TEST_PRIVATE_KEY_PEM);

    const mockFetch: FetchFn = async (_url, _init) => {
      fetchCallCount++;
      // First call returns a token expiring in 2 minutes (within 5-min refresh window)
      // Second call returns a token with a full hour
      const expiresAt = fetchCallCount === 1
        ? new Date(Date.now() + 120_000).toISOString() // 2 min — should trigger refresh
        : new Date(Date.now() + 3600_000).toISOString(); // 1 hour
      return new Response(
        JSON.stringify({
          token: `ghs_token_${fetchCallCount}`,
          expires_at: expiresAt,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const token1 = await ensureValidToken("12345", "67890", tmpFile, mockFetch);
    assertEquals(token1, "ghs_token_1");

    // Second call should refresh because token expires within 5 minutes
    const token2 = await ensureValidToken("12345", "67890", tmpFile, mockFetch);
    assertEquals(token2, "ghs_token_2");
    assertEquals(fetchCallCount, 2);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("github_app_auth - ensureValidToken rejects when key file does not exist", async () => {
  resetTokenCache();

  await assertRejects(
    () => ensureValidToken("12345", "67890", "/nonexistent/path/key.pem"),
    Error,
    "private key file",
  );
});

Deno.test("github_app_auth - ensureValidToken rejects when key file is empty", async () => {
  resetTokenCache();

  const tmpFile = await Deno.makeTempFile({ suffix: ".pem" });
  try {
    await Deno.writeTextFile(tmpFile, "");

    await assertRejects(
      () => ensureValidToken("12345", "67890", tmpFile),
      Error,
      "private key",
    );
  } finally {
    await Deno.remove(tmpFile);
  }
});

// =============================================================================
// isGitHubAppConfigured (Issue #2795 — object type predicate)
// =============================================================================

Deno.test("isGitHubAppConfigured - true when all three values present", () => {
  assertEquals(
    isGitHubAppConfigured({
      appId: "12345",
      installationId: "67890",
      privateKeyPath: "/tmp/key.pem",
    }),
    true,
  );
});

Deno.test("isGitHubAppConfigured - narrows fields to string without assertions", () => {
  // Issue #2795: inside the guard, the fields are typed `string`, so they
  // can be consumed without `!`. This compiles only if the predicate narrows.
  const config = {
    appId: "12345",
    installationId: "67890",
    privateKeyPath: "/tmp/key.pem",
  };
  if (isGitHubAppConfigured(config)) {
    const joined: string =
      `${config.appId}:${config.installationId}:${config.privateKeyPath}`;
    assertEquals(joined, "12345:67890:/tmp/key.pem");
  } else {
    throw new Error("expected config to be recognised as configured");
  }
});

Deno.test("isGitHubAppConfigured - false when a value is missing", () => {
  assertEquals(
    isGitHubAppConfigured({
      appId: "12345",
      installationId: undefined,
      privateKeyPath: "/tmp/key.pem",
    }),
    false,
  );
  assertEquals(
    isGitHubAppConfigured({
      appId: "12345",
      installationId: "67890",
      privateKeyPath: null,
    }),
    false,
  );
});

Deno.test("isGitHubAppConfigured - false for empty or whitespace-only values", () => {
  assertEquals(
    isGitHubAppConfigured({
      appId: "",
      installationId: "67890",
      privateKeyPath: "/tmp/key.pem",
    }),
    false,
  );
  assertEquals(
    isGitHubAppConfigured({
      appId: "12345",
      installationId: "   ",
      privateKeyPath: "/tmp/key.pem",
    }),
    false,
  );
});

Deno.test("isGitHubAppConfigured - false for fully empty config", () => {
  assertEquals(isGitHubAppConfigured({}), false);
});

// =============================================================================
// getGhTokenForSubprocess — Subprocess Token Wrapper (Issue #3040)
// =============================================================================

Deno.test("getGhTokenForSubprocess - returns undefined when fully unconfigured", async () => {
  resetTokenCache();
  // Caller falls back to ambient gh auth when the App is not configured.
  assertEquals(
    await getGhTokenForSubprocess(undefined, undefined, undefined),
    undefined,
  );
});

Deno.test("getGhTokenForSubprocess - returns undefined when partially configured", async () => {
  resetTokenCache();
  // Any missing value means "not configured" — no token, no throw.
  assertEquals(
    await getGhTokenForSubprocess("12345", undefined, "/tmp/key.pem"),
    undefined,
  );
  assertEquals(
    await getGhTokenForSubprocess("12345", "67890", undefined),
    undefined,
  );
  assertEquals(
    await getGhTokenForSubprocess("", "67890", "/tmp/key.pem"),
    undefined,
  );
});

Deno.test("getGhTokenForSubprocess - returns the minted token when configured", async () => {
  resetTokenCache();

  const tmpFile = await Deno.makeTempFile({ suffix: ".pem" });
  try {
    await Deno.writeTextFile(tmpFile, TEST_PRIVATE_KEY_PEM);

    // Prime the in-memory token cache via ensureValidToken with an injected
    // fetch (token valid for an hour, well beyond the 5-min refresh buffer).
    const mockFetch: FetchFn = async (_url, _init) => {
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      return new Response(
        JSON.stringify({ token: "ghs_faketoken", expires_at: expiresAt }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };
    await ensureValidToken("12345", "67890", tmpFile, mockFetch);

    // The wrapper reuses the cached token — no network call — and returns it.
    assertEquals(
      await getGhTokenForSubprocess("12345", "67890", tmpFile),
      "ghs_faketoken",
    );
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("getGhTokenForSubprocess - returns undefined when token resolution fails", async () => {
  resetTokenCache();
  // Configured but the key file is missing: ensureValidToken throws and the
  // caller falls back to ambient auth (the failure is reported — Issue #3644).
  const { logger } = captureSecurityEvents();
  assertEquals(
    await getGhTokenForSubprocess(
      "12345",
      "67890",
      "/nonexistent/path/key.pem",
      logger,
    ),
    undefined,
  );
});

// =============================================================================
// Issue #3644 — App auth failure must not degrade to ambient auth silently
// =============================================================================

Deno.test("getGhTokenForSubprocess - reports a security event when minting fails", async () => {
  resetTokenCache();
  const { logger, events } = captureSecurityEvents();

  const token = await getGhTokenForSubprocess(
    "12345",
    "67890",
    "/nonexistent/path/key.pem",
    logger,
  );

  assertEquals(token, undefined);
  assertEquals(events.length, 1);
  assertEquals(events[0]!.event, APP_AUTH_FALLBACK_EVENT);
  // The event must identify the App and name the degradation, so an incident
  // responder can tell which credential actually made later changes.
  assertStringIncludes(events[0]!.details, "appId=12345");
  assertStringIncludes(events[0]!.details, "installationId=67890");
  assertStringIncludes(events[0]!.details, "ambient");
  // ...and carry the underlying cause rather than discarding it.
  assertStringIncludes(events[0]!.details, "/nonexistent/path/key.pem");
});

Deno.test("getGhTokenForSubprocess - reports a security event when the exchange fails", async () => {
  resetTokenCache();
  const { logger, events } = captureSecurityEvents();

  const tmpFile = await Deno.makeTempFile({ suffix: ".pem" });
  try {
    // A malformed PEM fails inside the JWT stage rather than at file read,
    // covering the second failure mode (bad key material, not a missing file).
    await Deno.writeTextFile(tmpFile, "not-a-pem");

    assertEquals(
      await getGhTokenForSubprocess("12345", "67890", tmpFile, logger),
      undefined,
    );
    assertEquals(events.length, 1);
    assertEquals(events[0]!.event, APP_AUTH_FALLBACK_EVENT);
    assertStringIncludes(events[0]!.details, "PEM format");
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("getGhTokenForSubprocess - stays quiet when the App is not configured", async () => {
  resetTokenCache();
  const { logger, events } = captureSecurityEvents();

  // Unconfigured is a deliberate operator choice, not a failure: ambient auth
  // is the intended identity, so there is no degradation to report.
  assertEquals(
    await getGhTokenForSubprocess(undefined, undefined, undefined, logger),
    undefined,
  );
  assertEquals(
    await getGhTokenForSubprocess("12345", undefined, "/tmp/key.pem", logger),
    undefined,
  );
  assertEquals(events.length, 0);
});

Deno.test("getGhTokenForSubprocess - stays quiet when minting succeeds", async () => {
  resetTokenCache();
  const { logger, events } = captureSecurityEvents();

  const tmpFile = await Deno.makeTempFile({ suffix: ".pem" });
  try {
    await Deno.writeTextFile(tmpFile, TEST_PRIVATE_KEY_PEM);
    const mockFetch: FetchFn = (_url, _init) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            token: "ghs_faketoken",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
    await ensureValidToken("12345", "67890", tmpFile, mockFetch);

    assertEquals(
      await getGhTokenForSubprocess("12345", "67890", tmpFile, logger),
      "ghs_faketoken",
    );
    assertEquals(events.length, 0);
  } finally {
    await Deno.remove(tmpFile);
  }
});

// =============================================================================
// Helpers
// =============================================================================

/** Convert base64url to standard base64 for atob decoding. */
function base64urlToBase64(b64url: string): string {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) {
    b64 += "=";
  }
  return b64;
}
