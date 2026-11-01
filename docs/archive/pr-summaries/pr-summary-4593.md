## Summary

The fleet PR babysitter's Codex agent now runs under a per-spawn Codex
permissions profile instead of `--sandbox workspace-write`. The profile reads
the filesystem, writes only the temporary clone (its `.git` read-only) and the
scratch directory, and has access `none` to the GitHub App private key, every
`~/.vibe-coder/fleet-pr-babysitter*` entry (including `app.json`) and the real
path behind each symlink. Closes #4593.

Version bump: no `VERSION` change in this diff; the merged commit records the
final version.

## Spec

### Intent and Rationale

- The agent shares the runner's OS user, so a 0600 key is readable by it, and
  `workspace-write` allows reading the whole disk. The issue's first suggested
  fix, a sandbox profile that denies those reads, is the one that needs no new
  host setup (a keychain or separate user would).

### Essential Design Decisions

- `babysitterProtectedPaths` (`worker/deno/lib/fleet_babysitter_sandbox.ts`)
  enumerates the `fleet-pr-babysitter*` entries when the agent starts, plus the
  configured `privateKeyPath`, and adds each `realPath`, because the profile has
  no prefix pattern and `app.json` may name a key anywhere.
- `spawnBabysitterAgent` takes `protectedPaths` as a required argument and the
  builder throws on an empty list or a writable directory inside a protected
  path, so no caller can turn the boundary off by omission.
  `startBabysitterAgent` computes the list before minting the token, so a
  failure leaves no attempt recorded.
- The filesystem profile is passed as two `-c` overrides: `default_permissions`
  and one inline-table value for `permissions.babysitter-agent.filesystem` whose
  keys are the JSON-escaped paths. Codex splits a `-c` key on every `.`, and
  every protected path contains dots (`.vibe-coder`, `.git`, `.pem`); a TOML
  value is parsed as TOML, so quoted keys inside it survive intact and the `-c`
  key stays dot-free. JSON escaping means a path containing a quote cannot add a
  key.
- A third override explicitly enables network access for the agent's read-only
  GitHub requests. The profile does not inherit host `sandbox_workspace_write`
  settings, including network access, writable roots or the default `/tmp`
  grant.
- Setup and each repair require Codex CLI 0.164.0 or newer before token minting
  or recording an attempt. Older and unrecognised versions are refused because
  they may silently ignore the profile.

### Undiscoverable Facts

- **Not verified against a real Codex.** The profile has not been exercised
  against a running CLI here. Review checked its filesystem and network
  semantics against the source of Codex 0.164.0; the version preflight refuses
  older or unrecognised releases. `docs/workflows/fleet-pr-babysitter.md` tells
  the operator how to confirm a denied read on the host.
- The agent's own `gh` login (its credential store, if any) is outside this
  boundary. This PR does not change it.

## Evidence

Backend only, no UI. Code: `worker/deno/lib/fleet_babysitter_sandbox.ts` (new),
`worker/deno/commands/fleet_pr_babysitter.ts` (`spawnBabysitterAgent`,
`startBabysitterAgent`, `fix`). Docs: `docs/workflows/fleet-pr-babysitter.md`
(sandbox sentence and a "Verifying the credential boundary" paragraph); the lib
sweep ledger gains `docs/audits/lib-sweep-coverage/top-up-4593.json` for the new
module. `SECURITY.md` and `docs/THREAT-MODEL.md` do not mention the babysitter's
sandbox, so they are unchanged.

Callers of the changed functions: `spawnBabysitterAgent` is called only by
`startBabysitterAgent`; `startBabysitterAgent` only by `fix()`, which now passes
`home`. Both are required parameters.

## Test Plan

New: `worker/deno/tests/fleet_babysitter_sandbox_test.ts` (13 tests: protected
paths from the babysitter entries, the configured key and symlink targets, a
missing `.vibe-coder`, non-absolute inputs, the exact argument list, refusal of
empty lists, of a clone or scratch directory inside a protected path, of a
non-absolute scratch directory or protected path, and of a NUL byte, each with a
positive control, and quote escaping).

Changed: `worker/deno/tests/fleet_pr_babysitter_test.ts` (the argv test expects
the profile arguments in place of `--sandbox workspace-write`; new tests for no
`--sandbox`, a `none` entry per protected path, and refusal of an empty list)
and `worker/deno/tests/fleet_babysitter_app_test.ts` (calls pass `home`; the
success test asserts the key path is `none`; a relative `home` is refused before
any fetch, guard or spawn).

Removed from `worker/deno/tests/fleet_pr_babysitter_test.ts`: the expected argv
pair `"--sandbox", "workspace-write"`. Required by: "Keep the App key and config
out of reach of the agent's sandbox". Replaced by:
`...buildBabysitterSandboxArgs({ dir, scratch, protectedPaths })` in the same
test, plus the new no-`--sandbox` test.

Red checks: replacing the profile spread with `"--sandbox", "workspace-write"`
fails four tests (the argv test, the new no-`--sandbox` test, the empty-list
test and the app test's launch). Making the ancestor guard
(`writable.startsWith(`${path}/`)`) always false fails the two refusal tests.

Mutation follow-up: the three surviving mutants (the NUL-byte operand and the
two deleted `assertAbsolute` calls for the scratch directory and protected
paths) each now fail a test (checked by applying each). The `-c` keys were
restructured into one inline table to avoid dotted-key splitting.

Network follow-up: the exact-arguments test pins the explicit network override;
`deno test --allow-read --allow-write --allow-env --allow-run
--allow-sys=hostname tests/fleet_babysitter_sandbox_test.ts`
passed (13 tests).

Version preflight follow-up: the sandbox tests cover accepted, old and
unrecognised versions; the agent launch test verifies an old version is refused
before token minting, attempt recording or spawning. The sandbox, app and
babysitter test files passed together (43 passed, 0 failed).

Results: `deno test` over the sandbox, `fleet_pr_babysitter` and
`fleet_babysitter_app` tests: 41 passed, 0 failed; `deno task check:manifests`
passed after adding the ledger slice. `./quality.sh < /dev/null`: every stage
passed except `deno tests` (31427 passed, 3 failed). Two failures are the
Rust-formatter tests ("formatter should commit the Rust fix") and one was the
ledger test fixed afterwards; I did not run the Rust-formatter tests on the base
branch, so they are unverified as pre-existing. `config integration` and
`checkov` were skipped for local prerequisites, and the serial pass did not run
because the parallel pass failed. The gate was not re-run after the ledger fix;
the ledger test and `check:manifests` were.

Not checked: any run against a real Codex.
