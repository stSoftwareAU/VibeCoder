/** Native gh requests remain constrained by the trusted broker (#3699). */
import { assertEquals, assertThrows } from "@std/assert";
import {
  buildBrokeredGitHubEnvironment,
  createGitHubAgentGateway,
  githubAgentSocketConfig,
} from "../lib/github_agent_gateway.ts";
import { createCredentialBroker } from "../lib/credential_broker.ts";

const capability = "synthetic-local-capability-0123456789abcdef";
const upstreamSecret = "synthetic-upstream-only-credential";

Deno.test("native gh gateway preserves REST reads through the fixed broker", async () => {
  const requests: Request[] = [];
  const broker = createCredentialBroker({
    capability,
    credentials: { github: upstreamSecret },
    repositories: ["fixture/allowed"],
    fetch(request) {
      requests.push(request);
      return Promise.resolve(
        new Response(request.method === "HEAD" ? null : "[]", {
          headers: {
            "content-type": "application/json",
            "set-cookie": "private",
            "x-request-id": "fixture-request",
          },
        }),
      );
    },
  });
  const gateway = createGitHubAgentGateway({ capability, forward: broker });
  for (const method of ["GET", "HEAD"]) {
    const response = await gateway(
      new Request(
        "https://api.github.com/repos/fixture/allowed/issues?per_page=1",
        {
          method,
          headers: {
            authorization: "token untrusted",
            cookie: "private-cookie",
            "proxy-authorization": "untrusted",
            "x-github-api-version": "untrusted",
          },
        },
      ),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.text(), method === "HEAD" ? "" : "[]");
    assertEquals(response.headers.get("set-cookie"), null);
    assertEquals(response.headers.get("x-request-id"), "fixture-request");
    const request = requests.at(-1)!;
    assertEquals(
      request.url,
      "https://api.github.com/repos/fixture/allowed/issues?per_page=1",
    );
    assertEquals(request.method, method);
    assertEquals(
      request.headers.get("authorization"),
      `Bearer ${upstreamSecret}`,
    );
    assertEquals(request.headers.get("x-github-api-version"), "2022-11-28");
    assertEquals(request.headers.get("cookie"), null);
    assertEquals(request.headers.get("proxy-authorization"), null);
  }
  assertEquals(requests.length, 2);
});

Deno.test("native gh cannot select another service, repository, method or query authority", async () => {
  let calls = 0;
  const broker = createCredentialBroker({
    capability,
    credentials: { github: upstreamSecret, claude: upstreamSecret },
    repositories: ["fixture/allowed"],
    fetch() {
      calls++;
      return Promise.resolve(new Response("[]"));
    },
  });
  const gateway = createGitHubAgentGateway({ capability, forward: broker });
  // Positive control proves that denials are policy decisions, not a dead adapter.
  const allowed = await gateway(
    new Request("https://api.github.com/repos/fixture/allowed/issues"),
  );
  assertEquals(allowed.status, 200);
  await allowed.body?.cancel();
  for (
    const [method, path] of [
      ["POST", "/repos/fixture/allowed/issues"],
      ["PATCH", "/repos/fixture/allowed/issues/1"],
      ["DELETE", "/repos/fixture/allowed/issues/1"],
      ["GET", "/repos/fixture/other/issues"],
      ["POST", "/graphql"],
      ["GET", "/user"],
      ["GET", "/repos/fixture/allowed/issues?access_token=untrusted"],
      ["POST", "/claude/v1/messages"],
      ["GET", "//attacker.invalid/repos/fixture/allowed/issues"],
      ["GET", "/repos/fixture/allowed/%2f..%2fother/issues"],
    ]
  ) {
    const denied = await gateway(
      new Request(`https://api.github.com${path}`, { method }),
    );
    assertEquals(denied.status, 403, `${method} ${path}`);
    await denied.body?.cancel();
  }
  assertEquals(calls, 1);
});

Deno.test("native gh adapter sends only the local capability and preserves cancellation", async () => {
  let forwarded!: Request;
  const abort = new AbortController();
  const gateway = createGitHubAgentGateway({
    capability,
    forward(request) {
      forwarded = request;
      return Promise.resolve(Response.json([]));
    },
  });
  const response = await gateway(
    new Request("https://attacker.invalid/repos/fixture/allowed/issues", {
      headers: {
        authorization: "token caller-value",
        cookie: "caller-cookie",
        "x-api-key": "caller-key",
      },
      signal: abort.signal,
    }),
  );
  await response.body?.cancel();
  assertEquals(
    forwarded.url,
    "http://broker.invalid/github/repos/fixture/allowed/issues",
  );
  assertEquals([...forwarded.headers], [[
    "authorization",
    `Bearer ${capability}`,
  ]]);
  assertEquals(forwarded.redirect, "manual");
  abort.abort();
  assertEquals(forwarded.signal.aborted, true);
});

Deno.test("native gh adapter scrubs Unix transport errors", async () => {
  const gateway = createGitHubAgentGateway({
    capability,
    forward: () => Promise.reject(new Error(upstreamSecret)),
  });
  const response = await gateway(
    new Request("https://api.github.com/repos/fixture/allowed/issues"),
  );
  assertEquals(response.status, 502);
  assertEquals(await response.text(), "Broker transport unavailable\n");
  assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("native gh environment contains only an opaque capability and fresh state", () => {
  const env = buildBrokeredGitHubEnvironment({
    capability,
    homeDir: "/tmp/gh-home",
    configDir: "/tmp/gh-home/config",
  });
  assertEquals(env, {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/gh-home",
    GH_CONFIG_DIR: "/tmp/gh-home/config",
    GH_HOST: "github.com",
    GH_TOKEN: capability,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_TELEMETRY: "0",
  });
  assertEquals(
    githubAgentSocketConfig("/tmp/gh-home/gateway.sock"),
    'http_unix_socket: "/tmp/gh-home/gateway.sock"\n',
  );
});

Deno.test("native gh rejects malformed capabilities and state/config paths", () => {
  const options = {
    capability,
    homeDir: "/tmp/gh-home",
    configDir: "/tmp/gh-home/config",
  };
  for (const invalid of ["short", "x".repeat(257), "a".repeat(32) + "\n"]) {
    assertThrows(() =>
      createGitHubAgentGateway({
        capability: invalid,
        forward: () => Promise.resolve(new Response()),
      })
    );
    assertThrows(() =>
      buildBrokeredGitHubEnvironment({ ...options, capability: invalid })
    );
  }
  for (
    const invalid of [
      "relative",
      "/tmp/../host",
      "/tmp/name\nhttp_unix_socket: /host",
      '/tmp/quote"',
      "/tmp/space path",
    ]
  ) {
    assertThrows(() => githubAgentSocketConfig(invalid));
    assertThrows(() =>
      buildBrokeredGitHubEnvironment({ ...options, homeDir: invalid })
    );
    assertThrows(() =>
      buildBrokeredGitHubEnvironment({ ...options, configDir: invalid })
    );
  }
});
