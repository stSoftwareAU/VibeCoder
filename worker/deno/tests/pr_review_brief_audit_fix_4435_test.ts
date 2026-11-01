/**
 * Doc-drift test for Issue #4435: the review brief must not treat a change
 * that clears a red dependency audit on its own PR as unrelated to the issue,
 * and the reason it gives must agree with the CI-fix prompt that says every
 * red PR fixes the advisory itself.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("Issue #4435 - review brief step 2 does not treat a change that clears its own red dependency audit as unrelated", async () => {
  const doc = await readRepoDoc("prompts/pr_review_brief/prompt.md");
  const text = flat(section(doc, "Review Mode"));
  for (
    const phrase of [
      "A change that clears a dependency audit that is red on this PR is not unrelated",
      "every PR red on an advisory fixes it itself, even when another PR carries the same fix",
      '"Dependency audit failures"). Review it for correctness like any other change',
    ]
  ) {
    assertStringIncludes(text, phrase);
  }
});

Deno.test("Issue #4435 - ci_fix Dependency audit failures section says every red PR fixes the advisory itself", async () => {
  const doc = await readRepoDoc("prompts/ci_fix/prompt.md");
  assert(
    doc.includes("### Dependency audit failures"),
    'prompts/ci_fix/prompt.md must keep the "### Dependency audit failures" heading the review brief cites',
  );
  const audit = section(doc, "Dependency audit failures");
  assert(
    audit.length > 0,
    "the Dependency audit failures section must not be empty",
  );
  assertStringIncludes(
    flat(audit),
    "Every open PR that is red on the same advisory fixes it itself",
  );
});
