/**
 * Tests for Issue #2033 — retired labels dropped from prompt reserved lists.
 *
 * Six new prompt versions drop the retired labels (`refined`, `answered`,
 * `needs-clarification`, `skip-clarification`) and the deprecated discovery
 * labels (`claude`, `help wanted`) from their reserved/forbidden lists:
 *
 *   - coding_guidelines/v21.md (based on v20)
 *   - issue/v22.md             (based on v21)
 *   - planning/v15.md          (based on v14)
 *   - grill-me/v7.md           (based on v6)
 *   - question/v6.md           (based on v5)
 *   - security_scan/v4.md      (based on v3)
 *
 * Each test asserts:
 *   1. The new version loads via loadPrompt and is at least the latest.
 *   2. None of the retired labels appear in the file body.
 *   3. The remaining reserved labels (or workflow guidance) survive.
 *   4. Prior versions remain immutable (still contain at least one of the
 *      retired entries, proving they were not edited in place).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Labels retired by Issues #2029-#2032 — must not appear in the new versions. */
const RETIRED_LABEL_TOKENS = [
  "`refined`",
  "`answered`",
  "`needs-clarification`",
  "`skip-clarification`",
  "`claude`",
  "`help wanted`",
] as const;

function assertNoRetiredLabels(body: string, version: string): void {
  for (const token of RETIRED_LABEL_TOKENS) {
    assertEquals(
      body.includes(token),
      false,
      `${version} must not mention ${token}`,
    );
  }
}

// --- coding_guidelines/v21.md ------------------------------------------------

Deno.test("coding_guidelines v21 - loads via loadPrompt", async () => {
  const result = await loadPrompt("coding_guidelines", "v21", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("coding_guidelines v21 - is at least the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 21,
      true,
      `Expected coding_guidelines >= v21, got ${result.value}`,
    );
  }
});

Deno.test(
  "coding_guidelines v21 - drops every retired label from reserved list",
  async () => {
    const result = await loadPrompt("coding_guidelines", "v21", PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) assertNoRetiredLabels(result.value, "coding_guidelines v21");
  },
);

Deno.test(
  "coding_guidelines v21 - keeps needs-human handoff and pickup-priority order",
  async () => {
    const result = await loadPrompt("coding_guidelines", "v21", PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(
        result.value,
        "Use `needs-human` — and only `needs-human`",
      );
      assertStringIncludes(
        result.value,
        "`top-priority` > `work-on` > `low-priority` > `idle-task`",
      );
      // Surviving reserved labels still present.
      for (const label of ["`top-priority`", "`work-on`", "`question`"]) {
        assertStringIncludes(result.value, label);
      }
    }
  },
);

Deno.test(
  "coding_guidelines v20 - immutable (still mentions a retired label)",
  async () => {
    const result = await loadPrompt("coding_guidelines", "v20", PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      // At least one retired token must remain so we know v20 is untouched.
      const stillThere = RETIRED_LABEL_TOKENS.some((t) =>
        result.value.includes(t)
      );
      assertEquals(stillThere, true, "v20 must remain untouched");
    }
  },
);

// --- issue/v22.md ------------------------------------------------------------

Deno.test("issue v22 - loads via loadPrompt", async () => {
  const result = await loadPrompt("issue", "v22", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("issue v22 - is at least the latest version", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(num >= 22, true, `Expected issue >= v22, got ${result.value}`);
  }
});

Deno.test("issue v22 - drops every retired label", async () => {
  const result = await loadPrompt("issue", "v22", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) assertNoRetiredLabels(result.value, "issue v22");
});

Deno.test("issue v22 - keeps required prompt-builder placeholders", async () => {
  const result = await loadPrompt("issue", "v22", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (
      const placeholder of [
        "{{ISSUE_NUMBER}}",
        "{{CODING_GUIDELINES}}",
        "{{QUALITY_INSTRUCTIONS}}",
        "{{VERBOSITY_INSTRUCTIONS}}",
      ]
    ) {
      assertStringIncludes(result.value, placeholder);
    }
  }
});

Deno.test("issue v21 - immutable (still mentions a retired label)", async () => {
  const result = await loadPrompt("issue", "v21", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const stillThere = RETIRED_LABEL_TOKENS.some((t) =>
      result.value.includes(t)
    );
    assertEquals(stillThere, true, "issue v21 must remain untouched");
  }
});

// --- planning/v15.md ---------------------------------------------------------

Deno.test("planning v15 - loads via loadPrompt", async () => {
  const result = await loadPrompt("planning", "v15", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("planning v15 - is at least the latest version", async () => {
  const result = await getLatestVersion("planning", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 15,
      true,
      `Expected planning >= v15, got ${result.value}`,
    );
  }
});

Deno.test("planning v15 - drops every retired label", async () => {
  const result = await loadPrompt("planning", "v15", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) assertNoRetiredLabels(result.value, "planning v15");
});

Deno.test(
  "planning v15 - keeps the surviving reserved labels and needs-human note",
  async () => {
    const result = await loadPrompt("planning", "v15", PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      for (
        const label of [
          "`top-priority`",
          "`work-on`",
          "`needs-human`",
          "`refine-issue`",
          "`planning`",
          "`question`",
          "`best-model`",
        ]
      ) {
        assertStringIncludes(result.value, label);
      }
    }
  },
);

Deno.test("planning v14 - immutable (still mentions a retired label)", async () => {
  const result = await loadPrompt("planning", "v14", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const stillThere = RETIRED_LABEL_TOKENS.some((t) =>
      result.value.includes(t)
    );
    assertEquals(stillThere, true, "planning v14 must remain untouched");
  }
});

// --- grill-me/v7.md ----------------------------------------------------------

Deno.test("grill-me v7 - loads via loadPrompt", async () => {
  const result = await loadPrompt("grill-me", "v7", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("grill-me v7 - is at least the latest version", async () => {
  const result = await getLatestVersion("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 7,
      true,
      `Expected grill-me >= v7, got ${result.value}`,
    );
  }
});

Deno.test("grill-me v7 - drops every retired label from forbidden list", async () => {
  const result = await loadPrompt("grill-me", "v7", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) assertNoRetiredLabels(result.value, "grill-me v7");
});

Deno.test("grill-me v6 - immutable (still mentions a retired label)", async () => {
  const result = await loadPrompt("grill-me", "v6", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const stillThere = RETIRED_LABEL_TOKENS.some((t) =>
      result.value.includes(t)
    );
    assertEquals(stillThere, true, "grill-me v6 must remain untouched");
  }
});

// --- question/v6.md ----------------------------------------------------------

Deno.test("question v6 - loads via loadPrompt", async () => {
  const result = await loadPrompt("question", "v6", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("question v6 - is at least the latest version", async () => {
  const result = await getLatestVersion("question", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 6,
      true,
      `Expected question >= v6, got ${result.value}`,
    );
  }
});

Deno.test(
  "question v6 - replaces the `answered` post-answer signal with `needs-human`",
  async () => {
    const result = await loadPrompt("question", "v6", PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(
        result.value.includes("`answered`"),
        false,
        "question v6 must not mention the retired `answered` label",
      );
      assertStringIncludes(result.value, "{{QUESTION_LABEL}}");
      assertStringIncludes(result.value, "`needs-human`");
    }
  },
);

Deno.test("question v5 - immutable (still mentions a retired label)", async () => {
  const result = await loadPrompt("question", "v5", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const stillThere = RETIRED_LABEL_TOKENS.some((t) =>
      result.value.includes(t)
    );
    assertEquals(stillThere, true, "question v5 must remain untouched");
  }
});

// --- security_scan/v4.md -----------------------------------------------------

Deno.test("security_scan v4 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan v4 - is at least the latest version", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 4,
      true,
      `Expected security_scan >= v4, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan v4 - drops every retired label from the worker label list",
  async () => {
    const result = await loadPrompt("security_scan", "v4", PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) assertNoRetiredLabels(result.value, "security_scan v4");
  },
);

Deno.test(
  "security_scan v3 - immutable (still mentions a retired label)",
  async () => {
    const result = await loadPrompt("security_scan", "v3", PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      const stillThere = RETIRED_LABEL_TOKENS.some((t) =>
        result.value.includes(t)
      );
      assertEquals(stillThere, true, "security_scan v3 must remain untouched");
    }
  },
);
