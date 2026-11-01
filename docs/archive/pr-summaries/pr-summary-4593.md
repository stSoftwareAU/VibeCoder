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
  configured `privateKeyPath`, and adds each `realPath`, because the profile
  has no prefix pattern and `app.json` may name a key anywhere.
- `spawnBabysitterAgent` takes `protectedPaths` as a required argument and the
  builder throws on an empty list or a writable directory inside a protected
  path, so no caller can turn the boundary off by omission. `startBabysitterAgent`
  computes the list before minting the token, so a failure leaves no attempt
  recorded.
- The profile writes the `-c` overrides as TOML with JSON-escaped path keys, so
  a path containing a quote cannot add a key.

### Undiscoverable Facts

- **Not verified against a real Codex.** This host has no `codex` binary and no
  network, so the profile keys (`default_permissions`,
  `permissions.<name>.filesystem."<path>"` with `read`/`write`/`none`) come from
  memory of Codex's configuration, not from an installed CLI or its docs. If
  Codex rejects them the agent fails loudly; if it accepts them with different
  semantics (for example the network default, which `workspace-write` governed
  before) the operator must adjust. `docs/workflows/fleet-pr-babysitter.md` now
  tells the operator how to confirm a denied read on the host.
- The agent's own `gh` login (its credential store, if any) is outside this
  boundary. This PR does not change it.

## Evidence

Backend only, no UI. Code: `worker/deno/lib/fleet_babysitter_sandbox.ts` (new),
`worker/deno/commands/fleet_pr_babysitter.ts` (`spawnBabysitterAgent`,
`startBabysitterAgent`, `fix`). Docs: `docs/workflows/fleet-pr-babysitter.md`
(sandbox sentence and a "Verifying the credential boundary" paragraph); the
lib sweep ledger gains `docs/audits/lib-sweep-coverage/top-up-4593.json` for
the new module. `SECURITY.md` and `docs/THREAT-MODEL.md` do not mention the
babysitter's sandbox, so they are unchanged.

Callers of the changed functions: `spawnBabysitterAgent` is called only by
`startBabysitterAgent`; `startBabysitterAgent` only by `fix()`, which now passes
`home`. Both are required parameters.

## Test Plan

New: `worker/deno/tests/fleet_babysitter_sandbox_test.ts` (10 tests: protected
paths from the babysitter entries, the configured key and symlink targets, a
missing `.vibe-coder`, non-absolute inputs, the exact argument list, refusal of
empty lists and of a clone or scratch directory inside a protected path each
with a positive control, and quote escaping).

Changed: `worker/deno/tests/fleet_pr_babysitter_test.ts` (the argv test expects
the profile arguments in place of `--sandbox workspace-write`; new tests for no
`--sandbox`, a `none` entry per protected path, and refusal of an empty list)
and `worker/deno/tests/fleet_babysitter_app_test.ts` (calls pass `home`; the
success test asserts the key path is `none`; a relative `home` is refused
before any fetch, guard or spawn).

Removed from `worker/deno/tests/fleet_pr_babysitter_test.ts`: the expected argv
pair `"--sandbox", "workspace-write"`.
Required by: "Keep the App key and config out of reach of the agent's sandbox".
Replaced by: `...buildBabysitterSandboxArgs({ dir, scratch, protectedPaths })`
in the same test, plus the new no-`--sandbox` test.

Red checks: replacing the profile spread with `"--sandbox", "workspace-write"`
fails four tests (the argv test, the new no-`--sandbox` test, the empty-list
test and the app test's launch). Making the ancestor guard
(`writable.startsWith(`${path}/`)`) always false fails the two refusal tests.

Results: `deno task test:unit` over the sandbox, `fleet_pr_babysitter` and
`fleet_babysitter_app` tests: 38 passed, 0 failed; `deno task check:manifests`
passed after adding the ledger slice. `./quality.sh < /dev/null`: every stage
passed except `deno tests` (31427 passed, 3 failed). Two failures are the
Rust-formatter tests ("formatter should commit the Rust fix") and one was the
ledger test fixed afterwards; I did not run the Rust-formatter tests on the base
branch, so they are unverified as pre-existing. `config integration` and
`checkov` were skipped for local prerequisites, and the serial pass did not
run because the parallel pass failed. The gate was not re-run after the ledger
fix; the ledger test and `check:manifests` were.

Not checked: any run against a real Codex.
