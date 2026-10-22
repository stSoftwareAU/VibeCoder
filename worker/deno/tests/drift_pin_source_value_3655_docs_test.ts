/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3655 — fleet drift tests retyped values the code already held
 * (VibeCoder#3478, #3654), so the guidelines now state condition 3 and the
 * source-mutation red check: a pin that names a value a module or checked-in
 * config file holds is built from that source, and is red-checked by changing
 * the value at its source. The new-test rule, the Documentation-drift tests
 * section, the issue prompt's Test Plan step, the pr_feedback prompt's Making
 * Changes section, the review brief's Review Mode step and the CONTRIBUTING
 * drift-pin bullet must all carry it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { buildShallowCloneArgs } from "../commands/git_operations.ts";
import {
  assertPins,
  type DocSection,
  excerpt,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const PARAGRAPH_START = "**A new test must go red without its change.**";

/** The new-test-must-go-red paragraph, from its bold lead to the next blank line. */
function newTestParagraph(text: DocSection, what: string): DocSection {
  const start = text.indexOf(PARAGRAPH_START);
  assert(
    start >= 0,
    `could not locate the new-test-must-go-red rule in ${what}`,
  );
  const end = text.indexOf("\n\n", start);
  return excerpt(text, start, end >= 0 ? end : undefined);
}

Deno.test("both surfaces carry the source-mutation red check in the new-test rule (Issue #3655)", async () => {
  const depthFlag = buildShallowCloneArgs("owner/repo", "repo-dir").find((
    arg,
  ) => arg.startsWith("--depth="));
  assert(
    depthFlag !== undefined,
    "buildShallowCloneArgs returns no --depth= argument",
  );
  const example =
    `\`${buildShallowCloneArgs.name} ${depthFlag} → --filter=blob:none: test red\``;

  const surfaces = [
    [
      "CODING-STANDARDS.md",
      section(
        await readRepoDoc("CODING-STANDARDS.md"),
        "Test coverage expectations",
      ),
    ],
    [
      "coding_guidelines",
      section(
        await readRepoDoc("prompts/coding_guidelines/prompt.md"),
        "Test Coverage Expectations",
      ),
    ],
  ] as const;
  for (const [surface, text] of surfaces) {
    assertPins(newTestParagraph(text, surface), [
      "is built from that module or file, never typed in",
      "use `fn.name` for a function name",
      "change it in the module or file that produces it, run the drift test, see it fail, then restore it",
      "A pin that stays green when its source value changes is a blocking self-review finding",
      example,
    ]);
  }
});

Deno.test("condition 3 of Documentation-drift tests names the source mutation (Issue #3655)", async () => {
  const text = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Documentation-drift tests",
  );
  assertPins(text, [
    "the red check for each code-held value is a source mutation",
    "change the value in the module or file that produces it",
  ]);
});

Deno.test("issue prompt Test Plan step asks for one line per code-held value (Issue #3655)", async () => {
  const text = section(
    await readRepoDoc("prompts/issue/prompt.md"),
    "PR Summary File",
  );
  assertPins(text, [
    "checked-in config file already holds is built from that source, never typed in",
    "record here one line per such value — the value changed at its source and the result",
  ]);
});

Deno.test("pr_feedback asks for the source-value red run (Issue #3655)", async () => {
  const text = section(
    await readRepoDoc("prompts/pr_feedback/prompt.md"),
    "Making Changes",
  );
  assertPins(text, [
    "change the value at its source, run the test, quote the failing line, then restore it",
  ]);
});

Deno.test("review brief step 4 checks code-held drift pins (Issue #3655)", async () => {
  const text = section(
    await readRepoDoc("prompts/pr_review_brief/prompt.md"),
    "Review Mode",
  );
  assertPins(text, [
    "changing the value at its source must turn the test red; a typed-in copy is a finding",
  ]);
});

Deno.test("CONTRIBUTING drift-pin bullet names the source-value red check (Issue #3655)", async () => {
  const text = section(await readRepoDoc("CONTRIBUTING.md"), "Test layout");
  assertPins(text, [
    "is red-checked by changing the value at its source",
  ]);
});
