/**
 * The `secret-assignment` rule masks a value whose credential label is wrapped
 * in Markdown emphasis, a code span or angle brackets (Issue #5326).
 *
 * `**PASSWORD**: <value>` put `**` between the key and its separator, so the
 * rule never matched and the value was published. Tests drive the public
 * chokepoints so they keep holding if the rule is restructured.
 */

import { assertEquals } from "@std/assert";
import { containsSecret, redactSecrets } from "../lib/secret_redaction.ts";

const V = "q7Lm2Xv9Rk4Tz8Pw";
const R = "***REDACTED***";

/** Every leak fixture, so the idempotence check covers each one. */
const LEAKS: string[] = [];

function leak(name: string, input: string, expected: string): void {
  LEAKS.push(input);
  Deno.test(`#5326 masks: ${name}`, () => {
    assertEquals(redactSecrets(input), expected);
    assertEquals(containsSecret(input), true);
  });
}

function keep(name: string, input: string, expected: string = input): void {
  Deno.test(`#5326 control: ${name}`, () => {
    assertEquals(redactSecrets(input), expected);
    assertEquals(containsSecret(input), false);
  });
}

leak("bold label, colon outside", `**PASSWORD**: ${V}`, `**PASSWORD**: ${R}`);
leak("bold label, colon inside", `**PASSWORD:** ${V}`, `**PASSWORD:** ${R}`);
leak("italic label", `*PASSWORD*: ${V}`, `*PASSWORD*: ${R}`);
leak("bold italic label", `***SECRET***: ${V}`, `***SECRET***: ${R}`);
leak("code span, colon outside", "`PASSWORD`: " + V, "`PASSWORD`: " + R);
leak("underscore emphasis label", `_PASSWORD:_ ${V}`, `_PASSWORD:_ ${R}`);
leak("angle-bracket label", `<PASSWORD>: ${V}`, `<PASSWORD>: ${R}`);
leak(
  "bold label, spaced equals",
  `**API_TOKEN** = ${V}`,
  `**API_TOKEN** = ${R}`,
);
leak("bold label, tight equals", `**API_TOKEN**=${V}`, `**API_TOKEN**=${R}`);
leak("code span, tight equals", "`API_KEY`=" + V, "`API_KEY`=" + R);
leak(
  "credential-word key stays masked in heading shape",
  "- **GithubToken:** hunter rest of line",
  `- **GithubToken:** ${R} rest of line`,
);
leak("cross-line value", `**PASSWORD:**\n${V}`, `**PASSWORD:**\n${R}`);
leak(
  "nested label, bold",
  `credentials: **DEPLOY_TOKEN**: ${V}`,
  `credentials: **DEPLOY_TOKEN**: ${R}`,
);
leak(
  "nested label, trailing markers only",
  `credentials: DEPLOY_TOKEN**: ${V}`,
  `credentials: DEPLOY_TOKEN**: ${R}`,
);
leak(
  "nested label, colon inside bold",
  `credentials: **DEPLOY_TOKEN:** ${V}`,
  `credentials: **DEPLOY_TOKEN:** ${R}`,
);

leak(
  "marked plural key, value ending its line",
  "**Passwords:** sunshine",
  `**Passwords:** ${R}`,
);
leak(
  "marked plural key, value with a digit",
  "**Secrets:** hunter2 and more",
  `**Secrets:** ${R} and more`,
);
leak(
  "unmarked plural key never reaches the marked-plural exemption",
  "Tokens: input 27",
  `Tokens: ${R} 27`,
);

keep("marked plural key heads a count", "- **Tokens:** input 27 · output 11");
keep("marked plural key heads a sentence", "**Passwords:** sunshine and more");
keep(
  "prose naming a key in a code span is not masked",
  "a sentence ending in `credential:` adopted the next line",
);
keep(
  "accepted limit: a code span including the colon is not matched",
  "`PASSWORD:` " + V,
);
keep("comparison is not an assignment", "if max_tokens>=limit then");
keep(
  "bold prose heading keeps its exemption (colon inside)",
  "**TokenBudget:** run the agreed trial",
);
keep(
  "bold prose heading keeps its exemption (colon outside)",
  "**TokenBudget**: run the agreed trial",
);
keep(
  "fence after a bold lead-in is not a value",
  "**Credential:**\n```mermaid",
);
keep(
  "prose line after a bold lead-in is not a value",
  "**Note on the token:**\nThe next line is prose.",
);

Deno.test("#5326 control: asterisks around a bare value are part of the value", () => {
  const input = `PASSWORD=**${V}**`;
  assertEquals(redactSecrets(input), `PASSWORD=${R}`);
  assertEquals(containsSecret(input), true);
});

for (const input of LEAKS) {
  Deno.test(`#5326 idempotent: ${JSON.stringify(input.slice(0, 40))}`, () => {
    const once = redactSecrets(input);
    assertEquals(redactSecrets(once), once);
    assertEquals(containsSecret(once), false);
  });
}

// Linearity (the module header's linearity rule). No stopwatch: the hostile size is the detector.
Deno.test("#5326 hostile: a long run of asterisks after a key passes through", () => {
  const input = "PASSWORD" + "*".repeat(100_000) + "x";
  assertEquals(redactSecrets(input), input);
});

Deno.test("#5326 hostile: repeated marked labels are stable", () => {
  const input = "TOKEN**: ".repeat(20_000);
  const once = redactSecrets(input);
  assertEquals(typeof once, "string");
  assertEquals(redactSecrets(once), once);
});

Deno.test("#5326 hostile: a long run of backticks after a key", () => {
  const input = "API_KEY:" + "`".repeat(100_000) + " v";
  // No value starts within 63 characters of a letter or digit: unchanged.
  assertEquals(redactSecrets(input), input);
});
