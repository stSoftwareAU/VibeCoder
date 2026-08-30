/**
 * Recognising a transient network failure so it does not end the cycle as a
 * crash (Issue #644).
 *
 * A run on GRQ-23 spent 7.5 minutes on startup — housekeeping, milestone
 * sync, sixteen repositories scanned — reached its maintenance lane, and then
 * died on one blip:
 *
 *     11:25:16Z ERROR: Fatal error in main loop: gh command failed (exit 1):
 *               Post "https://api.github.com/graphql": unexpected EOF
 *     FAILED: Run complete: Fatal error: … (0 issues processed in 454.607s)
 *
 * Zero issues processed. The next cycle started from nothing, and the host's
 * launcher counted a crash — five consecutive by the time anyone looked, past
 * the escalation threshold, all of them the same flaky link rather than
 * anything broken in the worker.
 *
 * The precedent is already in `run_core.ts`: a primary rate limit does NOT
 * crash the run. It logs that the quota is gone, exits under its own status,
 * and the next cycle picks up. The reasoning transfers exactly — the run is
 * ending because the network went away, not because anything broke — and a
 * transient failure recorded as a crash is worse than useless: it spends the
 * escalation budget on a fault nobody can act on and buries the real ones.
 *
 * This is deliberately about CLASSIFICATION, not retrying. Retrying belongs at
 * the `gh` chokepoint; what this fixes is a cycle ending in a way that
 * misreports its own cause.
 *
 * Australian English spelling throughout (behaviour, recognise).
 */

/**
 * Fragments that identify a network fault rather than a fault in the work.
 *
 * Every one is a transport-layer failure: the request never got an answer the
 * worker could act on. Matched case-insensitively against the error message.
 *
 * Deliberately NOT included: `404`, `403`, `422`, and anything else the server
 * answered deliberately. Those are real outcomes that mean something, and
 * treating them as transient would retry-and-forget a genuine bug — the exact
 * mistake this module must not make in the other direction.
 */
const TRANSIENT_NETWORK_PATTERNS: ReadonlyArray<string> = [
  // Go's net/http, which is what `gh` reports through.
  "unexpected eof",
  "connection refused",
  "connection reset by peer",
  "broken pipe",
  "i/o timeout",
  "tls handshake timeout",
  "client connection force closed",
  "server closed idle connection",
  "eof", // bare EOF from a truncated response body
  // DNS.
  "no such host",
  "could not resolve host",
  "could not resolve hostname",
  "temporary failure in name resolution",
  "nodename nor servname provided",
  // Node/libuv spellings, in case a helper surfaces them.
  "econnrefused",
  "econnreset",
  "etimedout",
  "enotfound",
  "eai_again",
  // gh's own wording when it cannot reach the API at all.
  "error connecting to api.github.com",
  // Gateway-class responses: the edge answered, the origin did not.
  "502 bad gateway",
  "503 service unavailable",
  "504 gateway timeout",
];

/**
 * Is this error message a transient network failure?
 *
 * @param message - The error message, as reported by `gh` or a git command.
 */
export function isTransientNetworkFailure(message: string): boolean {
  const haystack = message.toLowerCase();
  return TRANSIENT_NETWORK_PATTERNS.some((pattern) =>
    haystack.includes(pattern)
  );
}

/**
 * The line the run logs when it stops for this reason.
 *
 * It says the network went away and that the next cycle will retry, so a
 * reader does not go looking for a fault in the worker — the confusion the
 * bare "Fatal error in main loop" caused for a whole day of these.
 */
export function formatTransientNetworkHalt(
  message: string,
  issuesProcessed: number,
): string {
  const progress = issuesProcessed > 0
    ? `${issuesProcessed} issue(s) were processed before it did`
    : "no issues had been processed yet";
  return `Main loop halting: the network failed, not the worker — ${progress}. ` +
    `The next cycle retries from a clean start. ${message}`;
}
