/**
 * GitHub App JWT and installation token generation.
 *
 * Issue #958: Creates short-lived installation access tokens from the
 * GitHub App private key. Tokens auto-rotate — no manual refresh needed.
 *
 * Issue #1391: a token may also be **scoped to a set of repositories**. An
 * installation token minted with no body carries the App's permissions on
 * *every* repository the installation covers — a whole organisation, for a
 * run that is only ever meant to write to one repo. `write_repo_allowlist.ts`
 * contains that blast radius in code; the repository scope contains it in the
 * credential itself, so a write that slips past the code layer is refused by
 * GitHub rather than performed. Callers pass `owner/repo` slugs; the API takes
 * bare names resolved against the installation's account, and
 * {@link installationRepoNames} is the one place that conversion happens.
 *
 * Issue #4572: a token may also be **limited to a set of permissions**. The
 * `permissions` field caps what the token can do (e.g. read-only), so a
 * credential given to an agent that only reads cannot write, even inside its
 * repository. Its request body is built from whichever of the two fields are
 * present.
 *
 * Uses Deno's built-in Web Crypto API (RS256) — no external dependencies.
 * Australian English spelling throughout (behaviour, authorisation, etc.)
 */ import { defaultLogger } from "./logger.ts";
import { fetchWithTimeout } from "./subprocess_timeout.ts";
/** Timeout for GitHub API fetch calls: 30 seconds. */ const GITHUB_API_TIMEOUT_MS = 30_000;
/** Max characters of a token-exchange error body kept in the thrown message. */ const TOKEN_EXCHANGE_ERROR_BODY_LIMIT = 400;
/** Marker appended when a token-exchange error body is truncated. */ const TOKEN_EXCHANGE_ERROR_BODY_ELISION = "…[truncated]";
/**
 * In-memory token cache, keyed by minting identity **and** repository scope.
 *
 * A map rather than a single entry because concurrent slots (Issue #4175) each
 * hold their own write-repo allowlist, so two live claims legitimately need two
 * differently-scoped tokens; a single entry would be re-minted on every `gh`
 * call as the slots alternated.
 */ const tokenCache = new Map();
/**
 * Distinct (identity, scope) tokens kept in memory at once.
 *
 * Bounded so a long-lived process cannot accumulate credentials: well above
 * the handful of concurrent slots a host runs, far below unbounded growth.
 */ const TOKEN_CACHE_LIMIT = 16;
/** Refresh buffer — refresh token if it expires within this many ms. */ const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Reset the in-memory token cache.
 *
 * Discards every entry — token, expiry, minting identity and scope — so a
 * reset can never leave a stale identity behind. Exposed for testing only.
 */ export function resetTokenCache() {
  tokenCache.clear();
}
/**
 * The cache key for one minting identity and repository scope.
 *
 * `null`/`undefined` scope is the unscoped token and gets its own key, so an
 * unscoped entry can never satisfy a scoped request (or the reverse).
 */ function tokenCacheKey(appId, installationId, repositories) {
  const scope = repositories === null || repositories === undefined ? "*" : JSON.stringify(installationRepoNames(repositories));
  return JSON.stringify([
    appId,
    installationId,
    scope
  ]);
}
/** Drop expired entries, then evict the soonest-expiring while over the cap. */ function pruneTokenCache() {
  const now = Date.now();
  for (const [key, entry] of tokenCache){
    if (entry.expiresAt.getTime() <= now) tokenCache.delete(key);
  }
  while(tokenCache.size > TOKEN_CACHE_LIMIT){
    let oldestKey;
    let oldestAt = Infinity;
    for (const [key, entry] of tokenCache){
      const at = entry.expiresAt.getTime();
      if (at < oldestAt) {
        oldestAt = at;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) return;
    tokenCache.delete(oldestKey);
  }
}
/**
 * Convert `owner/repo` slugs to the bare repository names the API expects.
 *
 * GitHub resolves the `repositories` field against the installation's own
 * account, so only the name after the owner is sent. The result is
 * de-duplicated and sorted, which also makes it a stable cache key.
 *
 * Fails loud on anything that is not exactly `owner/repo` (Issue #1391): a
 * malformed slug silently dropped from the scope would widen — or wrongly
 * narrow — the credential, and neither may pass as success.
 *
 * @param repositories - `owner/repo` slugs the token may reach.
 * @throws Error when a slug is blank or is not of the form `owner/repo`.
 */ export function installationRepoNames(repositories) {
  const names = new Set();
  for (const slug of repositories){
    const parts = slug.trim().split("/");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
      throw new Error(`Cannot scope an installation token to '${slug}': expected owner/repo`);
    }
    names.add(parts[1]);
  }
  return [
    ...names
  ].sort();
}
/**
 * Generate a JWT from the App private key (RS256).
 *
 * Uses Deno's built-in Web Crypto API — no external dependencies.
 *
 * @param appId - The GitHub App ID (issuer)
 * @param privateKeyPem - PEM-encoded RSA private key string
 * @returns Signed JWT string
 */ export async function generateAppJWT(appId, privateKeyPem) {
  if (!appId || appId.trim() === "") {
    throw new Error("appId must not be empty");
  }
  const cryptoKey = await importPrivateKey(privateKeyPem);
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT"
  };
  const payload = {
    iss: appId,
    iat: now - 60,
    exp: now + 600
  };
  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign({
    name: "RSASSA-PKCS1-v1_5"
  }, cryptoKey, new TextEncoder().encode(signingInput));
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
 * @param repositories - `owner/repo` slugs the token may reach (Issue #1391).
 *   Omitted or `null` mints the installation's full, unscoped reach.
 * @param permissions - Permissions to cap the token at, as GitHub names them
 *   (e.g. `{ contents: "read" }`) (Issue #4572). Omitted keeps GitHub's default
 *   of the App's full permissions. An empty object is refused, because GitHub
 *   would then mint the full-permission token.
 * @returns Token string, expiry timestamp, and the permissions GitHub granted
 *   the token (Issue #2892: callers that need specific scopes check these
 *   rather than discovering a gap only when a later API call is refused)
 * @throws Error when the repository or permission scope is present but empty,
 *   or holds a malformed slug
 */ export async function getInstallationToken(jwt, installationId, fetchFn = globalThis.fetch, repositories = undefined, permissions) {
  if (!installationId || installationId.trim() === "") {
    throw new Error("installationId must not be empty");
  }
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  // A caller that asked for a scope but named no repository wants a token that
  // may write nowhere. GitHub has no spelling for that, and minting the
  // unscoped token instead would hand back the widest credential in answer to
  // the narrowest request — so refuse rather than silently widen.
  const requestFields = {};
  if (repositories !== null && repositories !== undefined) {
    const names = installationRepoNames(repositories);
    if (names.length === 0) {
      throw new Error("Refusing to mint an installation token for an empty repository scope");
    }
    requestFields.repositories = names;
  }
  // Issue #4572: an empty permission object would make GitHub mint the
  // full-permission token, so it is refused for the same reason as above.
  if (permissions !== undefined) {
    if (Object.keys(permissions).length === 0) {
      throw new Error("Refusing to mint an installation token for an empty permission scope");
    }
    requestFields.permissions = permissions;
  }
  let body;
  if (Object.keys(requestFields).length > 0) {
    body = JSON.stringify(requestFields);
    headers["Content-Type"] = "application/json";
  }
  const fetchInit = {
    method: "POST",
    headers,
    ...body === undefined ? {} : {
      body
    }
  };
  const response = fetchFn === globalThis.fetch ? await fetchWithTimeout(url, fetchInit, GITHUB_API_TIMEOUT_MS) : await fetchFn(url, fetchInit);
  if (response.status !== 201) {
    const body = await response.text();
    throw new Error(`GitHub API returned ${response.status} exchanging JWT for installation token: ` + summariseTokenExchangeErrorBody(body));
  }
  const data = await response.json();
  if (!data.token || typeof data.token !== "string") {
    throw new Error("GitHub API response missing token field in installation token exchange");
  }
  if (!data.expires_at) {
    throw new Error("GitHub API response missing expires_at field in installation token exchange");
  }
  return {
    token: data.token,
    expiresAt: new Date(data.expires_at),
    permissions: data.permissions && typeof data.permissions === "object" ? data.permissions : undefined
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
 * @param repositories - `owner/repo` slugs the token may reach (Issue #1391).
 *   Part of the cache key, so a narrower scope never reuses a wider token.
 * @returns Valid installation access token string
 */ export async function ensureValidToken(appId, installationId, privateKeyPath, fetchFn = globalThis.fetch, repositories = undefined) {
  // Return cached token only when it was minted for THIS identity and THIS
  // repository scope, and is still valid (not expiring within the buffer).
  // Any mismatch is a cache miss and falls through to a fresh mint below.
  const cacheKey = tokenCacheKey(appId, installationId, repositories);
  const cachedToken = tokenCache.get(cacheKey);
  if (cachedToken !== undefined) {
    const msUntilExpiry = cachedToken.expiresAt.getTime() - Date.now();
    if (msUntilExpiry > REFRESH_BUFFER_MS) {
      return cachedToken.token;
    }
  }
  // Read private key from disk
  let pemContents;
  try {
    pemContents = await Deno.readTextFile(privateKeyPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read private key file at ${privateKeyPath}: ${message}`);
  }
  if (!pemContents || pemContents.trim() === "") {
    throw new Error(`private key file at ${privateKeyPath} is empty`);
  }
  // Generate JWT and exchange for installation token
  const jwt = await generateAppJWT(appId, pemContents);
  const result = await getInstallationToken(jwt, installationId, fetchFn, repositories);
  // Cache the new token under the identity and scope it was minted for
  tokenCache.set(cacheKey, {
    token: result.token,
    expiresAt: result.expiresAt
  });
  pruneTokenCache();
  return result.token;
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
 */ export function isGitHubAppConfigured(config) {
  return !!(config.appId && config.appId.trim() !== "" && config.installationId && config.installationId.trim() !== "" && config.privateKeyPath && config.privateKeyPath.trim() !== "");
}
/** Name of the security event emitted when App auth degrades to ambient auth. */ export const APP_AUTH_FALLBACK_EVENT = "GITHUB_APP_AUTH_FALLBACK";
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
 * @param repositories - `owner/repo` slugs the token may reach (Issue #1391).
 *   `gh_spawn.ts` derives this from the run's write-repo allowlist, so the
 *   credential the subprocess receives cannot reach a repo the run may not
 *   write to. `null`/omitted keeps the installation's full reach.
 */ export async function getGhTokenForSubprocess(appId, installationId, privateKeyPath, logger = defaultLogger, repositories = undefined) {
  const config = {
    appId,
    installationId,
    privateKeyPath
  };
  if (!isGitHubAppConfigured(config)) {
    // Not configured is a deliberate operator choice, not a failure — the
    // caller is meant to use ambient auth, so there is nothing to report.
    return undefined;
  }
  try {
    return await ensureValidToken(config.appId, config.installationId, config.privateKeyPath, globalThis.fetch, repositories);
  } catch (err) {
    // The guard above established the App IS configured, so reaching here is
    // a genuine failure — unreadable or malformed PEM, clock skew, a 401/5xx
    // on the installation-token exchange — not "App not configured".
    const message = err instanceof Error ? err.message : String(err);
    logger.security(APP_AUTH_FALLBACK_EVENT, `GitHub App token minting failed (appId=${config.appId} ` + `installationId=${config.installationId} scope=${repositories === null || repositories === undefined ? "<unscoped>" : repositories.join(",")}); falling back to ambient gh ` + `authentication, so subsequent calls may run as a different identity ` + `with broader permissions. Cause: ${message}`);
    return undefined;
  }
}
// =============================================================================
// Internal Helpers
// =============================================================================
/**
 * Summarise a GitHub token-exchange error body for interpolation into a
 * thrown Error (Issue #197).
 *
 * Prefer the structured `message` field when the body is JSON and that
 * field is a string; otherwise fall back to a truncated raw snippet.
 * Never throws — a parse failure must not mask the original HTTP status.
 */ function summariseTokenExchangeErrorBody(body) {
  const trimmed = body.trim();
  if (trimmed !== "") {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string") {
        return truncateTokenExchangeErrorBody(parsed.message);
      }
    } catch  {
    // Non-JSON body — fall through to the truncated raw text.
    }
  }
  return truncateTokenExchangeErrorBody(body);
}
/** Truncate an error-body snippet and mark the elision explicitly. */ function truncateTokenExchangeErrorBody(text) {
  if (text.length <= TOKEN_EXCHANGE_ERROR_BODY_LIMIT) {
    return text;
  }
  return text.slice(0, TOKEN_EXCHANGE_ERROR_BODY_LIMIT) + TOKEN_EXCHANGE_ERROR_BODY_ELISION;
}
/**
 * Import a PEM-encoded RSA private key as a CryptoKey for RS256 signing.
 */ async function importPrivateKey(pem) {
  // Strip PEM headers/footers and whitespace
  const pemHeader = "-----BEGIN RSA PRIVATE KEY-----";
  const pemFooter = "-----END RSA PRIVATE KEY-----";
  // Support both PKCS#1 and PKCS#8 formats
  const isPkcs1 = pem.includes(pemHeader);
  const isPkcs8 = pem.includes("-----BEGIN PRIVATE KEY-----");
  if (!isPkcs1 && !isPkcs8) {
    throw new Error("Invalid private key PEM format: expected RSA PRIVATE KEY or PRIVATE KEY header");
  }
  let b64;
  let format;
  if (isPkcs8) {
    b64 = pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
    format = "pkcs8";
  } else {
    b64 = pem.replace(pemHeader, "").replace(pemFooter, "").replace(/\s/g, "");
    format = "pkcs1";
  }
  const binaryString = atob(b64);
  const bytes = new Uint8Array(binaryString.length);
  for(let i = 0; i < binaryString.length; i++){
    bytes[i] = binaryString.charCodeAt(i);
  }
  try {
    // PKCS#1 keys need to be imported as "pkcs8" isn't correct for them.
    // Deno's Web Crypto only supports PKCS#8 for importKey. We need to
    // wrap PKCS#1 in a PKCS#8 envelope.
    const keyData = format === "pkcs1" ? wrapPkcs1InPkcs8(bytes) : bytes;
    return await crypto.subtle.importKey("pkcs8", keyData.buffer, {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    }, false, [
      "sign"
    ]);
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
 */ function wrapPkcs1InPkcs8(pkcs1Bytes) {
  // PKCS#8 header for RSA (OID 1.2.840.113549.1.1.1)
  // SEQUENCE {
  //   INTEGER 0 (version)
  //   SEQUENCE { OID rsaEncryption, NULL }
  //   OCTET STRING { <pkcs1 key bytes> }
  // }
  // The AlgorithmIdentifier for RSA
  const rsaOid = new Uint8Array([
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00
  ]);
  // Version INTEGER 0
  const version = new Uint8Array([
    0x02,
    0x01,
    0x00
  ]);
  // OCTET STRING wrapping the PKCS#1 key
  const octetString = wrapAsn1(0x04, pkcs1Bytes);
  // Inner SEQUENCE contents: version + algorithmId + octetString
  const innerContents = concatBytes(version, rsaOid, octetString);
  // Outer SEQUENCE
  return wrapAsn1(0x30, innerContents);
}
/** Wrap bytes in an ASN.1 TLV (tag-length-value). */ function wrapAsn1(tag, value) {
  const length = encodeAsn1Length(value.length);
  const result = new Uint8Array(1 + length.length + value.length);
  result[0] = tag;
  result.set(length, 1);
  result.set(value, 1 + length.length);
  return result;
}
/** Encode an ASN.1 length using DER rules. */ function encodeAsn1Length(length) {
  if (length < 0x80) {
    return new Uint8Array([
      length
    ]);
  }
  const bytes = [];
  let temp = length;
  while(temp > 0){
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return new Uint8Array([
    0x80 | bytes.length,
    ...bytes
  ]);
}
/** Concatenate multiple Uint8Arrays. */ function concatBytes(...arrays) {
  const totalLength = arrays.reduce((sum, a)=>sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays){
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
/** Base64url-encode a string (no padding). */ function base64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  return arrayBufferToBase64url(bytes.buffer);
}
/** Convert an ArrayBuffer to a base64url string (no padding). */ function arrayBufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for(let i = 0; i < bytes.length; i++){
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRodWJfYXBwX2F1dGgudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBHaXRIdWIgQXBwIEpXVCBhbmQgaW5zdGFsbGF0aW9uIHRva2VuIGdlbmVyYXRpb24uXG4gKlxuICogSXNzdWUgIzk1ODogQ3JlYXRlcyBzaG9ydC1saXZlZCBpbnN0YWxsYXRpb24gYWNjZXNzIHRva2VucyBmcm9tIHRoZVxuICogR2l0SHViIEFwcCBwcml2YXRlIGtleS4gVG9rZW5zIGF1dG8tcm90YXRlIOKAlCBubyBtYW51YWwgcmVmcmVzaCBuZWVkZWQuXG4gKlxuICogSXNzdWUgIzEzOTE6IGEgdG9rZW4gbWF5IGFsc28gYmUgKipzY29wZWQgdG8gYSBzZXQgb2YgcmVwb3NpdG9yaWVzKiouIEFuXG4gKiBpbnN0YWxsYXRpb24gdG9rZW4gbWludGVkIHdpdGggbm8gYm9keSBjYXJyaWVzIHRoZSBBcHAncyBwZXJtaXNzaW9ucyBvblxuICogKmV2ZXJ5KiByZXBvc2l0b3J5IHRoZSBpbnN0YWxsYXRpb24gY292ZXJzIOKAlCBhIHdob2xlIG9yZ2FuaXNhdGlvbiwgZm9yIGFcbiAqIHJ1biB0aGF0IGlzIG9ubHkgZXZlciBtZWFudCB0byB3cml0ZSB0byBvbmUgcmVwby4gYHdyaXRlX3JlcG9fYWxsb3dsaXN0LnRzYFxuICogY29udGFpbnMgdGhhdCBibGFzdCByYWRpdXMgaW4gY29kZTsgdGhlIHJlcG9zaXRvcnkgc2NvcGUgY29udGFpbnMgaXQgaW4gdGhlXG4gKiBjcmVkZW50aWFsIGl0c2VsZiwgc28gYSB3cml0ZSB0aGF0IHNsaXBzIHBhc3QgdGhlIGNvZGUgbGF5ZXIgaXMgcmVmdXNlZCBieVxuICogR2l0SHViIHJhdGhlciB0aGFuIHBlcmZvcm1lZC4gQ2FsbGVycyBwYXNzIGBvd25lci9yZXBvYCBzbHVnczsgdGhlIEFQSSB0YWtlc1xuICogYmFyZSBuYW1lcyByZXNvbHZlZCBhZ2FpbnN0IHRoZSBpbnN0YWxsYXRpb24ncyBhY2NvdW50LCBhbmRcbiAqIHtAbGluayBpbnN0YWxsYXRpb25SZXBvTmFtZXN9IGlzIHRoZSBvbmUgcGxhY2UgdGhhdCBjb252ZXJzaW9uIGhhcHBlbnMuXG4gKlxuICogSXNzdWUgIzQ1NzI6IGEgdG9rZW4gbWF5IGFsc28gYmUgKipsaW1pdGVkIHRvIGEgc2V0IG9mIHBlcm1pc3Npb25zKiouIFRoZVxuICogYHBlcm1pc3Npb25zYCBmaWVsZCBjYXBzIHdoYXQgdGhlIHRva2VuIGNhbiBkbyAoZS5nLiByZWFkLW9ubHkpLCBzbyBhXG4gKiBjcmVkZW50aWFsIGdpdmVuIHRvIGFuIGFnZW50IHRoYXQgb25seSByZWFkcyBjYW5ub3Qgd3JpdGUsIGV2ZW4gaW5zaWRlIGl0c1xuICogcmVwb3NpdG9yeS4gSXRzIHJlcXVlc3QgYm9keSBpcyBidWlsdCBmcm9tIHdoaWNoZXZlciBvZiB0aGUgdHdvIGZpZWxkcyBhcmVcbiAqIHByZXNlbnQuXG4gKlxuICogVXNlcyBEZW5vJ3MgYnVpbHQtaW4gV2ViIENyeXB0byBBUEkgKFJTMjU2KSDigJQgbm8gZXh0ZXJuYWwgZGVwZW5kZW5jaWVzLlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgYXV0aG9yaXNhdGlvbiwgZXRjLilcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IExvZ2dlciB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgZGVmYXVsdExvZ2dlciB9IGZyb20gXCIuL2xvZ2dlci50c1wiO1xuaW1wb3J0IHsgZmV0Y2hXaXRoVGltZW91dCB9IGZyb20gXCIuL3N1YnByb2Nlc3NfdGltZW91dC50c1wiO1xuXG4vKiogVGltZW91dCBmb3IgR2l0SHViIEFQSSBmZXRjaCBjYWxsczogMzAgc2Vjb25kcy4gKi9cbmNvbnN0IEdJVEhVQl9BUElfVElNRU9VVF9NUyA9IDMwXzAwMDtcblxuLyoqIE1heCBjaGFyYWN0ZXJzIG9mIGEgdG9rZW4tZXhjaGFuZ2UgZXJyb3IgYm9keSBrZXB0IGluIHRoZSB0aHJvd24gbWVzc2FnZS4gKi9cbmNvbnN0IFRPS0VOX0VYQ0hBTkdFX0VSUk9SX0JPRFlfTElNSVQgPSA0MDA7XG5cbi8qKiBNYXJrZXIgYXBwZW5kZWQgd2hlbiBhIHRva2VuLWV4Y2hhbmdlIGVycm9yIGJvZHkgaXMgdHJ1bmNhdGVkLiAqL1xuY29uc3QgVE9LRU5fRVhDSEFOR0VfRVJST1JfQk9EWV9FTElTSU9OID0gXCLigKZbdHJ1bmNhdGVkXVwiO1xuXG4vKiogRnVuY3Rpb24gc2lnbmF0dXJlIGZvciBmZXRjaCDigJQgaW5qZWN0YWJsZSBmb3IgdGVzdGluZy4gKi9cbmV4cG9ydCB0eXBlIEZldGNoRm4gPSAoXG4gIHVybDogc3RyaW5nIHwgVVJMLFxuICBpbml0PzogUmVxdWVzdEluaXQsXG4pID0+IFByb21pc2U8UmVzcG9uc2U+O1xuXG4vKipcbiAqIENhY2hlZCBpbnN0YWxsYXRpb24gdG9rZW4gd2l0aCBpdHMgZXhwaXJ5LlxuICpcbiAqIElzc3VlICMzOCAoU0VDLTBmN2QzYzlhNGUyMSk6IHRoZSBpZGVudGl0eSBpcyBwYXJ0IG9mIHRoZSBjYWNoZSAqa2V5KiBzbyBhXG4gKiByZXF1ZXN0IGZvciBhIGRpZmZlcmVudCBBcHAgb3IgaW5zdGFsbGF0aW9uIGNhbiBuZXZlciBiZSBzZXJ2ZWQgYW5vdGhlclxuICogaWRlbnRpdHkncyBjcmVkZW50aWFsIOKAlCBhIGNyb3NzLXRlbmFudCBsZWFrIHRoYXQgd291bGQgZmFpbCBzaWxlbnRseS5cbiAqIElzc3VlICMxMzkxIHB1dHMgdGhlIHJlcG9zaXRvcnkgc2NvcGUgaW4gdGhhdCBrZXkgZm9yIHRoZSBzYW1lIHJlYXNvbjogYVxuICogbmFycm93bHktc2NvcGVkIHJ1biBtdXN0IG5ldmVyIGJlIGhhbmRlZCB0aGUgd2lkZXIgdG9rZW4gYSBwcmV2aW91cyBjbGFpbVxuICogbWludGVkLlxuICovXG5pbnRlcmZhY2UgQ2FjaGVkVG9rZW4ge1xuICB0b2tlbjogc3RyaW5nO1xuICBleHBpcmVzQXQ6IERhdGU7XG59XG5cbi8qKlxuICogSW4tbWVtb3J5IHRva2VuIGNhY2hlLCBrZXllZCBieSBtaW50aW5nIGlkZW50aXR5ICoqYW5kKiogcmVwb3NpdG9yeSBzY29wZS5cbiAqXG4gKiBBIG1hcCByYXRoZXIgdGhhbiBhIHNpbmdsZSBlbnRyeSBiZWNhdXNlIGNvbmN1cnJlbnQgc2xvdHMgKElzc3VlICM0MTc1KSBlYWNoXG4gKiBob2xkIHRoZWlyIG93biB3cml0ZS1yZXBvIGFsbG93bGlzdCwgc28gdHdvIGxpdmUgY2xhaW1zIGxlZ2l0aW1hdGVseSBuZWVkIHR3b1xuICogZGlmZmVyZW50bHktc2NvcGVkIHRva2VuczsgYSBzaW5nbGUgZW50cnkgd291bGQgYmUgcmUtbWludGVkIG9uIGV2ZXJ5IGBnaGBcbiAqIGNhbGwgYXMgdGhlIHNsb3RzIGFsdGVybmF0ZWQuXG4gKi9cbmNvbnN0IHRva2VuQ2FjaGUgPSBuZXcgTWFwPHN0cmluZywgQ2FjaGVkVG9rZW4+KCk7XG5cbi8qKlxuICogRGlzdGluY3QgKGlkZW50aXR5LCBzY29wZSkgdG9rZW5zIGtlcHQgaW4gbWVtb3J5IGF0IG9uY2UuXG4gKlxuICogQm91bmRlZCBzbyBhIGxvbmctbGl2ZWQgcHJvY2VzcyBjYW5ub3QgYWNjdW11bGF0ZSBjcmVkZW50aWFsczogd2VsbCBhYm92ZVxuICogdGhlIGhhbmRmdWwgb2YgY29uY3VycmVudCBzbG90cyBhIGhvc3QgcnVucywgZmFyIGJlbG93IHVuYm91bmRlZCBncm93dGguXG4gKi9cbmNvbnN0IFRPS0VOX0NBQ0hFX0xJTUlUID0gMTY7XG5cbi8qKiBSZWZyZXNoIGJ1ZmZlciDigJQgcmVmcmVzaCB0b2tlbiBpZiBpdCBleHBpcmVzIHdpdGhpbiB0aGlzIG1hbnkgbXMuICovXG5jb25zdCBSRUZSRVNIX0JVRkZFUl9NUyA9IDUgKiA2MCAqIDEwMDA7IC8vIDUgbWludXRlc1xuXG4vKipcbiAqIFJlc2V0IHRoZSBpbi1tZW1vcnkgdG9rZW4gY2FjaGUuXG4gKlxuICogRGlzY2FyZHMgZXZlcnkgZW50cnkg4oCUIHRva2VuLCBleHBpcnksIG1pbnRpbmcgaWRlbnRpdHkgYW5kIHNjb3BlIOKAlCBzbyBhXG4gKiByZXNldCBjYW4gbmV2ZXIgbGVhdmUgYSBzdGFsZSBpZGVudGl0eSBiZWhpbmQuIEV4cG9zZWQgZm9yIHRlc3Rpbmcgb25seS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc2V0VG9rZW5DYWNoZSgpOiB2b2lkIHtcbiAgdG9rZW5DYWNoZS5jbGVhcigpO1xufVxuXG4vKipcbiAqIFRoZSBjYWNoZSBrZXkgZm9yIG9uZSBtaW50aW5nIGlkZW50aXR5IGFuZCByZXBvc2l0b3J5IHNjb3BlLlxuICpcbiAqIGBudWxsYC9gdW5kZWZpbmVkYCBzY29wZSBpcyB0aGUgdW5zY29wZWQgdG9rZW4gYW5kIGdldHMgaXRzIG93biBrZXksIHNvIGFuXG4gKiB1bnNjb3BlZCBlbnRyeSBjYW4gbmV2ZXIgc2F0aXNmeSBhIHNjb3BlZCByZXF1ZXN0IChvciB0aGUgcmV2ZXJzZSkuXG4gKi9cbmZ1bmN0aW9uIHRva2VuQ2FjaGVLZXkoXG4gIGFwcElkOiBzdHJpbmcsXG4gIGluc3RhbGxhdGlvbklkOiBzdHJpbmcsXG4gIHJlcG9zaXRvcmllczogUmVwb3NpdG9yeVNjb3BlLFxuKTogc3RyaW5nIHtcbiAgY29uc3Qgc2NvcGUgPSByZXBvc2l0b3JpZXMgPT09IG51bGwgfHwgcmVwb3NpdG9yaWVzID09PSB1bmRlZmluZWRcbiAgICA/IFwiKlwiXG4gICAgOiBKU09OLnN0cmluZ2lmeShpbnN0YWxsYXRpb25SZXBvTmFtZXMocmVwb3NpdG9yaWVzKSk7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeShbYXBwSWQsIGluc3RhbGxhdGlvbklkLCBzY29wZV0pO1xufVxuXG4vKiogRHJvcCBleHBpcmVkIGVudHJpZXMsIHRoZW4gZXZpY3QgdGhlIHNvb25lc3QtZXhwaXJpbmcgd2hpbGUgb3ZlciB0aGUgY2FwLiAqL1xuZnVuY3Rpb24gcHJ1bmVUb2tlbkNhY2hlKCk6IHZvaWQge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBmb3IgKGNvbnN0IFtrZXksIGVudHJ5XSBvZiB0b2tlbkNhY2hlKSB7XG4gICAgaWYgKGVudHJ5LmV4cGlyZXNBdC5nZXRUaW1lKCkgPD0gbm93KSB0b2tlbkNhY2hlLmRlbGV0ZShrZXkpO1xuICB9XG4gIHdoaWxlICh0b2tlbkNhY2hlLnNpemUgPiBUT0tFTl9DQUNIRV9MSU1JVCkge1xuICAgIGxldCBvbGRlc3RLZXk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgb2xkZXN0QXQgPSBJbmZpbml0eTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGVudHJ5XSBvZiB0b2tlbkNhY2hlKSB7XG4gICAgICBjb25zdCBhdCA9IGVudHJ5LmV4cGlyZXNBdC5nZXRUaW1lKCk7XG4gICAgICBpZiAoYXQgPCBvbGRlc3RBdCkge1xuICAgICAgICBvbGRlc3RBdCA9IGF0O1xuICAgICAgICBvbGRlc3RLZXkgPSBrZXk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChvbGRlc3RLZXkgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgIHRva2VuQ2FjaGUuZGVsZXRlKG9sZGVzdEtleSk7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgcmVwb3NpdG9yaWVzIGEgdG9rZW4gbWF5IHJlYWNoOiBgb3duZXIvcmVwb2Agc2x1Z3MsIG9yIGBudWxsYC9gdW5kZWZpbmVkYFxuICogZm9yIGFuIHVuc2NvcGVkIHRva2VuIGNhcnJ5aW5nIHRoZSBpbnN0YWxsYXRpb24ncyBmdWxsIHJlYWNoLlxuICovXG5leHBvcnQgdHlwZSBSZXBvc2l0b3J5U2NvcGUgPSByZWFkb25seSBzdHJpbmdbXSB8IG51bGwgfCB1bmRlZmluZWQ7XG5cbi8qKlxuICogQ29udmVydCBgb3duZXIvcmVwb2Agc2x1Z3MgdG8gdGhlIGJhcmUgcmVwb3NpdG9yeSBuYW1lcyB0aGUgQVBJIGV4cGVjdHMuXG4gKlxuICogR2l0SHViIHJlc29sdmVzIHRoZSBgcmVwb3NpdG9yaWVzYCBmaWVsZCBhZ2FpbnN0IHRoZSBpbnN0YWxsYXRpb24ncyBvd25cbiAqIGFjY291bnQsIHNvIG9ubHkgdGhlIG5hbWUgYWZ0ZXIgdGhlIG93bmVyIGlzIHNlbnQuIFRoZSByZXN1bHQgaXNcbiAqIGRlLWR1cGxpY2F0ZWQgYW5kIHNvcnRlZCwgd2hpY2ggYWxzbyBtYWtlcyBpdCBhIHN0YWJsZSBjYWNoZSBrZXkuXG4gKlxuICogRmFpbHMgbG91ZCBvbiBhbnl0aGluZyB0aGF0IGlzIG5vdCBleGFjdGx5IGBvd25lci9yZXBvYCAoSXNzdWUgIzEzOTEpOiBhXG4gKiBtYWxmb3JtZWQgc2x1ZyBzaWxlbnRseSBkcm9wcGVkIGZyb20gdGhlIHNjb3BlIHdvdWxkIHdpZGVuIOKAlCBvciB3cm9uZ2x5XG4gKiBuYXJyb3cg4oCUIHRoZSBjcmVkZW50aWFsLCBhbmQgbmVpdGhlciBtYXkgcGFzcyBhcyBzdWNjZXNzLlxuICpcbiAqIEBwYXJhbSByZXBvc2l0b3JpZXMgLSBgb3duZXIvcmVwb2Agc2x1Z3MgdGhlIHRva2VuIG1heSByZWFjaC5cbiAqIEB0aHJvd3MgRXJyb3Igd2hlbiBhIHNsdWcgaXMgYmxhbmsgb3IgaXMgbm90IG9mIHRoZSBmb3JtIGBvd25lci9yZXBvYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxhdGlvblJlcG9OYW1lcyhcbiAgcmVwb3NpdG9yaWVzOiByZWFkb25seSBzdHJpbmdbXSxcbik6IHN0cmluZ1tdIHtcbiAgY29uc3QgbmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBzbHVnIG9mIHJlcG9zaXRvcmllcykge1xuICAgIGNvbnN0IHBhcnRzID0gc2x1Zy50cmltKCkuc3BsaXQoXCIvXCIpO1xuICAgIGlmIChwYXJ0cy5sZW5ndGggIT09IDIgfHwgcGFydHNbMF0gPT09IFwiXCIgfHwgcGFydHNbMV0gPT09IFwiXCIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYENhbm5vdCBzY29wZSBhbiBpbnN0YWxsYXRpb24gdG9rZW4gdG8gJyR7c2x1Z30nOiBleHBlY3RlZCBvd25lci9yZXBvYCxcbiAgICAgICk7XG4gICAgfVxuICAgIG5hbWVzLmFkZChwYXJ0c1sxXSEpO1xuICB9XG4gIHJldHVybiBbLi4ubmFtZXNdLnNvcnQoKTtcbn1cblxuLyoqXG4gKiBHZW5lcmF0ZSBhIEpXVCBmcm9tIHRoZSBBcHAgcHJpdmF0ZSBrZXkgKFJTMjU2KS5cbiAqXG4gKiBVc2VzIERlbm8ncyBidWlsdC1pbiBXZWIgQ3J5cHRvIEFQSSDigJQgbm8gZXh0ZXJuYWwgZGVwZW5kZW5jaWVzLlxuICpcbiAqIEBwYXJhbSBhcHBJZCAtIFRoZSBHaXRIdWIgQXBwIElEIChpc3N1ZXIpXG4gKiBAcGFyYW0gcHJpdmF0ZUtleVBlbSAtIFBFTS1lbmNvZGVkIFJTQSBwcml2YXRlIGtleSBzdHJpbmdcbiAqIEByZXR1cm5zIFNpZ25lZCBKV1Qgc3RyaW5nXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZW5lcmF0ZUFwcEpXVChcbiAgYXBwSWQ6IHN0cmluZyxcbiAgcHJpdmF0ZUtleVBlbTogc3RyaW5nLFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgaWYgKCFhcHBJZCB8fCBhcHBJZC50cmltKCkgPT09IFwiXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJhcHBJZCBtdXN0IG5vdCBiZSBlbXB0eVwiKTtcbiAgfVxuXG4gIGNvbnN0IGNyeXB0b0tleSA9IGF3YWl0IGltcG9ydFByaXZhdGVLZXkocHJpdmF0ZUtleVBlbSk7XG5cbiAgY29uc3Qgbm93ID0gTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCk7XG4gIGNvbnN0IGhlYWRlciA9IHsgYWxnOiBcIlJTMjU2XCIsIHR5cDogXCJKV1RcIiB9O1xuICBjb25zdCBwYXlsb2FkID0ge1xuICAgIGlzczogYXBwSWQsXG4gICAgaWF0OiBub3cgLSA2MCxcbiAgICBleHA6IG5vdyArIDYwMCxcbiAgfTtcblxuICBjb25zdCBlbmNvZGVkSGVhZGVyID0gYmFzZTY0dXJsRW5jb2RlKEpTT04uc3RyaW5naWZ5KGhlYWRlcikpO1xuICBjb25zdCBlbmNvZGVkUGF5bG9hZCA9IGJhc2U2NHVybEVuY29kZShKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7XG4gIGNvbnN0IHNpZ25pbmdJbnB1dCA9IGAke2VuY29kZWRIZWFkZXJ9LiR7ZW5jb2RlZFBheWxvYWR9YDtcblxuICBjb25zdCBzaWduYXR1cmUgPSBhd2FpdCBjcnlwdG8uc3VidGxlLnNpZ24oXG4gICAgeyBuYW1lOiBcIlJTQVNTQS1QS0NTMS12MV81XCIgfSxcbiAgICBjcnlwdG9LZXksXG4gICAgbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHNpZ25pbmdJbnB1dCksXG4gICk7XG5cbiAgY29uc3QgZW5jb2RlZFNpZ25hdHVyZSA9IGFycmF5QnVmZmVyVG9CYXNlNjR1cmwoc2lnbmF0dXJlKTtcbiAgcmV0dXJuIGAke3NpZ25pbmdJbnB1dH0uJHtlbmNvZGVkU2lnbmF0dXJlfWA7XG59XG5cbi8qKlxuICogRXhjaGFuZ2UgdGhlIEpXVCBmb3IgYW4gaW5zdGFsbGF0aW9uIGFjY2VzcyB0b2tlbi5cbiAqXG4gKiBNYWtlcyBhIHNpbmdsZSBBUEkgY2FsbCB0byBHaXRIdWI6XG4gKiAgIFBPU1QgL2FwcC9pbnN0YWxsYXRpb25zL3tpZH0vYWNjZXNzX3Rva2Vuc1xuICpcbiAqIEBwYXJhbSBqd3QgLSBTaWduZWQgSldUIGZyb20gZ2VuZXJhdGVBcHBKV1RcbiAqIEBwYXJhbSBpbnN0YWxsYXRpb25JZCAtIEdpdEh1YiBBcHAgaW5zdGFsbGF0aW9uIElEXG4gKiBAcGFyYW0gZmV0Y2hGbiAtIE9wdGlvbmFsIGZldGNoIGZ1bmN0aW9uIChpbmplY3RhYmxlIGZvciB0ZXN0aW5nKVxuICogQHBhcmFtIHJlcG9zaXRvcmllcyAtIGBvd25lci9yZXBvYCBzbHVncyB0aGUgdG9rZW4gbWF5IHJlYWNoIChJc3N1ZSAjMTM5MSkuXG4gKiAgIE9taXR0ZWQgb3IgYG51bGxgIG1pbnRzIHRoZSBpbnN0YWxsYXRpb24ncyBmdWxsLCB1bnNjb3BlZCByZWFjaC5cbiAqIEBwYXJhbSBwZXJtaXNzaW9ucyAtIFBlcm1pc3Npb25zIHRvIGNhcCB0aGUgdG9rZW4gYXQsIGFzIEdpdEh1YiBuYW1lcyB0aGVtXG4gKiAgIChlLmcuIGB7IGNvbnRlbnRzOiBcInJlYWRcIiB9YCkgKElzc3VlICM0NTcyKS4gT21pdHRlZCBrZWVwcyBHaXRIdWIncyBkZWZhdWx0XG4gKiAgIG9mIHRoZSBBcHAncyBmdWxsIHBlcm1pc3Npb25zLiBBbiBlbXB0eSBvYmplY3QgaXMgcmVmdXNlZCwgYmVjYXVzZSBHaXRIdWJcbiAqICAgd291bGQgdGhlbiBtaW50IHRoZSBmdWxsLXBlcm1pc3Npb24gdG9rZW4uXG4gKiBAcmV0dXJucyBUb2tlbiBzdHJpbmcsIGV4cGlyeSB0aW1lc3RhbXAsIGFuZCB0aGUgcGVybWlzc2lvbnMgR2l0SHViIGdyYW50ZWRcbiAqICAgdGhlIHRva2VuIChJc3N1ZSAjMjg5MjogY2FsbGVycyB0aGF0IG5lZWQgc3BlY2lmaWMgc2NvcGVzIGNoZWNrIHRoZXNlXG4gKiAgIHJhdGhlciB0aGFuIGRpc2NvdmVyaW5nIGEgZ2FwIG9ubHkgd2hlbiBhIGxhdGVyIEFQSSBjYWxsIGlzIHJlZnVzZWQpXG4gKiBAdGhyb3dzIEVycm9yIHdoZW4gdGhlIHJlcG9zaXRvcnkgb3IgcGVybWlzc2lvbiBzY29wZSBpcyBwcmVzZW50IGJ1dCBlbXB0eSxcbiAqICAgb3IgaG9sZHMgYSBtYWxmb3JtZWQgc2x1Z1xuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0SW5zdGFsbGF0aW9uVG9rZW4oXG4gIGp3dDogc3RyaW5nLFxuICBpbnN0YWxsYXRpb25JZDogc3RyaW5nLFxuICBmZXRjaEZuOiBGZXRjaEZuID0gZ2xvYmFsVGhpcy5mZXRjaCxcbiAgcmVwb3NpdG9yaWVzOiBSZXBvc2l0b3J5U2NvcGUgPSB1bmRlZmluZWQsXG4gIHBlcm1pc3Npb25zPzogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4sXG4pOiBQcm9taXNlPFxuICB7IHRva2VuOiBzdHJpbmc7IGV4cGlyZXNBdDogRGF0ZTsgcGVybWlzc2lvbnM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IH1cbj4ge1xuICBpZiAoIWluc3RhbGxhdGlvbklkIHx8IGluc3RhbGxhdGlvbklkLnRyaW0oKSA9PT0gXCJcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcImluc3RhbGxhdGlvbklkIG11c3Qgbm90IGJlIGVtcHR5XCIpO1xuICB9XG5cbiAgY29uc3QgdXJsID1cbiAgICBgaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9hcHAvaW5zdGFsbGF0aW9ucy8ke2luc3RhbGxhdGlvbklkfS9hY2Nlc3NfdG9rZW5zYDtcblxuICBjb25zdCBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHtqd3R9YCxcbiAgICBBY2NlcHQ6IFwiYXBwbGljYXRpb24vdm5kLmdpdGh1Yitqc29uXCIsXG4gICAgXCJYLUdpdEh1Yi1BcGktVmVyc2lvblwiOiBcIjIwMjItMTEtMjhcIixcbiAgfTtcblxuICAvLyBBIGNhbGxlciB0aGF0IGFza2VkIGZvciBhIHNjb3BlIGJ1dCBuYW1lZCBubyByZXBvc2l0b3J5IHdhbnRzIGEgdG9rZW4gdGhhdFxuICAvLyBtYXkgd3JpdGUgbm93aGVyZS4gR2l0SHViIGhhcyBubyBzcGVsbGluZyBmb3IgdGhhdCwgYW5kIG1pbnRpbmcgdGhlXG4gIC8vIHVuc2NvcGVkIHRva2VuIGluc3RlYWQgd291bGQgaGFuZCBiYWNrIHRoZSB3aWRlc3QgY3JlZGVudGlhbCBpbiBhbnN3ZXIgdG9cbiAgLy8gdGhlIG5hcnJvd2VzdCByZXF1ZXN0IOKAlCBzbyByZWZ1c2UgcmF0aGVyIHRoYW4gc2lsZW50bHkgd2lkZW4uXG4gIGNvbnN0IHJlcXVlc3RGaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIGlmIChyZXBvc2l0b3JpZXMgIT09IG51bGwgJiYgcmVwb3NpdG9yaWVzICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBuYW1lcyA9IGluc3RhbGxhdGlvblJlcG9OYW1lcyhyZXBvc2l0b3JpZXMpO1xuICAgIGlmIChuYW1lcy5sZW5ndGggPT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJSZWZ1c2luZyB0byBtaW50IGFuIGluc3RhbGxhdGlvbiB0b2tlbiBmb3IgYW4gZW1wdHkgcmVwb3NpdG9yeSBzY29wZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmVxdWVzdEZpZWxkcy5yZXBvc2l0b3JpZXMgPSBuYW1lcztcbiAgfVxuICAvLyBJc3N1ZSAjNDU3MjogYW4gZW1wdHkgcGVybWlzc2lvbiBvYmplY3Qgd291bGQgbWFrZSBHaXRIdWIgbWludCB0aGVcbiAgLy8gZnVsbC1wZXJtaXNzaW9uIHRva2VuLCBzbyBpdCBpcyByZWZ1c2VkIGZvciB0aGUgc2FtZSByZWFzb24gYXMgYWJvdmUuXG4gIGlmIChwZXJtaXNzaW9ucyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKE9iamVjdC5rZXlzKHBlcm1pc3Npb25zKS5sZW5ndGggPT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJSZWZ1c2luZyB0byBtaW50IGFuIGluc3RhbGxhdGlvbiB0b2tlbiBmb3IgYW4gZW1wdHkgcGVybWlzc2lvbiBzY29wZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmVxdWVzdEZpZWxkcy5wZXJtaXNzaW9ucyA9IHBlcm1pc3Npb25zO1xuICB9XG4gIGxldCBib2R5OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGlmIChPYmplY3Qua2V5cyhyZXF1ZXN0RmllbGRzKS5sZW5ndGggPiAwKSB7XG4gICAgYm9keSA9IEpTT04uc3RyaW5naWZ5KHJlcXVlc3RGaWVsZHMpO1xuICAgIGhlYWRlcnNbXCJDb250ZW50LVR5cGVcIl0gPSBcImFwcGxpY2F0aW9uL2pzb25cIjtcbiAgfVxuXG4gIGNvbnN0IGZldGNoSW5pdDogUmVxdWVzdEluaXQgPSB7XG4gICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICBoZWFkZXJzLFxuICAgIC4uLihib2R5ID09PSB1bmRlZmluZWQgPyB7fSA6IHsgYm9keSB9KSxcbiAgfTtcblxuICBjb25zdCByZXNwb25zZSA9IGZldGNoRm4gPT09IGdsb2JhbFRoaXMuZmV0Y2hcbiAgICA/IGF3YWl0IGZldGNoV2l0aFRpbWVvdXQodXJsLCBmZXRjaEluaXQsIEdJVEhVQl9BUElfVElNRU9VVF9NUylcbiAgICA6IGF3YWl0IGZldGNoRm4odXJsLCBmZXRjaEluaXQpO1xuXG4gIGlmIChyZXNwb25zZS5zdGF0dXMgIT09IDIwMSkge1xuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEdpdEh1YiBBUEkgcmV0dXJuZWQgJHtyZXNwb25zZS5zdGF0dXN9IGV4Y2hhbmdpbmcgSldUIGZvciBpbnN0YWxsYXRpb24gdG9rZW46IGAgK1xuICAgICAgICBzdW1tYXJpc2VUb2tlbkV4Y2hhbmdlRXJyb3JCb2R5KGJvZHkpLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xuICBpZiAoIWRhdGEudG9rZW4gfHwgdHlwZW9mIGRhdGEudG9rZW4gIT09IFwic3RyaW5nXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkdpdEh1YiBBUEkgcmVzcG9uc2UgbWlzc2luZyB0b2tlbiBmaWVsZCBpbiBpbnN0YWxsYXRpb24gdG9rZW4gZXhjaGFuZ2VcIixcbiAgICApO1xuICB9XG4gIGlmICghZGF0YS5leHBpcmVzX2F0KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJHaXRIdWIgQVBJIHJlc3BvbnNlIG1pc3NpbmcgZXhwaXJlc19hdCBmaWVsZCBpbiBpbnN0YWxsYXRpb24gdG9rZW4gZXhjaGFuZ2VcIixcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICB0b2tlbjogZGF0YS50b2tlbixcbiAgICBleHBpcmVzQXQ6IG5ldyBEYXRlKGRhdGEuZXhwaXJlc19hdCksXG4gICAgcGVybWlzc2lvbnM6IGRhdGEucGVybWlzc2lvbnMgJiYgdHlwZW9mIGRhdGEucGVybWlzc2lvbnMgPT09IFwib2JqZWN0XCJcbiAgICAgID8gZGF0YS5wZXJtaXNzaW9uc1xuICAgICAgOiB1bmRlZmluZWQsXG4gIH07XG59XG5cbi8qKlxuICogSGlnaC1sZXZlbDogZ2V0IGEgdmFsaWQgaW5zdGFsbGF0aW9uIHRva2VuLCByZWZyZXNoaW5nIGlmIG5lZWRlZC5cbiAqXG4gKiBDYWNoZXMgdGhlIHRva2VuIGluIG1lbW9yeSBhbmQgb25seSByZWZyZXNoZXMgd2hlbiB0aGUgY2FjaGVkIHRva2VuXG4gKiBleHBpcmVzIHdpdGhpbiA1IG1pbnV0ZXMgKHRoZSByZWZyZXNoIGJ1ZmZlcikuXG4gKlxuICogQHBhcmFtIGFwcElkIC0gVGhlIEdpdEh1YiBBcHAgSURcbiAqIEBwYXJhbSBpbnN0YWxsYXRpb25JZCAtIEdpdEh1YiBBcHAgaW5zdGFsbGF0aW9uIElEXG4gKiBAcGFyYW0gcHJpdmF0ZUtleVBhdGggLSBGaWxlIHN5c3RlbSBwYXRoIHRvIHRoZSBQRU0gcHJpdmF0ZSBrZXlcbiAqIEBwYXJhbSBmZXRjaEZuIC0gT3B0aW9uYWwgZmV0Y2ggZnVuY3Rpb24gKGluamVjdGFibGUgZm9yIHRlc3RpbmcpXG4gKiBAcGFyYW0gcmVwb3NpdG9yaWVzIC0gYG93bmVyL3JlcG9gIHNsdWdzIHRoZSB0b2tlbiBtYXkgcmVhY2ggKElzc3VlICMxMzkxKS5cbiAqICAgUGFydCBvZiB0aGUgY2FjaGUga2V5LCBzbyBhIG5hcnJvd2VyIHNjb3BlIG5ldmVyIHJldXNlcyBhIHdpZGVyIHRva2VuLlxuICogQHJldHVybnMgVmFsaWQgaW5zdGFsbGF0aW9uIGFjY2VzcyB0b2tlbiBzdHJpbmdcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGVuc3VyZVZhbGlkVG9rZW4oXG4gIGFwcElkOiBzdHJpbmcsXG4gIGluc3RhbGxhdGlvbklkOiBzdHJpbmcsXG4gIHByaXZhdGVLZXlQYXRoOiBzdHJpbmcsXG4gIGZldGNoRm46IEZldGNoRm4gPSBnbG9iYWxUaGlzLmZldGNoLFxuICByZXBvc2l0b3JpZXM6IFJlcG9zaXRvcnlTY29wZSA9IHVuZGVmaW5lZCxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIC8vIFJldHVybiBjYWNoZWQgdG9rZW4gb25seSB3aGVuIGl0IHdhcyBtaW50ZWQgZm9yIFRISVMgaWRlbnRpdHkgYW5kIFRISVNcbiAgLy8gcmVwb3NpdG9yeSBzY29wZSwgYW5kIGlzIHN0aWxsIHZhbGlkIChub3QgZXhwaXJpbmcgd2l0aGluIHRoZSBidWZmZXIpLlxuICAvLyBBbnkgbWlzbWF0Y2ggaXMgYSBjYWNoZSBtaXNzIGFuZCBmYWxscyB0aHJvdWdoIHRvIGEgZnJlc2ggbWludCBiZWxvdy5cbiAgY29uc3QgY2FjaGVLZXkgPSB0b2tlbkNhY2hlS2V5KGFwcElkLCBpbnN0YWxsYXRpb25JZCwgcmVwb3NpdG9yaWVzKTtcbiAgY29uc3QgY2FjaGVkVG9rZW4gPSB0b2tlbkNhY2hlLmdldChjYWNoZUtleSk7XG4gIGlmIChjYWNoZWRUb2tlbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgbXNVbnRpbEV4cGlyeSA9IGNhY2hlZFRva2VuLmV4cGlyZXNBdC5nZXRUaW1lKCkgLSBEYXRlLm5vdygpO1xuICAgIGlmIChtc1VudGlsRXhwaXJ5ID4gUkVGUkVTSF9CVUZGRVJfTVMpIHtcbiAgICAgIHJldHVybiBjYWNoZWRUb2tlbi50b2tlbjtcbiAgICB9XG4gIH1cblxuICAvLyBSZWFkIHByaXZhdGUga2V5IGZyb20gZGlza1xuICBsZXQgcGVtQ29udGVudHM6IHN0cmluZztcbiAgdHJ5IHtcbiAgICBwZW1Db250ZW50cyA9IGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKHByaXZhdGVLZXlQYXRoKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgRmFpbGVkIHRvIHJlYWQgcHJpdmF0ZSBrZXkgZmlsZSBhdCAke3ByaXZhdGVLZXlQYXRofTogJHttZXNzYWdlfWAsXG4gICAgKTtcbiAgfVxuXG4gIGlmICghcGVtQ29udGVudHMgfHwgcGVtQ29udGVudHMudHJpbSgpID09PSBcIlwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYHByaXZhdGUga2V5IGZpbGUgYXQgJHtwcml2YXRlS2V5UGF0aH0gaXMgZW1wdHlgLFxuICAgICk7XG4gIH1cblxuICAvLyBHZW5lcmF0ZSBKV1QgYW5kIGV4Y2hhbmdlIGZvciBpbnN0YWxsYXRpb24gdG9rZW5cbiAgY29uc3Qgand0ID0gYXdhaXQgZ2VuZXJhdGVBcHBKV1QoYXBwSWQsIHBlbUNvbnRlbnRzKTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ2V0SW5zdGFsbGF0aW9uVG9rZW4oXG4gICAgand0LFxuICAgIGluc3RhbGxhdGlvbklkLFxuICAgIGZldGNoRm4sXG4gICAgcmVwb3NpdG9yaWVzLFxuICApO1xuXG4gIC8vIENhY2hlIHRoZSBuZXcgdG9rZW4gdW5kZXIgdGhlIGlkZW50aXR5IGFuZCBzY29wZSBpdCB3YXMgbWludGVkIGZvclxuICB0b2tlbkNhY2hlLnNldChjYWNoZUtleSwge1xuICAgIHRva2VuOiByZXN1bHQudG9rZW4sXG4gICAgZXhwaXJlc0F0OiByZXN1bHQuZXhwaXJlc0F0LFxuICB9KTtcbiAgcHJ1bmVUb2tlbkNhY2hlKCk7XG5cbiAgcmV0dXJuIHJlc3VsdC50b2tlbjtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIENvbmZpZ3VyYXRpb24gQ2hlY2sgYW5kIFN1YnByb2Nlc3MgVG9rZW4gSGVscGVyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIEZ1bGx5LWNvbmZpZ3VyZWQgR2l0SHViIEFwcCBjcmVkZW50aWFscyDigJQgYWxsIHRocmVlIHZhbHVlcyBwcmVzZW50LlxuICpcbiAqIFRoZSBuYXJyb3dlZCByZXN1bHQgb2Yge0BsaW5rIGlzR2l0SHViQXBwQ29uZmlndXJlZH06IGNhbGxlcnMgdGhhdCBwYXNzIHRoZVxuICogZ3VhcmQgY2FuIHJlYWQgdGhlc2UgZmllbGRzIGFzIGBzdHJpbmdgIHdpdGhvdXQgbm9uLW51bGwgYXNzZXJ0aW9ucy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBHaXRIdWJBcHBDb25maWcge1xuICBhcHBJZDogc3RyaW5nO1xuICBpbnN0YWxsYXRpb25JZDogc3RyaW5nO1xuICBwcml2YXRlS2V5UGF0aDogc3RyaW5nO1xufVxuXG4vKiogUG9zc2libHktaW5jb21wbGV0ZSBHaXRIdWIgQXBwIGNyZWRlbnRpYWxzLCBhcyByZWFkIGZyb20gYXJncy9lbnYuICovXG5leHBvcnQgaW50ZXJmYWNlIE1heWJlR2l0SHViQXBwQ29uZmlnIHtcbiAgYXBwSWQ/OiBzdHJpbmcgfCBudWxsO1xuICBpbnN0YWxsYXRpb25JZD86IHN0cmluZyB8IG51bGw7XG4gIHByaXZhdGVLZXlQYXRoPzogc3RyaW5nIHwgbnVsbDtcbn1cblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIEdpdEh1YiBBcHAgYXV0aGVudGljYXRpb24gaXMgY29uZmlndXJlZC5cbiAqXG4gKiBSZXR1cm5zIHRydWUgb25seSBpZiBhbGwgdGhyZWUgcmVxdWlyZWQgdmFsdWVzIGFyZSBub24tZW1wdHkgc3RyaW5ncy5cbiAqIElzc3VlICM5NTk6IFVzZWQgYnkgZ2hfYXV0aC50cyBhbmQgY29tbWFuZHMvZ2l0aHViX2FwcF9hdXRoLnRzLlxuICpcbiAqIElzc3VlICMyNzk1OiBUaGlzIGlzIGEgdHlwZSBwcmVkaWNhdGUgKGBjb25maWcgaXMgR2l0SHViQXBwQ29uZmlnYCksIHNvIGFcbiAqIGNhbGxlciBpbnNpZGUgdGhlIGB0cnVlYCBicmFuY2ggcmVhZHMgYGNvbmZpZy5hcHBJZGAgZXRjLiBhcyBgc3RyaW5nYFxuICogd2l0aG91dCBub24tbnVsbCBhc3NlcnRpb25zIOKAlCB0aGUgaW52YXJpYW50IGlzIHZlcmlmaWVkIGJ5IHRoZSBjb21waWxlclxuICogcmF0aGVyIHRoYW4gYXNzZXJ0ZWQgYXdheS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzR2l0SHViQXBwQ29uZmlndXJlZChcbiAgY29uZmlnOiBNYXliZUdpdEh1YkFwcENvbmZpZyxcbik6IGNvbmZpZyBpcyBHaXRIdWJBcHBDb25maWcge1xuICByZXR1cm4gISEoXG4gICAgY29uZmlnLmFwcElkICYmIGNvbmZpZy5hcHBJZC50cmltKCkgIT09IFwiXCIgJiZcbiAgICBjb25maWcuaW5zdGFsbGF0aW9uSWQgJiYgY29uZmlnLmluc3RhbGxhdGlvbklkLnRyaW0oKSAhPT0gXCJcIiAmJlxuICAgIGNvbmZpZy5wcml2YXRlS2V5UGF0aCAmJiBjb25maWcucHJpdmF0ZUtleVBhdGgudHJpbSgpICE9PSBcIlwiXG4gICk7XG59XG5cbi8qKiBOYW1lIG9mIHRoZSBzZWN1cml0eSBldmVudCBlbWl0dGVkIHdoZW4gQXBwIGF1dGggZGVncmFkZXMgdG8gYW1iaWVudCBhdXRoLiAqL1xuZXhwb3J0IGNvbnN0IEFQUF9BVVRIX0ZBTExCQUNLX0VWRU5UID0gXCJHSVRIVUJfQVBQX0FVVEhfRkFMTEJBQ0tcIjtcblxuLyoqIE1pbmltYWwgbG9nZ2VyIHN1cmZhY2UgbmVlZGVkIHRvIGFubm91bmNlIGFuIGF1dGhlbnRpY2F0aW9uIGRlZ3JhZGF0aW9uLiAqL1xuZXhwb3J0IHR5cGUgQXV0aEV2ZW50TG9nZ2VyID0gUGljazxMb2dnZXIsIFwic2VjdXJpdHlcIj47XG5cbi8qKlxuICogR2V0IGEgR2l0SHViIEFwcCBpbnN0YWxsYXRpb24gdG9rZW4gZm9yIGluamVjdGlvbiBpbnRvIHN1YnByb2Nlc3MgZW52LlxuICpcbiAqIFJldHVybnMgYSB0b2tlbiBzdHJpbmcgaWYgR2l0SHViIEFwcCBpcyBjb25maWd1cmVkIGFuZCB0b2tlbiBnZW5lcmF0aW9uXG4gKiBzdWNjZWVkcywgb3IgdW5kZWZpbmVkIGlmIG5vdCBjb25maWd1cmVkIG9yIGlmIHRva2VuIGdlbmVyYXRpb24gZmFpbHMuXG4gKlxuICogSXNzdWUgIzk1OTogVXNlZCBieSBnaF93cmFwcGVyLnRzIGFuZCBnaXRodWIudHMgdG8gaW5qZWN0IEdIX1RPS0VOLlxuICpcbiAqIElzc3VlICMzNjQ0OiBhIG1pbnRpbmcgZmFpbHVyZSBpcyBuZXZlciBzd2FsbG93ZWQuIEJvdGggY2FsbGVycyB0cmVhdFxuICogYHVuZGVmaW5lZGAgYXMgXCJBcHAgbm90IGNvbmZpZ3VyZWRcIiBhbmQgZmFsbCBiYWNrIHRvIGFtYmllbnQgYGdoYCBhdXRoLFxuICogc28gYSBmYWlsdXJlIGhlcmUgc2lsZW50bHkgcmUtY3JlZGVudGlhbHMgZXZlcnkgbGF0ZXIgY2FsbCBhcyB3aGF0ZXZlclxuICogdG9rZW4gc2l0cyBpbiBgR0hfQ09ORklHX0RJUmAg4oCUIHRoZSBleGFjdCBkcmlmdCBgaWRlbnRpdHlfZ3VhcmQudHNgXG4gKiBleGlzdHMgdG8gY2F0Y2guIFRoZSBkZWdyYWRhdGlvbiBpcyB0aGVyZWZvcmUgYW5ub3VuY2VkIGFzIGEgYFtTRUNVUklUWV1gXG4gKiBldmVudCBzbyBpdCBpcyB2aXNpYmxlIGluIHRoZSBydW4gbG9nIGFuZCByZWNvbnN0cnVjdGFibGUgYWZ0ZXJ3YXJkcy5cbiAqXG4gKiBAcGFyYW0gbG9nZ2VyIC0gU2luayBmb3IgdGhlIGZhbGxiYWNrIHNlY3VyaXR5IGV2ZW50IChpbmplY3RhYmxlIGZvciB0ZXN0aW5nKVxuICogQHBhcmFtIHJlcG9zaXRvcmllcyAtIGBvd25lci9yZXBvYCBzbHVncyB0aGUgdG9rZW4gbWF5IHJlYWNoIChJc3N1ZSAjMTM5MSkuXG4gKiAgIGBnaF9zcGF3bi50c2AgZGVyaXZlcyB0aGlzIGZyb20gdGhlIHJ1bidzIHdyaXRlLXJlcG8gYWxsb3dsaXN0LCBzbyB0aGVcbiAqICAgY3JlZGVudGlhbCB0aGUgc3VicHJvY2VzcyByZWNlaXZlcyBjYW5ub3QgcmVhY2ggYSByZXBvIHRoZSBydW4gbWF5IG5vdFxuICogICB3cml0ZSB0by4gYG51bGxgL29taXR0ZWQga2VlcHMgdGhlIGluc3RhbGxhdGlvbidzIGZ1bGwgcmVhY2guXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRHaFRva2VuRm9yU3VicHJvY2VzcyhcbiAgYXBwSWQ/OiBzdHJpbmcsXG4gIGluc3RhbGxhdGlvbklkPzogc3RyaW5nLFxuICBwcml2YXRlS2V5UGF0aD86IHN0cmluZyxcbiAgbG9nZ2VyOiBBdXRoRXZlbnRMb2dnZXIgPSBkZWZhdWx0TG9nZ2VyLFxuICByZXBvc2l0b3JpZXM6IFJlcG9zaXRvcnlTY29wZSA9IHVuZGVmaW5lZCxcbik6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IGNvbmZpZyA9IHsgYXBwSWQsIGluc3RhbGxhdGlvbklkLCBwcml2YXRlS2V5UGF0aCB9O1xuICBpZiAoIWlzR2l0SHViQXBwQ29uZmlndXJlZChjb25maWcpKSB7XG4gICAgLy8gTm90IGNvbmZpZ3VyZWQgaXMgYSBkZWxpYmVyYXRlIG9wZXJhdG9yIGNob2ljZSwgbm90IGEgZmFpbHVyZSDigJQgdGhlXG4gICAgLy8gY2FsbGVyIGlzIG1lYW50IHRvIHVzZSBhbWJpZW50IGF1dGgsIHNvIHRoZXJlIGlzIG5vdGhpbmcgdG8gcmVwb3J0LlxuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBlbnN1cmVWYWxpZFRva2VuKFxuICAgICAgY29uZmlnLmFwcElkLFxuICAgICAgY29uZmlnLmluc3RhbGxhdGlvbklkLFxuICAgICAgY29uZmlnLnByaXZhdGVLZXlQYXRoLFxuICAgICAgZ2xvYmFsVGhpcy5mZXRjaCxcbiAgICAgIHJlcG9zaXRvcmllcyxcbiAgICApO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBUaGUgZ3VhcmQgYWJvdmUgZXN0YWJsaXNoZWQgdGhlIEFwcCBJUyBjb25maWd1cmVkLCBzbyByZWFjaGluZyBoZXJlIGlzXG4gICAgLy8gYSBnZW51aW5lIGZhaWx1cmUg4oCUIHVucmVhZGFibGUgb3IgbWFsZm9ybWVkIFBFTSwgY2xvY2sgc2tldywgYSA0MDEvNXh4XG4gICAgLy8gb24gdGhlIGluc3RhbGxhdGlvbi10b2tlbiBleGNoYW5nZSDigJQgbm90IFwiQXBwIG5vdCBjb25maWd1cmVkXCIuXG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBsb2dnZXIuc2VjdXJpdHkoXG4gICAgICBBUFBfQVVUSF9GQUxMQkFDS19FVkVOVCxcbiAgICAgIGBHaXRIdWIgQXBwIHRva2VuIG1pbnRpbmcgZmFpbGVkIChhcHBJZD0ke2NvbmZpZy5hcHBJZH0gYCArXG4gICAgICAgIGBpbnN0YWxsYXRpb25JZD0ke2NvbmZpZy5pbnN0YWxsYXRpb25JZH0gc2NvcGU9JHtcbiAgICAgICAgICByZXBvc2l0b3JpZXMgPT09IG51bGwgfHwgcmVwb3NpdG9yaWVzID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgID8gXCI8dW5zY29wZWQ+XCJcbiAgICAgICAgICAgIDogcmVwb3NpdG9yaWVzLmpvaW4oXCIsXCIpXG4gICAgICAgIH0pOyBmYWxsaW5nIGJhY2sgdG8gYW1iaWVudCBnaCBgICtcbiAgICAgICAgYGF1dGhlbnRpY2F0aW9uLCBzbyBzdWJzZXF1ZW50IGNhbGxzIG1heSBydW4gYXMgYSBkaWZmZXJlbnQgaWRlbnRpdHkgYCArXG4gICAgICAgIGB3aXRoIGJyb2FkZXIgcGVybWlzc2lvbnMuIENhdXNlOiAke21lc3NhZ2V9YCxcbiAgICApO1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEludGVybmFsIEhlbHBlcnNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogU3VtbWFyaXNlIGEgR2l0SHViIHRva2VuLWV4Y2hhbmdlIGVycm9yIGJvZHkgZm9yIGludGVycG9sYXRpb24gaW50byBhXG4gKiB0aHJvd24gRXJyb3IgKElzc3VlICMxOTcpLlxuICpcbiAqIFByZWZlciB0aGUgc3RydWN0dXJlZCBgbWVzc2FnZWAgZmllbGQgd2hlbiB0aGUgYm9keSBpcyBKU09OIGFuZCB0aGF0XG4gKiBmaWVsZCBpcyBhIHN0cmluZzsgb3RoZXJ3aXNlIGZhbGwgYmFjayB0byBhIHRydW5jYXRlZCByYXcgc25pcHBldC5cbiAqIE5ldmVyIHRocm93cyDigJQgYSBwYXJzZSBmYWlsdXJlIG11c3Qgbm90IG1hc2sgdGhlIG9yaWdpbmFsIEhUVFAgc3RhdHVzLlxuICovXG5mdW5jdGlvbiBzdW1tYXJpc2VUb2tlbkV4Y2hhbmdlRXJyb3JCb2R5KGJvZHk6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHRyaW1tZWQgPSBib2R5LnRyaW0oKTtcbiAgaWYgKHRyaW1tZWQgIT09IFwiXCIpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcGFyc2VkOiB1bmtub3duID0gSlNPTi5wYXJzZSh0cmltbWVkKTtcbiAgICAgIGlmIChcbiAgICAgICAgcGFyc2VkICE9PSBudWxsICYmXG4gICAgICAgIHR5cGVvZiBwYXJzZWQgPT09IFwib2JqZWN0XCIgJiZcbiAgICAgICAgXCJtZXNzYWdlXCIgaW4gcGFyc2VkICYmXG4gICAgICAgIHR5cGVvZiAocGFyc2VkIGFzIHsgbWVzc2FnZTogdW5rbm93biB9KS5tZXNzYWdlID09PSBcInN0cmluZ1wiXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIHRydW5jYXRlVG9rZW5FeGNoYW5nZUVycm9yQm9keShcbiAgICAgICAgICAocGFyc2VkIGFzIHsgbWVzc2FnZTogc3RyaW5nIH0pLm1lc3NhZ2UsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBOb24tSlNPTiBib2R5IOKAlCBmYWxsIHRocm91Z2ggdG8gdGhlIHRydW5jYXRlZCByYXcgdGV4dC5cbiAgICB9XG4gIH1cbiAgcmV0dXJuIHRydW5jYXRlVG9rZW5FeGNoYW5nZUVycm9yQm9keShib2R5KTtcbn1cblxuLyoqIFRydW5jYXRlIGFuIGVycm9yLWJvZHkgc25pcHBldCBhbmQgbWFyayB0aGUgZWxpc2lvbiBleHBsaWNpdGx5LiAqL1xuZnVuY3Rpb24gdHJ1bmNhdGVUb2tlbkV4Y2hhbmdlRXJyb3JCb2R5KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICh0ZXh0Lmxlbmd0aCA8PSBUT0tFTl9FWENIQU5HRV9FUlJPUl9CT0RZX0xJTUlUKSB7XG4gICAgcmV0dXJuIHRleHQ7XG4gIH1cbiAgcmV0dXJuIHRleHQuc2xpY2UoMCwgVE9LRU5fRVhDSEFOR0VfRVJST1JfQk9EWV9MSU1JVCkgK1xuICAgIFRPS0VOX0VYQ0hBTkdFX0VSUk9SX0JPRFlfRUxJU0lPTjtcbn1cblxuLyoqXG4gKiBJbXBvcnQgYSBQRU0tZW5jb2RlZCBSU0EgcHJpdmF0ZSBrZXkgYXMgYSBDcnlwdG9LZXkgZm9yIFJTMjU2IHNpZ25pbmcuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGltcG9ydFByaXZhdGVLZXkocGVtOiBzdHJpbmcpOiBQcm9taXNlPENyeXB0b0tleT4ge1xuICAvLyBTdHJpcCBQRU0gaGVhZGVycy9mb290ZXJzIGFuZCB3aGl0ZXNwYWNlXG4gIGNvbnN0IHBlbUhlYWRlciA9IFwiLS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLVwiO1xuICBjb25zdCBwZW1Gb290ZXIgPSBcIi0tLS0tRU5EIFJTQSBQUklWQVRFIEtFWS0tLS0tXCI7XG5cbiAgLy8gU3VwcG9ydCBib3RoIFBLQ1MjMSBhbmQgUEtDUyM4IGZvcm1hdHNcbiAgY29uc3QgaXNQa2NzMSA9IHBlbS5pbmNsdWRlcyhwZW1IZWFkZXIpO1xuICBjb25zdCBpc1BrY3M4ID0gcGVtLmluY2x1ZGVzKFwiLS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tXCIpO1xuXG4gIGlmICghaXNQa2NzMSAmJiAhaXNQa2NzOCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiSW52YWxpZCBwcml2YXRlIGtleSBQRU0gZm9ybWF0OiBleHBlY3RlZCBSU0EgUFJJVkFURSBLRVkgb3IgUFJJVkFURSBLRVkgaGVhZGVyXCIsXG4gICAgKTtcbiAgfVxuXG4gIGxldCBiNjQ6IHN0cmluZztcbiAgbGV0IGZvcm1hdDogXCJwa2NzMVwiIHwgXCJwa2NzOFwiO1xuXG4gIGlmIChpc1BrY3M4KSB7XG4gICAgYjY0ID0gcGVtXG4gICAgICAucmVwbGFjZShcIi0tLS0tQkVHSU4gUFJJVkFURSBLRVktLS0tLVwiLCBcIlwiKVxuICAgICAgLnJlcGxhY2UoXCItLS0tLUVORCBQUklWQVRFIEtFWS0tLS0tXCIsIFwiXCIpXG4gICAgICAucmVwbGFjZSgvXFxzL2csIFwiXCIpO1xuICAgIGZvcm1hdCA9IFwicGtjczhcIjtcbiAgfSBlbHNlIHtcbiAgICBiNjQgPSBwZW1cbiAgICAgIC5yZXBsYWNlKHBlbUhlYWRlciwgXCJcIilcbiAgICAgIC5yZXBsYWNlKHBlbUZvb3RlciwgXCJcIilcbiAgICAgIC5yZXBsYWNlKC9cXHMvZywgXCJcIik7XG4gICAgZm9ybWF0ID0gXCJwa2NzMVwiO1xuICB9XG5cbiAgY29uc3QgYmluYXJ5U3RyaW5nID0gYXRvYihiNjQpO1xuICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGJpbmFyeVN0cmluZy5sZW5ndGgpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJpbmFyeVN0cmluZy5sZW5ndGg7IGkrKykge1xuICAgIGJ5dGVzW2ldID0gYmluYXJ5U3RyaW5nLmNoYXJDb2RlQXQoaSk7XG4gIH1cblxuICB0cnkge1xuICAgIC8vIFBLQ1MjMSBrZXlzIG5lZWQgdG8gYmUgaW1wb3J0ZWQgYXMgXCJwa2NzOFwiIGlzbid0IGNvcnJlY3QgZm9yIHRoZW0uXG4gICAgLy8gRGVubydzIFdlYiBDcnlwdG8gb25seSBzdXBwb3J0cyBQS0NTIzggZm9yIGltcG9ydEtleS4gV2UgbmVlZCB0b1xuICAgIC8vIHdyYXAgUEtDUyMxIGluIGEgUEtDUyM4IGVudmVsb3BlLlxuICAgIGNvbnN0IGtleURhdGEgPSBmb3JtYXQgPT09IFwicGtjczFcIiA/IHdyYXBQa2NzMUluUGtjczgoYnl0ZXMpIDogYnl0ZXM7XG5cbiAgICByZXR1cm4gYXdhaXQgY3J5cHRvLnN1YnRsZS5pbXBvcnRLZXkoXG4gICAgICBcInBrY3M4XCIsXG4gICAgICBrZXlEYXRhLmJ1ZmZlciBhcyBBcnJheUJ1ZmZlcixcbiAgICAgIHsgbmFtZTogXCJSU0FTU0EtUEtDUzEtdjFfNVwiLCBoYXNoOiBcIlNIQS0yNTZcIiB9LFxuICAgICAgZmFsc2UsXG4gICAgICBbXCJzaWduXCJdLFxuICAgICk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gaW1wb3J0IHByaXZhdGUga2V5OiAke21lc3NhZ2V9YCk7XG4gIH1cbn1cblxuLyoqXG4gKiBXcmFwIGEgUEtDUyMxIFJTQSBwcml2YXRlIGtleSBpbiBhIFBLQ1MjOCBlbnZlbG9wZS5cbiAqXG4gKiBQS0NTIzggd3JhcHMgdGhlIFBLQ1MjMSBrZXkgd2l0aCBhbiBBbGdvcml0aG1JZGVudGlmaWVyIGZvciBSU0EuXG4gKiBUaGlzIGlzIG5lZWRlZCBiZWNhdXNlIFdlYiBDcnlwdG8ncyBpbXBvcnRLZXkgb25seSBhY2NlcHRzIFBLQ1MjOC5cbiAqL1xuZnVuY3Rpb24gd3JhcFBrY3MxSW5Qa2NzOChwa2NzMUJ5dGVzOiBVaW50OEFycmF5KTogVWludDhBcnJheSB7XG4gIC8vIFBLQ1MjOCBoZWFkZXIgZm9yIFJTQSAoT0lEIDEuMi44NDAuMTEzNTQ5LjEuMS4xKVxuICAvLyBTRVFVRU5DRSB7XG4gIC8vICAgSU5URUdFUiAwICh2ZXJzaW9uKVxuICAvLyAgIFNFUVVFTkNFIHsgT0lEIHJzYUVuY3J5cHRpb24sIE5VTEwgfVxuICAvLyAgIE9DVEVUIFNUUklORyB7IDxwa2NzMSBrZXkgYnl0ZXM+IH1cbiAgLy8gfVxuXG4gIC8vIFRoZSBBbGdvcml0aG1JZGVudGlmaWVyIGZvciBSU0FcbiAgY29uc3QgcnNhT2lkID0gbmV3IFVpbnQ4QXJyYXkoW1xuICAgIDB4MzAsXG4gICAgMHgwZCwgLy8gU0VRVUVOQ0UsIDEzIGJ5dGVzXG4gICAgMHgwNixcbiAgICAweDA5LCAvLyBPSUQsIDkgYnl0ZXNcbiAgICAweDJhLFxuICAgIDB4ODYsXG4gICAgMHg0OCxcbiAgICAweDg2LFxuICAgIDB4ZjcsXG4gICAgMHgwZCxcbiAgICAweDAxLFxuICAgIDB4MDEsXG4gICAgMHgwMSwgLy8gMS4yLjg0MC4xMTM1NDkuMS4xLjFcbiAgICAweDA1LFxuICAgIDB4MDAsIC8vIE5VTExcbiAgXSk7XG5cbiAgLy8gVmVyc2lvbiBJTlRFR0VSIDBcbiAgY29uc3QgdmVyc2lvbiA9IG5ldyBVaW50OEFycmF5KFsweDAyLCAweDAxLCAweDAwXSk7XG5cbiAgLy8gT0NURVQgU1RSSU5HIHdyYXBwaW5nIHRoZSBQS0NTIzEga2V5XG4gIGNvbnN0IG9jdGV0U3RyaW5nID0gd3JhcEFzbjEoMHgwNCwgcGtjczFCeXRlcyk7XG5cbiAgLy8gSW5uZXIgU0VRVUVOQ0UgY29udGVudHM6IHZlcnNpb24gKyBhbGdvcml0aG1JZCArIG9jdGV0U3RyaW5nXG4gIGNvbnN0IGlubmVyQ29udGVudHMgPSBjb25jYXRCeXRlcyh2ZXJzaW9uLCByc2FPaWQsIG9jdGV0U3RyaW5nKTtcblxuICAvLyBPdXRlciBTRVFVRU5DRVxuICByZXR1cm4gd3JhcEFzbjEoMHgzMCwgaW5uZXJDb250ZW50cyk7XG59XG5cbi8qKiBXcmFwIGJ5dGVzIGluIGFuIEFTTi4xIFRMViAodGFnLWxlbmd0aC12YWx1ZSkuICovXG5mdW5jdGlvbiB3cmFwQXNuMSh0YWc6IG51bWJlciwgdmFsdWU6IFVpbnQ4QXJyYXkpOiBVaW50OEFycmF5IHtcbiAgY29uc3QgbGVuZ3RoID0gZW5jb2RlQXNuMUxlbmd0aCh2YWx1ZS5sZW5ndGgpO1xuICBjb25zdCByZXN1bHQgPSBuZXcgVWludDhBcnJheSgxICsgbGVuZ3RoLmxlbmd0aCArIHZhbHVlLmxlbmd0aCk7XG4gIHJlc3VsdFswXSA9IHRhZztcbiAgcmVzdWx0LnNldChsZW5ndGgsIDEpO1xuICByZXN1bHQuc2V0KHZhbHVlLCAxICsgbGVuZ3RoLmxlbmd0aCk7XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbi8qKiBFbmNvZGUgYW4gQVNOLjEgbGVuZ3RoIHVzaW5nIERFUiBydWxlcy4gKi9cbmZ1bmN0aW9uIGVuY29kZUFzbjFMZW5ndGgobGVuZ3RoOiBudW1iZXIpOiBVaW50OEFycmF5IHtcbiAgaWYgKGxlbmd0aCA8IDB4ODApIHtcbiAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoW2xlbmd0aF0pO1xuICB9XG4gIGNvbnN0IGJ5dGVzOiBudW1iZXJbXSA9IFtdO1xuICBsZXQgdGVtcCA9IGxlbmd0aDtcbiAgd2hpbGUgKHRlbXAgPiAwKSB7XG4gICAgYnl0ZXMudW5zaGlmdCh0ZW1wICYgMHhmZik7XG4gICAgdGVtcCA+Pj0gODtcbiAgfVxuICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoWzB4ODAgfCBieXRlcy5sZW5ndGgsIC4uLmJ5dGVzXSk7XG59XG5cbi8qKiBDb25jYXRlbmF0ZSBtdWx0aXBsZSBVaW50OEFycmF5cy4gKi9cbmZ1bmN0aW9uIGNvbmNhdEJ5dGVzKC4uLmFycmF5czogVWludDhBcnJheVtdKTogVWludDhBcnJheSB7XG4gIGNvbnN0IHRvdGFsTGVuZ3RoID0gYXJyYXlzLnJlZHVjZSgoc3VtLCBhKSA9PiBzdW0gKyBhLmxlbmd0aCwgMCk7XG4gIGNvbnN0IHJlc3VsdCA9IG5ldyBVaW50OEFycmF5KHRvdGFsTGVuZ3RoKTtcbiAgbGV0IG9mZnNldCA9IDA7XG4gIGZvciAoY29uc3QgYXJyIG9mIGFycmF5cykge1xuICAgIHJlc3VsdC5zZXQoYXJyLCBvZmZzZXQpO1xuICAgIG9mZnNldCArPSBhcnIubGVuZ3RoO1xuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbi8qKiBCYXNlNjR1cmwtZW5jb2RlIGEgc3RyaW5nIChubyBwYWRkaW5nKS4gKi9cbmZ1bmN0aW9uIGJhc2U2NHVybEVuY29kZShzdHI6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJ5dGVzID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHN0cik7XG4gIHJldHVybiBhcnJheUJ1ZmZlclRvQmFzZTY0dXJsKGJ5dGVzLmJ1ZmZlcik7XG59XG5cbi8qKiBDb252ZXJ0IGFuIEFycmF5QnVmZmVyIHRvIGEgYmFzZTY0dXJsIHN0cmluZyAobm8gcGFkZGluZykuICovXG5mdW5jdGlvbiBhcnJheUJ1ZmZlclRvQmFzZTY0dXJsKGJ1ZmZlcjogQXJyYXlCdWZmZXIpOiBzdHJpbmcge1xuICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGJ1ZmZlcik7XG4gIGxldCBiaW5hcnkgPSBcIlwiO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ5dGVzLmxlbmd0aDsgaSsrKSB7XG4gICAgYmluYXJ5ICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoYnl0ZXNbaV0hKTtcbiAgfVxuICByZXR1cm4gYnRvYShiaW5hcnkpXG4gICAgLnJlcGxhY2UoL1xcKy9nLCBcIi1cIilcbiAgICAucmVwbGFjZSgvXFwvL2csIFwiX1wiKVxuICAgIC5yZXBsYWNlKC89KyQvLCBcIlwiKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBd0JDLEdBR0QsU0FBUyxhQUFhLFFBQVEsY0FBYztBQUM1QyxTQUFTLGdCQUFnQixRQUFRLDBCQUEwQjtBQUUzRCxvREFBb0QsR0FDcEQs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
// denoCacheMetadata=17854555054837352389,9750436906450602926