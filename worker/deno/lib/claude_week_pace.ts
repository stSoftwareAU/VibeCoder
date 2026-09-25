/**
 * Skip the backlog tiers while the weekly Claude quota will not last
 * (Issue #1885).
 *
 * The operator wants the whole seven-day subscription window spent by the
 * time it resets, on as many issues as it covers, highest priority first.
 * Worker start already probes both of Anthropic's windows to pick a token
 * (`claude_token_selection.ts`, snapshotted by `claude_credential_pool.ts`),
 * but issue pickup never consulted the reading: `low-priority` (tier 3) and
 * `idle-task` (tier 4) issues were claimed whenever no higher tier had work,
 * so a week burning far too fast spent its last hours on busywork while
 * `top-priority` issues waited for the reset.
 *
 * This module is the pace gate. {@link claudeWeekPaceVerdict} is **pure** —
 * the clock is a parameter, never a clock of its own — so every rule below is
 * a plain unit test:
 *
 * - **Engaged** when at least {@link CLAUDE_WEEK_PACE_GRACE_HOURS} of the
 *   168-hour window has elapsed *and* the used share divided by the elapsed
 *   share is at or above {@link CLAUDE_WEEK_PACE_THRESHOLD}. That ratio is
 *   the linear projection of the share the window will have reached by its
 *   reset, so at 1.0 the quota lands exactly on the reset — the target — and
 *   anything above it runs out first.
 * - **Off** otherwise. Inside the grace the divisor is tiny and one heavy run
 *   reads as a catastrophic burn, so the projection is not trusted yet. A
 *   `resetAt` already in the past is off too: the window rolled over after
 *   the figure was produced, so the utilisation describes a window that no
 *   longer exists — the same reading `rankClaudeTokenBudgets` treats as a
 *   fresh, full window.
 * - **Unknown** when the probe reported no seven-day window at all (a failed
 *   probe, or a response carrying only the five-hour window). Unknown leaves
 *   the gate **off**, matching the existing rule that a failed probe never
 *   refuses work — it is recorded as a warning, never as a refusal.
 *
 * Only the seven-day window drives this gate; the five-hour window keeps its
 * existing role as the token-selection gate.
 *
 * ## A pool is judged as a pool (Issue #2647)
 *
 * On a host with two or more Claude subscriptions the question is not
 * whether the token this run holds lasts — one nearly spent token says
 * nothing when another has plenty left or reopens in a few hours — but
 * whether the **pool** lasts. {@link claudePoolWeekPaceVerdict} answers it,
 * as purely as the single-token verdict:
 *
 * 1. **Burn rate** — the sum over credentials of `usedShare / elapsedHours`
 *    of each one's own window: the rate the host has been drawing weekly
 *    share, in windows per hour. A credential inside the grace, or whose
 *    window has rolled over, has no trustworthy rate and is left out of it.
 * 2. **Capacity walk** — start from the sum of every credential's remaining
 *    share, and step through the reset times in order. Between resets the
 *    capacity is drawn down at the burn rate, soonest-expiring credential
 *    first; at each reset that credential's week reopens with a full window.
 *    The walk ends at the latest reset in the pool (at most 168 hours out).
 * 3. **Verdict** — engaged if capacity reaches zero before the next
 *    reopening would refill it; off otherwise.
 *
 * A credential whose reading is unknown, or which reports no seven-day
 * window, is left out of both the rate and the capacity (headroom has to be
 * evidenced); a pool with no usable reading at all is unknown. A host with a
 * single token is judged by {@link claudeWeekPaceVerdict} exactly as before.
 *
 * ## What it costs
 *
 * One reading per scan cycle at most, and that reading is re-probed only once
 * it is older than {@link CLAUDE_BUDGET_SNAPSHOT_MAX_AGE_MS} — the same ten
 * minutes the credential pool's snapshots use, so a busy cycle costs nothing.
 * A host with no Claude subscription token in its run environment (every
 * other vendor) makes **no** request and logs nothing: the gate is simply not
 * applicable there. A pooled host reads the credential pool's own snapshots
 * (`readPoolBudgets`), which follow the same ten-minute rule, so the pool
 * verdict adds no request of its own beyond refreshing a stale snapshot.
 *
 * The token value is never an input to anything this module formats, so it
 * cannot reach a log line.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  activeAgentProvider,
  type AgentProviderDescriptor,
  CLAUDE_PROVIDER_ID,
} from "./agent_provider.ts";
import {
  type ClaudeBudgetFetch,
  type ClaudeTokenBudget,
  probeClaudeTokenBudget,
} from "./claude_token_budget.ts";
import { CLAUDE_BUDGET_SNAPSHOT_MAX_AGE_MS } from "./claude_credential_pool.ts";
import {
  CLAUDE_WEEK_PACE_GRACE_HOURS,
  CLAUDE_WEEK_PACE_THRESHOLD,
} from "./claude_token_selection.ts";

/** Prefix shared by every line this module logs. Greppable, and its own. */
export const CLAUDE_WEEK_PACE_LOG_PREFIX = "claude-week-pace:";

/** One hour, in milliseconds. */
const HOUR_MS = 3_600_000;

/** Nominal length of Anthropic's seven-day window, in hours. */
export const SEVEN_DAY_WINDOW_HOURS = 168;

/** The figures the verdict was computed from, and reports. */
export interface ClaudeWeekPaceReading {
  /** Share of the weekly quota already spent, in `[0, 1]`. */
  readonly usedShare: number;
  /** Share of the 168-hour window already elapsed. */
  readonly elapsedShare: number;
  /**
   * Share the quota is projected to reach by the reset — `usedShare` divided
   * by `elapsedShare`. At or above {@link CLAUDE_WEEK_PACE_THRESHOLD} the
   * quota runs out before the window does.
   *
   * `null` when there is no projection to report: inside the 24 h grace the
   * divisor is too small to trust, and a window that has already rolled over
   * has no reset left to project to. Reporting the used share in its place
   * would put a figure on the log line that nothing computed.
   */
  readonly projectedShare: number | null;
  /** When the window resets, in epoch milliseconds. */
  readonly resetAt: number;
}

/** What the weekly window says about claiming backlog work. */
export type ClaudeWeekPaceVerdict =
  /** The week will not last: tiers 3 and 4 are skipped. */
  | { readonly state: "engaged"; readonly reading: ClaudeWeekPaceReading }
  /** The week is on pace, or too young to judge: every tier runs. */
  | {
    readonly state: "off";
    readonly reading: ClaudeWeekPaceReading;
    /**
     * Why it is off — inside the grace, under the threshold, rolled over,
     * or the operator's drain mode (Issue #2474).
     */
    readonly reason: "within-grace" | "on-pace" | "window-elapsed" | "drain";
  }
  /** No seven-day window was reported: every tier runs, with a warning. */
  | { readonly state: "unknown"; readonly reason: string };

/**
 * Judge the weekly quota's pace from one probe result (Issue #1885).
 *
 * @param budget - The probe outcome for the token this run selected.
 * @param nowMs - Current time in epoch milliseconds (a parameter, never a
 *   clock of this function's own, so every rule is deterministically
 *   testable).
 * @param options - `drain` opts the operator into draining the held token
 *   to zero: the verdict stays off while any budget remains, whatever the
 *   projection says, and the pool's token selection plus the run-level
 *   outage fallback own the switch-over at exhaustion.
 * @returns Whether the backlog tiers should be skipped, and the figures.
 */
export function claudeWeekPaceVerdict(
  budget: ClaudeTokenBudget,
  nowMs: number,
  options: { drain?: boolean } = {},
): ClaudeWeekPaceVerdict {
  if (!budget.known) {
    return {
      state: "unknown",
      reason: `budget unknown (${budget.reason})`,
    };
  }
  const sevenDay = budget.windows.find((w) => w.window === "seven_day");
  if (sevenDay === undefined) {
    return {
      state: "unknown",
      reason: "the probe reported no seven-day window",
    };
  }

  const windowMs = SEVEN_DAY_WINDOW_HOURS * HOUR_MS;
  const usedShare = 1 - sevenDay.remainingFraction;
  const elapsedMs = windowMs - (sevenDay.resetAt - nowMs);
  const elapsedShare = elapsedMs / windowMs;
  // Divide once, and only where the divisor is known to be a real fraction of
  // the window: `elapsedShare` is at least the grace share on every path that
  // reaches the projection.
  const reading = (projected: number | null): ClaudeWeekPaceReading => ({
    usedShare,
    elapsedShare,
    projectedShare: projected,
    resetAt: sevenDay.resetAt,
  });

  // A reset already behind us describes a window that has since rolled over,
  // so its utilisation says nothing about the week the run is now in.
  if (sevenDay.resetAt <= nowMs) {
    return { state: "off", reading: reading(null), reason: "window-elapsed" };
  }
  if (elapsedMs < CLAUDE_WEEK_PACE_GRACE_HOURS * HOUR_MS) {
    return { state: "off", reading: reading(null), reason: "within-grace" };
  }

  // Drain mode (Issue #2474): the operator prefers the held token be used
  // to zero rather than parked at a projection. Every tier stays eligible
  // while any budget remains; a spent token is the run-level outage
  // fallback's business, not this guard's.
  if (options.drain === true) {
    return { state: "off", reading: reading(null), reason: "drain" };
  }

  const projectedShare = usedShare / elapsedShare;
  return projectedShare >= CLAUDE_WEEK_PACE_THRESHOLD
    ? { state: "engaged", reading: reading(projectedShare) }
    : { state: "off", reading: reading(projectedShare), reason: "on-pace" };
}

/** The pool-wide figures the verdict was computed from, and reports. */
export interface ClaudePoolWeekPaceReading {
  /** Credentials in the pool, usable reading or not. */
  readonly total: number;
  /** Credentials with a usable seven-day reading, counted in the capacity. */
  readonly counted: number;
  /** Credentials whose own window gave a trustworthy burn rate. */
  readonly rated: number;
  /** Sum of every counted credential's remaining share, in windows. */
  readonly remainingShare: number;
  /** Weekly share the pool is drawing, in windows per hour. */
  readonly burnPerHour: number;
  /**
   * When capacity reaches zero before a reopening refills it, in epoch
   * milliseconds; `null` when it never does inside the walk.
   */
  readonly runsOutAt: number | null;
  /**
   * The reopening judged against: the one capacity ran out before when
   * engaged, otherwise the soonest one ahead; `null` when none lies ahead.
   */
  readonly nextReopenAt: number | null;
}

/** What the pool's weekly windows say about claiming backlog work. */
export type ClaudePoolWeekPaceVerdict =
  /** The pool will not last: tiers 3 and 4 are skipped. */
  | { readonly state: "engaged"; readonly reading: ClaudePoolWeekPaceReading }
  /** The pool lasts, or nothing gives a rate yet: every tier runs. */
  | {
    readonly state: "off";
    readonly reading: ClaudePoolWeekPaceReading;
    /**
     * `within-grace` and `window-elapsed` mean no credential gave a rate to
     * project with, for the same reasons the single-token verdict gives.
     */
    readonly reason: "within-grace" | "on-pace" | "window-elapsed" | "drain";
  }
  /** No credential reported a usable seven-day window: a warning. */
  | { readonly state: "unknown"; readonly reason: string };

/** One credential's place in the capacity walk. */
interface PoolCredential {
  /** Remaining share of its current window. */
  remaining: number;
  /** When that window reopens; `Infinity` when not inside the walk. */
  resetAt: number;
}

/**
 * The seven-day window of a known budget, when it is a usable reading.
 *
 * The five-hour window is deliberately never read: it is the token-selection
 * gate's, and a five-hour exhaustion says nothing about the week.
 */
function usableSevenDay(
  budget: ClaudeTokenBudget,
): { remainingFraction: number; resetAt: number } | null {
  if (!budget.known) return null;
  const window = budget.windows.find((w) => w.window === "seven_day");
  if (window === undefined) return null;
  if (
    !Number.isFinite(window.remainingFraction) ||
    !Number.isFinite(window.resetAt)
  ) {
    return null;
  }
  return {
    remainingFraction: Math.min(1, Math.max(0, window.remainingFraction)),
    resetAt: window.resetAt,
  };
}

/**
 * Judge the weekly quota's pace across a whole credential pool (Issue #2647).
 *
 * "Won't make it" means the pool as a whole runs out before capacity reopens
 * at the current burn rate — see the module comment for the model. One
 * nearly spent credential beside a fresh one, or beside one about to reopen,
 * leaves the gate off.
 *
 * A pool of exactly one budget takes its state from
 * {@link claudeWeekPaceVerdict}, so a single-credential host behaves exactly
 * as it always has; the pool figures are still reported.
 *
 * @param budgets - One probe outcome per pool credential.
 * @param nowMs - Current time in epoch milliseconds (a parameter, never a
 *   clock of this function's own).
 * @param options - `drain` (Issue #2474): off while any reading is usable.
 * @returns Whether the backlog tiers should be skipped, and the figures.
 */
export function claudePoolWeekPaceVerdict(
  budgets: readonly ClaudeTokenBudget[],
  nowMs: number,
  options: { drain?: boolean } = {},
): ClaudePoolWeekPaceVerdict {
  const windowMs = SEVEN_DAY_WINDOW_HOURS * HOUR_MS;
  const graceMs = CLAUDE_WEEK_PACE_GRACE_HOURS * HOUR_MS;
  const credentials: PoolCredential[] = [];
  let burnPerHour = 0;
  let rated = 0;
  let inGrace = 0;
  const unusable: string[] = [];

  for (const budget of budgets) {
    const window = usableSevenDay(budget);
    if (window === null) {
      unusable.push(
        budget.known
          ? `${budget.label}: no seven-day window`
          : `${budget.label}: ${budget.reason}`,
      );
      continue;
    }
    if (window.resetAt <= nowMs) {
      // Rolled over since the reading: a fresh, full window with no rate.
      credentials.push({ remaining: 1, resetAt: Number.POSITIVE_INFINITY });
      continue;
    }
    const elapsedMs = windowMs - (window.resetAt - nowMs);
    credentials.push({
      remaining: window.remainingFraction,
      resetAt: window.resetAt,
    });
    if (elapsedMs < graceMs) {
      inGrace++;
      continue;
    }
    burnPerHour += (1 - window.remainingFraction) / (elapsedMs / HOUR_MS);
    rated++;
  }

  if (credentials.length === 0) {
    return {
      state: "unknown",
      reason: `no credential in the pool reported a usable seven-day window ` +
        `(${unusable.join("; ") || "empty pool"})`,
    };
  }

  const walk = walkPoolCapacity(credentials, burnPerHour, nowMs);
  const reading: ClaudePoolWeekPaceReading = {
    total: budgets.length,
    counted: credentials.length,
    rated,
    remainingShare: credentials.reduce((sum, c) => sum + c.remaining, 0),
    burnPerHour,
    runsOutAt: walk.runsOutAt,
    nextReopenAt: walk.nextReopenAt,
  };

  const only = budgets.length === 1 ? budgets[0] : undefined;
  if (only !== undefined) {
    // One credential: the state is the single-token verdict's, unchanged.
    const single = claudeWeekPaceVerdict(only, nowMs, options);
    if (single.state === "unknown") return single;
    return single.state === "engaged"
      ? { state: "engaged", reading }
      : { state: "off", reading, reason: single.reason };
  }

  if (options.drain === true) return { state: "off", reading, reason: "drain" };
  if (rated === 0) {
    return {
      state: "off",
      reading,
      reason: inGrace > 0 ? "within-grace" : "window-elapsed",
    };
  }
  return walk.runsOutAt === null
    ? { state: "off", reading, reason: "on-pace" }
    : { state: "engaged", reading };
}

/**
 * Walk the pool's capacity forward through its reopenings.
 *
 * Between two reopenings the capacity is drawn down at the burn rate from the
 * soonest-expiring credential first (share still on a window when it reopens
 * is lost, so it is the share to spend first); at each reopening that
 * credential's window refills to a full one. Capacity reaching zero at or
 * before a reopening is "won't make it" — the single-token threshold, where a
 * projection landing exactly on the reset engages.
 *
 * Pure; mutates only its own copy of the credentials.
 */
function walkPoolCapacity(
  initial: readonly PoolCredential[],
  burnPerHour: number,
  nowMs: number,
): { runsOutAt: number | null; nextReopenAt: number | null } {
  const credentials = initial.map((c) => ({ ...c }));
  const horizon = nowMs + SEVEN_DAY_WINDOW_HOURS * HOUR_MS;
  const reopenings = [
    ...new Set(
      credentials.map((c) => c.resetAt).filter((at) =>
        at > nowMs && at <= horizon
      ),
    ),
  ].sort((a, b) => a - b);
  const firstReopen = reopenings[0] ?? null;
  const perMs = burnPerHour / HOUR_MS;
  if (!(perMs > 0)) return { runsOutAt: null, nextReopenAt: firstReopen };

  let at = nowMs;
  for (const reopenAt of reopenings) {
    const capacity = credentials.reduce((sum, c) => sum + c.remaining, 0);
    let need = perMs * (reopenAt - at);
    if (need >= capacity) {
      return { runsOutAt: at + capacity / perMs, nextReopenAt: reopenAt };
    }
    credentials.sort((a, b) => a.resetAt - b.resetAt);
    for (const credential of credentials) {
      const draw = Math.min(credential.remaining, need);
      credential.remaining -= draw;
      need -= draw;
    }
    for (const credential of credentials) {
      if (credential.resetAt === reopenAt) {
        credential.remaining = 1;
        // Its next reopening is a week on, beyond the walk.
        credential.resetAt = Number.POSITIVE_INFINITY;
      }
    }
    at = reopenAt;
  }
  return { runsOutAt: null, nextReopenAt: firstReopen };
}

/** Render a share as a percentage. */
function formatShare(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Render a reset instant as ISO-8601 UTC, as the budget surfaces do. */
function formatReset(epochMs: number): string {
  const at = new Date(epochMs);
  return Number.isFinite(at.getTime()) ? at.toISOString() : "unparseable";
}

/** The figures every pace line carries, in one shape. */
function describeReading(reading: ClaudeWeekPaceReading): string {
  const projected = reading.projectedShare === null
    ? "not-projected"
    : formatShare(reading.projectedShare);
  return `used=${formatShare(reading.usedShare)} ` +
    `elapsed=${formatShare(reading.elapsedShare)} ` +
    `projected=${projected} at reset ` +
    `${formatReset(reading.resetAt)}`;
}

/**
 * The line an engaged gate logs, once per scan cycle.
 *
 * Pure, so a test can assert the exact text.
 *
 * @param reading - The figures the verdict was computed from.
 * @returns The INFO line to log.
 */
export function formatWeekPaceEngagedLine(
  reading: ClaudeWeekPaceReading,
): string {
  return `${CLAUDE_WEEK_PACE_LOG_PREFIX} engaged — ${
    describeReading(reading)
  }; ` +
    `skipping low-priority and idle-task pickup so the remaining weekly ` +
    `quota goes to top-priority and work-on issues (Issue #1885)`;
}

/**
 * The line logged once when the gate lifts.
 *
 * @param reading - The figures that lifted it.
 * @returns The INFO line to log.
 */
export function formatWeekPaceLiftedLine(
  reading: ClaudeWeekPaceReading,
): string {
  return `${CLAUDE_WEEK_PACE_LOG_PREFIX} lifted — ${
    describeReading(reading)
  }; ` +
    `low-priority and idle-task pickup resumed`;
}

/**
 * The pool figures every pool pace line carries (Issue #2647): credentials
 * counted, remaining capacity, burn rate per hour, and when capacity runs out
 * against the next reopening. Labels and shares only — no token value is an
 * input here, so none can reach the line.
 */
function describePoolReading(reading: ClaudePoolWeekPaceReading): string {
  const runsOut = reading.runsOutAt === null
    ? "never before a reopening"
    : formatReset(reading.runsOutAt);
  const reopen = reading.nextReopenAt === null
    ? "none ahead"
    : formatReset(reading.nextReopenAt);
  return `pool counted=${reading.counted}/${reading.total} ` +
    `rated=${reading.rated} ` +
    `remaining=${formatShare(reading.remainingShare)} ` +
    `burn=${(reading.burnPerHour * 100).toFixed(2)}%/h ` +
    `runs-out=${runsOut} next-reopen=${reopen}`;
}

/**
 * The line an engaged pool gate logs (Issue #2647). Pure.
 *
 * @param reading - The pool figures the verdict was computed from.
 * @returns The INFO line to log.
 */
export function formatPoolWeekPaceEngagedLine(
  reading: ClaudePoolWeekPaceReading,
): string {
  return `${CLAUDE_WEEK_PACE_LOG_PREFIX} engaged — ${
    describePoolReading(reading)
  }; the pool runs out before capacity reopens, so low-priority and ` +
    `idle-task pickup is skipped and the remaining weekly quota goes to ` +
    `top-priority and work-on issues (Issues #1885, #2647)`;
}

/**
 * The line logged once when the pool gate lifts (Issue #2647). Pure.
 *
 * @param reading - The pool figures that lifted it.
 * @returns The INFO line to log.
 */
export function formatPoolWeekPaceLiftedLine(
  reading: ClaudePoolWeekPaceReading,
): string {
  return `${CLAUDE_WEEK_PACE_LOG_PREFIX} lifted — ${
    describePoolReading(reading)
  }; low-priority and idle-task pickup resumed`;
}

/**
 * The line an unknown reading logs, once per scan cycle.
 *
 * @param reason - Why the reading is unknown.
 * @returns The WARNING line to log.
 */
export function formatWeekPaceUnknownLine(reason: string): string {
  return `${CLAUDE_WEEK_PACE_LOG_PREFIX} unknown — ${reason}; every tier ` +
    `stays eligible, because a failed probe must never refuse work`;
}

/** Injection points and bounds; production passes only the log sinks. */
export interface ClaudeWeekPaceGateOptions {
  /**
   * The run's Claude subscription token, or null/empty when this run has
   * none — the single token worker start exported (Issue #919), so the
   * verdict is judged on the token the run is actually spending.
   *
   * Production declares it at the wiring site rather than leaving it ambient
   * (Issue #1177); the `CLAUDE_CODE_OAUTH_TOKEN` fallback below exists only
   * so a caller with no env lookup of its own is not forced to invent one.
   */
  token?: () => string | null;
  /** Injected `fetch`, forwarded to the probe. */
  fetchFn?: ClaudeBudgetFetch;
  /** Per-probe timeout, forwarded to the probe. */
  timeoutMs?: number;
  /** Endpoint override, for tests that assert what was called. */
  url?: string;
  /** Reading seam; defaults to one bounded probe of {@link token}. */
  readBudget?: () => Promise<ClaudeTokenBudget>;
  /**
   * Every credential's reading on a pooled host (Issue #2647) — production
   * passes the credential pool's `readPoolBudgets`, which keeps its own
   * ten-minute snapshots. `null`, or fewer than two readings, means a
   * single-token host, judged on {@link token} exactly as before.
   */
  readPoolBudgets?: (
    nowMs: number,
  ) => Promise<readonly ClaudeTokenBudget[] | null>;
  /** Age past which the reading is re-probed. Defaults to the pool's ten minutes. */
  snapshotMaxAgeMs?: number;
  /** Current time source; defaults to the wall clock. */
  now?: () => number;
  /** Sink for the engaged/lifted lines; defaults to discarding them. */
  logInfo?: (message: string) => void;
  /**
   * Drain mode (Issue #2474): never engage while the held token has any
   * budget. The verdict is off with reason `drain`; the pool's token
   * selection and the outage fallback own the switch-over at exhaustion.
   */
  drain?: boolean;
  /** Sink for the unknown-reading line; defaults to discarding it. */
  logWarn?: (message: string) => void;
  /**
   * The provider this run's coding agent uses; defaults to the active one.
   * Only a Claude run is paced by a Claude subscription window.
   */
  provider?: AgentProviderDescriptor;
}

/** The gate one worker process holds for the life of the run. */
export interface ClaudeWeekPaceGate {
  /**
   * Judge this scan cycle, logging the one line the verdict calls for.
   *
   * @param nowMs - Current epoch-ms; defaults to the injected clock.
   * @returns True when the backlog tiers must be skipped this cycle.
   */
  isEngaged(nowMs?: number): Promise<boolean>;

  /**
   * The verdict this gate last computed — no probe, no request, no line.
   *
   * For observers that must model the same refusal the scan applied (the
   * idle-decision census), so a tier the gate skipped is not counted as work
   * the scan mysteriously refused.
   *
   * @returns True when the last {@link isEngaged} call said engaged.
   */
  lastEngaged(): boolean;
}

/**
 * Build the per-run pace gate the Priority 2 scan consults (Issue #1885).
 *
 * Never throws and never refuses: a probe that fails, a response carrying no
 * seven-day window, and a run with no Claude subscription token all answer
 * `false`, which is exactly today's pickup order.
 *
 * @param options - Injected token, bounds, clock and log sinks.
 * @returns The gate.
 */
export function createClaudeWeekPaceGate(
  options: ClaudeWeekPaceGateOptions = {},
): ClaudeWeekPaceGate {
  const clock = options.now ?? (() => Date.now());
  const logInfo = options.logInfo ?? (() => {});
  const logWarn = options.logWarn ?? (() => {});
  const maxAgeMs = options.snapshotMaxAgeMs ??
    CLAUDE_BUDGET_SNAPSHOT_MAX_AGE_MS;
  const readToken = options.token ?? defaultTokenReader;
  const readBudget = options.readBudget ?? defaultBudgetReader;

  /**
   * The last reading, when it was observed, and the token it describes.
   *
   * Keyed by token because the credential pool may replace the run's token
   * mid-run (`applySelection`): a snapshot taken against the previous
   * subscription says nothing about the new one's week, so a switch discards
   * it rather than mixing two tokens' figures into one verdict.
   */
  let snapshot:
    | { budget: ClaudeTokenBudget; observedAtMs: number; token: string }
    | null = null;
  /** Whether the previous cycle's verdict was engaged, so a lift logs once. */
  let wasEngaged = false;
  /** The last line logged, so a repeated reading is not repeated per slot. */
  let lastLine: string | null = null;

  return {
    async isEngaged(nowMs = clock()): Promise<boolean> {
      // Another vendor's run must not be paced by a Claude subscription it is
      // not spending — a stale `CLAUDE_CODE_OAUTH_TOKEN` left in a shared
      // environment would otherwise gate pickup on a quota nothing consumes.
      if (!isClaudeRun()) return setVerdict(false);

      const token = readToken();
      // No Claude subscription in this run's environment. Not applicable
      // rather than unknown: no request, and no line.
      if (token === null || token.trim().length === 0) return setVerdict(false);

      // Issue #2647: a pooled host is judged across every credential, not on
      // the one token this run happens to hold.
      const pool = await readPool(nowMs);
      if (pool !== null && "failed" in pool) {
        say(logWarn, formatWeekPaceUnknownLine(pool.failed));
        return setVerdict(false);
      }
      if (pool !== null && pool.length >= 2) {
        const verdict = claudePoolWeekPaceVerdict(pool, nowMs, {
          drain: options.drain === true,
        });
        if (verdict.state === "unknown") {
          say(logWarn, formatWeekPaceUnknownLine(verdict.reason));
          return setVerdict(false);
        }
        if (verdict.state === "engaged") {
          say(logInfo, formatPoolWeekPaceEngagedLine(verdict.reading));
          return setVerdict(true);
        }
        if (wasEngaged) {
          say(logInfo, formatPoolWeekPaceLiftedLine(verdict.reading));
        }
        return setVerdict(false);
      }

      if (
        snapshot === null || snapshot.token !== token ||
        nowMs - snapshot.observedAtMs > maxAgeMs
      ) {
        snapshot = { budget: await readBudget(), observedAtMs: nowMs, token };
      }

      const verdict = claudeWeekPaceVerdict(snapshot.budget, nowMs, {
        drain: options.drain === true,
      });
      if (verdict.state === "unknown") {
        say(logWarn, formatWeekPaceUnknownLine(verdict.reason));
        return setVerdict(false);
      }
      if (verdict.state === "engaged") {
        say(logInfo, formatWeekPaceEngagedLine(verdict.reading));
        return setVerdict(true);
      }
      if (wasEngaged) say(logInfo, formatWeekPaceLiftedLine(verdict.reading));
      return setVerdict(false);
    },

    lastEngaged: () => wasEngaged,
  };

  /** Record the verdict for {@link ClaudeWeekPaceGate.lastEngaged}. */
  function setVerdict(engaged: boolean): boolean {
    wasEngaged = engaged;
    return engaged;
  }

  /**
   * Log `line` unless it is the one already on the record.
   *
   * A cycle asks the gate once per slot, and the reading behind the answer
   * changes at most every ten minutes, so logging every call would repeat one
   * sentence thousands of times over an engaged week. Every *change* — the
   * gate engaging, lifting, or the figures moving — still lands.
   */
  function say(sink: (message: string) => void, line: string): void {
    if (line === lastLine) return;
    lastLine = line;
    sink(line);
  }

  /**
   * Every pool credential's reading, null for a single-token host, or the
   * reason the pool could not be read. Never throws: a pool that cannot be
   * read is an unknown reading, never a hold.
   */
  async function readPool(
    nowMs: number,
  ): Promise<readonly ClaudeTokenBudget[] | null | { failed: string }> {
    if (options.readPoolBudgets === undefined) return null;
    try {
      return await options.readPoolBudgets(nowMs);
    } catch (error: unknown) {
      return {
        failed: `the credential pool could not be read (${
          error instanceof Error ? error.name : "unknown error"
        })`,
      };
    }
  }

  /** True when this run's coding agent is Claude. */
  function isClaudeRun(): boolean {
    try {
      return (options.provider ?? activeAgentProvider()).id ===
        CLAUDE_PROVIDER_ID;
    } catch {
      // An unresolvable provider is not a licence to gate: answer "not
      // Claude", which leaves every tier eligible.
      return false;
    }
  }

  /** The single Claude token worker start exported into this process. */
  function defaultTokenReader(): string | null {
    try {
      return Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN") ?? null;
    } catch (error: unknown) {
      // Loud, not silent: a permission denial must not read the same as "this
      // host holds no Claude subscription". Both leave the gate off, but only
      // one of them is a fault, and it says so.
      logWarn(
        `${CLAUDE_WEEK_PACE_LOG_PREFIX} could not read this run's Claude ` +
          `token from the environment (${
            error instanceof Error ? error.name : "unknown error"
          }) — the weekly pace gate stays off`,
      );
      return null;
    }
  }

  /** One bounded probe of the run's token. Never throws. */
  async function defaultBudgetReader(): Promise<ClaudeTokenBudget> {
    try {
      return await probeClaudeTokenBudget(readToken() ?? "", {
        label: "week-pace",
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs,
        url: options.url,
      });
    } catch (error: unknown) {
      // The probe documents that it never throws; if it ever does, the answer
      // is an explicit unknown, never an assumed budget.
      return {
        known: false,
        label: "week-pace",
        reason: "network-error",
        detail: error instanceof Error ? error.name : "probe threw",
      };
    }
  }
}
