/**
 * Tests for the orphan-dependency scan prompt v5 (Issue #3782,
 * parent #3767).
 *
 * v5 closes the six Claude best-practice gaps the #3775 audit recorded
 * against v4:
 *
 *   1. an `<examples>` block after Phase 2 carrying worked file/drop
 *      verdicts, so the staleness-alone boundary is taught, not asserted;
 *   2. XML structure — every injected value wrapped in a descriptive tag
 *      and the phases wrapped in `<instructions>`;
 *   3. a positive Phase 4 output spec plus a literal issue-body skeleton;
 *   4. parallel-call guidance beside the permitted-tool set, since the
 *      per-package metadata lookups are independent;
 *   5. a bounded, strength-ordered Phase 2 lookup replacing "surface every
 *      candidate", which conflicted with the six-issue cap;
 *   6. a "Working across a long run" constraint, and a read-only bound that
 *      also forbids scratch writes.
 *
 * These assertions inspect the prompt template content because the template
 * IS the deliverable the worker feeds to Claude — the same pattern the
 * dead-code, deprecated-API, and duplicated-knowledge prompt tests use.
 *
 * v4's contracts are asserted by the earlier prompt tests and are unchanged
 * (templates are immutable). Australian English spelling throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Collapse wrapping whitespace so prose assertions survive re-wraps. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Load v5 or fail the test loudly — never silently skip. */
async function loadV5(): Promise<string> {
  const result = await loadPrompt("orphan_deps", "v5", PROMPTS_DIR);
  assertEquals(result.ok, true, "expected prompts/orphan_deps/v5.md to load");
  if (!result.ok) throw new Error("unreachable — assert above failed");
  return result.value;
}

Deno.test("orphan_deps prompt - latest version is v5 or later", async () => {
  const latest = await getLatestVersion("orphan_deps", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (latest.ok) {
    const num = parseInt(latest.value.replace("v", ""), 10);
    assertEquals(
      num >= 5,
      true,
      `expected orphan_deps prompt >= v5, got ${latest.value}`,
    );
  }
});

Deno.test("orphan_deps prompt v5 - keeps the placeholder contract", async () => {
  const body = await loadV5();
  const validated = validatePromptTemplate("orphan_deps", body);
  assertEquals(validated.ok, true);
  for (
    const name of [
      "SUPPRESSED_IDS",
      "KNOWN_OPEN_FINDING_IDS",
      "ATTRIBUTION_FOOTER",
    ]
  ) {
    assertStringIncludes(body, `{{${name}}}`);
  }
});

Deno.test("orphan_deps prompt v5 - keeps the governed suppression rule", async () => {
  const body = flat(await loadV5());
  assertStringIncludes(body, "author=<github-login>");
  assertStringIncludes(body, "expires=<YYYY-MM-DD>");
  assertStringIncludes(body, "Rejected suppression:");
  assertStringIncludes(body, "orphan-deps-ignore: BP-");
  assert(
    /does not suppress/i.test(body),
    "an ungoverned marker must be reported, not honoured",
  );
});

Deno.test("orphan_deps prompt v5 - keeps the sanctioned network exception bounds", async () => {
  const body = flat(await loadV5());
  assertStringIncludes(body, "No package install, ever");
  assertStringIncludes(body, "No lifecycle scripts");
  assertStringIncludes(body, "drop the candidate");
});

// --- Gap 1: worked examples of the orphan/quiet boundary -------------------

Deno.test("orphan_deps prompt v5 - examples block carries file and drop verdicts", async () => {
  const body = await loadV5();
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
  // Every example shows the metadata it judged, its signal class, a verdict
  // and a reason.
  assertEquals(count, block.split("<metadata>").length - 1);
  assertEquals(count, block.split("<signal>").length - 1);
  assertEquals(count, block.split("<verdict>").length - 1);
  assertEquals(count, block.split("<reason>").length - 1);
  // The drop verdicts teach the principal false positive.
  assert(
    block.split("<verdict>drop</verdict>").length - 1 >= 2,
    "expected at least two drop verdicts",
  );
  assert(
    block.split("<verdict>file</verdict>").length - 1 >= 2,
    "expected at least two file verdicts",
  );
  // The cases the audit named must all appear.
  assertStringIncludes(block, "ORPHAN-DEPRECATED");
  assertStringIncludes(block, "ORPHAN-ARCHIVED");
  assertStringIncludes(block, "ORPHAN-STALE");
  assertStringIncludes(block, "severity:high");
  assertStringIncludes(block, "severity:medium");
  // The bump-flow boundary is exercised by an example, not only asserted.
  assertStringIncludes(flat(block), "dependency-bump flow");
});

Deno.test("orphan_deps prompt v5 - examples sit between Phase 2 and Phase 3", async () => {
  const body = await loadV5();
  assert(
    body.indexOf("## Phase 2") < body.indexOf("<examples>"),
    "examples must follow the detection signals they illustrate",
  );
  assert(
    body.indexOf("<examples>") < body.indexOf("## Phase 3"),
    "examples must precede Phase 3 triage",
  );
});

// --- Gap 2: XML structure -------------------------------------------------

Deno.test("orphan_deps prompt v5 - injected values are wrapped in XML tags", async () => {
  const body = await loadV5();
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

Deno.test("orphan_deps prompt v5 - phase instructions are wrapped in <instructions>", async () => {
  const body = await loadV5();
  const open = body.indexOf("<instructions>");
  const close = body.indexOf("</instructions>");
  assert(open >= 0 && close > open, "expected an <instructions> wrapper");
  assert(open < body.indexOf("## Phase 1"), "Phase 1 must sit inside the tag");
  assert(body.indexOf("## Phase 4") < close, "Phase 4 must sit inside the tag");
});

// --- Gap 3: positive output spec + body skeleton ---------------------------

Deno.test("orphan_deps prompt v5 - Phase 4 output spec is positive", async () => {
  const body = await loadV5();
  assertEquals(
    body.includes("Your printed reply is irrelevant"),
    false,
    "v5 must replace the prohibition-led spec with a positive one",
  );
  assertStringIncludes(body, "Your only output for this phase is the `gh`");
  assertStringIncludes(flat(body), "exit immediately after the last one");
});

Deno.test("orphan_deps prompt v5 - issue body is shown as a skeleton", async () => {
  const body = await loadV5();
  const start = body.indexOf("```markdown");
  assert(start >= 0, "expected a fenced markdown body skeleton");
  const skeleton = body.slice(start, body.indexOf("```", start + 11));
  assertStringIncludes(skeleton, "<!-- finding-id: BP-");
  assertStringIncludes(skeleton, "## Why this matters");
  assertStringIncludes(skeleton, "## Evidence");
  assertStringIncludes(skeleton, "## Suggested replacement");
  assertStringIncludes(skeleton, "## Cross-links");
  assertStringIncludes(flat(skeleton), "attribution footer");
});

// --- Gap 4: parallel-call guidance ----------------------------------------

Deno.test("orphan_deps prompt v5 - independent metadata lookups run in parallel", async () => {
  const body = flat(await loadV5());
  assertStringIncludes(body, "in parallel rather than one at a time");
  assertStringIncludes(
    body,
    "Only sequence a call when it needs the result of a previous one",
  );
});

// --- Gap 5: bounded, strength-ordered lookup ------------------------------

Deno.test("orphan_deps prompt v5 - Phase 2 lookup is bounded, not exhaustive", async () => {
  const body = await loadV5();
  assertEquals(
    body.includes("surface every candidate the evidence supports"),
    false,
    "the blanket coverage instruction conflicts with the six-issue cap",
  );
  const phase2 = flat(
    body.slice(body.indexOf("## Phase 2"), body.indexOf("<examples>")),
  );
  assertStringIncludes(phase2, "strength order");
  assertStringIncludes(phase2, "runtime or security-relevant path");
  assertStringIncludes(phase2, "six corroborated strong-signal findings");
  assertStringIncludes(phase2, "deliberate bound");
});

// --- Gap 6: long-run guidance and scratch-file bound ----------------------

Deno.test("orphan_deps prompt v5 - the read-only bound covers scratch files", async () => {
  const body = await loadV5();
  const constraints = flat(
    body.slice(
      body.indexOf("## Hard Constraints"),
      body.indexOf("<instructions>"),
    ),
  );
  assertStringIncludes(constraints, "no writes to tracked or untracked files");
  assertStringIncludes(constraints, "scratch");
});

Deno.test("orphan_deps prompt v5 - Hard Constraints cover a long run", async () => {
  const body = await loadV5();
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
  assertStringIncludes(flatC, "verdict");
});
