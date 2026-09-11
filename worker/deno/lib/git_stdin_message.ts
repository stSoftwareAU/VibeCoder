/**
 * Reading a `git` message piped on stdin, bounded (Issue #1953).
 *
 * `git commit -F -` is the idiomatic way a script writes a multi-line message
 * — a heredoc into the command — and the guard used to refuse it outright,
 * costing the agent a rewrite and a retry every time. The refusal's stated
 * reason was real: the guard runs as a subprocess *ahead* of the real `git`,
 * and stdin can be consumed once. The fix is the one the guard already applies
 * to `-F <path>` — consume it here, mask it, and hand the text back inline as
 * `-m <masked>` — so the real `git` has nothing left to read and is run with
 * its stdin closed.
 *
 * The read is bounded rather than unbounded for two reasons, and both are
 * loud refusals rather than a truncation:
 *
 * - **A terminal on stdin is refused before a byte is read.** These machines
 *   run unattended; a blocking read on a tty would wedge the worker until its
 *   watchdog fired rather than fail.
 * - **An oversized message is refused.** The masked text is handed back as a
 *   single argv element, and Linux caps one element at `MAX_ARG_STRLEN`
 *   (128 KiB). {@link MAX_STDIN_MESSAGE_BYTES} keeps a commit well inside
 *   that, and the refusal names the remedy: write it to a file and pass
 *   `-F <path>`, which has no such bound.
 *
 * The reader is split from its `Deno` binding so the bound and the refusals
 * are testable without a real pipe.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type StdinMessageSource,
  UnredactableMessageError,
} from "./git_message_redaction.ts";

/**
 * Largest `-F -` message the guard will scan, in bytes.
 *
 * 64 KiB is roughly a thousand lines of commit message — far more than any
 * commit the fleet writes — and leaves the masked text comfortably inside the
 * 128 KiB single-argument limit even if masking lengthens it.
 */
export const MAX_STDIN_MESSAGE_BYTES = 64 * 1024;

/** Bytes requested per read; purely a buffering choice. */
const READ_CHUNK_BYTES = 16 * 1024;

/**
 * Fills `buffer` from the stream, returning the byte count, or `null` at end
 * of stream — the shape of `Deno.stdin.readSync`.
 */
export type ChunkReader = (buffer: Uint8Array) => number | null;

/** How the message arrives, injected so the bound can be tested. */
export interface StdinMessageOptions {
  /** Whether stdin is a terminal; a terminal is refused, never read. */
  isTerminal: boolean;
  /** Reads the next chunk of the message. */
  readChunk: ChunkReader;
  /** Byte bound; defaults to {@link MAX_STDIN_MESSAGE_BYTES}. */
  limit?: number;
}

/**
 * Read a whole stdin message, refusing rather than blocking or truncating.
 *
 * @param options - The stream to read and the bound to apply.
 * @returns The message as text.
 * @throws UnredactableMessageError when stdin is a terminal, or when the
 *   message exceeds the bound.
 */
export function readStdinMessage(options: StdinMessageOptions): string {
  const limit = options.limit ?? MAX_STDIN_MESSAGE_BYTES;
  if (options.isTerminal) {
    throw new UnredactableMessageError(
      "-",
      "a git message was expected on stdin but stdin is a terminal — pass " +
        "the message with -m <text> or -F <path>",
    );
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const buffer = new Uint8Array(READ_CHUNK_BYTES);
    const read = options.readChunk(buffer);
    // `null` is end of stream; a zero-length read is treated the same way
    // rather than spun on, so a quiet stream can never loop forever.
    if (read === null || read <= 0) break;
    total += read;
    if (total > limit) {
      throw new UnredactableMessageError(
        "-",
        `a git message on stdin is larger than the ${limit}-byte scanning ` +
          "bound — write it to a file and pass -F <path>",
      );
    }
    chunks.push(buffer.subarray(0, read));
  }

  const message = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    message.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(message);
}

/**
 * The production stdin source: the guard child's own standard input.
 *
 * Needs no Deno permission — stdin is already open when the process starts —
 * so the guard keeps its `--allow-read`-only footprint.
 */
export const denoStdinMessageSource: StdinMessageSource = {
  read: () =>
    readStdinMessage({
      isTerminal: Deno.stdin.isTerminal(),
      readChunk: (buffer) => Deno.stdin.readSync(buffer),
    }),
};
