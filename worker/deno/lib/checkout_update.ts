/**
 * Host-side worker-checkout update and its crash-loop escalation
 * (Issues #512, #513, #4204).
 *
 * The worker checkout used to be updated from *inside* the container by the
 * bootstrap prelude's git reset, which made the in-container process the last
 * intentional writer to `/workspace` and forced that mount to stay read-write.
 * Issue #512 moved the update to the host; Issue #513 retired the in-container
 * reset and brought its consecutive-failure escalation across with it — the
 * diagnosis ("active development tree"), the streak file and the control-plane
 * escalation are all about the *checkout*, so they live beside the code that
 * now updates it.
 *
 * {@link updateCheckout} performs the update sequence — `git fetch origin` →
 * `git checkout <branch>` → `git reset --hard origin/<branch>` →
 * `git clean -fd` — and, on failure, enriches the error, counts the streak in
 * `<logDir>/checkout-update-failure-streak`, and raises exactly one GitHub
 * issue per streak once {@link CHECKOUT_UPDATE_ESCALATION_THRESHOLD}
 * consecutive failures are reached. A success resets the streak to zero.
 *
 * That escalation used to fire at the single run where the streak *equalled*
 * the threshold, and its transport — `gh issue create` against
 * `api.github.com` — needs the network whose loss is the dominant cause of the
 * streak. So the one observed firing threw and was lost for ever (Issue
 * #1018). It is now re-armed and queued: delivery is attempted on every
 * failing run at or above the threshold until one attempt lands, the
 * escalated-at marker is recorded **only** on success, and evidence that could
 * not be sent is spooled in `<logDir>/checkout-update-escalation` — one entry
 * per streak, overwritten — so the next run with connectivity delivers it. The
 * run that recovers is usually that run, and it flushes the queue marked as an
 * outage that has since ended; the spool is then cleared with the streak,
 * whatever became of that send, because a queued report must never outlive the
 * condition it describes.
 *
 * Under `update_mode: "frozen"` (Issue #624, part of #583) the sequence above
 * would defeat the pin, so the checkout is held at `pinned_ref` instead: fetch
 * (so a newly pushed tag resolves), then `git checkout --detach <ref>` →
 * `git reset --hard <ref>` → `git clean -fd`, and nothing at all when `HEAD`
 * already resolves to that ref. The skip is logged, never silent, and a ref
 * that does not resolve is a fail-loud failure counted in the same streak.
 *
 * An update that actually changed the checkout — moved the commit, or
 * discarded uncommitted work — names {@link SKIP_CHECKOUT_UPDATE_ENV} in
 * {@link checkoutOverwriteNotice} (Issue #735). The opt-out has existed since
 * Issue #512 and is documented across the guides, and an operator debugging
 * launcher defects on a new platform still burned a cycle re-applying a patch
 * the next launch discarded: the moment that discards the work is the moment
 * that names the way to prevent it. An update that changed nothing is silent.
 *
 * Every side effect flows through {@link CheckoutUpdateDeps} so the behaviour
 * can be unit-tested without touching git, the filesystem, or GitHub.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import type { Result, UpdateMode } from "../types.ts";
import { DEFAULT_UPDATE_MODE } from "./config_defaults.ts";
import { atomicWrite } from "./file_utils.ts";
import { runGitCommand } from "./git_timeout.ts";
import {
  appendRunCoreLogLine,
  resolveOriginDefaultBranch,
} from "./run_bootstrap.ts";
import {
  escalationHostId,
  fileOrCommentIssue,
  parseOriginRepo,
  resolveEscalationGhEnv,
  resolveOriginRepo,
} from "./host_escalation.ts";

// Re-exported for the callers and tests that knew this helper by its old
// home; the channel itself now lives in host_escalation.ts (Issue #556).
export { parseOriginRepo };

/**
 * Consecutive update failures before the host escalates through the control
 * plane (Issue #4204). One transient blip stays a log line; a crash-loop
 * becomes a GitHub issue the operator actually sees — the observed failure
 * mode was a worker silently running week-old code because its checkout was
 * occupied by interactive development work.
 */
export const CHECKOUT_UPDATE_ESCALATION_THRESHOLD = 3;

/**
 * Environment variable that turns the checkout update off (Issue #735).
 *
 * The single source of truth: the command re-exports this name, and the
 * operator-facing notice below is built from it, so the variable an update
 * advertises can never drift from the one it reads.
 */
export const SKIP_CHECKOUT_UPDATE_ENV = "VIBE_SKIP_CHECKOUT_UPDATE";

/** File under the log directory persisting the consecutive-failure count. */
export const CHECKOUT_UPDATE_FAILURE_STREAK_FILE =
  "checkout-update-failure-streak";

/**
 * File beside the streak holding the escalation marker and the spool (Issue
 * #1018) — a single JSON object, so one entry per streak is the shape of the
 * store rather than a convention a directory of files could drift from.
 */
export const CHECKOUT_UPDATE_ESCALATION_SPOOL_FILE =
  "checkout-update-escalation";

/** What the worker checkout looks like, for collision diagnosis (#4204). */
export interface CheckoutState {
  /** Currently checked-out branch (or `HEAD` when detached). */
  branch: string;
  /** Number of uncommitted paths reported by `git status --porcelain`. */
  dirtyFiles: number;
}

/** Everything the escalation hook needs to name the failure (#4204). */
export interface CheckoutUpdateEscalationContext {
  /** The worker checkout that could not be updated. */
  repoDir: string;
  /** Worker log directory (for any escalation-side logging). */
  logDir: string;
  /** Consecutive failures, including this one. */
  streak: number;
  /** The enriched failure detail. */
  error: string;
  /** Checkout state at failure time, when it could be read. */
  checkout: CheckoutState | null;
  /**
   * ISO-8601 time the first undelivered attempt was made, when this report
   * comes off the spool (Issue #1018); undefined for a first-attempt report.
   * The issue body says so, so a late report is never read as a fresh one.
   */
  spooledAt?: string;
  /**
   * True when this report is flushed by a run that updated cleanly (Issue
   * #1018) — the outage is over, and the body says so, so a report that
   * arrives after the fact is never read as a live one.
   */
  recovered?: boolean;
}

/**
 * Evidence of an escalation that could not be delivered (Issue #1018). Each
 * further failed attempt in the same streak overwrites the evidence — the
 * newest failure is the one worth reporting — while keeping the timestamp of
 * the first, so the report says how long the host has been unable to speak.
 */
export interface SpooledCheckoutEscalation {
  /** The worker checkout that could not be updated. */
  repoDir: string;
  /** Consecutive failures as at the most recent failed attempt. */
  streak: number;
  /** The enriched failure detail of the most recent failed attempt. */
  error: string;
  /** Checkout state at that failure, when it could be read. */
  checkout: CheckoutState | null;
  /** ISO-8601 time of the **first** delivery attempt that failed. */
  spooledAt: string;
}

/**
 * What the host knows about escalating the streak it is currently in (Issue
 * #1018). Cleared — the file removed — whenever a successful update ends the
 * streak.
 */
export interface CheckoutEscalationState {
  /**
   * The streak an escalation was **successfully delivered** for; 0 when none
   * has been. Non-zero is what keeps the rest of the streak quiet, so a send
   * that threw leaves the streak eligible for the next run to retry.
   */
  escalatedStreak: number;
  /** The single queued report awaiting connectivity, or null. */
  pending: SpooledCheckoutEscalation | null;
}

/** Nothing escalated, nothing queued. */
function emptyEscalationState(): CheckoutEscalationState {
  return { escalatedStreak: 0, pending: null };
}

/** Inputs to a single checkout update. */
export interface CheckoutUpdateOptions {
  /** The checkout to update. */
  repoDir: string;
  /** Directory holding worker logs (`pull.log`, `run_core.log`, the streak). */
  logDir: string;
  /**
   * Branch to update to. Omitted, it is resolved from the checkout's own
   * `origin/HEAD` (see {@link resolveOriginDefaultBranch}).
   */
  defaultBranch?: string;
  /**
   * How this host tracks releases (Issue #624). Omitted means `dynamic`, so a
   * caller that knows nothing about update modes behaves exactly as before.
   */
  updateMode?: UpdateMode;
  /** The commit SHA or tag the checkout is held at under `frozen`. */
  pinnedRef?: string;
}

/** Outcome of a single checkout update. */
export interface CheckoutUpdateOutcome {
  /** Whether the checkout is now where this host's update mode says it is. */
  ok: boolean;
  /** The branch updated to; "" when frozen, or when it could not be resolved. */
  branch: string;
  /** The mode the update ran in. */
  mode: UpdateMode;
  /** The pinned ref the checkout was held at; "" outside `frozen` mode. */
  ref: string;
  /** Enriched failure detail when {@link ok} is false. */
  error?: string;
  /**
   * The operator-facing line naming the opt-out, emitted when this update
   * actually changed the checkout (Issue #735); "" when it changed nothing.
   */
  overwriteNotice: string;
  /** Consecutive failures including this one; 0 after a success. */
  streak: number;
  /** Whether this failure raised the control-plane escalation. */
  escalated: boolean;
}

/** Injectable side effects, so the behaviour is testable end to end. */
export interface CheckoutUpdateDeps {
  /** Resolve the checkout's default branch from `origin/HEAD`. */
  resolveDefaultBranch(repoDir: string): Promise<Result<string>>;
  /** Update the checkout to `origin/<branch>`; fail-loud on any git failure. */
  resetToDefaultBranch(
    repoDir: string,
    branch: string,
    logDir: string,
  ): Promise<Result<void>>;
  /**
   * Fetch `origin` including tags (Issue #624), so a ref pushed since the last
   * launch can be resolved. Fail-loud on any git failure.
   */
  fetchOrigin(repoDir: string, logDir: string): Promise<Result<void>>;
  /**
   * Resolve a ref to its commit SHA in the checkout, or `null` when it does
   * not resolve there (Issue #624). Used both to detect a bad `pinned_ref` and
   * to skip the git writes when the checkout is already on the pin.
   */
  resolveCommit(repoDir: string, ref: string): Promise<string | null>;
  /** The commit `HEAD` resolves to, or `null` when it cannot be read. */
  readHeadCommit(repoDir: string): Promise<string | null>;
  /**
   * Hold the checkout at the pinned ref (Issue #624) — a detached checkout of
   * the ref, a hard reset to it, and a clean. Fail-loud on any git failure.
   */
  checkoutPinnedRef(
    repoDir: string,
    ref: string,
    logDir: string,
  ): Promise<Result<void>>;
  /**
   * Describe the checkout for collision diagnosis (Issue #4204). Best-effort:
   * `null` when the state cannot be read — diagnosis is enrichment, never a
   * new failure mode.
   */
  describeCheckoutState(repoDir: string): Promise<CheckoutState | null>;
  /** Read the persisted consecutive-failure count (0 when absent). */
  readFailureStreak(logDir: string): Promise<number>;
  /** Persist the consecutive-failure count. */
  writeFailureStreak(logDir: string, count: number): Promise<void>;
  /**
   * Read the escalation marker and spool (Issue #1018). An absent or
   * unreadable store reads as {@link emptyEscalationState}: the worst that
   * costs is one duplicate attempt, which the deduplicated escalation channel
   * folds into the open issue — a lost alert has no such recovery.
   */
  readEscalationState(logDir: string): Promise<CheckoutEscalationState>;
  /**
   * Persist the escalation marker and spool (Issue #1018). An empty state
   * removes the file, so "the streak reset" and "nothing is queued" are the
   * same observable fact.
   */
  writeEscalationState(
    logDir: string,
    state: CheckoutEscalationState,
  ): Promise<void>;
  /**
   * Raise the crash-loop through the control plane (Issue #4204) — the
   * default files (or comments on) a deduplicated GitHub issue against the
   * checkout's origin repository. Best-effort: a throw is logged and never
   * masks the underlying update failure.
   */
  escalate(context: CheckoutUpdateEscalationContext): Promise<void>;
  /** Append a timestamped line to `run_core.log`. */
  log(logDir: string, message: string): Promise<void>;
}

/** Append a single line (newline-terminated) to a file, creating it if absent. */
async function appendLine(filePath: string, line: string): Promise<void> {
  await Deno.writeTextFile(filePath, `${line}\n`, { append: true });
}

/**
 * The update sequence, unchanged from the prelude's:
 *   git fetch origin && git checkout <branch> &&
 *   git reset --hard origin/<branch> && git clean -fd
 *
 * Output is appended to `pull.log` **under the log directory**, which is a
 * mounted host directory — never the checkout. The first failing command
 * short-circuits and returns a fail-loud error (Issue #3234).
 */
export function resetCheckoutToDefaultBranch(
  repoDir: string,
  branch: string,
  logDir: string,
): Promise<Result<void>> {
  return runGitSteps(repoDir, logDir, [
    ["fetch", "origin"],
    ["checkout", branch],
    ["reset", "--hard", `origin/${branch}`],
    ["clean", "-fd"],
  ]);
}

/**
 * Fetch `origin` with its tags (Issue #624).
 *
 * Frozen mode fetches before resolving the pin, because a tag pushed since the
 * last launch does not exist in the checkout until it is fetched. `--tags` is
 * what separates this from the dynamic path's plain fetch: a pin is far more
 * often a tag than a branch tip.
 */
export function fetchOrigin(
  repoDir: string,
  logDir: string,
): Promise<Result<void>> {
  return runGitSteps(repoDir, logDir, [["fetch", "--tags", "origin"]]);
}

/**
 * Hold the checkout at `ref` (Issue #624): a detached checkout of the ref, a
 * hard reset to it, then a clean.
 *
 * `--detach` is deliberate — the pin is a commit SHA or a tag, and the
 * checkout is meant to sit exactly on it rather than on a branch that will
 * move under it. `--force` is what makes a dirty checkout land on the pin
 * instead of refusing the launch; as in the dynamic path, uncommitted work in
 * the checkout is discarded.
 */
export function checkoutPinnedRef(
  repoDir: string,
  ref: string,
  logDir: string,
): Promise<Result<void>> {
  return runGitSteps(repoDir, logDir, [
    ["checkout", "--force", "--detach", ref],
    ["reset", "--hard", ref],
    ["clean", "-fd"],
  ]);
}

/**
 * Run a git sequence in the checkout, appending output to `pull.log` **under
 * the log directory** — a mounted host directory, never the checkout. The
 * first failing command short-circuits with a fail-loud error (Issue #3234).
 */
async function runGitSteps(
  repoDir: string,
  logDir: string,
  steps: string[][],
): Promise<Result<void>> {
  const pullLog = `${logDir}/pull.log`;

  for (const args of steps) {
    const result = await runGitCommand(args, { cwd: repoDir });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const { code, stdout, stderr } = result.value;
    const output = `${stdout}${stderr}`;
    if (output.length > 0) {
      try {
        await appendLine(pullLog, output.replace(/\n$/, ""));
      } catch {
        // Best-effort logging — never masks the git outcome.
      }
    }
    if (code !== 0) {
      return {
        ok: false,
        error: new Error(
          `git ${args.join(" ")} failed (exit code ${code}): ${
            stderr.trim() || stdout.trim()
          }`,
        ),
      };
    }
  }

  return { ok: true, value: undefined };
}

/**
 * Resolve `ref` to the commit it names in the checkout (Issue #624).
 *
 * `null` means the ref does not resolve there — the bad-pin case the frozen
 * path fails loudly on. `^{commit}` peels an annotated tag, so a tag and the
 * SHA it points at compare equal.
 */
export async function resolveRefCommit(
  repoDir: string,
  ref: string,
): Promise<string | null> {
  const result = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: repoDir },
  );
  if (!result.ok || result.value.code !== 0) return null;
  const sha = result.value.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/** The commit `HEAD` names, or `null` when it cannot be read (Issue #624). */
export function readHeadCommit(repoDir: string): Promise<string | null> {
  return resolveRefCommit(repoDir, "HEAD");
}

/**
 * Read the checkout's branch and dirty-file count (Issue #4204). Best-effort:
 * any git failure returns `null` — diagnosis must never add a failure mode.
 */
export async function describeCheckoutState(
  repoDir: string,
): Promise<CheckoutState | null> {
  try {
    const branchResult = await runGitCommand(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoDir },
    );
    if (!branchResult.ok || branchResult.value.code !== 0) return null;
    const statusResult = await runGitCommand(["status", "--porcelain"], {
      cwd: repoDir,
    });
    if (!statusResult.ok || statusResult.value.code !== 0) return null;
    const dirtyFiles = statusResult.value.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .length;
    return { branch: branchResult.value.stdout.trim(), dirtyFiles };
  } catch {
    return null;
  }
}

/** What a checkout looked like at one moment (Issue #735). */
export interface CheckoutSnapshot {
  /** The commit `HEAD` named, or `null` when it could not be read. */
  head: string | null;
  /** Uncommitted paths, or `null` when the state could not be read. */
  dirtyFiles: number | null;
}

/**
 * Describe the checkout as it is now (Issue #735).
 *
 * Both dependencies are documented as best-effort — they report an unreadable
 * checkout as `null` rather than throwing — so this reads them exactly as the
 * frozen path does, and an unreadable state stays `null` all the way into
 * {@link checkoutOverwriteNotice}, which then says nothing rather than guessing.
 */
async function snapshotCheckout(
  deps: CheckoutUpdateDeps,
  repoDir: string,
): Promise<CheckoutSnapshot> {
  const head = await deps.readHeadCommit(repoDir);
  const state = await deps.describeCheckoutState(repoDir);
  return { head, dirtyFiles: state?.dirtyFiles ?? null };
}

/** Enough of a commit to recognise it in a log line. */
function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/**
 * The line an update prints when it changed the checkout (Issue #735).
 *
 * The opt-out has existed since Issue #512 and is documented across the guides,
 * but an operator hitting launcher defects on a new platform never found it —
 * they re-applied a local patch that the next launch discarded again. So the
 * moment that discards the work is the moment that names the way to prevent
 * it, on stderr and in `run_core.log`.
 *
 * Only an observed change speaks: a checkout that came out exactly where it
 * went in — or whose state could not be read — returns "". A host already on
 * the tip therefore says nothing; one that moved onto new commits says what
 * moved, which is the same event that would have taken a local patch with it.
 *
 * @param repoDir - The checkout the update ran against
 * @param before - Its state before the update
 * @param after - Its state after the update
 * @returns The operator-facing line, or "" when nothing was overwritten
 */
export function checkoutOverwriteNotice(
  repoDir: string,
  before: CheckoutSnapshot,
  after: CheckoutSnapshot,
): string {
  const changes: string[] = [];
  if (
    before.head !== null && after.head !== null && before.head !== after.head
  ) {
    changes.push(`HEAD ${shortSha(before.head)} → ${shortSha(after.head)}`);
  }
  if (
    before.dirtyFiles !== null && after.dirtyFiles !== null &&
    after.dirtyFiles < before.dirtyFiles
  ) {
    changes.push(
      `${before.dirtyFiles - after.dirtyFiles} uncommitted change(s) discarded`,
    );
  }
  if (changes.length === 0) return "";

  return `The checkout update changed ${repoDir} (${changes.join("; ")}). ` +
    `Local edits in this checkout do not survive a launch — set ` +
    `${SKIP_CHECKOUT_UPDATE_ENV}=1 to leave it exactly as it is.`;
}

/** Path of the persisted consecutive-failure count. */
function streakFilePath(logDir: string): string {
  return `${logDir}/${CHECKOUT_UPDATE_FAILURE_STREAK_FILE}`;
}

/** Read the persisted streak; absent or unreadable reads as zero. */
async function defaultReadFailureStreak(logDir: string): Promise<number> {
  try {
    const text = await Deno.readTextFile(streakFilePath(logDir));
    const parsed = Number.parseInt(text.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Persist the streak. Best-effort — a write failure only loses the count. */
async function defaultWriteFailureStreak(
  logDir: string,
  count: number,
): Promise<void> {
  try {
    await Deno.mkdir(logDir, { recursive: true });
    await Deno.writeTextFile(streakFilePath(logDir), `${count}\n`);
  } catch {
    // Best-effort persistence.
  }
}

/** Path of the escalation marker and spool (Issue #1018). */
function escalationSpoolPath(logDir: string): string {
  return `${logDir}/${CHECKOUT_UPDATE_ESCALATION_SPOOL_FILE}`;
}

/** A spool entry read back off disk, or null when the record is not one. */
function parseSpooledEscalation(
  value: unknown,
): SpooledCheckoutEscalation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { repoDir, streak, error, spooledAt } = record;
  if (
    typeof repoDir !== "string" || typeof error !== "string" ||
    typeof spooledAt !== "string" || typeof streak !== "number" ||
    !Number.isFinite(streak)
  ) {
    return null;
  }
  const rawCheckout = record["checkout"];
  let checkout: CheckoutState | null = null;
  if (
    typeof rawCheckout === "object" && rawCheckout !== null &&
    !Array.isArray(rawCheckout)
  ) {
    const state = rawCheckout as Record<string, unknown>;
    if (
      typeof state["branch"] === "string" &&
      typeof state["dirtyFiles"] === "number"
    ) {
      checkout = {
        branch: state["branch"],
        dirtyFiles: state["dirtyFiles"],
      };
    }
  }
  return { repoDir, streak, error, checkout, spooledAt };
}

/**
 * Read the escalation marker and spool (Issue #1018).
 *
 * Anything that stops the file meaning what it says — absent, unreadable,
 * malformed — reads as "nothing escalated, nothing queued". That is the safe
 * direction: it re-attempts an escalation the deduplicated channel folds into
 * the issue already open, rather than silencing a host running stale code.
 */
async function defaultReadEscalationState(
  logDir: string,
): Promise<CheckoutEscalationState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(escalationSpoolPath(logDir)));
  } catch {
    return emptyEscalationState();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return emptyEscalationState();
  }
  const record = parsed as Record<string, unknown>;
  const marker = record["escalatedStreak"];
  return {
    escalatedStreak: typeof marker === "number" && Number.isFinite(marker) &&
        marker > 0
      ? marker
      : 0,
    pending: parseSpooledEscalation(record["pending"]),
  };
}

/**
 * Persist the escalation marker and spool (Issue #1018).
 *
 * Fail-loud: a store that could not be written is thrown, because the caller
 * would otherwise log "spooled for the next run" over evidence that is not
 * anywhere — a claim of success for something that failed. The caller catches,
 * says so, and carries on; the update failure itself is never masked. A file
 * that was already absent is not a failure to remove.
 */
async function defaultWriteEscalationState(
  logDir: string,
  state: CheckoutEscalationState,
): Promise<void> {
  const path = escalationSpoolPath(logDir);
  if (state.escalatedStreak === 0 && state.pending === null) {
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return;
  }
  await Deno.mkdir(logDir, { recursive: true });
  // Written through the temp-file-and-rename helper: a launch interrupted
  // mid-write must not leave a half-written store, because the queued report
  // is the only remaining record of an outage nobody could report.
  const written = await atomicWrite({
    targetFile: path,
    content: `${JSON.stringify(state, null, 2)}\n`,
  });
  if (!written.ok) throw written.error;
}

/**
 * Enrich a bare git error with the collision diagnosis (Issue #4204): when the
 * checkout looks like an active development tree — dirty, or parked on another
 * branch — say so, instead of the bare failure that let a crash-loop run
 * unexplained for an hour.
 */
export function diagnoseUpdateFailure(
  error: string,
  branch: string,
  checkout: CheckoutState | null,
): string {
  if (
    !checkout || branch === "" ||
    (checkout.dirtyFiles === 0 && checkout.branch === branch)
  ) {
    return error;
  }
  return `${error} — the worker checkout looks like an active development ` +
    `tree (branch ${checkout.branch}, ${checkout.dirtyFiles} uncommitted ` +
    `change(s)). Commit or stash that work, or give the worker its own ` +
    `dedicated clone (Issue #4204).`;
}

/**
 * File (or comment on) a deduplicated GitHub issue naming the crash-loop
 * (Issue #4204). Rides the shared host-escalation channel in
 * `host_escalation.ts` (Issue #556), which goes through the `spawnGh`
 * chokepoint like every other worker write and resolves the staged
 * `GH_CONFIG_DIR` this update runs before the configuration load establishes.
 */
export async function escalateCheckoutUpdateFailure(
  context: CheckoutUpdateEscalationContext,
): Promise<void> {
  const repo = await resolveOriginRepo(context.repoDir);
  const env = await resolveEscalationGhEnv();

  const host = escalationHostId();
  const title = `Worker checkout update failing on ${host}`;
  const body = [
    context.recovered
      ? `The host-side worker checkout update on \`${host}\` failed ` +
        `${context.streak} consecutive runs and has **since recovered** — it ` +
        `updated cleanly on the run that delivered this report. The host was ` +
        `launching on stale code for the duration, and could not reach GitHub ` +
        `to say so at the time (Issues #4204, #1018).`
      : `The host-side worker checkout update on \`${host}\` has failed ` +
        `${context.streak} consecutive runs — the worker keeps launching on ` +
        `the checkout it already has, so that host is running stale code ` +
        `(Issues #4204, #513).`,
    "",
    "```",
    context.error,
    "```",
    "",
    context.checkout
      ? `Checkout state: branch \`${context.checkout.branch}\`, ` +
        `${context.checkout.dirtyFiles} uncommitted change(s).`
      : "Checkout state could not be read.",
    "",
    // A report that could not be sent when the fault started says so, rather
    // than reading as though the fault only began now (Issue #1018).
    ...(context.spooledAt
      ? [
        `This report was queued on \`${context.spooledAt}\` — the host could ` +
        `not reach GitHub at the time — and delivered on the first run that ` +
        `could (Issue #1018). The evidence above is from the last failing ` +
        `run before delivery.`,
        "",
      ]
      : []),
    "If this checkout doubles as a development tree, commit or stash the " +
    "in-flight work, or give the worker its own dedicated clone — see " +
    "docs/DEPLOYMENT.md (Dedicated clone).",
  ].join("\n");

  await fileOrCommentIssue({ repo, title, body, env });
}

/** Build the production dependency set for {@link updateCheckout}. */
export function createDefaultCheckoutUpdateDeps(): CheckoutUpdateDeps {
  return {
    resolveDefaultBranch: resolveOriginDefaultBranch,
    resetToDefaultBranch: resetCheckoutToDefaultBranch,
    fetchOrigin,
    resolveCommit: resolveRefCommit,
    readHeadCommit,
    checkoutPinnedRef,
    describeCheckoutState,
    readFailureStreak: defaultReadFailureStreak,
    writeFailureStreak: defaultWriteFailureStreak,
    readEscalationState: defaultReadEscalationState,
    writeEscalationState: defaultWriteEscalationState,
    escalate: escalateCheckoutUpdateFailure,
    log: appendRunCoreLogLine,
  };
}

/**
 * Hold the checkout at `ref` (frozen mode, Issue #624).
 *
 * A checkout whose `HEAD` already resolves to the pin is left completely
 * alone — not even a fetch — so a launch does not churn the tree. Otherwise
 * origin is fetched (a tag pushed since the last launch only resolves after
 * that), the ref is resolved, and the checkout is moved onto it.
 *
 * @returns The failure detail, or undefined when the checkout is on the pin.
 */
async function holdAtPinnedRef(
  deps: CheckoutUpdateDeps,
  repoDir: string,
  logDir: string,
  ref: string,
): Promise<string | undefined> {
  const head = await deps.readHeadCommit(repoDir);
  const local = await deps.resolveCommit(repoDir, ref);
  if (local !== null && local === head) return undefined;

  const fetched = await deps.fetchOrigin(repoDir, logDir);
  if (!fetched.ok) {
    // A ref that already resolves locally still pins — an offline host is
    // meant to keep running its pinned code — but the fetch failure is said
    // out loud rather than swallowed.
    if (local === null) {
      return `cannot fetch origin in ${repoDir} to resolve pinned_ref ` +
        `${ref}: ${fetched.error.message}`;
    }
    await deps.log(
      logDir,
      `Fetch failed while holding ${repoDir} at pinned_ref ${ref} ` +
        `(continuing on the ref this checkout already holds): ` +
        fetched.error.message,
    );
  }

  const target = local ?? await deps.resolveCommit(repoDir, ref);
  if (target === null) {
    return `pinned_ref ${ref} does not resolve in ${repoDir} — correct ` +
      `pinned_ref in .config.json (it takes a commit SHA or a tag that ` +
      `exists on origin), or set update_mode to "dynamic"`;
  }

  const pinned = await deps.checkoutPinnedRef(repoDir, ref, logDir);
  if (!pinned.ok) {
    return `cannot hold ${repoDir} at pinned_ref ${ref}: ${pinned.error.message}`;
  }
  return undefined;
}

/** The message of a thrown value, whatever it was. */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Persist the escalation state, saying so when it could not be persisted.
 *
 * Never masks the update failure — the caller carries on either way — but a
 * store that did not survive is said out loud rather than reported as queued:
 * the operator has to know that the evidence is only in this log.
 *
 * @returns Whether the state actually reached the disk
 */
async function saveEscalationState(
  deps: CheckoutUpdateDeps,
  logDir: string,
  state: CheckoutEscalationState,
): Promise<boolean> {
  try {
    await deps.writeEscalationState(logDir, state);
    return true;
  } catch (error) {
    await deps.log(
      logDir,
      `Could not persist the checkout-update escalation state in ${logDir} ` +
        `(Issue #1018): ${failureText(error)}`,
    );
    return false;
  }
}

/**
 * Deliver the crash-loop escalation for the current streak (Issues #4204,
 * #1018).
 *
 * Called on every failing run at or above the threshold. The marker — not the
 * streak count — decides whether to stay quiet, so an attempt that threw
 * leaves the streak eligible and the next run tries again; only a delivered
 * report silences the rest of the streak. Evidence that could not be sent is
 * spooled, and a run whose network has come back sends the spooled evidence
 * rather than pretending the fault started now.
 *
 * Every step is best-effort: nothing here may mask the underlying update
 * failure.
 *
 * @param deps - The injected side effects
 * @param current - This run's failure, as the escalation would report it
 * @returns Whether a report actually reached GitHub on this run
 */
async function deliverEscalation(
  deps: CheckoutUpdateDeps,
  current: CheckoutUpdateEscalationContext,
): Promise<boolean> {
  const { logDir, streak } = current;

  let state: CheckoutEscalationState;
  try {
    state = await deps.readEscalationState(logDir);
  } catch {
    state = emptyEscalationState();
  }
  // One delivered report per streak — a crash-loop must not spam the repo.
  //
  // The marker is only believed while this run is *later in the same streak*
  // than the delivery it records, which is what the count strictly increasing
  // within a streak means. A marker left behind by an earlier streak — the
  // clear on recovery could not remove the file, say — is therefore ignored
  // rather than silencing the host for ever, which would be a worse failure
  // than the duplicate report the deduplicated channel folds into one issue.
  if (state.escalatedStreak > 0 && streak > state.escalatedStreak) return false;

  const spooled = state.pending;
  const context: CheckoutUpdateEscalationContext = spooled === null
    ? current
    : {
      ...current,
      error: spooled.error,
      checkout: spooled.checkout,
      spooledAt: spooled.spooledAt,
    };

  await deps.log(
    logDir,
    `The worker checkout update has failed ${streak} consecutive runs — ` +
      `escalating through the control plane (Issue #4204)` +
      (spooled === null
        ? ""
        : `, delivering the report spooled at ${spooled.spooledAt} ` +
          `(Issue #1018)`),
  );

  try {
    await deps.escalate(context);
  } catch (escalationError) {
    // Queue the evidence — one entry per streak, overwritten — and leave the
    // marker unset so the next failing run attempts delivery again (#1018).
    const queued = await saveEscalationState(deps, logDir, {
      escalatedStreak: 0,
      pending: {
        repoDir: current.repoDir,
        streak,
        error: current.error,
        checkout: current.checkout,
        spooledAt: spooled?.spooledAt ?? new Date().toISOString(),
      },
    });
    await deps.log(
      logDir,
      `Checkout update escalation failed, ${
        queued
          ? "spooled for the next run with connectivity"
          : "and the evidence could NOT be queued — it exists only in this log"
      } (Issue #1018): ${failureText(escalationError)}`,
    );
    return false;
  }

  await saveEscalationState(deps, logDir, {
    escalatedStreak: streak,
    pending: null,
  });
  return true;
}

/**
 * End the streak, delivering whatever it never managed to say (Issue #1018).
 *
 * A queued report exists precisely because the host could not reach GitHub,
 * and the run that recovers is the first that can — so it is sent, marked as
 * an outage that has since ended, which is how "the operator learns about an
 * outage after it ends rather than never" actually holds. Nothing is ever
 * re-armed by it: only a report that was never delivered is flushed, so a
 * streak that already escalated stays at one issue.
 *
 * The spool is then cleared **whatever happened to that send**, because the
 * condition it describes has cleared — carrying it forward would be the stale
 * state that caught Issues #805 and #808. A flush that could not be delivered
 * is said out loud instead, so the operator can see in `run_core.log` that an
 * alert existed and why it never arrived.
 */
async function clearEscalationState(
  deps: CheckoutUpdateDeps,
  repoDir: string,
  logDir: string,
): Promise<void> {
  let state: CheckoutEscalationState;
  try {
    state = await deps.readEscalationState(logDir);
  } catch {
    state = emptyEscalationState();
  }
  const pending = state.pending;
  if (pending !== null) {
    await deps.log(
      logDir,
      `The checkout update succeeded — delivering the escalation spooled at ` +
        `${pending.spooledAt} after ${pending.streak} consecutive failures, ` +
        `now that this host can reach GitHub again (Issue #1018)`,
    );
    try {
      await deps.escalate({
        repoDir,
        logDir,
        streak: pending.streak,
        error: pending.error,
        checkout: pending.checkout,
        spooledAt: pending.spooledAt,
        recovered: true,
      });
    } catch (escalationError) {
      await deps.log(
        logDir,
        `The spooled checkout update escalation could not be delivered and ` +
          `is being discarded, because the condition it reports has already ` +
          `cleared (Issue #1018): ${failureText(escalationError)}`,
      );
    }
  }
  await saveEscalationState(deps, logDir, emptyEscalationState());
}

/**
 * Bring a checkout to where this host's update mode says it belongs — the tip
 * of `origin/<default-branch>` under `dynamic`, the pinned ref under `frozen`
 * (Issue #624) — counting consecutive failures and escalating a crash-loop
 * exactly once per streak (#4204), retrying until one report is delivered
 * (#1018).
 *
 * @param options - The checkout, the log directory, an optional branch, and
 *   the update mode with its pinned ref.
 * @param depsOverride - Partial dependency overrides (production defaults fill
 *   the rest). Tests inject a recording set.
 * @returns The outcome, including the streak and whether it escalated.
 */
export async function updateCheckout(
  options: CheckoutUpdateOptions,
  depsOverride: Partial<CheckoutUpdateDeps> = {},
): Promise<CheckoutUpdateOutcome> {
  const deps: CheckoutUpdateDeps = {
    ...createDefaultCheckoutUpdateDeps(),
    ...depsOverride,
  };
  const { repoDir, logDir } = options;
  const mode = options.updateMode ?? DEFAULT_UPDATE_MODE;
  // Where the checkout stood before anything touched it, so the update can
  // say whether it overwrote local work (Issue #735).
  const before = await snapshotCheckout(deps, repoDir);

  let branch = "";
  let ref = "";
  let failure: string | undefined;

  if (mode === "frozen") {
    ref = options.pinnedRef?.trim() ?? "";
    // The skip is stated before anything else happens, so `run_core.log`
    // names the mode and the ref even when the pin then fails to resolve.
    await deps.log(
      logDir,
      ref === ""
        ? `Checkout update skipped: update_mode=frozen, but no pinned_ref is set`
        : `Checkout update skipped: update_mode=frozen, pinned to ${ref}`,
    );
    failure = ref === ""
      ? `update_mode is "frozen" but no pinned_ref is set — set pinned_ref ` +
        `in .config.json to the commit SHA or tag ${repoDir} is held at`
      : await holdAtPinnedRef(deps, repoDir, logDir, ref);
  } else {
    branch = options.defaultBranch ?? "";
    if (branch === "") {
      const resolved = await deps.resolveDefaultBranch(repoDir);
      if (resolved.ok) {
        branch = resolved.value;
      } else {
        failure = `cannot resolve the default branch of ${repoDir}: ` +
          `${resolved.error.message} (pass --default-branch to name it)`;
      }
    }

    if (failure === undefined) {
      await deps.log(logDir, `Updating ${repoDir} to origin/${branch}`);
      const reset = await deps.resetToDefaultBranch(repoDir, branch, logDir);
      if (!reset.ok) {
        failure = `cannot update ${repoDir} to origin/${branch}: ` +
          reset.error.message;
      }
    }
  }

  if (failure === undefined) {
    // An update that changed the checkout names the opt-out that would have
    // preserved the overwritten work (Issue #735).
    const overwriteNotice = checkoutOverwriteNotice(
      repoDir,
      before,
      await snapshotCheckout(deps, repoDir),
    );
    if (overwriteNotice !== "") {
      await deps.log(logDir, overwriteNotice);
    }

    // A successful update ends any failure streak (Issue #4204) and takes the
    // escalation marker and any queued report with it (Issue #1018).
    try {
      await deps.writeFailureStreak(logDir, 0);
    } catch {
      // Best-effort persistence.
    }
    await clearEscalationState(deps, repoDir, logDir);
    return {
      ok: true,
      branch,
      mode,
      ref,
      streak: 0,
      escalated: false,
      overwriteNotice,
    };
  }

  let checkout: CheckoutState | null = null;
  try {
    checkout = await deps.describeCheckoutState(repoDir);
  } catch {
    checkout = null;
  }
  const detail = diagnoseUpdateFailure(failure, branch, checkout);
  await deps.log(logDir, `Checkout update failed: ${detail}`);

  // Consecutive-failure escalation (Issue #4204): one blip stays a log line;
  // a crash-loop is raised through the control plane once per streak, so an
  // unattended host running stale code is visible where the operator actually
  // looks. Delivery is attempted on every run from the threshold on until one
  // report lands (Issue #1018). Every step is best-effort — nothing here may
  // mask the underlying failure.
  let streak: number;
  try {
    streak = (await deps.readFailureStreak(logDir)) + 1;
  } catch {
    streak = 1;
  }
  try {
    await deps.writeFailureStreak(logDir, streak);
  } catch {
    // Best-effort persistence.
  }

  const escalated = streak >= CHECKOUT_UPDATE_ESCALATION_THRESHOLD
    ? await deliverEscalation(deps, {
      repoDir,
      logDir,
      streak,
      error: detail,
      checkout,
    })
    : false;

  // A failed update reports the failure, which already carries the
  // development-tree diagnosis; the overwrite hint belongs to updates that
  // completed (Issue #735).
  return {
    ok: false,
    branch,
    mode,
    ref,
    error: detail,
    streak,
    escalated,
    overwriteNotice: "",
  };
}
