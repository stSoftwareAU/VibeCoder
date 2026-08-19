/**
 * Tests for planning_critique v3 (Issue #2994).
 *
 * v3 amends the final close rule so a zero-sub-issue close only happens when
 * there is genuinely nothing to do. When the run produced zero sub-issues but
 * real work remains, the prompt now instructs Claude to create exactly one
 * pickup-labelled carrier sub-issue (with `Part of #parent`) before closing the
 * parent. The genuinely-nothing-to-do carve-out (invalid / duplicate / already
 * implemented) still closes with zero sub-issues and no carrier, gated by an
 * explicit `Nothing to do — <reason>` signal.
 *
 * v2 (and earlier) must remain immutable (Issue #235).
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("planning_critique v3 - loads via loadPrompt", async () => {
  const result = await loadPrompt("planning_critique", "v3", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("planning_critique v3 - is the latest version", async () => {
  const result = await getLatestVersion("planning_critique", PROMPTS_DIR);
  assert(result.ok);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 3,
    true,
    `Expected planning_critique >= v3, got ${result.value}`,
  );
});

Deno.test("planning_critique v3 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("planning_critique", "v3", PROMPTS_DIR);
  assert(result.ok);
  if (!result.ok) return;
  const v = validatePromptTemplate("planning_critique", result.value);
  assertEquals(v.ok, true);
});

Deno.test(
  "planning_critique v3 - drops the unconditional zero-sub-issue close",
  async () => {
    const result = await loadPrompt("planning_critique", "v3", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // The v2 wording closed unconditionally "whether you created zero, one, or
    // many sub-issues". v3 must no longer instruct a zero-sub-issue close
    // unconditionally.
    assert(
      !result.value.includes("whether you created zero, one, or many"),
      "v3 must not instruct an unconditional zero-sub-issue close",
    );
  },
);

Deno.test(
  "planning_critique v3 - instructs a carrier sub-issue when real work remains",
  async () => {
    const result = await loadPrompt("planning_critique", "v3", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    assert(body.includes("carrier"), "v3 must describe a carrier sub-issue");
    // The carrier must reference the parent and be the default for a
    // zero-sub-issue outcome.
    assert(
      body.includes("Part of #{{ISSUE_NUMBER}}"),
      "the carrier must reference the parent issue",
    );
    assert(
      // Strip markdown emphasis before matching ("exactly **one**").
      body.replace(/\*/g, "").toLowerCase().includes("exactly one"),
      "v3 must instruct exactly one carrier sub-issue",
    );
  },
);

Deno.test(
  "planning_critique v3 - keeps the nothing-to-do carve-out with an explicit signal",
  async () => {
    const result = await loadPrompt("planning_critique", "v3", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    const body = result.value;
    assert(
      body.includes("Nothing to do —"),
      "v3 must define the explicit nothing-to-do signal",
    );
    // The carve-out names the genuinely-empty cases.
    for (const reason of ["invalid", "duplicate", "wontfix"]) {
      assert(
        body.includes(reason),
        `v3 carve-out must name the ${reason} case`,
      );
    }
  },
);

Deno.test(
  "planning_critique v3 - carrier uses descriptive labels, not reserved workflow labels",
  async () => {
    const result = await loadPrompt("planning_critique", "v3", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    // The carrier must be labelled like sibling sub-issues (descriptive) so the
    // worker picks it up; an unlabelled carrier would reproduce the bug.
    assert(
      result.value.includes('--label "enhancement"'),
      "v3 carrier example must use a descriptive label",
    );
  },
);

Deno.test(
  "planning_critique v2 - immutable: retains the unconditional zero-sub-issue close (Issue #235)",
  async () => {
    const result = await loadPrompt("planning_critique", "v2", PROMPTS_DIR);
    assert(result.ok);
    if (!result.ok) return;
    assert(
      result.value.includes("whether you created zero, one, or many"),
      "v2 must remain the pre-#2994 prompt",
    );
    assert(
      !result.value.includes("carrier"),
      "v2 must not mention the carrier concept introduced in v3",
    );
  },
);
