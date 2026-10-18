/** Native Gemini transport with an opaque key and broker-owned authority. */
import { assertEquals, assertThrows } from "@std/assert";
import {
  buildBrokeredGeminiEnvironment,
  createGeminiAgentGateway,
} from "../lib/gemini_agent_gateway.ts";
import { createCredentialBroker } from "../lib/credential_broker.ts";

const capability = "synthetic-gemini-capability-0123456789abcdef";
const secret = "synthetic-broker-only-gemini-secret";

Deno.test("Gemini native requests retain content and streaming without exposing upstream auth", async () => {
  for (const suffix of ["generateContent", "streamGenerateContent?alt=sse"]) {
    const calls: Request[] = [];
    const broker = createCredentialBroker({
      capability,
      credentials: { gemini: secret },
      repositories: [],
      fetch(request) {
        calls.push(request);
        return Promise.resolve(
          new Response("data: fixture\n\n", {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "set-cookie": "private",
            },
          }),
        );
      },
    });
    const gateway = createGeminiAgentGateway({ capability, forward: broker });
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    const response = await gateway(
      new Request(
        `http://127.0.0.1:4567/v1beta/models/gemini-2.5-flash:${suffix}`,
        {
          method: "POST",
          body,
          headers: {
            "x-goog-api-key": capability,
            authorization: "Bearer untrusted",
            cookie: "agent-cookie",
            "content-type": "application/json",
            "proxy-authorization": "untrusted",
          },
        },
      ),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.text(), "data: fixture\n\n");
    assertEquals(response.headers.get("set-cookie"), null);
    assertEquals(calls.length, 1);
    assertEquals(
      calls[0]!.url,
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:${suffix}`,
    );
    assertEquals(await calls[0]!.text(), body);
    assertEquals(calls[0]!.headers.get("x-goog-api-key"), secret);
    assertEquals(calls[0]!.headers.get("authorization"), null);
    assertEquals(calls[0]!.headers.get("cookie"), null);
    assertEquals(calls[0]!.headers.get("proxy-authorization"), null);
    assertEquals(calls[0]!.headers.get("content-type"), "application/json");
  }
});

Deno.test("Gemini gateway cannot expand the broker service, route or query policy", async () => {
  let calls = 0;
  const broker = createCredentialBroker({
    capability,
    credentials: { gemini: secret, github: secret },
    repositories: ["example/repo"],
    fetch() {
      calls++;
      return Promise.resolve(new Response("unexpected"));
    },
  });
  const gateway = createGeminiAgentGateway({ capability, forward: broker });
  for (
    const path of [
      "/github/repos/example/repo/issues",
      "/oauth/token",
      "//attacker.invalid/v1beta/models/model:generateContent",
      "/v1beta/models/model:generateContent?key=untrusted",
      "/v1beta/models/model:generateContent?alt=sse&redirect=https://attacker.invalid",
      "/v1beta/models/model:delete",
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

Deno.test("Gemini gateway reports transport loss without leaking private details", async () => {
  const gateway = createGeminiAgentGateway({
    capability,
    forward() {
      return Promise.reject(new Error(secret));
    },
  });
  const response = await gateway(
    new Request("http://127.0.0.1:4567/v1beta/models/model:generateContent", {
      method: "POST",
      body: "{}",
    }),
  );
  assertEquals(response.status, 502);
  assertEquals(await response.text(), "Broker transport unavailable\n");
});

Deno.test("Gemini gateway preserves live response chunks and request cancellation", async () => {
  const controller = new AbortController();
  let signal!: AbortSignal;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const gateway = createGeminiAgentGateway({
    capability,
    forward(request) {
      signal = request.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(value) {
              stream = value;
            },
          }),
        ),
      );
    },
  });
  const response = await gateway(
    new Request(
      "http://127.0.0.1:4567/v1beta/models/model:streamGenerateContent?alt=sse",
      { method: "POST", body: "{}", signal: controller.signal },
    ),
  );
  const reader = response.body!.getReader();
  stream.enqueue(new TextEncoder().encode("data: first\n\n"));
  assertEquals(
    new TextDecoder().decode((await reader.read()).value),
    "data: first\n\n",
  );
  controller.abort();
  assertEquals(signal.aborted, true);
  stream.close();
  assertEquals((await reader.read()).done, true);
  reader.releaseLock();
});

Deno.test("Gemini environment contains only the opaque API key and explicit local gateway", () => {
  assertEquals(
    buildBrokeredGeminiEnvironment({
      capability,
      baseUrl: "http://127.0.0.1:4567",
      homeDir: "/tmp/gemini-agent",
    }),
    {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp/gemini-agent",
      GEMINI_API_KEY: capability,
      GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:4567",
      GOOGLE_GENAI_API_VERSION: "v1beta",
      GEMINI_TELEMETRY_ENABLED: "false",
      CI: "true",
    },
  );
});

Deno.test("Gemini environment rejects non-local URLs, path escapes and weak capabilities", () => {
  const valid = {
    capability,
    baseUrl: "http://127.0.0.1:4567",
    homeDir: "/tmp/gemini-agent",
  };
  for (
    const baseUrl of [
      "https://attacker.invalid",
      "http://127.0.0.1",
      "http://localhost:4567",
      "http://127.0.0.1:4567/path",
      "http://user@127.0.0.1:4567",
      "http://127.0.0.1:4567?key=x",
      "http://127.0.0.1:4567#x",
    ]
  ) {
    assertThrows(() => buildBrokeredGeminiEnvironment({ ...valid, baseUrl }));
  }
  for (const homeDir of ["relative", "/tmp/../private", "/tmp/home\n"]) {
    assertThrows(() => buildBrokeredGeminiEnvironment({ ...valid, homeDir }));
  }
  assertThrows(() =>
    buildBrokeredGeminiEnvironment({ ...valid, capability: "weak" })
  );
  assertThrows(() =>
    createGeminiAgentGateway({
      capability: "weak",
      forward: () => Promise.resolve(new Response()),
    })
  );
});
