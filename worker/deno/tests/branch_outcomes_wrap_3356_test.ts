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

// Real wrap: docs/archive/pr-summaries/pr-summary-1823.md:185-187, with only the
// verb substituted ("evaluates `Deno.env.get`" -> "reaches the fallback arm") so
// the admission "no test reaches" is split at the real break point.
const WRAP_1823_ADMISSION =
  "  a test inheriting host state — cannot occur: `deps.quarantineHours`\n" +
  "  short-circuits the read and every test names its own window, so no test\n" +
  "  reaches the fallback arm.\n";

Deno.test("a key phrase split at a real wrap after `none added.` is still an admission (Issue #3356)", () => {
  const result = run(
    "## Test Plan\n\n**Branch outcomes:** none added.\n\n" +
      WRAP_1823_ADMISSION,
  );
  assertEquals(result.valid, false);
  assert(result.unreachedEntries.length > 0);
});

Deno.test("a key phrase split at a real wrap after a list is still an admission (Issue #3356)", () => {
  const result = run(
    "## Test Plan\n\n**Branch outcomes:**\n" + ENTRY + "\n" +
      WRAP_1823_ADMISSION,
  );
  assertEquals(result.valid, false);
});

// Verbatim: docs/archive/pr-summaries/pr-summary-1823.md:185-187.
Deno.test("the original 1823 wrap (no test evaluates ...) is not an admission (Issue #3356)", () => {
  const result = run(
    "## Test Plan\n\n**Branch outcomes:** none added.\n\n" +
      "  a test inheriting host state — cannot occur: `deps.quarantineHours`\n" +
      "  short-circuits the read and every test names its own window, so no test\n" +
      "  evaluates `Deno.env.get`.\n",
  );
  assertEquals(result.valid, true);
});

// Verbatim: docs/archive/pr-summaries/pr-summary-1579.md:154-156.
Deno.test("the 1579 wrap (no test was removed or weakened) is not an admission (Issue #3356)", () => {
  const result = run(
    "## Test Plan\n\n**Branch outcomes:** none added.\n\n" +
      "Modified (business-logic change — routing input moved from job name to failed\n" +
      "step, so these stubs now serve the Actions job behind each check run; no test\n" +
      "was removed or weakened):\n",
  );
  assertEquals(result.valid, true);
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
