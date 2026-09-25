# 🔎 Security sweep — provider-outage alert (`provider_outage_alert.ts`)

**Issue:** [#2613](https://github.com/stSoftwareAU/VibeCoder/issues/2613)
(chunk top-up-2613) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2613:

- `worker/deno/lib/provider_outage_alert.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2613**, and this file is the reading of it.

## `worker/deno/lib/provider_outage_alert.ts`

It keeps one open issue per agent provider in the fleet's own repo while the
provider refuses requests, and closes it on recovery. Every GitHub call goes
through an injected `ghFn` that takes an argv array, so no shell parses it. In
production, that is the `gh` chokepoint.

| Input | Source | Handling |
| ----- | ------ | -------- |
| provider id | worker config | must match `^[a-z0-9._-]{1,40}$` before it reaches a title, body marker or argv; a mismatch returns `invalid` and makes no `gh` call |
| provider error text | agent CLI output (untrusted) | passed through `redactSecrets` **before** it is clipped to 500 characters, and every backtick is replaced so the text cannot close its `text` fence |
| `gh issue list` JSON | GitHub | parsed and then filtered twice: the body marker's provider must match exactly, and `selectFleetAuthoredMatches` keeps only fleet-authored issues, so a stranger's look-alike issue is never edited or closed |
| first-seen timestamp | the existing alert's marker | parsed with `Date.parse`; a non-finite value falls back to now rather than being echoed back |

The target repo is `GATE_WEDGE_DIAGNOSTIC_REPO` (the fleet repo), never a
monitored one. A failed search returns `gh-failed` and files nothing, so a
GitHub outage cannot duplicate the alert. Both public entry points catch and
log instead of throwing, because the alert is a side channel and must not fail
the run that noticed the outage.
