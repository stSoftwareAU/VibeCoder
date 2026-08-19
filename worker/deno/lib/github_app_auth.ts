/**
 * GitHub App JWT and installation token generation.
 *
 * Issue #958: Creates short-lived installation access tokens from the
 * GitHub App private key. Tokens auto-rotate — no manual refresh needed.
 *
 * Uses Deno's built-in Web Crypto API (RS256) — no external dependencies.
 * Australian English spelling throughout (behaviour, authorisation, etc.)
 */

import type { Logger } from "../types.ts";
import { defaultLogger } from "./logger.ts";
import { fetchWithTimeout } from "./subprocess_timeout.ts";

/** Timeout for GitHub API fetch calls: 30 seconds. */
const GITHUB_API_TIMEOUT_MS = 30_000;

/** Function signature for fetch — injectable for testing. */
export type FetchFn = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Cached installation token with its expiry. */
interface CachedToken {
  token: string;
  expiresAt: Date;
}

/** In-memory token cache. */
let cachedToken: CachedToken | null = null;

/** Refresh buffer — refresh token if it expires within this many ms. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Reset the in-memory token cache.
 * Exposed for testing only.
 */
export function resetTokenCache(): void {
  cachedToken = null;
}

/**
 * Generate a JWT from the App private key (RS256).
 *
 * Uses Deno's built-in Web Crypto API — no external dependencies.
 *
 * @param appId - The GitHub App ID (issuer)
 * @param privateKeyPem - PEM-encoded RSA private key string
 * @returns Signed JWT string
 */
export async function generateAppJWT(
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  if (!appId || appId.trim() === "") {
    throw new Error("appId must not be empty");
  }

  const cryptoKey = await importPrivateKey(privateKeyPem);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: appId,
    iat: now - 60,
    exp: now + 600,
  };

  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  const encodedSignature = arrayBufferToBase64url(signature);
  return `${signingInput}.${encodedSignature}`;
}

/**
 * Exchange the JWT for an installation access token.
 *
 * Makes a single API call to GitHub:
 *   POST /app/installations/{id}/access_tokens
 *
 * @param jwt - Signed JWT from generateAppJWT
 * @param installationId - GitHub App installation ID
 * @param fetchFn - Optional fetch function (injectable for testing)
 * @returns Token string and expiry timestamp
 */
export async function getInstallationToken(
  jwt: string,
  installationId: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<{ token: string; expiresAt: Date }> {
  if (!installationId || installationId.trim() === "") {
    throw new Error("installationId must not be empty");
  }

  const url =
    `https://api.github.com/app/installations/${installationId}/access_tokens`;

  const fetchInit: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };

  const response = fetchFn === globalThis.fetch
    ? await fetchWithTimeout(url, fetchInit, GITHUB_API_TIMEOUT_MS)
    : await fetchFn(url, fetchInit);

  if (response.status !== 201) {
    const body = await response.text();
    throw new Error(
      `GitHub API returned ${response.status} exchanging JWT for installation token: ${body}`,
    );
  }

  const data = await response.json();
  if (!data.token || typeof data.token !== "string") {
    throw new Error(
      "GitHub API response missing token field in installation token exchange",
    );
  }
  if (!data.expires_at) {
    throw new Error(
      "GitHub API response missing expires_at field in installation token exchange",
    );
  }

  return {
    token: data.token,
    expiresAt: new Date(data.expires_at),
  };
}

/**
 * High-level: get a valid installation token, refreshing if needed.
 *
 * Caches the token in memory and only refreshes when the cached token
 * expires within 5 minutes (the refresh buffer).
 *
 * @param appId - The GitHub App ID
 * @param installationId - GitHub App installation ID
 * @param privateKeyPath - File system path to the PEM private key
 * @param fetchFn - Optional fetch function (injectable for testing)
 * @returns Valid installation access token string
 */
export async function ensureValidToken(
  appId: string,
  installationId: string,
  privateKeyPath: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<string> {
  // Return cached token if still valid (not expiring within the buffer)
  if (cachedToken !== null) {
    const msUntilExpiry = cachedToken.expiresAt.getTime() - Date.now();
    if (msUntilExpiry > REFRESH_BUFFER_MS) {
      return cachedToken.token;
    }
  }

  // Read private key from disk
  let pemContents: string;
  try {
    pemContents = await Deno.readTextFile(privateKeyPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to read private key file at ${privateKeyPath}: ${message}`,
    );
  }

  if (!pemContents || pemContents.trim() === "") {
    throw new Error(
      `private key file at ${privateKeyPath} is empty`,
    );
  }

  // Generate JWT and exchange for installation token
  const jwt = await generateAppJWT(appId, pemContents);
  const result = await getInstallationToken(jwt, installationId, fetchFn);

  // Cache the new token
  cachedToken = { token: result.token, expiresAt: result.expiresAt };

  return result.token;
}

// =============================================================================
// Configuration Check and Subprocess Token Helper
// =============================================================================

/**
 * Fully-configured GitHub App credentials — all three values present.
 *
 * The narrowed result of {@link isGitHubAppConfigured}: callers that pass the
 * guard can read these fields as `string` without non-null assertions.
 */
export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKeyPath: string;
}

/** Possibly-incomplete GitHub App credentials, as read from args/env. */
export interface MaybeGitHubAppConfig {
  appId?: string | null;
  installationId?: string | null;
  privateKeyPath?: string | null;
}

/**
 * Check whether GitHub App authentication is configured.
 *
 * Returns true only if all three required values are non-empty strings.
 * Issue #959: Used by gh_auth.ts and commands/github_app_auth.ts.
 *
 * Issue #2795: This is a type predicate (`config is GitHubAppConfig`), so a
 * caller inside the `true` branch reads `config.appId` etc. as `string`
 * without non-null assertions — the invariant is verified by the compiler
 * rather than asserted away.
 */
export function isGitHubAppConfigured(
  config: MaybeGitHubAppConfig,
): config is GitHubAppConfig {
  return !!(
    config.appId && config.appId.trim() !== "" &&
    config.installationId && config.installationId.trim() !== "" &&
    config.privateKeyPath && config.privateKeyPath.trim() !== ""
  );
}

/** Name of the security event emitted when App auth degrades to ambient auth. */
export const APP_AUTH_FALLBACK_EVENT = "GITHUB_APP_AUTH_FALLBACK";

/** Minimal logger surface needed to announce an authentication degradation. */
export type AuthEventLogger = Pick<Logger, "security">;

/**
 * Get a GitHub App installation token for injection into subprocess env.
 *
 * Returns a token string if GitHub App is configured and token generation
 * succeeds, or undefined if not configured or if token generation fails.
 *
 * Issue #959: Used by gh_wrapper.ts and github.ts to inject GH_TOKEN.
 *
 * Issue #3644: a minting failure is never swallowed. Both callers treat
 * `undefined` as "App not configured" and fall back to ambient `gh` auth,
 * so a failure here silently re-credentials every later call as whatever
 * token sits in `GH_CONFIG_DIR` — the exact drift `identity_guard.ts`
 * exists to catch. The degradation is therefore announced as a `[SECURITY]`
 * event so it is visible in the run log and reconstructable afterwards.
 *
 * @param logger - Sink for the fallback security event (injectable for testing)
 */
export async function getGhTokenForSubprocess(
  appId?: string,
  installationId?: string,
  privateKeyPath?: string,
  logger: AuthEventLogger = defaultLogger,
): Promise<string | undefined> {
  const config = { appId, installationId, privateKeyPath };
  if (!isGitHubAppConfigured(config)) {
    // Not configured is a deliberate operator choice, not a failure — the
    // caller is meant to use ambient auth, so there is nothing to report.
    return undefined;
  }

  try {
    return await ensureValidToken(
      config.appId,
      config.installationId,
      config.privateKeyPath,
    );
  } catch (err) {
    // The guard above established the App IS configured, so reaching here is
    // a genuine failure — unreadable or malformed PEM, clock skew, a 401/5xx
    // on the installation-token exchange — not "App not configured".
    const message = err instanceof Error ? err.message : String(err);
    logger.security(
      APP_AUTH_FALLBACK_EVENT,
      `GitHub App token minting failed (appId=${config.appId} ` +
        `installationId=${config.installationId}); falling back to ambient gh ` +
        `authentication, so subsequent calls may run as a different identity ` +
        `with broader permissions. Cause: ${message}`,
    );
    return undefined;
  }
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Import a PEM-encoded RSA private key as a CryptoKey for RS256 signing.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Strip PEM headers/footers and whitespace
  const pemHeader = "-----BEGIN RSA PRIVATE KEY-----";
  const pemFooter = "-----END RSA PRIVATE KEY-----";

  // Support both PKCS#1 and PKCS#8 formats
  const isPkcs1 = pem.includes(pemHeader);
  const isPkcs8 = pem.includes("-----BEGIN PRIVATE KEY-----");

  if (!isPkcs1 && !isPkcs8) {
    throw new Error(
      "Invalid private key PEM format: expected RSA PRIVATE KEY or PRIVATE KEY header",
    );
  }

  let b64: string;
  let format: "pkcs1" | "pkcs8";

  if (isPkcs8) {
    b64 = pem
      .replace("-----BEGIN PRIVATE KEY-----", "")
      .replace("-----END PRIVATE KEY-----", "")
      .replace(/\s/g, "");
    format = "pkcs8";
  } else {
    b64 = pem
      .replace(pemHeader, "")
      .replace(pemFooter, "")
      .replace(/\s/g, "");
    format = "pkcs1";
  }

  const binaryString = atob(b64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  try {
    // PKCS#1 keys need to be imported as "pkcs8" isn't correct for them.
    // Deno's Web Crypto only supports PKCS#8 for importKey. We need to
    // wrap PKCS#1 in a PKCS#8 envelope.
    const keyData = format === "pkcs1" ? wrapPkcs1InPkcs8(bytes) : bytes;

    return await crypto.subtle.importKey(
      "pkcs8",
      keyData.buffer as ArrayBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to import private key: ${message}`);
  }
}

/**
 * Wrap a PKCS#1 RSA private key in a PKCS#8 envelope.
 *
 * PKCS#8 wraps the PKCS#1 key with an AlgorithmIdentifier for RSA.
 * This is needed because Web Crypto's importKey only accepts PKCS#8.
 */
function wrapPkcs1InPkcs8(pkcs1Bytes: Uint8Array): Uint8Array {
  // PKCS#8 header for RSA (OID 1.2.840.113549.1.1.1)
  // SEQUENCE {
  //   INTEGER 0 (version)
  //   SEQUENCE { OID rsaEncryption, NULL }
  //   OCTET STRING { <pkcs1 key bytes> }
  // }

  // The AlgorithmIdentifier for RSA
  const rsaOid = new Uint8Array([
    0x30,
    0x0d, // SEQUENCE, 13 bytes
    0x06,
    0x09, // OID, 9 bytes
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01, // 1.2.840.113549.1.1.1
    0x05,
    0x00, // NULL
  ]);

  // Version INTEGER 0
  const version = new Uint8Array([0x02, 0x01, 0x00]);

  // OCTET STRING wrapping the PKCS#1 key
  const octetString = wrapAsn1(0x04, pkcs1Bytes);

  // Inner SEQUENCE contents: version + algorithmId + octetString
  const innerContents = concatBytes(version, rsaOid, octetString);

  // Outer SEQUENCE
  return wrapAsn1(0x30, innerContents);
}

/** Wrap bytes in an ASN.1 TLV (tag-length-value). */
function wrapAsn1(tag: number, value: Uint8Array): Uint8Array {
  const length = encodeAsn1Length(value.length);
  const result = new Uint8Array(1 + length.length + value.length);
  result[0] = tag;
  result.set(length, 1);
  result.set(value, 1 + length.length);
  return result;
}

/** Encode an ASN.1 length using DER rules. */
function encodeAsn1Length(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  const bytes: number[] = [];
  let temp = length;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

/** Concatenate multiple Uint8Arrays. */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/** Base64url-encode a string (no padding). */
function base64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  return arrayBufferToBase64url(bytes.buffer);
}

/** Convert an ArrayBuffer to a base64url string (no padding). */
function arrayBufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
