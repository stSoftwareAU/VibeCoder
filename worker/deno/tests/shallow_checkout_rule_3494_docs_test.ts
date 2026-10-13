/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3494 — fleet code and tests kept assuming git history the worker's
 * `--depth=1 --no-single-branch` checkout does not have (#2893, #3398 and a
 * private fleet PR), because none of the guidance read while implementing an
 * issue said the checkout is shallow. CODING-STANDARDS.md and the
 * coding_guidelines prompt must both carry the shallow-checkout rule, its four
 * bullets word for word once wrapping is ignored.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildShallowCloneArgs,
  setupRepo,
} from "../commands/git_operations.ts";
import {
  assertPins,
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

// Derived from the live clone, so changing the flags turns the pins red.
const cloneArgs = buildShallowCloneArgs("owner/repo", "/tmp/r");
const CLONE_FLAGS = cloneArgs.slice(cloneArgs.indexOf("--") + 1).join(" ");
const SETUP_REPO = `\`${setupRepo.name}\``;

const RULE_TITLE = "Never assume history the worker's shallow checkout lacks";
const FIRST_BULLET = "- **Assume nothing beyond a branch tip.**";
const LAST_BULLET = '- **"Cannot run here" is a defect, not a caveat.**';

/** The four rule bullets, from the first bullet to the end of the last. */
function bulletsExcerpt(text: DocSection, what: string): DocSection {
  const start = text.indexOf(FIRST_BULLET);
  assert(
    start >= 0,
    `could not locate the first shallow-checkout bullet in ${what}`,
  );
  const last = text.indexOf(LAST_BULLET, start);
  assert(
    last >= 0,
    `could not locate the last shallow-checkout bullet in ${what}`,
  );
  const end = text.indexOf("\n\n", last);
  return excerpt(text, start, end >= 0 ? end : undefined);
}

function ruleBullets(text: DocSection, what: string): string {
  return flat(bulletsExcerpt(text, what)).trim();
}

const standards = section(await readRepoDoc("CODING-STANDARDS.md"), RULE_TITLE);
const guidelines = section(
  await readRepoDoc("prompts/coding_guidelines/prompt.md"),
  "Testing Best Practices",
);

Deno.test("CODING-STANDARDS.md says why the shallow-checkout rule exists (Issue #3494)", () => {
  assertPins(standards, [
    SETUP_REPO,
    "fetch-depth: 0",
    "grafted fleet worktrees",
    "author of the boundary commit",
  ]);
});

Deno.test("the coding guidelines carry the shallow-checkout rule in Testing Best Practices (Issue #3494)", () => {
  assertPins(guidelines, [`**${RULE_TITLE}.**`, "fetch-depth: 0"]);
});

Deno.test("both surfaces carry the shallow-checkout bullets, identical (Issue #3494)", () => {
  const pins = [
    CLONE_FLAGS,
    "`HEAD~N` or `<ref>^`",
    "`merge-base`",
    "`blame` attribution",
    "`git init` in a temporary directory",
    "`git rev-parse --is-shallow-repository`",
    "not whether an object exists",
    "unknown rather than as an answer",
    "not a caveat to report",
  ];
  assertPins(bulletsExcerpt(standards, "CODING-STANDARDS.md"), pins);
  assertPins(bulletsExcerpt(guidelines, "the coding guidelines"), pins);
  assertEquals(
    ruleBullets(standards, "CODING-STANDARDS.md"),
    ruleBullets(guidelines, "the coding guidelines"),
    "the shallow-checkout bullets must be identical on both surfaces",
  );
});
