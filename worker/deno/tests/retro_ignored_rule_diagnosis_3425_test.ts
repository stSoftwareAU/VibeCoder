/**
 * Drift test for Issue #3425: when a retro finds a rule that already existed
 * and was still missed, the prompt must make it diagnose the cause (verbose,
 * buried, ambiguous, effort) before proposing another rule, and the coding
 * standards must carry the same principle.
 */
import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("retro prompt category 3 maps each ignored-rule cause to a fix", async () => {
  const doc = await readRepoDoc("prompts/retro/prompt.md");
  const text = flat(section(doc, "3. Coding standards"));
  for (
    const phrase of [
      "| Too verbose |",
      "| Buried |",
      "| Ambiguous |",
      "| Effort |",
      "a category 2 candidate",
      "names the diagnosed cause and its matching fix",
      "A new rule beside an ignored one is the last option",
    ]
  ) {
    assert(
      text.includes(phrase),
      `retro prompt category 3 must include "${phrase}"`,
    );
  }
});

Deno.test("coding standards carry the diagnose-before-adding principle", async () => {
  const doc = await readRepoDoc("CODING-STANDARDS.md");
  const text = flat(section(doc, "Prompt Engineering Guidance"));
  assert(
    text.includes("Diagnose why a rule was ignored before adding another."),
    "Prompt Engineering Guidance must carry the diagnose-before-adding bullet",
  );
  assert(
    text.includes("prompts/retro/prompt.md"),
    "the bullet must point at prompts/retro/prompt.md",
  );
});
