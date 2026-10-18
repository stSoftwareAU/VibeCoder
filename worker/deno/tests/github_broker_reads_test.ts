/** The read extension accepts only known documents and host-authorised scope. */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  githubBrokerReadHeaders,
  resolveGitHubBrokerRead,
} from "../lib/github_broker_reads.ts";
import { GRAPHQL_QUOTA_PROBE_QUERY } from "../lib/graphql_quota_probe.ts";

const repositories = new Set(["fixture/allowed", "fixture/also-allowed"]);
const encoder = new TextEncoder();
const login = "query UserCurrent{viewer{login}}";
// gh 2.97.0 FetchRepository: these two shapes are used by the existing
// issue_routing_github and stranded_issue_branch callers respectively.
const permission = `query RepositoryInfo($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {viewerPermission}
}`;
const defaultBranch = `query RepositoryInfo($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {defaultBranchRef{name}}
}`;

function request(path: string, method = "GET"): Request {
  return new Request(`http://broker.invalid${path}`, { method });
}

function graphql(payload: unknown, method = "POST", path = "/github/graphql") {
  return resolveGitHubBrokerRead(
    request(path, method),
    repositories,
    encoder.encode(JSON.stringify(payload)),
  );
}

Deno.test("GitHub broker reads allow exactly the global startup routes and existing scoped REST reads", () => {
  for (const path of ["/", "/user", "/rate_limit"]) {
    for (const method of ["GET", "HEAD"]) {
      const result = resolveGitHubBrokerRead(
        request(`/github${path}`, method),
        new Set(),
      );
      assert(result);
      assertEquals(result.upstream.href, `https://api.github.com${path}`);
      assertEquals(result.body, undefined);
    }
  }
  for (const method of ["GET", "HEAD"]) {
    const result = resolveGitHubBrokerRead(
      request("/github/repos/fixture/allowed/issues?per_page=1&page=2", method),
      repositories,
    );
    assertEquals(
      result?.upstream.href,
      "https://api.github.com/repos/fixture/allowed/issues?per_page=1&page=2",
    );
  }
});

Deno.test("GitHub broker reads reject route, method, query and trusted-scope bypasses", () => {
  for (
    const path of [
      "/github",
      "/github/user/keys",
      "/github/user/repos",
      "/github/users/fixture",
      "/github/user?per_page=1",
      "/github/?token=hidden",
      "/github/rate_limit?resource=graphql",
      "/github/repos/fixture/other/issues",
      "/github/repos/fixture/allowed-extra/issues",
      "/github/repos/fixture/allowed/issues?access_token=hidden",
      "/github/repos/fixture/allowed%2F..%2Fother/issues",
      "/claude/v1/messages",
    ]
  ) {
    assertEquals(
      resolveGitHubBrokerRead(request(path), repositories),
      undefined,
      path,
    );
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (
      const path of [
        "/github/",
        "/github/user",
        "/github/rate_limit",
        "/github/repos/fixture/allowed/issues",
      ]
    ) {
      assertEquals(
        resolveGitHubBrokerRead(request(path, method), repositories),
        undefined,
        `${method} ${path}`,
      );
    }
  }
  assertEquals(
    resolveGitHubBrokerRead(
      request("/github/repos/fixture/allowed/issues"),
      new Set(),
    ),
    undefined,
  );
  assertEquals(
    resolveGitHubBrokerRead(
      request("/github/user"),
      repositories,
      encoder.encode("body"),
    ),
    undefined,
  );
});

Deno.test("GitHub broker reads accept pinned native login and the actual worker quota query", () => {
  for (const query of [login, GRAPHQL_QUOTA_PROBE_QUERY]) {
    for (const variables of [undefined, null, {}]) {
      const result = graphql({ query, variables });
      assert(result);
      assertEquals(result.upstream.href, "https://api.github.com/graphql");
      assert(result.body);
      const payload = JSON.parse(new TextDecoder().decode(result.body));
      assertEquals(payload.query, query);
      assertEquals(payload.variables, {});
    }
  }
  assert(graphql({ query: login, operationName: "UserCurrent" }));
  assert(graphql({ query: GRAPHQL_QUOTA_PROBE_QUERY, operationName: null }));
});

Deno.test("GitHub broker reads scope native RepositoryInfo documents to validated owner and name variables", () => {
  for (const query of [permission, defaultBranch]) {
    const result = graphql({
      query,
      operationName: "RepositoryInfo",
      variables: { owner: "Fixture", name: "Allowed" },
    });
    assert(result?.body);
    assertEquals(result.upstream.href, "https://api.github.com/graphql");
    const payload = JSON.parse(new TextDecoder().decode(result.body));
    assertEquals(payload.variables, { owner: "Fixture", name: "Allowed" });
    assertEquals(payload.operationName, "RepositoryInfo");
    assertEquals(
      graphql({ query, variables: { owner: "fixture", name: "other" } }),
      undefined,
    );
  }
  assert(
    graphql({
      query: defaultBranch.replaceAll(" ", "\n").replace("$name:", ",$name:"),
      variables: { owner: "fixture", name: "allowed" },
    }),
  );
});

Deno.test("GitHub broker reads refuse unknown GraphQL documents, aliases, fragments and multi-operation bodies", () => {
  for (
    const query of [
      "{viewer{login}}",
      "query UserCurrent{viewer{id}}",
      "query UserCurrent{viewer{login email}}",
      "query UserCurrent{alias:viewer{login}}",
      "query UserCurrent{viewer{...Login}} fragment Login on User{login}",
      `${login} mutation {deleteRepository(input:{repositoryId:\"secret\"}){clientMutationId}}`,
      `${login} query Other{viewer{email}}`,
      `${login} # comment`,
      "query UserCurrent{view er{login}}",
      "query UserCurrent{viewer{login}7}",
      "query UserCurrent{viewer{login}}!",
      login.replace("login", "lo\u0000gin"),
      `${login}\u0000`,
      permission.replace("viewerPermission", "parent{nameWithOwner}"),
      permission.replace("repository(owner:", "second:repository(owner:"),
      permission.replace("$owner", '"fixture"'),
      "",
      " \t\n,",
      "{",
      'mutation{changeUserStatus(input:{message:"x"}){clientMutationId}}',
    ]
  ) {
    assertEquals(
      graphql({ query, variables: { owner: "fixture", name: "allowed" } }),
      undefined,
      query,
    );
    assertEquals(graphql({ query }), undefined, query);
  }
  assertEquals(graphql({ query: login, operationName: "Other" }), undefined);
  assertEquals(
    graphql({ query: GRAPHQL_QUOTA_PROBE_QUERY, operationName: "RateLimit" }),
    undefined,
  );
  assertEquals(graphql({ query: login }, "GET"), undefined);
  assertEquals(graphql({ query: login }, "HEAD"), undefined);
  assertEquals(
    graphql({ query: login }, "POST", "/github/graphql?query=anything"),
    undefined,
  );
  assertEquals(
    graphql({ query: login }, "POST", "/github/graphql/"),
    undefined,
  );
});

Deno.test("GitHub broker reads reject malformed GraphQL envelopes, extra authority and invalid variables", () => {
  for (
    const payload of [
      null,
      [],
      "query",
      7,
      {},
      { query: null },
      { query: 7 },
      { query: [login] },
      { query: login, extensions: { persistedQuery: {} } },
      { query: login, repositories: ["fixture/other"] },
      { query: login, operationName: 1 },
      { query: login, operationName: "" },
      { query: login, variables: { owner: "fixture" } },
      { query: login, variables: [] },
      { query: login, variables: false },
      { query: login, variables: "" },
    ]
  ) assertEquals(graphql(payload), undefined, JSON.stringify(payload));
  for (
    const variables of [
      undefined,
      null,
      {},
      { owner: "fixture" },
      { name: "allowed" },
      { owner: 1, name: "allowed" },
      { owner: "fixture", name: 1 },
      { owner: "fixture", name: "allowed", approved: true },
      { owner: "fixture/other", name: "allowed" },
      { owner: "fixture", name: "../allowed" },
      { owner: "fixture", name: "" },
      { owner: "", name: "allowed" },
    ]
  ) {
    assertEquals(
      graphql({ query: permission, variables }),
      undefined,
      JSON.stringify(variables),
    );
  }
  for (
    const body of [
      encoder.encode("{"),
      new Uint8Array([0xff]),
      encoder.encode(" ".repeat(16_385)),
    ]
  ) {
    assertEquals(
      resolveGitHubBrokerRead(
        request("/github/graphql", "POST"),
        repositories,
        body,
      ),
      undefined,
    );
  }
});

Deno.test("GitHub broker reads enforce GraphQL byte and variable type boundaries before canonical forwarding", () => {
  const json = JSON.stringify({ query: login });
  const maximum = encoder.encode(json.padEnd(16_384));
  assert(
    resolveGitHubBrokerRead(
      request("/github/graphql", "POST"),
      repositories,
      maximum,
    ),
  );
  assertEquals(
    resolveGitHubBrokerRead(
      request("/github/graphql", "POST"),
      repositories,
      encoder.encode(json.padEnd(16_385)),
    ),
    undefined,
  );
  for (
    const variables of [{ owner: 1, name: "allowed" }, {
      owner: "fixture",
      name: 1,
    }]
  ) {
    assertEquals(
      resolveGitHubBrokerRead(
        request("/github/graphql", "POST"),
        new Set(["1/allowed", "fixture/1"]),
        encoder.encode(JSON.stringify({ query: permission, variables })),
      ),
      undefined,
    );
  }
  const before = encoder.encode('{"query":"');
  const after = encoder.encode(`","query":${JSON.stringify(login)}}`);
  const malformed = new Uint8Array([...before, 0xff, ...after]);
  assertEquals(
    resolveGitHubBrokerRead(
      request("/github/graphql", "POST"),
      repositories,
      malformed,
    ),
    undefined,
  );
});

Deno.test("GitHub broker reads forward a canonical validated body instead of ambiguous raw JSON", () => {
  const raw = `{"query":"mutation{deleteRepository}","query":${
    JSON.stringify(login)
  },"variables":null}`;
  const result = resolveGitHubBrokerRead(
    request("/github/graphql", "POST"),
    repositories,
    encoder.encode(raw),
  );
  assert(result?.body);
  assertEquals(
    new TextDecoder().decode(result.body),
    JSON.stringify({ query: login, variables: {} }),
  );
  const reversed = `{"query":${
    JSON.stringify(login)
  },"query":"mutation{deleteRepository}"}`;
  assertEquals(
    resolveGitHubBrokerRead(
      request("/github/graphql", "POST"),
      repositories,
      encoder.encode(reversed),
    ),
    undefined,
  );
});

const collection = new URL(
  "https://api.github.com/repos/fixture/allowed/issues?labels=bug,help&per_page=100&state=open",
);
function pageLink(page: string, relation = "next", url = collection): string {
  const target = new URL(url);
  target.searchParams.set("page", page);
  return `<${target.href}>; rel="${relation}"`;
}

Deno.test("GitHub broker read headers preserve scope and quota metadata without exposing auth or cookies", () => {
  const allowed = {
    "x-oauth-scopes": "repo, read:org",
    "x-accepted-oauth-scopes": "repo",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4999",
    "x-ratelimit-used": "1",
    "x-ratelimit-reset": "1800000000",
    "x-ratelimit-resource": "graphql",
  };
  const headers = githubBrokerReadHeaders(
    new URL("https://api.github.com/graphql"),
    new Headers({
      ...allowed,
      "authorization": "secret",
      "set-cookie": "secret",
      "location": "https://other.invalid",
      "x-debug": "secret",
    }),
    repositories,
  );
  assertEquals(Object.fromEntries(headers), allowed);
  assertEquals([
    ...githubBrokerReadHeaders(collection, new Headers(), repositories),
  ], []);
});

Deno.test("GitHub broker read pagination preserves every safe same-resource page link", () => {
  const links = [
    pageLink("2"),
    pageLink("10", "last"),
    pageLink("1", "first"),
    pageLink("1", "prev"),
  ].join(", ");
  const result = githubBrokerReadHeaders(
    collection,
    new Headers({ link: links }),
    repositories,
  );
  assertEquals(result.get("link"), links);
  const reordered =
    '<https://api.github.com/repos/fixture/allowed/issues?state=open&page=2&labels=bug%2Chelp&per_page=100>; rel="next"';
  assertEquals(
    githubBrokerReadHeaders(
      collection,
      new Headers({ link: reordered }),
      repositories,
    ).get("link"),
    reordered,
  );
});

Deno.test("GitHub broker read pagination fails loudly on scope, origin, filter or credential changes", () => {
  for (
    const target of [
      "https://other.invalid/repos/fixture/allowed/issues",
      "http://api.github.com/repos/fixture/allowed/issues",
      "https://api.github.com:444/repos/fixture/allowed/issues",
      "https://user@api.github.com/repos/fixture/allowed/issues",
      "https://:hidden@api.github.com/repos/fixture/allowed/issues",
      "https://api.github.com/repos/fixture/also-allowed/issues",
      "https://api.github.com/repos/fixture/other/issues",
      "https://api.github.com/repos/fixture/allowed/pulls",
      "https://api.github.com/user",
      "https://api.github.com/graphql",
    ]
  ) {
    const url = new URL(target);
    url.search = collection.search;
    const link = pageLink("2", "next", url);
    assertThrows(
      () =>
        githubBrokerReadHeaders(
          collection,
          new Headers({ link }),
          repositories,
        ),
      Error,
      "GitHub pagination link denied",
    );
  }
  for (
    const change of [
      (u: URL) => u.searchParams.set("access_token", "hidden"),
      (u: URL) => u.searchParams.set("state", "closed"),
      (u: URL) => u.searchParams.delete("labels"),
      (u: URL) => u.searchParams.set("per_page", "1"),
      (u: URL) => u.searchParams.append("page", "3"),
      (u: URL) => u.hash = "hidden",
    ]
  ) {
    const url = new URL(collection);
    url.searchParams.set("page", "2");
    change(url);
    assertThrows(
      () =>
        githubBrokerReadHeaders(
          collection,
          new Headers({ link: `<${url}>; rel="next"` }),
          repositories,
        ),
      Error,
      "GitHub pagination link denied",
    );
  }
  assertThrows(
    () =>
      githubBrokerReadHeaders(
        collection,
        new Headers({ link: pageLink("2") }),
        new Set(),
      ),
    Error,
    "GitHub pagination link denied",
  );
});

Deno.test("GitHub broker read pagination bounds otherwise valid Link metadata", () => {
  const current = new URL(
    "https://api.github.com/repos/fixture/allowed/issues?labels=",
  );
  const overhead = pageLink("2", "next", current).length;
  current.searchParams.set("labels", "x".repeat(8192 - overhead));
  const atLimit = pageLink("2", "next", current);
  assertEquals(atLimit.length, 8192);
  assertEquals(
    githubBrokerReadHeaders(
      current,
      new Headers({ link: atLimit }),
      repositories,
    ).get("link"),
    atLimit,
  );
  current.searchParams.set("labels", `${current.searchParams.get("labels")}x`);
  const beyond = pageLink("2", "next", current);
  assertEquals(beyond.length, 8193);
  assertThrows(
    () =>
      githubBrokerReadHeaders(
        current,
        new Headers({ link: beyond }),
        repositories,
      ),
    Error,
    "GitHub pagination link denied",
  );
});

Deno.test("GitHub broker read pagination rejects ambiguous or unsupported headers instead of truncating results", () => {
  for (
    const link of [
      "",
      "garbage",
      '<not-a-url>; rel="next"',
      '</relative>; rel="next"',
      `${pageLink("2")},`,
      `${pageLink("2")}, ${pageLink("3")}`,
      `${pageLink("2")}; token=hidden`,
      `${pageLink("2")} garbage`,
      pageLink("2", "alternate"),
      pageLink("0"),
      pageLink("-1"),
      pageLink("1.5"),
      pageLink("not-page"),
      `<${collection}>; rel="next"`,
      " ".repeat(8193),
    ]
  ) {
    assertThrows(
      () =>
        githubBrokerReadHeaders(
          collection,
          new Headers({ link }),
          repositories,
        ),
      Error,
      "GitHub pagination link denied",
      link,
    );
  }
  assertThrows(
    () =>
      githubBrokerReadHeaders(
        new URL("https://api.github.com/user"),
        new Headers({
          link: '<https://api.github.com/user?page=2>; rel="next"',
        }),
        repositories,
      ),
    Error,
    "GitHub pagination link denied",
  );
});
