/**
 * The `secret-assignment` rule masked a quoted value whose closing quote was
 * really the opening quote of a credential CLI flag's quoted value (Issue
 * #5457). `API_TOKEN='abc123def` followed on the next line by
 * `run --password 'correct horse battery staple'` closed the first value at
 * the flag's opening quote, so the mask covered the flag's name, the
 * `secret-cli-flag` rule never saw the flag, and its value was published. The
 * same happened for a double-quoted Windows path ending in a backslash and a
 * quoted message ending in `token:` with text glued to its closing quote. The
 * value is now masked through the flag's value.
 */

import { assert, assertEquals } from "@std/assert";
import { containsSecret, redactSecrets } from "../lib/secret_redaction.ts";

const R = "***REDACTED***";

function leak(
  name: string,
  input: string,
  expected: string,
  absent: string[],
): void {
  Deno.test(`#5457 masks: ${name}`, () => {
    const output = redactSecrets(input);
    assertEquals(output, expected);
    assertEquals(containsSecret(input), true);
    assertEquals(containsSecret(output), false);
    assertEquals(redactSecrets(output), output);
    for (const word of absent) {
      assert(!output.includes(word), `${word} published in ${output}`);
    }
  });
}

function keep(name: string, input: string, expected: string): void {
  Deno.test(`#5457 control: ${name}`, () => {
    assertEquals(redactSecrets(input), expected);
  });
}

leak(
  "cross-line single-quoted value",
  "API_TOKEN='abc123def\nrun --password 'correct horse battery staple'",
  `API_TOKEN=${R}`,
  ["horse", "battery", "staple"],
);
leak(
  "plain branch past the escape-aware bound",
  "API_TOKEN='" + "a".repeat(5000) +
    "\nrun --password 'correct horse battery staple'",
  `API_TOKEN=${R}`,
  ["horse", "battery", "staple"],
);
leak(
  "CRLF and text after the flag value survives",
  "API_TOKEN='abc123def\r\nrun --password 'correct horse battery staple' --verbose\nnext line",
  `API_TOKEN=${R} --verbose\nnext line`,
  ["horse", "battery", "staple"],
);
leak(
  "same-line single-quoted value",
  "API_TOKEN='abc123def run --password 'correct horse battery staple'",
  `API_TOKEN=${R}`,
  ["horse", "battery", "staple"],
);
leak(
  "bare flag value glued to the closing quote",
  "API_TOKEN='abc123def\nrun --password 'hunter2gen",
  `API_TOKEN=${R}`,
  ["hunter2gen"],
);
leak(
  "Windows path escape",
  'PASSWORD="C:\\dir\\" tool --password "correct horse battery staple"',
  `PASSWORD=${R}`,
  ["horse", "battery", "staple"],
);
leak(
  "quoted message ending in a credential word and colon",
  'echo "set the token:"x tool --password "correct horse battery staple"',
  `echo "set the token:${R}`,
  ["horse", "battery", "staple"],
);
leak(
  "nested label",
  "DEPLOY_TOKEN: 'deploy --token 'abc def'",
  `DEPLOY_TOKEN: ${R}`,
  ["abc", "def"],
);

keep(
  "closing quote on its own line",
  "API_TOKEN='abc123def'\nrun --password 'correct horse battery staple'",
  `API_TOKEN='${R}'\nrun --password ${R}`,
);
keep(
  "closing quote opens a non-flag quoted string",
  "API_TOKEN='abc def' and 'other text'",
  `API_TOKEN='${R}' and 'other text'`,
);
keep(
  "non-credential flag",
  "API_TOKEN='abc --name 'correct horse'",
  `API_TOKEN='${R}'correct horse'`,
);

Deno.test("#5457 hostile: long bare flag value returns", () => {
  const output = redactSecrets(
    "API_TOKEN='a --password '" + "b".repeat(200_000),
  );
  assert(!output.includes("bbbb"));
  assertEquals(containsSecret(output), false);
});

Deno.test("#5457 hostile: repeated flag values return", () => {
  const output = redactSecrets("API_TOKEN='a --password 'b c' ".repeat(20_000));
  assert(!output.includes("b c'"));
  assertEquals(containsSecret(output), false);
});
