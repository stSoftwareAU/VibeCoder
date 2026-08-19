# 🔗 Supply-chain gate

Operator manual for the supply-chain posture gate (Issue
[#4192](https://github.com/stSoftwareAU/VibeCoder/issues/4192), part of the
[#4160](https://github.com/stSoftwareAU/VibeCoder/issues/4160) proving-ground
hardening).

Every check here used to be a habit — "we always SHA-pin actions", "`run.sh`
always passes `--frozen`" — that nothing failed on when it decayed. A
published, credential-holding automation tool is an attractive supply-chain
target, so the posture is now a gate: a CI job that fails the build, and a
command an operator can run against any checkout.

## The single command

```bash
cd worker/deno
deno run --frozen --lock=deno.lock --allow-read --allow-env \
  mod.ts supply-chain-gate --repo ../..
```

Exits non-zero on any finding. Every finding is one line naming the file, the
line and the rule:

```text
.github/workflows/ci.yml:42: [action-sha-pin] `uses: actions/checkout@v4` is not pinned to a full 40-character commit SHA (ref "v4" is a tag or branch)
```

Options: `--repo <dir>` (default: the current directory), `--inventory <path>`
(default `docs/audits/dependency-inventory.md`, repo-relative) and
`--write-inventory` (regenerate the inventory before checking; needs
`--allow-write`).

## The rules

| Rule | What fails |
| ---- | ---------- |
| `action-sha-pin` | A `uses:` under `.github/workflows/` or `.github/actions/` whose ref is not a full 40-character commit SHA. Tag and branch refs are rejected, first-party ones included; a `docker://` action must carry an `@sha256:` digest. Only local `./` actions are exempt. |
| `action-pin-comment` | A SHA pin without the repository's `# owner/action@vX.Y.Z` comment on the line or within three lines above — the comment is how a human (and Dependabot) reads the version behind the SHA. |
| `deno-frozen` | A `deno run` / `test` / `cache` / `check` / `install` / `compile` / `eval` / `bench` / `serve` / `doc` invocation in a shipped script, launcher, container file, CI workflow or `worker/deno/deno.json` task without `--frozen` (or `--cached-only`, which forbids fetching at all). `--frozen=false` counts as unfrozen. |
| `container-base-digest` | A `FROM` under `container/` that does not resolve — through its `ARG` default — to an `@sha256:` digest. |
| `renovate-automerge` | `renovate.json` enables `automerge` anywhere except a `packageRules` entry restricted to `matchUpdateTypes` ⊆ `[pin, pinDigest]`, or extends an `automerge*` preset. Converting a floating reference to an exact one changes no resolved code; every other class lands new code and needs a human merge. |
| `renovate-release-age` | `renovate.json` drops the top-level `minimumReleaseAge` quarantine. |
| `inventory-stale` | `docs/audits/dependency-inventory.md` no longer matches what the tree declares (or is missing). |

### Deliberate `deno-frozen` exemptions

A handful of invocations legitimately run without `--frozen` — an inline
`deno eval` with no imports, throwaway CI probes, the one online run that
fills the container's pre-warmed npm cache. Each lives in
`DENO_INVOCATION_ALLOWLIST` in `worker/deno/lib/supply_chain_gate.ts` with a
reason, keyed by file and invocation text; the tests fail on an entry without
a reason. Add there, never by weakening the rule.

The launchers' `deno` calls that go through TypeScript (`quality.ts` spawning
`deno test`) are outside this textual gate; the shell and PowerShell surfaces
it does read are `*.sh` / `*.ps1` at the repo root, `container/`,
`worker/shared/`, `hooks/`, `.github/scripts/`, every workflow's `run:` steps
and the `deno.json` tasks.

## The dependency inventory

`docs/audits/dependency-inventory.md` is generated from the tree — GitHub
Actions with their SHA and version, container base images with digests, the
`container/tools.json` pins, the worker's and the container seed's Deno
imports resolved through their lockfiles, and the toolchain versions — with a
deterministic posture verdict per entry (`pinned to commit SHA`,
`digest-pinned`, `locked (exact version + integrity)`, …). It carries no
timestamp, so a dependency change produces a reviewable diff of the record
and nothing else. The gate fails when the committed copy is stale;
regenerate it with:

```bash
cd worker/deno
deno run --frozen --lock=deno.lock --allow-read --allow-write --allow-env \
  mod.ts supply-chain-gate --repo ../.. --write-inventory
```

The verdict is a pinning-posture reading, not a vulnerability assessment —
that is `dependency-audit.yml`.

## Where it runs

The `supply-chain-gate` job in `.github/workflows/validate-scripts.yml` runs
the command on every pull request and on pushes to `Develop` / `main`. Tests
in `worker/deno/tests/supply_chain_gate_test.ts` drive the same checks over
fixture trees — an unpinned action, an unfrozen `deno` call, a tag-pinned
base image, a permissive Renovate policy, a stale inventory — and over the
real repository tree, which must pass.
