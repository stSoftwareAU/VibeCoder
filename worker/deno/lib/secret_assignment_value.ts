/**
 * Is a scalar plausible as a secret-assignment value (Issue #1727)?
 *
 * The label is not enough evidence by itself: a Markdown fence, list or
 * heading after `credential:` is structure, not a credential. Retain the
 * existing minimum length and scalar character restrictions while allowing
 * quoted and bold-wrapped values. Other signature rules still scan the whole
 * text independently, so this predicate cannot exempt a known token.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */
export function isPlausibleSecretAssignmentValue(value: string): boolean {
  if (
    /^(?:`{3,}|~{3,}|#{1,6}(?:\s|$)|[-*+]\s|\d+[.)]\s|>\s?|\|)/.test(value)
  ) {
    return false;
  }

  let scalar = value;
  if (
    (scalar.startsWith('"') && scalar.endsWith('"')) ||
    (scalar.startsWith("'") && scalar.endsWith("'"))
  ) {
    scalar = scalar.slice(1, -1);
  }
  if (scalar.startsWith("**") && scalar.endsWith("**") && scalar.length > 4) {
    scalar = scalar.slice(2, -2);
  }

  return scalar.length >= 8 &&
    /^[A-Za-z0-9_./+~=-]+$/.test(scalar) &&
    /[A-Za-z0-9]/.test(scalar);
}
