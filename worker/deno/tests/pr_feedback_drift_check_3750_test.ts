/**
 * Recovery-prompt wording for a documentation-only fix (Issue #3750).
 *
 * The mutation check that once shared this prompt was retired (Issue #5095);
 * this file keeps only the documentation-only closing step it always had.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertStringIncludes } from "@std/assert";
import { buildDriftRecoveryPrompt } from "../lib/pr_feedback_drift_check.ts";

Deno.test("buildDriftRecoveryPrompt - the documentation-only closing step is kept verbatim", () => {
  const prompt = buildDriftRecoveryPrompt({
    repo: "org/repo",
    prNumber: 7,
    findings: [{ file: "a.md", sentence: "Foo.", reason: "bar" }],
    mismatches: [],
    docsSweepProblems: [],
  });
  assertStringIncludes(
    prompt,
    "Change no code — this is a documentation fix only. Commit the change, referencing PR #7.",
  );
});
