/**
 * The launch contract `run.sh` and `run.ps1` must both keep (Issue #4066).
 *
 * The two launchers are the containment boundary on their respective hosts.
 * They stay in agreement by construction — each asks the Deno
 * `container-launch-plan` command what to run and executes exactly that — but
 * "by construction" is only true while both actually delegate. This module
 * reads a launcher's source and reports what it does, so the parity test can
 * fail the moment one of them starts deciding for itself: hardcoding a mount,
 * adding a privilege-broadening flag, dropping a plan key it must honour, or
 * running the worker on the host at all.
 *
 * A Windows host must not be quietly less contained than a macOS one.
 *
 * **Host execution (Issues #4147, #4).** For a while the contract gated a
 * native path behind the run-mode opt-in (#4146). Containment is mandatory
 * now (Issue #4): the `native` and `seatbelt` modes are gone, so a
 * host-execution marker in a launcher is a fault outright — there is no
 * opt-in to gate it behind — and both launchers consult the run-mode resolver
 * only so a configuration naming a removed mode fails loud in one place.
 * Nothing about containment is relaxed: every broadening, mount and plan-key
 * rule is exactly as strict as before.
 *
 * **Checkout update (Issue #512).** Both launchers update the worker checkout
 * on the host, before the launch plan is built. A launcher that leaves that to
 * the container keeps `/workspace` read-write, so a missing update step is a
 * fault here too.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import type { ContainerLaunchPlanKey } from "./container_launch.ts";
import { executableLines, type LauncherDialect } from "./launcher_source.ts";

export type { LauncherDialect };

/** Every plan key a launcher is expected to consume. */
export const LAUNCH_PLAN_KEYS: readonly ContainerLaunchPlanKey[] = [
  "runtime",
  "image",
  // The launch's image dependency chain (Issue #1059): a launcher that drops
  // it prunes the base image its own extension layer is built FROM.
  "keep",
  "name",
  // The outer watchdog's deadline (Issue #4173): a launcher that ignores it
  // would wait on a wedged container for ever, which is a parity fault.
  "watchdog",
  "ensure",
  "exists",
  "build",
  // The operator's private layer (Issue #980): a launcher that ignored it
  // would run the standard image under the extension's tag on a deployment
  // that configures one — the same parity fault as dropping any other key.
  "extension-build",
  "run",
];

/**
 * Source markers that would broaden the container past its contract.
 *
 * Matched anywhere in the source, comments included: a launcher small enough
 * to audit has no reason to mention any of them. Short flags (`-p`, `-P`) are
 * deliberately absent — they collide with ordinary shell usage such as
 * `mkdir -p`, and the behavioural launcher tests assert on the real argument
 * list, where an exact match is meaningful.
 */
export const LAUNCHER_BROADENING_MARKERS: readonly string[] = [
  "--privileged",
  "--cap-add",
  "--device",
  "--publish",
  "--publish-all",
  "--pid=host",
  "--ipc=host",
  "--uts=host",
  "--userns=host",
  "--network=host",
  "--net=host",
  "--network host",
  "--net host",
  "docker.sock",
  "podman.sock",
  "containerd.sock",
  "crio.sock",
  "docker_engine",
];

/**
 * Source markers of a host (non-container) worker execution path. Containment
 * is mandatory (Issue #4): any of these in a launcher's executable lines is a
 * fault.
 */
export const LAUNCHER_NATIVE_EXECUTION_MARKERS: readonly string[] = [
  "run-entrypoint",
  "run_entrypoint.ts",
];

/**
 * Source markers of the run-mode resolver (Issue #4146).
 *
 * A launcher consults the resolver through the `run-mode` Deno sub-command, so
 * no shell parses `.config.json`; `VIBE_RUN_MODE` is the per-run override the
 * same resolver reads. With container the only mode (Issue #4) the
 * consultation exists so a removed or misspelled mode fails loud in one place.
 */
export const LAUNCHER_RUN_MODE_MARKERS: readonly string[] = [
  "run-mode",
  "VIBE_RUN_MODE",
];

/**
 * Source markers of the host-side checkout update (Issue #512).
 *
 * The worker checkout is updated by the **host**, before the launch plan is
 * built, through the `worker-checkout-update` Deno sub-command. A launcher
 * that skips it would leave the update to the container — which is the only
 * reason `/workspace` has to be mounted read-write, and so a container→host
 * escape path (Issue #509).
 */
export const LAUNCHER_CHECKOUT_UPDATE_MARKERS: readonly string[] = [
  "worker-checkout-update",
];

/** Mount flags a launcher must never pass for itself. */
export const LAUNCHER_MOUNT_FLAGS: readonly string[] = ["--volume", "--mount"];

/** What one launcher's source says it does. */
export interface LauncherContract {
  /** Launcher file name, used in divergence messages. */
  name: string;
  /** Language the launcher is written in. */
  dialect: LauncherDialect;
  /** True when the launcher asks the Deno plan command what to run. */
  delegatesToLaunchPlan: boolean;
  /** True when the launcher asks the run-mode resolver which mode to run in. */
  consultsRunMode: boolean;
  /** True when the launcher updates the worker checkout itself (Issue #512). */
  updatesCheckout: boolean;
  /** Plan keys the launcher handles, in the canonical order. */
  planKeys: string[];
  /** Broadening markers found — empty is the only acceptable result. */
  broadeningMarkers: string[];
  /**
   * Host-execution markers found in the launcher's executable lines. Empty
   * is the only acceptable result (Issue #4).
   */
  nativeExecutionMarkers: string[];
  /** Mount flags the launcher passes itself rather than reading from the plan. */
  hardcodedMountFlags: string[];
}

/**
 * Does this source line open the case branch that handles `key`?
 *
 * Matched by literal string comparison rather than a built regex: the key is
 * interpolated, and a dynamically built RegExp is a ReDoS surface the parity
 * check has no need for.
 */
function opensPlanKeyBranch(
  line: string,
  key: string,
  dialect: LauncherDialect,
): boolean {
  const trimmed = line.trimStart();
  // bash: `  runtime) RUNTIME="${value}" ;;`
  if (dialect === "bash") return trimmed.startsWith(`${key})`);
  // powershell: `  "runtime" { $Runtime = $value }`
  for (const quote of ['"', "'"]) {
    const quoted = `${quote}${key}${quote}`;
    if (trimmed.startsWith(quoted)) {
      return trimmed.slice(quoted.length).trimStart().startsWith("{");
    }
  }
  return false;
}

/** Does the launcher source handle `key`? */
function handlesPlanKey(
  source: string,
  key: string,
  dialect: LauncherDialect,
): boolean {
  return source.split("\n").some((line) =>
    opensPlanKeyBranch(line, key, dialect)
  );
}

/**
 * Read a launcher's source and report the contract it keeps.
 *
 * @param name - Launcher file name (`run.sh`, `run.ps1`)
 * @param source - The launcher's full source text
 * @param dialect - Language the launcher is written in
 * @returns What the source says the launcher does
 */
export function extractLauncherContract(
  name: string,
  source: string,
  dialect: LauncherDialect,
): LauncherContract {
  // Execution is judged on the code alone: a comment naming `run-entrypoint`
  // cannot start the worker, and must not be read as if it could.
  const code = executableLines(source, dialect);
  const consultsRunMode = LAUNCHER_RUN_MODE_MARKERS.some((marker) =>
    code.some((line) => line.includes(marker))
  );
  const updatesCheckout = LAUNCHER_CHECKOUT_UPDATE_MARKERS.some((marker) =>
    code.some((line) => line.includes(marker))
  );

  return {
    name,
    dialect,
    delegatesToLaunchPlan: source.includes("container-launch-plan"),
    consultsRunMode,
    updatesCheckout,
    planKeys: LAUNCH_PLAN_KEYS.filter((key) =>
      handlesPlanKey(source, key, dialect)
    ),
    broadeningMarkers: LAUNCHER_BROADENING_MARKERS.filter((marker) =>
      source.includes(marker)
    ),
    nativeExecutionMarkers: LAUNCHER_NATIVE_EXECUTION_MARKERS.filter((marker) =>
      code.some((line) => line.includes(marker))
    ),
    hardcodedMountFlags: LAUNCHER_MOUNT_FLAGS.filter((flag) =>
      source.includes(flag)
    ),
  };
}

/** Describe a list for a divergence message. */
function describe(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

/** Contract fields the two launchers are compared on. */
export type LauncherComparedField =
  | "delegatesToLaunchPlan"
  | "consultsRunMode"
  | "updatesCheckout"
  | "planKeys"
  | "broadeningMarkers"
  | "nativeExecutionMarkers"
  | "hardcodedMountFlags";

/** What each compared field is called in a divergence message. */
const COMPARED_FIELDS: Record<LauncherComparedField, string> = {
  delegatesToLaunchPlan: "launch-plan delegation",
  consultsRunMode: "run-mode consultation",
  updatesCheckout: "host-side checkout update",
  planKeys: "handled launch-plan keys",
  broadeningMarkers: "privilege/exposure markers",
  nativeExecutionMarkers: "native execution markers",
  hardcodedMountFlags: "hardcoded mount flags",
};

/** How two launchers compare. */
export interface LauncherParityReport {
  /** Divergences — empty is the only acceptable result. */
  divergences: string[];
}

/** Render one contract value for a divergence message. */
function render(value: boolean | string[]): string {
  return typeof value === "boolean" ? String(value) : describe(value);
}

/**
 * Report every way two launchers have drifted apart.
 *
 * @param left - One launcher's contract
 * @param right - The other launcher's contract
 * @returns Every divergence — there are no intended asymmetries left (Issue
 *   #4: both launchers are container-only and consult the run-mode resolver)
 */
export function compareLauncherContracts(
  left: LauncherContract,
  right: LauncherContract,
): LauncherParityReport {
  const report: LauncherParityReport = { divergences: [] };

  for (const [field, label] of Object.entries(COMPARED_FIELDS)) {
    const key = field as LauncherComparedField;
    const leftValue = left[key];
    const rightValue = right[key];
    if (
      (Array.isArray(leftValue) ? leftValue.join("\0") : leftValue) ===
        (Array.isArray(rightValue) ? rightValue.join("\0") : rightValue)
    ) {
      continue;
    }

    report.divergences.push(
      `${label} diverge: ${left.name} has ` +
        `${render(leftValue)}, ${right.name} has ${render(rightValue)}`,
    );
  }

  return report;
}

/**
 * Faults in a single launcher, whatever the other one does.
 *
 * Parity alone is not enough: two launchers that both mount a runtime socket
 * agree with each other and are both wrong.
 *
 * Host execution is a fault outright (Issue #4): containment is mandatory
 * and there is no opt-in to gate it behind.
 *
 * @param contract - The contract read from a launcher's source
 * @returns One message per fault; empty when the launcher is sound
 */
export function launcherContractFaults(contract: LauncherContract): string[] {
  const faults: string[] = [];

  if (!contract.delegatesToLaunchPlan) {
    faults.push(
      `${contract.name} does not ask container-launch-plan what to run, so ` +
        `its containment decisions are no longer auditable in one place`,
    );
  }
  const missing = LAUNCH_PLAN_KEYS.filter((key) =>
    !contract.planKeys.includes(key)
  );
  if (missing.length > 0) {
    faults.push(
      `${contract.name} ignores launch-plan keys: ${describe(missing)}`,
    );
  }
  if (contract.broadeningMarkers.length > 0) {
    faults.push(
      `${contract.name} broadens the container: ` +
        describe(contract.broadeningMarkers),
    );
  }
  if (contract.nativeExecutionMarkers.length > 0) {
    faults.push(
      `${contract.name} can run the worker on the host: ` +
        `${describe(contract.nativeExecutionMarkers)}. Containment is ` +
        `mandatory (Issue #4) — the launcher runs the container and nothing ` +
        `else`,
    );
  }
  if (!contract.consultsRunMode) {
    faults.push(
      `${contract.name} never consults the run-mode resolver (the ` +
        `${LAUNCHER_RUN_MODE_MARKERS[0]} command), so a configuration naming ` +
        `a removed mode would not fail loud (Issues #4146, #4)`,
    );
  }
  if (!contract.updatesCheckout) {
    faults.push(
      `${contract.name} never updates the worker checkout (the ` +
        `${LAUNCHER_CHECKOUT_UPDATE_MARKERS[0]} command), so the update is ` +
        `left to the container and the checkout cannot be mounted read-only ` +
        `(Issues #512, #509)`,
    );
  }
  if (contract.hardcodedMountFlags.length > 0) {
    faults.push(
      `${contract.name} passes its own mounts: ` +
        describe(contract.hardcodedMountFlags),
    );
  }

  return faults;
}
