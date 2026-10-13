## Summary

Adds a shallow-checkout rule to `CODING-STANDARDS.md` and to the injected
coding guidelines (`prompts/coding_guidelines/prompt.md`). The worker clones
every monitored repository with `--depth=1 --no-single-branch`, but none of the
guidance read while implementing an issue said so, and fleet code and tests
kept assuming history that checkout does not have (#2893, #3398 and a private
fleet PR). Closes #3494.

## Spec

### Intent and Rationale

- The guidance agents read while implementing an issue never said the checkout is shallow, so CI with `fetch-depth: 0` hid the mistake until the fleet's own gate or production logic hit it.
- The rule sits beside "Never let a unit test inherit the host's state" in `CODING-STANDARDS.md` (the placement the issue proposed) and at the end of **Testing Best Practices** in the guidelines prompt.

### Essential Design Decisions

- The four bullets are word for word the same on both surfaces, and `worker/deno/tests/shallow_checkout_rule_3494_docs_test.ts` fails if they drift apart.
- The production bullet names `ensureHistoryDepth` and `mergeWithUnshallowRetry` only as the Vibe Coder worker's helpers. The guidelines prompt is sent to other repositories too, so it asks them for "the repository's existing helper".

### Undiscoverable Facts

- The third case in the issue comes from a private fleet repository, so the standard describes it without naming the repository.

## Evidence

Docs and prompt change only, with no backend or UI code. Premises checked against the head:

- `setupRepo` clones with `"--depth=1", "--no-single-branch"` (`worker/deno/commands/git_operations.ts:114-115`).
- `ensureHistoryDepth` (`worker/deno/lib/git_history.ts:119`) and `mergeWithUnshallowRetry` (`worker/deno/lib/git_merge_unshallow_retry.ts:58`) exist and deepen a shallow clone.
- `#2893: security_sweep_2839_ledger_test: shallow-clone guard checks object existence, not reachable history, so the ancestor test fails in grafted fleet worktrees`
- `#3398: Orphan-deps suppression blame runs on the --depth=1 checkout, so markers older than the clone bind to the shallow boundary commit's author`
- `#3494: Fleet code and tests assume git history the worker's --depth=1 checkout does not have (VibeCoder#2893, #3398 and a private fleet PR)`

Related rules checked: **Never let a unit test inherit the host's state** (`CODING-STANDARDS.md`) agrees with the new rule and stays unchanged. A grep of `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md` and `prompts/issue/prompt.md` for `HEAD~`, `merge-base`, `git blame`, `git init`, `is-shallow`, `unshallow` and `fetch-depth` found no other overlapping rule.

Applying the new rule to this PR's own diff found nothing to fix. The only test this PR adds reads Markdown and runs no git command against the checkout.

**Docs sweep** — grep: "shallow", "depth=1", "inherit the host's state", "Rendezvous, never sleep"; section: `CODING-STANDARDS.md#never-assume-history-the-workers-shallow-checkout-lacks`; siblings: "Never let a unit test inherit the host's state", "Rendezvous, never sleep" — no doc lists these testing sections; updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`; `README.md:368` — still true because it describes the worker's own shallow-clone handling, not the rule; `prompts/issue/prompt.md:1047` — still true because it cites the host-state section, which is unchanged

## Test Plan

- Added `worker/deno/tests/shallow_checkout_rule_3494_docs_test.ts`, which has three drift tests:
  - the `CODING-STANDARDS.md` section says why the rule exists;
  - **Testing Best Practices** in the guidelines carries the rule;
  - both surfaces carry the same four bullets.
- Red checks:
  - With both docs restored to `origin/main`, the file fails to load: `no heading containing "Never assume history the worker's shallow checkout lacks"`.
  - With only the guidelines prompt restored to `origin/main`, the second and third tests fail.
  - With one bullet's wording changed in the guidelines only, the "identical" test fails.
- Pin check: `deno task drift-pins-on-base origin/main …` reports every pin in both sections as `absent on base`. That covers the 11 pins in the guidelines' Testing Best Practices section and the 4 pins plus `setupRepo` in the new standards section.
- The new test and the coding-guidelines and standards drift suites pass under `deno task test:unit`: 64 passed, 0 failed.
- `./quality.sh` result is recorded below.
- No existing test was edited.
- Branch outcomes: none added

🤖 Generated with [Claude Code](https://claude.com/claude-code)
