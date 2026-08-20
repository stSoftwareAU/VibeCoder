/**
 * Durable resume-state store (Issue #4170).
 *
 * A killed session used to restart from zero: the Claude conversation
 * lived in the container VM and the uncommitted diff lasted only until
 * the next attempt's repo reset. With `CLAUDE_CONFIG_DIR` on the durable
 * work dir (#4171/#4203) the conversation transcript now survives — this
 * store adds the pointer that lets the *next* attempt find it: session
 * id, phase count, and the issue branch, persisted per issue at
 * `${workDir}/.claude-sessions/resume/<owner>-<repo>-<issue>.json`.
 *
 * Lifecycle:
 *  - written by the execute phase's WIP checkpoints and at each phase
 *    completion;
 *  - read on re-claim — fresh (< 24 h) state primes `--resume` and lets
 *    the setup phase pick up the checkpointed branch instead of resetting;
 *  - deleted on successful PR creation and on claim release, so a
 *    gracefully finished or failed attempt starts the next one clean.
 *
 * The store lives under the dot-prefixed `.claude-sessions` directory,
 * which the stale-workdir scanner skips (stale_workdir.ts) and the
 * session sweeper's directory walk ignores (files are not session dirs).
 * Abandoned entries are swept opportunistically on save: any sibling
 * older than the freshness window is deleted, so the directory stays a
 * handful of tiny JSON files.
 *
 * Every operation is best-effort — resume is an optimisation, never
 * control flow, so a filesystem failure degrades to "no resume" rather
 * than failing the phase.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { describesPreservedWip } from "./wip_markers.ts";

/** Resume state older than this is stale — the next attempt starts clean. */
export const RESUME_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
   * Claude CLI session id, when session resume was active. Absent when the
   * attempt ran without CLI session continuity — the branch checkpoint is
   * still worth resuming.
   */
  sessionId?: string;
  /** Phases completed in the persisted session. */
  phaseCount: number;
  /** The issue branch the checkpointed work lives on. */
  branch: string;
  /** Epoch milliseconds of the last save, for the freshness window. */
  savedAtEpochMs: number;
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
  state: { sessionId?: string; phaseCount: number; branch: string },
  nowEpochMs: number = Date.now(),
): Promise<boolean> {
  const persisted: PersistedResumeState = {
    ...(state.sessionId !== undefined ? { sessionId: state.sessionId } : {}),
    phaseCount: state.phaseCount,
    branch: state.branch,
    savedAtEpochMs: nowEpochMs,
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
 */
export function resumeStateSurvivesRelease(
  outcome: { kind: string; message?: string } | undefined,
): boolean {
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
  return {
    ...(record.sessionId !== undefined
      ? { sessionId: record.sessionId as string }
      : {}),
    phaseCount: record.phaseCount,
    branch: record.branch,
    savedAtEpochMs: record.savedAtEpochMs,
  };
}

/**
 * Delete sibling entries whose recorded save time is outside the
 * freshness window (or that no longer parse). Keeps the directory from
 * accumulating files for issues that were never re-claimed.
 */
async function sweepStaleSiblings(
  dir: string,
  nowEpochMs: number,
): Promise<void> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
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
