/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3735 — a failure reason that quotes text the worker did not write must
 * open with a worker-written marker registered in WORKER_GATE_MARKERS, or a
 * quoted `rate limit`, `timeout` or `Error:` picks the category. The bullet in
 * "Never Fail Silently" of CODING-STANDARDS.md, its restatement in the
 * coding_guidelines prompt, and rule 5 of "Writing a gate over text" must carry
 * the rule. The behaviour is pinned by worker_gate_markers_3735_test.ts.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("CODING-STANDARDS.md Never Fail Silently carries the registered-marker bullet (Issue #3735)", async () => {
  assertPins(
    section(await readRepoDoc("CODING-STANDARDS.md"), "Never Fail Silently"),
    [
      "A failure reason that quotes text the worker did not write opens with a registered worker marker",
      "registered with its own category in `WORKER_GATE_MARKERS`",
      "the label-release sweeps skip any worker gate record (`isWorkerGateFailureRecord`)",
      "A new gate refusal is one registry entry, which each reader above then sees with no edit of its own.",
      "`worker/deno/tests/worker_gate_markers_3735_test.ts`",
    ],
  );
});

Deno.test("the coding_guidelines prompt restates the registered-marker rule in Never Fail Silently (Issue #3735)", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/coding_guidelines/prompt.md"),
      "Never Fail Silently",
    ),
    [
      "A recorded failure reason that quotes text the worker did not write opens with a worker-written marker.",
      "every classifier of that reason checks before its free-text rules (a `startsWith` on the reason itself, or a test of the category derived from it)",
      "so a quoted `rate limit`, `timeout` or `Error:` cannot pick the category",
      "register the marker in `WORKER_GATE_MARKERS` in `worker/deno/lib/failure_diagnosis.ts`",
    ],
  );
});

Deno.test("rule 5 of Writing a gate over text points at the marker registry (Issue #3735)", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Writing a gate over text",
    ),
    ["one of the gate-refusal prefixes registered in `WORKER_GATE_MARKERS`"],
  );
});
