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

- `cd worker/deno && deno task test:unit tests/mutation_gate_operands_3901_test.ts tests/mutation_gate_test.ts < /dev/null` gives `ok | 122 passed | 0 failed` (73 tests in the new file, 49 in `mutation_gate_test.ts`).
- A local harness applied the mutants `generateDenoMutants` makes for the new
  code (`worker/deno/lib/mutation_gate.ts` lines 764-1121) and ran both test
  files against each. The earlier run reported 127 mutants, all red except the
  one exempted below. That count, and the 112-test figure from before the
  mutation-pinning tests, cannot be reproduced from the repository, so they are
  not relied on here.
- Dead code removed where a mutant showed it unreachable: the redundant
  `exprDepths.length > 0 &&` (an empty stack reads `undefined`, never equal to
  a depth), `nx === ">" ||` (the next clause already catches `=>`),
  `m.charAt(i + 2) !== "="` (a `||=` is rejected by the earlier scan) and the
  `s < e` / `e > s` trim guards (replaced by `trimStart`/`trimEnd`).

Docs sweep — grep: `Drop one operand`, `Swap booleans`, "dropped operand", "flip each operand", `negated if condition`; section: `docs/mutation-check.md#built-in-deno-mutations`; siblings: `Delete an object property`, `Delete an array element`, `Revert a property value` (the #3601 wiring kinds); updated: `docs/mutation-check.md` (new `Drop one operand` table row and its explanatory paragraph). `CODING-STANDARDS.md` "flip each operand" and the wiring-revert sentence were read through and stay true; they describe the agent's duty, which the gate now backs mechanically.

## Test Plan

- Added `worker/deno/tests/mutation_gate_operands_3901_test.ts`: single-line `||`/`&&`, wrapped `if (`, leading/trailing operator, `return`, ternary, mixed and nested chains, strings/templates/regex/comments, types, `||=`/`&&=`, arrows, truncation and backtick escaping, the cap and order, open comment/template files, the region boundaries (`,`, `:`, `?`, `??`, `?.`, `+=`, `==`) and exact-output tests of every `maskedLines` branch.
- Added to `worker/deno/tests/mutation_gate_operands_3901_test.ts`, the `else if` and `while` forms of item 1: `generateDenoMutants - operand of an else if condition is mutated`, `generateDenoMutants - operand of a while condition is mutated` and `generateDenoMutants - operand of a wrapped while is mutated on each line`. Each asserts the exact mutated line and the `dropped operand` description.
  Red-check: `while` removed from `OPERAND_PREFIX` → the two `while` tests red; `else\s+` removed from `OPERAND_PREFIX` → the `else if` test red (both restored afterwards).
- Added to the same file: `buildMutationGateComment - a surviving operand mutant names the dropped operand`, which asserts the comment names `dropped operand b (replaced with false)` and `lib/sample.ts:1`.
  Red-check: renders the comment without the operand text (description built without `${shown}`) → red; `buildMutationGateComment` omitting the description → red.
- Removed from `worker/deno/tests/mutation_gate_test.ts`: `assertEquals(rest.length, 0);`
  Required by: "make one mutant per operand"
  Replaced by: ``assertEquals(rest.map((r) => r.description), [ "dropped operand `a` (replaced with true)", "dropped operand `b` (replaced with true)", ]);``
  (the same test now lists the two dropped-operand descriptions that follow the if negation).
- Removed from `worker/deno/tests/mutation_gate_test.ts`: `assertEquals(mutate("if (a &&\n  b) {\n}\n", [1]), []);`
  Required by: "operand line then gets its mutant, even when the"
  Replaced by: `assertEquals( mutate("if (a &&\n  b) {\n}\n", [1]).filter((x) => x.description === "negated if condition" ), [], );`
  (the wrapped if still gets no negation mutant; its first operand now gets a dropped-operand mutant).

<!-- vibe-branch-outcomes -->

## Acceptance Criteria

Drawn from the issue body's proposal items 1-5 and its list of required tests.

- [x] Item 1, drop one operand at a time: one mutant per top-level operand, replaced with the chain identity. Covered for single-line `||` and `&&` (tests at lines 54 and 69), `if` (107), `return` (199), ternary (214) and boolean assignment (54).
- [x] Item 1, `else if` and `while` conditions: tests at lines 123 (`else if`), 138 (`while`) and 153 (wrapped `while`).
- [x] Item 2, reach wrapped conditions via the line's own or neighbouring operator: tests at lines 107, 153, 168 and 184.
- [x] Item 3, nested groups: only top-level operands are dropped; operand mutants come after the other kinds under the cap: tests at lines 244 and 343.
- [x] Item 4, the recovery message names the operand: test at line 704.
- [x] Item 5, required tests:
  - [x] single-line `||` and `&&`: lines 54, 69.
  - [x] wrapped `if (` where only one operand line is added: line 184 (the `[2]` case at line 186).
  - [x] boolean `const` split across lines: lines 168, 184.
  - [x] nested `a || (b && c)`: line 244.
  - [x] `||` or `&&` in a string, template literal or comment is never mutated: lines 260, 275, 283, 287, 291.
  - [x] type-only line is never mutated: line 299.
  - [x] recovery message naming the operand: line 704.

## Standards Review

- Red-check: the comment test was recorded as red when the description is built without the operand text, and when `buildMutationGateComment` omits the description (see Test Plan).
- Per-operand outcomes: each operand of a chain has its own outcome and named test in `docs/archive/pr-summaries/pr-summary-3901.facts.json` (`noneAdded: false`). The one exemption is at `worker/deno/lib/mutation_gate.ts:790`: the initial `inClass = false` is overwritten before any read, so it is an equivalent mutant. Removing the initial assignment is the alternative to exempting it, and a reviewer should decide which.
- `maskedLines` is exported so the tests can pin its exact output. Production calls it at `worker/deno/lib/mutation_gate.ts:1081`.
- Docs: `docs/mutation-check.md` is updated with a new `Drop one operand` row and paragraph. Its `else if` and `while` claims are backed by the three tests named in the Test Plan.
- Regex vetting: four new regexes, at `worker/deno/lib/mutation_gate.ts` lines 775-776 (`OPERAND_PREFIX`), 896 (`/\s/`) and 915-916. None has nested or overlapping quantifiers on reading. `OPERAND_PREFIX` (used at line 961) and `/\s/` (line 896) run on the added line or one character at a time, and the added line is length-checked against `MAX_MUTATED_LINE_LENGTH` (line 71, 400 characters) at line 1093. The two regexes in `sourcedOperator` (lines 915-916) run on the neighbouring masked lines (`masked[n - 2]`, `masked[n]`), which are not length-checked; one is anchored at the start and the other has a single `$`-anchored alternation with no quantifier, so each scans linearly. No per-pattern hostile test exists; the closest is the hostile long-line test at `worker/deno/tests/mutation_gate_test.ts:289`.
- Shared helper callers: `generateDenoMutantsDetailed` has one production caller, `worker/deno/lib/mutation_runner.ts:341`. `generateDenoMutants` is a wrapper used only by tests.
- Twinned rules: "flip each operand" also appears in `prompts/coding_guidelines/prompt.md`. This PR does not change that rule, so no twin edit is made.
- Persisted data shape: no change.
- Tooling: Deno-native only (`deno task`); no new dependencies.
- Secrets: none added.

## Merge verification

Final-head hosted checks and independent GitHub approval remain required.
