/**
 * The close a planning run is ordered to make is no longer contradicted by
 * the block rendered above it (Issue #781).
 *
 * `buildPlanningCritiquePrompt` renders the phase template **and** the shared
 * `coding_guidelines` block into one prompt. The template's final step orders
 * `gh issue close … --reason completed` and says "your inline close is the
 * source of truth and must always run"; the shared block said `gh issue close`
 * "on any issue in the repo you are working" is refused. One prompt, both
 * statements.
 *
 * The behaviour was never wrong — `claimed_issue_guard.ts` is inert until a
 * run seeds it, and only the implementation route does, so the planning close
 * genuinely works. The shared block's unconditional scope was the inaccurate
 * half, and it now defers to the phase prompt.
 *
 * These cases assert the resolution where it matters: on the **rendered**
 * prompt, which is the artefact the agent reads, and against the real guard,
 * so the prose is checked against the behaviour it describes rather than
 * against itself.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildIssuePrompt,
  buildPlanningCritiquePrompt,
} from "../lib/prompt_builder.ts";
import { loadPrompt } from "../lib/prompt_manager.ts";
import {
  DEFAULT_CLAIMED_ISSUE_ALLOWED_VERBS,
  seedClaimedIssueGuard,
} from "../lib/claimed_issue_guard.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The order the planning-critique template gives as its final step. */
const CLOSE_ORDER = "gh issue close {{ISSUE_NUMBER}} --repo {{REPO}}";

/** The sentence that now subordinates the shared block to the phase prompt. */
const DEFERRAL = "Unless your phase prompt orders the close itself";

/** The rendered planning-critique prompt, template plus injected guidelines. */
async function renderCritique(): Promise<string> {
  const result = await buildPlanningCritiquePrompt({
    repo: "owner/repo",
    issueNumber: "781",
    issueTitle: "Plan it",
    issueBody: "Break this down",
    issueLabels: "planning",
    draftPlan: "Draft: three sub-issues.",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.message);
  return `${result.value.systemPrompt}\n${result.value.prompt}`;
}

Deno.test("issue lifecycle - the rendered critique prompt carries both the order and its exemption (Issue #781)", async () => {
  const rendered = await renderCritique();

  // The order is still there — the behaviour is not what changed.
  assertStringIncludes(rendered, "close this issue");
  assertStringIncludes(rendered, "must always run");
  // …and so is the refusal, which is right for every other route.
  assertStringIncludes(rendered, "ISSUE_LIFECYCLE_REFUSED");
  // What is new is the sentence that stops the two contradicting.
  assertStringIncludes(rendered, DEFERRAL);
});

Deno.test("issue lifecycle - the exemption is stated after the refusal it qualifies (Issue #781)", async () => {
  // Order matters in prose: a qualification the reader meets before the rule
  // it qualifies reads as a different rule.
  const rendered = await renderCritique();
  const refusal = rendered.indexOf("ISSUE_LIFECYCLE_REFUSED");
  const deferral = rendered.indexOf(DEFERRAL);
  assert(refusal >= 0 && deferral >= 0);
  assert(
    deferral > refusal,
    "the exemption must qualify the refusal, not precede it",
  );
});

Deno.test("issue lifecycle - the guidelines defer, and the implementation prompt says the guard is armed (Issue #781)", async () => {
  const guidelinesText = await loadPrompt("coding_guidelines", PROMPTS_DIR);
  assertEquals(guidelinesText.ok, true);
  if (!guidelinesText.ok) return;
  assertStringIncludes(guidelinesText.value, DEFERRAL);

  // The `issue` route is the one that *does* arm the guard, so its own prompt
  // says so rather than deferring to a phase prompt that is itself.
  const issueText = await loadPrompt("issue", PROMPTS_DIR);
  assertEquals(issueText.ok, true);
  if (!issueText.ok) return;
  // The prompt wraps its prose, so the fragment must not cross a line break.
  assertStringIncludes(issueText.value, "This route arms that");
});

Deno.test("issue lifecycle - the planning-critique template still orders the close (Issue #781)", async () => {
  // The exemption is only worth having while the order it protects exists.
  const result = await loadPrompt("planning_critique", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertStringIncludes(result.value, CLOSE_ORDER);
});

Deno.test("issue lifecycle - the guard the prompts describe refuses close only when seeded (Issue #781)", () => {
  // The prose is checked against the behaviour, not against itself: an
  // implementation run seeds the guard and permits `edit` alone, which is why
  // the refusal is unconditional there — and why a route that never seeds it
  // (the planning ones) can be ordered to close.
  seedClaimedIssueGuard("owner/repo", 781);
  assertEquals(DEFAULT_CLAIMED_ISSUE_ALLOWED_VERBS, ["edit"]);
  assertEquals(
    DEFAULT_CLAIMED_ISSUE_ALLOWED_VERBS.includes("close"),
    false,
    "a seeded run must never permit close — that is the rule the exemption " +
      "is careful not to widen",
  );
});

Deno.test("issue lifecycle - an implementation prompt is never told to close its issue (Issue #781)", async () => {
  // The exemption says "unless your phase prompt orders the close". That is
  // only safe while the armed route's prompt gives no such order.
  const result = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "781",
    issueTitle: "Do the work",
    issueBody: "Body",
    issueLabels: "bug",
    qualityInstructions: "Run ./quality.sh",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const rendered = `${result.value.systemPrompt}\n${result.value.prompt}`;
  assertEquals(
    /must be to close this issue|inline close is the source of truth/.test(
      rendered,
    ),
    false,
    "the armed route must carry no close order for the exemption to release",
  );
});
