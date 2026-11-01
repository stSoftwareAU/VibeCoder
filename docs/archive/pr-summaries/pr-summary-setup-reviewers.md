# Stop setup recreating deprecated allowed_authors

## Summary

The Bash and PowerShell setup wizards still prompted for allowed authors after
that key stopped granting worker trust. Replace the prompt and saved answer
with optional pr_reviewers. Removing allowed_authors from a host config now
survives interactive setup, without changing repository or service-account lists.

## Spec

### Intent and Rationale

- The operator removed allowed_authors as directed by the deprecation warning,
  but setup still asked them to supply it again.
- Reviewer selection is separate from collaborator-derived worker permissions.

### Essential Design Decisions

- Update both platform wizards and preserve Enter-to-keep-existing behaviour.
- Preserve legacy config/env compatibility in the TypeScript loader; this change
  stops the interactive wizard creating the deprecated setting.
- Correct PowerShell's existing gh-directory default expression to use a
  subexpression: the real interactive regression exposed its command-not-found
  failure before configuration could be saved.

### Undiscoverable Facts

- No access to the operator's Mac was used; terminal tests used temporary configs.

## Evidence

- Read and updated docs/SETUP.md, The minimum viable config and fuller example:
  remove deprecated keys from fresh examples and explain the reviewer prompt.
- Five atomic-write tests passed with Deno 2.9.5; the new reviewer test failed
  before the production change and passed afterwards.
- Two real Bash pseudo-terminal checks passed: new reviewers are saved, and
  Enter preserves existing reviewers. Neither recreates allowed_authors or
  changes the monitored repository list. bash -n and git diff --check passed.
- The new PowerShell prompt regression passed with PowerShell 7.5.4. Restoring
  the old default-directory expression made it fail; restoring the fix passed.
- Tests used a temporary import map to a local denoland/std checkout because
  pinned JSR packages cannot be downloaded in this environment. This is
  supplemental validation, not a pinned-dependency CI pass.
- Full quality gate attempted; completeness and tests failed fetching JSR
  dependencies. Source guards, formatting and Mermaid passed; unavailable
  optional tools were reported as skipped. Full CI verification remains required.
- No UI screenshots apply to this terminal configuration change.

## Test Plan

- setup_config_atomic_write_test.ts: reviewers-only input writes pr_reviewers,
  does not add allowed_authors, and preserves repos and service_accounts.
- setup_ps1_test.ts: drive the real prompt and writer with controlled Read-Host
  answers, asserting the reviewer prompt, resulting reviewer list and untouched
  repository list. No existing assertions were removed.
- Twinned rule: setup.sh and setup.ps1 both now prompt for optional reviewers.

## Merge verification

Draft pending pinned-dependency CI and independent review.
