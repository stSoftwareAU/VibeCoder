/**
 * Tests for the per-run scoped GitHub App installation token (Issue #1391).
 *
 * An installation token minted with no request body carries the App's
 * permissions on every repository the installation covers, so a write that
 * slipped past the code-level write-repo allowlist still succeeded. These
 * tests drive the real minting path with an injected `fetch` and assert on
 * what actually reaches GitHub — the POST body — plus the scope the allowlist
 * derives and the cache's refusal to serve a wider token to a narrower run.
 *
 * Uses Australian English throughout (behaviour, authorisation, organisation).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ensureValidToken,
  type FetchFn,
  getInstallationToken,
  installationRepoNames,
  resetTokenCache,
} from "../lib/github_app_auth.ts";
import {
  _resetWriteRepoAllowlistSinks,
  _resetWriteRepoPins,
  _setWriteRepoAllowlistSinks,
  installationTokenRepoScope,
  isWriteRepoAllowed,
  pinWriteRepo,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
  unpinWriteRepo,
  withTokenScopedRepo,
} from "../lib/write_repo_allowlist.ts";

// =============================================================================
// Helpers
// =============================================================================

/** A `fetch` stub that records the request bodies it was handed. */
function recordingFetch(
  bodies: Array<string | undefined>,
  token = "ghs_scoped_token",
): FetchFn {
  let mint = 0;
  return (_url, init) => {
    bodies.push(init?.body === undefined ? undefined : String(init.body));
    mint++;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          token: `${token}_${mint}`,
          // Well beyond the five-minute refresh buffer, so a second call is a
          // genuine cache decision rather than an expiry refresh.
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
  };
}

/** Write a fresh PKCS#8 RSA private key to a temp file for signing. */
async function writeTestPrivateKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64 = btoa(binary).replace(/(.{64})/g, "$1\n");
  const path = await Deno.makeTempFile({ suffix: ".pem" });
  await Deno.writeTextFile(
    path,
    `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
  );
  return path;
}

/** Silence the allowlist's security log for the duration of `fn`. */
async function withQuietSinks(fn: () => Promise<void>): Promise<void> {
  _setWriteRepoAllowlistSinks({ log: () => {} });
  try {
    await fn();
  } finally {
    _resetWriteRepoAllowlistSinks();
    resetWriteRepoAllowlist();
    _resetWriteRepoPins();
  }
}

// =============================================================================
// The token exchange carries the repository scope
// =============================================================================

Deno.test("installation token - scopes the exchange to the repos the run may write to", async () => {
  const bodies: Array<string | undefined> = [];
  await getInstallationToken("fake.jwt", "42", recordingFetch(bodies), [
    "stSoftwareAU/VibeCoder",
  ]);
  assertEquals(bodies.length, 1);
  assertEquals(bodies[0], JSON.stringify({ repositories: ["VibeCoder"] }));
});

Deno.test("installation token - sends bare repo names, de-duplicated and sorted", async () => {
  const bodies: Array<string | undefined> = [];
  await getInstallationToken("fake.jwt", "42", recordingFetch(bodies), [
    "stSoftwareAU/GRQ",
    "stSoftwareAU/VibeCoder",
    "stSoftwareAU/GRQ",
  ]);
  assertEquals(
    bodies[0],
    JSON.stringify({ repositories: ["GRQ", "VibeCoder"] }),
  );
});

Deno.test("installation token - stays unscoped when no scope is supplied", async () => {
  const bodies: Array<string | undefined> = [];
  await getInstallationToken("fake.jwt", "42", recordingFetch(bodies));
  assertEquals(bodies[0], undefined);
  await getInstallationToken("fake.jwt", "42", recordingFetch(bodies), null);
  assertEquals(bodies[1], undefined);
});

Deno.test("installation token - refuses an empty repository scope rather than widening", async () => {
  const bodies: Array<string | undefined> = [];
  await assertRejects(
    () => getInstallationToken("fake.jwt", "42", recordingFetch(bodies), []),
    Error,
    "empty repository scope",
  );
  assertEquals(bodies.length, 0);
});

Deno.test("installation token - fails loud on a slug that is not owner/repo", () => {
  assertEquals(installationRepoNames(["owner/repo"]), ["repo"]);
  for (const bad of ["VibeCoder", "owner/repo/extra", "/repo", "owner/", " "]) {
    let message = "";
    try {
      installationRepoNames([bad]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assert(
      message.includes("expected owner/repo"),
      `'${bad}' should be refused, got: ${message || "<no throw>"}`,
    );
  }
});

// =============================================================================
// The cache is scope-aware
// =============================================================================

Deno.test("installation token - a narrower run never reuses a wider cached token", async () => {
  const keyPath = await writeTestPrivateKey();
  resetTokenCache();
  try {
    const bodies: Array<string | undefined> = [];
    const fetchFn = recordingFetch(bodies);
    const wide = await ensureValidToken("1", "2", keyPath, fetchFn, [
      "stSoftwareAU/VibeCoder",
      "stSoftwareAU/GRQ",
    ]);
    const narrow = await ensureValidToken("1", "2", keyPath, fetchFn, [
      "stSoftwareAU/VibeCoder",
    ]);
    assertEquals(
      bodies.length,
      2,
      "the narrower scope must mint its own token",
    );
    assert(wide !== narrow, "the wider token must not be reused");
    assertEquals(
      bodies[1],
      JSON.stringify({ repositories: ["VibeCoder"] }),
    );
  } finally {
    resetTokenCache();
    await Deno.remove(keyPath);
  }
});

Deno.test("installation token - reuses the cached token for an identical scope", async () => {
  const keyPath = await writeTestPrivateKey();
  resetTokenCache();
  try {
    const bodies: Array<string | undefined> = [];
    const fetchFn = recordingFetch(bodies);
    const scope = ["stSoftwareAU/VibeCoder"];
    const first = await ensureValidToken("1", "2", keyPath, fetchFn, scope);
    const second = await ensureValidToken("1", "2", keyPath, fetchFn, [
      "stSoftwareAU/VibeCoder",
    ]);
    assertEquals(bodies.length, 1);
    assertEquals(first, second);
  } finally {
    resetTokenCache();
    await Deno.remove(keyPath);
  }
});

Deno.test("installation token - an unscoped request never reuses a scoped token", async () => {
  const keyPath = await writeTestPrivateKey();
  resetTokenCache();
  try {
    const bodies: Array<string | undefined> = [];
    const fetchFn = recordingFetch(bodies);
    const scoped = await ensureValidToken("1", "2", keyPath, fetchFn, [
      "stSoftwareAU/VibeCoder",
    ]);
    const unscoped = await ensureValidToken("1", "2", keyPath, fetchFn);
    assertEquals(bodies.length, 2);
    assert(scoped !== unscoped);
  } finally {
    resetTokenCache();
    await Deno.remove(keyPath);
  }
});

// =============================================================================
// The scope is derived from the run's write-repo allowlist
// =============================================================================

Deno.test("installation token scope - is null until a run seeds the allowlist", async () => {
  await withQuietSinks(() => {
    assertEquals(installationTokenRepoScope(), null);
    return Promise.resolve();
  });
});

Deno.test("installation token scope - is the repos the run may write to", async () => {
  await withQuietSinks(() => {
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    assertEquals(installationTokenRepoScope(), ["stSoftwareAU/VibeCoder"]);
    return Promise.resolve();
  });
});

Deno.test("installation token scope - includes heartbeat pins", async () => {
  await withQuietSinks(() => {
    pinWriteRepo("stSoftwareAU/GRQ");
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    assertEquals(installationTokenRepoScope(), [
      "stSoftwareAU/GRQ",
      "stSoftwareAU/VibeCoder",
    ]);
    unpinWriteRepo("stSoftwareAU/GRQ");
    assertEquals(installationTokenRepoScope(), ["stSoftwareAU/VibeCoder"]);
    return Promise.resolve();
  });
});

Deno.test("installation token scope - a read grant widens the token, not the write allowlist", async () => {
  await withQuietSinks(async () => {
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    let inside: string[] | null = null;
    let writable = true;
    await withTokenScopedRepo("stSoftwareAU/Prompts", () => {
      inside = installationTokenRepoScope();
      writable = isWriteRepoAllowed("stSoftwareAU/Prompts");
      return Promise.resolve();
    });
    assertEquals(inside, ["stSoftwareAU/Prompts", "stSoftwareAU/VibeCoder"]);
    assertEquals(writable, false, "a read grant must not permit writes");
    assertEquals(
      installationTokenRepoScope(),
      ["stSoftwareAU/VibeCoder"],
      "the grant must be released when the call settles",
    );
  });
});

Deno.test("installation token scope - releases the read grant when the call throws", async () => {
  await withQuietSinks(async () => {
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    await assertRejects(
      () =>
        withTokenScopedRepo("stSoftwareAU/Prompts", () => {
          throw new Error("probe failed");
        }),
      Error,
      "probe failed",
    );
    assertEquals(installationTokenRepoScope(), ["stSoftwareAU/VibeCoder"]);
  });
});
