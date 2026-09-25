/**
 * Issue #2635: a running checklist so long-run progress survives
 * summarisation.
 *
 * The Long-Horizon Runs section told the agent to save progress before the
 * context refreshes, but named no working record to keep as it goes and no
 * point at which to read it back. The fix names exactly one mechanism — a
 * `- [ ]` checklist in the PR summary — says when to update it (tick each
 * step as it lands) and when to re-read it (first, after a compaction).
 *
 * The PR summary was chosen over a scratch file: it is already committed,
 * so it survives a compaction and a container restart, and it needs no
 * cleanup step, no `.gitignore` entry and no Commit Safety allowlist change.
 * The rule rides the existing compaction bullet, so the always-loaded prompt
 * (#2574) gains no new bullet.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The Long-Horizon Runs section of the resolved coding guidelines. */
async function longHorizonSection(): Promise<string> {
  const loaded = await loadPrompt("coding_guidelines", PROMPTS_DIR);
  assert(loaded.ok, "coding_guidelines must resolve");
  const text = loaded.value;
  const start = text.indexOf("## Long-Horizon Runs");
  assert(start >= 0, "expected a Long-Horizon Runs section");
  const end = text.indexOf("\n## ", start + 1);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

/** The top-level bullet that governs automatic compaction. */
async function compactionBullet(): Promise<string> {
  const section = await longHorizonSection();
  const bullet = section.split("\n- ").find((b) =>
    b.startsWith("**Your context window is compacted automatically.**")
  );
  assert(bullet, "expected the compaction bullet");
  return bullet.replace(/\s+/g, " ");
}

Deno.test("running checklist - names one mechanism: a checklist in the PR summary (Issue #2635)", async () => {
  const bullet = await compactionBullet();
  assertStringIncludes(bullet, "running `- [ ]` checklist");
  assertStringIncludes(bullet, "in the PR summary");
});

Deno.test("running checklist - says when to update and when to re-read it (Issue #2635)", async () => {
  const bullet = await compactionBullet();
  assertStringIncludes(bullet, "tick each step as it lands");
  assertStringIncludes(
    bullet,
    "re-read the checklist first after a compaction",
  );
});

Deno.test("running checklist - never asks for a scratch checklist file (Issue #2635)", async () => {
  const section = (await longHorizonSection()).replace(/\s+/g, " ");
  assert(
    !/checklist file|\.\w*checklist/i.test(section),
    "the checklist must live in the committed PR summary, not a scratch file",
  );
});

Deno.test("running checklist - rides the existing bullet, adding none (Issue #2635)", async () => {
  const section = await longHorizonSection();
  const bullets = section.split("\n").filter((l) => l.startsWith("- "));
  assertEquals(bullets.length, 4, "Long-Horizon Runs keeps its four bullets");
});
