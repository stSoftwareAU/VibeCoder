/**
 * Documentation-drift tests for the additive CI-fix summary rule (Issue
 * #5023).
 *
 * The CI-fix summary rule used to fire only when the fix invalidated a claim,
 * so an additive CI fix (a dependency replaced, a race fixed in an unrelated
 * test) left the committed PR summary silent about the head commit. The rule
 * now asks for what the fix changed and why.
 *
 * Each pin is scoped to the narrowest heading section that carries it
 * (CODING-STANDARDS.md § Documentation-drift tests, condition 1).
 *
 * Australian English spelling used throughout (behaviour, recognised, etc.).
 */

import { assert, assertStringIncludes } from "@std/assert";
import {
  flat,
  readRepoDoc,
  section,
  splitSection,
  withoutSection,
} from "./support/markdown_docs.ts";

Deno.test("Issue #5023 - ci_fix summary rule asks for what the fix changed", async () => {
  const scoped = withoutSection(
    section(
      await readRepoDoc("prompts/ci_fix/prompt.md"),
      "Fixing the Failure",
    ),
    "Dependency audit failures",
  );
  const paragraph = splitSection(scoped, "\n\n").find((candidate) =>
    candidate.includes("**Keep the PR summary true to the head.**")
  );
  assert(
    paragraph !== undefined,
    `prompts/ci_fix/prompt.md: no "Keep the PR summary true to the head." paragraph`,
  );
  const text = flat(paragraph);
  for (
    const required of [
      "say what your fix changed and why",
      "rewrite any claim it made false",
      "purely additive fix",
      "git diff <base>...HEAD",
    ]
  ) {
    assertStringIncludes(
      text,
      required,
      `prompts/ci_fix/prompt.md: "Keep the PR summary true to the head." is missing "${required}"`,
    );
  }
  assert(
    !text.includes("invalidates anything it says"),
    `prompts/ci_fix/prompt.md: "Keep the PR summary true to the head." still gates the rule on "invalidates anything it says"`,
  );
});

Deno.test("Issue #5023 - CODING-STANDARDS.md says a CI-fix run records an additive change", async () => {
  const body = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "PR Summary and Evidence",
    ),
  );
  assertStringIncludes(
    body,
    "A CI-fix run also records what its fix changed",
    `CODING-STANDARDS.md: section "PR Summary and Evidence" is missing the additive CI-fix sentence`,
  );
});
