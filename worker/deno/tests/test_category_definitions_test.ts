/**
 * Issue #941: the three-way test taxonomy in `CODING-STANDARDS.md` is load
 * bearing, so it may not be quietly deleted.
 *
 * The section is cited, not restated, by the scan prompts that enforce it:
 * `prompts/test_audit/` checks 12 and 13 both say that section is normative
 * and this check is not, and check 13 deliberately carries no number of
 * seconds of its own so the budget lives in one place. A later edit that
 * drops the taxonomy, the parallel-safety rule or the ten-second rule would
 * leave those prompts pointing at text that no longer exists, and nothing
 * would fail — the prompts are prose, and prose does not compile.
 *
 * These cases pin what the prompts rely on:
 *   - the section names all three categories, each under its own heading;
 *   - it states the ten-second rule and the parallel-safety rule;
 *   - it says which pass a parallel-unsafe unit test runs in, because the
 *     manifests keep 42 such files inside the unit verdict;
 *   - it states the quiet-machine rule for timed workloads, with its reason;
 *   - the Quality Gates section says a quality run is unit-only;
 *   - every repository path the section links to still exists.
 *
 * Modelled on the existing standards drift tests
 * (`coding_standards_model_agnostic_test.ts`, `timing_assertion_policy_test.ts`).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertStringIncludes } from "@std/assert";

/** tests/ → worker/deno/ → worker/ → repo root. */
function repoUrl(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

async function readRepoFile(relative: string): Promise<string> {
  return await Deno.readTextFile(repoUrl(relative));
}

const STANDARDS = "CODING-STANDARDS.md";

/** The taxonomy heading, quoted by the scan prompts that cite it. */
const HEADING = "## Unit, Integration and Benchmark Tests";

/** One `## ` section of the standards, heading excluded. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  assert(
    start >= 0,
    `${STANDARDS} no longer has a "${heading}" section. The test-audit ` +
      "prompt cites it by name for checks 12 and 13 — rename it there too, " +
      "or the citation dangles.",
  );
  const from = start + heading.length + 2;
  const next = text.indexOf("\n## ", from);
  return text.slice(from, next < 0 ? text.length : next);
}

async function taxonomy(): Promise<string> {
  return section(await readRepoFile(STANDARDS), HEADING);
}

/** The section with its line wrapping removed, for phrase matching. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

Deno.test("test taxonomy - the standards name all three categories (Issue #941)", async () => {
  const body = await taxonomy();
  for (
    const subheading of [
      "### Unit tests",
      "### Integration tests",
      "### Benchmarks",
    ]
  ) {
    assertStringIncludes(
      body,
      subheading,
      `the taxonomy lost its "${subheading}" definition — a contributor can ` +
        "no longer classify a test from the text alone",
    );
  }
});

Deno.test("test taxonomy - the unit definition states the ten-second rule (Issue #941)", async () => {
  const body = collapse(await taxonomy());
  assert(
    /within 10 seconds/.test(body),
    "the unit definition no longer states a time budget. `test_audit` " +
      "check 13 carries no number of its own and defers to this section, so " +
      "deleting it leaves the budget stated nowhere.",
  );
});

Deno.test("test taxonomy - the unit definition states the parallel-safety rule (Issue #941)", async () => {
  const body = collapse(await taxonomy());
  assertStringIncludes(body, "Parallel-safe");
  // The rule is decidable only if it names the mutations it forbids. The
  // needles are the distinguishing halves rather than the full calls: this
  // file is scanned by the very classifier it describes, and spelling the
  // calls out here would put it on the parallel-unsafe list it is arguing
  // nobody should join.
  for (const call of ["env.set", "chdir"]) {
    assertStringIncludes(
      body,
      call,
      `the parallel-safety rule no longer names ${call}, so it states a ` +
        "preference rather than a criterion",
    );
  }
  // …and points at the check that enforces it, whose remedy is the seam.
  assertStringIncludes(body, "parallel_safety_cap_test.ts");
  assertStringIncludes(body, "injected seam");
});

Deno.test("test taxonomy - a serially-run unit test is still a unit test (Issue #941)", async () => {
  const body = collapse(await taxonomy());
  // The manifests keep wall-clock and subprocess-timing suites inside the
  // unit verdict, running them in the gate's second pass. Prose that reads
  // "not parallel-safe means not a unit test" would contradict the code and
  // push 42 behavioural suites out of the suite that runs on every change.
  assertStringIncludes(
    body,
    "A unit test that cannot run in parallel is still a unit test",
  );
  assertStringIncludes(body, "serial pass");
});

Deno.test("test taxonomy - the integration definition names its criterion and its prerequisites (Issue #941)", async () => {
  const body = collapse(await taxonomy());
  // The criterion the classifier actually applies: a repository script,
  // driven rather than merely read.
  assertStringIncludes(body, "isIntegrationTestSource");
  assertStringIncludes(body, "INTEGRATION_TEST_FILES");
  for (const extension of [".sh", ".ps1"]) {
    assertStringIncludes(body, extension);
  }
  // What such a test is allowed to need, and where it runs instead.
  assertStringIncludes(body, "excluded from every quality run");
  assertStringIncludes(body, "deno task test:integration");
  assert(
    /pwsh|PowerShell/.test(body) && /container runtime/.test(body) &&
      /network/.test(body),
    "the integration definition no longer says what such a test may need — " +
      "a provisioned interpreter, a container runtime, the network",
  );
});

Deno.test("test taxonomy - the timed-workload definition states the quiet-machine rule with its reason (Issue #941)", async () => {
  const body = collapse(await taxonomy());
  assertStringIncludes(body, "duration, not a pass/fail assertion");
  assertStringIncludes(body, "run on demand only");
  assertStringIncludes(body, "quiet machine");
  assert(
    /makes the timings meaningless|measures the load, not the code/.test(body),
    "the quiet-machine rule is stated without its reason, which is the half " +
      "that makes it stick",
  );
});

Deno.test("test taxonomy - the surviving carve-outs did not go with the rewrite (Issue #941)", async () => {
  const body = collapse(await taxonomy());
  // Two rules the rewrite had to preserve rather than drop.
  assertStringIncludes(body, "compare two readings of the same work");
  assertStringIncludes(body, "assertLinearGrowth");
  assert(
    /reduce iteration counts/.test(body),
    "the rule against shrinking iteration counts to smuggle a performance " +
      "test into the unit suite is gone",
  );
});

Deno.test("test taxonomy - the quality gate is documented as unit-only (Issue #941)", async () => {
  const body = collapse(
    section(await readRepoFile(STANDARDS), "## Quality Gates"),
  );
  assertStringIncludes(body, "A quality run executes the unit suite only");
  assert(
    /no integration tests, no benchmarks/i.test(body),
    "the Quality Gates section no longer says which categories a quality " +
      "run leaves out",
  );
  assertStringIncludes(body, "per-PR CI");
});

Deno.test("test taxonomy - every repository path the section links to exists (Issue #941)", async () => {
  const body = await taxonomy();
  const targets = [...body.matchAll(/\]\((worker\/[^)\s]+)\)/g)]
    .map((match) => match[1]!);
  assert(
    targets.length > 0,
    "the section cites no machinery at all — the definition and the code " +
      "can now drift apart in silence",
  );
  for (const target of targets) {
    const stat = await Deno.stat(repoUrl(target)).catch(() => null);
    assert(
      stat?.isFile === true,
      `${STANDARDS} links to ${target}, which no longer exists — the ` +
        "definition now points at machinery that moved",
    );
  }
});
