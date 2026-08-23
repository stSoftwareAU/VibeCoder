# PR Summary — Issue #338

## Summary

A follow-up to #334, which I shipped incomplete.

#334 stopped a fleet worker login authoring a suppression. The exclusion set it
wired was:

```ts
setSuppressionFleetLogins(
  resolveFleetAuthors(githubUser, [], config.fleetPrAuthors ?? []),
);
```

`resolveFleetAuthors` takes a fourth argument, `serviceAccounts`, and it was
left unset — so the set was `github_user ∪ fleet_pr_authors` and omitted
`service_accounts`. Issue #209 exists because that omission is easy to make:

> siblings listed only under `service_accounts` are fleet accounts too

**Hosts in this fleet run under different git users**, which is what makes the
gap reachable. A host's own login is excluded on that host, but on every other
host only if it appears in that host's `fleet_pr_authors`. Meanwhile the
`[fleet-config]` validator actively pushes every fleet login into
`allowed_authors`, and `allowed_authors` feeds the suppression allowlist. So a
sibling listed only under `service_accounts` was in the allowlist and not in
the exclusion set — able to author a suppression on every host but its own.

Nothing was exposed on the current config, where the two lists are identical.
It was latent, and would have opened the moment a new host was added to
`service_accounts` alone.

### The fix is a named function, not a fourth argument

`resolveSuppressionExcludedLogins({ githubUser, fleetPrAuthors, serviceAccounts })`
replaces the positional call. #338 *was* a dropped positional argument; there is
now no argument to drop, and the composition is the thing under test rather
than an incidental detail of a call site.

Still deliberately **not** `allowed_authors` — that also lists the humans who
legitimately suppress, and excluding them would silence real waivers (#3426).

Closes #338.

## Evidence

Backend change with no web interface, so there is no screenshot.

**The new tests fail against `origin/main`** — `resolveSuppressionExcludedLogins`
does not exist there.

**They pass here, with the #334 and fleet-author suites intact:**

```text
$ deno test --allow-all tests/suppression_excluded_logins_test.ts \
    tests/*fleet_authors* tests/*suppression_fleet*
ok | 34 passed | 0 failed (48ms)
```

**Full quality gate** (`./quality.sh`): every static gate PASSED —
`deno type check`, `deno lint`, `deno fmt`, markdownlint, mermaid, workflow
hygiene and the chokepoint gates.

A first run failed `deno lint` on the now-unused `resolveFleetAuthors` import;
fixed and re-verified. `deno tests` reports the 11 pre-existing `setup.ps1`
failures and, on one run, the known intermittent
`runClaudeWithRetry - a SIGKILLed agent's surviving descendant … (#4382)`.

## Test plan

`worker/deno/tests/suppression_excluded_logins_test.ts` — 6 cases:

| Case | Asserts |
| --- | --- |
| **a sibling listed only under `service_accounts` is excluded** | The regression: `vibe-worker-3` is in neither `github_user` nor `fleet_pr_authors` on this host |
| a sibling running under a different git user is excluded here too | Host A (`VibeCoderST`) must still refuse a suppression authored by host B (`stservice`) — the property that makes different per-host git users safe |
| the host's own login is always excluded | The #334 behaviour, unchanged |
| **`allowed_authors` is never folded in** | The #3426 trap: there is deliberately no parameter for humans, and a human must not be excluded |
| duplicates across the two lists collapse | The common config, where both lists name the same accounts |
| absent lists are not an error | `undefined` for either list |

## Note

This is a gap in a change I made earlier today, found because the fleet's use
of per-host git users was pointed out. The `[fleet-config]` config edit already
applied on GRQ-23 remains safe — `stservice` is in both lists there, so it was
covered by #334 — but any host added under `service_accounts` alone needs this
PR before its login joins `allowed_authors`.
