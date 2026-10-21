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

Changed files (`git diff --stat f5b0c628 HEAD`, 4 files, 630 insertions, 73
deletions):

- `worker/deno/lib/milestone_health.ts` (193 lines): the malformed-response
  error class (`:43`), the GraphQL branch throw (`:291-295`), the `switch
  (outcome.kind)` (`:299`), the REST and milestone-list throws (`:362-366`,
  `:371-375`, `:463-467`, `:471-475`).
- `worker/deno/lib/validation.ts` (149 added): `GraphQLBranchCompare` (`:1004`),
  `validateGraphQLBranchCompareJson` (`:1019`), `RestCompareJson` (`:1115`) and
  `validateRestCompareJson` (`:1126`). Their guards reuse `isObject` (`:261`),
  `fail` (`:265`) and `ok` (`:269`).
- `worker/deno/tests/validation_test.ts` (206 added) and
  `worker/deno/tests/milestone_health_test.ts` (155 added).

Checks run on the four changed files: `deno fmt --check`, `deno lint` and
`deno check` each exited 0. The unit run reported `ok | 146 passed | 0 failed (67ms)`.

Errors arm: the `case "errors":` arm of the GraphQL switch
(`milestone_health.ts:300-301`) is covered by the test at
`milestone_health_test.ts:807` (GraphQL errors payload is a failed branch
compare). That test asserts the REST fallback values (`aheadBy` 2, `behindBy` 1),
because `fetchBranchInfo` discards the GraphQL error text, so the message is not
visible through the public API. Flipping the arm made 1 test fail. The other arms
are covered: `absent` by the existing test at `milestone_health_test.ts:277`,
`compare` by the Issue #470 tests at `:644` and `:655`, and `unavailable`
indirectly by the `compare: null` tests at `validation_test.ts:749`,
`milestone_health_test.ts:767`, `:781` and `:795`.

Docs sweep: the content greps run for this PR returned exit 1 (no hits), so no
docs or prompt surface was edited.

## Test Plan

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
- Failed milestone list transport still gives an empty repo (`:825`).

Red checks: each validation guard, each validation `ok` return and each
`milestone_health.ts` arm was flipped in turn, its named test file run, and the
file restored and confirmed unchanged. Every flip made its test fail. The
`errors` arm flip made 1 test fail (see Evidence).
