# Diff-scoped mutation check (retired)

## What it did

Until Issue #5095 the worker ran a diff-scoped mutation check at the end of an
issue run, before the pull request was raised, and in the post-agent drift check
on review-fix (PR feedback) runs. It mutated only the lines a change added or
changed, re-ran the tests that covered them, and treated a surviving mutant as
behaviour that no test pinned.

## Retired by Issue #5095

Issue [#5095](https://github.com/stSoftwareAU/VibeCoder/issues/5095) retired the
automatic check on 12 November 2026. The owner removed automatic mutation testing
from the ordinary feature and repair workflow. Test adequacy is assessed during
implementation and code review, and existing deterministic tests give regression
protection. A newly discovered bug gets a failing regression test before its fix.
Mutation testing, fuzzing and broader test discovery happen only in a separately
requested investigation (see [Testing scope](../CODING-STANDARDS.md#test-driven-development-tdd)).

The worker ships no standalone mutation command. The earlier behaviour, and
Issues #3393, #4234, #4617 and #3750 that shaped it, are in the git history of
this file.

## What runs instead

There is no automatic replacement. The checks that still run are:

- the quality gate (lint, unit tests, markdownlint, mermaid and the other
  configured stages);
- the pre-PR verifier;
- the coverage carry-over gate (Issue #3795), which runs in the issue-run
  completion phase and still accepts the PR-summary exemption syntax (see
  [Coverage carry-over check](coverage-carryover-check.md));
- the security-fix discrimination check.

A repository whose own CI runs mutants still runs them in that CI. The worker
neither bypasses that job nor reports it as passed.

## Retired configuration keys

The `.config.json` `repo_config` keys `skip_mutation_check` and
`mutation_check_budget_seconds` (and their camelCase spellings `skipMutationCheck`
and `mutationCheckBudgetSeconds`) are no longer read. A config that still carries
them loads, and the worker logs one warning naming the retired key. Remove the
keys from the repository's `.config.json`.

## Container

The worker container image no longer installs `cargo-mutants`.

## Issue #5078 and the narrow cleanup fix

Issue #5078 reported ENOTEMPTY when the mutation temporary-directory cleanup raced
a writer. It was closed as superseded by this retirement.

The same fault remained in the security-fix discrimination check, which keeps its
temporary clone in `worker/deno/lib/security_fix_discrimination.ts`. Its `finally`
block removes that directory. This change fixed it narrowly: a cleanup failure is
now ignored, so it no longer turns a completed check into a not-checked result.
The coverage carry-over check already ignored cleanup errors.

The modules `mutation_runner.ts`, `mutation_gate.ts` and `ci_mutation_contract.ts`
keep only shared helpers, such as the runner seams, `isDenoTestFile`,
`parseMutationExemptions`, `mdSafe` and the workflow-parsing helpers that
`ci_cargo_checks` uses. None of them runs a mutation check.
