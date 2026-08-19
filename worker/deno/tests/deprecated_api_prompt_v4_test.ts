/**
 * Tests for the deprecated-API scan prompt v4 (Issue #3780, parent #3767).
 *
 * v4 closes the six Claude best-practice gaps the #3775 audit recorded
 * against v3:
 *
 *   1. a Phase 0 that reads the target repo's own conventions first, so a
 *      documented deprecation shim can override a candidate;
 *   2. an `<examples>` block after Phase 3 carrying worked file/drop
 *      verdicts, including the load-bearing negative ones;
 *   3. the substituted inputs wrapped in descriptive XML tags and the
 *      phase instructions in `<instructions>`;
 *   4. a positive Phase 4 output spec plus a literal issue-body skeleton;
 *   5. a permitted-tool set and parallel-call guidance;
 *   6. read-before-assert, a bounded working set, and a read-only rule
 *      that also forbids scratch writes.
 *
 * These assertions inspect the prompt template content because the
 * template IS the deliverable the worker feeds to Claude — the same
 * pattern the dead_code and github_actions_audit prompt tests use.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";
import {
  hasProjectConventionsStanza,
  PROJECT_CONVENTIONS_STANZA,
} from "../lib/project_conventions_stanza.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Collapse wrapping whitespace so prose assertions survive re-wraps. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Load v4 or fail the test loudly — never silently skip. */
async function loadV4(): Promise<string> {
  const result = await loadPrompt("deprecated_api", "v4", PROMPTS_DIR);
  assertEquals(
    result.ok,
    true,
    "expected prompts/deprecated_api/v4.md to load",
  );
  if (!result.ok) throw new Error("unreachable — assert above failed");
  return result.value;
}

Deno.test("deprecated_api prompt - latest version is v4 or later", async () => {
  const result = await getLatestVersion("deprecated_api", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 4,
      true,
      `Expected deprecated_api prompt >= v4, got ${result.value}`,
    );
  }
});

Deno.test("deprecated_api prompt v4 - keeps the placeholder contract", async () => {
  const body = await loadV4();
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

Deno.test("deprecated_api prompt v4 - keeps the idle-task body fingerprint", async () => {
  const body = await loadV4();
  // The idle-task template dispatches on this heading shape.
  assert(
    /^#+\s+Deprecated-API\b/m.test(body),
    "v4 must keep the Deprecated-API heading the template fingerprints",
  );
});

// --- Gap 1: Phase 0 completes the sequence --------------------------------

Deno.test("deprecated_api prompt v4 - carries the Phase 0 stanza verbatim", async () => {
  const body = await loadV4();
  assert(
    hasProjectConventionsStanza(body),
    "v4 must carry the canonical Phase 0 stanza verbatim so it cannot drift",
  );
  assert(
    body.indexOf(PROJECT_CONVENTIONS_STANZA) < body.indexOf("## Phase 1"),
    "the project's conventions must be read before Phase 1",
  );
});

Deno.test("deprecated_api prompt v4 - announces five phases starting at Phase 0", async () => {
  const body = await loadV4();
  assertEquals(
    body.includes("Follow the four phases below"),
    false,
    "v4 must renumber the sequence now that Phase 0 exists",
  );
  assertStringIncludes(
    flat(body),
    "Follow the five phases below in order, starting at Phase 0",
  );
  // A documented shim is the case Phase 0 exists to honour.
  const phase0 = body.slice(
    body.indexOf("## Phase 0"),
    body.indexOf("## Phase 1"),
  );
  assertStringIncludes(flat(phase0), "compatibility shim");
});

// --- Gap 2: worked examples, including negative ones ----------------------

Deno.test("deprecated_api prompt v4 - examples block carries file and drop verdicts", async () => {
  const body = await loadV4();
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
  assert(
    block.includes("<verdict>drop</verdict>"),
    "expected at least one drop verdict",
  );
  // Each example carries a candidate, a verdict and a reason.
  assertEquals(count, block.split("<candidate>").length - 1);
  assertEquals(count, block.split("<verdict>").length - 1);
  assertEquals(count, block.split("<reason>").length - 1);
  // The failure modes the audit named are worked, not abstract.
  const flatBlock = flat(block);
  assertStringIncludes(flatBlock, "declaration site");
  assertStringIncludes(flatBlock, "No toolchain signal");
  assertStringIncludes(flatBlock, "none stated");
  assertStringIncludes(flatBlock, "One finding, not three");
});

Deno.test("deprecated_api prompt v4 - examples sit after Phase 3 triage", async () => {
  const body = await loadV4();
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

Deno.test("deprecated_api prompt v4 - substituted inputs are wrapped in XML tags", async () => {
  const body = await loadV4();
  assertStringIncludes(
    body,
    "<suppressed_ids>\n{{SUPPRESSED_IDS}}\n</suppressed_ids>",
  );
  assertStringIncludes(
    body,
    "<known_open_finding_ids>\n{{KNOWN_OPEN_FINDING_IDS}}\n</known_open_finding_ids>",
  );
});

Deno.test("deprecated_api prompt v4 - phase instructions are wrapped in <instructions>", async () => {
  const body = await loadV4();
  const open = body.indexOf("<instructions>");
  const close = body.indexOf("</instructions>");
  assert(open >= 0 && close > open, "expected an <instructions> element");
  assert(open < body.indexOf("## Phase 0"), "Phase 0 must sit inside the tag");
  assert(body.indexOf("## Phase 4") < close, "Phase 4 must sit inside the tag");
});

// --- Gap 4: positive output spec + body skeleton --------------------------

Deno.test("deprecated_api prompt v4 - Phase 4 output spec is positive", async () => {
  const body = await loadV4();
  assertEquals(
    body.includes("Do not emit a fenced JSON block"),
    false,
    "v4 must replace the three prohibitions with a positive output spec",
  );
  assertStringIncludes(body, "Your only output for this phase is the `gh`");
  assertStringIncludes(body, "End the run immediately after the last call");
});

Deno.test("deprecated_api prompt v4 - issue body is shown as a skeleton", async () => {
  const body = await loadV4();
  assertStringIncludes(body, "```markdown");
  const skeleton = body.slice(
    body.indexOf("```markdown"),
    body.indexOf("4. **Cap at 6 issues.**"),
  );
  assertStringIncludes(skeleton, "<!-- finding-id: BP-");
  assertStringIncludes(skeleton, "## Call sites");
  assertStringIncludes(skeleton, "## Suggested replacement");
  assertStringIncludes(skeleton, "## Why this is flagged");
  assertStringIncludes(skeleton, "## Suggested action");
  assertStringIncludes(flat(skeleton), "attribution footer");
});

// --- Gap 5: permitted tools + parallel calls ------------------------------

Deno.test("deprecated_api prompt v4 - enumerates the permitted tool set", async () => {
  const body = await loadV4();
  assertStringIncludes(body, "**Permitted tools.**");
  for (const tool of ["grep", "deno lint", "deno check"]) {
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

Deno.test("deprecated_api prompt v4 - Phase 0 and Phase 1 encourage parallel calls", async () => {
  const body = await loadV4();
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

Deno.test("deprecated_api prompt v4 - read-before-assert rule is present", async () => {
  const body = await loadV4();
  assertStringIncludes(body, "**Read before you assert.**");
  assertStringIncludes(
    flat(body),
    "Never claim a call site you have not opened",
  );
  assertStringIncludes(
    flat(body),
    "A call site you have not read is a call site you drop",
  );
});

Deno.test("deprecated_api prompt v4 - Phase 2 bounds the working set", async () => {
  const body = await loadV4();
  const phase2 = body.slice(
    body.indexOf("## Phase 2"),
    body.indexOf("## Phase 3"),
  );
  assertStringIncludes(phase2, "Bound the working set");
  assertStringIncludes(flat(phase2), "group them by symbol");
  assertStringIncludes(
    flat(phase2),
    "Do not stop the run early over token budget",
  );
});

Deno.test("deprecated_api prompt v4 - read-only bound forbids scratch writes", async () => {
  const body = await loadV4();
  assertStringIncludes(flat(body), "no writes to tracked or untracked files");
  assertStringIncludes(body, "scratch");
  // The verification checklist enforces it before exit.
  const verify = body.slice(body.indexOf("### Verification before exit"));
  assertStringIncludes(flat(verify), "no file was written");
});

// --- Immutability guard ---------------------------------------------------

Deno.test("deprecated_api prompt v3 - stays frozen without the v4 fixes", async () => {
  const result = await loadPrompt("deprecated_api", "v3", PROMPTS_DIR);
  assertEquals(
    result.ok,
    true,
    "expected prompts/deprecated_api/v3.md to load",
  );
  if (!result.ok) return;
  assertEquals(
    result.value.includes("<examples>"),
    false,
    "v3 is immutable — the fixes belong to v4",
  );
});
