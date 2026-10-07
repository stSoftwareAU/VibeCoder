/**
 * Tests for the documentation-audit prompt's checks 13 and 14 (Issues #685,
 * #2321).
 *
 * Check 13 is **comment contradicts the code**: the source is the single
 * source of truth, so a comment stating something the adjacent code does not
 * do is removed by default. The one exception is a comment describing
 * deliberate behaviour the code never implements (a guard, a limit, an error
 * path); that is filed as a possible bug in the code, not as a comment
 * removal.
 *
 * Check 14 is **agent instructions do not follow Claude Code guidance**:
 * checks 5 and 9 decide how many agent instruction files a repo keeps, and
 * check 14 reads what the surviving one says — the commands it must carry, the
 * conditional items a fixed signal makes applicable, the 200-line size budget,
 * and the content Anthropic says to leave out.
 *
 * The assertions run against the current `documentation_audit` template, so an
 * edit that drops a check — or renumbers the catalogue without saying so —
 * fails in CI.
 *
 * Positive pins are scoped to the heading whose section holds them with
 * `section()`/`readRepoDoc()` from `support/markdown_docs.ts` (Issue #3309) —
 * a whole-file `includes` still passes on a page that moved the rule into an
 * unrelated section. The "keeps the dedup and attribution placeholders" test
 * stays whole-file: each placeholder must be substituted wherever the
 * template is rendered, and all four already live together under the one
 * "Inputs" heading, so scoping buys nothing there but a second lookup; see
 * CODING-STANDARDS.md § Documentation-drift tests, condition 1.
 *
 * Australian English is used throughout (behaviour, colour, organisation).
 */

import { assert, assertStringIncludes } from "@std/assert";
import { hasProjectConventionsStanza } from "../lib/project_conventions_stanza.ts";
import {
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const loadDocumentationAudit = () =>
  readRepoDoc("prompts/documentation_audit/prompt.md");

const readDoc = (relPath: string) => readRepoDoc(relPath);

/** The exact catalogue heading text, by check number — kept in sync with the
 * template's own numbering so a renumbering fails loudly via `section()`. */
const CHECK_TITLES: Record<number, string> = {
  13: "13. Comment contradicts the code",
  14: "14. Agent instructions do not follow Claude Code guidance",
};

/**
 * One numbered Phase 2 check, from its heading to the next check's heading
 * (or the shared worked-examples block, for the last check), flattened.
 */
async function catalogueSection(n: number): Promise<string> {
  const title = CHECK_TITLES[n];
  assert(title, `no catalogue title mapped for check ${n}`);
  const body = await loadDocumentationAudit();
  const whole = section(body, title);
  const examplesAt = whole.indexOf("<examples>");
  const trimmed: DocSection = examplesAt >= 0
    ? excerpt(whole, 0, examplesAt)
    : whole;
  return flat(trimmed);
}

Deno.test("documentation_audit - keeps the dedup and attribution placeholders", async () => {
  // All four placeholders live together under "## Inputs"; see file header.
  const inputs = flat(
    section(await loadDocumentationAudit(), "Inputs"),
  );
  for (
    const placeholder of [
      "{{SUPPRESSED_IDS}}",
      "{{KNOWN_OPEN_FINDING_IDS}}",
      "{{OPEN_ISSUE_TITLES}}",
      "{{ATTRIBUTION_FOOTER}}",
    ]
  ) {
    assertStringIncludes(inputs, placeholder);
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
  // catalogueSection(13) throws if the "13. Comment contradicts the code"
  // heading is renamed or removed.
  const check = await catalogueSection(13);
  assertStringIncludes(check, "The source code is the truth");
});

Deno.test("documentation_audit - check 13 removes the comment by default, citing file and line", async () => {
  const check = await catalogueSection(13);
  // The default remedy is deletion, evidenced by a file/line citation.
  assertStringIncludes(check, "delete the comment");
  assertStringIncludes(check, "Cite the comment's file and line");
});

Deno.test("documentation_audit - check 13 files a possible code bug when the comment documents absent behaviour", async () => {
  const check = await catalogueSection(13);
  assertStringIncludes(check, "possible bug in the code");
  // The three shapes the issue enumerates for deliberate-but-unimplemented
  // behaviour.
  for (const shape of ["guard", "limit", "error path"]) {
    assertStringIncludes(check, shape);
  }
});

Deno.test("documentation_audit - check 13 states the doc-coverage ownership boundary", async () => {
  // The sibling boundary used to cover only missing or paraphrase-only
  // docstrings; check 13 claims contradicting comments explicitly. Lives
  // under "## Sibling boundary — what belongs to this scan".
  const boundary = flat(
    section(
      await loadDocumentationAudit(),
      "Sibling boundary — what belongs to this scan",
    ),
  );
  assertStringIncludes(boundary, "contradicts the code it sits beside");
  assertStringIncludes(boundary, "paraphrase");
});

Deno.test("documentation_audit - check 13 carves out the legitimate look-alikes", async () => {
  const check = await catalogueSection(13);
  const silent = check.slice(check.indexOf("**Stay silent**"));
  assert(silent.length > 0, "check 13 must carry a stay-silent carve-out");
  // A TODO is future intent, commented-out code is not a claim, and a
  // rationale explains why rather than what.
  for (const carveOut of ["TODO", "commented-out code", "rationale"]) {
    assertStringIncludes(silent, carveOut);
  }
});

Deno.test("documentation_audit - check 13 collapses per source file", async () => {
  const check = await catalogueSection(13);
  assertStringIncludes(check, "one finding per source file");
});

Deno.test("documentation_audit - check 13 has worked examples for both verdicts", async () => {
  // The worked examples for every check share one block at the end of
  // Phase 2, so this is scoped to the whole catalogue section rather than
  // check 13's own subsection.
  const phase2 = flat(
    section(
      await loadDocumentationAudit(),
      "Phase 2 — Apply the fourteen-check catalogue",
    ),
  );
  assertStringIncludes(
    phase2,
    '<example name="comment-contradicts-adjacent-code">',
  );
  assertStringIncludes(
    phase2,
    '<example name="comment-documents-a-guard-the-code-lacks">',
  );
  assertStringIncludes(phase2, '<example name="comment-explaining-why">');
});

// --- Check 14: agent instructions versus the Claude Code guidance ---

/**
 * The check-14 section on its own — heading to the shared worked examples —
 * with its line wrapping flattened away.
 */
const checkFourteen = () => catalogueSection(14);

Deno.test("documentation_audit - carries check 14 for the agent-instruction guidance", async () => {
  // catalogueSection(14) throws if the heading text is renamed or removed.
  const check = await checkFourteen();
  assert(check.length > 0, "check 14 section is empty");
});

Deno.test("documentation_audit - check 14 assesses the detection set plus its @path imports", async () => {
  const check = await checkFourteen();
  for (
    const file of [
      "`AGENTS.md`",
      "`CLAUDE.md`",
      "`GEMINI.md`",
      "`.github/copilot-instructions.md`",
      "`.cursorrules`",
    ]
  ) {
    assertStringIncludes(check, file);
  }
  assertStringIncludes(check, "@path");
  // The check-9 end-state stands: no repo is ever asked to add a CLAUDE.md.
  assertStringIncludes(check, "Never ask a repo to **create** a `CLAUDE.md`");
});

Deno.test("documentation_audit - check 14 is held while checks 5 and 9 are outstanding", async () => {
  const check = await checkFourteen();
  assertStringIncludes(
    check,
    "Run this check only when checks 5 and 9 are clear",
  );
  assertStringIncludes(check, "hold this one until one file remains");
});

Deno.test("documentation_audit - check 14 requires a runnable command line per applicable stage", async () => {
  const check = await checkFourteen();
  assertStringIncludes(check, "runnable command line");
  assertStringIncludes(check, "**test** — always required");
  // Build and lint are owed only by a repo that has the stage.
  assertStringIncludes(check, "Cargo.toml");
  assertStringIncludes(check, "`Makefile` with a `build`");
  assertStringIncludes(
    check,
    "in a repo that has no such stage is not a finding",
  );
  // Naming the runner is not a command; one gate command covers its stages.
  assertStringIncludes(
    check,
    "Naming the test runner or the build tool without a command line does **not** satisfy the item",
  );
  assertStringIncludes(check, "./quality.sh");
});

Deno.test("documentation_audit - check 14 only fires on a repo with no agent file when the README also lacks the commands", async () => {
  const check = await checkFourteen();
  assertStringIncludes(check, "no agent instruction file at all");
  assertStringIncludes(check, "is a finding here only when");
  assertStringIncludes(check, "the documented end-state, not a gap");
});

Deno.test("documentation_audit - check 14 gates the five conditional items on a fixed signal list", async () => {
  const check = await checkFourteen();
  for (
    const signal of [
      ".env.example",
      "CONTRIBUTING.md",
      ".github/pull_request_template.md",
      "docs/adr/",
      "rustfmt.toml",
    ]
  ) {
    assertStringIncludes(check, signal);
  }
  for (
    const item of [
      "Code style rules",
      "Repository etiquette",
      "Project-specific architectural decisions",
      "Developer environment quirks",
      "Common gotchas",
    ]
  ) {
    assertStringIncludes(check, item);
  }
  assertStringIncludes(check, "Do not infer a signal");
  assertStringIncludes(check, "gotchas are never mandatory");
  assertStringIncludes(
    check,
    "**Conditional — five further items, each behind a fixed signal** (`severity:low`)",
  );
});

Deno.test("documentation_audit - check 14 measures 200 physical lines per file and never on the README", async () => {
  const check = await checkFourteen();
  assertStringIncludes(check, "under 200 lines per");
  assertStringIncludes(check, "`wc -l`");
  assertStringIncludes(check, "no exclusion for blank lines");
  assertStringIncludes(check, "an imported file over 200");
  assertStringIncludes(check, "it never fires on `README.md`");
});

Deno.test("documentation_audit - check 14 folds excluded content into the same file's size entry", async () => {
  const check = await checkFourteen();
  assertStringIncludes(check, "file-by-file descriptions");
  assertStringIncludes(check, "same file's size entry");
});

Deno.test("documentation_audit - check 14 collapses to one finding per repo under a fixed title", async () => {
  const check = await checkFourteen();
  assertStringIncludes(check, "collapse into a single finding per run");
  assertStringIncludes(
    check,
    "Agent instruction files do not follow Claude Code guidance",
  );
  // The primary file feeds the stable id, so it must be pinned too.
  assertStringIncludes(check, "primary file is the agent instruction file");
});

Deno.test("documentation_audit - check 14 has worked examples for both verdicts", async () => {
  // Shared examples block at the end of Phase 2, as for check 13 above.
  const phase2 = flat(
    section(
      await loadDocumentationAudit(),
      "Phase 2 — Apply the fourteen-check catalogue",
    ),
  );
  assertStringIncludes(
    phase2,
    '<example name="oversized-agent-instruction-file">',
  );
  assertStringIncludes(
    phase2,
    '<example name="gate-command-satisfies-both-stages">',
  );
});

Deno.test("documentation_audit - the line count check 14 needs is a permitted command", async () => {
  const constraints = section(
    await loadDocumentationAudit(),
    "Hard Constraints",
  );
  const scoped = excerpt(
    constraints,
    constraints.indexOf("2. **No code execution.**"),
    constraints.indexOf("3. **Read before you assert.**"),
  );
  assert(
    scoped.length > 0,
    "the no-code-execution constraint was not found",
  );
  assertStringIncludes(scoped, "`wc`");
});

Deno.test("documentation_audit - severity guidance covers the check-14 gaps", async () => {
  const severitySection = flat(
    section(await loadDocumentationAudit(), "Severity guidance"),
  );
  assert(severitySection.length > 0, "the severity guidance was not found");
  // Both halves: the mandatory gaps are medium, the conditional ones low.
  assertStringIncludes(
    severitySection,
    "missing a mandatory command (check 14)",
  );
  assertStringIncludes(severitySection, "says to exclude (check 14)");
});

Deno.test("documentation_audit - the suggested-fix guidance tells the filer what a check-14 body says", async () => {
  // "## Why this matters" and "## Suggested fix" below are headings *inside*
  // the fenced worked-example skeleton, not real document headings, so
  // section() masks them; both pins live in the real
  // "## Phase 4 — File one issue per finding" section, which is the
  // document's last real level-2 heading and so runs to end of file.
  const phase4 = flat(
    section(
      await loadDocumentationAudit(),
      "Phase 4 — File one issue per finding",
    ),
  );
  assertStringIncludes(phase4, "for an agent-instruction gap (check 14)");
});

Deno.test("documentation_audit - Phase 1 inventories the imports and line counts check 14 reads", async () => {
  const inventory = flat(
    section(
      await loadDocumentationAudit(),
      "Phase 1 — Inventory the documentation surface",
    ),
  );
  assertStringIncludes(inventory, "@path");
  assertStringIncludes(inventory, "line count");
});

// --- Inventory and bookkeeping the check depends on ---

Deno.test("documentation_audit - Phase 1 inventories the source comments check 13 reads", async () => {
  const inventory = section(
    await loadDocumentationAudit(),
    "Phase 1 — Inventory the documentation surface",
  );
  assertStringIncludes(inventory, "Source comments");
});

Deno.test("documentation_audit - the Phase 2 sweep bound cannot starve check 13", async () => {
  const phase2 = section(
    await loadDocumentationAudit(),
    "Phase 2 — Apply the fourteen-check catalogue",
  );
  const bound = excerpt(
    phase2,
    phase2.indexOf("**Bound the sweep, not just the results.**"),
    phase2.indexOf("### 1. Unabsorbed PR-summary learnings"),
  );
  assert(bound.length > 0, "the Phase 2 sweep bound was not found");
  // The source-comment shortlist is ranked below the docs in the drift
  // order, so without an exemption a repo with six drafty documents would
  // stop sweeping before check 13 ever ran.
  assertStringIncludes(bound, "**Check 13 is exempt from that stop rule**");
  assertStringIncludes(bound, "as you open it");
});

Deno.test("documentation_audit - an unresolved check-13 direction does not outrank a confirmed finding", async () => {
  const check = await catalogueSection(13);
  assertStringIncludes(check, "possible-bug shape at `severity:medium`");
});

Deno.test("documentation_audit - states the check counts consistently", async () => {
  const text = await loadDocumentationAudit();
  assertStringIncludes(text, "## Phase 2 — Apply the fourteen-check catalogue");
  // Absence checks stay whole-file: a stale count can appear anywhere.
  assert(
    !text.includes("twelve-check"),
    "the template must not still describe the catalogue as twelve checks",
  );
  assert(
    !text.includes("thirteen-check"),
    "the template must not still describe the catalogue as thirteen checks",
  );
});

Deno.test("documentation_audit - the read-before-you-assert rule extends to check 14", async () => {
  const text = await loadDocumentationAudit();
  const constraints = flat(section(text, "Hard Constraints"));
  assertStringIncludes(constraints, "This binds hardest on checks 10–14");
  // Absence checks stay whole-file: a stale range can appear anywhere.
  for (const stale of ["10–12", "10–13"]) {
    assert(
      !text.includes(`binds hardest on checks ${stale}`),
      `the read-before-you-assert range must extend past checks ${stale}`,
    );
  }
});

Deno.test("documentation_audit - severity guidance covers a contradicting comment", async () => {
  const severitySection = section(
    await loadDocumentationAudit(),
    "Severity guidance",
  );
  assertStringIncludes(severitySection, "comment");
});

Deno.test("documentation_audit - the suggested-fix guidance tells the filer what to write", async () => {
  // See the comment on the check-14 variant of this test above: both pins
  // live in the real "## Phase 4" section, not the fenced example's nested
  // "## Suggested fix" heading.
  const phase4 = section(
    await loadDocumentationAudit(),
    "Phase 4 — File one issue per finding",
  );
  assertStringIncludes(phase4, "for a contradicting comment (check 13)");
});

// --- The human-facing docs must not contradict the prompt ---

Deno.test("operator manual - documents the fourteen-check catalogue including checks 13 and 14", async () => {
  const manual = await readDoc("docs/DOCUMENTATION-AUDIT-SCAN.md");
  const catalogue = section(manual, "The fourteen-check catalogue");
  assertStringIncludes(catalogue, "13. **Comment contradicts the code**");
  assertStringIncludes(
    catalogue,
    "14. **Agent instructions do not follow Claude Code guidance**",
  );
  // Absence checks stay whole-file: a stale count can appear anywhere.
  assert(
    !manual.includes("twelve-check"),
    "the manual must not still claim a twelve-check catalogue",
  );
  assert(
    !manual.includes("against twelve checks"),
    "the manual must not still claim the prompt walks twelve checks",
  );
  assert(
    !manual.includes("thirteen-check"),
    "the manual must not still claim a thirteen-check catalogue",
  );
  assert(
    !manual.includes("against thirteen checks"),
    "the manual must not still claim the prompt walks thirteen checks",
  );
});

Deno.test("operator manual - the sibling table keeps the doc-coverage boundary", async () => {
  const manual = await readDoc("docs/DOCUMENTATION-AUDIT-SCAN.md");
  const designIntent = section(
    manual,
    "Design intent — docs converge on one source of truth",
  );
  assertStringIncludes(
    designIntent,
    "Comments that contradict the code they sit beside",
  );
});

Deno.test("design principles - records checks 13 and 14 and no longer claims thirteen checks", async () => {
  const principles = await readDoc("DESIGN-PRINCIPLES.md");
  const docSection = section(
    principles,
    "Documentation-audit scans (template #13)",
  );
  assertStringIncludes(docSection, "Fourteen checks");
  assertStringIncludes(docSection, "fourteen-check catalogue");
  assertStringIncludes(docSection, "Claude Code guidance");
  for (const stale of ["Twelve checks", "twelve-check catalogue"]) {
    assert(
      !docSection.includes(stale),
      `DESIGN-PRINCIPLES.md must not still claim "${stale}"`,
    );
  }
  for (const stale of ["Thirteen checks", "thirteen-check catalogue"]) {
    assert(
      !docSection.includes(stale),
      `DESIGN-PRINCIPLES.md must not still claim "${stale}"`,
    );
  }
});
