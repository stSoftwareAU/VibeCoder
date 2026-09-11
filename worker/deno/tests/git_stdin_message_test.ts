/**
 * Tests for the bounded `-F -` stdin message reader (Issue #1953).
 *
 * Every refusal is driven through the injected chunk reader, so the terminal,
 * deadline, bound and NUL cases are exercised without a real pipe.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ChunkReader,
  MAX_STDIN_MESSAGE_BYTES,
  preReadStdinSource,
  readStdinMessage,
  STDIN_MESSAGE_DEADLINE_MS,
  unreadStdinSource,
} from "../lib/git_stdin_message.ts";
import { UnredactableMessageError } from "../lib/git_message_redaction.ts";

/** A chunk reader that serves `text` in `chunkBytes`-sized pieces. */
function chunkedReader(text: string, chunkBytes: number): ChunkReader {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return () => {
    if (offset >= bytes.length) return Promise.resolve(null);
    const take = Math.min(chunkBytes, bytes.length - offset);
    const chunk = bytes.slice(offset, offset + take);
    offset += take;
    return Promise.resolve(chunk);
  };
}

/** Capture the error a read throws, failing the test when it throws none. */
async function refusal(
  options: Parameters<typeof readStdinMessage>[0],
): Promise<UnredactableMessageError> {
  let raised: unknown;
  try {
    await readStdinMessage(options);
  } catch (err) {
    raised = err;
  }
  assert(
    raised instanceof UnredactableMessageError,
    `expected a refusal, got ${raised}`,
  );
  return raised;
}

Deno.test("stdin message - reads a multi-line message to completion", async () => {
  const message = "subject line\n\nbody paragraph\nsecond line\n";
  assertEquals(
    await readStdinMessage({
      isTerminal: false,
      read: chunkedReader(message, 7),
    }),
    message,
  );
});

Deno.test("stdin message - an empty stream reads as an empty message", async () => {
  assertEquals(
    await readStdinMessage({
      isTerminal: false,
      read: () => Promise.resolve(null),
    }),
    "",
  );
});

Deno.test("stdin message - decodes multi-byte characters split across chunks", async () => {
  // A one-byte chunk size splits every é, so a per-chunk decode would corrupt
  // it — the message is decoded once, whole.
  const message = "café naïve — ☕\n";
  assertEquals(
    await readStdinMessage({
      isTerminal: false,
      read: chunkedReader(message, 1),
    }),
    message,
  );
});

Deno.test("stdin message - a terminal is refused without reading a byte", async () => {
  let reads = 0;
  const raised = await refusal({
    isTerminal: true,
    read: () => {
      reads++;
      return Promise.resolve(null);
    },
  });
  assertEquals(raised.source, "-");
  assertStringIncludes(raised.message, "terminal");
  assertEquals(reads, 0, "a terminal must never be read — it would block");
});

Deno.test("stdin message - a stream that never ends is refused on the deadline", async () => {
  // The case `isTerminal` cannot see: a pipe held open by a writer that never
  // writes. Before the deadline this blocked the guard, and with it the
  // agent's own git command, until something else killed it.
  const raised = await refusal({
    isTerminal: false,
    read: () => new Promise<Uint8Array | null>(() => {}),
    deadlineMs: 20,
  });
  assertStringIncludes(raised.message, "20ms");
  assertStringIncludes(raised.message, "-F <path>");
});

Deno.test("stdin message - a message past the bound is refused, never truncated", async () => {
  const raised = await refusal({
    isTerminal: false,
    read: chunkedReader("x".repeat(200), 32),
    limit: 100,
  });
  assertStringIncludes(raised.message, "-F <path>");
});

Deno.test("stdin message - a message exactly on the bound is accepted", async () => {
  const message = "y".repeat(100);
  assertEquals(
    await readStdinMessage({
      isTerminal: false,
      read: chunkedReader(message, 64),
      limit: 100,
    }),
    message,
  );
});

Deno.test("stdin message - the documented default bound applies when none is given", async () => {
  // The guard's own reader passes no limit, so the default has to bite.
  const raised = await refusal({
    isTerminal: false,
    read: chunkedReader("z".repeat(MAX_STDIN_MESSAGE_BYTES + 1), 8192),
  });
  assertStringIncludes(raised.message, `${MAX_STDIN_MESSAGE_BYTES}`);

  const largest = "z".repeat(MAX_STDIN_MESSAGE_BYTES);
  assertEquals(
    (await readStdinMessage({
      isTerminal: false,
      read: chunkedReader(largest, 8192),
    })).length,
    MAX_STDIN_MESSAGE_BYTES,
  );
});

Deno.test("stdin message - a NUL byte is refused naming itself", async () => {
  // The verdict is framed back to the wrapper as NUL-terminated fields, so a
  // NUL in the message would surface as an argument-count mismatch instead.
  const raised = await refusal({
    isTerminal: false,
    read: chunkedReader("subject\0with a nul\n", 64),
  });
  assertStringIncludes(raised.message, "NUL");
});

Deno.test("stdin message - an empty chunk ends the message rather than spinning", async () => {
  let calls = 0;
  const read: ChunkReader = () => {
    calls++;
    return Promise.resolve(
      calls === 1 ? new TextEncoder().encode("done") : new Uint8Array(0),
    );
  };
  assertEquals(await readStdinMessage({ isTerminal: false, read }), "done");
  assertEquals(calls, 2);
});

Deno.test("stdin message - the deadline default is long enough to be a backstop, not a hurry", () => {
  assert(STDIN_MESSAGE_DEADLINE_MS >= 30_000);
});

Deno.test("stdin message - a pre-read source replays the message it was given", () => {
  const source = preReadStdinSource("subject\n\nbody\n");
  assertEquals(source.read(), "subject\n\nbody\n");
});

Deno.test("stdin message - the unread source refuses rather than inventing a message", () => {
  let raised: unknown;
  try {
    unreadStdinSource.read();
  } catch (err) {
    raised = err;
  }
  assert(raised instanceof UnredactableMessageError);
  assertEquals(raised.source, "-");
});
