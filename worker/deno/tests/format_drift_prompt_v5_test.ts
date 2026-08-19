/**
 * Tests for the formatting & lint-drift scan prompt v5 (Issue #3783,
 * parent #3767).
 *
 * v5 closes the five Claude best-practice gaps the #3775 audit recorded
 * against v4:
 *
 *   1. an `<examples>` block after Phase 1 carrying worked CI-enforcement
 *      verdicts, so the hardest judgement in the scan is taught, not
 *      described abstractly;
 *   2. XML structure — every injected value wrapped in a descriptive tag
 *      (the attribution footer was previously substituted bare) and the
 *      phases wrapped in `<instructions>`;
 *   3. a positive Phase 4 output spec plus a literal issue-body skeleton;
 *   4. parallel-call guidance beside the permitted-command set, since the
 *      formatter check, the linter run and the workflow reads are
 *      independent;
 *   5. a read-before-assert rule that forbids an "enforced" verdict based
 *      on a step name alone, plus long-run guidance for a repo with many
 *      workflows.
 *
 * These assertions inspect the prompt template content because the template
 * IS the deliverable the worker feeds to Claude — the same pattern the
 * dead-code, duplicated-knowledge and orphan-deps prompt tests use.
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
  const result = await loadPrompt("format_drift", "v5", PROMPTS_DIR);
  assertEquals(result.ok, true, "expected prompts/format_drift/v5.md to load");
  if (!result.ok) throw new Error("unreachable — assert above failed");
  return result.value;
}

Deno.test("format_drift prompt - latest version is v5 or later", async () => {
  const latest = await getLatestVersion("format_drift", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (latest.ok) {
    const num = parseInt(latest.value.replace("v", ""), 10);
    assertEquals(
      num >= 5,
      true,
      `expected format_drift prompt >= v5, got ${latest.value}`,
    );
  }
});

Deno.test("format_drift prompt v5 - keeps the placeholder contract", async () => {
  const body = await loadV5();
  // `format_drift` declares no required-placeholder set with the prompt
  // manager, so an "Unknown template type" verdict is expected; any other
  // failure is a real contract break.
  const validated = validatePromptTemplate("format_drift", body);
  if (!validated.ok) {
    assertStringIncludes(validated.error.message, "Unknown template type");
  }
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

Deno.test("format_drift prompt v5 - keeps the both-halves filing rule", async () => {
  const body = flat(await loadV5());
  assertStringIncludes(
    body,
    "Both halves must hold to file: **drift present** and **gate not enforced**",
  );
  assertStringIncludes(body, "At most one finding");
});

Deno.test("format_drift prompt v5 - keeps the governed suppression rule", async () => {
  const body = flat(await loadV5());
  assertStringIncludes(body, "author=<github-login>");
  assertStringIncludes(body, "expires=<YYYY-MM-DD>");
  assertStringIncludes(body, "Rejected suppression:");
  assert(
    /does not suppress/i.test(body),
    "an ungoverned marker must be reported, not honoured",
  );
});

Deno.test("format_drift prompt v5 - keeps the summarise-don't-paste output bound", async () => {
  const body = flat(await loadV5());
  assertStringIncludes(body, "Do **not** paste the full diff");
  assertStringIncludes(body, "Do **not** paste every warning");
});

Deno.test("format_drift prompt v5 - never regresses a Deno repo to Node tooling", async () => {
  const body = flat(await loadV5());
  assertStringIncludes(body, "Never regress a Deno repo to Node tooling");
  assertStringIncludes(body, "never recommend Node tooling for a Deno repo");
});

// --- Gap 1: worked CI-enforcement examples --------------------------------

Deno.test("format_drift prompt v5 - examples block carries enforcement verdicts", async () => {
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
  // Every example shows the workflow evidence it judged, a verdict, and a
  // reason.
  assertEquals(count, block.split("<workflow>").length - 1);
  assertEquals(count, block.split("<verdict>").length - 1);
  assertEquals(count, block.split("<reason>").length - 1);
  // The negative cases matter most: a false positive files an issue against
  // a repo whose gate already works.
  const flatBlock = flat(block);
  assert(
    (flatBlock.match(/enforced — file nothing/g) ?? []).length >= 2,
    "expected at least two stay-silent verdicts",
  );
  assert(
    (flatBlock.match(/not enforced — file/g) ?? []).length >= 2,
    "expected at least two file verdicts",
  );
  // The four cases the audit named.
  assertStringIncludes(flatBlock, "deno fmt --check");
  assertStringIncludes(flatBlock, "quality.sh:41");
  assertStringIncludes(flatBlock, "no formatter or linter invocation");
  assertStringIncludes(flatBlock, "if: github.ref == 'refs/heads/main'");
});

Deno.test("format_drift prompt v5 - examples sit between Phase 1 and Phase 2", async () => {
  const body = await loadV5();
  assert(
    body.indexOf("## Phase 1") < body.indexOf("<examples>"),
    "examples must follow the enforcement determination they illustrate",
  );
  assert(
    body.indexOf("<examples>") < body.indexOf("## Phase 2"),
    "examples must precede Phase 2 measurement",
  );
});

// --- Gap 2: XML structure -------------------------------------------------

Deno.test("format_drift prompt v5 - injected values are wrapped in XML tags", async () => {
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

Deno.test("format_drift prompt v5 - the attribution footer is declared as an input", async () => {
  const body = await loadV5();
  const inputs = body.slice(
    body.indexOf("## Inputs"),
    body.indexOf("## Hard Constraints"),
  );
  assertStringIncludes(inputs, "{{ATTRIBUTION_FOOTER}}");
  assertStringIncludes(flat(inputs), "**Attribution footer**");
});

Deno.test("format_drift prompt v5 - phase instructions are wrapped in <instructions>", async () => {
  const body = await loadV5();
  const open = body.indexOf("<instructions>");
  const close = body.indexOf("</instructions>");
  assert(open >= 0 && close > open, "expected an <instructions> wrapper");
  assert(open < body.indexOf("## Phase 0"), "Phase 0 must sit inside the tag");
  assert(body.indexOf("## Phase 4") < close, "Phase 4 must sit inside the tag");
});

// --- Gap 3: positive output spec + body skeleton ---------------------------

Deno.test("format_drift prompt v5 - Phase 4 output spec is positive", async () => {
  const body = await loadV5();
  assertEquals(
    body.includes("Do not emit a fenced JSON block"),
    false,
    "v5 must replace the prohibition-led spec with a positive one",
  );
  const flatBody = flat(body);
  assertStringIncludes(
    flatBody,
    "Your only output for this phase is at most one `gh issue create` call",
  );
  assertStringIncludes(flatBody, "exit immediately after it");
});

Deno.test("format_drift prompt v5 - issue body is shown as a skeleton", async () => {
  const body = await loadV5();
  const start = body.indexOf("```markdown");
  assert(start >= 0, "expected a fenced markdown body skeleton");
  const skeleton = body.slice(start, body.indexOf("```", start + 11));
  assertStringIncludes(skeleton, "<!-- finding-id: BP-");
  assertStringIncludes(skeleton, "## Drift measured");
  assertStringIncludes(skeleton, "## CI enforcement");
  assertStringIncludes(skeleton, "## Suggested fix");
  assertStringIncludes(flat(skeleton), "attribution footer");
});

// --- Gap 4: parallel-call guidance ----------------------------------------

Deno.test("format_drift prompt v5 - independent commands run in parallel", async () => {
  const body = flat(await loadV5());
  assertStringIncludes(
    body,
    "The formatter check, the linter run, and the workflow reads are independent of one another",
  );
  assertStringIncludes(body, "in parallel rather than sequentially");
  assertStringIncludes(
    body,
    "Only sequence a command when it needs the result of a previous one",
  );
});

// --- Gap 5: read-before-assert and long-run guidance ----------------------

Deno.test("format_drift prompt v5 - an aggregate gate must be opened, not assumed", async () => {
  const body = await loadV5();
  const flatBody = flat(body);
  assertEquals(
    flatBody.includes("that is known to run them"),
    false,
    "v5 must not permit an enforcement verdict resting on a step name",
  );
  assertStringIncludes(
    flatBody,
    "Never record a tool as enforced on the strength of a step name",
  );
  assertStringIncludes(
    flatBody,
    "if you cannot open it, record the tool as **not enforced**",
  );
  assertStringIncludes(
    flatBody,
    "Never assert a fact about this repo you have",
  );
});

Deno.test("format_drift prompt v5 - Hard Constraints cover a long run", async () => {
  const body = await loadV5();
  const constraints = body.slice(
    body.indexOf("## Hard Constraints"),
    body.indexOf("<instructions>"),
  );
  assertStringIncludes(constraints, "Working across a long run");
  const flatC = flat(constraints);
  assertStringIncludes(flatC, "compacted");
  assertStringIncludes(flatC, "path order");
  assertStringIncludes(
    flatC,
    "Do not stop the scan early because of remaining token budget",
  );
});
