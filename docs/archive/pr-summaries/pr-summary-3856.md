## Summary

Milestone health cast parsed `gh` JSON at its GraphQL branch, compare and
milestone-list boundaries without checking the fields it consumes. A missing or
wrong-type required field could turn into a false success or an empty successful
result. This PR reuses the existing `ValidationResult<T>` guards in
`worker/deno/lib/validation.ts`, adds GraphQL and REST compare guards beside
them, and makes `worker/deno/lib/milestone_health.ts` fail with
`MalformedGhResponseError` naming the command context and the field. Documented
nullable fields (a null `ref`, a null `compare`) keep their existing meaning.
Closes #3856.

## Spec

### Intent and Rationale

- The issue asks for the unchecked gh response boundaries to be inspected and
  the consumed-field gaps listed before anything changes, then for the existing
  guards to be reused rather than a second validation framework added.
- Malformed required fields must fail with the command context and field name,
  without the raw response text or credentials, and must never become a success.

### Essential Design Decisions

- No new validation framework and no JSONC dependency. The diff adds no JSONC
  reference.
- The error text follows `Malformed gh response from <context>: <field>:
  <detail>`. It carries no raw response body.
- `getMilestoneHealth` returns `{ ok: false, error: e }` for a
  `MalformedGhResponseError` (`milestone_health.ts:591`) rather than continuing
  to the next repo (`milestone_health.ts:593`), so a malformed response cannot
  disappear into an empty repo result.
- Transport failures keep their existing behaviour. The REST branch transport
  catch still returns `undefined` (`milestone_health.ts:354`) and the milestone
  list transport catch still returns `{ repo, milestones: [] }`
  (`milestone_health.ts:454`). The second is pinned by a new test.

### Undiscoverable Facts

- `worker/deno/lib/github.ts:431` (`readGraphqlResetEpoch`) was inspected and is
  already guarded, so it is unchanged.
- The brief gave "~L1110-1135" for the `milestone_branch_sync.ts` precedent. The
  Issue #2607 precedent sits at `milestone_branch_sync.ts:1086`, `:1123` and
  `:1134`.

## Evidence

Changed code files (`git diff --numstat f5b0c628`, including the uncommitted new
test; 4 files, 666 insertions, 73 deletions):

- `worker/deno/lib/milestone_health.ts` (193 lines): the malformed-response
  error class (`:43`), the GraphQL branch throw (`:291-295`), the `switch
  (outcome.kind)` (`:299`), the REST and milestone-list throws (`:362-366`,
  `:371-375`, `:463-467`, `:471-475`).
- `worker/deno/lib/validation.ts` (149 added): `GraphQLBranchCompare` (`:1004`),
  `validateGraphQLBranchCompareJson` (`:1019`), `RestCompareJson` (`:1115`) and
  `validateRestCompareJson` (`:1126`). Their guards reuse `isObject` (`:261`),
  `fail` (`:265`) and `ok` (`:269`).
- `worker/deno/tests/validation_test.ts` (206 added) and
  `worker/deno/tests/milestone_health_test.ts` (191 added: 173 committed, plus 18
  for the new `unavailable` test).

Checks run on the four changed files: `deno fmt --check`, `deno lint` and
`deno check` each exited 0. The unit run reported `ok | 147 passed | 0 failed (142ms)`.

Errors arm: the `case "errors":` arm of the GraphQL switch
(`milestone_health.ts:300-301`) is covered by the test at
`milestone_health_test.ts:807` (GraphQL errors payload is a failed branch
compare). That test asserts the REST fallback values (`aheadBy` 2, `behindBy` 1),
because `fetchBranchInfo` discards the GraphQL error text, so the message is not
visible through the public API. Flipping the arm made 1 test fail. The other arms
are covered: `absent` by the existing test at `milestone_health_test.ts:277`,
`compare` by the Issue #470 tests at `:644` and `:655`.

Unavailable arm: the `case "unavailable":` arm (`milestone_health.ts:305-309`)
is covered directly by the test at `milestone_health_test.ts:825` (GraphQL
compare with null compare payload falls back to REST). That test asserts the
REST fallback values (`aheadBy` 2, `behindBy` 1), because the arm returns
`ok: false` and the caller falls back. The validator's `kind: "unavailable"`
is covered by `validation_test.ts:749`. Flipping the arm to `ok: true` made 1
test fail.

Docs sweep: the content greps run for this PR returned exit 1 (no hits), so no
docs or prompt surface was edited.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

Reviewer: spec-reviewer (diff+issue-body)

- Inspect the unchecked gh response boundaries in `milestone_health.ts` and the cited `github.ts` / `issue_query.ts` callers; list concrete consumed-field gaps before changing them.
  reviewer: PARTIAL
  reason: The three `milestone_health.ts` boundaries are fixed. `github.ts` (`readGraphqlResetEpoch`, see Spec) and the `issue_query.ts` milestone fetchers were inspected with no change: their consumed fields are already guarded or validated.
- Reuse or extend the existing guards and result types. Do not introduce a second validation framework or a JSONC dependency for schema validation.
  reviewer: MET
  reason: Reuses `validateGitHubMilestonesJson`, `ValidationResult`, `ok`, `fail` and `isObject`. No JSONC dependency.
- Accept documented nullable/optional GitHub fields; reject malformed required fields with the command/context and field name, without logging credentials or the full response.
  reviewer: MET
  reason: `MalformedGhResponseError` carries context and field. RAW_MARKER tests assert the raw response is absent.
- Invalid input cannot become a false success or an empty successful result. Preserve existing valid-response behaviour.
  reviewer: MET
  reason: Behaviour change noted by the spec reviewer: a GraphQL body with a null repository, which used to mean branch absent, now fails loud. This is the intended gap fix, not a regression, and it aborts the report for that repo.
- Tests exercise missing, null and wrong-type consumed fields and the production caller's error handling. Already-validated paths need no rewrite.
  reviewer: MET
  reason: Validation tests cover missing, null and wrong-type fields. Production caller tests cover the error handling in `milestone_health_test.ts`.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- Rule: `Do not swallow errors` (CODING-STANDARDS.md, Never Fail Silently)
  Evidence: worker/deno/lib/milestone_health.ts, the `} catch { return undefined; }` around the branch-existence ghCommandFn call (in fetchBranchInfoRest, unchanged context line), and the new docstring line that states a failed gh call is reported as branch absent.
  reason: NOT fixed in this diff. It is a pre-existing transport-failure path outside the parsing gaps the issue scopes (`Keep this bounded to evidenced parsing gaps`). A follow-up issue is the route. It is left as a documented known departure.

Clean checks:

- Failure reason names the cause without the raw response.
- No persisted shape changed.
- No field exists only for tests (`RestCompareJson` and `GraphQLBranchCompare` are read by production code).
- Australian English in added lines.
- Tests call real functions.

## Test Plan

<!-- vibe-branch-outcomes -->

Validation guards (`worker/deno/tests/validation_test.ts`, section at `:720`):

- `validateGraphQLBranchCompareJson` accepts a compare (`:732`), treats a null
  ref as absent (`:742`), treats a null compare as unavailable (`:749`), reports
  non-empty errors ahead of data (`:756`), treats an empty errors array as no
  errors (`:767`).
- `validateGraphQLBranchCompareJson` rejects a non-object root (`:778`), a null
  root (`:785`), non-array errors (`:789`), a non-object errors element (`:796`),
  a non-string errors message (`:803`), missing data (`:812`), null data
  (`:816`), missing repository (`:823`), null repository (`:830`), a wrong-type
  ref (`:839`), a wrong-type compare (`:850`), missing aheadBy (`:857`), null
  aheadBy (`:866`) and string behindBy (`:877`).
- `validateRestCompareJson` accepts counts and ignores extra fields (`:888`),
  rejects a null root (`:898`), missing `ahead_by` (`:902`), null `ahead_by`
  (`:909`) and string `behind_by` (`:916`).

Production caller (`worker/deno/tests/milestone_health_test.ts`, section at
`:671`):

- Non-array milestone list fails naming the endpoint and root (`:708`).
- Milestone with null number fails naming the field (`:716`).
- Milestone list that is not JSON fails (`:727`).
- GraphQL data without repository fails naming the field (`:739`).
- GraphQL aheadBy of the wrong type fails naming the field (`:751`).
- REST compare missing `ahead_by` fails naming the field (`:764`).
- REST compare with string `behind_by` fails naming the field (`:778`).
- REST compare that is not JSON fails (`:792`).
- GraphQL errors payload is a failed branch compare, falling back to REST
  values (`:807`).
- GraphQL compare with null compare payload falls back to REST values, the
  direct test of the `unavailable` arm (`:825`).
- Failed milestone list transport still gives an empty repo (`:843`).

Moved to: worker/deno/tests/milestone_health_test.ts (failed-milestone transport test). Reason: the empty-repo transport catch (`milestone_health.ts:454`) is kept by design (see Spec), and this test pins it in the production-caller section.

Assertions removed: none removed.

Red checks: each validation guard, each validation `ok` return and each
`milestone_health.ts` arm was flipped in turn, its named test file run, and the
file restored and confirmed unchanged. Every flip made its test fail. The
`errors` arm flip made 1 test fail (see Evidence). The `unavailable` arm flipped
to `ok: true` made 1 test fail (`milestone_health_test.ts:825`), run with type
checking on.

Unit run for the changed suites (`deno task test:unit` on `validation_test.ts`,
`milestone_health_test.ts` and `milestone_health_cache_test.ts`):
`ok | 147 passed | 0 failed (142ms)`.
