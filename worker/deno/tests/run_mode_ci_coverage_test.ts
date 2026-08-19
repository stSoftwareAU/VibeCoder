/**
 * The run mode must be exercised by CI, and the no-host-fallback contract
 * proven (Issues #4150, #4).
 *
 * The unit cases drive {@link auditRunModeCiCoverage} with synthetic workflows
 * — one that satisfies every requirement, and one per way a workflow can stop
 * proving containment. The last cases run the audit against the real
 * `.github/workflows/validate-scripts.yml` and `container-build.yml`, so the
 * gate itself fails if the container leg is dropped, renamed into ambiguity,
 * the no-runtime proof disappears, or the container build is quietly turned
 * into a mode matrix.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  auditRunModeCiCoverage,
  CONTAINER_RUNTIME_EXECUTABLES,
  CONTAINER_RUNTIME_UNAVAILABLE_MARKER,
} from "../lib/run_mode_ci_coverage.ts";
import { scanActionPins } from "../lib/action_pin_scanner.ts";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const VALIDATE_WORKFLOW = `${REPO_ROOT}/.github/workflows/validate-scripts.yml`;
const CONTAINER_WORKFLOW = `${REPO_ROOT}/.github/workflows/container-build.yml`;

/** A workflow that satisfies every requirement. */
function compliantWorkflow(): string {
  return `
name: Validate Scripts
on:
  pull_request:
    branches: [main]
jobs:
  run-mode:
    name: validate (\${{ matrix.mode }})
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      matrix:
        mode: [container, no-runtime]
    steps:
      - name: Take every container runtime off this runner
        if: matrix.mode == 'no-runtime'
        run: |
          for runtime in ${CONTAINER_RUNTIME_EXECUTABLES.join(" ")}; do
            command -v "\${runtime}" && exit 1
          done
      - name: Launcher and worker tests
        run: |
          cd worker/deno
          deno task test tests/run_sh_launcher_test.ts
      - name: No-runtime smoke - the launch fails loud
        if: matrix.mode == 'no-runtime'
        run: |
          ./run.sh < /dev/null > out.log 2>&1 || status=$?
          grep -q "${CONTAINER_RUNTIME_UNAVAILABLE_MARKER}" out.log
`;
}

Deno.test("run-mode CI coverage - a compliant workflow reports the container leg, the no-host-fallback proof, and no problems", () => {
  const coverage = auditRunModeCiCoverage(compliantWorkflow());

  // `no-runtime` is not a run mode, so it is not a mode leg: only container
  // is (Issue #4).
  assertEquals(coverage.jobs.map((job) => job.mode), ["container"]);
  assertEquals(coverage.jobs.map((job) => job.checkName), [
    "validate (container)",
  ]);
  assertEquals(coverage.noHostFallbackProofs, ["run-mode"]);
  assertEquals(coverage.problems, []);
});

Deno.test("run-mode CI coverage - dropping the container leg is a problem", () => {
  const workflow = compliantWorkflow().replace(
    "mode: [container, no-runtime]",
    "mode: [no-runtime]",
  );
  const coverage = auditRunModeCiCoverage(workflow);

  // No mode leg at all reads as "not a mode gate" — the real-workflow test
  // below is what pins that the gate has one. With a mode job present but
  // the container value gone the problem is named.
  assertEquals(coverage.jobs, []);

  const envSelected = `
jobs:
  other:
    name: validate (container)
    timeout-minutes: 5
    env:
      VIBE_RUN_MODE: container
    steps:
      - run: deno task test
`;
  assertEquals(auditRunModeCiCoverage(envSelected).jobs.length, 1);
});

Deno.test("run-mode CI coverage - a job environment can select the mode instead of a matrix", () => {
  const workflow = `
jobs:
  container-leg:
    name: validate (container)
    timeout-minutes: 5
    env:
      VIBE_RUN_MODE: container
    steps:
      - run: |
          for runtime in ${CONTAINER_RUNTIME_EXECUTABLES.join(" ")}; do
            command -v "$runtime"
          done
      - run: deno task test
      - run: |
          ./run.sh < /dev/null || true
          grep "${CONTAINER_RUNTIME_UNAVAILABLE_MARKER}" out.log
`;
  const coverage = auditRunModeCiCoverage(workflow);
  assertEquals(coverage.jobs.map((job) => job.jobId), ["container-leg"]);
  assertEquals(coverage.problems, []);
});

Deno.test("run-mode CI coverage - a removed mode in a matrix is not a mode leg (Issue #4)", () => {
  const workflow = compliantWorkflow().replace(
    "mode: [container, no-runtime]",
    "mode: [container, native, seatbelt]",
  );
  const coverage = auditRunModeCiCoverage(workflow);
  assertEquals(coverage.jobs.map((job) => job.mode), ["container"]);
});

Deno.test("run-mode CI coverage - losing the no-host-fallback proof is a problem", () => {
  const withoutSmoke = auditRunModeCiCoverage(
    compliantWorkflow().replace(
      `grep -q "${CONTAINER_RUNTIME_UNAVAILABLE_MARKER}" out.log`,
      "true",
    ),
  );
  assertEquals(withoutSmoke.noHostFallbackProofs, []);
  assert(
    withoutSmoke.problems.some((p) => p.includes("no-host-fallback")),
    withoutSmoke.problems.join("; "),
  );

  const withRuntimeKept = auditRunModeCiCoverage(
    compliantWorkflow().replace('command -v "${runtime}" && exit 1', "true"),
  );
  assertEquals(withRuntimeKept.noHostFallbackProofs, []);
  assert(
    withRuntimeKept.problems.some((p) => p.includes("no-host-fallback")),
  );
});

Deno.test("run-mode CI coverage - a leg reporting a bare check name is a problem", () => {
  const workflow = compliantWorkflow().replace(
    "name: validate (${{ matrix.mode }})",
    "name: validate",
  );
  const coverage = auditRunModeCiCoverage(workflow);

  assertEquals(coverage.jobs.map((job) => job.checkName), ["validate"]);
  assert(
    coverage.problems.some((problem) =>
      problem.includes("does not name the mode")
    ),
    `expected a naming problem, got: ${coverage.problems.join("; ")}`,
  );
});

Deno.test("run-mode CI coverage - an unnamed matrix job takes GitHub's own leg name", () => {
  const workflow = compliantWorkflow().replace(
    "    name: validate (${{ matrix.mode }})\n",
    "",
  );
  const coverage = auditRunModeCiCoverage(workflow);

  assertEquals(coverage.jobs.map((job) => job.checkName), [
    "run-mode (container)",
  ]);
  assertEquals(coverage.problems, []);
});

Deno.test("run-mode CI coverage - a leg that runs no tests is a problem", () => {
  const workflow = compliantWorkflow().replace(
    "          deno task test tests/run_sh_launcher_test.ts",
    "          echo skipped",
  );
  const coverage = auditRunModeCiCoverage(workflow);

  assertEquals(coverage.jobs.every((job) => job.runsModeTests), false);
  assertEquals(
    coverage.problems.filter((problem) => problem.includes("runs no tests"))
      .length,
    1,
  );
});

Deno.test("run-mode CI coverage - a mode leg with no timeout budget is a problem", () => {
  const workflow = compliantWorkflow().replace("    timeout-minutes: 20\n", "");
  const coverage = auditRunModeCiCoverage(workflow);

  assertEquals(coverage.jobs.every((job) => job.timeoutMinutes === null), true);
  assertEquals(
    coverage.problems.filter((problem) => problem.includes("timeout-minutes"))
      .length,
    1,
  );
});

Deno.test("run-mode CI coverage - the loud-failure marker is the message a runtime-less host prints", () => {
  // Derived, not restated: a reworded error changes what CI must grep for.
  assertEquals(
    CONTAINER_RUNTIME_UNAVAILABLE_MARKER,
    "No supported container runtime is available on",
  );
});

// ---------------------------------------------------------------------------
// The real workflows
// ---------------------------------------------------------------------------

Deno.test("validate-scripts.yml exercises container mode and proves no host fallback (Issues #4150, #4)", async () => {
  const workflow = await Deno.readTextFile(VALIDATE_WORKFLOW);
  const coverage = auditRunModeCiCoverage(workflow);

  assertEquals(
    coverage.problems,
    [],
    "the Validate Scripts gate must exercise container mode and prove no host fallback",
  );
  assertEquals(coverage.jobs.map((job) => job.mode), ["container"]);
  assertEquals(coverage.noHostFallbackProofs.length >= 1, true);

  // The required `validate` check must keep its name: turning it into a matrix
  // would rename it and leave branch protection waiting on a check that never
  // reports again.
  const parsedNames = coverage.jobs.map((job) => job.checkName);
  assertEquals(parsedNames.includes("validate"), false);
  // Containment is mandatory (Issue #4): no host-mode leg, no opt-in smoke.
  assertEquals(workflow.includes("VIBE_RUN_MODE: native"), false);
  assertEquals(workflow.includes("native_run"), false);
});

Deno.test("validate-scripts.yml pins every third-party action to a SHA (Issue #2123)", async () => {
  const workflow = await Deno.readTextFile(VALIDATE_WORKFLOW);
  const findings = scanActionPins([{
    path: ".github/workflows/validate-scripts.yml",
    rawText: workflow,
    parsed: null,
    kind: "workflow",
  }]);
  assertEquals(
    findings.map((finding) => finding.coordinate),
    [],
    "the run-mode legs must not add an unpinned action",
  );
});

Deno.test("container-build.yml stays container-only (Issue #4150)", async () => {
  const workflow = await Deno.readTextFile(CONTAINER_WORKFLOW);
  const coverage = auditRunModeCiCoverage(workflow);

  assertEquals(
    coverage.jobs,
    [],
    "the image build and its in-image verifications are container-only",
  );
  assertEquals(workflow.includes("VIBE_RUN_MODE"), false);
});
