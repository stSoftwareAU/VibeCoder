/** Read-policy integration must retain authentication, body bounds and cancellation. */
import { assertEquals } from "@std/assert";
import { createCredentialBroker } from "../lib/credential_broker.ts";
import { createGitHubAgentGateway } from "../lib/github_agent_gateway.ts";

const capability = "synthetic-read-capability-0123456789abcdef";
const secret = "synthetic-broker-private-github-token";
const userQuery = "query UserCurrent{viewer{login}}";

function request(path: string, body?: string, auth = capability) {
  return new Request(`http://broker.invalid/github${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${auth}` },
    body,
  });
}

Deno.test("authenticated broker permits exact startup reads and canonicalises registered GraphQL", async () => {
  const calls: Request[] = [];
  const broker = createCredentialBroker({
    capability,
    credentials: { github: secret },
    repositories: ["example/repo"],
    fetch(input) {
      calls.push(input);
      return Promise.resolve(Response.json({ viewer: { login: "fixture" } }));
    },
  });
  for (const path of ["/", "/user", "/rate_limit"]) {
    const response = await broker(request(path));
    assertEquals(response.status, 200);
    await response.body?.cancel();
    assertEquals(calls.at(-1)!.url, `https://api.github.com${path}`);
    assertEquals(
      calls.at(-1)!.headers.get("authorization"),
      `Bearer ${secret}`,
    );
  }
  const response = await broker(
    request(
      "/graphql",
      `{"query":"mutation { closeIssue { id } }","query":${
        JSON.stringify(userQuery)
      }}`,
    ),
  );
  assertEquals(response.status, 200);
  await response.body?.cancel();
  assertEquals(calls.at(-1)!.url, "https://api.github.com/graphql");
  assertEquals(
    await calls.at(-1)!.text(),
    JSON.stringify({ query: userQuery, variables: {} }),
  );
});

Deno.test("broker read extension cannot bypass capability, body-size, closed-session or query policy", async () => {
  let calls = 0;
  const controller = new AbortController();
  const broker = createCredentialBroker({
    capability,
    credentials: { github: secret },
    repositories: ["example/repo"],
    maxRequestBytes: 100,
    signal: controller.signal,
    fetch() {
      calls++;
      return Promise.resolve(new Response("unexpected"));
    },
  });
  for (
    const [input, status] of [
      [request("/user", undefined, "incorrect"), 401],
      [
        request(
          "/graphql",
          JSON.stringify({ query: userQuery, padding: "x".repeat(100) }),
        ),
        413,
      ],
      [
        request(
          "/graphql",
          JSON.stringify({ query: "mutation { closeIssue { id } }" }),
        ),
        403,
      ],
      [
        request(
          "/graphql?operation=read",
          JSON.stringify({ query: userQuery }),
        ),
        403,
      ],
      [request("/user?access_token=stolen"), 403],
    ] as const
  ) {
    const response = await broker(input);
    assertEquals(response.status, status);
    await response.body?.cancel();
  }
  controller.abort();
  assertEquals((await broker(request("/user"))).status, 503);
  assertEquals(calls, 0);
});

Deno.test("native GitHub gateway caller receives scoped pagination and safe auth metadata", async () => {
  const link =
    '<https://api.github.com/repos/example/repo/issues?per_page=1&page=2>; rel="next"';
  const broker = createCredentialBroker({
    capability,
    credentials: { github: secret },
    repositories: ["example/repo"],
    fetch: () =>
      Promise.resolve(
        new Response("[]", {
          headers: {
            link,
            "x-oauth-scopes": "repo, read:org",
            "x-ratelimit-remaining": "4999",
            "set-cookie": secret,
          },
        }),
      ),
  });
  const gateway = createGitHubAgentGateway({ capability, forward: broker });
  const response = await gateway(
    new Request("https://api.github.com/repos/example/repo/issues?per_page=1"),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("link"), link);
  assertEquals(response.headers.get("x-oauth-scopes"), "repo, read:org");
  assertEquals(response.headers.get("x-ratelimit-remaining"), "4999");
  assertEquals(response.headers.get("set-cookie"), null);
  assertEquals(await response.text(), "[]");
});

Deno.test("unsafe upstream pagination refuses and cancels the whole response with scrubbed diagnostics", async () => {
  let cancelled = false;
  const broker = createCredentialBroker({
    capability,
    credentials: { github: secret },
    repositories: ["example/repo"],
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: { link: `<https://evil.example/${secret}>; rel="next"` },
          },
        ),
      ),
  });
  const response = await broker(
    request("/repos/example/repo/issues?per_page=1"),
  );
  assertEquals(response.status, 502);
  assertEquals(await response.text(), "GitHub pagination refused\n");
  assertEquals(cancelled, true);
});
