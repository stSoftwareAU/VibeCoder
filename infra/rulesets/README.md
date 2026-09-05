# Committed rulesets

The JSON files here are the source of truth for the GitHub rulesets applied to
`stSoftwareAU/VibeCoder`. Each is the exact payload the create/update API
accepts, so an operator applies one with a single `gh api --method PUT`.

| Payload                                        | Ruleset        | Protects           |
| ---------------------------------------------- | -------------- | ------------------ |
| [`main.json`](main.json)                       | `main`         | the default branch |
| [`milestone.json`](milestone.json)             | `Milestone`    | `milestone/**`     |
| [`release-tags.json`](release-tags.json)       | `Release tags` | release tags       |

A committed payload on its own is only a wish. `check-rulesets` reads what
GitHub actually applies and compares all three, field by field — required
contexts, enforcement, bypass actors, ref conditions and rules:

```bash
deno run --allow-all worker/deno/mod.ts check-rulesets
```

It is read-only, exits non-zero on drift, fails loud when a ruleset is absent
(deleted or renamed is indistinguishable from unprotected), and skips — saying
so — when there is no credential holding `administration:read`. Applying a
payload needs **admin**, which the fleet's service account does not hold, so
the command prints the `gh` call and a human runs it.

Adding a payload here without registering it in
[`worker/deno/lib/committed_rulesets.ts`](../../worker/deno/lib/committed_rulesets.ts)
fails the test suite: a committed ruleset nobody reconciles is how the
`Milestone` one drifted unnoticed.

## `main` versus `Milestone` — the deliberate differences

Milestone branches are where a multi-PR feature is assembled over days by
several agents, so they are the branch most likely to accumulate a broken
intermediate state and the cheapest place to catch one. Until Issue #1073 the
`Milestone` ruleset required exactly two contexts — `gitleaks` and `semgrep` —
so a PR could merge with the entire test suite red. PR #1039 did, with
`validate (tests 1/4)` failing, and rode a resurrected `fleet_health.ts` onto
the milestone branch (Issue #1042).

The two branch rulesets now require the same test gate. Everything that still
differs is a decision, recorded here with its reason:

| Field                            | `main`                                          | `Milestone`                    | Why                                                                                                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `conditions.ref_name.include`    | `~DEFAULT_BRANCH`                               | `refs/heads/milestone/**`      | The refs each one protects.                                                                                                                                                                                                                        |
| Required contexts                | 13                                              | the same 13, plus `milestone-resurrection` | The resurrection check of Issue #1048 reports on every PR whose base is a milestone branch and on no ordinary `main` PR, so it is required here and exempt there. It is the check that would have stopped Issue #1042 at the door.  |
| `pull_request` rule              | present — squash-only, unattributed-change review | absent                        | The `main` → milestone sync lands as a **merge commit**, never a squash (`mergeMethodFlagForHead`, Issues #589 and #1048): squashing that sync is what silently resurrected files `main` had deleted. A squash-only `allowed_merge_methods` on this ruleset would force exactly that. `required_status_checks` already refuses a direct push, so the PR path is enforced without the rule. |
| `copilot_code_review` rule       | present                                         | absent                         | The review is advisory and gates nothing. A milestone is assembled from many intermediate PRs and lands on `main` through a PR that does get the review, so spending one per intermediate state buys no extra gate.                                 |
| `do_not_enforce_on_create`       | `true`                                          | `true`                         | Same reason in both: a branch created at `main`'s tip carries no check runs, because the workflows are `pull_request`-triggered. Enforcing on create would refuse every new milestone branch. The applied `Milestone` ruleset has `false`, which the reconciliation reports as drift. |
| `enforcement` / `bypass_actors`  | `active` / none                                 | `active` / none                | An admin may bypass; the fleet may not (Issue #586). A bypass actor makes an active ruleset protect nothing, so the check compares the actors themselves, not just the count.                                                                       |

A fourth ruleset, `Review Needed`, is live on the default branch and is
operator-owned (one approving review). It is not committed here and is outside
what Issue #1073 covers.
