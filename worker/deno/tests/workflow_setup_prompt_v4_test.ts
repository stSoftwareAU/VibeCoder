/**
 * Tests for workflow_setup prompt v4 (Issue #2638, follow-up to #2624).
 *
 * v4 lightly simplifies v3 for Fable 5: it states the "do not invent
 * alternatives / private-repo-14 workflow wins" rule once (v3 stated it both at
 * the top and bottom of the Gitleaks section) and trims the duplicated
 * action-pinning restatement in the General Requirements. The
 * workflow_setup prompt has no four-phase finding-stage scaffolding, so
 * the rest of the #2624 recipe does not apply.
 *
 * The load-bearing contracts are unchanged: every required placeholder,
 * the optional `{{VERBOSITY_INSTRUCTIONS}}`, and — per the issue note —
 * the `Gitleaks Reference Implementation` section and its private-repo-14 strings
 * verbatim (the worker has no H1 router for this prompt, but the
 * workflow_setup_prompt_test.ts latest-version test asserts the Gitleaks
 * string survives).
 *
 * Also guards immutability of v3 (Issue #235).
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("workflow_setup prompt v4 - loads via loadPrompt", async () => {
  const result = await loadPrompt("workflow_setup", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("workflow_setup prompt v4 - latest version is v4 or later", async () => {
  const result = await getLatestVersion("workflow_setup", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 4,
      true,
      `Expected workflow_setup prompt >= v4, got ${result.value}`,
    );
  }
});

Deno.test(
  "workflow_setup prompt v4 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("workflow_setup", "v4", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate(
      "workflow_setup",
      result.ok ? result.value : "",
    );
    assertEquals(v.ok, true);
  },
);

Deno.test(
  "workflow_setup prompt v4 - retains every required + optional placeholder",
  async () => {
    const result = await loadPrompt("workflow_setup", "v4", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    for (
      const ph of [
        "{{REPO}}",
        "{{LANGUAGES}}",
        "{{MISSING_WORKFLOWS}}",
        "{{DEFAULT_BRANCH}}",
        "{{EXISTING_WORKFLOWS}}",
        "{{CODING_GUIDELINES}}",
        "{{VERBOSITY_INSTRUCTIONS}}",
      ]
    ) {
      assertStringIncludes(result.value, ph);
    }
  },
);

Deno.test(
  "workflow_setup prompt v4 - keeps the private-repo-14 Gitleaks strings verbatim",
  async () => {
    const result = await loadPrompt("workflow_setup", "v4", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    assertStringIncludes(body, "Gitleaks Reference Implementation");
    assertStringIncludes(body, "stSoftwareAU/private-repo-14");
    assertStringIncludes(body, "GITLEAKS_LICENSE");
    assertStringIncludes(body, "ErrLicense");
    assert(
      /40-character\s+commit SHA/.test(body),
      "v4 must require a 40-character commit SHA pin",
    );
    assertStringIncludes(body, "Fetch base branch");
    assertStringIncludes(body, "github.base_ref");
    assertStringIncludes(body, "Invalid revision range");
    assertStringIncludes(body, "CI Hardening Defaults");
  },
);

Deno.test(
  "workflow_setup prompt v4 - latest version resolves to the Gitleaks pattern",
  async () => {
    // loadPrompt without an explicit version selects the latest file.
    const result = await loadPrompt("workflow_setup", undefined, PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assertStringIncludes(result.value, "Gitleaks Reference Implementation");
  },
);

Deno.test(
  "workflow_setup prompt v3 - immutable: keeps the duplicated closing 'source of truth' paragraph v4 drops (Issue #235)",
  async () => {
    const result = await loadPrompt("workflow_setup", "v3", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // v3 restated the source-of-truth rule in a trailing paragraph; v4
    // states it once inline. This sentence is unique to v3.
    assertStringIncludes(
      result.value,
      "This block of guidance is the source of truth for Gitleaks setup.",
    );
  },
);
