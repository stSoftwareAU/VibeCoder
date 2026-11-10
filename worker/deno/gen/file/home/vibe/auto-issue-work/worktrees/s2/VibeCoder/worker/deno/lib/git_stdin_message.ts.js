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
 */ import { UnredactableMessageError } from "./git_message_redaction.ts";
/**
 * Largest `-F -` message the guard will scan, in bytes.
 *
 * 64 KiB is roughly a thousand lines of commit message — far more than any
 * commit the fleet writes — and leaves the masked text comfortably inside the
 * 128 KiB single-argument limit even if masking lengthens it.
 */ export const MAX_STDIN_MESSAGE_BYTES = 64 * 1024;
/**
 * How long the whole stdin read may take before it is refused.
 *
 * Generous, because the writer is usually a heredoc that finishes instantly and
 * occasionally a command that takes a moment: the deadline is there to stop a
 * stream that never ends, not to hurry a slow one.
 */ export const STDIN_MESSAGE_DEADLINE_MS = 60_000;
/**
 * Resolve `pending`, or throw when `ms` elapses first.
 *
 * The timer is always cleared, so a read that wins the race leaves nothing
 * pending behind it.
 */ async function withDeadline(pending, ms) {
  let timer;
  const expiry = new Promise((_, reject)=>{
    timer = setTimeout(()=>reject(new UnredactableMessageError("-", `a git message on stdin did not arrive within ${ms}ms — the ` + "stream is still open and nothing is writing to it. Pass the " + "message with -m <text> or -F <path>")), ms);
  });
  try {
    return await Promise.race([
      pending,
      expiry
    ]);
  } finally{
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
 */ export async function readStdinMessage(options) {
  const limit = options.limit ?? MAX_STDIN_MESSAGE_BYTES;
  const deadlineMs = options.deadlineMs ?? STDIN_MESSAGE_DEADLINE_MS;
  if (options.isTerminal) {
    throw new UnredactableMessageError("-", "a git message was expected on stdin but stdin is a terminal — pass " + "the message with -m <text> or -F <path>");
  }
  const chunks = [];
  let total = 0;
  const expiresAt = Date.now() + deadlineMs;
  for(;;){
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      throw new UnredactableMessageError("-", `a git message on stdin did not finish within ${deadlineMs}ms — ` + "pass the message with -m <text> or -F <path>");
    }
    const chunk = await withDeadline(options.read(), remaining);
    // `null` is end of stream; an empty chunk is treated the same way rather
    // than spun on, so a quiet stream can never loop forever.
    if (chunk === null || chunk.length === 0) break;
    total += chunk.length;
    if (total > limit) {
      throw new UnredactableMessageError("-", `a git message on stdin is larger than the ${limit}-byte scanning ` + "bound — write it to a file and pass -F <path>");
    }
    chunks.push(chunk);
  }
  const message = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks){
    message.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder().decode(message);
  if (text.includes("\0")) {
    throw new UnredactableMessageError("-", "a git message on stdin contains a NUL byte, which cannot be carried " + "back to the git wrapper — write it to a file and pass -F <path>");
  }
  return text;
}
/**
 * Read the guard child's own standard input.
 *
 * Needs no Deno permission — stdin is already open when the process starts —
 * so the guard keeps its `--allow-read`-only footprint.
 */ export async function readProcessStdinMessage() {
  const reader = Deno.stdin.readable.getReader();
  try {
    return await readStdinMessage({
      isTerminal: Deno.stdin.isTerminal(),
      read: async ()=>{
        const { value, done } = await reader.read();
        return done ? null : value ?? null;
      }
    });
  } finally{
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
 */ export function preReadStdinSource(message) {
  return {
    read: ()=>message
  };
}
/**
 * The source used when the argv named no stdin message.
 *
 * Reaching it would mean the guard decided differently on two passes over the
 * same argv, so it refuses rather than committing something nothing read.
 */ export const unreadStdinSource = {
  read: ()=>{
    throw new UnredactableMessageError("-", "a git message from stdin was needed but never read — refusing rather " + "than committing a message no control scanned");
  }
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfc3RkaW5fbWVzc2FnZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFJlYWRpbmcgYSBgZ2l0YCBtZXNzYWdlIHBpcGVkIG9uIHN0ZGluLCBib3VuZGVkIChJc3N1ZSAjMTk1MykuXG4gKlxuICogYGdpdCBjb21taXQgLUYgLWAgaXMgdGhlIGlkaW9tYXRpYyB3YXkgYSBzY3JpcHQgd3JpdGVzIGEgbXVsdGktbGluZSBtZXNzYWdlXG4gKiDigJQgYSBoZXJlZG9jIGludG8gdGhlIGNvbW1hbmQg4oCUIGFuZCB0aGUgZ3VhcmQgdXNlZCB0byByZWZ1c2UgaXQgb3V0cmlnaHQsXG4gKiBjb3N0aW5nIHRoZSBhZ2VudCBhIHJld3JpdGUgYW5kIGEgcmV0cnkgZXZlcnkgdGltZS4gVGhlIHJlZnVzYWwncyBzdGF0ZWRcbiAqIHJlYXNvbiB3YXMgcmVhbDogdGhlIGd1YXJkIHJ1bnMgYXMgYSBzdWJwcm9jZXNzICphaGVhZCogb2YgdGhlIHJlYWwgYGdpdGAsXG4gKiBhbmQgc3RkaW4gY2FuIGJlIGNvbnN1bWVkIG9uY2UuIFRoZSBmaXggaXMgdGhlIG9uZSB0aGUgZ3VhcmQgYWxyZWFkeSBhcHBsaWVzXG4gKiB0byBgLUYgPHBhdGg+YCDigJQgY29uc3VtZSBpdCBoZXJlLCBtYXNrIGl0LCBhbmQgaGFuZCB0aGUgdGV4dCBiYWNrIGlubGluZSBhc1xuICogYC1tIDxtYXNrZWQ+YCDigJQgc28gdGhlIHJlYWwgYGdpdGAgaGFzIG5vdGhpbmcgbGVmdCB0byByZWFkIGFuZCBpcyBydW4gd2l0aFxuICogaXRzIHN0ZGluIGNsb3NlZC5cbiAqXG4gKiBFdmVyeSB3YXkgdGhpcyByZWFkIGNvdWxkIGZhaWwgdG8gZW5kIGlzIGEgbG91ZCByZWZ1c2FsIHJhdGhlciB0aGFuIGFcbiAqIHRydW5jYXRpb24gb3IgYSB3YWl0OlxuICpcbiAqIC0gKipBIHRlcm1pbmFsIG9uIHN0ZGluIGlzIHJlZnVzZWQgYmVmb3JlIGEgYnl0ZSBpcyByZWFkLioqIFRoZXNlIG1hY2hpbmVzXG4gKiAgIHJ1biB1bmF0dGVuZGVkOyBhIGJsb2NraW5nIHJlYWQgb24gYSB0dHkgd291bGQgaG9sZCB0aGUgYWdlbnQncyBgZ2l0YCB1bnRpbFxuICogICBzb21ldGhpbmcgZWxzZSBraWxsZWQgaXQuXG4gKiAtICoqQSBwaXBlIG5vYm9keSBldmVyIHdyaXRlcyB0bywgb3IgbmV2ZXIgY2xvc2VzLCBpcyByZWZ1c2VkIG9uIGFcbiAqICAgZGVhZGxpbmUuKiogQSB0dHkgaXMgbm90IHRoZSBvbmx5IHN0cmVhbSB0aGF0IG5ldmVyIGVuZHMg4oCUXG4gKiAgIGBta2ZpZm8gZjsgc2xlZXAgMTAwMCA+IGY7IGdpdCBjb21taXQgLUYgLSA8IGZgIGJsb2NrcyBleGFjdGx5IGFzIGEgdHR5XG4gKiAgIGRvZXMsIGFuZCBgaXNUZXJtaW5hbGAgc2F5cyBub3RoaW5nIGFib3V0IGl0LiB7QGxpbmsgU1RESU5fTUVTU0FHRV9ERUFETElORV9NU31cbiAqICAgYm91bmRzIHRoZSB3aG9sZSByZWFkLCBzbyB0aGUgd29yc3QgY2FzZSBpcyBhIHJlZnVzYWwgdGhlIGFnZW50IGNhbiBhY3Qgb25cbiAqICAgcmF0aGVyIHRoYW4gYSBjb21tYW5kIHRoYXQgbmV2ZXIgcmV0dXJucy5cbiAqIC0gKipBbiBvdmVyc2l6ZWQgbWVzc2FnZSBpcyByZWZ1c2VkLioqIFRoZSBtYXNrZWQgdGV4dCBpcyBoYW5kZWQgYmFjayBhcyBhXG4gKiAgIHNpbmdsZSBhcmd2IGVsZW1lbnQsIGFuZCBMaW51eCBjYXBzIG9uZSBlbGVtZW50IGF0IGBNQVhfQVJHX1NUUkxFTmBcbiAqICAgKDEyOCBLaUIpLiB7QGxpbmsgTUFYX1NURElOX01FU1NBR0VfQllURVN9IGtlZXBzIGEgY29tbWl0IHdlbGwgaW5zaWRlXG4gKiAgIHRoYXQsIGFuZCB0aGUgcmVmdXNhbCBuYW1lcyB0aGUgcmVtZWR5OiB3cml0ZSBpdCB0byBhIGZpbGUgYW5kIHBhc3NcbiAqICAgYC1GIDxwYXRoPmAsIHdoaWNoIGhhcyBubyBzdWNoIGJvdW5kLlxuICogLSAqKkEgTlVMIGJ5dGUgaXMgcmVmdXNlZCwgbmFtaW5nIGl0c2VsZi4qKiBUaGUgdmVyZGljdCB0cmF2ZWxzIGJhY2sgdG8gdGhlXG4gKiAgIHdyYXBwZXIgYXMgTlVMLXRlcm1pbmF0ZWQgZmllbGRzLCBzbyBhIE5VTCBpbnNpZGUgdGhlIG1lc3NhZ2Ugd291bGQgc3BsaXRcbiAqICAgaW50byBhbiBleHRyYSBmaWVsZCBhbmQgYmUgcmVmdXNlZCBhcyBhbiBhcmd1bWVudC1jb3VudCBtaXNtYXRjaCDigJQgYVxuICogICB0cnV0aGZ1bCByZWZ1c2FsIGZvciBhbiB1bnRydXRoZnVsIHJlYXNvbi5cbiAqXG4gKiBUaGUgcmVhZGVyIGlzIHNwbGl0IGZyb20gaXRzIGBEZW5vYCBiaW5kaW5nIHNvIGV2ZXJ5IG9uZSBvZiB0aG9zZSByZWZ1c2FscyBpc1xuICogdGVzdGFibGUgd2l0aG91dCBhIHJlYWwgcGlwZS5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQge1xuICB0eXBlIFN0ZGluTWVzc2FnZVNvdXJjZSxcbiAgVW5yZWRhY3RhYmxlTWVzc2FnZUVycm9yLFxufSBmcm9tIFwiLi9naXRfbWVzc2FnZV9yZWRhY3Rpb24udHNcIjtcblxuLyoqXG4gKiBMYXJnZXN0IGAtRiAtYCBtZXNzYWdlIHRoZSBndWFyZCB3aWxsIHNjYW4sIGluIGJ5dGVzLlxuICpcbiAqIDY0IEtpQiBpcyByb3VnaGx5IGEgdGhvdXNhbmQgbGluZXMgb2YgY29tbWl0IG1lc3NhZ2Ug4oCUIGZhciBtb3JlIHRoYW4gYW55XG4gKiBjb21taXQgdGhlIGZsZWV0IHdyaXRlcyDigJQgYW5kIGxlYXZlcyB0aGUgbWFza2VkIHRleHQgY29tZm9ydGFibHkgaW5zaWRlIHRoZVxuICogMTI4IEtpQiBzaW5nbGUtYXJndW1lbnQgbGltaXQgZXZlbiBpZiBtYXNraW5nIGxlbmd0aGVucyBpdC5cbiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9TVERJTl9NRVNTQUdFX0JZVEVTID0gNjQgKiAxMDI0O1xuXG4vKipcbiAqIEhvdyBsb25nIHRoZSB3aG9sZSBzdGRpbiByZWFkIG1heSB0YWtlIGJlZm9yZSBpdCBpcyByZWZ1c2VkLlxuICpcbiAqIEdlbmVyb3VzLCBiZWNhdXNlIHRoZSB3cml0ZXIgaXMgdXN1YWxseSBhIGhlcmVkb2MgdGhhdCBmaW5pc2hlcyBpbnN0YW50bHkgYW5kXG4gKiBvY2Nhc2lvbmFsbHkgYSBjb21tYW5kIHRoYXQgdGFrZXMgYSBtb21lbnQ6IHRoZSBkZWFkbGluZSBpcyB0aGVyZSB0byBzdG9wIGFcbiAqIHN0cmVhbSB0aGF0IG5ldmVyIGVuZHMsIG5vdCB0byBodXJyeSBhIHNsb3cgb25lLlxuICovXG5leHBvcnQgY29uc3QgU1RESU5fTUVTU0FHRV9ERUFETElORV9NUyA9IDYwXzAwMDtcblxuLyoqIFJlYWRzIHRoZSBuZXh0IGNodW5rIG9mIHRoZSBtZXNzYWdlLCBvciBgbnVsbGAgYXQgZW5kIG9mIHN0cmVhbS4gKi9cbmV4cG9ydCB0eXBlIENodW5rUmVhZGVyID0gKCkgPT4gUHJvbWlzZTxVaW50OEFycmF5IHwgbnVsbD47XG5cbi8qKiBIb3cgdGhlIG1lc3NhZ2UgYXJyaXZlcywgaW5qZWN0ZWQgc28gZXZlcnkgcmVmdXNhbCBjYW4gYmUgdGVzdGVkLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTdGRpbk1lc3NhZ2VPcHRpb25zIHtcbiAgLyoqIFdoZXRoZXIgc3RkaW4gaXMgYSB0ZXJtaW5hbDsgYSB0ZXJtaW5hbCBpcyByZWZ1c2VkLCBuZXZlciByZWFkLiAqL1xuICBpc1Rlcm1pbmFsOiBib29sZWFuO1xuICAvKiogUmVhZHMgdGhlIG5leHQgY2h1bmsgb2YgdGhlIG1lc3NhZ2UuICovXG4gIHJlYWQ6IENodW5rUmVhZGVyO1xuICAvKiogQnl0ZSBib3VuZDsgZGVmYXVsdHMgdG8ge0BsaW5rIE1BWF9TVERJTl9NRVNTQUdFX0JZVEVTfS4gKi9cbiAgbGltaXQ/OiBudW1iZXI7XG4gIC8qKiBXaG9sZS1yZWFkIGRlYWRsaW5lOyBkZWZhdWx0cyB0byB7QGxpbmsgU1RESU5fTUVTU0FHRV9ERUFETElORV9NU30uICovXG4gIGRlYWRsaW5lTXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogUmVzb2x2ZSBgcGVuZGluZ2AsIG9yIHRocm93IHdoZW4gYG1zYCBlbGFwc2VzIGZpcnN0LlxuICpcbiAqIFRoZSB0aW1lciBpcyBhbHdheXMgY2xlYXJlZCwgc28gYSByZWFkIHRoYXQgd2lucyB0aGUgcmFjZSBsZWF2ZXMgbm90aGluZ1xuICogcGVuZGluZyBiZWhpbmQgaXQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHdpdGhEZWFkbGluZTxUPihwZW5kaW5nOiBQcm9taXNlPFQ+LCBtczogbnVtYmVyKTogUHJvbWlzZTxUPiB7XG4gIGxldCB0aW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGV4cGlyeSA9IG5ldyBQcm9taXNlPG5ldmVyPigoXywgcmVqZWN0KSA9PiB7XG4gICAgdGltZXIgPSBzZXRUaW1lb3V0KFxuICAgICAgKCkgPT5cbiAgICAgICAgcmVqZWN0KFxuICAgICAgICAgIG5ldyBVbnJlZGFjdGFibGVNZXNzYWdlRXJyb3IoXG4gICAgICAgICAgICBcIi1cIixcbiAgICAgICAgICAgIGBhIGdpdCBtZXNzYWdlIG9uIHN0ZGluIGRpZCBub3QgYXJyaXZlIHdpdGhpbiAke21zfW1zIOKAlCB0aGUgYCArXG4gICAgICAgICAgICAgIFwic3RyZWFtIGlzIHN0aWxsIG9wZW4gYW5kIG5vdGhpbmcgaXMgd3JpdGluZyB0byBpdC4gUGFzcyB0aGUgXCIgK1xuICAgICAgICAgICAgICBcIm1lc3NhZ2Ugd2l0aCAtbSA8dGV4dD4gb3IgLUYgPHBhdGg+XCIsXG4gICAgICAgICAgKSxcbiAgICAgICAgKSxcbiAgICAgIG1zLFxuICAgICk7XG4gIH0pO1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBQcm9taXNlLnJhY2UoW3BlbmRpbmcsIGV4cGlyeV0pO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh0aW1lciAhPT0gdW5kZWZpbmVkKSBjbGVhclRpbWVvdXQodGltZXIpO1xuICB9XG59XG5cbi8qKlxuICogUmVhZCBhIHdob2xlIHN0ZGluIG1lc3NhZ2UsIHJlZnVzaW5nIHJhdGhlciB0aGFuIGJsb2NraW5nIG9yIHRydW5jYXRpbmcuXG4gKlxuICogQHBhcmFtIG9wdGlvbnMgLSBUaGUgc3RyZWFtIHRvIHJlYWQgYW5kIHRoZSBib3VuZHMgdG8gYXBwbHkuXG4gKiBAcmV0dXJucyBUaGUgbWVzc2FnZSBhcyB0ZXh0LlxuICogQHRocm93cyBVbnJlZGFjdGFibGVNZXNzYWdlRXJyb3Igd2hlbiBzdGRpbiBpcyBhIHRlcm1pbmFsLCB3aGVuIHRoZSBzdHJlYW1cbiAqICAgc3RhbGxzIHBhc3QgdGhlIGRlYWRsaW5lLCB3aGVuIHRoZSBtZXNzYWdlIGV4Y2VlZHMgdGhlIGJ5dGUgYm91bmQsIG9yIHdoZW5cbiAqICAgaXQgY2FycmllcyBhIE5VTCBieXRlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZFN0ZGluTWVzc2FnZShcbiAgb3B0aW9uczogU3RkaW5NZXNzYWdlT3B0aW9ucyxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGxpbWl0ID0gb3B0aW9ucy5saW1pdCA/PyBNQVhfU1RESU5fTUVTU0FHRV9CWVRFUztcbiAgY29uc3QgZGVhZGxpbmVNcyA9IG9wdGlvbnMuZGVhZGxpbmVNcyA/PyBTVERJTl9NRVNTQUdFX0RFQURMSU5FX01TO1xuICBpZiAob3B0aW9ucy5pc1Rlcm1pbmFsKSB7XG4gICAgdGhyb3cgbmV3IFVucmVkYWN0YWJsZU1lc3NhZ2VFcnJvcihcbiAgICAgIFwiLVwiLFxuICAgICAgXCJhIGdpdCBtZXNzYWdlIHdhcyBleHBlY3RlZCBvbiBzdGRpbiBidXQgc3RkaW4gaXMgYSB0ZXJtaW5hbCDigJQgcGFzcyBcIiArXG4gICAgICAgIFwidGhlIG1lc3NhZ2Ugd2l0aCAtbSA8dGV4dD4gb3IgLUYgPHBhdGg+XCIsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGNodW5rczogVWludDhBcnJheVtdID0gW107XG4gIGxldCB0b3RhbCA9IDA7XG4gIGNvbnN0IGV4cGlyZXNBdCA9IERhdGUubm93KCkgKyBkZWFkbGluZU1zO1xuICBmb3IgKDs7KSB7XG4gICAgY29uc3QgcmVtYWluaW5nID0gZXhwaXJlc0F0IC0gRGF0ZS5ub3coKTtcbiAgICBpZiAocmVtYWluaW5nIDw9IDApIHtcbiAgICAgIHRocm93IG5ldyBVbnJlZGFjdGFibGVNZXNzYWdlRXJyb3IoXG4gICAgICAgIFwiLVwiLFxuICAgICAgICBgYSBnaXQgbWVzc2FnZSBvbiBzdGRpbiBkaWQgbm90IGZpbmlzaCB3aXRoaW4gJHtkZWFkbGluZU1zfW1zIOKAlCBgICtcbiAgICAgICAgICBcInBhc3MgdGhlIG1lc3NhZ2Ugd2l0aCAtbSA8dGV4dD4gb3IgLUYgPHBhdGg+XCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBjaHVuayA9IGF3YWl0IHdpdGhEZWFkbGluZShvcHRpb25zLnJlYWQoKSwgcmVtYWluaW5nKTtcbiAgICAvLyBgbnVsbGAgaXMgZW5kIG9mIHN0cmVhbTsgYW4gZW1wdHkgY2h1bmsgaXMgdHJlYXRlZCB0aGUgc2FtZSB3YXkgcmF0aGVyXG4gICAgLy8gdGhhbiBzcHVuIG9uLCBzbyBhIHF1aWV0IHN0cmVhbSBjYW4gbmV2ZXIgbG9vcCBmb3JldmVyLlxuICAgIGlmIChjaHVuayA9PT0gbnVsbCB8fCBjaHVuay5sZW5ndGggPT09IDApIGJyZWFrO1xuICAgIHRvdGFsICs9IGNodW5rLmxlbmd0aDtcbiAgICBpZiAodG90YWwgPiBsaW1pdCkge1xuICAgICAgdGhyb3cgbmV3IFVucmVkYWN0YWJsZU1lc3NhZ2VFcnJvcihcbiAgICAgICAgXCItXCIsXG4gICAgICAgIGBhIGdpdCBtZXNzYWdlIG9uIHN0ZGluIGlzIGxhcmdlciB0aGFuIHRoZSAke2xpbWl0fS1ieXRlIHNjYW5uaW5nIGAgK1xuICAgICAgICAgIFwiYm91bmQg4oCUIHdyaXRlIGl0IHRvIGEgZmlsZSBhbmQgcGFzcyAtRiA8cGF0aD5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNodW5rcy5wdXNoKGNodW5rKTtcbiAgfVxuXG4gIGNvbnN0IG1lc3NhZ2UgPSBuZXcgVWludDhBcnJheSh0b3RhbCk7XG4gIGxldCBvZmZzZXQgPSAwO1xuICBmb3IgKGNvbnN0IGNodW5rIG9mIGNodW5rcykge1xuICAgIG1lc3NhZ2Uuc2V0KGNodW5rLCBvZmZzZXQpO1xuICAgIG9mZnNldCArPSBjaHVuay5sZW5ndGg7XG4gIH1cbiAgY29uc3QgdGV4dCA9IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShtZXNzYWdlKTtcbiAgaWYgKHRleHQuaW5jbHVkZXMoXCJcXDBcIikpIHtcbiAgICB0aHJvdyBuZXcgVW5yZWRhY3RhYmxlTWVzc2FnZUVycm9yKFxuICAgICAgXCItXCIsXG4gICAgICBcImEgZ2l0IG1lc3NhZ2Ugb24gc3RkaW4gY29udGFpbnMgYSBOVUwgYnl0ZSwgd2hpY2ggY2Fubm90IGJlIGNhcnJpZWQgXCIgK1xuICAgICAgICBcImJhY2sgdG8gdGhlIGdpdCB3cmFwcGVyIOKAlCB3cml0ZSBpdCB0byBhIGZpbGUgYW5kIHBhc3MgLUYgPHBhdGg+XCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gdGV4dDtcbn1cblxuLyoqXG4gKiBSZWFkIHRoZSBndWFyZCBjaGlsZCdzIG93biBzdGFuZGFyZCBpbnB1dC5cbiAqXG4gKiBOZWVkcyBubyBEZW5vIHBlcm1pc3Npb24g4oCUIHN0ZGluIGlzIGFscmVhZHkgb3BlbiB3aGVuIHRoZSBwcm9jZXNzIHN0YXJ0cyDigJRcbiAqIHNvIHRoZSBndWFyZCBrZWVwcyBpdHMgYC0tYWxsb3ctcmVhZGAtb25seSBmb290cHJpbnQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkUHJvY2Vzc1N0ZGluTWVzc2FnZSgpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCByZWFkZXIgPSBEZW5vLnN0ZGluLnJlYWRhYmxlLmdldFJlYWRlcigpO1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCByZWFkU3RkaW5NZXNzYWdlKHtcbiAgICAgIGlzVGVybWluYWw6IERlbm8uc3RkaW4uaXNUZXJtaW5hbCgpLFxuICAgICAgcmVhZDogYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCB7IHZhbHVlLCBkb25lIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgICByZXR1cm4gZG9uZSA/IG51bGwgOiB2YWx1ZSA/PyBudWxsO1xuICAgICAgfSxcbiAgICB9KTtcbiAgfSBmaW5hbGx5IHtcbiAgICByZWFkZXIucmVsZWFzZUxvY2soKTtcbiAgfVxufVxuXG4vKipcbiAqIEEgc291cmNlIGhhbmRpbmcgYmFjayBhIG1lc3NhZ2UgdGhhdCBoYXMgYWxyZWFkeSBiZWVuIHJlYWQuXG4gKlxuICogUmVkYWN0aW9uIGlzIHN5bmNocm9ub3VzLCBzbyB0aGUgbWVzc2FnZSBpcyByZWFkIGJlZm9yZSBpdCBydW5zIGFuZCByZXBsYXllZFxuICogaGVyZS4gVGhlIHN0cmVhbSBpdHNlbGYgaXMgc3RpbGwgcmVhZCBleGFjdGx5IG9uY2Ug4oCUIHNlZVxuICogYGdpdF9ndWFyZF9jbGkudHNgLCB3aGljaCByZWZ1c2VzIGEgc2Vjb25kIGAtRiAtYCBpbiB0aGUgc2FtZSBjb21tYW5kLlxuICpcbiAqIEBwYXJhbSBtZXNzYWdlIC0gVGhlIHRleHQgcmVhZCBmcm9tIHN0ZGluLlxuICogQHJldHVybnMgQSBzb3VyY2UgcmV0dXJuaW5nIHRoYXQgdGV4dC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByZVJlYWRTdGRpblNvdXJjZShtZXNzYWdlOiBzdHJpbmcpOiBTdGRpbk1lc3NhZ2VTb3VyY2Uge1xuICByZXR1cm4geyByZWFkOiAoKSA9PiBtZXNzYWdlIH07XG59XG5cbi8qKlxuICogVGhlIHNvdXJjZSB1c2VkIHdoZW4gdGhlIGFyZ3YgbmFtZWQgbm8gc3RkaW4gbWVzc2FnZS5cbiAqXG4gKiBSZWFjaGluZyBpdCB3b3VsZCBtZWFuIHRoZSBndWFyZCBkZWNpZGVkIGRpZmZlcmVudGx5IG9uIHR3byBwYXNzZXMgb3ZlciB0aGVcbiAqIHNhbWUgYXJndiwgc28gaXQgcmVmdXNlcyByYXRoZXIgdGhhbiBjb21taXR0aW5nIHNvbWV0aGluZyBub3RoaW5nIHJlYWQuXG4gKi9cbmV4cG9ydCBjb25zdCB1bnJlYWRTdGRpblNvdXJjZTogU3RkaW5NZXNzYWdlU291cmNlID0ge1xuICByZWFkOiAoKSA9PiB7XG4gICAgdGhyb3cgbmV3IFVucmVkYWN0YWJsZU1lc3NhZ2VFcnJvcihcbiAgICAgIFwiLVwiLFxuICAgICAgXCJhIGdpdCBtZXNzYWdlIGZyb20gc3RkaW4gd2FzIG5lZWRlZCBidXQgbmV2ZXIgcmVhZCDigJQgcmVmdXNpbmcgcmF0aGVyIFwiICtcbiAgICAgICAgXCJ0aGFuIGNvbW1pdHRpbmcgYSBtZXNzYWdlIG5vIGNvbnRyb2wgc2Nhbm5lZFwiLFxuICAgICk7XG4gIH0sXG59O1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXNDQyxHQUVELFNBRUUsd0JBQXdCLFFBQ25CLDZCQUE2QjtBQUVwQzs7Ozs7O0NBTUMsR0FDRCxPQUFPLE1BQU0sMEJBQTBCLEtBQUssS0FBSztBQUVqRDs7Ozs7O0NBTUMsR0FDRCxPQUFPLE1BQU0sNEJBQTRCLE9BQU87QUFpQmhEOzs7OztDQUtDLEdBQ0QsZUFBZSxhQUFnQixPQUFtQixFQUFFLEVBQVU7RUFDNUQsSUFBSTtFQUNKLE1BQU0sU0FBUyxJQUFJLFFBQWUsQ0FBQyxHQUFHO0lBQ3BDLFFBQVEsV0FDTixJQUNFLE9BQ0UsSUFBSSx5QkFDRixLQUNBLENBQUMsNkNBQTZDLEVBQUUsR0FBRyxTQUFTLENBQUMsR0FDM0QsaUVBQ0EseUNBR1I7RUFFSjtFQUNBLElBQUk7SUFDRixPQUFPLE1BQU0sUUFBUSxJQUFJLENBQUM7TUFBQztNQUFTO0tBQU87RUFDN0MsU0FBVTtJQUNSLElBQUksVUFBVSxXQUFXLGFBQWE7RUFDeEM7QUFDRjtBQUVBOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxlQUFlLGlCQUNwQixPQUE0QjtFQUU1QixNQUFNLFFBQVEsUUFBUSxLQUFLLElBQUk7RUFDL0IsTUFBTSxhQUFhLFFBQVEsVUFBVSxJQUFJO0VBQ3pDLElBQUksUUFBUSxVQUFVLEVBQUU7SUFDdEIsTUFBTSxJQUFJLHlCQUNSLEtBQ0Esd0VBQ0U7RUFFTjtFQUVBLE1BQU0sU0FBdUIsRUFBRTtFQUMvQixJQUFJLFFBQVE7RUFDWixNQUFNLFlBQVksS0FBSyxHQUFHLEtBQUs7RUFDL0IsT0FBUztJQUNQLE1BQU0sWUFBWSxZQUFZLEtBQUssR0FBRztJQUN0QyxJQUFJLGFBQWEsR0FBRztNQUNsQixNQUFNLElBQUkseUJBQ1IsS0FDQSxDQUFDLDZDQUE2QyxFQUFFLFdBQVcsS0FBSyxDQUFDLEdBQy9EO0lBRU47SUFDQSxNQUFNLFFBQVEsTUFBTSxhQUFhLFFBQVEsSUFBSSxJQUFJO0lBQ2pELHlFQUF5RTtJQUN6RSwwREFBMEQ7SUFDMUQsSUFBSSxVQUFVLFFBQVEsTUFBTSxNQUFNLEtBQUssR0FBRztJQUMxQyxTQUFTLE1BQU0sTUFBTTtJQUNyQixJQUFJLFFBQVEsT0FBTztNQUNqQixNQUFNLElBQUkseUJBQ1IsS0FDQSxDQUFDLDBDQUEwQyxFQUFFLE1BQU0sZUFBZSxDQUFDLEdBQ2pFO0lBRU47SUFDQSxPQUFPLElBQUksQ0FBQztFQUNkO0VBRUEsTUFBTSxVQUFVLElBQUksV0FBVztFQUMvQixJQUFJLFNBQVM7RUFDYixLQUFLLE1BQU0sU0FBUyxPQUFRO0lBQzFCLFFBQVEsR0FBRyxDQUFDLE9BQU87SUFDbkIsVUFBVSxNQUFNLE1BQU07RUFDeEI7RUFDQSxNQUFNLE9BQU8sSUFBSSxjQUFjLE1BQU0sQ0FBQztFQUN0QyxJQUFJLEtBQUssUUFBUSxDQUFDLE9BQU87SUFDdkIsTUFBTSxJQUFJLHlCQUNSLEtBQ0EseUVBQ0U7RUFFTjtFQUNBLE9BQU87QUFDVDtBQUVBOzs7OztDQUtDLEdBQ0QsT0FBTyxlQUFlO0VBQ3BCLE1BQU0sU0FBUyxLQUFLLEtBQUssQ0FBQyxRQUFRLENBQUMsU0FBUztFQUM1QyxJQUFJO0lBQ0YsT0FBTyxNQUFNLGlCQUFpQjtNQUM1QixZQUFZLEtBQUssS0FBSyxDQUFDLFVBQVU7TUFDakMsTUFBTTtRQUNKLE1BQU0sRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLEdBQUcsTUFBTSxPQUFPLElBQUk7UUFDekMsT0FBTyxPQUFPLE9BQU8sU0FBUztNQUNoQztJQUNGO0VBQ0YsU0FBVTtJQUNSLE9BQU8sV0FBVztFQUNwQjtBQUNGO0FBRUE7Ozs7Ozs7OztDQVNDLEdBQ0QsT0FBTyxTQUFTLG1CQUFtQixPQUFlO0VBQ2hELE9BQU87SUFBRSxNQUFNLElBQU07RUFBUTtBQUMvQjtBQUVBOzs7OztDQUtDLEdBQ0QsT0FBTyxNQUFNLG9CQUF3QztFQUNuRCxNQUFNO0lBQ0osTUFBTSxJQUFJLHlCQUNSLEtBQ0EsMEVBQ0U7RUFFTjtBQUNGLEVBQUUifQ==
// denoCacheMetadata=4162141402556578856,3127979449749266563