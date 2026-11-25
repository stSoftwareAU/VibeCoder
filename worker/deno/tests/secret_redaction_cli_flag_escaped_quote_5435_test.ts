/**
 * Regression tests for Issue #5435 — the `secret-cli-flag` rule read a
 * credential flag's quoted value up to the first quote of the same kind, so an
 * escaped quote (`--token "ab\"cd"`, `--password 'ab''cd'`) masked only the
 * leading part and published the rest. The walk's two copies of the flag
 * pattern read the value the same way and now share the rule's value.
 *
 * These tests assert the exact output `redactSecrets` produces for each shape,
 * that `containsSecret` is false on that output, that a second pass changes
 * nothing, and that the secret tail is gone. The controls keep the base
 * behaviour for a plain quoted value and for an escape that never closes. The
 * linearity cases assert output only, with no stopwatch, as in
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

Deno.test("Issue #5435: double-quoted flag value with an escaped double quote is masked whole", () => {
  const input = String.raw`--token "ab\"cdSECRETtail"`;
  assertEquals(containsSecret(input), true);
  assertRedacts(input, `--token ***REDACTED***`, "cdSECRETtail");
});

Deno.test("Issue #5435: single-quoted flag value with an escaped single quote is masked whole", () => {
  const input = String.raw`--token 'ab\'cdSECRETtail'`;
  assertEquals(containsSecret(input), true);
  assertRedacts(input, `--token ***REDACTED***`, "cdSECRETtail");
});

Deno.test("Issue #5435: single-quoted flag value with a doubled quote is masked whole", () => {
  const input = `--password 'ab''cdSECRETtail' next`;
  assertEquals(containsSecret(input), true);
  assertRedacts(input, `--password ***REDACTED*** next`, "cdSECRETtail");
});

Deno.test("Issue #5435: shell '\\'' idiom in a flag value is masked whole and the next flag kept", () => {
  const input = String.raw`--password 'it'\''s cdSECRETtail' --verbose`;
  assertEquals(containsSecret(input), true);
  assertRedacts(
    input,
    `--password ***REDACTED*** --verbose`,
    "cdSECRETtail",
  );
});

Deno.test("Issue #5435: escaped quote followed by whitespace does not stop the mask at the whitespace", () => {
  const input = String.raw`run --api-key "x\" cdSECRET tail" next`;
  assertEquals(containsSecret(input), true);
  assertRedacts(
    input,
    `run --api-key ***REDACTED*** next`,
    "cdSECRET tail",
  );
});

Deno.test("Issue #5435: text glued after the closing quote is kept", () => {
  const input = String.raw`--api-key "x\"cdSECRETtail"rest`;
  assertEquals(containsSecret(input), true);
  assertRedacts(input, `--api-key ***REDACTED***rest`, "cdSECRETtail");
});

Deno.test("Issue #5435: walk in step with an assignment label before the flag", () => {
  const input = String.raw`token: --token "ab\"cdSECRETtail" next`;
  assertEquals(containsSecret(input), true);
  assertRedacts(
    input,
    `token: --token ***REDACTED*** next`,
    "cdSECRETtail",
  );
});

Deno.test("Issue #5435: walk in step when an inner label sits inside an escaped flag value", () => {
  const input = String.raw`--password 'al\'pha beta TOKEN='tail`;
  assertEquals(containsSecret(input), true);
  assertRedacts(
    input,
    `--password ***REDACTED******REDACTED***`,
    "pha beta",
  );
});

Deno.test("Issue #5435: walk in step when a label follows the escaped flag value", () => {
  const input = String.raw`--password 'x\' secrets: DEPLOY_TOKEN': y`;
  assertEquals(containsSecret(input), true);
  assertRedacts(
    input,
    `--password ***REDACTED***: ***REDACTED***`,
    "DEPLOY_TOKEN",
  );
});

Deno.test("Issue #5435: control, a plain quoted flag value is masked whole", () => {
  assertRedacts(
    `--token "plain value" after`,
    `--token ***REDACTED*** after`,
    "plain value",
  );
});

Deno.test("Issue #5435: control, an escape that never closes falls back to the first quote", () => {
  assertRedacts(
    String.raw`--token "C:\dir\" more`,
    `--token ***REDACTED*** more`,
    "C:\\dir",
  );
});

Deno.test("Issue #5435: control, an escaped backslash before the closing quote closes the value", () => {
  assertRedacts(
    String.raw`--token "a\\" next`,
    `--token ***REDACTED*** next`,
    "a\\",
  );
});

Deno.test("Issue #5435: linearity, escapes past the bound fall back to the first quote", () => {
  const input = `--token "` + String.raw`\"`.repeat(20000) + ` tail`;
  const expected = `--token ***REDACTED***` + String.raw`\"`.repeat(19999) +
    ` tail`;
  assertEquals(redactSecrets(input), expected);
});

Deno.test("Issue #5435: linearity, many escaped flag values in one text", () => {
  const input = String.raw`--token "a\"b" `.repeat(5000);
  assertEquals(redactSecrets(input), `--token ***REDACTED*** `.repeat(5000));
});

Deno.test("Issue #5435: linearity, a long run of doubled single quotes", () => {
  const input = `--password '` + `''`.repeat(20000) + `x`;
  const output = redactSecrets(input);
  assert(output.startsWith(`--password ***REDACTED***`));
  assertEquals(redactSecrets(output), output);
  // The escape-aware branch takes the opening quote, 4,096 doubled quotes and
  // a closing quote (8,194 characters); the rest of the run and the final `x` stay as they were.
  assertEquals(output, `--password ***REDACTED***` + "'".repeat(31807) + "x");
});

Deno.test("a quote shared with a following flag protects both values", () => {
  const sentinel = "fixture".repeat(5);
  for (const q of ["'", '"']) {
    for (const gap of [" ", "\n"]) {
      for (
        const before of [
          `echo ${q}missing token:${q}`,
          `--secret-dir ${q}private-path\\${q}`,
          ...(q === "'"
            ? [
              "--secret-dir 'private-path''",
              "--secret-dir 'private-path'\\''",
            ]
            : []),
        ]
      ) {
        const input = `${before}${gap}--token ${q}${sentinel}${q}`;
        const once = redactSecrets(input);
        assertEquals(once.includes(sentinel), false, before);
        assertEquals(once.includes("private-path"), false, before);
        assertEquals(redactSecrets(once), once, before);
        assertEquals(containsSecret(once), false, before);
      }
    }
  }
});
