/**
 * Tests for the bounded `-F -` stdin message reader (Issue #1953).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ChunkReader,
  MAX_STDIN_MESSAGE_BYTES,
  readStdinMessage,
} from "../lib/git_stdin_message.ts";
import { UnredactableMessageError } from "../lib/git_message_redaction.ts";

/** A chunk reader that serves `text` in `chunkBytes`-sized pieces. */
function chunkedReader(text: string, chunkBytes: number): ChunkReader {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return (buffer) => {
    if (offset >= bytes.length) return null;
    const take = Math.min(chunkBytes, bytes.length - offset, buffer.length);
    buffer.set(bytes.subarray(offset, offset + take));
    offset += take;
    return take;
  };
}

Deno.test("stdin message - reads a multi-line message to completion", () => {
  const message = "subject line\n\nbody paragraph\nsecond line\n";
  assertEquals(
    readStdinMessage({
      isTerminal: false,
      readChunk: chunkedReader(message, 7),
    }),
    message,
  );
});

Deno.test("stdin message - an empty stream reads as an empty message", () => {
  assertEquals(
    readStdinMessage({ isTerminal: false, readChunk: () => null }),
    "",
  );
});

Deno.test("stdin message - decodes multi-byte characters split across chunks", () => {
  // A one-byte chunk size splits every é, so a per-chunk decode would corrupt
  // it — the message is decoded once, whole.
  const message = "café naïve — ☕\n";
  assertEquals(
    readStdinMessage({
      isTerminal: false,
      readChunk: chunkedReader(message, 1),
    }),
    message,
  );
});

Deno.test("stdin message - a terminal is refused without reading a byte", () => {
  let reads = 0;
  let raised: unknown;
  try {
    readStdinMessage({
      isTerminal: true,
      readChunk: () => {
        reads++;
        return null;
      },
    });
  } catch (err) {
    raised = err;
  }
  assert(raised instanceof UnredactableMessageError);
  assertEquals(raised.source, "-");
  assertStringIncludes(raised.message, "terminal");
  assertEquals(reads, 0, "a terminal must never be read — it would block");
});

Deno.test("stdin message - a message past the bound is refused, never truncated", () => {
  let raised: unknown;
  try {
    readStdinMessage({
      isTerminal: false,
      readChunk: chunkedReader("x".repeat(200), 32),
      limit: 100,
    });
  } catch (err) {
    raised = err;
  }
  assert(raised instanceof UnredactableMessageError);
  assertStringIncludes(raised.message, "-F <path>");
});

Deno.test("stdin message - a message exactly on the bound is accepted", () => {
  const message = "y".repeat(100);
  assertEquals(
    readStdinMessage({
      isTerminal: false,
      readChunk: chunkedReader(message, 64),
      limit: 100,
    }),
    message,
  );
});

Deno.test("stdin message - a zero-length read ends the message rather than spinning", () => {
  let calls = 0;
  const readChunk: ChunkReader = (buffer) => {
    calls++;
    if (calls === 1) {
      buffer.set(new TextEncoder().encode("done"));
      return 4;
    }
    return 0;
  };
  assertEquals(readStdinMessage({ isTerminal: false, readChunk }), "done");
  assertEquals(calls, 2);
});

Deno.test("stdin message - the default bound is the documented 64 KiB", () => {
  assertEquals(MAX_STDIN_MESSAGE_BYTES, 65536);
});
