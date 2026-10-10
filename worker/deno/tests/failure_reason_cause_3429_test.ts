/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3429 — fleet failure reasons quoted git's boilerplate last line
 * ("fatal: Could not read from remote repository.") instead of the line that
 * names the cause, and the tests asserted only the fixed prefix. The
 * "failure reason names the cause" bullet in Never Fail Silently and the
 * "failure-reason test asserts the cause" paragraph in the test-coverage
 * section must be on both CODING-STANDARDS.md and the coding_guidelines
 * prompt, word for word once wrapping is ignored, and the issue prompt must
 * require the check.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  assertPins,
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const BULLET_LEAD = "A failure reason names the cause, not just the failure";
const PARAGRAPH_START = "**A failure-reason test asserts the cause.**";

/** The bullet body after its lead and separator, first letter lower-cased. */
function bulletBody(sectionText: DocSection, separator: string): string {
  const start = sectionText.indexOf(`- **${BULLET_LEAD}${separator}`);
  assert(start >= 0, `could not locate the bullet with separator ${separator}`);
  const ends = ["\n- ", "\n\n"]
    .map((marker) => sectionText.indexOf(marker, start + 1))
    .filter((index) => index >= 0);
  const bullet = flat(excerpt(sectionText, start, Math.min(...ends)));
  const body = bullet.slice(
    bullet.indexOf(separator) + separator.length,
  ).trim();
  return body.charAt(0).toLowerCase() + body.slice(1);
}

function testParagraph(sectionText: DocSection): DocSection {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, "could not locate the failure-reason test paragraph");
  const end = sectionText.indexOf("\n\n", start);
  return excerpt(sectionText, start, end >= 0 ? end : undefined);
}

Deno.test("both surfaces carry the failure-reason-cause rule in Never Fail Silently (Issue #3429)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Never Fail Silently",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Never Fail Silently",
  );

  for (const text of [standards, guidelines]) {
    assertPins(text, [
      BULLET_LEAD,
      "quote the line that names the cause",
      "redact any credential the line carries",
      "Never take the last line blindly",
      "Please make sure you have the correct access rights and the repository exists.",
      "over SSH or a local path, git ends a failed fetch or clone",
      "The cause is on an earlier line",
      "carry the cause from the attempt that failed, not the wrapper's summary",
      "Observe the real tool's output for each failure class",
    ]);
  }

  assertEquals(
    bulletBody(standards, "** —"),
    bulletBody(guidelines, ".**"),
    "the failure-reason-cause bullet must be identical on both surfaces",
  );
});

Deno.test("both surfaces carry the failure-reason-test rule, identical, between observe-real-tool and workflow-validator (Issue #3429)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  for (const text of [standards, guidelines]) {
    assertPins(text, [PARAGRAPH_START]);
    assertPins(testParagraph(text), [
      "triggers a realistic failure of the real tool",
      "a fake built from its observed output",
      "asserts that the cause text appears in the reason",
      "Asserting only the fixed prefix, the exit code or a wrapper's own text is not enough",
      "Remove the cause from the reason on purpose and confirm the test goes red",
      "passes with the cause missing is a blocking self-review finding",
    ]);

    const observe = text.indexOf(
      "**Observe the real tool before you rely on it.**",
    );
    const here = text.indexOf(PARAGRAPH_START);
    const validator = text.indexOf(
      "**A workflow behaviour change extends the workflow validator.**",
    );
    assert(observe >= 0 && observe < here, "must follow observe-real-tool");
    assert(here < validator, "must precede the workflow-validator rule");
  }

  assertEquals(
    flat(testParagraph(standards)).trim(),
    flat(testParagraph(guidelines)).trim(),
  );
});

Deno.test("Choosing assertions points at the failure-reason-test rule (Issue #3429)", async () => {
  assertPins(
    section(await readRepoDoc("CODING-STANDARDS.md"), "Choosing assertions"),
    [
      "A test of a recorded failure reason asserts the tool's cause text",
      "see **A failure-reason test asserts the cause** above",
    ],
  );
});

Deno.test("issue prompt PR Raising Requirements carries the failure-reason check (Issue #3429)", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "PR Raising Requirements",
    ),
    [
      "the reason quotes the line that names the cause and its test asserts that cause text",
      "**A failure reason names the cause, not just the failure**",
    ],
  );
});
