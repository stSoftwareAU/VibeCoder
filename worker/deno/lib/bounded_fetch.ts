/**
 * Bounded outbound HTTP helpers (Issue #3710).
 *
 * Every outbound `fetch` the worker makes must be bounded in both time and
 * memory. Without a timeout a hung or hostile server wedges the worker
 * indefinitely; without a streaming size cap the whole body is buffered
 * (and then re-encoded, roughly doubling peak memory) before any cap is
 * applied. This module supplies the two primitives every call site needs:
 *
 * - {@link withRequestTimeout} — attach an `AbortSignal.timeout(...)`.
 * - {@link readTextBounded} / {@link readTailBounded} — read the body while
 *   streaming, cancelling the stream rather than buffering then truncating.
 *
 * All helpers fail loud: exceeding a cap is an error Result, never a silent
 * truncation reported as success.
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */

import type { Result } from "../types.ts";

/** Default timeout applied to a single outbound request (30 seconds). */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Default cap on a fully-buffered response body (1 MiB). */
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Default ceiling on the bytes a tail read will pull off the wire (64 MiB).
 *
 * A tail read retains only `maxBytes`, so memory is safe however long the
 * body runs — but an endless body would still stream forever. This is the
 * hard stop: past it the stream is cancelled and the read reports that it
 * was cut short.
 */
export const DEFAULT_MAX_STREAM_BYTES = 64 * 1024 * 1024;

/** Outcome of a tail-preserving bounded read. */
export interface BoundedTailRead {
  /** The last `maxBytes` bytes of the body (fewer if the body was shorter). */
  tail: Uint8Array;
  /** Total bytes streamed from the server, including bytes since dropped. */
  totalBytes: number;
  /** True when the stream hit the ceiling and was cancelled mid-body. */
  streamCapped: boolean;
}

/**
 * Describe a rejected `fetch`, naming the timeout when the request's abort
 * signal fired.
 *
 * `AbortSignal.timeout` rejects with a bare "signal has been aborted"
 * DOMException, which tells an operator nothing about which bound was
 * breached. Naming the timeout makes the failure actionable (Issue #3234).
 */
export function describeFetchFailure(
  error: unknown,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return `request timed out after ${timeoutMs}ms`;
  }
  return describe(error);
}

/**
 * Return `init` with an abort signal that fires after `timeoutMs`.
 *
 * Any signal already present on `init` is replaced — no worker call site
 * supplies one, and silently ignoring the timeout would be worse.
 *
 * @throws RangeError when `timeoutMs` is not a positive finite number.
 */
export function withRequestTimeout(
  init: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): RequestInit {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `Request timeout must be a positive number of milliseconds; got ${timeoutMs}`,
    );
  }
  return { ...init, signal: AbortSignal.timeout(timeoutMs) };
}

/** Describe a thrown value without leaking a stack trace. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Join `chunks` (totalling `size` bytes) into one buffer. */
function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Read a response body as UTF-8 text, cancelling the stream the moment it
 * exceeds `maxBytes`.
 *
 * Peak memory is bounded by `maxBytes` plus one network chunk. An oversized
 * body is an error, not a truncated success.
 */
export async function readTextBounded(
  response: Response,
  maxBytes: number = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<Result<string, string>> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return {
      ok: false,
      error: `maxBytes must be a positive number; got ${maxBytes}`,
    };
  }

  const body = response.body;
  if (!body) return { ok: true, value: "" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return {
          ok: false,
          error: `Response body exceeded the ${maxBytes}-byte limit`,
        };
      }
      chunks.push(value);
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: `Failed to read response body: ${describe(error)}`,
    };
  } finally {
    reader.releaseLock();
  }

  return { ok: true, value: new TextDecoder().decode(concat(chunks, total)) };
}

/**
 * Read a response body while retaining only its last `maxBytes` bytes.
 *
 * Used for console logs, where the tail carries the failure. Peak memory is
 * bounded by `maxBytes` plus one network chunk however large the body grows,
 * so an oversized log costs a truncation notice rather than the worker's
 * heap. Total elapsed time is bounded by the request's abort signal.
 */
export async function readTailBounded(
  response: Response,
  maxBytes: number,
  maxStreamBytes: number = DEFAULT_MAX_STREAM_BYTES,
): Promise<Result<BoundedTailRead, string>> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return {
      ok: false,
      error: `maxBytes must be a positive number; got ${maxBytes}`,
    };
  }
  if (!Number.isFinite(maxStreamBytes) || maxStreamBytes <= 0) {
    return {
      ok: false,
      error: `maxStreamBytes must be a positive number; got ${maxStreamBytes}`,
    };
  }

  const body = response.body;
  if (!body) {
    return {
      ok: true,
      value: { tail: new Uint8Array(0), totalBytes: 0, streamCapped: false },
    };
  }

  const reader = body.getReader();
  const window: Uint8Array[] = [];
  let buffered = 0;
  let total = 0;
  let streamCapped = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;

      // A single chunk larger than the cap contributes only its own tail.
      const chunk = value.byteLength > maxBytes
        ? value.subarray(value.byteLength - maxBytes)
        : value;
      window.push(chunk);
      buffered += chunk.byteLength;

      // Drop leading chunks that are wholly outside the retained window.
      while (
        window.length > 1 && buffered - window[0]!.byteLength >= maxBytes
      ) {
        buffered -= window.shift()!.byteLength;
      }

      // Hard stop: an endless body would otherwise stream forever, since the
      // tail window keeps memory flat and never trips a size error.
      if (total >= maxStreamBytes) {
        streamCapped = true;
        await reader.cancel();
        break;
      }
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: `Failed to read response body: ${describe(error)}`,
    };
  } finally {
    reader.releaseLock();
  }

  const joined = concat(window, buffered);
  const tail = joined.byteLength > maxBytes
    ? joined.subarray(joined.byteLength - maxBytes)
    : joined;
  return { ok: true, value: { tail, totalBytes: total, streamCapped } };
}

/**
 * Cancel a response body without buffering it.
 *
 * Used on error paths where the body is never read: cancelling frees the
 * connection without giving a hostile server a place to stream megabytes.
 */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection is already gone; the status code is the signal we need.
  }
}
