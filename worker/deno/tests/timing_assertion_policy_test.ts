/**
 * One rule about timing assertions in unit tests (Issue #786).
 *
 * Three surfaces stated three different rules about the same concrete
 * pattern:
 *
 *   - `coding_guidelines` — "**Do not measure performance inside unit
 *     tests**", a flat ban;
 *   - `CODING-STANDARDS.md` — "a few tests **must** measure", mandating
 *     `assertLinearGrowth`;
 *   - `test_audit` check 3 — "flag **any** wall-clock comparison inside a unit
 *     test as a finding", with no carve-out.
 *
 * `assertLinearGrowth` times the same work at N and 4N and compares the two
 * readings, so a `test-audit` run over this repository would have filed
 * `timing-assertion` findings against the exact pattern its own standards
 * require — and the implementing run would read a guidelines block telling it
 * not to measure at all.
 *
 * The narrow rule that reconciles all three: what the elapsed time is compared
 * *against*. Another reading of the same work is fine; a constant is the
 * defect. These cases pin that rule on all three surfaces, and pin the callers
 * that depend on it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { flat, readRepoDoc, section } from "./support/markdown_docs.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

/** The ratio helper the policy exists to permit. */
const HELPER = "assertLinearGrowth";

/** The one-line rule each surface now states. */
const RULE =
  /compare two readings of the same work|another reading\s+of the same work/i;

/** The three (doc, heading) pairs each surface's timing rule lives under. */
const GUIDELINES_SECTION = {
  doc: "prompts/coding_guidelines/prompt.md",
  title: "Unit Tests vs Benchmarks",
} as const;
const AUDIT_SECTION = {
  doc: "prompts/test_audit/prompt.md",
  title: "3. Performance / timing assertions inside unit tests",
} as const;
const STANDARDS_SECTION = {
  doc: "CODING-STANDARDS.md",
  title: "Unit tests",
} as const;

/** One surface's timing-rule section, flattened so wrapped prose still matches. */
async function timingSection(doc: string, title: string): Promise<string> {
  return flat(section(await readRepoDoc(doc), title));
}

/**
 * True if `phrase` appears in `text` regardless of line wrapping: both are
 * collapsed to single-spaced whitespace before the substring check, so no
 * regex construction is needed. Used only for whole-file absence checks,
 * which must not be narrowed to one section. Avoiding `flat()` here also
 * keeps this test compatible if `flat()` later takes a `DocSection` brand
 * and refuses whole-file input (not yet: PR #3240 for Issue #3234).
 */
function phraseAnywhere(text: string, phrase: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
  return normalize(text).includes(normalize(phrase));
}

Deno.test("timing policy - all three surfaces state the same rule (Issue #786)", async () => {
  const guidelines = await timingSection(
    GUIDELINES_SECTION.doc,
    GUIDELINES_SECTION.title,
  );
  const audit = await timingSection(AUDIT_SECTION.doc, AUDIT_SECTION.title);
  const standards = await timingSection(
    STANDARDS_SECTION.doc,
    STANDARDS_SECTION.title,
  );

  for (
    const [name, text] of [
      ["coding_guidelines", guidelines],
      ["test_audit", audit],
      ["CODING-STANDARDS.md", standards],
    ] as const
  ) {
    assert(
      RULE.test(text),
      `${name} does not state what an elapsed time may be compared against — ` +
        `that distinction is the whole policy`,
    );
  }
});

Deno.test("timing policy - the guidelines no longer ban measuring outright (Issue #786)", async () => {
  const collapsed = await timingSection(
    GUIDELINES_SECTION.doc,
    GUIDELINES_SECTION.title,
  );
  // The absence check below covers the whole file on purpose: the flat ban
  // must not survive anywhere in coding_guidelines, not just outside this
  // section.
  const whole = await readRepoDoc(GUIDELINES_SECTION.doc);
  assertEquals(
    phraseAnywhere(whole, "Do not measure performance inside unit tests"),
    false,
    "coding_guidelines still carries the flat ban, which forbids the ratio " +
      "assertions CODING-STANDARDS.md requires",
  );
  // …and it names the helper, so a reader knows what is permitted.
  assertStringIncludes(collapsed, HELPER);
});

Deno.test("timing policy - the auditor exempts ratio assertions (Issue #786)", async () => {
  const collapsed = await timingSection(AUDIT_SECTION.doc, AUDIT_SECTION.title);
  // It still flags the real defect …
  assertStringIncludes(collapsed, "Absolute");
  assertStringIncludes(collapsed, "against a constant as a finding");
  // … and now says the growth pattern is not one.
  assertStringIncludes(collapsed, "Ratio assertions are not a finding");
  // Not the helper by name: `test_audit` is filed into other repositories, so
  // its body may not cite a VibeCoder-internal path (the cross-repo body
  // guard). It describes the shape instead.
  assertStringIncludes(collapsed, "times the same work at two input sizes");
  // The absence check below covers the whole file on purpose: the unqualified
  // ban must not survive anywhere in test_audit, not just outside this
  // section.
  const whole = await readRepoDoc(AUDIT_SECTION.doc);
  assertEquals(
    phraseAnywhere(whole, "Flag any wall-clock comparison inside a unit test"),
    false,
    "test_audit still flags every comparison without exception",
  );
});

Deno.test("timing policy - the helper the carve-out names still exists and is used (Issue #786)", async () => {
  // The carve-out is only worth having while the pattern it protects is real.
  const growth = await Deno.readTextFile(
    `${REPO_ROOT}worker/deno/tests/support/growth.ts`,
  );
  assertStringIncludes(growth, `export function ${HELPER}`);

  const callers: string[] = [];
  for await (const entry of Deno.readDir(`${REPO_ROOT}worker/deno/tests`)) {
    if (!entry.isFile || !entry.name.endsWith("_test.ts")) continue;
    const text = await Deno.readTextFile(
      `${REPO_ROOT}worker/deno/tests/${entry.name}`,
    );
    if (text.includes(`${HELPER}(`)) callers.push(entry.name);
  }
  assert(
    callers.length > 0,
    "no unit test calls the helper the carve-out was written for",
  );
});
