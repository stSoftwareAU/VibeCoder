## Summary

Adds `classifyIssueRouting(draft, targetRepo, ctx)` in `worker/deno/lib/issue_routing_classifier.ts`, a pure function that decides which repository owns a draft issue and records why in four audit fields. It is tested from deterministic fixtures, four of which are the real #3607, #3630, GRQ-AutoTrader#3242 and GRQ-AutoTrader#3184 issues stored verbatim. Closes #3741.

## Spec

### Intent and Rationale

- #3691 needs one documented routing decision that can be tested without the network. This PR adds only that pure core. Filing, duplicate search and the CLI are sibling issues: not yet, #3742 and #3743 will call it.
- Signals are categorical (worker, product, named product repository) rather than scored, so every outcome can be traced to the rule and the text that fired it, and the `reason` names both.

### Essential Design Decisions

- The #2592 diagnostic rule runs first, so worker or product text in a fast-failure issue can never move it. A marker for another repository routes there only when that repository is a configured product repository (not VibeCoder), and the decision uses the configured spelling. The marker name comes from the untrusted draft body, so any other name (an unconfigured repository, VibeCoder, or a name that is not `owner/name`) counts as a conflict: the draft is `ambiguous` and stays in its target. A configured name has already passed the `owner/name` check, so matching one validates the marker name too.
- The product rule falls back to the target only when the target is a configured product repository other than VibeCoder. A product signal drafted against any other repository that names no product repository is `ambiguous` ("a product signal but no product repository").
- Marker detection calls the owner helpers `isRepoFastFailureIssue` and `isRepoFastFailureTallyIssue`. A loose scan only collects candidate names in whatever casing the body uses, so the comparison with the target can be case-insensitive while the helpers still confirm the exact marker. The tally sibling is needed because GRQ-AutoTrader#3184 carries only the tally marker.
- `ambiguous` always keeps the draft in its target (owner = subject = target), and its reason states the basis and "close nothing automatically". A missing title, target or context repository throws, naming the field, so there is no default owner.
- The worker vocabulary is limited to worker-specific paths and terms. Generic words such as "worker", "provider" and "container" also name product code (a service worker, a price provider, a Docker container), so they are not signals. Product words only count in prose, so the branch name `milestone/3127-web-pwa-refresh` in #3630 is not a product signal.

### Undiscoverable Facts

- GRQ-AutoTrader#3184's body carries `VIBE_REPO_FAST_FAILURE_TALLY:` and not the back-off marker. `isRepoFastFailureIssue` alone returns false for it, which `gh issue view 3184 --repo stSoftwareAU/GRQ-AutoTrader` confirms.
- #3607's body says "the Vibe Coder cannot transfer issues", and #3630's body contains "pwa" inside a branch name. A naive keyword rule therefore misroutes both real fixtures.

## Evidence

Backend-only change: a library module, its tests and fixtures. Nothing in the diff renders a UI.

```mermaid
flowchart TD
    V{title, target, ctx valid?} -- no --․> X[throw, naming the field]
    V -- yes --․> M{fast-failure marker confirmed?}
    M -- "for the target" --․> D1[diagnostic in target]
    M -- "for one configured product repo" --․> D2[diagnostic in that repo]
    M -- "unconfigured name / several / over 8 names" --․> A[ambiguous: stays in target]
    M -- none --․> S{signals}
    S -- "worker only" --․> W[implementation in VibeCoder]
    S -- "product only, one named or configured-target product repo" --․> P[implementation in that product repo]
    S -- "both, drafted in either codebase" --․> C[cross-repo: one issue per codebase]
    S -- "none / conflicting / repo unknown" --․> A
```

- `deno task test:unit tests/issue_routing_classifier_test.ts` (from `worker/deno`): 20 passed, 0 failed.
- `./quality.sh < /dev/null`: `Result: PASSED (with skipped checks)`. Only `config integration` was SKIPPED.
- Mutation red-check: 36 hand-applied mutants of the classifier's branches and operands each turned the suite red. After the pre-PR verifier's findings, 5 more mutants of the new marker and product-target checks also turned it red (all listed in the facts file).
- Fixtures were fetched with `gh issue view <n> --json title,body` for VibeCoder#3607, #3630 and GRQ-AutoTrader#3242, #3184. The code depends on #3184's body holding `<․!-- VIBE_REPO_FAST_FAILURE_TALLY:stSoftwareAU/GRQ-AutoTrader --․>`.
- Issue numbers cited as provenance: #3741: Routing types and pure classifier with deterministic fixtures; #3691: Deterministic cross-repository issue routing and wrong-repo duplicate prevention; #2592: File repo fast-failure diagnostics in the monitored repo, not VibeCoder; #3607: PWA iPhone home-screen app: too big a gap above the header; #3630: Lane worktree creation wedges when the shared clone's HEAD dangles — heal it to the default branch; #3742: Duplicate search and write-permission check for issue routing; #3743: Routed issue filing orchestration with dry-run and audit marker.
- Public API exemption: `classifyIssueRouting`, `IssueKind`, `RoutingDecision`, `IssueRoutingDraft` and `IssueRoutingContext` have no production caller yet. The issue asks for them as the library API, and the open sibling #3743 will call them.

**Docs sweep** — grep: `classifyIssueRouting`, `isRepoFastFailureIssue`, `isRepoFastFailureTallyIssue`, `issue_routing`, `WALL_CLOCK_TEST_FILES`; section: none — no manual documents issue routing yet (#3749 will add it); siblings: `admin_only_finding_test`, `closure_verdict_test`, `top-up-3667` — no doc lists the wall-clock manifest or the top-up slices; updated: none; no hits in docs outside `docs/archive/`

## Test Plan

- Added `worker/deno/tests/issue_routing_classifier_test.ts` (20 tests) and the fixtures `worker/deno/tests/fixtures/issue_routing/{vibecoder_3607,vibecoder_3630,grq_autotrader_3242,grq_autotrader_3184}.json`.
- The pre-PR verifier's two findings are covered by new cases in `::ambiguous drafts stay in their target with the basis stated`: a product signal drafted against `other/unlisted`, and markers for `attacker/elsewhere`, for VibeCoder, for `not-a-repo`, and for a product repository plus an unconfigured one. `::VibeCoder is never counted as a product repository` now also covers a context that lists VibeCoder as a product: VibeCoder is neither a product target nor a marker's monitored repository. Before the fix, the old code routed the `other/unlisted`, `attacker/elsewhere`, VibeCoder and `not-a-repo` cases out of `ambiguous`. The mixed-marker case was already `ambiguous`, so it is a positive control.
- Registered the new module in `docs/audits/lib-sweep-coverage/top-up-3741.json` and the growth test in `WALL_CLOCK_TEST_FILES` (`worker/deno/lib/parallel_unsafe_test_manifest.ts`), as `tests/lib_sweep_coverage_test.ts` and `tests/parallel_unsafe_test_manifest_test.ts` require. Both pass under `deno task check:manifests`.
- `deno task test:unit tests/issue_routing_classifier_test.ts`: 20 passed. `./quality.sh`: PASSED (with skipped checks).
- Red-checks: each new test was run against mutants of the code it guards and went red (36 mutants, 0 survivors). The "eight are checked" half of the cap test is a positive control; the nine-name half is the guard.
- No existing test was edited. No existing assertion was removed.

<․!-- vibe-branch-outcomes --․>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Acceptance Criteria

<․!-- vibe-spec-review inputs="diff+issue-body" --․>

- **met** — Fixture: the #3607 / GRQ-AutoTrader#3242 pair routes to stSoftwareAU/GRQ-AutoTrader , issue kind: implementation . — evidence: `worker/deno/tests/issue routing classifier test.ts::classifyIssueRouting - #3607 drafted in VibeCoder routes to GRQ-AutoTrader as implementation; ::classifyIssueRouting - GRQ-AutoTrader#3242 stays in GRQ-AutoTrader as implementation (fixtures vibecoder 3607.json, grq autotrader 3242.json)` — reviewer: met
- **met** — Fixture: GRQ-AutoTrader#3184 routes to stSoftwareAU/GRQ-AutoTrader , issue kind: diagnostic . #3630 routes to stSoftwareAU/VibeCoder , issue kind: implementation . — evidence: `worker/deno/tests/issue routing classifier test.ts::classifyIssueRouting - GRQ-AutoTrader#3184 tally issue stays in GRQ-AutoTrader as a diagnostic; ::classifyIssueRouting - #3630 worker fix routes to VibeCoder as implementation (fixtures grq autotrader 3184.json, vibecoder 3630.json)` — reviewer: met
- **met** — Fixture: a GRQ-AutoTrader review finding about prompt or worker code routes to stSoftwareAU/VibeCoder . — evidence: `worker/deno/tests/issue routing classifier test.ts::classifyIssueRouting - a GRQ-AutoTrader review finding about prompt code routes to VibeCoder; ::classifyIssueRouting - a GRQ-AutoTrader review finding about worker wording routes to VibeCoder` — reviewer: met
- **met** — Fixture: a GRQ scoring bug routes to stSoftwareAU/GRQ . — evidence: `worker/deno/tests/issue routing classifier test.ts::classifyIssueRouting - a GRQ scoring bug routes to GRQ wherever it is drafted` — reviewer: met
- **met** — A #2592 diagnostic is never reported as belonging to another repository. — evidence: `worker/deno/tests/issue routing classifier test.ts::classifyIssueRouting - a #2592 diagnostic is never reported as belonging to another repository; ::a diagnostic drafted against another repository stays in the monitored one; ::VibeCoder is never counted as a product repository (a marker can name on` — reviewer: met
- **met** — An ambiguous draft returns issue kind: ambiguous with a non-empty reason . — evidence: `worker/deno/tests/issue routing classifier test.ts::classifyIssueRouting - ambiguous drafts stay in their target with the basis stated (AMBIGUOUS CASES, including the cases for unconfigured-marker and unlisted-target); ::markers for two repositories are ambiguous; ::more than eight marker names is a` — reviewer: met
- **met** — Every decision fills in all four audit fields. — evidence: `worker/deno/tests/issue routing classifier test.ts::classifyIssueRouting - every decision fills in all four audit fields; the route() helper also checks all four fields on every classification made through it (the hostile-input growth test calls classifyIssueRouting directly and checks only that reason is non-empty)` — reviewer: met
- **met** — Tests and quality checks pass. — evidence: `deno test tests/issue routing classifier test.ts (20 passed, 0 failed); deno test of lib sweep top up files test.ts, parallel unsafe test manifest test.ts, parallel safety cap test.ts and sweep drift command test.ts (50 passed, 0 failed); deno fmt --check, deno lint and deno check are clean on the c` — reviewer: met

## Standards Review

<․!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" --․>

- **clean** — Checked Australian English in identifiers, comments and the PR summary; KISS (one pure function, a SIMPLE-ON-PURPOSE cap on marker candidates); TDD with fixture-backed tests for each criterion; fail-loud validation that names the missing field and has no default owner; untrusted issue text treated a
