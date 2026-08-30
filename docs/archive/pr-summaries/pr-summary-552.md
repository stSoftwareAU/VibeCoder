## Summary

The CI-fix lane never fixed anything: it wrote its retry counter to the bare
relative path `.ci_check_state`, which resolves against the worker's working
directory — the **read-only** `--base-dir` mount in container mode. Every
automatic CI fix therefore died in `recordCiCheckRetry` before the agent ran,
which is why a human had to comment "Fix Semgrep" on
[PR #548](https://github.com/stSoftwareAU/VibeCoder/pull/548). Closes #552.

The evidence from this host's own worker log, with the semgrep failure on
PR #548 found and then abandoned nine seconds later:

```text
[2026-08-29 20:35:12Z] INFO: Found failed CI check repo=stSoftwareAU/VibeCoder prNumber=548 checkName=semgrep checkId=99156131115
[2026-08-29 20:35:19Z] INFO: Processing CI failure repo=stSoftwareAU/VibeCoder prNumber=548 checkName=semgrep checkRunId=99156131115
[2026-08-29 20:35:21Z] ERROR: [m1] Error in priority 1.55 (CI Fix): Read-only file system (os error 30): writefile '.ci_check_state/stSoftwareAU_VibeCoder_99156131115.retries'
```

The same line repeats across `worker-20260829-231853` and
`worker-20260830-001617` — the lane had been failing on every CI failure, not
just semgrep.

- **`worker/deno/lib/ci_check_state_dir.ts`** (new) resolves the store to an
  **always absolute** path inside the agent-writable work directory —
  `${WORK_DIR}/.ci_check_state` — trying the explicit work directory, then
  `WORK_DIR`, then `$HOME/auto-issue-work`, and skipping any candidate that is
  not absolute. This is the behaviour `docs/INTERNALS.md` already documented;
  the code had drifted from it.
- **`lib/pr_ci_processor.ts`**, **`lib/pr_maintenance.ts`** and
  **`commands/pr_maintenance.ts`** default to the resolver instead of the
  relative literal, and **`lib/run_core_production_deps.ts`** passes one
  explicit `resolveCiCheckStateDir({ workDir })` to both the scanner and the
  processor so they share a single store.
- **`lib/pr_ci_checks.ts`** — `recordCiCheckRetry` now fails loud with context:
  the thrown error names the state directory, the repo and the check id, rather
  than the bare `writefile '.ci_check_state/…'` that gave no clue which
  directory the worker meant or why the whole lane went quiet.

## Evidence

Backend/worker change with no web interface to screenshot — the evidence is the
worker log above, the test suite driving the real functions, and the flow below.

```mermaid
flowchart TD
    F["semgrep fails on a PR"] --> S["Priority 1.55 scan<br/>findFailedCiChecks"]
    S --> R["recordCiCheckRetry(stateDir…)"]
    R -->|before: '.ci_check_state' relative to a<br/>read-only cwd| X["EROFS — lane aborts<br/>human must ask for a fix"]
    R -->|after: ${WORK_DIR}/.ci_check_state| P["processCiFailure runs<br/>agent fixes, pushes, re-runs CI"]
    style X fill:#c45858,stroke:#6b2020,color:#fff
    style P fill:#5ab078,stroke:#1d5a35,color:#1a1a1a
```

```text
deno task test tests/ci_check_state_dir_test.ts
ok | 9 passed | 0 failed

deno task test tests/pr_ci_processor_test.ts tests/pr_maintenance_test.ts \
                tests/pr_ci_processor_lock_test.ts tests/pr_ci_processor_auto_fix_cap_test.ts
ok | 99 passed | 0 failed
```

## Test Plan

- Added `worker/deno/tests/ci_check_state_dir_test.ts` — 9 tests over the real
  functions:
  - `resolveCiCheckStateDir` — explicit work directory, trailing-slash
    normalisation, `WORK_DIR` fallback, `$HOME/auto-issue-work` fallback, a
    relative `WORK_DIR` ignored in favour of `HOME`, and the regression
    invariant that a blank/relative/root base **never** yields a path relative
    to the working directory.
  - `recordCiCheckRetry` — the counter increments on disk, and an unwritable
    state directory throws an error naming the directory, repo and check id.
  - `processCiFailure` with **no** `stateDir` — the production default path —
    records `org_repo_99156131115.retries` under `${WORK_DIR}/.ci_check_state`.
    This is the regression test: against the unfixed code the counter landed in
    the process working directory and the assertion fails.
- Re-ran the existing CI-fix suites (`pr_ci_processor`, `pr_maintenance`,
  `pr_ci_processor_lock`, `pr_ci_processor_auto_fix_cap`) — 99 passed.
- `./quality.sh` run in full.
