# Operand-level mutants in the diff-scoped Deno mutation gate

Closes #3901.

## Summary

The built-in Deno mutator only negated a whole `if` or ternary condition, so an
untested operand of a compound condition survived the gate: the tested operand
killed the whole-condition mutant, a wrapped `if (` produced no mutant on its
operand lines, and a boolean `const` produced none at all. The mutator now
makes one `dropped operand` mutant per top-level operand of a `||` or `&&`
chain on an added line, replacing that operand with the chain identity (`false`
for `||`, `true` for `&&`). It covers `if`, `else if` and `while` conditions,
ternary conditions, `return` expressions and boolean assignments, and reaches
wrapped conditions by taking the operator from the line's own or neighbouring
trailing or leading `||`/`&&`. Operands inside strings, templates, comments and
regex literals, type unions and `||=`/`&&=` are never mutated. The mutants
count towards the existing 40-mutant cap, after the other kinds on each line.

## Spec

### Intent and Rationale

- Deleting one operand of an added compound condition must turn a test red, so
  an untested operand is caught before the PR is raised, not in review.

### Essential Design Decisions

- Replace the operand with the chain identity rather than deleting text, so
  the mutant stays parseable and a wrapped operand line (`a ||`) still works.
- A comment/literal-aware line mask (`maskedLines`) decides what is code, so a
  `||` in a string, template, comment or regex is never mutated.
- Only top-level operands are dropped; a group `(b && c)` is one operand.

### Undiscoverable Facts

- A mutant of `maskedLines` itself is only noticed by an exact-output test of
  the mask, because the operand mutants read it indirectly.

## Evidence

- `deno test --no-check -A worker/deno/tests/mutation_gate_operands_3901_test.ts worker/deno/tests/mutation_gate_test.ts` passes (112 tests before the
  mutation-pinning tests, 127 mutants of the new code afterwards).
- A local harness applied every mutant `generateDenoMutants` makes for the new
  code (`worker/deno/lib/mutation_gate.ts` lines 779-1040, 127 mutants, no cap)
  and ran both test files against each: all 127 went red except the one
  exempted below.
- Dead code removed where a mutant showed it unreachable: the redundant
  `exprDepths.length > 0 &&` (an empty stack reads `undefined`, never equal to
  a depth), `nx === ">" ||` (the next clause already catches `=>`),
  `m.charAt(i + 2) !== "="` (a `||=` is rejected by the earlier scan) and the
  `s < e` / `e > s` trim guards (replaced by `trimStart`/`trimEnd`).

Docs sweep — grep: `Drop one operand`, `Swap booleans`, "dropped operand", "flip each operand", `negated if condition`; section: `docs/mutation-check.md#built-in-deno-mutations`; siblings: `Delete an object property`, `Delete an array element`, `Revert a property value` (the #3601 wiring kinds); updated: `docs/mutation-check.md` (new `Drop one operand` table row and its explanatory paragraph). `CODING-STANDARDS.md` "flip each operand" and the wiring-revert sentence were read through and stay true; they describe the agent's duty, which the gate now backs mechanically.

## Test Plan

- Added `worker/deno/tests/mutation_gate_operands_3901_test.ts`: single-line `||`/`&&`, wrapped `if (`, leading/trailing operator, `return`, ternary, mixed and nested chains, strings/templates/regex/comments, types, `||=`/`&&=`, arrows, truncation and backtick escaping, the cap and order, open comment/template files, the region boundaries (`,`, `:`, `?`, `??`, `?.`, `+=`, `==`) and exact-output tests of every `maskedLines` branch.
- Removed from `worker/deno/tests/mutation_gate_test.ts`: `assertEquals(rest.length, 0);`
  Required by: "make one mutant per operand"
  Replaced by: ``assertEquals(rest.map((r) => r.description), [ "dropped operand `a` (replaced with true)", "dropped operand `b` (replaced with true)", ]);``
  (the same test now lists the two `dropped operand` descriptions that follow the `if` negation).
- Removed from `worker/deno/tests/mutation_gate_test.ts`: `assertEquals(mutate("if (a &&\n  b) {\n}\n", [1]), []);`
  Required by: "operand line then gets its mutant, even when the"
  Replaced by: `assertEquals( mutate("if (a &&\n  b) {\n}\n", [1]).filter((x) => x.description === "negated if condition" ), [], );`
  (the wrapped `if` still gets no `negated if condition` mutant; its operand `a` now gets a `dropped operand` mutant).

## Branch outcomes

**Branch outcomes:**
- `worker/deno/lib/mutation_gate.ts:784` — masking: block comment, string, template, template expression, regex and code each blanked or opaque; open block comment / template returns null — `worker/deno/tests/mutation_gate_operands_3901_test.ts::maskedLines - a block comment is opaque for its whole length` (and the sibling `maskedLines - ...` tests) — each `buf.push`, mode and brace branch flipped by the local mutant harness, a test went red
- `worker/deno/lib/mutation_gate.ts:790` — exempt (untestable): the initial `inClass = false` is always overwritten when a regex opens (`inClass = false` at the regex start), so no input can observe the initial value; searched `maskedLines - a regex starts with a fresh character class state` and the other `maskedLines` tests
- `worker/deno/lib/mutation_gate.ts:965-995` — operand region ends at an unmatched closer, `;`, `,`, `:`, a ternary `?` (not `??`/`?.`), or an opaque comment; an assignment/arrow returns nothing — `worker/deno/tests/mutation_gate_operands_3901_test.ts::operand region - a call argument line ends at its trailing comma` (and the other `operand region - ...` tests) — flipped each terminator, test went red
- `worker/deno/lib/mutation_gate.ts:1004-1006` and `1027-1030` — a single `&`/`|` is not a split (only a doubled `||`/`&&` is), and a line with no edge operator takes the shallowest-depth operator, `||` preferred — `worker/deno/tests/mutation_gate_operands_3901_test.ts::chain operator - a single & or | is not a chain operator` (and the bracketed/braced/parenthesised variants) — flipped, test went red
- `worker/deno/lib/mutation_gate.ts:1018` and `1031-1033` — no edge operator on the line: sourced from the neighbouring line (`sourcedOperator`), and with no operator at all no mutant — `worker/deno/tests/mutation_gate_operands_3901_test.ts::generateDenoMutants - an operator at the end of the previous line is sourced` — flipped, test went red
- `worker/deno/lib/mutation_gate.ts:1046-1053` — blank or literal-only operand skipped; long operand truncated and backticks replaced — `worker/deno/tests/mutation_gate_operands_3901_test.ts::chain operator - a trailing operator leaves no blank operand` — flipped, test went red
- `worker/deno/lib/mutation_gate.ts:1121` — `masks === null` (unbalanced file, computed at line 1081) disables only the operand kind — `worker/deno/tests/mutation_gate_operands_3901_test.ts::generateDenoMutants - an open template literal at end of file disables only the operand kind` — flipped, test went red

## Merge verification

Final-head hosted checks and independent GitHub approval remain required.
