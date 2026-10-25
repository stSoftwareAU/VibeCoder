// The language-aware lexer in doc_prose_scope.ts still runs on source a pull
// request changes (sourceProseLines, sourceStringLiterals). These cases used
// to live beside the removed-assertion gate. That gate is gone (Issue #4234);
// the lexer is not, so the growth and regex-versus-division cases stay here.
// Uses Australian English throughout.

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  sourceProseLines,
  sourceStringLiterals,
} from "../lib/doc_prose_scope.ts";
import { assertLinearGrowth } from "./support/growth.ts";

const PATH = "worker/deno/lib/example.ts";

function lex(source: string) {
  return {
    prose: sourceProseLines(source, PATH),
    literals: sourceStringLiterals(source, PATH),
  };
}

Deno.test("growth: one long line of open brackets and quotes stays linear", () => {
  assertLinearGrowth(
    "source lexer long-line scan",
    (chars) => "const x = " + "([{'\"`".repeat(Math.ceil(chars / 6)) + ";\n",
    (input) => lex(input),
    { baseChars: 20_000 },
  );
});

Deno.test(
  "growth: a long wrapped head and many template substitutions stay linear",
  () => {
    assertLinearGrowth(
      "source lexer wrapped-head scan",
      (chars) =>
        "if (\n" + "  a &&\n".repeat(Math.ceil(chars / 40)) + ") {\n" +
        "  `${`${x}`}` && keep(x);\n".repeat(Math.ceil(chars / 40)) + "}\n",
      (input) => lex(input),
      { baseChars: 20_000 },
    );
  },
);

Deno.test("regex: a regex literal holding a backtick does not hide the lines below", () => {
  const source = [
    "function words(text: string): string[] {",
    "  return text.replace(/[*_`" + ">]/" + 'g, " ");',
    "}",
    'const visible = "after the regex";',
    "",
  ].join("\n");
  const { prose, literals } = lex(source);
  assertEquals(prose.unterminatedFrom, -1);
  assert(
    prose.lines.some((line) => line.code.includes("const visible")),
    "the line after the regex is still code",
  );
  assert(literals.some((literal) => literal.text === "after the regex"));
  assertFalse(
    literals.some((literal) => literal.text.includes("const visible")),
  );
});

Deno.test("no flag: a division is not lexed as a regex literal", () => {
  // `total / 2` follows an operand, so the `/` is division. Lexing it as a
  // regex would blank `/ 2; const note = ` and open the backtick below.
  const source = [
    "function half(total: number): number {",
    "  const value = total / 2; const note = `/" + "`;",
    "  return value;",
    "}",
    "",
  ].join("\n");
  const { prose, literals } = lex(source);
  assertEquals(prose.unterminatedFrom, -1);
  assert(
    prose.lines.some((line) => line.code.includes("return value")),
    "the line after the division is still code",
  );
  assert(literals.some((literal) => literal.text === "/"));
  assertFalse(
    literals.some((literal) => literal.text.includes("return value")),
  );
});
