/**
 * Issue #3613: a Standards `violation` whose cited path is reworded (for
 * example `worker/deno/lib/run callback telemetry.ts` for
 * `worker/deno/lib/run_callback_telemetry.ts`) cannot be placed against the
 * diff, so the standing-violation guard fails closed. The instructions must
 * tell the Standards reviewer and the author to cite the path exactly as
 * `git diff --name-only` prints it.
 *
 * The guard's own tests are in `standing_violation_routing_test.ts`; this test
 * pins only the instruction side: the issue prompt's "Independent Review
 * Before the PR" section.
 *
 * Uses Australian English throughout (behaviour, recognised, etc.).
 */

import { assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

/**
 * Carried by the Standards reviewer brief in the prompt. It appears nowhere
 * else in that section, so removing the sentence fails the test.
 */
const DIFF_PATH_PHRASE =
  "exactly as `git diff --name-only` prints it, in backticks, never reworded";

/**
 * Carried by the author's evidence rule in the prompt. Pinned on its own so
 * that removing that sentence fails the test too.
 */
const NO_REWORDING_PHRASE =
  "with no prose rewording (no spaces for underscores, no shortened directory)";

Deno.test("Issue #3613 - the issue prompt's review section pins the diff path as the reviewer and author must write it", async () => {
  const doc = await readRepoDoc("prompts/issue/prompt.md");
  const reviewSection = flat(
    section(doc, "Independent Review Before the PR"),
  );

  assertStringIncludes(reviewSection, DIFF_PATH_PHRASE);
  assertStringIncludes(reviewSection, NO_REWORDING_PHRASE);
});
