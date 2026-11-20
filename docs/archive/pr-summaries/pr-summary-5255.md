## Summary

The Container Build pull-request change filter (`IMAGE_PATHS` in
`.github/scripts/detect-image-changes.sh`) now lists the babysitter repair gate
modules and the containment probe fixture. A pull request that changes any of
them builds the image and runs the containment suite's step "babysitter repairs
run real checks before READY and publication", instead of reporting the required
`container` check green with every step skipped. Closes #5255.

## Spec

### Intent and Rationale

- The filter listed `container_containment_test.ts` but none of the modules its
  babysitter step runs, so a change to the gate (PR #5252 is the example the
  issue gives) was first exercised on the weekly scheduled run, after merge.
- Listing the five paths the issue names follows the existing pattern (Issues
  #2070–#2073, #4047): a worker module an in-image check exercises is
  image-affecting.

### Essential Design Decisions

- Exactly the five paths the issue names were added, as literal entries:
  `worker/deno/lib/babysitter_tree_gate.ts`, `worker/deno/lib/pre_push_gate.ts`,
  `worker/deno/commands/babysitter_repair.ts`,
  `worker/deno/lib/fleet_babysitter_container.ts` and
  `worker/deno/tests/support/babysitter_gate_container_probe.ts`.
- The probe's own helper imports (`babysitter_ready.ts`,
  `tests/support/babysitter_harness.ts`,
  `tests/support/babysitter_tree_fixture.ts`) and the gate's transitive imports
  are not listed: the issue names the five modules, and each extra path puts
  more worker-only PRs on the image build. A change to those files is still
  exercised by the weekly scheduled build.

### Undiscoverable Facts

None.

## Evidence

CI/script change; no UI files.

- New test
  `worker/deno/tests/container_image_change_filter_test.ts::image filter - babysitter gate changes run the containment probes (Issue #5255)`
  commits each of the five paths in a throwaway repository and runs the real
  script. Against the unchanged script it failed with
  `Expected actual: "image=false\n" to contain: "image=true": worker/deno/lib/babysitter_tree_gate.ts`;
  after the change it passes.
- Docs updated: `docs/workflows/fleet-pr-babysitter.md` (the containment probe
  paragraph now says these changes run the step) and `docs/CONTAINER.md` (the
  list of image-affecting paths no longer reads as complete, and the weekly
  sweep covers "the rest of `worker/**`"). Grepped `README.md`, `docs/` and the
  scripts for `detect-image-changes` and `IMAGE_PATHS`;
  `docs/EC2-LINUX-VERIFICATION.md` mentions the script without listing paths and
  stays true.
- Issue numbers the diff adds: #5255: Container Build change filter skips the
  babysitter gate probes when the gate's own modules change.

## Test Plan

- Added the test above. No existing test or assertion was edited.
- `deno test -A tests/container_image_change_filter_test.ts`: 12 passed, 0
  failed. The existing negative control "an unrelated worker change still skips
  the image build (Issue #4047)" still gets `image=false`.
- `deno test -A tests/container_build_probe_paths_test.ts` (reads `IMAGE_PATHS`
  from the script): 2 passed, 0 failed.
- `shellcheck` and `bash -n` on the script: clean. `deno fmt --check` and
  `deno lint` on the test file: clean. `markdownlint-cli2` on both docs: 0
  issues.
- `./quality.sh < /dev/null` on the head:
  `Result: PASSED (with skipped checks)`. Config integration was skipped
  (`deno or .config.json not available`), and so was checkov (no checkov on
  PATH).

Not done: the live containment step itself was not run here (it needs a built
image); the new filter entries only decide that CI runs it.
