// Credential flag names at a value's end must survive for the next scan.
import { assertEquals } from "@std/assert";
import { redactGhBodyArgs } from "../lib/gh_body_redaction.ts";
import {
  containsSecret,
  REDACTION_PLACEHOLDER as R,
  redactSecrets,
} from "../lib/secret_redaction.ts";
import { assertRedacts } from "./support/secret_redaction_asserts.ts";

for (const prefix of ["", "abc"]) {
  for (const [open, other] of [['"', "'"], ["'", '"']]) {
    Deno.test(`#5614: unclosed ${open} value, prefix ${JSON.stringify(prefix)}`, () => {
      assertRedacts(
        `${prefix}--api-key ${open}tail${other}--api-key hunter2abc`,
        `${prefix}--api-key ${R}--api-key ${R}`,
        ["tail", "hunter2abc"],
      );
    });
  }
}

Deno.test("#5614: different credential flags and whitespace keep both values masked", () => {
  for (
    const [first, second] of [
      ["--token", "--password"],
      ["--secret", "--github-token"],
      ["--private-key", "--access-key"],
      ["--credential", "--api_key"],
    ]
  ) {
    for (const gap of [" ", "\t", "\n", "\r\n", "\u2028"]) {
      assertRedacts(
        `${first}${gap}first-value${second}${gap}second-value --verbose`,
        `${first}${gap}${R}${second}${gap}${R} --verbose`,
        ["first-value", "second-value"],
      );
    }
  }
});

Deno.test("#5614: chained value overlaps resume at each trailing flag", () => {
  assertRedacts(
    `--token "first'--password middle--api-key last-value --verbose`,
    `--token ${R}--password ${R}--api-key ${R} --verbose`,
    ["first", "middle", "last-value"],
  );
});

Deno.test("#5614: trailing flags with already-redacted values are preserved", () => {
  assertRedacts(
    `--token "first'--password ${R}`,
    `--token ${R}--password ${R}`,
    ["first"],
  );
  const masked = `--token ${R}--password ${R}`;
  assertEquals(redactSecrets(masked), masked);
  assertEquals(containsSecret(masked), false);
});

Deno.test("#5614: non-credential flags and missing values stay inside the mask", () => {
  for (
    const suffix of [
      "--verbose public",
      "--password",
      "--password   ",
      "--password --verbose",
    ]
  ) {
    const gap = suffix.indexOf(" ");
    assertRedacts(
      `--token "first'${suffix}`,
      `--token ${R}${gap === -1 ? "" : suffix.slice(gap)}`,
      ["first"],
    );
  }
});

Deno.test("#5614: normally closed quotes keep their complete mask", () => {
  for (const quote of ['"', "'"]) {
    assertRedacts(
      `--token ${quote}first--password${quote} public --api-key second-value`,
      `--token ${R} public --api-key ${R}`,
      ["first", "second-value"],
    );
  }
});

Deno.test("#5614: shared quotes still mask the union before a trailing flag", () => {
  for (const quote of ['"', "'"]) {
    assertRedacts(
      `--token ${quote}first\\${quote} --password ${quote}second--api-key last-value`,
      `--token ${R}--api-key ${R}`,
      ["first", "second", "last-value"],
    );
  }
});

Deno.test("#5614: outbound bodies redact an overlapping flag's value", () => {
  const input = `abc--api-key "tail'--password hunter2abc`;
  const once = redactGhBodyArgs(["pr", "create", "--body", input]);
  assertEquals(once, [
    "pr",
    "create",
    "--body",
    `abc--api-key ${R}--password ${R}`,
  ]);
  assertEquals(redactGhBodyArgs(once), once);
  assertEquals(containsSecret(once[3]!), false);
});

Deno.test("#5614: long name runs and chains retain exact masking (output only)", () => {
  const names = "--token".repeat(20_000);
  // The bounded name grammar accepts at most 19 of these seven-character names.
  assertRedacts(
    `--password "first'${names} last-value`,
    `--password ${R}${"--token".repeat(19)} ${R}`,
    ["first", "last-value"],
  );
  assertRedacts(
    `--password "first'${names}! public`,
    `--password ${R} public`,
    ["first"],
  );
  assertRedacts(
    `--token ${"first--password ".repeat(20_000)}last-value`,
    `--token ${`${R}--password `.repeat(20_000)}${R}`,
    ["first", "last-value"],
  );
});
