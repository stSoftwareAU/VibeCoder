/**
 * The `secret-assignment` rule leaves a credential CLI flag that has a value to
 * the `secret-cli-flag` rule (Issue #5330). `the token: --token hunter2gen`
 * took the flag as the label's value, masked its name, and so hid the flag from
 * `secret-cli-flag`, which published the value.
 */

import { assert, assertEquals } from "@std/assert";
import { containsSecret, redactSecrets } from "../lib/secret_redaction.ts";

const R = "***REDACTED***";

/** Every masked fixture, so the idempotence check covers each one. */
const LEAKS: Array<[string, string]> = [];

function leak(name: string, input: string, expected: string): void {
  LEAKS.push([input, expected]);
  Deno.test(`#5330 masks: ${name}`, () => {
    assertEquals(redactSecrets(input), expected);
    assertEquals(containsSecret(input), true);
  });
}

function keep(name: string, input: string, expected: string): void {
  Deno.test(`#5330 control: ${name}`, () => {
    assertEquals(redactSecrets(input), expected);
  });
}

leak("token flag", "the token: --token hunter2gen", `the token: --token ${R}`);
leak(
  "password flag",
  "Pass the password: --password sunshine123",
  `Pass the password: --password ${R}`,
);
leak(
  "api-key flag",
  "credentials: --api-key abcdefgh",
  `credentials: --api-key ${R}`,
);
leak(
  "flag on the next line",
  "Set the token:\n--github-token hunter2gen",
  `Set the token:\n--github-token ${R}`,
);
leak(
  "tab separated",
  "token:\t--token\thunter2gen",
  `token:\t--token\t${R}`,
);
leak("quoted value", "token: --token 'my secret'", `token: --token ${R}`);
leak(
  "bold label",
  "**Token:** --token hunter2gen",
  `**Token:** --token ${R}`,
);
leak("equals separator", "TOKEN=--token hunter2gen", `TOKEN=--token ${R}`);
leak(
  "export with env-style key",
  "export API_TOKEN: --imgbb-api-key 0123abcd",
  `export API_TOKEN: --imgbb-api-key ${R}`,
);

keep("flag with no value", "password: --verbose", `password: ${R}`);
keep("credential flag alone", "password: --token", `password: ${R}`);
keep(
  "credential flag then another flag",
  "password: --token --verbose",
  `password: ${R} --verbose`,
);
keep("flag with equals", "token: --token=hunter2gen", `token: ${R}`);
keep(
  "non-credential flag",
  "password: --name hunter2gen",
  `password: ${R} hunter2gen`,
);
keep(
  "bare separator after the flag",
  "credentials: --token = hunter2gen",
  `credentials: ${R} = ${R}`,
);

for (
  const [input, expected] of [
    [
      "credentials: DEPLOY_TOKEN = --token hunter2gen",
      `credentials: ${R} = --token ${R}`,
    ],
    [
      "credentials: TOKEN: --api-key hunter2gen",
      `credentials: ${R} --api-key ${R}`,
    ],
  ] as const
) {
  Deno.test(`#5330 nested: ${JSON.stringify(input)}`, () => {
    const out = redactSecrets(input);
    assert(!out.includes("hunter2gen"), out);
    assertEquals(out, expected);
    assertEquals(containsSecret(input), true);
  });
}

Deno.test("#5330 idempotent: every masked fixture", () => {
  for (const [input] of LEAKS) {
    const out = redactSecrets(input);
    assertEquals(redactSecrets(out), out, input);
    assertEquals(containsSecret(out), false, input);
  }
});

Deno.test("#5330 idempotent: placeholder after the flag", () => {
  const input = `token: --token ${R}`;
  assertEquals(redactSecrets(input), input);
  assertEquals(containsSecret(input), false);
});

Deno.test("#5330 linear: many flag lines", () => {
  assertEquals(
    redactSecrets("x token: --token v ".repeat(20000)),
    `x token: --token ${R} `.repeat(20000),
  );
});

Deno.test("#5330 linear: flag then long whitespace", () => {
  const spaces = " ".repeat(100000);
  assertEquals(
    redactSecrets("token: --token" + spaces + "-"),
    `token: ${R}` + spaces + "-",
  );
});
