/**
 * The benchmark audit does not fire on a function name (Issue #583 follow-up).
 *
 * `validate`'s "Benchmark audit" step scans `worker/deno/tests` for
 * `Deno.test("…bench…")` and fails the build, so a performance measurement
 * cannot hide in the unit suite. The pattern matched the word anywhere in the
 * test name, including inside a camelCase identifier, so
 *
 *     Deno.test("resolveBenchmarkMode - a blank container stamp reports a
 *                host run, not a container (Issue #1493)")
 *
 * — three correctness tests naming the function under test — were reported as
 * disguised benchmarks and turned `validate` red. That merged into a
 * milestone branch, where bare `validate` is not required, and would have
 * surfaced again at the rollup with forty commits sitting on top of it.
 *
 * The obvious "fix" is to rename the tests. That is the wrong direction: a
 * test should name the function it tests, and a gate should not make names
 * worse to stay quiet. A word boundary keeps every real violation.
 *
 * The pattern is asserted here rather than in the workflow because an inline
 * `deno eval` has no other test, and this repository already tests
 * `validate-scripts.yml` directly (`issue_3333_validate_scripts_pr_only_test`).
 *
 * Australian English spelling throughout (behaviour, recognises).
 */

import { assert, assertEquals } from "@std/assert";

const WORKFLOW = new URL(
  "../../../.github/workflows/validate-scripts.yml",
  import.meta.url,
);

/** The audit's live pattern, read out of the workflow it runs in. */
async function auditPattern(): Promise<RegExp> {
  const yaml = await Deno.readTextFile(WORKFLOW);
  const line = yaml
    .split("\n")
    .find((l) => l.includes("const benchmarkPattern = /"));
  assert(line, "the benchmark audit's pattern is no longer where it was");
  const body = line.slice(line.indexOf("/") + 1, line.lastIndexOf("/i"));
  return new RegExp(body, "i");
}

Deno.test("audit pattern - a camelCase function name is not flagged", async () => {
  const pattern = await auditPattern();
  // The three real test names from `benchmark_test.ts` that turned it red.
  for (
    const name of [
      "resolveBenchmarkMode - a blank container stamp reports a host run, not a container (Issue #1493)",
      "resolveBenchmarkMode - a real container stamp still reports a container run (Issue #1493)",
      "resolveBenchmarkMode - --mode and VIBE_RUN_MODE still win over the stamp (Issue #1493)",
    ]
  ) {
    assertEquals(
      pattern.test(`Deno.test("${name}", () => {`),
      false,
      `a correctness test naming its function is not a benchmark: ${name}`,
    );
  }
});

Deno.test("audit pattern - a disguised perf test is still caught", async () => {
  const pattern = await auditPattern();
  // The direction that matters: the gate must keep doing its job. Asserted
  // beside the exemption above so narrowing one cannot silently widen it.
  for (
    const name of [
      "benchmark: startup completes in under 5ms",
      "the benchmark loop measures wall time",
      "bench_harness warms up before measuring",
      "Benchmark the scan over 10k issues",
    ]
  ) {
    assertEquals(
      pattern.test(`Deno.test("${name}", () => {`),
      true,
      `this must still fail the build: ${name}`,
    );
  }
});
