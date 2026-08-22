# PR Summary — Issue #275

## Summary

`git_ref_argv_check.ts` is the CI tripwire for Issue #12's shape: a git command
that takes an attacker-controlled ref as a bare positional, so a dash-leading PR
head branch is parsed as an option rather than a refspec (CWE-88). It guarded
`fetch`, `pull` and `checkout` — and nothing else.

That is why the gate was silent on both of its sibling findings in this
milestone. #267's `pr_ci_nudge` pushed a GitHub-controlled PR head branch as a
bare positional and the gate saw nothing, because `push` was excluded outright —
`git_ref_argv_check_test.ts` even asserted `["push", "origin", branchName]` was
*clean*. `rebase` was worse: it was named in the module contract and had a
`buildRebaseArgs` builder, but was missing from the pattern, so the
documentation promised a gate that did not exist.

This adds `push` and `rebase` to the guarded verbs.

**Three live violations surfaced immediately** — a gate is not a gate while real
code trips it, so they are fixed here rather than allowlisted:

| Site | Was |
| --- | --- |
| `git_push_lease_args.ts:31` | `["push", "origin", branchName, lease]` |
| `git_pull.ts:728` | `["push", "origin", branchName, "--force-with-lease"]` |
| `git_push_recovery.ts:164` | `["push", "origin", branchName]` |

All three now route through `buildPushArgs`, which validates the ref with
`assertSafeGitRef` and places `--end-of-options` before the first positional.
The lease path needed `buildPushArgs` to learn a `forceWithLease` option,
because the flag has to sit **ahead** of the separator: everything after
`--end-of-options` is a positional, so the old trailing `--force-with-lease`
would have reached git as a third refspec. The repo-wide scan now reports
**0 violations across 721 files**.

**The pattern itself was restructured.** It had tried to express "not
builder-shaped" as a lookahead for `--end-of-options` in the slot immediately
after the verb. That cannot survive `push`: `buildPushArgs` emits
`["push", "-u", "--end-of-options", …]`, so a flag legitimately sits between the
verb and the separator, and the lease form interpolates the branch name *into*
that flag ahead of it. Both safe arrays would have been reported as violations.
It now matches the whole array literal and applies two plain predicates —
`--end-of-options` anywhere in the array means the author used the builders and
the array is safe; otherwise an attacker-controlled identifier makes it a
violation. `[^\]]` spans newlines, so the multi-line evasion from #268 is caught
by the same expression and the separate line-local pass is gone.

Closes #275.

## Evidence

Backend/CI change with no web interface, so there is no screenshot to capture.

**The new tests fail against the unfixed tree.** On
`origin/milestone/193-security-scan-overflow-4-unfiled-findings`, `push` and
`rebase` are not guarded verbs, so `scanContentForGitRefArgv` returns `[]` for
the #267 and #268 push shapes and every new assertion fails.

**The gate finds the three real violations before the fix:**

```text
$ deno run --allow-read scan.ts     # scanDirectoriesForGitRefArgv over the repo
filesScanned 721 violations 3
 worker/deno/lib/git_push_lease_args.ts:31  return ["push", "origin", branchName, lease];
 worker/deno/lib/git_pull.ts:728  ["push", "origin", branchName, "--force-with-lease"],
 worker/deno/lib/git_push_recovery.ts:164  ["push", "origin", branchName],
```

**And none after it:**

```text
filesScanned 721 violations 0
```

**Scanner suite:**

```text
$ deno test --allow-all tests/git_ref_argv_check_test.ts
scanner - flags an inline fetch/checkout/pull/rebase ref ... ok
scanner - the builder-shaped array is not a violation ... ok
scanner - non-ref git verbs are ignored ... ok
scanner - flags an unguarded push of a PR head branch (Issues #267, #275) ... ok
scanner - flags a multi-line push argv (Issues #267, #268, #275) ... ok
scanner - flags an unguarded rebase onto a PR head branch (Issue #275) ... ok
scanner - a builder-shaped push with a flag before the separator is clean (Issue #275) ... ok
scanner - safe internal refs stay out of scope for push and rebase (Issue #275) ... ok
scanner - a comment naming the pattern is not a violation ... ok
scanner - flags a multi-line fetch argv (Issue #268) ... ok
the real lib/commands tree routes every ref through the builders (Issue #12) ... ok
only the builders file is allowlisted ... ok

ok | 12 passed | 0 failed (473ms)
```

**No regression in the push/pull/ref suites** — 12 files, including
`git_push_test.ts`, `git_push_recovery_test.ts`, `git_push_preflight.ts`,
`git_pull_conflict_test.ts` and `git_ref_args_integration_test.ts`:

```text
ok | 93 passed | 0 failed
```

Two of those tests asserted the old lease argv order and were updated — that
order is precisely the bug: the branch name preceded the lease flag as a bare
positional. A third case was added asserting `buildForceWithLeaseArgs` now
*throws* on `--upload-pack=evil`, which is the guarantee the separator alone
does not give.

## Test plan

`worker/deno/tests/git_ref_argv_check_test.ts` — 5 new cases, 1 rewritten:

| Case | Asserts |
| --- | --- |
| flags an unguarded push of a PR head branch | The #267 shape is now a violation |
| flags a multi-line push argv | The #268 evasion applied to a push |
| flags an unguarded rebase onto a PR head branch | Closes the doc/behaviour gap |
| a builder-shaped push with a flag before the separator is clean | `-u` and `--force-with-lease=<branch>:<sha>` forms are not false positives — the case the old lookahead failed |
| safe internal refs stay out of scope for push and rebase | `defaultBranch` / `baseBranch` / `milestoneBranch` remain out of scope; this is CWE-88, not a blanket ban |
| *(rewritten)* non-ref git verbs are ignored | `["push", "origin", branchName]` removed from the safe list — it is now the violation the issue asks for; `git remote set-url` took its place |

`worker/deno/tests/git_push_recovery_lease_test.ts` — 2 updated, 1 added:

| Case | Asserts |
| --- | --- |
| pins the lease to the captured baseline *(updated)* | `["push", "--force-with-lease=feature:<sha>", "--end-of-options", "origin", "feature"]` |
| falls back to the bare lease with no baseline *(updated)* | Same ordering with the bare flag |
| refuses a dash-leading branch name *(new)* | `assertSafeGitRef` rejects `--upload-pack=evil` before an argv exists |

Acceptance criteria from the issue:

- *Teach the scanner multi-line array literals* — already landed in #268; the
  restructure keeps it and removes the now-redundant second pass, covered by
  `flags a multi-line push argv` and the retained `flags a multi-line fetch
  argv`.
- *Include `push`* — done, plus `rebase`, which the contract already claimed.
- *Regression tests that fail on the #267 / #268 shapes* — the first two cases
  above.
