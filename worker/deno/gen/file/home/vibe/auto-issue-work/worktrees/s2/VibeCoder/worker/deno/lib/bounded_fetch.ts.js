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
 */ /** Default timeout applied to a single outbound request (30 seconds). */ export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
/** Default cap on a fully-buffered response body (1 MiB). */ export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
/**
 * Default ceiling on the bytes a tail read will pull off the wire (64 MiB).
 *
 * A tail read retains only `maxBytes`, so memory is safe however long the
 * body runs — but an endless body would still stream forever. This is the
 * hard stop: past it the stream is cancelled and the read reports that it
 * was cut short.
 */ export const DEFAULT_MAX_STREAM_BYTES = 64 * 1024 * 1024;
/**
 * Describe a rejected `fetch`, naming the timeout when the request's abort
 * signal fired.
 *
 * `AbortSignal.timeout` rejects with a bare "signal has been aborted"
 * DOMException, which tells an operator nothing about which bound was
 * breached. Naming the timeout makes the failure actionable (Issue #3234).
 */ export function describeFetchFailure(error, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
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
 */ export function withRequestTimeout(init, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`Request timeout must be a positive number of milliseconds; got ${timeoutMs}`);
  }
  return {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  };
}
/** Describe a thrown value without leaking a stack trace. */ function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
/** Join `chunks` (totalling `size` bytes) into one buffer. */ function concat(chunks, size) {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks){
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
 */ export async function readTextBounded(response, maxBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return {
      ok: false,
      error: `maxBytes must be a positive number; got ${maxBytes}`
    };
  }
  const body = response.body;
  if (!body) return {
    ok: true,
    value: ""
  };
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while(true){
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return {
          ok: false,
          error: `Response body exceeded the ${maxBytes}-byte limit`
        };
      }
      chunks.push(value);
    }
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read response body: ${describe(error)}`
    };
  } finally{
    reader.releaseLock();
  }
  return {
    ok: true,
    value: new TextDecoder().decode(concat(chunks, total))
  };
}
/**
 * Read a response body while retaining only its last `maxBytes` bytes.
 *
 * Used for console logs, where the tail carries the failure. Peak memory is
 * bounded by `maxBytes` plus one network chunk however large the body grows,
 * so an oversized log costs a truncation notice rather than the worker's
 * heap. Total elapsed time is bounded by the request's abort signal.
 */ export async function readTailBounded(response, maxBytes, maxStreamBytes = DEFAULT_MAX_STREAM_BYTES) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return {
      ok: false,
      error: `maxBytes must be a positive number; got ${maxBytes}`
    };
  }
  if (!Number.isFinite(maxStreamBytes) || maxStreamBytes <= 0) {
    return {
      ok: false,
      error: `maxStreamBytes must be a positive number; got ${maxStreamBytes}`
    };
  }
  const body = response.body;
  if (!body) {
    return {
      ok: true,
      value: {
        tail: new Uint8Array(0),
        totalBytes: 0,
        streamCapped: false
      }
    };
  }
  const reader = body.getReader();
  const window = [];
  let buffered = 0;
  let total = 0;
  let streamCapped = false;
  try {
    while(true){
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      // A single chunk larger than the cap contributes only its own tail.
      const chunk = value.byteLength > maxBytes ? value.subarray(value.byteLength - maxBytes) : value;
      window.push(chunk);
      buffered += chunk.byteLength;
      // Drop leading chunks that are wholly outside the retained window.
      while(window.length > 1 && buffered - window[0].byteLength >= maxBytes){
        buffered -= window.shift().byteLength;
      }
      // Hard stop: an endless body would otherwise stream forever, since the
      // tail window keeps memory flat and never trips a size error.
      if (total >= maxStreamBytes) {
        streamCapped = true;
        await reader.cancel();
        break;
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read response body: ${describe(error)}`
    };
  } finally{
    reader.releaseLock();
  }
  const joined = concat(window, buffered);
  const tail = joined.byteLength > maxBytes ? joined.subarray(joined.byteLength - maxBytes) : joined;
  return {
    ok: true,
    value: {
      tail,
      totalBytes: total,
      streamCapped
    }
  };
}
/**
 * Cancel a response body without buffering it.
 *
 * Used on error paths where the body is never read: cancelling frees the
 * connection without giving a hostile server a place to stream megabytes.
 */ export async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch  {
  // The connection is already gone; the status code is the signal we need.
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ib3VuZGVkX2ZldGNoLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQm91bmRlZCBvdXRib3VuZCBIVFRQIGhlbHBlcnMgKElzc3VlICMzNzEwKS5cbiAqXG4gKiBFdmVyeSBvdXRib3VuZCBgZmV0Y2hgIHRoZSB3b3JrZXIgbWFrZXMgbXVzdCBiZSBib3VuZGVkIGluIGJvdGggdGltZSBhbmRcbiAqIG1lbW9yeS4gV2l0aG91dCBhIHRpbWVvdXQgYSBodW5nIG9yIGhvc3RpbGUgc2VydmVyIHdlZGdlcyB0aGUgd29ya2VyXG4gKiBpbmRlZmluaXRlbHk7IHdpdGhvdXQgYSBzdHJlYW1pbmcgc2l6ZSBjYXAgdGhlIHdob2xlIGJvZHkgaXMgYnVmZmVyZWRcbiAqIChhbmQgdGhlbiByZS1lbmNvZGVkLCByb3VnaGx5IGRvdWJsaW5nIHBlYWsgbWVtb3J5KSBiZWZvcmUgYW55IGNhcCBpc1xuICogYXBwbGllZC4gVGhpcyBtb2R1bGUgc3VwcGxpZXMgdGhlIHR3byBwcmltaXRpdmVzIGV2ZXJ5IGNhbGwgc2l0ZSBuZWVkczpcbiAqXG4gKiAtIHtAbGluayB3aXRoUmVxdWVzdFRpbWVvdXR9IOKAlCBhdHRhY2ggYW4gYEFib3J0U2lnbmFsLnRpbWVvdXQoLi4uKWAuXG4gKiAtIHtAbGluayByZWFkVGV4dEJvdW5kZWR9IC8ge0BsaW5rIHJlYWRUYWlsQm91bmRlZH0g4oCUIHJlYWQgdGhlIGJvZHkgd2hpbGVcbiAqICAgc3RyZWFtaW5nLCBjYW5jZWxsaW5nIHRoZSBzdHJlYW0gcmF0aGVyIHRoYW4gYnVmZmVyaW5nIHRoZW4gdHJ1bmNhdGluZy5cbiAqXG4gKiBBbGwgaGVscGVycyBmYWlsIGxvdWQ6IGV4Y2VlZGluZyBhIGNhcCBpcyBhbiBlcnJvciBSZXN1bHQsIG5ldmVyIGEgc2lsZW50XG4gKiB0cnVuY2F0aW9uIHJlcG9ydGVkIGFzIHN1Y2Nlc3MuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzYXRpb24sIGNvbG91cikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcblxuLyoqIERlZmF1bHQgdGltZW91dCBhcHBsaWVkIHRvIGEgc2luZ2xlIG91dGJvdW5kIHJlcXVlc3QgKDMwIHNlY29uZHMpLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfRkVUQ0hfVElNRU9VVF9NUyA9IDMwXzAwMDtcblxuLyoqIERlZmF1bHQgY2FwIG9uIGEgZnVsbHktYnVmZmVyZWQgcmVzcG9uc2UgYm9keSAoMSBNaUIpLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfTUFYX1JFU1BPTlNFX0JZVEVTID0gMTAyNCAqIDEwMjQ7XG5cbi8qKlxuICogRGVmYXVsdCBjZWlsaW5nIG9uIHRoZSBieXRlcyBhIHRhaWwgcmVhZCB3aWxsIHB1bGwgb2ZmIHRoZSB3aXJlICg2NCBNaUIpLlxuICpcbiAqIEEgdGFpbCByZWFkIHJldGFpbnMgb25seSBgbWF4Qnl0ZXNgLCBzbyBtZW1vcnkgaXMgc2FmZSBob3dldmVyIGxvbmcgdGhlXG4gKiBib2R5IHJ1bnMg4oCUIGJ1dCBhbiBlbmRsZXNzIGJvZHkgd291bGQgc3RpbGwgc3RyZWFtIGZvcmV2ZXIuIFRoaXMgaXMgdGhlXG4gKiBoYXJkIHN0b3A6IHBhc3QgaXQgdGhlIHN0cmVhbSBpcyBjYW5jZWxsZWQgYW5kIHRoZSByZWFkIHJlcG9ydHMgdGhhdCBpdFxuICogd2FzIGN1dCBzaG9ydC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfTUFYX1NUUkVBTV9CWVRFUyA9IDY0ICogMTAyNCAqIDEwMjQ7XG5cbi8qKiBPdXRjb21lIG9mIGEgdGFpbC1wcmVzZXJ2aW5nIGJvdW5kZWQgcmVhZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQm91bmRlZFRhaWxSZWFkIHtcbiAgLyoqIFRoZSBsYXN0IGBtYXhCeXRlc2AgYnl0ZXMgb2YgdGhlIGJvZHkgKGZld2VyIGlmIHRoZSBib2R5IHdhcyBzaG9ydGVyKS4gKi9cbiAgdGFpbDogVWludDhBcnJheTtcbiAgLyoqIFRvdGFsIGJ5dGVzIHN0cmVhbWVkIGZyb20gdGhlIHNlcnZlciwgaW5jbHVkaW5nIGJ5dGVzIHNpbmNlIGRyb3BwZWQuICovXG4gIHRvdGFsQnl0ZXM6IG51bWJlcjtcbiAgLyoqIFRydWUgd2hlbiB0aGUgc3RyZWFtIGhpdCB0aGUgY2VpbGluZyBhbmQgd2FzIGNhbmNlbGxlZCBtaWQtYm9keS4gKi9cbiAgc3RyZWFtQ2FwcGVkOiBib29sZWFuO1xufVxuXG4vKipcbiAqIERlc2NyaWJlIGEgcmVqZWN0ZWQgYGZldGNoYCwgbmFtaW5nIHRoZSB0aW1lb3V0IHdoZW4gdGhlIHJlcXVlc3QncyBhYm9ydFxuICogc2lnbmFsIGZpcmVkLlxuICpcbiAqIGBBYm9ydFNpZ25hbC50aW1lb3V0YCByZWplY3RzIHdpdGggYSBiYXJlIFwic2lnbmFsIGhhcyBiZWVuIGFib3J0ZWRcIlxuICogRE9NRXhjZXB0aW9uLCB3aGljaCB0ZWxscyBhbiBvcGVyYXRvciBub3RoaW5nIGFib3V0IHdoaWNoIGJvdW5kIHdhc1xuICogYnJlYWNoZWQuIE5hbWluZyB0aGUgdGltZW91dCBtYWtlcyB0aGUgZmFpbHVyZSBhY3Rpb25hYmxlIChJc3N1ZSAjMzIzNCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNjcmliZUZldGNoRmFpbHVyZShcbiAgZXJyb3I6IHVua25vd24sXG4gIHRpbWVvdXRNczogbnVtYmVyID0gREVGQVVMVF9GRVRDSF9USU1FT1VUX01TLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgbmFtZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5uYW1lIDogXCJcIjtcbiAgaWYgKG5hbWUgPT09IFwiVGltZW91dEVycm9yXCIgfHwgbmFtZSA9PT0gXCJBYm9ydEVycm9yXCIpIHtcbiAgICByZXR1cm4gYHJlcXVlc3QgdGltZWQgb3V0IGFmdGVyICR7dGltZW91dE1zfW1zYDtcbiAgfVxuICByZXR1cm4gZGVzY3JpYmUoZXJyb3IpO1xufVxuXG4vKipcbiAqIFJldHVybiBgaW5pdGAgd2l0aCBhbiBhYm9ydCBzaWduYWwgdGhhdCBmaXJlcyBhZnRlciBgdGltZW91dE1zYC5cbiAqXG4gKiBBbnkgc2lnbmFsIGFscmVhZHkgcHJlc2VudCBvbiBgaW5pdGAgaXMgcmVwbGFjZWQg4oCUIG5vIHdvcmtlciBjYWxsIHNpdGVcbiAqIHN1cHBsaWVzIG9uZSwgYW5kIHNpbGVudGx5IGlnbm9yaW5nIHRoZSB0aW1lb3V0IHdvdWxkIGJlIHdvcnNlLlxuICpcbiAqIEB0aHJvd3MgUmFuZ2VFcnJvciB3aGVuIGB0aW1lb3V0TXNgIGlzIG5vdCBhIHBvc2l0aXZlIGZpbml0ZSBudW1iZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3aXRoUmVxdWVzdFRpbWVvdXQoXG4gIGluaXQ6IFJlcXVlc3RJbml0LFxuICB0aW1lb3V0TXM6IG51bWJlciA9IERFRkFVTFRfRkVUQ0hfVElNRU9VVF9NUyxcbik6IFJlcXVlc3RJbml0IHtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUodGltZW91dE1zKSB8fCB0aW1lb3V0TXMgPD0gMCkge1xuICAgIHRocm93IG5ldyBSYW5nZUVycm9yKFxuICAgICAgYFJlcXVlc3QgdGltZW91dCBtdXN0IGJlIGEgcG9zaXRpdmUgbnVtYmVyIG9mIG1pbGxpc2Vjb25kczsgZ290ICR7dGltZW91dE1zfWAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4geyAuLi5pbml0LCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9O1xufVxuXG4vKiogRGVzY3JpYmUgYSB0aHJvd24gdmFsdWUgd2l0aG91dCBsZWFraW5nIGEgc3RhY2sgdHJhY2UuICovXG5mdW5jdGlvbiBkZXNjcmliZShlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG59XG5cbi8qKiBKb2luIGBjaHVua3NgICh0b3RhbGxpbmcgYHNpemVgIGJ5dGVzKSBpbnRvIG9uZSBidWZmZXIuICovXG5mdW5jdGlvbiBjb25jYXQoY2h1bmtzOiBVaW50OEFycmF5W10sIHNpemU6IG51bWJlcik6IFVpbnQ4QXJyYXkge1xuICBjb25zdCBvdXQgPSBuZXcgVWludDhBcnJheShzaXplKTtcbiAgbGV0IG9mZnNldCA9IDA7XG4gIGZvciAoY29uc3QgY2h1bmsgb2YgY2h1bmtzKSB7XG4gICAgb3V0LnNldChjaHVuaywgb2Zmc2V0KTtcbiAgICBvZmZzZXQgKz0gY2h1bmsuYnl0ZUxlbmd0aDtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKipcbiAqIFJlYWQgYSByZXNwb25zZSBib2R5IGFzIFVURi04IHRleHQsIGNhbmNlbGxpbmcgdGhlIHN0cmVhbSB0aGUgbW9tZW50IGl0XG4gKiBleGNlZWRzIGBtYXhCeXRlc2AuXG4gKlxuICogUGVhayBtZW1vcnkgaXMgYm91bmRlZCBieSBgbWF4Qnl0ZXNgIHBsdXMgb25lIG5ldHdvcmsgY2h1bmsuIEFuIG92ZXJzaXplZFxuICogYm9keSBpcyBhbiBlcnJvciwgbm90IGEgdHJ1bmNhdGVkIHN1Y2Nlc3MuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkVGV4dEJvdW5kZWQoXG4gIHJlc3BvbnNlOiBSZXNwb25zZSxcbiAgbWF4Qnl0ZXM6IG51bWJlciA9IERFRkFVTFRfTUFYX1JFU1BPTlNFX0JZVEVTLFxuKTogUHJvbWlzZTxSZXN1bHQ8c3RyaW5nLCBzdHJpbmc+PiB7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKG1heEJ5dGVzKSB8fCBtYXhCeXRlcyA8PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBgbWF4Qnl0ZXMgbXVzdCBiZSBhIHBvc2l0aXZlIG51bWJlcjsgZ290ICR7bWF4Qnl0ZXN9YCxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgYm9keSA9IHJlc3BvbnNlLmJvZHk7XG4gIGlmICghYm9keSkgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBcIlwiIH07XG5cbiAgY29uc3QgcmVhZGVyID0gYm9keS5nZXRSZWFkZXIoKTtcbiAgY29uc3QgY2h1bmtzOiBVaW50OEFycmF5W10gPSBbXTtcbiAgbGV0IHRvdGFsID0gMDtcbiAgdHJ5IHtcbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgY29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChkb25lKSBicmVhaztcbiAgICAgIGlmICghdmFsdWUpIGNvbnRpbnVlO1xuICAgICAgdG90YWwgKz0gdmFsdWUuYnl0ZUxlbmd0aDtcbiAgICAgIGlmICh0b3RhbCA+IG1heEJ5dGVzKSB7XG4gICAgICAgIGF3YWl0IHJlYWRlci5jYW5jZWwoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgZXJyb3I6IGBSZXNwb25zZSBib2R5IGV4Y2VlZGVkIHRoZSAke21heEJ5dGVzfS1ieXRlIGxpbWl0YCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNodW5rcy5wdXNoKHZhbHVlKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBgRmFpbGVkIHRvIHJlYWQgcmVzcG9uc2UgYm9keTogJHtkZXNjcmliZShlcnJvcil9YCxcbiAgICB9O1xuICB9IGZpbmFsbHkge1xuICAgIHJlYWRlci5yZWxlYXNlTG9jaygpO1xuICB9XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUoY29uY2F0KGNodW5rcywgdG90YWwpKSB9O1xufVxuXG4vKipcbiAqIFJlYWQgYSByZXNwb25zZSBib2R5IHdoaWxlIHJldGFpbmluZyBvbmx5IGl0cyBsYXN0IGBtYXhCeXRlc2AgYnl0ZXMuXG4gKlxuICogVXNlZCBmb3IgY29uc29sZSBsb2dzLCB3aGVyZSB0aGUgdGFpbCBjYXJyaWVzIHRoZSBmYWlsdXJlLiBQZWFrIG1lbW9yeSBpc1xuICogYm91bmRlZCBieSBgbWF4Qnl0ZXNgIHBsdXMgb25lIG5ldHdvcmsgY2h1bmsgaG93ZXZlciBsYXJnZSB0aGUgYm9keSBncm93cyxcbiAqIHNvIGFuIG92ZXJzaXplZCBsb2cgY29zdHMgYSB0cnVuY2F0aW9uIG5vdGljZSByYXRoZXIgdGhhbiB0aGUgd29ya2VyJ3NcbiAqIGhlYXAuIFRvdGFsIGVsYXBzZWQgdGltZSBpcyBib3VuZGVkIGJ5IHRoZSByZXF1ZXN0J3MgYWJvcnQgc2lnbmFsLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZFRhaWxCb3VuZGVkKFxuICByZXNwb25zZTogUmVzcG9uc2UsXG4gIG1heEJ5dGVzOiBudW1iZXIsXG4gIG1heFN0cmVhbUJ5dGVzOiBudW1iZXIgPSBERUZBVUxUX01BWF9TVFJFQU1fQllURVMsXG4pOiBQcm9taXNlPFJlc3VsdDxCb3VuZGVkVGFpbFJlYWQsIHN0cmluZz4+IHtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobWF4Qnl0ZXMpIHx8IG1heEJ5dGVzIDw9IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGBtYXhCeXRlcyBtdXN0IGJlIGEgcG9zaXRpdmUgbnVtYmVyOyBnb3QgJHttYXhCeXRlc31gLFxuICAgIH07XG4gIH1cbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobWF4U3RyZWFtQnl0ZXMpIHx8IG1heFN0cmVhbUJ5dGVzIDw9IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IGBtYXhTdHJlYW1CeXRlcyBtdXN0IGJlIGEgcG9zaXRpdmUgbnVtYmVyOyBnb3QgJHttYXhTdHJlYW1CeXRlc31gLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBib2R5ID0gcmVzcG9uc2UuYm9keTtcbiAgaWYgKCFib2R5KSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IHsgdGFpbDogbmV3IFVpbnQ4QXJyYXkoMCksIHRvdGFsQnl0ZXM6IDAsIHN0cmVhbUNhcHBlZDogZmFsc2UgfSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgcmVhZGVyID0gYm9keS5nZXRSZWFkZXIoKTtcbiAgY29uc3Qgd2luZG93OiBVaW50OEFycmF5W10gPSBbXTtcbiAgbGV0IGJ1ZmZlcmVkID0gMDtcbiAgbGV0IHRvdGFsID0gMDtcbiAgbGV0IHN0cmVhbUNhcHBlZCA9IGZhbHNlO1xuICB0cnkge1xuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIGJyZWFrO1xuICAgICAgaWYgKCF2YWx1ZSB8fCB2YWx1ZS5ieXRlTGVuZ3RoID09PSAwKSBjb250aW51ZTtcbiAgICAgIHRvdGFsICs9IHZhbHVlLmJ5dGVMZW5ndGg7XG5cbiAgICAgIC8vIEEgc2luZ2xlIGNodW5rIGxhcmdlciB0aGFuIHRoZSBjYXAgY29udHJpYnV0ZXMgb25seSBpdHMgb3duIHRhaWwuXG4gICAgICBjb25zdCBjaHVuayA9IHZhbHVlLmJ5dGVMZW5ndGggPiBtYXhCeXRlc1xuICAgICAgICA/IHZhbHVlLnN1YmFycmF5KHZhbHVlLmJ5dGVMZW5ndGggLSBtYXhCeXRlcylcbiAgICAgICAgOiB2YWx1ZTtcbiAgICAgIHdpbmRvdy5wdXNoKGNodW5rKTtcbiAgICAgIGJ1ZmZlcmVkICs9IGNodW5rLmJ5dGVMZW5ndGg7XG5cbiAgICAgIC8vIERyb3AgbGVhZGluZyBjaHVua3MgdGhhdCBhcmUgd2hvbGx5IG91dHNpZGUgdGhlIHJldGFpbmVkIHdpbmRvdy5cbiAgICAgIHdoaWxlIChcbiAgICAgICAgd2luZG93Lmxlbmd0aCA+IDEgJiYgYnVmZmVyZWQgLSB3aW5kb3dbMF0hLmJ5dGVMZW5ndGggPj0gbWF4Qnl0ZXNcbiAgICAgICkge1xuICAgICAgICBidWZmZXJlZCAtPSB3aW5kb3cuc2hpZnQoKSEuYnl0ZUxlbmd0aDtcbiAgICAgIH1cblxuICAgICAgLy8gSGFyZCBzdG9wOiBhbiBlbmRsZXNzIGJvZHkgd291bGQgb3RoZXJ3aXNlIHN0cmVhbSBmb3JldmVyLCBzaW5jZSB0aGVcbiAgICAgIC8vIHRhaWwgd2luZG93IGtlZXBzIG1lbW9yeSBmbGF0IGFuZCBuZXZlciB0cmlwcyBhIHNpemUgZXJyb3IuXG4gICAgICBpZiAodG90YWwgPj0gbWF4U3RyZWFtQnl0ZXMpIHtcbiAgICAgICAgc3RyZWFtQ2FwcGVkID0gdHJ1ZTtcbiAgICAgICAgYXdhaXQgcmVhZGVyLmNhbmNlbCgpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBgRmFpbGVkIHRvIHJlYWQgcmVzcG9uc2UgYm9keTogJHtkZXNjcmliZShlcnJvcil9YCxcbiAgICB9O1xuICB9IGZpbmFsbHkge1xuICAgIHJlYWRlci5yZWxlYXNlTG9jaygpO1xuICB9XG5cbiAgY29uc3Qgam9pbmVkID0gY29uY2F0KHdpbmRvdywgYnVmZmVyZWQpO1xuICBjb25zdCB0YWlsID0gam9pbmVkLmJ5dGVMZW5ndGggPiBtYXhCeXRlc1xuICAgID8gam9pbmVkLnN1YmFycmF5KGpvaW5lZC5ieXRlTGVuZ3RoIC0gbWF4Qnl0ZXMpXG4gICAgOiBqb2luZWQ7XG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogeyB0YWlsLCB0b3RhbEJ5dGVzOiB0b3RhbCwgc3RyZWFtQ2FwcGVkIH0gfTtcbn1cblxuLyoqXG4gKiBDYW5jZWwgYSByZXNwb25zZSBib2R5IHdpdGhvdXQgYnVmZmVyaW5nIGl0LlxuICpcbiAqIFVzZWQgb24gZXJyb3IgcGF0aHMgd2hlcmUgdGhlIGJvZHkgaXMgbmV2ZXIgcmVhZDogY2FuY2VsbGluZyBmcmVlcyB0aGVcbiAqIGNvbm5lY3Rpb24gd2l0aG91dCBnaXZpbmcgYSBob3N0aWxlIHNlcnZlciBhIHBsYWNlIHRvIHN0cmVhbSBtZWdhYnl0ZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkaXNjYXJkQm9keShyZXNwb25zZTogUmVzcG9uc2UpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBhd2FpdCByZXNwb25zZS5ib2R5Py5jYW5jZWwoKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gVGhlIGNvbm5lY3Rpb24gaXMgYWxyZWFkeSBnb25lOyB0aGUgc3RhdHVzIGNvZGUgaXMgdGhlIHNpZ25hbCB3ZSBuZWVkLlxuICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBaUJDLEdBSUQsdUVBQXVFLEdBQ3ZFLE9BQU8sTUFBTSwyQkFBMkIsT0FBTztBQUUvQywyREFBMkQsR0FDM0QsT0FBTyxNQUFNLDZCQUE2QixPQUFPLEtBQUs7QUFFdEQ7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sTUFBTSwyQkFBMkIsS0FBSyxPQUFPLEtBQUs7QUFZekQ7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sU0FBUyxxQkFDZCxLQUFjLEVBQ2QsWUFBb0Isd0JBQXdCO0VBRTVDLE1BQU0sT0FBTyxpQkFBaUIsUUFBUSxNQUFNLElBQUksR0FBRztFQUNuRCxJQUFJLFNBQVMsa0JBQWtCLFNBQVMsY0FBYztJQUNwRCxPQUFPLENBQUMsd0JBQXdCLEVBQUUsVUFBVSxFQUFFLENBQUM7RUFDakQ7RUFDQSxPQUFPLFNBQVM7QUFDbEI7QUFFQTs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxTQUFTLG1CQUNkLElBQWlCLEVBQ2pCLFlBQW9CLHdCQUF3QjtFQUU1QyxJQUFJLENBQUMsT0FBTyxRQUFRLENBQUMsY0FBYyxhQUFhLEdBQUc7SUFDakQsTUFBTSxJQUFJLFdBQ1IsQ0FBQywrREFBK0QsRUFBRSxXQUFXO0VBRWpGO0VBQ0EsT0FBTztJQUFFLEdBQUcsSUFBSTtJQUFFLFFB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
// denoCacheMetadata=4368936664167841109,10743107220180614426