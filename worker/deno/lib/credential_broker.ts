/**
 * Experimental request broker: credentials stay on the forwarding side of a
 * separate container boundary (#3698, #3699). It does not create that
 * boundary or enable normal worker startup by itself.
 *
 * No arbitrary CONNECT, redirects, agent token-issuing endpoints or
 * caller-selected upstreams. Ordinary GitHub writes require a trusted grant.
 * Errors deliberately name a stable category
 * rather than an upstream exception that may contain an injected credential.
 */
import {
  assertBrokerCapability,
  type BrokerService,
  CREDENTIAL_BROKER_UPSTREAMS,
  resolveCredentialBrokerRoute,
} from "./credential_broker_policy.ts";
import {
  githubBrokerReadHeaders,
  resolveGitHubBrokerRead,
} from "./github_broker_reads.ts";
import {
  type GitHubBrokerWriteContext,
  resolveGitHubBrokerWrite,
} from "./github_broker_writes.ts";
import type { MutationInfo } from "./audit_mutation_classifier.ts";
import { createCodexSubscriptionTransport } from "./codex_subscription_transport.ts";
import { CODEX_SUBSCRIPTION_METADATA_HEADERS } from "./codex_transport_headers.ts";
import { resolveGitBrokerRequest } from "./git_broker_transport.ts";

export interface CredentialBrokerOptions {
  /** Per-run broker capability; never an upstream provider/GitHub credential. */
  capability: string;
  /**
   * Selected upstream values, held only by the trusted broker. Claude's value
   * uses claudeAuthentication; no fallback or token refresh is implied.
   */
  credentials: Partial<Record<BrokerService, string>>;
  /** Trusted selection only; bearer mode never falls back to an API key. */
  claudeAuthentication?: "api-key" | "bearer";
  /** Trusted selected subscription snapshot and persistence, never worker input. */
  codexSubscription?: Omit<
    Parameters<typeof createCodexSubscriptionTransport>[0],
    "signal" | "fetch"
  >;
  /** Repository names supplied by the trusted supervisor, not by a worker request. */
  repositories: readonly string[];
  /** Host opt-in to scoped upload-pack only; this never grants Git writes. */
  gitReads?: boolean;
  /** Explicit host grant; no agent request can select a claim or audit target. */
  githubWrites?: {
    claimedIssue?: GitHubBrokerWriteContext["claimedIssue"];
    /** Trusted journal callback. An absent status means transport outcome unknown. */
    audit: (mutation: MutationInfo, status?: number) => Promise<void>;
  };
  /** Production defaults to fetch; tests can observe the outgoing request. */
  fetch?: (request: Request) => Promise<Response>;
  /** Hard request-body bound, including streaming/chunked requests. */
  maxRequestBytes?: number;
  /** Trusted session lifetime; callers cannot override it in a request. */
  signal?: AbortSignal;
}

function failure(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}

async function refuseResponse(
  response: Response,
  status: number,
  reason: string,
): Promise<Response> {
  try {
    await response.body?.cancel();
  } catch {
    // The response stays refused; report the cleanup failure without leaking
    // an upstream exception, which may include an injected credential.
    return failure(status, `${reason}; upstream cancellation failed`);
  }
  return failure(status, reason);
}

async function boundedBody(
  request: Request,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const abort = () => {
    // A rejected underlying cancel still settles pending reads. The signal
    // check below maps that attempt to a refused request, never a success.
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        return;
      }
      chunks.push(value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** Create one run-scoped handler; callers provide the network boundary. */
export function createCredentialBroker(
  options: CredentialBrokerOptions,
): (request: Request) => Promise<Response> {
  assertBrokerCapability(options.capability);
  const claudeAuthentication = options.claudeAuthentication ?? "api-key";
  if (claudeAuthentication !== "api-key" && claudeAuthentication !== "bearer") {
    throw new Error("Unsupported broker Claude authentication mode");
  }
  const maximum = options.maxRequestBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new Error(
      "Broker request-body limit must be a positive safe integer",
    );
  }
  if (
    options.repositories.some((repo) =>
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
    )
  ) {
    throw new Error("Broker repositories must be owner/name pairs");
  }
  const repositories = new Set(
    options.repositories.map((repo) => repo.toLowerCase()),
  );
  const credentials = { ...options.credentials };
  for (const value of Object.values(credentials)) {
    if (!/^[\x21-\x7e]+$/.test(value)) {
      throw new Error("Invalid broker credential");
    }
  }
  const capabilityHash = crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`Bearer ${options.capability}`),
  );
  const forward = options.fetch ?? fetch;
  const subscription = options.codexSubscription
    ? createCodexSubscriptionTransport({
      ...options.codexSubscription,
      signal: options.signal,
      fetch: forward,
    })
    : undefined;
  const writes = options.githubWrites;
  if (writes && typeof writes.audit !== "function") {
    throw new Error("GitHub writes require a trusted audit journal");
  }
  const writeContext: GitHubBrokerWriteContext = {
    repositories: [...repositories],
    ...(writes?.claimedIssue
      ? { claimedIssue: { ...writes.claimedIssue } }
      : {}),
  };
  const auditWrite = writes?.audit;
  const gitReads = options.gitReads === true;
  const gitContext = {
    repositories: [...repositories].map((repo) => ({
      repo,
      defaultBranch: "",
      protectedBranches: [],
    })),
    transactions: [],
  };
  const gitRead = (request: Request, bytes = new Uint8Array()) => {
    if (!gitReads) return;
    const decision = resolveGitBrokerRequest(request, gitContext, bytes);
    if (
      decision.allowed &&
      (decision.kind === "fetch" ||
        (decision.kind === "discovery" &&
          decision.upstream.search === "?service=git-upload-pack"))
    ) return decision;
    return undefined;
  };

  return async (request) => {
    if (options.signal?.aborted) {
      return failure(503, "Broker session is closed");
    }
    const presented = request.headers.get("authorization") ?? "";
    const actual = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(presented),
      ),
    );
    const expected = new Uint8Array(await capabilityHash);
    let difference = 0;
    for (let index = 0; index < expected.length; index++) {
      difference |= expected[index]! ^ actual[index]!;
    }
    if (difference !== 0) return failure(401, "Broker capability required");
    let route: { service: BrokerService | "git"; upstream: URL } | undefined =
      resolveCredentialBrokerRoute(request, repositories);
    const url = new URL(request.url);
    let gitRequest = request;
    const compressedGit = url.pathname.startsWith("/git/") &&
      request.method === "POST" &&
      request.headers.get("content-encoding") === "gzip";
    if (compressedGit) {
      const headers = new Headers(request.headers);
      headers.delete("content-encoding");
      // Policy sees the eventual uncompressed metadata. Body validation below
      // separately bounds wire bytes and inflated bytes before any forwarding.
      gitRequest = new Request(request.url, {
        method: request.method,
        headers,
      });
    }
    if (url.pathname.startsWith("/git/")) {
      const read = gitRead(gitRequest);
      route = read ? { service: "git", upstream: read.upstream } : undefined;
    }
    if (url.pathname.startsWith("/github/")) {
      const read = resolveGitHubBrokerRead(request, repositories);
      if (read) route = { service: "github", upstream: read.upstream };
      else if (
        request.method === "POST" && url.pathname === "/github/graphql" &&
        !url.search
      ) {
        // Only this exact endpoint may await bounded body validation below.
        // Authentication has already run; no unknown GraphQL is forwarded.
        route = {
          service: "github",
          upstream: new URL("/graphql", CREDENTIAL_BROKER_UPSTREAMS.github),
        };
      } else if (
        writes && ["POST", "PATCH"].includes(request.method) &&
        url.pathname.startsWith("/github/repos/") && !url.search
      ) {
        // This is only a pending body check. The closed write policy below
        // supplies the actual upstream after validating and redacting bytes.
        route = {
          service: "github",
          upstream: new URL(CREDENTIAL_BROKER_UPSTREAMS.github),
        };
      }
    }
    if (!route) return failure(403, "Broker route denied");
    const credential = credentials[
      route.service === "git" ? "github" : route.service
    ];
    if (route.service === "codex-subscription" ? !subscription : !credential) {
      return failure(503, "Broker service is not configured");
    }

    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(180_000),
      ...(options.signal ? [options.signal] : []),
    ]);

    let body: Uint8Array<ArrayBuffer> | undefined;
    try {
      body = await boundedBody(request, maximum, signal);
      if (body && compressedGit) {
        body = await boundedBody(
          new Request(request.url, {
            method: "POST",
            body: new Blob([body]).stream().pipeThrough(
              new DecompressionStream("gzip"),
            ),
          }),
          maximum,
          signal,
        );
      }
    } catch {
      if (options.signal?.aborted) {
        return failure(503, "Broker session is closed");
      }
      if (signal.aborted) return failure(408, "Broker request was cancelled");
      return failure(400, "Request body could not be read");
    }
    if (!body) return failure(413, "Request body exceeds broker limit");
    let mutation: MutationInfo | undefined;
    if (route.service === "github") {
      const read = resolveGitHubBrokerRead(request, repositories, body);
      if (read) {
        route = { service: "github", upstream: read.upstream };
        body = read.body ?? body;
      } else {
        const write = writes &&
          resolveGitHubBrokerWrite(request, writeContext, body);
        if (!write || !write.allowed) {
          return failure(403, "Broker route denied");
        }
        route = { service: "github", upstream: write.upstream };
        body = write.body;
        mutation = write.mutation;
      }
    }
    let headers = new Headers();
    if (route.service === "git") {
      const read = gitRead(gitRequest, body);
      if (!read) return failure(403, "Broker route denied");
      route = { service: "git", upstream: read.upstream };
      body = read.body;
      headers = read.headers;
    } else {
      headers.set("accept", "application/json, text/event-stream");
      if (body.byteLength > 0) headers.set("content-type", "application/json");
    }
    if (route.service === "codex-subscription") {
      for (const name of CODEX_SUBSCRIPTION_METADATA_HEADERS) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
    }
    const anthropic = route.service === "claude" ||
      (route.service === "deepseek" &&
        route.upstream.pathname.startsWith("/anthropic/"));
    if (anthropic) {
      // The official gateway protocol defines this as an open namespace:
      // new capability headers must survive together with their body fields.
      // Upstream authentication stays exclusively in the injected headers.
      for (const [name, value] of request.headers) {
        if (name.startsWith("anthropic-")) headers.set(name, value);
      }
      if (!headers.has("anthropic-version")) {
        headers.set("anthropic-version", "2023-06-01");
      }
    }
    if (route.service === "claude" && claudeAuthentication === "api-key") {
      headers.set("x-api-key", credential!);
    } else if (route.service === "gemini") {
      headers.set("x-goog-api-key", credential!);
    } else if (route.service === "git") {
      headers.set(
        "authorization",
        `Basic ${btoa(`x-access-token:${credential}`)}`,
      );
    } else if (route.service !== "codex-subscription") {
      headers.set("authorization", `Bearer ${credential}`);
    }
    if (route.service === "github") {
      headers.set("x-github-api-version", "2022-11-28");
    }
    // Authentication/body reads yield. Recheck immediately before crossing
    // the boundary so even a custom transport cannot start after revocation.
    if (signal.aborted) {
      return failure(
        options.signal?.aborted ? 503 : 408,
        options.signal?.aborted
          ? "Broker session is closed"
          : "Broker request was cancelled",
      );
    }
    let response: Response;
    let status: number | undefined;
    try {
      response = await (route.service === "codex-subscription"
        ? subscription!
        : forward)(
          new Request(route.upstream, {
            method: request.method,
            headers,
            body: ["POST", "PATCH"].includes(request.method)
              ? body
              : undefined,
            redirect: "manual",
            signal,
          }),
        );
      status = response.status;
    } catch {
      if (options.signal?.aborted) {
        return failure(503, "Broker session is closed");
      }
      return failure(502, "Upstream request failed");
    } finally {
      if (mutation) {
        try {
          await auditWrite!(mutation, status);
        } catch {
          // Match the existing journal contract: publication has already
          // happened, so record failure loudly without inducing a retry.
          console.error(
            "[SECURITY] [AUDIT_JOURNAL_REFUSED] Broker write outcome could not be recorded",
          );
        }
      }
    }
    if (signal.aborted) {
      return refuseResponse(
        response,
        options.signal?.aborted ? 503 : 408,
        options.signal?.aborted
          ? "Broker session is closed"
          : "Broker request was cancelled",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      return refuseResponse(response, 502, "Upstream redirect refused");
    }
    const responseHeaders = new Headers({ "cache-control": "no-store" });
    // An allowlist keeps auth/cookie/location/debug headers from the agent.
    for (const [name, value] of response.headers) {
      if (
        ["content-type", "retry-after", "x-request-id", "request-id"].includes(
          name,
        ) ||
        (route.service === "codex-subscription" &&
          name === "x-codex-turn-state") ||
        (anthropic &&
          (name === "x-should-retry" ||
            name.startsWith("anthropic-ratelimit-unified-")))
      ) responseHeaders.set(name, value);
    }
    if (route.service === "github") {
      try {
        for (
          const [name, value] of githubBrokerReadHeaders(
            route.upstream,
            response.headers,
            repositories,
          )
        ) responseHeaders.set(name, value);
      } catch {
        return refuseResponse(response, 502, "GitHub pagination refused");
      }
    }
    // Enforce revocation even when a forwarding implementation does not
    // cancel a response body after its request signal aborts.
    const stream = response.body?.pipeThrough(new TransformStream(), {
      signal,
    });
    return new Response(stream, {
      status: response.status,
      headers: responseHeaders,
    });
  };
}
