/**
 * Tests for the duplicated-knowledge scan prompt v3 (Issue #3781,
 * parent #3767).
 *
 * v3 closes the seven Claude best-practice gaps the #3775 audit recorded
 * against v2:
 *
 *   1. an `<examples>` block after Phase 2 carrying worked file/drop
 *      verdicts for the knowledge test;
 *   2. XML structure — every injected value wrapped in a descriptive tag
 *      and the phases wrapped in `<instructions>`;
 *   3. long-context handling for the one large input (the pre-pass
 *      candidate list): a document structure and a reading bound;
 *   4. a positive Phase 4 output spec plus a literal issue-body skeleton;
 *   5. parallel-call guidance beside the permitted-tool set;
 *   6. a bounded Phase 1 sweep and a commit-to-an-answer rule in Phase 2;
 *   7. a "Working across a long run" clause covering incremental progress
 *      and context compaction.
 *
 * These assertions inspect the prompt template content because the
 * template IS the deliverable the worker feeds to Claude — the same
 * pattern the dead-code and deprecated-API prompt tests use.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Collapse wrapping whitespace so prose assertions survive re-wraps. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Load v3 or fail the test loudly — never silently skip. */
async function loadV3(): Promise<string> {
  const result = await loadPrompt("duplicated_knowledge", "v3", PROMPTS_DIR);
  assertEquals(
    result.ok,
    true,
    "expected prompts/duplicated_knowledge/v3.md to load",
  );
  if (!result.ok) throw new Error("unreachable — assert above failed");
  return result.value;
}

Deno.test("duplicated_knowledge prompt - latest version is v3 or later", async () => {
  const result = await getLatestVersion("duplicated_knowledge", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 3,
      true,
      `Expected duplicated_knowledge prompt >= v3, got ${result.value}`,
    );
  }
});

Deno.test("duplicated_knowledge prompt v3 - keeps the placeholder contract", async () => {
  const body = await loadV3();
  for (
    const name of [
      "SUPPRESSED_IDS",
      "KNOWN_OPEN_FINDING_IDS",
      "DUPLICATE_BLOCKS",
      "ATTRIBUTION_FOOTER",
    ]
  ) {
    assertStringIncludes(body, `{{${name}}}`);
  }
});

Deno.test("duplicated_knowledge prompt v3 - keeps the governed suppression rule", async () => {
  const body = flat(await loadV3());
  assertStringIncludes(body, "author=<github-login>");
  assertStringIncludes(body, "expires=<YYYY-MM-DD>");
  assertStringIncludes(body, "Rejected suppression:");
  assert(
    /does not suppress/i.test(body),
    "an ungoverned marker must be reported, not honoured",
  );
});

// --- Gap 1: worked examples of the knowledge test -------------------------

Deno.test("duplicated_knowledge prompt v3 - examples block carries file and drop verdicts", async () => {
  const body = await loadV3();
  assertStringIncludes(body, "<examples>");
  assertStringIncludes(body, "</examples>");
  const block = body.slice(
    body.indexOf("<examples>"),
    body.indexOf("</examples>"),
  );
  const count = block.split("<example>").length - 1;
  assert(
    count >= 4 && count <= 6,
    `expected 4-6 <example> entries, got ${count}`,
  );
  assert(
    block.includes("<verdict>file</verdict>"),
    "expected at least one file verdict",
  );
  // The drop verdicts are the load-bearing half of this scan.
  assert(
    block.split("<verdict>drop</verdict>").length - 1 >= 3,
    "expected at least three drop verdicts",
  );
  // Every example answers the knowledge test explicitly and gives a reason.
  assertEquals(count, block.split("<knowledge_test>").length - 1);
  assertEquals(count, block.split("<reason>").length - 1);
  // The severity a filed example earns is stated, not left implicit.
  assertStringIncludes(block, "severity:high");
  assertStringIncludes(block, "severity:low");
});

Deno.test("duplicated_knowledge prompt v3 - examples sit between Phase 2 and Phase 3", async () => {
  const body = await loadV3();
  assert(
    body.indexOf("## Phase 2") < body.indexOf("<examples>"),
    "examples must follow the knowledge test they illustrate",
  );
  assert(
    body.indexOf("<examples>") < body.indexOf("## Phase 3"),
    "examples must precede Phase 3 triage",
  );
});

// --- Gap 2: XML structure -------------------------------------------------

Deno.test("duplicated_knowledge prompt v3 - injected values are wrapped in XML tags", async () => {
  const body = await loadV3();
  assertStringIncludes(
    body,
    "<duplicate_block_candidates>\n{{DUPLICATE_BLOCKS}}\n</duplicate_block_candidates>",
  );
  assertStringIncludes(
    body,
    "<suppressed_ids>\n{{SUPPRESSED_IDS}}\n</suppressed_ids>",
  );
  assertStringIncludes(
    body,
    "<known_open_finding_ids>\n{{KNOWN_OPEN_FINDING_IDS}}\n</known_open_finding_ids>",
  );
  assertStringIncludes(
    body,
    "<attribution_footer>\n{{ATTRIBUTION_FOOTER}}\n</attribution_footer>",
  );
});

Deno.test("duplicated_knowledge prompt v3 - phase instructions are wrapped in <instructions>", async () => {
  const body = await loadV3();
  const open = body.indexOf("<instructions>");
  const close = body.indexOf("</instructions>");
  assert(open >= 0 && close > open, "expected an <instructions> wrapper");
  assert(open < body.indexOf("## Phase 0"), "Phase 0 must sit inside the tag");
  assert(body.indexOf("## Phase 4") < close, "Phase 4 must sit inside the tag");
});

Deno.test("duplicated_knowledge prompt v3 - documents the indexed candidate shape", async () => {
  const body = flat(await loadV3());
  assertStringIncludes(body, "<candidate index=");
  assertStringIncludes(body, "<sites>");
  // A candidate is addressable by its index in every later phase.
  assertStringIncludes(body, "by its index");
});

// --- Gap 3: long-context handling of the pre-pass list --------------------

Deno.test("duplicated_knowledge prompt v3 - bounds reading of the candidate list", async () => {
  const body = await loadV3();
  const phase1 = flat(
    body.slice(body.indexOf("## Phase 1"), body.indexOf("## Phase 2")),
  );
  assertStringIncludes(phase1, "larger than you can read in full");
  assertStringIncludes(phase1, "path order");
  assertStringIncludes(phase1, "six confirmed findings");
  assertStringIncludes(phase1, "Record how many candidates you reached");
});

Deno.test("duplicated_knowledge prompt v3 - the long input sits above the phases", async () => {
  const body = await loadV3();
  assert(
    body.indexOf("{{DUPLICATE_BLOCKS}}") < body.indexOf("## Phase 0"),
    "the longform pre-pass list must stay above the phase instructions",
  );
});

// --- Gap 4: positive output spec + body skeleton --------------------------

Deno.test("duplicated_knowledge prompt v3 - Phase 4 output spec is positive", async () => {
  const body = await loadV3();
  assertEquals(
    body.includes("Your printed reply is irrelevant"),
    false,
    "v3 must replace the prohibition-led spec with a positive one",
  );
  assertStringIncludes(body, "Your only output for this phase is the `gh`");
  assertStringIncludes(flat(body), "exit immediately after the last one");
});

Deno.test("duplicated_knowledge prompt v3 - issue body is shown as a skeleton", async () => {
  const body = await loadV3();
  const start = body.indexOf("```markdown");
  assert(start >= 0, "expected a fenced markdown body skeleton");
  const skeleton = body.slice(start, body.indexOf("```", start + 11));
  assertStringIncludes(skeleton, "<!-- finding-id: BP-");
  assertStringIncludes(skeleton, "## The shared knowledge");
  assertStringIncludes(skeleton, "## Suggested fix");
  assertStringIncludes(flat(skeleton), "attribution footer");
});

// --- Gap 5: parallel-call guidance ----------------------------------------

Deno.test("duplicated_knowledge prompt v3 - independent reads are issued in parallel", async () => {
  const body = flat(await loadV3());
  assertStringIncludes(body, "in parallel rather than sequentially");
  assertStringIncludes(
    body,
    "Only sequence a call when it needs the result of a previous one",
  );
});

// --- Gap 6: bounded exploration -------------------------------------------

Deno.test("duplicated_knowledge prompt v3 - the reworded-copy sweep is bounded", async () => {
  const body = await loadV3();
  const phase1 = flat(
    body.slice(body.indexOf("## Phase 1"), body.indexOf("## Phase 2")),
  );
  assertStringIncludes(phase1, "at most one targeted search pass");
  assertStringIncludes(phase1, "exhaustive cross-language sweep");
});

Deno.test("duplicated_knowledge prompt v3 - Phase 2 commits to one answer per candidate", async () => {
  const body = await loadV3();
  const phase2 = flat(
    body.slice(body.indexOf("## Phase 2"), body.indexOf("<examples>")),
  );
  assertStringIncludes(phase2, "Answer it once");
  assertStringIncludes(phase2, "do not relitigate");
});

// --- Gap 7: long-run agentic guidance -------------------------------------

Deno.test("duplicated_knowledge prompt v3 - Hard Constraints cover a long run", async () => {
  const body = await loadV3();
  const constraints = body.slice(
    body.indexOf("## Hard Constraints"),
    body.indexOf("<instructions>"),
  );
  assertStringIncludes(constraints, "Working across a long run");
  const flatC = flat(constraints);
  assertStringIncludes(flatC, "compacted");
  assertStringIncludes(
    flatC,
    "Do not stop the scan early because of remaining token budget",
  );
  assertStringIncludes(flatC, "confirmed and rejected");
});
