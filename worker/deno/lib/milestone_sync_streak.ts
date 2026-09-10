/**
 * Per-branch milestone-sync failure streaks (Issue #4260, proposal 2).
 *
 * A milestone branch that fails to sync cycle after cycle (FLEET
 * `milestone/4064` sat 5 commits behind Develop for days) needs to become
 * visible where its owner looks — the milestone's tracking issue — not just
 * scroll past in the worker log. This persists a per-branch consecutive
 * failure count across cycles so an escalation fires once at a threshold,
 * not every cycle.
 *
 * Same shape as the merged-sweep watermark and the scan cursor (#2427): a
 * small JSON file in `WORK_DIR`, atomic tempfile-then-rename write, and a
 * missing or corrupt file reads as empty (the streak just restarts).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { atomicWrite } from "./file_utils.ts";
import {
  DEFAULT_CONFLICT_COOLDOWN_HOURS,
  DEFAULT_MAX_CONFLICT_ATTEMPTS,
} from "./pr_merge_conflict_scan.ts";

/** Consecutive failures before a needs-human escalation is posted. */
export const MILESTONE_SYNC_ESCALATION_THRESHOLD = 3;

/**
 * Concluded conflict-resolution failures a milestone branch may spend before
 * the ladder stops trying (Issue #1766).
 *
 * One constant, two consumers: this is {@link DEFAULT_MAX_CONFLICT_ATTEMPTS},
 * the budget the PR ladder spends, re-exported under the name the milestone
 * ladder reads it by. A milestone branch and a PR branch conflict for the
 * same reasons, so a divergence between the two budgets would be a bug
 * waiting to be found in production rather than a considered difference.
 */
export const MILESTONE_CONFLICT_ATTEMPT_BUDGET = DEFAULT_MAX_CONFLICT_ATTEMPTS;

/**
 * How a conflict-resolution attempt on a milestone branch ended.
 *
 * - `failed` — the merge was judged and did not produce a mergeable branch.
 *   This is the only outcome that spends the budget.
 * - `not-charged` — the attempt reached a conclusion the branch is not
 *   answerable for (a merge gate refused the push, the run stood down).
 * - `disrupted` — the run died before the conflict was judged, mirroring the
 *   PR ladder's unconcluded attempt marker (Issues #395 and #1693).
 */
export type ConflictAttemptOutcome = "failed" | "not-charged" | "disrupted";

/** The last conflict-resolution attempt on a milestone branch. */
export interface ConflictAttemptRecord {
  /** ISO timestamp of the conclusion. */
  at: string;
  /** What the attempt concluded. */
  outcome: ConflictAttemptOutcome;
  /** One line naming what the attempt tripped on. */
  reason: string;
  /** Default-branch tip the attempt merged from, when it was known. */
  defaultSha?: string;
}

/** One branch's streak state. */
export interface SyncStreakEntry {
  /** Consecutive failed sync cycles for this branch. */
  count: number;
  /** True once the needs-human comment has been posted for this streak. */
  escalated: boolean;
  /**
   * True once the merge-gate escalation has been posted for this streak
   * (Issue #974). Tracked apart from {@link escalated} so a branch that has
   * already escalated for an ordinary sync failure still reports a merge the
   * type check refused — the silence this gate exists to end.
   */
  gateEscalated?: boolean;
  /**
   * The default-branch commit whose conflicting merge has already been
   * reported (Issue #1558). Kept across a successful sync — unlike the
   * failure count — so the same conflict is reported once, while a conflict
   * against a NEW default-branch commit is reported again.
   */
  conflictEscalatedSha?: string;
  /**
   * The default-branch commit whose *unresolvable* conflict was escalated
   * with the prepared analysis (Issue #1559).
   *
   * Nothing writes it since Issue #1778: that escalation fired on the first
   * conflicting commit, before any of the three automatic attempts had been
   * spent, and the conflict budget replaced it. The field is still read and
   * carried so a `milestone_sync_failures.json` written before #1778 loads
   * unchanged rather than losing a key on the next save.
   */
  analysisEscalatedSha?: string;
  /**
   * Conflict-resolution attempts that reached a **failed** conclusion
   * (Issue #1766). Only {@link resetConflictLedgerOnSuccess} zeroes it — a
   * moved default tip does not, or a branch conflicting against a busy
   * default branch would never exhaust anything.
   */
  conflictAttempts?: number;
  /**
   * ISO timestamp of an attempt that opened and has not concluded. An open
   * attempt reads as disrupted rather than failed and is never charged,
   * mirroring the PR ladder's marker rule (Issues #395 and #1693).
   */
  attemptOpenedAt?: string;
  /** The most recent concluded attempt, whatever it concluded. */
  lastAttempt?: ConflictAttemptRecord;
  /**
   * ISO timestamp before which no further attempt is due. Set by a concluded
   * failure to now + {@link DEFAULT_CONFLICT_COOLDOWN_HOURS}, and cleared by
   * {@link recordDefaultSha} when the default tip moves — a conflict that
   * failed identically against the same tip must not be re-attempted every
   * 30-second cycle and burn the whole budget in 90 seconds.
   */
  deferUntil?: string;
  /** Default-branch tip this branch was last synced against. */
  lastSyncedDefaultSha?: string;
  /** Lifetime count of conflict resolutions rolled back on this branch. */
  rollbacks?: number;
}

/** Streak state keyed by "owner/repo|milestone-branch". */
export type SyncStreaks = Record<string, SyncStreakEntry>;

/** Resolve the streak file path for a work directory. */
export function milestoneSyncStreakPath(workDir: string): string {
  return `${workDir}/milestone_sync_failures.json`;
}

/** Load streaks; a missing or corrupt file reads as empty. */
export async function loadSyncStreaks(path: string): Promise<SyncStreaks> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const streaks: SyncStreaks = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (
          value && typeof value === "object" &&
          typeof (value as SyncStreakEntry).count === "number" &&
          Number.isFinite((value as SyncStreakEntry).count)
        ) {
          const entry = value as SyncStreakEntry;
          const sha = entry.conflictEscalatedSha;
          const analysisSha = entry.analysisEscalatedSha;
          streaks[key] = {
            count: Math.max(0, Math.floor(entry.count)),
            escalated: entry.escalated === true,
            gateEscalated: entry.gateEscalated === true,
            ...(typeof sha === "string" && sha
              ? { conflictEscalatedSha: sha }
              : {}),
            ...(typeof analysisSha === "string" && analysisSha
              ? { analysisEscalatedSha: analysisSha }
              : {}),
            // Ledger fields (Issue #1766). A file written before this change
            // has none of them, and reads as an unspent budget.
            ...readConflictLedger(entry),
          };
        }
      }
      return streaks;
    }
  } catch {
    // Missing or corrupt — start fresh.
  }
  return {};
}

/**
 * Persist streaks atomically, throwing when the write did not happen.
 *
 * `atomicWrite` reports a refused write as a failed `Result` rather than by
 * throwing, and discarding it was a silent failure: the ledger's whole point
 * is that an attempt marker survives the run that opened it, so a write
 * nobody noticed turns the next cycle's `disrupted` reading into a charged
 * failure for a conflict nobody judged. The caller decides what to do about
 * it — it must not be able to miss it.
 */
export async function saveSyncStreaks(
  path: string,
  streaks: SyncStreaks,
): Promise<void> {
  const written = await atomicWrite({
    targetFile: path,
    content: JSON.stringify(streaks, null, 2) + "\n",
  });
  if (!written.ok) throw written.error;
}

/** A non-empty string, or undefined. */
function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A non-negative whole number, or undefined when the field is absent. */
function optionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

/** The last-attempt record, or undefined when it is missing or malformed. */
function readLastAttempt(value: unknown): ConflictAttemptRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<ConflictAttemptRecord>;
  const at = optionalText(record.at);
  const outcome = record.outcome;
  if (
    at === undefined ||
    (outcome !== "failed" && outcome !== "not-charged" &&
      outcome !== "disrupted")
  ) {
    return undefined;
  }
  const defaultSha = optionalText(record.defaultSha);
  return {
    at,
    outcome,
    reason: typeof record.reason === "string" ? record.reason : "",
    ...(defaultSha ? { defaultSha } : {}),
  };
}

/**
 * Read the conflict ledger out of a persisted entry (Issue #1766).
 *
 * Every field is optional and every malformed field is dropped, so a
 * `milestone_sync_failures.json` written before this change loads as a branch
 * with an unspent budget rather than failing the whole load.
 */
function readConflictLedger(entry: SyncStreakEntry): Partial<SyncStreakEntry> {
  const attempts = optionalCount(entry.conflictAttempts);
  const rollbacks = optionalCount(entry.rollbacks);
  const openedAt = optionalText(entry.attemptOpenedAt);
  const deferUntil = optionalText(entry.deferUntil);
  const syncedSha = optionalText(entry.lastSyncedDefaultSha);
  const lastAttempt = readLastAttempt(entry.lastAttempt);
  return {
    ...(attempts !== undefined ? { conflictAttempts: attempts } : {}),
    ...(openedAt ? { attemptOpenedAt: openedAt } : {}),
    ...(lastAttempt ? { lastAttempt } : {}),
    // An unparseable deferral is kept, not dropped: dropping it would read a
    // corrupt value as "no cooldown applies", which is the permissive
    // direction on a safety bound. `isConflictAttemptDue` refuses it instead,
    // and the next tip move clears it.
    ...(deferUntil ? { deferUntil } : {}),
    ...(syncedSha ? { lastSyncedDefaultSha: syncedSha } : {}),
    ...(rollbacks !== undefined ? { rollbacks } : {}),
  };
}

/**
 * Drop `deferUntil` when `defaultSha` is a tip the deferral was not set
 * against (Issue #1766).
 *
 * The invariant every writer keeps: a live `deferUntil` always paces the
 * branch against the tip in `lastAttempt.defaultSha`. Any observation of a
 * different tip — a sync recording it, or a later attempt concluding against
 * it — is what clears the deferral, because the conflict being paced is no
 * longer the conflict in front of the branch.
 *
 * Only a tip that has been seen before can be observed to have moved: with no
 * recorded tip the deferral stands, since dropping it would hand the branch
 * straight back and spend the whole budget inside one cooldown.
 */
function clearDeferralIfTipMoved(
  entry: SyncStreakEntry,
  defaultSha: string | undefined,
): SyncStreakEntry {
  const previous = entry.lastSyncedDefaultSha ?? entry.lastAttempt?.defaultSha;
  if (
    defaultSha === undefined || previous === undefined ||
    previous === defaultSha
  ) {
    return entry;
  }
  const { deferUntil: _deferred, ...rest } = entry;
  return rest;
}

/**
 * Record that a conflict-resolution attempt has started (Issue #1766).
 *
 * Opening charges nothing. An attempt that never concludes stays open, reads
 * as disrupted on the next cycle, and leaves the budget where it was — the
 * PR ladder's rule for an attempt marker with no conclusion (#395, #1693),
 * applied to a milestone branch.
 */
export function openConflictAttempt(
  entry: SyncStreakEntry,
  nowMs: number = Date.now(),
): SyncStreakEntry {
  return { ...entry, attemptOpenedAt: new Date(nowMs).toISOString() };
}

/**
 * Conclude the open attempt, charging the budget only for a real failure
 * (Issue #1766).
 *
 * A `failed` conclusion spends one attempt and defers the branch for
 * {@link DEFAULT_CONFLICT_COOLDOWN_HOURS}; `not-charged` and `disrupted`
 * conclusions record what happened and spend nothing.
 *
 * @param entry - The branch's streak entry.
 * @param outcome - What the attempt concluded.
 * @param reason - One line naming what it tripped on.
 * @param defaultSha - Default-branch tip the attempt merged from.
 * @param nowMs - Conclusion time in epoch milliseconds.
 */
export function concludeConflictAttempt(
  entry: SyncStreakEntry,
  outcome: ConflictAttemptOutcome,
  reason: string,
  defaultSha?: string,
  nowMs: number = Date.now(),
): SyncStreakEntry {
  const { attemptOpenedAt: _opened, ...rest } = entry;
  const charged = outcome === "failed";
  const paced = charged
    ? rest
    // An uncharged conclusion against a tip the failure never saw is an
    // observation that the tip has moved, so it clears the deferral the same
    // way `recordDefaultSha` does. Without this the ledger would keep pacing
    // the branch against a conflict that no longer exists.
    : clearDeferralIfTipMoved(rest, defaultSha);
  return {
    ...paced,
    conflictAttempts: (entry.conflictAttempts ?? 0) + (charged ? 1 : 0),
    lastAttempt: {
      at: new Date(nowMs).toISOString(),
      outcome,
      reason,
      ...(defaultSha ? { defaultSha } : {}),
    },
    ...(charged
      ? {
        deferUntil: new Date(
          nowMs + DEFAULT_CONFLICT_COOLDOWN_HOURS * 3600_000,
        ).toISOString(),
      }
      : {}),
  };
}

/**
 * Whether this branch has spent its conflict budget (Issue #1766).
 *
 * Counts concluded failures only — an attempt that is still open has judged
 * nothing, so it cannot exhaust anything.
 */
export function isConflictBudgetExhausted(
  entry: SyncStreakEntry,
  budget: number = MILESTONE_CONFLICT_ATTEMPT_BUDGET,
): boolean {
  return (entry.conflictAttempts ?? 0) >= budget;
}

/**
 * Whether another conflict-resolution attempt is due (Issue #1766).
 *
 * Due when the default tip has moved since the last concluded attempt — the
 * conflict is a different one now — or when the deferral set by that
 * attempt's failure has passed. An unparseable `deferUntil` reads as "still
 * running", the conservative direction the PR ladder takes for an
 * unparseable attempt timestamp: guessing the other way re-attempts every
 * pass.
 *
 * @param entry - The branch's streak entry.
 * @param currentDefaultSha - Default-branch tip as it stands now.
 * @param nowMs - Current time in epoch milliseconds.
 */
export function isConflictAttemptDue(
  entry: SyncStreakEntry,
  currentDefaultSha: string,
  nowMs: number = Date.now(),
): boolean {
  const lastSha = entry.lastAttempt?.defaultSha;
  if (lastSha !== undefined && lastSha !== currentDefaultSha) return true;
  if (entry.deferUntil === undefined) return true;
  const until = Date.parse(entry.deferUntil);
  if (Number.isNaN(until)) return false;
  return nowMs >= until;
}

/**
 * Record the default-branch tip this branch has been measured against
 * (Issue #1766).
 *
 * A moved tip clears the deferral — the conflict to be resolved is a new one,
 * so waiting out a cooldown set for the old one helps nobody — but it never
 * touches {@link SyncStreakEntry.conflictAttempts}. A busy default branch
 * would otherwise refill the budget faster than the ladder could spend it,
 * and a genuinely unresolvable conflict would retry forever.
 */
export function recordDefaultSha(
  entry: SyncStreakEntry,
  defaultSha: string,
): SyncStreakEntry {
  return {
    ...clearDeferralIfTipMoved(entry, defaultSha),
    lastSyncedDefaultSha: defaultSha,
  };
}

/**
 * Zero the conflict ledger after a successful sync (Issue #1766).
 *
 * Success is the only thing that refills the budget: the conflict this branch
 * was spending attempts on is over. The lifetime {@link
 * SyncStreakEntry.rollbacks} count, the last synced tip and the
 * {@link SyncStreakEntry.lastAttempt} audit record survive — they describe
 * the branch's history, not the budget that has just been refilled.
 */
export function resetConflictLedgerOnSuccess(
  entry: SyncStreakEntry,
): SyncStreakEntry {
  const { attemptOpenedAt: _opened, deferUntil: _deferred, ...rest } = entry;
  return { ...rest, conflictAttempts: 0 };
}

/**
 * Extract the tracking-issue number a milestone title leads with
 * (e.g. `#3648 Learn stage fails…` → 3648). Milestone titles in this fleet
 * are named for the issue that tracks them; returns null when none leads.
 */
export function trackingIssueFromMilestoneTitle(title: string): number | null {
  const match = title.trim().match(/^#(\d+)\b/);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
