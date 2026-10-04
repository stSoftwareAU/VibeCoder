/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3222 — the changed-call-site rule only named "more than one
 * production caller", so a single entry point (a CLI command or task, an
 * HTTP route, a scheduled job, a UI control's event handler) threaded with
 * new behaviour and tested nowhere slipped past it. CODING-STANDARDS.md and
 * the coding_guidelines prompt must both widen the rule to cover a single
 * caller and UI controls, word for word once wrapping is ignored, and the
 * issue prompt's PR Summary File section must require a UI control test to
 * invoke the handler and list each entry point checked.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const PARAGRAPH_START =
  "**Every changed call site needs a test that goes red without it.**";

function changedCallSiteParagraph(sectionText: string, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(start >= 0, `could not locate the changed-call-site rule in ${what}`);
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = end >= 0
    ? sectionText.slice(start, end)
    : sectionText.slice(start);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "including a single caller",
  "a UI control's event handler",
  "a scheduled job",
  "invoke the control's handler",
  "pressing X requests Y",
  "List each entry point checked in the PR summary",
];

Deno.test("both surfaces widen the changed-call-site rule to a single entry point and UI controls (Issue #3222)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const paragraph = changedCallSiteParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the changed-call-site rule: ${paragraph}`,
      );
    }
    assert(
      !paragraph.includes("more than one production caller"),
      `${surface} still limits the rule to more than one production caller: ${paragraph}`,
    );
  }
});

Deno.test("issue prompt PR Summary File section requires invoking UI control handlers and listing entry points (Issue #3222)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  assert(
    text.includes("for a UI control that test invokes the handler"),
    `PR Summary File section is missing the UI-control invocation requirement: ${text}`,
  );
  assert(
    text.includes("lists each entry point checked"),
    `PR Summary File section is missing the entry-point enumeration requirement: ${text}`,
  );
});
