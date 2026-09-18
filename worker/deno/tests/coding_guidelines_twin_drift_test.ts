/**
 * Issue #793: `CODING-STANDARDS.md` and the injected
 * `prompts/coding_guidelines/` template are declared twins, and had drifted
 * in two ways.
 *
 * 1. **TDD.** The standards claimed both surfaces carry test-first TDD "in
 *    every run in every repository", but the guidelines template has zero
 *    occurrences of TDD. Test-first actually rides the `issue` and
 *    `pr_feedback` phase prompts, so phases that receive only the injected
 *    block (`spelling_fix`, `ci_fix`, `merge_conflict`, `workflow_setup`)
 *    never saw the rule the standards promised them.
 * 2. **Coverage strength.** The identical rule over the identical scope was
 *    "should" in the standards and "MUST" in the guidelines — advisory to a
 *    human reader, blocking to the agent.
 *
 * The fix corrected the standards on both counts. This test pins the pair so
 * the next drift fails here. It reads whatever guidelines version resolves,
 * so a new version that changes either rule is caught.
 *
 * Issue #1166 added a third drift to the pin: the **unit-test speed budget**.
 * The standards said 10 seconds, the injected guidelines said 120 (plus a
 * `BATS_TEST_TIMEOUT` knob for a suite this repository no longer has, and a
 * third figure of 30 in its own next bullet), and `CONTRIBUTING.md` said 120
 * as well. The prompt is filed verbatim into other repositories, so the wrong
 * figure was not merely present but distributed. All three surfaces now state
 * one budget, and say it is a target enforced by shape rather than a
 * stopwatch — the cases below fail the moment any of them disagrees again.
 *
 * Issue #2322 added a fourth: the **smallest-change-first ladder**, its
 * never-cut floor and the `// SIMPLE-ON-PURPOSE:` corner-cut marker, all hung
 * under the `**KISS**` bullet. A ladder rung, a floor item or the marker
 * stated on one surface and not the other is drift, so both surfaces are read
 * and compared rung by rung, in order — an unordered ladder is not a ladder.
 *
 * Modelled on `hidden_allowlist_drift_test.ts` (Issue #784).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Case-insensitive markers for a test-first requirement. */
const TDD_PATTERN = /TDD|test-driven|failing test/i;

const readStandards = () =>
  Deno.readTextFile(`${REPO_ROOT}CODING-STANDARDS.md`);

const readContributing = () => Deno.readTextFile(`${REPO_ROOT}CONTRIBUTING.md`);

/** The one unit-test speed budget every surface must state, in seconds. */
const BUDGET_SECONDS = 10;

/** Every "N second"/"N-second" reading in a passage, as numbers. */
function secondsIn(passage: string): number[] {
  return [...passage.matchAll(/(\d+)[ -]second/g)].map((m) => Number(m[1]));
}

/** Extract a passage, failing loudly when the surface no longer carries it. */
function passage(text: string, pattern: RegExp, what: string): string {
  const found = text.match(pattern);
  assert(found, `could not locate ${what}`);
  return found[0];
}

/** The standards' unit-test speed rule — the `**Fast**` bullet. */
const standardsBudget = (standards: string) =>
  passage(
    standards,
    /- \*\*Fast\*\*[\s\S]*?(?=\n- \*\*)/,
    "the `**Fast**` bullet in CODING-STANDARDS.md",
  );

/** The guidelines' unit-test speed rule — its whole benchmarks section. */
const guidelinesBudget = (guidelines: string) =>
  passage(
    guidelines,
    /## Unit Tests vs Benchmarks\n[\s\S]*?(?=\n## )/,
    "the 'Unit Tests vs Benchmarks' section in coding_guidelines",
  );

/** CONTRIBUTING.md's unit-test speed rule — its `**Speed budget**` bullet. */
const contributingBudget = (contributing: string) =>
  passage(
    contributing,
    /- \*\*Speed budget\*\*[\s\S]*?(?=\n\n)/,
    "the `**Speed budget**` bullet in CONTRIBUTING.md",
  );

/** The `**KISS**` bullet, which carries the ladder, floor and marker. */
const kissBullet = (text: string, surface: string) =>
  passage(
    text,
    /- \*\*KISS\*\*[\s\S]*?(?=\n- \*\*)/,
    `the \`**KISS**\` bullet in ${surface}`,
  );

/**
 * A prose phrase, matched across the line wrapping Markdown introduces — both
 * surfaces wrap at 80 columns, so a fixed-space pattern would fail on wording
 * that is present and correct.
 */
const phrase = (words: string) =>
  new RegExp(words.trim().split(/\s+/).join("\\s+"), "i");

/** The seven rungs, in the order the ladder must state them. */
const LADDER_RUNGS: readonly string[] = [
  "skip what is not needed",
  "reuse what the codebase has",
  "use the standard library",
  "use a native platform feature",
  "use a dependency already installed",
  "write one line",
  "write new code",
];

/** What a corner cut may never remove. */
const FLOOR_ITEMS: readonly string[] = [
  "input validation at a trust boundary",
  "error handling that prevents data loss",
  "security",
  "accessibility",
  "the issue explicitly asks for",
];

/** The corner-cut marker token and its two fields, in order. */
const MARKER_TOKEN = "// SIMPLE-ON-PURPOSE:";
const MARKER_FIELDS: readonly string[] = ["ceiling", "upgrade when"];

/** Assert each phrase is present, and each one after the one before it. */
function assertPhrasesInOrder(
  surface: string,
  text: string,
  what: string,
  phrases: readonly string[],
): void {
  let previous = -1;
  for (const words of phrases) {
    const found = text.search(phrase(words));
    assert(found >= 0, `${surface} has lost the ${what} "${words}": ${text}`);
    assert(
      found > previous,
      `${surface} states the ${what} "${words}" out of order: ${text}`,
    );
    previous = found;
  }
}

async function latestPromptText(name: string): Promise<string> {
  const result = await loadPrompt(name, PROMPTS_DIR);
  assert(result.ok, `${name} prompt failed to load`);
  return result.value;
}

Deno.test("twin pair - the coverage rule carries the same strength on both surfaces (Issue #793)", async () => {
  const [standards, guidelines] = await Promise.all([
    readStandards(),
    latestPromptText("coding_guidelines"),
  ]);

  // Both state the public-function coverage rule. Neither may soften it:
  // "should" here is advisory to a contributor but blocking to the agent.
  const standardsRule = standards.match(
    /Every new or modified public function[^.]*\./s,
  );
  const guidelinesRule = guidelines.match(
    /Every new or modified public function[^.:]*[.:]/s,
  );
  assert(standardsRule, "CODING-STANDARDS.md lost its public-function rule");
  assert(guidelinesRule, "coding_guidelines lost its public-function rule");

  for (
    const [surface, rule] of [
      ["CODING-STANDARDS.md", standardsRule[0]],
      ["coding_guidelines", guidelinesRule[0]],
    ] as const
  ) {
    assert(
      rule.includes("MUST"),
      `${surface} must state the coverage rule as MUST, got: ${rule}`,
    );
    assert(
      !/\bshould\b/.test(rule),
      `${surface} softens the coverage rule to "should": ${rule}`,
    );
  }
});

Deno.test("twin pair - the injected guidelines block carries no test-first rule (Issue #793)", async () => {
  const guidelines = await latestPromptText("coding_guidelines");
  assertEquals(
    TDD_PATTERN.test(guidelines),
    false,
    "coding_guidelines/prompt.md now states a test-first rule. That is " +
      "fine, but CODING-STANDARDS.md says it does not — update the claim in " +
      "the 'Language-Agnostic Standards vs Per-Language Buckets' section.",
  );
});

Deno.test("twin pair - the standards attribute TDD to the phases that actually carry it (Issue #793)", async () => {
  const standards = await readStandards();

  // The corrected claim names issue and pr_feedback as the carriers.
  assert(
    /Test-first TDD is \*\*not\*\* in that injected block/.test(standards),
    "CODING-STANDARDS.md must state that the injected guidelines block " +
      "carries no test-first rule",
  );

  // …and that claim must be true of those prompts.
  for (const name of ["issue", "pr_feedback"]) {
    const text = await latestPromptText(name);
    assert(
      TDD_PATTERN.test(text),
      `CODING-STANDARDS.md attributes test-first TDD to the ${name} prompt, ` +
        "but that prompt states no test-first rule",
    );
  }
});

Deno.test("twin pair - the standards no longer list TDD among the injected block's rules (Issue #793)", async () => {
  const standards = await readStandards();
  const section = standards.match(
    /## Language-Agnostic Standards vs Per-Language Buckets[\s\S]*?\n## /,
  );
  assert(section, "could not locate the twin-pair section");
  const claim = section[0].match(
    /This document and the injected[^.]*\.[^.]*\./s,
  );
  assert(claim, "could not locate the twin-pair claim sentence");
  assertEquals(
    /\bTDD\b/.test(claim[0]),
    false,
    "the twin-pair claim still lists TDD among the rules both surfaces " +
      `carry, which the guidelines template does not: ${claim[0]}`,
  );
});

Deno.test("twin pair - every surface states the same unit-test speed budget (Issue #1166)", async () => {
  const [standards, guidelines, contributing] = await Promise.all([
    readStandards(),
    latestPromptText("coding_guidelines"),
    readContributing(),
  ]);

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standardsBudget(standards)],
      ["coding_guidelines", guidelinesBudget(guidelines)],
      ["CONTRIBUTING.md", contributingBudget(contributing)],
    ] as const
  ) {
    const readings = secondsIn(text);
    assert(
      readings.length > 0,
      `${surface} no longer states a unit-test speed budget at all`,
    );
    assertEquals(
      readings.filter((s) => s !== BUDGET_SECONDS),
      [],
      `${surface} states a second-hand figure alongside the agreed ` +
        `${BUDGET_SECONDS}-second budget: ${text}`,
    );
  }
});

Deno.test("twin pair - the speed budget is stated as a shape-enforced target, not a kill (Issue #1166)", async () => {
  const [standards, guidelines] = await Promise.all([
    readStandards(),
    latestPromptText("coding_guidelines"),
  ]);

  // Nothing times a unit test at run time. Each surface must say so, or the
  // budget reads as an absolute timeout an agent will try to configure.
  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standardsBudget(standards)],
      ["coding_guidelines", guidelinesBudget(guidelines)],
    ] as const
  ) {
    assert(
      /enforced by shape/.test(text),
      `${surface} states the speed budget without saying it is enforced by ` +
        `shape rather than by a run-time timeout: ${text}`,
    );
  }
});

Deno.test("twin pair - both surfaces state the same smallest-change-first ladder, in order (Issue #2322)", async () => {
  const [standards, guidelines] = await Promise.all([
    readStandards(),
    latestPromptText("coding_guidelines"),
  ]);

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", kissBullet(standards, "CODING-STANDARDS.md")],
      ["coding_guidelines", kissBullet(guidelines, "coding_guidelines")],
    ] as const
  ) {
    assert(
      /smallest-change-first ladder/i.test(text),
      `${surface} no longer names the smallest-change-first ladder: ${text}`,
    );

    // Each rung present, and each one after the rung before it: a ladder
    // whose rungs have been reordered no longer says "stop at the first
    // rung that solves the problem".
    assertPhrasesInOrder(surface, text, "ladder rung", LADDER_RUNGS);
  }
});

Deno.test("twin pair - both surfaces state the never-cut floor and the corner-cut marker (Issue #2322)", async () => {
  const [standards, guidelines] = await Promise.all([
    readStandards(),
    latestPromptText("coding_guidelines"),
  ]);

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", kissBullet(standards, "CODING-STANDARDS.md")],
      ["coding_guidelines", kissBullet(guidelines, "coding_guidelines")],
    ] as const
  ) {
    for (const item of FLOOR_ITEMS) {
      assert(
        phrase(item).test(text),
        `${surface} has lost "${item}" from the never-cut floor: ${text}`,
      );
    }

    assert(
      text.includes(MARKER_TOKEN),
      `${surface} no longer states the ${MARKER_TOKEN} corner-cut marker, ` +
        `so \`grep -r SIMPLE-ON-PURPOSE\` stops listing every cut: ${text}`,
    );

    // Both fields, ceiling first: the marker's whole value is that a reader
    // grepping it learns the limit and what lifts it, in that order.
    assertPhrasesInOrder(
      surface,
      text,
      "corner-cut marker field",
      MARKER_FIELDS,
    );
  }
});

Deno.test("twin pair - the guidelines name no timeout knob for a suite this repo dropped (Issue #1166)", async () => {
  const guidelines = await latestPromptText("coding_guidelines");
  assertEquals(
    /BATS_TEST_TIMEOUT/.test(guidelines),
    false,
    "coding_guidelines prescribes BATS_TEST_TIMEOUT, but the BATS suite was " +
      "fully migrated to Deno — the knob names no runner this repository has, " +
      "and the prompt is filed verbatim into other repositories",
  );
});
