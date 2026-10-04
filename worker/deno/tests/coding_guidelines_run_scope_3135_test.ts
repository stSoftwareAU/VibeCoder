/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3135 — two fleet PRs added a rule to a layer-scoped prompt that held
 * for only some of the run types that load it: one told every run that a
 * `Depends on owner/repo#N` hand-off is not read once work is committed,
 * while a CI-fix run always has commits and `_resolveBaseBranchDeferral`
 * reads it from `.pr_response_message` (#3075); one said the escape hatch is
 * honoured only when the run leaves no commit, while `detectEscapeHatch`
 * runs on `.pr_response_message` whatever the branch holds (#3095).
 * CODING-STANDARDS.md and docs/EXTENDING.md must both tell the agent to
 * scope a claim about the worker's behaviour to the runs it actually holds
 * for, since `prompts/coding_guidelines/prompt.md`'s `code` layer is shared
 * by several run types rather than belonging to the issue run alone.
 *
 * Issue #3154 adds the same run-scope check against the prompt itself: the
 * Escape Hatch's "do not close the issue yourself" step claimed the
 * claim-release-and-hand-to-a-human behaviour for every run that loads the
 * `code` layer, when it only holds for an issue run.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";
import { CODING_GUIDELINES_LAYER_BY_PHASE } from "../lib/prompt_builder.ts";
import { selectCodingGuidelinesLayer } from "../lib/coding_guidelines_overlay.ts";

const STANDARDS_KEY_PHRASES = [
  "Scope a rule to the runs it is true for",
  'a layer marker cannot say "issue runs only"',
  "check it against the processor for each run that loads it",
  "name those runs in the sentence",
  "that run type's own `prompts/<type>/prompt.md`",
];

Deno.test("CODING-STANDARDS.md Prompt Engineering Guidance requires scoping a rule to the runs it holds for (Issue #3135)", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Prompt Engineering Guidance",
    ),
  );

  for (const phrase of STANDARDS_KEY_PHRASES) {
    assert(
      text.includes(phrase),
      `Prompt Engineering Guidance is missing "${phrase}": ${text}`,
    );
  }

  // The rule's premise — the `code` layer spans several run types, not just
  // `issue` — is checked against the live table, not retyped here.
  assertEquals(CODING_GUIDELINES_LAYER_BY_PHASE.issue, "code");
  assertEquals(CODING_GUIDELINES_LAYER_BY_PHASE.ci_fix, "code");
  assertEquals(CODING_GUIDELINES_LAYER_BY_PHASE.pr_feedback, "code");
});

const EXTENDING_KEY_PHRASES = [
  "Scope a rule to the runs it is true for",
  "must hold for every run that loads it",
];

Deno.test("docs/EXTENDING.md Phase-scoped coding-guidelines layers points at the run-scope rule (Issue #3135)", async () => {
  const text = flat(
    section(
      await readRepoDoc("docs/EXTENDING.md"),
      "Phase-scoped coding-guidelines layers",
    ),
  );

  for (const phrase of EXTENDING_KEY_PHRASES) {
    assert(
      text.includes(phrase),
      `Phase-scoped coding-guidelines layers is missing "${phrase}": ${text}`,
    );
  }
});

Deno.test("Escape Hatch rendered for a PR-feedback run scopes the claim-release sentence to issue runs (Issue #3154)", async () => {
  const template = await readRepoDoc("prompts/coding_guidelines/prompt.md");
  const selected = selectCodingGuidelinesLayer(
    template,
    CODING_GUIDELINES_LAYER_BY_PHASE.pr_feedback,
  );
  if (!selected.ok) {
    throw new Error(`selectCodingGuidelinesLayer failed: ${selected.error}`);
  }

  const escapeHatch = flat(
    section(
      selected.value,
      "Escape Hatch — Hand Off When Genuinely Out of Scope",
    ),
  );

  assert(
    escapeHatch.includes(
      "A PR-feedback or CI-fix run keeps using the `.pr_response_message` escape hatch",
    ),
    `Escape Hatch dropped the PR-feedback/CI-fix exception: ${escapeHatch}`,
  );

  const sentences = escapeHatch.split(/(?<=\.)\s+/);
  let matched = 0;
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (
      !lower.includes("releases its claim") &&
      !lower.includes("once work is committed")
    ) {
      continue;
    }
    matched++;
    assert(
      sentence.includes("In an issue run"),
      `Sentence about claim release or hand-off is not scoped to issue runs: "${sentence}"`,
    );
  }
  assert(
    matched > 0,
    `no sentence matched the claim-release filter: ${escapeHatch}`,
  );
});
