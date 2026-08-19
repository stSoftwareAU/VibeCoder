/**
 * Tests for the best-practices orchestrator bump to v3 (Issue #2270).
 *
 * v3 adds two cross-bucket framing sections — dead dependencies and
 * deprecated config on framework bump (Issue #2263) — naming each rule
 * once at the orchestrator level. The per-bucket detections live in the
 * bucket guides (#2268, #2269).
 *
 * Australian English spelling used throughout.
 */

import { assert } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function readPrompt(rel: string): Promise<string> {
  return await Deno.readTextFile(`${PROMPTS_DIR}/${rel}`);
}

Deno.test(
  "best_practices - loadPrompt resolves the latest version's heading",
  async () => {
    // The latest best_practices prompt heading must match whatever version
    // getLatestVersion resolves. Derived rather than hard-pinned so a routine
    // version bump (e.g. Issue #3509's citation cleanup, which shipped v6) no
    // longer breaks this test.
    const latest = await getLatestVersion("best_practices", PROMPTS_DIR);
    assert(latest.ok, "getLatestVersion should succeed for best_practices");
    if (!latest.ok) return;
    const result = await loadPrompt("best_practices", undefined, PROMPTS_DIR);
    assert(result.ok, "loadPrompt should succeed for best_practices");
    if (!result.ok) return;
    const firstLine = result.value.split("\n")[0] ?? "";
    assert(
      firstLine.includes(`(${latest.value})`),
      `first heading should read '(${latest.value})', got: ${firstLine}`,
    );
  },
);

Deno.test(
  "best_practices/v3.md - contains both new cross-bucket sections",
  async () => {
    const body = await readPrompt("best_practices/v3.md");
    assert(
      body.startsWith("# Best-Practices Review — Bucket-Scoped (v3)"),
      "v3.md must start with the (v3) heading",
    );
    for (
      const heading of [
        "### Cross-bucket: dead dependencies (Issue #2263)",
        "### Cross-bucket: deprecated config on framework bump (Issue #2263)",
      ]
    ) {
      assert(
        body.includes(heading),
        `v3.md must contain heading '${heading}'`,
      );
    }
  },
);

Deno.test(
  "best_practices/v2.md - immutable: keeps supply-chain framing, lacks v3-only sections (Issue #235)",
  async () => {
    const body = await readPrompt("best_practices/v2.md");
    assert(
      body.startsWith("# Best-Practices Review — Bucket-Scoped (v2)"),
      "v2.md must remain the (v2) orchestrator",
    );
    assert(
      body.includes("### Cross-bucket: supply-chain hardening (Issue #2184)"),
      "v2.md must retain the supply-chain hardening section",
    );
    for (
      const v3Only of [
        "### Cross-bucket: dead dependencies (Issue #2263)",
        "### Cross-bucket: deprecated config on framework bump (Issue #2263)",
      ]
    ) {
      assert(
        !body.includes(v3Only),
        `v2.md must NOT contain the v3-only section '${v3Only}'`,
      );
    }
  },
);
