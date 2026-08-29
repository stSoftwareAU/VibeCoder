/**
 * The two launchers must not drift apart (Issue #4066).
 *
 * `run.sh` and `run.ps1` are the containment boundary on their own hosts, and
 * a Windows host must not end up quietly less contained than a macOS one.
 *
 * Parity is checked two ways:
 *
 * 1. **By source.** Both launchers are read and the contract each keeps is
 *    extracted — whether it delegates to `container-launch-plan`, which plan
 *    keys it honours, whether it hardcodes a mount, broadens privileges or
 *    can run the worker on the host at all. This half runs everywhere.
 * 2. **By invocation.** Where PowerShell is installed, both launchers are run
 *    against the same recording stub and the argument lists they hand the
 *    runtime are compared directly: mount sets, read-only flags, network
 *    settings and privilege flags must be identical.
 *
 * Containment is mandatory (Issue #4): a host-execution marker in either
 * launcher is a fault outright, both launchers consult the run-mode resolver
 * (so a removed mode fails loud), and there is no intended asymmetry left to
 * except — the two contracts must simply be equal.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  compareLauncherContracts,
  extractLauncherContract,
  LAUNCH_PLAN_KEYS,
  launcherContractFaults,
} from "../lib/launcher_contract.ts";
import {
  BASH_LAUNCHER,
  denoInvocationOrder,
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
  assertEquals(contract.consultsRunMode, false);
  assertEquals(contract.updatesCheckout, false);
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
  assertEquals(contract.consultsRunMode, false);
  assertEquals(contract.hardcodedMountFlags, ["--volume"]);

  // No delegation, missing plan keys, broadening, host execution, no
  // run-mode consultation, no host-side checkout update (Issue #512),
  // hardcoded mounts: seven faults.
  const faults = launcherContractFaults(contract);
  assertEquals(faults.length, 7, faults.join("\n"));
});

// ---------------------------------------------------------------------------
// Host execution is a fault outright (Issue #4)
// ---------------------------------------------------------------------------

/**
 * A synthetic bash launcher that honours every launch-plan key, consults the
 * run-mode resolver and updates the checkout host-side (Issue #512).
 */
function bashLauncher(...extraLines: string[]): string {
  return [
    'if ! deno run mod.ts container-launch-plan --out "${PLAN}"; then exit 1; fi',
    'RUN_MODE="$(deno run mod.ts run-mode)"',
    'deno run mod.ts worker-checkout-update --base-dir "${BASE_DIR}" || true',
    "case ${key} in",
    ...LAUNCH_PLAN_KEYS.map((key) => `  ${key}) value_of_${key}=${key} ;;`),
    "esac",
    ...extraLines,
  ].join("\n");
}

Deno.test("launcherContractFaults - a sound container-only launcher has no faults", () => {
  const contract = extractLauncherContract("sound.sh", bashLauncher(), "bash");
  assertEquals(contract.consultsRunMode, true);
  assertEquals(contract.nativeExecutionMarkers, []);
  assertEquals(launcherContractFaults(contract), []);
});

Deno.test("launcherContractFaults - host execution is a fault even behind a run-mode branch (Issue #4)", () => {
  // What used to be the accepted, gated native branch (Issue #4147): with
  // containment mandatory there is no opt-in to gate behind, so it is a
  // fault like any other host-execution path.
  const contract = extractLauncherContract(
    "gated.sh",
    bashLauncher(
      'if [[ "${RUN_MODE}" == "native" ]]; then',
      '  exec deno run mod.ts run-entrypoint --base-dir "${BASE_DIR}"',
      "fi",
    ),
    "bash",
  );
  assertEquals(contract.nativeExecutionMarkers, ["run-entrypoint"]);
  const faults = launcherContractFaults(contract);
  assertEquals(faults.length, 1, faults.join("\n"));
  assertStringIncludes(faults[0]!, "can run the worker on the host");
  assertStringIncludes(faults[0]!, "Issue #4");
});

Deno.test("launcherContractFaults - a comment naming the host path is not execution", () => {
  const contract = extractLauncherContract(
    "commented.sh",
    bashLauncher("# the old run-entrypoint path lived here (Issue #4148)"),
    "bash",
  );
  assertEquals(contract.nativeExecutionMarkers, []);
  assertEquals(launcherContractFaults(contract), []);
});

Deno.test("launcherContractFaults - never consulting the run-mode resolver is a fault", () => {
  const contract = extractLauncherContract(
    "silent.sh",
    [
      'if ! deno run mod.ts container-launch-plan --out "${PLAN}"; then exit 1; fi',
      'deno run mod.ts worker-checkout-update --base-dir "${BASE_DIR}" || true',
      "case ${key} in",
      ...LAUNCH_PLAN_KEYS.map((key) => `  ${key}) value_of_${key}=${key} ;;`),
      "esac",
    ].join("\n"),
    "bash",
  );
  assertEquals(contract.consultsRunMode, false);
  const faults = launcherContractFaults(contract);
  assertEquals(faults.length, 1, faults.join("\n"));
  assertStringIncludes(faults[0]!, "run-mode resolver");
});

Deno.test("launcherContractFaults - leaving the checkout update to the container is a fault (Issue #512)", () => {
  // Everything else sound: the only thing missing is the host-side update,
  // which is what keeps /workspace mounted read-write.
  const contract = extractLauncherContract(
    "stale.sh",
    [
      'if ! deno run mod.ts container-launch-plan --out "${PLAN}"; then exit 1; fi',
      'RUN_MODE="$(deno run mod.ts run-mode)"',
      "case ${key} in",
      ...LAUNCH_PLAN_KEYS.map((key) => `  ${key}) value_of_${key}=${key} ;;`),
      "esac",
    ].join("\n"),
    "bash",
  );
  assertEquals(contract.updatesCheckout, false);
  const faults = launcherContractFaults(contract);
  assertEquals(faults.length, 1, faults.join("\n"));
  assertStringIncludes(faults[0]!, "worker-checkout-update");
  assertStringIncludes(faults[0]!, "Issues #512, #509");
});

Deno.test("launcherContractFaults - a comment naming the checkout update is not the step (Issue #512)", () => {
  const contract = extractLauncherContract(
    "commented-update.sh",
    [
      'if ! deno run mod.ts container-launch-plan --out "${PLAN}"; then exit 1; fi',
      'RUN_MODE="$(deno run mod.ts run-mode)"',
      "# worker-checkout-update used to run here",
      "case ${key} in",
      ...LAUNCH_PLAN_KEYS.map((key) => `  ${key}) value_of_${key}=${key} ;;`),
      "esac",
    ].join("\n"),
    "bash",
  );
  assertEquals(contract.updatesCheckout, false);
});

Deno.test("launcherContractFaults - PowerShell is judged the same way", () => {
  const hostPath = extractLauncherContract(
    "host.ps1",
    [
      "& deno run mod.ts container-launch-plan --out $PlanFile",
      "switch -CaseSensitive ($key) {",
      ...LAUNCH_PLAN_KEYS.map((key) => `    "${key}" { $Seen.Add("${key}") }`),
      "}",
      "$RunMode = (& deno run mod.ts run-mode).Trim()",
      'if ($RunMode -eq "native") {',
      "    & deno run mod.ts run-entrypoint --base-dir $BaseDir",
      "}",
    ].join("\n"),
    "powershell",
  );
  assertEquals(hostPath.nativeExecutionMarkers, ["run-entrypoint"]);
  assert(
    launcherContractFaults(hostPath).some((fault) =>
      fault.includes("can run the worker on the host")
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

Deno.test("compareLauncherContracts - a run.ps1 that gains a host-execution path is a divergence (Issue #4)", () => {
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
    `a host-executing run.ps1 must be a divergence: ${JSON.stringify(report)}`,
  );
});

// ---------------------------------------------------------------------------
// The real launchers
// ---------------------------------------------------------------------------

Deno.test("run.sh and run.ps1 - keep the same launch contract", () => {
  const { divergences } = compareLauncherContracts(RUN_SH, RUN_PS1);
  assertEquals(divergences, [], divergences.join("\n"));
});

Deno.test("run.sh and run.ps1 - both are container-only and both consult the run-mode resolver (Issue #4)", () => {
  for (const contract of [RUN_SH, RUN_PS1]) {
    assertEquals(
      contract.nativeExecutionMarkers,
      [],
      `${contract.name} must not carry a host-execution path`,
    );
    assertEquals(
      contract.consultsRunMode,
      true,
      `${contract.name} must resolve the run mode so a removed mode fails loud`,
    );
  }
});

Deno.test("run.sh and run.ps1 - both update the worker checkout host-side (Issue #512)", () => {
  for (const contract of [RUN_SH, RUN_PS1]) {
    assertEquals(
      contract.updatesCheckout,
      true,
      `${contract.name} must update the checkout before the launch, so the ` +
        `container never has to`,
    );
  }
});

Deno.test("compareLauncherContracts - a run.ps1 that drops the checkout update is a divergence (Issue #512)", () => {
  const drifted = extractLauncherContract(
    "run.ps1",
    RUN_PS1_SOURCE.replaceAll("worker-checkout-update", "run-mode"),
    "powershell",
  );

  const { divergences } = compareLauncherContracts(RUN_SH, drifted);
  assert(
    divergences.some((message) =>
      message.includes("host-side checkout update")
    ),
    `dropping the checkout update must be a divergence: ${
      JSON.stringify(divergences)
    }`,
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
    "run.sh and run.ps1 - a removed run mode fails loud in both, and neither launches anything (Issue #4)",
  ignore: POWERSHELL_LAUNCHER === null,
  fn: async () => {
    for (const launcher of [BASH_LAUNCHER, POWERSHELL_LAUNCHER!]) {
      for (const removed of ["native", "seatbelt"]) {
        const harness = await setupHarness({
          STUB_IMAGE_INSPECT_EXIT: "0",
          VIBE_RUN_MODE: removed,
        });
        try {
          const outcome = await runLauncher(harness, launcher);
          assert(
            outcome.code !== 0,
            `${removed} must fail, not fall through: ${outcome.stderr}`,
          );
          assertStringIncludes(outcome.stderr, "removed");
          assertStringIncludes(outcome.stderr, "Issue #4");
          assertEquals(
            await recorded(harness, "run"),
            null,
            "a refused mode must never launch a container instead",
          );
          assertEquals(await recorded(harness, "build"), null);
        } finally {
          await harness.cleanup();
        }
      }
    }
  },
});

Deno.test({
  name:
    "run.sh and run.ps1 - both update the checkout before building the launch plan (Issue #512)",
  ignore: POWERSHELL_LAUNCHER === null,
  fn: async () => {
    for (const launcher of [BASH_LAUNCHER, POWERSHELL_LAUNCHER!]) {
      const harness = await setupHarness({ STUB_IMAGE_INSPECT_EXIT: "0" });
      try {
        const outcome = await runLauncher(harness, launcher);
        assertEquals(outcome.code, 0, outcome.stderr);

        const args = await recorded(harness, "worker-checkout-update");
        assert(args, `${launcher.name} never updated the worker checkout`);
        assertEquals(args[args.indexOf("--base-dir") + 1], REPO_ROOT);

        const order = await denoInvocationOrder(harness);
        const update = order.indexOf("worker-checkout-update");
        const plan = order.indexOf("container-launch-plan");
        assert(update > -1 && plan > -1, `${launcher.name}: ${order}`);
        assert(
          update < plan,
          `${launcher.name} must update the checkout before it builds the ` +
            `launch plan, got ${order.join(" -> ")}`,
        );
      } finally {
        await harness.cleanup();
      }
    }
  },
});

Deno.test({
  name:
    "run.sh and run.ps1 - a failed checkout update warns in both and launches anyway (Issue #512)",
  ignore: POWERSHELL_LAUNCHER === null,
  fn: async () => {
    for (const launcher of [BASH_LAUNCHER, POWERSHELL_LAUNCHER!]) {
      const harness = await setupHarness({
        STUB_IMAGE_INSPECT_EXIT: "0",
        STUB_CHECKOUT_UPDATE_EXIT: "1",
      });
      try {
        const outcome = await runLauncher(harness, launcher);
        assertEquals(
          outcome.code,
          0,
          `${launcher.name} must still launch: ${outcome.stderr}`,
        );
        assertStringIncludes(outcome.stderr, "could not update the worker");
        assert(
          await recorded(harness, "run"),
          `${launcher.name} launched no container after a failed update`,
        );
      } finally {
        await harness.cleanup();
      }
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
     * temporary host directory, each launch its own container name, and each
     * `container-launch-plan` its own live `df` reading. Available bytes
     * drift by tens of kilobytes between sequential launches once `df`
     * stdout is actually captured (Issue #345); the parity this test
     * cares about is that both launchers pass the env vars, not that the
     * host's free space stayed still for a few seconds.
     */
    const normalise = (invocation: { args: string[]; tmpDir: string }) =>
      invocation.args.map((arg) =>
        arg
          .replaceAll(invocation.tmpDir, "<host>")
          .replace(/^vibe-coder-\d+$/, "<container-name>")
          .replace(
            /^VIBE_HOST_DISK_AVAIL_BYTES=\d+$/,
            "VIBE_HOST_DISK_AVAIL_BYTES=<bytes>",
          )
          .replace(
            /^VIBE_HOST_DISK_TOTAL_BYTES=\d+$/,
            "VIBE_HOST_DISK_TOTAL_BYTES=<bytes>",
          )
      );

    const hostDiskEnvPresent = (name: string, args: string[]) => {
      assert(
        args.some((arg) => arg.startsWith("VIBE_HOST_DISK_AVAIL_BYTES=")),
        `${name} must pass the host-disk reading into the container (Issue #226)`,
      );
      assert(
        args.some((arg) => arg.startsWith("VIBE_HOST_DISK_TOTAL_BYTES=")),
        `${name} must pass the host-disk total into the container (Issue #226)`,
      );
    };
    hostDiskEnvPresent("run.sh", bash.args);
    hostDiskEnvPresent("run.ps1", powershell.args);

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
