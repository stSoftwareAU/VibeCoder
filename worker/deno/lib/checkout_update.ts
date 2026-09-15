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
 * `git clean -fd` → the scoped ignored clean of Issue #1443 — and, on
 * failure, enriches the error, counts the streak in
 * `<logDir>/checkout-update-failure-streak`, and delivers exactly one report
 * per streak through the operator's own `callbacks.host_failure` hook once
 * {@link CHECKOUT_UPDATE_ESCALATION_THRESHOLD} consecutive failures are
 * reached **and** they span at least
 * {@link CHECKOUT_UPDATE_ESCALATION_MIN_SPAN_SECONDS}. A success resets the
 * streak to zero.
 *
 * That report used to be a GitHub issue filed against the checkout's own
 * origin repository (Issue #4204). It no longer is (Issues #2110, #2088): a
 * host-level fault is the operator's business, not a public record in the
 * repository the fleet works on, so the escalation now rides the host-side
 * `callbacks.host_failure` hook of Issue #2107 — a `checkout_update` payload
 * handed to whatever command the operator configured. No path in this module
 * spawns `gh`. A host with no hook configured records `no_hook_configured`
 * locally and a host whose `callbacks` block cannot be read records
 * `config_invalid`; neither stops the update itself, and neither is retried,
 * because there is nothing to retry against.
 *
 * The span is half the rule because the count alone was not measuring
 * persistence (Issue #1017): on GRQ-23 the streak went 1 → 2 → 3 in eight
 * seconds for one transient macOS `No user exists for uid 501` — the host's
 * directory services failing to resolve the user the launcher was already
 * running as — and tripped an escalation written to mean an hour of stale
 * code. That condition is now recognised by name rather than passed through
 * as git's "correct access rights" boilerplate, and retried in place with a
 * short bounded backoff, so a run that recovers within seconds never reaches
 * the streak at all.
 *
 * That escalation used to fire at the single run where the streak *equalled*
 * the threshold, and a transport that fails is the dominant failure mode here
 * — the fault being reported is often the same fault that stops the report
 * (Issue #1018). So delivery is re-armed and bounded: it is attempted on every
 * failing run at or above the threshold until one invocation returns `ok` or
 * {@link CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS} attempts have failed, the
 * settled-streak marker is recorded on delivery, and evidence that could not
 * be delivered is spooled in `<logDir>/checkout-update-escalation` — one entry
 * per streak, overwritten, carrying the attempt count — so the next failing
 * run retries it. The fifth failed attempt records `escalation_lost` once and
 * settles the streak, so a hook that never works cannot make every launch pay
 * for it.
 *
 * **Recovery delivers nothing** (Issue #2110). A run that updates cleanly ends
 * the streak: it clears `<logDir>/checkout-update-failure-streak` and the
 * spool, and logs one line saying the streak ended and whether a report was
 * still undelivered. The condition is over, and a hook fired after the fact
 * would report a fault that no longer exists — the local line is the record.
 *
 * Both outcomes are also self-heal events under the `checkout_update` module:
 * `escalated` carries the hook status, the attempt and the streak, and
 * `escalation_lost` records the streak whose report never landed.
 *
 * Under `update_mode: "frozen"` (Issue #624, part of #583) the sequence above
 * would defeat the pin, so the checkout is held at `pinned_ref` instead: fetch
 * (so a newly pushed tag resolves), then `git checkout --detach <ref>` →
 * `git reset --hard <ref>` → `git clean -fd` → the scoped ignored clean, and
 * nothing at all when `HEAD` already resolves to that ref. The skip is logged, never silent, and a ref
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
import { ignoredExecutableCleanArgs } from "./ignored_path_clean.ts";
import {
  appendRunCoreLogLine,
  resolveOriginDefaultBranch,
} from "./run_bootstrap.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { escalationHostId, parseOriginRepo } from "./host_escalation.ts";
import type { CallbackInvocation } from "./run_callbacks.ts";
import {
  type HostFailureHookConfig,
  type HostFailurePayload,
  invokeHostFailureHook,
} from "./host_failure_hook.ts";
import { emitSelfHealEventAuto } from "./self_heal_events.ts";

// Re-exported for the callers and tests that knew this helper by its old
// home; the channel itself now lives in host_escalation.ts (Issue #556).
export { parseOriginRepo };

/**
 * Consecutive update failures before the host escalates through the control
 * plane (Issue #4204). One transient blip stays a log line; a crash-loop
 * reaches the operator's own `callbacks.host_failure` hook (Issue #2110) —
 * the observed failure mode was a worker silently running week-old code
 * because its checkout was occupied by interactive development work.
 */
export const CHECKOUT_UPDATE_ESCALATION_THRESHOLD = 3;

/**
 * Hook invocations a single streak may spend before its report is abandoned
 * (Issue #2110).
 *
 * The hook is a command on the host, and the fault it reports — a wedged
 * checkout, a host that cannot reach its remote — is exactly the kind of
 * fault that can stop it running. Retrying on each later failing run is what
 * gets a report out of a transient outage; retrying for ever is what makes a
 * permanently broken hook a cost on every launch. Five attempts spans the
 * hourly cadence the streak was written for without becoming unbounded, and
 * the fifth failure says `escalation_lost` out loud rather than going quiet.
 */
export const CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS = 5;

/**
 * The shortest span those consecutive failures may cover before the host
 * escalates (Issue #1017).
 *
 * "3 consecutive runs" was written meaning three hourly launches — an hour of
 * a host running stale code, and a genuine crash-loop. On GRQ-23 it meant
 * three launches **eight seconds apart**: the streak file went 1 → 2 → 3
 * between 09:47:44 and 09:47:52 for one transient uid-lookup glitch that was
 * over before the third run started. A streak that can be exhausted faster
 * than the condition can clear is not measuring persistence, so the count is
 * now qualified by the elapsed span as well.
 *
 * Fifteen minutes is chosen to sit well above any burst of launches and well
 * below the two hours three hourly launches span, so the hourly case this
 * threshold was written for still escalates on its third failure.
 */
export const CHECKOUT_UPDATE_ESCALATION_MIN_SPAN_SECONDS = 15 * 60;

/**
 * The persisted consecutive-failure streak (Issues #4204, #1017).
 *
 * The count alone could not tell three failures in eight seconds from three
 * across three hours, so the first failure's time is persisted beside it.
 */
export interface CheckoutUpdateStreak {
  /** Consecutive failures recorded so far; 0 when there is no streak. */
  count: number;
  /**
   * Unix seconds of the first failure in this streak.
   *
   * `0` means "not known" — either there is no streak, or the file was
   * written by a worker from before this field existed. An unknown start
   * never *blocks* an escalation: silencing a host that is running stale code
   * is the worse of the two errors, and the very next failure records a real
   * start.
   */
  firstFailureAt: number;
}

/** Whether a streak has both the count and the span to escalate (#1017). */
export function checkoutStreakEscalates(
  streak: CheckoutUpdateStreak,
  nowSeconds: number,
): boolean {
  if (streak.count < CHECKOUT_UPDATE_ESCALATION_THRESHOLD) return false;
  // An unknown start is not evidence of a short span, so it does not veto.
  if (streak.firstFailureAt <= 0) return true;
  return nowSeconds - streak.firstFailureAt >=
    CHECKOUT_UPDATE_ESCALATION_MIN_SPAN_SECONDS;
}

/**
 * The uid in a macOS Directory Services lookup failure, or `null` (#1017).
 *
 * `No user exists for uid 501` is the host failing to resolve the *invoking*
 * user — 501 being the operator's own uid. `git` and `ssh` could not read the
 * passwd entry for the user they were already running as, so they could not
 * find `~/.ssh` or `~/.gitconfig` and gave up with git's "make sure you have
 * the correct access rights" boilerplate attached. It is neither a
 * credentials fault nor a network one, it is a known transient after certain
 * sleep/wake cycles and DirectoryService restarts, and it clears on its own.
 */
export function directoryServicesUid(text: string): string | null {
  const match = /No user exists for uid (\d+)/.exec(text);
  return match?.[1] ?? null;
}

/**
 * Backoff between retries of a git step the host's directory services broke
 * (Issue #1017). Short and bounded: the condition typically clears within
 * seconds, and a launcher must not sit on the checkout waiting for it.
 */
export const DIRECTORY_SERVICES_RETRY_DELAYS_MS: readonly number[] = [
  500,
  1_500,
  3_000,
];

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

/** Everything the host-failure hook needs to name the failure (#4204). */
export interface CheckoutUpdateEscalationContext {
  /** The worker checkout that could not be updated. */
  repoDir: string;
  /** Worker log directory (for any escalation-side logging). */
  logDir: string;
  /** Consecutive failures, including this one. */
  streak: number;
  /** Unix seconds of the first failure in this streak; 0 when unknown. */
  streakStartedAt: number;
  /** Which delivery attempt this report is, counting from 1 (Issue #2110). */
  attempt: number;
  /** The enriched failure detail. */
  error: string;
  /** Checkout state at failure time, when it could be read. */
  checkout: CheckoutState | null;
}

/** The evidence of one failure, before an attempt number is put on it. */
type CheckoutEscalationEvidence = Omit<
  CheckoutUpdateEscalationContext,
  "attempt"
>;

/**
 * Evidence of an escalation that could not be delivered (Issue #1018). Each
 * further failed attempt in the same streak overwrites the evidence — the
 * newest failure is the one worth reporting — while keeping the timestamp of
 * the first, so the record says how long the host has been unable to speak.
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
  /**
   * Hook invocations this streak has spent (Issue #2110). Bounded by
   * {@link CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS}: the attempt that reaches
   * the bound settles the streak, so a hook that never works is paid for
   * five times, not for ever.
   */
  attempts: number;
}

/**
 * What the host knows about escalating the streak it is currently in (Issue
 * #1018). Cleared — the file removed — whenever a successful update ends the
 * streak.
 */
export interface CheckoutEscalationState {
  /**
   * The streak whose report is **settled**; 0 while it is still open. Settled
   * means one of: the hook returned `ok`, there was no hook to invoke, or
   * {@link CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS} attempts all failed
   * (Issue #2110). Non-zero is what keeps the rest of the streak quiet, so an
   * invocation that merely failed leaves the streak eligible to retry.
   */
  escalatedStreak: number;
  /** The single queued report awaiting a working hook, or null. */
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
  /**
   * Read the persisted streak — the consecutive-failure count and when the
   * streak started (Issue #1017). An absent or unreadable file reads as
   * {@link emptyCheckoutStreak}.
   */
  readFailureStreak(logDir: string): Promise<CheckoutUpdateStreak>;
  /** Persist the streak. */
  writeFailureStreak(
    logDir: string,
    streak: CheckoutUpdateStreak,
  ): Promise<void>;
  /** Clock seam, in Unix seconds, so the span rule is testable (#1017). */
  now(): number;
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
   * The operator's `callbacks.host_failure` hook, as a targeted read of this
   * host's `.config.json` found it (Issues #2107, #2110). `none` and
   * `invalid` are recorded locally and settle the streak — there is nothing
   * to retry against — and neither blocks the update itself.
   */
  hostFailureHook: HostFailureHookConfig;
  /**
   * Report the crash-loop to the validated hook (Issues #4204, #2110).
   * Delivery is an invocation whose status is `ok`; everything else is
   * retried on the next failing run, up to
   * {@link CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS}. Best-effort: a throw is
   * logged and never masks the underlying update failure.
   */
  escalate(
    context: CheckoutUpdateEscalationContext,
    hook: { path: string; timeoutSeconds: number },
  ): Promise<CallbackInvocation>;
  /** Append a timestamped line to `run_core.log`. */
  log(logDir: string, message: string): Promise<void>;
}

/**
 * Append a single line (newline-terminated) to a file, creating it if absent.
 *
 * The line is redacted first (Issue #1258). `pull.log` carries git's raw
 * stdout and stderr, and neither structural redactor covers this path — the
 * logger is not used, and the console patch covers `console.*` only, not a
 * file write. Git error text is the canonical carrier of a tokenised remote
 * URL (`https://x-access-token:<token>@github.com/owner/repo`), so this is the
 * chokepoint for every byte this module appends to the log directory.
 */
async function appendLine(filePath: string, line: string): Promise<void> {
  await Deno.writeTextFile(filePath, `${redactSecrets(line)}\n`, {
    append: true,
  });
}

/**
 * The update sequence, the prelude's plus the ignored clean (Issue #1443):
 *   git fetch origin && git checkout <branch> &&
 *   git reset --hard origin/<branch> && git clean -fd &&
 *   git clean -ffdx -- <executable-bearing ignored paths>
 *
 * Output is appended to `pull.log` **under the log directory**, which is a
 * mounted host directory — never the checkout. The first failing command
 * short-circuits and returns a fail-loud error (Issue #3234).
 *
 * `deps` is the seam {@link runGitStepWithRetry} needs (Issue #1017); it
 * defaults to the real git runner, so production callers pass nothing.
 */
export function resetCheckoutToDefaultBranch(
  repoDir: string,
  branch: string,
  logDir: string,
  deps: GitStepDeps = defaultGitStepDeps(),
): Promise<Result<void>> {
  return runGitSteps(repoDir, logDir, [
    ["fetch", "origin"],
    ["checkout", branch],
    ["reset", "--hard", `origin/${branch}`],
    ["clean", "-fd"],
    // Issue #1443: and the ignored directories that carry executable content,
    // so nothing a previous launch left in them runs in this one.
    ignoredExecutableCleanArgs(),
  ], deps);
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
  deps: GitStepDeps = defaultGitStepDeps(),
): Promise<Result<void>> {
  return runGitSteps(repoDir, logDir, [["fetch", "--tags", "origin"]], deps);
}

/**
 * Hold the checkout at `ref` (Issue #624): a detached checkout of the ref, a
 * hard reset to it, then the clean pair — untracked, then the ignored
 * executable paths (Issue #1443).
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
  deps: GitStepDeps = defaultGitStepDeps(),
): Promise<Result<void>> {
  return runGitSteps(repoDir, logDir, [
    ["checkout", "--force", "--detach", ref],
    ["reset", "--hard", ref],
    ["clean", "-fd"],
    ignoredExecutableCleanArgs(),
  ], deps);
}

/** Seams the retrying git-step runner needs, so it is testable (#1017). */
export interface GitStepDeps {
  /** Run one git invocation in the checkout. */
  run(
    args: string[],
    options: { cwd: string },
  ): Promise<Result<{ code: number; stdout: string; stderr: string }>>;
  /** Wait, between retries. */
  sleep(ms: number): Promise<void>;
}

/** The production seams: the bounded git runner and a real wait. */
export function defaultGitStepDeps(): GitStepDeps {
  return {
    run: (args, options) => runGitCommand(args, options),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** One git step's outcome, plus anything worth saying about how it got there. */
export interface GitStepAttempt {
  result: Result<{ code: number; stdout: string; stderr: string }>;
  /** Lines for `pull.log` — empty unless the step had to be retried. */
  notes: string[];
}

/**
 * Run one git step, retrying while the host's directory services are the
 * reason it failed (Issue #1017).
 *
 * `No user exists for uid <n>` clears on its own, usually within seconds, so
 * giving up on the first occurrence throws away the run: the launcher went on
 * with a stale checkout and burned a third of its escalation streak in eight
 * seconds. The retries are few and short — this runs before the launch, so it
 * must cost seconds, not minutes — and every other failure returns
 * immediately, exactly as before.
 */
export async function runGitStepWithRetry(
  args: string[],
  repoDir: string,
  deps: GitStepDeps = defaultGitStepDeps(),
): Promise<GitStepAttempt> {
  const notes: string[] = [];
  let result = await deps.run(args, { cwd: repoDir });

  for (const delayMs of DIRECTORY_SERVICES_RETRY_DELAYS_MS) {
    const uid = directoryServicesFailureUid(result);
    if (uid === null) break;
    notes.push(
      `git ${args.join(" ")}: the host could not resolve uid ${uid} ` +
        `(directory services); retrying in ${delayMs}ms (Issue #1017)`,
    );
    await deps.sleep(delayMs);
    result = await deps.run(args, { cwd: repoDir });
  }

  // Only a step that ended up succeeding gets to claim a recovery; one that
  // kept failing already reports the fault itself, and a "retried" line
  // beside it would read as though the retry had helped.
  if (notes.length > 0 && !(result.ok && result.value.code === 0)) {
    return { result, notes: [] };
  }
  return { result, notes };
}

/** The uid a git step failed on, or `null` when that was not the fault. */
function directoryServicesFailureUid(
  result: Result<{ code: number; stdout: string; stderr: string }>,
): string | null {
  if (!result.ok) return directoryServicesUid(result.error.message);
  if (result.value.code === 0) return null;
  return directoryServicesUid(`${result.value.stderr}${result.value.stdout}`);
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
  deps: GitStepDeps = defaultGitStepDeps(),
): Promise<Result<void>> {
  const pullLog = `${logDir}/pull.log`;

  for (const args of steps) {
    const attempt = await runGitStepWithRetry(args, repoDir, deps);
    const result = attempt.result;
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    // A step that only succeeded because it was retried says so in the log
    // the operator already reads for this update (Issue #1017): a silent
    // recovery is indistinguishable from a condition that never happened,
    // and this one is worth knowing recurred.
    for (const note of attempt.notes) {
      try {
        await appendLine(pullLog, note);
      } catch {
        // Best-effort logging — never masks the git outcome.
      }
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

/** The empty streak — no failures, no start. */
export function emptyCheckoutStreak(): CheckoutUpdateStreak {
  return { count: 0, firstFailureAt: 0 };
}

/**
 * Parse the streak file's contents (Issue #1017).
 *
 * Two formats are accepted, because a host upgrades in place and a launcher
 * that dies parsing its own state file is worse than the bug it was fixing:
 * the JSON object written since this change, and the bare decimal count every
 * worker wrote before it. A bare count has no start, which reads as "unknown"
 * — never as "just now", which would postpone an escalation the host had
 * already earned.
 */
export function parseCheckoutStreak(text: string): CheckoutUpdateStreak {
  const trimmed = text.trim();
  if (trimmed === "") return emptyCheckoutStreak();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const count = record["count"];
    const started = record["firstFailureAt"];
    if (typeof count === "number" && Number.isFinite(count) && count > 0) {
      return {
        count: Math.floor(count),
        firstFailureAt:
          typeof started === "number" && Number.isFinite(started) &&
            started > 0
            ? Math.floor(started)
            : 0,
      };
    }
    return emptyCheckoutStreak();
  }

  // The pre-#1017 format: a bare count on its own line.
  const legacy = Number.parseInt(trimmed, 10);
  return Number.isFinite(legacy) && legacy > 0
    ? { count: legacy, firstFailureAt: 0 }
    : emptyCheckoutStreak();
}

/** Read the persisted streak; absent, unreadable or malformed reads as empty. */
async function defaultReadFailureStreak(
  logDir: string,
): Promise<CheckoutUpdateStreak> {
  try {
    return parseCheckoutStreak(await Deno.readTextFile(streakFilePath(logDir)));
  } catch {
    return emptyCheckoutStreak();
  }
}

/** Persist the streak. Best-effort — a write failure only loses the count. */
async function defaultWriteFailureStreak(
  logDir: string,
  streak: CheckoutUpdateStreak,
): Promise<void> {
  try {
    await Deno.mkdir(logDir, { recursive: true });
    await Deno.writeTextFile(
      streakFilePath(logDir),
      `${JSON.stringify(streak)}\n`,
    );
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
  // A spool entry written before Issue #2110 carries no attempt count. It
  // reads as one attempt already spent, not as none: the entry exists
  // *because* an attempt failed, and counting it as zero would hand a
  // never-working hook one extra try per upgrade.
  const rawAttempts = record["attempts"];
  const attempts =
    typeof rawAttempts === "number" && Number.isFinite(rawAttempts) &&
      rawAttempts > 0
      ? Math.floor(rawAttempts)
      : 1;
  return { repoDir, streak, error, checkout, spooledAt, attempts };
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
  // Named before the development-tree diagnosis is even considered, because
  // this one is about the *host*, not the checkout (Issue #1017). Left
  // unnamed, git's own "make sure you have the correct access rights"
  // boilerplate sent an operator to the deploy keys and the SSH agent, and
  // there was nothing wrong with either.
  const uid = directoryServicesUid(error);
  if (uid !== null) {
    return `${error} — this is the host's directory services failing to ` +
      `resolve uid ${uid}, the user this launcher is already running as: ` +
      `git could not read that user's passwd entry, so it could not find ` +
      `their ~/.ssh or ~/.gitconfig. It is neither a credentials nor a ` +
      `network fault, it is a known transient after sleep/wake and ` +
      `DirectoryService restarts, and it clears on its own (Issue #1017).`;
  }
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
 * The exit status a failing git step reported, or undefined (Issue #2110).
 *
 * The enriched detail carries git's own `(exit code N)` — it is the one place
 * the status survives into the report, because the update sequence returns a
 * message rather than a status. Nothing invents one: a failure whose status
 * was never observed (an unresolvable default branch, an unresolvable pin)
 * omits `lastExitStatus` rather than emitting a placeholder a hook would read
 * as real.
 */
export function gitStepExitStatus(detail: string): number | undefined {
  const match = /\(exit code (-?\d+)\)/.exec(detail);
  const captured = match?.[1];
  if (captured === undefined) return undefined;
  const code = Number.parseInt(captured, 10);
  return Number.isFinite(code) ? code : undefined;
}

/**
 * The `host_failure` payload describing this checkout-update crash-loop
 * (Issues #2107, #2110).
 *
 * `delivery` is always `first`/1: the checkout update delivers one report per
 * streak, and a retry of that same report is a further *attempt*, not a
 * further delivery — which is what `attempt` says.
 *
 * @param context - The failure, and which attempt is reporting it
 * @param host - Host identifier; defaults to this host's
 * @param nowMs - Clock seam, used only when the streak start is unknown
 * @returns The payload the hook receives
 */
export function buildCheckoutHostFailurePayload(
  context: CheckoutUpdateEscalationContext,
  host: string = escalationHostId(),
  nowMs: () => number = Date.now,
): HostFailurePayload {
  const startedMs = context.streakStartedAt > 0
    ? context.streakStartedAt * 1000
    : nowMs();
  const payload: HostFailurePayload = {
    host,
    condition: "checkout_update",
    phase: "checkout_update",
    consecutiveFailures: context.streak,
    streakStartedAt: new Date(startedMs).toISOString(),
    delivery: { kind: "first", count: 1 },
    attempt: context.attempt,
    // Git error text is the canonical carrier of a tokenised remote URL, and
    // this detail is handed to a command the operator wrote (Issue #1258).
    detail: redactSecrets(context.error),
  };
  const exitStatus = gitStepExitStatus(context.error);
  if (exitStatus !== undefined) payload.lastExitStatus = exitStatus;
  if (context.checkout !== null) {
    payload.checkout = {
      branch: context.checkout.branch,
      dirtyFiles: context.checkout.dirtyFiles,
    };
  }
  return payload;
}

/**
 * Run the operator's `callbacks.host_failure` hook for this crash-loop
 * (Issues #2110, #2088) — the production {@link CheckoutUpdateDeps.escalate}.
 *
 * This replaced the GitHub issue the crash-loop used to file against the
 * checkout's origin repository: a host-level fault belongs to whoever runs
 * the host, not to the public record of the repository the fleet works on.
 * The invoker never throws — a hook that could not be spawned, that failed or
 * that timed out comes back as a non-`ok` invocation the caller retries.
 *
 * Both hook-side log sinks go to stderr: the launchers redirect this
 * command's stderr into the operator's run log, and stdout carries the
 * command's own result.
 */
export function invokeCheckoutUpdateFailureHook(
  context: CheckoutUpdateEscalationContext,
  hook: { path: string; timeoutSeconds: number },
): Promise<CallbackInvocation> {
  return invokeHostFailureHook(buildCheckoutHostFailurePayload(context), hook, {
    log: (message) => console.error(`[worker-checkout-update] ${message}`),
    logError: (message) => console.error(`[worker-checkout-update] ${message}`),
  });
}

/**
 * Build the production dependency set for {@link updateCheckout}.
 *
 * @param hostFailureHook - What a targeted read of `callbacks.host_failure`
 *   found (Issue #2110). The default is `none`, so a caller that knows
 *   nothing about the hook escalates nowhere rather than guessing a path.
 */
export function createDefaultCheckoutUpdateDeps(
  hostFailureHook: HostFailureHookConfig = { kind: "none" },
): CheckoutUpdateDeps {
  return {
    hostFailureHook,
    resolveDefaultBranch: resolveOriginDefaultBranch,
    resetToDefaultBranch: resetCheckoutToDefaultBranch,
    fetchOrigin,
    resolveCommit: resolveRefCommit,
    readHeadCommit,
    checkoutPinnedRef,
    describeCheckoutState,
    readFailureStreak: defaultReadFailureStreak,
    writeFailureStreak: defaultWriteFailureStreak,
    now: () => Math.floor(Date.now() / 1000),
    readEscalationState: defaultReadEscalationState,
    writeEscalationState: defaultWriteEscalationState,
    escalate: invokeCheckoutUpdateFailureHook,
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
 * Record a streak that has nowhere to report to (Issue #2110).
 *
 * A host with no `callbacks.host_failure`, or one whose `callbacks` block
 * will not parse, is not a fault of the update — but it must not be silent
 * either, or a wedged host produces no signal at all. So it is said once, in
 * `run_core.log` and as a self-heal event, and the streak is **settled**
 * rather than left eligible: nothing about the configuration will change
 * between now and the next failing run, so a retry would only repeat the
 * line.
 */
async function recordUnusableHook(
  deps: CheckoutUpdateDeps,
  logDir: string,
  streak: number,
  hook: { kind: "none" } | { kind: "invalid"; error: string },
): Promise<void> {
  const hookStatus = hook.kind === "none"
    ? "no_hook_configured"
    : "config_invalid";
  await deps.log(
    logDir,
    `The worker checkout update has failed ${streak} consecutive runs — ` +
      (hook.kind === "none"
        ? `no callbacks.host_failure hook is configured on this host, so ` +
          `there is nowhere to report it (${hookStatus}, Issue #2110)`
        : `callbacks.host_failure could not be read, so there is nowhere ` +
          `to report it (${hookStatus}, Issue #2110): ${hook.error}`),
  );
  await emitSelfHealEventAuto({
    module: "checkout_update",
    action: "escalated",
    reason: `checkout update failed ${streak} consecutive runs`,
    result: "skipped",
    details: { hookStatus, attempt: 0, streak },
  });
  await saveEscalationState(deps, logDir, {
    escalatedStreak: streak,
    pending: null,
  });
}

/**
 * Abandon this streak's report after the attempt bound (Issue #2110).
 *
 * Said out loud in both records, so "nobody was told" is itself something the
 * operator can find, rather than a silence indistinguishable from a host that
 * never failed.
 */
async function recordEscalationLost(
  deps: CheckoutUpdateDeps,
  logDir: string,
  streak: number,
  hookStatus: string,
  attempts: number,
): Promise<void> {
  await deps.log(
    logDir,
    `escalation_lost: ${CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS} attempts ` +
      `to report this checkout-update streak through ` +
      `callbacks.host_failure have all failed — no further attempt will be ` +
      `made for this streak, and the evidence exists only in this log ` +
      `(Issue #2110)`,
  );
  await emitSelfHealEventAuto({
    module: "checkout_update",
    action: "escalation_lost",
    reason:
      `${CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS} hook attempts all failed`,
    result: "failed",
    details: { hookStatus, attempts, streak },
  });
}

/**
 * Deliver this streak's report through the `callbacks.host_failure` hook
 * (Issues #4204, #1018, #2110).
 *
 * Called on every failing run at or above the threshold. The settled marker —
 * not the streak count — decides whether to stay quiet, so an invocation that
 * did not return `ok` leaves the streak eligible and the next failing run
 * tries again. Attempts are bounded: the
 * {@link CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS}th failed attempt records
 * `escalation_lost` once and settles the streak, so a hook that never works
 * is not paid for on every launch for ever.
 *
 * A host with no hook, or with a `callbacks` block that could not be read,
 * has nothing to deliver to: that is recorded once, locally, and settles the
 * streak — retrying an absent hook would only repeat the same line.
 *
 * Every step is best-effort: nothing here may mask the underlying update
 * failure.
 *
 * @param deps - The injected side effects
 * @param current - This run's failure, as the report would describe it
 * @returns Whether the hook actually took delivery on this run
 */
async function deliverEscalation(
  deps: CheckoutUpdateDeps,
  current: CheckoutEscalationEvidence,
): Promise<boolean> {
  const { logDir, streak } = current;

  let state: CheckoutEscalationState;
  try {
    state = await deps.readEscalationState(logDir);
  } catch {
    state = emptyEscalationState();
  }
  // One settled report per streak — a crash-loop must not re-fire the hook
  // every hour once its report has landed, been abandoned, or had nowhere to
  // go.
  //
  // The marker is only believed while this run is *later in the same streak*
  // than the outcome it records, which is what the count strictly increasing
  // within a streak means. A marker left behind by an earlier streak — the
  // clear on recovery could not remove the file, say — is therefore ignored
  // rather than silencing the host for ever, which would be a worse failure
  // than one duplicate report.
  if (state.escalatedStreak > 0 && streak > state.escalatedStreak) return false;

  const hook = deps.hostFailureHook;
  if (hook.kind !== "hook") {
    await recordUnusableHook(deps, logDir, streak, hook);
    return false;
  }

  const attempt = (state.pending?.attempts ?? 0) + 1;
  await deps.log(
    logDir,
    `The worker checkout update has failed ${streak} consecutive runs — ` +
      `invoking the callbacks.host_failure hook (attempt ${attempt} of ` +
      `${CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS}, Issue #2110)`,
  );

  let invocation: CallbackInvocation | null = null;
  let thrown = "";
  try {
    invocation = await deps.escalate({ ...current, attempt }, {
      path: hook.path,
      timeoutSeconds: hook.timeoutSeconds,
    });
  } catch (escalationError) {
    // The invoker is documented never to throw, so this is a fault in the
    // seam rather than in the hook — recorded as its own status, never
    // silently folded into "the hook failed".
    thrown = failureText(escalationError);
  }
  const hookStatus = invocation?.status ?? "threw";

  await emitSelfHealEventAuto({
    module: "checkout_update",
    action: "escalated",
    reason: `checkout update failed ${streak} consecutive runs`,
    result: hookStatus === "ok" ? "ok" : "failed",
    details: { hookStatus, attempt, streak },
  });

  if (hookStatus === "ok") {
    await deps.log(
      logDir,
      `The callbacks.host_failure hook took delivery of the checkout-update ` +
        `report on attempt ${attempt} (Issue #2110)`,
    );
    await saveEscalationState(deps, logDir, {
      escalatedStreak: streak,
      pending: null,
    });
    return true;
  }

  const lost = attempt >= CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS;
  const queued = await saveEscalationState(deps, logDir, {
    escalatedStreak: lost ? streak : 0,
    pending: {
      repoDir: current.repoDir,
      streak,
      error: current.error,
      checkout: current.checkout,
      spooledAt: state.pending?.spooledAt ?? new Date().toISOString(),
      attempts: attempt,
    },
  });
  await deps.log(
    logDir,
    `Checkout update escalation failed (hook status ${hookStatus}` +
      (thrown === "" ? "" : `: ${thrown}`) +
      `) on attempt ${attempt} of ` +
      `${CHECKOUT_UPDATE_ESCALATION_MAX_ATTEMPTS}, ` +
      (queued
        ? "spooled for the next failing run"
        : "and the evidence could NOT be queued — it exists only in this log") +
      ` (Issue #2110)`,
  );

  if (lost) {
    await recordEscalationLost(deps, logDir, streak, hookStatus, attempt);
  }
  return false;
}

/**
 * End the streak, recording locally what it never managed to say (Issue
 * #2110).
 *
 * Nothing is delivered here. A run that updates cleanly is proof the
 * condition has cleared, and firing the hook then would report a fault that
 * no longer exists — the operator would be paged, at recovery, about a host
 * that is fine. So the streak file and the spool are cleared together and one
 * line goes to `run_core.log` saying the streak ended and whether its report
 * was still undelivered, which is the record that an alert existed and never
 * arrived.
 *
 * A success on a host that never escalated says nothing: there is no streak
 * to report the end of.
 */
async function clearEscalationState(
  deps: CheckoutUpdateDeps,
  logDir: string,
): Promise<void> {
  let state: CheckoutEscalationState;
  try {
    state = await deps.readEscalationState(logDir);
  } catch {
    state = emptyEscalationState();
  }
  const pending = state.pending;
  if (state.escalatedStreak > 0 || pending !== null) {
    await deps.log(
      logDir,
      `The checkout update succeeded — the failure streak has ended` +
        (pending === null
          ? `, and its escalation state is cleared (Issue #2110)`
          : `, but its report was still undelivered after ${pending.attempts} ` +
            `hook attempt(s) first queued at ${pending.spooledAt}; it is ` +
            `discarded with the condition it describes (Issue #2110)`),
    );
  }
  await saveEscalationState(deps, logDir, emptyEscalationState());
}

/**
 * Bring a checkout to where this host's update mode says it belongs — the tip
 * of `origin/<default-branch>` under `dynamic`, the pinned ref under `frozen`
 * (Issue #624) — counting consecutive failures and reporting a crash-loop
 * through `callbacks.host_failure` exactly once per streak (#4204, #2110),
 * retrying until one invocation returns `ok` or five have failed (#1018).
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
      await deps.writeFailureStreak(logDir, emptyCheckoutStreak());
    } catch {
      // Best-effort persistence.
    }
    await clearEscalationState(deps, logDir);
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
  // a crash-loop is reported through the host-failure hook once per streak, so an
  // unattended host running stale code is visible where the operator actually
  // looks. Delivery is attempted on every run from the threshold on until one
  // report lands or five attempts have failed (Issues #1018, #2110). Every
  // step is best-effort — nothing here may mask the underlying failure.
  const nowSeconds = deps.now();
  let previous: CheckoutUpdateStreak;
  try {
    previous = await deps.readFailureStreak(logDir);
  } catch {
    previous = emptyCheckoutStreak();
  }
  // The start survives the whole streak, so every failure in one ongoing
  // condition is measured from the same moment; a streak that begins here
  // starts now (Issue #1017).
  const streak: CheckoutUpdateStreak = {
    count: previous.count + 1,
    firstFailureAt: previous.count > 0 && previous.firstFailureAt > 0
      ? previous.firstFailureAt
      : nowSeconds,
  };
  try {
    await deps.writeFailureStreak(logDir, streak);
  } catch {
    // Best-effort persistence.
  }

  // Both the count AND the span (Issue #1017): three failures eight seconds
  // apart are one transient glitch, not the hour of stale code this
  // escalation was written to report.
  const escalated = checkoutStreakEscalates(streak, nowSeconds)
    ? await deliverEscalation(deps, {
      repoDir,
      logDir,
      streak: streak.count,
      streakStartedAt: streak.firstFailureAt,
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
    streak: streak.count,
    escalated,
    overwriteNotice: "",
  };
}
