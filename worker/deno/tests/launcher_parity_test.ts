/**
 * The two launchers must not drift apart (Issue #4066).
 *
 * `run.sh` and `run.ps1` are the containment boundary on their own hosts, and
 * a Windows host must not end up quietly less contained than a macOS one.
 * Parity is checked two ways:
 *
 * 1. **By source.** Both launchers are read and the contract each keeps is
 *    extracted — whether it delegates to `container-launch-plan`, which plan
 *    keys it honours, whether it hardcodes a mount, broadens privileges or
 *    can run the worker on the host without the explicit run-mode opt-in.
 *    This half runs everywhere.
 * 2. **By invocation.** Where PowerShell is installed, both launchers are run
 *    against the same recording stub and the argument lists they hand the
 *    runtime are compared directly: mount sets, read-only flags, network
 *    settings and privilege flags must be identical.
 *
 * Issue #4147 reworks the native-path rule: markers are data, and the fault is
 * *ungated* native execution. The one intended asymmetry — Windows stays
 * container-only — is recorded as the named `windows-container-only`
 * exception and asserted to still be in force, both in the source contract and
 * behaviourally (requesting native under `run.ps1` exits non-zero).
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  compareLauncherContracts,
  extractLauncherContract,
  LAUNCH_PLAN_KEYS,
  launcherContractFaults,
  WINDOWS_CONTAINER_ONLY,
} from "../lib/launcher_contract.ts";
import {
  BASH_LAUNCHER,
  mountValues,
  POWERSHELL_LAUNCHER,
  recorded,
  REPO_ROOT,
  runLauncher,
  setupHarness,
} from "./fixtures/launcher_harness.ts";

const RUN_SH_SOURCE = await Deno.readTextFile(`${REPO_ROOT}/run.sh`);
const RUN_PS1_SOURCE = await Deno.readTextFile(`${REPO_ROOT}/run.ps1`);

const RUN_SH = extractLauncherContract("run.sh", RUN_SH_SOURCE, "bash");
const RUN_PS1 = extractLauncherContract(
  "run.ps1",
  RUN_PS1_SOURCE,
  "powershell",
);

// ---------------------------------------------------------------------------
// The extractor itself, against sources whose contents are known
// ---------------------------------------------------------------------------

Deno.test("extractLauncherContract - reads the keys a bash launcher honours", () => {
  const contract = extractLauncherContract(
    "sample.sh",
    [
      'if ! deno run mod.ts container-launch-plan --out "${PLAN}"; then exit 1; fi',
      "case ${key} in",
      "  runtime) RUNTIME=${value} ;;",
      "  run) run_args+=(${value}) ;;",
      "esac",
    ].join("\n"),
    "bash",
  );

  assertEquals(contract.delegatesToLaunchPlan, true);
  assertEquals(contract.planKeys, ["runtime", "run"]);
  assertEquals(contract.broadeningMarkers, []);
  assertEquals(contract.nativeExecutionMarkers, []);
  assertEquals(contract.ungatedNativeExecution, []);
  assertEquals(contract.consultsRunMode, false);
  assertEquals(contract.containerPathGatedOnNative, false);
  assertEquals(contract.hardcodedMountFlags, []);
});

Deno.test("extractLauncherContract - reads the keys a PowerShell launcher honours", () => {
  const contract = extractLauncherContract(
    "sample.ps1",
    [
      "& deno run mod.ts container-launch-plan --out $PlanFile",
      "switch -CaseSensitive ($key) {",
      '    "runtime" { $Runtime = $value }',
      "    'run' { $RunArgs.Add($value) }",
      "}",
    ].join("\n"),
    "powershell",
  );

  assertEquals(contract.delegatesToLaunchPlan, true);
  assertEquals(contract.planKeys, ["runtime", "run"]);
});

Deno.test("extractLauncherContract - names a launcher that decides for itself", () => {
  const contract = extractLauncherContract(
    "rogue.ps1",
    [
      "$runArgs = @('run', '--privileged', '--network=host',",
      "    '--volume', '/var/run/docker.sock:/var/run/docker.sock')",
      "& deno run mod.ts run-entrypoint --base-dir $BaseDir",
    ].join("\n"),
    "powershell",
  );

  assertEquals(contract.delegatesToLaunchPlan, false);
  assertEquals(contract.planKeys, []);
  assertEquals(contract.broadeningMarkers, [
    "--privileged",
    "--network=host",
    "docker.sock",
  ]);
  assertEquals(contract.nativeExecutionMarkers, ["run-entrypoint"]);
  assertEquals(contract.ungatedNativeExecution, ["run-entrypoint"]);
  assertEquals(contract.consultsRunMode, false);
  assertEquals(contract.hardcodedMountFlags, ["--volume"]);

  const faults = launcherContractFaults(contract);
  assertEquals(faults.length, 5, faults.join("\n"));
});

// ---------------------------------------------------------------------------
// The gated/ungated native distinction (Issue #4147)
// ---------------------------------------------------------------------------

/** A synthetic bash launcher that honours every launch-plan key. */
function bashLauncher(...extraLines: string[]): string {
  return [
    'if ! deno run mod.ts container-launch-plan --out "${PLAN}"; then exit 1; fi',
    "case ${key} in",
    ...LAUNCH_PLAN_KEYS.map((key) => `  ${key}) value_of_${key}=${key} ;;`),
    "esac",
    ...extraLines,
  ].join("\n");
}

Deno.test("launcherContractFaults - ungated native execution is a fault even with the resolver present", () => {
  const contract = extractLauncherContract(
    "ungated.sh",
    bashLauncher(
      'MODE="$(deno run mod.ts run-mode)"',
      // Consulting the resolver is not enough: nothing acts on the answer.
      'exec deno run mod.ts run-entrypoint --base-dir "${BASE_DIR}"',
    ),
    "bash",
  );

  assertEquals(contract.consultsRunMode, true);
  assertEquals(contract.nativeExecutionMarkers, ["run-entrypoint"]);
  assertEquals(contract.ungatedNativeExecution, ["run-entrypoint"]);

  const faults = launcherContractFaults(contract);
  assertEquals(faults.length, 1, faults.join("\n"));
  assertStringIncludes(faults[0]!, "without the explicit run-mode opt-in");
});

Deno.test("launcherContractFaults - native execution without the resolver at all is a fault", () => {
  const contract = extractLauncherContract(
    "no-resolver.sh",
    bashLauncher(
      'if [[ "${1:-}" == "--native" ]]; then',
      '  exec deno run mod.ts run-entrypoint --base-dir "${BASE_DIR}"',
      "fi",
    ),
    "bash",
  );

  // A native-looking branch that never asks the resolver is still ungated:
  // the opt-in has to be the run mode, not a flag the launcher invents.
  assertEquals(contract.consultsRunMode, false);
  assertEquals(contract.ungatedNativeExecution, ["run-entrypoint"]);
  assertEquals(launcherContractFaults(contract).length, 1);
});

Deno.test("launcherContractFaults - a resolver-gated native branch is not a fault", () => {
  const contract = extractLauncherContract(
    "gated.sh",
    bashLauncher(
      'RUN_MODE="$(deno run mod.ts run-mode)"',
      'if [[ "${RUN_MODE}" == "native" ]]; then',
      '  exec deno run mod.ts run-entrypoint --base-dir "${BASE_DIR}"',
      "fi",
    ),
    "bash",
  );

  assertEquals(contract.consultsRunMode, true);
  assertEquals(contract.nativeExecutionMarkers, ["run-entrypoint"]);
  assertEquals(contract.ungatedNativeExecution, []);
  assertEquals(contract.containerPathGatedOnNative, false);

  const faults = launcherContractFaults(contract);
  assertEquals(faults, [], faults.join("\n"));
});

Deno.test("launcherContractFaults - a PowerShell native branch gates the same way", () => {
  const gated = extractLauncherContract(
    "gated.ps1",
    [
      "& deno run mod.ts container-launch-plan --out $PlanFile",
      "switch -CaseSensitive ($key) {",
      ...LAUNCH_PLAN_KEYS.map((key) => `    "${key}" { $Seen.Add("${key}") }`),
      "}",
      "$RunMode = (& deno run mod.ts run-mode).Trim()",
      'if ($RunMode -eq "native") {',
      "    & deno run mod.ts run-entrypoint --base-dir $BaseDir",
      "    exit $LASTEXITCODE",
      "}",
    ].join("\n"),
    "powershell",
  );

  assertEquals(gated.ungatedNativeExecution, []);
  assertEquals(launcherContractFaults(gated), []);

  // The same launcher with the branch removed is a fault again.
  const ungated = extractLauncherContract(
    "ungated.ps1",
    [
      "& deno run mod.ts container-launch-plan --out $PlanFile",
      "$RunMode = (& deno run mod.ts run-mode).Trim()",
      "& deno run mod.ts run-entrypoint --base-dir $BaseDir",
    ].join("\n"),
    "powershell",
  );
  assertEquals(ungated.ungatedNativeExecution, ["run-entrypoint"]);
  assert(
    launcherContractFaults(ungated).some((fault) =>
      fault.includes("without the explicit run-mode opt-in")
    ),
  );
});

Deno.test("launcherContractFaults - the container path may not itself be the opt-in", () => {
  const contract = extractLauncherContract(
    "inverted.sh",
    [
      'RUN_MODE="$(deno run mod.ts run-mode)"',
      'if [[ "${RUN_MODE}" != "native" ]]; then',
      '  deno run mod.ts container-launch-plan --out "${PLAN}"',
      "fi",
      "case ${key} in",
      ...LAUNCH_PLAN_KEYS.map((key) => `  ${key}) value_of_${key}=${key} ;;`),
      "esac",
    ].join("\n"),
    "bash",
  );

  // `!= native` still names the native mode, so the branch reads as the
  // native one: the container launch must not be reachable only from there.
  assertEquals(contract.containerPathGatedOnNative, true);
  assert(
    launcherContractFaults(contract).some((fault) =>
      fault.includes("makes the container path the opt-in")
    ),
  );
});

// ---------------------------------------------------------------------------
// Parity comparison
// ---------------------------------------------------------------------------

Deno.test("compareLauncherContracts - reports a launcher that drops a plan key", () => {
  const drifted = extractLauncherContract(
    "run.ps1",
    RUN_PS1_SOURCE.replace(/^\s*"ensure".*$/m, "        # ensure removed"),
    "powershell",
  );

  const { divergences } = compareLauncherContracts(RUN_SH, drifted);
  assertEquals(divergences.length, 1, divergences.join("\n"));
  assert(divergences[0]!.includes("launch-plan keys"));
});

Deno.test("compareLauncherContracts - reports a launcher that broadens the container", () => {
  const drifted = extractLauncherContract(
    "run.ps1",
    `${RUN_PS1_SOURCE}\n$RunArgs.Add("--privileged")\n`,
    "powershell",
  );

  const { divergences } = compareLauncherContracts(RUN_SH, drifted);
  assertEquals(divergences.length, 1, divergences.join("\n"));
  assert(divergences[0]!.includes("privilege/exposure markers"));
});

Deno.test("compareLauncherContracts - the Windows exception does not cover a native run.ps1", () => {
  const drifted = extractLauncherContract(
    "run.ps1",
    `${RUN_PS1_SOURCE}\n& deno run mod.ts run-entrypoint --base-dir $BaseDir\n`,
    "powershell",
  );

  const report = compareLauncherContracts(RUN_SH, drifted);
  assert(
    report.divergences.some((message) =>
      message.includes("native execution markers")
    ),
    `a native run.ps1 must be a real divergence: ${JSON.stringify(report)}`,
  );
  assertEquals(report.excepted, []);
});

Deno.test("compareLauncherContracts - a gated native run.ps1 lapses the exception too", () => {
  // Since Issue #4148 `run.sh` legitimately carries native markers of its own,
  // so a `run.ps1` that gained a properly gated native branch would match it
  // marker for marker and diverge on nothing. The exception is a promise about
  // `run.ps1` alone, so its lapse is reported whatever `run.sh` does.
  const drifted = extractLauncherContract(
    "run.ps1",
    `${RUN_PS1_SOURCE}\nif ($RunMode -eq "native") {\n` +
      `  & deno run mod.ts run-entrypoint --base-dir $BaseDir\n}\n`,
    "powershell",
  );

  assertEquals(drifted.ungatedNativeExecution, []);
  const report = compareLauncherContracts(RUN_SH, drifted);
  assert(
    report.divergences.some((message) =>
      message.includes(WINDOWS_CONTAINER_ONLY.name)
    ),
    `a gated native run.ps1 must lapse the exception: ${
      JSON.stringify(report)
    }`,
  );
  assertEquals(report.excepted, []);
});

// ---------------------------------------------------------------------------
// The real launchers
// ---------------------------------------------------------------------------

Deno.test("run.sh and run.ps1 - keep the same launch contract", () => {
  const { divergences } = compareLauncherContracts(RUN_SH, RUN_PS1);
  assertEquals(divergences, [], divergences.join("\n"));
});

Deno.test("run.sh and run.ps1 - the Windows container-only asymmetry stays a named exception", () => {
  // The asymmetry itself: run.ps1 is container-only by design (#4145), so it
  // consults the run mode purely to refuse a native opt-in, and never carries
  // a native execution path.
  assertEquals(
    RUN_PS1.consultsRunMode,
    true,
    "run.ps1 must resolve the run mode so a native opt-in fails loudly",
  );
  assertEquals(
    RUN_PS1.nativeExecutionMarkers,
    [],
    "run.ps1 must stay container-only",
  );
  assertEquals(WINDOWS_CONTAINER_ONLY.launcher, "run.ps1");

  // Every divergence the two launchers keep is named by that exception - it
  // is recorded, not silently tolerated.
  const report = compareLauncherContracts(RUN_SH, RUN_PS1);
  for (const excepted of report.excepted) {
    assertStringIncludes(excepted, `[${WINDOWS_CONTAINER_ONLY.name}]`);
    assertStringIncludes(excepted, WINDOWS_CONTAINER_ONLY.reason);
  }
  assertEquals(
    report.excepted.length > 0,
    RUN_SH.consultsRunMode !== RUN_PS1.consultsRunMode ||
      RUN_SH.nativeExecutionMarkers.length > 0,
    "an intended asymmetry must be reported whenever it exists",
  );
});

Deno.test("run.sh and run.ps1 - both delegate every containment decision", () => {
  for (const contract of [RUN_SH, RUN_PS1]) {
    const faults = launcherContractFaults(contract);
    assertEquals(faults, [], faults.join("\n"));
    assertEquals(contract.planKeys, [...LAUNCH_PLAN_KEYS]);
  }
});

Deno.test({
  name:
    "run.ps1 - refuses an explicit native opt-in instead of launching a container",
  ignore: POWERSHELL_LAUNCHER === null,
  fn: async () => {
    const harness = await setupHarness({
      STUB_IMAGE_INSPECT_EXIT: "0",
      VIBE_RUN_MODE: "native",
    });
    try {
      const outcome = await runLauncher(harness, POWERSHELL_LAUNCHER!);
      assert(
        outcome.code !== 0,
        `native mode must fail on Windows, not fall through: ${outcome.stderr}`,
      );
      assertStringIncludes(outcome.stderr, "native");
      assertStringIncludes(outcome.stderr, "container-only");
      assertEquals(
        await recorded(harness, "run"),
        null,
        "a refused native opt-in must never launch a container instead",
      );
    } finally {
      await harness.cleanup();
    }
  },
});

Deno.test({
  name: "run.sh and run.ps1 - hand the runtime the same invocation",
  ignore: POWERSHELL_LAUNCHER === null,
  fn: async () => {
    /** Run one launcher and return the container invocation it produced. */
    const invocationOf = async (
      launcher: typeof BASH_LAUNCHER,
    ): Promise<{ args: string[]; tmpDir: string }> => {
      const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "0" });
      try {
        const outcome = await runLauncher(harness, launcher);
        assertEquals(outcome.code, 0, outcome.stderr);
        const args = await recorded(harness, "run");
        assert(args, `${launcher.name} launched no container`);
        return { args, tmpDir: harness.tmpDir };
      } finally {
        await harness.cleanup();
      }
    };

    const bash = await invocationOf(BASH_LAUNCHER);
    const powershell = await invocationOf(POWERSHELL_LAUNCHER!);

    /**
     * Normalise the two run-specific values away: each harness gets its own
     * temporary host directory, and each launch its own container name.
     */
    const normalise = (invocation: { args: string[]; tmpDir: string }) =>
      invocation.args.map((arg) =>
        arg
          .replaceAll(invocation.tmpDir, "<host>")
          .replace(/^vibe-coder-\d+$/, "<container-name>")
      );

    assertEquals(
      normalise(powershell),
      normalise(bash),
      "run.ps1 must hand the runtime exactly what run.sh does — mounts, " +
        "read-only flags, network settings and privilege flags included",
    );

    // Stated separately so a failure names the mounts rather than the whole
    // argument list.
    assertEquals(
      mountValues(normalise(powershell)),
      mountValues(normalise(bash)),
    );
  },
});
