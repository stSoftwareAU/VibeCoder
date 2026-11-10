/**
 * Entry point invoked by the agent-side `git` shim (Issue #1284).
 *
 * The shim runs this module once per message-carrying `git` invocation the
 * agent makes, passing the `git` arguments on argv after a `--` separator.
 * Everything it decides on arrives as arguments, so its only Deno permission
 * is `--allow-read`, and only to scan the message files named in that argv.
 *
 * The contract with the shim mirrors the `gh` guard's: a **positive verdict
 * marker on stdout**, not an exit code, because `deno` itself exits 1 on a
 * module-resolution or runtime error and "exit 0/1" alone cannot distinguish a
 * verdict from a broken guard. The shim proceeds only on one of the two allow
 * markers — {@link GIT_GUARD_ALLOW_MARKER} or
 * {@link GIT_GUARD_ALLOW_STDIN_MARKER}; anything else — a refusal, a crash, an
 * empty stdout — refuses the `git` call.
 *
 * Exit codes accompany the marker: `0` allowed, `1` refused because the
 * message could not be scanned, `2` malformed invocation.
 *
 * A message piped on stdin (`git commit -F -`) is consumed here and handed
 * back inline in the argv (Issue #1953). The shim is told so by a distinct
 * allow marker, {@link GIT_GUARD_ALLOW_STDIN_MARKER}, because it must then run
 * the real `git` with stdin closed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { redactGitMessageArgs, UnredactableMessageError, usesStdinMessage } from "./git_message_redaction.ts";
import { preReadStdinSource, readProcessStdinMessage, unreadStdinSource } from "./git_stdin_message.ts";
import { installConsoleRedaction } from "./console_redaction.ts";
import { encodeNulFields } from "./guard_field_encoding.ts";
/** Printed on stdout when — and only when — the command may proceed. */ export const GIT_GUARD_ALLOW_MARKER = "VIBE_GIT_GUARD_ALLOW";
/**
 * Printed instead of {@link GIT_GUARD_ALLOW_MARKER} when the guard consumed a
 * `-F -` message from stdin (Issue #1953).
 *
 * The message is in the returned argv now, so the shim must run the real `git`
 * with its stdin closed: a stream can be read once, and a second reader would
 * see an empty — or, worse, a partial — message.
 */ export const GIT_GUARD_ALLOW_STDIN_MARKER = "VIBE_GIT_GUARD_ALLOW_STDIN";
/** Printed on stdout when the guard refused the command. */ export const GIT_GUARD_REFUSE_MARKER = "VIBE_GIT_GUARD_REFUSE";
/** Production message-file reader — used when the caller supplies none. */ const denoMessageFileReader = (path)=>Deno.readTextFileSync(path);
/**
 * Frame a verdict for the shim: the marker, then the argv to run, each field
 * NUL-terminated.
 *
 * @param result - The evaluation to frame.
 * @returns The exact bytes to write to stdout.
 */ export function encodeGitGuardStdout(result) {
  return encodeNulFields([
    result.stdout,
    ...result.gitArgs ?? []
  ]);
}
/**
 * Evaluate one shim invocation.
 *
 * @param argv - The guard's own argv: `--`, then the `git` arguments.
 * @param readMessageFile - Reader for `-F <path>` contents (test seam).
 * @param stdin - Source for a `-F -` message, already read from the stream
 *   ({@link preReadStdinSource}); reading it is what makes the stdin verdict
 *   marker appear.
 * @returns The exit code, the stderr line to emit, and — when allowed — the
 *   arguments the shim must run.
 */ export function runGitGuardCli(argv, readMessageFile = denoMessageFileReader, stdin = unreadStdinSource) {
  const separator = argv.indexOf("--");
  if (separator < 0) {
    return {
      exitCode: 2,
      stdout: GIT_GUARD_REFUSE_MARKER,
      stderr: "[SECURITY] [GIT_GUARD_ERROR] missing '--' separator before the git " + "arguments"
    };
  }
  const gitArgv = argv.slice(separator + 1);
  // A stdin message is read at most once and reported here rather than
  // inferred from argv: its two arguments are rewritten whether or not a
  // secret was found, so an argv comparison would claim a redaction on every
  // piped commit.
  let stdinConsumed = false;
  let redacted = false;
  const sources = {
    readMessageFile,
    stdin: {
      read: ()=>{
        // One command, one read. `git commit -F - -F -` would otherwise be
        // handed the same text twice, where the real `git` sees the message
        // once and then an empty stream.
        if (stdinConsumed) {
          throw new UnredactableMessageError("-", "this git command names stdin as its message source more than " + "once, and a stream can be read only once");
        }
        stdinConsumed = true;
        return stdin.read();
      }
    },
    onMasked: ()=>{
      redacted = true;
    }
  };
  let gitArgs;
  try {
    gitArgs = redactGitMessageArgs(gitArgv, sources);
  } catch (err) {
    if (!(err instanceof UnredactableMessageError)) throw err;
    return {
      exitCode: 1,
      stdout: GIT_GUARD_REFUSE_MARKER,
      stderr: `[SECURITY] [GIT_MESSAGE_UNREDACTABLE] ${err.message}`
    };
  }
  return {
    exitCode: 0,
    stdout: stdinConsumed ? GIT_GUARD_ALLOW_STDIN_MARKER : GIT_GUARD_ALLOW_MARKER,
    stderr: redacted ? "[SECURITY] [GIT_MESSAGE_REDACTED] a secret was masked in the " + "message of this git command before it reached history." : "",
    gitArgs
  };
}
/**
 * Read the stdin message this argv needs, as a source redaction can replay.
 *
 * Redaction is synchronous and the read is not — it is bounded by a deadline so
 * a stream nobody closes cannot hold the agent's `git` open — so the message is
 * read first and handed over already in hand. A read that refuses is carried
 * into the source, so the refusal reaches the caller through the same path as
 * every other unscannable message.
 *
 * @param gitArgv - The `git` arguments, after the `--` separator.
 * @returns The source to evaluate this command with.
 */ async function stdinSourceFor(gitArgv) {
  if (!usesStdinMessage(gitArgv)) return unreadStdinSource;
  try {
    return preReadStdinSource(await readProcessStdinMessage());
  } catch (err) {
    if (!(err instanceof UnredactableMessageError)) throw err;
    return {
      read: ()=>{
        throw err;
      }
    };
  }
}
if (import.meta.main) {
  // The refusal reason quotes a path from the agent's own argv, which is where
  // a credential can ride in; the NUL-encoded verdict is written through
  // `Deno.stdout` and is untouched by the patch.
  installConsoleRedaction();
  const separator = Deno.args.indexOf("--");
  const stdin = await stdinSourceFor(separator < 0 ? [] : Deno.args.slice(separator + 1));
  const result = runGitGuardCli(Deno.args, denoMessageFileReader, stdin);
  await Deno.stdout.write(new TextEncoder().encode(encodeGitGuardStdout(result)));
  if (result.stderr) console.error(result.stderr);
  Deno.exit(result.exitCode);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfZ3VhcmRfY2xpLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRW50cnkgcG9pbnQgaW52b2tlZCBieSB0aGUgYWdlbnQtc2lkZSBgZ2l0YCBzaGltIChJc3N1ZSAjMTI4NCkuXG4gKlxuICogVGhlIHNoaW0gcnVucyB0aGlzIG1vZHVsZSBvbmNlIHBlciBtZXNzYWdlLWNhcnJ5aW5nIGBnaXRgIGludm9jYXRpb24gdGhlXG4gKiBhZ2VudCBtYWtlcywgcGFzc2luZyB0aGUgYGdpdGAgYXJndW1lbnRzIG9uIGFyZ3YgYWZ0ZXIgYSBgLS1gIHNlcGFyYXRvci5cbiAqIEV2ZXJ5dGhpbmcgaXQgZGVjaWRlcyBvbiBhcnJpdmVzIGFzIGFyZ3VtZW50cywgc28gaXRzIG9ubHkgRGVubyBwZXJtaXNzaW9uXG4gKiBpcyBgLS1hbGxvdy1yZWFkYCwgYW5kIG9ubHkgdG8gc2NhbiB0aGUgbWVzc2FnZSBmaWxlcyBuYW1lZCBpbiB0aGF0IGFyZ3YuXG4gKlxuICogVGhlIGNvbnRyYWN0IHdpdGggdGhlIHNoaW0gbWlycm9ycyB0aGUgYGdoYCBndWFyZCdzOiBhICoqcG9zaXRpdmUgdmVyZGljdFxuICogbWFya2VyIG9uIHN0ZG91dCoqLCBub3QgYW4gZXhpdCBjb2RlLCBiZWNhdXNlIGBkZW5vYCBpdHNlbGYgZXhpdHMgMSBvbiBhXG4gKiBtb2R1bGUtcmVzb2x1dGlvbiBvciBydW50aW1lIGVycm9yIGFuZCBcImV4aXQgMC8xXCIgYWxvbmUgY2Fubm90IGRpc3Rpbmd1aXNoIGFcbiAqIHZlcmRpY3QgZnJvbSBhIGJyb2tlbiBndWFyZC4gVGhlIHNoaW0gcHJvY2VlZHMgb25seSBvbiBvbmUgb2YgdGhlIHR3byBhbGxvd1xuICogbWFya2VycyDigJQge0BsaW5rIEdJVF9HVUFSRF9BTExPV19NQVJLRVJ9IG9yXG4gKiB7QGxpbmsgR0lUX0dVQVJEX0FMTE9XX1NURElOX01BUktFUn07IGFueXRoaW5nIGVsc2Ug4oCUIGEgcmVmdXNhbCwgYSBjcmFzaCwgYW5cbiAqIGVtcHR5IHN0ZG91dCDigJQgcmVmdXNlcyB0aGUgYGdpdGAgY2FsbC5cbiAqXG4gKiBFeGl0IGNvZGVzIGFjY29tcGFueSB0aGUgbWFya2VyOiBgMGAgYWxsb3dlZCwgYDFgIHJlZnVzZWQgYmVjYXVzZSB0aGVcbiAqIG1lc3NhZ2UgY291bGQgbm90IGJlIHNjYW5uZWQsIGAyYCBtYWxmb3JtZWQgaW52b2NhdGlvbi5cbiAqXG4gKiBBIG1lc3NhZ2UgcGlwZWQgb24gc3RkaW4gKGBnaXQgY29tbWl0IC1GIC1gKSBpcyBjb25zdW1lZCBoZXJlIGFuZCBoYW5kZWRcbiAqIGJhY2sgaW5saW5lIGluIHRoZSBhcmd2IChJc3N1ZSAjMTk1MykuIFRoZSBzaGltIGlzIHRvbGQgc28gYnkgYSBkaXN0aW5jdFxuICogYWxsb3cgbWFya2VyLCB7QGxpbmsgR0lUX0dVQVJEX0FMTE9XX1NURElOX01BUktFUn0sIGJlY2F1c2UgaXQgbXVzdCB0aGVuIHJ1blxuICogdGhlIHJlYWwgYGdpdGAgd2l0aCBzdGRpbiBjbG9zZWQuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHtcbiAgdHlwZSBNZXNzYWdlRmlsZVJlYWRlcixcbiAgdHlwZSBNZXNzYWdlU291cmNlcyxcbiAgcmVkYWN0R2l0TWVzc2FnZUFyZ3MsXG4gIHR5cGUgU3RkaW5NZXNzYWdlU291cmNlLFxuICBVbnJlZGFjdGFibGVNZXNzYWdlRXJyb3IsXG4gIHVzZXNTdGRpbk1lc3NhZ2UsXG59IGZyb20gXCIuL2dpdF9tZXNzYWdlX3JlZGFjdGlvbi50c1wiO1xuaW1wb3J0IHtcbiAgcHJlUmVhZFN0ZGluU291cmNlLFxuICByZWFkUHJvY2Vzc1N0ZGluTWVzc2FnZSxcbiAgdW5yZWFkU3RkaW5Tb3VyY2UsXG59IGZyb20gXCIuL2dpdF9zdGRpbl9tZXNzYWdlLnRzXCI7XG5pbXBvcnQgeyBpbnN0YWxsQ29uc29sZVJlZGFjdGlvbiB9IGZyb20gXCIuL2NvbnNvbGVfcmVkYWN0aW9uLnRzXCI7XG5pbXBvcnQgeyBlbmNvZGVOdWxGaWVsZHMgfSBmcm9tIFwiLi9ndWFyZF9maWVsZF9lbmNvZGluZy50c1wiO1xuXG4vKiogUHJpbnRlZCBvbiBzdGRvdXQgd2hlbiDigJQgYW5kIG9ubHkgd2hlbiDigJQgdGhlIGNvbW1hbmQgbWF5IHByb2NlZWQuICovXG5leHBvcnQgY29uc3QgR0lUX0dVQVJEX0FMTE9XX01BUktFUiA9IFwiVklCRV9HSVRfR1VBUkRfQUxMT1dcIjtcblxuLyoqXG4gKiBQcmludGVkIGluc3RlYWQgb2Yge0BsaW5rIEdJVF9HVUFSRF9BTExPV19NQVJLRVJ9IHdoZW4gdGhlIGd1YXJkIGNvbnN1bWVkIGFcbiAqIGAtRiAtYCBtZXNzYWdlIGZyb20gc3RkaW4gKElzc3VlICMxOTUzKS5cbiAqXG4gKiBUaGUgbWVzc2FnZSBpcyBpbiB0aGUgcmV0dXJuZWQgYXJndiBub3csIHNvIHRoZSBzaGltIG11c3QgcnVuIHRoZSByZWFsIGBnaXRgXG4gKiB3aXRoIGl0cyBzdGRpbiBjbG9zZWQ6IGEgc3RyZWFtIGNhbiBiZSByZWFkIG9uY2UsIGFuZCBhIHNlY29uZCByZWFkZXIgd291bGRcbiAqIHNlZSBhbiBlbXB0eSDigJQgb3IsIHdvcnNlLCBhIHBhcnRpYWwg4oCUIG1lc3NhZ2UuXG4gKi9cbmV4cG9ydCBjb25zdCBHSVRfR1VBUkRfQUxMT1dfU1RESU5fTUFSS0VSID0gXCJWSUJFX0dJVF9HVUFSRF9BTExPV19TVERJTlwiO1xuXG4vKiogUHJpbnRlZCBvbiBzdGRvdXQgd2hlbiB0aGUgZ3VhcmQgcmVmdXNlZCB0aGUgY29tbWFuZC4gKi9cbmV4cG9ydCBjb25zdCBHSVRfR1VBUkRfUkVGVVNFX01BUktFUiA9IFwiVklCRV9HSVRfR1VBUkRfUkVGVVNFXCI7XG5cbi8qKiBPdXRjb21lIG9mIG9uZSBndWFyZCBldmFsdWF0aW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBHaXRHdWFyZENsaVJlc3VsdCB7XG4gIC8qKiBQcm9jZXNzIGV4aXQgY29kZSAoc2VlIHRoZSBtb2R1bGUgY29tbWVudCBmb3IgdGhlIGNvbnRyYWN0KS4gKi9cbiAgZXhpdENvZGU6IG51bWJlcjtcbiAgLyoqIFZlcmRpY3QgbWFya2VyIHRvIHdyaXRlIHRvIHN0ZG91dC4gKi9cbiAgc3Rkb3V0OiBzdHJpbmc7XG4gIC8qKiBMaW5lIHRvIHdyaXRlIHRvIHN0ZGVyciwgb3IgZW1wdHkgd2hlbiBub3RoaW5nIG5lZWRlZCBzYXlpbmcuICovXG4gIHN0ZGVycjogc3RyaW5nO1xuICAvKipcbiAgICogVGhlIGFyZ3VtZW50cyB0aGUgc2hpbSBtdXN0IHJ1biDigJQgbWVzc2FnZSBhcmd1bWVudHMgcmVkYWN0ZWQuIFByZXNlbnRcbiAgICogb25seSB3aGVuIHRoZSBjb21tYW5kIGlzIGFsbG93ZWQuXG4gICAqL1xuICBnaXRBcmdzPzogc3RyaW5nW107XG59XG5cbi8qKiBQcm9kdWN0aW9uIG1lc3NhZ2UtZmlsZSByZWFkZXIg4oCUIHVzZWQgd2hlbiB0aGUgY2FsbGVyIHN1cHBsaWVzIG5vbmUuICovXG5jb25zdCBkZW5vTWVzc2FnZUZpbGVSZWFkZXI6IE1lc3NhZ2VGaWxlUmVhZGVyID0gKHBhdGgpID0+XG4gIERlbm8ucmVhZFRleHRGaWxlU3luYyhwYXRoKTtcblxuLyoqXG4gKiBGcmFtZSBhIHZlcmRpY3QgZm9yIHRoZSBzaGltOiB0aGUgbWFya2VyLCB0aGVuIHRoZSBhcmd2IHRvIHJ1biwgZWFjaCBmaWVsZFxuICogTlVMLXRlcm1pbmF0ZWQuXG4gKlxuICogQHBhcmFtIHJlc3VsdCAtIFRoZSBldmFsdWF0aW9uIHRvIGZyYW1lLlxuICogQHJldHVybnMgVGhlIGV4YWN0IGJ5dGVzIHRvIHdyaXRlIHRvIHN0ZG91dC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuY29kZUdpdEd1YXJkU3Rkb3V0KHJlc3VsdDogR2l0R3VhcmRDbGlSZXN1bHQpOiBzdHJpbmcge1xuICByZXR1cm4gZW5jb2RlTnVsRmllbGRzKFtyZXN1bHQuc3Rkb3V0LCAuLi4ocmVzdWx0LmdpdEFyZ3MgPz8gW10pXSk7XG59XG5cbi8qKlxuICogRXZhbHVhdGUgb25lIHNoaW0gaW52b2NhdGlvbi5cbiAqXG4gKiBAcGFyYW0gYXJndiAtIFRoZSBndWFyZCdzIG93biBhcmd2OiBgLS1gLCB0aGVuIHRoZSBgZ2l0YCBhcmd1bWVudHMuXG4gKiBAcGFyYW0gcmVhZE1lc3NhZ2VGaWxlIC0gUmVhZGVyIGZvciBgLUYgPHBhdGg+YCBjb250ZW50cyAodGVzdCBzZWFtKS5cbiAqIEBwYXJhbSBzdGRpbiAtIFNvdXJjZSBmb3IgYSBgLUYgLWAgbWVzc2FnZSwgYWxyZWFkeSByZWFkIGZyb20gdGhlIHN0cmVhbVxuICogICAoe0BsaW5rIHByZVJlYWRTdGRpblNvdXJjZX0pOyByZWFkaW5nIGl0IGlzIHdoYXQgbWFrZXMgdGhlIHN0ZGluIHZlcmRpY3RcbiAqICAgbWFya2VyIGFwcGVhci5cbiAqIEByZXR1cm5zIFRoZSBleGl0IGNvZGUsIHRoZSBzdGRlcnIgbGluZSB0byBlbWl0LCBhbmQg4oCUIHdoZW4gYWxsb3dlZCDigJQgdGhlXG4gKiAgIGFyZ3VtZW50cyB0aGUgc2hpbSBtdXN0IHJ1bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJ1bkdpdEd1YXJkQ2xpKFxuICBhcmd2OiByZWFkb25seSBzdHJpbmdbXSxcbiAgcmVhZE1lc3NhZ2VGaWxlOiBNZXNzYWdlRmlsZVJlYWRlciA9IGRlbm9NZXNzYWdlRmlsZVJlYWRlcixcbiAgc3RkaW46IFN0ZGluTWVzc2FnZVNvdXJjZSA9IHVucmVhZFN0ZGluU291cmNlLFxuKTogR2l0R3VhcmRDbGlSZXN1bHQge1xuICBjb25zdCBzZXBhcmF0b3IgPSBhcmd2LmluZGV4T2YoXCItLVwiKTtcbiAgaWYgKHNlcGFyYXRvciA8IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgZXhpdENvZGU6IDIsXG4gICAgICBzdGRvdXQ6IEdJVF9HVUFSRF9SRUZVU0VfTUFSS0VSLFxuICAgICAgc3RkZXJyOlxuICAgICAgICBcIltTRUNVUklUWV0gW0dJVF9HVUFSRF9FUlJPUl0gbWlzc2luZyAnLS0nIHNlcGFyYXRvciBiZWZvcmUgdGhlIGdpdCBcIiArXG4gICAgICAgIFwiYXJndW1lbnRzXCIsXG4gICAgfTtcbiAgfVxuICBjb25zdCBnaXRBcmd2ID0gYXJndi5zbGljZShzZXBhcmF0b3IgKyAxKSBhcyBzdHJpbmdbXTtcblxuICAvLyBBIHN0ZGluIG1lc3NhZ2UgaXMgcmVhZCBhdCBtb3N0IG9uY2UgYW5kIHJlcG9ydGVkIGhlcmUgcmF0aGVyIHRoYW5cbiAgLy8gaW5mZXJyZWQgZnJvbSBhcmd2OiBpdHMgdHdvIGFyZ3VtZW50cyBhcmUgcmV3cml0dGVuIHdoZXRoZXIgb3Igbm90IGFcbiAgLy8gc2VjcmV0IHdhcyBmb3VuZCwgc28gYW4gYXJndiBjb21wYXJpc29uIHdvdWxkIGNsYWltIGEgcmVkYWN0aW9uIG9uIGV2ZXJ5XG4gIC8vIHBpcGVkIGNvbW1pdC5cbiAgbGV0IHN0ZGluQ29uc3VtZWQgPSBmYWxzZTtcbiAgbGV0IHJlZGFjdGVkID0gZmFsc2U7XG4gIGNvbnN0IHNvdXJjZXM6IE1lc3NhZ2VTb3VyY2VzID0ge1xuICAgIHJlYWRNZXNzYWdlRmlsZSxcbiAgICBzdGRpbjoge1xuICAgICAgcmVhZDogKCkgPT4ge1xuICAgICAgICAvLyBPbmUgY29tbWFuZCwgb25lIHJlYWQuIGBnaXQgY29tbWl0IC1GIC0gLUYgLWAgd291bGQgb3RoZXJ3aXNlIGJlXG4gICAgICAgIC8vIGhhbmRlZCB0aGUgc2FtZSB0ZXh0IHR3aWNlLCB3aGVyZSB0aGUgcmVhbCBgZ2l0YCBzZWVzIHRoZSBtZXNzYWdlXG4gICAgICAgIC8vIG9uY2UgYW5kIHRoZW4gYW4gZW1wdHkgc3RyZWFtLlxuICAgICAgICBpZiAoc3RkaW5Db25zdW1lZCkge1xuICAgICAgICAgIHRocm93IG5ldyBVbnJlZGFjdGFibGVNZXNzYWdlRXJyb3IoXG4gICAgICAgICAgICBcIi1cIixcbiAgICAgICAgICAgIFwidGhpcyBnaXQgY29tbWFuZCBuYW1lcyBzdGRpbiBhcyBpdHMgbWVzc2FnZSBzb3VyY2UgbW9yZSB0aGFuIFwiICtcbiAgICAgICAgICAgICAgXCJvbmNlLCBhbmQgYSBzdHJlYW0gY2FuIGJlIHJlYWQgb25seSBvbmNlXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBzdGRpbkNvbnN1bWVkID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuIHN0ZGluLnJlYWQoKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICBvbk1hc2tlZDogKCkgPT4ge1xuICAgICAgcmVkYWN0ZWQgPSB0cnVlO1xuICAgIH0sXG4gIH07XG5cbiAgbGV0IGdpdEFyZ3M6IHN0cmluZ1tdO1xuICB0cnkge1xuICAgIGdpdEFyZ3MgPSByZWRhY3RHaXRNZXNzYWdlQXJncyhnaXRBcmd2LCBzb3VyY2VzKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKCEoZXJyIGluc3RhbmNlb2YgVW5yZWRhY3RhYmxlTWVzc2FnZUVycm9yKSkgdGhyb3cgZXJyO1xuICAgIHJldHVybiB7XG4gICAgICBleGl0Q29kZTogMSxcbiAgICAgIHN0ZG91dDogR0lUX0dVQVJEX1JFRlVTRV9NQVJLRVIsXG4gICAgICBzdGRlcnI6IGBbU0VDVVJJVFldIFtHSVRfTUVTU0FHRV9VTlJFREFDVEFCTEVdICR7ZXJyLm1lc3NhZ2V9YCxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBleGl0Q29kZTogMCxcbiAgICBzdGRvdXQ6IHN0ZGluQ29uc3VtZWRcbiAgICAgID8gR0lUX0dVQVJEX0FMTE9XX1NURElOX01BUktFUlxuICAgICAgOiBHSVRfR1VBUkRfQUxMT1dfTUFSS0VSLFxuICAgIHN0ZGVycjogcmVkYWN0ZWRcbiAgICAgID8gXCJbU0VDVVJJVFldIFtHSVRfTUVTU0FHRV9SRURBQ1RFRF0gYSBzZWNyZXQgd2FzIG1hc2tlZCBpbiB0aGUgXCIgK1xuICAgICAgICBcIm1lc3NhZ2Ugb2YgdGhpcyBnaXQgY29tbWFuZCBiZWZvcmUgaXQgcmVhY2hlZCBoaXN0b3J5LlwiXG4gICAgICA6IFwiXCIsXG4gICAgZ2l0QXJncyxcbiAgfTtcbn1cblxuLyoqXG4gKiBSZWFkIHRoZSBzdGRpbiBtZXNzYWdlIHRoaXMgYXJndiBuZWVkcywgYXMgYSBzb3VyY2UgcmVkYWN0aW9uIGNhbiByZXBsYXkuXG4gKlxuICogUmVkYWN0aW9uIGlzIHN5bmNocm9ub3VzIGFuZCB0aGUgcmVhZCBpcyBub3Qg4oCUIGl0IGlzIGJvdW5kZWQgYnkgYSBkZWFkbGluZSBzb1xuICogYSBzdHJlYW0gbm9ib2R5IGNsb3NlcyBjYW5ub3QgaG9sZCB0aGUgYWdlbnQncyBgZ2l0YCBvcGVuIOKAlCBzbyB0aGUgbWVzc2FnZSBpc1xuICogcmVhZCBmaXJzdCBhbmQgaGFuZGVkIG92ZXIgYWxyZWFkeSBpbiBoYW5kLiBBIHJlYWQgdGhhdCByZWZ1c2VzIGlzIGNhcnJpZWRcbiAqIGludG8gdGhlIHNvdXJjZSwgc28gdGhlIHJlZnVzYWwgcmVhY2hlcyB0aGUgY2FsbGVyIHRocm91Z2ggdGhlIHNhbWUgcGF0aCBhc1xuICogZXZlcnkgb3RoZXIgdW5zY2FubmFibGUgbWVzc2FnZS5cbiAqXG4gKiBAcGFyYW0gZ2l0QXJndiAtIFRoZSBgZ2l0YCBhcmd1bWVudHMsIGFmdGVyIHRoZSBgLS1gIHNlcGFyYXRvci5cbiAqIEByZXR1cm5zIFRoZSBzb3VyY2UgdG8gZXZhbHVhdGUgdGhpcyBjb21tYW5kIHdpdGguXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0ZGluU291cmNlRm9yKFxuICBnaXRBcmd2OiByZWFkb25seSBzdHJpbmdbXSxcbik6IFByb21pc2U8U3RkaW5NZXNzYWdlU291cmNlPiB7XG4gIGlmICghdXNlc1N0ZGluTWVzc2FnZShnaXRBcmd2KSkgcmV0dXJuIHVucmVhZFN0ZGluU291cmNlO1xuICB0cnkge1xuICAgIHJldHVybiBwcmVSZWFkU3RkaW5Tb3VyY2UoYXdhaXQgcmVhZFByb2Nlc3NTdGRpbk1lc3NhZ2UoKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmICghKGVyciBpbnN0YW5jZW9mIFVucmVkYWN0YWJsZU1lc3NhZ2VFcnJvcikpIHRocm93IGVycjtcbiAgICByZXR1cm4ge1xuICAgICAgcmVhZDogKCkgPT4ge1xuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9LFxuICAgIH07XG4gIH1cbn1cblxuaWYgKGltcG9ydC5tZXRhLm1haW4pIHtcbiAgLy8gVGhlIHJlZnVzYWwgcmVhc29uIHF1b3RlcyBhIHBhdGggZnJvbSB0aGUgYWdlbnQncyBvd24gYXJndiwgd2hpY2ggaXMgd2hlcmVcbiAgLy8gYSBjcmVkZW50aWFsIGNhbiByaWRlIGluOyB0aGUgTlVMLWVuY29kZWQgdmVyZGljdCBpcyB3cml0dGVuIHRocm91Z2hcbiAgLy8gYERlbm8uc3Rkb3V0YCBhbmQgaXMgdW50b3VjaGVkIGJ5IHRoZSBwYXRjaC5cbiAgaW5zdGFsbENvbnNvbGVSZWRhY3Rpb24oKTtcblxuICBjb25zdCBzZXBhcmF0b3IgPSBEZW5vLmFyZ3MuaW5kZXhPZihcIi0tXCIpO1xuICBjb25zdCBzdGRpbiA9IGF3YWl0IHN0ZGluU291cmNlRm9yKFxuICAgIHNlcGFyYXRvciA8IDAgPyBbXSA6IERlbm8uYXJncy5zbGljZShzZXBhcmF0b3IgKyAxKSxcbiAgKTtcbiAgY29uc3QgcmVzdWx0ID0gcnVuR2l0R3VhcmRDbGkoRGVuby5hcmdzLCBkZW5vTWVzc2FnZUZpbGVSZWFkZXIsIHN0ZGluKTtcbiAgYXdhaXQgRGVuby5zdGRvdXQud3JpdGUoXG4gICAgbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKGVuY29kZUdpdEd1YXJkU3Rkb3V0KHJlc3VsdCkpLFxuICApO1xuICBpZiAocmVzdWx0LnN0ZGVycikgY29uc29sZS5lcnJvcihyZXN1bHQuc3RkZXJyKTtcbiAgRGVuby5leGl0KHJlc3VsdC5leGl0Q29kZSk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7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
// denoCacheMetadata=5872663377602965901,9188282672898128759