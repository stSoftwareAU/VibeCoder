/**
 * Loud reporting for state-file load failures (Issue #3649, SEC-6b03e9d5127f).
 *
 * The circuit breaker and the per-issue cooldown both fall back to empty
 * state when their JSON file cannot be read, parsed, or validated. That
 * fallback is the right recovery, but it was silent: one junk byte in a file
 * sitting in the parent of the agent's clone reset all backoff and cleared
 * every cooldown with nothing in the log to say so, which is
 * indistinguishable from a clean first run.
 *
 * A *missing* file is the ordinary first-run case and stays quiet. Anything
 * else is a fault and must be visible — see the "Never Fail Silently — Fail
 * Loud" rule in CODING-STANDARDS.md.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Report that a state file could not be loaded and its contents were
 * discarded.
 *
 * @param stateName - Human name of the state, e.g. `"cooldown state"`
 * @param path - Path that was read
 * @param cause - The thrown value, or a synthetic `Error` for a failed
 *   structural validation
 * @param warn - Sink for the notice (defaults to `console.error`)
 * @returns `true` when a notice was emitted, `false` for a missing file
 */
export function reportStateLoadFailure(
  stateName: string,
  path: string,
  cause: unknown,
  warn: (message: string) => void = (message) => console.error(message),
): boolean {
  if (cause instanceof Deno.errors.NotFound) return false;

  const detail = cause instanceof Error ? cause.message : String(cause);
  warn(
    `[STATE_LOAD_FAILURE] ${stateName} at ${path} could not be loaded ` +
      `(${detail}) — falling back to empty state, so every recorded entry ` +
      `has been discarded.`,
  );
  return true;
}
