/**
 * Regression tests for secret-assignment value classification (Issue #1727).
 *
 * A credential label alone is not evidence that the next Markdown line is a
 * secret. Keep genuine scalar credentials masked without breaking diagrams.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { isPlausibleSecretAssignmentValue } from "../lib/secret_assignment_value.ts";
import { redactGhBodyArgs, redactGhBodyText } from "../lib/gh_body_redaction.ts";
import {
  containsSecret,
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";

const MERMAID_BODY = [
  "How a spawn or a mid-run switch now picks a credential:",
  "",
  "```mermaid",
  "flowchart TD",
  "    A[Pool candidates] --> B[Select credential]",
  "```",
].join("\n");

Deno.test("Issue #1727 - a credential lead-in preserves its Mermaid fence", () => {
  assertEquals(redactSecrets(MERMAID_BODY), MERMAID_BODY);
  assertEquals(redactGhBodyText(MERMAID_BODY), MERMAID_BODY);
  assertEquals(containsSecret(MERMAID_BODY), false);
  assertEquals(
    redactGhBodyArgs(["pr", "create", "--body", MERMAID_BODY]),
    ["pr", "create", "--body", MERMAID_BODY],
  );
});

Deno.test("Issue #1727 - Markdown structure is not an assignment value", () => {
  for (
    const value of [
      "```mermaid",
      "~~~mermaid",
      "# Heading",
      "## Heading",
      "- list item",
      "* list item",
      "+ list item",
      "1. list item",
      "> quoted text",
      "| table |",
      "`inline code`",
      "[documentation](https://example.com)",
      "a normal sentence describing the credential",
      "short",
      REDACTION_PLACEHOLDER,
    ]
  ) {
    const body = `credential:\n\n${value}\n`;
    assertEquals(isPlausibleSecretAssignmentValue(value), false, value);
    assertEquals(redactSecrets(body), body, value);
  }
});

Deno.test("Issue #1727 - credential-like scalar values remain masked", () => {
  const value = "abc123DEF456ghi789";
  for (
    const body of [
      `credential: ${value}`,
      `credential : ${value}`,
      `x credential:\n\n${value}\n`,
      `CREDENTIAL=\"${value}\"`,
      `PASSWORD: **${value}**`,
      `credential:\n\n\"${value}\"\n`,
    ]
  ) {
    const out = redactGhBodyText(body);
    assertEquals(out.includes(value), false, body);
    assertEquals(out.includes(REDACTION_PLACEHOLDER), true, body);
  }
});

Deno.test("Issue #1727 - a secret after a Markdown fence is still masked", () => {
  const value = "abc123DEF456ghi789";
  const body = `${MERMAID_BODY}\n\ncredential:\n\n${value}\n`;
  const out = redactGhBodyText(body);
  assertEquals(out.includes(value), false);
  assertEquals(out.includes("```mermaid\nflowchart TD"), true);
  assertEquals(
    out.includes(`credential:\n\n${REDACTION_PLACEHOLDER}`),
    true,
  );
});

Deno.test("Issue #1727 - explicit provider token signatures remain independent", () => {
  const token = "ghp_" + "A".repeat(36);
  const body = `${MERMAID_BODY}\n\ncredential:\n\n${token}\n`;
  const out = redactGhBodyText(body);
  assertEquals(out.includes(token), false);
  assertEquals(out.includes("```mermaid\nflowchart TD"), true);
});
