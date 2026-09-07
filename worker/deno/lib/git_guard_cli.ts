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
 * verdict from a broken guard. The shim proceeds only on
 * {@link GIT_GUARD_ALLOW_MARKER}; anything else — a refusal, a crash, an empty
 * stdout — refuses the `git` call.
 *
 * Exit codes accompany the marker: `0` allowed, `1` refused because the
 * message could not be scanned, `2` malformed invocation.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type MessageFileReader,
  redactGitMessageArgs,
  UnredactableMessageError,
} from "./git_message_redaction.ts";
import { installConsoleRedaction } from "./console_redaction.ts";
import { encodeNulFields } from "./guard_field_encoding.ts";

/** Printed on stdout when — and only when — the command may proceed. */
export const GIT_GUARD_ALLOW_MARKER = "VIBE_GIT_GUARD_ALLOW";

/** Printed on stdout when the guard refused the command. */
export const GIT_GUARD_REFUSE_MARKER = "VIBE_GIT_GUARD_REFUSE";

/** Outcome of one guard evaluation. */
export interface GitGuardCliResult {
  /** Process exit code (see the module comment for the contract). */
  exitCode: number;
  /** Verdict marker to write to stdout. */
  stdout: string;
  /** Line to write to stderr, or empty when nothing needed saying. */
  stderr: string;
  /**
   * The arguments the shim must run — message arguments redacted. Present
   * only when the command is allowed.
   */
  gitArgs?: string[];
}

/** Production message-file reader — used when the caller supplies none. */
const denoMessageFileReader: MessageFileReader = (path) =>
  Deno.readTextFileSync(path);

/**
 * Frame a verdict for the shim: the marker, then the argv to run, each field
 * NUL-terminated.
 *
 * @param result - The evaluation to frame.
 * @returns The exact bytes to write to stdout.
 */
export function encodeGitGuardStdout(result: GitGuardCliResult): string {
  return encodeNulFields([result.stdout, ...(result.gitArgs ?? [])]);
}

/**
 * Evaluate one shim invocation.
 *
 * @param argv - The guard's own argv: `--`, then the `git` arguments.
 * @param readMessageFile - Reader for `-F <path>` contents (test seam).
 * @returns The exit code, the stderr line to emit, and — when allowed — the
 *   arguments the shim must run.
 */
export function runGitGuardCli(
  argv: readonly string[],
  readMessageFile: MessageFileReader = denoMessageFileReader,
): GitGuardCliResult {
  const separator = argv.indexOf("--");
  if (separator < 0) {
    return {
      exitCode: 2,
      stdout: GIT_GUARD_REFUSE_MARKER,
      stderr:
        "[SECURITY] [GIT_GUARD_ERROR] missing '--' separator before the git " +
        "arguments",
    };
  }
  const gitArgv = argv.slice(separator + 1) as string[];

  let gitArgs: string[];
  try {
    gitArgs = redactGitMessageArgs(gitArgv, readMessageFile);
  } catch (err) {
    if (!(err instanceof UnredactableMessageError)) throw err;
    return {
      exitCode: 1,
      stdout: GIT_GUARD_REFUSE_MARKER,
      stderr: `[SECURITY] [GIT_MESSAGE_UNREDACTABLE] ${err.message}`,
    };
  }

  const redacted = gitArgs.some((arg, i) => arg !== gitArgv[i]);
  return {
    exitCode: 0,
    stdout: GIT_GUARD_ALLOW_MARKER,
    stderr: redacted
      ? "[SECURITY] [GIT_MESSAGE_REDACTED] a secret was masked in the " +
        "message of this git command before it reached history."
      : "",
    gitArgs,
  };
}

if (import.meta.main) {
  // The refusal reason quotes a path from the agent's own argv, which is where
  // a credential can ride in; the NUL-encoded verdict is written through
  // `Deno.stdout` and is untouched by the patch.
  installConsoleRedaction();

  const result = runGitGuardCli(Deno.args);
  await Deno.stdout.write(
    new TextEncoder().encode(encodeGitGuardStdout(result)),
  );
  if (result.stderr) console.error(result.stderr);
  Deno.exit(result.exitCode);
}
