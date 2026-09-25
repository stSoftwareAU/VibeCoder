# Quiet reporter on every raw CI `deno test` (Issue #2608)

## Summary

Closes #2608.

The quality gate's own test passes are quiet on green (`TEST_REPORTER_FLAG =
"--reporter=dot"`, Issue #2430), but three CI steps called `deno test` /
`deno task test` directly without it, so a green PR logged one line per test
there:

- `markdown-lint.yml`: the `threat_model_docs_test.ts` step;
- `container-build.yml`: the in-image `deno task test` over the seven
  container suites, and the containment `deno test`.

Each now passes `--reporter=dot`. A new test,
`workflow_test_reporter_2608_test.ts`, reads every workflow, joins
`\`-continued commands, and fails on any raw `deno test` / `deno task test`
without `TEST_REPORTER_FLAG`, so a new step cannot drift from the convention.
`deno task test:unit` / `test:integration` already go through
`unit_test_runner.ts` and are not raw calls.

## Acceptance Criteria

The issue is a best-practices finding with no criteria block. Delivered:

- **met**: both raw invocations named in the issue carry `--reporter=dot`, along with a third in the same file. Evidence: `.github/workflows/markdown-lint.yml`, `.github/workflows/container-build.yml`.
- **met**: the convention is pinned for every workflow. Evidence: `workflows - every raw deno test runs with the quiet reporter (Issue #2608)`, which failed first naming exactly the three calls; `noisyTestCalls - catches single-line and continued commands, ignores the runner tasks and comments`.

## Test Plan

- The new tests: 2 passed, in 3 ms.
- The 14 unit test files that read these workflows: 201 passed, 0 failed.
- `actionlint` is clean on both workflows. `deno task test --reporter=dot <files>` prints dot output as expected.
