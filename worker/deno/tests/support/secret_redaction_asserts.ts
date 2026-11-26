import { assert, assertEquals } from "@std/assert";
import { containsSecret, redactSecrets } from "../../lib/secret_redaction.ts";

/** Asserts the exact redaction, detection, idempotence and absence of leaks. */
export function assertRedacts(
  input: string,
  expected: string,
  leaked: readonly string[],
): void {
  const output = redactSecrets(input);
  assertEquals(output, expected);
  assertEquals(containsSecret(input), true);
  assertEquals(containsSecret(output), false);
  assertEquals(redactSecrets(output), output);
  for (const word of leaked) {
    assert(!output.includes(word), `"${word}" survived in: ${output}`);
  }
}
