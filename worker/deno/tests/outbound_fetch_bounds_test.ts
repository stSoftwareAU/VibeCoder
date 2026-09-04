/**
 * Outbound-fetch bounds for every HTTP client the worker owns (Issue #3710).
 *
 * A hung or hostile server used to wedge the worker: no request carried an
 * abort signal, and response bodies were buffered whole before any cap was
 * applied. These tests drive each client with (a) a stalled request and (b) an
 * endless response body, and assert the client aborts rather than waits and
 * cancels the stream rather than buffering it.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  fetchJenkinsBuildLog,
  fetchJenkinsBuildStatus,
} from "../lib/jenkins_log_fetcher.ts";
import {
  checkJenkinsAccess,
  type EnvReader,
} from "../lib/jenkins_access_check.ts";
import { uploadToImgbb } from "../lib/imgbb_upload.ts";
import { fetchNpmTimeData } from "../lib/npm_package_age.ts";

/**
 * Jenkins credentials for the bounded-fetch probes. Issue #958: these are
 * handed to each client through its `readEnv` seam, so nothing here writes
 * a token-shaped value into the process environment.
 */
const jenkinsEnv = {
  JENKINS_URL: "https://jenkins.example.com",
  JENKINS_USER: "ci-bot",
  JENKINS_TOKEN: "not-a-real-token",
};

const readEnv: EnvReader = (name) =>
  jenkinsEnv[name as keyof typeof jenkinsEnv];

/** A response body that never ends, reporting cancellation. */
function endlessResponse(chunkBytes = 64 * 1024): {
  response: Response;
  cancelled: () => boolean;
  bytesEmitted: () => number;
} {
  let cancelled = false;
  let bytesEmitted = 0;
  const chunk = new TextEncoder().encode("x".repeat(chunkBytes));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (bytesEmitted > 512 * 1024 * 1024) {
        controller.error(new Error("stream was never cancelled"));
        return;
      }
      bytesEmitted += chunk.byteLength;
      controller.enqueue(chunk.slice());
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream, { status: 200 }),
    cancelled: () => cancelled,
    bytesEmitted: () => bytesEmitted,
  };
}

/** A fetch that behaves like a request whose timeout signal fired. */
function timingOutFetch(): (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response> {
  return (_url, init) => {
    assert(init?.signal instanceof AbortSignal, "request must carry a signal");
    return Promise.reject(
      new DOMException("The signal has been aborted", "TimeoutError"),
    );
  };
}

/** Capture the init a client passes to fetch. */
function capturingFetch(response: () => Response): {
  fetchFn: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  init: () => RequestInit | undefined;
} {
  let seen: RequestInit | undefined;
  return {
    fetchFn: (_url, init) => {
      seen = init;
      return Promise.resolve(response());
    },
    init: () => seen,
  };
}

// ── Jenkins status ──────────────────────────────────────────────────────

Deno.test("fetchJenkinsBuildStatus - request carries an abort signal", async () => {
  const cap = capturingFetch(() =>
    new Response(JSON.stringify({ number: 1, result: "SUCCESS" }))
  );
  const result = await fetchJenkinsBuildStatus({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    fetchFn: cap.fetchFn,
  });
  assert(result.ok);
  assert(
    cap.init()?.signal instanceof AbortSignal,
    "status request must be bounded by a signal",
  );
});

Deno.test("fetchJenkinsBuildStatus - a timed-out request fails loud", async () => {
  const result = await fetchJenkinsBuildStatus({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    fetchFn: timingOutFetch(),
    timeoutMs: 25,
  });
  assert(!result.ok);
  assertStringIncludes(result.error, "timed out after 25ms");
});

Deno.test("fetchJenkinsBuildStatus - an endless body is cancelled, not parsed", async () => {
  const endless = endlessResponse();
  const result = await fetchJenkinsBuildStatus({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    fetchFn: () => Promise.resolve(endless.response),
  });
  assert(!result.ok);
  assertStringIncludes(result.error, "exceeded");
  assert(endless.cancelled(), "the status body stream must be cancelled");
});

Deno.test("fetchJenkinsBuildStatus - an error body is discarded unread", async () => {
  const endless = endlessResponse();
  const errorResponse = new Response(endless.response.body, { status: 500 });
  const result = await fetchJenkinsBuildStatus({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    fetchFn: () => Promise.resolve(errorResponse),
  });
  assert(!result.ok);
  assert(endless.cancelled(), "a 5xx body must be cancelled, not buffered");
  // At most the stream's own initial pull; the client never reads a chunk.
  assert(
    endless.bytesEmitted() <= 64 * 1024,
    `buffered ${endless.bytesEmitted()} bytes of a 5xx body`,
  );
});

// ── Jenkins console log ─────────────────────────────────────────────────

Deno.test("fetchJenkinsBuildLog - request carries an abort signal", async () => {
  const cap = capturingFetch(() => new Response("log body"));
  const result = await fetchJenkinsBuildLog({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    fetchFn: cap.fetchFn,
  });
  assert(result.ok);
  assert(
    cap.init()?.signal instanceof AbortSignal,
    "log request must be bounded by a signal",
  );
});

Deno.test("fetchJenkinsBuildLog - a timed-out request fails loud", async () => {
  const result = await fetchJenkinsBuildLog({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    fetchFn: timingOutFetch(),
    timeoutMs: 40,
  });
  assert(!result.ok);
  assertStringIncludes(result.error, "timed out after 40ms");
});

Deno.test("fetchJenkinsBuildLog - an endless log stream is cancelled at the hard limit", async () => {
  const endless = endlessResponse(4096);
  const maxStreamBytes = 128 * 1024;
  const result = await fetchJenkinsBuildLog({
    readEnv,
    jobPath: "MyJob",
    build: 1,
    maxBytes: 8 * 1024,
    maxStreamBytes,
    fetchFn: () => Promise.resolve(endless.response),
  });
  assert(result.ok);
  assertStringIncludes(result.value, "truncated");
  const size = new TextEncoder().encode(result.value).byteLength;
  assert(size <= 8 * 1024, `returned ${size} bytes, expected <= 8192`);
  assert(endless.cancelled(), "the log stream must be cancelled");
  assert(
    endless.bytesEmitted() <= maxStreamBytes + 4096,
    `read ${endless.bytesEmitted()} bytes past the ${maxStreamBytes} ceiling`,
  );
});

// ── Jenkins preflight ───────────────────────────────────────────────────

Deno.test("checkJenkinsAccess - probe carries an abort signal", async () => {
  const cap = capturingFetch(() => new Response("{}", { status: 200 }));
  const diagnosis = await checkJenkinsAccess({
    jobPath: "MyJob",
    fetchFn: cap.fetchFn,
    readEnv,
  });
  assertEquals(diagnosis.ok, true);
  assert(
    cap.init()?.signal instanceof AbortSignal,
    "preflight probe must be bounded by a signal",
  );
});

Deno.test("checkJenkinsAccess - a timed-out probe is a network diagnosis", async () => {
  const diagnosis = await checkJenkinsAccess({
    jobPath: "MyJob",
    fetchFn: timingOutFetch(),
    timeoutMs: 15,
    readEnv,
  });
  assertEquals(diagnosis.ok, false);
  assertEquals(diagnosis.status, "network-error");
  assertStringIncludes(diagnosis.summary, "timed out after 15ms");
});

Deno.test("checkJenkinsAccess - the probe body is discarded unread", async () => {
  const endless = endlessResponse();
  const diagnosis = await checkJenkinsAccess({
    jobPath: "MyJob",
    fetchFn: () =>
      Promise.resolve(new Response(endless.response.body, { status: 403 })),
    readEnv,
  });
  assertEquals(diagnosis.ok, false);
  assert(endless.cancelled(), "the probe body must be cancelled, not buffered");
  // At most the stream's own initial pull; the client never reads a chunk.
  assert(
    endless.bytesEmitted() <= 64 * 1024,
    `buffered ${endless.bytesEmitted()} bytes of a probe body`,
  );
});

// ── ImgBB ───────────────────────────────────────────────────────────────

Deno.test("uploadToImgbb - upload carries an abort signal", async () => {
  const cap = capturingFetch(() =>
    new Response(
      JSON.stringify({
        success: true,
        data: { display_url: "https://x/y.png" },
      }),
    )
  );
  const result = await uploadToImgbb({
    imageBase64: "Zm9v",
    apiKey: "key",
    fetchFn: cap.fetchFn,
  });
  assert(result.ok);
  assert(
    cap.init()?.signal instanceof AbortSignal,
    "upload must be bounded by a signal",
  );
});

Deno.test("uploadToImgbb - a timed-out upload fails loud", async () => {
  const result = await uploadToImgbb({
    imageBase64: "Zm9v",
    apiKey: "key",
    fetchFn: timingOutFetch(),
    timeoutMs: 30,
  });
  assert(!result.ok);
  assertStringIncludes(result.error.message, "timed out after 30ms");
});

Deno.test("uploadToImgbb - an endless response body is cancelled, not parsed", async () => {
  const endless = endlessResponse();
  const result = await uploadToImgbb({
    imageBase64: "Zm9v",
    apiKey: "key",
    fetchFn: () => Promise.resolve(endless.response),
  });
  assert(!result.ok);
  assertStringIncludes(result.error.message, "exceeded");
  assert(endless.cancelled(), "the ImgBB body stream must be cancelled");
});

// ── npm registry ────────────────────────────────────────────────────────

Deno.test("fetchNpmTimeData - lookup carries an abort signal", async () => {
  const cap = capturingFetch(() =>
    new Response(JSON.stringify({ time: { "1.0.0": "2026-01-01T00:00:00Z" } }))
  );
  const time = await fetchNpmTimeData("playwright", { fetchFn: cap.fetchFn });
  assertEquals(time["1.0.0"], "2026-01-01T00:00:00Z");
  assert(
    cap.init()?.signal instanceof AbortSignal,
    "registry lookup must be bounded by a signal",
  );
});

Deno.test("fetchNpmTimeData - a timed-out lookup rejects with the timeout named", async () => {
  await assertRejects(
    () =>
      fetchNpmTimeData("playwright", {
        fetchFn: timingOutFetch(),
        timeoutMs: 50,
      }),
    Error,
    "timed out after 50ms",
  );
});

Deno.test("fetchNpmTimeData - an endless packument is refused, not buffered", async () => {
  const endless = endlessResponse();
  await assertRejects(
    () =>
      fetchNpmTimeData("playwright", {
        fetchFn: () => Promise.resolve(endless.response),
        maxBytes: 256 * 1024,
      }),
    Error,
    "exceeded",
  );
  assert(endless.cancelled(), "the registry stream must be cancelled");
});
