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
 */ import { isPersistableSessionId } from "./session_resume.ts";
import { streamKey } from "./stream_identity.ts";
import { describesPreservedWip } from "./wip_markers.ts";
/**
 * Per-issue resume state older than this is stale — the next attempt starts
 * clean. A stream session has no such window (Issue #2332).
 */ export const RESUME_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** File-name prefix marking a stream record — never a per-issue record. */ const STREAM_FILE_PREFIX = "stream-";
/**
 * A per-issue record's file name: `<repo-slug>-<issue>.json`, where the slug
 * is `[A-Za-z0-9-]` only. The sweep considers nothing else, so it is blind to
 * stream files twice over: they carry {@link STREAM_FILE_PREFIX}, which it
 * skips outright, and their key carries the `__` segment separator, which this
 * pattern excludes (Issue #2332).
 */ const PER_ISSUE_FILE_PATTERN = /^[A-Za-z0-9-]+-\d+\.json$/u;
/**
 * Prompt paragraph appended to the execute prompt when a re-claim resumed
 * a checkpointed branch, so the agent continues the prior work instead of
 * re-deriving it from scratch.
 */ export const PRIOR_PROGRESS_PROMPT_NOTE = "\n\n## Prior progress exists on this branch\n\n" + "An earlier session working this issue was interrupted; its progress " + "was checkpointed as WIP commits on the current branch. Review what " + "already exists (`git log`, `git diff` against the base branch) and " + "continue from it — do not start again from scratch, and do not revert " + "the checkpointed work unless it is wrong.";
/** Directory holding all resume-state files. */ export function resumeStateDir(workDir) {
  return `${workDir}/.claude-sessions/resume`;
}
/** Path of one issue's resume-state file. */ export function resumeStatePath(workDir, repo, issueNumber) {
  const slug = repo.replace(/[^a-zA-Z0-9]/g, "-");
  return `${resumeStateDir(workDir)}/${slug}-${issueNumber}.json`;
}
/**
 * Persist resume state for an issue. Best-effort: returns false (and
 * writes nothing) on any filesystem failure. Also sweeps abandoned
 * sibling entries older than the freshness window.
 */ export async function saveResumeState(workDir, repo, issueNumber, state, nowEpochMs = Date.now()) {
  const persisted = {
    ...state.sessionId !== undefined ? {
      sessionId: state.sessionId
    } : {},
    phaseCount: state.phaseCount,
    branch: state.branch,
    savedAtEpochMs: nowEpochMs,
    ...state.providerId !== undefined ? {
      providerId: state.providerId
    } : {},
    ...state.credentialScope !== undefined ? {
      credentialScope: state.credentialScope
    } : {}
  };
  const dir = resumeStateDir(workDir);
  try {
    await Deno.mkdir(dir, {
      recursive: true
    });
    await Deno.writeTextFile(resumeStatePath(workDir, repo, issueNumber), JSON.stringify(persisted, null, 2) + "\n");
  } catch  {
    return false;
  }
  await sweepStaleSiblings(dir, nowEpochMs);
  return true;
}
/**
 * Load an issue's resume state. Returns null — deleting the file where
 * appropriate — when it is missing, unparseable, malformed, or older
 * than {@link RESUME_STATE_MAX_AGE_MS}.
 */ export async function loadResumeState(workDir, repo, issueNumber, nowEpochMs = Date.now()) {
  const path = resumeStatePath(workDir, repo, issueNumber);
  let raw;
  try {
    raw = await Deno.readTextFile(path);
  } catch  {
    return null;
  }
  const parsed = parsePersisted(raw);
  if (parsed === null || nowEpochMs - parsed.savedAtEpochMs > RESUME_STATE_MAX_AGE_MS) {
    await Deno.remove(path).catch(()=>undefined);
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
 */ export function resumeStateSurvivesRelease(outcome) {
  if (outcome?.kind === "pr_deferred") return true;
  return outcome?.kind === "no_pr" && describesPreservedWip(outcome.message);
}
/** Remove an issue's resume state. Idempotent, never throws. */ export async function deleteResumeState(workDir, repo, issueNumber) {
  await Deno.remove(resumeStatePath(workDir, repo, issueNumber)).catch(()=>undefined);
}
/** Path of one stream's session record. Throws when `stream.repo` is not `owner/name`. */ export function streamSessionPath(workDir, stream) {
  return `${resumeStateDir(workDir)}/${STREAM_FILE_PREFIX}${streamKey(stream)}.json`;
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
 */ export async function saveStreamSession(workDir, stream, session, nowEpochMs = Date.now()) {
  const path = streamSessionPath(workDir, stream);
  const sessions = await readStreamSessions(path);
  if (sessions === null) return false;
  sessions[session.providerId] = {
    sessionId: session.sessionId,
    savedAtEpochMs: nowEpochMs,
    providerId: session.providerId,
    ...session.credentialScope !== undefined ? {
      credentialScope: session.credentialScope
    } : {},
    ...session.holderHost !== undefined ? {
      holderHost: session.holderHost
    } : {}
  };
  return await writeStreamSessions(workDir, path, sessions);
}
/**
 * Look up one provider's session on a stream, saying which of the four
 * states above the record is in. Throws when `stream.repo` is malformed.
 *
 * There is deliberately no clock parameter: a stream session never expires.
 */ export async function lookupStreamSession(workDir, stream, providerId, options = {}) {
  const sessions = await readStreamSessions(streamSessionPath(workDir, stream));
  const session = sessions?.[providerId];
  if (session === undefined) return {
    status: "none"
  };
  const createdBy = session.providerId ?? options.legacyProviderId ?? providerId;
  if (createdBy !== providerId) {
    return {
      status: "foreign",
      sessionId: session.sessionId,
      createdBy
    };
  }
  if (!isPersistableSessionId(session.sessionId, providerId)) {
    return {
      status: "unusable",
      sessionId: session.sessionId,
      reason: `the recorded session id is not one the ${providerId} CLI would accept`
    };
  }
  return {
    status: "usable",
    session
  };
}
/**
 * Load one provider's session for a stream. Returns null when the record is
 * missing, unreadable, unparseable, holds no session for that provider, or
 * holds an id the provider's CLI would refuse (#204) or a session another
 * provider created (#2638). Throws when
 * `stream.repo` is malformed.
 *
 * There is deliberately no clock parameter: a stream session never expires.
 */ export async function loadStreamSession(workDir, stream, providerId, options = {}) {
  const lookup = await lookupStreamSession(workDir, stream, providerId, options);
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
 */ export async function deleteStreamSession(workDir, stream, providerId) {
  const path = streamSessionPath(workDir, stream);
  if (providerId === undefined) {
    await Deno.remove(path).catch(()=>undefined);
    return;
  }
  const sessions = await readStreamSessions(path);
  if (sessions === null) {
    // Unreadable — drop the whole record rather than leave the named
    // session behind.
    await Deno.remove(path).catch(()=>undefined);
    return;
  }
  if (sessions[providerId] === undefined) return;
  delete sessions[providerId];
  if (Object.keys(sessions).length === 0) {
    await Deno.remove(path).catch(()=>undefined);
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
 */ async function readStreamSessions(path) {
  let raw;
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
 */ async function writeStreamSessions(workDir, path, sessions) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.mkdir(resumeStateDir(workDir), {
      recursive: true
    });
    await Deno.writeTextFile(temporary, JSON.stringify({
      sessions
    }, null, 2) + "\n");
    await Deno.rename(temporary, path);
    return true;
  } catch  {
    await Deno.remove(temporary).catch(()=>undefined);
    return false;
  }
}
/** Parse a stream record, keeping only well-formed per-provider entries. */ function parseStreamSessions(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch  {
    return {};
  }
  if (typeof value !== "object" || value === null) return {};
  const sessions = value.sessions;
  if (typeof sessions !== "object" || sessions === null) return {};
  const parsed = {};
  for (const [providerId, entry] of Object.entries(sessions)){
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry;
    if (typeof record.sessionId !== "string" || record.sessionId.length === 0 || typeof record.savedAtEpochMs !== "number") {
      continue;
    }
    parsed[providerId] = {
      sessionId: record.sessionId,
      savedAtEpochMs: record.savedAtEpochMs,
      ...typeof record.credentialScope === "string" ? {
        credentialScope: record.credentialScope
      } : {},
      ...typeof record.holderHost === "string" ? {
        holderHost: record.holderHost
      } : {},
      ...typeof record.providerId === "string" && record.providerId !== "" ? {
        providerId: record.providerId
      } : {}
    };
  }
  return parsed;
}
/** Parse and validate a persisted file's contents. */ function parsePersisted(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch  {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value;
  if (typeof record.phaseCount !== "number" || typeof record.branch !== "string" || record.branch.length === 0 || typeof record.savedAtEpochMs !== "number") {
    return null;
  }
  if (record.sessionId !== undefined && typeof record.sessionId !== "string") {
    return null;
  }
  if (record.providerId !== undefined && typeof record.providerId !== "string") {
    return null;
  }
  if (record.credentialScope !== undefined && typeof record.credentialScope !== "string") {
    return null;
  }
  const providerId = typeof record.providerId === "string" ? record.providerId : undefined;
  // An id written before the UUID fix (Issue #204) is stale for Claude: the
  // CLI refuses it outright. Codex thread ids are not UUIDs-or-bust
  // (Issue #1699), so they persist when the record names Codex.
  const sessionId = typeof record.sessionId === "string" && isPersistableSessionId(record.sessionId, providerId) ? record.sessionId : undefined;
  return {
    ...sessionId !== undefined ? {
      sessionId
    } : {},
    phaseCount: record.phaseCount,
    branch: record.branch,
    savedAtEpochMs: record.savedAtEpochMs,
    ...providerId !== undefined ? {
      providerId
    } : {},
    ...typeof record.credentialScope === "string" ? {
      credentialScope: record.credentialScope
    } : {}
  };
}
/**
 * Delete sibling **per-issue** entries whose recorded save time is outside
 * the freshness window (or that no longer parse). Keeps the directory from
 * accumulating files for issues that were never re-claimed.
 *
 * Only files matching the per-issue name shape are considered, so a stream
 * record — which never expires — is never swept (Issue #2332).
 */ async function sweepStaleSiblings(dir, nowEpochMs) {
  try {
    for await (const entry of Deno.readDir(dir)){
      if (!entry.isFile || entry.name.startsWith(STREAM_FILE_PREFIX) || !PER_ISSUE_FILE_PATTERN.test(entry.name)) {
        continue;
      }
      const path = `${dir}/${entry.name}`;
      try {
        const parsed = parsePersisted(await Deno.readTextFile(path));
        if (parsed === null || nowEpochMs - parsed.savedAtEpochMs > RESUME_STATE_MAX_AGE_MS) {
          await Deno.remove(path).catch(()=>undefined);
        }
      } catch  {
      // Unreadable entry — leave it for the next sweep.
      }
    }
  } catch  {
  // Directory vanished mid-sweep — nothing to do.
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9yZXN1bWVfc3RhdGVfc3RvcmUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEdXJhYmxlIHJlc3VtZS1zdGF0ZSBzdG9yZSAoSXNzdWUgIzQxNzApLlxuICpcbiAqIEEga2lsbGVkIHNlc3Npb24gdXNlZCB0byByZXN0YXJ0IGZyb20gemVybzogdGhlIENsYXVkZSBjb252ZXJzYXRpb25cbiAqIGxpdmVkIGluIHRoZSBjb250YWluZXIgVk0gYW5kIHRoZSB1bmNvbW1pdHRlZCBkaWZmIGxhc3RlZCBvbmx5IHVudGlsXG4gKiB0aGUgbmV4dCBhdHRlbXB0J3MgcmVwbyByZXNldC4gV2l0aCBgQ0xBVURFX0NPTkZJR19ESVJgIG9uIHRoZSBkdXJhYmxlXG4gKiB3b3JrIGRpciAoIzQxNzEvIzQyMDMpIHRoZSBjb252ZXJzYXRpb24gdHJhbnNjcmlwdCBub3cgc3Vydml2ZXMg4oCUIHRoaXNcbiAqIHN0b3JlIGFkZHMgdGhlIHBvaW50ZXIgdGhhdCBsZXRzIHRoZSAqbmV4dCogYXR0ZW1wdCBmaW5kIGl0LlxuICpcbiAqIFRoZSBzdG9yZSBrZWVwcyAqKnR3byoqIHJlY29yZHMgc2lkZSBieSBzaWRlLCBiZWNhdXNlIHRoZSB0d28gdGhpbmdzIGl0XG4gKiByZW1lbWJlcnMgaGF2ZSBkaWZmZXJlbnQgb3duZXJzIGFuZCBkaWZmZXJlbnQgbGlmZXRpbWVzIChJc3N1ZSAjMjMzMik6XG4gKlxuICogLSB0aGUgKipwZXItaXNzdWUgY2hlY2twb2ludCoqLCBhdFxuICogICBgJHt3b3JrRGlyfS8uY2xhdWRlLXNlc3Npb25zL3Jlc3VtZS88b3duZXI+LTxyZXBvPi08aXNzdWU+Lmpzb25gIOKAlCBwaGFzZVxuICogICBjb3VudCBhbmQgdGhlIGlzc3VlIGJyYW5jaCwgcGx1cyB0aGUgc2Vzc2lvbiBpZCBhbiBvbGRlciBob3N0IHdyb3RlIHRoZXJlO1xuICogLSB0aGUgKipzdHJlYW0gc2Vzc2lvbioqLCBhdFxuICogICBgJHt3b3JrRGlyfS8uY2xhdWRlLXNlc3Npb25zL3Jlc3VtZS9zdHJlYW0tPHN0cmVhbUtleT4uanNvbmAg4oCUIHRoZSBzZXNzaW9uXG4gKiAgIGlkIG9mIHRoZSAocmVwb3NpdG9yeSwgc3RyZWFtKSBjb252ZXJzYXRpb24sIG9uZSBwZXIgcHJvdmlkZXIuXG4gKlxuICogUGVyLWlzc3VlIGxpZmVjeWNsZTpcbiAqICAtIHdyaXR0ZW4gYnkgdGhlIGV4ZWN1dGUgcGhhc2UncyBXSVAgY2hlY2twb2ludHMgYW5kIGF0IGVhY2ggcGhhc2VcbiAqICAgIGNvbXBsZXRpb247XG4gKiAgLSByZWFkIG9uIHJlLWNsYWltIOKAlCBmcmVzaCAoPCAyNCBoKSBzdGF0ZSBwcmltZXMgYC0tcmVzdW1lYCBhbmQgbGV0c1xuICogICAgdGhlIHNldHVwIHBoYXNlIHBpY2sgdXAgdGhlIGNoZWNrcG9pbnRlZCBicmFuY2ggaW5zdGVhZCBvZiByZXNldHRpbmc7XG4gKiAgLSBkZWxldGVkIG9uIHN1Y2Nlc3NmdWwgUFIgY3JlYXRpb24gYW5kIG9uIGNsYWltIHJlbGVhc2UsIHNvIGFcbiAqICAgIGdyYWNlZnVsbHkgZmluaXNoZWQgb3IgZmFpbGVkIGF0dGVtcHQgc3RhcnRzIHRoZSBuZXh0IG9uZSBjbGVhbi5cbiAqXG4gKiBTdHJlYW0gbGlmZWN5Y2xlOiB0aGUgY29udmVyc2F0aW9uIG91dGxpdmVzIGV2ZXJ5IGlzc3VlIHRoYXQgcnVucyBvbiBpdCwgc29cbiAqIGEgc3RyZWFtIHNlc3Npb24gaGFzICoqbm8gZnJlc2huZXNzIHdpbmRvdyoqLCBpcyAqKm5vdCoqIGRlbGV0ZWQgYXQgUFJcbiAqIGNyZWF0aW9uIG9yIGNsYWltIHJlbGVhc2UsIGFuZCBpcyBuZXZlciB0b3VjaGVkIGJ5IHRoZSBwZXItaXNzdWUgc3dlZXAuXG4gKiBEZWxldGluZyBvbmUgaXMgdGhlIGpvYiBvZiBtaWxlc3RvbmUtY2xvc2UgaG91c2VrZWVwaW5nIGFuZCBvZiB0aGUgcmVzZXRcbiAqIHBhdGggd2hlbiBhIHNlc3Npb24gcHJvdmVzIHVucmVzdW1hYmxlLiBUaGVyZSBpcyBubyBtaWdyYXRpb246IGEgcGVyLWlzc3VlXG4gKiByZWNvcmQgY2FycnlpbmcgYSBzZXNzaW9uIGlkIGlzIHJlYWQgYXMgYmVmb3JlIGZvciB0aGF0IGlzc3VlIGFuZCBpcyBuZXZlclxuICogcHJvbW90ZWQsIGFuZCBhIGhvc3Qgd2l0aCBubyBzdHJlYW0gcmVjb3JkIHNpbXBseSBzdGFydHMgdGhlIHN0cmVhbSBmcmVzaC5cbiAqXG4gKiBUaGUgc3RvcmUgbGl2ZXMgdW5kZXIgdGhlIGRvdC1wcmVmaXhlZCBgLmNsYXVkZS1zZXNzaW9uc2AgZGlyZWN0b3J5LFxuICogd2hpY2ggdGhlIHN0YWxlLXdvcmtkaXIgc2Nhbm5lciBza2lwcyAoc3RhbGVfd29ya2Rpci50cykgYW5kIHRoZVxuICogc2Vzc2lvbiBzd2VlcGVyJ3MgZGlyZWN0b3J5IHdhbGsgaWdub3JlcyAoZmlsZXMgYXJlIG5vdCBzZXNzaW9uIGRpcnMpLlxuICogQWJhbmRvbmVkIGVudHJpZXMgYXJlIHN3ZXB0IG9wcG9ydHVuaXN0aWNhbGx5IG9uIHNhdmU6IGFueSAqKnBlci1pc3N1ZSoqXG4gKiBzaWJsaW5nIG9sZGVyIHRoYW4gdGhlIGZyZXNobmVzcyB3aW5kb3cgaXMgZGVsZXRlZCwgc28gdGhlIGRpcmVjdG9yeSBzdGF5c1xuICogYSBoYW5kZnVsIG9mIHRpbnkgSlNPTiBmaWxlcy5cbiAqXG4gKiBFdmVyeSBvcGVyYXRpb24gaXMgYmVzdC1lZmZvcnQg4oCUIHJlc3VtZSBpcyBhbiBvcHRpbWlzYXRpb24sIG5ldmVyXG4gKiBjb250cm9sIGZsb3csIHNvIGEgZmlsZXN5c3RlbSBmYWlsdXJlIGRlZ3JhZGVzIHRvIFwibm8gcmVzdW1lXCIgcmF0aGVyXG4gKiB0aGFuIGZhaWxpbmcgdGhlIHBoYXNlLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IGlzUGVyc2lzdGFibGVTZXNzaW9uSWQgfSBmcm9tIFwiLi9zZXNzaW9uX3Jlc3VtZS50c1wiO1xuaW1wb3J0IHsgdHlwZSBTdHJlYW1JZCwgc3RyZWFtS2V5IH0gZnJvbSBcIi4vc3RyZWFtX2lkZW50aXR5LnRzXCI7XG5pbXBvcnQgeyBkZXNjcmliZXNQcmVzZXJ2ZWRXaXAgfSBmcm9tIFwiLi93aXBfbWFya2Vycy50c1wiO1xuXG4vKipcbiAqIFBlci1pc3N1ZSByZXN1bWUgc3RhdGUgb2xkZXIgdGhhbiB0aGlzIGlzIHN0YWxlIOKAlCB0aGUgbmV4dCBhdHRlbXB0IHN0YXJ0c1xuICogY2xlYW4uIEEgc3RyZWFtIHNlc3Npb24gaGFzIG5vIHN1Y2ggd2luZG93IChJc3N1ZSAjMjMzMikuXG4gKi9cbmV4cG9ydCBjb25zdCBSRVNVTUVfU1RBVEVfTUFYX0FHRV9NUyA9IDI0ICogNjAgKiA2MCAqIDEwMDA7XG5cbi8qKiBGaWxlLW5hbWUgcHJlZml4IG1hcmtpbmcgYSBzdHJlYW0gcmVjb3JkIOKAlCBuZXZlciBhIHBlci1pc3N1ZSByZWNvcmQuICovXG5jb25zdCBTVFJFQU1fRklMRV9QUkVGSVggPSBcInN0cmVhbS1cIjtcblxuLyoqXG4gKiBBIHBlci1pc3N1ZSByZWNvcmQncyBmaWxlIG5hbWU6IGA8cmVwby1zbHVnPi08aXNzdWU+Lmpzb25gLCB3aGVyZSB0aGUgc2x1Z1xuICogaXMgYFtBLVphLXowLTktXWAgb25seS4gVGhlIHN3ZWVwIGNvbnNpZGVycyBub3RoaW5nIGVsc2UsIHNvIGl0IGlzIGJsaW5kIHRvXG4gKiBzdHJlYW0gZmlsZXMgdHdpY2Ugb3ZlcjogdGhleSBjYXJyeSB7QGxpbmsgU1RSRUFNX0ZJTEVfUFJFRklYfSwgd2hpY2ggaXRcbiAqIHNraXBzIG91dHJpZ2h0LCBhbmQgdGhlaXIga2V5IGNhcnJpZXMgdGhlIGBfX2Agc2VnbWVudCBzZXBhcmF0b3IsIHdoaWNoIHRoaXNcbiAqIHBhdHRlcm4gZXhjbHVkZXMgKElzc3VlICMyMzMyKS5cbiAqL1xuY29uc3QgUEVSX0lTU1VFX0ZJTEVfUEFUVEVSTiA9IC9eW0EtWmEtejAtOS1dKy1cXGQrXFwuanNvbiQvdTtcblxuLyoqXG4gKiBQcm9tcHQgcGFyYWdyYXBoIGFwcGVuZGVkIHRvIHRoZSBleGVjdXRlIHByb21wdCB3aGVuIGEgcmUtY2xhaW0gcmVzdW1lZFxuICogYSBjaGVja3BvaW50ZWQgYnJhbmNoLCBzbyB0aGUgYWdlbnQgY29udGludWVzIHRoZSBwcmlvciB3b3JrIGluc3RlYWQgb2ZcbiAqIHJlLWRlcml2aW5nIGl0IGZyb20gc2NyYXRjaC5cbiAqL1xuZXhwb3J0IGNvbnN0IFBSSU9SX1BST0dSRVNTX1BST01QVF9OT1RFID1cbiAgXCJcXG5cXG4jIyBQcmlvciBwcm9ncmVzcyBleGlzdHMgb24gdGhpcyBicmFuY2hcXG5cXG5cIiArXG4gIFwiQW4gZWFybGllciBzZXNzaW9uIHdvcmtpbmcgdGhpcyBpc3N1ZSB3YXMgaW50ZXJydXB0ZWQ7IGl0cyBwcm9ncmVzcyBcIiArXG4gIFwid2FzIGNoZWNrcG9pbnRlZCBhcyBXSVAgY29tbWl0cyBvbiB0aGUgY3VycmVudCBicmFuY2guIFJldmlldyB3aGF0IFwiICtcbiAgXCJhbHJlYWR5IGV4aXN0cyAoYGdpdCBsb2dgLCBgZ2l0IGRpZmZgIGFnYWluc3QgdGhlIGJhc2UgYnJhbmNoKSBhbmQgXCIgK1xuICBcImNvbnRpbnVlIGZyb20gaXQg4oCUIGRvIG5vdCBzdGFydCBhZ2FpbiBmcm9tIHNjcmF0Y2gsIGFuZCBkbyBub3QgcmV2ZXJ0IFwiICtcbiAgXCJ0aGUgY2hlY2twb2ludGVkIHdvcmsgdW5sZXNzIGl0IGlzIHdyb25nLlwiO1xuXG4vKiogV2hhdCBzdXJ2aXZlcyBhIHByb2Nlc3MvY29udGFpbmVyL2hvc3QgZGVhdGgsIHBlciBpc3N1ZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUGVyc2lzdGVkUmVzdW1lU3RhdGUge1xuICAvKipcbiAgICogQ0xJIHNlc3Npb24gaWQsIHdoZW4gc2Vzc2lvbiByZXN1bWUgd2FzIGFjdGl2ZS4gQWJzZW50IHdoZW4gdGhlXG4gICAqIGF0dGVtcHQgcmFuIHdpdGhvdXQgQ0xJIHNlc3Npb24gY29udGludWl0eSDigJQgdGhlIGJyYW5jaCBjaGVja3BvaW50IGlzXG4gICAqIHN0aWxsIHdvcnRoIHJlc3VtaW5nLiBDb2RleCBzdG9yZXMgaXRzIHRocmVhZCBpZCBoZXJlIHRvbyAoSXNzdWUgIzE2OTkpO1xuICAgKiB7QGxpbmsgcHJvdmlkZXJJZH0gc2F5cyB3aGljaCB2ZW5kb3IgbmFtZWQgaXQuXG4gICAqL1xuICBzZXNzaW9uSWQ/OiBzdHJpbmc7XG4gIC8qKiBQaGFzZXMgY29tcGxldGVkIGluIHRoZSBwZXJzaXN0ZWQgc2Vzc2lvbi4gKi9cbiAgcGhhc2VDb3VudDogbnVtYmVyO1xuICAvKiogVGhlIGlzc3VlIGJyYW5jaCB0aGUgY2hlY2twb2ludGVkIHdvcmsgbGl2ZXMgb24uICovXG4gIGJyYW5jaDogc3RyaW5nO1xuICAvKiogRXBvY2ggbWlsbGlzZWNvbmRzIG9mIHRoZSBsYXN0IHNhdmUsIGZvciB0aGUgZnJlc2huZXNzIHdpbmRvdy4gKi9cbiAgc2F2ZWRBdEVwb2NoTXM6IG51bWJlcjtcbiAgLyoqIFByb3ZpZGVyIHRoYXQgb3ducyB7QGxpbmsgc2Vzc2lvbklkfSAoSXNzdWUgIzE2OTkpLiAqL1xuICBwcm92aWRlcklkPzogc3RyaW5nO1xuICAvKiogQ3JlZGVudGlhbCBsYWJlbCB0aGF0IG9wZW5lZCB0aGUgc2Vzc2lvbiAoSXNzdWUgIzE2OTkpLiAqL1xuICBjcmVkZW50aWFsU2NvcGU/OiBzdHJpbmc7XG59XG5cbi8qKiBEaXJlY3RvcnkgaG9sZGluZyBhbGwgcmVzdW1lLXN0YXRlIGZpbGVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc3VtZVN0YXRlRGlyKHdvcmtEaXI6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHt3b3JrRGlyfS8uY2xhdWRlLXNlc3Npb25zL3Jlc3VtZWA7XG59XG5cbi8qKiBQYXRoIG9mIG9uZSBpc3N1ZSdzIHJlc3VtZS1zdGF0ZSBmaWxlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc3VtZVN0YXRlUGF0aChcbiAgd29ya0Rpcjogc3RyaW5nLFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4pOiBzdHJpbmcge1xuICBjb25zdCBzbHVnID0gcmVwby5yZXBsYWNlKC9bXmEtekEtWjAtOV0vZywgXCItXCIpO1xuICByZXR1cm4gYCR7cmVzdW1lU3RhdGVEaXIod29ya0Rpcil9LyR7c2x1Z30tJHtpc3N1ZU51bWJlcn0uanNvbmA7XG59XG5cbi8qKlxuICogUGVyc2lzdCByZXN1bWUgc3RhdGUgZm9yIGFuIGlzc3VlLiBCZXN0LWVmZm9ydDogcmV0dXJucyBmYWxzZSAoYW5kXG4gKiB3cml0ZXMgbm90aGluZykgb24gYW55IGZpbGVzeXN0ZW0gZmFpbHVyZS4gQWxzbyBzd2VlcHMgYWJhbmRvbmVkXG4gKiBzaWJsaW5nIGVudHJpZXMgb2xkZXIgdGhhbiB0aGUgZnJlc2huZXNzIHdpbmRvdy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNhdmVSZXN1bWVTdGF0ZShcbiAgd29ya0Rpcjogc3RyaW5nLFxuICByZXBvOiBzdHJpbmcsXG4gIGlzc3VlTnVtYmVyOiBudW1iZXIsXG4gIHN0YXRlOiB7XG4gICAgc2Vzc2lvbklkPzogc3RyaW5nO1xuICAgIHBoYXNlQ291bnQ6IG51bWJlcjtcbiAgICBicmFuY2g6IHN0cmluZztcbiAgICBwcm92aWRlcklkPzogc3RyaW5nO1xuICAgIGNyZWRlbnRpYWxTY29wZT86IHN0cmluZztcbiAgfSxcbiAgbm93RXBvY2hNczogbnVtYmVyID0gRGF0ZS5ub3coKSxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBwZXJzaXN0ZWQ6IFBlcnNpc3RlZFJlc3VtZVN0YXRlID0ge1xuICAgIC4uLihzdGF0ZS5zZXNzaW9uSWQgIT09IHVuZGVmaW5lZCA/IHsgc2Vzc2lvbklkOiBzdGF0ZS5zZXNzaW9uSWQgfSA6IHt9KSxcbiAgICBwaGFzZUNvdW50OiBzdGF0ZS5waGFzZUNvdW50LFxuICAgIGJyYW5jaDogc3RhdGUuYnJhbmNoLFxuICAgIHNhdmVkQXRFcG9jaE1zOiBub3dFcG9jaE1zLFxuICAgIC4uLihzdGF0ZS5wcm92aWRlcklkICE9PSB1bmRlZmluZWQgPyB7IHByb3ZpZGVySWQ6IHN0YXRlLnByb3ZpZGVySWQgfSA6IHt9KSxcbiAgICAuLi4oc3RhdGUuY3JlZGVudGlhbFNjb3BlICE9PSB1bmRlZmluZWRcbiAgICAgID8geyBjcmVkZW50aWFsU2NvcGU6IHN0YXRlLmNyZWRlbnRpYWxTY29wZSB9XG4gICAgICA6IHt9KSxcbiAgfTtcbiAgY29uc3QgZGlyID0gcmVzdW1lU3RhdGVEaXIod29ya0Rpcik7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5ta2RpcihkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShcbiAgICAgIHJlc3VtZVN0YXRlUGF0aCh3b3JrRGlyLCByZXBvLCBpc3N1ZU51bWJlciksXG4gICAgICBKU09OLnN0cmluZ2lmeShwZXJzaXN0ZWQsIG51bGwsIDIpICsgXCJcXG5cIixcbiAgICApO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgYXdhaXQgc3dlZXBTdGFsZVNpYmxpbmdzKGRpciwgbm93RXBvY2hNcyk7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKipcbiAqIExvYWQgYW4gaXNzdWUncyByZXN1bWUgc3RhdGUuIFJldHVybnMgbnVsbCDigJQgZGVsZXRpbmcgdGhlIGZpbGUgd2hlcmVcbiAqIGFwcHJvcHJpYXRlIOKAlCB3aGVuIGl0IGlzIG1pc3NpbmcsIHVucGFyc2VhYmxlLCBtYWxmb3JtZWQsIG9yIG9sZGVyXG4gKiB0aGFuIHtAbGluayBSRVNVTUVfU1RBVEVfTUFYX0FHRV9NU30uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkUmVzdW1lU3RhdGUoXG4gIHdvcmtEaXI6IHN0cmluZyxcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuICBub3dFcG9jaE1zOiBudW1iZXIgPSBEYXRlLm5vdygpLFxuKTogUHJvbWlzZTxQZXJzaXN0ZWRSZXN1bWVTdGF0ZSB8IG51bGw+IHtcbiAgY29uc3QgcGF0aCA9IHJlc3VtZVN0YXRlUGF0aCh3b3JrRGlyLCByZXBvLCBpc3N1ZU51bWJlcik7XG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHtcbiAgICByYXcgPSBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShwYXRoKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgY29uc3QgcGFyc2VkID0gcGFyc2VQZXJzaXN0ZWQocmF3KTtcbiAgaWYgKFxuICAgIHBhcnNlZCA9PT0gbnVsbCB8fFxuICAgIG5vd0Vwb2NoTXMgLSBwYXJzZWQuc2F2ZWRBdEVwb2NoTXMgPiBSRVNVTUVfU1RBVEVfTUFYX0FHRV9NU1xuICApIHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShwYXRoKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHJldHVybiBwYXJzZWQ7XG59XG5cbi8qKlxuICogRG9lcyB0aGUgcmVzdW1lIHN0YXRlIHN1cnZpdmUgdGhpcyBjbGFpbSByZWxlYXNlPyAoSXNzdWUgIzE0OClcbiAqXG4gKiBBIHJlbGVhc2VkIGNsYWltIG5vcm1hbGx5IGVuZHMgdGhlIGF0dGVtcHQgZGVsaWJlcmF0ZWx5LCBzbyB0aGUgcG9pbnRlclxuICogaXMgZGVsZXRlZCBhbmQgdGhlIG5leHQgYXR0ZW1wdCBzdGFydHMgY2xlYW4gKCM0MTcwKS4gVGhlIGV4Y2VwdGlvbiBpcyBhXG4gKiBydW4gd2hvc2Ugd29yayB3YXMgcHJlc2VydmVkIGFzIGEgV0lQIGNvbW1pdCBvbiB0aGUgaXNzdWUgYnJhbmNoOiB0aGVcbiAqIGNvbW1pdCBpcyB0aGUgZHVyYWJsZSBhcnRpZmFjdCwgYW5kIHRoaXMgcG9pbnRlciBpcyB3aGF0IGxldHMgdGhlIG5leHRcbiAqIGNsYWltIGZpbmQgaXQgKGJyYW5jaCBjaGVja291dCBwbHVzIGAtLXJlc3VtZWApLiBEZWxldGluZyBpdCBpbiB0aGUgc2FtZVxuICogYnJlYXRoIGFzIHdyaXRpbmcgaXQgbWFkZSBwcmVzZXJ2YXRpb24gcmVzdW1hYmxlIGluIG5hbWUgb25seS5cbiAqXG4gKiBBIFBSIGRlZmVycmVkIGJ5IEdpdEh1YidzIHNlY29uZGFyeSByYXRlIGxpbWl0IChJc3N1ZSAjMTk1MSkgaXMgdGhlIHNlY29uZFxuICogc3VjaCByZWxlYXNlOiB0aGUgd29yayBpcyBmaW5pc2hlZCBhbmQgcHVzaGVkLCBhbmQgdGhlIFBSIGlzIHBhcmtlZCBmb3IgdGhlXG4gKiBuZXh0IGN5Y2xlJ3MgZHJhaW4uIFNob3VsZCB0aGF0IGRyYWluIG5ldmVyIHJhaXNlIGl0IOKAlCBhIHJlY29yZCBsb3N0IHdpdGhcbiAqIHRoZSBob3N0LCBhIHJlcG8gb2ZmIHRoZSByb3N0ZXIg4oCUIHRoZSBuZXh0IGNsYWltIG9mIHRoZSBpc3N1ZSBpcyB0aGVcbiAqIGZhbGxiYWNrLCBhbmQgdGhpcyBwb2ludGVyIGlzIHdoYXQgbGV0cyBpdCByZXN1bWUgdGhlIGJyYW5jaCBpbnN0ZWFkIG9mXG4gKiBzdGFydGluZyB0aGUgd29yayBhZ2Fpbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc3VtZVN0YXRlU3Vydml2ZXNSZWxlYXNlKFxuICBvdXRjb21lOiB7IGtpbmQ6IHN0cmluZzsgbWVzc2FnZT86IHN0cmluZyB9IHwgdW5kZWZpbmVkLFxuKTogYm9vbGVhbiB7XG4gIGlmIChvdXRjb21lPy5raW5kID09PSBcInByX2RlZmVycmVkXCIpIHJldHVybiB0cnVlO1xuICByZXR1cm4gb3V0Y29tZT8ua2luZCA9PT0gXCJub19wclwiICYmIGRlc2NyaWJlc1ByZXNlcnZlZFdpcChvdXRjb21lLm1lc3NhZ2UpO1xufVxuXG4vKiogUmVtb3ZlIGFuIGlzc3VlJ3MgcmVzdW1lIHN0YXRlLiBJZGVtcG90ZW50LCBuZXZlciB0aHJvd3MuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGVsZXRlUmVzdW1lU3RhdGUoXG4gIHdvcmtEaXI6IHN0cmluZyxcbiAgcmVwbzogc3RyaW5nLFxuICBpc3N1ZU51bWJlcjogbnVtYmVyLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IERlbm8ucmVtb3ZlKHJlc3VtZVN0YXRlUGF0aCh3b3JrRGlyLCByZXBvLCBpc3N1ZU51bWJlcikpLmNhdGNoKFxuICAgICgpID0+IHVuZGVmaW5lZCxcbiAgKTtcbn1cblxuLyoqXG4gKiBPbmUgcHJvdmlkZXIncyBzZXNzaW9uIG9uIGEgc3RyZWFtIChJc3N1ZSAjMjMzMikuXG4gKlxuICogYGhvbGRlckhvc3RgIHJlY29yZHMgd2hpY2ggZmxlZXQgaG9zdCBvcGVuZWQgaXQg4oCUIHRoZSB0cmFuc2NyaXB0IGl0c2VsZiBpc1xuICogaG9zdC1sb2NhbCwgc28gYSByZWFkZXIgb24gYW5vdGhlciBob3N0IGtub3dzIHRoZSBpZCBpdCBmb3VuZCBpcyBub3QgaXRzIG93blxuICogdG8gcmVwbGF5LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFBlcnNpc3RlZFN0cmVhbVNlc3Npb24ge1xuICAvKiogQ0xJIHNlc3Npb24gaWQgKENvZGV4IHN0b3JlcyBpdHMgdGhyZWFkIGlkIGhlcmUgdG9vKS4gKi9cbiAgc2Vzc2lvbklkOiBzdHJpbmc7XG4gIC8qKiBFcG9jaCBtaWxsaXNlY29uZHMgb2YgdGhlIGxhc3Qgc2F2ZS4gRGlhZ25vc3RpYyDigJQgbmV2ZXIgYW4gZXhwaXJ5LiAqL1xuICBzYXZlZEF0RXBvY2hNczogbnVtYmVyO1xuICAvKiogQ3JlZGVudGlhbCBsYWJlbCB0aGF0IG9wZW5lZCB0aGUgc2Vzc2lvbi4gKi9cbiAgY3JlZGVudGlhbFNjb3BlPzogc3RyaW5nO1xuICAvKiogRmxlZXQgaG9zdCB0aGF0IG93bnMgdGhlIGR1cmFibGUgdHJhbnNjcmlwdC4gKi9cbiAgaG9sZGVySG9zdD86IHN0cmluZztcbiAgLyoqXG4gICAqIFByb3ZpZGVyIHdob3NlIENMSSBjcmVhdGVkIHRoZSBzZXNzaW9uIChJc3N1ZSAjMjYzOCkuIEEgc2Vzc2lvbiBpcyBib3VuZFxuICAgKiB0byBpdHMgY3JlYXRvciDigJQgaXRzIG1vZGVsIGlkcywgaXRzIHRoaW5raW5nIGJsb2NrcyBhbmQgaXRzIHNpemUgYnVkZ2V0XG4gICAqIGFyZSB0aGF0IHByb3ZpZGVyJ3Mg4oCUIHNvIGl0IGlzIG5ldmVyIHJlc3VtZWQgYnkgYW5vdGhlci4gQWJzZW50IG9uXG4gICAqIHJlY29yZHMgd3JpdHRlbiBiZWZvcmUgdGhpcyBmaWVsZCBleGlzdGVkOyBhIHJlYWRlciB0cmVhdHMgdGhvc2UgYXMgdGhlXG4gICAqIGNvbmZpZ3VyZWQgcHJlZmVycmVkIHByb3ZpZGVyJ3MuXG4gICAqL1xuICBwcm92aWRlcklkPzogc3RyaW5nO1xufVxuXG4vKiogUGF0aCBvZiBvbmUgc3RyZWFtJ3Mgc2Vzc2lvbiByZWNvcmQuIFRocm93cyB3aGVuIGBzdHJlYW0ucmVwb2AgaXMgbm90IGBvd25lci9uYW1lYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdHJlYW1TZXNzaW9uUGF0aCh3b3JrRGlyOiBzdHJpbmcsIHN0cmVhbTogU3RyZWFtSWQpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7cmVzdW1lU3RhdGVEaXIod29ya0Rpcil9LyR7U1RSRUFNX0ZJTEVfUFJFRklYfSR7XG4gICAgc3RyZWFtS2V5KHN0cmVhbSlcbiAgfS5qc29uYDtcbn1cblxuLyoqXG4gKiBQZXJzaXN0IG9uZSBwcm92aWRlcidzIHNlc3Npb24gZm9yIGEgc3RyZWFtLCBsZWF2aW5nIGV2ZXJ5IG90aGVyIHByb3ZpZGVyJ3NcbiAqIHNlc3Npb24gaW4gdGhlIHJlY29yZCB1bnRvdWNoZWQg4oCUIGEgc3ViLWlzc3VlIHRoYXQgcmFuIHVuZGVyIGEgZmFsbGJhY2tcbiAqIHByb3ZpZGVyIHN0YXJ0cyB0aGF0IHByb3ZpZGVyJ3Mgb3duIHN0cmVhbSBzZXNzaW9uIHJhdGhlciB0aGFuIG92ZXJ3cml0aW5nXG4gKiB0aGUgcHJpbWFyeSdzLlxuICpcbiAqIEJlc3QtZWZmb3J0OiByZXR1cm5zIGZhbHNlIChhbmQgd3JpdGVzIG5vdGhpbmcpIG9uIGFueSBmaWxlc3lzdGVtIGZhaWx1cmUg4oCUXG4gKiBpbmNsdWRpbmcgYSByZWNvcmQgdGhhdCBleGlzdHMgYnV0IGNhbm5vdCBiZSByZWFkLCBiZWNhdXNlIG1lcmdpbmcgaW50byBhblxuICogZW1wdHkgbWFwIHRoZXJlIHdvdWxkIGRlc3Ryb3kgdGhlIG90aGVyIHByb3ZpZGVycycgc2Vzc2lvbnMgcmF0aGVyIHRoYW5cbiAqIG1lcmVseSBtaXNzIGEgcmVzdW1lLiBUaHJvd3Mgb25seSB3aGVuIGBzdHJlYW0ucmVwb2AgaXMgbWFsZm9ybWVkLCB3aGljaCBpc1xuICogYSBjYWxsZXIgYnVnLCBub3QgYSByZXN1bWUgbWlzcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNhdmVTdHJlYW1TZXNzaW9uKFxuICB3b3JrRGlyOiBzdHJpbmcsXG4gIHN0cmVhbTogU3RyZWFtSWQsXG4gIHNlc3Npb246IHtcbiAgICBwcm92aWRlcklkOiBzdHJpbmc7XG4gICAgc2Vzc2lvbklkOiBzdHJpbmc7XG4gICAgY3JlZGVudGlhbFNjb3BlPzogc3RyaW5nO1xuICAgIGhvbGRlckhvc3Q/OiBzdHJpbmc7XG4gIH0sXG4gIG5vd0Vwb2NoTXM6IG51bWJlciA9IERhdGUubm93KCksXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgcGF0aCA9IHN0cmVhbVNlc3Npb25QYXRoKHdvcmtEaXIsIHN0cmVhbSk7XG4gIGNvbnN0IHNlc3Npb25zID0gYXdhaXQgcmVhZFN0cmVhbVNlc3Npb25zKHBhdGgpO1xuICBpZiAoc2Vzc2lvbnMgPT09IG51bGwpIHJldHVybiBmYWxzZTtcbiAgc2Vzc2lvbnNbc2Vzc2lvbi5wcm92aWRlcklkXSA9IHtcbiAgICBzZXNzaW9uSWQ6IHNlc3Npb24uc2Vzc2lvbklkLFxuICAgIHNhdmVkQXRFcG9jaE1zOiBub3dFcG9jaE1zLFxuICAgIHByb3ZpZGVySWQ6IHNlc3Npb24ucHJvdmlkZXJJZCxcbiAgICAuLi4oc2Vzc2lvbi5jcmVkZW50aWFsU2NvcGUgIT09IHVuZGVmaW5lZFxuICAgICAgPyB7IGNyZWRlbnRpYWxTY29wZTogc2Vzc2lvbi5jcmVkZW50aWFsU2NvcGUgfVxuICAgICAgOiB7fSksXG4gICAgLi4uKHNlc3Npb24uaG9sZGVySG9zdCAhPT0gdW5kZWZpbmVkXG4gICAgICA/IHsgaG9sZGVySG9zdDogc2Vzc2lvbi5ob2xkZXJIb3N0IH1cbiAgICAgIDoge30pLFxuICB9O1xuICByZXR1cm4gYXdhaXQgd3JpdGVTdHJlYW1TZXNzaW9ucyh3b3JrRGlyLCBwYXRoLCBzZXNzaW9ucyk7XG59XG5cbi8qKlxuICogV2hhdCBhIHN0cmVhbSByZWNvcmQgaG9sZHMgZm9yIG9uZSBwcm92aWRlciAoSXNzdWUgIzIzMzMpLlxuICpcbiAqIGBsb2FkU3RyZWFtU2Vzc2lvbmAgY29sbGFwc2VzIFwidGhpcyBzdHJlYW0gaGFzIG5vIHNlc3Npb24gb2YgbWluZSB5ZXRcIiBhbmRcbiAqIFwidGhlIHNlc3Npb24gaXQgbmFtZXMgaXMgb25lIG15IENMSSB3b3VsZCByZWZ1c2VcIiBpbnRvIGEgc2luZ2xlIG51bGwsIGFuZFxuICogdGhvc2UgdHdvIGNhbGwgZm9yIG9wcG9zaXRlIHRoaW5nczogdGhlIGZpcnN0IHN0YXJ0cyB0aGUgcHJvdmlkZXIncyBzZXNzaW9uXG4gKiBiZXNpZGUgaXRzIHNpYmxpbmdzLCB0aGUgc2Vjb25kIHJlc2V0cyBhIHN0cmVhbSB0aGF0IGlzIHJlY29yZGVkIGJ1dCBkZWFkLlxuICovXG5leHBvcnQgdHlwZSBTdHJlYW1TZXNzaW9uTG9va3VwID1cbiAgLyoqIE5vIHJlY29yZCwgb3Igbm9uZSBuYW1pbmcgdGhpcyBwcm92aWRlciDigJQgdGhlIHByb3ZpZGVyIHN0YXJ0cyB0aGUgc3RyZWFtLiAqL1xuICB8IHsgc3RhdHVzOiBcIm5vbmVcIiB9XG4gIC8qKiBBIHNlc3Npb24gdGhpcyBwcm92aWRlciBtYXkgcmVzdW1lLiAqL1xuICB8IHsgc3RhdHVzOiBcInVzYWJsZVwiOyBzZXNzaW9uOiBQZXJzaXN0ZWRTdHJlYW1TZXNzaW9uIH1cbiAgLyoqIEEgc2Vzc2lvbiByZWNvcmRlZCBmb3IgdGhpcyBwcm92aWRlciB0aGF0IGl0cyBDTEkgd291bGQgcmVmdXNlICgjMjA0KS4gKi9cbiAgfCB7IHN0YXR1czogXCJ1bnVzYWJsZVwiOyBzZXNzaW9uSWQ6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfVxuICAvKipcbiAgICogQSBzZXNzaW9uIGluIHRoaXMgcHJvdmlkZXIncyBzbG90IHRoYXQgYW5vdGhlciBwcm92aWRlciBjcmVhdGVkXG4gICAqIChJc3N1ZSAjMjYzOCkuIE5ldmVyIHJlc3VtZWQgYW5kIG5ldmVyIGRlbGV0ZWQ6IGl0IGlzIG5vdCB0aGlzXG4gICAqIHByb3ZpZGVyJ3MgdG8gcmVwbGF5LCBhbmQgdGhlIHNsb3QgaXMgb3ZlcndyaXR0ZW4gYnkgdGhlIHNlc3Npb24gdGhpc1xuICAgKiBwcm92aWRlciBvcGVucyBpbnN0ZWFkLlxuICAgKi9cbiAgfCB7IHN0YXR1czogXCJmb3JlaWduXCI7IHNlc3Npb25JZDogc3RyaW5nOyBjcmVhdGVkQnk6IHN0cmluZyB9O1xuXG4vKiogSG93IHtAbGluayBsb29rdXBTdHJlYW1TZXNzaW9ufSByZWFkcyBhIHJlY29yZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3RyZWFtU2Vzc2lvbkxvb2t1cE9wdGlvbnMge1xuICAvKipcbiAgICogVGhlIHByb3ZpZGVyIGEgcmVjb3JkIHdpdGggbm8gcmVjb3JkZWQgY3JlYXRvciBpcyBwcmVzdW1lZCB0byBiZWxvbmcgdG9cbiAgICogKElzc3VlICMyNjM4KSDigJQgdGhlIGNvbmZpZ3VyZWQgcHJlZmVycmVkIHByb3ZpZGVyLiBPbWl0dGVkLCBzdWNoIGFcbiAgICogcmVjb3JkIGlzIHByZXN1bWVkIHRvIGJlbG9uZyB0byB0aGUgcHJvdmlkZXIgd2hvc2Ugc2xvdCBob2xkcyBpdC5cbiAgICovXG4gIGxlZ2FjeVByb3ZpZGVySWQ/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogTG9vayB1cCBvbmUgcHJvdmlkZXIncyBzZXNzaW9uIG9uIGEgc3RyZWFtLCBzYXlpbmcgd2hpY2ggb2YgdGhlIGZvdXJcbiAqIHN0YXRlcyBhYm92ZSB0aGUgcmVjb3JkIGlzIGluLiBUaHJvd3Mgd2hlbiBgc3RyZWFtLnJlcG9gIGlzIG1hbGZvcm1lZC5cbiAqXG4gKiBUaGVyZSBpcyBkZWxpYmVyYXRlbHkgbm8gY2xvY2sgcGFyYW1ldGVyOiBhIHN0cmVhbSBzZXNzaW9uIG5ldmVyIGV4cGlyZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb29rdXBTdHJlYW1TZXNzaW9uKFxuICB3b3JrRGlyOiBzdHJpbmcsXG4gIHN0cmVhbTogU3RyZWFtSWQsXG4gIHByb3ZpZGVySWQ6IHN0cmluZyxcbiAgb3B0aW9uczogU3RyZWFtU2Vzc2lvbkxvb2t1cE9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8U3RyZWFtU2Vzc2lvbkxvb2t1cD4ge1xuICBjb25zdCBzZXNzaW9ucyA9IGF3YWl0IHJlYWRTdHJlYW1TZXNzaW9ucyhcbiAgICBzdHJlYW1TZXNzaW9uUGF0aCh3b3JrRGlyLCBzdHJlYW0pLFxuICApO1xuICBjb25zdCBzZXNzaW9uID0gc2Vzc2lvbnM/Lltwcm92aWRlcklkXTtcbiAgaWYgKHNlc3Npb24gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgc3RhdHVzOiBcIm5vbmVcIiB9O1xuICBjb25zdCBjcmVhdGVkQnkgPSBzZXNzaW9uLnByb3ZpZGVySWQgPz8gb3B0aW9ucy5sZWdhY3lQcm92aWRlcklkID8/XG4gICAgcHJvdmlkZXJJZDtcbiAgaWYgKGNyZWF0ZWRCeSAhPT0gcHJvdmlkZXJJZCkge1xuICAgIHJldHVybiB7IHN0YXR1czogXCJmb3JlaWduXCIsIHNlc3Npb25JZDogc2Vzc2lvbi5zZXNzaW9uSWQsIGNyZWF0ZWRCeSB9O1xuICB9XG4gIGlmICghaXNQZXJzaXN0YWJsZVNlc3Npb25JZChzZXNzaW9uLnNlc3Npb25JZCwgcHJvdmlkZXJJZCkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzOiBcInVudXNhYmxlXCIsXG4gICAgICBzZXNzaW9uSWQ6IHNlc3Npb24uc2Vzc2lvbklkLFxuICAgICAgcmVhc29uOlxuICAgICAgICBgdGhlIHJlY29yZGVkIHNlc3Npb24gaWQgaXMgbm90IG9uZSB0aGUgJHtwcm92aWRlcklkfSBDTEkgd291bGQgYWNjZXB0YCxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7IHN0YXR1czogXCJ1c2FibGVcIiwgc2Vzc2lvbiB9O1xufVxuXG4vKipcbiAqIExvYWQgb25lIHByb3ZpZGVyJ3Mgc2Vzc2lvbiBmb3IgYSBzdHJlYW0uIFJldHVybnMgbnVsbCB3aGVuIHRoZSByZWNvcmQgaXNcbiAqIG1pc3NpbmcsIHVucmVhZGFibGUsIHVucGFyc2VhYmxlLCBob2xkcyBubyBzZXNzaW9uIGZvciB0aGF0IHByb3ZpZGVyLCBvclxuICogaG9sZHMgYW4gaWQgdGhlIHByb3ZpZGVyJ3MgQ0xJIHdvdWxkIHJlZnVzZSAoIzIwNCkgb3IgYSBzZXNzaW9uIGFub3RoZXJcbiAqIHByb3ZpZGVyIGNyZWF0ZWQgKCMyNjM4KS4gVGhyb3dzIHdoZW5cbiAqIGBzdHJlYW0ucmVwb2AgaXMgbWFsZm9ybWVkLlxuICpcbiAqIFRoZXJlIGlzIGRlbGliZXJhdGVseSBubyBjbG9jayBwYXJhbWV0ZXI6IGEgc3RyZWFtIHNlc3Npb24gbmV2ZXIgZXhwaXJlcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWRTdHJlYW1TZXNzaW9uKFxuICB3b3JrRGlyOiBzdHJpbmcsXG4gIHN0cmVhbTogU3RyZWFtSWQsXG4gIHByb3ZpZGVySWQ6IHN0cmluZyxcbiAgb3B0aW9uczogU3RyZWFtU2Vzc2lvbkxvb2t1cE9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8UGVyc2lzdGVkU3RyZWFtU2Vzc2lvbiB8IG51bGw+IHtcbiAgY29uc3QgbG9va3VwID0gYXdhaXQgbG9va3VwU3RyZWFtU2Vzc2lvbihcbiAgICB3b3JrRGlyLFxuICAgIHN0cmVhbSxcbiAgICBwcm92aWRlcklkLFxuICAgIG9wdGlvbnMsXG4gICk7XG4gIHJldHVybiBsb29rdXAuc3RhdHVzID09PSBcInVzYWJsZVwiID8gbG9va3VwLnNlc3Npb24gOiBudWxsO1xufVxuXG4vKipcbiAqIFJlbW92ZSBhIHN0cmVhbSdzIHNlc3Npb24g4oCUIG9uZSBwcm92aWRlcidzIHdoZW4gYHByb3ZpZGVySWRgIGlzIGdpdmVuLCB0aGVcbiAqIHdob2xlIHJlY29yZCBvdGhlcndpc2UuIElkZW1wb3RlbnQgZm9yIGEgbWlzc2luZyByZWNvcmQ7IHRocm93cyBvbmx5IHdoZW5cbiAqIGBzdHJlYW0ucmVwb2AgaXMgbWFsZm9ybWVkLlxuICpcbiAqIEZvciBtaWxlc3RvbmUtY2xvc2UgaG91c2VrZWVwaW5nICh0aGUgd2hvbGUgcmVjb3JkKSBhbmQgZm9yIHRoZSByZXNldCBwYXRoXG4gKiB3aGVuIG9uZSBwcm92aWRlcidzIHNlc3Npb24gcHJvdmVzIHVucmVzdW1hYmxlOyB0aG9zZSBjYWxsZXJzIGxhbmQgd2l0aCB0aGVcbiAqIHJlc3Qgb2YgdGhpcyBtaWxlc3RvbmUuXG4gKlxuICogV2hlbiBhIHNpbmdsZS1wcm92aWRlciBkZWxldGUgY2Fubm90IHJlYWQgdGhlIHJlY29yZCBpdCByZW1vdmVzIHRoZSB3aG9sZVxuICogZmlsZTogdGhlIGNhbGxlcidzIGNvbnRyYWN0IGlzIHRoYXQgdGhlIG5hbWVkIHNlc3Npb24gaXMgZ29uZSBhZnRlcndhcmRzLFxuICogYW5kIGxvc2luZyBhIHNpYmxpbmcgZW50cnkgb25seSBjb3N0cyB0aGUgc3RyZWFtIGEgZnJlc2ggc3RhcnQsIHdoZXJlYXNcbiAqIGxlYXZpbmcgYW4gdW5yZXN1bWFibGUgc2Vzc2lvbiBiZWhpbmQgaXMgdGhlIGZhdWx0IHRoaXMgY2FsbCBleGlzdHMgdG9cbiAqIGNsZWFyLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGVsZXRlU3RyZWFtU2Vzc2lvbihcbiAgd29ya0Rpcjogc3RyaW5nLFxuICBzdHJlYW06IFN0cmVhbUlkLFxuICBwcm92aWRlcklkPzogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHBhdGggPSBzdHJlYW1TZXNzaW9uUGF0aCh3b3JrRGlyLCBzdHJlYW0pO1xuICBpZiAocHJvdmlkZXJJZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocGF0aCkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3Qgc2Vzc2lvbnMgPSBhd2FpdCByZWFkU3RyZWFtU2Vzc2lvbnMocGF0aCk7XG4gIGlmIChzZXNzaW9ucyA9PT0gbnVsbCkge1xuICAgIC8vIFVucmVhZGFibGUg4oCUIGRyb3AgdGhlIHdob2xlIHJlY29yZCByYXRoZXIgdGhhbiBsZWF2ZSB0aGUgbmFtZWRcbiAgICAvLyBzZXNzaW9uIGJlaGluZC5cbiAgICBhd2FpdCBEZW5vLnJlbW92ZShwYXRoKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoc2Vzc2lvbnNbcHJvdmlkZXJJZF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICBkZWxldGUgc2Vzc2lvbnNbcHJvdmlkZXJJZF07XG4gIGlmIChPYmplY3Qua2V5cyhzZXNzaW9ucykubGVuZ3RoID09PSAwKSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocGF0aCkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgICByZXR1cm47XG4gIH1cbiAgYXdhaXQgd3JpdGVTdHJlYW1TZXNzaW9ucyh3b3JrRGlyLCBwYXRoLCBzZXNzaW9ucyk7XG59XG5cbi8qKlxuICogUmVhZCBhIHN0cmVhbSByZWNvcmQuXG4gKlxuICogQW4gYWJzZW50IGZpbGUgYW5kIGEgY29ycnVwdCBvbmUgYm90aCByZWFkIGFzIGFuIGVtcHR5IG1hcCDigJQgdGhlcmUgaXNcbiAqIG5vdGhpbmcgdG8gcHJlc2VydmUgaW4gZWl0aGVyLiBBIGZpbGUgdGhhdCBleGlzdHMgYnV0IGNhbm5vdCBiZSByZWFkXG4gKiAocGVybWlzc2lvbnMsIEkvTykgcmVhZHMgYXMgYG51bGxgLCBzbyBhIGNhbGxlciBtZXJnaW5nIGludG8gdGhlIHJlc3VsdFxuICogYWJvcnRzIGluc3RlYWQgb2Ygd3JpdGluZyBhIHJlY29yZCB0aGF0IHNpbGVudGx5IGRyb3BzIGV2ZXJ5IHByb3ZpZGVyIGl0XG4gKiBjb3VsZCBub3Qgc2VlLlxuICovXG5hc3luYyBmdW5jdGlvbiByZWFkU3RyZWFtU2Vzc2lvbnMoXG4gIHBhdGg6IHN0cmluZyxcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgUGVyc2lzdGVkU3RyZWFtU2Vzc2lvbj4gfCBudWxsPiB7XG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHtcbiAgICByYXcgPSBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShwYXRoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCA/IHt9IDogbnVsbDtcbiAgfVxuICByZXR1cm4gcGFyc2VTdHJlYW1TZXNzaW9ucyhyYXcpO1xufVxuXG4vKipcbiAqIFdyaXRlIGEgc3RyZWFtIHJlY29yZCB0aHJvdWdoIGEgdGVtcG9yYXJ5IGZpbGUgYW5kIGEgcmVuYW1lLCBzbyBhIGNyYXNoXG4gKiBtaWQtd3JpdGUgbGVhdmVzIHRoZSBwcmV2aW91cyByZWNvcmQgcmF0aGVyIHRoYW4gYSB0cnVuY2F0ZWQgb25lIOKAlCB0aGVcbiAqIHJlY29yZCBoYXMgbm8gZXhwaXJ5IGFuZCBubyBzd2VlcCwgc28gYSB0cnVuY2F0aW9uIHdvdWxkIGJlIHBlcm1hbmVudC5cbiAqIEJlc3QtZWZmb3J0OiBmYWxzZSBvbiBhbnkgZmlsZXN5c3RlbSBmYWlsdXJlLlxuICovXG5hc3luYyBmdW5jdGlvbiB3cml0ZVN0cmVhbVNlc3Npb25zKFxuICB3b3JrRGlyOiBzdHJpbmcsXG4gIHBhdGg6IHN0cmluZyxcbiAgc2Vzc2lvbnM6IFJlY29yZDxzdHJpbmcsIFBlcnNpc3RlZFN0cmVhbVNlc3Npb24+LFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHRlbXBvcmFyeSA9IGAke3BhdGh9LiR7Y3J5cHRvLnJhbmRvbVVVSUQoKX0udG1wYDtcbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLm1rZGlyKHJlc3VtZVN0YXRlRGlyKHdvcmtEaXIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICB0ZW1wb3JhcnksXG4gICAgICBKU09OLnN0cmluZ2lmeSh7IHNlc3Npb25zIH0sIG51bGwsIDIpICsgXCJcXG5cIixcbiAgICApO1xuICAgIGF3YWl0IERlbm8ucmVuYW1lKHRlbXBvcmFyeSwgcGF0aCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHRlbXBvcmFyeSkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFBhcnNlIGEgc3RyZWFtIHJlY29yZCwga2VlcGluZyBvbmx5IHdlbGwtZm9ybWVkIHBlci1wcm92aWRlciBlbnRyaWVzLiAqL1xuZnVuY3Rpb24gcGFyc2VTdHJlYW1TZXNzaW9ucyhcbiAgcmF3OiBzdHJpbmcsXG4pOiBSZWNvcmQ8c3RyaW5nLCBQZXJzaXN0ZWRTdHJlYW1TZXNzaW9uPiB7XG4gIGxldCB2YWx1ZTogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICB2YWx1ZSA9IEpTT04ucGFyc2UocmF3KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHt9O1xuICB9XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIgfHwgdmFsdWUgPT09IG51bGwpIHJldHVybiB7fTtcbiAgY29uc3Qgc2Vzc2lvbnMgPSAodmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLnNlc3Npb25zO1xuICBpZiAodHlwZW9mIHNlc3Npb25zICE9PSBcIm9iamVjdFwiIHx8IHNlc3Npb25zID09PSBudWxsKSByZXR1cm4ge307XG4gIGNvbnN0IHBhcnNlZDogUmVjb3JkPHN0cmluZywgUGVyc2lzdGVkU3RyZWFtU2Vzc2lvbj4gPSB7fTtcbiAgZm9yIChjb25zdCBbcHJvdmlkZXJJZCwgZW50cnldIG9mIE9iamVjdC5lbnRyaWVzKHNlc3Npb25zKSkge1xuICAgIGlmICh0eXBlb2YgZW50cnkgIT09IFwib2JqZWN0XCIgfHwgZW50cnkgPT09IG51bGwpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHJlY29yZCA9IGVudHJ5IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGlmIChcbiAgICAgIHR5cGVvZiByZWNvcmQuc2Vzc2lvbklkICE9PSBcInN0cmluZ1wiIHx8IHJlY29yZC5zZXNzaW9uSWQubGVuZ3RoID09PSAwIHx8XG4gICAgICB0eXBlb2YgcmVjb3JkLnNhdmVkQXRFcG9jaE1zICE9PSBcIm51bWJlclwiXG4gICAgKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgcGFyc2VkW3Byb3ZpZGVySWRdID0ge1xuICAgICAgc2Vzc2lvbklkOiByZWNvcmQuc2Vzc2lvbklkLFxuICAgICAgc2F2ZWRBdEVwb2NoTXM6IHJlY29yZC5zYXZlZEF0RXBvY2hNcyxcbiAgICAgIC4uLih0eXBlb2YgcmVjb3JkLmNyZWRlbnRpYWxTY29wZSA9PT0gXCJzdHJpbmdcIlxuICAgICAgICA/IHsgY3JlZGVudGlhbFNjb3BlOiByZWNvcmQuY3JlZGVudGlhbFNjb3BlIH1cbiAgICAgICAgOiB7fSksXG4gICAgICAuLi4odHlwZW9mIHJlY29yZC5ob2xkZXJIb3N0ID09PSBcInN0cmluZ1wiXG4gICAgICAgID8geyBob2xkZXJIb3N0OiByZWNvcmQuaG9sZGVySG9zdCB9XG4gICAgICAgIDoge30pLFxuICAgICAgLi4uKHR5cGVvZiByZWNvcmQucHJvdmlkZXJJZCA9PT0gXCJzdHJpbmdcIiAmJiByZWNvcmQucHJvdmlkZXJJZCAhPT0gXCJcIlxuICAgICAgICA/IHsgcHJvdmlkZXJJZDogcmVjb3JkLnByb3ZpZGVySWQgfVxuICAgICAgICA6IHt9KSxcbiAgICB9O1xuICB9XG4gIHJldHVybiBwYXJzZWQ7XG59XG5cbi8qKiBQYXJzZSBhbmQgdmFsaWRhdGUgYSBwZXJzaXN0ZWQgZmlsZSdzIGNvbnRlbnRzLiAqL1xuZnVuY3Rpb24gcGFyc2VQZXJzaXN0ZWQocmF3OiBzdHJpbmcpOiBQZXJzaXN0ZWRSZXN1bWVTdGF0ZSB8IG51bGwge1xuICBsZXQgdmFsdWU6IHVua25vd247XG4gIHRyeSB7XG4gICAgdmFsdWUgPSBKU09OLnBhcnNlKHJhdyk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIgfHwgdmFsdWUgPT09IG51bGwpIHJldHVybiBudWxsO1xuICBjb25zdCByZWNvcmQgPSB2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgaWYgKFxuICAgIHR5cGVvZiByZWNvcmQucGhhc2VDb3VudCAhPT0gXCJudW1iZXJcIiB8fFxuICAgIHR5cGVvZiByZWNvcmQuYnJhbmNoICE9PSBcInN0cmluZ1wiIHx8IHJlY29yZC5icmFuY2gubGVuZ3RoID09PSAwIHx8XG4gICAgdHlwZW9mIHJlY29yZC5zYXZlZEF0RXBvY2hNcyAhPT0gXCJudW1iZXJcIlxuICApIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBpZiAocmVjb3JkLnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiByZWNvcmQuc2Vzc2lvbklkICE9PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgaWYgKFxuICAgIHJlY29yZC5wcm92aWRlcklkICE9PSB1bmRlZmluZWQgJiYgdHlwZW9mIHJlY29yZC5wcm92aWRlcklkICE9PSBcInN0cmluZ1wiXG4gICkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGlmIChcbiAgICByZWNvcmQuY3JlZGVudGlhbFNjb3BlICE9PSB1bmRlZmluZWQgJiZcbiAgICB0eXBlb2YgcmVjb3JkLmNyZWRlbnRpYWxTY29wZSAhPT0gXCJzdHJpbmdcIlxuICApIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBjb25zdCBwcm92aWRlcklkID0gdHlwZW9mIHJlY29yZC5wcm92aWRlcklkID09PSBcInN0cmluZ1wiXG4gICAgPyByZWNvcmQucHJvdmlkZXJJZFxuICAgIDogdW5kZWZpbmVkO1xuICAvLyBBbiBpZCB3cml0dGVuIGJlZm9yZSB0aGUgVVVJRCBmaXggKElzc3VlICMyMDQpIGlzIHN0YWxlIGZvciBDbGF1ZGU6IHRoZVxuICAvLyBDTEkgcmVmdXNlcyBpdCBvdXRyaWdodC4gQ29kZXggdGhyZWFkIGlkcyBhcmUgbm90IFVVSURzLW9yLWJ1c3RcbiAgLy8gKElzc3VlICMxNjk5KSwgc28gdGhleSBwZXJzaXN0IHdoZW4gdGhlIHJlY29yZCBuYW1lcyBDb2RleC5cbiAgY29uc3Qgc2Vzc2lvbklkID0gdHlwZW9mIHJlY29yZC5zZXNzaW9uSWQgPT09IFwic3RyaW5nXCIgJiZcbiAgICAgIGlzUGVyc2lzdGFibGVTZXNzaW9uSWQocmVjb3JkLnNlc3Npb25JZCwgcHJvdmlkZXJJZClcbiAgICA/IHJlY29yZC5zZXNzaW9uSWRcbiAgICA6IHVuZGVmaW5lZDtcbiAgcmV0dXJuIHtcbiAgICAuLi4oc2Vzc2lvbklkICE9PSB1bmRlZmluZWQgPyB7IHNlc3Npb25JZCB9IDoge30pLFxuICAgIHBoYXNlQ291bnQ6IHJlY29yZC5waGFzZUNvdW50LFxuICAgIGJyYW5jaDogcmVjb3JkLmJyYW5jaCxcbiAgICBzYXZlZEF0RXBvY2hNczogcmVjb3JkLnNhdmVkQXRFcG9jaE1zLFxuICAgIC4uLihwcm92aWRlcklkICE9PSB1bmRlZmluZWQgPyB7IHByb3ZpZGVySWQgfSA6IHt9KSxcbiAgICAuLi4odHlwZW9mIHJlY29yZC5jcmVkZW50aWFsU2NvcGUgPT09IFwic3RyaW5nXCJcbiAgICAgID8geyBjcmVkZW50aWFsU2NvcGU6IHJlY29yZC5jcmVkZW50aWFsU2NvcGUgfVxuICAgICAgOiB7fSksXG4gIH07XG59XG5cbi8qKlxuICogRGVsZXRlIHNpYmxpbmcgKipwZXItaXNzdWUqKiBlbnRyaWVzIHdob3NlIHJlY29yZGVkIHNhdmUgdGltZSBpcyBvdXRzaWRlXG4gKiB0aGUgZnJlc2huZXNzIHdpbmRvdyAob3IgdGhhdCBubyBsb25nZXIgcGFyc2UpLiBLZWVwcyB0aGUgZGlyZWN0b3J5IGZyb21cbiAqIGFjY3VtdWxhdGluZyBmaWxlcyBmb3IgaXNzdWVzIHRoYXQgd2VyZSBuZXZlciByZS1jbGFpbWVkLlxuICpcbiAqIE9ubHkgZmlsZXMgbWF0Y2hpbmcgdGhlIHBlci1pc3N1ZSBuYW1lIHNoYXBlIGFyZSBjb25zaWRlcmVkLCBzbyBhIHN0cmVhbVxuICogcmVjb3JkIOKAlCB3aGljaCBuZXZlciBleHBpcmVzIOKAlCBpcyBuZXZlciBzd2VwdCAoSXNzdWUgIzIzMzIpLlxuICovXG5hc3luYyBmdW5jdGlvbiBzd2VlcFN0YWxlU2libGluZ3MoXG4gIGRpcjogc3RyaW5nLFxuICBub3dFcG9jaE1zOiBudW1iZXIsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBmb3IgYXdhaXQgKGNvbnN0IGVudHJ5IG9mIERlbm8ucmVhZERpcihkaXIpKSB7XG4gICAgICBpZiAoXG4gICAgICAgICFlbnRyeS5pc0ZpbGUgfHxcbiAgICAgICAgZW50cnkubmFtZS5zdGFydHNXaXRoKFNUUkVBTV9GSUxFX1BSRUZJWCkgfHxcbiAgICAgICAgIVBFUl9JU1NVRV9GSUxFX1BBVFRFUk4udGVzdChlbnRyeS5uYW1lKVxuICAgICAgKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgcGF0aCA9IGAke2Rpcn0vJHtlbnRyeS5uYW1lfWA7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVBlcnNpc3RlZChhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShwYXRoKSk7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBwYXJzZWQgPT09IG51bGwgfHxcbiAgICAgICAgICBub3dFcG9jaE1zIC0gcGFyc2VkLnNhdmVkQXRFcG9jaE1zID4gUkVTVU1FX1NUQVRFX01BWF9BR0VfTVNcbiAgICAgICAgKSB7XG4gICAgICAgICAgYXdhaXQgRGVuby5yZW1vdmUocGF0aCkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIFVucmVhZGFibGUgZW50cnkg4oCUIGxlYXZlIGl0IGZvciB0aGUgbmV4dCBzd2VlcC5cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIERpcmVjdG9yeSB2YW5pc2hlZCBtaWQtc3dlZXAg4oCUIG5vdGhpbmcgdG8gZG8uXG4gIH1cbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0ErQ0MsR0FFRCxTQUFTLHNCQUFzQixRQUFRLHNCQUFzQjtBQUM3RCxTQUF3QixTQUFTLFFBQVEsdUJBQXVCO0FBQ2hFLFNBQVMscUJBQXFCLFFBQVEsbUJBQW1CO0FBRXpEOzs7Q0FHQyxHQUNELE9BQU8sTUFBTSwwQkFBMEIsS0FBSyxLQUFLLEtBQUssS0FBSztBQUUzRCx5RUFBeUUsR0FDekUsTUFBTSxxQkFBcUI7QUFFM0I7Ozs7OztDQU1DLEdBQ0QsTUFBTSx5QkFBeUI7QUFFL0I7Ozs7Q0FJQyxHQUNELE9BQU8sTUFBTSw2QkFDWCxvREFDQSx5RUFDQSx3RUFDQSx3RUFDQSwyRUFDQSw0Q0FBNEM7QUF1QjlDLDhDQUE4QyxHQUM5QyxPQUFPLFNBQVMsZUFBZSxPQUFlO0VBQzVDLE9BQU8sR0FBRyxRQUFRLHdCQUF3QixDQUFDO0FBQzdDO0FBRUEsMkNBQTJDLEdBQzNDLE9BQU8sU0FBUyxnQkFDZCxPQUFlLEVBQ2YsSUFBWSxFQUNaLFdBQW1CO0VBRW5CLE1BQU0sT0FBTyxLQUFLLE9BQU8sQ0FBQyxpQkFBaUI7RUFDM0MsT0FBTyxHQUFH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
// denoCacheMetadata=13725384627768373860,15570355535857156469