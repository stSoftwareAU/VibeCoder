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
 * order, and the `idle-task`-only exception. The escape-hatch sections state
 * the rule that applies to an issue the agent just filed (Issue #780): every
 * reserved label on it, `needs-human` included, is removed after creation.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import {
  buildFallbackDraftPlanningPrompt,
  buildSingleInvocationPlanningPrompt,
  RESERVED_LABEL_PROHIBITION,
} from "../lib/planning_processor.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

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

// --- The escape-hatch prompts ------------------------------------------------

/** Every prompt whose escape-hatch section opens a follow-up issue. */
const PROMPTS = ["pr_feedback", "ci_fix", "issue"] as const;

for (const name of PROMPTS) {
  Deno.test(`${name} - loads via loadPrompt`, async () => {
    const result = await loadPrompt(name, PROMPTS_DIR);
    assertEquals(result.ok, true);
  });

  Deno.test(
    `${name} - forbids reserved labels on the follow-up issue`,
    async () => {
      const result = await loadPrompt(name, PROMPTS_DIR);
      assertEquals(result.ok, true);
      if (result.ok) {
        // The escape-hatch follow-up clause must name the prohibition and
        // its rationale. The clause wraps across lines in every template, so
        // the comparison is on collapsed whitespace.
        const collapsed = result.value.replace(/\s+/g, " ");
        assertStringIncludes(
          collapsed,
          "The follow-up issue you open must carry only descriptive labels",
        );
        assertStringIncludes(
          collapsed,
          "do **not** add any reserved workflow label",
        );
        // Issue #780 replaced the "silently stripped" rationale here: on an
        // issue the agent just filed, every reserved label goes after
        // creation, so applying one achieves nothing.
        assertStringIncludes(collapsed, "is removed after creation");
      }
    },
  );
}
