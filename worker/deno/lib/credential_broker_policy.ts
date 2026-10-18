/**
 * Fixed upstreams for the experimental credential broker (#3698, #3699).
 *
 * This is deliberately narrower than the worker's network needs. It is NOT
 * wired into agent startup: native CLI transport and network isolation still
 * need integration evidence before the broker can replace readable secrets.
 */
export const CREDENTIAL_BROKER_UPSTREAMS = {
  claude: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  deepseek: "https://api.deepseek.com",
  gemini: "https://generativelanguage.googleapis.com",
  github: "https://api.github.com",
  "codex-subscription": "https://chatgpt.com",
} as const;

/** Trusted refresh only; these endpoints are never agent-accessible routes. */
export const CREDENTIAL_BROKER_AUTH_ENDPOINTS = {
  codex: "https://auth.openai.com/oauth/token",
} as const;

/** The upstream services implemented by the experimental broker. */
export type BrokerService = keyof typeof CREDENTIAL_BROKER_UPSTREAMS;

/** Reject weak or malformed run capabilities before starting either side. */
export function assertBrokerCapability(capability: string): void {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(capability)) {
    throw new Error(
      "Broker capability must contain 32–256 URL-safe characters",
    );
  }
}

/** Decide a route before reading its body or looking up any credential. */
export function resolveCredentialBrokerRoute(
  request: Request,
  repositories: ReadonlySet<string>,
): { service: BrokerService; upstream: URL } | undefined {
  const url = new URL(request.url);
  const segments = url.pathname.split("/");
  const service = segments[1] as BrokerService;
  if (!Object.hasOwn(CREDENTIAL_BROKER_UPSTREAMS, service)) return;
  if (service === "codex-subscription") {
    if (
      request.method !== "POST" ||
      url.pathname !== "/codex-subscription/responses" || url.search
    ) return;
    return {
      service,
      upstream: new URL(
        "/backend-api/codex/responses",
        CREDENTIAL_BROKER_UPSTREAMS[service],
      ),
    };
  }
  const path = "/" + segments.slice(2).join("/");
  // No encoded separators, control characters, dot segments, path parameters,
  // or backslashes. The small API surface below needs none of them. URL has
  // already normalised dot segments; policy is checked on what is forwarded.
  if (!/^\/[A-Za-z0-9_./:\-]*$/.test(path) || path.includes("//")) return;
  if (service === "github") {
    if (request.method !== "GET" && request.method !== "HEAD") return;
    const repo = /^\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/|$)/.exec(
      path,
    );
    if (!repo || !repositories.has(repo[1]!.toLowerCase())) return;
    // Query parameters are closed too: token-bearing/redirect parameters and
    // arbitrary extension parameters must never become a covert auth surface.
    const permittedQuery = new Set([
      "per_page",
      "page",
      "state",
      "sort",
      "direction",
      "ref",
      "since",
      "labels",
      "milestone",
      "assignee",
      "creator",
      "mentioned",
      "base",
      "head",
    ]);
    if ([...url.searchParams.keys()].some((key) => !permittedQuery.has(key))) {
      return;
    }
  } else {
    if (request.method !== "POST") return;
    const permitted = service === "claude"
      ? ["/v1/messages", "/v1/messages/count_tokens"].includes(path)
      : service === "openai"
      ? ["/v1/responses", "/v1/chat/completions"].includes(path)
      : service === "deepseek"
      ? [
        "/anthropic/v1/messages",
        "/anthropic/v1/messages/count_tokens",
        "/chat/completions",
      ].includes(path)
      : /^\/v1beta\/models\/[A-Za-z0-9_.-]+:(?:generateContent|streamGenerateContent)$/
        .test(path);
    if (!permitted) return;
    if (service === "gemini") {
      if (url.search && url.search !== "?alt=sse") return;
    } else if (url.search) {
      // Native Claude Code uses this exact flag on Anthropic-format
      // inference. No additional or duplicate query parameter is needed.
      if (
        (service !== "claude" &&
          !(service === "deepseek" && path.startsWith("/anthropic/"))) ||
        url.search !== "?beta=true"
      ) return;
    }
  }
  return {
    service,
    upstream: new URL(path + url.search, CREDENTIAL_BROKER_UPSTREAMS[service]),
  };
}
