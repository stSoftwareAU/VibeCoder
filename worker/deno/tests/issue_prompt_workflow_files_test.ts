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
 * The assertions below read the shipped `issue` template through the real
 * `loadPrompt()` and hold the section to the exported check table, so the two
 * cannot drift: a check added to the table that the prompt does not name
 * fails here, and so does a label dropped from the prompt.
 *
 * Uses Australian English throughout (behaviour, catalogue, recognised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { WORKFLOW_FILE_CHECKS } from "../lib/workflow_file_checks.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The H2 the rule lives under. */
const SECTION_HEADING = "## Workflow Files — `.github/workflows/`";

async function loadIssue(): Promise<string> {
  const result = await loadPrompt("issue", PROMPTS_DIR);
  assertEquals(result.ok, true, "issue failed to load");
  if (!result.ok) throw new Error("issue failed to load");
  return result.value;
}

/**
 * The section's body, from its heading to the next H2.
 *
 * Hard wraps are joined so a rule split across two lines is still one
 * phrase — the template wraps at 80 columns and a check label is longer.
 */
function workflowFilesSection(template: string): string {
  const start = template.indexOf(SECTION_HEADING);
  assert(
    start >= 0,
    `the issue prompt has no "${SECTION_HEADING}" section`,
  );
  const rest = template.slice(start + SECTION_HEADING.length);
  const next = rest.search(/\n## /);
  const body = next === -1 ? rest : rest.slice(0, next);
  return body.replace(/\s+/g, " ").trim();
}

Deno.test("issue prompt - carries a workflow-files section naming the directory", async () => {
  const section = workflowFilesSection(await loadIssue());
  assert(section.length > 0, "the workflow-files section is empty");
  assertStringIncludes(section, "`.github/workflows/`");
});

Deno.test("issue prompt - names every workflow file check with its rule", async () => {
  const section = workflowFilesSection(await loadIssue());
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
  const section = workflowFilesSection(await loadIssue());
  // The tag that marks the YAML as catalogue-supplied, and the one section
  // whose entries may differ from the issue's YAML.
  assertStringIncludes(section, "vibe-coder:workflow-sync");
  assertStringIncludes(section, "verbatim");
  assertStringIncludes(section, "How to apply");
  assertStringIncludes(section, "repository-specific");
});

Deno.test("issue prompt - resolved pins are copied as given, never re-resolved", async () => {
  const section = workflowFilesSection(await loadIssue());
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
  const section = workflowFilesSection(await loadIssue());
  const lower = section.toLowerCase();
  assertStringIncludes(lower, "never write an action sha from memory");
  // The resolution step itself, and the tag recorded beside the pin.
  assertStringIncludes(section, "gh api repos/<owner>/<repo>/commits/<tag>");
  assertStringIncludes(lower, "trailing comment");
});
