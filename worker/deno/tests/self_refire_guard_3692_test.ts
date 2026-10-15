/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3692 — VibeCoder#2898 and VibeCoder#3676 added automation that
 * re-fires on its own output: a partial rollup raised again on every scan, and
 * a `Finish #N` follow-up whose own follow-up was filed as
 * `Finish #F1: Finish #N`. CODING-STANDARDS.md and the coding_guidelines prompt
 * must both carry the same "must not re-fire on its own output" rule, the
 * standards must name both past regressions, and the guidelines copy must sit
 * in the core layer beside the provenance rule.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import {
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const RULE_START =
  "**Automation that creates fleet work must not re-fire on its own output.**";
const SECOND_PASS = "**Test the second pass**";
const PROVENANCE_RULE = "**Remove only what you can prove you added.**";
const GUIDELINES_LAYER_MARKER = "<!-- guidelines-layer: code -->";
const STANDARDS_TITLE = "Automation and Shared GitHub State";
const GUIDELINES_TITLE = "Human Escalation";

const KEY_PHRASES = [
  "must not re-fire on its own output",
  "files an issue, raises a PR, pushes a ref or applies a label",
  "say in the PR summary what stops the trigger from firing again",
  "a fleet-authored marker on the output that the trigger reads and skips",
  "a generation or depth cap",
  "a non-empty diff, a still-open parent",
  "Deduping against *open* items is not enough",
  "**Test the second pass**",
  "the rollup merged and synced back",
  "files, raises, pushes or applies nothing",
];

/**
 * The re-fire rule: from its bold opening up to the end of the "Test the second
 * pass" bullet, which is the next blank line after that bullet.
 */
function refireRule(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(RULE_START);
  assert(start >= 0, `could not locate the re-fire rule in ${what}`);
  const bullet = sectionText.indexOf(SECOND_PASS, start);
  assert(
    bullet >= 0,
    `could not locate the "Test the second pass" bullet in ${what}`,
  );
  const end = sectionText.indexOf("\n\n", bullet);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

Deno.test("both surfaces carry the re-fire rule (Issue #3692)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    STANDARDS_TITLE,
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    GUIDELINES_TITLE,
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const rule = refireRule(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        rule.includes(phrase),
        `${surface} is missing "${phrase}" from the re-fire rule: ${rule}`,
      );
    }
  }
});

Deno.test("the standards name both past regressions (Issue #3692)", async () => {
  const standards = flat(
    section(await readRepoDoc("CODING-STANDARDS.md"), STANDARDS_TITLE),
  );

  assert(
    standards.includes("VibeCoder#2898's `createPartialRollup`"),
    `the standards do not name VibeCoder#2898's \`createPartialRollup\`: ${standards}`,
  );
  assert(
    standards.includes("`Finish #F1: Finish #N`"),
    `the standards do not name the \`Finish #F1: Finish #N\` regression: ${standards}`,
  );
});

Deno.test("the guidelines copy sits in the core layer beside the provenance rule (Issue #3692)", async () => {
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    GUIDELINES_TITLE,
  );

  const provenance = guidelines.indexOf(PROVENANCE_RULE);
  const refire = guidelines.indexOf(RULE_START);
  const marker = guidelines.indexOf(GUIDELINES_LAYER_MARKER);

  assert(
    provenance >= 0,
    `Human Escalation is missing the provenance rule "${PROVENANCE_RULE}"`,
  );
  assert(refire >= 0, `Human Escalation is missing the re-fire rule`);
  assert(
    marker >= 0,
    `Human Escalation is missing the "${GUIDELINES_LAYER_MARKER}" marker`,
  );
  assert(
    provenance < refire,
    "the re-fire rule must follow the provenance rule in Human Escalation",
  );
  assert(
    refire < marker,
    "the re-fire rule must sit before the guidelines-layer code marker",
  );
});
