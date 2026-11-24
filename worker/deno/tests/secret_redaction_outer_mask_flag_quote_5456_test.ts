/**
 * Regression tests for Issue #5456 — a credential flag's closing quote that sits
 * inside an outer label's value the `secret-assignment` walk masks whole.
 *
 * In `--token 'alpha beta credentials: TOKEN='tail` the outer label
 * `credentials:` has a bare value `TOKEN='tail`, which the walk masks whole. That
 * mask contains the flag's closing quote (`'tail`), so the quote was masked away
 * with the value. The `secret-cli-flag` rule then found no closing quote, fell
 * back to `\S+` and masked only `'alpha`, publishing `beta credentials:`. The fix
 * keeps the quote in front of the placeholder when the flag's opening quote lies
 * outside every assignment mask. An interior quote is kept when no later quote
 * of that kind survives, or that quote lies past another flag whose value starts
 * outside every mask. Otherwise the flag rule pairs with the later quote and
 * masks through it (the outcome the Issue #5310 round 13 tests pin). The base
 * code leaks `beta` on the simple later-quote shape too, so it is a regression
 * case, not a control.
 * A bare value that starts at the quote is always kept, as in Issue #5363.
 *
 * These tests assert the exact output `redactSecrets` produces, that
 * `containsSecret` is false on that output, that a second pass changes nothing,
 * and that the leaked words are gone. The controls pass on the unfixed code
 * too: they pin that only a flag's closing quote is kept. The size case asserts
 * output only, with no stopwatch, as in `secret_redaction_redos_test.ts`.
 */

import { assertEquals } from "@std/assert";
import { redactSecrets } from "../lib/secret_redaction.ts";
import { assertRedacts } from "./support/secret_redaction_asserts.ts";

const R = "***REDACTED***";

Deno.test("Issue #5456: outer label's masked value containing a flag's closing quote keeps that quote", () => {
  assertRedacts(
    "--token 'alpha beta credentials: TOKEN='tail",
    `--token ${R}${R}`,
    ["beta", "tail"],
  );
});

Deno.test("Issue #5456: mid-line outer label keeps the quote and the following word survives", () => {
  assertRedacts(
    "--password 'alpha beta gamma secret: PASSWORD='rest of line",
    `--password ${R}${R} of line`,
    ["beta", "gamma"],
  );
});

Deno.test("Issue #5456: flag after a command word keeps the quote with the outer label", () => {
  assertRedacts(
    "run --api-key 'one two three credentials: API_KEY='x",
    `run --api-key ${R}${R}`,
    ["two", "three"],
  );
});

Deno.test("Issue #5456: outer bare value with no inner label keeps the flag's closing quote", () => {
  assertRedacts(
    "--token 'alpha beta credentials: abc'def more",
    `--token ${R}${R} more`,
    ["beta", "abc", "def"],
  );
});

Deno.test("Issue #5456: a later flag after the kept quote is masked and the next flag survives", () => {
  assertRedacts(
    "--token 'one two password: TOKEN='z --verbose",
    `--token ${R}${R} --verbose`,
    ["two"],
  );
});

Deno.test("Issue #5456: newline before the outer label keeps the flag's closing quote", () => {
  assertRedacts(
    "--token 'alpha beta\ncredentials: TOKEN='tail",
    `--token ${R}${R}`,
    ["beta"],
  );
});

Deno.test("Issue #5456: CRLF before the outer label keeps the flag's closing quote", () => {
  assertRedacts(
    "--token 'alpha beta\r\ncredentials: TOKEN='tail",
    `--token ${R}${R}`,
    ["beta", "tail"],
  );
});

Deno.test("Issue #5456: a later bare mask that masks the surviving quote away leaves the kept quote needed", () => {
  assertRedacts(
    "--token 'alpha beta credentials: TOKEN='tail x password: a'b",
    `--token ${R}${R} x password: ${R}`,
    ["beta", "tail"],
  );
});

Deno.test("Issue #5456: a later surviving quote of the same kind lets the flag rule mask through it", () => {
  assertRedacts(
    "--token 'alpha beta credentials: TOKEN='tail then it's done",
    `--token ${R}${R}${R}s done`,
    ["beta", "tail", "then"],
  );
});

Deno.test("Issue #5456: consecutive flags retain both closing quotes", () => {
  assertRedacts(
    "--token 'alpha beta credentials: TOKEN='tail --token 'gamma delta credentials: TOKEN='rest",
    `--token ${R}${R} --token ${R}${R}`,
    ["beta", "delta", "tail", "rest"],
  );
});

Deno.test("Issue #5456: a quote inside a later flag's value must not close the earlier flag", () => {
  assertRedacts(
    `--token 'alpha beta credentials: TOKEN='tail --password "gamma delta's tail"`,
    `--token ${R}${R} --password ${R}`,
    ["beta", "gamma", "delta", "tail"],
  );
});

Deno.test("Issue #5456: a quote in a later bare flag value must not close the earlier flag", () => {
  assertRedacts(
    "--token 'alpha beta credentials: TOKEN='tail --password gamma'delta finish",
    `--token ${R}${R} --password ${R} finish`,
    ["beta", "gamma", "delta", "tail"],
  );
});

Deno.test("Issue #5456: a later quote of the other kind does not replace the needed quote", () => {
  assertRedacts(
    `--token 'alpha beta credentials: TOKEN='tail then "public"`,
    `--token ${R}${R} then "public"`,
    ["beta", "tail"],
  );
});

// Controls: these pass on the unfixed code as well. They pin that only a
// flag's closing quote is kept in front of the placeholder.

Deno.test("Issue #5456: control - a quote that closes no flag value is still masked with the value", () => {
  assertRedacts(`x credentials: a'b`, `x credentials: ${R}`, ["a'b"]);
});

Deno.test("Issue #5456: control - a flag value that closed earlier leaves the later mask whole", () => {
  assertRedacts(
    "--password 'a b' credentials: TOKEN='tail",
    `--password ${R} credentials: ${R}`,
    ["tail"],
  );
});

Deno.test("Issue #5456: control - a later quoted assignment retains the quote the flag rule pairs with", () => {
  assertRedacts(
    "--token 'alpha beta credentials: TOKEN='tail password: 'private value' after",
    `--token ${R}${R}' after`,
    ["beta", "tail", "private", "value"],
  );
});

Deno.test("Issue #5456: control - a flag opener inside a quoted assignment stays masked", () => {
  assertRedacts(
    `PASSWORD="--token 'alpha beta credentials: TOKEN='tail"`,
    `PASSWORD="${R}"`,
    ["alpha", "beta", "tail"],
  );
});

Deno.test("Issue #5456: a long run of flags still masks the final credential (output only)", () => {
  const run = "--token 'a b' ".repeat(20_000);
  const output = redactSecrets(
    run + "--token 'alpha beta credentials: TOKEN='tail",
  );
  assertEquals(
    output,
    `--token ${R} `.repeat(20_000) + `--token ${R}${R}`,
  );
});

Deno.test("Issue #5456: repeated outer masks retain each flag's closing quote (output only)", () => {
  assertEquals(
    redactSecrets(
      "--token 'alpha beta credentials: TOKEN='tail\r\n".repeat(20_000),
    ),
    `--token ${R}${R}\r\n`.repeat(20_000),
  );
});
