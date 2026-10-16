# Coverage carry-over check

The coverage carry-over check is a PR-raise gate (Issue #3795). It checks that
the production lines a removed or rewritten test used to execute are still
executed by some test on the branch, and blocks the PR when a carried line is
not.

## Why

A fleet PR that rewrites or deletes a test the linked issue retires sometimes
leaves a branch whose only test was that test. The removed-assertion gate checks
the stated reason for each removed assertion, and the mutation check mutates only
the lines a PR adds or changes. The orphaned lines are unchanged, so neither gate
looks at them, and the branch can ship with no test reaching them. The target
pattern is `rewritten-test-drops-live-branch`.

## When it runs

The gate runs in the issue-run completion phase, beside the mutation check:
after the PR summary is final and before the PR is raised. It joins the late
summary gates and feeds the same single recovery turn, which may change tests.

It runs only when the PR diff deletes an existing Deno test file (`*_test.ts`,
`*.test.ts` and similar) or removes at least one line from one. Pure additions
to tests do not trigger it.

## Flow

```mermaid
flowchart TD
    A["PR summary final"] --> B{"skip_coverage_carryover_check?"}
    B -- yes --> Z["Raise PR"]
    B -- no --> C{"PR deletes or removes a line from a Deno test file?"}
    C -- no --> N["Not applicable: log the reason"]
    N --> Z
    C -- yes --> D["Base: merge-base worktree, run removed or edited tests with coverage"]
    D -- "runner error" --> X["Block (fail closed)"]
    D -- "budget exhausted" --> W["Warn: carried lines not verified"]
    D --> E["Head: run importing tests and edited head tests with coverage"]
    E -- "runner error" --> X
    E -- "budget exhausted" --> W
    E --> F{"Unexempted carried line not executed at head?"}
    F -- yes --> X
    F -- no --> Z
    W --> Z
    X --> R["Recovery turn: add a test reaching each file:line, remove dead code, or exempt it"]
    R --> A
```

## Steps

1. Run `git merge-base <base> HEAD` and check out the merge base in a temporary
   detached `git worktree`.
2. Run only the removed or edited test files, at their base versions, with
   `deno test --no-check -A --coverage=<dir>` from their Deno project directory,
   then `deno coverage --lcov`. Collect the non-test production lines they
   executed.
3. Map each line through `git diff --unified=0 --no-renames <base>...HEAD`. A
   line deleted or rewritten at head is out of scope.
4. At head, run per Deno project the tests that import a carried file directly,
   plus the head versions of the edited tests, with coverage.
5. Block when a carried line is not executed at head. The block lists each
   `file:line` and asks for a test that reaches it, removal if it is dead code,
   or an exemption in the PR summary.

The temporary worktree is removed afterwards with `git worktree remove --force`.
If that fails, the directory is deleted and `git worktree prune` runs.

## Languages

Only Deno is checked. For a Rust repository the gate is not applicable and logs
`Rust coverage carry-over needs cargo-llvm-cov, which the worker container does
not install`. Rust repositories are not checked yet.

## Outcomes

| Outcome                  | Meaning                                                                                 | Blocks the PR? |
| ------------------------ | --------------------------------------------------------------------------------------- | -------------- |
| Not applicable           | No removed or edited Deno test file, or a Rust repository; logged                       | No             |
| Completed, no uncovered  | Every carried line is executed at head, or is exempted                                  | No             |
| Completed, uncovered     | At least one carried line is not executed at head and is not exempted                   | Yes            |
| Budget exhausted         | The fixed 600 s budget ran out; a warning, never a pass                                 | No             |
| Error                    | Runner failed: merge-base, worktree, base or head tests failing, or coverage export     | Yes (fail closed) |

## Exemption

A carried line that no test can reasonably reach may be exempted by a PR-summary
line naming the location and giving a reason, in the same convention as the
mutation check:

```text
- `worker/deno/lib/example.ts:42` — exempt (untestable): <reason>
```

## Configuration

Set `skip_coverage_carryover_check` (boolean, default `false`) under
`repo_config["owner/repo"]` in `.config.json`. `true` skips the check for that
repository. There is no budget setting; the budget is fixed at 600 seconds
(`DEFAULT_COVERAGE_CARRYOVER_BUDGET_SECONDS`).

The test runs receive the repository's resolved `quality_credentials`, the same
credentials the mutation check passes (see [Configuration](CONFIGURATION.md)).

## Known limits

- The head side counts only tests that import a carried module directly, plus
  the head versions of the edited tests. A line reached only indirectly, through
  another module, is reported uncovered. Exempt it with a reason.
