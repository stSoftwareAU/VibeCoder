/**
 * Build the post-run callback context for one terminal issue run (Issue #806,
 * parent #796).
 *
 * The scan loop knows the claim, the result and the wall-clock bounds; this
 * module adds the host, worker, provider, session and transcript facts that
 * identify *which* run a hook is looking at.
 *
 * Every optional fact is **omitted when unknown**, never guessed and never
 * emitted empty, so `sessionId in context` is a truthful test rather than a
 * value a hook has to second-guess.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type {
  IssueRunCallbackContext,
  TerminalIssueRun,
} from "./run_callbacks.ts";
import {
  agentTranscriptDir,
  agentTranscriptEnabled,
  agentTranscriptPath,
} from "./agent_transcript.ts";

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
}

/**
 * Absolute path of this run's agent transcript, when one was actually
 * written.
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
export function resolveSessionLogPath(
  identity: CallbackIdentity,
  issueNumber: number,
  seams: CallbackContextSeams = {},
): string | undefined {
  const transcriptEnabled = seams.transcriptEnabled ?? agentTranscriptEnabled;
  const exists = seams.exists ?? fileExists;
  const home = present(identity.home);
  if (!home || !transcriptEnabled()) return undefined;
  const path = agentTranscriptPath(
    agentTranscriptDir(home),
    identity.runId,
    issueNumber,
  );
  return exists(path) ? path : undefined;
}

/** Assemble the versioned context handed to every hook this run triggers. */
export function buildIssueRunCallbackContext(
  run: TerminalIssueRun,
  identity: CallbackIdentity,
  seams: CallbackContextSeams = {},
): IssueRunCallbackContext {
  const sessionLogPath = resolveSessionLogPath(
    identity,
    run.issueNumber,
    seams,
  );
  return {
    runId: identity.runId,
    result: run.result,
    repository: run.repo,
    issueNumber: run.issueNumber,
    host: identity.host,
    ...(present(identity.workerName)
      ? { workerName: present(identity.workerName)! }
      : {}),
    ...(present(identity.provider)
      ? { provider: present(identity.provider)! }
      : {}),
    ...(present(identity.sessionId)
      ? { sessionId: present(identity.sessionId)! }
      : {}),
    ...(sessionLogPath ? { sessionLogPath } : {}),
    startedAt: new Date(run.startedAtEpochMs).toISOString(),
    finishedAt: new Date(run.finishedAtEpochMs).toISOString(),
    // Clamped at zero: the claim time and the finish time can come from
    // different clocks in a test wiring, and a negative duration would be
    // nonsense to a hook.
    durationSeconds: Math.max(
      0,
      Math.round((run.finishedAtEpochMs - run.startedAtEpochMs) / 1000),
    ),
    // The run's own exit code: 0 for success, 1 for failure. A hook never
    // changes it.
    exitCode: run.result === "success" ? 0 : 1,
    ...(run.telemetry ? { telemetry: run.telemetry } : {}),
  };
}
