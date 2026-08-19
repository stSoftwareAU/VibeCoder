/**
 * Tests that the orphan-dependency operator manual + framework cross-links
 * (Issue #2909) stay accurate against the registered template.
 *
 * These are documentation-drift tests: they call the real template
 * factory / helpers and assert that the values the docs quote (label,
 * wrapper title, cadence number, summary wording, body fingerprint) match
 * the implementation's exported constants, so a code change and its doc must
 * move together. They assert against exported constants rather than grepping
 * hand-written prose, so a harmless reword of the manual never reddens the
 * suite (Issue #3264).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  ORPHAN_DEPS_BODY_FINGERPRINT,
  ORPHAN_DEPS_ISSUE_TITLE,
  ORPHAN_DEPS_LABEL,
  ORPHAN_DEPS_LABEL_COLOUR,
  orphanDepsTemplate,
  renderOrphanDepsSummary,
} from "../lib/idle_task_templates/orphan_deps_template.ts";

// Repo root relative to this test file (worker/deno/tests/).
const REPO_ROOT = new URL("../../../", import.meta.url);

function readDoc(relPath: string): string {
  return Deno.readTextFileSync(new URL(relPath, REPO_ROOT));
}

// ---------------------------------------------------------------------------
// Documented constants match the registered template
// ---------------------------------------------------------------------------

Deno.test("orphan-deps docs - documented label matches the template", () => {
  assertEquals(ORPHAN_DEPS_LABEL, "orphan-deps");
});

Deno.test("orphan-deps docs - documented label colour matches the template", () => {
  assertEquals(ORPHAN_DEPS_LABEL_COLOUR, "0E8A16");
});

Deno.test("orphan-deps docs - documented wrapper title matches the template", () => {
  assertEquals(ORPHAN_DEPS_ISSUE_TITLE, "Run an orphan-dependency scan");
  assertEquals(
    orphanDepsTemplate.buildIssueTitle("o/r"),
    ORPHAN_DEPS_ISSUE_TITLE,
  );
});

Deno.test("orphan-deps docs - documented weekly cadence + no-PR config match", () => {
  assertEquals(orphanDepsTemplate.cooldownHours, 168, "weekly cadence");
  assertEquals(orphanDepsTemplate.skipMilestone, true, "no PR / no milestone");
  assertEquals(orphanDepsTemplate.outputLabel, ORPHAN_DEPS_LABEL);
});

Deno.test("orphan-deps docs - documented close-summary wording matches helper", () => {
  assertEquals(renderOrphanDepsSummary([]), "no findings");
  assertEquals(
    renderOrphanDepsSummary([3, 1, 2]),
    "Orphan-dependency scan complete. Filed 3 issues: #1, #2, #3",
  );
});

Deno.test("orphan-deps docs - body fingerprint matches the prompt heading the docs quote", () => {
  assert(
    ORPHAN_DEPS_BODY_FINGERPRINT.test("# Orphan-Dependency Scan — overview"),
  );
});

// ---------------------------------------------------------------------------
// Operator manual exists and is cross-linked
// ---------------------------------------------------------------------------

Deno.test("orphan-deps docs - operator manual quotes the template's constants", () => {
  const doc = readDoc("docs/ORPHAN-DEPS-SCAN.md");
  assert(doc.includes(ORPHAN_DEPS_LABEL), "documents the orphan-deps label");
  assert(doc.includes(ORPHAN_DEPS_ISSUE_TITLE), "documents the wrapper title");
  // Derive the cadence from the template's own constant so a cadence change
  // must update both code and doc together — not grep an arbitrary literal.
  assert(
    doc.includes(String(orphanDepsTemplate.cooldownHours)),
    "documents the weekly cadence (cooldownHours)",
  );
});

Deno.test("orphan-deps docs - framework manual links the operator manual + lists the templates", () => {
  const framework = readDoc("docs/IDLE-TASK-FRAMEWORK.md");
  assert(
    framework.includes("ORPHAN-DEPS-SCAN.md"),
    "framework links the new manual",
  );
  assert(
    framework.includes(ORPHAN_DEPS_LABEL),
    "framework names the template",
  );
});
