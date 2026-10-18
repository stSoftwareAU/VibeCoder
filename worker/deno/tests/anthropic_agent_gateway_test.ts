/** Native Anthropic-format transport without upstream credentials (#3699). */
import { assertEquals, assertThrows } from "@std/assert";
import {
  buildBrokeredAnthropicEnvironment,
  createAnthropicAgentGateway,
} from "../lib/anthropic_agent_gateway.ts";
import { createCredentialBroker } from "../lib/credential_broker.ts";

const capability = "synthetic-local-capability-0123456789abcdef";
const upstreamSecret = "synthetic-upstream-only-credential";

Deno.test("native Anthropic gateway preserves capability semantics through the fixed broker", async () => {
  for (const service of ["claude", "deepseek"] as const) {
    const calls: Request[] = [];
    const broker = createCredentialBroker({
      capability,
      credentials: { [service]: upstreamSecret },
      repositories: [],
      fetch(request) {
        calls.push(request);
        return Promise.resolve(
          new Response("data: native-stream\n\n", {
            headers: {
              "content-type": "text/event-stream",
              "x-should-retry": "false",
              "anthropic-ratelimit-unified-status": "allowed",
              "set-cookie": "private-cookie",
            },
          }),
        );
      },
    });
    const gateway = createAnthropicAgentGateway({
      service,
      capability,
      forward: broker,
    });
    const body = JSON.stringify({
      model: "fixture-model",
      messages: [{ role: "user", content: "fixture request" }],
      thinking: { type: "adaptive" },
      stream: true,
    });
    const response = await gateway(
      new Request(
        "http://127.0.0.1:4567/v1/messages?beta=true",
        {
          method: "POST",
          body,
          headers: {
            "x-api-key": capability,
            "anthropic-beta": "oauth-2025-04-20,future-capability-2099-01-01",
            "anthropic-version": "2023-06-01",
            "anthropic-future-capability": "fixture-future-value",
            cookie: "agent-cookie",
            "proxy-authorization": "untrusted",
          },
        },
      ),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.text(), "data: native-stream\n\n");
    assertEquals(calls.length, 1);
    const forwarded = calls[0]!;
    assertEquals(
      forwarded.url,
      service === "claude"
        ? "https://api.anthropic.com/v1/messages?beta=true"
        : "https://api.deepseek.com/anthropic/v1/messages?beta=true",
    );
    assertEquals(await forwarded.text(), body);
    assertEquals(
      forwarded.headers.get("anthropic-beta"),
      "oauth-2025-04-20,future-capability-2099-01-01",
    );
    assertEquals(forwarded.headers.get("anthropic-version"), "2023-06-01");
    assertEquals(
      forwarded.headers.get("anthropic-future-capability"),
      "fixture-future-value",
    );
    assertEquals(forwarded.headers.get("cookie"), null);
    assertEquals(forwarded.headers.get("proxy-authorization"), null);
    assertEquals(
      forwarded.headers.get(
        service === "claude" ? "x-api-key" : "authorization",
      ),
      service === "claude" ? upstreamSecret : `Bearer ${upstreamSecret}`,
    );
    assertEquals(response.headers.get("x-should-retry"), "false");
    assertEquals(
      response.headers.get("anthropic-ratelimit-unified-status"),
      "allowed",
    );
    assertEquals(response.headers.get("set-cookie"), null);
  }
});

Deno.test("native Anthropic gateway never broadens the broker route or changes provider", async () => {
  let calls = 0;
  const broker = createCredentialBroker({
    capability,
    credentials: { claude: upstreamSecret, github: upstreamSecret },
    repositories: ["example/repo"],
    fetch() {
      calls++;
      return Promise.resolve(new Response("unexpected"));
    },
  });
  const gateway = createAnthropicAgentGateway({
    service: "claude",
    capability,
    forward: broker,
  });
  for (
    const path of [
      "/github/repos/example/repo/issues",
      "/v1/messages?beta=false",
      "/v1/messages?beta=true&redirect=https://attacker.invalid",
      "/v1/messages?beta=true&beta=true",
      "/oauth/token",
      "//attacker.invalid/v1/messages",
    ]
  ) {
    const response = await gateway(
      new Request(`http://127.0.0.1:4567${path}`, {
        method: "POST",
        body: "{}",
      }),
    );
    assertEquals(response.status, 403, path);
    await response.body?.cancel();
  }
  assertEquals(calls, 0);
});

Deno.test("native Anthropic token counting uses only the selected provider path", async () => {
  for (const service of ["claude", "deepseek"] as const) {
    const calls: Request[] = [];
    const broker = createCredentialBroker({
      capability,
      credentials: { [service]: upstreamSecret },
      repositories: [],
      fetch(request) {
        calls.push(request);
        return Promise.resolve(Response.json({ input_tokens: 7 }));
      },
    });
    const gateway = createAnthropicAgentGateway({
      service,
      capability,
      forward: broker,
    });
    const response = await gateway(
      new Request("http://127.0.0.1:4567/v1/messages/count_tokens", {
        method: "POST",
        body: "{}",
      }),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { input_tokens: 7 });
    assertEquals(calls.length, 1);
    assertEquals(
      calls[0]!.url,
      service === "claude"
        ? "https://api.anthropic.com/v1/messages/count_tokens"
        : "https://api.deepseek.com/anthropic/v1/messages/count_tokens",
    );
  }
});

Deno.test("native gateway reports Unix transport loss without exposing exception details", async () => {
  const gateway = createAnthropicAgentGateway({
    service: "claude",
    capability,
    forward: () =>
      Promise.reject(new Error(`private path and ${upstreamSecret}`)),
  });
  const response = await gateway(
    new Request("http://127.0.0.1:4567/v1/messages", {
      method: "POST",
      body: "{}",
    }),
  );
  assertEquals(response.status, 502);
  assertEquals(await response.text(), "Broker transport unavailable\n");
});

Deno.test("native gateway preserves incremental responses and cancellation", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let forwardedSignal!: AbortSignal;
  const abort = new AbortController();
  const gateway = createAnthropicAgentGateway({
    service: "claude",
    capability,
    forward(request) {
      forwardedSignal = request.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(value) {
              controller = value;
            },
          }),
        ),
      );
    },
  });
  const response = await gateway(
    new Request("http://127.0.0.1:4567/v1/messages", {
      method: "POST",
      body: "{}",
      signal: abort.signal,
    }),
  );
  const reader = response.body!.getReader();
  controller.enqueue(new TextEncoder().encode("first chunk"));
  assertEquals(
    new TextDecoder().decode((await reader.read()).value),
    "first chunk",
  );
  abort.abort();
  assertEquals(forwardedSignal.aborted, true);
  controller.close();
  assertEquals((await reader.read()).done, true);
  reader.releaseLock();
});

Deno.test("brokered Anthropic environment selects one opaque auth mode and inherits nothing", () => {
  const input = {
    capability,
    baseUrl: "http://127.0.0.1:4567",
    homeDir: "/tmp/agent-home",
    configDir: "/state/claude",
  };
  for (const mode of ["api-key", "subscription", "bearer"] as const) {
    const env = buildBrokeredAnthropicEnvironment({
      ...input,
      service: "claude",
      mode,
    });
    assertEquals(env.ANTHROPIC_BASE_URL, input.baseUrl);
    assertEquals(env.HOME, input.homeDir);
    assertEquals(env.CLAUDE_CONFIG_DIR, input.configDir);
    assertEquals(
      env.ANTHROPIC_API_KEY,
      mode === "api-key" ? capability : undefined,
    );
    assertEquals(
      env.CLAUDE_CODE_OAUTH_TOKEN,
      mode === "subscription" ? capability : undefined,
    );
    assertEquals(
      env.ANTHROPIC_AUTH_TOKEN,
      mode === "bearer" ? capability : undefined,
    );
    assertEquals(env.GH_TOKEN, undefined);
    assertEquals(env.GITHUB_TOKEN, undefined);
    assertEquals(env.CODEX_HOME, undefined);
    assertEquals(env.DEEPSEEK_API_KEY, undefined);
    assertEquals(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
  }
  const deepseek = buildBrokeredAnthropicEnvironment({
    ...input,
    service: "deepseek",
    mode: "bearer",
  });
  assertEquals(deepseek.ANTHROPIC_AUTH_TOKEN, capability);
  assertEquals(deepseek.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  for (
    const baseUrl of [
      "https://attacker.invalid",
      "http://localhost:4567",
      "http://127.0.0.1:4567/extra",
      "http://user:password@127.0.0.1:4567",
      "http://127.0.0.1:4567?redirect=1",
    ]
  ) {
    assertThrows(() =>
      buildBrokeredAnthropicEnvironment({
        ...input,
        service: "claude",
        mode: "subscription",
        baseUrl,
      })
    );
  }
  assertThrows(() =>
    buildBrokeredAnthropicEnvironment({
      ...input,
      service: "deepseek",
      mode: "subscription",
    })
  );
  assertThrows(() =>
    buildBrokeredAnthropicEnvironment({
      ...input,
      service: "claude",
      mode: "subscription",
      capability: "weak",
    })
  );
  assertThrows(() =>
    buildBrokeredAnthropicEnvironment({
      ...input,
      service: "claude",
      mode: "subscription",
      configDir: "relative",
    })
  );
});

Deno.test("brokered Anthropic environment does not copy unrelated parent values", () => {
  const name = `VIBE_CONTAINMENT_TEST_${
    crypto.randomUUID().replaceAll("-", "")
  }`;
  Deno.env.set(name, "synthetic-parent-value");
  try {
    const env = buildBrokeredAnthropicEnvironment({
      service: "claude",
      mode: "subscription",
      capability,
      baseUrl: "http://127.0.0.1:4567",
      homeDir: "/tmp/home",
      configDir: "/state/claude",
    });
    assertEquals(env[name], undefined);
  } finally {
    Deno.env.delete(name);
  }
});
