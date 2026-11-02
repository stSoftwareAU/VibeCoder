## Summary

The babysitter's Codex sandbox denies host GitHub and SSH credentials from the
worker configuration and environment, including symlink targets and missing
credential tails. Paths containing a directory symlink followed by `..` retain
the actual filesystem target as well as normalised protections. Closes #4633.

Version bump: no version changed for this issue.

## Spec

### Intent and Rationale

- Prevent review text from steering the babysitter agent to read credentials
  that could write to fleet repositories or approve pull requests.
- Extend the existing deny-list profile, preserving its read-only root grant and
  existing babysitter-specific protections.

### Essential Design Decisions

- Read raw credential fields from the same `CONFIG_PATH` file used by the
  babysitter because `loadConfig` does not retain the reviewer App settings.
- Deny normalised locations and canonical targets of both the configured and
  normalised spellings. Resolve missing tails through the longest existing
  prefix; surface unexpected resolution errors before spawning.
- Reject clone or scratch directories that overlap a protected credential path
  in either direction.
- Remove unreachable or redundant conditions identified by mutation checks:
  absolute prefixes always contain a slash; JSON primitives and arrays have no
  named `private_key_path`. Optional chaining retains the reviewer null guard.

### Undiscoverable Facts

- The issue comment also identified configured `ssh_key_path` as a host
  credential; it is covered alongside the paths in the issue description.
- With this host's Deno, narrower read permissions normalise `..` before
  filesystem resolution. The repair regression runs with `--allow-all`, matching
  the production launcher, so it exercises actual symlink traversal semantics.

## Evidence

This backend/CLI change is covered by temporary credential fixtures and assertions
on the arguments actually passed to the Codex spawn. The production repair test
runs the command's main entry point, discovery, lock, repair and launch code;
only subprocess and GitHub boundaries are replaced by an offline preload fixture.
It selects an alternate `CONFIG_PATH` while `.config.json` contains distinct decoy
paths, then checks the selected worker App, reviewer, SSH and gh locations.

The new production repair test failed against the pre-retry head because the
actual SSH target after directory-symlink/`..` traversal lacked a `none` entry.
The repaired head protects that target, the normalised alias and its separate
symlink target. The same test checks both original and canonical locations of a
missing reviewer-key tail beneath an existing directory symlink. This exercises
both production callers reported by the verifier: `fix` calls
`startBabysitterAgent`, which calls `babysitterProtectedPaths`.

Read the credential-boundary section of `docs/workflows/fleet-pr-babysitter.md`.
Updated that manual and control C36 in `docs/THREAT-MODEL.md` to describe actual
filesystem traversal. The branch also updates `docs/CONFIGURATION.md` to link the
reviewer-key protection to the manual. No second implementation of the path rule
was found; callers share `babysitterProtectedPaths`.

## Test Plan

- Focused unit run — passed, 117 tests (105 parallel, 12 serial):
  `deno task test:unit tests/fleet_babysitter_sandbox_test.ts tests/fleet_babysitter_app_test.ts tests/fleet_pr_babysitter_test.ts tests/fleet_pr_babysitter_supervisor_test.ts tests/fleet_pr_babysitter_setup_test.ts tests/fleet_babysitter_codex_test.ts tests/fleet_babysitter_repositories_test.ts tests/service_account_env_test.ts tests/cross_file_anchors_test.ts`.
- Manifest check: `deno task check:manifests` — passed (846 passed, 0 failed,
  1 ignored).
- Targeted Deno formatting, lint and type checks, including the offline repair
  preload fixture — passed.
- `git diff --check` — passed.
- Full quality gate and pre-PR verifier are rerun by worker completion after this
  commit. Runtime Codex sandbox enforcement was not exercised; tests inspect the
  spawned profile rather than running a live Codex agent.

### Mutation evidence

The notice's line numbers refer to the pre-retry
`worker/deno/lib/fleet_babysitter_sandbox.ts`. Each listed mutation was applied
individually to that source and tested with the strengthened suite. Nine caused
runtime test failures. Three equivalent conditions were removed from production
code; no untestable exemptions are claimed.

| Notice location and mutation | Regression or resolution |
| --- | --- |
| 41: delete absolute-path assertion | `fleet_babysitter_sandbox_test.ts::babysitterProtectedPaths removes dot segments and validates additional paths` rejects a relative additional credential path. |
| 44: drop dot-segment operand | The same test requires only the normalised location and canonical key target. |
| 62: drop `slash < 0` | Removed unreachable operand: every prefix is absolute, and truncating it retains `/`. |
| 62: drop root operand | `babysitterProtectedPaths stops when even the root cannot be resolved` checks the root-specific error and termination after one root lookup. |
| 76: delete HOME assertion | `babysitterHostCredentialPaths validates HOME independently of credential defaults` supplies an absolute credential override and requires HOME rejection. |
| 80: drop null operand | `babysitterHostCredentialPaths rejects non-object configuration null` requires the configuration-shape error. |
| 80: drop object-type operand | The non-object configuration tests reject boolean, numeric and string JSON values. |
| 80: drop array operand | `babysitterHostCredentialPaths rejects non-object configuration []` requires rejection. |
| 88: drop reviewer truth guard | `babysitterHostCredentialPaths ignores absent reviewer keys and empty credential fields` covers omitted and null reviewers; optional chaining now performs that guard. Removing optional chaining also failed this test. |
| 88: drop reviewer object-type operand | Removed redundant operand; JSON primitive property lookup yields no credential key. The reviewer-shape matrix retains the ignored-value contract. |
| 89: drop reviewer array operand | Removed redundant operand; JSON arrays cannot carry a named credential-key property. The reviewer-shape matrix includes an array. |
| 104: drop blank-value operand | The reviewer/empty-field test requires empty and whitespace-only paths to be omitted, and positively checks trimmed SSH/reviewer paths. |

The verifier's missing coverage was also red-checked with temporary mutations:

- Replacing `configPath` with `.config.json` at the production repair call failed
  `fleet_babysitter_app_test.ts::production repair forwards CONFIG_PATH and denies canonical credential targets`.
- Removing canonical resolution of the configured spelling failed that production
  repair test on the actual credential target after directory-symlink/`..`.
- Returning the original path when a tail is missing failed
  `fleet_babysitter_sandbox_test.ts::babysitterProtectedPaths denies missing credential tails beneath a directory symlink`.

All mutations were restored before the passing checks.

### Deno regression avoided

Used Deno-native tasks and tooling; no Node tooling or dependency was added.
