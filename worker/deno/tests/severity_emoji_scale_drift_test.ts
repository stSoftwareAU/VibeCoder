/**
 * Section-scoped wording pin for `orphan_deps`' severity scale (Issue #788),
 * split out of `severity_emoji_scale_test.ts` and scoped to its section per
 * Issue #3309.
 *
 * This pins the exact phrase within the `### Severity guidance` section of
 * `prompts/orphan_deps/prompt.md`. This file imports `markdown_docs.ts`,
 * which spawns git — which is why this pin lives here rather than in
 * `severity_emoji_scale_test.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("severity scale - orphan_deps states the no-critical-band rationale in its Severity guidance section (Issue #788)", async () => {
  const collapsed = flat(
    section(
      await readRepoDoc("prompts/orphan_deps/prompt.md"),
      "Severity guidance",
    ),
  );
  // The template says so itself, which is a stronger check than the absence
  // of the string — it mentions `severity:critical` deliberately, to say the
  // red belongs to the scan that does have that band.
  assertStringIncludes(
    collapsed,
    "There is **no `severity:critical`**",
    "missing from orphan_deps' Severity guidance section",
  );
});
