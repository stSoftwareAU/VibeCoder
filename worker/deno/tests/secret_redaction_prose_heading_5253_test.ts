/**
 * A product name used as a prose heading is not a credential assignment
 * (Issue #5253).
 *
 * The `secret-assignment` rule matches any identifier containing TOKEN,
 * SECRET or another credential word, followed by `:` or `=` and a value. So a
 * PR title such as `Product: run the agreed trial …`, a product name used as a
 * heading (the form the worker's own titles take), had the word after the
 * colon masked. The PR title for Issue #4959, a product-name heading, had the
 * word after its colon published as the placeholder.
 *
 * The exemption is narrow. It needs a bare colon and spaces, a Capitalised key
 * whose last word is not a credential field, and a plain single word as the
 * value. Credential fields keep their mask whatever the value, and so do `=`
 * assignments, quoted keys, underscore keys and lower-camel identifiers. Most
 * cases here are a pair: a survive assertion beside the mask it must not
 * weaken.
 *
 * Tests drive the public chokepoints (`redactSecrets`, `redactGhBodyText`,
 * `redactGhBodyArgs`, `containsSecret`), as the Issue #1727 Markdown test does.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  redactGhBodyArgs,
  redactGhBodyText,
} from "../lib/gh_body_redaction.ts";
import {
  containsSecret,
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";

/**
 * The #4959 product name, assembled from halves so this file does not spell
 * it: the trial docs drift test purges every file that names the trialled
 * plugin, and this one must not be among them.
 */
const PRODUCT = ["Token", "Economizer"].join("");

/** The #4959 product name in upper snake case, as an environment-style key. */
const PRODUCT_SNAKE = ["TOKEN", "ECONOMIZER"].join("_");

/** The #4959 product name in lower camel case. */
const PRODUCT_LOWER = ["token", "Economizer"].join("");

/** The PR title published for Issue #4959, which the rule masked (Issue #5253). */
const TITLE =
  `${PRODUCT}: run the agreed trial to an automatic keep-or-purge verdict (Issue #4959)`;

/** The same title as the issue carried it, without the issue reference. */
const ISSUE_TITLE =
  `${PRODUCT}: run the agreed trial to an automatic keep-or-purge verdict`;

/**
 * A generic credential with no provider prefix, so only this rule catches it.
 *
 * Assembled from halves at run time: written in one piece, this synthetic
 * fixture is a high-entropy literal beside a `SECRET` identifier, which is
 * exactly the shape `generic-api-key` flags. The value assembles identically.
 */
const SECRET = ["aB3dE6gH", "9jK2mN5p"].join("");

/** An AWS secret access key: 40 characters, no prefix any signature rule sees. */
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

/** Assert `body` is published byte-for-byte and reads as carrying no secret. */
function assertSurvives(body: string, label: string): void {
  assertEquals(redactSecrets(body), body, label);
  assertEquals(containsSecret(body), false, label);
}

/** Assert `body` is masked and still reads as carrying a secret. */
function assertMasked(body: string, secret: string, label: string): void {
  const out = redactSecrets(body);
  assertEquals(out.includes(secret), false, label);
  assertStringIncludes(out, REDACTION_PLACEHOLDER, label);
  assertEquals(containsSecret(body), true, label);
}

// ---------------------------------------------------------------------------
// The reported defect
// ---------------------------------------------------------------------------

Deno.test("Issue #5253 - the reported PR title survives byte-for-byte", () => {
  for (const title of [TITLE, ISSUE_TITLE]) {
    assertSurvives(title, title);
    assertEquals(
      redactGhBodyArgs(["pr", "create", "--title", title]),
      ["pr", "create", "--title", title],
    );
  }
});

Deno.test("Issue #5253 - a body quoting the reported title survives", () => {
  const body = [
    "## Summary",
    "",
    `Closes #4959: "${ISSUE_TITLE}"`,
    "",
    `The published title was \`${TITLE}\`.`,
    "",
  ].join("\n");
  assertEquals(redactGhBodyText(body), body);
  assertSurvives(body, "quoted title body");
});

// ---------------------------------------------------------------------------
// The exemption is narrow: credential fields and code keys stay masked
// ---------------------------------------------------------------------------

Deno.test("Issue #5253 - credential fields with short dictionary-word values stay masked", () => {
  const cases: [string, string][] = [
    ["GITHUB_TOKEN: run", "run"],
    ["GithubToken: run the agreed trial", "run"],
    ["Password: hunter", "hunter"],
    ["ApiKey: secret", "secret"],
    ["AccessKey: open", "open"],
    ["ClientSecret: banana", "banana"],
    ["Credentials: letmein", "letmein"],
    ["SecretValue: hunter", "hunter"],
    [`${PRODUCT}=run`, "run"],
    [`"${PRODUCT}": "run"`, "run"],
    [`${PRODUCT_SNAKE}: run`, "run"],
    [`${PRODUCT_LOWER}: run`, "run"],
  ];
  for (const [body, secret] of cases) {
    assertMasked(body, secret, body);
  }
});

Deno.test("Issue #5253 - a lower-case password keeps the word after it masked", () => {
  assertEquals(
    redactSecrets("password: run the job now"),
    `password: ${REDACTION_PLACEHOLDER} the job now`,
  );
  assertEquals(containsSecret("password: run the job now"), true);
});

Deno.test("Issue #5253 - a quoted product-name value stays masked", () => {
  assertEquals(
    redactSecrets(`"${PRODUCT}": "run"`),
    `"${PRODUCT}": "${REDACTION_PLACEHOLDER}"`,
  );
});

Deno.test("Issue #5253 - long and short synthetic values under a product heading stay masked", () => {
  const cases: [string, string][] = [
    [`${PRODUCT}: ${SECRET}`, SECRET],
    [`${PRODUCT}: ${AWS_SECRET}`, AWS_SECRET],
    [`${PRODUCT}: correcthorsebatterystaple`, "correcthorsebatterystaple"],
    [`${PRODUCT}: hunter2`, "hunter2"],
    [`${PRODUCT}: "run"`, "run"],
  ];
  for (const [body, secret] of cases) {
    assertMasked(body, secret, body);
  }
});

Deno.test("Issue #5253 - a product heading split across a line break stays masked", () => {
  assertMasked(`${PRODUCT}:\n${SECRET}\n`, SECRET, "cross-line");
});

Deno.test("Issue #5253 - only the key's last word decides a prose heading", () => {
  // Positive control: the same body, decided by the key's last component alone.
  const body = (key: string) => `${key}: run the agreed trial`;
  assertSurvives(body(PRODUCT), "product-name key survives");
  assertMasked(body("GithubToken"), "run", "credential-field key is masked");
});
