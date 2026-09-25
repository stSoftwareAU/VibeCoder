# 🔎 Security sweep — repo-settings audit-issue close-out (`repo_settings_audit_close.ts`)

**Issue:** [#2629](https://github.com/stSoftwareAU/VibeCoder/issues/2629)
(chunk top-up-2629) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/setup/` under #2629:

- `worker/deno/setup/repo_settings_audit_close.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2629**, and this file is the reading of it.

## `worker/deno/setup/repo_settings_audit_close.ts`

After setup hardens a repository's settings, it re-scans them and closes the
fleet-filed `BP-REPO-*` audit issues whose finding the hardening fixed. Closing
an issue is a write to a monitored repository, so the risk is closing the wrong
one. Every GitHub call goes through the injected `ghCommandFn`, which takes an
argv array, so no shell parses anything. In production, that is the `gh`
chokepoint (`gh_spawn.ts`), which redacts the comment body and records the close.

| Input | Source | Handling |
| ----- | ------ | -------- |
| repo slug | setup's repo list | used only as a `--repo` argv element and inside `repos/<repo>/…` API paths that `hardenRepo` has already validated with `isValidRepoSlug` |
| `hardenRepo` outcome | this run | a finding is eligible only when every result of its mapped step kind is `applied`, or when there is no result of that kind. An aborted pass (the failed `repos/<repo>` sentinel) closes nothing |
| settings re-scan | GitHub API (read-only) | any `onLookupFailure`, an unknown default branch or an unreadable CODEOWNERS lookup closes nothing. Secret scanning, push protection, CODEOWNERS and the allow-list must also read back as fixed, because the scanner's silence alone proves nothing for those |
| `gh issue list` JSON | GitHub (issue bodies are attacker-writable) | the finding id comes only from the fixed `BP-REPO-*` marker regex in `admin_only_finding.ts`, and only ids in the static `FINDING_STEP_KIND` map can close. The author login must be in `fleetLogins` (case-insensitive). An empty fleet list closes nothing, so an outsider's issue with a copied marker is never touched |
| run label, step titles | setup's own code | written into the comment body. No issue text is echoed back |

`BP-WORKER-TOKEN-CAN-EDIT-RULESETS` is not a `BP-REPO-*` id, so it never
parses and is never closed. A failed comment leaves the issue open, so no issue
is closed without its explanation. The function never throws. Every fault
becomes a warning, so a GitHub outage cannot fail the setup run.
