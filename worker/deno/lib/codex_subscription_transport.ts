/**
 * Trusted-only Codex ChatGPT transport (#3699), pinned to CLI 0.147.0.
 * The authenticated outer broker owns capability, lease and request-body bounds.
 * No token endpoint, credential snapshot or refresh result is an agent route.
 */
import { readTextBounded } from "./bounded_fetch.ts";
import {
  CREDENTIAL_BROKER_AUTH_ENDPOINTS,
  CREDENTIAL_BROKER_UPSTREAMS,
} from "./credential_broker_policy.ts";

const RESPONSES_URL = new URL(
  "/backend-api/codex/responses",
  CREDENTIAL_BROKER_UPSTREAMS["codex-subscription"],
).href;
const REFRESH_URL = CREDENTIAL_BROKER_AUTH_ENDPOINTS.codex;
const MAX_AUTH_BYTES = 128 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const REFRESH_WINDOW_MS = 5 * 60_000;
const REFRESH_AGE_MS = 8 * 24 * 60 * 60_000;

import { CODEX_SUBSCRIPTION_METADATA_HEADERS } from "./codex_transport_headers.ts";
export { CODEX_SUBSCRIPTION_METADATA_HEADERS } from "./codex_transport_headers.ts";

interface Snapshot {
  readonly authJson: string;
  readonly accountId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
  readonly fedramp: boolean;
  readonly expiresAt?: number;
  readonly lastRefresh: number;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}

function token(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,65536}$/.test(value)) {
    throw new Error("Invalid token");
  }
  return value;
}

/** Claims are consistency checks on trusted state, not JWT signature verification. */
function claims(value: string, accountId: string): {
  expiresAt?: number;
  fedramp: boolean;
} {
  const parts = value.split(".");
  if (
    parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  ) {
    throw new Error("Invalid token encoding");
  }
  const decoded = atob(parts[1]!.replaceAll("-", "+").replaceAll("_", "/"));
  const payload = record(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(decoded, (char) => char.charCodeAt(0)),
    )),
  );
  const auth = record(payload["https://api.openai.com/auth"]);
  if (auth.chatgpt_account_id !== accountId) throw new Error("Account changed");
  if (
    auth.chatgpt_account_is_fedramp !== undefined &&
    typeof auth.chatgpt_account_is_fedramp !== "boolean"
  ) throw new Error("Invalid account routing");
  let expiresAt: number | undefined;
  if (payload.exp !== undefined && payload.exp !== null) {
    if (
      !Number.isSafeInteger(payload.exp) || typeof payload.exp !== "number" ||
      payload.exp <= 0 || !Number.isSafeInteger(payload.exp * 1000)
    ) throw new Error("Invalid token expiry");
    expiresAt = payload.exp * 1000;
  }
  return { expiresAt, fedramp: auth.chatgpt_account_is_fedramp === true };
}

function snapshot(authJson: string, accountId: string): Snapshot {
  try {
    if (
      new TextEncoder().encode(authJson).byteLength > MAX_AUTH_BYTES ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(accountId)
    ) throw new Error("Invalid account snapshot size or identity");
    const value = record(JSON.parse(authJson));
    if (
      (value.auth_mode !== undefined && value.auth_mode !== null &&
        value.auth_mode !== "chatgpt") ||
      [
        "OPENAI_API_KEY",
        "agent_identity",
        "personal_access_token",
        "bedrock_api_key",
      ]
        .some((key) => value[key] !== undefined && value[key] !== null)
    ) throw new Error("Ambiguous authentication mode");
    const tokens = record(value.tokens);
    if (tokens.account_id !== accountId) throw new Error("Account changed");
    const accessToken = token(tokens.access_token);
    const idToken = token(tokens.id_token);
    const accessClaims = claims(accessToken, accountId);
    const idClaims = claims(idToken, accountId);
    if (
      typeof value.last_refresh !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
        .test(value.last_refresh) ||
      !Number.isFinite(Date.parse(value.last_refresh))
    ) throw new Error("Invalid refresh timestamp");
    return Object.freeze({
      authJson,
      accountId,
      accessToken,
      idToken,
      refreshToken: token(tokens.refresh_token),
      fedramp: idClaims.fedramp,
      expiresAt: accessClaims.expiresAt,
      lastRefresh: Date.parse(value.last_refresh),
    });
  } catch {
    throw new Error("Invalid selected Codex subscription snapshot");
  }
}

/** Validate host-owned state without returning credential values to a caller. */
export function assertCodexSubscriptionSnapshot(
  authJson: string,
  accountId: string,
): void {
  snapshot(authJson, accountId);
}

/** A successful disk writer returns its exact merged JSON for the next CAS. */
export type CodexSubscriptionPersist = (replacement: {
  expectedAuthJson: string;
  authJson: string;
  signal: AbortSignal;
}) => Promise<string | void>;

/** Same-account host lock held across reload, refresh and persistence. */
export type CodexSubscriptionTransaction = (options: {
  signal: AbortSignal;
  run: (authJson: string, persist: CodexSubscriptionPersist) => Promise<string>;
}) => Promise<string>;

function failure(status: number, reason: string): Response {
  return new Response(`${reason}\n`, {
    status,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}

/**
 * Construct one selected-account transport in the trusted broker.
 * `persist` must atomically compare expectedAuthJson and replace only while its
 * signal remains live. For shared auth files, `transaction` must hold the host
 * account lock across reload, upstream refresh and persistence; CAS alone cannot
 * prevent two brokers consuming the same rotating refresh token.
 * Neither its arguments nor this function belong inside the agent container.
 */
export function createCodexSubscriptionTransport(options: {
  authJson: string;
  accountId: string;
  now?: () => number;
  signal?: AbortSignal;
  persist: CodexSubscriptionPersist;
  transaction?: CodexSubscriptionTransaction;
  fetch?: (request: Request) => Promise<Response>;
}): (request: Request) => Promise<Response> {
  let current = snapshot(options.authJson, options.accountId);
  const accountId = options.accountId;
  const forward = options.fetch ?? fetch;
  const persist = options.persist;
  const transaction = options.transaction;
  const now = options.now ?? Date.now;
  const session = options.signal ?? new AbortController().signal;
  const failureAbort = new AbortController();
  let refreshInFlight: Promise<Snapshot> | undefined;
  let failed: string | undefined;

  function latchFailure(reason: string): Error {
    failed = reason;
    failureAbort.abort();
    return new Error(reason);
  }

  function stale(value: Snapshot): boolean {
    return value.expiresAt !== undefined
      ? value.expiresAt <= now() + REFRESH_WINDOW_MS
      : value.lastRefresh < now() - REFRESH_AGE_MS;
  }

  async function refresh(previous: Snapshot): Promise<Snapshot> {
    if (failed) throw new Error(failed);
    session.throwIfAborted();
    if (current !== previous) return current;
    if (refreshInFlight) return refreshInFlight;
    const job = (async () => {
      const signal = AbortSignal.any([
        session,
        failureAbort.signal,
        AbortSignal.timeout(30_000),
      ]);
      const rotate = async (
        authJson: string,
        commit: CodexSubscriptionPersist,
      ): Promise<string> => {
        signal.throwIfAborted();
        const selected = snapshot(authJson, accountId);
        // Another broker rotated while we waited for the host account lock.
        if (
          (selected.accessToken !== previous.accessToken ||
            selected.refreshToken !== previous.refreshToken ||
            selected.idToken !== previous.idToken ||
            selected.lastRefresh !== previous.lastRefresh) && !stale(selected)
        ) {
          return selected.authJson;
        }
        let replacement: Snapshot;
        try {
          const response = await forward(
            new Request(REFRESH_URL, {
              method: "POST",
              redirect: "manual",
              signal,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
                grant_type: "refresh_token",
                refresh_token: selected.refreshToken,
              }),
            }),
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Refresh refused");
          }
          const body = await readTextBounded(
            new Response(
              response.body?.pipeThrough(new TransformStream(), { signal }),
            ),
            MAX_AUTH_BYTES,
          );
          signal.throwIfAborted();
          if (!body.ok) throw new Error("Refresh response exceeded its bound");
          const result = record(JSON.parse(body.value));
          replacement = snapshot(
            JSON.stringify({
              auth_mode: "chatgpt",
              OPENAI_API_KEY: null,
              tokens: {
                account_id: accountId,
                access_token: token(result.access_token),
                refresh_token: result.refresh_token === undefined ||
                    result.refresh_token === null
                  ? selected.refreshToken
                  : token(result.refresh_token),
                id_token:
                  result.id_token === undefined || result.id_token === null
                    ? selected.idToken
                    : token(result.id_token),
              },
              last_refresh: new Date(now()).toISOString(),
            }),
            accountId,
          );
          if (stale(replacement)) {
            throw new Error("Replacement already expired");
          }
        } catch {
          throw latchFailure("Codex subscription refresh failed");
        }
        signal.throwIfAborted();
        try {
          const committed = await commit({
            expectedAuthJson: selected.authJson,
            authJson: replacement.authJson,
            signal,
          });
          signal.throwIfAborted();
          return committed ?? replacement.authJson;
        } catch {
          throw latchFailure("Codex subscription persistence failed");
        }
      };
      try {
        const committed = transaction
          ? await transaction({ signal, run: rotate })
          : await rotate(previous.authJson, persist);
        signal.throwIfAborted();
        current = snapshot(committed, accountId);
      } catch {
        if (failed) throw new Error(failed);
        throw latchFailure("Codex subscription account transaction failed");
      }
      return current;
    })();
    refreshInFlight = job;
    try {
      return await job;
    } finally {
      if (refreshInFlight === job) refreshInFlight = undefined;
    }
  }

  return async (request) => {
    if (session.aborted) {
      return failure(503, "Codex subscription session is closed");
    }
    if (failed) return failure(503, failed);
    if (request.method !== "POST" || request.url !== RESPONSES_URL) {
      return failure(403, "Codex subscription route denied");
    }
    const signal = AbortSignal.any([
      session,
      failureAbort.signal,
      request.signal,
      AbortSignal.timeout(180_000),
    ]);
    const cancelled = () =>
      failure(
        session.aborted ? 503 : 408,
        session.aborted
          ? "Codex subscription session is closed"
          : "Codex subscription request cancelled",
      );
    if (signal.aborted) return cancelled();
    const body = await readTextBounded(
      new Response(
        request.body?.pipeThrough(new TransformStream(), { signal }),
      ),
      MAX_REQUEST_BYTES,
    );
    if (session.aborted) return cancelled();
    if (failed) return failure(503, failed);
    if (signal.aborted) return cancelled();
    if (!body.ok) {
      return failure(413, "Codex subscription request body refused");
    }
    let selected = current;
    try {
      if (stale(selected)) selected = await refresh(selected);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (failed) return failure(503, failed);
        signal.throwIfAborted();
        const headers = new Headers({
          authorization: `Bearer ${selected.accessToken}`,
          "chatgpt-account-id": accountId,
          "content-type": "application/json",
          accept: "text/event-stream",
        });
        for (const name of CODEX_SUBSCRIPTION_METADATA_HEADERS) {
          const value = request.headers.get(name);
          if (value !== null) headers.set(name, value);
        }
        if (selected.fedramp) headers.set("x-openai-fedramp", "true");
        const response = await forward(
          new Request(RESPONSES_URL, {
            method: "POST",
            headers,
            body: body.value,
            redirect: "manual",
            signal,
          }),
        );
        if (signal.aborted) {
          await response.body?.cancel();
          if (!session.aborted && failed) return failure(503, failed);
          return cancelled();
        }
        if (response.status === 401) {
          await response.body?.cancel();
          if (attempt === 0) {
            selected = await refresh(selected);
            continue;
          }
          const error = latchFailure(
            "Codex subscription authentication refused",
          );
          return failure(401, error.message);
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          return failure(502, "Codex subscription redirect refused");
        }
        const outputHeaders = new Headers({ "cache-control": "no-store" });
        for (
          const name of [
            "content-type",
            "retry-after",
            "x-request-id",
            "request-id",
            "x-codex-turn-state",
          ]
        ) {
          const value = response.headers.get(name);
          if (value !== null) outputHeaders.set(name, value);
        }
        return new Response(
          response.body?.pipeThrough(new TransformStream(), { signal }),
          {
            status: response.status,
            headers: outputHeaders,
          },
        );
      }
    } catch {
      if (session.aborted || request.signal.aborted) return cancelled();
      if (failed) return failure(502, failed);
      if (signal.aborted) return cancelled();
      return failure(502, failed ?? "Codex subscription upstream failed");
    }
    throw new Error("Codex subscription retry bound was exceeded");
  };
}
