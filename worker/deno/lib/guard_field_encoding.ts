/**
 * NUL-framed verdict encoding shared by the agent-side guard shims.
 *
 * A guard child hands its wrapper both a verdict marker and the argv to run,
 * and a redacted body or commit message may contain newlines, quotes and
 * backslashes that must survive byte-for-byte. A NUL cannot occur inside a
 * process argument, so it is the one separator the bash wrapper can split on
 * with no encoding step of its own (`read -r -d ''`).
 *
 * Extracted so the `gh` guard (Issue #3938) and the `git` guard (Issue #1284)
 * share one framing rather than two copies that can drift apart.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Frame a verdict marker and the arguments that follow it for a shim.
 *
 * @param fields - The marker first, then each argument to run.
 * @returns The exact bytes to write to stdout.
 */
export function encodeNulFields(fields: readonly string[]): string {
  return fields.map((field) => `${field}\0`).join("");
}
