/**
 * Regression tests for Issue #5363 — a bare `secret-assignment` value that
 * starts at the closing quote of a credential flag's quoted value.
 *
 * In `--password 'alpha beta TOKEN='tail` the bare value of `TOKEN=` opens at
 * the flag's closing quote (`'tail`). The assignment mask replaced that quote
 * along with the value, so the `secret-cli-flag` rule found no closing quote,
 * fell back to `\S+` and masked only `'alpha`, publishing `beta`. The fix keeps
 * that quote in front of the placeholder when the flag's opening quote lies
 * outside every assignment mask, so the flag rule pairs the two.
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

Deno.test("Issue #5363: bare value opening at a flag's closing quote keeps that quote", () => {
  assertRedacts(
    "--password 'alpha beta TOKEN='tail",
    `--password ${R}${R}`,
    ["beta"],
  );
});

Deno.test("Issue #5363: closing quote kept mid-sentence and the following word survives", () => {
  assertRedacts(
    "deploy --password 'correct horse battery staple TOKEN:'tail more",
    `deploy --password ${R}${R} more`,
    ["horse", "battery", "staple"],
  );
});

Deno.test("Issue #5363: later flag after the kept quote is masked and the next flag survives", () => {
  assertRedacts(
    "run --api-key 'first second API_KEY='q7Lm2Xv9 --verbose",
    `run --api-key ${R}${R} --verbose`,
    ["second", "q7Lm2Xv9"],
  );
});

Deno.test("Issue #5363: a word after the kept quote's flag survives the walk", () => {
  assertRedacts(
    "curl --token 'one two three password: 'x; echo done",
    `curl --token ${R}${R} echo done`,
    ["two", "three"],
  );
});

Deno.test("Issue #5363: newline-separated label still keeps the flag's closing quote", () => {
  assertRedacts(
    "--password 'alpha beta\nTOKEN='tail",
    `--password ${R}${R}`,
    ["beta"],
  );
});

// Controls: these pass on the unfixed code as well. They pin that only a
// flag's closing quote is kept in front of the placeholder.

Deno.test("Issue #5363: control - an unclosed quote that closes no flag value is still masked with the value", () => {
  assertRedacts("x TOKEN='tail", `x TOKEN=${R}`, ["tail"]);
});

Deno.test("Issue #5363: control - a flag whose value closed earlier leaves the later assignment fully masked", () => {
  assertRedacts(
    "--password 'a b' TOKEN='tail",
    `--password ${R} TOKEN=${R}`,
    ["tail"],
  );
});

Deno.test("Issue #5363: control - bare values stop at a double quote, so a double quote is never kept", () => {
  assertRedacts(
    `--password "alpha beta TOKEN="tail`,
    `--password ${R}tail`,
    ["alpha", "beta"],
  );
});

Deno.test("Issue #5363: a long run of flags keeps the closing quote in linear time (output only)", () => {
  const run = "--token 'a b' ".repeat(20_000);
  const output = redactSecrets(run + "--password 'alpha beta TOKEN='tail");
  assertEquals(
    output,
    `--token ${R} `.repeat(20_000) + `--password ${R}${R}`,
  );
});
