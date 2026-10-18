import { assertEquals } from "@std/assert";
import {
  createCredentialBroker,
  type CredentialBrokerOptions,
} from "../lib/credential_broker.ts";

const capability = "synthetic-git-capability-0123456789abcdef";
const secret = "synthetic-github-upstream-token";
function request(
  path = "fixture/allowed.git/info/refs?service=git-upload-pack",
  body?: Uint8Array<ArrayBuffer>,
  auth = capability,
) {
  return new Request(`http://broker.invalid/git/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${auth}`,
      "git-protocol": "version=2",
      "content-type": "application/x-git-upload-pack-request",
      "x-broker-role": "worker",
    },
    body,
  });
}
function fixture(overrides: Partial<CredentialBrokerOptions> = {}) {
  const calls: Request[] = [];
  const broker = createCredentialBroker({
    capability,
    credentials: { github: secret },
    repositories: ["fixture/allowed"],
    gitReads: true,
    fetch(input) {
      calls.push(input);
      return Promise.resolve(
        new Response(new Uint8Array([0, 255, 1, 2]), {
          headers: {
            "content-type": "application/x-git-upload-pack-result",
            "set-cookie": secret,
          },
        }),
      );
    },
    ...overrides,
  });
  return { broker, calls };
}

Deno.test("Git read broker injects fixed GitHub Basic authentication and preserves binary protocol bytes", async () => {
  const { broker, calls } = fixture();
  const bytes = new TextEncoder().encode("000eversion 2\n0000");
  for (
    const input of [
      request(),
      request("fixture/allowed.git/git-upload-pack", bytes),
    ]
  ) {
    const result = await broker(input);
    assertEquals(result.status, 200);
    assertEquals(
      new Uint8Array(await result.arrayBuffer()),
      new Uint8Array([0, 255, 1, 2]),
    );
    assertEquals(result.headers.get("set-cookie"), null);
    assertEquals(
      result.headers.get("content-type"),
      "application/x-git-upload-pack-result",
    );
    const sent = calls.at(-1)!;
    assertEquals(new URL(sent.url).origin, "https://github.com");
    assertEquals(
      sent.headers.get("authorization"),
      `Basic ${btoa(`x-access-token:${secret}`)}`,
    );
    assertEquals(sent.headers.get("git-protocol"), "version=2");
    assertEquals(sent.headers.get("x-broker-role"), null);
  }
  assertEquals(
    calls[0]!.url,
    "https://github.com/fixture/allowed.git/info/refs?service=git-upload-pack",
  );
  assertEquals(
    calls[1]!.url,
    "https://github.com/fixture/allowed.git/git-upload-pack",
  );
  assertEquals(
    calls[1]!.headers.get("content-type"),
    "application/x-git-upload-pack-request",
  );
  assertEquals(new Uint8Array(await calls[1]!.arrayBuffer()), bytes);
});

Deno.test("Git broker read grant never authorises writes, another repository, extensions or unauthenticated access", async () => {
  const { broker, calls } = fixture();
  for (
    const [input, status] of [
      [request(undefined, undefined, "incorrect"), 401],
      [request("fixture/other.git/info/refs?service=git-upload-pack"), 403],
      [request("fixture/allowed.git/info/refs?service=git-receive-pack"), 403],
      [
        request("fixture/allowed.git/git-receive-pack", new Uint8Array([0])),
        403,
      ],
      [request("fixture/allowed.git/objects/HEAD"), 403],
      [
        request(
          "fixture/allowed.git/info/refs?service=git-upload-pack&token=secret",
        ),
        403,
      ],
    ] as const
  ) {
    const response = await broker(input);
    assertEquals(response.status, status);
    await response.body?.cancel();
  }
  assertEquals(calls.length, 0);
  const disabled = fixture({ gitReads: false });
  assertEquals((await disabled.broker(request())).status, 403);
  assertEquals(disabled.calls.length, 0);
});

Deno.test("Git read broker retains common body bounds, revocation and redirect refusal", async () => {
  const controller = new AbortController();
  const first = fixture({ signal: controller.signal, maxRequestBytes: 1 });
  assertEquals(
    (await first.broker(
      request("fixture/allowed.git/git-upload-pack", new Uint8Array([1, 2])),
    )).status,
    413,
  );
  controller.abort();
  assertEquals((await first.broker(request())).status, 503);
  assertEquals(first.calls.length, 0);
  let cancelled = false;
  const redirect = fixture({
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 302,
            headers: { location: `https://other.invalid/${secret}` },
          },
        ),
      ),
  });
  const response = await redirect.broker(request());
  assertEquals(response.status, 502);
  assertEquals(await response.text(), "Upstream redirect refused\n");
  assertEquals(cancelled, true);
});

Deno.test("Git read broker bounds both compressed and inflated negotiation bodies", async () => {
  const bytes = new TextEncoder().encode("000eversion 2\n0000".repeat(100));
  const compressed = new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const encoded = (body = compressed, encoding = "gzip") => {
    const input = request("fixture/allowed.git/git-upload-pack", body);
    input.headers.set("content-encoding", encoding);
    return input;
  };
  const { broker, calls } = fixture();
  const response = await broker(encoded());
  assertEquals(response.status, 200);
  await response.body?.cancel();
  assertEquals(new Uint8Array(await calls[0]!.arrayBuffer()), bytes);
  assertEquals(calls[0]!.headers.get("content-encoding"), null);
  const small = fixture({ maxRequestBytes: compressed.length + 1 });
  assertEquals((await small.broker(encoded())).status, 413);
  assertEquals(small.calls.length, 0);
  assertEquals((await broker(encoded(new Uint8Array([1, 2, 3])))).status, 400);
  assertEquals((await broker(encoded(compressed, "br"))).status, 403);
  assertEquals(calls.length, 1);
});
