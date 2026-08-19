/**
 * Tests that the four Boy Scout idle-task templates (dead-code,
 * doc-coverage, format-drift, deprecated-api) are wired into the
 * production idle-task framework so they are actually raised on the
 * monitored repos (Issue #2930).
 *
 * The four templates were created in milestone #2903 but never imported
 * into any production path, so they registered nowhere and never fired.
 * These tests pin the wiring at three chokepoints:
 *   1. The production filer command registers them, so the random
 *      rotation can pick them (`listTemplates()` sees all ten).
 *   2. Their canonical wrapper titles are on the `IDLE_TASK_WRAPPER_TITLES`
 *      allowlist, so a filed wrapper is claimable and seedable.
 *   3. The claim handler registers them, so a claimed Boy Scout wrapper
 *      routes to its `runTask()`.
 *
 * Importing the production modules for their registration side-effect is
 * exactly what the worker does at start-up.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert } from "@std/assert";

// Production wiring under test — imported for their registration side-effect,
// mirroring how the worker boots.
import "../commands/maybe_file_idle_task.ts";
import "../lib/idle_task_claim_handler.ts";

import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import { IDLE_TASK_WRAPPER_TITLES } from "../lib/idle_task_backfill.ts";
import { DEAD_CODE_ISSUE_TITLE } from "../lib/idle_task_templates/dead_code_template.ts";
import { DOC_COVERAGE_ISSUE_TITLE } from "../lib/idle_task_templates/doc_coverage_template.ts";
import { FORMAT_DRIFT_ISSUE_TITLE } from "../lib/idle_task_templates/format_drift_template.ts";
import { DEPRECATED_API_ISSUE_TITLE } from "../lib/idle_task_templates/deprecated_api_template.ts";

/** The four Boy Scout template names, paired with their wrapper titles. */
const BOY_SCOUT_TEMPLATES: ReadonlyArray<{ name: string; title: string }> = [
  { name: "dead-code", title: DEAD_CODE_ISSUE_TITLE },
  { name: "doc-coverage", title: DOC_COVERAGE_ISSUE_TITLE },
  { name: "format-drift", title: FORMAT_DRIFT_ISSUE_TITLE },
  { name: "deprecated-api", title: DEPRECATED_API_ISSUE_TITLE },
];

Deno.test(
  "Boy Scout templates are registered in the production registry (Issue #2930)",
  () => {
    for (const { name } of BOY_SCOUT_TEMPLATES) {
      assert(
        getTemplate(name) !== undefined,
        `template "${name}" must be registered for the random filer to pick it`,
      );
    }
  },
);

Deno.test(
  "production registry holds all ten idle-task templates (Issue #2930)",
  () => {
    const names = new Set(listTemplates().map((t) => t.name));
    for (
      const expected of [
        "security-scan",
        "best-practices",
        "test-audit",
        "github-actions-audit",
        "supply-chain-readiness",
        "orphan-deps",
        "dead-code",
        "doc-coverage",
        "format-drift",
        "deprecated-api",
      ]
    ) {
      assert(names.has(expected), `registry missing template "${expected}"`);
    }
  },
);

Deno.test(
  "Boy Scout wrapper titles are on the canonical allowlist (Issue #2930)",
  () => {
    for (const { title } of BOY_SCOUT_TEMPLATES) {
      assert(
        IDLE_TASK_WRAPPER_TITLES.includes(title),
        `wrapper title "${title}" must be on IDLE_TASK_WRAPPER_TITLES so ` +
          `the wrapper is claimable and seedable`,
      );
    }
  },
);

Deno.test(
  "each Boy Scout template title matches its registered buildIssueTitle (Issue #2930)",
  () => {
    for (const { name, title } of BOY_SCOUT_TEMPLATES) {
      const template = getTemplate(name);
      assert(template !== undefined, `template "${name}" not registered`);
      // The title constant the allowlist uses must equal what the template
      // actually files — otherwise dispatch would never match a claimed
      // wrapper back to its template.
      assert(
        template.buildIssueTitle("org/example").trim() === title,
        `template "${name}" buildIssueTitle does not match its wrapper title`,
      );
    }
  },
);
