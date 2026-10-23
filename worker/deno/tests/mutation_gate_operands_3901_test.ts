/**
 * Unit tests for the operand mutants of the diff-scoped mutation gate
 * (Issue #3901): on an added line holding a top-level `||` or `&&` chain, one
 * mutant per operand, with that operand replaced by the chain identity
 * (`false` for `||`, `true` for `&&`).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_MUTANT_CAP,
  generateDenoMutants,
  generateDenoMutantsDetailed,
} from "../lib/mutation_gate.ts";

const FILE = "lib/sample.ts";

interface OperandMutant {
  line: number;
  text: string;
  description: string;
}

/** The operand mutants only, with the mutated line text for each. */
function operandMutants(
  source: string,
  addedLines: number[],
  cap = DEFAULT_MUTANT_CAP,
): OperandMutant[] {
  return generateDenoMutants(FILE, source, addedLines, cap)
    .filter((m) => m.description.startsWith("dropped operand"))
    .map((m) => ({
      line: m.line,
      text: m.mutatedSource.split("\n")[m.line - 1] ?? "",
      description: m.description,
    }));
}

/** The 1-based line numbers whose text differs between two sources. */
function changedLines(before: string, after: string): number[] {
  const a = before.split("\n");
  const b = after.split("\n");
  return a.flatMap((line, i) => (line === b[i] ? [] : [i + 1]));
}

// ---------------------------------------------------------------------------
// Chains on a single line
// ---------------------------------------------------------------------------

Deno.test("generateDenoMutants - operand of a single-line || gets one mutant per operand", () => {
  assertEquals(operandMutants("const ok = a || b;\n", [1]), [
    {
      line: 1,
      text: "const ok = false || b;",
      description: "dropped operand `a` (replaced with false)",
    },
    {
      line: 1,
      text: "const ok = a || false;",
      description: "dropped operand `b` (replaced with false)",
    },
  ]);
});

Deno.test("generateDenoMutants - operand of a single-line && is replaced with true", () => {
  assertEquals(operandMutants("if (a && b) {\n}\n", [1]), [
    {
      line: 1,
      text: "if (true && b) {",
      description: "dropped operand `a` (replaced with true)",
    },
    {
      line: 1,
      text: "if (a && true) {",
      description: "dropped operand `b` (replaced with true)",
    },
  ]);
});

Deno.test("generateDenoMutants - only the operand's own line changes", () => {
  const source = "const ok = a || b;\nconst other = 1;\n";
  const mutants = generateDenoMutants(FILE, source, [1], DEFAULT_MUTANT_CAP)
    .filter((m) => m.description.startsWith("dropped operand"));
  assert(mutants.length > 0);
  for (const m of mutants) {
    assertEquals(changedLines(source, m.mutatedSource), [m.line]);
  }
});

Deno.test("generateDenoMutants - a single operand with no chain gets no operand mutant", () => {
  assertEquals(operandMutants("if (a) {\n}\n", [1]), []);
  assertEquals(operandMutants("const x = a;\n", [1]), []);
});

Deno.test("generateDenoMutants - a comment-only line gets no operand mutant", () => {
  assertEquals(operandMutants("// a || b\n", [1]), []);
});

// ---------------------------------------------------------------------------
// Chains that span lines
// ---------------------------------------------------------------------------

Deno.test("generateDenoMutants - operand of a wrapped if is mutated on each line", () => {
  const source = "if (a &&\n  b) {\n}\n";
  assertEquals(operandMutants(source, [1, 2]), [
    {
      line: 1,
      text: "if (true &&",
      description: "dropped operand `a` (replaced with true)",
    },
    {
      line: 2,
      text: "  true) {",
      description: "dropped operand `b` (replaced with true)",
    },
  ]);
});

Deno.test("generateDenoMutants - an operator at the start of the next line is sourced", () => {
  const source = "const ok = a\n  || b;\n";
  assertEquals(operandMutants(source, [1, 2]), [
    {
      line: 1,
      text: "const ok = false",
      description: "dropped operand `a` (replaced with false)",
    },
    {
      line: 2,
      text: "  || false;",
      description: "dropped operand `b` (replaced with false)",
    },
  ]);
});

Deno.test("generateDenoMutants - an operator at the end of the previous line is sourced", () => {
  const source = "const ok = a &&\n  b;\n";
  assertEquals(operandMutants(source, [2]), [
    {
      line: 2,
      text: "  true;",
      description: "dropped operand `b` (replaced with true)",
    },
  ]);
});

// ---------------------------------------------------------------------------
// Statement heads and expression shapes
// ---------------------------------------------------------------------------

Deno.test("generateDenoMutants - operands after return are mutated", () => {
  assertEquals(operandMutants("function f() {\n  return a || b;\n}\n", [2]), [
    {
      line: 2,
      text: "  return false || b;",
      description: "dropped operand `a` (replaced with false)",
    },
    {
      line: 2,
      text: "  return a || false;",
      description: "dropped operand `b` (replaced with false)",
    },
  ]);
});

Deno.test("generateDenoMutants - ternary condition chain stops at the ?", () => {
  assertEquals(operandMutants("const x = ok || a ? 1 : 2;\n", [1]), [
    {
      line: 1,
      text: "const x = false || a ? 1 : 2;",
      description: "dropped operand `ok` (replaced with false)",
    },
    {
      line: 1,
      text: "const x = ok || false ? 1 : 2;",
      description: "dropped operand `a` (replaced with false)",
    },
  ]);
});

Deno.test("generateDenoMutants - a mixed chain at one depth splits on ||", () => {
  assertEquals(operandMutants("const ok = a && b || c;\n", [1]), [
    {
      line: 1,
      text: "const ok = false || c;",
      description: "dropped operand `a && b` (replaced with false)",
    },
    {
      line: 1,
      text: "const ok = a && b || false;",
      description: "dropped operand `c` (replaced with false)",
    },
  ]);
});

Deno.test("generateDenoMutants - nested chain is split at the top level only", () => {
  const source = "if ((a || b) && c) {\n}\n";
  assertEquals(operandMutants(source, [1]), [
    {
      line: 1,
      text: "if (true && c) {",
      description: "dropped operand `(a || b)` (replaced with true)",
    },
    {
      line: 1,
      text: "if ((a || b) && true) {",
      description: "dropped operand `c` (replaced with true)",
    },
  ]);
});

Deno.test("generateDenoMutants - a trailing comment is not joined to the last operand", () => {
  assertEquals(operandMutants("const v = a || b // x || y\n", [1]), [
    {
      line: 1,
      text: "const v = false || b // x || y",
      description: "dropped operand `a` (replaced with false)",
    },
    {
      line: 1,
      text: "const v = a || false // x || y",
      description: "dropped operand `b` (replaced with false)",
    },
  ]);
});

Deno.test("generateDenoMutants - a comment with no chain gets no operand mutant", () => {
  assertEquals(operandMutants("const v = a // x || y\n", [1]), []);
});

// ---------------------------------------------------------------------------
// Text that is not code
// ---------------------------------------------------------------------------

Deno.test("generateDenoMutants - a || inside a string is not a chain", () => {
  assertEquals(operandMutants('const s = "a || b";\n', [1]), []);
});

Deno.test("generateDenoMutants - a || inside a regex literal is not a chain", () => {
  assertEquals(operandMutants("const r = /a||b/;\n", [1]), []);
});

Deno.test("generateDenoMutants - a || inside a template expression is not a chain", () => {
  assertEquals(operandMutants("const t = `${a || b}`;\n", [1]), []);
});

// ---------------------------------------------------------------------------
// Lines that are not plain chains
// ---------------------------------------------------------------------------

Deno.test("generateDenoMutants - a type alias line gets no operand mutant", () => {
  assertEquals(operandMutants("type Flag = a || b;\n", [1]), []);
});

Deno.test("generateDenoMutants - ||= and &&= are not chains", () => {
  assertEquals(operandMutants("x ||= a;\n", [1]), []);
  assertEquals(operandMutants("x &&= a;\n", [1]), []);
});

Deno.test("generateDenoMutants - an arrow function line gets no operand mutant", () => {
  assertEquals(operandMutants("const f = () => a || b;\n", [1]), []);
});

Deno.test("generateDenoMutants - ?? is not a chain", () => {
  assertEquals(operandMutants("const v = a ?? b;\n", [1]), []);
});

// ---------------------------------------------------------------------------
// Description and identity
// ---------------------------------------------------------------------------

Deno.test("generateDenoMutants - an operand longer than 60 characters is shown truncated", () => {
  const long = "a".repeat(70);
  assertEquals(operandMutants(`const ok = ${long} || b;\n`, [1])[0], {
    line: 1,
    text: "const ok = false || b;",
    description: `dropped operand \`${
      "a".repeat(57)
    }...\` (replaced with false)`,
  });
});

Deno.test("generateDenoMutants - backticks in a shown operand are replaced with quotes", () => {
  assertEquals(operandMutants("const s = a + `x` || b;\n", [1])[0], {
    line: 1,
    text: "const s = false || b;",
    description: "dropped operand `a + 'x'` (replaced with false)",
  });
});

// ---------------------------------------------------------------------------
// Cap ordering and hostile input
// ---------------------------------------------------------------------------

Deno.test("generateDenoMutantsDetailed - operand mutants come after the other kinds under the cap", () => {
  const source = "if (a && b) {\n}\n";
  const full = generateDenoMutantsDetailed(
    FILE,
    source,
    [1],
    DEFAULT_MUTANT_CAP,
  );
  const capped = generateDenoMutantsDetailed(FILE, source, [1], 2);
  assertEquals(capped.mutants.map((m) => m.description), [
    "negated if condition",
    "dropped operand `a` (replaced with true)",
  ]);
  // Every candidate is either tried or counted as dropped.
  assertEquals(
    capped.mutants.length + capped.dropped,
    full.mutants.length + full.dropped,
  );
});

Deno.test("generateDenoMutantsDetailed - a line over the length limit is dropped, not mutated", () => {
  const source = `const ok = ${"a || ".repeat(50_000)}b;\n`;
  const out = generateDenoMutantsDetailed(
    FILE,
    source,
    [1],
    DEFAULT_MUTANT_CAP,
  );
  assertEquals(out.mutants, []);
  assertEquals(out.dropped, 1);
});

Deno.test("generateDenoMutants - a long chain is capped and the rest counted as dropped", () => {
  const operands = Array.from({ length: 45 }, () => "a").join(" || ");
  const source = `const ok = ${operands};\n`;
  const out = generateDenoMutantsDetailed(
    FILE,
    source,
    [1],
    DEFAULT_MUTANT_CAP,
  );
  assertEquals(out.mutants.length, DEFAULT_MUTANT_CAP);
  assert(out.dropped >= 5);
});

Deno.test("generateDenoMutants - an open block comment at end of file disables only the operand kind", () => {
  const source = "if (a && b) {\n}\n/* open\n";
  const mutants = generateDenoMutants(FILE, source, [1], DEFAULT_MUTANT_CAP);
  assertEquals(
    mutants.filter((m) => m.description.startsWith("dropped operand")),
    [],
  );
  assertEquals(
    mutants.filter((m) => m.description === "negated if condition").length,
    1,
  );
});

Deno.test("generateDenoMutants - an open template literal at end of file disables only the operand kind", () => {
  const source = "const s = 1;\nconst t = `open\nif (a && b) {\n}\n";
  const mutants = generateDenoMutants(FILE, source, [3], DEFAULT_MUTANT_CAP);
  assertEquals(
    mutants.filter((m) => m.description.startsWith("dropped operand")),
    [],
  );
  assertEquals(
    mutants.filter((m) => m.description === "negated if condition").length,
    1,
  );
});
