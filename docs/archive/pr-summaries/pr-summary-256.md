# PR Summary — Issue #256

## Summary

This is the sub-issue that changes who the worker trusts. Everything mechanical
was pushed into its dependencies — the collaborator fetch (#250), the exclusion
sources (#251), the config schema (#252), the per-cycle snapshot and skip-cycle
gate (#253), the resolver (#254). What is left is the flip itself, and the
parent issue says review attention belongs on two questions only:

1. **Does a fetch failure ever widen trust?**
2. **Does write access on one repo confer trust on another?**

Both are answered no, and both are pinned by tests rather than by inspection.

### The flip

`refreshTrustedAuthors` in `run_core_production_deps.ts` is now source-aware.
`author_source: "config"` copies the static arrays exactly as before and never
touches GitHub — it remains the default, so no host changes trust model by
upgrading. `"github"` calls `resolveDerivedAuthors`, folds the per-repo result
to the fleet-wide set, and pushes it through `applyTrustSnapshot`, which is the
single way in: the comment-trust path, the fleet-PR guards, the heartbeat marker
allowlist and the suppression allowlist all move together or not at all.

### Question 1 — a fetch failure never widens trust

A failed resolve returns `{ ok: false }` naming the source that broke. It does
**not** fall back to the local arrays, even when those arrays are populated. The
existing skip-cycle gate in `run_core.ts` then stands the whole cycle down. A
fallback would mean a GitHub outage silently restores whatever stale list sits
in `.config.json`, which is the failure mode the sub-issue exists to prevent.

**One real bug surfaced here, found by writing the test rather than by
inspection.** The construction-time snapshot seed in
`createProductionRunCoreDeps` copied `config.allowedAuthors` regardless of
source. That seed is live until the first refresh lands, so under `"github"` a
populated local list was *genuinely trusted* for that window — the acceptance
criterion "a populated local `allowed_authors` has no effect under `github`"
was false as originally wired. The seed is now empty under `"github"`: trust
starts closed and is opened only by a successful resolve. If the first resolve
fails, the cycle is skipped with nobody trusted, which is the correct end state.

### Question 2 — one repo does not confer fleet-wide trust

The resolver returns trust per repo; the snapshot is fleet-wide. The issue
requires that choice be explicit, so `intersectDerivedAuthors` is an
**intersection** and says why in its contract: a login is fleet-wide trusted
only when it holds write/maintain/admin on *every* monitored repo. A union
would mean a contractor added to one low-stakes repo becomes an authorised
author across all fifteen. Nothing about "can push to repo A" implies "the
worker should act on their issue in repo B".

The cost is understood and accepted: the fleet-wide set is the smallest of the
per-repo sets, so someone with write on fourteen of fifteen repos is not
fleet-wide trusted. That is the fail-closed direction, and the remedy — grant
the access, or narrow `repos` — is visible and deliberate. The per-repo map is
left on `DerivedAuthorsResult` so a repo-scoped call site can use that repo's
exact set rather than this floor. `formatDerivedAuthorsFoldSummary` logs the
fleet-wide size next to each repo's, because a login dropped by the
intersection is otherwise indistinguishable from one that was never a
collaborator.

### Start-up visibility and validation

- `commands/run_core.ts` logs a `[trust-source]` line next to the build banner,
  naming the active source and — under `"github"` — that the local arrays are
  ignored and a resolve failure skips the cycle. Reading a log later, "who did
  this host trust?" must be answerable from the log alone.
- `validateFleetConfig` takes the source and suppresses the
  empty-`allowed_authors` warning under `"github"`, where empty is the healthy
  state. It would otherwise fire on every start-up, and a warning that always
  fires trains operators to ignore the validator. The sibling-divergence checks
  still run — `fleet_pr_authors` and `service_accounts` are host configuration
  either way.
- #190 consistency: the comment-trust path already reads
  `trustHolder.read().authorisedCommenters`, so it receives the derived set
  automatically. A test pins it rather than leaving it to inspection.

`ProductionDepsOptions.resolveTrustedAuthors` is a test-only injection seam.
The no-fallback rule is this sub-issue's security guarantee, and a test that
proved it by letting a real `gh` call fail would prove nothing on a host where
`gh` works.

Per the issue's rollout note, `author_source` still defaults to `"config"`.
Switch one host to `"github"`, confirm from its `[trust-source]` and
`[derived-authors]` lines that the derived set matches the intended humans, and
only then change the default.

Closes #256.

## Evidence

Backend change with no web interface, so there is no screenshot to capture.

**The new tests fail against the unfixed tree.** On
`origin/milestone/234-…`, `intersectDerivedAuthors` and
`formatDerivedAuthorsFoldSummary` do not exist, `ProductionDepsOptions` has no
`resolveTrustedAuthors`, and `FleetConfigInput` has no `authorSource` — the
file does not type-check, and under `--no-check` every case fails.

**They pass on this branch:**

```text
$ deno test --allow-all tests/derived_trust_source_test.ts
intersect - a login with write on every repo is fleet-wide trusted ... ok
intersect - write on ONE repo does not confer fleet-wide trust (Issue #256) ... ok
intersect - a login missing from one of many repos is dropped ... ok
intersect - disjoint repos trust nobody rather than everybody ... ok
intersect - no repos yields an empty set, never an open one ... ok
intersect - a single repo passes its own set through ... ok
intersect - the result is deduplicated and order-stable ... ok
fold summary - names the per-repo sizes so a narrowing is visible ... ok
refreshTrustedAuthors - a resolver failure never falls back to populated local arrays (Issue #256) ... ok
refreshTrustedAuthors - github source populates the snapshot from the resolver, and a populated local allowed_authors has no effect (Issue #256) ... ok
refreshTrustedAuthors - config source still applies the static arrays (Issue #256) ... ok
refreshTrustedAuthors - a failed resolve leaves the previous snapshot rather than widening to the local arrays (Issue #256) ... ok
refreshTrustedAuthors - config source never calls the resolver (Issue #256) ... ok
refreshTrustedAuthors - an all-repos-fail resolve is a failure, not an empty success ... ok
validateFleetConfig - empty allowed_authors is not a warning under github (Issue #256) ... ok
validateFleetConfig - empty allowed_authors still warns under config (Issue #256) ... ok
validateFleetConfig - an absent authorSource behaves as config (Issue #256) ... ok
production deps - the github source seeds trust CLOSED, before any refresh (Issue #256) ... ok
production deps - the config source still seeds from the static arrays (Issue #256) ... ok

ok | 19 passed | 0 failed
```

**No regression across the trust surface** — the snapshot, resolver, refresh
gate, fleet validation and production-deps suites together:

```text
$ deno test --allow-all tests/derived_trust_source_test.ts tests/trust_snapshot_test.ts \
    tests/derived_authors_test.ts tests/run_core_trust_refresh_test.ts \
    tests/fleet_config_validation_test.ts tests/run_core_production_deps_test.ts
ok | 69 passed | 0 failed (240ms)
```

### How the snapshot's *contents* are asserted

The trusted set lives in closures inside the deps factory, so the tests observe
it from outside through a real consumer. `applyTrustSnapshot` pushes the set
into `setSuppressionAuthorAllowlist`, and `findSuppressions` with an empty
policy validates a marker's `author=` against exactly that allowlist. A marker
that is honoured therefore names a login the snapshot trusts. With the resolver
returning `org/a: [alice, bob]`, `org/b: [alice]` and
`allowed_authors: ["ignored-human"]`:

| Login | Honoured? | Why |
| --- | --- | --- |
| `alice` | yes | write on every monitored repo — the derived set reached the snapshot |
| `ignored-human` | **no** | populated in `allowed_authors`, and it has no effect under `"github"` |
| `bob` | **no** | write on `org/a` only — the fold is an intersection |

That is one assertion covering three acceptance criteria, on behaviour rather
than on a return value.

## Test plan

`worker/deno/tests/derived_trust_source_test.ts` — 19 new cases:

| Group | Covers |
| --- | --- |
| Intersection (7) | Every-repo logins survive; a one-repo login does not; a login missing from one of four is dropped; disjoint repos trust nobody; no repos yields empty, never open; a single repo passes through; the result is deduplicated and order-stable |
| Fold summary (1) | Per-repo sizes appear next to the fleet-wide size so a narrowing is visible |
| No-fallback (4) | A resolver failure returns `ok:false` naming the failed source and saying the fallback was refused; the stale local array is not trusted as a side effect; `"config"` never calls the resolver; an exclusion-team failure is a failure, not an empty success |
| Snapshot contents (3) | The derived set reaches the snapshot; a populated `allowed_authors` has no effect under `"github"`; `"config"` still applies the static arrays |
| Fail-closed seed (2) | Under `"github"` nobody is trusted before the first refresh; `"config"` keeps its construction-time behaviour |
| Start-up validation (3) | Empty `allowed_authors` is not a warning under `"github"`, still is under `"config"`, and an absent source behaves as `"config"` |

Acceptance criteria from the issue:

- [x] With `author_source: "github"`, trusted authors come from repo
      collaborators minus exclusions, refreshed each cycle.
- [x] A populated local `allowed_authors` has **no** effect under `"github"` —
      asserted by a test, and the construction-time seed bug that broke this
      is fixed.
- [x] A resolver failure never falls back to local arrays; the cycle is skipped.
- [x] The active trust source is stated in the start-up log.
- [x] The empty-`allowed_authors` fleet-config warning does not fire spuriously
      under `"github"`.
- [x] `comment_trust_filter.ts` classifies against the derived commenter set —
      the path reads the snapshot, pinned by the snapshot-contents tests.
- [x] `./quality.sh` passes.
