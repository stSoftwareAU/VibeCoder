/**
 * Issue #3058: PR bodies, docs and acceptance claims verified against the
 * final diff; standing violations the diff introduced block the PR.
 */

import { assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("Issue #3058 - issue prompt blocks the PR for a violation the diff introduced", async () => {
  const body = flat(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "Independent Review Before the PR",
    ),
  );

  for (
    const required of [
      "A violation this diff introduced blocks the PR",
      "Only a departure that predates the diff",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("Issue #3058 - issue prompt demands demonstrated criteria and finished deliverables", async () => {
  const issuePrompt = await readRepoDoc("prompts/issue/prompt.md");

  // Issue #4227: the issue run's escape hatch is gone; an approved issue is
  // completed, and the only exits are the defined markers.
  const noHandBack = flat(section(issuePrompt, "No hand-back, no follow-up"));
  for (
    const required of [
      "It is never handed to a human, and a follow-up",
      "Do not file an issue and then depend on it",
      "A closed, unreadable or self-filed dependency does not defer",
    ]
  ) {
    assertStringIncludes(noHandBack, required);
  }

  const acceptanceCriteriaClosure = flat(
    section(issuePrompt, "Acceptance-Criteria Closure"),
  );
  for (
    const required of [
      "Demonstrate a criterion; do not assert it",
      "must have been run on the final head",
      "one untested branch makes it `partial`",
      "An unmet criterion is not a PR",
      "The worker raises no PR until every criterion is met",
      "a planning marker defers or plans and raises no PR",
      "suspicious-image flag is the exception",
      "A closed, unreadable or self-filed dependency does not defer",
      "A bare `## Blocked:` heading does not defer",
    ]
  ) {
    assertStringIncludes(acceptanceCriteriaClosure, required);
  }
});

Deno.test("Issue #3058 - issue prompt holds docs the diff touches to the same rule", async () => {
  const body = flat(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "PR Summary File",
    ),
  );

  for (
    const required of [
      "Hold every doc the diff adds or edits to the same rule",
      "a claim whose subject the merge absorbed is dropped",
    ]
  ) {
    assertStringIncludes(body, required);
  }
});

Deno.test("Issue #3058 - coding guidelines defer a committed Blocked heading and keep the escape hatch uncommitted", async () => {
  const guidelinesPrompt = await readRepoDoc(
    "prompts/coding_guidelines/prompt.md",
  );

  const blockedOnAnotherIssue = flat(
    section(guidelinesPrompt, "Blocked on another issue"),
  );
  for (
    const required of [
      "In an issue run, the worker recognises that shape and **defers** the issue",
      "After a commit this deferral is honoured only when the `Depends on` / `Blocked by` line names an issue the worker reads as still open",
      "A CI-fix run is the exception",
      "Base-branch failures",
    ]
  ) {
    assertStringIncludes(blockedOnAnotherIssue, required);
  }

  const escapeHatch = flat(
    section(
      guidelinesPrompt,
      "Escape Hatch — Hand Off When Genuinely Out of Scope",
    ),
  );
  // Issue #4227: the escape hatch is the PR-feedback / CI-fix route only.
  for (
    const required of [
      "PR-feedback and CI-fix runs only",
      "an issue run has no escape hatch",
      "`.pr_response_message`",
    ]
  ) {
    assertStringIncludes(escapeHatch, required);
  }
});

Deno.test("Issue #3058 - CODING-STANDARDS.md carries the matching verification rules", async () => {
  const standards = await readRepoDoc("CODING-STANDARDS.md");

  const testCoverageExpectations = flat(
    section(standards, "Test coverage expectations"),
  );
  for (
    const required of [
      "run on the final head",
      "names the branches its tests exercise",
    ]
  ) {
    assertStringIncludes(testCoverageExpectations, required);
  }

  const prSummaryAndEvidence = flat(
    section(standards, "PR Summary and Evidence"),
  );
  for (
    const required of [
      "every doc the diff adds or edits",
      "the diff itself introduced",
      "core deliverable is `missing`",
      "genuinely blocked on another open issue after work is committed",
      "Depends on owner/repo#N",
      "A closed or unreadable dependency does not defer",
      "honoured after a commit as well as before one",
      "In an issue run, a hand-off",
      "A CI-fix run is the exception",
      "prompts/pr_feedback/prompt.md",
      ".pr_response_message",
    ]
  ) {
    assertStringIncludes(prSummaryAndEvidence, required);
  }
});
