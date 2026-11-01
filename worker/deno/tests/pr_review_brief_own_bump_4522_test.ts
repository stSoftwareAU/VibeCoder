/**
 * Doc-drift test for Issue #4522: the review brief must not treat the
 * routine `bump-deps.sh` refresh the worker commits on every PR as unrelated
 * to the issue, and the coding guidelines must say the bump commit is part of
 * the PR rather than ending in a dangling "see.".
 */

import { assert, assertStringIncludes } from "@std/assert";
import { buildBumpCommitMessage } from "../lib/bump_deps.ts";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

// The commit subject the worker writes, taken from its producer.
const BUMP_SUBJECT = buildBumpCommitMessage();

Deno.test("Issue #4522 - review brief step 2 names the worker's own bump commit as not unrelated", async () => {
  const doc = await readRepoDoc("prompts/pr_review_brief/prompt.md");
  const text = flat(section(doc, "Review Mode"));
  for (
    const phrase of [
      BUMP_SUBJECT,
      '"Dependency Bumps and Supply Chain"',
      "is not unrelated: it is part of the PR, so do not ask for it to be reverted as unrelated to the issue. Review it for correctness like any other change",
    ]
  ) {
    assertStringIncludes(text, phrase);
  }
});

Deno.test("Issue #4522 - coding guidelines say the bump commit is part of the PR and the sentence is finished", async () => {
  const doc = await readRepoDoc("prompts/coding_guidelines/prompt.md");
  const text = flat(section(doc, "Dependency Bumps and Supply Chain"));
  assertStringIncludes(
    text,
    `its \`${BUMP_SUBJECT}\` commit is part of the PR: do not revert it as unrelated to the issue`,
  );
  assert(
    !text.includes("before `./quality.sh`; see."),
    "the bump sentence must not end in a dangling 'see.'",
  );
});
