/**
 * Issue #2636: the front-end design anti-pattern list lives in the `html`
 * bucket, so only best-practices scans of HTML repos pay for it. Tests assert
 * structure (short, every check links its source), never wording.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  bucketGuidePath,
  readBucketGuide,
} from "../lib/idle_task_templates/best_practices_template.ts";
import { findCheckNumberingIssues } from "../lib/bucket_check_numbering.ts";
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

/** Numbered checks in `markdown`, one entry per check. */
function checksIn(markdown: string): string[] {
  return markdown
    .split(/\n(?=\d+\. \*\*)/)
    .filter((chunk) => /^\d+\. \*\*/.test(chunk));
}

/** Checks that do not link a canonical source. */
function unlinked(checks: string[]): string[] {
  return checks.filter((check) => !/<https:\/\/[^>\s]+>/.test(check));
}

/** The anti-pattern checks, one entry per numbered check. */
async function antiPatternChecks(): Promise<string[]> {
  return checksIn(section(await htmlGuide(), HEADING));
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
  assertEquals(unlinked(await antiPatternChecks()), []);
});

Deno.test("html bucket - negative control: a check without a link is caught", async () => {
  const stripped = section(await htmlGuide(), HEADING)
    .replace(/<https:\/\/[^>\s]+>/g, "");
  assert(unlinked(checksIn(stripped)).length > 0);
});

Deno.test("html bucket - anti-pattern checks keep the guide's 1..N numbering", async () => {
  assertEquals(findCheckNumberingIssues(await htmlGuide()), []);
});

Deno.test("html bucket - error path: a renamed section fails loudly", async () => {
  const rest = withoutSection(await htmlGuide(), HEADING);
  assertThrows(() => section(rest, HEADING));
});

Deno.test("coding guidelines - the always-loaded prompt does not carry the list", async () => {
  const loaded = await loadPrompt("coding_guidelines", PROMPTS_DIR);
  assert(loaded.ok, "coding_guidelines must resolve");
  assert(
    !loaded.value.includes(HEADING),
    "the anti-pattern list belongs in the html bucket, not every run",
  );
});
