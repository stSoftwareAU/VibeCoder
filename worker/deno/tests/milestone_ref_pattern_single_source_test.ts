/**
 * The milestone ref pattern is defined once (Issue #1322 follow-up).
 *
 * `refs/heads/milestone/**` has to agree byte-for-byte between the module
 * that *writes* the ruleset (`repo_rulesets.ts`), the module that *audits*
 * one (`milestone_ruleset_check.ts`) and the hardening planner
 * (`repo_settings_harden.ts`). It was declared twice — `repo_rulesets.ts`
 * had exported it since PR #588 and PR #1322 added a second `const` with the
 * same literal in `repo_settings_harden.ts`. Two literals that must agree are
 * a drift waiting to happen: change one and the auditor stops recognising
 * the ruleset the writer creates, with nothing failing to say so.
 *
 * This scans the library source rather than comparing imported values,
 * because the defect is a *second declaration* — two constants holding equal
 * strings compare equal and would pass a value check.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import { MILESTONE_REF_PATTERN } from "../lib/repo_rulesets.ts";

/** The one module allowed to declare the pattern. */
const CANONICAL_MODULE = "repo_rulesets.ts";

/** `const NAME = "refs/heads/milestone/**"` in any of its spellings. */
const DECLARATION = /=\s*"refs\/heads\/milestone\/\*\*"/;

const LIB_DIR = new URL("../lib/", import.meta.url);

Deno.test("milestone ref pattern - declared in exactly one library module", async () => {
  const declaring: string[] = [];
  for await (const entry of Deno.readDir(LIB_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const source = await Deno.readTextFile(new URL(entry.name, LIB_DIR));
    if (DECLARATION.test(source)) declaring.push(entry.name);
  }
  assertEquals(
    declaring,
    [CANONICAL_MODULE],
    `the milestone ref pattern must be declared only in ${CANONICAL_MODULE}; ` +
      `import it rather than repeating the literal. Found in: ` +
      `${declaring.join(", ")}`,
  );
});

Deno.test("milestone ref pattern - the auditor accepts what the writer creates", () => {
  // The value half of the same invariant: whatever the writer puts in a
  // ruleset's ref_name.include must be a pattern the checker counts as
  // covering the milestone branches.
  assertEquals(MILESTONE_REF_PATTERN, "refs/heads/milestone/**");
});
