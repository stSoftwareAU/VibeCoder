/**
 * Section-scoped wording pins for the `--no-verify` ban (Issue #783),
 * split out of `no_verify_ban_test.ts` and scoped to their sections per
 * Issue #3302.
 *
 * These pin exact phrases within specific sections of the coding guidelines
 * and the two templates that cite them. This file imports `markdown_docs.ts`,
 * which spawns git — which is why these pins live here rather than in
 * `no_verify_ban_test.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("no-verify - the guidelines' Commit Safety section keeps the categorical ban (Issue #783)", async () => {
  // The ban lives in the Commit Safety section; the wording wraps, so it is
  // matched as one collapsed line within that section.
  const collapsed = flat(
    section(
      await readRepoDoc("prompts/coding_guidelines/prompt.md"),
      "Commit Safety",
    ),
  );
  assertStringIncludes(
    collapsed,
    "Bypassing either safeguard (e.g. `git commit --no-verify`, `git add -f`) " +
      "is forbidden",
    "missing from coding_guidelines' Commit Safety section",
  );
  assertStringIncludes(
    collapsed,
    "fix the allowlist via PR — do not bypass",
    "missing from coding_guidelines' Commit Safety section",
  );
});

Deno.test("no-verify - the two templates keep the rest of the reversibility bullet (Issue #783)", async () => {
  // Only `--no-verify` leaves the list: `push --force`, `rm -rf` and branch
  // deletion genuinely can be the only way forward, and keep their clause.
  // Both templates carry that bullet in their Long-Horizon Execution section.
  for (const name of ["issue", "pr_feedback"]) {
    const collapsed = flat(
      section(
        await readRepoDoc(`prompts/${name}/prompt.md`),
        "Long-Horizon Execution",
      ),
    );
    const section_ = `${name}'s Long-Horizon Execution section`;
    assertStringIncludes(
      collapsed,
      "Bound irreversible actions",
      `missing from ${section_}`,
    );
    assertStringIncludes(
      collapsed,
      "git push --force",
      `missing from ${section_}`,
    );
    assertStringIncludes(
      collapsed,
      "only way forward",
      `missing from ${section_}`,
    );
    // …and each now says why the bypass is not among them.
    assertStringIncludes(
      collapsed,
      "Bypassing the pre-commit gate is",
      `missing from ${section_}`,
    );
  }
});
