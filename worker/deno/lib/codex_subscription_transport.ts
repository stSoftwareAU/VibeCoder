/**
 * Trusted-only Codex ChatGPT transport (#3699), pinned to CLI 0.147.0.
 * The authenticated outer broker owns capability, lease and request-body bounds.
 * No token endpoint, credential snapshot or refresh result is an agent route.
 */
import { readTextBounded } from "./bounded_fetch.ts";

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const MAX_AUTH_BYTES = 128 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const REFRESH_WINDOW_MS = 5 * 60_000;
const REFRESH_AGE_MS = 8 * 24 * 60 * 60_000;

/** Pinned HTTP metadata; outer adapters must carry these without adding auth. */
export const CODEX_SUBSCRIPTION_METADATA_HEADERS = [
  "originator",
  "user-agent",
  "version",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-turn-state",
  "x-codex-turn-metadata",
  "x-codex-window-id",
  "x-codex-parent-thread-id",
  "x-codex-installation-id",
  "x-openai-subagent",
  "x-openai-memgen-request",
  "x-openai-internal-codex-responses-lite",
] as const;

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

function failure(status: number, reason: string): Response {
  return new Response(`${reason}\n`, {
    status,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}

/**
 * Construct one selected-account transport in the trusted broker.
 * `persist` must atomically compare expectedAuthJson and replace only while its
 * signal remains live. The host must serialise owners of the same auth file.
 * Neither its arguments nor this function belong inside the agent container.
 */
export function createCodexSubscriptionTransport(options: {
  authJson: string;
  accountId: string;
  now?: () => number;
  signal?: AbortSignal;
  persist: (replacement: {
    expectedAuthJson: string;
    authJson: string;
    signal: AbortSignal;
  }) => Promise<void>;
  fetch?: (request: Request) => Promise<Response>;
}): (request: Request) => Promise<Response> {
  let current = snapshot(options.authJson, options.accountId);
  const accountId = options.accountId;
  const forward = options.fetch ?? fetch;
  const persist = options.persist;
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
              refresh_token: previous.refreshToken,
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
                ? previous.refreshToken
                : token(result.refresh_token),
              id_token:
                result.id_token === undefined || result.id_token === null
                  ? previous.idToken
                  : token(result.id_token),
            },
            last_refresh: new Date(now()).toISOString(),
          }),
          accountId,
        );
        if (stale(replacement)) throw new Error("Replacement already expired");
      } catch {
        throw latchFailure("Codex subscription refresh failed");
      }
      signal.throwIfAborted();
      try {
        await persist({
          expectedAuthJson: previous.authJson,
          authJson: replacement.authJson,
          signal,
        });
        signal.throwIfAborted();
      } catch {
        throw latchFailure("Codex subscription persistence failed");
      }
      current = replacement;
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
