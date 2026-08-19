/**
 * Tests for the reinforced reserved-label warning (Issue #2040).
 *
 * The worker had been adding the `question` label to issues it was
 * working on. Because the worker is not on the trusted-author allowlist,
 * `label_security` silently strips the label — but the prompt did not
 * explain WHY adding it was wrong, so the model kept doing it. v2040
 * adds three specific facts to the prompts:
 *
 *   1. The worker is NOT a trusted/authorised author.
 *   2. Any reserved workflow label the worker applies will be silently
 *      STRIPPED by `label_security` (Issue #1344).
 *   3. `question` is especially harmful because humans use that label
 *      to ASK the Vibe Coder a question — self-applying it either
 *      triggers an unintended question-answering run or is stripped
 *      and wastes the run.
 *
 * Earlier prompt versions must remain immutable (Issue #235).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

interface PromptUnderTest {
  name: string;
  version: string;
  previousVersion: string;
}

const PROMPTS: PromptUnderTest[] = [
  { name: "coding_guidelines", version: "v21", previousVersion: "v20" },
  { name: "issue", version: "v22", previousVersion: "v21" },
  { name: "planning", version: "v15", previousVersion: "v14" },
  { name: "grill-me", version: "v7", previousVersion: "v6" },
];

// --- Each new version exists and is the latest ---

for (const { name, version } of PROMPTS) {
  Deno.test(`${name} ${version} - loads via loadPrompt`, async () => {
    const result = await loadPrompt(name, version, PROMPTS_DIR);
    assertEquals(result.ok, true);
  });

  Deno.test(`${name} ${version} - is the latest version`, async () => {
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
}

// --- Reinforced warning content ---

for (const { name, version } of PROMPTS) {
  Deno.test(
    `${name} ${version} - explains the worker is not a trusted author`,
    async () => {
      const result = await loadPrompt(name, version, PROMPTS_DIR);
      assertEquals(result.ok, true);
      if (result.ok) {
        // The wording must surface the trust-allowlist reality so the
        // model understands WHY the label is rejected.
        const lower = result.value.toLowerCase();
        const matchesAuthored = lower.includes("not an authorised author") ||
          lower.includes("not on the trusted-author allowlist");
        assertEquals(
          matchesAuthored,
          true,
          `Expected ${name} ${version} to explain the worker is not a trusted/authorised author`,
        );
      }
    },
  );

  Deno.test(
    `${name} ${version} - states reserved labels will be silently stripped`,
    async () => {
      const result = await loadPrompt(name, version, PROMPTS_DIR);
      assertEquals(result.ok, true);
      if (result.ok) {
        const lower = result.value.toLowerCase();
        const explainsStripping = lower.includes("silently stripped") ||
          lower.includes("will be stripped");
        assertEquals(
          explainsStripping,
          true,
          `Expected ${name} ${version} to state reserved labels are stripped`,
        );
      }
    },
  );

  Deno.test(
    `${name} ${version} - cites label_security (Issue #1344)`,
    async () => {
      const result = await loadPrompt(name, version, PROMPTS_DIR);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertStringIncludes(result.value, "#1344");
      }
    },
  );

  Deno.test(
    `${name} ${version} - calls out the 'question' label specifically`,
    async () => {
      const result = await loadPrompt(name, version, PROMPTS_DIR);
      assertEquals(result.ok, true);
      if (result.ok) {
        // The body must explain that humans use 'question' to ASK the
        // Vibe Coder — applying it on the worker side is nonsensical.
        const lower = result.value.toLowerCase();
        const callsOutQuestion = lower.includes("`question`") &&
          (lower.includes("ask the vibe coder") ||
            lower.includes("how humans ask") ||
            lower.includes("how a human asks"));
        assertEquals(
          callsOutQuestion,
          true,
          `Expected ${name} ${version} to explicitly explain why self-applying 'question' is harmful`,
        );
      }
    },
  );

  Deno.test(
    `${name} ${version} - references Issue #2040`,
    async () => {
      const result = await loadPrompt(name, version, PROMPTS_DIR);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertStringIncludes(result.value, "#2040");
      }
    },
  );
}

// --- Prior versions remain immutable ---

for (const { name, previousVersion } of PROMPTS) {
  Deno.test(
    `${name} ${previousVersion} - remains immutable (no #2040 marker)`,
    async () => {
      const result = await loadPrompt(name, previousVersion, PROMPTS_DIR);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(
          result.value.includes("#2040"),
          false,
          `${name} ${previousVersion} must not mention #2040 — prior versions are immutable`,
        );
        assertEquals(
          result.value.includes("silently stripped"),
          false,
          `${name} ${previousVersion} must remain immutable — must not contain the new wording`,
        );
      }
    },
  );
}

// --- Existing reserved-label list still present ---

for (const { name, version } of PROMPTS) {
  Deno.test(
    `${name} ${version} - retains the reserved labels list`,
    async () => {
      const result = await loadPrompt(name, version, PROMPTS_DIR);
      assertEquals(result.ok, true);
      if (result.ok) {
        for (
          const label of [
            "`top-priority`",
            "`work-on`",
            "`question`",
            "`needs-human`",
            "`planning`",
          ]
        ) {
          assertStringIncludes(result.value, label);
        }
      }
    },
  );
}
