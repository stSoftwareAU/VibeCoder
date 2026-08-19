/**
 * Tests for planning v20 (Issue #3795).
 *
 * v20 closes the six Claude best-practice gaps the #3772 audit recorded against
 * v19 — the draft half of the draft → critique → publish chain: symbolic draft
 * dependencies, worked ask-splitting examples, XML tags around the injected and
 * skeleton blocks, a role sentence, a no-scratch-file bound, and a
 * read-before-assert rule.
 *
 * v19 stays immutable (Issue #235) and is used here as the negative control:
 * each gap test asserts the defect is present in v19 and absent in v20, so the
 * test fails against the unfixed template.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { buildPlanningPrompt } from "../lib/prompt_builder.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadPlanning(version: string): Promise<string> {
  const result = await loadPrompt("planning", version, PROMPTS_DIR);
  assertEquals(result.ok, true, `planning ${version} failed to load`);
  if (!result.ok) throw new Error(`planning ${version} failed to load`);
  return result.value;
}

const loadV20 = () => loadPlanning("v20");

/** Text between two markers, exclusive of the markers. */
function between(body: string, start: string, end: string): string {
  const from = body.indexOf(start);
  const to = body.indexOf(end, from + start.length);
  assertEquals(from >= 0 && to > from, true, `missing ${start} … ${end}`);
  return body.slice(from + start.length, to);
}

// --- Loading contract ---

Deno.test("planning v20 - loads via loadPrompt", async () => {
  const body = await loadV20();
  assertEquals(body.length > 0, true);
});

Deno.test("planning v20 - is the latest version", async () => {
  const result = await getLatestVersion("planning", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 20,
    true,
    `Expected planning >= v20, got ${result.value}`,
  );
});

Deno.test("planning v20 - satisfies the placeholder contract", async () => {
  const v = validatePromptTemplate("planning", await loadV20());
  assertEquals(v.ok, true);
});

// --- Gap 1: be clear and direct (contradictory dependency notation) ---

Deno.test("planning v20 - Gap 1: the draft's dependency notation is symbolic", async () => {
  const v19 = await loadPlanning("v19");
  const v20 = await loadV20();
  // v19 required `Depends on #N` in a turn where, by its own statement, no
  // issue numbers exist yet.
  assertStringIncludes(v19, '[List "Depends on #N" for each prerequisite');
  assertEquals(
    v20.includes('[List "Depends on #N" for each prerequisite'),
    false,
    "v20 must not ask the draft for numeric dependency links",
  );
  assertStringIncludes(
    v20,
    '[List "Depends on: <working title of the prerequisite sub-issue>" for each prerequisite',
  );
  assertStringIncludes(v20, "Do not invent issue numbers");
});

Deno.test("planning v20 - Gap 1: the output section agrees with the body template", async () => {
  const v19 = await loadPlanning("v19");
  const v20 = await loadV20();
  const v19Output = v19.slice(v19.indexOf("### Output (draft only)"));
  const v20Output = v20.slice(v20.indexOf("### Output (draft only)"));
  // v19 repeated the numeric requirement in its output section.
  assertStringIncludes(v19Output, "any `Depends on #N`");
  assertEquals(
    v20Output.includes("`Depends on #N`"),
    false,
    "the output section must not restate the numeric form",
  );
  assertStringIncludes(v20Output, "`Depends on: <working title>`");
});

// --- Gap 2: use examples effectively ---

Deno.test("planning v20 - Gap 2: carries tagged ask-splitting examples", async () => {
  const v19 = await loadPlanning("v19");
  const v20 = await loadV20();
  assertEquals(v19.includes("<example>"), false, "v19 had no examples");

  const block = between(v20, "<examples>", "</examples>");
  const count = block.split("<example>").length - 1;
  assertEquals(count >= 4, true, `expected >= 4 examples, got ${count}`);
  assertEquals(
    block.split("</example>").length - 1,
    count,
    "every <example> must be closed",
  );
  for (const tag of ["<situation>", "<action>", "<reason>"]) {
    assertEquals(
      block.split(tag).length - 1,
      count,
      `every example needs one ${tag}`,
    );
  }
});

Deno.test("planning v20 - Gap 2: examples sit with the ask-splitting rule they illustrate", async () => {
  const v20 = await loadV20();
  const rule = v20.indexOf("### Separate the distinct asks");
  const examples = v20.indexOf("<examples>");
  const next = v20.indexOf("### Sub-issue quality");
  assertEquals(
    rule < examples && examples < next,
    true,
    "the <examples> block must follow the ask-splitting rule",
  );
});

Deno.test("planning v20 - Gap 2: covers the over-split and already-tracked near misses", async () => {
  const block = between(await loadV20(), "<examples>", "</examples>");
  // The near miss that matters most: one ask stated twice is still one ask.
  assertStringIncludes(block, "Draft **one** sub-issue.");
  // An ask already covered by an open issue is referenced, not recreated.
  assertStringIncludes(block, "referenced, not recreated");
});

// --- Gap 3: structure prompts with XML tags ---

Deno.test("planning v20 - Gap 3: injected values and the skeleton are tagged", async () => {
  const v19 = await loadPlanning("v19");
  const v20 = await loadV20();
  for (
    const tag of [
      "escalation_context",
      "milestone_instructions",
      "sub_issue_body_template",
    ]
  ) {
    assertEquals(v19.includes(`<${tag}>`), false, `v19 had no <${tag}>`);
    assertStringIncludes(v20, `<${tag}>`);
    assertStringIncludes(v20, `</${tag}>`);
  }
  // Each injected placeholder sits inside its own tag pair.
  assertStringIncludes(
    between(v20, "<escalation_context>", "</escalation_context>"),
    "{{COMPLEXITY_CONTEXT}}",
  );
  assertStringIncludes(
    between(v20, "<milestone_instructions>", "</milestone_instructions>"),
    "{{MILESTONE_INSTRUCTIONS}}",
  );
});

Deno.test("planning v20 - Gap 3: the built prompt renders injected text inside its tags", async () => {
  const built = await buildPlanningPrompt({
    repo: "owner/repo",
    issueNumber: "99",
    issueTitle: "Big feature",
    issueBody: "Body",
    issueLabels: "enhancement",
    complexityContext: "Touches nine modules",
    milestoneTitle: "v2.0",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  assertStringIncludes(
    between(
      built.value.prompt,
      "<escalation_context>",
      "</escalation_context>",
    ),
    "Touches nine modules",
  );
  assertStringIncludes(
    between(
      built.value.prompt,
      "<milestone_instructions>",
      "</milestone_instructions>",
    ),
    "v2.0",
  );
});

Deno.test("planning v20 - Gap 3: names where the coding guidelines arrive", async () => {
  const v20 = await loadV20();
  assertStringIncludes(v20, "supplied in the system prompt for this run");
  assertStringIncludes(v20, "`<coding_guidelines>` tags");
});

// --- Gap 4: give Claude a role ---

Deno.test("planning v20 - Gap 4: opens with a persona, not just a mode", async () => {
  const v19 = await loadPlanning("v19");
  const v20 = await loadV20();
  assertEquals(
    v19.includes("You are a technical lead"),
    false,
    "v19 named a mode, not a role",
  );
  assertStringIncludes(
    v20,
    "You are a technical lead decomposing a GitHub issue",
  );
  // The persona must precede the mode statement it frames.
  assertEquals(
    v20.indexOf("You are a technical lead") <
      v20.indexOf("You are in planning mode."),
    true,
    "the role sentence must come first",
  );
});

// --- Gap 5: reduce file creation in agentic coding ---

Deno.test("planning v20 - Gap 5: bounds the draft to reply text and forbids stray files", async () => {
  const v19 = await loadPlanning("v19");
  const v20 = await loadV20();
  assertEquals(
    v19.includes("do not write it to a file"),
    false,
    "v19 never mentioned files",
  );
  assertStringIncludes(v20, "do not write it to a file");
  assertStringIncludes(v20, "Create no files in the working tree");
  assertStringIncludes(v20, "delete it before the turn ends");
});

// --- Gap 6: minimise hallucinations ---

Deno.test("planning v20 - Gap 6: requires read-before-assert on repo references", async () => {
  const v19 = await loadPlanning("v19");
  const v20 = await loadV20();
  assertEquals(
    v19.includes("Never name a file, directory, or module"),
    false,
    "v19 had no read-before-assert rule",
  );
  assertStringIncludes(
    v20,
    "**Never name a file, directory, or module you have not read in this turn.**",
  );
  assertStringIncludes(v20, "prefixed `Assumption:`");
});

Deno.test("planning v20 - Gap 6: the pre-finish checklist enforces the rule", async () => {
  const v20 = await loadV20();
  const checklist = between(
    v20,
    "Before finishing the draft, confirm",
    "### Output (draft only)",
  );
  assertStringIncludes(
    checklist,
    "no file, directory, or module reference that you have neither read nor marked `Assumption:`",
  );
});

// --- Behaviour preserved from v19 ---

Deno.test("planning v20 - keeps the Failure Detection section and its gate wording", async () => {
  const v19 = await loadPlanning("v19");
  const v20 = await loadV20();
  // The bracketed placeholder is pinned by the deterministic gate's tests
  // (Issue #3246) — it must survive the version bump byte for byte.
  const placeholder = between(
    v19,
    "## Failure Detection\n",
    "\n\n## Dependencies",
  );
  assertStringIncludes(v20, placeholder);
  const ac = v20.indexOf("## Acceptance Criteria");
  const fd = v20.indexOf("## Failure Detection");
  const dep = v20.indexOf("## Dependencies");
  assertEquals(ac < fd && fd < dep, true, "body section order preserved");
});

Deno.test("planning v20 - keeps the draft-only and reserved-label constraints", async () => {
  const v20 = await loadV20();
  assertStringIncludes(v20, "Do not create any sub-issues yet");
  assertStringIncludes(v20, "do not close this issue");
  assertStringIncludes(v20, "`label_security`");
  assertStringIncludes(v20, "`needs-human`");
  assertStringIncludes(v20, "Australian English");
});
