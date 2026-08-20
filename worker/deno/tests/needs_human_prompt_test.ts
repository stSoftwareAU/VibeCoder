/**
 * Tests for the needs-human escalation directive added in:
 *   - coding_guidelines/v11.md
 *   - issue/v13.md
 *   - planning/v11.md
 *
 * See.
 *
 * These tests verify that the new prompt versions:
 *   1. Load via loadPrompt and are at least as new as the required version.
 *   2. Explicitly tell the worker to use `needs-human` for human escalation.
 *   3. Forbid self-applying `help wanted` / `work-on`.
 *   4. Retain every heading from the immediately preceding version.
 *   5. Leave prior versions untouched (immutability spot-checks).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- coding_guidelines v11 ---------------------------------------------------

Deno.test("coding_guidelines v11 - loads via loadPrompt", async () => {
  const result = await loadPrompt("coding_guidelines", "v11", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("coding_guidelines v11 - is at least the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(num >= 11, true, `Expected >= v11, got ${result.value}`);
  }
});

Deno.test("coding_guidelines v11 - has Human Escalation section with needs-human directive", async () => {
  const result = await loadPrompt("coding_guidelines", "v11", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "## Human Escalation");
    assertStringIncludes(result.value, "`needs-human`");
  }
});

Deno.test("coding_guidelines v11 - lists reserved workflow labels the worker must not self-apply", async () => {
  const result = await loadPrompt("coding_guidelines", "v11", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const label of ["work-on", "failed"]) {
      assertStringIncludes(result.value, `\`${label}\``);
    }
  }
});

Deno.test("coding_guidelines v11 - retains every v10 heading", async () => {
  const v10 = await loadPrompt("coding_guidelines", "v10", PROMPTS_DIR);
  const v11 = await loadPrompt("coding_guidelines", "v11", PROMPTS_DIR);
  assertEquals(v10.ok, true);
  assertEquals(v11.ok, true);
  if (v10.ok && v11.ok) {
    const headings = v10.value.split("\n").filter((l) => /^## /.test(l));
    for (const heading of headings) {
      assertStringIncludes(
        v11.value,
        heading,
        `v11 missing v10 heading: ${heading}`,
      );
    }
  }
});

Deno.test("coding_guidelines v10 - remains immutable (no needs-human directive)", async () => {
  const result = await loadPrompt("coding_guidelines", "v10", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.value.includes("## Human Escalation"),
      false,
      "v10 must not contain the v11 Human Escalation section",
    );
  }
});

// --- issue v13 ---------------------------------------------------------------

Deno.test("issue v13 - loads via loadPrompt", async () => {
  const result = await loadPrompt("issue", "v13", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("issue v13 - is at least the latest version", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(num >= 13, true, `Expected >= v13, got ${result.value}`);
  }
});

Deno.test("issue v13 - has Human Escalation section directing the worker to needs-human", async () => {
  const result = await loadPrompt("issue", "v13", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "## Human Escalation");
    assertStringIncludes(result.value, "`needs-human`");
    // Forbids self-applying work-on
    assertStringIncludes(result.value, "`work-on`");
  }
});

Deno.test("issue v13 - retains required placeholders for prompt builder", async () => {
  const result = await loadPrompt("issue", "v13", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // These placeholders are substituted by prompt_builder.ts — they must
    // remain in the template or prompt validation will fail.
    for (
      const placeholder of [
        "{{ISSUE_NUMBER}}",
        "{{CODING_GUIDELINES}}",
        "{{QUALITY_INSTRUCTIONS}}",
        "{{VERBOSITY_INSTRUCTIONS}}",
      ]
    ) {
      assertStringIncludes(
        result.value,
        placeholder,
        `issue v13 missing placeholder: ${placeholder}`,
      );
    }
  }
});

Deno.test("issue v13 - retains every v12 heading", async () => {
  const v12 = await loadPrompt("issue", "v12", PROMPTS_DIR);
  const v13 = await loadPrompt("issue", "v13", PROMPTS_DIR);
  assertEquals(v12.ok, true);
  assertEquals(v13.ok, true);
  if (v12.ok && v13.ok) {
    const headings = v12.value.split("\n").filter((l) => /^## /.test(l));
    for (const heading of headings) {
      assertStringIncludes(
        v13.value,
        heading,
        `v13 missing v12 heading: ${heading}`,
      );
    }
  }
});

Deno.test("issue v12 - remains immutable (no needs-human directive)", async () => {
  const result = await loadPrompt("issue", "v12", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.value.includes("## Human Escalation"),
      false,
      "v12 must not contain the v13 Human Escalation section",
    );
  }
});

// --- planning v11 ------------------------------------------------------------

Deno.test("planning v11 - loads via loadPrompt", async () => {
  const result = await loadPrompt("planning", "v11", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("planning v11 - is at least the latest version", async () => {
  const result = await getLatestVersion("planning", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(num >= 11, true, `Expected >= v11, got ${result.value}`);
  }
});

Deno.test("planning v11 - reserved label list includes needs-human", async () => {
  const result = await loadPrompt("planning", "v11", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "`needs-human`");
    // Adjacent reserved labels still present
    assertStringIncludes(result.value, "`work-on`");
  }
});

Deno.test("planning v11 - retains every v10 heading", async () => {
  const v10 = await loadPrompt("planning", "v10", PROMPTS_DIR);
  const v11 = await loadPrompt("planning", "v11", PROMPTS_DIR);
  assertEquals(v10.ok, true);
  assertEquals(v11.ok, true);
  if (v10.ok && v11.ok) {
    const headings = v10.value.split("\n").filter((l) => /^## /.test(l));
    for (const heading of headings) {
      assertStringIncludes(
        v11.value,
        heading,
        `v11 missing v10 heading: ${heading}`,
      );
    }
  }
});

Deno.test("planning v10 - remains immutable (needs-human not in reserved list)", async () => {
  const result = await loadPrompt("planning", "v10", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.value.includes("`needs-human`"),
      false,
      "v10 must not contain the v11 needs-human reserved-label entry",
    );
  }
});

// --- Universal "label + same-run comment" rule ----------------
//
// Every `needs-human` application must be paired with a same-run explanation
// comment. The four new prompt versions state this as a universal rule; the
// immediately-preceding versions must not (immutability per the prompt-version
// contract).

// Distinctive opening clause shared by all four new versions.
const UNIVERSAL_RULE =
  "Any time you apply the `needs-human` label — for any reason — you must on the same run post a comment";

const UNIVERSAL_RULE_NEW: ReadonlyArray<[string, string]> = [
  ["coding_guidelines", "v23"],
  ["issue", "v24"],
  ["pr_feedback", "v8"],
  ["ci_fix", "v7"],
];

// The immediately-preceding versions that must stay free of the new wording.
const UNIVERSAL_RULE_OLD: ReadonlyArray<[string, string]> = [
  ["coding_guidelines", "v22"],
  ["issue", "v23"],
  ["pr_feedback", "v7"],
  ["ci_fix", "v6"],
];

for (const [name, version] of UNIVERSAL_RULE_NEW) {
  Deno.test(`${name} ${version} - states the universal needs-human comment rule`, async () => {
    const result = await loadPrompt(name, version, PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value, UNIVERSAL_RULE);
    }
  });

  Deno.test(`${name} ${version} - is at least the latest version`, async () => {
    const latest = await getLatestVersion(name, PROMPTS_DIR);
    assertEquals(latest.ok, true);
    if (latest.ok) {
      const num = parseInt(latest.value.replace("v", ""), 10);
      const want = parseInt(version.replace("v", ""), 10);
      assertEquals(
        num >= want,
        true,
        `Expected ${name} latest >= ${version}, got ${latest.value}`,
      );
    }
  });
}

for (const [name, version] of UNIVERSAL_RULE_OLD) {
  Deno.test(`${name} ${version} - remains immutable (no universal-rule wording)`, async () => {
    const result = await loadPrompt(name, version, PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(
        result.value.includes(UNIVERSAL_RULE),
        false,
        `${name} ${version} must not contain the universal-rule wording`,
      );
    }
  });
}
