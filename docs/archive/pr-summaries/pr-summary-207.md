# PR Summary — Issue #207

## Summary

`bump_deps.ts` captured the bump script's combined output into `BumpInfo.output`
and then threw it away: `bump_deps_phase.ts` logged only `rejectionReason` and
`files.length`. The worker log said

```text
WARNING: bump-deps: script rejected the bump reason=`bump-deps.sh` exited with status 1 — bump reverted. files=1
```

and nothing more, so an operator could not tell a transient registry error from
a script broken on every run — and a broken script silently disables dependency
bumps for that repo for ever. Both halves of the issue's acceptance criteria are
implemented.

**Surface the output.** `formatBumpOutputTail()` builds a secret-redacted tail
of the script's output — last 20 lines, capped at 2 KB. Redaction runs over the
whole text *before* truncation (the redact-before-truncate standard in
`SECURITY.md`), so a secret straddling the cut cannot survive in the kept tail.
The tail rides on a new `BumpInfo.outputTail` and is written to the log as its
own block after the one-line WARNING; a script that printed nothing says so
rather than leaving the operator guessing.

**Surface a permanently broken script.** New
`worker/deno/lib/bump_script_failure_streak.ts` counts consecutive script
rejections per repo in an atomically-written JSON file under the work directory,
and at three consecutive rejections files **one** tracking issue against the repo
that owns the broken script. The streak clears the moment the script runs
cleanly, is absent, or is a no-op.

Design decisions worth naming:

- **Dedup on a body marker, not the title** (`<!-- VIBE_BUMP_SCRIPT_FAILURE:owner/repo -->`),
  following `run_failure_issue.ts`, so two hosts converge on one issue. A
  *failed* search returns `gh_failed` and files nothing — a lookup we could not
  perform must never read as "no issue exists" and produce a duplicate.
- **Filed against the repo that owns the script**, never a central repo: the fix
  belongs where the script lives.
- **No label.** The worker cannot self-apply `work-on` (`worker_label_guard.ts`
  strips a worker-applied pickup label on the next scan) and naming a content
  label the target repo may not define would fail creation outright. The body
  asks a human to apply `work-on`.
- **Body-safe escaping** of script output: it must not close the fenced block nor
  forge an HTML comment that a later marker read would trust.
- **A quarantine rejection is not a script-failure streak** — there the script
  did its job and the embargo rejected what it produced, so the streak is left
  untouched.
- Reuses the existing `truncateLogTail`, `redactSecrets`, `atomicWrite` and
  `withStateLock` helpers rather than reimplementing any of them. Best-effort
  throughout: every failure path returns a decision and logs it, so the bump
  phase is never derailed by its own reporting.

`docs/TROUBLESHOOTING.md` gains a row for the auto-filed issue and its existing
bump-rejection row now points at the output-tail block.

Closes #207.

## Evidence

Backend/CLI change with no web interface, so there is no screenshot to capture.
The evidence is the test runs below.

**The new tests fail against the unfixed tree.** Copied into a detached worktree
of `origin/main`:

```text
$ deno test --no-check --allow-all tests/bump_deps_test.ts --filter formatBumpOutputTail
error: SyntaxError: The requested module '../lib/bump_deps.ts' does not provide an export named 'BUMP_OUTPUT_TAIL_LINES'
FAILED | 0 passed | 1 failed (3ms)

$ deno test --no-check --allow-all tests/bump_deps_phase_test.ts --filter "output tail"
error: Module not found ".../worker/deno/lib/bump_script_failure_streak.ts".
```

**They pass on this branch.** All three affected files:

```text
$ deno test --no-check --allow-all tests/bump_deps_test.ts \
    tests/bump_deps_phase_test.ts tests/bump_script_failure_streak_test.ts
workOnIssueBumpDeps - logs the script's output tail on rejection ... ok (469µs)
workOnIssueBumpDeps - redacts secrets in the logged output tail ... ok (393µs)
workOnIssueBumpDeps - says so when a rejecting script printed nothing ... ok (197µs)
workOnIssueBumpDeps - files one issue after three consecutive rejections ... ok (13ms)
workOnIssueBumpDeps - a clean run clears the rejection streak ... ok (38ms)
workOnIssueBumpDeps - a quarantine rejection is not a script-failure streak ... ok (1ms)
recordBumpScriptRejection - counts below the threshold without touching GitHub ... ok (14ms)
recordBumpScriptRejection - files one issue at the threshold and not again ... ok (24ms)
recordBumpScriptRejection - reuses an open tracking issue found by its marker ... ok (12ms)
recordBumpScriptRejection - a failed search reports and does not file ... ok (8ms)
recordBumpScriptRejection - a failed create reports and retries next run ... ok (26ms)
clearBumpScriptStreak - a clean run resets the count ... ok (19ms)
clearBumpScriptStreak - untracked repo is a no-op ... ok (3ms)
formatBumpScriptFailureBody - neutralises markers and fences in script output ... ok (175µs)
ok | 63 passed | 0 failed (1s)
```

**Full quality gate** (`./quality.sh`, host run):

```text
  prompt immutability            PASSED     source targets                 PASSED
  benchmark audit                PASSED     mermaid                        PASSED
  hardcoded branch names         PASSED     markdownlint                   PASSED
  needs-human chokepoint         PASSED     docs prompt versions           PASSED
  gh spawn chokepoint            PASSED     deno lint                      PASSED
  host work-dir guard            PASSED     deno type check                PASSED
  git ref chokepoint             PASSED     deno fmt                       PASSED
  workflow hygiene               PASSED     deno tests                     FAILED
```

`deno type check` (1844 files), `deno lint`, `deno fmt` and every static gate
pass. `deno tests` reports 12 failures, all pre-existing and none in the changed
area:

- 11 × `setup.ps1 - …` — `error: NotFound: Failed to spawn 'pwsh': entity not
  found`. Environmental; reproduces on `origin/main`.
- 1 × `runClaudeWithTimeout - watchdogLateSeconds stays 0 for an on-time kill
  after extensions (Issues #4254, #4298)` — timing-sensitive, failed only under
  a host load average of 23. Passes in isolation:
  `ok | 1 passed | 0 failed (5s)`.

## Test plan

| File | Added | Covers |
| --- | --- | --- |
| `worker/deno/tests/bump_deps_test.ts` | 6 cases | `formatBumpOutputTail` keeps the last lines, redacts secrets, bounds a runaway line by bytes, returns `""` for empty output; `runBumpDeps` populates `rejectionReason`/`outputTail` on a script rejection and says so when the script printed nothing |
| `worker/deno/tests/bump_deps_phase_test.ts` | 6 cases | The phase logs the tail, redacts secrets in it, reports a silent script, files one issue after three consecutive rejections, clears the streak on a clean run, and does not count a quarantine rejection |
| `worker/deno/tests/bump_script_failure_streak_test.ts` | 13 cases | Counting below threshold without touching GitHub; filing once at the threshold and not again; reusing an open issue found by its marker; a failed search filing nothing; a failed create retrying next run; streak clearing; corrupt-state recovery; body/title formatting including marker and fence neutralisation |

Acceptance criteria from the issue:

- *A bump-script rejection in the worker log shows the script's stderr/stdout
  tail* — `workOnIssueBumpDeps - logs the script's output tail on rejection`.
- *A repo whose `bump-deps.sh` fails repeatedly gets one issue filed against it,
  not silent no-ops for ever* — `workOnIssueBumpDeps - files one issue after
  three consecutive rejections` and `recordBumpScriptRejection - files one issue
  at the threshold and not again`.
