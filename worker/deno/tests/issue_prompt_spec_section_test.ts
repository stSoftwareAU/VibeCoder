/**
 * Tests for the issue prompt's AfterVibe-style after-run Spec section
 * (Issue #2913).
 *
 * The PR summary file's "The file MUST contain:" list gains a `## Spec`
 * section directly after `## Summary`, recording what a reviewer cannot
 * recover from the diff alone — intent and rationale, essential design
 * decisions, and undiscoverable facts — each capped at four bullets, with
 * `None.` when a sub-heading has nothing to say. Enforcement is prompt-only:
 * there is no runtime gate, so these assertions are the only thing that
 * catches drift between the contract and the worked example.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadIssue(): Promise<string> {
  const result = await loadPrompt("issue", PROMPTS_DIR);
  assertEquals(result.ok, true, "issue failed to load");
  if (!result.ok) throw new Error("issue failed to load");
  return result.value;
}

function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

Deno.test("issue - the MUST-contain list carries Spec as item 2, before Evidence", async () => {
  const text = await loadIssue();
  const body = normaliseWhitespace(text);

  const specIndex = text.indexOf("**Spec**");
  const evidenceIndex = text.indexOf("**Evidence**");
  assert(specIndex > -1, "the contract list must name a Spec item");
  assert(evidenceIndex > -1, "the contract list must name an Evidence item");
  assert(
    specIndex < evidenceIndex,
    "Spec must be listed before Evidence in the MUST-contain list",
  );

  for (
    const heading of [
      "### Intent and Rationale",
      "### Essential Design Decisions",
      "### Undiscoverable Facts",
    ]
  ) {
    assertStringIncludes(text, heading);
  }

  // The three sub-headings must appear in this order after the Spec item.
  const intentIndex = text.indexOf("### Intent and Rationale");
  const decisionsIndex = text.indexOf("### Essential Design Decisions");
  const factsIndex = text.indexOf("### Undiscoverable Facts");
  assert(
    specIndex < intentIndex && intentIndex < decisionsIndex &&
      decisionsIndex < factsIndex,
    "the three Spec sub-headings must follow the Spec item, in order",
  );

  assertStringIncludes(body, "at most four bullets each");
  assertStringIncludes(text, "None.");
});

Deno.test("issue - the worked example places Spec after Summary and before Evidence", async () => {
  const text = await loadIssue();

  const exampleMarker = "Fixed the button alignment issue";
  const markerIndex = text.indexOf(exampleMarker);
  assert(markerIndex > -1, "the worked example must survive unchanged");

  const summaryIndex = text.lastIndexOf("## Summary", markerIndex);
  assert(
    summaryIndex > -1,
    "the worked example must be preceded by a ## Summary heading",
  );
  const example = text.slice(summaryIndex);

  const specIndex = example.indexOf("## Spec");
  const evidenceIndex = example.indexOf("## Evidence");
  assert(specIndex > -1, "the worked example must carry a ## Spec heading");
  assert(
    evidenceIndex > -1,
    "the worked example must carry a ## Evidence heading",
  );
  assert(
    specIndex < evidenceIndex,
    "## Spec must come before ## Evidence in the worked example",
  );

  const intentIndex = example.indexOf("### Intent and Rationale");
  const decisionsIndex = example.indexOf("### Essential Design Decisions");
  const factsIndex = example.indexOf("### Undiscoverable Facts");
  assert(
    specIndex < intentIndex && intentIndex < decisionsIndex &&
      decisionsIndex < factsIndex && factsIndex < evidenceIndex,
    "the three Spec sub-headings must sit between ## Spec and ## Evidence, in order",
  );
});
