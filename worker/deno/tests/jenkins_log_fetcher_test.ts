/**
 * Tests for the Jenkins log fetcher library (Issue #1891).
 *
 * Verifies that fetchJenkinsBuildStatus() and fetchJenkinsBuildLog()
 * correctly translate Jenkins HTTP responses to Result types, handle
 * missing environment variables, surface non-2xx responses, truncate
 * oversized logs to preserve the tail, and never leak the token in
 * any error message.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  fetchJenkinsBuildLog,
  fetchJenkinsBuildStatus,
} from "../lib/jenkins_log_fetcher.ts";
import type { EnvReader } from "../lib/jenkins_access_check.ts";

/**
 * Issue #958: the credentials arrive through the fetcher's `readEnv` seam,
 * so nothing here writes a token-shaped value into the process environment
 * that a parallel worker — or a child process — would see.
 */
function envReader(values: Record<string, string>): EnvReader {
  return (name) => values[name];
}

const TEST_TOKEN = "super-secret-jenkins-token-XYZ123";

const goodEnv = {
  JENKINS_URL: "https://jenkins.example.com",
  JENKINS_USER: "ci-bot",
  JENKINS_TOKEN: TEST_TOKEN,
};

/** The credentials every happy-path test drives the fetcher with. */
const readEnv = envReader(goodEnv);

Deno.test("fetchJenkinsBuildStatus - happy path returns parsed build", async () => {
  const fetchFn = (_url: string | URL | Request, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    assert(auth?.startsWith("Basic "), "expected Basic auth header");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          number: 42,
          result: "SUCCESS",
          url: "https://jenkins.example.com/job/MyJob/42/",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };

  const result = await fetchJenkinsBuildStatus({
    readEnv,
    jobPath: "MyJob",
    build: 42,
    fetchFn,
  });

  assert(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
  assertEquals(result.value.number, 42);
  assertEquals(result.value.result, "SUCCESS");
  assertEquals(
    result.value.url,
    "https://jenkins.example.com/job/MyJob/42/",
  );
});

Deno.test("fetchJenkinsBuildStatus - missing env vars returns specific error", async () => {
  const result = await fetchJenkinsBuildStatus({
    readEnv: envReader({}),
    jobPath: "MyJob",
    build: 1,
  });
  assert(!result.ok, "expected error");
  assertStringIncludes(result.error, "JENKINS_URL");
});

Deno.test("fetchJenkinsBuildStatus - 401 surfaces status without token", async () => {
  const fetchFn = () =>
    Promise.resolve(new Response("Unauthorized", { status: 401 }));

  const result = await fetchJenkinsBuildStatus({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    fetchFn,
  });

  assert(!result.ok, "expected error");
  assertStringIncludes(result.error, "401");
  assert(
    !result.error.includes(TEST_TOKEN),
    "error must not contain the token",
  );
});

Deno.test("fetchJenkinsBuildStatus - non-JSON response is reported", async () => {
  const fetchFn = () =>
    Promise.resolve(
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

  const result = await fetchJenkinsBuildStatus({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    fetchFn,
  });

  assert(!result.ok);
  assertStringIncludes(result.error.toLowerCase(), "json");
  assert(!result.error.includes(TEST_TOKEN));
});

Deno.test("fetchJenkinsBuildStatus - network failure is reported without token", async () => {
  const fetchFn = () => Promise.reject(new Error("ECONNRESET"));

  const result = await fetchJenkinsBuildStatus({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    fetchFn,
  });

  assert(!result.ok);
  assertStringIncludes(result.error, "ECONNRESET");
  assert(!result.error.includes(TEST_TOKEN));
});

Deno.test("fetchJenkinsBuildStatus - null result coerced to UNKNOWN", async () => {
  const fetchFn = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          number: 7,
          result: null,
          url: "https://jenkins.example.com/job/MyJob/7/",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

  const result = await fetchJenkinsBuildStatus({
    readEnv,
    jobPath: "MyJob",
    build: 7,
    fetchFn,
  });

  assert(result.ok);
  assertEquals(result.value.result, "UNKNOWN");
});

Deno.test("fetchJenkinsBuildLog - happy path returns text", async () => {
  const fetchFn = (_url: string | URL | Request, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    assert(auth?.startsWith("Basic "));
    return Promise.resolve(
      new Response("hello build log\nline 2\n", { status: 200 }),
    );
  };

  const result = await fetchJenkinsBuildLog({
    readEnv,
    jobPath: "MyJob",
    build: "42",
    fetchFn,
  });

  assert(result.ok);
  assertStringIncludes(result.value, "hello build log");
});

Deno.test("fetchJenkinsBuildLog - oversized log is truncated from the start", async () => {
  // 4 KiB of "AAAA..." prefix, then a "TAIL-MARKER" at the very end.
  const head = "A".repeat(4096);
  const tailMarker = "TAIL-MARKER-END\n";
  const fullBody = head + tailMarker;

  const fetchFn = () =>
    Promise.resolve(new Response(fullBody, { status: 200 }));

  const maxBytes = 1024;
  const result = await fetchJenkinsBuildLog({
    readEnv,
    jobPath: "MyJob",
    build: 99,
    maxBytes,
    fetchFn,
  });

  assert(result.ok);
  // Tail must be preserved.
  assertStringIncludes(result.value, "TAIL-MARKER-END");
  // Truncation marker should appear at the beginning.
  assertStringIncludes(result.value, "truncated");
  // Original head should be gone.
  assert(
    !result.value.startsWith(head),
    "log must be truncated from the start",
  );
  // Size constraint: result must not exceed maxBytes plus the truncation
  // notice (which is short — keep an upper bound).
  const encoded = new TextEncoder().encode(result.value);
  assert(
    encoded.byteLength <= maxBytes + 256,
    `result ${encoded.byteLength} should be <= ${maxBytes + 256}`,
  );
});

Deno.test("fetchJenkinsBuildLog - 404 is surfaced without token", async () => {
  const fetchFn = () =>
    Promise.resolve(new Response("not found", { status: 404 }));

  const result = await fetchJenkinsBuildLog({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    fetchFn,
  });

  assert(!result.ok);
  assertStringIncludes(result.error, "404");
  assert(!result.error.includes(TEST_TOKEN));
});

Deno.test("fetchJenkinsBuildLog - missing env vars returns error", async () => {
  const result = await fetchJenkinsBuildLog({
    readEnv: envReader({
      JENKINS_URL: "https://jenkins.example.com",
      JENKINS_USER: "x",
    }),
    jobPath: "MyJob",
    build: 1,
  });
  assert(!result.ok);
  assertStringIncludes(result.error, "JENKINS_TOKEN");
});

Deno.test("fetchJenkinsBuildStatus - URL composition handles trailing slash", async () => {
  let capturedUrl = "";
  const fetchFn = (url: string | URL | Request) => {
    capturedUrl = typeof url === "string" ? url : url.toString();
    return Promise.resolve(
      new Response(
        JSON.stringify({
          number: 1,
          result: "SUCCESS",
          url: "x",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };

  await fetchJenkinsBuildStatus({
    readEnv: envReader({
      ...goodEnv,
      JENKINS_URL: "https://jenkins.example.com/",
    }),
    jobPath: "MyJob",
    build: 1,
    fetchFn,
  });

  // No double-slash between host and /job/.
  assert(
    !capturedUrl.includes("com//job/"),
    `URL must not contain double slash: ${capturedUrl}`,
  );
  assertStringIncludes(capturedUrl, "/job/MyJob/1/api/json");
});

// --- Issue #3710: bounded outbound fetches -------------------------------

/** A fetch that never resolves until its abort signal fires. */
function hangingFetch(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // No signal → hangs forever, which the test fails on.
    signal.addEventListener("abort", () => reject(signal.reason));
  });
}

Deno.test("fetchJenkinsBuildStatus - a hung server aborts on the timeout", async () => {
  const result = await fetchJenkinsBuildStatus({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    timeoutMs: 30,
    fetchFn: (_url, init) => hangingFetch(init),
  });

  assert(!result.ok, "a hung server must not resolve successfully");
  assertStringIncludes(result.error, "network");
  assert(!result.error.includes(TEST_TOKEN));
});

Deno.test("fetchJenkinsBuildLog - a hung server aborts on the timeout", async () => {
  const result = await fetchJenkinsBuildLog({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    timeoutMs: 30,
    fetchFn: (_url, init) => hangingFetch(init),
  });

  assert(!result.ok, "a hung server must not resolve successfully");
  assertStringIncludes(result.error, "network");
  assert(!result.error.includes(TEST_TOKEN));
});

Deno.test("fetchJenkinsBuildLog - an endless body is bounded to maxBytes", async () => {
  // Streams far more than the cap; the fetcher must never buffer it all.
  let emitted = 0;
  const chunk = new TextEncoder().encode("y".repeat(4096));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= 512) {
        controller.close();
        return;
      }
      emitted++;
      controller.enqueue(chunk);
    },
  });

  const result = await fetchJenkinsBuildLog({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    maxBytes: 1024,
    fetchFn: () => Promise.resolve(new Response(body, { status: 200 })),
  });

  assert(result.ok, "an oversized log is truncated, not an error");
  const bytes = new TextEncoder().encode(result.value);
  assertEquals(
    bytes.byteLength <= 1024,
    true,
    `expected <= 1024 bytes, got ${bytes.byteLength}`,
  );
  assertStringIncludes(result.value, "[log truncated");
  assertStringIncludes(result.value, `original ${512 * 4096} bytes`);
});

Deno.test("fetchJenkinsBuildStatus - an oversized status body fails loud", async () => {
  const huge = JSON.stringify({ number: 1, pad: "z".repeat(300 * 1024) });
  const result = await fetchJenkinsBuildStatus({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    fetchFn: () => Promise.resolve(new Response(huge, { status: 200 })),
  });

  assert(!result.ok, "an oversized status body must be rejected");
  assertStringIncludes(result.error, "exceeded");
});

// --- Issue #958: the credentials seam ------------------------------------

/**
 * Credentials that exist nowhere but this object. A fetcher that quietly
 * fell back to `Deno.env.get` could not produce this host or this user, so
 * these two tests fail loudly rather than passing on an ambient value.
 */
const injectedOnlyEnv = {
  JENKINS_URL: "https://only-injected-958.jenkins.invalid",
  JENKINS_USER: "seam-user-958",
  JENKINS_TOKEN: TEST_TOKEN,
};

Deno.test("fetchJenkinsBuildStatus - the injected lookup supplies URL and auth (Issue #958)", async () => {
  let capturedUrl = "";
  let capturedAuth = "";
  const result = await fetchJenkinsBuildStatus({
    readEnv: envReader(injectedOnlyEnv),
    jobPath: "MyJob",
    build: 5,
    fetchFn: (url, init) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string> | undefined)
        ?.["Authorization"] ??
        "";
      return Promise.resolve(
        new Response(
          JSON.stringify({ number: 5, result: "FAILURE", url: capturedUrl }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  });

  assert(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
  assertEquals(
    capturedUrl,
    "https://only-injected-958.jenkins.invalid/job/MyJob/5/api/json",
  );
  assertEquals(
    capturedAuth,
    `Basic ${btoa(`${injectedOnlyEnv.JENKINS_USER}:${TEST_TOKEN}`)}`,
  );
  // The token reaches the Authorization header and nothing else.
  assert(
    !JSON.stringify(result).includes(TEST_TOKEN),
    "token leaked into the returned build",
  );
});

Deno.test("fetchJenkinsBuildLog - the injected lookup supplies URL and auth (Issue #958)", async () => {
  let capturedUrl = "";
  let capturedAuth = "";
  const result = await fetchJenkinsBuildLog({
    readEnv: envReader(injectedOnlyEnv),
    jobPath: "MyJob",
    build: 5,
    fetchFn: (url, init) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string> | undefined)
        ?.["Authorization"] ??
        "";
      return Promise.resolve(new Response("console output", { status: 200 }));
    },
  });

  assert(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
  assertEquals(
    capturedUrl,
    "https://only-injected-958.jenkins.invalid/job/MyJob/5/consoleText",
  );
  assertEquals(
    capturedAuth,
    `Basic ${btoa(`${injectedOnlyEnv.JENKINS_USER}:${TEST_TOKEN}`)}`,
  );
  assert(!result.value.includes(TEST_TOKEN), "token leaked into the log text");
});
