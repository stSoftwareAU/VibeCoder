# Run the review-fleet-prs headless round inside the worker container image

## Summary

The review-fleet-prs runner (`.claude/skills/review-fleet-prs/run.sh`) used to
start each review round as `claude -p` on the host, using the host's own
`claude` login. #3289 then copied the worker's credential plumbing into a host
script (`claude_credential.ts`) to pick a subscription. Now the cheap parts
stay on the host: the gate pass, the audit send-backs and the escalation. The
round itself runs as a `container run` of the worker image. That gives one
place that knows how to run Claude unattended on the right subscription,
instead of two.

- **`worker/deno/lib/review_round.ts`, `worker/deno/commands/review_round.ts`**:
  the new `review-round` driver command. It exports the subscription the
  worker's Claude credential pool ranks first (`createClaudeCredentialPool`,
  `applyProviderCredentialEnv`). It runs `claude -p` with
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`. After a usage-limit refusal it
  switches to the next subscription with budget (`selectAvailable` with the
  spent label excluded, then `applySelection`) and runs once more. Labels are
  logged; token values never are.
- **`container/entrypoint.sh`**: when `review-round` is the first argument,
  the entrypoint does its usual staging and then runs that command instead of
  `run-entrypoint`.
- **`run.sh`**: builds the round's container from the worker's own
  `mod.ts container-launch-plan`, with the same image, credential mounts, log
  mount and checkout mount.
  - It leaves out the worker's named volumes.
  - It passes the reviewer App token as `--env GH_TOKEN`, by name only.
  - It checks that the image is built and the runtime is on `PATH`.
  - It writes the prompt to `prompt.md` in the round directory, using
    container paths.
  - A timed-out round's container is killed by name.
  - `claude_credential.ts` and its test are removed.
- **`post.ts`**: a new `--state-dir=<dir>` option, because inside the
  container the state directory is mounted at another path.
- **`SKILL.md`**: the host requirements are now the worker's (container
  runtime, built image, credential directory) instead of a host `claude`
  login. A new section explains where a round runs and how its subscription is
  chosen.

Closes #3293

## Spec

### Intent and Rationale

- One credential path for unattended Claude: the round uses the driver's pool
  and rotation rather than a host-side copy of them.
- The gate keeps running on the host every 5 minutes with no model and no
  container, so an idle host starts nothing.

### Essential Design Decisions

- The round's container comes from `container-launch-plan`, not from a
  second hand-written `run` line, so the containment contract stays in one
  module. The named volumes are dropped because the worker's own container
  may be using them. On Apple `container` they are block devices that must not
  be mounted by two VMs at once.
- Inside the container, the round reaches the state directory through the
  worker's existing log mount (`<log_dir>` → `/home/vibe/logs`). `post.ts` is
  told the path with `--state-dir`, not an environment override; `log_dir.ts`
  deliberately ignores log-directory environment variables.
- `--env GH_TOKEN` with no value makes the runtime copy the variable from the
  host environment. The token is minted on the host as before, and its value
  is never on a command line, in a `bash -x` trace or in a file.
- The 50-minute alarm, the per-round directory and the runner's log lines
  are unchanged. The usage-limit rotation now happens inside the container,
  so its log lines come from the driver.

### Undiscoverable Facts

- The image tag is derived from the content of `container/entrypoint.sh`
  (`container_image_hash.ts`). An image built before this change therefore
  never matches the plan, and the runner reports
  `the worker image is not built` instead of starting an old entrypoint, which
  would run the worker loop. The worker's next launch builds the new image.
- A real `container-launch-plan` on a macOS host emits the mounts as
  `--volume src:target[:ro]` and the named volumes as `volume=` keys. The
  runner's parser was checked against a real plan.

## Evidence

This changes infrastructure only and has no UI, so there are no screenshots.
`review_round_test.ts`, `review_fleet_prs_runner_test.ts` and
`container_entrypoint_test.ts` pin the behaviour. A real launch plan was
generated on a macOS host and its argument layout checked against the
runner's parser.

**Docs sweep:** grep `claude_credential.ts`, `review-fleet-prs/run.sh`,
`review-round`, `host's claude login`. Updated
`.claude/skills/review-fleet-prs/SKILL.md` (Running unattended; Where a round
runs; Persistent failure escalation; the `post.ts` `--state-dir` note).
`docs/CONFIGURATION.md:382` is still true because the runner is still
`run.sh`, and it still reviews as the App.

## Test Plan

- `worker/deno/tests/review_round_test.ts` (new):
  - the pool's subscription is exported and only its label is logged;
  - a usage-limit round is retried once on the next subscription;
  - with no subscription left, the round stays failed;
  - a round that failed for another reason is not retried;
  - a token that came from no pool file is not rotated.
- `worker/deno/tests/review_fleet_prs_runner_test.ts`: the `claude` stub is
  replaced by a stubbed container runtime and a stubbed launch plan.
  - New cases:
    - the round runs in `review-round` mode with container paths;
    - the named volumes are left out;
    - `GH_TOKEN` is passed by name only, even under `bash -x`;
    - there is no `GH_TOKEN` without an App;
    - a missing image fails the pass;
    - a failed plan fails the pass;
    - a timed-out container is killed by name;
    - a missing runtime fails the pass.
  - The #3289 host-credential cases moved to `review_round_test.ts`.
- `worker/deno/tests/container_entrypoint_test.ts`: `review-round` runs the
  round instead of `run-entrypoint`.
- `worker/deno/tests/mod_test.ts`: the command count goes from 151 to 152.
- `./quality.sh`:
  - Every check passes and every test passes.
  - Locally, the unit-test time budget flagged 24 unrelated git-heavy suites
    because the host was under load. None of them are touched here.
