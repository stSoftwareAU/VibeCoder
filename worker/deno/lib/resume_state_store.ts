/**
 * Durable resume-state store (Issue #4170).
 *
 * A killed session used to restart from zero: the Claude conversation
 * lived in the container VM and the uncommitted diff lasted only until
 * the next attempt's repo reset. With `CLAUDE_CONFIG_DIR` on the durable
 * work dir (#4171/#4203) the conversation transcript now survives — this
 * store adds the pointer that lets the *next* attempt find it.
 *
 * The store keeps **two** records side by side, because the two things it
 * remembers have different owners and different lifetimes (Issue #2332):
 *
 * - the **per-issue checkpoint**, at
 *   `${workDir}/.claude-sessions/resume/<owner>-<repo>-<issue>.json` — phase
 *   count and the issue branch, plus the session id an older host wrote there;
 * - the **stream session**, at
 *   `${workDir}/.claude-sessions/resume/stream-<streamKey>.json` — the session
 *   id of the (repository, stream) conversation, one per provider.
 *
 * Per-issue lifecycle:
 *  - written by the execute phase's WIP checkpoints and at each phase
 *    completion;
 *  - read on re-claim — fresh (< 24 h) state primes `--resume` and lets
 *    the setup phase pick up the checkpointed branch instead of resetting;
 *  - deleted on successful PR creation and on claim release, so a
 *    gracefully finished or failed attempt starts the next one clean.
 *
 * Stream lifecycle: the conversation outlives every issue that runs on it, so
 * a stream session has **no freshness window**, is **not** deleted at PR
 * creation or claim release, and is never touched by the per-issue sweep.
 * Deleting one is the job of milestone-close housekeeping and of the reset
 * path when a session proves unresumable. There is no migration: a per-issue
 * record carrying a session id is read as before for that issue and is never
 * promoted, and a host with no stream record simply starts the stream fresh.
 *
 * The store lives under the dot-prefixed `.claude-sessions` directory,
 * which the stale-workdir scanner skips (stale_workdir.ts) and the
 * session sweeper's directory walk ignores (files are not session dirs).
 * Abandoned entries are swept opportunistically on save: any **per-issue**
 * sibling older than the freshness window is deleted, so the directory stays
 * a handful of tiny JSON files.
 *
 * Every operation is best-effort — resume is an optimisation, never
 * control flow, so a filesystem failure degrades to "no resume" rather
 * than failing the phase.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isPersistableSessionId } from "./session_resume.ts";
import { type StreamId, streamKey } from "./stream_identity.ts";
import { describesPreservedWip } from "./wip_markers.ts";

/**
 * Per-issue resume state older than this is stale — the next attempt starts
 * clean. A stream session has no such window (Issue #2332).
 */
export const RESUME_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** File-name prefix marking a stream record — never a per-issue record. */
const STREAM_FILE_PREFIX = "stream-";

/**
 * A per-issue record's file name: `<repo-slug>-<issue>.json`, where the slug
 * is `[A-Za-z0-9-]` only. The sweep considers nothing else, so it is blind to
 * stream files twice over: they carry {@link STREAM_FILE_PREFIX}, which it
 * skips outright, and their key carries the `__` segment separator, which this
 * pattern excludes (Issue #2332).
 */
const PER_ISSUE_FILE_PATTERN = /^[A-Za-z0-9-]+-\d+\.json$/u;

/**
 * Prompt paragraph appended to the execute prompt when a re-claim resumed
 * a checkpointed branch, so the agent continues the prior work instead of
 * re-deriving it from scratch.
 */
export const PRIOR_PROGRESS_PROMPT_NOTE =
  "\n\n## Prior progress exists on this branch\n\n" +
  "An earlier session working this issue was interrupted; its progress " +
  "was checkpointed as WIP commits on the current branch. Review what " +
  "already exists (`git log`, `git diff` against the base branch) and " +
  "continue from it — do not start again from scratch, and do not revert " +
  "the checkpointed work unless it is wrong.";

/** What survives a process/container/host death, per issue. */
export interface PersistedResumeState {
  /**
   * CLI session id, when session resume was active. Absent when the
   * attempt ran without CLI session continuity — the branch checkpoint is
   * still worth resuming. Codex stores its thread id here too (Issue #1699);
   * {@link providerId} says which vendor named it.
   */
  sessionId?: string;
  /** Phases completed in the persisted session. */
  phaseCount: number;
  /** The issue branch the checkpointed work lives on. */
  branch: string;
  /** Epoch milliseconds of the last save, for the freshness window. */
  savedAtEpochMs: number;
  /** Provider that owns {@link sessionId} (Issue #1699). */
  providerId?: string;
  /** Credential label that opened the session (Issue #1699). */
  credentialScope?: string;
}

/** Directory holding all resume-state files. */
export function resumeStateDir(workDir: string): string {
  return `${workDir}/.claude-sessions/resume`;
}

/** Path of one issue's resume-state file. */
export function resumeStatePath(
  workDir: string,
  repo: string,
  issueNumber: number,
): string {
  const slug = repo.replace(/[^a-zA-Z0-9]/g, "-");
  return `${resumeStateDir(workDir)}/${slug}-${issueNumber}.json`;
}

/**
 * Persist resume state for an issue. Best-effort: returns false (and
 * writes nothing) on any filesystem failure. Also sweeps abandoned
 * sibling entries older than the freshness window.
 */
export async function saveResumeState(
  workDir: string,
  repo: string,
  issueNumber: number,
  state: {
    sessionId?: string;
    phaseCount: number;
    branch: string;
    providerId?: string;
    credentialScope?: string;
  },
  nowEpochMs: number = Date.now(),
): Promise<boolean> {
  const persisted: PersistedResumeState = {
    ...(state.sessionId !== undefined ? { sessionId: state.sessionId } : {}),
    phaseCount: state.phaseCount,
    branch: state.branch,
    savedAtEpochMs: nowEpochMs,
    ...(state.providerId !== undefined ? { providerId: state.providerId } : {}),
    ...(state.credentialScope !== undefined
      ? { credentialScope: state.credentialScope }
      : {}),
  };
  const dir = resumeStateDir(workDir);
  try {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      resumeStatePath(workDir, repo, issueNumber),
      JSON.stringify(persisted, null, 2) + "\n",
    );
  } catch {
    return false;
  }
  await sweepStaleSiblings(dir, nowEpochMs);
  return true;
}

/**
 * Load an issue's resume state. Returns null — deleting the file where
 * appropriate — when it is missing, unparseable, malformed, or older
 * than {@link RESUME_STATE_MAX_AGE_MS}.
 */
export async function loadResumeState(
  workDir: string,
  repo: string,
  issueNumber: number,
  nowEpochMs: number = Date.now(),
): Promise<PersistedResumeState | null> {
  const path = resumeStatePath(workDir, repo, issueNumber);
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    return null;
  }
  const parsed = parsePersisted(raw);
  if (
    parsed === null ||
    nowEpochMs - parsed.savedAtEpochMs > RESUME_STATE_MAX_AGE_MS
  ) {
    await Deno.remove(path).catch(() => undefined);
    return null;
  }
  return parsed;
}

/**
 * Does the resume state survive this claim release? (Issue #148)
 *
 * A released claim normally ends the attempt deliberately, so the pointer
 * is deleted and the next attempt starts clean (#4170). The exception is a
 * run whose work was preserved as a WIP commit on the issue branch: the
 * commit is the durable artifact, and this pointer is what lets the next
 * claim find it (branch checkout plus `--resume`). Deleting it in the same
 * breath as writing it made preservation resumable in name only.
 *
 * A PR deferred by GitHub's secondary rate limit (Issue #1951) is the second
 * such release: the work is finished and pushed, and the PR is parked for the
 * next cycle's drain. Should that drain never raise it — a record lost with
 * the host, a repo off the roster — the next claim of the issue is the
 * fallback, and this pointer is what lets it resume the branch instead of
 * starting the work again.
 */
export function resumeStateSurvivesRelease(
  outcome: { kind: string; message?: string } | undefined,
): boolean {
  if (outcome?.kind === "pr_deferred") return true;
  return outcome?.kind === "no_pr" && describesPreservedWip(outcome.message);
}

/** Remove an issue's resume state. Idempotent, never throws. */
export async function deleteResumeState(
  workDir: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  await Deno.remove(resumeStatePath(workDir, repo, issueNumber)).catch(
    () => undefined,
  );
}

/**
 * One provider's session on a stream (Issue #2332).
 *
 * `holderHost` records which fleet host opened it — the transcript itself is
 * host-local, so a reader on another host knows the id it found is not its own
 * to replay.
 */
export interface PersistedStreamSession {
  /** CLI session id (Codex stores its thread id here too). */
  sessionId: string;
  /** Epoch milliseconds of the last save. Diagnostic — never an expiry. */
  savedAtEpochMs: number;
  /** Credential label that opened the session. */
  credentialScope?: string;
  /** Fleet host that owns the durable transcript. */
  holderHost?: string;
  /**
   * Provider whose CLI created the session (Issue #2638). A session is bound
   * to its creator — its model ids, its thinking blocks and its size budget
   * are that provider's — so it is never resumed by another. Absent on
   * records written before this field existed; a reader treats those as the
   * configured preferred provider's.
   */
  providerId?: string;
}

/** Path of one stream's session record. Throws when `stream.repo` is not `owner/name`. */
export function streamSessionPath(workDir: string, stream: StreamId): string {
  return `${resumeStateDir(workDir)}/${STREAM_FILE_PREFIX}${
    streamKey(stream)
  }.json`;
}

/**
 * Persist one provider's session for a stream, leaving every other provider's
 * session in the record untouched — a sub-issue that ran under a fallback
 * provider starts that provider's own stream session rather than overwriting
 * the primary's.
 *
 * Best-effort: returns false (and writes nothing) on any filesystem failure —
 * including a record that exists but cannot be read, because merging into an
 * empty map there would destroy the other providers' sessions rather than
 * merely miss a resume. Throws only when `stream.repo` is malformed, which is
 * a caller bug, not a resume miss.
 */
export async function saveStreamSession(
  workDir: string,
  stream: StreamId,
  session: {
    providerId: string;
    sessionId: string;
    credentialScope?: string;
    holderHost?: string;
  },
  nowEpochMs: number = Date.now(),
): Promise<boolean> {
  const path = streamSessionPath(workDir, stream);
  const sessions = await readStreamSessions(path);
  if (sessions === null) return false;
  sessions[session.providerId] = {
    sessionId: session.sessionId,
    savedAtEpochMs: nowEpochMs,
    providerId: session.providerId,
    ...(session.credentialScope !== undefined
      ? { credentialScope: session.credentialScope }
      : {}),
    ...(session.holderHost !== undefined
      ? { holderHost: session.holderHost }
      : {}),
  };
  return await writeStreamSessions(workDir, path, sessions);
}

/**
 * What a stream record holds for one provider (Issue #2333).
 *
 * `loadStreamSession` collapses "this stream has no session of mine yet" and
 * "the session it names is one my CLI would refuse" into a single null, and
 * those two call for opposite things: the first starts the provider's session
 * beside its siblings, the second resets a stream that is recorded but dead.
 */
export type StreamSessionLookup =
  /** No record, or none naming this provider — the provider starts the stream. */
  | { status: "none" }
  /** A session this provider may resume. */
  | { status: "usable"; session: PersistedStreamSession }
  /** A session recorded for this provider that its CLI would refuse (#204). */
  | { status: "unusable"; sessionId: string; reason: string }
  /**
   * A session in this provider's slot that another provider created
   * (Issue #2638). Never resumed and never deleted: it is not this
   * provider's to replay, and the slot is overwritten by the session this
   * provider opens instead.
   */
  | { status: "foreign"; sessionId: string; createdBy: string };

/** How {@link lookupStreamSession} reads a record. */
export interface StreamSessionLookupOptions {
  /**
   * The provider a record with no recorded creator is presumed to belong to
   * (Issue #2638) — the configured preferred provider. Omitted, such a
   * record is presumed to belong to the provider whose slot holds it.
   */
  legacyProviderId?: string;
}

/**
 * Look up one provider's session on a stream, saying which of the four
 * states above the record is in. Throws when `stream.repo` is malformed.
 *
 * There is deliberately no clock parameter: a stream session never expires.
 */
export async function lookupStreamSession(
  workDir: string,
  stream: StreamId,
  providerId: string,
  options: StreamSessionLookupOptions = {},
): Promise<StreamSessionLookup> {
  const sessions = await readStreamSessions(
    streamSessionPath(workDir, stream),
  );
  const session = sessions?.[providerId];
  if (session === undefined) return { status: "none" };
  const createdBy = session.providerId ?? options.legacyProviderId ??
    providerId;
  if (createdBy !== providerId) {
    return { status: "foreign", sessionId: session.sessionId, createdBy };
  }
  if (!isPersistableSessionId(session.sessionId, providerId)) {
    return {
      status: "unusable",
      sessionId: session.sessionId,
      reason:
        `the recorded session id is not one the ${providerId} CLI would accept`,
    };
  }
  return { status: "usable", session };
}

/**
 * Load one provider's session for a stream. Returns null when the record is
 * missing, unreadable, unparseable, holds no session for that provider, or
 * holds an id the provider's CLI would refuse (#204) or a session another
 * provider created (#2638). Throws when
 * `stream.repo` is malformed.
 *
 * There is deliberately no clock parameter: a stream session never expires.
 */
export async function loadStreamSession(
  workDir: string,
  stream: StreamId,
  providerId: string,
  options: StreamSessionLookupOptions = {},
): Promise<PersistedStreamSession | null> {
  const lookup = await lookupStreamSession(
    workDir,
    stream,
    providerId,
    options,
  );
  return lookup.status === "usable" ? lookup.session : null;
}

/**
 * Remove a stream's session — one provider's when `providerId` is given, the
 * whole record otherwise. Idempotent for a missing record; throws only when
 * `stream.repo` is malformed.
 *
 * For milestone-close housekeeping (the whole record) and for the reset path
 * when one provider's session proves unresumable; those callers land with the
 * rest of this milestone.
 *
 * When a single-provider delete cannot read the record it removes the whole
 * file: the caller's contract is that the named session is gone afterwards,
 * and losing a sibling entry only costs the stream a fresh start, whereas
 * leaving an unresumable session behind is the fault this call exists to
 * clear.
 */
export async function deleteStreamSession(
  workDir: string,
  stream: StreamId,
  providerId?: string,
): Promise<void> {
  const path = streamSessionPath(workDir, stream);
  if (providerId === undefined) {
    await Deno.remove(path).catch(() => undefined);
    return;
  }
  const sessions = await readStreamSessions(path);
  if (sessions === null) {
    // Unreadable — drop the whole record rather than leave the named
    // session behind.
    await Deno.remove(path).catch(() => undefined);
    return;
  }
  if (sessions[providerId] === undefined) return;
  delete sessions[providerId];
  if (Object.keys(sessions).length === 0) {
    await Deno.remove(path).catch(() => undefined);
    return;
  }
  await writeStreamSessions(workDir, path, sessions);
}

/**
 * Read a stream record.
 *
 * An absent file and a corrupt one both read as an empty map — there is
 * nothing to preserve in either. A file that exists but cannot be read
 * (permissions, I/O) reads as `null`, so a caller merging into the result
 * aborts instead of writing a record that silently drops every provider it
 * could not see.
 */
async function readStreamSessions(
  path: string,
): Promise<Record<string, PersistedStreamSession> | null> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? {} : null;
  }
  return parseStreamSessions(raw);
}

/**
 * Write a stream record through a temporary file and a rename, so a crash
 * mid-write leaves the previous record rather than a truncated one — the
 * record has no expiry and no sweep, so a truncation would be permanent.
 * Best-effort: false on any filesystem failure.
 */
async function writeStreamSessions(
  workDir: string,
  path: string,
  sessions: Record<string, PersistedStreamSession>,
): Promise<boolean> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.mkdir(resumeStateDir(workDir), { recursive: true });
    await Deno.writeTextFile(
      temporary,
      JSON.stringify({ sessions }, null, 2) + "\n",
    );
    await Deno.rename(temporary, path);
    return true;
  } catch {
    await Deno.remove(temporary).catch(() => undefined);
    return false;
  }
}

/** Parse a stream record, keeping only well-formed per-provider entries. */
function parseStreamSessions(
  raw: string,
): Record<string, PersistedStreamSession> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null) return {};
  const sessions = (value as Record<string, unknown>).sessions;
  if (typeof sessions !== "object" || sessions === null) return {};
  const parsed: Record<string, PersistedStreamSession> = {};
  for (const [providerId, entry] of Object.entries(sessions)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.sessionId !== "string" || record.sessionId.length === 0 ||
      typeof record.savedAtEpochMs !== "number"
    ) {
      continue;
    }
    parsed[providerId] = {
      sessionId: record.sessionId,
      savedAtEpochMs: record.savedAtEpochMs,
      ...(typeof record.credentialScope === "string"
        ? { credentialScope: record.credentialScope }
        : {}),
      ...(typeof record.holderHost === "string"
        ? { holderHost: record.holderHost }
        : {}),
      ...(typeof record.providerId === "string" && record.providerId !== ""
        ? { providerId: record.providerId }
        : {}),
    };
  }
  return parsed;
}

/** Parse and validate a persisted file's contents. */
function parsePersisted(raw: string): PersistedResumeState | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.phaseCount !== "number" ||
    typeof record.branch !== "string" || record.branch.length === 0 ||
    typeof record.savedAtEpochMs !== "number"
  ) {
    return null;
  }
  if (record.sessionId !== undefined && typeof record.sessionId !== "string") {
    return null;
  }
  if (
    record.providerId !== undefined && typeof record.providerId !== "string"
  ) {
    return null;
  }
  if (
    record.credentialScope !== undefined &&
    typeof record.credentialScope !== "string"
  ) {
    return null;
  }
  const providerId = typeof record.providerId === "string"
    ? record.providerId
    : undefined;
  // An id written before the UUID fix (Issue #204) is stale for Claude: the
  // CLI refuses it outright. Codex thread ids are not UUIDs-or-bust
  // (Issue #1699), so they persist when the record names Codex.
  const sessionId = typeof record.sessionId === "string" &&
      isPersistableSessionId(record.sessionId, providerId)
    ? record.sessionId
    : undefined;
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    phaseCount: record.phaseCount,
    branch: record.branch,
    savedAtEpochMs: record.savedAtEpochMs,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(typeof record.credentialScope === "string"
      ? { credentialScope: record.credentialScope }
      : {}),
  };
}

/**
 * Delete sibling **per-issue** entries whose recorded save time is outside
 * the freshness window (or that no longer parse). Keeps the directory from
 * accumulating files for issues that were never re-claimed.
 *
 * Only files matching the per-issue name shape are considered, so a stream
 * record — which never expires — is never swept (Issue #2332).
 */
async function sweepStaleSiblings(
  dir: string,
  nowEpochMs: number,
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (
        !entry.isFile ||
        entry.name.startsWith(STREAM_FILE_PREFIX) ||
        !PER_ISSUE_FILE_PATTERN.test(entry.name)
      ) {
        continue;
      }
      const path = `${dir}/${entry.name}`;
      try {
        const parsed = parsePersisted(await Deno.readTextFile(path));
        if (
          parsed === null ||
          nowEpochMs - parsed.savedAtEpochMs > RESUME_STATE_MAX_AGE_MS
        ) {
          await Deno.remove(path).catch(() => undefined);
        }
      } catch {
        // Unreadable entry — leave it for the next sweep.
      }
    }
  } catch {
    // Directory vanished mid-sweep — nothing to do.
  }
}
