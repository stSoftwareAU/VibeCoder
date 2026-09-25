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
 * (#2574) gains no new bullet — one bullet carries the rule.
 *
 * A documentation-drift test under CODING-STANDARDS.md: the rule is prose
 * the worker cannot hold as a value, and it is read section-scoped.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { flat, section, withoutSection } from "./support/markdown_docs.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const HEADING = "Long-Horizon Runs";
const COMPACTION = "**Your context window is compacted automatically.**";
const MECHANISM = "running `- [ ]` checklist";

/** The resolved coding guidelines template. */
async function guidelines(): Promise<string> {
  const loaded = await loadPrompt("coding_guidelines", PROMPTS_DIR);
  assert(loaded.ok, "coding_guidelines must resolve");
  return loaded.value;
}

/** Top-level bullets of the Long-Horizon Runs section, single-spaced. */
async function bullets(): Promise<string[]> {
  return section(await guidelines(), HEADING).split("\n- ").map(flat);
}

/** The bullet that governs automatic compaction. */
async function compactionBullet(): Promise<string> {
  const bullet = (await bullets()).find((b) => b.includes(COMPACTION));
  assert(bullet, "expected the compaction bullet");
  return bullet;
}

Deno.test("running checklist - names one mechanism: a checklist in the PR summary (Issue #2635)", async () => {
  const bullet = await compactionBullet();
  assertStringIncludes(
    bullet,
    `${MECHANISM} of the task's steps in the PR summary`,
  );
});

Deno.test("running checklist - says when to update and when to re-read it (Issue #2635)", async () => {
  const bullet = await compactionBullet();
  assertStringIncludes(bullet, "tick each step as it lands");
  assertStringIncludes(
    bullet,
    "re-read the checklist first after a compaction",
  );
});

Deno.test("running checklist - one bullet carries the rule, not a new one (Issue #2635)", async () => {
  const carriers = (await bullets()).filter((b) => b.includes("checklist"));
  assertEquals(carriers.length, 1, "the checklist rule lives in one bullet");
  assertStringIncludes(carriers[0] ?? "", COMPACTION);
});

Deno.test("running checklist - negative control: the rule lives only in Long-Horizon Runs (Issue #2635)", async () => {
  const rest = flat(withoutSection(await guidelines(), HEADING));
  assert(!rest.includes(MECHANISM), "the rule must not be restated elsewhere");
});
