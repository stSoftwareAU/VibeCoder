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

const ENV_KEYS = ["JENKINS_URL", "JENKINS_USER", "JENKINS_TOKEN"] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = Deno.env.get(key);
  }
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }
}

function setEnv(values: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }
}

const TEST_TOKEN = "super-secret-jenkins-token-XYZ123";

const goodEnv = {
  JENKINS_URL: "https://jenkins.example.com",
  JENKINS_USER: "ci-bot",
  JENKINS_TOKEN: TEST_TOKEN,
};

Deno.test("fetchJenkinsBuildStatus - happy path returns parsed build", async () => {
  const snapshot = snapshotEnv();
  setEnv(goodEnv);
  try {
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
  } finally {
    restoreEnv(snapshot);
  }
});

Deno.test("fetchJenkinsBuildStatus - missing env vars returns specific error", async () => {
  const snapshot = snapshotEnv();
  setEnv({});
  try {
    const result = await fetchJenkinsBuildStatus({
      jobPath: "MyJob",
      build: 1,
    });
    assert(!result.ok, "expected error");
    assertStringIncludes(result.error, "JENKINS_URL");
  } finally {
    restoreEnv(snapshot);
  }
});

Deno.test("fetchJenkinsBuildStatus - 401 surfaces status without token", async () => {
  const snapshot = snapshotEnv();
  setEnv(goodEnv);
  try {
    const fetchFn = () =>
      Promise.resolve(new Response("Unauthorized", { status: 401 }));

    const result = await fetchJenkinsBuildStatus({
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
  } finally {
    restoreEnv(snapshot);
  }
});

Deno.test("fetchJenkinsBuildStatus - non-JSON response is reported", async () => {
  const snapshot = snapshotEnv();
  setEnv(goodEnv);
  try {
    const fetchFn = () =>
      Promise.resolve(
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      );

    const result = await fetchJenkinsBuildStatus({
      jobPath: "MyJob",
      build: 1,
      fetchFn,
    });

    assert(!result.ok);
    assertStringIncludes(result.error.toLowerCase(), "json");
    assert(!result.error.includes(TEST_TOKEN));
  } finally {
    restoreEnv(snapshot);
  }
});

Deno.test("fetchJenkinsBuildStatus - network failure is reported without token", async () => {
  const snapshot = snapshotEnv();
  setEnv(goodEnv);
  try {
    const fetchFn = () => Promise.reject(new Error("ECONNRESET"));

    const result = await fetchJenkinsBuildStatus({
      jobPath: "MyJob",
      build: 1,
      fetchFn,
    });

    assert(!result.ok);
    assertStringIncludes(result.error, "ECONNRESET");
    assert(!result.error.includes(TEST_TOKEN));
  } finally {
    restoreEnv(snapshot);
  }
});

Deno.test("fetchJenkinsBuildStatus - null result coerced to UNKNOWN", async () => {
  const snapshot = snapshotEnv();
  setEnv(goodEnv);
  try {
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
      jobPath: "MyJob",
      build: 7,
      fetchFn,
    });

    assert(result.ok);
    assertEquals(result.value.result, "UNKNOWN");
  } finally {
    restoreEnv(snapshot);
  }
});

Deno.test("fetchJenkinsBuildLog - happy path returns text", async () => {
  const snapshot = snapshotEnv();
  setEnv(goodEnv);
  try {
    const fetchFn = (_url: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      assert(auth?.startsWith("Basic "));
      return Promise.resolve(
        new Response("hello build log\nline 2\n", { status: 200 }),
      );
    };

    const result = await fetchJenkinsBuildLog({
      jobPath: "MyJob",
      build: "42",
      fetchFn,
    });

    assert(result.ok);
    assertStringIncludes(result.value, "hello build log");
  } finally {
    restoreEnv(snapshot);
  }
});

Deno.test("fetchJenkinsBuildLog - oversized log is truncated from the start", async () => {
  const snapshot = snapshotEnv();
  setEnv(goodEnv);
  try {
    // 4 KiB of "AAAA..." prefix, then a "TAIL-MARKER" at the very end.
    const head = "A".repeat(4096);
    const tailMarker = "TAIL-MARKER-END\n";
    const fullBody = head + tailMarker;

    const fetchFn = () =>
      Promise.resolve(new Response(fullBody, { status: 200 }));

    const maxBytes = 1024;
    const result = await fetchJenkinsBuildLog({
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
  } finally {
    restoreEnv(snapshot);
  }
});

Deno.test("fetchJenkinsBuildLog - 404 is surfaced without token", async () => {
  const snapshot = snapshotEnv();
  setEnv(goodEnv);
  try {
    const fetchFn = () =>
      Promise.resolve(new Response("not found", { status: 404 }));

    const result = await fetchJenkinsBuildLog({
      jobPath: "MyJob",
      build: 1,
      fetchFn,
    });

    assert(!result.ok);
    assertStringIncludes(result.error, "404");
    assert(!result.error.includes(TEST_TOKEN));
  } finally {
    restoreEnv(snapshot);
  }
});

Deno.test("fetchJenkinsBuildLog - missing env vars returns error", async () => {
  const snapshot = snapshotEnv();
  setEnv({ JENKINS_URL: "https://jenkins.example.com", JENKINS_USER: "x" });
  try {
    const result = await fetchJenkinsBuildLog({
      jobPath: "MyJob",
      build: 1,
    });
    assert(!result.ok);
    assertStringIncludes(result.error, "JENKINS_TOKEN");
  } finally {
    restoreEnv(snapshot);
  }
});

Deno.test("fetchJenkinsBuildStatus - URL composition handles trailing slash", async () => {
  const snapshot = snapshotEnv();
  setEnv({ ...goodEnv, JENKINS_URL: "https://jenkins.example.com/" });
  try {
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
  } finally {
    restoreEnv(snapshot);
  }
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
  const snapshot = snapshotEnv();
  setEnv(goodEnv);
  try {
    const result = await fetchJenkinsBuildStatus({
      jobPath: "MyJob",
      build: 1,
      timeoutMs: 30,
      fetchFn: (_url, init) => hangingFetch(init),
    });

    assert(!result.ok, "a hung server must not resolve successfully");
    assertStringIncludes(result.error, "network");
    assert(!result.error.includes(TEST_TOKEN));
  } finally {
    restoreEnv(snapshot);
  }
});

Deno.test("fetchJenkinsBuildLog - a hung server aborts on the timeout", async () => {
  const snapshot = snapshotEnv();
  setEnv(goodEnv);
  try {
    const result = await fetchJenkinsBuildLog({
      jobPath: "MyJob",
      build: 1,
      timeoutMs: 30,
      fetchFn: (_url, init) => hangingFetch(init),
    });

    assert(!result.ok, "a hung server must not resolve successfully");
    assertStringIncludes(result.error, "network");
    assert(!result.error.includes(TEST_TOKEN));
  } finally {
    restoreEnv(snapshot);
  }
});

Deno.test("fetchJenkinsBuildLog - an endless body is bounded to maxBytes", async () => {
  const snapshot = snapshotEnv();
  setEnv(goodEnv);
  try {
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
  } finally {
    restoreEnv(snapshot);
  }
});

Deno.test("fetchJenkinsBuildStatus - an oversized status body fails loud", async () => {
  const snapshot = snapshotEnv();
  setEnv(goodEnv);
  try {
    const huge = JSON.stringify({ number: 1, pad: "z".repeat(300 * 1024) });
    const result = await fetchJenkinsBuildStatus({
      jobPath: "MyJob",
      build: 1,
      fetchFn: () => Promise.resolve(new Response(huge, { status: 200 })),
    });

    assert(!result.ok, "an oversized status body must be rejected");
    assertStringIncludes(result.error, "exceeded");
  } finally {
    restoreEnv(snapshot);
  }
});
