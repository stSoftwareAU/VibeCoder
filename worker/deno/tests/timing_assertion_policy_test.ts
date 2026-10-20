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
 * Issue #3680: fleet PRs kept adding wall-clock ratio tests to target
 * repositories whose own standards forbid timing, because the coding
 * guidelines called ratio tests permitted. Those tests flaked under load. The
 * target repository's own testing standard now wins on timing; the guidelines
 * name the output-then-work-count forms and treat a ratio only as a last
 * resort; `test_audit` flags a ratio unless the repository's standard allows
 * it. The ratio carve-out, with `assertLinearGrowth`, now lives only in
 * CODING-STANDARDS.md as this repository's last resort, because the guidelines
 * are injected into other repositories and must not name a VibeCoder-only
 * helper.
 *
 * Issue #3897: the regex hostile-case rules in coding guidelines and
 * pr_feedback say a hostile case asserts output or counted work, never a
 * wall-clock ratio where the target repository keeps timing out of unit tests,
 * and name no VibeCoder-only helper.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  assertPins,
  DocSection,
  excerpt,
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

/** The ratio helper this repository's own standard allows as a last resort. */
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
const SECURITY_SCAN_SECTION = {
  doc: "prompts/security_scan/prompt.md",
  title: "For each surviving finding",
} as const;

/** The wording every surface shares for "the target repository wins". */
const TARGET_WINS =
  "The target repository's own testing standard wins on timing";

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

Deno.test("timing policy - every surface says the target repository's own standard wins (Issue #3680)", async () => {
  const guidelines = await timingSection(
    GUIDELINES_SECTION.doc,
    GUIDELINES_SECTION.title,
  );
  const standards = await timingSection(
    STANDARDS_SECTION.doc,
    STANDARDS_SECTION.title,
  );
  const audit = await timingSection(AUDIT_SECTION.doc, AUDIT_SECTION.title);
  assertStringIncludes(
    guidelines,
    TARGET_WINS,
    "coding_guidelines does not defer to the target repository's standard",
  );
  assertStringIncludes(
    standards,
    TARGET_WINS,
    "CODING-STANDARDS.md does not defer to the target repository's standard",
  );
  assertStringIncludes(
    audit,
    "explicitly allows ratio tests",
    "test_audit does not stay silent only where the repository allows ratios",
  );
});

Deno.test("timing policy - the guidelines no longer ban measuring outright (Issue #786)", async () => {
  // The absence check below covers the whole file on purpose: the flat ban
  // must not survive anywhere in coding_guidelines, not just outside this
  // section.
  const whole = await readRepoDoc(GUIDELINES_SECTION.doc);
  assertEquals(
    phraseAnywhere(whole, "Do not measure performance inside unit tests"),
    false,
    "coding_guidelines still carries the flat ban, which forbids the ratio " +
      "assertions CODING-STANDARDS.md allows as a last resort",
  );
});

Deno.test("timing policy - the guidelines no longer call ratio tests permitted and name no VibeCoder-only helper (Issue #3680)", async () => {
  // Whole-file absence on purpose: the guidelines are injected into other
  // repositories, so the retired carve-out and the VibeCoder-only helper must
  // not survive anywhere in coding_guidelines.
  const whole = await readRepoDoc(GUIDELINES_SECTION.doc);
  for (
    const phrase of [
      "Ratio timing assertions are the exception",
      "they are permitted",
      "assertLinearGrowth",
      "tests/support/growth.ts",
      "Issue #530",
    ]
  ) {
    assertEquals(
      phraseAnywhere(whole, phrase),
      false,
      `coding_guidelines still carries "${phrase}"`,
    );
  }
  assertPins(section(whole, GUIDELINES_SECTION.title), [
    "count **deterministic work**",
    "benchmark harness",
    "last resort",
    "Cite only what exists in the repository you are working",
  ]);
});

Deno.test("timing policy - the auditor flags ratio assertions unless the repository allows them (Issues #786, #3680)", async () => {
  const body = section(
    await readRepoDoc(AUDIT_SECTION.doc),
    AUDIT_SECTION.title,
  );
  const collapsed = flat(body);
  // It still flags the real defect …
  assertStringIncludes(collapsed, "Absolute");
  assertStringIncludes(collapsed, "against a constant as a finding");
  // … and says a ratio is a timing assertion too, silent only where the
  // repository's own standard explicitly allows ratio tests.
  assertPins(body, [
    "A ratio of two readings is a timing assertion too",
    "Stay silent on a ratio only where the repository's own testing standard explicitly allows ratio tests",
  ]);
  // Not the helper by name: `test_audit` is filed into other repositories, so
  // its body may not cite a VibeCoder-internal path (the cross-repo body
  // guard). It describes the shape instead.
  assertStringIncludes(collapsed, "times the same work at two input sizes");
  // The absence checks below cover the whole file on purpose: the unqualified
  // ban and the old blanket exemption must not survive anywhere in test_audit,
  // not just outside this section.
  const whole = await readRepoDoc(AUDIT_SECTION.doc);
  assertEquals(
    phraseAnywhere(whole, "Flag any wall-clock comparison inside a unit test"),
    false,
    "test_audit still flags every comparison without exception",
  );
  assertEquals(
    phraseAnywhere(whole, "Ratio assertions are not a finding"),
    false,
    "test_audit still exempts every ratio assertion without the repository's standard",
  );
});

Deno.test("timing policy - CODING-STANDARDS keeps the ratio only as this repository's last resort (Issue #3680)", async () => {
  const standards = await timingSection(
    STANDARDS_SECTION.doc,
    STANDARDS_SECTION.title,
  );
  assertStringIncludes(
    standards,
    "this repository allows a ratio as a last resort",
  );
  // Whole-file absence: the unqualified permission must not survive anywhere
  // in CODING-STANDARDS.md, not just inside the Unit tests section.
  const whole = await readRepoDoc(STANDARDS_SECTION.doc);
  assertEquals(
    phraseAnywhere(whole, "A ratio assertion is permitted"),
    false,
    "CODING-STANDARDS.md still permits a ratio assertion outright",
  );
});

Deno.test("timing policy - security_scan never prescribes a wall-clock ratio regression test (Issue #3680)", async () => {
  const body = section(
    await readRepoDoc(SECURITY_SCAN_SECTION.doc),
    SECURITY_SCAN_SECTION.title,
  );
  assertPins(body, [
    "A suggested regression test never times the work",
    "never a wall-clock ratio test",
    "only after confirming it exists in the scanned repository",
  ]);
});

Deno.test("timing policy - the helper the carve-out names still exists and is used (Issue #786)", async () => {
  // The carve-out now lives in CODING-STANDARDS.md only (Issue #3680), as this
  // repository's last resort. It is only worth keeping while the pattern it
  // protects is real, so the helper must still exist and still have callers.
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

/**
 * The slice of `text` from the first `start` to the earliest following `ends`
 * marker (or the end of `text`), `start` included. Stays a `DocSection`, so
 * `assertPins` and `flat` still accept it.
 */
function slice(text: DocSection, start: string, ends: string[]): DocSection {
  const from = text.indexOf(start);
  assert(from >= 0, `could not locate "${start}" in the section`);
  const after = from + start.length;
  const stops = ends
    .map((end) => text.indexOf(end, after))
    .filter((index) => index >= 0);
  const to = stops.length > 0 ? Math.min(...stops) : text.length;
  return excerpt(text, from, to);
}

/**
 * Tokens the regex-hostile-case rules must never name: VibeCoder-only helpers,
 * paths and issue numbers. The guidelines and pr_feedback prompts are injected
 * into other repositories, where none of these is a precedent.
 */
const FORBIDDEN: readonly string[] = [
  "assertLinearGrowth",
  "tests/support/growth.ts",
  "Issue #530",
  "stSoftwareAU/VibeCoder#",
];

/** Citations the guidelines bullet alone carried, checked on top of `FORBIDDEN`. */
const GUIDELINES_ONLY_FORBIDDEN: readonly string[] = [
  "(Issue #3186)",
  "(Issue #3164)",
];

/** The tokens of `tokens` that `text` contains, once whitespace is collapsed. */
function forbiddenIn(text: string, tokens: readonly string[]): string[] {
  const collapsed = flatWholeFile(text);
  return tokens.filter((token) => collapsed.includes(token));
}

Deno.test("timing policy - regex hostile-case rules assert output or counted work, not a wall-clock ratio (Issue #3897)", async () => {
  const guidelines = section(
    await readRepoDoc(GUIDELINES_SECTION.doc),
    GUIDELINES_SECTION.title,
  );
  const guidelinesBullet = slice(
    guidelines,
    "- **Vet every regex on untrusted text",
    ["\n- ", "\n\n"],
  );
  assertPins(guidelinesBullet, [
    "asserts the pattern's result on an input long enough that catastrophic backtracking never returns",
    "guard super-linear cost by output, then by counted work, as the timing bullets above say",
    "It is not a wall-clock ratio where the repository's own testing standard keeps timing out of unit tests",
  ]);

  const prFeedback = section(
    await readRepoDoc("prompts/pr_feedback/prompt.md"),
    "Making Changes",
  );
  const prFeedbackParagraph = slice(
    prFeedback,
    "**A backtracking finding covers every regex in the module.**",
    ["\n\n"],
  );
  assertPins(prFeedbackParagraph, [
    "never a wall-clock ratio where the repository's own standard keeps timing out of unit tests",
    "See **Vet every regex on untrusted text** in the guidelines",
  ]);

  assertEquals(
    forbiddenIn(guidelinesBullet, [
      ...FORBIDDEN,
      ...GUIDELINES_ONLY_FORBIDDEN,
    ]),
    [],
    "coding_guidelines bullet names a VibeCoder-only helper, precedent or issue number the guidelines must not cite",
  );
  assertEquals(
    forbiddenIn(prFeedbackParagraph, FORBIDDEN),
    [],
    "pr_feedback paragraph names a VibeCoder-only helper, precedent or issue number the guidelines must not cite",
  );
});

Deno.test("timing policy - the absence check reports each forbidden token it is fed and no clean text (Issue #3897)", () => {
  // Each fixture carries one forbidden token; the check must report exactly it.
  const fixtures: [string, string][] = [
    ["assertLinearGrowth", "Time it with assertLinearGrowth against 4N."],
    ["tests/support/growth.ts", "The helper lives in tests/support/growth.ts."],
    ["Issue #530", "Carried over from Issue #530 last quarter."],
    [
      "stSoftwareAU/VibeCoder#",
      "Capped in stSoftwareAU/VibeCoder#3085 last cycle.",
    ],
  ];
  for (const [token, fixture] of fixtures) {
    assert(
      FORBIDDEN.includes(token),
      `"${token}" is missing from the forbidden list`,
    );
    assertEquals(
      forbiddenIn(fixture, FORBIDDEN),
      [token],
      `the absence check missed "${token}"`,
    );
  }

  const guidelinesOnly: [string, string][] = [
    ["(Issue #3186)", "The remedy is named in (Issue #3186) above."],
    ["(Issue #3164)", "The hostile cases are in (Issue #3164) above."],
  ];
  for (const [token, fixture] of guidelinesOnly) {
    assert(
      GUIDELINES_ONLY_FORBIDDEN.includes(token),
      `"${token}" is missing from the guidelines-only list`,
    );
    assertEquals(
      forbiddenIn(fixture, GUIDELINES_ONLY_FORBIDDEN),
      [token],
      `the absence check missed "${token}"`,
    );
  }

  assertEquals(
    forbiddenIn(
      "Cite only what exists in the repository you are working; this names nothing from elsewhere.",
      [...FORBIDDEN, ...GUIDELINES_ONLY_FORBIDDEN],
    ),
    [],
    "the absence check reported a token in clean text",
  );
});
