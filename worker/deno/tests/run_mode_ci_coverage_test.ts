/**
 * Both run modes must be exercised by CI (Issue #4150).
 *
 * The unit cases drive {@link auditRunModeCiCoverage} with synthetic workflows
 * — one that satisfies every #4150 requirement, and one per way a workflow can
 * stop proving a mode works. The last two cases run the audit against the real
 * `.github/workflows/validate-scripts.yml` and `container-build.yml`, so the
 * gate itself fails if a mode leg is dropped, renamed into ambiguity, or the
 * container build is quietly turned into a mode matrix.
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

/** A workflow that satisfies every #4150 requirement. */
function compliantWorkflow(): string {
  return `
name: Validate Scripts
on:
  pull_request:
    branches: [Develop]
jobs:
  run-mode:
    name: validate (\${{ matrix.mode }})
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      matrix:
        mode: [container, native]
    steps:
      - name: Take every container runtime off this runner
        if: matrix.mode == 'native'
        run: |
          for runtime in ${CONTAINER_RUNTIME_EXECUTABLES.join(" ")}; do
            command -v "\${runtime}" && exit 1
          done
      - name: Launcher and worker tests
        run: |
          cd worker/deno
          deno task test tests/run_sh_launcher_test.ts
      - name: Native smoke - the opt-in runs the driver on the host
        if: matrix.mode == 'native'
        env:
          VIBE_RUN_MODE: native
        run: ./run.sh < /dev/null
      - name: Native smoke - no opt-in fails loud
        if: matrix.mode == 'native'
        run: |
          ./run.sh < /dev/null > out.log 2>&1 || status=$?
          grep -q "${CONTAINER_RUNTIME_UNAVAILABLE_MARKER}" out.log
`;
}

Deno.test("run-mode CI coverage - a compliant workflow reports both modes and no problems", () => {
  const coverage = auditRunModeCiCoverage(compliantWorkflow());

  assertEquals(coverage.problems, []);
  assertEquals(coverage.jobs.map((job) => job.mode), ["container", "native"]);
  assertEquals(
    coverage.jobs.map((job) => job.checkName),
    ["validate (container)", "validate (native)"],
  );
  assertEquals(coverage.jobs.every((job) => job.runsModeTests), true);
  assertEquals(coverage.jobs.every((job) => job.timeoutMinutes === 20), true);

  const native = coverage.jobs.find((job) => job.mode === "native");
  assert(native);
  assertEquals(native.provesNoContainerRuntime, true);
  assertEquals(native.runsNativeOptInSmoke, true);
  assertEquals(native.runsLoudFailureSmoke, true);
});

Deno.test("run-mode CI coverage - dropping the native leg is a problem", () => {
  const workflow = compliantWorkflow().replace(
    "mode: [container, native]",
    "mode: [container]",
  );
  const coverage = auditRunModeCiCoverage(workflow);

  assertEquals(coverage.jobs.map((job) => job.mode), ["container"]);
  assert(
    coverage.problems.some((problem) => problem.includes("native")),
    `expected a missing-native problem, got: ${coverage.problems.join("; ")}`,
  );
});

Deno.test("run-mode CI coverage - a job environment can select the mode instead of a matrix", () => {
  const workflow = `
jobs:
  container-leg:
    name: validate (container)
    timeout-minutes: 20
    env:
      VIBE_RUN_MODE: container
    steps:
      - run: deno task test
  native-leg:
    name: validate (native)
    timeout-minutes: 20
    env:
      VIBE_RUN_MODE: native
    steps:
      - name: No container runtime
        run: |
          for runtime in ${CONTAINER_RUNTIME_EXECUTABLES.join(" ")}; do
            command -v "\${runtime}" && exit 1
          done
      - run: deno task test
      - run: VIBE_RUN_MODE=native ./run.sh < /dev/null
      - run: |
          ./run.sh < /dev/null > out.log 2>&1 || true
          grep -q "${CONTAINER_RUNTIME_UNAVAILABLE_MARKER}" out.log
`;

  const coverage = auditRunModeCiCoverage(workflow);
  assertEquals(coverage.problems, []);
  assertEquals(coverage.jobs.map((job) => job.jobId), [
    "container-leg",
    "native-leg",
  ]);
});

Deno.test("run-mode CI coverage - both legs reporting one check name is a problem", () => {
  const workflow = compliantWorkflow().replace(
    "name: validate (${{ matrix.mode }})",
    "name: validate",
  );
  const coverage = auditRunModeCiCoverage(workflow);

  assertEquals(coverage.jobs.map((job) => job.checkName), [
    "validate",
    "validate",
  ]);
  assert(
    coverage.problems.some((problem) => problem.includes("same check name")),
    `expected a clashing-name problem, got: ${coverage.problems.join("; ")}`,
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
    "run-mode (native)",
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
    2,
  );
});

Deno.test("run-mode CI coverage - a native leg missing either smoke half is a problem", () => {
  const withoutOptIn = auditRunModeCiCoverage(
    compliantWorkflow().replace(
      "          VIBE_RUN_MODE: native",
      "          FOO: bar",
    ),
  );
  assert(
    withoutOptIn.problems.some((problem) => problem.includes("native opt-in")),
    `expected a missing opt-in smoke problem, got: ${
      withoutOptIn.problems.join("; ")
    }`,
  );

  const withoutLoudFailure = auditRunModeCiCoverage(
    compliantWorkflow().replace(CONTAINER_RUNTIME_UNAVAILABLE_MARKER, "boom"),
  );
  assert(
    withoutLoudFailure.problems.some((problem) => problem.includes("loud")),
    `expected a missing loud-failure problem, got: ${
      withoutLoudFailure.problems.join("; ")
    }`,
  );
});

Deno.test("run-mode CI coverage - a native leg that keeps a container runtime is a problem", () => {
  const workflow = compliantWorkflow().replace(
    /\s+- name: Take every container runtime off this runner[\s\S]*?- name: Launcher/,
    "\n      - name: Launcher",
  );
  const coverage = auditRunModeCiCoverage(workflow);

  assert(
    coverage.problems.some((problem) =>
      problem.includes("no container runtime")
    ),
    `expected a runtime-present problem, got: ${coverage.problems.join("; ")}`,
  );
});

Deno.test("run-mode CI coverage - a mode leg with no timeout budget is a problem", () => {
  const workflow = compliantWorkflow().replace("    timeout-minutes: 20\n", "");
  const coverage = auditRunModeCiCoverage(workflow);

  assertEquals(coverage.jobs.every((job) => job.timeoutMinutes === null), true);
  assertEquals(
    coverage.problems.filter((problem) => problem.includes("timeout-minutes"))
      .length,
    2,
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

Deno.test("validate-scripts.yml exercises both run modes (Issue #4150)", async () => {
  const workflow = await Deno.readTextFile(VALIDATE_WORKFLOW);
  const coverage = auditRunModeCiCoverage(workflow);

  assertEquals(
    coverage.problems,
    [],
    "the Validate Scripts gate must exercise both run modes",
  );
  assertEquals(
    coverage.jobs.map((job) => job.mode).sort(),
    ["container", "native"],
  );

  // The required `validate` check must keep its name: turning it into a matrix
  // would rename it and leave branch protection waiting on a check that never
  // reports again.
  const parsedNames = coverage.jobs.map((job) => job.checkName);
  assertEquals(parsedNames.includes("validate"), false);
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
