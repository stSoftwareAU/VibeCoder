/**
 * Issue #2636: a visual/UX design anti-pattern list for front-end work.
 *
 * `design.md` covers code smells and `html.md` / `react.md` cover markup and
 * hook correctness, but no prompt named the visual mistakes a front-end
 * review should flag. The list lives in the `html` bucket: that bucket
 * already cites WCAG and the ARIA Authoring Practices, and a bucket is
 * inlined only into a best-practices scan of a repo with HTML, so the
 * always-loaded coding guidelines pay nothing for it.
 *
 * The tests read the guide through the same reader the scan uses and assert
 * structure — a short list whose every check links a canonical source — so
 * the wording may change freely.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  bucketGuidePath,
  readBucketGuide,
} from "../lib/idle_task_templates/best_practices_template.ts";
import { checkNumbersIn } from "../lib/bucket_check_numbering.ts";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { section, withoutSection } from "./support/markdown_docs.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const HEADING = "Visual design anti-patterns";
/** "Keep it short" — a list longer than this is restating the sources. */
const MAX_CHECKS = 8;

/** The `html` bucket guide, read the way a best-practices scan reads it. */
async function htmlGuide(): Promise<string> {
  return await readBucketGuide(bucketGuidePath("html"), PROMPTS_DIR);
}

/** The anti-pattern checks, one entry per numbered check. */
async function antiPatternChecks(): Promise<string[]> {
  return section(await htmlGuide(), HEADING)
    .split(/\n(?=\d+\. \*\*)/)
    .filter((chunk) => /^\d+\. \*\*/.test(chunk));
}

Deno.test("html bucket - carries a short design anti-pattern list", async () => {
  const checks = await antiPatternChecks();
  assert(checks.length >= 4, `expected a real list, got ${checks.length}`);
  assert(
    checks.length <= MAX_CHECKS,
    `list must stay short (<= ${MAX_CHECKS}), got ${checks.length}`,
  );
});

Deno.test("html bucket - every anti-pattern links a canonical source", async () => {
  for (const check of await antiPatternChecks()) {
    assert(
      /<https:\/\/[^>\s]+>/.test(check),
      `check must link its source rather than restate it: ${check}`,
    );
  }
});

Deno.test("html bucket - anti-pattern checks continue the guide's numbering", async () => {
  const guide = await htmlGuide();
  const before = checkNumbersIn(withoutSection(guide, HEADING));
  const within = checkNumbersIn(section(guide, HEADING));
  assertEquals(within[0], before.length + 1);
});

Deno.test("html bucket - negative control: the list is gone without its section", async () => {
  const rest = withoutSection(await htmlGuide(), HEADING);
  assert(!rest.includes(HEADING));
});

Deno.test("coding guidelines - the always-loaded prompt does not carry the list", async () => {
  const loaded = await loadPrompt("coding_guidelines", PROMPTS_DIR);
  assert(loaded.ok, "coding_guidelines must resolve");
  assert(
    !loaded.value.includes(HEADING),
    "the anti-pattern list belongs in the html bucket, not every run",
  );
});
