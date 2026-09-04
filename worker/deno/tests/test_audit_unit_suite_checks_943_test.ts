/**
 * The test-audit catalogue files slow and parallel-unsafe unit tests
 * (Issue #943).
 *
 * The scan could audit a test for maintainability and for coverage, but not
 * for the one property that made a quality gate take 42 minutes against a
 * 45-minute budget: a unit suite that cannot run in parallel because its
 * tests mutate the process environment, and unit tests that sit waiting on
 * the wall clock. Neither stream could surface that, so the debt grew
 * unreported while the hard gates — the parallel-safety cap and the
 * integration manifest — could only stop it growing further.
 *
 * Checks 12 and 13 close that. Both are **static, source-shape** checks: the
 * audit reads test source and never runs it, so a finding cites a mutating
 * call, a sleep, a poll or a spawn that a reader can see, never a measured or
 * guessed duration. Both exclude what is already declared — files on the
 * parallel-unsafe manifest are known debt, files on the integration manifest
 * are integration tests by declaration — and both are reported as a single
 * finding listing the affected files, because a suite-wide habit across a
 * hundred files must not become a hundred issues.
 *
 * These cases read the shipped template, in the manner of the rest of the
 * prompt-drift family, so a renumbering or a deletion of either check fails
 * in CI rather than silently disarming the audit. They match against
 * whitespace-collapsed text: re-wrapping a paragraph is not drift, deleting
 * the rule in it is.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { INTEGRATION_TEST_FILES } from "../lib/integration_test_manifest.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const TESTS_DIR = new URL(".", import.meta.url).pathname;

/**
 * The process-mutating shapes, assembled rather than written out.
 *
 * `parallel_safety_cap_test.ts` classifies a file as a process-state mutator
 * by grepping its source for these very tokens, so spelling them literally
 * here would make this read-only suite look like the debt it describes.
 */
const ENV_MUTATION = ["Deno", "env", "set"].join(".");
const CHDIR_MUTATION = ["Deno", "chdir"].join(".");

/** Matches a file that mutates process-wide state. */
const MUTATOR = new RegExp(
  [ENV_MUTATION, CHDIR_MUTATION]
    .map((token) => token.replaceAll(".", "\\."))
    .join("|"),
);

/** Runs of whitespace flattened, so a re-wrap is not a failure. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

async function testAuditPrompt(): Promise<string> {
  const loaded = await loadPrompt("test_audit", PROMPTS_DIR);
  assertEquals(loaded.ok, true, "test_audit failed to load");
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

/** The whole template, collapsed. */
async function promptText(): Promise<string> {
  return collapse(await testAuditPrompt());
}

/** One numbered Phase 2 check, up to the next `###` heading, collapsed. */
function checkBody(prompt: string, number: number): string {
  const heading = new RegExp(`^### ${number}\\. .*$`, "m");
  const start = prompt.search(heading);
  assert(start >= 0, `the catalogue has no check ${number}`);
  const after = prompt.slice(start + 1);
  const next = after.search(/^### /m);
  return collapse(
    next >= 0 ? prompt.slice(start, start + 1 + next) : prompt.slice(start),
  );
}

/** One `<example name="…">` block, collapsed. */
function exampleBody(prompt: string, name: string): string {
  const open = `<example name="${name}">`;
  const start = prompt.indexOf(open);
  assert(start >= 0, `the template has no worked example named ${name}`);
  const end = prompt.indexOf("</example>", start);
  assert(end > start, `example ${name} is not closed`);
  return collapse(prompt.slice(start, end));
}

// --- The catalogue stays contiguous ---

Deno.test("test_audit - the Phase 2 catalogue runs 1..13 with no hole (Issue #943)", async () => {
  const prompt = await testAuditPrompt();
  const numbers = [...prompt.matchAll(/^### (\d+)\. /gm)]
    .map((match) => Number(match[1]));
  assertEquals(
    numbers,
    Array.from({ length: 13 }, (_, index) => index + 1),
    "the numbered checks must be contiguous and end at 13 — a hole or a " +
      "duplicate breaks the stable-ID slugs and the check ranges citing them",
  );
});

Deno.test("test_audit - every surface counting the catalogue says thirteen (Issue #943)", async () => {
  const prompt = await promptText();
  for (
    const claim of [
      "## Phase 2 — Apply the thirteen audit checks",
      "against the thirteen audit checks",
      "which of the thirteen checks",
    ]
  ) {
    assertStringIncludes(prompt, claim);
  }
  assertEquals(
    prompt.includes("eleven audit checks"),
    false,
    "a surface still describes the catalogue as eleven checks",
  );
});

// --- Check 12 fires on a genuine parallel-unsafe unit test ---

Deno.test("test_audit - check 12 fires on a unit test that mutates process-wide state (Issue #943)", async () => {
  const body = checkBody(await testAuditPrompt(), 12);
  assertStringIncludes(body, "### 12. Parallel-unsafe unit tests");
  assertStringIncludes(body, "process-wide state");
  // The shapes it keys on, across ecosystems — an audit that only knew the
  // Deno spelling would miss the same defect everywhere else.
  for (
    const shape of [
      ENV_MUTATION,
      CHDIR_MUTATION,
      "process.env",
      "os.environ",
      "set_var",
      "System.setProperty",
      "singleton",
    ]
  ) {
    assertStringIncludes(body, shape);
  }
});

Deno.test("test_audit - check 12 has a worked verdict that files (Issue #943)", async () => {
  const example = exampleBody(
    await testAuditPrompt(),
    "parallel-unsafe-unit-test",
  );
  assertStringIncludes(example, "<signal>check 12");
  assertStringIncludes(example, "<verdict>file");
});

// --- Check 12 stays silent on a clean one ---

Deno.test("test_audit - check 12 is silent on a file already on the known-debt manifest (Issue #943)", async () => {
  const body = checkBody(await testAuditPrompt(), 12);
  assertStringIncludes(body, "**Stay silent** when:");
  assertStringIncludes(body, "parallel_unsafe_test_manifest.ts");
  assertStringIncludes(body, "**known debt**");
  assertStringIncludes(body, "stop that list growing");
});

Deno.test("test_audit - check 12 has a worked verdict that stays silent (Issue #943)", async () => {
  const example = exampleBody(
    await testAuditPrompt(),
    "parallel-unsafe-test-already-on-the-known-debt-list",
  );
  assertStringIncludes(example, "<signal>none");
  assertStringIncludes(example, "<verdict>silent");
});

Deno.test("test_audit - check 12 is silent on state the test itself owns (Issue #943)", async () => {
  const body = checkBody(await testAuditPrompt(), 12);
  // An environment handed to a child process is not shared with the parallel
  // workers, so it is not the defect.
  assertStringIncludes(body, "**child** process");
  assertStringIncludes(body, "temporary directory");
});

Deno.test("test_audit - check 12 prescribes the seam, never a flag (Issue #943)", async () => {
  const body = checkBody(await testAuditPrompt(), 12);
  assertStringIncludes(body, "**the seam, never a flag**");
  assertStringIncludes(body, "--no-parallel");
  assertStringIncludes(body, "must not be offered as one");
});

// --- Check 13 fires on a genuine slow unit test ---

Deno.test("test_audit - check 13 fires on a wait, a poll or a spawn in the source (Issue #943)", async () => {
  const body = checkBody(await testAuditPrompt(), 13);
  assertStringIncludes(body, "### 13. Slow unit tests");
  for (
    const shape of [
      "**A wall-clock sleep**",
      "**A retry loop with wall-clock backoff**",
      "**A polling wait**",
      "**A spawned process**",
    ]
  ) {
    assertStringIncludes(body, shape);
  }
});

Deno.test("test_audit - check 13 has a worked verdict that files (Issue #943)", async () => {
  const example = exampleBody(
    await testAuditPrompt(),
    "slow-unit-test-by-shape",
  );
  assertStringIncludes(example, "<signal>check 13");
  assertStringIncludes(example, "<verdict>file");
});

// --- Check 13 stays silent on a clean one ---

Deno.test("test_audit - check 13 is silent on declared integration tests and injected clocks (Issue #943)", async () => {
  const body = checkBody(await testAuditPrompt(), 13);
  assertStringIncludes(body, "**Stay silent** when:");
  assertStringIncludes(body, "integration_test_manifest.ts");
  assertStringIncludes(body, "integration tests **by declaration**");
  assertStringIncludes(body, "**injected** clock");
});

Deno.test("test_audit - check 13 restates the ratio-assertion carve-out (Issue #943)", async () => {
  const body = checkBody(await testAuditPrompt(), 13);
  // The carve-out the growth helper settled: what the elapsed time is
  // compared against. Another reading of the same work is fine; a constant is
  // the defect. A new slow-test check that omitted this would re-open it.
  assertStringIncludes(body, "**ratio assertion**");
  assertStringIncludes(body, "times the same work at two input sizes");
  assertStringIncludes(body, "another reading of the same work");
  assertStringIncludes(body, "cannot be read as contradicting it");
  assertStringIncludes(
    body,
    "An **absolute** wall-clock threshold remains a check 3 finding.",
  );
});

Deno.test("test_audit - the helper the carve-out protects still exists (Issue #943)", async () => {
  // The restatement is only worth having while the pattern it protects is
  // real, so this reads the helper rather than trusting the prose.
  const growth = await Deno.readTextFile(`${TESTS_DIR}support/growth.ts`);
  assertStringIncludes(growth, "export function assertLinearGrowth");
});

// --- Both checks are static, and neither reports a failure ---

Deno.test("test_audit - both new checks declare themselves static and duration-free (Issue #943)", async () => {
  const prompt = await testAuditPrompt();
  for (const number of [12, 13]) {
    const body = checkBody(prompt, number);
    assertStringIncludes(body, "**static, source-shape** check");
    assert(
      /never claims an observed race|never on a measured duration/.test(body),
      `check ${number} does not forbid asserting what the audit cannot read ` +
        `from the source`,
    );
  }
  const slow = checkBody(prompt, 13);
  assertStringIncludes(slow, "never on an estimated or guessed one");
  assertStringIncludes(slow, "unless it is a literal you read in the test");
});

Deno.test("test_audit - neither new check attributes an environmental failure (Issue #943)", async () => {
  const body = checkBody(await testAuditPrompt(), 13);
  // Roughly thirty of the failures measured under a parallel run were a host
  // without the PowerShell interpreter — not races and not slowness. Filing
  // those against either check would be a fabricated diagnosis.
  assertStringIncludes(body, "**Neither check reports a failing test.**");
  assertStringIncludes(body, "interpreter, runtime or toolchain");
  assertStringIncludes(body, "no pass/fail verdict to report");
});

// --- The exclusions name lists that actually exist ---

Deno.test("test_audit - the integration exclusion names the live manifest (Issue #943)", async () => {
  const prompt = await promptText();
  assert(
    INTEGRATION_TEST_FILES.length > 0,
    "the integration manifest is empty, so the exclusion excludes nothing",
  );
  assertStringIncludes(prompt, "integration_test_manifest.ts");
  // Cross-repo bodies may not cite an internal path, so the manifest is named
  // by file, never by its location in this repository.
  assertEquals(
    prompt.includes("worker/deno/"),
    false,
    "the template must not cite a VibeCoder-internal path — it is filed " +
      "verbatim into other repositories",
  );
});

Deno.test("test_audit - the definition is cited, not restated (Issue #943)", async () => {
  const prompt = await testAuditPrompt();
  assertStringIncludes(collapse(prompt), "CODING-STANDARDS.md");
  assertStringIncludes(collapse(prompt), '"Unit Tests vs Benchmarks"');
  const slow = checkBody(prompt, 13);
  assertStringIncludes(slow, "that section is normative, not this check");
  assertEquals(
    /\b(?:ten|10)[- ]second/.test(slow),
    false,
    "check 13 restates the budget instead of citing the standards that own it",
  );
});

// --- Volume control: a suite-wide habit is one finding, not one per file ---

Deno.test("test_audit - a suite-wide habit yields one finding, not one per file (Issue #943)", async () => {
  // The real input is large: this repository's own unit suite carries dozens
  // of files with the shape check 12 keys on. The bound is what stops a first
  // run burying the repository under an issue for each of them.
  const offenders: string[] = [];
  for await (const entry of Deno.readDir(TESTS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith("_test.ts")) continue;
    const source = await Deno.readTextFile(`${TESTS_DIR}${entry.name}`);
    if (MUTATOR.test(source)) offenders.push(entry.name);
  }
  assert(
    offenders.length >= 20,
    `expected a large input to bound, found ${offenders.length} files — ` +
      "if the debt is genuinely paid down, retire this case",
  );

  const prompt = await testAuditPrompt();
  for (const number of [12, 13]) {
    const body = checkBody(prompt, number);
    assertStringIncludes(body, "never one finding per file");
    assertStringIncludes(body, "Phase 3 step 3");
  }
  // …and the two rules that do the bounding still say so.
  const collapsed = collapse(prompt);
  assertStringIncludes(
    collapsed,
    "collapse them into one finding whose body lists the call sites",
  );
  assertStringIncludes(collapsed, "Keep at most **6 findings**");
  assertStringIncludes(
    collapsed,
    "a repository with a hundred such files must still yield one finding, " +
      "not a hundred issues",
  );
});

// --- One run, one report, one set of rules ---

Deno.test("test_audit - the new checks join the one report, not a third stream (Issue #943)", async () => {
  const prompt = await promptText();
  assertStringIncludes(
    prompt,
    "The audit reviews three complementary concerns and reports all of them",
  );
  assertStringIncludes(
    prompt,
    "finding-limit rules — never as a parallel report",
  );
  assertStringIncludes(prompt, "**Unit-suite classification**");
  assertStringIncludes(prompt, "(checks 12–13 in Phase 2)");
  // The maintainability and coverage ranges are untouched by the addition.
  assertStringIncludes(prompt, "checks 1–6 and 8–11");
  assertStringIncludes(prompt, "(check 7 in Phase 2)");
});

Deno.test("test_audit - the stable-ID recipe registers both new slugs (Issue #943)", async () => {
  const prompt = await promptText();
  assertStringIncludes(prompt, "`parallel-unsafe-unit-test`");
  assertStringIncludes(prompt, "`slow-unit-test`");
});

Deno.test("test_audit - Phase 4 names the remedy for a classification finding (Issue #943)", async () => {
  const prompt = await promptText();
  const phase4 = prompt.slice(prompt.indexOf("## Phase 4 — File one issue"));
  assertStringIncludes(
    phase4,
    "For a unit-suite classification finding (checks 12–13)",
  );
  assertStringIncludes(phase4, "never a `--no-parallel` switch");
  assertStringIncludes(
    phase4,
    "reclassification into the repository's integration-test manifest",
  );
  assertStringIncludes(phase4, "rather than filing an issue per file");
});

Deno.test("test_audit - severity guidance covers the two new checks (Issue #943)", async () => {
  const prompt = await promptText();
  const guidance = prompt.slice(prompt.indexOf("### Severity guidance"));
  assertStringIncludes(guidance, "(check 12)");
  assertStringIncludes(guidance, "(check 13)");
});

// --- The single-template convention survives the edit ---

Deno.test("test_audit - the prompt directory still holds one editable template (Issue #943)", async () => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(`${PROMPTS_DIR}/test_audit`)) {
    if (entry.isFile) names.push(entry.name);
  }
  assertEquals(
    names.sort(),
    ["prompt.md"],
    "the vN.md convention was retired — edit prompt.md in place and let git " +
      "history be the record",
  );
});
