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
