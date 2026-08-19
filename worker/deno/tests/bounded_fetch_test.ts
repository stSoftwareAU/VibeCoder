/**
 * Tests for the bounded outbound-fetch helpers (Issue #3710).
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  describeFetchFailure,
  discardBody,
  readTailBounded,
  readTextBounded,
  withRequestTimeout,
} from "../lib/bounded_fetch.ts";

/** Build a Response whose body streams `chunks` one at a time. */
function streamingResponse(chunks: Uint8Array[]): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]);
    },
  });
  return new Response(stream);
}

/** A body that never ends — models a hung or hostile server. */
function endlessResponse(): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  const chunk = new TextEncoder().encode("x".repeat(1024));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(stream), cancelled: () => cancelled };
}

Deno.test("withRequestTimeout - attaches an abort signal that fires", async () => {
  const init = withRequestTimeout({ method: "GET" }, 20);
  assertEquals(init.method, "GET");
  assert(init.signal instanceof AbortSignal);
  assertEquals(init.signal.aborted, false);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEquals(init.signal.aborted, true);
});

Deno.test("withRequestTimeout - defaults to DEFAULT_FETCH_TIMEOUT_MS", () => {
  assert(DEFAULT_FETCH_TIMEOUT_MS > 0);
  const init = withRequestTimeout({ method: "POST" });
  assert(init.signal instanceof AbortSignal);
  assertEquals(init.signal.aborted, false);
});

Deno.test("withRequestTimeout - rejects a non-positive timeout", () => {
  assertThrows(() => withRequestTimeout({}, 0), RangeError);
  assertThrows(() => withRequestTimeout({}, -1), RangeError);
  assertThrows(() => withRequestTimeout({}, Number.NaN), RangeError);
});

Deno.test("readTextBounded - returns a body under the cap", async () => {
  const result = await readTextBounded(new Response("hello world"), 1024);
  assert(result.ok);
  assertEquals(result.value, "hello world");
});

Deno.test("readTextBounded - empty body reads as an empty string", async () => {
  const result = await readTextBounded(new Response(null), 1024);
  assert(result.ok);
  assertEquals(result.value, "");
});

Deno.test("readTextBounded - fails loud once the cap is exceeded", async () => {
  const result = await readTextBounded(new Response("a".repeat(200)), 100);
  assert(!result.ok);
  assert(
    result.error.includes("100"),
    `expected the limit in the error, got: ${result.error}`,
  );
});

Deno.test("readTextBounded - cancels an endless body instead of buffering", async () => {
  const { response, cancelled } = endlessResponse();
  const result = await readTextBounded(response, 4096);
  assert(!result.ok);
  assert(cancelled(), "expected the stream to be cancelled at the cap");
});

Deno.test("readTextBounded - rejects a non-positive cap", async () => {
  const result = await readTextBounded(new Response("x"), 0);
  assert(!result.ok);
});

Deno.test("readTailBounded - keeps the whole body when under the cap", async () => {
  const result = await readTailBounded(new Response("short"), 1024);
  assert(result.ok);
  assertEquals(new TextDecoder().decode(result.value.tail), "short");
  assertEquals(result.value.totalBytes, 5);
});

Deno.test("readTailBounded - keeps only the tail of an oversized body", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode("AAAA"),
    encoder.encode("BBBB"),
    encoder.encode("CCCC"),
    encoder.encode("DDDD"),
  ];
  const result = await readTailBounded(streamingResponse(chunks), 6);
  assert(result.ok);
  assertEquals(result.value.totalBytes, 16);
  // Never buffers more than the cap, and the retained bytes are the tail.
  assert(result.value.tail.byteLength <= 6);
  const text = new TextDecoder().decode(result.value.tail);
  assert(
    "AAAABBBBCCCCDDDD".endsWith(text),
    `expected a tail slice, got: ${text}`,
  );
  assertEquals(text.includes("A"), false);
});

Deno.test("readTailBounded - bounds a single oversized chunk", async () => {
  const encoder = new TextEncoder();
  const result = await readTailBounded(
    streamingResponse([encoder.encode("0123456789")]),
    4,
  );
  assert(result.ok);
  assertEquals(new TextDecoder().decode(result.value.tail), "6789");
  assertEquals(result.value.totalBytes, 10);
});

Deno.test("readTailBounded - rejects a non-positive cap", async () => {
  const result = await readTailBounded(new Response("x"), -5);
  assert(!result.ok);
});

Deno.test("discardBody - cancels the body without buffering it", async () => {
  const { response, cancelled } = endlessResponse();
  await discardBody(response);
  assert(cancelled(), "expected discardBody to cancel the stream");
});

Deno.test("discardBody - tolerates a null body", async () => {
  await discardBody(new Response(null));
});

Deno.test("readTailBounded - cancels an endless body at the stream ceiling", async () => {
  const { response, cancelled } = endlessResponse();
  const result = await readTailBounded(response, 256, 8 * 1024);
  assert(result.ok);
  assert(result.value.streamCapped, "expected the stream ceiling to trip");
  assertEquals(result.value.tail.byteLength, 256);
  assert(cancelled(), "expected the capped stream to be cancelled");
});

Deno.test("readTailBounded - rejects a non-positive stream ceiling", async () => {
  const result = await readTailBounded(new Response("x"), 8, 0);
  assert(!result.ok);
  assertStringIncludes(result.error, "maxStreamBytes");
});

Deno.test("describeFetchFailure - names the timeout for an aborted request", () => {
  const timedOut = new DOMException(
    "The signal has been aborted",
    "TimeoutError",
  );
  assertEquals(
    describeFetchFailure(timedOut, 250),
    "request timed out after 250ms",
  );
  assertEquals(
    describeFetchFailure(new DOMException("aborted", "AbortError"), 10),
    "request timed out after 10ms",
  );
});

Deno.test("describeFetchFailure - passes other failures through", () => {
  assertEquals(
    describeFetchFailure(new TypeError("connection refused"), 250),
    "connection refused",
  );
  assertEquals(describeFetchFailure("odd", 250), "odd");
});
