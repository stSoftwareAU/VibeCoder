## Summary

PR maintenance now admits Dependabot and Renovate PRs. `gh pr list --json
author` reports a GitHub App as `{"is_bot":true,"login":"app/dependabot"}`;
`fetchAllOpenPRs` stored that login as is, so `listBotPrs` dropped every such PR
at `isBotAuthorForMaintenance`. The listing now records an App author as
`<slug>[bot]`. Closes #4719.

Version bump: `VERSION` is not changed by this PR.

## Spec

### Intent and Rationale

- Normalise where the listing is parsed (the issue's proposed fix), so every
  reader of `authorLogin` sees one spelling. The admission predicate is
  unchanged and still matches only `[bot]` or the three exact names.

### Essential Design Decisions

- `normaliseGhAppLogin` rewrites only `app/<slug>`; `fetchAllOpenPRs` calls it
  only when `author.is_bot === true`, so a human login is never rewritten.
- `listBotPrs` also calls it. The `prs_open_all` cache is file-backed (10 min
  TTL), so a row written by the previous release can still hold `app/<slug>`.
  The persisted field stays a string, so no key bump; the old shape is read
  instead. A cached row has no `is_bot`, so there `app/<slug>` is rewritten on
  shape alone (a real login cannot contain `/`).
- Other readers of `authorLogin` (`prAuthorForGate`, idle census, claimable
  audit, `selectBranchUpdatePrs`, `provenOpenPrAuthors`) classify `app/x` and
  `x[bot]` identically as non-fleet; `selectBranchUpdatePrs` also gains bot
  admission. Normalising grants no authority: cross-repository, fleet-author and
  every other rule still apply.
- Import edge `issue_query.ts` → `trust_exclusions.ts` joins an import cycle
  that already existed through `gh_spawn.ts`; the function is pure.

### Undiscoverable Facts

None.

## Evidence

Backend only; no UI. Fixture shape taken from the issue's quoted `gh pr list`
output (`{"is_bot":true,"login":"app/dependabot"}`); I did not call `gh` against
a live repo. `docs/HUMAN-PR-POLICY.md` gains a paragraph on the spelling
(sections read: the admission-predicate section; `human_pr_policy_docs_test.ts`
passes).

## Test Plan

- `worker/deno/tests/trust_exclusions_test.ts`: four `normaliseGhAppLogin` tests
  (App slugs, unchanged inputs, malformed `app/` forms, a 100k-character hostile
  input, composition with `isBotAuthorForMaintenance`).
- `worker/deno/tests/pr_bot_lookup_test.ts`: `prJson` default author is now the
  real `gh` shape; added `app/renovate` admitted, human not admitted,
  cross-repo App PR excluded, host's own App PR skipped, stale cached
  `app/dependabot` row admitted.
- `worker/deno/tests/issue_query_test.ts`: `is_bot: true` → `dependabot[bot]`;
  `is_bot: false` and a missing `is_bot` left unchanged.
- Edited expectation: the `prJson` default author. Red check: with both
  normalisations removed, 13 tests fail (`FAILED | 185 passed | 13 failed`).
  Only the fetch normalisation removed: the `issue_query_test.ts` re-spelling
  test goes red. Only the `listBotPrs` normalisation removed: the stale-cache
  test goes red (`FAILED | 197 passed | 1 failed`).
- Run: `deno task test:unit` on the four touched test files plus
  `tests/pr_maintenance_bot_prs_test.ts`: 198 passed, 0 failed; `deno fmt`,
  `deno lint`, `deno check` clean on the six changed files.
- `./quality.sh < /dev/null` on the code head: exit 0, "Result: PASSED (with
  skipped checks)"; config integration and checkov were skipped by the gate
  itself.
- Not tested: an `is_bot: false` `app/<slug>` row in the stale cache is also
  rewritten (see decision above); `gh` cannot emit it.
