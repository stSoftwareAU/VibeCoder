/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3437 — plumbing PRs documented a new config key as working before
 * any code read it (an operator who set the key still got the default). The
 * rule now requires grepping the head for the setting's reader, and, when
 * there is none, wording every doc row, prompt line and code comment as
 * accepted but not read yet, naming the open issue that will read it.
 * CODING-STANDARDS.md's "PR Summary and Evidence" section and the issue
 * prompt's Instructions section must both state it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("CODING-STANDARDS.md states the setting-reader rule in PR Summary and Evidence (Issue #3437)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "PR Summary and Evidence",
    ),
  );

  for (
    const phrase of [
      "until something reads it",
      "Grep the head for its **reader**",
      "accepted but not read yet",
      "names the open issue that will read it",
      "VibeCoder#3434",
    ]
  ) {
    assert(
      text.includes(phrase),
      `CODING-STANDARDS.md § PR Summary and Evidence is missing "${phrase}": ${text}`,
    );
  }
});

Deno.test("issue prompt Instructions section states the setting-reader rule (Issue #3437)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Instructions"),
  );

  for (
    const phrase of [
      "until something reads it",
      "grep the head for its reader",
      "accepted but not read yet",
      "names the open issue that will read it",
    ]
  ) {
    assert(
      text.includes(phrase),
      `issue prompt § Instructions is missing "${phrase}": ${text}`,
    );
  }
});
