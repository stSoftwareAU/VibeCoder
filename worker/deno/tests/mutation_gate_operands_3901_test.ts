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
  buildMutationGateComment,
  DEFAULT_MUTANT_CAP,
  generateDenoMutants,
  generateDenoMutantsDetailed,
  maskedLines,
  type MutationGateVerdict,
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

// ---------------------------------------------------------------------------
// maskedLines: the masked text of each literal and comment kind, exactly
// ---------------------------------------------------------------------------

/** `maskedLines` with the opaque marker shown as `#`, so expectations read. */
function masked(source: string): string[] | null {
  const out = maskedLines(source);
  return out === null ? null : out.map((l) => l.replaceAll("\u0001", "#"));
}

Deno.test("maskedLines - a block comment is opaque for its whole length", () => {
  assertEquals(masked("a /* x */ b || c"), ["a ####### b || c"]);
});

Deno.test("maskedLines - a block comment spanning lines is opaque on each line", () => {
  assertEquals(masked("a /* x\n y */ b"), ["a ####", "##### b"]);
});

Deno.test("maskedLines - a line comment is opaque to the end of the line only", () => {
  assertEquals(masked("a // c\nb"), ["a ####", "b"]);
});

Deno.test("maskedLines - a string is blanked, an escaped quote stays inside it", () => {
  assertEquals(masked('"a\\"b" || c'), ["       || c"]);
});

Deno.test("maskedLines - a string closes at its own quote and code resumes", () => {
  assertEquals(masked("'a' || \"b\" && c"), ["    ||     && c"]);
});

Deno.test("maskedLines - a template expression is opaque and the template resumes after it", () => {
  assertEquals(masked("`a${b}c` d"), ["    #    d"]);
});

Deno.test("maskedLines - code after a template expression is plain code again", () => {
  assertEquals(masked("`${a}` + b"), ["   #   + b"]);
});

Deno.test("maskedLines - braces nested inside a template expression do not end it early", () => {
  assertEquals(masked("`a${ {x: 1} }c` + e || f"), [
    "    ########    + e || f",
  ]);
});

Deno.test("maskedLines - braces in code are counted so a template expression closes at its own brace", () => {
  assertEquals(masked("{ { x } `${y}` } || z"), ["{ { x }    #   } || z"]);
});

Deno.test("maskedLines - a stray closing brace does not unbalance a later template expression", () => {
  assertEquals(masked("} `${y}` || z"), ["}    #   || z"]);
});

Deno.test("maskedLines - a slash inside a regex character class does not end the regex", () => {
  assertEquals(masked("x = /[/]/ || b"), ["x =       || b"]);
});

Deno.test("maskedLines - a regex ends at its closing slash after a character class", () => {
  assertEquals(masked("x = /[a]/.test(y) || b"), ["x =      .test(y) || b"]);
});

Deno.test("maskedLines - a regex starts with a fresh character class state", () => {
  assertEquals(masked("x = /[abc\ny = /a/ || b"), [
    "x =      ",
    "y =     || b",
  ]);
});

Deno.test("maskedLines - a plain slash after an operand is division, not a regex", () => {
  assertEquals(masked("a / b || c"), ["a / b || c"]);
});

Deno.test("maskedLines - null when a template literal is left open", () => {
  assertEquals(maskedLines("`open\nx"), null);
});

Deno.test("maskedLines - null when a block comment is left open", () => {
  assertEquals(maskedLines("/* open\nx"), null);
});

Deno.test("maskedLines - an unterminated string ends at the line break", () => {
  assertEquals(masked("x = 'abc\ny || z"), ["x =     ", "y || z"]);
});

Deno.test("maskedLines - a star or slash alone inside a block comment does not end it", () => {
  assertEquals(masked("/* a * b / c */ d"), ["############### d"]);
});

Deno.test("maskedLines - a star after an operand is multiplication, not a comment", () => {
  assertEquals(masked("a * b || c"), ["a * b || c"]);
});

Deno.test("maskedLines - a backslash ending a line in a string does not swallow the line break", () => {
  assertEquals(masked('"ab\\\n cd" || x'), ["    ", " cd      "]);
});

Deno.test("maskedLines - a backslash ending the source keeps the length", () => {
  assertEquals(masked('"ab\\'), ["    "]);
});

Deno.test("maskedLines - a lone dollar or brace in a template is not an expression", () => {
  assertEquals(masked("`a$b` || c"), ["      || c"]);
  assertEquals(masked("`a{b}` || c"), ["       || c"]);
});

// ---------------------------------------------------------------------------
// Chain boundaries: where the operand region ends and which operator splits it
// ---------------------------------------------------------------------------

/** The shown operands of the operand mutants, in order. */
function shown(source: string, addedLines: number[]): string[] {
  return operandMutants(source, addedLines).map((m) =>
    m.description.replace(
      /^dropped operand `(.*)` \(replaced with \w+\)$/,
      "$1",
    )
  );
}

Deno.test("operand region - an array literal's comma and bracket stay inside an operand", () => {
  assertEquals(shown("const x = a || [b, c].length;\n", [1]), [
    "a",
    "[b, c].length",
  ]);
});

Deno.test("operand region - an object literal's colon and brace stay inside an operand", () => {
  assertEquals(shown("const x = a || { b: 1 }.c;\n", [1]), [
    "a",
    "{ b: 1 }.c",
  ]);
});

Deno.test("operand region - a call argument line ends at its trailing comma", () => {
  assertEquals(shown("foo(\n  a || b,\n  c,\n);\n", [2]), ["a", "b"]);
});

Deno.test("operand region - a property line ends at its colon and has no chain", () => {
  assertEquals(shown("const o = {\n  key: a || b,\n};\n", [2]), []);
});

Deno.test("operand region - a ternary ends at its question mark", () => {
  assertEquals(shown("const x = a || b ? c : d;\n", [1]), ["a", "b"]);
});

Deno.test("operand region - ?? and ?. are not ternary question marks", () => {
  assertEquals(shown("const x = a ?? b || c;\n", [1]), ["a ?? b", "c"]);
  assertEquals(shown("const x = a?.b || c;\n", [1]), ["a?.b", "c"]);
});

Deno.test("operand region - a compound assignment is not a chain", () => {
  assertEquals(shown("x += a || b;\n", [1]), []);
});

Deno.test("operand region - a comparison is part of an operand", () => {
  assertEquals(shown("if (a >= 1 || b <= 2 || c != 3) {\n}\n", [1]), [
    "a >= 1",
    "b <= 2",
    "c != 3",
  ]);
});

Deno.test("chain operator - a bracketed || does not split an && chain", () => {
  assertEquals(shown("return a && [b || c].length;\n", [1]), [
    "a",
    "[b || c].length",
  ]);
  assertEquals(shown("return [b || c].length && d;\n", [1]), [
    "[b || c].length",
    "d",
  ]);
});

Deno.test("chain operator - a braced || does not split an && chain", () => {
  assertEquals(shown("return a && { b: c || d }.e;\n", [1]), [
    "a",
    "{ b: c || d }.e",
  ]);
  assertEquals(shown("return { b: c || d }.e && f;\n", [1]), [
    "{ b: c || d }.e",
    "f",
  ]);
});

Deno.test("chain operator - a single & or | is not a chain operator", () => {
  assertEquals(shown("return a & b && c;\n", [1]), ["a & b", "c"]);
  assertEquals(shown("return a | b || c;\n", [1]), ["a | b", "c"]);
});

Deno.test("chain operator - a string operand alone gets no mutant but its sibling does", () => {
  assertEquals(shown('return "x" || b;\n', [1]), ["b"]);
});

Deno.test("chain operator - a trailing operator leaves no blank operand", () => {
  assertEquals(shown("if (\n  a ||\n  b ||\n) {\n}\n", [2]), ["a"]);
});

Deno.test("operand region - == and === are comparisons, not assignments", () => {
  assertEquals(shown("if (a === 1 || b == 2) {\n}\n", [1]), [
    "a === 1",
    "b == 2",
  ]);
});

Deno.test("chain operator - a parenthesised || does not split an && chain", () => {
  assertEquals(shown("return a && (b || c) && d;\n", [1]), [
    "a",
    "(b || c)",
    "d",
  ]);
});

// ---------------------------------------------------------------------------
// Bracket balance and edge operators (Issue #3901)
// ---------------------------------------------------------------------------

/** `(`, `[`, `{` open and `)`, `]`, `}` close; balanced when none close early and all close. */
function bracketsBalanced(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** The 1-based numbers of every line in `source`. */
function everyLine(source: string): number[] {
  return Array.from({ length: source.split("\n").length - 1 }, (_, i) => i + 1);
}

Deno.test("generateDenoMutants - every operand mutant keeps its brackets balanced", () => {
  const sources = [
    "foo(a || b);\n",
    " (s.code !== 0 && s.code !== 2)\n",
    "if (\n  !s.ok ||\n  (s.code !== 0 && s.code !== 2)\n) {\n}\n",
    "for (const x of y) if (a || b) z();\n",
  ];
  for (const source of sources) {
    const mutants = generateDenoMutants(
      FILE,
      source,
      everyLine(source),
      DEFAULT_MUTANT_CAP,
    ).filter((m) => m.description.startsWith("dropped operand"));
    for (const m of mutants) {
      const changed = m.mutatedSource.split("\n")[m.line - 1] ?? "";
      assert(bracketsBalanced(changed), `${m.description}: ${changed}`);
      assert(bracketsBalanced(m.mutatedSource), m.description);
    }
  }
});

Deno.test("generateDenoMutants - a chain cut inside a call or a for head gets no operand mutant", () => {
  assertEquals(operandMutants("foo(a || b);\n", [1]), []);
  assertEquals(
    operandMutants("for (const x of y) if (a || b) z();\n", [1]),
    [],
  );
});

Deno.test("generateDenoMutants - a wrapped group line alone gets no operand mutant", () => {
  assertEquals(operandMutants(" (s.code !== 0 && s.code !== 2)\n", [1]), []);
});

Deno.test("generateDenoMutants - a wrapped group after || is one operand replaced with false", () => {
  const source = "if (\n  !s.ok ||\n  (x !== 0 && x !== 2)\n) {\n}\n";
  assertEquals(operandMutants(source, [2, 3, 4]), [
    {
      line: 2,
      text: "  false ||",
      description: "dropped operand `!s.ok` (replaced with false)",
    },
    {
      line: 3,
      text: "  false",
      description:
        "dropped operand `(x !== 0 && x !== 2)` (replaced with false)",
    },
  ]);
  assertEquals(operandMutants(source, [4]), []);
  const group = generateDenoMutants(FILE, source, [3], DEFAULT_MUTANT_CAP)
    .find((m) => m.description.startsWith("dropped operand"));
  assertEquals(group?.mutatedSource, "if (\n  !s.ok ||\n  false\n) {\n}\n");
});

// ---------------------------------------------------------------------------
// Recovery comment: the dropped operand is named (Issue #3901)
// ---------------------------------------------------------------------------

Deno.test("buildMutationGateComment - a surviving operand mutant names the dropped operand", () => {
  const mutant = generateDenoMutants(
    FILE,
    "const ok = a || b;\n",
    [1],
    DEFAULT_MUTANT_CAP,
  ).find((m) =>
    m.description.startsWith("dropped operand") && m.description.includes("`b`")
  );
  assert(mutant !== undefined, "no dropped operand `b` mutant was generated");
  const verdict: MutationGateVerdict = {
    blocked: true,
    reason: "survivors",
    survivors: [mutant],
    exempted: [],
    budgetExhausted: false,
    note: "",
  };
  const comment = buildMutationGateComment(verdict);
  assert(comment.includes("dropped operand b (replaced with false)"), comment);
  assert(comment.includes("lib/sample.ts:1"), comment);
});
