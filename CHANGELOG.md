# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The per-PR documents under `docs/pr-summary-*.md` and the archived summaries in
`docs/archive/pr-summaries/` remain the canonical detailed record of each change.
This changelog is a human-readable digest grouped by version.

## [Unreleased]

### Added

- **The launcher heals a builder that ran out of storage (Issue #4441).** An
  ENOSPC during `container build` leaves Apple container's BuildKit builder VM
  with a read-only filesystem, and it stays that way after the host disk is
  freed — on host-23 every later launch died with "read-only file system"
  before it built anything and `loop.sh` backed off to 960 s with no human
  coming. `run.sh` and `run.ps1` now capture the build's output and call the
  new `container-build-heal` command on failure: a build that carries a
  builder-storage signature (`no space left on device`, `read-only file
  system`, `ENOSPC`, BuildKit's `ResourceExhausted`) restarts the builder and
  is retried **once**; a second failure in the same launch recreates the
  builder so the next launch starts clean. A build that failed for its own
  reasons fails exactly as it always has — the command exits 3 to say so — and
  every decision is recorded in `~/logs/run_core.log`.

- **Supply-chain posture gate (Issue #4192).** New `supply-chain-gate`
  command and a `supply-chain-gate` job in `validate-scripts.yml` that fail on
  a `uses:` not pinned to a full commit SHA (only local `./` actions exempt),
  a shipped `deno` invocation that resolves dependencies without `--frozen`,
  a container base image referenced by tag rather than `@sha256:` digest, a
  Renovate policy that would auto-merge beyond pin-class updates, or a stale
  `docs/audits/dependency-inventory.md` — the generated, timestamp-free
  inventory of every action, base image, container tool, Deno import and
  toolchain version with a posture verdict per entry. Every finding names the
  file, line and rule. Closing the gaps it found: `--frozen` added to the CI
  `deno` invocations, the `test` / `check` tasks and the container's seed
  `deno cache`. Manual: `docs/SUPPLY-CHAIN-GATE.md`.
- **Superseded container image tags are pruned on every launch (Issue #4162).**
  The content-derived tag (#4062) rebuilds on every change to `container/` and
  nothing used to delete the tag it replaced, so an unattended host leaked a
  multi-gigabyte image per merged change until the next build died mid-export
  ("No space left on device" on host-23, 765 MB free). `run.sh` and `run.ps1` now
  call the new `container-image-prune` command once the image they need is
  present: every other `vibe-coder` tag is removed and each removal is named on
  the host log. Foreign images and the builder cache are never touched, and a
  prune that fails is a loud warning rather than a blocked launch.
- **Rust build-profile checks in the `rust` best-practices bucket (Issue
  #4159).** The bucket guide now checks that `[profile.dev]` uses
  `debug = "line-tables-only"` (fastest dev rebuilds), that the workspace-root
  `[profile.release]` sets `opt-level = 3` + `lto = "fat"` +
  `codegen-units = 1` (most optimised release artefact), and that
  `-C target-cpu=native` is used for binaries built and run on the same host
  — never for published crates, `wasm32` targets, or artefacts copied
  elsewhere. Stable Rust only: the nightly `-Zthreads` front-end and the
  Cranelift backend are explicitly out of scope. `.cargo/config.toml` joins
  the bucket's file scope; per-repo manifest edits ride each repo's own PR.
- **`github-actions-audit` detects untrackable and stale container-image pins
  (Issue #3902).** Prompt v17 adds check #35 (a container image pinned by a
  bare `@sha256:` digest with no tag — immutable but invisible to Renovate and
  Dependabot, so it freezes forever) and check #36 (a digest pin the tree
  itself shows is materially stale, via an aged floating-channel capture
  comment or in-repo drift). Both file `BP-CONTAINER-PIN-…` /
  `BP-CONTAINER-STALE-…` findings; the audit stays read-only detect-and-file
  and the pin fix rides each repo's own PR (Issue #3239).
- `CHANGELOG.md` at the repo root following Keep a Changelog 1.1.0
  (Issue #2171). User-visible changes should land an entry under `[Unreleased]`
  alongside the per-PR summary in `docs/pr-summary-*.md`.

### Changed

- **Agent `gh` guard covers the environment and config aliases (Issue #3866).**
  The PATH shim now re-asserts the run's target before `exec` — clearing
  `GH_REPO`/`GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` and pinning the
  worker's `GH_HOST`/`GH_CONFIG_DIR` — and the guard refuses a root command
  `gh` does not ship, which can only be a user-defined config alias whose
  expansion the argv-only verdict never saw.
- **`bump-deps.sh` quarantine is verified, not advised (Issue #3659).** The
  worker now checks the release ages of the dependency versions a repo's
  `bump-deps.sh` actually produced and reverts the bump as
  `rejected_by_quarantine` when one was published inside
  `VIBE_BUMP_QUARANTINE_HOURS` (default 24h). Internal `@stsoftware/*` packages
  are exempt; an age that cannot be resolved is logged as unverified rather
  than blocking.
- **Supply-chain quarantine split by ecosystem (Issue #2536).** Documented
  native Deno `deno.json` `minimumDependencyAge` as the standard quarantine
  mechanism for Deno dependencies (JSR / `deno.land/x`) across `CLAUDE.md`,
  `AGENTS.md`, `docs/INTERNALS.md`, and `docs/DEPLOYMENT.md`. The canonical
  config (Issue #2539) is `{ "age": "P1D", "exclude": ["jsr:@stsoftware/*",
  "npm:@stsoftware/*"] }`: external Deno deps wait the 24h (`P1D`) floor,
  internal `stSoftwareAU` deps update at 0h, enforced via `deno update` /
  `deno outdated --minimum-dependency-age`. npm, cargo, and GitHub Actions
  remain on Renovate / `VIBE_BUMP_QUARANTINE_HOURS` with the 24h window
  unchanged.

### Fixed

- **Setup no longer clones an assumed FLEET-health repository, or warns about
  its own cache.** `setup.sh` / `setup.ps1` used to `git clone` a fixed
  fleet-health URL on every first run — on a host without access to it, only
  ever a `Could not read from remote repository … repository exists` warning —
  and to record `fleet_health_dir` regardless, after which the worker retried
  the same failed clone every heartbeat. Health tracking is optional: setup
  records the directory only when the checkout exists (`../private-repo-6`,
  `VIBE_FLEET_HEALTH_DIR`, or the configured `fleet_health_dir`), clones only
  a repository named by the new `VIBE_FLEET_HEALTH_REPO`, and otherwise prints
  one informational line. The worker likewise clones only `FLEET_HEALTH_REPO`
  and logs that tracking is off when there is no checkout and no URL. Setup's
  end-of-run reminder about an obsolete host `~/auto-issue-work` now ignores
  the `.vibe-cache` its own workflow audits write there, so it no longer
  flags a 4K directory it just created.
- **Two super-linear regexes could stall the single-threaded worker
  (Issue #3942).** The suppression parser's block-comment patterns were cubic
  on an unterminated `/* … ignore: … ` line (11s for 4,000 characters, hours
  for 40KB) and `redactSecrets`'s `url-userinfo` and `secret-cli-flag` rules
  were quadratic on a long run of letters or hyphens. Both patterns are now
  bounded and unambiguous, and the suppression scan's own caps back them up:
  `MAX_SUPPRESSION_LINE_CHARS` (2,000 per line, skipped whole) and
  `MAX_MANIFEST_SCAN_CHARS` / `MAX_MANIFEST_SCAN_LINE_CHARS` (200,000 per
  manifest, 4,000 per line, both warned about rather than dropped silently).
  `redactSecrets` deliberately keeps scanning its whole input — capping it
  would leave the tail unmasked.

## [1.0.0] - 2026-05-23

Baseline release. The `worker/deno/deno.json:version` field is `1.0.0`; prior
behaviour shipped without a versioned changelog. The headline capabilities
described below reflect the worker's behaviour as of this baseline; consult
`docs/archive/pr-summaries/` for per-PR detail.

### Added

- **Autonomous issue worker** — clones each monitored repository, claims
  issues by priority, raises pull requests, and responds to PR feedback
  without human intervention. Orchestrated by `loop.sh` / `run.sh` and
  implemented in `worker/deno/` (88 commands, 199+ libraries).
- **Milestone-aware work streams** — at most one in-flight PR per work
  stream (each milestone plus the default branch), enforced by
  `repo_availability.ts`, `issue_filter.ts`, and `issue_query.ts`.
- **Idle-task framework** — files real GitHub issues labelled `idle-task`
  when no claimable work exists, claimed on the next iteration through
  standard priority dispatch. See `docs/IDLE-TASK-FRAMEWORK.md`.
- **Security-scan template** (idle-task #1) — four-phase MythOS-style
  audit; findings filed as standalone issues, no PR raised. See
  `docs/SECURITY-SCAN.md`.
- **Best-practices template** (idle-task #2) — bucket-scoped LLM review
  with linter-in-CI configuration check; 50/50 dispatch with
  security-scan. See `docs/BEST-PRACTICES-SCAN.md`.
- **In-code suppression comments** — `security-scan-ignore` and
  `best-practice-ignore` markers recognised across TypeScript,
  JavaScript, Python, Go, Rust, Java, Ruby, and shell
  (`worker/deno/lib/suppression_comments.ts`).
- **Hidden-file commit safety** — `.gitignore` enforcer plus pre-commit
  gate refuse to stage hidden paths outside the documented allowlist.
- **Shallow clone with on-demand history deepening** —
  `--depth=1 --no-single-branch` with `ensureHistoryDepth()`
  doubling-step fetches when ancestry is needed.
- **Per-repository session persistence** — `.claude/` state retained
  per work stream under `.claude-sessions/<owner>/<repo>/...`, with a
  50 MB / 7-day cap.
- **Escape hatch** — Claude opens a follow-up issue and hands off
  cleanly when a run is genuinely out of scope rather than looping to
  the timeout (`escape_hatch.ts`).
- **Renovate quarantine** — `renovate.json` enforces a 24-hour
  supply-chain quarantine for external dependency bumps.
- **GitHub Actions pinned to commit SHAs** — third-party actions are
  referenced by 40-character SHA rather than tag.
- **`CONTRIBUTING.md`** documenting contribution expectations.
- **SPDX licence declaration** in `worker/deno/deno.json`.

[Unreleased]: https://github.com/stSoftwareAU/VibeCoder/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/stSoftwareAU/VibeCoder/releases/tag/v1.0.0
