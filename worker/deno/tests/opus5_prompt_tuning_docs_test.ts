/**
 * Tests for — the Opus 5 prompt re-tune learning must live in a
 * durable prose doc, and `CODING-STANDARDS.md` must not contradict it.
 *
 * The re-tune recorded a negative result: the Opus 4.8-era tuning
 * *encouraged* subagent delegation and added an explicit self-verification
 * checkpoint, and both were reversed for Opus 5. That learning survived only
 * inside `docs/archive/pr-summaries/pr-summary-3562.md` (prunable) and
 * implicitly inside the prompt files, while `CODING-STANDARDS.md` still told
 * prompt authors to add the checkpoint back and named a stale fallback model.
 *
 * Australian English throughout (behaviour, generalisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";

async function readRepoFile(relativePath: string): Promise<string> {
  const url = new URL(`../../../${relativePath}`, import.meta.url);
  return await Deno.readTextFile(url);
}

async function repoFileExists(relativePath: string): Promise<boolean> {
  const url = new URL(`../../../${relativePath}`, import.meta.url);
  try {
    await Deno.stat(url);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

const TUNING_ANCHOR = "#model-generation-prompt-tuning";

Deno.test("MODEL-AND-CACHING.md captures the Opus 5 prompt-tuning learning", async () => {
  const text = await readRepoFile("docs/MODEL-AND-CACHING.md");
  assert(
    /####\s+Model-generation prompt tuning\s*$/m.test(text),
    "docs/MODEL-AND-CACHING.md is missing the " +
      "'Model-generation prompt tuning' section",
  );
  const section = text.slice(
    text.indexOf("#### Model-generation prompt tuning"),
  );
  for (
    const needle of [
      "self-verif", // the deleted checkpoint
      "delegat", // the capped delegation
      "scope",
      "Opus 4.8",
      "Opus 5",
    ]
  ) {
    assert(
      section.toLowerCase().includes(needle.toLowerCase()),
      `Opus 5 prompt-tuning section does not mention "${needle}"`,
    );
  }
  assert(
    /revers/i.test(section),
    "The delegation-cap reversal (the negative result) is not stated as a " +
      "reversal of the Opus 4.8-era encouragement",
  );
});

// Issue #371 superseded the original form of this test, which required
// CODING-STANDARDS.md to *name* the current fallback generation. Naming it
// duplicated the routing chain that docs/MODEL-AND-CACHING.md owns and went
// stale on every routing change, so the standard now names no generation at
// all and links to the routing doc instead. The intent — the two documents
// must not drift — is unchanged.
Deno.test("CODING-STANDARDS.md defers the fallback chain to MODEL-AND-CACHING.md", async () => {
  const text = await readRepoFile("CODING-STANDARDS.md");
  assert(
    text.includes("docs/MODEL-AND-CACHING.md#model-selection"),
    "CODING-STANDARDS.md does not link to the Model Selection section that " +
      "owns the per-phase routing chain and the unavailability self-heal",
  );
});

Deno.test("CODING-STANDARDS.md gives no blanket self-verification-checkpoint advice", async () => {
  const text = await readRepoFile("CODING-STANDARDS.md");
  assert(
    !/\*\*Add explicit self-verification checkpoints\*\*/.test(text),
    "CODING-STANDARDS.md still tells prompt authors to add explicit " +
      "self-verification checkpoints — the re-tune deleted that " +
      "scaffolding as redundant on Opus 5",
  );
  assert(
    text.includes(`docs/MODEL-AND-CACHING.md${TUNING_ANCHOR}`),
    "CODING-STANDARDS.md does not defer model-generation-specific prompt " +
      "tuning to the MODEL-AND-CACHING.md section",
  );
});

Deno.test("the CODING-STANDARDS.md tuning cross-link resolves to a real heading", async () => {
  const target = await readRepoFile("docs/MODEL-AND-CACHING.md");
  const headings = target
    .split("\n")
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) =>
      "#" +
      line
        .replace(/^#{1,6}\s+/, "")
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
    );
  assert(
    headings.includes(TUNING_ANCHOR),
    `No heading in docs/MODEL-AND-CACHING.md yields the anchor ${TUNING_ANCHOR}`,
  );
});

Deno.test("pr-summary-3562.md is pruned now its learning is absorbed", async () => {
  assertEquals(
    await repoFileExists("docs/archive/pr-summaries/pr-summary-3562.md"),
    false,
    "pr-summary-3562.md still exists — the archive copy is redundant once " +
      "docs/MODEL-AND-CACHING.md carries the learning",
  );
});
