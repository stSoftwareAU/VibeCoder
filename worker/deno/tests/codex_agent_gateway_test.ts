/** Codex 0.147.0 transport contracts, without live accounts or ambient secrets. */
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type BrokeredCodexOptions,
  buildBrokeredCodexLaunch,
  createCodexAgentGateway,
} from "../lib/codex_agent_gateway.ts";
import { createCredentialBroker } from "../lib/credential_broker.ts";
import {
  assertCodexNativeOutput,
  CODEX_NATIVE_FIXTURE_RESULT,
} from "./support/codex_native_evidence.ts";

const capability = "synthetic-local-codex-capability-0123456789abcdef";
const secret = "synthetic-upstream-only-codex-secret";
const options: BrokeredCodexOptions = {
  mode: "api-key",
  capability,
  baseUrl: "http://127.0.0.1:4567",
  homeDir: "/tmp/agent-home",
  codexHome: "/state/codex",
};

Deno.test("Codex gateway preserves Responses streaming through the fixed authenticated broker", async () => {
  const calls: Request[] = [];
  const broker = createCredentialBroker({
    capability,
    credentials: { openai: secret },
    repositories: [],
    fetch(request) {
      calls.push(request);
      return Promise.resolve(
        new Response("data: fixture-stream\n\n", {
          headers: {
            "content-type": "text/event-stream",
            "set-cookie": "private",
          },
        }),
      );
    },
  });
  const gateway = createCodexAgentGateway({
    mode: "api-key",
    capability,
    forward: broker,
  });
  const body = JSON.stringify({
    model: "fixture-model",
    input: [],
    stream: true,
  });
  const response = await gateway(
    new Request(`${options.baseUrl}/v1/responses`, {
      method: "POST",
      body,
      headers: {
        authorization: "Bearer attacker-value",
        "ChatGPT-Account-ID": "attacker-account",
        "openai-organization": "attacker-org",
        "proxy-authorization": "attacker-proxy",
        cookie: "attacker-cookie",
        "content-type": "application/json",
      },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.text(), "data: fixture-stream\n\n");
  assertEquals(calls.length, 1);
  const call = calls[0]!;
  assertEquals(call.url, "https://api.openai.com/v1/responses");
  assertEquals(await call.text(), body);
  assertEquals(call.headers.get("authorization"), `Bearer ${secret}`);
  for (
    const name of [
      "ChatGPT-Account-ID",
      "openai-organization",
      "proxy-authorization",
      "cookie",
    ]
  ) {
    assertEquals(call.headers.get(name), null);
  }
  assertEquals(response.headers.get("set-cookie"), null);
});

Deno.test("Codex gateway cannot select a different provider, account or token endpoint", async () => {
  let calls = 0;
  const broker = createCredentialBroker({
    capability,
    credentials: { openai: secret, claude: secret },
    repositories: [],
    fetch() {
      calls++;
      return Promise.resolve(new Response("unexpected"));
    },
  });
  const gateway = createCodexAgentGateway({
    mode: "api-key",
    capability,
    forward: broker,
  });
  for (
    const [method, path] of [
      ["POST", "/v1/responses?redirect=https://attacker.invalid"],
      ["POST", "/oauth/token"],
      ["POST", "/backend-api/codex/responses"],
      ["POST", "/claude/v1/messages"],
      ["GET", "/v1/responses"],
      ["POST", "/v1/chat/completions"],
    ]
  ) {
    const request = new Request(`${options.baseUrl}${path}`, { method });
    const response = await gateway(request);
    assertEquals(response.status, 403, `${method} ${path}`);
    await response.body?.cancel();
  }
  assertEquals(calls, 0);
});

Deno.test("Codex gateway refuses unavailable Unix transport without exposing its cause", async () => {
  const gateway = createCodexAgentGateway({
    mode: "api-key",
    capability,
    forward: () => Promise.reject(new Error(`private path ${secret}`)),
  });
  const response = await gateway(
    new Request(`${options.baseUrl}/v1/responses`, { method: "POST" }),
  );
  assertEquals(response.status, 502);
  assertEquals(await response.text(), "Broker transport unavailable\n");
});

Deno.test("Codex gateway preserves incremental body delivery and cancellation", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let forwardedSignal!: AbortSignal;
  const abort = new AbortController();
  const gateway = createCodexAgentGateway({
    mode: "api-key",
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
    new Request(`${options.baseUrl}/v1/responses`, {
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

Deno.test({
  name:
    "Codex API-key launch never reads parent secrets and configures only the local broker",
  permissions: { env: false },
  fn() {
    const launch = buildBrokeredCodexLaunch(options);
    assertEquals(launch.env, {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: options.homeDir,
      CODEX_HOME: options.codexHome,
      CODEX_BROKER_CAPABILITY: capability,
    });
    assertEquals(
      launch.configToml,
      [
        'model_provider = "vibe_broker_api_key"',
        "check_for_update_on_startup = false",
        'cli_auth_credentials_store = "file"',
        "",
        "[model_providers.vibe_broker_api_key]",
        'name = "Isolated OpenAI API-key broker"',
        'base_url = "http://127.0.0.1:4567/v1"',
        'env_key = "CODEX_BROKER_CAPABILITY"',
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "supports_websockets = false",
        "",
      ].join("\n"),
    );
  },
});

Deno.test("Codex subscription mode is explicitly refused without metered fallback", () => {
  for (const mode of ["chatgpt", "unknown"] as BrokeredCodexOptions["mode"][]) {
    assertThrows(
      () => buildBrokeredCodexLaunch({ ...options, mode }),
      Error,
      "Only explicitly selected API-key mode is implemented",
    );
    assertThrows(
      () =>
        createCodexAgentGateway({
          mode,
          capability,
          forward: () => Promise.resolve(new Response()),
        }),
      Error,
      "Only explicitly selected API-key mode is implemented",
    );
  }
});

Deno.test("Codex launch rejects injected paths, weak capabilities and nonlocal model destinations", () => {
  for (
    const baseUrl of [
      "https://attacker.invalid",
      "http://localhost:4567",
      "http://127.0.0.1:4567/extra",
      "http://user:secret@127.0.0.1:4567",
      "http://127.0.0.1:4567?redirect=1",
      "http://127.0.0.1:4567#fragment",
    ]
  ) {
    assertThrows(
      () => buildBrokeredCodexLaunch({ ...options, baseUrl }),
      Error,
      "Agent model gateway must be an explicit local loopback port",
    );
  }
  for (const path of ["relative", "/tmp/../private", '/tmp/evil"\nconfig']) {
    assertThrows(
      () => buildBrokeredCodexLaunch({ ...options, homeDir: path }),
      Error,
      "Agent home and state must be absolute sandbox paths",
    );
    assertThrows(
      () => buildBrokeredCodexLaunch({ ...options, codexHome: path }),
      Error,
      "Agent home and state must be absolute sandbox paths",
    );
  }
  assertThrows(
    () => buildBrokeredCodexLaunch({ ...options, capability: "weak" }),
    Error,
    "Broker capability must contain 32–256 URL-safe characters",
  );
});

// These envelopes follow rust-v0.147.0 exec/src/exec_events.rs. Hosted execution
// must still establish that the real pinned CLI accepts the synthetic SSE.
const nativeEvents = [
  { type: "thread.started", thread_id: "fixture-thread" },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: {
      id: "item_0",
      type: "agent_message",
      text: CODEX_NATIVE_FIXTURE_RESULT,
    },
  },
  {
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 5 },
  },
];

Deno.test("Codex native output requires the broker text and successful turn, and detects leaked credentials", async () => {
  // Match the real broker probe's planted credential format.
  const plantedSecret = `synthetic-${crypto.randomUUID()}`;
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(plantedSecret),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const output = (events: unknown[], stderr = "", success = true) => ({
    success,
    code: success ? 0 : 1,
    stdout: new TextEncoder().encode(
      events.map((event) => JSON.stringify(event)).join("\n"),
    ),
    stderr: new TextEncoder().encode(stderr),
  });
  await assertCodexNativeOutput(output(nativeEvents), hash);
  for (
    const [sample, reason] of [
      [output(nativeEvents, "", false), "failed with exit 1"],
      [output(nativeEvents, plantedSecret), "contains the upstream credential"],
      [output(nativeEvents.slice(0, -1)), "lacked the broker response"],
      [
        output(nativeEvents.filter((event) => event.type !== "item.completed")),
        "lacked the broker response",
      ],
      [
        output([...nativeEvents, {
          type: "turn.failed",
          error: { message: "fixture failure" },
        }]),
        "emitted a failed turn",
      ],
      [
        output([...nativeEvents, { type: "error", message: "fixture error" }]),
        "emitted a failed turn",
      ],
      [
        output([{
          type: "item.completed",
          item: { type: "agent_message", text: "other response" },
        }, nativeEvents.at(-1)]),
        "lacked the broker response",
      ],
      [
        output([nativeEvents.at(-1), nativeEvents[2]]),
        "lacked the broker response",
      ],
      [
        {
          ...output(nativeEvents),
          stdout: new TextEncoder().encode("not JSON"),
        },
        "did not emit JSONL",
      ],
    ] as const
  ) {
    await assertRejects(
      () => assertCodexNativeOutput(sample, hash),
      Error,
      reason,
    );
  }
});
