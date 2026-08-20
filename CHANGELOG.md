# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The per-PR documents under `docs/pr-summary-*.md` and the archived summaries in
`docs/archive/pr-summaries/` remain the canonical detailed record of each change.
This changelog is a human-readable digest grouped by version.

## [Unreleased]

### Added

- **A deployment can bake extra build-time tools into its image (Issue #5).**
  A top-level `container_tools` array in `.config.json` declares the tools this
  deployment's monitored repositories need — Java and Maven are the first
  expected use. Each entry is a declarative archive install (download → verify
  SHA-256 → extract → PATH → `env`): no install commands, no packages, no
  installer scripts. The install prefix is fixed at `/opt/vibe-tools/<id>` and
  every `bin`/`env` value is relative to it, so no selection can aim PATH or
  `JAVA_HOME` at an arbitrary host path; a `url` without a matching `sha256` is
  refused as an unverified download. The default is an empty selection, so the
  fleet image is byte-for-byte what it was. Issue #75 adds the worked Java +
  Maven example, the checksum-drift answer (the build fails loud and the fix is
  to update `.config.json`, never to relax verification) and the deployer
  documentation across
  [Container Image](docs/CONTAINER.md#deployer-supplied-build-time-tools),
  [Configuration](docs/CONFIGURATION.md) and
  [Deployment](docs/DEPLOYMENT.md#-changing-container_tools-forces-an-image-rebuild).

### Changed

- **A preserved WIP commit can no longer become a half-done PR (Issue #148).**
  The `wip:` commit left by a timed-out run makes the issue branch ahead of
  base, so a later claim that added nothing used to pass the completion
  phase's ahead-of-base guard and raise a PR from work nobody finished.
  Completion now refuses when every commit ahead of base is a worker-authored
  WIP marker *and* the branch tip has not moved since this run's agent
  started — the resume must advance the branch first. A run that did produce
  work (including one whose only commits are its own checkpoints) is
  unaffected, and a guard that cannot determine either fact fails open.
- **A deadline-killed execute no longer discards its work, and late-cycle
  claims that cannot fit a full execute are refused (Issue #47).** On a hard
  timeout with a dirty tree the run's work is committed as a WIP commit and
  pushed to the claim-locked issue branch through the guarded chokepoint —
  regardless of `enable_session_resume` — and the release comment names the
  branch so the next claimant (or a human) resumes from it instead of
  starting from zero. The claim-runway floor (#4304) is raised to the
  configured `claudeTimeout` whenever the cycle is long enough to offer one,
  so a deadline-bound execute becomes a documented exception; on hosts whose
  whole cycle is shorter than the budget the plain floor stands and the
  worker logs that permanent exception once per cycle.

### Removed

- **Containment is mandatory: the `native` and `seatbelt` run modes are gone
  (Issue #4).** Container is the only run mode. A `.config.json` `run_mode`
  (or `VIBE_RUN_MODE`) naming a removed mode fails loud — in the launchers,
  `setup.sh`, config validation and `loadConfig` — with the removal explained,
  and is never coerced into a container run the operator did not know they
  were getting. `run.sh` / `run.ps1` carry no host-execution
  path at all (no `run-entrypoint`, no `sandbox-exec`); the launch contract
  again treats any host-execution marker as a fault and drops the
  Windows-container-only parity exception (both launchers are equal now);
  the `seatbelt-profile` command and `seatbelt_profile.ts` are deleted; the
  setup prerequisite probe has no native classification (the container
  runtime and worker image are host-fatal, `jq`/`timeout` image-owned). CI's
  `validate (native)` leg is replaced by `validate (no-runtime)`, which
  strips every container runtime from the runner and asserts `run.sh` fails
  loud with no host fallback — the run-mode CI audit now requires that proof.
  A missing container runtime remains a loud failure; `./setup.sh` installs
  one. Green-gate still counts a legacy native/seatbelt launch record (from a
  checkout older than this removal) as a host-mode launch: NOT GREEN.

### Added

- **The launcher heals a builder that ran out of storage.** An
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

- **Supply-chain posture gate.** New `supply-chain-gate`
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
- **Superseded container image tags are pruned on every launch.**
  The content-derived tag rebuilds on every change to `container/` and
  nothing used to delete the tag it replaced, so an unattended host leaked a
  multi-gigabyte image per merged change until the next build died mid-export
  ("No space left on device" on host-23, 765 MB free). `run.sh` and `run.ps1` now
  call the new `container-image-prune` command once the image they need is
  present: every other `vibe-coder` tag is removed and each removal is named on
  the host log. Foreign images and the builder cache are never touched, and a
  prune that fails is a loud warning rather than a blocked launch.
- **Rust build-profile checks in the `rust` best-practices bucket.** The bucket guide now checks that `[profile.dev]` uses
  `debug = "line-tables-only"` (fastest dev rebuilds), that the workspace-root
  `[profile.release]` sets `opt-level = 3` + `lto = "fat"` +
  `codegen-units = 1` (most optimised release artefact), and that
  `-C target-cpu=native` is used for binaries built and run on the same host
  — never for published crates, `wasm32` targets, or artefacts copied
  elsewhere. Stable Rust only: the nightly `-Zthreads` front-end and the
  Cranelift backend are explicitly out of scope. `.cargo/config.toml` joins
  the bucket's file scope; per-repo manifest edits ride each repo's own PR.
- **`github-actions-audit` detects untrackable and stale container-image pins
 .** Prompt v17 adds check #35 (a container image pinned by a
  bare `@sha256:` digest with no tag — immutable but invisible to Renovate and
  Dependabot, so it freezes forever) and check #36 (a digest pin the tree
  itself shows is materially stale, via an aged floating-channel capture
  comment or in-repo drift). Both file `BP-CONTAINER-PIN-…` /
  `BP-CONTAINER-STALE-…` findings; the audit stays read-only detect-and-file
  and the pin fix rides each repo's own PR.
- `CHANGELOG.md` at the repo root following Keep a Changelog 1.1.0
 . User-visible changes should land an entry under `[Unreleased]`
  alongside the per-PR summary in `docs/pr-summary-*.md`.

### Changed

- **Setup caches nothing on the host, and cleans up its own leftover
  (Issues #131–#134).** `WORK_DIR` no longer defaults to a host
  `$HOME/auto-issue-work`: only the in-container run driver exports it
  (pointing the worker at the `vibe-work` volume), and with it unset there is
  no cache directory at all — setup, the launchers and housekeeping re-query
  the GitHub API for default branches each run instead of caching the answers
  on the host. Setup now also removes an existing host `~/auto-issue-work`
  that holds nothing beyond a stale `.vibe-cache` an earlier setup wrote,
  reporting what it removed; a directory holding real worker data still only
  gets the size-and-reclaim reminder — setup never deletes operator data.
- **Agent `gh` guard covers the environment and config aliases.**
  The PATH shim now re-asserts the run's target before `exec` — clearing
  `GH_REPO`/`GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` and pinning the
  worker's `GH_HOST`/`GH_CONFIG_DIR` — and the guard refuses a root command
  `gh` does not ship, which can only be a user-defined config alias whose
  expansion the argv-only verdict never saw.
- **`bump-deps.sh` quarantine is verified, not advised.** The
  worker now checks the release ages of the dependency versions a repo's
  `bump-deps.sh` actually produced and reverts the bump as
  `rejected_by_quarantine` when one was published inside
  `VIBE_BUMP_QUARANTINE_HOURS` (default 24h). Internal `@stsoftware/*` packages
  are exempt; an age that cannot be resolved is logged as unverified rather
  than blocking.
- **Supply-chain quarantine split by ecosystem.** Documented
  native Deno `deno.json` `minimumDependencyAge` as the standard quarantine
  mechanism for Deno dependencies (JSR / `deno.land/x`) across `CLAUDE.md`,
  `AGENTS.md`, `docs/INTERNALS.md`, and `docs/DEPLOYMENT.md`. The canonical
  config is `{ "age": "P1D", "exclude": ["jsr:@stsoftware/*",
  "npm:@stsoftware/*"] }`: external Deno deps wait the 24h (`P1D`) floor,
  internal `stSoftwareAU` deps update at 0h, enforced via `deno update` /
  `deno outdated --minimum-dependency-age`. npm, cargo, and GitHub Actions
  remain on Renovate / `VIBE_BUMP_QUARANTINE_HOURS` with the 24h window
  unchanged.

### Fixed

- **One worker per host: a launcher now refuses to start beside a running
  worker, and setup offers to remove a LaunchAgent / scheduled task the
  operator declines (Issue #26).** The pre-launch reaper only killed stale or
  orphaned containers, so a second `run.sh` (loop.sh beside the LaunchAgent)
  launched anyway and died on the runtime's storage-attachment error
  (`VZErrorDomain … The storage device attachment is invalid`) — the work
  volumes are per-host singletons. `container-reap --refuse-live` now reports
  a live worker container (young, launcher alive) with its own exit status
  (4), and `run.sh` / `run.ps1` exit before building or launching, naming the
  container and launcher pid. Separately, answering `n` to "Install the
  LaunchAgent now?" used to leave an agent from an earlier setup installed and
  firing every five minutes; setup now says it is installed and offers to
  remove it (`launchagent --uninstall`; `scheduled-task --uninstall` on
  Windows).
- **The optional-feature keys in `.config.json` reach the worker again, and
  FLEET health needs only the repository URL.** `imgbb_api_key`,
  `fleet_health_dir`, `fleet_health_repo` and `update_gh_user_status` were
  turned into environment variables only by the bash-era `load-config`
  export script, which the Deno driver never applied — natively and in the
  container the worker logged `FLEET_HEALTH_REPO is not set` (and
  `health-tracking: degraded`, `github-status: degraded`) beside a config that
  set them. The driver now applies them at start (environment wins, as
  `${VAR:-config}` did; a host `fleet_health_dir` is not applied inside the
  container). Setup asks only for the health repository's git URL; the worker
  clones it on first run into a checkout named after the repository —
  `../GRQ-health` natively, `~/auto-issue-work/GRQ-health` in the container —
  so no directory is asked for and no placeholder name appears. Health
  tracking counts as available with the repository alone.
- **The worker no longer assumes its own default branch is `Develop`.** The
  bootstrap prelude (and startup housekeeping's branch clean-up) reset the
  worker checkout to a fixed `origin/Develop`; a checkout of a repository
  whose default branch is `main` failed every cycle with
  `git checkout Develop failed … pathspec 'Develop' did not match`. The
  branch is now resolved from the checkout's own `origin/HEAD` (recorded with
  `git remote set-head origin --auto` first when an older clone lacks it);
  `--default-branch` still overrides, and an unresolvable default fails loud
  naming that escape hatch rather than guessing.
- **Setup asks where the FLEET-health repository is (optional) instead of
  cloning an assumed URL, and no longer warns about its own cache.** `setup.sh`
  / `setup.ps1` used to `git clone` a fixed fleet-health URL on every first run
  — on a host without access to it, only ever a `Could not read from remote
  repository … repository exists` warning — and to record `fleet_health_dir`
  regardless, after which the worker retried the same failed clone every
  heartbeat. Health tracking is optional: the interactive setup now asks once
  for the health repository's git URL and checkout directory, stores them in
  `.config.json` (`fleet_health_repo`, `fleet_health_dir` — no environment
  variables), clones the repository if the checkout is missing, and otherwise
  prints one informational line. The worker reads `fleet_health_repo` from the
  config, clones only that, and logs that tracking is off when there is no
  checkout and no URL. Setup's end-of-run reminder about an obsolete host
  `~/auto-issue-work` now ignores the `.vibe-cache` its own workflow audits
  write there, so it no longer flags a 4K directory it just created; and
  `setup.sh` leaves through `exit` after `main` so a file rewritten mid-run
  is not read past its old end.
- **Two super-linear regexes could stall the single-threaded worker
 .** The suppression parser's block-comment patterns were cubic
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
