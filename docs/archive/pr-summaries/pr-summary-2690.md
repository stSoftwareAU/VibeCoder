# PR Summary — Issue #2690

## Summary

Setup now configures every monitored repository so the fleet works without
admin. Closes #2690.

1. **Milestone sync converges without admin.** `repo-settings-harden` sets
   `allow_merge_commit=true`, so a sync PR raised by `git_pull.ts` lands as a
   real merge commit. Its auto-merge already asks for the merge method and
   falls back to squash only when the repository refuses (Issue #1048).
   - The default branch stays squash-only through its ruleset's
     `pull_request` rule, `allowed_merge_methods: ["squash"]`. GitHub's docs
     say the targeted branches "may only be merged based on the allowed
     type", so the restriction applies only to the branches that ruleset
     targets.
   - The change goes into the ruleset whose `pull_request` rule the default
     branch already carries, found by `ruleset_id` as
     `planDefaultBranchApproval` did, and only when that ruleset targets the
     default branch alone. Otherwise it goes into the worker's own
     `Vibe Coder default branch` ruleset. Every other rule, parameter and
     bypass actor is echoed.
   - When the approval and squash-only changes land in the same ruleset, they
     are one write, so neither overwrites the other.
   - Squash-only is written before merge commits are switched on. If it fails,
     the merge-commit step is skipped (`dependsOn`).
   - A default branch that cannot be kept squash-only (a direct-push branch)
     keeps merge commits off, and its line says why.
   - Milestone rulesets are never given a `pull_request` rule. A test pins
     that `buildMilestoneRulesetBody` carries nothing that refuses a merge
     commit.
2. **Fleet accounts at write.** For each account in `fleet_pr_authors` ∪
   `service_accounts`, a role above write (admin or maintain) is set to
   `push`. The role is read back afterwards. If it is still above write, the
   admin comes from a team or the organisation, and the step fails naming
   where to change it.
   - An organisation owner cannot be lowered per repository. It is reported
     once per organisation with the exact setting to change (People → the
     account → Change role → Member). Setup never changes membership.
   - Setup never lowers the login it runs as.
   - A login that is not a valid GitHub login never reaches an API path.
3. **Token-scope preflight.** A new read-only `token-scope-preflight`
   subcommand runs from both `setup.sh` and `setup.ps1` on every run. It reads
   the token in `gh_config_dir` with `gh auth status` and checks it for
   `repo`, `workflow` and `read:org`. For any that are missing, it prints the
   exact `GH_CONFIG_DIR=… gh auth refresh -h github.com -s …` command.
   - Fine-grained and app tokens are recognised by their masked prefix. For
     those it names the permissions they need instead.
   - It replaces `setup.sh`'s interactive-only `workflow` check, which
     `setup.ps1` never had.

Everything runs as the operator admin identity (#2685), honours `--dry-run`,
runs inside `withSetupWriteScope` (#2684) and is idempotent.

## Evidence

A read-only `--dry-run` against the 20 live repositories planned:

- `merge-commit-allowed` on 16 repositories;
- `default-branch-squash-only` on 6 repositories;
- no fleet-account write, because `VibeCoderST` is already write everywhere;
- one report for `stservice` as an owner of stSoftwareAU;
- GRQ-validation's merge commits held off, because it is a direct-push
  default branch.

## Test Plan

- `tests/repo_settings_harden_test.ts`: planner and `hardenRepo` cases for
  merge commits, squash-only, broad-scope rulesets, the single combined write,
  `dependsOn`, fleet roles and login validation.
- `tests/setup_repo_settings_harden_test.ts`: composition against the
  stateful fake GitHub. A squash-only repository converges and a second run
  writes nothing. Fleet accounts end at write, with an organisation owner
  reported once. A dry run writes nothing. The token-scope report is covered
  too.
- `tests/gh_auth_test.ts`: `assessFleetTokenScopes` and
  `fleetTokenScopeRefreshCommand`.
- `tests/setup_parity_test.ts` and `tests/setup_ps1_test.ts` (under `pwsh`):
  both launchers run `token-scope-preflight`.
