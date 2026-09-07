/**
 * Reading one operator answer per question (Issue #1296).
 *
 * A consent question must be satisfied only by input aimed at it. Reading a
 * fixed-size buffer breaks that: whatever the operator typed past the buffer —
 * the newline and everything after it — stayed in the terminal buffer and was
 * read as the NEXT question's answer, so setup could write a ruleset on a
 * repository the operator was never asked about, while that repository's
 * question was never seen.
 *
 * So a prompt consumes exactly one line and discards the rest of whatever
 * arrived with it. Typing ahead cannot answer a question that has not been
 * asked; the worst it can do is leave the next prompt with nothing, which
 * declines.
 */

/** The byte source a prompt reads from — `Deno.stdin` satisfies it. */
export interface ConsentReader {
  read(buffer: Uint8Array): Promise<number | null>;
}

/** Bytes read per pass — a whole terminal line arrives well inside this. */
const CHUNK_BYTES = 256;

/**
 * Longest answer kept. A paste far beyond this is still consumed to the end
 * of its line, but only the first {@link MAX_ANSWER_BYTES} are decoded — an
 * over-long answer is never affirmative, so truncating it can only decline.
 */
const MAX_ANSWER_BYTES = 1024;

const NEWLINE = 0x0a;

/**
 * Read one answer: bytes up to the first newline, remainder discarded.
 *
 * @param reader - Where the answer arrives, usually `Deno.stdin`
 * @returns The trimmed, lower-cased answer, or `null` when the input ended
 *   without one (EOF, or a closed pipe) — no answer, so no consent
 */
export async function readConsentLine(
  reader: ConsentReader,
): Promise<string | null> {
  const buffer = new Uint8Array(CHUNK_BYTES);
  const answer: number[] = [];
  let sawInput = false;

  while (true) {
    const read = await reader.read(buffer);
    // `null` is EOF; a zero-length read means the source has no more to give,
    // and looping on it would spin forever.
    if (read === null || read <= 0) {
      return sawInput ? decodeAnswer(answer) : null;
    }
    sawInput = true;

    const chunk = buffer.subarray(0, read);
    const newline = chunk.indexOf(NEWLINE);
    const line = newline === -1 ? chunk : chunk.subarray(0, newline);
    for (const byte of line) {
      if (answer.length >= MAX_ANSWER_BYTES) break;
      answer.push(byte);
    }
    if (newline !== -1) return decodeAnswer(answer);
  }
}

/** True only for an explicit yes — anything else, including `null`, declines. */
export function isAffirmative(answer: string | null): boolean {
  return answer === "y" || answer === "yes";
}

function decodeAnswer(bytes: readonly number[]): string {
  return new TextDecoder().decode(new Uint8Array(bytes)).trim().toLowerCase();
}
