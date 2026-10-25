/**
 * Tests for the re-hardened reserved-label wording.
 *
 * The soft prompt rule that stopped the worker self-applying reserved
 * workflow labels regressed in two spots:
 *
 *   1. The inline planning prompts built in `planning_processor.ts`
 *      (`buildSingleInvocationPlanningPrompt` + the mirrored draft-turn
 *      builder) carried only a soft one-liner with no rationale.
 *   2. The escape-hatch sections of the `pr_feedback`, `ci_fix`, and
 *      `issue` prompts told Claude to open a follow-up issue and mention
 *      `needs-human`, but never told it not to add reserved labels to
 *      that follow-up.
 *
 * This re-applies the strong wording. The inline planning prompts state the
 * full rationale — the worker is not on the trusted-author allowlist, reserved
 * labels are silently stripped by `label_security`, the canonical pickup
 * order, and the `idle-task`-only exception. No prompt has an escape hatch
 * any more (Issues #4227, #4304), so none files a follow-up issue.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildFallbackDraftPlanningPrompt,
  buildSingleInvocationPlanningPrompt,
  RESERVED_LABEL_PROHIBITION,
} from "../lib/planning_processor.ts";

// --- Inline planning prompts carry the full rationale ------------------------

const planningCases: { label: string; prompt: string }[] = [
  {
    label: "buildSingleInvocationPlanningPrompt",
    prompt: buildSingleInvocationPlanningPrompt({
      repo: "stSoftwareAU/VibeCoder",
      issueNumber: 2826,
      issueTitle: "Example planning issue",
      issueBody: "Body text describing the work to break down.",
    }),
  },
  {
    label: "buildFallbackDraftPlanningPrompt",
    prompt: buildFallbackDraftPlanningPrompt({
      issueNumber: 2826,
      issueTitle: "Example planning issue",
      issueBody: "Body text describing the work to break down.",
    }),
  },
];

for (const { label, prompt } of planningCases) {
  Deno.test(`${label} - names the trusted-author allowlist rationale`, () => {
    assertStringIncludes(prompt, "trusted-author allowlist");
  });

  Deno.test(`${label} - states reserved labels are silently stripped`, () => {
    assertStringIncludes(prompt, "silently stripped");
  });

  Deno.test(`${label} - cites label_security`, () => {
    assertStringIncludes(prompt, "label_security");
  });

  Deno.test(`${label} - names the idle-task-only exception`, () => {
    assertStringIncludes(prompt, "`idle-task` is self-appliable");
  });

  Deno.test(`${label} - lists the canonical pickup-priority order`, () => {
    assertStringIncludes(
      prompt,
      "`top-priority` > `work-on` > `low-priority` > `idle-task`",
    );
  });

  Deno.test(`${label} - is no longer the soft one-liner`, () => {
    // The regressed wording carried no rationale at all.
    assertEquals(
      prompt.includes(
        "not reserved workflow labels. Then post one summary comment",
      ),
      false,
    );
  });
}

Deno.test("RESERVED_LABEL_PROHIBITION - bundles every reserved label", () => {
  for (
    const lbl of [
      "`top-priority`",
      "`work-on`",
      "`low-priority`",
      "`failed`",
      "`refine-issue`",
      "`planning`",
      "`question`",
      "`best-model`",
      "`needs-human`",
    ]
  ) {
    assertStringIncludes(RESERVED_LABEL_PROHIBITION, lbl);
  }
});
