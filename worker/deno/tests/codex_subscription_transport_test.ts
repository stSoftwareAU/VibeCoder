/** Trusted-only ChatGPT transport and refresh, using synthetic OAuth state. */
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createCodexSubscriptionTransport } from "../lib/codex_subscription_transport.ts";

const account = "fixture-account";
const now = Date.UTC(2026, 9, 18);
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
function jwt(
  accountId = account,
  expires: number | null = now / 1000 + 3600,
  fedramp = false,
): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("=", "").replaceAll("+", "-")
      .replaceAll("/", "_");
  return `${encode({ alg: "none" })}.${
    encode({
      exp: expires,
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
        chatgpt_account_is_fedramp: fedramp,
      },
    })
  }.synthetic`;
}
function auth(expires = now / 1000 + 3600) {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      account_id: account,
      access_token: jwt(account, expires),
      id_token: jwt(),
      refresh_token: "synthetic-refresh-one",
    },
    last_refresh: new Date(now).toISOString(),
  };
}
function request(url = endpoint, signal?: AbortSignal) {
  return new Request(url, {
    method: "POST",
    body: '{"model":"fixture","stream":true}',
    headers: {
      authorization: "Bearer agent-value",
      "chatgpt-account-id": "agent-account",
      "x-openai-fedramp": "true",
      cookie: "agent-cookie",
    },
    signal,
  });
}

Deno.test("Codex subscription uses only the trusted account and fixed ChatGPT destination", async () => {
  const initial = auth();
  const calls: Request[] = [];
  const forward = createCodexSubscriptionTransport({
    authJson: JSON.stringify(initial),
    accountId: account,
    now: () => now,
    persist: () => Promise.reject(new Error("unexpected refresh")),
    fetch(req) {
      calls.push(req);
      return Promise.resolve(
        new Response("fixture SSE", {
          headers: {
            "content-type": "text/event-stream",
            "set-cookie": "secret",
          },
        }),
      );
    },
  });
  initial.tokens.account_id = "mutated-after-construction";
  const response = await forward(request());
  assertEquals(response.status, 200);
  assertEquals(await response.text(), "fixture SSE");
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.url, endpoint);
  assertEquals(calls[0]!.redirect, "manual");
  assertEquals(calls[0]!.headers.get("authorization"), `Bearer ${jwt()}`);
  assertEquals(calls[0]!.headers.get("chatgpt-account-id"), account);
  assertEquals(calls[0]!.headers.get("x-openai-fedramp"), null);
  assertEquals(calls[0]!.headers.get("cookie"), null);
  assertEquals(response.headers.get("set-cookie"), null);
  assertEquals(await calls[0]!.text(), '{"model":"fixture","stream":true}');
  for (
    const url of [
      endpoint + "?redirect=1",
      "https://api.openai.com/v1/responses",
      "https://auth.openai.com/oauth/token",
    ]
  ) {
    const denied = await forward(request(url));
    assertEquals(denied.status, 403);
    assertEquals(await denied.text(), "Codex subscription route denied\n");
  }
  assertEquals(calls.length, 1);
});

Deno.test("Codex subscription rejects malformed or ambiguous account snapshots before any request", () => {
  const base = auth();
  for (
    const value of [
      {},
      { ...base, auth_mode: "apikey" },
      { ...base, OPENAI_API_KEY: "available-api-key" },
      { ...base, tokens: { ...base.tokens, account_id: undefined } },
      { ...base, tokens: { ...base.tokens, account_id: "another-account" } },
      {
        ...base,
        tokens: { ...base.tokens, access_token: jwt("another-account") },
      },
      { ...base, tokens: { ...base.tokens, id_token: jwt("another-account") } },
      { ...base, tokens: { ...base.tokens, id_token: "malformed" } },
      { ...base, tokens: { ...base.tokens, refresh_token: "" } },
      { ...base, last_refresh: "not-a-date" },
    ]
  ) {
    assertThrows(
      () =>
        createCodexSubscriptionTransport({
          authJson: JSON.stringify(value),
          accountId: account,
          persist: () => Promise.resolve(),
        }),
      Error,
      "Invalid selected Codex subscription snapshot",
    );
  }
});

Deno.test("Codex refresh persists a same-account replacement before any native request uses it", async () => {
  const initial = JSON.stringify(auth(now / 1000 - 1));
  const refreshedAccess = jwt(account, now / 1000 + 7200);
  const events: string[] = [];
  const forward = createCodexSubscriptionTransport({
    authJson: initial,
    accountId: account,
    now: () => now,
    async persist(replacement) {
      events.push("persist");
      assertEquals(replacement.expectedAuthJson, initial);
      const saved = JSON.parse(replacement.authJson);
      assertEquals(saved.tokens.account_id, account);
      assertEquals(saved.tokens.access_token, refreshedAccess);
      assertEquals(saved.tokens.refresh_token, "synthetic-refresh-two");
      assertEquals(saved.tokens.id_token, jwt());
      assertEquals(saved.last_refresh, new Date(now).toISOString());
      await Promise.resolve();
    },
    async fetch(req) {
      if (req.url === "https://auth.openai.com/oauth/token") {
        events.push("refresh");
        assertEquals(req.method, "POST");
        assertEquals(req.redirect, "manual");
        assertEquals(req.headers.get("authorization"), null);
        assertEquals(await req.json(), {
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          grant_type: "refresh_token",
          refresh_token: "synthetic-refresh-one",
        });
        return Response.json({
          access_token: refreshedAccess,
          refresh_token: "synthetic-refresh-two",
        });
      }
      events.push("inference");
      assertEquals(req.url, endpoint);
      assertEquals(
        req.headers.get("authorization"),
        `Bearer ${refreshedAccess}`,
      );
      return new Response("completed");
    },
  });
  const response = await forward(request());
  assertEquals(await response.text(), "completed");
  assertEquals(events, ["refresh", "persist", "inference"]);
});

Deno.test("Codex overlapping stale-token refusals share one refresh and wait for persistence", async () => {
  const allOldCalls = Promise.withResolvers<void>();
  const refreshStarted = Promise.withResolvers<void>();
  const allowRefresh = Promise.withResolvers<void>();
  const persistenceStarted = Promise.withResolvers<void>();
  const allowPersistence = Promise.withResolvers<void>();
  let oldCalls = 0;
  let newCalls = 0;
  let refreshes = 0;
  let persists = 0;
  let persistenceCompleted = false;
  const replacement = jwt(account, now / 1000 + 7200);
  const forward = createCodexSubscriptionTransport({
    authJson: JSON.stringify(auth()),
    accountId: account,
    now: () => now,
    async persist() {
      persists++;
      persistenceStarted.resolve();
      await allowPersistence.promise;
      persistenceCompleted = true;
    },
    async fetch(req) {
      if (req.url.endsWith("/oauth/token")) {
        refreshes++;
        refreshStarted.resolve();
        await allowRefresh.promise;
        return Response.json({ access_token: replacement });
      }
      if (req.headers.get("authorization") === `Bearer ${jwt()}`) {
        if (++oldCalls === 3) allOldCalls.resolve();
        return new Response("private refusal", { status: 401 });
      }
      assertEquals(req.headers.get("authorization"), `Bearer ${replacement}`);
      assertEquals(persistenceCompleted, true);
      newCalls++;
      return new Response("completed");
    },
  });
  const pending = [forward(request()), forward(request()), forward(request())];
  await Promise.all([allOldCalls.promise, refreshStarted.promise]);
  assertEquals(refreshes, 1);
  allowRefresh.resolve();
  await persistenceStarted.promise;
  assertEquals(newCalls, 0);
  assertEquals(persists, 1);
  allowPersistence.resolve();
  for (const result of await Promise.all(pending)) {
    assertEquals(result.status, 200);
    assertEquals(await result.text(), "completed");
  }
  assertEquals({ oldCalls, newCalls, refreshes, persists }, {
    oldCalls: 3,
    newCalls: 3,
    refreshes: 1,
    persists: 1,
  });
});

Deno.test("Codex closing a session during refresh cancels it without persisting or inferring", async () => {
  const session = new AbortController();
  const started = Promise.withResolvers<void>();
  let refreshSignal!: AbortSignal;
  let calls = 0;
  let persists = 0;
  const forward = createCodexSubscriptionTransport({
    authJson: JSON.stringify(auth(now / 1000 - 1)),
    accountId: account,
    now: () => now,
    signal: session.signal,
    persist() {
      persists++;
      return Promise.resolve();
    },
    fetch(req) {
      calls++;
      assertEquals(req.url, "https://auth.openai.com/oauth/token");
      refreshSignal = req.signal;
      started.resolve();
      return new Promise((_resolve, reject) => {
        req.signal.addEventListener(
          "abort",
          () => reject(new Error("private refresh failure")),
          { once: true },
        );
      });
    },
  });
  const pending = forward(request());
  await started.promise;
  session.abort();
  const result = await pending;
  assertEquals(refreshSignal.aborted, true);
  assertEquals(result.status, 503);
  assertEquals(await result.text(), "Codex subscription session is closed\n");
  assertEquals((await forward(request())).status, 503);
  assertEquals({ calls, persists }, { calls: 1, persists: 0 });
});

Deno.test("Codex a late refusal for an old snapshot reuses the already persisted replacement", async () => {
  const lateStarted = Promise.withResolvers<void>();
  const releaseLate = Promise.withResolvers<void>();
  let oldCalls = 0;
  let refreshes = 0;
  let persists = 0;
  const forward = createCodexSubscriptionTransport({
    authJson: JSON.stringify(auth()),
    accountId: account,
    now: () => now,
    persist() {
      persists++;
      return Promise.resolve();
    },
    async fetch(req) {
      if (req.url.endsWith("/oauth/token")) {
        refreshes++;
        return Response.json({ access_token: jwt(account, now / 1000 + 7200) });
      }
      if (req.headers.get("authorization") === `Bearer ${jwt()}`) {
        if (++oldCalls === 2) {
          lateStarted.resolve();
          await releaseLate.promise;
        }
        return new Response("old token refused", { status: 401 });
      }
      return new Response("completed");
    },
  });
  const first = forward(request());
  const second = forward(request());
  await lateStarted.promise;
  assertEquals(await (await first).text(), "completed");
  releaseLate.resolve();
  assertEquals(await (await second).text(), "completed");
  assertEquals({ oldCalls, refreshes, persists }, {
    oldCalls: 2,
    refreshes: 1,
    persists: 1,
  });
});

Deno.test("Codex close while persistence is pending cannot publish a replacement into an invocation", async () => {
  const session = new AbortController();
  const started = Promise.withResolvers<void>();
  const finishPersistence = Promise.withResolvers<void>();
  let persistSignal!: AbortSignal;
  let calls = 0;
  const forward = createCodexSubscriptionTransport({
    authJson: JSON.stringify(auth(now / 1000 - 1)),
    accountId: account,
    now: () => now,
    signal: session.signal,
    async persist(replacement) {
      persistSignal = replacement.signal;
      started.resolve();
      // Even a buggy host writer returning success after cancellation must
      // not make the transport use the replacement or send another request.
      await finishPersistence.promise;
    },
    fetch(req) {
      calls++;
      assertEquals(req.url, "https://auth.openai.com/oauth/token");
      return Promise.resolve(Response.json({ access_token: jwt() }));
    },
  });
  const pending = forward(request());
  await started.promise;
  session.abort();
  assertEquals(persistSignal.aborted, true);
  finishPersistence.resolve();
  assertEquals((await pending).status, 503);
  assertEquals((await forward(request())).status, 503);
  assertEquals(calls, 1);
});

Deno.test("Codex persistence failure latches the transport closed without using the unsaved replacement", async () => {
  let calls = 0;
  const forward = createCodexSubscriptionTransport({
    authJson: JSON.stringify(auth(now / 1000 - 1)),
    accountId: account,
    now: () => now,
    persist: () => Promise.reject(new Error("private snapshot path and token")),
    fetch(req) {
      calls++;
      assertEquals(req.url, "https://auth.openai.com/oauth/token");
      return Promise.resolve(Response.json({ access_token: jwt() }));
    },
  });
  const first = await forward(request());
  assertEquals(first.status, 502);
  assertEquals(await first.text(), "Codex subscription persistence failed\n");
  const second = await forward(request());
  assertEquals(second.status, 503);
  assertEquals(await second.text(), "Codex subscription persistence failed\n");
  assertEquals(calls, 1);
});

Deno.test("Codex a request still reading its body observes another request's failed refresh", async () => {
  const reading = Promise.withResolvers<void>();
  let cancelled = false;
  let inference = 0;
  const forward = createCodexSubscriptionTransport({
    authJson: JSON.stringify(auth()),
    accountId: account,
    now: () => now,
    persist: () => Promise.reject(new Error("persistence unavailable")),
    fetch(req) {
      if (req.url.endsWith("/oauth/token")) {
        return Promise.resolve(
          Response.json({ access_token: jwt(account, now / 1000 + 7200) }),
        );
      }
      inference++;
      return Promise.resolve(new Response("private token", { status: 401 }));
    },
  });
  const waiting = forward(
    new Request(endpoint, {
      method: "POST",
      body: new ReadableStream({
        pull() {
          reading.resolve();
        },
        cancel() {
          cancelled = true;
        },
      }),
    }),
  );
  await reading.promise;
  assertEquals((await forward(request())).status, 502);
  const refused = await waiting;
  assertEquals(cancelled, true);
  assertEquals(refused.status, 503);
  assertEquals(await refused.text(), "Codex subscription persistence failed\n");
  assertEquals(inference, 1);
});

Deno.test("Codex malformed, refused, oversized or different-account refresh responses fail closed", async () => {
  const responses = [
    () => Response.json({}),
    () => Response.json({ access_token: jwt("other-account") }),
    () =>
      Response.json({ access_token: jwt(), id_token: jwt("other-account") }),
    () => Response.json({ access_token: jwt(), refresh_token: "" }),
    () => Response.json({ access_token: jwt(), id_token: "invalid" }),
    () => Response.json({ access_token: jwt(account, now / 1000 - 1) }),
    () => new Response("not JSON"),
    () => new Response("private token refused", { status: 401 }),
    () =>
      new Response("redirected token", {
        status: 302,
        headers: { location: "https://attacker.invalid" },
      }),
    () =>
      Response.json({ access_token: jwt(), padding: "a".repeat(128 * 1024) }),
  ];
  for (const response of responses) {
    let calls = 0;
    let persists = 0;
    const forward = createCodexSubscriptionTransport({
      authJson: JSON.stringify(auth(now / 1000 - 1)),
      accountId: account,
      now: () => now,
      persist() {
        persists++;
        return Promise.resolve();
      },
      fetch(req) {
        calls++;
        assertEquals(req.url, "https://auth.openai.com/oauth/token");
        return Promise.resolve(response());
      },
    });
    const first = await forward(request());
    assertEquals(first.status, 502);
    assertEquals(await first.text(), "Codex subscription refresh failed\n");
    assertEquals((await forward(request())).status, 503);
    assertEquals({ calls, persists }, { calls: 1, persists: 0 });
  }
});

Deno.test("Codex retries authentication once and never returns token-bearing refusal bodies", async () => {
  let inference = 0;
  let refreshes = 0;
  const forward = createCodexSubscriptionTransport({
    authJson: JSON.stringify(auth()),
    accountId: account,
    now: () => now,
    persist: () => Promise.resolve(),
    fetch(req) {
      if (req.url.endsWith("/oauth/token")) {
        refreshes++;
        return Promise.resolve(
          Response.json({ access_token: jwt(account, now / 1000 + 7200) }),
        );
      }
      inference++;
      return Promise.resolve(
        new Response("private credential", { status: 401 }),
      );
    },
  });
  const result = await forward(request());
  assertEquals(result.status, 401);
  assertEquals(
    await result.text(),
    "Codex subscription authentication refused\n",
  );
  assertEquals((await forward(request())).status, 503);
  assertEquals({ inference, refreshes }, { inference: 2, refreshes: 1 });
});

Deno.test("Codex response streaming preserves cancellation and refuses redirects", async () => {
  const session = new AbortController();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let upstreamSignal!: AbortSignal;
  const forward = createCodexSubscriptionTransport({
    authJson: JSON.stringify(auth()),
    accountId: account,
    now: () => now,
    signal: session.signal,
    persist: () => Promise.resolve(),
    fetch(req) {
      upstreamSignal = req.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              source = controller;
            },
          }),
        ),
      );
    },
  });
  const response = await forward(request());
  const reader = response.body!.getReader();
  source.enqueue(new TextEncoder().encode("first"));
  assertEquals(new TextDecoder().decode((await reader.read()).value), "first");
  session.abort();
  assertEquals(upstreamSignal.aborted, true);
  await assertRejects(() => reader.read(), DOMException);
  reader.releaseLock();

  let calls = 0;
  const redirecting = createCodexSubscriptionTransport({
    authJson: JSON.stringify(auth()),
    accountId: account,
    now: () => now,
    persist: () => Promise.resolve(),
    fetch() {
      calls++;
      return Promise.resolve(
        new Response("private location", {
          status: 307,
          headers: { location: "https://attacker.invalid" },
        }),
      );
    },
  });
  const refused = await redirecting(request());
  assertEquals(refused.status, 502);
  assertEquals(await refused.text(), "Codex subscription redirect refused\n");
  assertEquals(refused.headers.get("location"), null);
  assertEquals(calls, 1);
});

Deno.test("Codex pinned expiry window and legacy age determine refresh while trusted FedRAMP routing survives", async () => {
  for (
    const [expires, ageDays, expectedRefreshes] of [
      [now / 1000 + 300, 0, 1],
      [now / 1000 + 301, 9, 0],
      [null, 8, 0],
      [null, 9, 1],
    ] as const
  ) {
    const selected = auth();
    selected.tokens.access_token = jwt(account, expires);
    selected.tokens.id_token = jwt(account, null, true);
    selected.last_refresh = new Date(now - ageDays * 86400_000).toISOString();
    let refreshes = 0;
    const forward = createCodexSubscriptionTransport({
      authJson: JSON.stringify(selected),
      accountId: account,
      now: () => now,
      persist: () => Promise.resolve(),
      fetch(req) {
        if (req.url.endsWith("/oauth/token")) {
          refreshes++;
          return Promise.resolve(Response.json({ access_token: jwt() }));
        }
        assertEquals(req.headers.get("x-openai-fedramp"), "true");
        return Promise.resolve(new Response("completed"));
      },
    });
    const response = await forward(request());
    assertEquals(await response.text(), "completed");
    assertEquals(refreshes, expectedRefreshes);
  }
});

Deno.test("Codex body bounds and caller cancellation prevent any upstream invocation", async () => {
  let calls = 0;
  const forward = createCodexSubscriptionTransport({
    authJson: JSON.stringify(auth()),
    accountId: account,
    now: () => now,
    persist: () => Promise.resolve(),
    fetch() {
      calls++;
      return Promise.resolve(new Response("unexpected"));
    },
  });
  const oversized = await forward(
    new Request(endpoint, {
      method: "POST",
      body: new Uint8Array(16 * 1024 * 1024 + 1),
    }),
  );
  assertEquals(oversized.status, 413);
  assertEquals(
    await oversized.text(),
    "Codex subscription request body refused\n",
  );
  const caller = new AbortController();
  caller.abort();
  const cancelled = await forward(request(endpoint, caller.signal));
  assertEquals(cancelled.status, 408);
  assertEquals(
    await cancelled.text(),
    "Codex subscription request cancelled\n",
  );
  const wrongMethod = await forward(new Request(endpoint));
  assertEquals(wrongMethod.status, 403);
  assertEquals(calls, 0);
});

Deno.test("Codex upstream and refresh exceptions never disclose private diagnostic text", async () => {
  for (const expires of [now / 1000 + 3600, now / 1000 - 1]) {
    const forward = createCodexSubscriptionTransport({
      authJson: JSON.stringify(auth(expires)),
      accountId: account,
      now: () => now,
      persist: () => Promise.resolve(),
      fetch: () =>
        Promise.reject(new Error("private selected-token diagnostic")),
    });
    const result = await forward(request());
    assertEquals(result.status, 502);
    assertEquals(
      await result.text(),
      expires > now / 1000
        ? "Codex subscription upstream failed\n"
        : "Codex subscription refresh failed\n",
    );
  }
});

Deno.test("Codex native HTTP metadata and returned turn state survive without forwarding identity selectors", async () => {
  const metadata = {
    originator: "codex_cli_rs",
    "user-agent": "codex_cli_rs/0.147.0 (Linux fixture; x86_64)",
    version: "0.147.0",
    "session-id": "fixture-session",
    "thread-id": "fixture-thread",
    "x-client-request-id": "fixture-thread",
    "x-codex-beta-features": "fixture-beta",
    "x-codex-turn-state": "fixture-routing-state",
    "x-codex-turn-metadata": '{"turn_id":"fixture-turn"}',
    "x-codex-window-id": "fixture-thread:0",
    "x-codex-parent-thread-id": "fixture-parent",
    "x-codex-installation-id": "fixture-installation",
    "x-openai-subagent": "review",
    "x-openai-memgen-request": "true",
    "x-openai-internal-codex-responses-lite": "true",
  };
  const forbidden = [
    "openai-organization",
    "openai-project",
    "proxy-authorization",
    "x-openai-actor-authorization",
    "x-openai-internal-codex-residency",
    "openai-beta",
  ];
  const forward = createCodexSubscriptionTransport({
    authJson: JSON.stringify(auth()),
    accountId: account,
    now: () => now,
    persist: () => Promise.resolve(),
    fetch(req) {
      for (const [name, value] of Object.entries(metadata)) {
        assertEquals(req.headers.get(name), value, name);
      }
      for (const name of forbidden) {
        assertEquals(req.headers.get(name), null, name);
      }
      return Promise.resolve(
        new Response("completed", {
          headers: {
            "x-codex-turn-state": "returned-routing-state",
            authorization: "Bearer private-upstream-token",
          },
        }),
      );
    },
  });
  const incoming = request();
  for (const [name, value] of Object.entries(metadata)) {
    incoming.headers.set(name, value);
  }
  for (const name of forbidden) incoming.headers.set(name, "caller-selected");
  const response = await forward(incoming);
  assertEquals(response.status, 200);
  assertEquals(await response.text(), "completed");
  assertEquals(
    response.headers.get("x-codex-turn-state"),
    "returned-routing-state",
  );
  assertEquals(response.headers.get("authorization"), null);
});
