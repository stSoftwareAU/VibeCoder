/**
 * A credential label at the end of a line must not consume the next Markdown
 * line as its value (Issue #1727).
 *
 * The `secret-assignment` rule's separator (`["']?\s*[=:]\s*`) spans line
 * breaks, so prose ending in `credential:` adopted the following line as the
 * assignment's value. When that line was a Mermaid fence the fence itself was
 * replaced with the placeholder and the diagram stopped rendering in the
 * published PR body — `CODING-STANDARDS.md` requires that diagram.
 *
 * These tests drive the public chokepoints (`redactSecrets`,
 * `redactGhBodyText`, `redactGhBodyArgs`, `containsSecret`) so they keep
 * holding if the rule is reimplemented, plus the value-side predicate
 * directly for its boundaries.
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
  isCredentialShapedValue,
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";

/** The PR body shape from Issue #1726 that lost its diagram. */
const MERMAID_BODY = [
  "How a spawn or a mid-run switch now picks a credential:",
  "",
  "```mermaid",
  "flowchart TD",
  "    A[Pool] --> B[Selected credential]",
  "```",
].join("\n");

/** A generic credential with no provider prefix, so only the rule can catch it. */
const SECRET = "aB3dE6gH9jK2mN5p";

Deno.test("Issue #1727 - a credential lead-in keeps its Mermaid fence", () => {
  assertEquals(redactSecrets(MERMAID_BODY), MERMAID_BODY);
  assertEquals(redactGhBodyText(MERMAID_BODY), MERMAID_BODY);
  assertEquals(containsSecret(MERMAID_BODY), false);
  assertEquals(
    redactGhBodyArgs(["pr", "create", "--body", MERMAID_BODY]),
    ["pr", "create", "--body", MERMAID_BODY],
  );
});

Deno.test("Issue #1727 - every credential label spelling keeps the fence", () => {
  for (
    const label of [
      "credential:",
      "x credential:",
      "credential :",
      "the API_KEY:",
      "PASSWORD:",
      "a token:",
      "SECRET=",
    ]
  ) {
    for (const gap of ["\n\n", "\n"]) {
      const body =
        `${label}${gap}\`\`\`mermaid\nflowchart TD\n    A --> B\n\`\`\`\n`;
      assertEquals(redactSecrets(body), body, `${label}${gap}`);
      assertEquals(containsSecret(body), false, `${label}${gap}`);
    }
  }
});

Deno.test("Issue #1727 - a fence or an image is never an assignment value", () => {
  for (
    const value of ["```mermaid", "```typescript", "~~~mermaid", "![a](b.png)"]
  ) {
    assertEquals(isCredentialShapedValue(value, true), false, value);
    assertEquals(isCredentialShapedValue(value, false), false, value);
  }
});

Deno.test("Issue #1727 - Markdown after a trailing label survives redaction", () => {
  for (
    const value of [
      "```mermaid",
      "~~~mermaid",
      "![diagram](docs/evidence/a.png)",
      "`inline code`",
      "# Heading",
      "> quoted",
      "| table cell |",
      "- item",
      "1. item",
    ]
  ) {
    const body = `credential:\n\n${value}\n`;
    assertEquals(redactSecrets(body), body, value);
    assertEquals(containsSecret(body), false, value);
  }
});

Deno.test("Issue #1727 - the exclusion does not reach legitimate password characters", () => {
  // A backtick, `#`, `>` and `|` all occur in real passwords, so an inline
  // assignment carrying one must stay masked.
  for (
    const body of [
      "PASSWORD: `hunter2hunter2`",
      "SECRET: #hunter2!",
      "API_KEY: >hunter2hunter2",
      "CREDENTIAL: |hunter2hunter2",
    ]
  ) {
    assertStringIncludes(redactSecrets(body), REDACTION_PLACEHOLDER, body);
    assertEquals(containsSecret(body), true, body);
  }
});

Deno.test("Issue #1727 - prose after a trailing label is not a credential", () => {
  for (
    const sentence of [
      "The pool ranks every candidate by remaining quota.",
      "Selection happens once per spawn.",
      "**Note** that a mid-run switch re-reads the pool.",
      "Although the pool is shared, each slot picks alone.",
    ]
  ) {
    const body = `How a spawn picks a credential:\n\n${sentence}\n`;
    assertEquals(redactSecrets(body), body, sentence);
  }
});

Deno.test("Issue #1727 - an inline assignment value is still masked", () => {
  for (
    const body of [
      `credential: ${SECRET}`,
      `credential : ${SECRET}`,
      `CREDENTIAL="${SECRET}"`,
      `PASSWORD: **${SECRET}**`,
      `{"api_key":"${SECRET}"}`,
      `secret_scanning: enabled`,
      `PASSWORD=12345`,
    ]
  ) {
    assertStringIncludes(redactSecrets(body), REDACTION_PLACEHOLDER, body);
    assertEquals(containsSecret(body), true, body);
  }
});

Deno.test("Issue #1727 - a credential-shaped value on the next line is still masked", () => {
  for (
    const body of [
      `CREDENTIAL:\n${SECRET}\n`,
      `credential:\n\n${SECRET}\n`,
      `credential:\n\n"short"\n`,
      `credential:\n\n**${SECRET}**\n`,
    ]
  ) {
    const out = redactSecrets(body);
    assertEquals(out.includes(SECRET), false, body);
    assertStringIncludes(out, REDACTION_PLACEHOLDER, body);
  }
});

Deno.test("Issue #1727 - a provider token after a fence is masked, fence intact", () => {
  const token = "ghp_" + "A".repeat(36);
  const body = `${MERMAID_BODY}\n\ncredential:\n\n${token}\n`;
  const out = redactGhBodyText(body);
  assertEquals(out.includes(token), false);
  assertStringIncludes(out, "```mermaid\nflowchart TD");
  assertStringIncludes(out, REDACTION_PLACEHOLDER);
});
