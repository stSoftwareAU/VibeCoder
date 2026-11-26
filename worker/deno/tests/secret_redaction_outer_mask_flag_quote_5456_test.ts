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
 * The quote is also kept at the start of a bare value, as in Issue #5363.
 *
 * These tests assert the exact output `redactSecrets` produces, that
 * `containsSecret` is false on that output, that a second pass changes nothing,
 * and that the leaked words are gone. The controls pass on the unfixed code
 * too: they pin that only a flag's closing quote is kept. The size cases assert
 * output only, with no stopwatch, as in
 * `worker/deno/tests/secret_redaction_redos_test.ts`.
 */

import { assert, assertEquals } from "@std/assert";
import { redactSecrets } from "../lib/secret_redaction.ts";
import { redactGhBodyArgs } from "../lib/gh_body_redaction.ts";
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

Deno.test("Issue #5456: a label glued after the kept quote has its bare value masked", () => {
  assertRedacts(
    "--token 'a b credentials: x'password: mike --token z it's",
    `--token ${R}${R} --token ${R} it's`,
    ["mike", "credentials", "password", "z it"],
  );
});

Deno.test("Issue #5456: a label glued after the kept quote has its quoted value masked", () => {
  assertRedacts(
    `--token 'alpha beta credentials: TOKEN='password: "mike pass" --token z it's`,
    `--token ${R}${R} --token ${R} it's`,
    ["mike pass", "beta", "z it"],
  );
});

Deno.test("Issue #5456: a flag name glued after the kept quote has its value masked", () => {
  assertRedacts(
    "--token 'a b credentials: x'--password mike --token z it's",
    // Since Issue #5608 the outer value ends before the flag's name, so the
    // flag rule keeps the name and masks its value.
    `--token ${R}${R}--password ${R} --token ${R} it's`,
    ["mike", "credentials", "z it"],
  );
});

Deno.test("Issue #5456: a glued label before a later quoted flag masks both values", () => {
  assertRedacts(
    "--token 'a b credentials: x'password: mike --token 'z y'",
    `--token ${R}${R} --token ${R}`,
    ["mike", "password", "z y"],
  );
});

Deno.test("Issue #5456: text before a glued label stays inside the mask", () => {
  assertRedacts(
    "--token 'a b credentials: x'foo,password: mike --token z it's",
    `--token ${R}${R} --token ${R} it's`,
    ["mike", "foo", "password"],
  );
});

Deno.test("Issue #5456: a label glued after a quote kept with no later quote has its value masked", () => {
  assertRedacts(
    "--token 'a b credentials: x'password: mike",
    `--token ${R}${R}`,
    ["mike", "credentials", "password"],
  );
});

Deno.test("Issue #5456: a label glued after a quote a bare value opens at has its value masked", () => {
  assertRedacts(
    "--password 'alpha beta TOKEN='password: mike",
    `--password ${R}${R}`,
    ["mike", "beta", "password:"],
  );
});

// PR #5607 review: the glued name is never written back. It stays inside the
// mask, which is extended through the value it labels, so nothing the
// unfixed walk masked is published. These fail on the write-back version.

Deno.test("Issue #5456: a glued keyword run with no value after it stays masked", () => {
  assertRedacts(
    "--password 'alpha beta TOKEN='mypassword=",
    `--password ${R}${R}`,
    ["beta", "mypassword"],
  );
  assertRedacts(
    "--token 'a b credentials: x'apikeyfoo=",
    `--token ${R}${R}`,
    ["apikeyfoo"],
  );
});

Deno.test("Issue #5456: a glued keyword run with a value after it masks both in place", () => {
  assertRedacts(
    "--token 'a b credentials: x'mypassword= hunter2 done",
    `--token ${R}${R} done`,
    ["mypassword", "hunter2"],
  );
});

Deno.test("Issue #5363 shape: a glued keyword run at the bare value's opening quote stays masked", () => {
  assertRedacts(
    "--password 'alpha beta TOKEN='secretkey:",
    `--password ${R}${R}`,
    ["beta", "secretkey"],
  );
});

Deno.test("Issue #5456: a glued label with no value does not take the next line's flag value", () => {
  assertRedacts(
    "--password 'alpha beta TOKEN='password:\nkey: --password hunter2",
    `--password ${R}${R}\nkey: --password ${R}`,
    ["hunter2", "beta"],
  );
  assertRedacts(
    "--password 'alpha beta TOKEN='password:\napi_key: --token s3cr3t",
    `--password ${R}${R}\napi_key: --token ${R}`,
    ["s3cr3t", "beta"],
  );
});

Deno.test("Issue #5456: a glued label before a next-line assignment holding a flag masks that flag's value", () => {
  assertRedacts(
    "--password 'alpha beta TOKEN='password:\nTOKEN=--password w0q x",
    `--password ${R}${R}--password ${R} x`,
    ["w0q", "beta"],
  );
});

Deno.test("Issue #5456: a glued label whose value is a flag name leaves that flag to its rule", () => {
  assertRedacts(
    "--password 'alpha beta TOKEN='password: --token hunter2",
    `--password ${R}${R} --token ${R}`,
    ["hunter2", "beta"],
  );
});

Deno.test("Issue #5456: a glued label's bare value stops before a flag name glued to it", () => {
  assertRedacts(
    "--token 'alpha beta credentials: TOKEN='credentials: abc--token def",
    `--token ${R}${R}--token ${R}`,
    ["abc", "def"],
  );
});

// PR #5607 review round 2: the glued value's extent is read with the walk's
// own grammar, so punctuation, hyphens, escaped quotes and multiline quoted
// values stay masked, and only a real credential flag ends it early.

for (
  const [label, value] of [
    ["equals", "abc=def"],
    ["colon", "abc:def"],
    ["internal hyphen", "mike-pass"],
    ["leading hyphen", "-mike"],
  ] as const
) {
  Deno.test(`Issue #5456: a glued label's bare value with a ${label} is masked whole`, () => {
    assertRedacts(
      `--token 'a b credentials: x'password: ${value} --token z it's`,
      `--token ${R}${R} --token ${R} it's`,
      [value, "def", "pass", "mike", "credentials"],
    );
  });
}

Deno.test("Issue #5456: a glued label's double-quoted value with an escaped quote is masked whole", () => {
  assertRedacts(
    `--token 'alpha beta credentials: TOKEN='password: "mike \\" secretword" --token z it's`,
    `--token ${R}${R} --token ${R} it's`,
    ["mike", "secretword", "beta"],
  );
});

Deno.test("Issue #5456: a glued label's closed multiline quoted value is masked whole", () => {
  assertRedacts(
    `--token 'alpha beta credentials: TOKEN='password: "mike\nsecretword" --token z it's`,
    `--token ${R}${R} --token ${R} it's`,
    ["mike", "secretword", "beta"],
  );
});

// PR #5607 review round 3: a glued label's quoted value can hold an inner
// assignment the walk masks on its own. The value is read through its real
// closing quote, not cut at that inner mask, and the extended mask takes the
// inner one over, so nothing after the inner mask is published.

const INNER_ASSIGNMENT =
  `--token 'alpha beta credentials: TOKEN='password: "mike password: hidden secretword" --token z it's`;

Deno.test("Issue #5456: a glued label's quoted value holding an inner assignment is masked whole", () => {
  assertRedacts(
    INNER_ASSIGNMENT,
    `--token ${R}${R} --token ${R} it's`,
    ["mike", "hidden", "secretword", "beta", "z it"],
  );
});

Deno.test("Issue #5456: the outbound body masks a glued quoted value holding an inner assignment", () => {
  const args = redactGhBodyArgs(["pr", "create", "--body", INNER_ASSIGNMENT]);
  const body = args[args.indexOf("--body") + 1] ?? "";
  assertEquals(body, `--token ${R}${R} --token ${R} it's`);
  assert(!body.includes("secretword"), body);
});

Deno.test("Issue #5456: a glued quoted value holding an inner TOKEN= assignment is masked whole", () => {
  assertRedacts(
    `--token 'alpha beta credentials: TOKEN='password: "mike TOKEN=abc def" --token z it's`,
    `--token ${R}${R} --token ${R} it's`,
    ["mike", "abc", "def", "beta"],
  );
});

Deno.test("Issue #5456: an unclosed glued quoted value holding an inner assignment is masked to its line end", () => {
  assertRedacts(
    `--token 'alpha beta credentials: TOKEN='password: "mike password: hidden secretword\nnext line`,
    `--token ${R}${R}\nnext line`,
    ["mike", "hidden", "secretword", "beta"],
  );
});

Deno.test("Issue #5456: a credential flag after a glued value holding an inner assignment is still masked", () => {
  assertRedacts(
    `--token 'alpha beta credentials: TOKEN='password: "mike password: hidden" plain --password 'q r' after`,
    `--token ${R}${R} plain --password ${R} after`,
    ["mike", "hidden", "q r"],
  );
});

Deno.test("Issue #5456: repeated glued values holding inner assignments are masked (output only)", () => {
  assertEquals(
    redactSecrets(`${INNER_ASSIGNMENT}\n`.repeat(20_000)),
    `--token ${R}${R} --token ${R} it's\n`.repeat(20_000),
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
