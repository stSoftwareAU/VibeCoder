/**
 * Hard-wrapped prose and the branch-outcomes gate's uncaptured-line grouping
 * (Issue #3356). Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { validateBranchOutcomes } from "../lib/branch_outcomes_gate.ts";

const CHANGED = ["worker/deno/lib/foo.ts"];
const TESTS = new Set(["worker/deno/tests/a_test.ts"]);
const ENTRY =
  "- `worker/deno/lib/foo.ts:10` — success — `worker/deno/tests/a_test.ts::passes` — flipped, went red\n";

function run(prSummaryContent: string) {
  return validateBranchOutcomes({
    changedFiles: CHANGED,
    prSummaryContent,
    testsAtHead: TESTS,
  });
}

Deno.test("a key phrase split across two lines after `none added.` is still an admission (Issue #3356)", () => {
  const result = run(
    "## Test Plan\n\n**Branch outcomes:** none added.\n\n" +
      "The new guard on the retry path has no test\nreaches it yet.\n",
  );
  assertEquals(result.valid, false);
  assert(result.unreachedEntries.length > 0);
});

Deno.test("a key phrase split across two lines after a list is still an admission (Issue #3356)", () => {
  const result = run(
    "## Test Plan\n\n**Branch outcomes:**\n" + ENTRY +
      "\nThe fallback arm has no test\nreaches it.\n",
  );
  assertEquals(result.valid, false);
});

Deno.test("a deeper heading citation does not clear a weak admission on the next line (Issue #3356)", () => {
  const result = run(
    "## Test Plan\n\n**Branch outcomes:**\n" + ENTRY +
      "\n#### `worker/deno/tests/a_test.ts`\nThe error arm is untested.\n",
  );
  assertEquals(result.valid, false);
});

Deno.test("a fenced citation directly above prose does not clear its weak admission (Issue #3356)", () => {
  const result = run(
    "## Test Plan\n\n**Branch outcomes:**\n" + ENTRY +
      "\n~~~\nworker/deno/tests/a_test.ts\n~~~\nThe error arm is untested.\n",
  );
  assertEquals(result.valid, false);
});

Deno.test("a wrapped, covered entry is not mistaken for an admission (Issue #3356)", () => {
  const result = run(
    "## Test Plan\n\n**Branch outcomes:**\n" +
      "- `worker/deno/lib/foo.ts:10` — error arm — `worker/deno/tests/a_test.ts::rejects`\n" +
      "  — flipped to success, the test went\n  red\n",
  );
  assertEquals(result.valid, true);
});
