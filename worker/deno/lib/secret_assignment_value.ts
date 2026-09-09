/**
 * Classify an assignment value without mistaking Markdown for a credential.
 *
 * The generic prose label `credential:` is ambiguous, so a short plain word
 * or a sentence is not enough evidence. Explicit assignment syntax and other
 * secret-bearing keys retain their existing short-value protection. Known
 * provider-token signatures are checked independently by the caller.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */
export function isPlausibleSecretAssignmentValue(
  value: string,
  key = "credential",
  separator = ":",
  following = "",
): boolean {
  // These are Markdown structure, never an assignment's scalar value.
  if (
    /^(?:`|~{3,}|#{1,6}(?:\s|$)|[-*+]\s|\d+[.)]\s|>\s?|\||!?\[)/.test(value)
  ) {
    return false;
  }

  let scalar = value;
  let quoted = false;
  if (
    (scalar.startsWith('"') && scalar.endsWith('"')) ||
    (scalar.startsWith("'") && scalar.endsWith("'"))
  ) {
    scalar = scalar.slice(1, -1);
    quoted = true;
  }
  if (scalar.startsWith("**") && scalar.endsWith("**") && scalar.length > 4) {
    scalar = scalar.slice(2, -2);
  }
  if (!/[A-Za-z0-9]/.test(scalar) || scalar.includes("***REDACTED***")) {
    return false;
  }

  // Only a bare, lower-case prose label is ambiguous. Preserve the old
  // behaviour for API_KEY=abc, "token":"abc", PASSWORD: hunter2, etc.
  const narrative = key === "credential" && !/[="']/.test(separator);
  if (!narrative) return true;

  // A quoted value is explicit, including a short password or one with spaces.
  if (quoted) return true;
  // Do not mistake the first word of a sentence for its credential.
  if (
    /^[A-Za-z]+$/.test(scalar) &&
    /^[^\S\r\n]+[A-Za-z]/.test(following)
  ) {
    return false;
  }
  // A short plain word is weak evidence. Digits or punctuation make a short
  // scalar more credential-like, and must not be discarded by the length rule.
  return scalar.length >= 8 || !/^[A-Za-z]+$/.test(scalar);
}
