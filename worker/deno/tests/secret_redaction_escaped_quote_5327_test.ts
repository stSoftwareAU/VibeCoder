/**
 * Regression tests for Issue #5327 — the quoted-value branches of the
 * `secret-assignment` pattern ended at the first quote of the same kind, so an
 * escaped quote (`"abc\"def"`, `'abc\'def'`) or a doubled single quote
 * (`'abc''def'`) masked only the leading part and published the rest.
 *
 * These tests assert the exact output `redactSecrets` produces for each escaped
 * shape, that `containsSecret` is false on that output, that a second pass
 * changes nothing, and that the secret tail is gone. The controls keep the
 * base behaviour for a plain quoted value and for an escape that never closes.
 * The linearity cases (the linearity rule in the `secret_redaction.ts` module
 * header) assert output only, with no stopwatch, as in
 * `secret_redaction_redos_test.ts`.
 */

import { assert, assertEquals } from "@std/assert";
import { containsSecret, redactSecrets } from "../lib/secret_redaction.ts";

/** Asserts the exact redaction, no surviving secret, idempotence and no tail. */
function assertRedacts(input: string, expected: string, tail: string): void {
  const output = redactSecrets(input);
  assertEquals(output, expected);
  assertEquals(containsSecret(output), false);
  assertEquals(redactSecrets(output), output);
  assert(!output.includes(tail), `tail "${tail}" survived in: ${output}`);
}

Deno.test("Issue #5327: JSON value with an escaped double quote is masked whole and still parses", () => {
  const input = String.raw`{"password":"hun\"ter2xyzSecret","user":"bob"}`;
  const expected = String.raw`{"password":"***REDACTED***","user":"bob"}`;
  assertRedacts(input, expected, "ter2xyzSecret");
  assertEquals(JSON.parse(redactSecrets(input)).user, "bob");
});

Deno.test("Issue #5327: shell double-quoted value with an escaped double quote is masked whole", () => {
  assertRedacts(
    String.raw`export API_TOKEN="abc\"defSECRETtail"`,
    `export API_TOKEN="***REDACTED***"`,
    "defSECRETtail",
  );
});

Deno.test("Issue #5327: single-quoted value with a backslash-escaped quote is masked whole", () => {
  assertRedacts(
    String.raw`PASSWORD='abc\'defSECRETtail'`,
    `PASSWORD='***REDACTED***'`,
    "defSECRETtail",
  );
});

Deno.test("Issue #5327: SQL doubled single quote is masked whole", () => {
  assertRedacts(
    "password = 'abc''defSECRETtail';",
    "password = '***REDACTED***';",
    "defSECRETtail",
  );
});

Deno.test("Issue #5327: shell '\\'' idiom is masked whole and the following word is kept", () => {
  assertRedacts(
    String.raw`PASSWORD='it'\''s a secret' next`,
    `PASSWORD='***REDACTED***' next`,
    "s a secret",
  );
});

Deno.test("Issue #5327: text after the escaped quote with no whitespace is kept", () => {
  assertRedacts(
    String.raw`TOKEN="abc\"defSECRETtail"rest`,
    `TOKEN="***REDACTED***"rest`,
    "defSECRETtail",
  );
});

Deno.test("Issue #5327: an escaped backslash before the closing quote closes the value", () => {
  assertRedacts(
    String.raw`{"token":"a\\","x":1}`,
    String.raw`{"token":"***REDACTED***","x":1}`,
    String.raw`a\\`,
  );
});

Deno.test("Issue #5327: a plain quoted value still masks as before", () => {
  assertRedacts(
    String.raw`TOKEN="plainvalue123" x`,
    `TOKEN="***REDACTED***" x`,
    "plainvalue123",
  );
});

Deno.test("Issue #5327: an escape that never closes falls back to the first quote", () => {
  assertRedacts(
    String.raw`TOKEN="C:\dir\"`,
    `TOKEN="***REDACTED***"`,
    String.raw`C:\dir`,
  );
});

Deno.test("Issue #5327: containsSecret is true on each raw escaped input", () => {
  const inputs = [
    String.raw`{"password":"hun\"ter2xyzSecret","user":"bob"}`,
    String.raw`export API_TOKEN="abc\"defSECRETtail"`,
    String.raw`PASSWORD='abc\'defSECRETtail'`,
    "password = 'abc''defSECRETtail';",
    String.raw`PASSWORD='it'\''s a secret' next`,
    String.raw`TOKEN="abc\"defSECRETtail"rest`,
    String.raw`{"token":"a\\","x":1}`,
  ];
  for (const input of inputs) {
    assertEquals(containsSecret(input), true, `not detected: ${input}`);
  }
});

// The `a` after the opening quote puts an alphanumeric inside the rule's
// lookahead (`(?=\S{0,63}[A-Za-z0-9])`), so the escape branches run rather than
// the rule being rejected before they are reached.
Deno.test("Issue #5327 (linearity): an unclosed backslash run passes through unchanged", () => {
  const N = 131_072;
  const input = 'PASSWORD="a' + "\\".repeat(N);
  assertEquals(redactSecrets(input), input);
});

Deno.test("Issue #5327 (linearity): escaped quotes past the bound fall back to the first quote", () => {
  const N = 131_072;
  const input = 'PASSWORD="a' + '\\"'.repeat(N / 2);
  const expected = 'PASSWORD="***REDACTED***"' + '\\"'.repeat(N / 2 - 1);
  assertEquals(redactSecrets(input), expected);
});

Deno.test("Issue #5327 (linearity): a long run of doubled single quotes is masked and the output is final", () => {
  const N = 131_072;
  const input = "PASSWORD='a" + "''".repeat(N / 2) + "x";
  const output = redactSecrets(input);
  assert(
    output.startsWith("PASSWORD='***REDACTED***'"),
    `got: ${output.slice(0, 60)}`,
  );
  assert(output.endsWith("x"));
  assertEquals(containsSecret(output), false);
  assertEquals(redactSecrets(output), output);
});

Deno.test("Issue #5327 (linearity): a long run of shell idioms is masked and the output is final", () => {
  const N = 131_072;
  const input = "PASSWORD='a" + "'\\''".repeat(N / 4);
  const output = redactSecrets(input);
  assert(
    output.startsWith("PASSWORD='***REDACTED***'"),
    `got: ${output.slice(0, 60)}`,
  );
  assertEquals(containsSecret(output), false);
  assertEquals(redactSecrets(output), output);
});
