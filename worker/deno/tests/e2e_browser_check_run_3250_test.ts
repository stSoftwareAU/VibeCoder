/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3250 — fleet UI PRs shipped `e2e/` browser checks the agent never
 * ran ("no Chromium"), so they failed on correct code the next run had to
 * re-diagnose. The image now bakes Chromium and exports `$CHROMIUM_PATH`
 * (also on PATH as `chromium`), but the issue and pr_feedback prompts must
 * both say in words that a browser check added or changed has to be run
 * against it before it counts as a regression guard, and must not be
 * dismissed as "missing" from `which chromium` alone.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const ISSUE_PHRASES = [
  "A browser check you did not run is not a safety net",
  "$CHROMIUM_PATH",
  "failing run with the fix reverted",
  "do not present it as the regression guard",
  "$PLAYWRIGHT_BROWSERS_PATH",
];

Deno.test("issue prompt's Error Recovery section requires running e2e checks against the baked Chromium (Issue #3250)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "Error Recovery"),
  );

  for (const phrase of ISSUE_PHRASES) {
    assert(
      text.includes(phrase),
      `Error Recovery is missing "${phrase}" from the browser-check rule: ${text}`,
    );
  }
});

const PR_FEEDBACK_PHRASES = [
  "A browser check you did not run is not a safety net",
  "run the `e2e/` script against the baked Chromium",
  "failing with the fix reverted",
  "do not present it as the regression guard",
];

Deno.test("pr_feedback prompt's Making Changes section requires running e2e checks against the baked Chromium (Issue #3250)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  for (const phrase of PR_FEEDBACK_PHRASES) {
    assert(
      text.includes(phrase),
      `Making Changes is missing "${phrase}" from the browser-check rule: ${text}`,
    );
  }
});

Deno.test("pr_feedback's browser-check rule sits between the red-run and backtracking paragraphs (Issue #3250)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  const redRun = text.indexOf("A requested red run is shown, not claimed");
  const browserCheck = text.indexOf(
    "A browser check you did not run is not a safety net",
  );
  const backtracking = text.indexOf(
    "A backtracking finding covers every regex in the module",
  );

  assert(redRun >= 0, `could not locate the red-run paragraph: ${text}`);
  assert(
    browserCheck >= 0,
    `could not locate the browser-check paragraph: ${text}`,
  );
  assert(
    backtracking >= 0,
    `could not locate the backtracking paragraph: ${text}`,
  );
  assert(
    redRun < browserCheck,
    "the browser-check paragraph must come after the red-run paragraph",
  );
  assert(
    browserCheck < backtracking,
    "the browser-check paragraph must come before the backtracking paragraph",
  );
});
