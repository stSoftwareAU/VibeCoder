# PR Summary — Issue #4997

## Summary

The TypeScript/React compile-gate suggestion was the unquoted glob
`deno check **/*.ts`. In a GitHub Actions bash `run:` step (no `globstar`),
bash expands that to files exactly one directory deep before Deno sees it, so
a repository that followed the suggestion got a compile gate that skipped most
of its files. All three places that suggest the command now suggest
`deno check .`, which needs no shell glob. Closes #4997.

- `worker/deno/lib/language_validity_gate.ts` — `suggested` for `typescript`
  and `react`.
- `worker/deno/lib/linter_in_ci_check.ts` — the ESLint path's
  `compileMissingPhrase`.
- `worker/deno/lib/idle_task_templates/best_practices_template.ts` —
  `COMPILE_GATE_COMMANDS` for `typescript` and `react`, rendered in the
  `BP-LINTER-<bucket>` finding's "Suggested fix".

## Spec

### Intent and Rationale

- The issue offered either `deno check '**/*.ts'` or `deno check .`.
  `deno check .` was chosen: there is no glob to quote or misquote in any
  shell, and it also type-checks `.tsx` files, which matters for the React
  bucket and which `**/*.ts` never matched.

### Essential Design Decisions

- The suggested command still satisfies the detector it is meant to clear:
  `COMPILE_GATE_PATTERNS.typescript` / `.react` match `deno\s+check\b`, so a
  repository that adds `deno check .` is reported as having the gate.
- The test fixtures that contain `deno check **/*.ts` as workflow content were
  left as they are: they model CI that already exists, and detection must keep
  recognising it.

### Undiscoverable Facts

- Observed in this run (Deno 2.9.8, bash). In a directory holding `main.ts`,
  `src/app.ts` and `src/lib/util.ts`, `bash -c 'echo deno check **/*.ts'`
  printed `deno check src/app.ts`. The unquoted command checked only
  `src/app.ts` and passed, even though `src/lib/util.ts` had a type error.
- In the same directory, `deno check .` checked `main.ts`, `src/app.ts`,
  `src/lib/util.ts` and `src/lib/view.tsx`, and failed on their errors.

## Evidence

This is a backend/CLI-only change: no UI file is touched. Each new test was
observed failing against the unfixed text, then passing after the fix.

- `language_validity_gate_test.ts` was red with `Expected actual: "… Add a step
  such as \`deno check **/*.ts\` … to contain: \"\`deno check .\`\""`, then
  passed (25 passed, 0 failed).
- `linter_in_ci_check_test.ts` was red with `… add a step such as
  \`deno check **/*.ts\` … to contain: \"\`deno check .\`\"`, then passed
  (47 passed, 0 failed).
- `best_practices_template_test.ts` was red with `FAILED | 67 passed | 2
  failed`, because the filed body read `(\`deno check **/*.ts\` OR
  \`npx tsc --noEmit\`)`. It then passed (69 passed, 0 failed).
- `./quality.sh < /dev/null` passed on the head commit, with two checks
  skipped by the host environment. "config integration" was skipped because
  deno or `.config.json` was not available. "checkov" was skipped because no
  checkov binary or image was available; the CI checkov job stays
  authoritative.

`#2175` and `#2177` already appeared in the edited code and tests. This diff
adds only `#4997`, cited as provenance:

- #4997: Suggested TypeScript compile-gate command `deno check **/*.ts` is
  unquoted, so in a GitHub Actions bash step it type-checks only files exactly
  one directory deep

## Test Plan

Every test exercises its real public entry point. The text each test asserts
on is the only text that contains the suggestion, and none of the test inputs
contains `**`. So the "no shell glob" assertion fails whenever the suggestion
carries the glob.

- Added `worker/deno/tests/language_validity_gate_test.ts::typescript/react #4997 — suggested compile gate uses no shell glob`.
  It drives `checkLanguageValidityGates` for both TypeScript and React repos
  with no compile gate. It asserts `present === false`, that `details`
  contains `` `deno check .` ``, and that `details` contains no `**`.
- Added `worker/deno/tests/linter_in_ci_check_test.ts::typescript/react #4997 — compile-missing suggestion uses no shell glob`.
  It drives `checkLinterInCI` for `typescript` and `react` with ESLint
  configured but no compile step. It asserts `gates.compile === false`, that
  `details` contains `` `deno check .` ``, and that `details` contains no
  `**`.
- Added `worker/deno/tests/best_practices_template_test.ts::runTask - #4997 typescript compile gate suggestion uses no shell glob`
  and the matching `react` test. They drive `createBestPracticesTemplate(...)
  .runTask` and read the filed issue. They assert that the body contains
  `` `deno check .` `` and `` `npx tsc --noEmit` `` and contains no `**/*`.
- No existing assertion was removed or edited.
- I swept the docs (excluding `docs/archive/`), `prompts/` and the workflows
  for `deno check **`, and found no other suggestion to change. The rows in
  `docs/BEST-PRACTICES-SCAN.md` and `docs/BASH-SYNTAX-AUDIT-SCAN.md` name only
  `deno check` with no glob, so they stay true.
- `./quality.sh < /dev/null` passed (two host-environment skips, as listed
  under Evidence).

Not checked: none.
