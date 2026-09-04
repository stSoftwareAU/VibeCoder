/**
 * Tests for the documentation-audit prompt's check 13 (Issue #685).
 *
 * Check 13 is **comment contradicts the code**: the source is the single
 * source of truth, so a comment stating something the adjacent code does not
 * do is removed by default. The one exception is a comment describing
 * deliberate behaviour the code never implements (a guard, a limit, an error
 * path); that is filed as a possible bug in the code, not as a comment
 * removal.
 *
 * The assertions run against the current `documentation_audit` template, so an
 * edit that drops the check — or renumbers the catalogue without saying so —
 * fails in CI.
 *
 * Australian English is used throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { hasProjectConventionsStanza } from "../lib/project_conventions_stanza.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

async function loadDocumentationAudit(): Promise<string> {
  const result = await loadPrompt("documentation_audit", PROMPTS_DIR);
  assertEquals(result.ok, true, "documentation_audit failed to load");
  if (!result.ok) {
    throw new Error("documentation_audit failed to load");
  }
  return result.value;
}

const readDoc = (relPath: string) =>
  Deno.readTextFile(`${REPO_ROOT}${relPath}`);

Deno.test("documentation_audit - keeps the dedup and attribution placeholders", async () => {
  const body = await loadDocumentationAudit();
  for (
    const placeholder of [
      "{{SUPPRESSED_IDS}}",
      "{{KNOWN_OPEN_FINDING_IDS}}",
      "{{OPEN_ISSUE_TITLES}}",
      "{{ATTRIBUTION_FOOTER}}",
    ]
  ) {
    assertStringIncludes(body, placeholder);
  }
});

Deno.test("documentation_audit - keeps the shared Phase 0 conventions stanza", async () => {
  assert(
    hasProjectConventionsStanza(await loadDocumentationAudit()),
    "the template must carry the canonical Phase 0 stanza verbatim",
  );
});

Deno.test("documentation_audit - the H1 names the audit", async () => {
  const text = await loadDocumentationAudit();
  const h1 = text.split("\n")[0] ?? "";
  assertStringIncludes(h1, "# Documentation Audit");
});

// --- Check 13: comments that contradict the code ---

Deno.test("documentation_audit - carries check 13 for comments that contradict the code", async () => {
  const text = await loadDocumentationAudit();
  assertStringIncludes(text, "### 13. Comment contradicts the code");
  assertStringIncludes(text, "The source code is the truth");
});

Deno.test("documentation_audit - check 13 removes the comment by default, citing file and line", async () => {
  const text = await loadDocumentationAudit();
  const check = text.slice(
    text.indexOf("### 13. Comment contradicts the code"),
    text.indexOf("<examples>"),
  );
  assert(check.length > 0, "check 13 section not found before the examples");
  // The default remedy is deletion, evidenced by a file/line citation.
  assertStringIncludes(check, "delete the comment");
  assertStringIncludes(check, "Cite the comment's file and line");
});

Deno.test("documentation_audit - check 13 files a possible code bug when the comment documents absent behaviour", async () => {
  const text = await loadDocumentationAudit();
  const check = text.slice(
    text.indexOf("### 13. Comment contradicts the code"),
    text.indexOf("<examples>"),
  );
  assertStringIncludes(check, "possible bug in the code");
  // The three shapes the issue enumerates for deliberate-but-unimplemented
  // behaviour.
  for (const shape of ["guard", "limit", "error path"]) {
    assertStringIncludes(check, shape);
  }
});

Deno.test("documentation_audit - check 13 states the doc-coverage ownership boundary", async () => {
  // The sibling boundary used to cover only missing or paraphrase-only
  // docstrings; check 13 claims contradicting comments explicitly.
  const text = await loadDocumentationAudit();
  assertStringIncludes(text, "contradicts the code it sits beside");
  assertStringIncludes(text, "paraphrase");
});

Deno.test("documentation_audit - check 13 carves out the legitimate look-alikes", async () => {
  const text = await loadDocumentationAudit();
  const check = text.slice(
    text.indexOf("### 13. Comment contradicts the code"),
    text.indexOf("<examples>"),
  );
  const silent = check.slice(check.indexOf("**Stay silent**"));
  assert(silent.length > 0, "check 13 must carry a stay-silent carve-out");
  // A TODO is future intent, commented-out code is not a claim, and a
  // rationale explains why rather than what.
  for (const carveOut of ["TODO", "commented-out code", "rationale"]) {
    assertStringIncludes(silent, carveOut);
  }
});

Deno.test("documentation_audit - check 13 collapses per source file", async () => {
  const text = await loadDocumentationAudit();
  const check = text.slice(
    text.indexOf("### 13. Comment contradicts the code"),
    text.indexOf("<examples>"),
  );
  assertStringIncludes(check, "one finding per source file");
});

Deno.test("documentation_audit - check 13 has worked examples for both verdicts", async () => {
  const text = await loadDocumentationAudit();
  assertStringIncludes(
    text,
    '<example name="comment-contradicts-adjacent-code">',
  );
  assertStringIncludes(
    text,
    '<example name="comment-documents-a-guard-the-code-lacks">',
  );
  assertStringIncludes(text, '<example name="comment-explaining-why">');
});

// --- Inventory and bookkeeping the check depends on ---

Deno.test("documentation_audit - Phase 1 inventories the source comments check 13 reads", async () => {
  const text = await loadDocumentationAudit();
  const inventory = text.slice(
    text.indexOf("## Phase 1 — Inventory the documentation surface"),
    text.indexOf("## Phase 2"),
  );
  assertStringIncludes(inventory, "Source comments");
});

Deno.test("documentation_audit - the Phase 2 sweep bound cannot starve check 13", async () => {
  const text = await loadDocumentationAudit();
  const bound = text.slice(
    text.indexOf("**Bound the sweep, not just the results.**"),
    text.indexOf("### 1. Unabsorbed PR-summary learnings"),
  );
  assert(bound.length > 0, "the Phase 2 sweep bound was not found");
  // The source-comment shortlist is ranked below the docs in the drift
  // order, so without an exemption a repo with six drafty documents would
  // stop sweeping before check 13 ever ran.
  assertStringIncludes(bound, "**Check 13 is exempt from that stop rule**");
  assertStringIncludes(bound, "as you open it");
});

Deno.test("documentation_audit - an unresolved check-13 direction does not outrank a confirmed finding", async () => {
  const text = await loadDocumentationAudit();
  const check = text.slice(
    text.indexOf("### 13. Comment contradicts the code"),
    text.indexOf("<examples>"),
  );
  assertStringIncludes(check, "possible-bug shape at `severity:medium`");
});

Deno.test("documentation_audit - states the check counts consistently", async () => {
  const text = await loadDocumentationAudit();
  assertStringIncludes(text, "## Phase 2 — Apply the thirteen-check catalogue");
  assert(
    !text.includes("twelve-check"),
    "the template must not still describe the catalogue as twelve checks",
  );
});

Deno.test("documentation_audit - the read-before-you-assert rule extends to check 13", async () => {
  const text = await loadDocumentationAudit();
  assertStringIncludes(text, "This binds hardest on checks 10–13");
  assert(
    !text.includes("binds hardest on checks 10–12"),
    "the read-before-you-assert range must extend to check 13",
  );
});

Deno.test("documentation_audit - severity guidance covers a contradicting comment", async () => {
  const text = await loadDocumentationAudit();
  const severitySection = text.slice(text.indexOf("### Severity guidance"));
  assertStringIncludes(severitySection, "comment");
});

Deno.test("documentation_audit - the suggested-fix guidance tells the filer what to write", async () => {
  const text = await loadDocumentationAudit();
  const phase4 = text.slice(
    text.indexOf("## Phase 4 — File one issue per finding"),
  );
  assertStringIncludes(phase4, "for a contradicting comment (check 13)");
});

// --- The human-facing docs must not contradict the prompt ---

Deno.test("operator manual - documents the thirteen-check catalogue including check 13", async () => {
  const manual = await readDoc("docs/DOCUMENTATION-AUDIT-SCAN.md");
  assertStringIncludes(manual, "## The thirteen-check catalogue");
  assertStringIncludes(manual, "13. **Comment contradicts the code**");
  assert(
    !manual.includes("twelve-check"),
    "the manual must not still claim a twelve-check catalogue",
  );
  assert(
    !manual.includes("against twelve checks"),
    "the manual must not still claim the prompt walks twelve checks",
  );
});

Deno.test("operator manual - the sibling table keeps the doc-coverage boundary", async () => {
  const manual = await readDoc("docs/DOCUMENTATION-AUDIT-SCAN.md");
  assertStringIncludes(
    manual,
    "Comments that contradict the code they sit beside",
  );
});

Deno.test("design principles - records check 13 and no longer claims twelve checks", async () => {
  const principles = await readDoc("DESIGN-PRINCIPLES.md");
  const section = principles.slice(
    principles.indexOf("### Documentation-audit scans (template #13)"),
    principles.indexOf("### Workflow-annotation scans (template #15)"),
  );
  assert(section.length > 0, "documentation-audit design section not found");
  assertStringIncludes(section, "Thirteen checks");
  assertStringIncludes(section, "thirteen-check catalogue");
  assert(
    !section.includes("Twelve checks"),
    "DESIGN-PRINCIPLES.md must not still claim twelve checks",
  );
  assert(
    !section.includes("twelve-check catalogue"),
    "DESIGN-PRINCIPLES.md must not still claim a twelve-check catalogue",
  );
});
