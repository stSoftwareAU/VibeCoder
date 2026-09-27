/**
 * `Prompt is too long` handling for the execute phase (Issue #2682).
 *
 * When the agent CLI refuses a run because the resumed conversation no longer
 * fits the model's context window, the fault is the worker's — it chose to
 * resume an oversized transcript. `/compact` cannot help (it resends the same
 * transcript), so the worker discards that session and retries once on a
 * fresh one without counting the attempt. Only a refusal on a fresh session
 * is a real failure, reported under the `prompt_too_long` category.
 *
 * The decide / discard split is deliberately generic — "worker fault on a
 * resumed session → one uncounted fresh-session retry" — so sibling faults
 * (e.g. #2689) can reuse {@link discardResumedSession}.
 */

import { PROMPT_TOO_LONG_MARKER } from "./failure_diagnosis.ts";
import {
  deleteResumeState,
  deleteStreamSession,
  lookupStreamSession,
  resumeStatePath,
  streamSessionPath,
} from "./resume_state_store.ts";
import {
  createSessionResumeState,
  type SessionResumeState,
} from "./session_resume.ts";
import type { JoinedStream, StreamSessionLogger } from "./stream_session.ts";

/**
 * Longest agent output still read as a bare CLI refusal. A real run that
 * merely *mentions* the phrase produces far more text than the refusal line.
 */
export const PROMPT_TOO_LONG_MAX_OUTPUT_CHARS = 500;

const PROMPT_TOO_LONG_PATTERN = /prompt is too long/i;

/** True when the agent's whole output is the CLI's `Prompt is too long` refusal. */
export function isPromptTooLongOutput(output: string | undefined): boolean {
  const trimmed = (output ?? "").trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > PROMPT_TOO_LONG_MAX_OUTPUT_CHARS) return false;
  return PROMPT_TOO_LONG_PATTERN.test(trimmed);
}

/** What the execute phase does with one attempt's output. */
export type PromptTooLongDecision = "none" | "retry" | "fail";

/**
 * Decide the response to an attempt's output:
 * - `none` — not a `Prompt is too long` refusal; the attempt stands.
 * - `retry` — refused on a resumed session not yet retried: discard it and
 *   retry once on a fresh session, uncounted.
 * - `fail` — refused on a fresh session (or after the retry): a real failure.
 */
export function decidePromptTooLong(input: {
  output: string | undefined;
  /** Session the attempt resumed; absent when it started a fresh one. */
  resumedSessionId?: string;
  alreadyRetried: boolean;
}): PromptTooLongDecision {
  if (!isPromptTooLongOutput(input.output)) return "none";
  if (input.resumedSessionId && !input.alreadyRetried) return "retry";
  return "fail";
}

/**
 * The session id an attempt is about to resume, or `undefined` when it will
 * start a fresh session. Read *before* the attempt: a completed attempt
 * advances the phase count, so afterwards every session looks resumed.
 */
export function resumedSessionIdOf(
  state: SessionResumeState | undefined,
): string | undefined {
  if (!state || state.phaseCount <= 0) return undefined;
  return state.sessionId;
}

/** Failure reason for a refusal the fresh-session retry did not clear. */
export function buildPromptTooLongReason(output?: string): string {
  const snippet = (output ?? "").trim().slice(
    0,
    PROMPT_TOO_LONG_MAX_OUTPUT_CHARS,
  );
  return `${PROMPT_TOO_LONG_MARKER} — the issue's context does not fit the ` +
    "model even on a fresh session, so trim or split the issue (Issue #2682)." +
    (snippet ? `\n\nAgent output: ${snippet}` : "");
}

/**
 * Discard a resumed session the worker must not resume again: its stream slot
 * (when the run joined a stream) and the issue's persisted resume pointer.
 * Logs one line naming the discarded session and the fresh-session retry, and
 * returns the fresh session state to retry on.
 */
export async function discardResumedSession(input: {
  workDir: string;
  repo: string;
  issueNumber: number;
  sessionId: string;
  streamSession?: JoinedStream;
  providerId?: string;
  logger: StreamSessionLogger;
  /** Why the session is discarded, for the log line. */
  reason: string;
}): Promise<SessionResumeState> {
  const providerId = input.providerId ?? input.streamSession?.providerId;
  if (input.streamSession) {
    await deleteStreamSession(
      input.workDir,
      input.streamSession.stream,
      providerId,
    );
  }
  await deleteResumeState(input.workDir, input.repo, input.issueNumber);
  // The delete helpers never throw, so confirm the removal before claiming it.
  await assertSessionDiscarded(input, providerId);
  const fresh = createSessionResumeState();
  input.logger.warn(
    `Discarded resumed session ${input.sessionId} (${input.reason}); ` +
      `retrying once on fresh session ${fresh.sessionId} — not counted ` +
      "towards the failure budget",
    {
      repo: input.repo,
      issueNumber: input.issueNumber,
      discardedSessionId: input.sessionId,
      freshSessionId: fresh.sessionId,
    },
  );
  return fresh;
}

/** Throws when the discarded session could still be resumed by a later run. */
async function assertSessionDiscarded(
  input: {
    workDir: string;
    repo: string;
    issueNumber: number;
    sessionId: string;
    streamSession?: JoinedStream;
  },
  providerId: string | undefined,
): Promise<void> {
  const leftovers: string[] = [];
  const pointer = resumeStatePath(input.workDir, input.repo, input.issueNumber);
  if (await pathExists(pointer)) leftovers.push(pointer);
  if (input.streamSession && providerId !== undefined) {
    const { stream } = input.streamSession;
    const slot = await lookupStreamSession(input.workDir, stream, providerId);
    if (slot.status === "usable") {
      leftovers.push(
        `${providerId} slot in ${streamSessionPath(input.workDir, stream)}`,
      );
    }
  }
  if (leftovers.length > 0) {
    throw new Error(
      `Could not discard session ${input.sessionId}: ${leftovers.join(", ")} ` +
        "still present",
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
