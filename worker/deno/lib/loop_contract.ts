/**
 * The supervision contract `loop.sh` and `loop.ps1` must both keep (Issue
 * #1403).
 *
 * `setup` and `run` each already have a parity test that reads both scripts'
 * contracts and fails on a divergence — `setup_contract.ts` and
 * `launcher_contract.ts`. `loop` had neither, and the two supervisors drifted
 * to 501 and 148 lines: `loop.ps1` never pulled its checkout (Issue #1401) so
 * a Windows host ran frozen code for ever, and never resolved the log
 * directory (Issue #1402) so it left no record an operator could find. Both
 * were found by reading the files side by side, months after they appeared.
 *
 * This module is the missing gate. It reads a supervisor's source and reports
 * what it does — whether it can exit, whether it delegates the backoff, where
 * it logs, whether it refreshes the checkout, which launcher exit statuses it
 * tells apart — so the parity test fails the moment one supervisor gains or
 * loses a behaviour the other has.
 *
 * **Intended asymmetries are named, never silent.** Three divergences are
 * deliberate and are recorded as exceptions ({@link LOOP_PARITY_EXCEPTIONS}),
 * each granted only while its own condition holds. An exception that cannot
 * lapse is a licence rather than an exception: the host-side run bound lapses
 * the moment a supervisor kills its launcher without reaping what the kill
 * leaves behind, the control-plane probe lapses the moment a supervisor
 * probes without being able to recover, and both lapse if the bash supervisor
 * ever drops the capability the PowerShell one is being excused for.
 *
 * Only executable lines are read: a capability described in a comment cannot
 * run, and must not be read as if it could.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { executableLines, type LauncherDialect } from "./launcher_source.ts";

export type { LauncherDialect };

/**
 * A launcher exit status both supervisors must tell apart from a crash.
 *
 * A supervisor that treats one of these as an ordinary failure grows a
 * backoff against a host that is behaving exactly as designed.
 */
export interface SupervisorExitStatus {
  /** Short name the divergence and fault messages quote. */
  name: string;
  /** The numeric status the launcher exits with. */
  status: number;
  /** Why the status is not a failure. */
  reason: string;
}

/** Launcher exit statuses both supervisors must distinguish. */
export const SHARED_EXIT_STATUSES: readonly SupervisorExitStatus[] = [
  {
    name: "another-worker-running",
    status: 4,
    reason:
      "one worker per host is the design invariant holding, not a crash " +
      "(Issues #26, #1056)",
  },
  {
    name: "quota-pause",
    status: 75,
    reason:
      "a host out of Claude quota is a scheduled pause re-probed on a fixed " +
      "cadence, not a failure to back off from (Issue #342)",
  },
];

/**
 * Source fragments that evidence one capability, per dialect.
 *
 * Each entry is a list of alternatives; an alternative holds when every one
 * of its fragments appears somewhere in the script's executable lines. Two
 * fragments are used where one alone would be ambiguous (`launch-*.log` plus
 * the removal that prunes it), and alternatives where the two dialects spell
 * the same behaviour differently.
 */
interface CapabilityMarkers {
  bash: readonly (readonly string[])[];
  powershell: readonly (readonly string[])[];
  /**
   * Match outside quoted strings only.
   *
   * Set where every spelling of the capability is an unquoted command, so a
   * supervisor that keeps the message naming a step it no longer performs is
   * not credited with performing it — both scripts log `git pull exited with
   * status ...` beside the pull itself. It is deliberately not set where a
   * dialect spells the marker as a quoted argument (`$WorkerMod "log-dir"`,
   * `-Filter "launch-*.log"`), which stripping would hide.
   */
  commandsOnly?: true;
}

/** Capabilities read from a supervisor's source. */
export type SupervisorCapability =
  | "neverExits"
  | "invokesLauncher"
  | "delegatesBackoff"
  | "resolvesLogDir"
  | "writesLaunchLog"
  | "prunesLaunchLogs"
  | "quotesLaunchLogInEscalation"
  | "namesHostInEscalation"
  | "refreshesCheckout"
  | "recordsOutcomeItself"
  | "freezesLockfile"
  | "honoursSleepOverride"
  | "reportsOnStderr"
  | "boundsRunDuration"
  | "reapsOrphans"
  | "probesControlPlane"
  | "recoversWedgedContainer"
  | "survivesProcessGroupSignals";

/** How each dialect spells each capability. */
const CAPABILITY_MARKERS: Record<SupervisorCapability, CapabilityMarkers> = {
  neverExits: { bash: [["while true"]], powershell: [["while ($true)"]] },
  invokesLauncher: { bash: [["run.sh"]], powershell: [["run.ps1"]] },
  delegatesBackoff: {
    bash: [["container-restart-backoff"]],
    powershell: [["container-restart-backoff"]],
  },
  resolvesLogDir: { bash: [["log-dir"]], powershell: [["log-dir"]] },
  writesLaunchLog: { bash: [["launch-"]], powershell: [["launch-"]] },
  prunesLaunchLogs: {
    bash: [["launch-*.log", "rm -f"]],
    powershell: [["launch-*.log", "Remove-Item"]],
  },
  quotesLaunchLogInEscalation: {
    bash: [["--launch-log"]],
    powershell: [["--launch-log"]],
  },
  namesHostInEscalation: {
    bash: [["--allow-sys=hostname"]],
    powershell: [["--allow-sys=hostname"]],
  },
  refreshesCheckout: {
    bash: [["git pull"]],
    powershell: [["git pull"]],
    commandsOnly: true,
  },
  recordsOutcomeItself: {
    bash: [["VIBE_SUPERVISOR_RECORDS_OUTCOME"]],
    powershell: [["VIBE_SUPERVISOR_RECORDS_OUTCOME"]],
  },
  freezesLockfile: {
    bash: [["--frozen", "--lock="]],
    powershell: [["--frozen", "--lock="]],
  },
  honoursSleepOverride: {
    bash: [["LOOP_SLEEP_SECONDS"]],
    powershell: [["LOOP_SLEEP_SECONDS"]],
  },
  reportsOnStderr: {
    bash: [[">&2"]],
    powershell: [["[Console]::Error"]],
  },
  boundsRunDuration: {
    bash: [["VIBE_RUN_MAX_SECONDS"]],
    powershell: [["VIBE_RUN_MAX_SECONDS"]],
  },
  reapsOrphans: {
    bash: [["pgrep", "kill -TERM"]],
    powershell: [["Stop-Process"]],
    commandsOnly: true,
  },
  probesControlPlane: {
    bash: [["container exec"]],
    powershell: [["container exec"]],
    commandsOnly: true,
  },
  recoversWedgedContainer: {
    bash: [["container kill"]],
    powershell: [["container kill"]],
    commandsOnly: true,
  },
  survivesProcessGroupSignals: {
    bash: [["trap ", "SIGTERM"]],
    powershell: [["Register-EngineEvent"], ["CancelKeyPress"]],
  },
};

/** What one supervisor's source says it does. */
export interface SupervisorContract {
  /** Script file name, used in divergence messages. */
  name: string;
  /** Language the supervisor is written in. */
  dialect: LauncherDialect;
  /** True when the supervision loop has no exit condition of its own. */
  neverExits: boolean;
  /** True when the supervisor invokes this platform's launcher. */
  invokesLauncher: boolean;
  /** True when the wait between cycles comes from the worker's recorder. */
  delegatesBackoff: boolean;
  /** True when the log directory is asked of the worker (Issue #1402). */
  resolvesLogDir: boolean;
  /** True when each cycle writes its own launch log (Issue #633). */
  writesLaunchLog: boolean;
  /** True when the launch-log directory is kept bounded (Issue #633). */
  prunesLaunchLogs: boolean;
  /** True when the escalation is handed this cycle's log (Issues #709, #1029). */
  quotesLaunchLogInEscalation: boolean;
  /** True when the escalation can name the host it is about (Issue #633). */
  namesHostInEscalation: boolean;
  /** True when every cycle refreshes the checkout (Issue #1401). */
  refreshesCheckout: boolean;
  /** True when the supervisor tells the launcher it records the outcome itself. */
  recordsOutcomeItself: boolean;
  /** True when every worker invocation is frozen against a lockfile. */
  freezesLockfile: boolean;
  /** True when the base sleep can be overridden for a test or a host. */
  honoursSleepOverride: boolean;
  /** True when the supervisor's loud fallbacks reach stderr rather than nothing. */
  reportsOnStderr: boolean;
  /** Shared exit statuses the supervisor tells apart, in canonical order. */
  distinguishedExitStatuses: string[];
  /** True when each run is bounded by a host-side wall clock (Issue #322). */
  boundsRunDuration: boolean;
  /** True when a killed launcher's containers are reaped (Issue #322). */
  reapsOrphans: boolean;
  /** True when the container's control plane is probed rather than inferred (Issue #323). */
  probesControlPlane: boolean;
  /** True when a wedged container can be terminated (Issue #323). */
  recoversWedgedContainer: boolean;
  /** True when process-group signals do not kill the supervisor (Issue #1836). */
  survivesProcessGroupSignals: boolean;
}

/**
 * One source line with its quoted spans removed.
 *
 * Character by character rather than by regex: a line's quoting is a state
 * machine, and there is nothing here worth a backtracking surface.
 */
function outsideStrings(line: string): string {
  let quote = "";
  let code = "";
  for (const character of line) {
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    code += character;
  }
  return code;
}

/** Does the executable source evidence this capability? */
function has(
  source: { code: string; commands: string },
  dialect: LauncherDialect,
  capability: SupervisorCapability,
): boolean {
  const markers = CAPABILITY_MARKERS[capability];
  const text = markers.commandsOnly ? source.commands : source.code;
  return markers[dialect].some((alternative) =>
    alternative.every((fragment) => text.includes(fragment))
  );
}

/**
 * Is this status defined as a named constant and then used?
 *
 * A constant nothing compares against distinguishes nothing, so the name has
 * to appear at least twice: the definition, and one use. Matched by scanning
 * for an assignment of the literal to a name that says it is an exit status,
 * which both dialects spell the same way apart from the sigil
 * (`readonly QUOTA_PAUSE_EXIT=75`, `$QuotaPauseExit = 75`).
 */
function distinguishes(code: string, status: number): boolean {
  const literal = String(status);
  for (const line of code.split("\n")) {
    const trimmed = line.trimEnd();
    // `... = 75` — the assignment, not a comparison against one.
    if (!trimmed.endsWith(literal)) continue;
    const head = trimmed.slice(0, -literal.length).trimEnd();
    if (!head.endsWith("=")) continue;
    // The last identifier before the `=`, with any sigil dropped:
    // `readonly QUOTA_PAUSE_EXIT=75` and `$QuotaPauseExit = 75` both give
    // the name. Split on a static character class — a pattern built from the
    // status would be a needless dynamic regex.
    const name = head.slice(0, -1).trimEnd().split(/[^A-Za-z0-9_]/).pop() ?? "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (!name.toLowerCase().includes("exit")) continue;
    if (code.split(name).length - 1 >= 2) return true;
  }
  return false;
}

/**
 * Read a supervisor's source and report the contract it keeps.
 *
 * @param name - Script file name (`loop.sh`, `loop.ps1`)
 * @param source - The supervisor's full source text
 * @param dialect - Language the supervisor is written in
 * @returns What the source says the supervisor does
 */
export function extractSupervisorContract(
  name: string,
  source: string,
  dialect: LauncherDialect,
): SupervisorContract {
  const lines = executableLines(source, dialect);
  const code = lines.join("\n");
  const commands = lines.map(outsideStrings).join("\n");
  const capability = (name: SupervisorCapability) =>
    has({ code, commands }, dialect, name);

  return {
    name,
    dialect,
    neverExits: capability("neverExits"),
    invokesLauncher: capability("invokesLauncher"),
    delegatesBackoff: capability("delegatesBackoff"),
    resolvesLogDir: capability("resolvesLogDir"),
    writesLaunchLog: capability("writesLaunchLog"),
    prunesLaunchLogs: capability("prunesLaunchLogs"),
    quotesLaunchLogInEscalation: capability("quotesLaunchLogInEscalation"),
    namesHostInEscalation: capability("namesHostInEscalation"),
    refreshesCheckout: capability("refreshesCheckout"),
    recordsOutcomeItself: capability("recordsOutcomeItself"),
    freezesLockfile: capability("freezesLockfile"),
    honoursSleepOverride: capability("honoursSleepOverride"),
    reportsOnStderr: capability("reportsOnStderr"),
    distinguishedExitStatuses: SHARED_EXIT_STATUSES
      .filter((known) => distinguishes(code, known.status))
      .map((known) => known.name),
    boundsRunDuration: capability("boundsRunDuration"),
    reapsOrphans: capability("reapsOrphans"),
    probesControlPlane: capability("probesControlPlane"),
    recoversWedgedContainer: capability("recoversWedgedContainer"),
    survivesProcessGroupSignals: capability("survivesProcessGroupSignals"),
  };
}

/** Describe a list for a divergence message. */
function describe(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

/** Contract fields the two supervisors are compared on. */
export type SupervisorComparedField = Exclude<
  keyof SupervisorContract,
  "name" | "dialect"
>;

/** What each compared field is called in a divergence message. */
const COMPARED_FIELDS: Record<SupervisorComparedField, string> = {
  neverExits: "never-exit supervision loop",
  invokesLauncher: "launcher invocation",
  delegatesBackoff: "delegated restart backoff",
  resolvesLogDir: "resolved log directory",
  writesLaunchLog: "per-cycle launch log",
  prunesLaunchLogs: "launch-log pruning",
  quotesLaunchLogInEscalation: "launch log quoted in the escalation",
  namesHostInEscalation: "host named in the escalation",
  refreshesCheckout: "per-cycle checkout refresh",
  recordsOutcomeItself: "supervisor-owned outcome recording",
  freezesLockfile: "lockfile freezing",
  honoursSleepOverride: "base sleep override",
  reportsOnStderr: "loud fallbacks on stderr",
  distinguishedExitStatuses: "distinguished launcher exit statuses",
  boundsRunDuration: "host-side run duration cap",
  reapsOrphans: "orphaned container reaping",
  probesControlPlane: "container control-plane probe",
  recoversWedgedContainer: "wedged container recovery",
  survivesProcessGroupSignals: "process-group signal survival",
};

/** A divergence the two supervisors are allowed to keep, and why. */
export interface LoopParityException {
  /** Short name the report quotes. */
  name: string;
  /** Fields the exception covers. */
  fields: readonly SupervisorComparedField[];
  /** Why the asymmetry is intended. */
  reason: string;
  /**
   * Granted only while this holds. An exception that cannot lapse is a
   * licence, not an exception.
   */
  granted: (left: SupervisorContract, right: SupervisorContract) => boolean;
}

/**
 * The bash supervisor has the capability and the PowerShell one does not.
 *
 * Every intended asymmetry here excuses the PowerShell side for a
 * platform reason. If the bash side ever drops the capability the excuse no
 * longer describes what happened, so the divergence is reported instead.
 */
function onlyBashHas(
  field: SupervisorComparedField,
): (left: SupervisorContract, right: SupervisorContract) => boolean {
  return (left, right) => {
    const bash = [left, right].find((c) => c.dialect === "bash");
    const powershell = [left, right].find((c) => c.dialect === "powershell");
    return bash?.[field] === true && powershell?.[field] === false;
  };
}

/**
 * The run cap and the reaping it makes necessary (Issues #322, #423).
 *
 * `loop.sh` wraps each run in `timeout --kill-after=<grace>
 * <VIBE_RUN_MAX_SECONDS>` and reaps the container the kill orphans.
 * `loop.ps1` invokes `run.ps1` in-process, so it can bound nothing: what
 * bounds a run on a Windows host is the container watchdog, the worker's own
 * run-duration limit, and Task Scheduler, which owns the wall clock there.
 *
 * Granted only while a supervisor that bounds a run also reaps after it: a
 * cap that kills a launcher and leaves its container running at full tilt is
 * the 2026-08-22 incident, not an intended asymmetry.
 */
export const HOST_SIDE_RUN_BOUND: LoopParityException = {
  name: "host-side-run-bound",
  fields: ["boundsRunDuration", "reapsOrphans"],
  reason:
    "loop.ps1 invokes run.ps1 in-process and can bound nothing host-side " +
    "(Issue #423): the container watchdog, the worker's own run-duration " +
    "limit and Task Scheduler bound a Windows run instead",
  granted: (left, right) =>
    onlyBashHas("boundsRunDuration")(left, right) &&
    onlyBashHas("reapsOrphans")(left, right) &&
    [left, right].every((c) => c.boundsRunDuration === c.reapsOrphans),
};

/**
 * The Apple `container` control-plane probe (Issue #323).
 *
 * The probe and its recovery exist for the macOS-only Apple `container`
 * runtime, whose init stopped answering on 2026-08-22 while `container ls`
 * reported the container healthy. Recovery walks the host process tree with
 * `pgrep`/`ps`/`kill`, which is the same Unix-only surface.
 *
 * Granted only while a supervisor that probes can also recover: a probe that
 * detects a wedged control plane and can do nothing about it is worse than
 * no probe, because it reports the fault as handled.
 */
export const MACOS_CONTAINER_CONTROL_PLANE: LoopParityException = {
  name: "macos-container-control-plane",
  fields: ["probesControlPlane", "recoversWedgedContainer"],
  reason: "the control-plane probe exists for the macOS-only Apple container " +
    "runtime and recovers through the Unix process tree (Issue #323)",
  granted: (left, right) =>
    onlyBashHas("probesControlPlane")(left, right) &&
    onlyBashHas("recoversWedgedContainer")(left, right) &&
    [left, right].every((c) =>
      c.probesControlPlane === c.recoversWedgedContainer
    ),
};

/**
 * Surviving a process-group signal (Issue #1836).
 *
 * A SIGTERM delivered to the worker's process group also reaches `loop.sh`,
 * which would otherwise inherit the default disposition and die — a 10-hour
 * gap in the logs after a clean worker shutdown. PowerShell on Windows has no
 * process group to be signalled through and no disposition to override.
 */
export const PROCESS_GROUP_SIGNALS: LoopParityException = {
  name: "process-group-signals",
  fields: ["survivesProcessGroupSignals"],
  reason:
    "SIGTERM/SIGHUP reach a bash supervisor through the Unix process group " +
    "(Issue #1836); Windows PowerShell has no equivalent disposition to " +
    "override",
  granted: onlyBashHas("survivesProcessGroupSignals"),
};

/** Every intended asymmetry between the two supervisors. */
export const LOOP_PARITY_EXCEPTIONS: readonly LoopParityException[] = [
  HOST_SIDE_RUN_BOUND,
  MACOS_CONTAINER_CONTROL_PLANE,
  PROCESS_GROUP_SIGNALS,
];

/** How two supervisors compare. */
export interface LoopParityReport {
  /** Unintended divergences — empty is the only acceptable result. */
  divergences: string[];
  /** Divergences covered by a named exception, each quoting it. */
  excepted: string[];
}

/** Render one contract value for a divergence message. */
function render(value: boolean | string[]): string {
  return typeof value === "boolean" ? String(value) : describe(value);
}

/**
 * Report every way two supervisors have drifted apart.
 *
 * @param left - One supervisor's contract
 * @param right - The other supervisor's contract
 * @returns Unintended divergences, and those covered by a named exception
 */
export function compareSupervisorContracts(
  left: SupervisorContract,
  right: SupervisorContract,
): LoopParityReport {
  const report: LoopParityReport = { divergences: [], excepted: [] };

  for (const [field, label] of Object.entries(COMPARED_FIELDS)) {
    const key = field as SupervisorComparedField;
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
    const exception = LOOP_PARITY_EXCEPTIONS.find((candidate) =>
      candidate.fields.includes(key) && candidate.granted(left, right)
    );
    if (exception) {
      report.excepted.push(
        `[${exception.name}] intended: ${message} — ${exception.reason}`,
      );
    } else {
      report.divergences.push(message);
    }
  }

  return report;
}

/**
 * Faults in a single supervisor, whatever the other one does.
 *
 * Parity alone is not enough: two supervisors that both stop pulling their
 * checkout agree with each other and are both wrong.
 *
 * @param contract - The contract read from a supervisor's source
 * @returns One message per fault; empty when the supervisor is sound
 */
export function supervisorContractFaults(
  contract: SupervisorContract,
): string[] {
  const faults: string[] = [];
  const require = (held: boolean, fault: string) => {
    if (!held) faults.push(`${contract.name} ${fault}`);
  };

  require(
    contract.neverExits,
    "has no never-exit supervision loop, so the host stops being supervised " +
      "the first time a cycle ends",
  );
  require(
    contract.invokesLauncher,
    "never invokes this platform's launcher, so it supervises nothing",
  );
  require(
    contract.delegatesBackoff,
    "does not ask container-restart-backoff how long to wait, so a " +
      "repeatedly failing host retries blindly and never escalates " +
      "(Issue #4072)",
  );
  require(
    contract.resolvesLogDir,
    "does not resolve the log directory through the worker's log-dir " +
      "command, so it writes where nothing reads (Issues #873, #1402)",
  );
  require(
    contract.writesLaunchLog,
    "writes no per-cycle launch log, so a failed launch leaves no evidence " +
      "(Issue #633)",
  );
  require(
    contract.prunesLaunchLogs,
    "never prunes its launch logs, so an unbounded directory grows on the " +
      "host (Issue #633)",
  );
  require(
    contract.quotesLaunchLogInEscalation,
    "does not hand the recorder this cycle's launch log, so an escalation " +
      "quotes only an exit status (Issues #709, #1029)",
  );
  require(
    contract.namesHostInEscalation,
    "records outcomes without --allow-sys=hostname, so every host in the " +
      "fleet escalates as unknown-host onto one issue (Issues #633, #710)",
  );
  require(
    contract.refreshesCheckout,
    "never refreshes its checkout, so a host it supervises runs the " +
      "revision it was started with for ever — including through the fix " +
      "for whatever is breaking it (Issue #1401)",
  );
  require(
    contract.recordsOutcomeItself,
    "does not set VIBE_SUPERVISOR_RECORDS_OUTCOME, so one launcher failure " +
      "is counted twice (Issue #4072)",
  );
  require(
    contract.freezesLockfile,
    "runs the worker without --frozen and an explicit --lock=, so " +
      "dependency drift is resolved silently (Issue #3653)",
  );
  require(
    contract.honoursSleepOverride,
    "hardcodes its base sleep, so neither a host nor a test can shorten it",
  );
  require(
    contract.reportsOnStderr,
    "writes nothing to stderr, so its fallbacks are silent — a supervisor " +
      "that must never exit still says what it did",
  );

  const undistinguished = SHARED_EXIT_STATUSES.filter((known) =>
    !contract.distinguishedExitStatuses.includes(known.name)
  );
  for (const known of undistinguished) {
    faults.push(
      `${contract.name} treats launcher status ${known.status} ` +
        `(${known.name}) as an ordinary failure: ${known.reason}`,
    );
  }

  if (contract.boundsRunDuration && !contract.reapsOrphans) {
    faults.push(
      `${contract.name} kills its launcher at the run cap but never reaps ` +
        `the container the kill orphans, which leaves a VM running with ` +
        `nothing supervising it and makes the next cycle fail the same way ` +
        `(Issue #322)`,
    );
  }
  if (contract.probesControlPlane && !contract.recoversWedgedContainer) {
    faults.push(
      `${contract.name} probes the container control plane but cannot ` +
        `recover a wedged one, so the fault is detected and then reported ` +
        `as handled (Issue #323)`,
    );
  }

  return faults;
}
