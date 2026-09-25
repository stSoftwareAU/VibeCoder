/**
 * Build the post-run callback context for one terminal issue run (Issue #806,
 * parent #796) and the per-cycle heartbeat (Issue #1955).
 *
 * The scan loop knows the claim, the result and the wall-clock bounds; this
 * module adds the host, worker, provider, session and transcript facts that
 * identify *which* run a hook is looking at.
 *
 * Every optional fact is **omitted when unknown**, never guessed and never
 * emitted empty, so `sessionId in context` is a truthful test rather than a
 * value a hook has to second-guess. Telemetry and the session log are the
 * exception (Issue #1948): when the value is absent a reason code is present
 * instead, never neither.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { FailureCategory } from "./failure_diagnosis.ts";
import type {
  CallbackRunOutcome,
  CycleCallbackContext,
  IssueRunCallbackContext,
  SessionLogAbsentReason,
  TerminalIssueRun,
  TerminalScanCycle,
} from "./run_callbacks.ts";
import { callbackGraftFacts } from "./run_callbacks.ts";
import { BRIEF_OFF, CODEGRAPH_OFF, RTK_OFF } from "./run_callbacks.ts";
import { classifyRunFailure } from "./run_outcome_classifier.ts";
import {
  agentTranscriptDir,
  agentTranscriptEnabled,
  agentTranscriptPath,
  peekTranscriptAbsence,
} from "./agent_transcript.ts";
import {
  type WorkerBuildFacts,
  workerBuildFacts,
} from "./worker_build_info.ts";

/** Host-side facts the loop cannot supply on its own. */
export interface CallbackIdentity {
  /** Canonical worker run id (`VIBE_RUN_ID`). */
  runId: string;
  /** Host the worker runs on. */
  host: string;
  /** Operator-configured worker name, when set. */
  workerName?: string;
  /** Agent provider configured for this worker, when set. */
  provider?: string;
  /** Agent session id for this claim, when the run recorded one. */
  sessionId?: string;
  /** Home directory the transcript tee writes beneath. */
  home?: string;
}

/** Non-blank trimmed value, or undefined. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Whether a path exists on disk. Injectable so tests need no filesystem. */
export type PathExists = (path: string) => boolean;

/** Default existence probe, tolerating a denied `--allow-read`. */
function fileExists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** Seams the builder resolves the transcript through. */
export interface CallbackContextSeams {
  /** Whether the agent transcript tee is switched on for this run. */
  transcriptEnabled?: () => boolean;
  /** Existence probe for the resolved transcript path. */
  exists?: PathExists;
  /** Last disable reason the writer recorded for this issue, when any. */
  transcriptAbsenceReason?: (
    issueNumber: number,
  ) => SessionLogAbsentReason | undefined;
  /**
   * Worker build identity for this run (Issue #2444). Defaults to the
   * process-wide memo, so a caller never resolves it per run.
   */
  buildFacts?: () => WorkerBuildFacts;
}

/**
 * Absolute path of this run's agent transcript, when one was actually
 * written, or the reason it is absent (Issue #1948).
 *
 * The tee writes nothing unless `.config.json`'s `agent_transcript_enabled`
 * asks for it (Issue #1141), and it disables itself when its directory cannot
 * be created — so the path is **verified on disk** before it is published.
 * Naming a file a hook cannot open would be worse than naming none.
 *
 * The directory comes from {@link agentTranscriptDir}, the same helper the
 * writer uses: this call site has to find the file that one made, so the two
 * must not be able to disagree.
 */
export function resolveSessionLog(
  identity: CallbackIdentity,
  issueNumber: number,
  seams: CallbackContextSeams = {},
): { path: string } | { reason: SessionLogAbsentReason } {
  const transcriptEnabled = seams.transcriptEnabled ?? agentTranscriptEnabled;
  const exists = seams.exists ?? fileExists;
  if (!transcriptEnabled()) return { reason: "tee_disabled" };
  const home = present(identity.home);
  if (!home) return { reason: "log_dir_unavailable" };
  const path = agentTranscriptPath(
    agentTranscriptDir(home),
    identity.runId,
    issueNumber,
  );
  if (exists(path)) return { path };
  const recorded = seams.transcriptAbsenceReason?.(issueNumber) ??
    peekTranscriptAbsence(identity.runId, issueNumber);
  return { reason: recorded ?? "file_missing" };
}

/**
 * Absolute path of this run's agent transcript, when one was actually
 * written. Prefer {@link resolveSessionLog} when the absence reason matters.
 */
export function resolveSessionLogPath(
  identity: CallbackIdentity,
  issueNumber: number,
  seams: CallbackContextSeams = {},
): string | undefined {
  const resolved = resolveSessionLog(identity, issueNumber, seams);
  return "path" in resolved ? resolved.path : undefined;
}

/** Map a {@link TerminalIssueRun} onto the structured callback outcome. */
export function callbackOutcomeFromRun(
  run: TerminalIssueRun,
): CallbackRunOutcome | undefined {
  const outcome = run.outcome;
  if (!outcome) {
    if (!run.phase) return undefined;
    return {
      kind: "no_pr",
      category: "unknown" satisfies FailureCategory,
      phase: run.phase,
    };
  }
  const result: CallbackRunOutcome = { kind: outcome.kind };
  if ("phase" in outcome && typeof outcome.phase === "string") {
    result.phase = outcome.phase;
  } else if (run.phase) {
    result.phase = run.phase;
  }
  if (outcome.kind === "no_pr") {
    result.category = outcome.category;
    result.failureClass = classifyRunFailure(
      outcome.category,
      outcome.message,
    ).failureClass;
  } else if (outcome.kind === "pr" && outcome.blocked) {
    // A PR-then-later-step failure (Issue #2044): the archive reads the PR
    // number AND why the run still failed, so "delivered, one finding
    // outstanding" is countable separately from "delivered nothing".
    result.phase = outcome.blocked.phase;
    result.category = outcome.blocked.category;
    result.failureClass = classifyRunFailure(
      outcome.blocked.category,
      outcome.blocked.reason,
    ).failureClass;
  }
  if ("prNumber" in outcome && typeof outcome.prNumber === "number") {
    result.prNumber = outcome.prNumber;
  }
  return result;
}

/** Assemble the versioned context handed to every hook this run triggers. */
export function buildIssueRunCallbackContext(
  run: TerminalIssueRun,
  identity: CallbackIdentity,
  seams: CallbackContextSeams = {},
): IssueRunCallbackContext {
  const sessionLog = resolveSessionLog(
    identity,
    run.issueNumber,
    seams,
  );
  const outcome = callbackOutcomeFromRun(run);
  const facts = (seams.buildFacts ?? (() => workerBuildFacts()))();
  return {
    runId: identity.runId,
    result: run.result,
    repository: run.repo,
    issueNumber: run.issueNumber,
    host: identity.host,
    ...(present(identity.workerName)
      ? { workerName: present(identity.workerName)! }
      : {}),
    // Issue #2444: omitted rather than guessed when the build could not be
    // read; resolved once per process, never per run.
    ...(facts.version ? { workerVersion: facts.version } : {}),
    ...(facts.commit ? { workerCommit: facts.commit } : {}),
    // Issue #2100: the workflow label the dispatch matched, so an archive can
    // compare implementation runs only. Absent when the loop named none.
    ...(present(run.mode) ? { mode: present(run.mode)! } : {}),
    ...(present(identity.provider)
      ? { provider: present(identity.provider)! }
      : {}),
    ...(present(identity.sessionId)
      ? { sessionId: present(identity.sessionId)! }
      : {}),
    ...("path" in sessionLog
      ? { sessionLogPath: sessionLog.path }
      : { sessionLogAbsentReason: sessionLog.reason }),
    startedAt: new Date(run.startedAtEpochMs).toISOString(),
    finishedAt: new Date(run.finishedAtEpochMs).toISOString(),
    durationSeconds: Math.max(
      0,
      Math.round((run.finishedAtEpochMs - run.startedAtEpochMs) / 1000),
    ),
    exitCode: run.result === "success" ? 0 : 1,
    ...(run.telemetry ? { telemetry: run.telemetry } : {
      telemetryAbsentReason: run.telemetryAbsentReason ??
        "agent_not_invoked",
    }),
    // Issue #2104: what this run's Graft collection did, rebuilt field by
    // field so the bundle text can never ride along. Absent when the run
    // ended before the collection — the document reports `off` for it.
    ...(run.graft ? { graft: callbackGraftFacts(run.graft) } : {}),
    ...(outcome ? { outcome } : {}),
    // Issue #2162: stated on every run, so a host without the switch is
    // explicitly comparable with the hosts that have it.
    codegraph: run.codegraph ?? CODEGRAPH_OFF,
    // Issue #2386: likewise stated on every run, `off` when the run reported
    // no RTK preparation.
    rtk: run.rtk ?? RTK_OFF,
    // Issue #2603: and brief's, `off` when the run reported no outcome.
    brief: run.brief ?? BRIEF_OFF,
  };
}

/** Assemble the versioned context handed to the per-cycle heartbeat. */
export function buildCycleCallbackContext(
  cycle: TerminalScanCycle,
  identity: Pick<CallbackIdentity, "runId" | "host" | "workerName">,
): CycleCallbackContext {
  return {
    runId: identity.runId,
    host: identity.host,
    ...(present(identity.workerName)
      ? { workerName: present(identity.workerName)! }
      : {}),
    startedAt: new Date(cycle.startedAtEpochMs).toISOString(),
    finishedAt: new Date(cycle.finishedAtEpochMs).toISOString(),
    durationSeconds: Math.max(
      0,
      Math.round((cycle.finishedAtEpochMs - cycle.startedAtEpochMs) / 1000),
    ),
    issuesScanned: cycle.issuesScanned,
    claimsAttempted: cycle.claimsAttempted,
    claimsTaken: cycle.claimsTaken,
    endReason: cycle.endReason,
    fleetSummary: cycle.fleetSummary,
  };
}
