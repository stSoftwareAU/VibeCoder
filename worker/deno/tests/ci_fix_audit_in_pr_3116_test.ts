/**
 * Doc-drift test for Issue #3140: a red dependency audit is fixed in the
 * CI-fix PR rather than deferred to the base-branch "depends on" escape,
 * and the carve-out is scoped to the CI-fix exception rather than stated as
 * a general rule.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("Issue #3140 - ci_fix Dependency audit failures section covers the base-branch carve-out", async () => {
  const doc = await readRepoDoc("prompts/ci_fix/prompt.md");
  const text = flat(section(doc, "Dependency audit failures"));
  for (
    const phrase of [
      "is fixed in this PR even when the same advisory is red on the base branch",
      "Never end the reply with `Depends on owner/repo#N` for it",
      "`deno audit`, `cargo audit`, or any check whose log reports a `GHSA-` or `RUSTSEC-` advisory",
    ]
  ) {
    assertStringIncludes(text, phrase);
  }
});

Deno.test("Issue #3140 - ci_fix Dependency audit failures section covers what counts as fixed and the ignore ban", async () => {
  const doc = await readRepoDoc("prompts/ci_fix/prompt.md");
  const text = flat(section(doc, "Dependency audit failures"));
  for (
    const phrase of [
      "upgraded to a patched release",
      "the dependency edge that pulls the vulnerable package in was removed or replaced",
      "An `--ignore` flag or allow-list entry never counts as fixed, and neither does editing the audit workflow or the audit command",
    ]
  ) {
    assertStringIncludes(text, phrase);
  }
});

Deno.test("Issue #3140 - ci_fix Dependency audit failures section covers the needs-human escalation", async () => {
  const doc = await readRepoDoc("prompts/ci_fix/prompt.md");
  const text = flat(section(doc, "Dependency audit failures"));
  for (
    const phrase of [
      "Only when no edge can be upgraded, removed or replaced",
      "names the advisory ID",
    ]
  ) {
    assertStringIncludes(text, phrase);
  }
});

Deno.test("Issue #3140 - ci_fix Dependency audit failures section covers the tracking issue and several-PRs rule", async () => {
  const doc = await readRepoDoc("prompts/ci_fix/prompt.md");
  const text = flat(section(doc, "Dependency audit failures"));
  for (
    const phrase of [
      "--state open",
      "descriptive labels only",
      "`Fixes #N`",
      "the same-repo form",
      "the fixing commit message",
      "docs/archive/pr-summaries/pr-summary-*.md",
      "A PR comment does not close the issue",
      "The worker's merged-PR sweep reads the pull request body only",
      "only a same-repo `#N`",
      "`Fixes owner/repo#N` is not",
      "Every open PR that is red on the same advisory fixes it itself; none waits for another",
    ]
  ) {
    assertStringIncludes(text, phrase);
  }
});

Deno.test("Issue #3140 - ci_fix Base-branch failures section excludes dependency audits but keeps the other deferral", async () => {
  const doc = await readRepoDoc("prompts/ci_fix/prompt.md");
  const text = flat(section(doc, "Base-branch failures"));
  for (
    const phrase of [
      "This deferral does not apply to a dependency-audit check",
      "Dependency audit failures",
      "When the same check fails on the **base branch**",
      "Depends on owner/repo#N",
      "Search before you file",
      "Every other check already red on the base branch defers as below",
    ]
  ) {
    assertStringIncludes(text, phrase);
  }
});

/**
 * Both documents repeat the same CI-fix carve-out: the exception that lets a
 * CI-fix run defer to `Depends on owner/repo#N` never covers a dependency
 * audit. Shared so the two call sites cannot drift apart.
 */
async function assertCiFixAuditScoping(relative: string): Promise<void> {
  const doc = await readRepoDoc(relative);
  const text = flat(doc);
  for (
    const phrase of [
      "A CI-fix run is the exception",
      "That CI-fix deferral never covers a dependency-audit check",
      "a CI-fix run fixes it in the PR",
      "Dependency audit failures",
    ]
  ) {
    assertStringIncludes(text, phrase);
  }
  const exceptionIndex = text.indexOf("A CI-fix run is the exception");
  const carveOutIndex = text.indexOf(
    "That CI-fix deferral never covers a dependency-audit check",
  );
  assert(
    carveOutIndex > exceptionIndex,
    "the dependency-audit carve-out must come after the CI-fix exception it scopes",
  );
  assert(
    carveOutIndex - exceptionIndex < 600,
    "the dependency-audit carve-out must sit inside the CI-fix exception, not read as a general rule",
  );
}

Deno.test("Issue #3140 - coding_guidelines prompt scopes the audit carve-out inside the CI-fix exception", async () => {
  await assertCiFixAuditScoping("prompts/coding_guidelines/prompt.md");
});

Deno.test("Issue #3140 - CODING-STANDARDS scopes the audit carve-out inside the CI-fix exception", async () => {
  await assertCiFixAuditScoping("CODING-STANDARDS.md");
});

/**
 * The operator manual and the prompt index must name the same exception the
 * prompt does, and point at the section that states it.
 */
async function assertAuditExceptionLinked(relative: string): Promise<void> {
  const doc = await readRepoDoc(relative);
  const text = flat(doc);
  for (
    const phrase of [
      "fixed in the PR even when the base is red",
      "never deferred",
      "needs-human",
      "only when no edge can be upgraded, removed or replaced",
      "prompts/ci_fix/prompt.md#dependency-audit-failures",
      // The claim is scoped to what the prompt instructs, not a worker
      // guarantee — #3141 (still open) is what would make it one.
      "stSoftwareAU/VibeCoder#3141",
      "does not enforce this exception",
    ]
  ) {
    assertStringIncludes(text, phrase);
  }
}

Deno.test("Issue #3140 - CI-fix manual states the audit exception and links the prompt", async () => {
  await assertAuditExceptionLinked("docs/workflows/ci-fix.md");
});

Deno.test("Issue #3140 - prompt index states the audit exception and links the prompt", async () => {
  await assertAuditExceptionLinked("docs/PROMPTS.md");
});
