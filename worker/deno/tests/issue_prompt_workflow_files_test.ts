/**
 * The issue prompt's rule for files under `.github/workflows/` (Issue #1825,
 * part of #1755).
 *
 * A run that touches a workflow file writes CI for a repository the fleet
 * audits, so the file it commits is held to the same file-scoped checks the
 * `github-actions-audit` idle task runs — `WORKFLOW_FILE_CHECKS`. The prompt
 * previously said nothing about `.github/workflows/` at all, so a run either
 * inferred the rules or invented them: the most expensive shape being an
 * action SHA written from memory, which resolves nowhere and fails later in
 * someone else's CI.
 *
 * The assertions below read the shipped `issue` template from the repo and
 * hold the Workflow Files section to the exported check table, so the two
 * cannot drift: a check added to the table that the prompt does not name
 * fails here, and so does a label dropped from the prompt.
 *
 * Uses Australian English throughout (behaviour, catalogue, recognised).
 */

import { assert, assertStringIncludes } from "@std/assert";
import { WORKFLOW_FILE_CHECKS } from "../lib/workflow_file_checks.ts";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

/** The H2 the rule lives under. */
const SECTION_HEADING = "Workflow Files — `.github/workflows/`";

/**
 * The section's body, from its heading to the next heading at the same or a
 * higher level.
 */
async function workflowFilesSection(): Promise<string> {
  const doc = await readRepoDoc("prompts/issue/prompt.md");
  return flat(section(doc, SECTION_HEADING));
}

Deno.test("issue prompt - carries a workflow-files section naming the directory", async () => {
  const section = await workflowFilesSection();
  assert(section.length > 0, "the workflow-files section is empty");
  assertStringIncludes(section, "`.github/workflows/`");
});

Deno.test("issue prompt - names every workflow file check with its rule", async () => {
  const section = await workflowFilesSection();
  assert(
    WORKFLOW_FILE_CHECKS.length > 0,
    "WORKFLOW_FILE_CHECKS is empty, so this test would assert nothing",
  );
  for (const check of WORKFLOW_FILE_CHECKS) {
    assertStringIncludes(
      section,
      `\`${check.id}\``,
      `the section does not name the \`${check.id}\` check`,
    );
    assertStringIncludes(
      section,
      check.label.replace(/\s+/g, " "),
      `the section does not state the rule for \`${check.id}\``,
    );
  }
});

Deno.test("issue prompt - a workflow-sync template is committed verbatim", async () => {
  const section = await workflowFilesSection();
  // The tag that marks the YAML as catalogue-supplied, and the one section
  // whose entries may differ from the issue's YAML.
  assertStringIncludes(section, "vibe-coder:workflow-sync");
  assertStringIncludes(section, "verbatim");
  assertStringIncludes(section, "How to apply");
  assertStringIncludes(section, "repository-specific");
});

Deno.test("issue prompt - resolved pins are copied as given, never re-resolved", async () => {
  const section = await workflowFilesSection();
  const lower = section.toLowerCase();
  // Whole phrases, not bare words: prose saying the opposite of the rule must
  // not satisfy the assertion.
  for (
    const phrase of [
      "already resolved",
      "never re-resolve a pin",
      "never bump one to a newer tag",
      "never reformat the yaml",
    ]
  ) {
    assertStringIncludes(lower, phrase);
  }
});

Deno.test("issue prompt - an action SHA is resolved in the run, never recalled", async () => {
  const section = await workflowFilesSection();
  const lower = section.toLowerCase();
  assertStringIncludes(lower, "never write an action sha from memory");
  // The resolution step itself, and the tag recorded beside the pin.
  assertStringIncludes(section, "gh api repos/<owner>/<repo>/commits/<tag>");
  assertStringIncludes(lower, "trailing comment");
});
