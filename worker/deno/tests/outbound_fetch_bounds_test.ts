/**
 * Outbound-fetch bounds for every HTTP client the worker owns (Issue #3710).
 *
 * A hung or hostile server used to wedge the worker: no request carried an
 * abort signal, and response bodies were buffered whole before any cap was
 * applied. These tests drive each client with (a) a stalled request and (b) an
 * endless response body, and assert the client aborts rather than waits and
 * cancels the stream rather than buffering it.
 *
 * The CI-client cases that lived here went with the Jenkins implementation
 * (Issue #986); the remaining clients need no credentials in the process, so
 * this suite mutates nothing and runs in the fast parallel pass.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { uploadToImgbb } from "../lib/imgbb_upload.ts";
import { fetchNpmTimeData } from "../lib/npm_package_age.ts";

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
