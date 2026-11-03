## Summary

Adds `worker/deno/lib/fleet_babysitter_container.ts`, a host-side module that
turns the worker's container launch plan into a babysitter repair run. It builds
the plan with `buildLaunchPlanForCommand` under a container name unique to each
repair, drops the plan's named volumes, mounts only the clone and scratch
directories in their place, passes `GH_TOKEN` by name alone (`--env GH_TOKEN`),
refuses any mount at or above the babysitter App key and any argument carrying
the key path, preflights the runtime and the image, and runs the repair with a
90-minute limit, killing the container by name on timeout. The module is not
wired into `fix()`. `worker/deno/lib/fleet_babysitter_sandbox.ts` only gains two
`export` keywords (`normaliseAbsolutePath`, `canonicalPathIncludingMissingTail`)
so the key guard calls the existing path helpers instead of copying them. A
lib-sweep ledger entry, `docs/audits/lib-sweep-coverage/top-up-4767.json`,
claims the new module, as `lib_sweep_coverage_test.ts` requires. Closes #4767.

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- Copies the reviewer-round split (orchestration on the host, the agent in the
  container) from `round_container` and `round_args` in
  `.claude/skills/review-fleet-prs/scripts/run.sh`, so a missing runtime or image
  is a loud failed pass and never a host process.

### Essential Design Decisions

- The plan's other host mounts (checkout, logs, config, credential
  directories) are kept, exactly as `round_args` keeps them; only the named
  volumes are dropped. The agent in the container can therefore see whatever
  credential directories the worker plan mounts. Only the babysitter App key is
  kept out, by the key guard. This follows the issue's "minus its volume mounts"
  wording; whether the babysitter should drop more mounts is the owner's call.
- The key guard fails closed: it checks each mount source and the key in three
  forms (normalised, canonical, canonical of the normalised path), and refuses
  `-v`, `--mount`, `--env-file`, `--volume=`/`--mount=` spellings and any
  `GH_TOKEN` env spelling in the plan, so a future runtime dialect cannot bypass
  it silently.
- The runtime child gets an allowlisted environment (`PATH`, `HOME`, `USER`,
  `LOGNAME`, `TMPDIR`, `DOCKER_HOST`, `XDG_RUNTIME_DIR`, `CONTAINER_HOST`) with
  `clearEnv`; the token is added only to the repair spawn, never to the image
  check or the kill. A runtime that needs another variable would need it added.
- A completed non-zero image inspect means "image not built"; a failure to run
  the inspect, or its timeout, throws its own cause instead of that message.

### Undiscoverable Facts

- `babysitter-repair` does not exist in the image yet: #4768 will add it, and
  #4774 will wire this module into `fix()`. A real run today would fail inside
  the container; the module and its doc comments say so.

## Evidence

Backend only; no UI. Cited code was read at the head:
`worker/deno/commands/container_launch_plan.ts` (`buildLaunchPlanForCommand`),
`worker/deno/lib/container_launch.ts` (`ContainerLaunchPlan`: `runArgs` end with
the image; `volumes`, `resettableVolumes`, `imageInspectArgs`, `egressEnforced`,
`proxyName`), `worker/deno/lib/container_runtime.ts` (`buildMountArguments`
emits `--volume <source>:<target>` for every dialect),
`.claude/skills/review-fleet-prs/scripts/run.sh` (`round_container`,
`round_args`), `worker/deno/lib/subprocess_timeout.ts` (`runWithTimeout`).

- The tests use fakes for the plan builder, runtime probe, image check and
  spawn. The fake plan mirrors `ContainerLaunchPlan` (`runArgs` ending with the
  image, `--volume <name>:<target>` for named volumes, host `--volume` mounts
  for the rest). `babysitterSpawn` and `babysitterImageExists` are also tested
  for real, with the `deno` binary as the runtime.
- Issue numbers cited: #4738: Fleet PR babysitter repairs run in the worker
  container, like reviewer rounds; #4768: Add the worker container's
  babysitter-repair mode: one repair session in a mounted clone; #4774: Run
  fleet PR babysitter repairs and quality.sh in the worker container; delete the
  host sandbox and Codex installer.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Test: the spawned command is the plan's runtime with the plan's run arguments, the image, `babysitter-repair` and the contract arguments. No `codex` and no host agent command is spawned. — evidence: `worker/deno/tests/fleet_babysitter_container_4738_test.ts::repair spawns the plan's run args, the mounts, GH_TOKEN and the fixed command` — reviewer: met
- **met** — Test: the plan's named volumes are dropped, and exactly the clone and scratch mounts are added. — evidence: `worker/deno/tests/fleet_babysitter_container_4738_test.ts::repair drops the named volumes and adds exactly the clone and scratch mounts` — reviewer: met
- **met** — Test: no `--volume` source is at or above the App key's directory; the key path is in no argument; the key's contents are in no argument and in no env value passed to the runtime; and `GH_TOKEN` appears only as `--env GH_TOKEN`. — evidence: `worker/deno/tests/fleet_babysitter_container_4738_test.ts::repair keeps the key out of every mount, argument and env value`, plus the key-guard refusal tests — reviewer: met
- **met** — Test: a missing runtime and a missing image each throw with their cause and spawn nothing. — evidence: `worker/deno/tests/fleet_babysitter_container_4738_test.ts::repair refuses when the runtime is not on PATH, and never asks for the image` and `::repair refuses when the worker image is not built, and spawns nothing` — reviewer: met
- **met** — Test: a timeout kills the container by name and throws. — evidence: `worker/deno/tests/fleet_babysitter_container_4738_test.ts::repair kills the container by name on timeout, and reports a failed kill` — reviewer: met
- **met** — `./quality.sh` passes. — evidence: full gate run on the final head, see Test Plan — reviewer: missing — reason: the reviewer saw only the diff and could not run the gate; it was run here and passed
- **unrequested** — key guard also refuses relative sources, other flag spellings and symlink/`..` forms; input validation of clone, scratch, key and token; stderr redaction; `babysitterRuntimeOnPath`, `babysitterSpawn`, `babysitterImageExists` exports; the lib-sweep ledger file — reviewer: unrequested — reason: each fails closed on the issue's key-isolation and fail-loud requirements, or is required by `lib_sweep_coverage_test.ts` for any new module

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — key guard missed `<dir>/missing/../link` — evidence: `worker/deno/lib/fleet_babysitter_container.ts:230` — reason: fixed in this diff (three path forms checked; combined symlink test added)
- **violation** — guard covered only the `--volume` spelling — evidence: `worker/deno/lib/fleet_babysitter_container.ts:164` — reason: fixed in this diff (other spellings refused; evasion tests)
- **violation** — tests mutated `PATH` with `Deno.env.set` — evidence: `worker/deno/tests/fleet_babysitter_container_4738_test.ts:328` — reason: fixed in this diff (env reader injected)
- **violation** — default `clearEnv` isolation untested — evidence: `worker/deno/lib/fleet_babysitter_container.ts:301` — reason: fixed in this diff (`babysitterSpawn` tested with the real `deno` binary)
- **violation** — untested branches (image-last check, blank token, relative/NUL paths, custom timeout, spawn throw) — evidence: `worker/deno/lib/fleet_babysitter_container.ts:154` — reason: fixed in this diff (tests added)
- **violation** — spawn failure or timeout reported as "image not built" — evidence: `worker/deno/lib/fleet_babysitter_container.ts:297` — reason: fixed in this diff (own cause thrown)
- **violation** — refusal tests lacked accepted controls — evidence: `worker/deno/tests/fleet_babysitter_container_4738_test.ts:514` — reason: fixed in this diff
- **violation** — present-tense description of `babysitter-repair`, which does not exist yet — evidence: `worker/deno/lib/fleet_babysitter_container.ts:1` — reason: fixed in this diff (marked planned, #4768)
- **clean** — Australian English; no hidden or key files staged; temp-dir hygiene; every seam has a production default; token only by name on the command line and in the child env; no workflow change; no existing test edited

## Test Plan

Added `worker/deno/tests/fleet_babysitter_container_4738_test.ts` (31 tests).
No existing test edited, no assertion removed.

- Red-checks (each guard broken alone, test file run, guard restored): ancestor
  comparison always false → key-guard refusal tests red; plan volumes kept →
  red; whole process env passed to spawn → red; kill skipped on timeout → red;
  image check dropped → red; egress refusal dropped → red; flag-spelling refusal
  off → red; `-e`/`--env=` GH_TOKEN spellings off → red; `clearEnv` removed from
  `babysitterSpawn` → red; image-check `!ok` returning false → red; stat error
  rethrown → red; path validation off → red; `redactSecrets` removed → red.
  The third path form (canonical of the normalised path) did not go red alone:
  on this Deno, `realPath` already follows `<root>/missing/../link`, so it is
  redundant here and kept for hosts where `realPath` fails on a missing
  component.
- `deno task test:unit tests/fleet_babysitter_container_4738_test.ts tests/fleet_babysitter_app_test.ts tests/lib_sweep_coverage_test.ts`: passed.
- `deno task check:manifests`: passed.
- Exempt (untestable): none.
- `./quality.sh < /dev/null`: `Result: PASSED (with skipped checks)`; config integration and checkov were skipped by the gate itself. An earlier run on a previous head failed on the missing lib-sweep claim (fixed here) and on `pr_maintenance_command_test.ts` tests that passed when re-run alone.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
