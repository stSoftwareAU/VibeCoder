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
import { DEFAULT_MAX_CONFLICT_ATTEMPTS } from "./pr_merge_conflict_scan.ts";

/** Consecutive failures before a needs-human escalation is posted. */
export const MILESTONE_SYNC_ESCALATION_THRESHOLD = 3;

/**
 * Whether this cycle's concluded reason repeats the previous cycle's
 * (Issue #1964).
 *
 * A branch whose failure reason has not changed is not making progress: the
 * fleet watched `milestone/168-…` spend four cycles, and four agent runs, on
 * one identical line before anyone was told. An identical repeat is therefore
 * escalated on its second occurrence rather than at
 * {@link MILESTONE_SYNC_ESCALATION_THRESHOLD}.
 *
 * "The previous cycle" means the previous **failing** cycle in an unbroken
 * run of them. {@link SyncStreakEntry.lastAttempt} survives a success on
 * purpose — it is the audit record — so the caller passes `failureCount`,
 * this cycle's consecutive-failure count, and a branch that failed, synced,
 * then failed the same way again reads as the first failure it is.
 *
 * @param entry - The branch's streak entry, before this cycle concludes
 * @param reason - The reason this cycle concluded with
 * @param failureCount - Consecutive failures including this cycle's
 */
export function isRepeatedFailureReason(
  entry: SyncStreakEntry,
  reason: string,
  failureCount: number,
): boolean {
  if (failureCount < 2) return false;
  const previous = entry.lastAttempt?.reason;
  return typeof previous === "string" && previous.length > 0 &&
    previous === reason;
}

/**
 * Concluded conflict-resolution failures a milestone branch may spend before
 * the ladder stops trying (Issue #1766), with no wait between them
 * (Issue #2305).
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
   * The default-branch commit whose resolution the **verification refused**,
   * escalated with the prepared analysis (Issues #1559 and #1778).
   *
   * Issue #1778 narrowed what it records. It used to key the escalation for a
   * conflict *no rung could settle*, which fired before any of the three
   * automatic attempts had been spent — the conflict budget replaced that
   * outright. What is left is the gate refusal: the worker made the
   * resolution and the verification said no, which no retry clears, so it is
   * reported once per commit. Tracked apart from {@link gateEscalated} so an
   * Issue #974 refusal of the *merged tree* cannot suppress it, or the
   * reverse.
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
  /** Default-branch tip this branch was last synced against. */
  lastSyncedDefaultSha?: string;
  /**
   * The milestone branch's own tip at its last successful sync
   * (Issue #2285). A child PR landing moves it; the cadence guard reads a
   * moved milestone as a reason to sync again, so a sync PR that a child
   * made stale or conflicting is refreshed on the next cycle rather than
   * when the default branch happens to move.
   */
  lastSyncedMilestoneSha?: string;
  /** Lifetime count of conflict resolutions rolled back on this branch. */
  rollbacks?: number;
  /** Child PR numbers a roll-back has already reverted (Issue #1781). */
  revertedPrs?: number[];
  /** Merge SHAs those roll-backs undid (Issue #1781). */
  revertedShas?: string[];
}

/** Streak state keyed by "owner/repo|milestone-branch". */
export type SyncStreaks = Record<string, SyncStreakEntry>;

/**
 * The ledger key one branch is recorded under (Issue #1780).
 *
 * Every reader and writer of `milestone_sync_failures.json` — the periodic
 * sweep and the child run's pre-cut sync — must key a branch identically, so
 * the key is spelled once, here, beside the ledger it keys.
 *
 * @param repo - Repository in `owner/repo` form
 * @param milestoneBranch - The milestone branch name
 */
export function syncStreakKey(repo: string, milestoneBranch: string): string {
  return `${repo}|${milestoneBranch}`;
}

/** Resolve the streak file path for a work directory. */
export function milestoneSyncStreakPath(workDir: string): string {
  return `${workDir}/milestone_sync_failures.json`;
}

/**
 * Where the sync left off when its budget ran out (Issue #2215).
 *
 * The sync is one handler under one watchdog, and a pass over every
 * repository's milestones does not always fit the cycle that is left — on
 * GRQ-23 a pass started 13 minutes before the cycle end was abandoned
 * mid-way, silently, and the next cycle started over from the first
 * repository, so the milestones at the end of the list were never reached.
 * The cursor names the repository (and branch) the next cycle starts from.
 */
export interface SyncCursor {
  repo: string;
  milestoneBranch?: string;
}

/** Path of the per-host sync cursor (Issue #2215). */
export function milestoneSyncCursorPath(workDir: string): string {
  return `${workDir}/milestone_sync_cursor.json`;
}

/** Load the cursor; a missing or corrupt file reads as none. */
export async function loadSyncCursor(path: string): Promise<SyncCursor | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path)) as unknown;
    if (
      parsed && typeof parsed === "object" &&
      typeof (parsed as SyncCursor).repo === "string" &&
      (parsed as SyncCursor).repo.includes("/")
    ) {
      const branch = (parsed as SyncCursor).milestoneBranch;
      return {
        repo: (parsed as SyncCursor).repo,
        ...(typeof branch === "string" && branch
          ? { milestoneBranch: branch }
          : {}),
      };
    }
  } catch {
    // Absent or unreadable: the pass starts from the top.
  }
  return null;
}

/** Save the cursor, best-effort. */
export async function saveSyncCursor(
  path: string,
  cursor: SyncCursor,
): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(cursor, null, 2) + "\n");
}

/** Remove the cursor once a pass completes; a missing file is fine. */
export async function clearSyncCursor(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/**
 * Load streaks; a missing or corrupt file reads as empty.
 *
 * Every field is named here, so a `deferUntil` an older worker wrote is
 * dropped on load rather than pacing a branch against a cooldown that no
 * longer exists (Issue #2305).
 */
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
  const syncedSha = optionalText(entry.lastSyncedDefaultSha);
  const syncedMilestoneSha = optionalText(entry.lastSyncedMilestoneSha);
  const lastAttempt = readLastAttempt(entry.lastAttempt);
  const revertedPrs = readPositiveInts(entry.revertedPrs);
  const revertedShas = readShaList(entry.revertedShas);
  return {
    ...(attempts !== undefined ? { conflictAttempts: attempts } : {}),
    ...(openedAt ? { attemptOpenedAt: openedAt } : {}),
    ...(lastAttempt ? { lastAttempt } : {}),
    ...(syncedSha ? { lastSyncedDefaultSha: syncedSha } : {}),
    ...(syncedMilestoneSha
      ? { lastSyncedMilestoneSha: syncedMilestoneSha }
      : {}),
    ...(rollbacks !== undefined ? { rollbacks } : {}),
    ...(revertedPrs !== undefined ? { revertedPrs } : {}),
    ...(revertedShas !== undefined ? { revertedShas } : {}),
  };
}

/** A list of positive integers, or undefined when the field is absent. */
function readPositiveInts(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.filter((n): n is number =>
    typeof n === "number" && Number.isInteger(n) && n > 0
  );
  return numbers;
}

/** A list of hex SHAs, or undefined when the field is absent. */
function readShaList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((s): s is string =>
    typeof s === "string" && /^[0-9a-f]{7,40}$/i.test(s)
  );
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
 * A `failed` conclusion spends one attempt of the branch's two and nothing
 * else — no deferral is written, so the next attempt is due on the very next
 * cycle (Issue #2305). `not-charged` and `disrupted` conclusions record what
 * happened and spend nothing.
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
  return {
    ...rest,
    conflictAttempts: (entry.conflictAttempts ?? 0) + (charged ? 1 : 0),
    lastAttempt: {
      at: new Date(nowMs).toISOString(),
      outcome,
      reason,
      ...(defaultSha ? { defaultSha } : {}),
    },
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
 * Whether another conflict-resolution attempt is due — that is, whether no
 * attempt is open on this branch (Issue #2305).
 *
 * There is no deferral to wait out any more: a charged failure spends one of
 * the branch's two attempts and the next one is due immediately. What is left
 * is the open-attempt marker, and a marker still open is a run this host has
 * not concluded yet. A sibling host's attempt is refused by the sync claim
 * (`milestone_sync_claim.ts`), not by this ledger, which is host-local.
 *
 * @param entry - The branch's streak entry.
 */
export function isConflictAttemptDue(entry: SyncStreakEntry): boolean {
  return entry.attemptOpenedAt === undefined;
}

/**
 * Record the default-branch tip this branch has been measured against
 * (Issue #1766).
 *
 * It never touches {@link SyncStreakEntry.conflictAttempts}: a busy default
 * branch would otherwise refill the budget faster than the ladder could spend
 * it, and a genuinely unresolvable conflict would retry forever.
 */
export function recordDefaultSha(
  entry: SyncStreakEntry,
  defaultSha: string,
): SyncStreakEntry {
  return { ...entry, lastSyncedDefaultSha: defaultSha };
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
  const { attemptOpenedAt: _opened, ...rest } = entry;
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
