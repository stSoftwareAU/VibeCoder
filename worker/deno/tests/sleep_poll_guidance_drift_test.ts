/**
 * Section-scoped wait-command pins for the sleep-poll guidance (Issue #1954),
 * split out of `sleep_poll_guidance_1954_test.ts` per Issue #3302's scoping.
 *
 * `markdown_docs.ts` spawns git, which matches `HEAVY_RE` in
 * `worker/deno/lib/completeness_checks.ts` — importing it here, rather than in
 * `sleep_poll_guidance_1954_test.ts`, keeps that file (and its whole-tree
 * `prompts - none recommends sleep as a polling primitive` scan) in the
 * `deno task check:manifests` completeness family (Issue #1483).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert } from "@std/assert";
import { readRepoDoc, section } from "./support/markdown_docs.ts";

/** The wait commands both templates must name, and what bounds them. */
const WAIT_CONTRACT: readonly { what: string; pattern: RegExp }[] = [
  { what: "gh pr checks --watch", pattern: /gh\s+pr\s+checks[^\n]*--watch/ },
  {
    what: "gh run watch --exit-status",
    pattern: /gh\s+run\s+watch[^\n]*--exit-status/,
  },
  {
    what: "the foreground `sleep` refusal",
    pattern: /foreground\s+`?sleep`?[^.]*block/i,
  },
  {
    what: "the bound the wait runs under",
    pattern: /bounded\s+by\s+the\s+Bash\s+tool's[^.]*timeout/i,
  },
];

/** The section each template carries its wait-command contract in. */
const WAIT_CONTRACT_SECTION: Readonly<Record<string, string>> = {
  coding_guidelines: "Long-Horizon Runs",
  ci_fix: "CI Fix Mode",
};

for (const [template, title] of Object.entries(WAIT_CONTRACT_SECTION)) {
  Deno.test(`${template} - names a wait command that works in the container`, async () => {
    const text = section(
      await readRepoDoc(`prompts/${template}/prompt.md`),
      title,
    );
    for (const { what, pattern } of WAIT_CONTRACT) {
      assert(
        pattern.test(text),
        `${template}/prompt.md's "${title}" section must name ${what} ` +
          `(no match for ${pattern})`,
      );
    }
  });
}
