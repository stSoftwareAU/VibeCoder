/**
 * One rule about documentation-drift tests (Issue #2429).
 *
 * Two surfaces banned outright a pattern this repository depends on:
 *
 *   - `CODING-STANDARDS.md` rule 5 — do not "check documentation for
 *     keywords", "these are not real tests";
 *   - `test_audit` check 2 — "Flag every grep-as-assertion you find", with no
 *     carve-out.
 *
 * Meanwhile the tree ships a `worker/deno/tests/*_docs_test.ts` suite for every
 * documented promise the code cannot hold as a value, and CI depends on them:
 * they are the only guard on a documented rule, switch name or rendered line
 * drifting away from the code that produces it. So every new trial or protocol
 * page re-litigated the same question and every new suite argued its own
 * exemption in a file header — most recently `rtk_output_trial_docs_test.ts`
 * (Issue #2387), which a standards review recorded as a violation that stands.
 *
 * The narrow rule that reconciles both surfaces is what the test pins: a rule
 * the source cannot hold is documentation drift; a string the source does hold
 * is a grep. These cases pin that rule on both surfaces, pin the conditions the
 * carve-out attaches to it, and pin the mechanism it names.
 *
 * The suite dogfoods its own rule: every assertion below is scoped to a named
 * section with `section()` rather than run over a whole file.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const PROMPTS_DIR = `${REPO_ROOT}prompts`;
const TESTS_DIR = `${REPO_ROOT}worker/deno/tests`;

/** The helper module the carve-out names, relative to `tests/`. */
const SUPPORT = "support/markdown_docs.ts";

/** The one-line rule both surfaces now state. */
const RULE = /a rule the source cannot hold is documentation drift/i;

/** The text of one prompt family, collapsed for matching. */
async function promptCollapsed(family: string): Promise<string> {
  const loaded = await loadPrompt(family, PROMPTS_DIR);
  assertEquals(loaded.ok, true, `cannot load ${family}`);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return flat(loaded.value);
}

/** The `## Test-Driven Development (TDD)` section of the standards. */
async function tddSection(): Promise<string> {
  return section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test-Driven Development",
  );
}

Deno.test("documentation drift - both surfaces state the same rule (Issue #2429)", async () => {
  const audit = await promptCollapsed("test_audit");
  const standards = flat(await tddSection());

  for (
    const [name, text] of [
      ["test_audit", audit],
      ["CODING-STANDARDS.md", standards],
    ] as const
  ) {
    assert(
      RULE.test(text),
      `${name} does not state what separates a documentation-drift test from ` +
        `a source grep — that distinction is the whole policy`,
    );
  }
});

Deno.test("documentation drift - the standards carve the pattern out instead of banning it (Issue #2429)", async () => {
  const tdd = await tddSection();
  // The numbered rules, before the first `###` subsection.
  const rules = flat(tdd.split("\n### ")[0] ?? "");

  assertEquals(
    rules.includes("check documentation for keywords"),
    false,
    "rule 5 still bans outright the pattern the *_docs_test.ts suites are",
  );
  // The real defect is still banned, so the carve-out did not widen into one.
  assertStringIncludes(rules, "grep source files for patterns");

  const carveOut = flat(section(tdd, "Documentation-drift tests"));
  // Section-scoped, through the shared helper that masks fenced code.
  assertStringIncludes(carveOut, "Section-scoped");
  assertStringIncludes(carveOut, SUPPORT);
  // …pinning a promise no module holds …
  assertStringIncludes(carveOut, "the code cannot express");
  // …and never retyping a value that one does.
  assertStringIncludes(carveOut, "imported from the live module");
  // The filesystem-derived species is named as needing no exemption.
  assertStringIncludes(carveOut, "bucket_docs_test.ts");
});

Deno.test("documentation drift - the auditor exempts the pattern it still flags in source (Issue #2429)", async () => {
  const collapsed = await promptCollapsed("test_audit");
  // It still flags the real defect …
  assertStringIncludes(collapsed, "grep-as-assertion");
  // … and now says a documentation-drift test is not one.
  assertStringIncludes(
    collapsed,
    "Documentation-drift tests are not a finding",
  );
  // Not the helper by path: `test_audit` is filed into other repositories, so
  // its body may not cite a VibeCoder-internal path (the cross-repo body
  // guard). It describes the shape instead.
  assertEquals(
    collapsed.includes(SUPPORT),
    false,
    "test_audit cites a VibeCoder-internal path, which the cross-repo body " +
      "guard forbids — describe the shape instead",
  );
  assertEquals(
    collapsed.includes("Flag every grep-as-assertion you find."),
    false,
    "test_audit still flags every grep-as-assertion without exception",
  );
});

Deno.test("documentation drift - the pattern the carve-out protects is real (Issue #2429)", async () => {
  // The carve-out is only worth having while the suites it protects exist and
  // use the mechanism it names.
  const support = await Deno.readTextFile(`${TESTS_DIR}/${SUPPORT}`);
  for (const exported of ["readRepoDoc", "section"]) {
    assertStringIncludes(support, `export function ${exported}`);
  }

  const docsSuites: string[] = [];
  const callers: string[] = [];
  for await (const entry of Deno.readDir(TESTS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith("_test.ts")) continue;
    if (entry.name.endsWith("_docs_test.ts")) docsSuites.push(entry.name);
    const text = await Deno.readTextFile(`${TESTS_DIR}/${entry.name}`);
    if (text.includes(`./${SUPPORT}`)) callers.push(entry.name);
  }
  assert(
    docsSuites.length > 0,
    "no documentation-drift suite remains — the carve-out exempts nothing",
  );
  assert(
    callers.length > 0,
    "no test imports the helper the carve-out was written for",
  );
});

Deno.test("documentation drift - the scoping helper the carve-out names does the scoping (Issue #2429)", () => {
  // Condition 1 is only worth stating while `section()` really narrows: a
  // whole-file `includes` passes on a page that moved the rule elsewhere.
  const page = [
    "## First",
    "before",
    "",
    "## Target",
    "the promise the code cannot hold",
    "",
    "```bash",
    "# Not a heading — a comment inside a fence",
    "```",
    "",
    "still inside Target",
    "",
    "## After",
    "after",
  ].join("\n");

  const body = section(page, "Target");
  assertStringIncludes(body, "the promise the code cannot hold");
  // The fenced `#` comment does not end the section …
  assertStringIncludes(body, "still inside Target");
  // … and the next real heading does.
  assertEquals(body.includes("after"), false);
  assertEquals(body.includes("before"), false);

  // A renamed heading fails loudly rather than asserting against "".
  assertThrows(
    () => section(page, "Renamed"),
    Error,
    "Renamed",
  );
});
