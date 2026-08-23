# PR Summary — Issue #334

## Summary

Start-up prints this every cycle:

```text
[fleet-config] WARNING Fleet sibling "stservice" is in fleet_pr_authors/service_accounts
  but not allowed_authors … add it to allowed_authors to keep them consistent.
```

The advice is right, and matches the design. `collect_work_on_candidates.ts`
says so at the point it guards the consequence:

> Issue #3416: exclude fleet worker logins (own host + siblings) — **they sit
> in allowedAuthors for PR-dedup** but must not be trusted to self-apply the
> reserved `work-on` discovery label.

Service accounts belong in `allowed_authors`, with targeted exclusions
wherever that trust must not follow. #3416 added one. **The equivalent for
suppression authorship was missing**, so simply following the warning would
have widened trust in a way the warning does not mention.

`allowed_authors` feeds the suppression allowlist directly:

```ts
setSuppressionAuthorAllowlist(snap.allowedAuthors);
```

and `suppression_comments.ts` checks `author=` against exactly that list —
`grep -n "fleetWorkerLogins\|isFleetLogin" worker/deno/lib/suppression_comments.ts`
returned nothing. So adding `stservice` would have let a marker reading
`author=stservice` be honoured. Issue #269 binds `author=` to a verified commit
identity, but `stservice` **is** the identity the fleet commits under, so that
bind is satisfied by the worker's own commits and stops nothing. The net effect
would be the worker able to waive security findings in code it wrote.

The divergence was accidentally preventing that. That is not a safeguard — it
is a warning nobody can act on without quietly widening trust.

`setSuppressionFleetLogins` closes it. The exclusion set is
`github_user ∪ fleet_pr_authors`, deliberately **not** `allowed_authors`,
matching #3426's reasoning: `allowed_authors` also lists the humans who
legitimately suppress, so using it would strip them too.

Closes #334.

## Evidence

Backend change with no web interface, so there is no screenshot.

**The new tests fail against `origin/main`** — the export does not exist:

```text
error: SyntaxError: The requested module '../lib/suppression_comments.ts' does not
  provide an export named '_resetSuppressionFleetLogins'
```

**They pass here:**

```text
$ deno test --allow-all tests/suppression_fleet_login_test.ts
ok | 6 passed | 0 failed (2ms)
```

**The warning clears, for the right reason.** With the service accounts added
to `allowed_authors` and this guard in place:

```text
level: ok
[fleet-config] ok effective-authors=VibeCoderST,nleck,stservice
```

**Full quality gate** (`./quality.sh`, host run): every static gate PASSED —
`deno type check`, `deno lint`, `deno fmt`, markdownlint, mermaid, workflow
hygiene and the chokepoint gates. `deno tests` reports only the 11 pre-existing
`setup.ps1` failures (`NotFound: Failed to spawn 'pwsh'`, environmental).

A first gate run failed `deno lint` on an unused import in the new test; fixed
and re-verified.

## Test plan

`worker/deno/tests/suppression_fleet_login_test.ts` — 6 cases. Each drives the
real `findSuppressions` path with the #269 commit-identity bind **satisfied**,
so the fleet exclusion is the only thing that can refuse the marker:

| Case | Asserts |
| --- | --- |
| a fleet login in `allowed_authors` still cannot suppress | Exactly the state the `[fleet-config]` warning asks for — the whole point of the change |
| the host's own login cannot suppress either | `github_user`, not just siblings |
| a human in `allowed_authors` suppresses exactly as before | The exclusion must not strip the humans who legitimately suppress — the #3426 trap |
| the comparison is case-insensitive | `StService` and `stservice` are the same login |
| with no fleet logins configured nothing changes | A caller that never wires the set keeps the pre-#334 behaviour |
| a login outside the allowlist is still refused for that reason | The new refusal does not mask the original one |

## Operational note

The config change this unblocks has been applied on host GRQ-23 —
`allowed_authors` now reads `["nleck", "VibeCoderST", "stservice"]` in both
`.config.json` and the mounted `~/.vibe-coder/run-config/.config.json`, backed
up alongside and file modes unchanged (`0600`). **Other hosts still need the
same edit**, and should not receive it until this PR is on their checkout —
until then, adding the service accounts grants suppression authority.
