/**
 * Unit tests for the PR-summary docs-sweep gate (Issue #3073).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildDocsSweepGateComment,
  codeChangingFiles,
  isDocsSweepExemptPath,
  parseDocsSweepLine,
  validateDocsSweep,
} from "../lib/docs_sweep_gate.ts";
import { assertLinearGrowth } from "./support/growth.ts";

// ---------------------------------------------------------------------------
// isDocsSweepExemptPath / codeChangingFiles
// ---------------------------------------------------------------------------

Deno.test("isDocsSweepExemptPath - test files are exempt", () => {
  assert(isDocsSweepExemptPath("worker/deno/tests/foo_test.ts"));
  assert(isDocsSweepExemptPath("web/src/foo.test.tsx"));
});

Deno.test("isDocsSweepExemptPath - documentation files are exempt", () => {
  assert(isDocsSweepExemptPath("README.md"));
});

Deno.test("isDocsSweepExemptPath - a docs/ path segment is exempt regardless of extension", () => {
  assert(isDocsSweepExemptPath("docs/guide.png"));
  assert(isDocsSweepExemptPath("crates/x/docs/a.txt"));
});

Deno.test("isDocsSweepExemptPath - code paths are not exempt", () => {
  assertEquals(isDocsSweepExemptPath("web/src/BrokerBalance.tsx"), false);
  assertEquals(isDocsSweepExemptPath("crates/report/src/decisions.rs"), false);
  assertEquals(isDocsSweepExemptPath(".github/workflows/ci.yml"), false);
});

Deno.test("isDocsSweepExemptPath - empty or whitespace path is exempt", () => {
  assert(isDocsSweepExemptPath(""));
  assert(isDocsSweepExemptPath("   "));
});

Deno.test("codeChangingFiles - filters out test and doc paths", () => {
  const files = [
    "worker/deno/tests/foo_test.ts",
    "README.md",
    "docs/guide.md",
    "web/src/BrokerBalance.tsx",
    "crates/report/src/decisions.rs",
  ];
  assertEquals(codeChangingFiles(files), [
    "web/src/BrokerBalance.tsx",
    "crates/report/src/decisions.rs",
  ]);
});

// ---------------------------------------------------------------------------
// parseDocsSweepLine
// ---------------------------------------------------------------------------

Deno.test("parseDocsSweepLine - plain line with section parses", () => {
  const line = parseDocsSweepLine(
    "**Docs sweep** — grep: `retryLimit`; section: `docs/workflows/retries.md#retry-limit`; no hits",
  );
  assert(line.present);
  assertEquals(line.section, "docs/workflows/retries.md#retry-limit");
});

Deno.test("parseDocsSweepLine - list-item decorated variant parses", () => {
  const line = parseDocsSweepLine(
    "- **Docs sweep** — grep: `x`; section: `docs/x.md#y`; no hits",
  );
  assert(line.present);
  assertEquals(line.section, "docs/x.md#y");
});

Deno.test("parseDocsSweepLine - bold-colon variant parses", () => {
  const line = parseDocsSweepLine(
    "**Docs sweep:** grep: `x`; section: `docs/x.md#y`; no hits",
  );
  assert(line.present);
  assertEquals(line.section, "docs/x.md#y");
});

Deno.test("parseDocsSweepLine - a mid-prose mention does not count", () => {
  const line = parseDocsSweepLine(
    "We did the docs sweep already in a previous PR, no need to repeat it here.",
  );
  assertEquals(line.present, false);
});

Deno.test("parseDocsSweepLine - absent line reports not present", () => {
  const line = parseDocsSweepLine("## Summary\n\nFixed the thing.\n");
  assertEquals(line.present, false);
  assertEquals(line.section, "");
});

Deno.test("parseDocsSweepLine - line with no section field reports empty section", () => {
  const line = parseDocsSweepLine("**Docs sweep** — grep: `x`; no hits");
  assert(line.present);
  assertEquals(line.section, "");
});

Deno.test("parseDocsSweepLine - section on a wrapped continuation line parses", () => {
  const line = parseDocsSweepLine(
    '**Docs sweep** — grep: "A stub mirrors the real callee\'s contract", "stub\n' +
      'must mirror"; section: `docs/workflows/issue-processing.md#stubs`; updated: docs/workflows/issue-processing.md',
  );
  assert(line.present);
  assertEquals(line.section, "docs/workflows/issue-processing.md#stubs");
});

Deno.test("parseDocsSweepLine - indented list continuation still carries section", () => {
  const line = parseDocsSweepLine(
    "- **Docs sweep** — grep: `stub`\n" +
      "  must mirror; section: `docs/workflows/issue-processing.md#stubs`; updated: docs/workflows/issue-processing.md",
  );
  assert(line.present);
  assertEquals(line.section, "docs/workflows/issue-processing.md#stubs");
});

Deno.test("parseDocsSweepLine - a blank line ends the entry", () => {
  const line = parseDocsSweepLine(
    "**Docs sweep** — grep: `x`; no hits\n\nsection: `docs/x.md#y`",
  );
  assert(line.present);
  assertEquals(line.section, "");
});

Deno.test("parseDocsSweepLine - a later list item is not part of the entry", () => {
  const line = parseDocsSweepLine(
    "- **Docs sweep** — grep: `x`\n- section: `docs/x.md#y`",
  );
  assert(line.present);
  assertEquals(line.section, "");
});

Deno.test("parseDocsSweepLine - a heading ends the entry", () => {
  const line = parseDocsSweepLine(
    "**Docs sweep** — grep: `x`\n## Evidence\nsection: `docs/x.md#y`",
  );
  assert(line.present);
  assertEquals(line.section, "");
});

// ---------------------------------------------------------------------------
// validateDocsSweep
// ---------------------------------------------------------------------------

const CODE_FILES = [
  "web/src/BrokerBalance.tsx",
  "crates/report/src/decisions.rs",
];
const DOC_FILES = [
  "README.md",
  "docs/guide.md",
  "worker/deno/tests/foo_test.ts",
];

Deno.test("validateDocsSweep - docs-only diff is not applicable", () => {
  const result = validateDocsSweep({
    changedFiles: DOC_FILES,
    prSummaryContent: "## Summary\n\nFixed the docs.\n",
  });
  assertEquals(result.applicable, false);
  assertEquals(result.valid, true);
});

Deno.test("validateDocsSweep - code diff with no line is rejected", () => {
  const result = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent: "## Summary\n\nFixed the thing.\n",
  });
  assertEquals(result.applicable, true);
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "Docs sweep");
});

Deno.test("validateDocsSweep - code diff with a line but no section is rejected", () => {
  const result = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent: "**Docs sweep** — grep: `x`; no hits",
  });
  assertEquals(result.applicable, true);
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "section");
});

Deno.test("validateDocsSweep - a wrapped plain entry with section on the next line is accepted", () => {
  const result = validateDocsSweep({
    changedFiles: ["worker/deno/lib/x.ts"],
    prSummaryContent:
      '**Docs sweep** — grep: "A stub mirrors the real callee\'s contract", "stub\n' +
      'must mirror"; section: `docs/workflows/issue-processing.md#stubs`; updated: docs/workflows/issue-processing.md; siblings: none — no existing set gained a member',
  });
  assertEquals(result.valid, true);
  assertEquals(result.line.section, "docs/workflows/issue-processing.md#stubs");
});

Deno.test("validateDocsSweep - a wrapped list item with section on the continuation is accepted", () => {
  const result = validateDocsSweep({
    changedFiles: ["worker/deno/lib/x.ts"],
    prSummaryContent: "- **Docs sweep** — grep: `stub`\n" +
      "  must mirror; section: `docs/workflows/issue-processing.md#stubs`; updated: docs/workflows/issue-processing.md; siblings: none — no existing set gained a member",
  });
  assertEquals(result.valid, true);
  assertEquals(result.line.section, "docs/workflows/issue-processing.md#stubs");
});

Deno.test("validateDocsSweep - a bare 'section: none' is rejected", () => {
  const result = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent: "**Docs sweep** — grep: `x`; section: none; no hits",
  });
  assertEquals(result.valid, false);
  assertStringIncludes(result.problems[0]!, "placeholder");
});

Deno.test("validateDocsSweep - 'section: none — <reason>' is accepted", () => {
  const result = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent:
      "**Docs sweep** — grep: `x`; section: none — no manual documents this flag; siblings: none — no existing set gained a member; no hits",
  });
  assertEquals(result.valid, true, result.problems.join("; "));
});

Deno.test(
  "validateDocsSweep - rejects a code-changing summary without the line and accepts `no hits` with a named section",
  () => {
    const rejected = validateDocsSweep({
      changedFiles: CODE_FILES,
      prSummaryContent: "## Summary\n\nNo docs sweep line here.\n",
    });
    assertEquals(rejected.valid, false);
    assertStringIncludes(rejected.problems[0]!, "Docs sweep");

    const accepted = validateDocsSweep({
      changedFiles: CODE_FILES,
      prSummaryContent:
        "**Docs sweep** — grep: `retryLimit`; section: `docs/workflows/retries.md#retry-limit`; siblings: none — no existing set gained a member; no hits",
    });
    assertEquals(accepted.valid, true, accepted.problems.join("; "));
  },
);

Deno.test("validateDocsSweep - changedFiles null is applicable and rejected without a line", () => {
  const result = validateDocsSweep({
    changedFiles: null,
    prSummaryContent: "## Summary\n\nFixed the thing.\n",
  });
  assertEquals(result.applicable, true);
  assertEquals(result.valid, false);
  assertEquals(result.changedFilesKnown, false);
  assertEquals(result.codeFiles, []);
});

Deno.test("validateDocsSweep - changedFiles null is accepted with a valid line", () => {
  const result = validateDocsSweep({
    changedFiles: null,
    prSummaryContent:
      "**Docs sweep** — grep: `x`; section: `docs/x.md#y`; siblings: none — no existing set gained a member; no hits",
  });
  assertEquals(result.applicable, true);
  assertEquals(result.valid, true, result.problems.join("; "));
});

Deno.test("validateDocsSweep - names up to 5 code files then 'and N more'", () => {
  const files = [
    "a.ts",
    "b.ts",
    "c.ts",
    "d.ts",
    "e.ts",
    "f.ts",
    "g.ts",
  ];
  const result = validateDocsSweep({
    changedFiles: files,
    prSummaryContent: "## Summary\n\nNo line.\n",
  });
  assertStringIncludes(result.problems[0]!, "a.ts");
  assertStringIncludes(result.problems[0]!, "and 2 more");
});

// ---------------------------------------------------------------------------
// buildDocsSweepGateComment
// ---------------------------------------------------------------------------

Deno.test("buildDocsSweepGateComment - contains the problems and the section shape", () => {
  const result = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent: "## Summary\n\nNo docs sweep line.\n",
  });
  const comment = buildDocsSweepGateComment(result);
  assertStringIncludes(comment, result.problems[0]!);
  assertStringIncludes(comment, "section:");
  assertStringIncludes(comment, "Docs sweep");
});

// ---------------------------------------------------------------------------
// The siblings: part (Issue #3371)
// ---------------------------------------------------------------------------

const SIBLINGS_LINE =
  "**Docs sweep** — grep: `x`; section: `docs/x.md#y`; no hits";

Deno.test("parseDocsSweepLine - reads siblings from a wrapped continuation line", () => {
  const line = parseDocsSweepLine(
    "**Docs sweep** — grep: `x`; section: `docs/x.md#y`; siblings: `Foo::get`,\n" +
      '  "Foo::set"; updated: docs/x.md',
  );
  assert(line.present);
  assertEquals(line.siblings, 'Foo::get, "Foo::set"');
});

Deno.test("validateDocsSweep - a line with no siblings: is refused, and accepted once an explained none is added", () => {
  const refused = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent: SIBLINGS_LINE,
  });
  assertEquals(refused.valid, false);
  assertEquals(refused.problems.length, 1);
  assertStringIncludes(refused.problems[0]!, "names no `siblings:`");

  const accepted = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent: SIBLINGS_LINE +
      "; siblings: none — no existing set gained a member",
  });
  assertEquals(accepted.valid, true, accepted.problems.join("; "));
});

Deno.test("validateDocsSweep - a bare siblings: placeholder is refused, with only the placeholder problem", () => {
  for (const placeholder of ["none", "tbd", "n/a."]) {
    const result = validateDocsSweep({
      changedFiles: CODE_FILES,
      prSummaryContent: SIBLINGS_LINE + `; siblings: ${placeholder}`,
    });
    assertEquals(result.valid, false, placeholder);
    assertEquals(result.problems.length, 1, placeholder);
    assertStringIncludes(
      result.problems[0]!,
      "`siblings:` is a bare placeholder",
    );
  }
});

Deno.test("validateDocsSweep - a none negative for siblings: is accepted with backticks, straight or curly quotes", () => {
  for (
    const negative of [
      "`none` — no existing set gained a member",
      '"none" — no existing set gained a member',
      "“none” — no existing set gained a member",
    ]
  ) {
    const result = validateDocsSweep({
      changedFiles: CODE_FILES,
      prSummaryContent: SIBLINGS_LINE + `; siblings: ${negative}`,
    });
    assertEquals(
      result.valid,
      true,
      `${negative}: ${result.problems.join("; ")}`,
    );
  }
});

Deno.test("validateDocsSweep - a quote-wrapped bare none for siblings: is refused as a bare placeholder", () => {
  for (const placeholder of ['"none"', "“none”"]) {
    const result = validateDocsSweep({
      changedFiles: CODE_FILES,
      prSummaryContent: SIBLINGS_LINE + `; siblings: ${placeholder}`,
    });
    assertEquals(result.valid, false, placeholder);
    assertEquals(result.problems.length, 1, placeholder);
    assertStringIncludes(
      result.problems[0]!,
      "`siblings:` is a bare placeholder",
    );
  }
});

Deno.test("validateDocsSweep - a siblings: value that quotes no term is refused, and accepted once terms are quoted", () => {
  const refused = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent: SIBLINGS_LINE + "; siblings: max_buy_price, buy ceiling",
  });
  assertEquals(refused.valid, false);
  assertEquals(refused.problems.length, 1);
  assertStringIncludes(refused.problems[0]!, "`siblings:` quotes no term");

  const accepted = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent: SIBLINGS_LINE +
      '; siblings: `max_buy_price`, "buy ceiling" (`OWNER_TUNED`)',
  });
  assertEquals(accepted.valid, true, accepted.problems.join("; "));
});

Deno.test("validateDocsSweep - a line with neither section nor siblings reports both problems, section first", () => {
  const refused = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent: "**Docs sweep** — grep: `x`; no hits",
  });
  assertEquals(refused.valid, false);
  assertEquals(refused.problems.length, 2);
  assertStringIncludes(refused.problems[0]!, "names no `section:`");
  assertStringIncludes(refused.problems[1]!, "names no `siblings:`");

  const fixed = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent:
      "**Docs sweep** — grep: `x`; section: `docs/x.md#y`; siblings: none — no existing set gained a member; no hits",
  });
  assertEquals(fixed.valid, true, fixed.problems.join("; "));
});

Deno.test("validateDocsSweep - a siblings label with no colon and a long space run is read quickly and refused", () => {
  const hostile = "**Docs sweep** — grep: `x`; section: none — r; siblings" +
    " ".repeat(3_500) + "x";
  const result = validateDocsSweep({
    changedFiles: CODE_FILES,
    prSummaryContent: hostile,
  });
  assertEquals(result.line.present, true);
  assertEquals(result.problems.length, 1);
  assertStringIncludes(result.problems[0]!, "names no `siblings:`");
});

Deno.test("buildDocsSweepGateComment - each example Docs sweep line it shows passes the gate", () => {
  const comment = buildDocsSweepGateComment(
    validateDocsSweep({
      changedFiles: CODE_FILES,
      prSummaryContent: "## Summary\n\nNo docs sweep line.\n",
    }),
  );
  const examples = comment.split("\n").filter((l) =>
    l.startsWith("**Docs sweep**")
  );
  assertEquals(examples.length, 2);
  for (const example of examples) {
    const result = validateDocsSweep({
      changedFiles: CODE_FILES,
      prSummaryContent: example,
    });
    assertEquals(result.applicable, true);
    assertEquals(
      result.valid,
      true,
      `${example}: ${result.problems.join("; ")}`,
    );
  }
});

// ---------------------------------------------------------------------------
// isBarePlaceholder growth (Issue #3085 review) — driven indirectly through
// validateDocsSweep's `section:` field, since the helper is module-private.
// ---------------------------------------------------------------------------

Deno.test(
  "validateDocsSweep - a bare placeholder with a long trailing-decoration run scales linearly",
  () => {
    // A run of `.` that does NOT reach the end of the value is the shape
    // that makes `/[.!\s]+$/` backtrack. A trailing `x` is outside the
    // decoration class, so without the 64-character cap the scan is
    // quadratic and the value is no longer read as a placeholder. With the
    // cap the slice still ends in `.`, so it stays a bare placeholder and
    // both sizes cost about the same.
    const buildSummary = (chars: number) =>
      `**Docs sweep** — section: none${".".repeat(chars)}x`;

    const result = assertLinearGrowth(
      "docs-sweep bare-placeholder trailing-decoration scan",
      buildSummary,
      (input) =>
        validateDocsSweep({
          changedFiles: CODE_FILES,
          prSummaryContent: input,
        }),
      { baseChars: 20_000 },
    );

    assertEquals(
      result.valid,
      false,
      "still a bare placeholder, not an explained negative",
    );
    assertStringIncludes(result.problems[0]!, "placeholder");
  },
);

Deno.test(
  "validateDocsSweep - a Docs sweep line with a long space run before a lone CR scales linearly",
  () => {
    // `"Docs sweep:" + spaces + "\\rX\\rY"` used to be one line, because the
    // split kept a lone CR. `.+` cannot match CR and `$` only matches at the
    // end, so the old line regex retried from every space. Splitting on
    // every line terminator and taking the body by slice stays linear, and
    // the empty body after the separator is still not a Docs sweep line.
    const buildSummary = (chars: number) =>
      `Docs sweep:${" ".repeat(chars)}\rX\rY`;

    const result = assertLinearGrowth(
      "docs-sweep line match",
      buildSummary,
      (input) =>
        validateDocsSweep({
          changedFiles: CODE_FILES,
          prSummaryContent: input,
        }),
      { baseChars: 20_000 },
    );

    assertEquals(result.line.present, false);
    assertEquals(result.valid, false);
  },
);
