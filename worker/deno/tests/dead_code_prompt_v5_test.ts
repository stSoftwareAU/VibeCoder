/**
 * Tests for the dead-code scan prompt v5 (Issue #3779, parent #3767).
 *
 * v5 closes the six Claude best-practice gaps the #3775 audit recorded
 * against v4:
 *
 *   1. the stated deliverable now matches Phase 4 (a set of issues, one
 *      per candidate, capped at six) instead of "a single issue";
 *   2. an `<examples>` block after Phase 3 carries worked file/drop
 *      verdicts, including the load-bearing negative ones;
 *   3. the substituted inputs are wrapped in descriptive XML tags and
 *      the phase instructions in `<instructions>`;
 *   4. the Phase 4 output spec is positive and shows a literal issue-body
 *      skeleton;
 *   5. a permitted-tool set and parallel-call guidance are stated;
 *   6. read-before-assert, a bounded working set, and a read-only rule
 *      that also forbids scratch writes.
 *
 * These assertions inspect the prompt template content because the
 * template IS the deliverable the worker feeds to Claude — the same
 * pattern the grill-me and github_actions_audit prompt tests use.
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

/** Load v5 or fail the test loudly — never silently skip. */
async function loadV5(): Promise<string> {
  const result = await loadPrompt("dead_code", "v5", PROMPTS_DIR);
  assertEquals(result.ok, true, "expected prompts/dead_code/v5.md to load");
  if (!result.ok) throw new Error("unreachable — assert above failed");
  return result.value;
}

Deno.test("dead_code prompt - latest version is v5 or later", async () => {
  const result = await getLatestVersion("dead_code", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 5,
      true,
      `Expected dead_code prompt >= v5, got ${result.value}`,
    );
  }
});

Deno.test("dead_code prompt v5 - keeps the placeholder contract", async () => {
  const body = await loadV5();
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

// --- Gap 1: the deliverable matches Phase 4 -------------------------------

Deno.test("dead_code prompt v5 - deliverable is one issue per candidate", async () => {
  const body = await loadV5();
  assertEquals(
    body.includes("The deliverable is a single GitHub findings"),
    false,
    "v5 must drop the 'single findings issue' claim that contradicts Phase 4",
  );
  assertStringIncludes(body, "one issue per surviving removal candidate");
  // The cap is stated where the deliverable is stated, not only in Phase 4.
  const lead = body.slice(0, body.indexOf("## Hard constraints"));
  assertStringIncludes(lead, "6 per");
});

// --- Gap 2: worked examples, including negative ones ----------------------

Deno.test("dead_code prompt v5 - examples block carries file and drop verdicts", async () => {
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
  // Both verdicts appear, and the negative ones outnumber none.
  assert(
    block.includes("<verdict>file</verdict>"),
    "expected at least one file verdict",
  );
  assert(
    block.includes("<verdict>drop</verdict>"),
    "expected at least one drop verdict",
  );
  // Each example carries a candidate, a verdict and a reason.
  assertEquals(count, block.split("<verdict>").length - 1);
  assertEquals(count, block.split("<reason>").length - 1);
  // The false-positive classes the audit named are worked, not abstract.
  assertStringIncludes(flat(block), "mod.ts");
  assertStringIncludes(flat(block), "string key");
  assertStringIncludes(flat(block), "_test.ts");
});

Deno.test("dead_code prompt v5 - examples sit after Phase 3 triage", async () => {
  const body = await loadV5();
  assert(
    body.indexOf("## Phase 3") < body.indexOf("<examples>"),
    "examples must follow the Phase 3 triage rules they illustrate",
  );
  assert(
    body.indexOf("<examples>") < body.indexOf("## Phase 4"),
    "examples must precede Phase 4",
  );
});

// --- Gap 3: XML structure -------------------------------------------------

Deno.test("dead_code prompt v5 - substituted inputs are wrapped in XML tags", async () => {
  const body = await loadV5();
  assertStringIncludes(
    body,
    "<suppressed_ids>\n{{SUPPRESSED_IDS}}\n</suppressed_ids>",
  );
  assertStringIncludes(
    body,
    "<known_open_finding_ids>\n{{KNOWN_OPEN_FINDING_IDS}}\n</known_open_finding_ids>",
  );
});

Deno.test("dead_code prompt v5 - phase instructions are wrapped in <instructions>", async () => {
  const body = await loadV5();
  assertStringIncludes(body, "<instructions>");
  assertStringIncludes(body, "</instructions>");
  const open = body.indexOf("<instructions>");
  const close = body.indexOf("</instructions>");
  assert(open < body.indexOf("## Phase 0"), "Phase 0 must sit inside the tag");
  assert(body.indexOf("## Phase 4") < close, "Phase 4 must sit inside the tag");
});

// --- Gap 4: positive output spec + body skeleton --------------------------

Deno.test("dead_code prompt v5 - Phase 4 output spec is positive", async () => {
  const body = await loadV5();
  assertEquals(
    body.includes("Do not emit a fenced JSON block"),
    false,
    "v5 must replace the three prohibitions with a positive output spec",
  );
  assertStringIncludes(body, "Your only output for this phase is the `gh`");
  assertStringIncludes(body, "End the run immediately after the last call");
});

Deno.test("dead_code prompt v5 - issue body is shown as a skeleton", async () => {
  const body = await loadV5();
  assertStringIncludes(body, "```markdown");
  const skeleton = body.slice(
    body.indexOf("```markdown"),
    body.indexOf("4. **Cap at 6 issues.**"),
  );
  assertStringIncludes(skeleton, "<!-- finding-id: BP-");
  assertStringIncludes(skeleton, "## Why this is a candidate");
  assertStringIncludes(skeleton, "## Why it is safe to remove");
  assertStringIncludes(skeleton, "## Suggested action");
  assertStringIncludes(flat(skeleton), "attribution footer");
});

// --- Gap 5: permitted tools + parallel calls ------------------------------

Deno.test("dead_code prompt v5 - enumerates the permitted tool set", async () => {
  const body = await loadV5();
  assertStringIncludes(body, "**Permitted tools.**");
  // Readers, the detected analysis commands, and the gh subcommands.
  for (const tool of ["grep", "deno lint", "deno info"]) {
    assertStringIncludes(body, tool);
  }
  for (
    const sub of [
      "`gh issue list`",
      "`gh label create`",
      "`gh issue create`",
      "`gh issue edit`",
    ]
  ) {
    assertStringIncludes(body, sub);
  }
  // Executors are named as forbidden.
  assertStringIncludes(body, "Forbidden:");
  assertStringIncludes(body, "`deno test`");
});

Deno.test("dead_code prompt v5 - Phase 0 and Phase 1 encourage parallel calls", async () => {
  const body = await loadV5();
  const phase0 = body.slice(
    body.indexOf("## Phase 0"),
    body.indexOf("## Phase 1"),
  );
  const phase1 = body.slice(
    body.indexOf("## Phase 1"),
    body.indexOf("## Phase 2"),
  );
  assertStringIncludes(flat(phase0), "in parallel rather than sequentially");
  assertStringIncludes(flat(phase1), "in parallel rather than sequentially");
});

// --- Gap 6: agentic rules -------------------------------------------------

Deno.test("dead_code prompt v5 - read-before-assert rule is present", async () => {
  const body = await loadV5();
  assertStringIncludes(body, "**Read before you assert.**");
  assertStringIncludes(
    flat(body),
    "A candidate you have not read is a candidate you drop",
  );
});

Deno.test("dead_code prompt v5 - Phase 2 bounds the working set", async () => {
  const body = await loadV5();
  const phase2 = body.slice(
    body.indexOf("## Phase 2"),
    body.indexOf("## Phase 3"),
  );
  assertStringIncludes(phase2, "Bound the working set");
  assertStringIncludes(
    flat(phase2),
    "Do not stop the run early over token budget",
  );
});

Deno.test("dead_code prompt v5 - read-only bound forbids scratch writes", async () => {
  const body = await loadV5();
  assertStringIncludes(flat(body), "no writes to tracked or untracked files");
  assertStringIncludes(body, "scratch");
  // The verification checklist enforces it before exit.
  const verify = body.slice(body.indexOf("### Verification before exit"));
  assertStringIncludes(flat(verify), "no file was written");
});
