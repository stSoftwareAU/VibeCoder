/**
 * Tests for the masked-instruction detector (`lib/masked_instructions.ts`,
 * Issue #2390).
 *
 * Live incident: fourteen audit issues were filed reading
 * "Add `persist-credentials: ***REDACTED***` to the checkout step" — the
 * worker's own secret filter had masked the one value the instruction needed —
 * and were then queued and claimed as ordinary work. The detector is what both
 * the filer and the pickup path use to tell an instruction nobody can follow
 * from a masked token in a quoted log, where masking is correct and harmless.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildMaskedInstructionQuestions,
  findMaskedInstructions,
} from "../lib/masked_instructions.ts";

/** The body the audit actually filed, as published. */
const INCIDENT_BODY = [
  "**File:** `.github/workflows/markdown-lint.yml`:29",
  "",
  "## Why this matters",
  "",
  "Job `markdownlint` step 0 runs `actions/checkout` without `persist-credentials: ***REDACTED*** By default checkout writes the token.",
  "",
  "## Suggested fix",
  "",
  "Add `persist-credentials: ***REDACTED*** to the checkout step so the token is not written to disk:",
  "",
  "```yaml",
  "      - uses: actions/checkout@<sha>",
  "        with:",
  "          persist-credentials: ***REDACTED***",
  "```",
  "",
  "## Evidence",
  "",
  "`.github/workflows/markdown-lint.yml`:29 — `uses: actions/checkout` with no `persist-credentials: ***REDACTED***",
].join("\n");

Deno.test("findMaskedInstructions - the incident body: the prose and the fenced YAML of the fix are both found", () => {
  const hits = findMaskedInstructions(INCIDENT_BODY);
  const fix = hits.filter((h) => h.section === "Suggested fix");
  assertEquals(fix.map((h) => h.line), [9, 14]);
  assertStringIncludes(fix[0]?.text ?? "", "persist-credentials");
});

Deno.test("findMaskedInstructions - the same body with the value restored is workable", () => {
  assertEquals(
    findMaskedInstructions(
      INCIDENT_BODY.replaceAll("***REDACTED***", "false`"),
    ),
    [],
  );
});

Deno.test("findMaskedInstructions - a masked token in quoted evidence is correct masking, not an unreadable instruction", () => {
  const body = [
    "The deploy fails. Make the job retry once.",
    "",
    "## Evidence",
    "",
    "```text",
    "curl -H 'Authorization: Bearer ***REDACTED***' https://example.test",
    "```",
    "",
    "> remote: API_KEY=***REDACTED*** rejected",
    "",
    "## Logs",
    "",
    "TOKEN=***REDACTED*** was printed at start-up.",
  ].join("\n");
  assertEquals(findMaskedInstructions(body), []);
});

Deno.test("findMaskedInstructions - a fenced log outside any instruction section is evidence", () => {
  const body = [
    "Start-up prints this, please silence it:",
    "",
    "```",
    "DB_PASSWORD=***REDACTED***",
    "```",
  ].join("\n");
  assertEquals(findMaskedInstructions(body), []);
});

Deno.test("findMaskedInstructions - the placeholder named as a thing, in its own code span, is a mention", () => {
  const body = [
    "## Expected",
    "",
    "A body that carries `***REDACTED***` (or `***PROMPT-LEAK-REDACTED***`) is unclear.",
  ].join("\n");
  assertEquals(findMaskedInstructions(body), []);
});

Deno.test("findMaskedInstructions - the prompt-leak placeholder inside an instruction is found too", () => {
  const body =
    "## Steps\n\nSet the header to ***PROMPT-LEAK-REDACTED*** and redeploy.";
  assertEquals(findMaskedInstructions(body).map((h) => h.line), [3]);
});

Deno.test("findMaskedInstructions - a secret masked in running prose is masking doing its job", () => {
  for (
    const body of [
      "leak ***REDACTED***",
      "## Suggested fix\n\nFound token ***REDACTED*** in config.ts — rotate it and remove the line.",
    ]
  ) {
    assertEquals(findMaskedInstructions(body), [], body);
  }
});

Deno.test("findMaskedInstructions - prose with no headings at all is instruction", () => {
  assertEquals(
    findMaskedInstructions("Set `retries: ***REDACTED***` in ci.yml.").length,
    1,
  );
});

Deno.test("buildMaskedInstructionQuestions - names each line, asks for the value, and warns off pasting a secret", () => {
  const text = buildMaskedInstructionQuestions(
    findMaskedInstructions(INCIDENT_BODY),
  );
  assertStringIncludes(text, "line 9");
  assertStringIncludes(text, "Suggested fix");
  assertStringIncludes(text, "persist-credentials");
  assertStringIncludes(text, "edit the issue");
  assertStringIncludes(text, "real secret");
});
