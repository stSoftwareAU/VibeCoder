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

Consumed-field gaps found at the inspected boundaries:

| Boundary | Consumed fields | Before | Now |
|---|---|---|---|
| GraphQL branch compare, `milestone_health.ts:284` | `data.repository.ref.compare.aheadBy/behindBy`, `errors[].message` | unchecked cast | `validateGraphQLBranchCompareJson` |
| REST compare, `milestone_health.ts:360` | `ahead_by`, `behind_by` | unchecked cast | `validateRestCompareJson` |
| Milestone list, `milestone_health.ts:461` | `[].number`, `title` | unchecked cast | `validateGitHubMilestonesJson` (existing) |
| `github.ts:438` rate-limit read | `resources.graphql.reset`, `resources.core.reset` | no gap | unchanged: already guarded by `typeof`/`isFinite` with a fallback |
| `issue_query.ts:652-693` milestone fetchers | `title`, `closed_issues` | no gap | unchanged: already guarded |

### Essential Design Decisions

- No new validation framework and no JSONC dependency. The diff adds no JSONC
  reference.
- The error text follows `Malformed gh response from <context>: <field>:
  <detail>`. It carries no raw response body.
- `getMilestoneHealth` returns `{ ok: false, error: e }` for a
  `MalformedGhResponseError` (`milestone_health.ts:595`) rather than continuing
  to the next repo (`milestone_health.ts:597`), so a malformed response cannot
  disappear into an empty repo result.
- Transport failures keep their existing behaviour. The REST branch transport
  catch still returns `undefined` (`milestone_health.ts:354`) and the milestone
  list transport catch still returns `{ repo, milestones: [] }`
  (`milestone_health.ts:454`). The second is pinned by a new test. This is a
  deliberate departure from a literal reading of AC4: a transport failure is not
  a malformed response, and the issue scopes the change to parsing gaps.

### Undiscoverable Facts

- `worker/deno/lib/github.ts:438` (`readGraphqlResetEpoch`) was inspected and is
  already guarded, so it is unchanged.
- The Issue #2607 fail-loud precedent sits at `milestone_branch_sync.ts:1086`,
  `:1123` and `:1134`.

## Evidence

Changed files (`git diff --shortstat origin/main`): 6 files changed, 1146 insertions,
75 deletions. Of these, four are code and tests; the other two are this summary
and its facts file.

- `worker/deno/lib/milestone_health.ts`: the malformed-response error class
  (`:43`), the GraphQL branch throw (`:291-295`), the `switch (outcome.kind)`
  (`:299`), the REST and milestone-list throws (`:362-366`, `:371-375`,
  `:463-467`, `:471-475`), and the `getMilestoneHealth` catch (`:595`).
  The `getMilestoneHealth` doc comment (`:563-568`) states which failures skip
  a repo: only a non-malformed throw from its health lookup, such as an
  unresolvable default branch. A failed milestone-list call still reports the
  repo with no milestones.
- `worker/deno/lib/validation.ts`: `GraphQLBranchCompare` (`:1004`),
  `validateGraphQLBranchCompareJson` (`:1019`), `RestCompareJson` (`:1115`) and
  `validateRestCompareJson` (`:1126`). Their guards reuse `isObject` (`:261`),
  `fail` (`:265`) and `ok` (`:269`).
- `worker/deno/tests/validation_test.ts` and
  `worker/deno/tests/milestone_health_test.ts`.

Checks run on the four changed code and test files: `deno fmt --check`,
`deno lint` and `deno check` each exited 0. The unit run reported
`ok | 150 passed | 0 failed`.

GraphQL switch arms (`milestone_health.ts:299`):

- `errors` (`:301`) is covered by `worker/deno/tests/milestone_health_test.ts:816`.
- `unavailable` (`:306`) is covered by `worker/deno/tests/milestone_health_test.ts:835`.
- `absent` (`:304`) is covered by the existing test at
  `worker/deno/tests/milestone_health_test.ts:277`.
- `compare` (`:316`) is covered by the Issue #470 tests at `:648` and `:659`.

The `errors` and `unavailable` tests assert the REST fallback values (`aheadBy` 2,
`behindBy` 1). Both arms return `ok: false` and the caller falls back to REST,
and `fetchBranchInfo` discards the GraphQL error text, so the fallback values are
what the public API shows. Flipping each arm to `ok: true` made 1 test fail.

**Docs sweep** — grep: `milestone_health`, `MalformedGhResponseError`, `validateGraphQLBranchCompareJson`, `validateRestCompareJson`, `getMilestoneHealth`; section: `docs/INTERNALS.md#-milestone-health-diagnostics`; siblings: `validateGitHubMilestonesJson`; updated: none — the `milestone_health` hits at `docs/INTERNALS.md:3157` and `:5794` describe the health report, which is still true.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Inspect the unchecked gh response boundaries in `milestone_health.ts` and the cited `github.ts` / `issue_query.ts` callers; list concrete consumed-field gaps before changing them. — evidence: `worker/deno/lib/milestone_health.ts:284` (gap table in Spec) — reviewer: met
- **met** — Reuse or extend the existing guards and result types. Do not introduce a second validation framework or a JSONC dependency for schema validation. — evidence: `worker/deno/lib/validation.ts:1019` — reviewer: met
- **met** — Accept documented nullable/optional GitHub fields; reject malformed required fields with the command/context and field name, without logging credentials or the full response. — evidence: `worker/deno/tests/validation_test.ts::validation - validateGraphQLBranchCompareJson treats an omitted ref as absent` — reviewer: met
- **met** — Invalid input cannot become a false success or an empty successful result. Preserve existing valid-response behaviour. — evidence: `worker/deno/tests/milestone_health_test.ts::getMilestoneHealth - non-array milestone list fails naming the endpoint and root (Issue #3856)` — reviewer: partial — reason: a milestone-list transport failure still gives an empty repo; a transport failure is not a malformed response, the issue scopes the change to parsing gaps, and the behaviour is pinned by `worker/deno/tests/milestone_health_test.ts:854`
- **met** — Tests exercise missing, null and wrong-type consumed fields and the production caller's error handling. Already-validated paths need no rewrite. — evidence: `worker/deno/tests/milestone_health_test.ts:680` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Every outcome of a branch you add needs a test that reaches it (compound operands) — evidence: `worker/deno/lib/validation.ts:1030` — reason: fixed in this diff
- **violation** — Change every copy of a twinned rule ("mirrors Issue #2607" comment declared a twin) — evidence: `worker/deno/lib/milestone_health.ts:594` — reason: fixed in this diff
- **clean** — failure reason names cause without raw response; no persisted shape changed; no test-only members; Australian English; tests call real functions

## Test Plan

<!-- vibe-branch-outcomes -->

Validation guards (`worker/deno/tests/validation_test.ts`, section at `:720`):

- `validateGraphQLBranchCompareJson` accepts a compare (`:732`), treats a null
  ref as absent (`:742`), treats a null compare as unavailable (`:749`), accepts
  a compare with null errors (`:756`), treats an omitted ref as absent (`:767`),
  treats an omitted compare as unavailable (`:774`), reports non-empty errors
  (`:781`), treats an empty errors array as no errors (`:792`).
- `validateGraphQLBranchCompareJson` rejects a non-object root (`:803`), a null
  root (`:810`), non-array errors (`:814`), a non-object errors element
  (`:821`), a non-string errors message (`:828`), missing data (`:837`), null
  data (`:841`), missing repository with the message `got undefined`
  (`:848`), null repository with the message `got null` (`:857`), a
  wrong-type ref (`:868`), a wrong-type compare (`:879`), missing aheadBy
  (`:886`), null aheadBy (`:895`) and string behindBy (`:906`).
- `validateRestCompareJson` accepts counts and ignores extra fields (`:917`),
  rejects a null root (`:927`), missing `ahead_by` (`:931`), null `ahead_by`
  (`:938`) and string `behind_by` (`:945`).

Production caller (`worker/deno/tests/milestone_health_test.ts`, section at
`:680`):

- The GraphQL compare arm reports the milestone branch name it compared, as
  well as the drift (`:659`).
- Non-array milestone list fails naming the endpoint and root (`:717`).
- Milestone with null number fails naming the field (`:725`).
- Milestone list that is not JSON fails (`:736`).
- GraphQL data without repository fails naming the field (`:748`).
- GraphQL aheadBy of the wrong type fails naming the field (`:760`).
- REST compare missing `ahead_by` fails naming the field (`:773`).
- REST compare with string `behind_by` fails naming the field (`:787`).
- REST compare that is not JSON fails (`:801`).
- GraphQL errors payload is a failed branch compare, falling back to the REST
  branch name and values (`:816`).
- GraphQL compare with null compare payload falls back to the REST branch name
  and values, the direct test of the `unavailable` arm (`:835`).
- Failed milestone list transport still gives an empty repo (`:854`).

Assertions removed: none.

Red checks: each validation guard, each validation `ok` return and each
`milestone_health.ts` arm was flipped in turn, its named test file run, and the
file restored and confirmed unchanged. Every flip made its test fail.

Compound-condition operand flips (`worker/deno/lib/validation.ts`):

- `:1030` `errors !== null` operand removed → `worker/deno/tests/validation_test.ts:756` red.
- `:1074` `ref === undefined` operand removed → `worker/deno/tests/validation_test.ts:767` red.
- `:1085` `compare === undefined` operand removed → `worker/deno/tests/validation_test.ts:774` red.

Mutation-check survivors, each applied by hand and run with `deno test
--no-check` on `worker/deno/tests/milestone_health_test.ts` and
`worker/deno/tests/validation_test.ts`, then the file restored:

- `worker/deno/lib/milestone_health.ts:319` `name` deleted or reverted to
  shorthand → `worker/deno/tests/milestone_health_test.ts:648` and `:659` red.
- `worker/deno/lib/milestone_health.ts:379` `name` deleted or reverted to
  shorthand → `worker/deno/tests/milestone_health_test.ts:816`, `:835` and the
  Issue #470 REST comparison at `:648` red.
- `worker/deno/lib/validation.ts:1068` ternary negated →
  `worker/deno/tests/validation_test.ts:848` and `:857` red.
- `worker/deno/lib/milestone_health.ts:307` exempt (untestable): an equivalent
  mutant. Deleting `ok: false` leaves `ok` undefined, and the only caller,
  `fetchBranchInfo` (`worker/deno/lib/milestone_health.ts:206`), tests
  `graphqlResult.ok` for truthiness, so both values take the same REST fallback.
  Deleting the property ran `ok | 143 passed`.
- `worker/deno/lib/milestone_health.ts:308` exempt (untestable): an equivalent
  mutant. `fetchBranchInfo` discards the error on the `ok: false` path and
  never reads `.error`, so no public result carries this text. Deleting the
  property ran `ok | 143 passed`.

Unit run for the changed suites (`deno task test:unit` on
`worker/deno/tests/validation_test.ts`, `worker/deno/tests/milestone_health_test.ts`
and `worker/deno/tests/milestone_health_cache_test.ts`):
`ok | 150 passed | 0 failed`.

Not done: the full integration suite was not run beyond `./quality.sh`.
