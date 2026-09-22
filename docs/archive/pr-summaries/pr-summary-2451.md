# Gate the fixed-cost maintenance sweeps on the per-repository lease

## Summary

With the lease rules (#2448) and the store (#2450) in place, this wires them
into the run loop: the four fixed-cost maintenance sweeps now run only on the
repositories this host holds the maintenance lease on. Before, every host ran
all four for every repository — roughly 80 GraphQL calls per cycle per host,
≈320 across a four-host fleet, to reach the same answer four times. After, one
host sweeps each repository and the others stand down: ≈80 per cycle
fleet-wide. Closes #2451.

- `worker/deno/lib/run_core_production_deps.ts`
  - `leasedRepos()` — resolved **once per cycle** and shared by all four
    sweeps. For each configured repository it calls `readMaintenanceLease` →
    `decideMaintenanceLease({ holder, thisHost, nowSeconds })`; when `run` is
    true it calls `refreshMaintenanceLease` and keeps the repository, otherwise
    it drops it. `thisHost` is `installFromMachineId(machineId)`;
    `trustedAuthors` is `resolveFleetMaintenanceAuthorSet(...)`.
  - The repository list handed to `closeIssuesForMergedPrs`,
    `recoverAssignedWithClosedPr`, `checkMilestoneCompletions` and
    `resumeFailureDetectionRepairs` is `leasedRepos()` rather than
    `config.repos`.
  - One summary line per cycle:
    `maintenance-lease: ran=<n> held-elsewhere=<n> degraded=<n>`. The holder
    host is an install uuid — operator detail — so it is named at debug level
    only.
  - `resetIterationCaches()` clears the memo, so the next cycle re-reads the
    lease rather than reusing one that has aged.
  - `MaintenanceSweepSeams` — an optional, scoped test seam for the lease store
    and the four gated sweeps. Production leaves it unset.
- `docs/workflows/README.md` — a "Maintenance lease" subsection in the
  Maintenance lane with a Mermaid sequence diagram (two hosts, one anchor
  issue, take-over after expiry). `docs/GH-API-OPTIMISATION.md` is untouched;
  it belongs to the pacing group.

The lease is a cost optimisation, never a lock. A degraded read returns `null`
from the store — indistinguishable from "no holder" by return value — so the
repository **stays in the list** and is swept. A fleet that cannot read the
lease keeps working rather than going quiet.

## Evidence

Backend only — no web interface to screenshot. The evidence is the test suite,
which drives the real `createProductionRunCoreDeps` with a fake lease store, so
what is asserted is the gate itself rather than GitHub:

```
deno test tests/run_core_production_deps_test.ts
ok | 26 passed | 0 failed

./quality.sh < /dev/null   → Result: PASSED (with skipped checks), exit 0
deno task check:manifests  → 672 passed, 0 failed
deno lint / deno fmt --check / deno check on the changed files → clean
markdownlint-cli2 docs/workflows/README.md → 0 issues
```

Diff size: 3 files, 445 insertions, 30 deletions.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — fake lease store: `held-elsewhere` repo A dropped, `no-holder` repo
  B and `null`-read repo C kept, all four sweeps handed only B+C,
  `refreshMaintenanceLease` called exactly once per leased repo per cycle —
  evidence: `worker/deno/tests/run_core_production_deps_test.ts::maintenance
  lease - all four sweeps receive only the leased repos` (asserts
  `seen[key][0] === ["org/b","org/c"]` for close/recover/milestone/resume and
  `refreshed === ["org/b","org/c"]`; gate at
  `worker/deno/lib/run_core_production_deps.ts:1329`, per-cycle memo at `:1398`
  cleared at `:4756`) — reviewer: met
- **met** — two hosts, one repo in the test double: exactly one refreshes the
  lease per cycle, the other logs `held-elsewhere` — evidence:
  `worker/deno/tests/run_core_production_deps_test.ts::maintenance lease - two
  hosts, one repo: exactly one refreshes` (distinct work dirs give distinct
  install uuids; asserts `refreshes.length === 1`, `sweptBy.two === []`,
  `ran=1 held-elsewhere=0 degraded=0` on host one and
  `ran=0 held-elsewhere=1 degraded=0` plus a DEBUG-level `held-elsewhere` line
  naming the holder uuid on host two) — reviewer: met
- **partial** — `./quality.sh < /dev/null` passes; PR well under 500 lines —
  evidence: `quality.sh` (the reviewer ran `timeout 590 ./quality.sh
  < /dev/null`, exit 0, `Result: PASSED (with skipped checks)`;
  `git diff --shortstat` = 3 files, 445 insertions, 30 deletions) — reviewer:
  partial — reason: the quality gate is verified green, but 475 changed lines
  sits only 5% below the 500-line ceiling, which is under it rather than well
  under it.

No unrequested changes: every hunk in the diff traces to the issue's "what
needs to be done", and the post-run callback contract
(`run_callback_context.ts`, `run_callback_telemetry.ts`,
`issue_callback_guard.ts`, `callback_conformance.ts`) is untouched.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Never Fail Silently: never catch-and-ignore an exception or
  discard a non-zero result — evidence:
  `worker/deno/lib/run_core_production_deps.ts:1387` — reason: stands —
  `await refreshLeaseFn(...)` discards its `boolean`, and
  `refreshMaintenanceLease` returns `false` exactly for "degraded" or "another
  host holds it". The repository is pushed into `leased` at `:1386` and swept
  regardless, and because `if (degradedRead) degraded++` runs at `:1385`
  *before* the refresh, a refresh-time degradation never reaches the
  `degraded=<n>` count in the summary line that `docs/workflows/README.md:338`
  tells operators to read. The store's WARN line still fires, so the operator
  is not blind — but the count under-reports. The read's fail-open is
  documented; the write's is not. Not fixed here: the code on the branch has
  already passed the quality gate and this is a summary-only change.
- **violation** — Test coverage: every new or modified public function needs at
  least one error path — evidence:
  `worker/deno/lib/run_core_production_deps.ts:1361` — reason: stands — the new
  `try/catch` around `readLeaseFn` (its warn line, the `err instanceof Error`
  branch, and the "a thrown read still keeps the repository" rule) is exercised
  by no test. Both new cases reach degradation through the `io.log` sink at
  `:1352`, which is a different branch, so a `readLease` that *throws* is
  uncovered.
- **violation** — Test coverage: the edge cases relevant to the change —
  evidence: `worker/deno/lib/run_core_production_deps.ts:4756` — reason: stands
  — the per-cycle memo is what the "refreshed exactly once per leased
  repository per cycle" claim rests on, yet no test calls
  `resetIterationCaches()` and re-drives a sweep. A regression that never
  cleared `leasedReposPending` would serve a stale, ageing lease list for the
  life of the process with every test still green. The `repos.length === 0`
  early return at `:1330` is likewise untested.
- **violation** — PR Summary and Evidence: the canonical
  `docs/archive/pr-summaries/pr-summary-{issue_number}.md` is mandatory —
  evidence: `docs/archive/pr-summaries/pr-summary-2451.md:1` — reason: fixed
  here — the file did not exist on the branch; this is it, carrying the
  Summary, Evidence, Test Plan and the `Closes #2451` keyword. The Mermaid
  obligation for a workflow change was already satisfied separately at
  `docs/workflows/README.md:296`.
- **clean** — Australian English on every added line (`memoised`,
  `optimisation`, `behaviour`); JSDoc style consistent with the file — every
  new member, inner function and seam carries a doc comment naming Issue #2451
  and its rationale; log levels match their promise — `logger.warn` for the
  store's degradation sink and the caught read failure, `logger.debug` for the
  per-repo held-elsewhere detail so the expected multi-host path is not WARN
  noise, one INFO summary per cycle; the caught read *is* handled meaningfully
  (context-bearing warn, counted, repository deliberately retained) and that
  fail-open is documented both at `:1315-1325` and in
  `docs/workflows/README.md:319-330`; the test-seam convention matches the
  file's existing `resolveTrustedAuthors` / `idleDetectGhCommandFn` /
  `fleetPrefetchGhCommandFn` pattern (production leaves it unset, scope-limited
  to the four gated sweeps, rationale documented) and all six seams are used,
  so no single-implementation abstraction; no duplicated machinery —
  `recoverClosedPrFn` and `checkAndHandleMilestoneCompletionsFn` are import
  aliases rather than pre-existing injectable options, and the late
  `resolveFleetMaintenanceAuthorSet(...)` call at `:1333` follows the existing
  sites at `:2566` / `:3427` because `fleetPrAuthorInput` is mutated by
  `applyTrustSnapshot`; test shape compliant — `Deno.makeTempDir()` with
  `finally` removal and `finally cleanup()` in both cases, no `Deno.env` or
  `chdir` mutation, no sleeps, no wall-clock or elapsed-time assertion,
  distinct temp work dirs give each host a distinct install uuid so nothing is
  inherited from the machine, and the lease store is faked with decisions
  asserted rather than request text; ledger obligation already met —
  `run_core_production_deps.ts` is claimed at
  `docs/audits/lib-sweep-coverage.json:141` and no new `lib/` module was added;
  docs match the code (`MAINTENANCE_LEASE_SECONDS` 900s, the real
  `graphql-quota:` neighbour line, the four named sweeps) and no other doc
  surface makes a now-false per-repo claim. Commands run, all green:
  `deno lint`, `deno fmt --check`, `deno check`,
  `deno test --filter "maintenance lease"`, `deno task check:manifests`,
  `markdownlint-cli2`.

## Test Plan

- Added `worker/deno/tests/run_core_production_deps_test.ts` (2 tests):
  - `maintenance lease - all four sweeps receive only the leased repos` — a
    fake store reports a fresh foreign holder for `org/a`, no holder for
    `org/b`, and a degraded read (log sink fired, `null` returned) for
    `org/c`. All four sweeps are driven through the real deps object and each
    is handed exactly `["org/b", "org/c"]` exactly once; `refreshLease` is
    called exactly once per leased repository, proving the per-cycle memo is
    shared rather than re-resolved per sweep.
  - `maintenance lease - two hosts, one repo: exactly one refreshes` — two
    `createProductionRunCoreDeps` instances with distinct work dirs (hence
    distinct install uuids) share one in-memory lease store. Host one finds no
    holder, refreshes and sweeps `["org/shared"]`; host two reads host one's
    fresh marker, refreshes nothing and sweeps `[]`. The summary lines
    (`ran=1 held-elsewhere=0 degraded=0` and
    `ran=0 held-elsewhere=1 degraded=0`) are asserted, as is the holder uuid
    appearing only on the DEBUG-level `held-elsewhere` line.
- Existing `run_core_production_deps_test.ts` cases (24) still pass, so the
  unrelated dependency wiring is unchanged.
