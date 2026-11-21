/**
 * A credential label must not be taken as the value of the label before it
 * (Issue #5310).
 *
 * `credentials: DEPLOY_TOKEN = <value>` matched with `DEPLOY_TOKEN` as the
 * first label's value; the bare-value branch stops at whitespace, so only the
 * label was masked, the scan resumed after it and the real value was
 * published. Tests drive the public chokepoints so they keep holding if the
 * rule is restructured.
 */

import { assertEquals } from "@std/assert";
import { containsSecret, redactSecrets } from "../lib/secret_redaction.ts";

const V = "q7Lm2Xv9Rk4Tz8Pw1Hn6Bc3Df5Gj0Ys2Ua7Ne4Mi";
const R = "***REDACTED***";

function leak(name: string, input: string, expected: string): void {
  Deno.test(`#5310 masks: ${name}`, () => {
    assertEquals(redactSecrets(input), expected);
    assertEquals(containsSecret(input), true);
  });
}

function keep(
  name: string,
  input: string,
  expected: string,
  flagged: boolean,
): void {
  Deno.test(`#5310 control: ${name}`, () => {
    assertEquals(redactSecrets(input), expected);
    assertEquals(containsSecret(input), flagged);
  });
}

leak(
  "same line, long value",
  `Rotate these credentials: DEPLOY_TOKEN = ${V}`,
  `Rotate these credentials: DEPLOY_TOKEN = ${R}`,
);
leak(
  "next line, long value",
  `Rotate these credentials:\nDEPLOY_TOKEN = ${V}`,
  `Rotate these credentials:\nDEPLOY_TOKEN = ${R}`,
);
leak(
  "same line colon, short value",
  "The secret: api_key: pw42",
  `The secret: api_key: ${R}`,
);
leak(
  "next line colon, short value",
  "The secret:\napi_key: pw42",
  `The secret:\napi_key: ${R}`,
);
leak(
  "same line colon, long value",
  `The secret: api_key: ${V}`,
  `The secret: api_key: ${R}`,
);
leak(
  "next line colon, long value",
  `The secret:\napi_key: ${V}`,
  `The secret:\napi_key: ${R}`,
);
leak(
  "YAML child holding a credential",
  "secrets:\n  API_TOKEN: abcdefgh12345",
  `secrets:\n  API_TOKEN: ${R}`,
);
leak(
  "double-quoted inner value",
  `credentials: DEPLOY_TOKEN="${V}"`,
  `credentials: DEPLOY_TOKEN="${R}"`,
);
leak(
  "chain of labels",
  `credentials: secret: DEPLOY_TOKEN = ${V}`,
  `credentials: secret: DEPLOY_TOKEN = ${R}`,
);

keep(
  "password with credential word and colon",
  "password=MySecret:2024x",
  `password=${R}`,
  true,
);
keep(
  "no whitespace: whole run is the value",
  `credentials: DEPLOY_TOKEN=${V}`,
  `credentials: ${R}`,
  true,
);
keep(
  "expression child is untouched",
  "secrets:\n  GH_TOKEN: ${{ secrets.GH_TOKEN }}",
  "secrets:\n  GH_TOKEN: ${{ secrets.GH_TOKEN }}",
  false,
);
keep("bare parent key", "secrets:\n  deploy:", "secrets:\n  deploy:", false);
keep(
  "standalone assignment",
  `DEPLOY_TOKEN = ${V}`,
  `DEPLOY_TOKEN = ${R}`,
  true,
);

Deno.test("#5310 idempotent on the same-line case", () => {
  const once = redactSecrets(`Rotate these credentials: DEPLOY_TOKEN = ${V}`);
  assertEquals(once, `Rotate these credentials: DEPLOY_TOKEN = ${R}`);
  assertEquals(redactSecrets(once), once);
});

Deno.test("#5310 hostile: long run before a label stays linear and publishes nothing", () => {
  const input = "credentials: " + "x".repeat(200_000) + "_TOKEN" +
    " ".repeat(40) + "!";
  const expected = "credentials: " + R + " ".repeat(40) + "!";
  assertEquals(redactSecrets(input), expected);
});

Deno.test("#5310 control: label within the 64-character bound is masked", () => {
  const input = `credentials: ${"A".repeat(60)}_TOKEN = ${V}`;
  assertEquals(
    redactSecrets(input),
    `credentials: ${"A".repeat(60)}_TOKEN = ${R}`,
  );
  assertEquals(containsSecret(input), true);
});

Deno.test("#5310 hostile: many TOKEN words then a rejected character", () => {
  const input = "credentials: " + "TOKEN".repeat(20_000) + "!";
  const expected = "credentials: " + R;
  assertEquals(redactSecrets(input), expected);
});
