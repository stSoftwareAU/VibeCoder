/**
 * Tests for documentation-audit prompt v9 (Issue #685).
 *
 * v9 adds audit check 13 — **comment contradicts the code**: the source is
 * the single source of truth, so a comment stating something the adjacent
 * code does not do is removed by default. The one exception is a comment
 * describing deliberate behaviour the code never implements (a guard, a
 * limit, an error path); that is filed as a possible bug in the code, not
 * as a comment removal.
 *
 * v8 stays immutable and serves as the negative control — every check-13
 * assertion asserts the gap is present in v8 and closed in v9, so the suite
 * fails against the unfixed prompt tree.
 *
 * Australian English is used throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";
import { hasProjectConventionsStanza } from "../lib/project_conventions_stanza.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

async function loadDocumentationAudit(version: string): Promise<string> {
  const result = await loadPrompt("documentation_audit", version, PROMPTS_DIR);
  assertEquals(
    result.ok,
    true,
    `documentation_audit ${version} failed to load`,
  );
  if (!result.ok) {
    throw new Error(`documentation_audit ${version} failed to load`);
  }
  return result.value;
}

const loadV8 = () => loadDocumentationAudit("v8");
const loadV9 = () => loadDocumentationAudit("v9");

const readDoc = (relPath: string) =>
  Deno.readTextFile(`${REPO_ROOT}${relPath}`);

// --- Version resolution ---

Deno.test("documentation_audit v9 - is the version the worker resolves", async () => {
  const latest = await getLatestVersion("documentation_audit", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) return;
  assertEquals(latest.value, "v9");

  const [byName, byVersion] = await Promise.all([
    loadPrompt("documentation_audit", undefined, PROMPTS_DIR),
    loadV9(),
  ]);
  assertEquals(byName.ok, true);
  if (!byName.ok) return;
  assertEquals(byName.value, byVersion);
});

Deno.test("documentation_audit v9 - keeps the dedup and attribution placeholders", async () => {
  const body = await loadV9();
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

Deno.test("documentation_audit v9 - keeps the shared Phase 0 conventions stanza", async () => {
  assert(
    hasProjectConventionsStanza(await loadV9()),
    "v9 must carry the canonical Phase 0 stanza verbatim",
  );
});

Deno.test("documentation_audit v9 - the H1 names its own version", async () => {
  const v9 = await loadV9();
  const h1 = v9.split("\n")[0] ?? "";
  assertStringIncludes(h1, "# Documentation Audit");
  assertStringIncludes(h1, "(v9)");
});

// --- Check 13: comments that contradict the code ---

Deno.test("documentation_audit v9 - adds check 13 for comments that contradict the code", async () => {
  const [v8, v9] = await Promise.all([loadV8(), loadV9()]);
  assert(
    !/### 13\./.test(v8),
    "v8 is the negative control: it must have no check 13",
  );
  assertStringIncludes(v9, "### 13. Comment contradicts the code");
  assertStringIncludes(v9, "The source code is the truth");
});

Deno.test("documentation_audit v9 - check 13 removes the comment by default, citing file and line", async () => {
  const v9 = await loadV9();
  const check = v9.slice(
    v9.indexOf("### 13. Comment contradicts the code"),
    v9.indexOf("<examples>"),
  );
  assert(check.length > 0, "check 13 section not found before the examples");
  // The default remedy is deletion, evidenced by a file/line citation.
  assertStringIncludes(check, "delete the comment");
  assertStringIncludes(check, "Cite the comment's file and line");
});

Deno.test("documentation_audit v9 - check 13 files a possible code bug when the comment documents absent behaviour", async () => {
  const v9 = await loadV9();
  const check = v9.slice(
    v9.indexOf("### 13. Comment contradicts the code"),
    v9.indexOf("<examples>"),
  );
  assertStringIncludes(check, "possible bug in the code");
  // The three shapes the issue enumerates for deliberate-but-unimplemented
  // behaviour.
  for (const shape of ["guard", "limit", "error path"]) {
    assertStringIncludes(check, shape);
  }
});

Deno.test("documentation_audit v9 - check 13 states the doc-coverage ownership boundary", async () => {
  const [v8, v9] = await Promise.all([loadV8(), loadV9()]);
  // v8 already draws the sibling boundary, but only over missing or
  // paraphrase-only docstrings — it never claims contradicting comments.
  assert(
    !v8.includes("contradicts the code it sits beside"),
    "v8 is the negative control: it claims no ownership of contradicting comments",
  );
  assertStringIncludes(v9, "contradicts the code it sits beside");
  assertStringIncludes(v9, "paraphrase");
});

Deno.test("documentation_audit v9 - check 13 carves out the legitimate look-alikes", async () => {
  const v9 = await loadV9();
  const check = v9.slice(
    v9.indexOf("### 13. Comment contradicts the code"),
    v9.indexOf("<examples>"),
  );
  const silent = check.slice(check.indexOf("**Stay silent**"));
  assert(silent.length > 0, "check 13 must carry a stay-silent carve-out");
  // A TODO is future intent, commented-out code is not a claim, and a
  // rationale explains why rather than what.
  for (const carveOut of ["TODO", "commented-out code", "rationale"]) {
    assertStringIncludes(silent, carveOut);
  }
});

Deno.test("documentation_audit v9 - check 13 collapses per source file", async () => {
  const v9 = await loadV9();
  const check = v9.slice(
    v9.indexOf("### 13. Comment contradicts the code"),
    v9.indexOf("<examples>"),
  );
  assertStringIncludes(check, "one finding per source file");
});

Deno.test("documentation_audit v9 - check 13 has worked examples for both verdicts", async () => {
  const [v8, v9] = await Promise.all([loadV8(), loadV9()]);
  assertStringIncludes(v9, '<example name="comment-contradicts-adjacent-code">');
  assertStringIncludes(v9, '<example name="comment-documents-a-guard-the-code-lacks">');
  assertStringIncludes(v9, '<example name="comment-explaining-why">');
  assert(
    !v8.includes("check 13"),
    "v8 is the negative control: no check 13 example",
  );
});

// --- Inventory and bookkeeping the new check depends on ---

Deno.test("documentation_audit v9 - Phase 1 inventories the source comments check 13 reads", async () => {
  const [v8, v9] = await Promise.all([loadV8(), loadV9()]);
  const inventory = v9.slice(
    v9.indexOf("## Phase 1 — Inventory the documentation surface"),
    v9.indexOf("## Phase 2"),
  );
  assertStringIncludes(inventory, "Source comments");
  assert(
    !v8.includes("Source comments"),
    "v8 is the negative control: its inventory stops at prose",
  );
});

Deno.test("documentation_audit v9 - renumbers the check counts consistently", async () => {
  const [v8, v9] = await Promise.all([loadV8(), loadV9()]);
  assertStringIncludes(v8, "twelve-check catalogue");
  assertStringIncludes(v9, "## Phase 2 — Apply the thirteen-check catalogue");
  assert(
    !v9.includes("twelve-check"),
    "v9 must not still describe the catalogue as twelve checks",
  );
});

Deno.test("documentation_audit v9 - the read-before-you-assert rule extends to check 13", async () => {
  const [v8, v9] = await Promise.all([loadV8(), loadV9()]);
  assertStringIncludes(v8, "This binds hardest on checks 10–12");
  assertStringIncludes(v9, "This binds hardest on checks 10–13");
  assert(
    !v9.includes("binds hardest on checks 10–12"),
    "v9 must extend the read-before-you-assert range to check 13",
  );
});

Deno.test("documentation_audit v9 - severity guidance covers a contradicting comment", async () => {
  const v9 = await loadV9();
  const severitySection = v9.slice(v9.indexOf("### Severity guidance"));
  assertStringIncludes(severitySection, "comment");
});

Deno.test("documentation_audit v9 - the suggested-fix guidance tells the filer what to write", async () => {
  const v9 = await loadV9();
  const phase4 = v9.slice(v9.indexOf("## Phase 4 — File one issue per finding"));
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
  assertStringIncludes(manual, "Comments that contradict the code they sit beside");
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
