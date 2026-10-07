/**
 * Section-scoped wording pins for the presence-gap decision (Issue #841),
 * split out of `prompt_presence_gaps_test.ts` and scoped to their sections
 * per Issue #3309.
 *
 * These pin exact phrases within specific sections of
 * `docs/PROMPT-BEST-PRACTICES-CHECKLIST.md` and
 * `docs/PROMPT-HOUSE-VOCABULARY.md`. This file imports `markdown_docs.ts`,
 * which spawns git — which is why these pins live here rather than in
 * `prompt_presence_gaps_test.ts`.
 *
 * Uses Australian English spelling throughout (behaviour, organisation).
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const CHECKLIST_PATH = "docs/PROMPT-BEST-PRACTICES-CHECKLIST.md";
const VOCABULARY_PATH = "docs/PROMPT-HOUSE-VOCABULARY.md";

/** The house heading for a scan's closing self-check. */
const VERIFICATION_HEADING = "### Verification before exit";

/**
 * The four surfaces no model ever reads: their `prompt.md` is rendered as
 * the filed wrapper issue body by a native template. Kept in step with the
 * list in `prompt_presence_gaps_test.ts` (Issue #841).
 */
const WRAPPER_ISSUE_BODIES: readonly string[] = [
  "alert_feed",
  "bash_script_refs",
  "bash_syntax_audit",
  "workflow_annotation_scan",
];

/** Parse every Markdown table row into trimmed cell arrays. */
function tableRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell)));
}

Deno.test("the checklist records the wrapper-issue-body surface kind (Issue #841)", async () => {
  const body = section(
    await readRepoDoc(CHECKLIST_PATH),
    "Applicability",
  );

  assert(
    body.includes("Wrapper issue body"),
    "the checklist's Applicability section does not record the third " +
      "surface kind",
  );
  for (const directory of WRAPPER_ISSUE_BODIES) {
    assert(
      body.includes(`prompts/${directory}/`),
      `the wrapper-issue-body kind does not cite prompts/${directory}/`,
    );
  }
});

Deno.test("row 5 exempts the surfaces no model reads (Issue #841)", async () => {
  const rows = tableRows(section(await readRepoDoc(CHECKLIST_PATH), "Checklist"));
  const row = rows.find((cells) => cells[0] === "5");
  assert(row, "the checklist's Checklist section has no row 5");

  const notApplicable = row[4] ?? "";
  assert(
    /wrapper issue body/i.test(notApplicable),
    "row 5 still scores a persona on a surface no model reads; its n/a " +
      "definition does not name the wrapper-issue-body kind",
  );
});

Deno.test("the vocabulary points at the settled presence decision (Issue #841)", async () => {
  const body = flat(
    section(await readRepoDoc(VOCABULARY_PATH), "Out of scope"),
  );

  assert(
    body.includes("841"),
    `${VOCABULARY_PATH}'s Out of scope section does not record where the ` +
      "presence-gap decision landed",
  );
  assert(
    body.includes(CHECKLIST_PATH),
    `${VOCABULARY_PATH}'s Out of scope section does not point at the ` +
      "checklist the decision is recorded in",
  );
  assert(
    /wrapper issue bod/i.test(body),
    `${VOCABULARY_PATH}'s Out of scope section does not record which way ` +
      "the persona gap went",
  );
  assert(
    body.includes(VERIFICATION_HEADING),
    `${VOCABULARY_PATH}'s Out of scope section does not record which way ` +
      "the closing-check gap went",
  );
});
