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
 * Every way this read could fail to end is a loud refusal rather than a
 * truncation or a wait:
 *
 * - **A terminal on stdin is refused before a byte is read.** These machines
 *   run unattended; a blocking read on a tty would hold the agent's `git` until
 *   something else killed it.
 * - **A pipe nobody ever writes to, or never closes, is refused on a
 *   deadline.** A tty is not the only stream that never ends —
 *   `mkfifo f; sleep 1000 > f; git commit -F - < f` blocks exactly as a tty
 *   does, and `isTerminal` says nothing about it. {@link STDIN_MESSAGE_DEADLINE_MS}
 *   bounds the whole read, so the worst case is a refusal the agent can act on
 *   rather than a command that never returns.
 * - **An oversized message is refused.** The masked text is handed back as a
 *   single argv element, and Linux caps one element at `MAX_ARG_STRLEN`
 *   (128 KiB). {@link MAX_STDIN_MESSAGE_BYTES} keeps a commit well inside
 *   that, and the refusal names the remedy: write it to a file and pass
 *   `-F <path>`, which has no such bound.
 * - **A NUL byte is refused, naming itself.** The verdict travels back to the
 *   wrapper as NUL-terminated fields, so a NUL inside the message would split
 *   into an extra field and be refused as an argument-count mismatch — a
 *   truthful refusal for an untruthful reason.
 *
 * The reader is split from its `Deno` binding so every one of those refusals is
 * testable without a real pipe.
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

/**
 * How long the whole stdin read may take before it is refused.
 *
 * Generous, because the writer is usually a heredoc that finishes instantly and
 * occasionally a command that takes a moment: the deadline is there to stop a
 * stream that never ends, not to hurry a slow one.
 */
export const STDIN_MESSAGE_DEADLINE_MS = 60_000;

/** Reads the next chunk of the message, or `null` at end of stream. */
export type ChunkReader = () => Promise<Uint8Array | null>;

/** How the message arrives, injected so every refusal can be tested. */
export interface StdinMessageOptions {
  /** Whether stdin is a terminal; a terminal is refused, never read. */
  isTerminal: boolean;
  /** Reads the next chunk of the message. */
  read: ChunkReader;
  /** Byte bound; defaults to {@link MAX_STDIN_MESSAGE_BYTES}. */
  limit?: number;
  /** Whole-read deadline; defaults to {@link STDIN_MESSAGE_DEADLINE_MS}. */
  deadlineMs?: number;
}

/**
 * Resolve `pending`, or throw when `ms` elapses first.
 *
 * The timer is always cleared, so a read that wins the race leaves nothing
 * pending behind it.
 */
async function withDeadline<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new UnredactableMessageError(
            "-",
            `a git message on stdin did not arrive within ${ms}ms — the ` +
              "stream is still open and nothing is writing to it. Pass the " +
              "message with -m <text> or -F <path>",
          ),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([pending, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Read a whole stdin message, refusing rather than blocking or truncating.
 *
 * @param options - The stream to read and the bounds to apply.
 * @returns The message as text.
 * @throws UnredactableMessageError when stdin is a terminal, when the stream
 *   stalls past the deadline, when the message exceeds the byte bound, or when
 *   it carries a NUL byte.
 */
export async function readStdinMessage(
  options: StdinMessageOptions,
): Promise<string> {
  const limit = options.limit ?? MAX_STDIN_MESSAGE_BYTES;
  const deadlineMs = options.deadlineMs ?? STDIN_MESSAGE_DEADLINE_MS;
  if (options.isTerminal) {
    throw new UnredactableMessageError(
      "-",
      "a git message was expected on stdin but stdin is a terminal — pass " +
        "the message with -m <text> or -F <path>",
    );
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const expiresAt = Date.now() + deadlineMs;
  for (;;) {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      throw new UnredactableMessageError(
        "-",
        `a git message on stdin did not finish within ${deadlineMs}ms — ` +
          "pass the message with -m <text> or -F <path>",
      );
    }
    const chunk = await withDeadline(options.read(), remaining);
    // `null` is end of stream; an empty chunk is treated the same way rather
    // than spun on, so a quiet stream can never loop forever.
    if (chunk === null || chunk.length === 0) break;
    total += chunk.length;
    if (total > limit) {
      throw new UnredactableMessageError(
        "-",
        `a git message on stdin is larger than the ${limit}-byte scanning ` +
          "bound — write it to a file and pass -F <path>",
      );
    }
    chunks.push(chunk);
  }

  const message = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    message.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder().decode(message);
  if (text.includes("\0")) {
    throw new UnredactableMessageError(
      "-",
      "a git message on stdin contains a NUL byte, which cannot be carried " +
        "back to the git wrapper — write it to a file and pass -F <path>",
    );
  }
  return text;
}

/**
 * Read the guard child's own standard input.
 *
 * Needs no Deno permission — stdin is already open when the process starts —
 * so the guard keeps its `--allow-read`-only footprint.
 */
export async function readProcessStdinMessage(): Promise<string> {
  const reader = Deno.stdin.readable.getReader();
  try {
    return await readStdinMessage({
      isTerminal: Deno.stdin.isTerminal(),
      read: async () => {
        const { value, done } = await reader.read();
        return done ? null : value ?? null;
      },
    });
  } finally {
    reader.releaseLock();
  }
}

/**
 * A source handing back a message that has already been read.
 *
 * Redaction is synchronous, so the message is read before it runs and replayed
 * here. The stream itself is still read exactly once — see
 * `git_guard_cli.ts`, which refuses a second `-F -` in the same command.
 *
 * @param message - The text read from stdin.
 * @returns A source returning that text.
 */
export function preReadStdinSource(message: string): StdinMessageSource {
  return { read: () => message };
}

/**
 * The source used when the argv named no stdin message.
 *
 * Reaching it would mean the guard decided differently on two passes over the
 * same argv, so it refuses rather than committing something nothing read.
 */
export const unreadStdinSource: StdinMessageSource = {
  read: () => {
    throw new UnredactableMessageError(
      "-",
      "a git message from stdin was needed but never read — refusing rather " +
        "than committing a message no control scanned",
    );
  },
};
