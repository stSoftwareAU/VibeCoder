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
 * This re-applies the strong wording: the worker is not on the
 * trusted-author allowlist, reserved labels are silently stripped by
 * `label_security`, the canonical pickup order, and the
 * `idle-task`-only exception. Prior prompt versions stay immutable
 * .
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";
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
    assertStringIncludes(prompt, "");
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

// --- New escape-hatch prompt versions ----------------------------------------

interface PromptUnderTest {
  name: string;
  version: string;
  previousVersion: string;
}

const PROMPTS: PromptUnderTest[] = [
  { name: "pr_feedback", version: "v10", previousVersion: "v9" },
  { name: "ci_fix", version: "v9", previousVersion: "v8" },
  { name: "issue", version: "v26", previousVersion: "v25" },
];

for (const { name, version } of PROMPTS) {
  Deno.test(`${name} ${version} - loads via loadPrompt`, async () => {
    const result = await loadPrompt(name, version, PROMPTS_DIR);
    assertEquals(result.ok, true);
  });

  Deno.test(`${name} ${version} - is at least the latest version`, async () => {
    const result = await getLatestVersion(name, PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      const num = parseInt(result.value.replace("v", ""), 10);
      const required = parseInt(version.replace("v", ""), 10);
      assertEquals(
        num >= required,
        true,
        `Expected ${name} >= ${version}, got ${result.value}`,
      );
    }
  });

  Deno.test(
    `${name} ${version} - forbids reserved labels on the follow-up issue`,
    async () => {
      const result = await loadPrompt(name, version, PROMPTS_DIR);
      assertEquals(result.ok, true);
      if (result.ok) {
        // The escape-hatch follow-up clause must name the prohibition and
        // its rationale.
        assertStringIncludes(result.value, "reserved workflow label");
        assertStringIncludes(result.value, "trusted-author allowlist");
        assertStringIncludes(result.value, "silently stripped");
        assertStringIncludes(result.value, "");
      }
    },
  );
}

// --- Prior versions remain immutable -----------------------------------------

for (const { name, previousVersion } of PROMPTS) {
  Deno.test(
    `${name} ${previousVersion} - has no escape-hatch label clause`,
    async () => {
      const result = await loadPrompt(name, previousVersion, PROMPTS_DIR);
      assertEquals(result.ok, true);
      if (result.ok) {
        // The new escape-hatch wording must not appear in the prior version.
        assertEquals(
          result.value.includes(
            "The follow-up issue you open must carry only descriptive labels",
          ),
          false,
          `${name} ${previousVersion} must remain immutable`,
        );
        assertEquals(
          result.value.includes(
            "The follow-up issue must carry only descriptive labels",
          ),
          false,
          `${name} ${previousVersion} must remain immutable`,
        );
      }
    },
  );
}
