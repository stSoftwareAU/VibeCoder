# Security sweep — the cancelled-check re-run (`ci_infrastructure_rerun.ts`)

**Issue:** [#2914](https://github.com/stSoftwareAU/VibeCoder/issues/2914)
(chunk top-up-2914) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12af) recorded their coverage:

- `worker/deno/lib/ci_infrastructure_rerun.ts` — added by #2914.

## `worker/deno/lib/ci_infrastructure_rerun.ts`

The module classifies a PR's red CI checks into "infrastructure" (a
`cancelled` check, or a `failure` whose Actions job resolved with zero
steps — it never actually started) and "code" (a genuine failure), then
re-runs the workflow run behind each infrastructure check, at most once per
PR head commit. Before this module, `findFailedCiChecks` only ever read
`failure` conclusions, so a PR whose only red checks were `cancelled` was
invisible to the CI-fix scan and sat stuck forever. Two exported functions:
`classifyRedChecks` and `rerunInfrastructureChecks`, both called from
`worker/deno/lib/pr_maintenance.ts` / `run_core_production_deps.ts` via the
worker's usual `ghCommandFn` chokepoint.

Shapes checked:

| Property | Result |
| --- | --- |
| argv-only `gh` calls, no shell | `lookupActionsJob` calls `ghCommandFn(["api", "repos/${repo}/actions/jobs/${checkId}"])` and `rerunInfrastructureChecks` calls `ghCommandFn(["run", "rerun", String(runId), "--repo", repo])` — both plain argv arrays passed to the injected `ghCommandFn`, never a shell string |
| the check id is validated before the lookup | `lookupActionsJob` returns `null` immediately unless `Number.isInteger(checkId) && checkId > 0`, before it is interpolated into the `gh api` path |
| the run id from the GitHub API response is validated before it reaches argv | `lookupActionsJob` accepts `parsed.run_id` only when `Number.isInteger(parsed.run_id) && parsed.run_id > 0`, else it stores `null`; `rerunInfrastructureChecks` skips any candidate whose `runId` is `null`, so only a positive integer ever reaches `String(runId)` in the `gh run rerun` argv |
| `repo` is config-sourced, not GitHub-sourced | `rerunInfrastructureChecks` and `classifyRedChecks` both take `repo` as a caller-supplied string; the only caller, `findFailedCiChecks` in `pr_maintenance.ts`, iterates the worker's own configured repo list and calls `if (!isRepoAllowed(repo)) continue;` before a repo is ever scanned, so a repo reaches this module only after passing the allow-list |
| marker file path confinement | before the marker path is built, `headSha` must match `/^[0-9a-f]{40}$/i` and `prNumber` must satisfy `Number.isInteger(prNumber) && prNumber > 0`; either failing returns `[]` with a `logger.warn`. Only then is `${stateDir}/${sanitiseRepoName(repo)}_pr${prNumber}_${headSha.toLowerCase()}.infra-rerun` built. `stateDir` is the existing CI-check state directory (`resolveCiCheckStateDir`, already swept under 12d as `ci_check_state_dir.ts`), not a new sink |
| `sanitiseRepoName` only replaces the first `/` | confirmed in `worker/deno/lib/pr_ci_checks.ts`: `repo.replace("/", "_")` — no `g` flag, so only the first slash in `owner/repo` is replaced. This is the same convention the existing CI-check retry-count marker files use (`pr_ci_checks.ts`'s `recordCiCheckRetry`/`getCiCheckRetryCount`), and `repo` here is config-sourced (see row above), not attacker-controlled, so a second `/` cannot be injected by a fork or a GitHub API field |
| the rerun mutation is bounded | at most one rerun batch per PR head: `rerunInfrastructureChecks` reads the marker with `Deno.stat` first and returns `[]` if it is already present; the marker is written with `Deno.writeTextFile` only after `rerun.length > 0` — i.e. only once at least one `gh run rerun` call has actually succeeded |
| the mutation is routed through the injected `ghCommandFn` | both `gh api …/actions/jobs/…` and `gh run rerun …` go through the caller-supplied `ghCommandFn`, the worker's single `gh` chokepoint, never a raw `Deno.Command` |
| `run rerun` is classified as a mutation | confirmed in `worker/deno/lib/audit_mutation_classifier.ts`: the per-root table has `run: new Set(["cancel", "rerun", "delete"])`, and `rerun` is also in the generic mutating-verb list `GH_GENERIC_MUTATING_VERBS`, so `gh run rerun` is treated as a write by the audit journal and the write-repo allow-list regardless of which table matches |
| rerun failure does not stall the heal | a `gh run rerun` call that throws is caught per-candidate, logged with `logger.warn`, and simply excluded from `rerun`; the loop continues to the next candidate and the PR is retried on the next scan (no marker is written unless at least one rerun succeeded) |
| marker-write failure is not silent | a `Deno.mkdir`/`Deno.writeTextFile` failure after a successful rerun is caught and logged with `logger.error`, naming the marker path; the function still returns the ids that were re-run, so the caller sees the rerun happened even though the marker did not persist |
| a job-lookup failure never drops a real code failure | for a `failure` check, `job === null` (the job could not be resolved, e.g. it is not an Actions job, or the lookup errored) keeps the check on the `code` route via `code.push(check)`, logged at `info` level, not silently classified as infrastructure |
| a job-lookup failure on `cancelled` warns but still proceeds | for a `cancelled` check, `job === null` logs `logger.warn` (no run id, so it cannot be re-run) but the check is still pushed onto `infrastructure` with `runId: null`; `rerunInfrastructureChecks` then skips it (see run-id-validation row) rather than treating the warn as fatal |
| the marker `Deno.stat` failure mode fails open, not closed | any `Deno.stat` error (not just `NotFound`) is caught and treated as "marker absent", so a transient filesystem error causes at most one extra rerun on the next scan rather than permanently blocking the heal — this is a deliberate residual, not a control gap, since the alternative (treating stat errors as "already rerun") would silently strand a PR |
| untrusted check names never reach a prompt or comment | `check.name` (fork-controllable on `pull_request` workflows, since PR authors choose workflow/job names) is only interpolated into `logger.warn`/`logger.info` log lines throughout this module; it is never written to a marker file, a PR comment body, or an agent prompt |
| the `conclusions` parameter is validated before use in a jq filter | confirmed in `worker/deno/lib/pr_maintenance.ts`: `fetchFailedCheckRuns`'s new `conclusions` parameter (this module's caller passes `RED_CHECK_CONCLUSIONS = ["failure", "cancelled"]`) is checked against `JQ_CONCLUSION_PATTERN = /^[a-z_]+$/` for every entry before any is interpolated into the `--jq` filter string; a non-matching entry throws instead of reaching the filter |

No finding requiring a code change. Two residuals are noted above rather than
treated as findings: (1) the marker file's `Deno.stat` call treats every
error — not just `NotFound` — as "marker not present", which fails open to
at most one extra rerun per scan rather than blocking the self-heal, and (2)
`sanitiseRepoName`'s single-replace behaviour relies on `repo` being
config-sourced (via the caller's `isRepoAllowed` gate) rather than being
re-validated inside this module itself; both are acceptable given the
bounded, once-per-head nature of the mutation and the existing convention
shared with the retry-count marker files.
