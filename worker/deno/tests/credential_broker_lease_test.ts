/** Host-owned broker grants expire and revoke without exposing credentials. */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createCredentialBrokerLease } from "../lib/credential_broker_lease.ts";

const upstreamSecret = "synthetic-broker-only-value";

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ expired: true }>((resolve) => {
    timer = setTimeout(() => resolve({ expired: true }), 250);
  });
  try {
    const outcome = await Promise.race([
      promise.then((value) => ({ value })),
      timeout,
    ]);
    assert(
      "value" in outcome,
      "Broker cancellation did not settle within the test deadline",
    );
    return outcome.value;
  } finally {
    clearTimeout(timer);
  }
}

function request(
  capability: string,
  path = "/claude/v1/messages",
  body: BodyInit = "{}",
): Request {
  return new Request(`http://broker.invalid${path}`, {
    method: path.startsWith("/github/") ? "GET" : "POST",
    headers: { authorization: `Bearer ${capability}` },
    body: path.startsWith("/github/") ? undefined : body,
  });
}

Deno.test("broker leases bind immutable host scope and cannot issue authority over HTTP", async () => {
  const repositories = ["example/one"];
  const credentials = { claude: upstreamSecret, github: upstreamSecret };
  const calls: Request[] = [];
  const lease = createCredentialBrokerLease({
    lifetimeMs: 60_000,
    credentials,
    repositories,
    fetch(input) {
      calls.push(input);
      return Promise.resolve(new Response("allowed"));
    },
  });
  try {
    repositories.push("example/two");
    credentials.claude = "changed-after-host-grant";
    const allowed = await lease.handle(request(lease.capability));
    assertEquals(await allowed.text(), "allowed");
    assertEquals(calls[0]!.headers.get("x-api-key"), upstreamSecret);
    for (
      const path of [
        "/github/repos/example/two/issues",
        "/capabilities",
        "/admin/grants",
        "/claude/oauth/token",
      ]
    ) {
      const denied = await lease.handle(request(lease.capability, path));
      assertEquals(denied.status, 403, path);
      await denied.body?.cancel();
    }
    assertEquals(calls.length, 1);
    assert(!lease.capability.includes(upstreamSecret));
  } finally {
    lease.close();
  }
  await within(lease.closed);
});

Deno.test("revoking one broker lease leaves an independently scoped lease usable", async () => {
  let calls = 0;
  const options = {
    lifetimeMs: 60_000,
    credentials: { claude: upstreamSecret },
    repositories: [],
    fetch: () => {
      calls++;
      return Promise.resolve(new Response("allowed"));
    },
  };
  const first = createCredentialBrokerLease(options);
  const second = createCredentialBrokerLease(options);
  try {
    assert(first.capability !== second.capability);
    first.close();
    first.close();
    const stopped = await first.handle(request(first.capability));
    assertEquals(stopped.status, 503);
    assertEquals(await stopped.text(), "Broker session is closed\n");
    const wrong = await second.handle(request(first.capability));
    assertEquals(wrong.status, 401);
    await wrong.body?.cancel();
    assertEquals(
      await (await second.handle(request(second.capability))).text(),
      "allowed",
    );
    assertEquals(calls, 1);
  } finally {
    first.close();
    second.close();
  }
});

Deno.test("broker lease expiry refuses later requests without reaching upstream", async () => {
  let calls = 0;
  const lease = createCredentialBrokerLease({
    lifetimeMs: 10,
    credentials: { claude: upstreamSecret },
    repositories: [],
    fetch() {
      calls++;
      return Promise.resolve(new Response("unexpected"));
    },
  });
  try {
    await within(lease.closed);
    const response = await lease.handle(request(lease.capability));
    assertEquals(response.status, 503);
    await response.body?.cancel();
    assertEquals(calls, 0);
  } finally {
    lease.close();
  }
});

Deno.test("revocation cancels an unfinished request body before any upstream operation", async () => {
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  let calls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      started();
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  const lease = createCredentialBrokerLease({
    lifetimeMs: 60_000,
    credentials: { claude: upstreamSecret },
    repositories: [],
    fetch() {
      calls++;
      return Promise.resolve(new Response("unexpected"));
    },
  });
  try {
    const pending = lease.handle(
      request(lease.capability, "/claude/v1/messages", body),
    );
    await within(reading);
    lease.close();
    const response = await within(pending);
    assertEquals(response.status, 503);
    await response.body?.cancel();
    assertEquals(cancelled, true);
    assertEquals(calls, 0);
  } finally {
    lease.close();
  }
});

Deno.test("revocation aborts a live response stream and the upstream request", async () => {
  let upstreamSignal!: AbortSignal;
  let cancelled = false;
  const lease = createCredentialBrokerLease({
    lifetimeMs: 60_000,
    credentials: { claude: upstreamSecret },
    repositories: [],
    fetch(input) {
      upstreamSignal = input.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
    },
  });
  try {
    const response = await lease.handle(request(lease.capability));
    const reader = response.body!.getReader();
    assertEquals(
      new TextDecoder().decode((await reader.read()).value),
      "first",
    );
    lease.close();
    assertEquals(upstreamSignal.aborted, true);
    await assertRejects(
      () => within(reader.read()),
      DOMException,
      "Broker session is closed",
    );
    reader.releaseLock();
    assertEquals(cancelled, true);
  } finally {
    lease.close();
  }
});

Deno.test("broker leases reject absent, unbounded or invalid lifetimes", () => {
  for (const lifetimeMs of [0, -1, NaN, Infinity, 0.5, 86_400_001]) {
    assertThrows(() =>
      createCredentialBrokerLease({
        lifetimeMs,
        credentials: {},
        repositories: [],
      })
    );
  }
});

Deno.test("revocation during authentication refuses bodyless requests before calling the transport", async () => {
  let calls = 0;
  const lease = createCredentialBrokerLease({
    lifetimeMs: 60_000,
    credentials: { github: upstreamSecret },
    repositories: ["example/one"],
    fetch() {
      calls++;
      return Promise.resolve(new Response("unexpected"));
    },
  });
  try {
    // handle has passed its entry check and yielded on asynchronous capability
    // hashing; close before that continuation can forward the bodyless GET.
    const pending = lease.handle(
      request(lease.capability, "/github/repos/example/one/issues"),
    );
    lease.close();
    const response = await within(pending);
    assertEquals(response.status, 503);
    assertEquals(await response.text(), "Broker session is closed\n");
    assertEquals(calls, 0);
  } finally {
    lease.close();
  }
});

Deno.test("revoked and redirected upstream responses remain refused when cancellation rejects", async () => {
  for (const revoked of [true, false]) {
    let cancelled = false;
    const lease = createCredentialBrokerLease({
      lifetimeMs: 60_000,
      credentials: { claude: upstreamSecret },
      repositories: [],
      fetch() {
        if (revoked) lease.close();
        return Promise.resolve(
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
                throw new Error(upstreamSecret);
              },
            }),
            { status: revoked ? 200 : 302 },
          ),
        );
      },
    });
    try {
      const response = await within(lease.handle(request(lease.capability)));
      assertEquals(response.status, revoked ? 503 : 502);
      const text = await response.text();
      assert(
        text.includes(
          revoked ? "Broker session is closed" : "Upstream redirect refused",
        ),
      );
      assert(text.includes("upstream cancellation failed"));
      assert(!text.includes(upstreamSecret));
      assertEquals(cancelled, true);
    } finally {
      lease.close();
    }
  }
});
