/**
 * A quoted `secret-assignment` value is judged inside its quotes, and an
 * unterminated double-quoted value is masked to the end of its line (Issue
 * #5329).
 *
 * `PASSWORD=" hunter2 abc"` matched nothing because the value opened with a
 * space, failing the lookahead that reads the whole run; `TOKEN="hunter2abc`
 * matched neither branch, as the bare-value branch excludes a double quote.
 * Every fake secret is built from short parts at run time, so no literal reads
 * as a credential to gitleaks.
 */

import { assertEquals } from "@std/assert";
import {
  containsSecret,
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";

const v = "hun" + "ter2";

/** A positive fixture: masked as expected, idempotent, and clean afterwards. */
function masked(name: string, input: string, expected: string): void {
  Deno.test(`#5329 masks: ${name}`, () => {
    assertEquals(redactSecrets(input), expected);
    assertEquals(containsSecret(input), true);
    const once = redactSecrets(input);
    assertEquals(redactSecrets(once), once);
    assertEquals(containsSecret(once), false);
  });
}

/** A negative control: the text is unchanged and not flagged. */
function unchanged(name: string, input: string): void {
  Deno.test(`#5329 control: ${name}`, () => {
    assertEquals(redactSecrets(input), input);
    assertEquals(containsSecret(input), false);
  });
}

Deno.test("#5329 placeholder is the literal the fixtures expect", () => {
  assertEquals(REDACTION_PLACEHOLDER, "***REDACTED***");
});

// Quoted values whose text opens with a space or a symbol-only word.
masked(
  "double-quoted value opening with a space",
  `PASSWORD=" ${v} abc"`,
  `PASSWORD="***REDACTED***"`,
);
masked(
  "double-quoted value opening with a symbol-only word",
  `PASSWORD="!!! ${v}"`,
  `PASSWORD="***REDACTED***"`,
);
masked(
  "single-quoted value opening with a space",
  `API_KEY=' ${v} value'`,
  `API_KEY='***REDACTED***'`,
);
masked(
  "single-quoted value opening with a symbol-only word",
  `API_KEY='#! ${v}'`,
  `API_KEY='***REDACTED***'`,
);

// Double-quoted values with no closing quote.
masked(
  "unterminated double quote, no space",
  `TOKEN="${v}abc`,
  `TOKEN=***REDACTED***`,
);
masked(
  "unterminated double quote, masked to the end of the line",
  `TOKEN="${v} abc def`,
  `TOKEN=***REDACTED***`,
);
masked(
  "unterminated double quote, opening with a space",
  `TOKEN=" ${v}`,
  `TOKEN=***REDACTED***`,
);
masked(
  "unterminated double quote, next line untouched",
  `line one\nDB_PASSWORD="${v}-val\nnext line`,
  `line one\nDB_PASSWORD=***REDACTED***\nnext line`,
);
masked(
  "unterminated double quote inside a JSON string",
  `{"password":"${v}xyz`,
  `{"password":***REDACTED***`,
);

// Unchanged behaviour: the rule's existing shapes.
masked(
  "closed double quote inside JSON",
  `"password":"${v}"`,
  `"password":"***REDACTED***"`,
);
masked(
  "unterminated single quote keeps the bare run",
  `PASSWORD='${v} abc`,
  `PASSWORD=***REDACTED*** abc`,
);
unchanged("permission level is not a secret", "id-token: write");
unchanged(
  "markdown label with a count (Issue #4004)",
  "- **Tokens:** input 27",
);

// Negative controls: no letter or digit inside the quotes, so nothing is judged.
unchanged("quoted punctuation only", `PASSWORD="---"`);
unchanged("quoted space only", `PASSWORD=" "`);
unchanged("empty double-quoted value", `PASSWORD=""`);
unchanged("lone opening double quote", `TOKEN="`);
unchanged("quoted punctuation and spaces", `PASSWORD="  -- "`);
unchanged(
  "only letter lies past the 256-character span",
  `PASSWORD="${" ".repeat(300)}x"`,
);

// Positive control just inside the 256-character span.
masked(
  "letter inside the 256-character span",
  `PASSWORD="${" ".repeat(200)}${v}"`,
  `PASSWORD="***REDACTED***"`,
);

// Hostile inputs: assert the output only, never the timing (Issue #3942).
unchanged(
  "100,000 spaces inside a double quote",
  `PASSWORD="${" ".repeat(100_000)}"`,
);
unchanged(
  "100,000 spaces inside a single quote",
  `PASSWORD='${" ".repeat(100_000)}`,
);
unchanged(
  "100,000 symbols inside a double quote",
  `PASSWORD="${"!".repeat(100_000)}`,
);
masked(
  "25,000 words in an unterminated double quote",
  `TOKEN="${"a b ".repeat(25_000)}`,
  `TOKEN=***REDACTED***`,
);

Deno.test("#5329 hostile: repeated lone quote-and-space stays linear", () => {
  const input = ('TOKEN=" ').repeat(20_000);
  assertEquals(containsSecret(redactSecrets(input)), false);
});
