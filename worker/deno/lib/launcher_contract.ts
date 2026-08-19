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
 * running the worker on the host without an explicit opt-in.
 *
 * A Windows host must not be quietly less contained than a macOS one.
 *
 * **Native execution (Issue #4147).** The contract used to ban a native path
 * outright. Milestone #4060 (parent #4145) settled a different invariant:
 * container is the default, and native is reachable only through the explicit
 * run-mode opt-in (#4146). So native-execution markers are data, and the fault
 * is *ungated* native execution — a launcher that can run the worker on the
 * host without consulting the run-mode resolver, or outside an explicit native
 * branch. Nothing about containment is relaxed: every broadening, mount and
 * plan-key rule is exactly as strict as before.
 *
 * **The one intended asymmetry.** Windows stays container-only, so `run.ps1`
 * legitimately differs from `run.sh` on the run-mode fields. That is recorded
 * as a named exception ({@link LAUNCHER_PARITY_EXCEPTIONS}) and reported, not
 * silently tolerated — and it lapses the moment `run.ps1` gains a native path
 * of its own.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import type { ContainerLaunchPlanKey } from "./container_launch.ts";
import {
  executableLines,
  type LauncherDialect,
  nativeBranchGatedLines,
} from "./launcher_source.ts";

export type { LauncherDialect };

/** Every plan key a launcher is expected to consume. */
export const LAUNCH_PLAN_KEYS: readonly ContainerLaunchPlanKey[] = [
  "runtime",
  "image",
  "name",
  // The outer watchdog's deadline (Issue #4173): a launcher that ignores it
  // would wait on a wedged container for ever, which is a parity fault.
  "watchdog",
  "ensure",
  "exists",
  "build",
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

/** Source markers of a native, non-container worker execution path. */
export const LAUNCHER_NATIVE_EXECUTION_MARKERS: readonly string[] = [
  "run-entrypoint",
  "run_entrypoint.ts",
];

/**
 * Source markers of the run-mode resolver (Issue #4146).
 *
 * A launcher consults the resolver through the `run-mode` Deno sub-command, so
 * no shell parses `.config.json`; `VIBE_RUN_MODE` is the per-run override the
 * same resolver reads.
 */
export const LAUNCHER_RUN_MODE_MARKERS: readonly string[] = [
  "run-mode",
  "VIBE_RUN_MODE",
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
  /** Plan keys the launcher handles, in the canonical order. */
  planKeys: string[];
  /** Broadening markers found — empty is the only acceptable result. */
  broadeningMarkers: string[];
  /**
   * Native-execution markers found. Data, not a verdict (Issue #4147): a
   * launcher may run the worker natively when the run mode says so.
   */
  nativeExecutionMarkers: string[];
  /**
   * Native-execution markers reachable without the explicit opt-in — either
   * the launcher never consults the run-mode resolver, or the marker sits
   * outside a native branch. Empty is the only acceptable result.
   */
  ungatedNativeExecution: string[];
  /**
   * True when the launch-plan delegation itself sits inside a native branch,
   * which would make the container path the opt-in rather than the default.
   */
  containerPathGatedOnNative: boolean;
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
  const gated = nativeBranchGatedLines(source, dialect);
  const consultsRunMode = LAUNCHER_RUN_MODE_MARKERS.some((marker) =>
    code.some((line) => line.includes(marker))
  );

  /** Lines where `marker` can execute, and whether each one is gated. */
  const occurrences = (marker: string): boolean[] =>
    code.flatMap((line, index) => line.includes(marker) ? [gated[index]!] : []);

  return {
    name,
    dialect,
    delegatesToLaunchPlan: source.includes("container-launch-plan"),
    consultsRunMode,
    planKeys: LAUNCH_PLAN_KEYS.filter((key) =>
      handlesPlanKey(source, key, dialect)
    ),
    broadeningMarkers: LAUNCHER_BROADENING_MARKERS.filter((marker) =>
      source.includes(marker)
    ),
    nativeExecutionMarkers: LAUNCHER_NATIVE_EXECUTION_MARKERS.filter((marker) =>
      source.includes(marker)
    ),
    // Without the resolver there is no opt-in to gate on, so every executable
    // occurrence is reachable by default.
    ungatedNativeExecution: LAUNCHER_NATIVE_EXECUTION_MARKERS.filter((marker) =>
      occurrences(marker).some((isGated) => !consultsRunMode || !isGated)
    ),
    containerPathGatedOnNative: occurrencesGatedThroughout(
      code,
      gated,
      "container-launch-plan",
    ),
    hardcodedMountFlags: LAUNCHER_MOUNT_FLAGS.filter((flag) =>
      source.includes(flag)
    ),
  };
}

/** Does `marker` execute only inside native branches, and at least once? */
function occurrencesGatedThroughout(
  code: string[],
  gated: boolean[],
  marker: string,
): boolean {
  const found = code.flatMap((line, index) =>
    line.includes(marker) ? [gated[index]!] : []
  );
  return found.length > 0 && found.every((isGated) => isGated);
}

/** Describe a list for a divergence message. */
function describe(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

/** Contract fields the two launchers are compared on. */
export type LauncherComparedField =
  | "delegatesToLaunchPlan"
  | "consultsRunMode"
  | "planKeys"
  | "broadeningMarkers"
  | "nativeExecutionMarkers"
  | "hardcodedMountFlags";

/** What each compared field is called in a divergence message. */
const COMPARED_FIELDS: Record<LauncherComparedField, string> = {
  delegatesToLaunchPlan: "launch-plan delegation",
  consultsRunMode: "run-mode consultation",
  planKeys: "handled launch-plan keys",
  broadeningMarkers: "privilege/exposure markers",
  nativeExecutionMarkers: "native execution markers",
  hardcodedMountFlags: "hardcoded mount flags",
};

/**
 * A divergence the two launchers are allowed to keep, and why.
 *
 * An exception is granted to one named launcher, covers named fields, and
 * carries the reason in operator-facing words — so an intended asymmetry is
 * recorded and reviewable rather than silently tolerated (Issue #4147).
 */
export interface LauncherParityException {
  /** Short name the report quotes. */
  name: string;
  /** Launcher the exception is granted to. */
  launcher: string;
  /** Fields the exception covers. */
  fields: readonly LauncherComparedField[];
  /** Why the asymmetry is intended. */
  reason: string;
}

/**
 * Windows stays container-only (Issue #4145).
 *
 * `run.ps1` never gains a native execution path; it consults the run mode only
 * to refuse an explicit native opt-in loudly, so it may differ from `run.sh` on
 * the run-mode fields. The exception lapses the moment `run.ps1` carries a
 * native execution path of its own — at which point the divergence is real.
 */
export const WINDOWS_CONTAINER_ONLY: LauncherParityException = {
  name: "windows-container-only",
  launcher: "run.ps1",
  fields: ["consultsRunMode", "nativeExecutionMarkers"],
  reason:
    "Windows stays container-only (Issue #4145): run.ps1 carries no native " +
    "execution path and consults the run mode only to refuse an explicit " +
    "native opt-in with a non-zero exit",
};

/** Every intended asymmetry between the two launchers. */
export const LAUNCHER_PARITY_EXCEPTIONS: readonly LauncherParityException[] = [
  WINDOWS_CONTAINER_ONLY,
];

/** How two launchers compare. */
export interface LauncherParityReport {
  /** Unintended divergences — empty is the only acceptable result. */
  divergences: string[];
  /** Divergences covered by a named exception, each quoting it. */
  excepted: string[];
}

/** Is this divergence covered by a named, still-valid exception? */
function exceptionFor(
  field: LauncherComparedField,
  contracts: LauncherContract[],
): LauncherParityException | undefined {
  return LAUNCHER_PARITY_EXCEPTIONS.find((exception) => {
    if (!exception.fields.includes(field)) return false;
    const granted = contracts.find((one) => one.name === exception.launcher);
    // Granted only while the named launcher is the more contained side.
    return granted !== undefined &&
      granted.nativeExecutionMarkers.length === 0;
  });
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
 * @returns Unintended divergences, and those covered by a named exception
 */
export function compareLauncherContracts(
  left: LauncherContract,
  right: LauncherContract,
): LauncherParityReport {
  const report: LauncherParityReport = { divergences: [], excepted: [] };

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

    const message = `${label} diverge: ${left.name} has ` +
      `${render(leftValue)}, ${right.name} has ${render(rightValue)}`;
    const exception = exceptionFor(key, [left, right]);
    if (exception) {
      report.excepted.push(
        `[${exception.name}] intended: ${message} — ${exception.reason}`,
      );
    } else {
      report.divergences.push(message);
    }
  }

  report.divergences.push(...lapsedExceptions([left, right]));
  return report;
}

/**
 * Exceptions whose premise no longer holds (Issue #4150).
 *
 * An exception is a promise about one launcher — `windows-container-only` says
 * `run.ps1` carries no native execution path — not a fact about the pair. Once
 * `run.sh` legitimately carries one (Issue #4148), the two launchers agree on
 * the marker set and the field comparison above sees nothing to except, so a
 * native `run.ps1` would slip through in silence. Report the lapse against the
 * exception itself instead.
 *
 * @param contracts - Both launchers' contracts
 * @returns One message per lapsed exception
 */
function lapsedExceptions(contracts: LauncherContract[]): string[] {
  const lapsed: string[] = [];

  for (const exception of LAUNCHER_PARITY_EXCEPTIONS) {
    if (!exception.fields.includes("nativeExecutionMarkers")) continue;
    const granted = contracts.find((one) => one.name === exception.launcher);
    if (!granted || granted.nativeExecutionMarkers.length === 0) continue;
    lapsed.push(
      `${COMPARED_FIELDS.nativeExecutionMarkers} diverge: ${granted.name} now ` +
        `carries ${describe(granted.nativeExecutionMarkers)}, so the ` +
        `[${exception.name}] exception has lapsed — ${exception.reason}`,
    );
  }

  return lapsed;
}

/**
 * Faults in a single launcher, whatever the other one does.
 *
 * Parity alone is not enough: two launchers that both mount a runtime socket
 * agree with each other and are both wrong.
 *
 * Native execution is a fault only when it is *ungated* (Issue #4147) — every
 * other rule here is exactly as strict as it was.
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
  if (contract.ungatedNativeExecution.length > 0) {
    faults.push(
      `${contract.name} can run the worker on the host without the explicit ` +
        `run-mode opt-in: ${describe(contract.ungatedNativeExecution)}. ` +
        `Gate native execution behind a branch on the run mode (the ` +
        `${LAUNCHER_RUN_MODE_MARKERS[0]} command), so container stays the ` +
        `default (Issues #4146, #4147)`,
    );
  }
  if (contract.containerPathGatedOnNative) {
    faults.push(
      `${contract.name} reaches container-launch-plan only inside a native ` +
        `branch, which makes the container path the opt-in rather than the ` +
        `default (Issue #4147)`,
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
