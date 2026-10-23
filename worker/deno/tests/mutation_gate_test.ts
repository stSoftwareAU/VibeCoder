/**
 * Unit tests for the pure half of the diff-scoped mutation gate (Issue #3393).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { assertLinearGrowth } from "./support/growth.ts";
import {
  buildMutationGateComment,
  evaluateMutationGate,
  generateDenoMutants,
  generateDenoMutantsDetailed,
  generateShellMutantsDetailed,
  hasShellShebang,
  isShellScriptPath,
  isShellTestFile,
  type MutationCheckResult,
  parseAddedLines,
  parseMutationExemptions,
} from "../lib/mutation_gate.ts";

// ---------------------------------------------------------------------------
// parseAddedLines
// ---------------------------------------------------------------------------

Deno.test("parseAddedLines - multiple files and hunk offsets", () => {
  const diff = [
    "diff --git a/lib/a.ts b/lib/a.ts",
    "--- a/lib/a.ts",
    "+++ b/lib/a.ts",
    "@@ -1,3 +1,4 @@",
    " keep",
    "+added at two",
    " keep",
    " keep",
    "@@ -10,2 +11,3 @@",
    " ctx",
    "-removed",
    "+added at twelve",
    "+added at thirteen",
    "diff --git a/lib/b.ts b/lib/b.ts",
    "--- a/lib/b.ts",
    "+++ b/lib/b.ts",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two",
  ].join("\n");
  const out = parseAddedLines(diff);
  assertEquals(out.get("lib/a.ts"), [2, 12, 13]);
  assertEquals(out.get("lib/b.ts"), [1, 2]);
});

Deno.test("parseAddedLines - deleted files are skipped", () => {
  const diff = [
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-a",
    "-b",
  ].join("\n");
  assertEquals(parseAddedLines(diff).size, 0);
});

Deno.test("parseAddedLines - no-newline marker does not shift line numbers", () => {
  const diff = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,2 @@",
    " first",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  assertEquals(parseAddedLines(diff).get("x.ts"), [2]);
});

Deno.test("parseAddedLines - added line starting with ++ is content, not a header", () => {
  const diff = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1 +1,2 @@",
    " a",
    "+++ b/not-a-header",
  ].join("\n");
  const out = parseAddedLines(diff);
  assertEquals([...out.keys()], ["x.ts"]);
  assertEquals(out.get("x.ts"), [2]);
});

// ---------------------------------------------------------------------------
// generateDenoMutants
// ---------------------------------------------------------------------------

function mutate(source: string, lines: number[], cap = 40) {
  return generateDenoMutants("lib/m.ts", source, lines, cap);
}

Deno.test("generateDenoMutants - negates a single-line if", () => {
  const [m, ...rest] = mutate("  if (a && b) {\n  }\n", [1]);
  assertEquals(rest.length, 0);
  assertEquals(m?.description, "negated if condition");
  assertEquals(m?.mutatedSource, "  if (!(a && b)) {\n  }\n");
});

Deno.test("generateDenoMutants - skips an if whose parens do not balance on the line", () => {
  assertEquals(mutate("if (a &&\n  b) {\n}\n", [1]), []);
});

Deno.test("generateDenoMutants - negates a simple ternary condition", () => {
  const [m] = mutate("const x = ok ? 1 : 2;\n", [1]);
  assertEquals(m?.description, "negated ternary condition");
  assertEquals(m?.mutatedSource, "const x = !(ok) ? 1 : 2;\n");
});

Deno.test("generateDenoMutants - a ternary mutant negates the whole condition, not its last operand", () => {
  const cases: Array<[string, string]> = [
    ["const x = a === b ? 1 : 2;", "const x = !(a === b) ? 1 : 2;"],
    ["return a && b.c() ? 1 : 2;", "return !(a && b.c()) ? 1 : 2;"],
    ["foo(a === b ? 1 : 2);", "foo(!(a === b) ? 1 : 2);"],
    ["const l = [a === b ? 1 : 2];", "const l = [!(a === b) ? 1 : 2];"],
    ["f(x, a < b ? 1 : 2);", "f(x, !(a < b) ? 1 : 2);"],
    ["const o = { k: n >= 3 ? 1 : 2 };", "const o = { k: !(n >= 3) ? 1 : 2 };"],
    [
      'const x: T = s === "a ? b" ? 1 : 2;',
      'const x: T = !(s === "a ? b") ? 1 : 2;',
    ],
    [
      "const g = (v) => v?.a ?? b ? 1 : 2;",
      "const g = (v) => !(v?.a ?? b) ? 1 : 2;",
    ],
  ];
  for (const [line, expected] of cases) {
    const m = mutate(`${line}\n`, [1]).find((x) =>
      x.description === "negated ternary condition"
    );
    assertEquals(m?.mutatedSource, `${expected}\n`, line);
  }
});

Deno.test("generateDenoMutants - a ternary after a statement keyword is not negated into unparseable code", () => {
  // The condition scan runs to the start of the line; negating what it finds
  // there (`if (cached) return fresh`) would not parse.
  for (
    const line of [
      "  if (cached) return fresh ? value : stale;",
      "} else return a ? 1 : 2;",
      "export default a ? b : c;",
    ]
  ) {
    const ternary = mutate(`${line}\n`, [1]).filter((x) =>
      x.description === "negated ternary condition"
    );
    assertEquals(ternary, [], line);
  }
  // A keyword inside brackets, or a plain `return`, still mutates.
  const kept = mutate("const x = items.some((i) => { return i; }) ? 1 : 2;\n", [
    1,
  ]).find((x) => x.description === "negated ternary condition");
  assertEquals(
    kept?.mutatedSource,
    "const x = !(items.some((i) => { return i; })) ? 1 : 2;\n",
  );
});

Deno.test("generateDenoMutants - swaps true and false outside strings", () => {
  const [m] = mutate('const s = "true"; const f = true;\n', [1]);
  assertEquals(m?.description, "swapped true -> false");
  assertEquals(m?.mutatedSource, 'const s = "true"; const f = false;\n');
});

Deno.test("generateDenoMutants - return value heuristics", () => {
  const cases: Array<[string, string]> = [
    ["return true;", "return false;"],
    ["return false;", "return true;"],
    ["return 7;", "return 0;"],
    ["return 0;", "return 1;"],
    ['return "abc";', 'return "";'],
    ["return compute(x);", "return undefined;"],
  ];
  for (const [src, want] of cases) {
    const ms = mutate(`  ${src}\n`, [1]).filter((m) =>
      m.description.startsWith("replaced return")
    );
    assertEquals(ms.length, 1, src);
    assertEquals(ms[0]?.mutatedSource, `  ${want}\n`, src);
  }
  assertEquals(mutate("  return;\n", [1]), []);
});

Deno.test("generateDenoMutants - deletes a whole-statement call but keeps the line count", () => {
  const src = "function f() {\n  await this.x.y(1, 2);\n  helper(a);\n}\n";
  const ms = mutate(src, [2, 3]);
  assertEquals(ms.map((m) => m.description), [
    "deleted call statement",
    "deleted call statement",
  ]);
  assertEquals(ms[0]?.mutatedSource, "function f() {\n\n  helper(a);\n}\n");
  assertEquals(
    ms[0]?.mutatedSource.split("\n").length,
    src.split("\n").length,
  );
});

Deno.test("generateDenoMutants - does not delete assignments, declarations or chained calls", () => {
  assertEquals(mutate("const x = foo();\n", [1]), []);
  assertEquals(mutate("x = foo();\n", [1]), []);
  assertEquals(mutate("foo(a)(b);\n", [1]), []);
  assertEquals(mutate("if (x) foo();\n", [1]).map((m) => m.description), [
    "negated if condition",
  ]);
});

Deno.test("generateDenoMutants - only mutates added lines", () => {
  const src = "return true;\nreturn true;\nreturn true;\n";
  const ms = mutate(src, [2]);
  assert(ms.length > 0);
  assert(ms.every((m) => m.line === 2));
});

Deno.test("generateDenoMutants - orders by line then kind", () => {
  const src = "if (a) { return true; }\nfoo();\n";
  const ms = mutate(src, [2, 1]);
  assertEquals(ms.map((m) => `${m.line}:${m.description}`), [
    "1:negated if condition",
    "1:swapped true -> false",
    "2:deleted call statement",
  ]);
});

Deno.test("generateDenoMutants - respects the cap", () => {
  const src = Array.from({ length: 10 }, () => "foo();").join("\n");
  const all = Array.from({ length: 10 }, (_, i) => i + 1);
  assertEquals(mutate(src, all, 3).length, 3);
  assertEquals(mutate(src, all, 0).length, 0);
});

Deno.test("generateDenoMutantsDetailed - counts the candidates the cap and the line limit drop", () => {
  const src = Array.from({ length: 10 }, () => "foo();").join("\n");
  const all = Array.from({ length: 10 }, (_, i) => i + 1);
  const capped = generateDenoMutantsDetailed("lib/m.ts", src, all, 3);
  assertEquals([capped.mutants.length, capped.dropped], [3, 7]);
  const none = generateDenoMutantsDetailed("lib/m.ts", src, all, 0);
  assertEquals([none.mutants.length, none.dropped], [0, 10]);
  const roomy = generateDenoMutantsDetailed("lib/m.ts", src, all, 50);
  assertEquals([roomy.mutants.length, roomy.dropped], [10, 0]);
  const long = `foo(${"a".repeat(450)});`;
  const overlong = generateDenoMutantsDetailed("lib/m.ts", `${long}\n// c\n`, [
    1,
    2,
  ], 5);
  assertEquals([overlong.mutants.length, overlong.dropped], [0, 1]);
});

Deno.test("generateDenoMutants - skips comment lines and test files", () => {
  const src = "// return true;\n/** if (a) {} */\n * return true;\n";
  assertEquals(mutate(src, [1, 2, 3]), []);
  assertEquals(
    generateDenoMutants("lib/m_test.ts", "return true;\n", [1], 5),
    [],
  );
  assertEquals(
    generateDenoMutants("lib/m.test.ts", "return true;\n", [1], 5),
    [],
  );
});

Deno.test("generateDenoMutants - skips over-long lines", () => {
  assertEquals(mutate(`return "${"a".repeat(500)}";\n`, [1]), []);
});

// ---------------------------------------------------------------------------
// Hostile inputs: one per pattern. A backtracking regex would hang here.
// ---------------------------------------------------------------------------

Deno.test("hostile - mutation generation completes on long hostile lines", () => {
  const big = 50_000;
  const shapes = [
    "if (" + "(".repeat(big),
    "return " + " ".repeat(big) + "x",
    "x = " + "a".repeat(big) + " ? ",
    "true".repeat(big),
    "  ".repeat(big) + "foo(",
    "await " + "a.".repeat(big),
    "a_test".repeat(big),
  ];
  for (const s of shapes) {
    mutate(s + "\n", [1]);
    generateDenoMutants("x".repeat(big) + "_tes.ts", "a;\n", [1], 5);
  }
});

Deno.test("hostile - diff parsing completes on long hostile lines", () => {
  const big = 50_000;
  parseAddedLines("@@ -" + "1".repeat(big) + " +");
  parseAddedLines("@@ -1 +1 @@\n" + "+".repeat(big) + "\n");
  parseAddedLines("+++ " + "b/".repeat(big) + "\n");
});

Deno.test("hostile - exemption parsing completes on long hostile lines", () => {
  const big = 50_000;
  parseMutationExemptions("a".repeat(big) + ":" + "exempt (untestable): x");
  parseMutationExemptions(
    "`" + "a:".repeat(1000) + "1` exempt (untestable): " + " ".repeat(big),
  );
  parseMutationExemptions("exempt (untestable):".repeat(big));
  parseMutationExemptions(" ".repeat(big) + "x:1 exempt (untestable): r");
});

// ---------------------------------------------------------------------------
// parseMutationExemptions
// ---------------------------------------------------------------------------

Deno.test("parseMutationExemptions - backticked and bare locations with a reason", () => {
  const summary = [
    "- `lib/a.ts:12` exempt (untestable): logging only",
    "lib/b.ts:7 EXEMPT (Untestable): wall clock",
  ].join("\n");
  assertEquals(parseMutationExemptions(summary), [
    { file: "lib/a.ts", line: 12, reason: "logging only" },
    { file: "lib/b.ts", line: 7, reason: "wall clock" },
  ]);
});

Deno.test("parseMutationExemptions - empty reason is not an exemption", () => {
  assertEquals(
    parseMutationExemptions("`lib/a.ts:12` exempt (untestable):   "),
    [],
  );
  assertEquals(
    parseMutationExemptions("`lib/a.ts:12` exempt (untestable):"),
    [],
  );
});

Deno.test("parseMutationExemptions - lines without the marker or a location are ignored", () => {
  assertEquals(parseMutationExemptions("`lib/a.ts:12` is fine"), []);
  assertEquals(parseMutationExemptions("exempt (untestable): reason only"), []);
  assertEquals(
    parseMutationExemptions("`lib/a.ts:x` exempt (untestable): r"),
    [],
  );
});

// ---------------------------------------------------------------------------
// evaluateMutationGate
// ---------------------------------------------------------------------------

const SURVIVOR = {
  file: "lib/a.ts",
  line: 12,
  description: "negated if condition",
};

function completed(survivors = [SURVIVOR]): MutationCheckResult {
  return {
    kind: "completed",
    language: "deno",
    survivors,
    killed: 2,
    total: 3,
  };
}

Deno.test("evaluateMutationGate - surviving mutant blocks", () => {
  const v = evaluateMutationGate(completed(), "");
  assert(v.blocked);
  assertEquals(v.survivors, [SURVIVOR]);
  assertStringIncludes(v.reason, "1 mutant");
});

Deno.test("evaluateMutationGate - all mutants killed passes", () => {
  const v = evaluateMutationGate(completed([]), "");
  assertFalse(v.blocked);
  assertFalse(v.budgetExhausted);
});

Deno.test("evaluateMutationGate - exempted survivor passes", () => {
  const v = evaluateMutationGate(
    completed(),
    "`lib/a.ts:12` exempt (untestable): logging only",
  );
  assertFalse(v.blocked);
  assertEquals(v.exempted, [SURVIVOR]);
  assertEquals(v.survivors, []);
});

Deno.test("evaluateMutationGate - exemption for a different line does not apply", () => {
  const v = evaluateMutationGate(
    completed(),
    "`lib/a.ts:13` exempt (untestable): logging only",
  );
  assert(v.blocked);
});

const EXHAUSTED = {
  kind: "budget_exhausted" as const,
  language: "deno" as const,
  killed: 1,
  tested: 2,
  total: 5,
  budgetSeconds: 300,
};

Deno.test("evaluateMutationGate - budget exhausted with a survivor blocks", () => {
  const v = evaluateMutationGate({ ...EXHAUSTED, survivors: [SURVIVOR] }, "");
  assert(v.blocked);
  assert(v.budgetExhausted);
});

Deno.test("evaluateMutationGate - budget exhausted without survivors is flagged, never described as passed", () => {
  const v = evaluateMutationGate({ ...EXHAUSTED, survivors: [] }, "");
  assertFalse(v.blocked);
  assert(v.budgetExhausted);
  assertStringIncludes(
    v.note,
    "mutation budget exhausted after 2 of 5 mutants (300 s) — remaining mutants untested, not passed",
  );
});

Deno.test("evaluateMutationGate - a capped run is flagged with its untested count, never described as passed", () => {
  const v = evaluateMutationGate(
    { ...EXHAUSTED, limit: "mutant_cap", tested: 40, total: 55, survivors: [] },
    "",
  );
  assertFalse(v.blocked);
  assert(v.budgetExhausted);
  assertStringIncludes(
    v.note,
    "mutation cap reached: 40 of 55 candidate mutants tried",
  );
  assertStringIncludes(v.note, "15 untested");
  assertStringIncludes(v.note, "not passed");
});

Deno.test("evaluateMutationGate - error fails closed with a remedy", () => {
  const v = evaluateMutationGate({ kind: "error", reason: "boom" }, "");
  assert(v.blocked);
  assertStringIncludes(v.reason, "boom");
  assertStringIncludes(v.reason, "skip_mutation_check");
});

Deno.test("evaluateMutationGate - not applicable passes and explains", () => {
  const v = evaluateMutationGate(
    { kind: "not_applicable", reason: "docs only" },
    "",
  );
  assertFalse(v.blocked);
  assertStringIncludes(v.note, "docs only");
});

// ---------------------------------------------------------------------------
// buildMutationGateComment
// ---------------------------------------------------------------------------

Deno.test("buildMutationGateComment - names each survivor and the remedy", () => {
  const v = evaluateMutationGate(completed(), "");
  const comment = buildMutationGateComment(v);
  assertStringIncludes(comment, "`lib/a.ts:12` — negated if condition");
  assertStringIncludes(comment, "No test went red");
  assertStringIncludes(comment, "exempt (untestable): <reason>");
});

Deno.test("buildMutationGateComment - sanitises backticks and newlines", () => {
  const v = evaluateMutationGate(
    completed([{ file: "a`b\n.ts", line: 1, description: "x`y\nz" }]),
    "",
  );
  const comment = buildMutationGateComment(v);
  assertStringIncludes(comment, "`ab .ts:1` — xy z");
});

Deno.test("buildMutationGateComment - includes the budget note when exhausted", () => {
  const v = evaluateMutationGate({ ...EXHAUSTED, survivors: [SURVIVOR] }, "");
  assertStringIncludes(buildMutationGateComment(v), "untested, not passed");
});

// ---------------------------------------------------------------------------
// Wiring mutants: object properties, array elements, property values
// (Issue #3601)
// ---------------------------------------------------------------------------

/** Mutants of every line of `src` (1-based), keyed by description. */
function wiringMutants(src: string, lines: number[]) {
  return generateDenoMutants("lib/a.ts", src, lines, 100);
}

/** The mutated text of `line` in a mutant's source. */
const lineOf = (m: { mutatedSource: string }, line: number) =>
  m.mutatedSource.split("\n")[line - 1];

Deno.test("wiring mutants - deletes a shorthand property alone on its line in an object literal (Issue #3601)", () => {
  const src = [
    "const request = {",
    "  issue,",
    "  repo,",
    "};",
  ].join("\n");
  const ms = wiringMutants(src, [3]);
  const del = ms.find((m) =>
    m.description === "deleted object property `repo`"
  );
  assert(
    del,
    `no property deletion in ${JSON.stringify(ms.map((m) => m.description))}`,
  );
  assertEquals(lineOf(del, 3), "");
});

Deno.test("wiring mutants - deletes one entry of a single-line object literal argument (Issue #3601)", () => {
  const src = "  await runner.run({ repo, ...request });";
  const ms = wiringMutants(src, [1]);
  const del = ms.find((m) =>
    m.description === "deleted object property `repo`"
  );
  assert(
    del,
    `no entry deletion in ${JSON.stringify(ms.map((m) => m.description))}`,
  );
  assertEquals(lineOf(del, 1), "  await runner.run({ ...request });");
});

Deno.test("wiring mutants - deletes a string element alone on its line in an array literal (Issue #3601)", () => {
  const src = [
    "const fields = [",
    '  "number",',
    '  "subIssuesSummary",',
    "];",
  ].join("\n");
  const ms = wiringMutants(src, [3]);
  const del = ms.find((m) =>
    m.description === 'deleted array element `"subIssuesSummary"`'
  );
  assert(
    del,
    `no element deletion in ${JSON.stringify(ms.map((m) => m.description))}`,
  );
  assertEquals(lineOf(del, 3), "");
});

Deno.test("wiring mutants - reverts a renamed property value to the shorthand when that name is in scope (Issue #3601)", () => {
  const src = [
    "function block(reason: string, failureReason: string) {",
    "  return {",
    "    reason: failureReason,",
    "  };",
    "}",
  ].join("\n");
  const ms = wiringMutants(src, [3]);
  const revert = ms.find((m) =>
    m.description === "reverted property `reason` to shorthand"
  );
  assert(
    revert,
    `no revert in ${JSON.stringify(ms.map((m) => m.description))}`,
  );
  assertEquals(lineOf(revert, 3), "    reason,");
  assert(
    ms.some((m) => m.description === "deleted object property `reason`"),
    "the property can also be deleted",
  );
});

Deno.test("wiring mutants - no revert when the key is not a name in use nearby (Issue #3601)", () => {
  const src = [
    "export const config = {",
    "  colour: defaultColour,",
    "};",
  ].join("\n");
  const ms = wiringMutants(src, [2]);
  assertFalse(ms.some((m) => m.description.startsWith("reverted property")));
});

Deno.test("wiring mutants - type-only lines produce none: interfaces, type literals, annotations and generics (Issue #3601)", () => {
  const cases: Array<[string, number]> = [
    ["interface Request {\n  repo: string;\n  issue: number,\n}", 3],
    ["type Request = {\n  repo: string,\n};", 2],
    ["export type Pair = [\n  string,\n  number,\n];", 2],
    ["function f(opts: {\n  repo: string,\n}) {}", 2],
    ["const m: Record<string, {\n  repo: string,\n}> = {};", 2],
    ["function f(\n  repo,\n  issue,\n) {}", 2],
  ];
  for (const [src, line] of cases) {
    const ms = wiringMutants(src, [line]);
    assertEquals(
      ms.map((m) => m.description),
      [],
      `expected no mutants for line ${line} of:\n${src}`,
    );
  }
});

Deno.test("wiring mutants - index access, comments and strings are not array or object literals (Issue #3601)", () => {
  assertEquals(
    wiringMutants("const x = items[0];", [1]).map((m) => m.description),
    [],
  );
  const commented = "const a = {\n  // repo,\n};";
  assertEquals(wiringMutants(commented, [2]), []);
  const template = "const s = `\n  repo,\n`;";
  assertEquals(wiringMutants(template, [2]), []);
});

Deno.test("wiring mutants - a file whose brackets do not balance gets no wiring mutants, only the old kinds (Issue #3601)", () => {
  const src = [
    "const request = {",
    "  repo,",
    "]; // mismatched closer",
    "if (ok) { run(); }",
  ].join("\n");
  const ms = wiringMutants(src, [2, 4]);
  assertFalse(
    ms.some((m) => m.description.startsWith("deleted object property")),
  );
  assert(ms.some((m) => m.description === "negated if condition"));
});

Deno.test("wiring mutants - a property line that continues onto the next line is not deleted (Issue #3601)", () => {
  const src = [
    "const request = {",
    "  repo: base +",
    "    suffix,",
    "};",
  ].join("\n");
  assertFalse(
    wiringMutants(src, [2]).some((m) =>
      m.description.startsWith("deleted object property")
    ),
  );
});

Deno.test("wiring mutants - an element that continues the previous line's expression is not deleted (Issue #3601)", () => {
  const src = [
    "const notes = [",
    '  "first part " +',
    '    "second part",',
    "];",
  ].join("\n");
  assertFalse(
    wiringMutants(src, [3]).some((m) =>
      m.description.startsWith("deleted array element")
    ),
  );
});

Deno.test("wiring mutants - a literal value such as null is never reverted to a shorthand (Issue #3601)", () => {
  const src = [
    "function f(pending: string) {",
    "  return {",
    "    pending: null,",
    "  };",
    "}",
  ].join("\n");
  const ms = wiringMutants(src, [3]);
  assertFalse(ms.some((m) => m.description.startsWith("reverted property")));
  assert(ms.some((m) => m.description === "deleted object property `pending`"));
});

Deno.test("wiring mutants - a key holding $ is matched as a name, not as a pattern (Issue #3601)", () => {
  const src = [
    "function f($state: string, next: string) {",
    "  return {",
    "    $state: next,",
    "  };",
    "}",
  ].join("\n");
  assert(
    wiringMutants(src, [3]).some((m) =>
      m.description === "reverted property `$state` to shorthand"
    ),
  );
});

// ---------------------------------------------------------------------------
// Shell script mutants
// ---------------------------------------------------------------------------

const SHELL_FILE = "scripts/deploy.sh";

function shell(source: string, lines: number[], cap = 40) {
  return generateShellMutantsDetailed(SHELL_FILE, source, lines, cap);
}

function shellDescriptions(source: string, lines: number[]): string[] {
  return shell(source, lines).mutants.map((m) => m.description);
}

function mutantFor(
  source: string,
  lines: number[],
  description: string,
): string | undefined {
  return shell(source, lines).mutants.find((m) => m.description === description)
    ?.mutatedSource;
}

Deno.test("isShellScriptPath - matches .sh and .bash paths only", () => {
  assert(isShellScriptPath("scripts/deploy.sh"));
  assert(isShellScriptPath("scripts/deploy.bash"));
  assertFalse(isShellScriptPath("scripts/deploy.sh.txt"));
  assertFalse(isShellScriptPath("lib/x.ts"));
  assertFalse(isShellScriptPath("scripts/deploy"));
});

Deno.test("isShellTestFile - recognises shell and bats test files by name", () => {
  for (
    const f of [
      "tests/foo_test.sh",
      "scripts/check.test.sh",
      "test_deploy.sh",
      "scripts/test_deploy.sh",
      "tests/run.bats",
    ]
  ) {
    assert(isShellTestFile(f), f);
  }
  for (
    const f of [
      "scripts/deploy.sh",
      "scripts/latest.sh",
      "scripts/contest.sh",
      "lib/x_test.ts",
    ]
  ) {
    assertFalse(isShellTestFile(f), f);
  }
});

Deno.test("hasShellShebang - accepts sh and bash interpreters, direct or via env", () => {
  for (
    const first of [
      "#!/bin/sh",
      "#!/bin/bash",
      "#!/usr/bin/env bash",
      "#!/usr/bin/env -S bash -e",
      "#!/usr/bin/env -i sh",
      "#!/bin/bash ",
    ]
  ) {
    assert(hasShellShebang(`${first}\necho hi\n`), first);
  }
  assert(hasShellShebang("#!/bin/sh\r\necho hi\n"));
});

Deno.test("hasShellShebang - rejects other interpreters, a missing shebang, or a shebang not on line one", () => {
  for (
    const src of [
      "#!/usr/bin/python3\nprint(1)\n",
      "#!/usr/bin/env python3\n",
      "#!/bin/zsh\n",
      "echo hi\n#!/bin/sh\n",
      "",
      "#!/usr/bin/env\n",
    ]
  ) {
    assertFalse(hasShellShebang(src), src);
  }
});

Deno.test("generateShellMutantsDetailed - deletes an export statement to a no-op", () => {
  const { mutants, dropped } = shell("export FOO=1\n", [1]);
  assertEquals(dropped, 0);
  assertEquals(mutants.length, 2);
  assertEquals(mutants[0]?.description, "deleted statement");
  assertEquals(mutants[0]?.mutatedSource, ":\n");
  assertEquals(
    mutants[1]?.description,
    "guarded statement off with `false &&`",
  );
  assertEquals(mutants[1]?.mutatedSource, "false && export FOO=1\n");
});

Deno.test("generateShellMutantsDetailed - guards a plain statement off with false && and keeps its indent", () => {
  assertEquals(
    mutantFor("x=y\n", [1], "guarded statement off with `false &&`"),
    "false && x=y\n",
  );
  assertEquals(
    mutantFor(
      '    touch "$f"\n',
      [1],
      "guarded statement off with `false &&`",
    ),
    '    false && touch "$f"\n',
  );
  assertEquals(
    mutantFor("\t[[ -f x ]]\n", [1], "guarded statement off with `false &&`"),
    "\tfalse && [[ -f x ]]\n",
  );
});

Deno.test("generateShellMutantsDetailed - no guard is added to a list, pipeline, subshell, substitution or header", () => {
  const lines = [
    "a=1; b=2",
    "cat x | grep y",
    "bar &",
    "echo hi 2>&1",
    "x=$(cmd)",
    "declare -a arr=(1 2)",
    "(cd dir)",
    "f()",
    "foo)",
    "f() {",
    "if true; then",
    "fi",
    "cmd \\",
    "cat x |",
    "foo &&",
  ];
  for (const line of lines) {
    assertFalse(
      shellDescriptions(`${line}\n`, [1]).includes(
        "guarded statement off with `false &&`",
      ),
      line,
    );
  }
});

Deno.test("generateShellMutantsDetailed - an already guarded line gets no added guard", () => {
  for (
    const line of [
      '[[ -f "$f" ]] || touch "$f"',
      '[[ -f "$f" ]] && touch "$f"',
      "a || b",
    ]
  ) {
    assertFalse(
      shellDescriptions(`${line}\n`, [1]).includes(
        "guarded statement off with `false &&`",
      ),
      line,
    );
  }
});

Deno.test("generateShellMutantsDetailed - flips each test operator to its opposite", () => {
  const pairs: Array<[string, string]> = [
    ["-eq", "-ne"],
    ["-ne", "-eq"],
    ["-lt", "-ge"],
    ["-ge", "-lt"],
    ["-gt", "-le"],
    ["-le", "-gt"],
    ["==", "!="],
    ["!=", "=="],
    ["-z", "-n"],
    ["-n", "-z"],
  ];
  for (const [from, to] of pairs) {
    assertEquals(
      mutantFor(
        `  test "$a" ${from} "$b"\n`,
        [1],
        `flipped \`${from}\` to \`${to}\``,
      ),
      `  test "$a" ${to} "$b"\n`,
      from,
    );
  }
});

Deno.test("generateShellMutantsDetailed - swaps the first && and || connective", () => {
  assertEquals(
    mutantFor("cmd1 && cmd2 || cmd3\n", [1], "swapped `&&` for `||`"),
    "cmd1 || cmd2 || cmd3\n",
  );
  assertEquals(
    mutantFor("a || b\n", [1], "swapped `||` for `&&`"),
    "a && b\n",
  );
});

Deno.test("generateShellMutantsDetailed - flips a return or exit status", () => {
  assertEquals(
    mutantFor("return 0\n", [1], "replaced `return 0` with `return 1`"),
    "return 1\n",
  );
  assertEquals(
    mutantFor("return 1\n", [1], "replaced `return 1` with `return 0`"),
    "return 0\n",
  );
  assertEquals(
    mutantFor("exit 0\n", [1], "replaced `exit 0` with `exit 1`"),
    "exit 1\n",
  );
  assertEquals(
    mutantFor("exit 5\n", [1], "replaced `exit 5` with `exit 0`"),
    "exit 0\n",
  );
  // A return status other than 0 or 1 has no flip.
  assertEquals(shellDescriptions("return 2\n", [1]), [
    "deleted statement",
    "guarded statement off with `false &&`",
  ]);
});

Deno.test("generateShellMutantsDetailed - removes a [[ ]] guard", () => {
  assertEquals(
    mutantFor('  [[ -f "$f" ]] || touch "$f"\n', [1], "removed `[[ ]]` guard"),
    '  touch "$f"\n',
  );
});

Deno.test("generateShellMutantsDetailed - structural lines are never deleted", () => {
  for (
    const line of [
      "if true; then",
      "else",
      "fi",
      "done",
      "esac",
      "}",
      "{",
      "then",
      "case $x in",
      "for f in a; do",
      "function f {",
      "cmd \\",
      "cat x |",
      "foo &&",
      ")",
    ]
  ) {
    assertFalse(
      shellDescriptions(`${line}\n`, [1]).includes("deleted statement"),
      line,
    );
  }
});

Deno.test("generateShellMutantsDetailed - each structural word as a command is never deleted or guarded", () => {
  for (
    const word of [
      "if",
      "then",
      "else",
      "elif",
      "fi",
      "for",
      "while",
      "until",
      "do",
      "done",
      "case",
      "esac",
      "in",
      "select",
      "function",
      "{",
      "}",
    ]
  ) {
    const descriptions = shellDescriptions(`${word} foo\n`, [1]);
    assertFalse(descriptions.includes("deleted statement"), word);
    assertFalse(
      descriptions.includes("guarded statement off with `false &&`"),
      word,
    );
  }
});

Deno.test("generateShellMutantsDetailed - bare structural keywords yield no mutants", () => {
  for (const line of ["fi", "else", "done", "esac", "then", "}", "{", ")"]) {
    assertEquals(shell(`${line}\n`, [1]).mutants, [], line);
  }
});

Deno.test("generateShellMutantsDetailed - case patterns and terminators are never deleted", () => {
  for (
    const line of [
      "a|b)",
      "*)",
      "foo)",
      '"x y")',
      "*) cmd ;;",
      "pattern) cmd ;;",
      "  cmd ;;",
      "cmd ;&",
      ";;",
      "esac",
      "in",
    ]
  ) {
    assertFalse(
      shellDescriptions(`${line}\n`, [1]).includes("deleted statement"),
      line,
    );
  }
});

Deno.test("generateShellMutantsDetailed - a command beside case clauses still mutates, as do $(...) statements", () => {
  const src = [
    "case $x in",
    "  a|b)",
    "    export FOO=1",
    "    ;;",
    "  *)",
    '    echo ")"',
    "    foo=$(bar)",
    "    x=$(cmd)",
    "    ;;",
    "esac",
  ].join("\n") + "\n";
  assertEquals(shellDescriptions(src, [2, 4, 5, 9, 10]), []);
  const deleted = (line: number) =>
    shell(src, [line]).mutants.find((m) =>
      m.description === "deleted statement"
    )?.mutatedSource ?? null;
  assertEquals(
    deleted(3),
    src.replace("    export FOO=1", "    :"),
  );
  assertEquals(
    deleted(6),
    src.replace('    echo ")"', "    :"),
  );
  assertEquals(
    deleted(7),
    src.replace("    foo=$(bar)", "    :"),
  );
  assertEquals(
    deleted(8),
    src.replace("    x=$(cmd)", "    :"),
  );
});

Deno.test("generateShellMutantsDetailed - comment and blank lines yield nothing", () => {
  const src = "# export FOO=1\n  # if [ $a -eq 1 ]; then\n\n   \n#!/bin/sh\n";
  assertEquals(shell(src, [1, 2, 3, 4, 5]).mutants, []);
});

Deno.test("generateShellMutantsDetailed - keeps CRLF line endings on a mutated line", () => {
  assertEquals(
    shell("export FOO=1\r\n", [1]).mutants[0]?.mutatedSource,
    ":\r\n",
  );
  assertEquals(
    mutantFor("x=y\r\n", [1], "guarded statement off with `false &&`"),
    "false && x=y\r\n",
  );
});

Deno.test("generateShellMutantsDetailed - a 400-character line is processed and a 401-character line is dropped", () => {
  const at400 = "export X=" + "1".repeat(391);
  assertEquals(at400.length, 400);
  const ok = shell(`${at400}\n`, [1]);
  assertEquals(ok.mutants.length, 2);
  assertEquals(
    ok.mutants[1]?.description,
    "guarded statement off with `false &&`",
  );
  assertEquals(ok.dropped, 0);
  const over = shell(`${at400}1\n`, [1]);
  assertEquals(over.mutants, []);
  assertEquals(over.dropped, 1);
});

Deno.test("generateShellMutantsDetailed - stops at the cap and counts what it dropped", () => {
  // One line with three candidates: a deletion, a guard-off and a flip.
  const src = '  [ "$a" -eq 1 ]\n';
  const capped = shell(src, [1], 1);
  assertEquals(capped.mutants.map((m) => m.description), [
    "deleted statement",
  ]);
  assertEquals(capped.dropped, 2);
  const twoCapped = shell(src, [1], 2);
  assertEquals(twoCapped.mutants.map((m) => m.description), [
    "deleted statement",
    "guarded statement off with `false &&`",
  ]);
  assertEquals(twoCapped.dropped, 1);
  const none = shell(src, [1], 0);
  assertEquals(none.mutants, []);
  assertEquals(none.dropped, 3);
});

Deno.test("generateShellMutantsDetailed - the default cap is 40 mutants", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `export V${i}=1`);
  const src = lines.join("\n") + "\n";
  const all = generateShellMutantsDetailed(
    SHELL_FILE,
    src,
    lines.map((_, i) => i + 1),
  );
  assertEquals(all.mutants.length, 40);
  // Each export line has two candidates, a deletion and a guard-off: 100 in all.
  assertEquals(all.dropped, 60);
});

Deno.test("generateShellMutantsDetailed - a shell test file yields no mutants", () => {
  for (
    const file of [
      "tests/foo_test.sh",
      "scripts/check.test.sh",
      "test_deploy.sh",
      "tests/run.bats",
    ]
  ) {
    assertEquals(
      generateShellMutantsDetailed(file, "export A=1\n", [1]),
      { mutants: [], dropped: 0 },
      file,
    );
  }
});

Deno.test("generateShellMutantsDetailed - a 50_000-character line is dropped without work", () => {
  const src = "export A=" + "1".repeat(50_000) + "\n";
  assertEquals(shell(src, [1]), { mutants: [], dropped: 1 });
});

Deno.test("generateShellMutantsDetailed - a 50_000-character file completes at the cap", () => {
  const src = "export V=1\n".repeat(4_545);
  const lines = Array.from({ length: 4_545 }, (_, i) => i + 1);
  const { mutants, dropped } = generateShellMutantsDetailed(
    SHELL_FILE,
    src,
    lines,
  );
  assertEquals(mutants.length, 40);
  // Two candidates per line: 9_090 in all, 40 kept.
  assertEquals(dropped, 9_050);
});

Deno.test("generateShellMutantsDetailed - growth stays linear on hostile input", () => {
  const build = (chars: number) =>
    "export V=1\n".repeat(Math.max(1, Math.floor(chars / 11)));
  const run = (input: string) => {
    const count = input.split("\n").length;
    return generateShellMutantsDetailed(
      SHELL_FILE,
      input,
      Array.from({ length: count }, (_, i) => i + 1),
    );
  };
  const out = assertLinearGrowth("shell mutant generation", build, run, {
    baseChars: 12_500,
  });
  assertEquals(out.mutants.length, 40);
});

// ---------------------------------------------------------------------------
// evaluateMutationGate for shell results
// ---------------------------------------------------------------------------

const NOT_CHECKED_REASON =
  'no test runs scripts/deploy.sh (searched for "scripts/deploy.sh" and its basename)';

function notChecked(): MutationCheckResult {
  return { kind: "not_checked", language: "shell", reason: NOT_CHECKED_REASON };
}

Deno.test("evaluateMutationGate - not_checked blocks and never reports survivors", () => {
  const v = evaluateMutationGate(notChecked(), "");
  assert(v.blocked);
  assertFalse(v.budgetExhausted);
  assertEquals(v.survivors, []);
  assertEquals(v.exempted, []);
  assertStringIncludes(v.reason, "mutation check not checked:");
  assertStringIncludes(
    v.reason,
    "add a test that names each script (its repo-relative path or basename) so its mutants can run",
  );
  assertEquals(v.note, `not checked: ${NOT_CHECKED_REASON}`);
});

Deno.test("evaluateMutationGate - an exemption does not unblock not_checked", () => {
  const v = evaluateMutationGate(
    notChecked(),
    "`scripts/deploy.sh:3` exempt (untestable): logging only",
  );
  assert(v.blocked);
  assertEquals(v.exempted, []);
});
