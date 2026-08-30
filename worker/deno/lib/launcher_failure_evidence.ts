/**
 * Evidence for a launcher self-heal alert (Issues #633, #638).
 *
 * Issue #633 is the alert the fleet filed about itself, in full:
 *
 *   The launcher on `unknown-host` has failed 3 consecutive runs and has no
 *   issue in flight to report on, so this is the report.
 *   Failure phase: worker_run (worker run)
 *   Consecutive launcher failures: 3 (escalation threshold 3)
 *   Last launcher exit status: 255
 *   Next attempt after a 240s backoff
 *
 * The escalation worked — it noticed, counted, and reported without a human
 * asking. What it reported was the problem: every field was already in
 * `.container_restart_state.json`, and none of it helps find a cause.
 *
 * Two things were knowable and went unsaid:
 *
 * 1. The host. The same run writes `run mode: container host=GRQ-23` to its
 *    own log, and `resolveRunHostId()` has resolved it since Issue #4189.
 *    An alert that cannot name the machine is close to useless in a fleet
 *    reporting into one shared repository.
 *
 * 2. Whether the status can have come from the worker at all. `run_worker.ts`
 *    returns 0, 1, or the quota-pause status; `container_build_heal` and
 *    `container_reap` name their own. A status outside that set is BY
 *    CONSTRUCTION from the container runtime client, not from worker code —
 *    which rules out half the search space in one line, and took a manual
 *    trace through four files to establish the first time.
 *
 * Australian English spelling throughout (behaviour, recognise).
 */

/**
 * Exit statuses the worker itself can produce.
 *
 * Keep in step with `run_worker.ts` (0, 1, `QUOTA_PAUSE_EXIT_STATUS`) and the
 * commands that name their own — `container_build_heal` and `container_reap`.
 * Being wrong here costs a misleading sentence in an alert, so the wording
 * below hedges to "not a status the worker is known to produce" rather than
 * claiming the runtime is definitely at fault.
 */
export interface KnownWorkerStatuses {
  /** Statuses the worker or its commands return deliberately. */
  statuses: ReadonlyArray<number>;
  /** How each is described, for the alert's one-line explanation. */
  describe: (status: number) => string | undefined;
}

/** The default table, matching the current worker. */
export function knownWorkerStatuses(
  quotaPauseStatus: number,
  buildNotHealableStatus: number,
  anotherWorkerRunningStatus: number,
): KnownWorkerStatuses {
  const table = new Map<number, string>([
    [0, "a clean run"],
    [1, "a bootstrap, config or loop failure the worker reported itself"],
    [quotaPauseStatus, "a deliberate quota pause"],
    [buildNotHealableStatus, "an image build the heal path could not repair"],
    [anotherWorkerRunningStatus, "another worker already running"],
  ]);
  return {
    statuses: [...table.keys()],
    describe: (status: number) => table.get(status),
  };
}

/**
 * One line naming where an exit status must have come from.
 *
 * The point is to rule things out. A status the worker never produces did not
 * come from worker code, so the search starts at the runtime client and the
 * container, not in the worker's own error handling.
 */
export function explainExitStatus(
  status: number,
  known: KnownWorkerStatuses,
): string {
  const described = known.describe(status);
  if (described !== undefined) {
    return `Exit status ${status} is one the worker produces deliberately: ${described}.`;
  }
  const list = [...known.statuses].sort((a, b) => a - b).join(", ");
  return `Exit status ${status} is NOT one the worker produces (it returns ` +
    `${list}), so it came from the container runtime client or the container ` +
    `itself — not from worker code. Look at the runtime and the launch, not ` +
    `at the worker's error handling.`;
}

/** A log file and how much of its tail to quote. */
export interface LogTailRequest {
  /** Absolute path to the log. */
  path: string;
  /** Maximum lines to quote. */
  maxLines: number;
}

/** Reading is injected so the formatting can be tested without a filesystem. */
export interface EvidenceDeps {
  readTextFile: (path: string) => Promise<string>;
  /** Newest-first launcher logs, most recent first. */
  listLogs?: () => Promise<string[]>;
}

/**
 * The tail of a log, fenced and labelled, or a line saying why there is none.
 *
 * An alert that silently omits the log is indistinguishable from one whose
 * log was empty, and those need different responses — so the absence is
 * always stated.
 */
export async function formatLogTail(
  request: LogTailRequest,
  deps: EvidenceDeps,
): Promise<string> {
  let content: string;
  try {
    content = await deps.readTextFile(request.path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `No log tail: could not read ${request.path} (${message}).`;
  }

  const lines = content.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) {
    // Not a formatting nicety: the failing cycles in Issue #633 wrote ONLY
    // their header line before dying, and that emptiness is itself the
    // strongest evidence available — it says the worker died before it could
    // report anything, which a missing section would not.
    return `The log at ${request.path} is empty — the run produced no output ` +
      `at all before it exited, so it died before reaching anything that logs.`;
  }

  const tail = lines.slice(-request.maxLines);
  const omitted = lines.length - tail.length;
  const header = omitted > 0
    ? `Last ${tail.length} of ${lines.length} lines from ${request.path}:`
    : `All ${lines.length} line(s) from ${request.path}:`;
  return [header, "```", ...tail, "```"].join("\n");
}
