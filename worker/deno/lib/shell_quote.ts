/**
 * POSIX shell quoting for values that are interpolated into a shell string
 * (Issue #3661, SEC-a228ff008ed4 / SEC-bea501c3a7d7).
 *
 * A value that reaches a shell unquoted is not merely a formatting bug: a path
 * containing a space silently splits into two arguments, and one containing
 * `;`, `$(...)` or a backtick executes. Every place the worker builds a string
 * that a shell will later parse must route the interpolated value through
 * {@link posixSingleQuote} so "no unescaped interpolation into a shell context"
 * is an invariant rather than a per-call-site habit.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Wrap a value in single quotes, safe for any POSIX shell.
 *
 * Inside single quotes every character is literal, so the only character
 * needing treatment is `'` itself: close the quote, emit an escaped quote,
 * reopen (`'\''`). The result is always a single shell word.
 *
 * @param value - The raw value to quote.
 * @returns The value as one single-quoted shell word.
 */
export function posixSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build the `GIT_SSH_COMMAND` value for a service-account SSH key.
 *
 * Git hands `GIT_SSH_COMMAND` to `/bin/sh`, so the key path is shell input,
 * not an argv element. Quoting it keeps a path with a space authenticating
 * with the intended identity instead of silently falling back to the ambient
 * one, and stops a path containing shell metacharacters from executing at
 * every clone, fetch and push.
 *
 * @param keyPath - Absolute path to the private key (already `~`-expanded).
 * @returns The `GIT_SSH_COMMAND` string with the key path quoted.
 */
export function buildGitSshCommand(keyPath: string): string {
  return `ssh -i ${posixSingleQuote(keyPath)} -o IdentitiesOnly=yes`;
}
