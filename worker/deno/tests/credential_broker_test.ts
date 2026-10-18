/** Behavioural tests for the experimental credential broker (#3698, #3699). */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { createCredentialBroker } from "../lib/credential_broker.ts";

const capability = "synthetic-run-capability-01234567890123456789";
const secret = "synthetic-upstream-secret-never-for-the-agent";

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${capability}`);
  return new Request(`http://broker.invalid${path}`, { ...init, headers });
}

function fixture() {
  const calls: Request[] = [];
  const handle = createCredentialBroker({
    capability,
    credentials: { claude: secret, github: secret, gemini: secret },
    repositories: ["example/repository"],
    fetch: (input) => {
      calls.push(input);
      return Promise.resolve(
        new Response('{"ok":true}', {
          headers: {
            "content-type": "application/json",
            "set-cookie": "private",
          },
        }),
      );
    },
  });
  return { calls, handle };
}

Deno.test("credential broker injects its credential only on the fixed model route", async () => {
  const { calls, handle } = fixture();
  const response = await handle(request("/claude/v1/messages", {
    method: "POST",
    body: '{"model":"example","messages":[]}',
    headers: {
      "content-type": "application/json",
      "x-api-key": "attacker-chosen",
      "cookie": "untrusted",
      "proxy-authorization": "untrusted",
    },
  }));
  assertEquals(response.status, 200);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.url, "https://api.anthropic.com/v1/messages");
  assertEquals(calls[0]!.headers.get("x-api-key"), secret);
  assertEquals(calls[0]!.headers.get("authorization"), null);
  assertEquals(calls[0]!.headers.get("cookie"), null);
  assertEquals(calls[0]!.headers.get("proxy-authorization"), null);
  assertEquals(await calls[0]!.text(), '{"model":"example","messages":[]}');
  assertEquals(response.headers.get("set-cookie"), null);
  assertEquals(await response.text(), '{"ok":true}');
});

Deno.test("credential broker denies callers without its per-run capability", async () => {
  const { calls, handle } = fixture();
  for (const authorization of [undefined, "Bearer wrong", "Basic wrong"]) {
    const response = await handle(
      new Request("http://broker.invalid/claude/v1/messages", {
        method: "POST",
        headers: authorization ? { authorization } : {},
      }),
    );
    assertEquals(response.status, 401);
    await response.body?.cancel();
  }
  assertEquals(calls.length, 0);
});

Deno.test("credential broker refuses arbitrary destinations and credential minting endpoints", async () => {
  const { calls, handle } = fixture();
  for (
    const path of [
      "/https://attacker.invalid/collect",
      "/claude/oauth/token",
      "/github/app/installations/1/access_tokens",
      "/github/authorizations",
      "/claude/v1/messages/extra",
      "/claude/v1/messages?redirect=https://attacker.invalid",
    ]
  ) {
    const response = await handle(request(path, { method: "POST" }));
    assertEquals(response.status, 403, path);
    await response.body?.cancel();
  }
  assertEquals(calls.length, 0);
});

Deno.test("credential broker confines GitHub reads to the selected repository", async () => {
  const { calls, handle } = fixture();
  assertEquals(
    (await handle(
      request("/github/repos/example/repository/issues?per_page=10"),
    )).status,
    200,
  );
  assertEquals(
    calls[0]!.url,
    "https://api.github.com/repos/example/repository/issues?per_page=10",
  );
  assertEquals(calls[0]!.headers.get("authorization"), `Bearer ${secret}`);
  for (
    const path of [
      "/github/repos/example/another/issues",
      "/github/repos/example/repository-extra/issues",
      "/github/repos/example/repository%2f..%2fanother/issues",
      "/github/repos/example/repository/issues?access_token=untrusted",
    ]
  ) {
    const response = await handle(request(path));
    assertEquals(response.status, 403, path);
    await response.body?.cancel();
  }
  assertEquals(
    (await handle(request("/github/repos/example/repository/issues", {
      method: "POST",
      body: "{}",
    }))).status,
    403,
  );
  assertEquals(calls.length, 1);
});

Deno.test("credential broker refuses unconfigured providers instead of sending an anonymous request", async () => {
  const { calls, handle } = fixture();
  const response = await handle(
    request("/openai/v1/responses", { method: "POST", body: "{}" }),
  );
  assertEquals(response.status, 503);
  assertEquals(calls.length, 0);
});

Deno.test("credential broker keeps Gemini query authentication out of the URL", async () => {
  const { calls, handle } = fixture();
  const response = await handle(
    request("/gemini/v1beta/models/example:streamGenerateContent?alt=sse", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(
    calls[0]!.url,
    "https://generativelanguage.googleapis.com/v1beta/models/example:streamGenerateContent?alt=sse",
  );
  assertEquals(calls[0]!.headers.get("x-goog-api-key"), secret);
  assert(!calls[0]!.url.includes(secret));
});

Deno.test("credential broker refuses redirects and never follows them with credentials", async () => {
  let calls = 0;
  const handle = createCredentialBroker({
    capability,
    credentials: { claude: secret },
    repositories: [],
    fetch: (input) => {
      calls++;
      assertEquals(input.redirect, "manual");
      return Promise.resolve(
        new Response(null, {
          status: 307,
          headers: { location: "https://attacker.invalid/collect" },
        }),
      );
    },
  });
  const response = await handle(
    request("/claude/v1/messages", { method: "POST", body: "{}" }),
  );
  assertEquals(response.status, 502);
  assertEquals(response.headers.get("location"), null);
  assertEquals(calls, 1);
});

Deno.test("credential broker errors disclose neither injected credentials nor upstream exception text", async () => {
  const handle = createCredentialBroker({
    capability,
    credentials: { claude: secret },
    repositories: [],
    fetch: () => Promise.reject(new Error(`upstream failed with ${secret}`)),
  });
  const response = await handle(
    request("/claude/v1/messages", { method: "POST", body: "{}" }),
  );
  assertEquals(response.status, 502);
  assertEquals(await response.text(), "Upstream request failed\n");
});

Deno.test("credential broker rejects oversized bodies before any upstream request", async () => {
  let calls = 0;
  const handle = createCredentialBroker({
    capability,
    credentials: { claude: secret },
    repositories: [],
    maxRequestBytes: 4,
    fetch: () => {
      calls++;
      return Promise.resolve(new Response("unexpected"));
    },
  });
  const response = await handle(request("/claude/v1/messages", {
    method: "POST",
    body: "12345",
    headers: { "content-type": "application/json" },
  }));
  assertEquals(response.status, 413);
  assertEquals(calls, 0);
});

Deno.test("credential broker rejects weak capability configuration before serving", () => {
  assertThrows(
    () =>
      createCredentialBroker({
        capability: "short",
        credentials: {},
        repositories: [],
      }),
    Error,
    "capability",
  );
});

Deno.test("credential broker preserves incremental model output without buffering the response", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const handle = createCredentialBroker({
    capability,
    credentials: { claude: secret },
    repositories: [],
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              stream = controller;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  });
  const response = await handle(
    request("/claude/v1/messages", { method: "POST", body: "{}" }),
  );
  assertEquals(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body!.getReader();
  stream.enqueue(new TextEncoder().encode("data: first\n\n"));
  assertEquals(
    new TextDecoder().decode((await reader.read()).value),
    "data: first\n\n",
  );
  stream.enqueue(new TextEncoder().encode("data: second\n\n"));
  assertEquals(
    new TextDecoder().decode((await reader.read()).value),
    "data: second\n\n",
  );
  stream.close();
  assertEquals((await reader.read()).done, true);
});

Deno.test("credential broker enforces its body limit across stream chunks without trusting Content-Length", async () => {
  let calls = 0;
  let cancelled = false;
  const handle = createCredentialBroker({
    capability,
    credentials: { claude: secret },
    repositories: [],
    maxRequestBytes: 4,
    fetch: () => {
      calls++;
      return Promise.resolve(new Response());
    },
  });
  const response = await handle(request("/claude/v1/messages", {
    method: "POST",
    headers: { "content-length": "1" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
      },
      cancel() {
        cancelled = true;
      },
    }),
  }));
  assertEquals(response.status, 413);
  assert(cancelled);
  assertEquals(calls, 0);
});

Deno.test("credential broker rejects invalid repositories and credentials before serving", () => {
  assertThrows(
    () =>
      createCredentialBroker({
        capability,
        credentials: {},
        repositories: ["example/repository/extra"],
      }),
    Error,
    "owner/name",
  );
  for (const credential of ["bad\nheader", "", "non-ASCII-☃"]) {
    assertThrows(
      () =>
        createCredentialBroker({
          capability,
          credentials: { claude: credential },
          repositories: [],
        }),
      Error,
      "Invalid broker credential",
    );
  }
});
