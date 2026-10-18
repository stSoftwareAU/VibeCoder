/**
 * Closed, read-only GitHub policy extension for the credential broker.
 *
 * This module grants neither writes nor git transport. Its caller authenticates
 * the run capability and bounds the streaming body before passing those bytes
 * here. Repository authority comes only from the trusted supervisor's set.
 */
import {
  CREDENTIAL_BROKER_UPSTREAMS,
  resolveCredentialBrokerRoute,
} from "./credential_broker_policy.ts";

/** Forward this exact validated body, never the original GraphQL request bytes. */
export interface GitHubBrokerRead {
  upstream: URL;
  body?: Uint8Array<ArrayBuffer>;
}

const origin = CREDENTIAL_BROKER_UPSTREAMS.github;
const globalPaths = new Set(["/github/", "/github/user", "/github/rate_limit"]);

/**
 * This is a closed token grammar, not a general GraphQL parser. The registered
 * documents need no comments, strings, directives, fragments or numeric literals.
 * Keep name boundaries: `view er` must never normalise to `viewer`.
 */
function documentKey(document: string): string {
  return (document.match(/[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[$!():{}]/g) ?? [])
    .join(" ");
}

// Pinned native source: cli/cli v2.97.0 (container/tools.json), api/queries_user.go,
// api/queries_repo.go FetchRepository and api/query_builder.go RepositoryGraphQL.
// The quota document is the existing graphql_quota_probe.ts request. Keep this
// policy snapshot closed: a caller adding fields must not silently grant them.
const documents = new Map([
  [documentKey("query UserCurrent{viewer{login}}"), {
    name: "UserCurrent",
    repository: false,
  }],
  [documentKey("{ rateLimit { limit remaining used resetAt } }"), {
    name: undefined,
    repository: false,
  }],
  ...["viewerPermission", "defaultBranchRef{name}"].map((fields) =>
    [
      documentKey(`query RepositoryInfo($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {${fields}}
    }`),
      { name: "RepositoryInfo", repository: true },
    ] as const
  ),
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function graphqlBody(
  bytes: Uint8Array,
  repositories: ReadonlySet<string>,
): Uint8Array<ArrayBuffer> | undefined {
  // The streaming broker has a separate whole-request bound. These small
  // documents also have a strict parse bound independent of that configuration.
  if (bytes.byteLength > 16_384) return;
  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return;
  }
  if (!record(payload)) return;
  if (
    Object.keys(payload).some((key) =>
      !["query", "variables", "operationName"].includes(key)
    )
  ) return;
  const query = payload.query;
  if (typeof query !== "string") return;
  if (!/^[A-Za-z0-9_$!():{} \t\r\n,]+$/.test(query)) return;
  const document = documents.get(documentKey(query));
  if (!document) return;
  const operationName = payload.operationName;
  if (operationName != null && operationName !== document.name) return;
  const variables = payload.variables ?? {};
  if (!record(variables)) return;
  if (document.repository) {
    if (Object.keys(variables).length !== 2) return;
    const { owner, name } = variables;
    if (typeof owner !== "string" || typeof name !== "string") return;
    if (!repositories.has(`${owner}/${name}`.toLowerCase())) return;
  } else if (Object.keys(variables).length !== 0) return;
  // JSON duplicates have one meaning here and at the upstream because only
  // this canonical object crosses the boundary, never the ambiguous raw bytes.
  return new TextEncoder().encode(JSON.stringify({
    query,
    variables,
    ...(operationName != null ? { operationName } : {}),
  }));
}

/** Resolve known reads after capability authentication and bounded body reading. */
export function resolveGitHubBrokerRead(
  request: Request,
  repositories: ReadonlySet<string>,
  body: Uint8Array = new Uint8Array(),
): GitHubBrokerRead | undefined {
  const url = new URL(request.url);
  if (
    request.method === "POST" && url.pathname === "/github/graphql" &&
    !url.search
  ) {
    const validated = graphqlBody(body, repositories);
    if (!validated) return;
    return { upstream: new URL("/graphql", origin), body: validated };
  }
  if (request.method !== "GET" && request.method !== "HEAD") return;
  if (body.byteLength !== 0) return;
  if (globalPaths.has(url.pathname) && !url.search) {
    return { upstream: new URL(url.pathname.slice("/github".length), origin) };
  }
  const route = resolveCredentialBrokerRoute(request, repositories);
  if (route?.service !== "github") return;
  return { upstream: route.upstream };
}

function paginationDenied(): never {
  // Do not echo an upstream URL/header: it could contain a planted credential.
  throw new Error("GitHub pagination link denied");
}

/** Filters must remain identical; only the page number may change. */
function filters(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete("page");
  params.sort();
  return params.toString();
}

function paginationLink(
  current: URL,
  link: string,
  repositories: ReadonlySet<string>,
): string {
  if (link.length > 8192) paginationDenied();
  const relations = new Set<string>();
  const links: string[] = [];
  for (const part of link.split(/,(?=\s*<)/)) {
    const match = /^\s*<([^<>\s]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(
      part,
    );
    if (!match) paginationDenied();
    const address = match[1]!;
    const relation = match[2]!;
    if (relations.has(relation)) paginationDenied();
    relations.add(relation);
    let target: URL;
    try {
      target = new URL(address);
    } catch {
      paginationDenied();
    }
    if (
      target.origin !== origin || target.username || target.password ||
      target.hash
    ) paginationDenied();
    if (target.pathname !== current.pathname) paginationDenied();
    if (filters(target) !== filters(current)) paginationDenied();
    const pages = target.searchParams.getAll("page");
    if (pages.length !== 1 || !/^[1-9][0-9]*$/.test(pages[0]!)) {
      paginationDenied();
    }
    const route = resolveCredentialBrokerRoute(
      new Request(
        `http://broker.invalid/github${target.pathname}${target.search}`,
      ),
      repositories,
    );
    if (route?.service !== "github") paginationDenied();
    links.push(`<${target.href}>; rel="${relation}"`);
  }
  return links.join(", ");
}

/**
 * Additional safe response metadata for authenticated GitHub reads. Merge it
 * into the broker's existing response allowlist. Invalid Link fails the whole
 * response; dropping it would make `gh api --paginate` silently omit pages.
 */
export function githubBrokerReadHeaders(
  upstream: URL,
  headers: Headers,
  repositories: ReadonlySet<string>,
): Headers {
  const result = new Headers();
  for (
    const name of [
      "x-oauth-scopes",
      "x-accepted-oauth-scopes",
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-used",
      "x-ratelimit-reset",
      "x-ratelimit-resource",
    ]
  ) {
    const value = headers.get(name);
    if (value !== null) result.set(name, value);
  }
  const link = headers.get("link");
  if (link !== null) {
    result.set("link", paginationLink(upstream, link, repositories));
  }
  return result;
}
