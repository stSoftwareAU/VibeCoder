/**
 * Joining a run to its stream's conversation (Issue #2333).
 *
 * A **stream** owns one agent conversation per provider (`stream_identity.ts`,
 * #2331) and the id of that conversation lives in the stream record
 * (`resume_state_store.ts`, #2332). This module is the seam between them: it
 * says **which run kinds join a stream at all**, and it turns a stream record
 * into the {@link SessionResumeState} the CLI flags are built from.
 *
 * ## Only implementation and planning join
 *
 * Every other run kind keeps the per-issue session it has today and never
 * reads or writes a stream record. {@link STREAM_JOIN_POLICY} is that
 * decision, in one table — a run kind added later cannot compile until it
 * states which side it is on, so nothing joins a stream by omission.
 *
 * ## Three outcomes, one of them never fatal
 *
 * - `new` — the stream has no session for this provider; the run opens one and
 *   becomes the holder. The first issue of a stream, and a fallback provider's
 *   first issue on a stream the primary already runs.
 * - `resumed` — the stream's session id is replayed, so the run continues the
 *   conversation the previous issue left.
 * - `reset` — the record names a session this provider cannot resume. The dead
 *   entry is dropped, a fresh session opens in its place, and the reason is
 *   logged. A stream that cannot be resumed is a lost conversation, never a
 *   failed issue: resume is an optimisation, never control flow.
 *
 * A milestone stream is only ever joined by the issues that carry that
 * milestone, so a freshly planned milestone starts at its first sub-issue with
 * no record and logs `new` — the planning run's own (blank) stream is not
 * forked into it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  DEFAULT_AGENT_PROVIDER_ID,
  repoPinnedAgentProvider,
  resolveAgentProviderId,
} from "./agent_provider.ts";
import { escalationHostId } from "./host_escalation.ts";
import type { RepoConfig } from "../types.ts";
import {
  deleteStreamSession,
  lookupStreamSession,
  saveStreamSession,
} from "./resume_state_store.ts";
import {
  createSessionResumeState,
  isPersistableSessionId,
  sessionResumeForProvider,
  type SessionResumeState,
} from "./session_resume.ts";
import {
  resolveStreamId,
  type StreamId,
  streamLabel,
} from "./stream_identity.ts";
import { IDLE_TASK_LABEL } from "./idle_task_issue.ts";

/** The kinds of run the worker dispatches an agent for. */
export type StreamRunKind =
  | "implementation"
  | "planning"
  | "idle-task"
  | "grill-me"
  | "question"
  | "pr-feedback"
  | "ci-fix";

/**
 * Which run kinds join their stream's conversation.
 *
 * Exhaustive by type: adding a member to {@link StreamRunKind} without an
 * entry here is a compile error, so a new run kind never joins a stream — or
 * stays out of one — by accident.
 */
export const STREAM_JOIN_POLICY: Readonly<Record<StreamRunKind, boolean>> = {
  implementation: true,
  planning: true,
  // Per-issue by design: a sweep, a clarification round, a question, and the
  // two pull-request routes are each one self-contained conversation, and
  // folding them into the stream would pollute the context every sub-issue of
  // that milestone inherits.
  "idle-task": false,
  "grill-me": false,
  question: false,
  "pr-feedback": false,
  "ci-fix": false,
};

/** The run kinds that keep a per-issue session — the readable exclusion list. */
export const PER_ISSUE_RUN_KINDS: readonly StreamRunKind[] = Object.freeze(
  (Object.keys(STREAM_JOIN_POLICY) as StreamRunKind[]).filter(
    (kind) => !STREAM_JOIN_POLICY[kind],
  ),
);

/** Does this run kind join its stream's conversation? */
export function joinsStream(runKind: StreamRunKind): boolean {
  return STREAM_JOIN_POLICY[runKind] === true;
}

/**
 * The run kind of a claim-scan run, from the labels on its issue.
 *
 * That scan serves the implementation workflow plus the idle-task wrapper
 * route inside `processIssue` — the same two the callback `mode` resolver
 * reads (`callback_run_mode.ts`). The label routes never reach here.
 */
export function resolveStreamRunKind(
  issueLabels: readonly string[],
): StreamRunKind {
  const applied = issueLabels.map((label) => label.trim().toLowerCase());
  return applied.includes(IDLE_TASK_LABEL) ? "idle-task" : "implementation";
}

/**
 * The provider a run is about to spawn, as best it can be known *before* the
 * spawn — the repository's pin, else the configured/active provider.
 *
 * Resolution throws on an unsupported id or a provider the running image did
 * not install (#3234); here that is not worth failing an issue over, so it
 * degrades to the default. Picking the wrong provider costs a resume and
 * nothing else: `sessionResumeForProvider` drops a session id that does not
 * belong to the provider that actually ran, and the record written after the
 * run always names the provider that really served it.
 */
export function anticipatedProviderId(
  repoConfig?: RepoConfig,
): string {
  try {
    return repoPinnedAgentProvider(repoConfig) ?? resolveAgentProviderId();
  } catch {
    return DEFAULT_AGENT_PROVIDER_ID;
  }
}

/** What joining a stream did to the run's session. */
export type StreamSessionOutcome = "resumed" | "new" | "reset";

/** The session a run adopted from its stream, and how it came by it. */
export interface StreamSessionAdoption {
  /** The stream whose conversation this run joined. */
  stream: StreamId;
  /** Session state to hand the CLI — `resumed` states emit `--resume`. */
  state: SessionResumeState;
  outcome: StreamSessionOutcome;
  /** Why the stream was reset. Present only when `outcome` is `reset`. */
  resetReason?: string;
}

/** Options shared by {@link adoptStreamSession} and {@link primeStreamSession}. */
export interface StreamSessionOptions {
  /** Durable work directory holding the resume store. */
  workDir: string;
  /** Repository as `owner/name`. */
  repo: string;
  /** Milestone title of the issue, absent for the repository's blank stream. */
  milestoneTitle?: string;
  /** Provider whose conversation is being joined. */
  providerId: string;
  /** What kind of run this is — a non-joining kind touches no record. */
  runKind: StreamRunKind;
}

/**
 * Join this run to its stream's conversation, or start that conversation.
 *
 * Returns `undefined` — reading and writing nothing — for a run kind that
 * keeps a per-issue session. Throws only when `repo` is not `owner/name`,
 * which is a caller bug; {@link primeStreamSession} is the phase-facing
 * wrapper that degrades instead.
 */
export async function adoptStreamSession(
  options: StreamSessionOptions,
): Promise<StreamSessionAdoption | undefined> {
  const { workDir, repo, milestoneTitle, providerId, runKind } = options;
  if (!joinsStream(runKind)) return undefined;

  const stream = resolveStreamId(repo, milestoneTitle);
  const lookup = await lookupStreamSession(workDir, stream, providerId);

  if (lookup.status === "usable") {
    // phaseCount 1 is what makes `buildSessionResumeFlags` emit `--resume`:
    // the conversation exists, this run is continuing it rather than opening
    // it under a `--session-id` the CLI already knows.
    const candidate: SessionResumeState = {
      sessionId: lookup.session.sessionId,
      phaseCount: 1,
      providerId,
      ...(lookup.session.credentialScope !== undefined
        ? { credentialScope: lookup.session.credentialScope }
        : {}),
    };
    const resumable = sessionResumeForProvider(candidate, providerId);
    if (resumable) return { stream, state: resumable, outcome: "resumed" };
    return await resetStream(
      workDir,
      stream,
      providerId,
      `the recorded session does not belong to ${providerId}`,
    );
  }

  if (lookup.status === "unusable") {
    return await resetStream(workDir, stream, providerId, lookup.reason);
  }

  return { stream, state: createSessionResumeState(), outcome: "new" };
}

/** Drop the dead entry and open a fresh session in its place. */
async function resetStream(
  workDir: string,
  stream: StreamId,
  providerId: string,
  reason: string,
): Promise<StreamSessionAdoption> {
  await deleteStreamSession(workDir, stream, providerId);
  return {
    stream,
    state: createSessionResumeState(),
    outcome: "reset",
    resetReason: reason,
  };
}

/** The one line a run logs about its stream. */
export function describeStreamSession(
  adoption: StreamSessionAdoption,
): string {
  return `stream ${streamLabel(adoption.stream)} session ` +
    `${adoption.state.sessionId} (${adoption.outcome})`;
}

/** Minimal logger surface — the phases' logger satisfies it. */
export interface StreamSessionLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/**
 * {@link adoptStreamSession} for a phase: logs the one-line record, logs a
 * reset with its reason, and degrades to `undefined` on any fault rather than
 * failing the issue over a resume optimisation.
 */
export async function primeStreamSession(
  options: StreamSessionOptions & { logger: StreamSessionLogger },
): Promise<StreamSessionAdoption | undefined> {
  const { logger, ...rest } = options;
  let adoption: StreamSessionAdoption | undefined;
  try {
    adoption = await adoptStreamSession(rest);
  } catch (error) {
    logger.warn(
      "Could not join the stream conversation — this run uses a per-issue " +
        "session (Issue #2333)",
      {
        repo: rest.repo,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return undefined;
  }
  if (!adoption) return undefined;
  if (adoption.outcome === "reset") {
    logger.warn(`stream session reset: ${adoption.resetReason}`, {
      repo: rest.repo,
      stream: streamLabel(adoption.stream),
    });
  }
  logger.info(describeStreamSession(adoption), {
    repo: rest.repo,
    providerId: rest.providerId,
  });
  return adoption;
}

/**
 * Write the session this run ended up on back to the stream record, with this
 * host named as the holder of the durable transcript.
 *
 * Best-effort, like every other resume write: `false` on a filesystem failure
 * or an id this provider's CLI would refuse (#204) — recording one would hand
 * the stream's next issue a session that cannot be resumed.
 */
export async function recordStreamSession(options: {
  workDir: string;
  stream: StreamId;
  providerId: string;
  sessionId: string;
  credentialScope?: string;
  holderHost?: string;
}): Promise<boolean> {
  const { workDir, stream, providerId, sessionId } = options;
  if (!isPersistableSessionId(sessionId, providerId)) return false;
  return await saveStreamSession(workDir, stream, {
    providerId,
    sessionId,
    ...(options.credentialScope !== undefined
      ? { credentialScope: options.credentialScope }
      : {}),
    holderHost: options.holderHost ?? escalationHostId(),
  });
}
