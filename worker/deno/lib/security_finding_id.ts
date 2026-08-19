/**
 * Deterministic security finding ID generator (Issue #1938).
 *
 * The ID is the first 12 hex characters of SHA-256 over
 * `repo + '|' + class + '|' + file + '|' + normalise(snippet)`, prefixed
 * with `SEC-` for unambiguous issue searches.
 *
 * Identifiers are case-sensitive on purpose: renaming a variable is a
 * real change to the code and should produce a new finding ID. We only
 * normalise whitespace (trim per line, collapse internal runs, drop
 * blank lines) — case and identifier spelling are preserved verbatim.
 *
 * Pure function, no I/O. Uses Australian English throughout.
 */

export interface FindingIdInput {
  /** `owner/repo` of the source repository the finding came from. */
  repo: string;
  /** Vulnerability class (e.g. `sql-injection`, `xss`). */
  class: string;
  /** Path to the offending file, relative to the repo root. */
  file: string;
  /** The code snippet flagged by the scanner. */
  snippet: string;
}

/**
 * Normalise a snippet for stable hashing.
 *
 * - Trim leading/trailing whitespace on each line.
 * - Collapse runs of internal whitespace (spaces, tabs) to a single space.
 * - Drop blank lines entirely.
 *
 * Case is preserved — see file-level comment for rationale.
 */
function normalise(snippet: string): string {
  return snippet
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]+/g, " "))
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Compute the stable finding ID for a scan result.
 *
 * Returns `SEC-` followed by the first 12 hex characters of the SHA-256
 * digest. The async signature is forced by `crypto.subtle.digest`.
 */
export async function computeFindingId(input: FindingIdInput): Promise<string> {
  const canonical = [
    input.repo,
    input.class,
    input.file,
    normalise(input.snippet),
  ].join("|");
  const encoded = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `SEC-${hex.slice(0, 12)}`;
}
