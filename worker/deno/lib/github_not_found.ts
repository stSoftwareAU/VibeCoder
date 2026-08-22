/**
 * "Does this issue exist?" — the one definitive-not-found test (Issue #210).
 *
 * Every path that acts on an issue number taken from *model output* has to
 * tell "GitHub says this issue does not exist" apart from "the lookup did not
 * complete". The two demand opposite responses: an absent issue is the
 * agent's mistake and must be reported once and skipped, while a timeout or a
 * 5xx says nothing and must not be turned into a refusal.
 *
 * The wording matters. `gh` reports a missing issue number through GraphQL as
 * `Could not resolve to an issue or pull request with the number of 3952`,
 * which carries neither "not found" nor "404" — so the escape-hatch follow-up
 * label strip read it as a transient error, retried, and raised an ERROR
 * about NEAT-AI-Lamarck#3952, an issue that cannot exist. This module is the
 * single place that recognises all three shapes, shared by the strip and by
 * `escape_hatch_verify.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Recognise a "this issue does not exist" answer from the GitHub API.
 *
 * Definitive shapes: the REST 404 (`Not Found`, `HTTP 404`) and the GraphQL
 * wording `gh` returns for a missing issue number (`Could not resolve to an
 * issue or pull request with the number of N`). Anything else — timeout, 401,
 * 403, 5xx, rate limit — is an inconclusive lookup.
 *
 * @param message - The error message from the failed lookup.
 * @returns true when the API definitively reported the issue as absent.
 */
export function isDefinitiveNotFound(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("not found") ||
    lower.includes("404") ||
    lower.includes("could not resolve to an issue or pull request");
}
