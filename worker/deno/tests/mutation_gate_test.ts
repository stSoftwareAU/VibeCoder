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
import {
  buildMutationGateComment,
  evaluateMutationGate,
  generateDenoMutants,
  generateDenoMutantsDetailed,
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
