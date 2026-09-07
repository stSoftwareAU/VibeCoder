/**
 * The two supervisors must not drift apart (Issue #1403).
 *
 * `setup` and `run` each had a parity test long before `loop` did, and the
 * two supervisors drifted to 501 and 148 lines while nothing checked them:
 * `loop.ps1` never pulled its checkout (Issue #1401) and never resolved the
 * log directory (Issue #1402), both found by reading the files side by side
 * rather than by any gate. This is the gate.
 *
 * Each supervisor's contract is read from its source — whether the loop can
 * exit, whether the backoff is delegated, where the cycle logs, whether the
 * checkout is refreshed, which launcher exit statuses are told apart — and
 * the two are compared. A divergence fails unless it is covered by a named
 * exception, and every exception is granted only while its own condition
 * holds.
 *
 * Read by source rather than by invocation: a supervisor's whole job is to
 * run for hours without exiting, so the behaviours that matter here cannot be
 * observed in a unit test's budget. The behavioural half lives in
 * `loop_supervisor_test.ts`.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  compareSupervisorContracts,
  extractSupervisorContract,
  LOOP_PARITY_EXCEPTIONS,
  SHARED_EXIT_STATUSES,
  type SupervisorContract,
  supervisorContractFaults,
} from "../lib/loop_contract.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

const LOOP_SH_SOURCE = await Deno.readTextFile(`${REPO_ROOT}/loop.sh`);
const LOOP_PS1_SOURCE = await Deno.readTextFile(`${REPO_ROOT}/loop.ps1`);

const LOOP_SH = extractSupervisorContract("loop.sh", LOOP_SH_SOURCE, "bash");
const LOOP_PS1 = extractSupervisorContract(
  "loop.ps1",
  LOOP_PS1_SOURCE,
  "powershell",
);

/**
 * A synthetic bash supervisor that keeps the whole contract, plus whatever
 * extra lines a test needs.
 */
function bashSupervisor(...extraLines: string[]): string {
  return [
    "LOOP_SLEEP_SECONDS=${LOOP_SLEEP_SECONDS:-60}",
    "export VIBE_SUPERVISOR_RECORDS_OUTCOME=1",
    "readonly QUOTA_PAUSE_EXIT=75",
    "readonly ANOTHER_WORKER_RUNNING_EXIT=4",
    'LOG_DIR="$(deno run --frozen --lock=deno.lock mod.ts log-dir)"',
    'trap "on_signal SIGTERM" SIGTERM',
    "while true; do",
    '  rm -f "${LOG_DIR}"/launch-*.log',
    '  LAUNCH_LOG="${LOG_DIR}/launch-${EPOCH}.log"',
    '  timeout "${VIBE_RUN_MAX_SECONDS}" ./run.sh',
    '  pgrep -f "container run" && kill -TERM "${pid}"',
    '  container exec "${name}" true || container kill "${name}"',
    '  [[ "${status}" -eq "${QUOTA_PAUSE_EXIT}" ]] && echo paused >&2',
    '  [[ "${status}" -eq "${ANOTHER_WORKER_RUNNING_EXIT}" ]] && echo busy',
    "  deno run --frozen --lock=deno.lock --allow-sys=hostname mod.ts",
    '    container-restart-backoff --launch-log "${LAUNCH_LOG}"',
    "  git pull",
    ...extraLines,
    "done",
  ].join("\n");
}

/**
 * A synthetic PowerShell supervisor that keeps the whole contract, minus the
 * three capabilities the named exceptions cover.
 */
function powershellSupervisor(...extraLines: string[]): string {
  return [
    '$LoopSleepSeconds = [Environment]::GetEnvironmentVariable("LOOP_SLEEP_SECONDS")',
    '$env:VIBE_SUPERVISOR_RECORDS_OUTCOME = "1"',
    "$QuotaPauseExit = 75",
    "$AnotherWorkerRunningExit = 4",
    '$LogDir = & deno run "--frozen" "--lock=deno.lock" $WorkerMod "log-dir"',
    "while ($true) {",
    '    Get-ChildItem -Filter "launch-*.log" | Remove-Item',
    '    $LaunchLog = Join-Path $LogDir "launch-$epoch.log"',
    '    & "$ScriptDir/run.ps1"',
    "    if ($status -eq $QuotaPauseExit) { }",
    "    if ($status -eq $AnotherWorkerRunningExit) { }",
    '    [Console]::Error.WriteLine("falling back")',
    '    & deno run "--frozen" "--lock=deno.lock" "--allow-sys=hostname"',
    '        $WorkerMod "container-restart-backoff" "--launch-log" $LaunchLog',
    "    & git pull",
    ...extraLines,
    "}",
  ].join("\n");
}

const SOUND_BASH = extractSupervisorContract(
  "sound.sh",
  bashSupervisor(),
  "bash",
);
const SOUND_POWERSHELL = extractSupervisorContract(
  "sound.ps1",
  powershellSupervisor(),
  "powershell",
);

/** Every field of `contract` a test names, for a readable assertion. */
function capabilities(contract: SupervisorContract): Record<string, unknown> {
  const { name: _name, dialect: _dialect, ...rest } = contract;
  return rest;
}

// ---------------------------------------------------------------------------
// The extractor itself, against sources whose contents are known
// ---------------------------------------------------------------------------

Deno.test("extractSupervisorContract - reads what a bash supervisor does", () => {
  assertEquals(capabilities(SOUND_BASH), {
    neverExits: true,
    invokesLauncher: true,
    delegatesBackoff: true,
    resolvesLogDir: true,
    writesLaunchLog: true,
    prunesLaunchLogs: true,
    quotesLaunchLogInEscalation: true,
    namesHostInEscalation: true,
    refreshesCheckout: true,
    recordsOutcomeItself: true,
    freezesLockfile: true,
    honoursSleepOverride: true,
    reportsOnStderr: true,
    distinguishedExitStatuses: ["another-worker-running", "quota-pause"],
    boundsRunDuration: true,
    reapsOrphans: true,
    probesControlPlane: true,
    recoversWedgedContainer: true,
    survivesProcessGroupSignals: true,
  });
});

Deno.test("extractSupervisorContract - reads what a PowerShell supervisor does", () => {
  assertEquals(capabilities(SOUND_POWERSHELL), {
    neverExits: true,
    invokesLauncher: true,
    delegatesBackoff: true,
    resolvesLogDir: true,
    writesLaunchLog: true,
    prunesLaunchLogs: true,
    quotesLaunchLogInEscalation: true,
    namesHostInEscalation: true,
    refreshesCheckout: true,
    recordsOutcomeItself: true,
    freezesLockfile: true,
    honoursSleepOverride: true,
    reportsOnStderr: true,
    distinguishedExitStatuses: ["another-worker-running", "quota-pause"],
    // The three the named exceptions cover.
    boundsRunDuration: false,
    reapsOrphans: false,
    probesControlPlane: false,
    recoversWedgedContainer: false,
    survivesProcessGroupSignals: false,
  });
});

Deno.test("extractSupervisorContract - a capability described in a comment is not one", () => {
  const commented = extractSupervisorContract(
    "commented.sh",
    [
      "while true; do",
      "  ./run.sh",
      "  # git pull used to run here",
      "  # deno run mod.ts log-dir resolves the directory",
      "done",
    ].join("\n"),
    "bash",
  );
  assertEquals(commented.refreshesCheckout, false);
  assertEquals(commented.resolvesLogDir, false);
});

Deno.test("extractSupervisorContract - a PowerShell block comment cannot supervise either", () => {
  const commented = extractSupervisorContract(
    "commented.ps1",
    [
      "<#",
      ".SYNOPSIS",
      "    The cycle ends with `& git pull`, exactly as loop.sh does.",
      "#>",
      "while ($true) {",
      '    & "$ScriptDir/run.ps1"',
      "}",
    ].join("\n"),
    "powershell",
  );
  assertEquals(commented.refreshesCheckout, false);
  assertEquals(commented.invokesLauncher, true);
});

Deno.test("extractSupervisorContract - a status constant nothing compares against distinguishes nothing", () => {
  const defined = extractSupervisorContract(
    "defined.sh",
    ["readonly QUOTA_PAUSE_EXIT=75", "while true; do ./run.sh; done"].join(
      "\n",
    ),
    "bash",
  );
  assertEquals(defined.distinguishedExitStatuses, []);

  const used = extractSupervisorContract(
    "used.sh",
    [
      "readonly QUOTA_PAUSE_EXIT=75",
      'while true; do ./run.sh; [[ $? -eq "${QUOTA_PAUSE_EXIT}" ]] && :; done',
    ].join("\n"),
    "bash",
  );
  assertEquals(used.distinguishedExitStatuses, ["quota-pause"]);
});

// ---------------------------------------------------------------------------
// Faults in one supervisor, whatever the other one does
// ---------------------------------------------------------------------------

Deno.test("supervisorContractFaults - a sound supervisor has no faults", () => {
  assertEquals(supervisorContractFaults(SOUND_BASH), []);
  assertEquals(supervisorContractFaults(SOUND_POWERSHELL), []);
});

Deno.test("supervisorContractFaults - names every capability a bare loop is missing", () => {
  const bare = extractSupervisorContract(
    "bare.ps1",
    ['while ($true) { & "$ScriptDir/run.ps1" }'].join("\n"),
    "powershell",
  );
  const faults = supervisorContractFaults(bare);

  // Every fault the module can report except the two conditional ones, which
  // need a capability this supervisor does not have.
  assertEquals(faults.length, 13, faults.join("\n"));
  for (
    const expected of [
      "container-restart-backoff",
      "log-dir",
      "launch log",
      "prunes its launch logs",
      "--allow-sys=hostname",
      "refreshes its checkout",
      "VIBE_SUPERVISOR_RECORDS_OUTCOME",
      "--frozen",
      "base sleep",
      "stderr",
    ]
  ) {
    assert(
      faults.some((fault) => fault.includes(expected)),
      `no fault named ${expected}: ${faults.join("\n")}`,
    );
  }
  for (const known of SHARED_EXIT_STATUSES) {
    assert(
      faults.some((fault) => fault.includes(`status ${known.status}`)),
      `status ${known.status} not reported: ${faults.join("\n")}`,
    );
  }
});

Deno.test("supervisorContractFaults - a supervisor that never loops supervises nothing", () => {
  const once = extractSupervisorContract(
    "once.sh",
    bashSupervisor().replace("while true; do", "if true; then").replace(
      /done$/,
      "fi",
    ),
    "bash",
  );
  const faults = supervisorContractFaults(once);
  assertEquals(faults.length, 1, faults.join("\n"));
  assertStringIncludes(faults[0]!, "never-exit supervision loop");
});

Deno.test("supervisorContractFaults - a run cap without reaping is a fault (Issue #322)", () => {
  const unreaped = extractSupervisorContract(
    "unreaped.sh",
    bashSupervisor().replace(
      '  pgrep -f "container run" && kill -TERM "${pid}"',
      "",
    ),
    "bash",
  );
  assertEquals(unreaped.boundsRunDuration, true);
  assertEquals(unreaped.reapsOrphans, false);

  const faults = supervisorContractFaults(unreaped);
  assertEquals(faults.length, 1, faults.join("\n"));
  assertStringIncludes(faults[0]!, "never reaps");
  assertStringIncludes(faults[0]!, "Issue #322");
});

Deno.test("supervisorContractFaults - probing without recovery is a fault (Issue #323)", () => {
  const inert = extractSupervisorContract(
    "inert.sh",
    bashSupervisor().replace(' || container kill "${name}"', ""),
    "bash",
  );
  assertEquals(inert.probesControlPlane, true);
  assertEquals(inert.recoversWedgedContainer, false);

  const faults = supervisorContractFaults(inert);
  assertEquals(faults.length, 1, faults.join("\n"));
  assertStringIncludes(faults[0]!, "cannot");
  assertStringIncludes(faults[0]!, "Issue #323");
});

// ---------------------------------------------------------------------------
// Parity comparison
// ---------------------------------------------------------------------------

Deno.test("compareSupervisorContracts - a sound pair diverges only through named exceptions", () => {
  const report = compareSupervisorContracts(SOUND_BASH, SOUND_POWERSHELL);
  assertEquals(report.divergences, [], report.divergences.join("\n"));
  assertEquals(report.excepted.length, 5, report.excepted.join("\n"));
});

Deno.test("compareSupervisorContracts - a supervisor that stops pulling its checkout diverges (Issue #1401)", () => {
  const frozen = extractSupervisorContract(
    "loop.ps1",
    LOOP_PS1_SOURCE.replaceAll("& git pull", "# & git pull"),
    "powershell",
  );

  const { divergences } = compareSupervisorContracts(LOOP_SH, frozen);
  assertEquals(divergences.length, 1, divergences.join("\n"));
  assertStringIncludes(divergences[0]!, "checkout refresh");
});

Deno.test("compareSupervisorContracts - a supervisor that stops resolving the log directory diverges (Issue #1402)", () => {
  // Every occurrence, which is what the pre-#1402 loop.ps1 looked like: it
  // named `log-dir` nowhere at all. The marker is matched anywhere in the
  // executable source rather than outside strings, because PowerShell spells
  // it as a quoted argument — `$WorkerMod "log-dir"`.
  const unresolved = extractSupervisorContract(
    "loop.ps1",
    LOOP_PS1_SOURCE.replaceAll("log-dir", "elsewhere"),
    "powershell",
  );

  const { divergences } = compareSupervisorContracts(LOOP_SH, unresolved);
  assertEquals(divergences.length, 1, divergences.join("\n"));
  assertStringIncludes(divergences[0]!, "log directory");
});

Deno.test("extractSupervisorContract - a step named only in a message is not performed", () => {
  // Both supervisors log `git pull exited with status ...` beside the pull
  // itself, so a message alone must not be read as the step (Issue #1401).
  const talkative = extractSupervisorContract(
    "talkative.ps1",
    powershellSupervisor().replace(
      "    & git pull",
      '    Write-LoopLine "loop.ps1: git pull exited with status 1"',
    ),
    "powershell",
  );
  assertEquals(talkative.refreshesCheckout, false);

  const { divergences } = compareSupervisorContracts(SOUND_BASH, talkative);
  assert(
    divergences.some((message) => message.includes("checkout refresh")),
    divergences.join("\n"),
  );
});

Deno.test("compareSupervisorContracts - a supervisor that stops telling a scheduled pause from a crash diverges (Issue #342)", () => {
  const blind = extractSupervisorContract(
    "loop.ps1",
    LOOP_PS1_SOURCE.replaceAll("$QuotaPauseExit", "$SomeOtherThing"),
    "powershell",
  );

  const { divergences } = compareSupervisorContracts(LOOP_SH, blind);
  assertEquals(divergences.length, 1, divergences.join("\n"));
  assertStringIncludes(divergences[0]!, "exit statuses");
});

// ---------------------------------------------------------------------------
// The exceptions lapse rather than licence
// ---------------------------------------------------------------------------

Deno.test("the run-bound exception lapses when a supervisor caps a run but never reaps (Issue #322)", () => {
  const capped = extractSupervisorContract(
    "capped.ps1",
    powershellSupervisor(
      '    & $TimeoutCmd "$env:VIBE_RUN_MAX_SECONDS" "$ScriptDir/run.ps1"',
    ),
    "powershell",
  );
  assertEquals(capped.boundsRunDuration, true);
  assertEquals(capped.reapsOrphans, false);

  const { divergences, excepted } = compareSupervisorContracts(
    SOUND_BASH,
    capped,
  );
  assertEquals(
    excepted.some((message) => message.includes("run duration")),
    false,
  );
  assert(
    divergences.some((message) => message.includes("orphaned container")),
    `an unreaped cap must be reported: ${divergences.join("\n")}`,
  );
  assert(
    supervisorContractFaults(capped).some((fault) =>
      fault.includes("never reaps")
    ),
  );
});

Deno.test("the control-plane exception lapses when a supervisor probes without recovering (Issue #323)", () => {
  const probing = extractSupervisorContract(
    "probing.ps1",
    powershellSupervisor('    & container exec "$name" true'),
    "powershell",
  );

  const { divergences, excepted } = compareSupervisorContracts(
    SOUND_BASH,
    probing,
  );
  assertEquals(
    excepted.some((message) => message.includes("control-plane probe")),
    false,
  );
  assert(
    divergences.some((message) => message.includes("wedged container")),
    `a probe with no recovery must be reported: ${divergences.join("\n")}`,
  );
});

Deno.test("an exception does not excuse the bash supervisor dropping the capability", () => {
  const untrapped = extractSupervisorContract(
    "untrapped.sh",
    bashSupervisor().replace('trap "on_signal SIGTERM" SIGTERM', ""),
    "bash",
  );
  const signalling = extractSupervisorContract(
    "signalling.ps1",
    powershellSupervisor(
      "    Register-EngineEvent PowerShell.Exiting -Action { }",
    ),
    "powershell",
  );

  const { divergences, excepted } = compareSupervisorContracts(
    untrapped,
    signalling,
  );
  assertEquals(
    excepted.some((message) => message.includes("process-group")),
    false,
    "the exception excuses the PowerShell side, never the bash one",
  );
  assert(
    divergences.some((message) => message.includes("process-group")),
    divergences.join("\n"),
  );
});

Deno.test("every named exception states why it is intended", () => {
  for (const exception of LOOP_PARITY_EXCEPTIONS) {
    assert(exception.fields.length > 0, `${exception.name} covers no field`);
    assert(
      /Issue #\d+/.test(exception.reason),
      `${exception.name} must cite the issue that decided it`,
    );
  }
});

// ---------------------------------------------------------------------------
// The real supervisors
// ---------------------------------------------------------------------------

Deno.test("loop.sh and loop.ps1 - keep the same supervision contract", () => {
  const { divergences } = compareSupervisorContracts(LOOP_SH, LOOP_PS1);
  assertEquals(divergences, [], divergences.join("\n"));
});

Deno.test("loop.sh and loop.ps1 - every remaining asymmetry is a named, stated exception", () => {
  const { excepted } = compareSupervisorContracts(LOOP_SH, LOOP_PS1);
  for (const message of excepted) {
    assert(
      LOOP_PARITY_EXCEPTIONS.some((exception) =>
        message.startsWith(`[${exception.name}]`)
      ),
      `unnamed exception: ${message}`,
    );
  }
});

Deno.test("loop.sh and loop.ps1 - neither carries a fault of its own", () => {
  for (const contract of [LOOP_SH, LOOP_PS1]) {
    const faults = supervisorContractFaults(contract);
    assertEquals(faults, [], faults.join("\n"));
  }
});

Deno.test("loop.sh and loop.ps1 - both tell every shared launcher exit status apart", () => {
  for (const contract of [LOOP_SH, LOOP_PS1]) {
    assertEquals(
      contract.distinguishedExitStatuses,
      SHARED_EXIT_STATUSES.map((known) => known.name),
      `${contract.name} must not treat a scheduled pause as a crash`,
    );
  }
});
