import { assertEquals } from "@std/assert";
import {
  createCredentialBroker,
  type CredentialBrokerOptions,
} from "../lib/credential_broker.ts";
import { createCodexAgentGateway } from "../lib/codex_agent_gateway.ts";

const capability = "synthetic-subscription-capability-0123456789abcdef";
const account = "fixture-account";
const now = Date.UTC(2026, 9, 18);
function jwt() {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("=", "").replaceAll("+", "-")
      .replaceAll("/", "_");
  return `${encode({ alg: "none" })}.${
    encode({
      exp: now / 1000 + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: account },
    })
  }.synthetic-private-signature`;
}
const authJson = JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    account_id: account,
    access_token: jwt(),
    id_token: jwt(),
    refresh_token: "synthetic-private-refresh",
  },
  last_refresh: new Date(now).toISOString(),
});
function request(
  path = "/codex-subscription/responses",
  auth = capability,
  body = '{"stream":true}',
) {
  return new Request(`http://broker.invalid${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth}`,
      "session-id": "fixture-session",
      "chatgpt-account-id": "worker-override",
      "x-openai-fedramp": "true",
    },
    body,
  });
}
function fixture(overrides: Partial<CredentialBrokerOptions> = {}) {
  const calls: Request[] = [];
  const broker = createCredentialBroker({
    capability,
    repositories: [],
    credentials: {},
    codexSubscription: {
      authJson,
      accountId: account,
      now: () => now,
      persist: () => Promise.reject(new Error("unexpected refresh")),
    },
    fetch(input) {
      calls.push(input);
      return Promise.resolve(
        new Response("data: completed\n\n", {
          headers: {
            "content-type": "text/event-stream",
            "x-codex-turn-state": "fixture-turn-state",
            "set-cookie": "private",
          },
        }),
      );
    },
    ...overrides,
  });
  return { broker, calls };
}

Deno.test("authenticated broker routes subscription calls only through the selected ChatGPT account", async () => {
  const { broker, calls } = fixture({
    credentials: { openai: "synthetic-api-key-must-not-be-billed" },
  });
  const gateway = createCodexAgentGateway({
    mode: "chatgpt",
    capability,
    forward: broker,
  });
  const result = await gateway(
    new Request("http://127.0.0.1:8111/v1/responses", {
      method: "POST",
      headers: {
        "session-id": "fixture-session",
        "chatgpt-account-id": "worker-override",
        "x-openai-fedramp": "true",
      },
      body: '{"stream":true}',
    }),
  );
  assertEquals(result.status, 200);
  assertEquals(await result.text(), "data: completed\n\n");
  assertEquals(result.headers.get("x-codex-turn-state"), "fixture-turn-state");
  assertEquals(result.headers.get("set-cookie"), null);
  assertEquals(calls.length, 1);
  const sent = calls[0]!;
  assertEquals(sent.url, "https://chatgpt.com/backend-api/codex/responses");
  assertEquals(sent.headers.get("authorization"), `Bearer ${jwt()}`);
  assertEquals(sent.headers.get("chatgpt-account-id"), account);
  assertEquals(sent.headers.get("session-id"), "fixture-session");
  assertEquals(sent.headers.get("x-openai-fedramp"), null);
  assertEquals(await sent.text(), '{"stream":true}');
});

Deno.test("subscription cannot bypass broker capability, bounds, closed endpoints or session revocation", async () => {
  const controller = new AbortController();
  const { broker, calls } = fixture({
    maxRequestBytes: 100,
    signal: controller.signal,
  });
  for (
    const [input, status] of [
      [request(undefined, "wrong"), 401],
      [request(undefined, undefined, "x".repeat(101)), 413],
      [request("/codex-subscription/responses?account=other"), 403],
      [request("/codex-subscription/oauth/token"), 403],
      [request("/codex-subscription/backend-api/codex/responses"), 403],
      [request("/openai/v1/responses"), 503],
    ] as const
  ) {
    const result = await broker(input);
    assertEquals(result.status, status);
    await result.body?.cancel();
  }
  controller.abort();
  assertEquals((await broker(request())).status, 503);
  assertEquals(calls.length, 0);
  const noFallback = fixture({
    codexSubscription: undefined,
    credentials: { openai: "api-key-must-not-pay-for-subscription" },
  });
  assertEquals((await noFallback.broker(request())).status, 503);
  assertEquals(noFallback.calls.length, 0);
});

Deno.test("subscription response stream stops on broker lease revocation", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const { broker } = fixture({
    signal: controller.signal,
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      ),
  });
  const result = await broker(request());
  const reader = result.body!.getReader();
  const pending = reader.read().then(() => false, () => true);
  controller.abort();
  assertEquals(await pending, true);
  await Promise.resolve();
  assertEquals(cancelled, true);
  reader.releaseLock();
});
