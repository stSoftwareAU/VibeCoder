# Security sweep — CI-fix attempt markers (`ci_fix_attempt_markers.ts`)

**Issue:** [#1877](https://github.com/stSoftwareAU/VibeCoder/issues/1877)
(chunk 12aa) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after chunk 12z recorded its coverage:

- `worker/deno/lib/ci_fix_attempt_markers.ts` — added by #1877.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**12aa**, and this file is the reading of it.

## `worker/deno/lib/ci_fix_attempt_markers.ts`

The module builds and parses the two PR comment markers the CI-fix lane uses as
its fleet-wide record of attempts and deferrals. Both the tally the attempt cap
binds on and the dedup that stops a diagnosis being posted twice are read out of
a **pull-request comment**, which on a public repository is the most accessible
attack surface there is — so this is 12c's untrusted-ingestion shape, with an
authorisation decision (may this run act again?) hanging off it.

| Property | Result |
| -------- | ------- |
| no spawn, no argv | no `Deno.Command`; every exported function is pure over the strings and comment rows it is given |
| no filesystem, no network, no `gh` | nothing is read or written; the comments arrive from the caller's existing `getIssueComments` result, so no extra API call is made |
| no environment or secret sinks | no `Deno.env`, no logging — the caller owns both |
| a marker is not trusted because it exists | `collectFleetCiFixMarkers` drops every comment whose author is outside the fleet login set **before** it reads the body, so a drive-by comment carrying three attempt markers cannot exhaust the cap and one carrying a deferral marker cannot park the PR. This is `alert_dedup_authors.ts`'s control (#1216) applied to a new marker family |
| an unresolved fleet identity collects nothing | an empty `fleetLogins` returns empty maps rather than falling back to "trust the body" — the fail direction the existing dedup sites already take. The consequence is the caller's to state, and each states it in its own log |
| no value is passed through unvalidated | signature (`[0-9a-f]{8,64}`), head (40-character SHA), attempt (positive integer ≤ 999), outcome (one of two literals) and `depends-on` (`REPO_SLUG_PATTERN` plus `#N`) are each checked on parse; a marker failing any check is skipped whole, never half-read |
| a partial marker cannot be counted | every attribute is required — a marker with no `outcome`, or a deferral with no `depends-on`, yields nothing, so the surviving half of a truncated marker never reads as an attempt |
| the check name cannot break out of the comment | `sanitiseCheckName` removes `"`, `'`, `<` and `>` outright and flattens control characters, so a workflow job named `x --> <script>` can neither end the attribute nor end the HTML comment. Attribute values have no escaping to lean on, which is why the characters are removed rather than encoded |
| the parsed text cannot inject into a later comment | the same sanitiser runs on **parse**, so a value a fleet account wrote under an older, laxer build is still rendered inert before it reaches the next comment body |
| a diagnosis line is bounded | `firstDiagnosisLine` flattens control characters and caps at 200 characters, so an oversized or multi-line body cannot expand the cap summary; the doc comment states plainly that Markdown escaping for the table cell is the caller's job |
| the patterns are linear | both marker regexes are a literal prefix, a lazy `[^]*?` and a literal `-->` terminator, and the attribute pattern is a simple alternation-free scan — no nested quantifier, so no catastrophic backtracking on a hostile body |
| no pattern is built from data | `ATTRIBUTE_RE` is hardcoded and the attribute name is compared against the captured group, rather than a regex compiled per name (`cross_repo_pr_handoff.ts`'s shape) |
| the worker's own values fail loud | the build functions **throw** on a malformed signature, head, attempt or dependency reference rather than writing a marker no reader will accept; only the check name — which the worker does not choose — is sanitised instead |

### Findings

None.

### Accepted residuals

- **A fleet account can still write a marker by hand.** Author verification
  buys attribution, not intent: anyone holding a fleet credential could post an
  attempt marker and spend the PR's budget. That is the same trust boundary
  every fleet marker sits behind, and a compromised fleet credential has
  strictly larger powers than exhausting a CI-fix cap.
- **`isFleetAuthor` compares logins, not account ids.** A renamed and
  re-registered login would be trusted on the strength of its name. The fleet
  identity set is operator-configured (`service_accounts` /
  `fleet_pr_authors`), so this is the existing fleet-wide assumption rather
  than one this module adds.
- **The signature is a non-cryptographic FNV-1a digest**
  (`auto_fix_attempt_tracker.ts`). It is a state key, not a security boundary:
  a collision merges two failures' tallies, which spends attempts early — the
  safe direction — and a marker still has to come from a fleet author to count
  at all.
- **Ordering is the caller's chronology.** "The earliest deferral" is the first
  row the caller supplied, not the earliest `createdAt`, because the REST
  listing is already oldest-first and re-sorting on a timestamp GitHub supplies
  would trust attacker-adjacent data to choose which record wins.
