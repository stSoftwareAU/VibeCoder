import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createCredentialBroker,
  type CredentialBrokerOptions,
} from "../lib/credential_broker.ts";
import { createGitHubAgentGateway } from "../lib/github_agent_gateway.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";

const capability = "synthetic-write-capability-0123456789abcdef";
const secret = "synthetic-private-github-token";
function request(
  path: string,
  body: unknown,
  method = "POST",
  auth = capability,
) {
  return new Request(
    `http://broker.invalid/github/repos/fixture/allowed/${path}`,
    {
      method,
      headers: { authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    },
  );
}
function fixture(overrides: Partial<CredentialBrokerOptions> = {}) {
  const calls: Request[] = [];
  const audits: unknown[] = [];
  const broker = createCredentialBroker({
    capability,
    credentials: { github: secret },
    repositories: ["fixture/allowed"],
    githubWrites: {
      claimedIssue: { repo: "fixture/allowed", issueNumber: 7 },
      audit: (mutation, status) => {
        audits.push({ mutation, status });
        return Promise.resolve();
      },
    },
    fetch(input) {
      calls.push(input);
      return Promise.resolve(Response.json({ id: 10 }, { status: 201 }));
    },
    ...overrides,
  });
  return { broker, calls, audits };
}

Deno.test("broker forwards only canonical redacted REST bytes and journals the actual target and outcome", async () => {
  const { broker, calls, audits } = fixture();
  const leaked = "ghp_" + "a".repeat(36);
  for (const method of ["POST", "PATCH"]) {
    const path = method === "POST" ? "issues/7/comments" : "issues/comments/10";
    const result = await broker(
      request(path, { body: `Note ${leaked}` }, method),
    );
    assertEquals(result.status, 201);
    await result.body?.cancel();
    const sent = calls.at(-1)!;
    assertEquals(sent.method, method);
    assertEquals(
      sent.url,
      `https://api.github.com/repos/fixture/allowed/${path}`,
    );
    assertEquals(sent.headers.get("authorization"), `Bearer ${secret}`);
    assertEquals(sent.headers.get("content-type"), "application/json");
    assertEquals(
      await sent.text(),
      JSON.stringify({
        body: `Note ${REDACTION_PLACEHOLDER}`,
      }),
    );
  }
  assertEquals(
    audits,
    ["issues/7/comments", "issues/comments/10"].map((path, index) => ({
      mutation: {
        verb: index === 0 ? "api-post" : "api-patch",
        scope: "explicit",
        repo: "fixture/allowed",
        target: `repos/fixture/allowed/${path}`,
      },
      status: 201,
    })),
  );
});

Deno.test("broker writes cannot bypass capability, bounds, host claim or closed route policy", async () => {
  const { broker, calls, audits } = fixture({ maxRequestBytes: 100 });
  for (
    const [input, expected] of [
      [request("issues/7/comments", { body: "ok" }, "POST", "wrong"), 401],
      [request("issues/7/comments", { body: "x".repeat(100) }), 413],
      [request("issues/8/labels", { labels: ["needs-human"] }), 403],
      [request("issues/7/labels", { labels: ["work-on"] }), 403],
      [request("issues/7", { state: "closed" }, "PATCH"), 403],
      [request("pulls/9/merge", {}, "PUT"), 403],
      [request("issues/7/comments?access_token=secret", { body: "ok" }), 403],
      [request("issues/7/comments", { body: "ok", role: "worker" }), 403],
    ] as const
  ) {
    const result = await broker(input);
    assertEquals(result.status, expected);
    await result.body?.cancel();
  }
  assertEquals(calls.length, 0);
  assertEquals(audits, []);
  const disabled = fixture({ githubWrites: undefined });
  assertEquals(
    (await disabled.broker(request("issues/7/comments", { body: "ok" })))
      .status,
    403,
  );
  assertEquals(disabled.calls.length, 0);
});

Deno.test("existing native GitHub gateway supports permitted REST writes without passing supplied authority", async () => {
  const { broker, calls } = fixture();
  const gateway = createGitHubAgentGateway({ capability, forward: broker });
  const response = await gateway(
    new Request(
      "https://api.github.com/repos/fixture/allowed/issues/7/labels",
      {
        method: "POST",
        headers: {
          authorization: "Bearer worker-secret",
          "x-broker-role": "worker",
        },
        body: '{"labels":["needs-human"]}',
      },
    ),
  );
  assertEquals(response.status, 201);
  await response.body?.cancel();
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.headers.get("x-broker-role"), null);
  assertEquals(await calls[0]!.text(), '{"labels":["needs-human"]}');
});

Deno.test("revocation during a pending write body refuses the write and audit records transport errors without secrets", async () => {
  const controller = new AbortController();
  const first = fixture({ signal: controller.signal });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => started = resolve);
  const response = first.broker(
    new Request(
      "http://broker.invalid/github/repos/fixture/allowed/issues/7/comments",
      {
        method: "POST",
        headers: { authorization: `Bearer ${capability}` },
        body: new ReadableStream({
          pull() {
            started();
          },
        }),
      },
    ),
  );
  await ready;
  controller.abort();
  assertEquals((await response).status, 503);
  assertEquals(first.calls.length, 0);
  assertEquals(first.audits, []);
  const second = fixture({ fetch: () => Promise.reject(new Error(secret)) });
  const failed = await second.broker(
    request("issues/7/comments", { body: "ok" }),
  );
  assertEquals(failed.status, 502);
  assertEquals(await failed.text(), "Upstream request failed\n");
  assertEquals(second.audits.length, 1);
  assertStringIncludes(JSON.stringify(second.audits), '"verb":"api-post"');
  assertEquals(JSON.stringify(second.audits).includes(secret), false);
});
