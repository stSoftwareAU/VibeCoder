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
 * existing role as the token-selection gate. The verdict is judged on the
 * token this run selected at start, so a host with a token pool re-judges at
 * the next worker start exactly as it does today.
 *
 * ## What it costs
 *
 * One reading per scan cycle at most, and that reading is re-probed only once
 * it is older than {@link CLAUDE_BUDGET_SNAPSHOT_MAX_AGE_MS} — the same ten
 * minutes the credential pool's snapshots use, so a busy cycle costs nothing.
 * A host with no Claude subscription token in its run environment (every
 * other vendor) makes **no** request and logs nothing: the gate is simply not
 * applicable there.
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
    /** Why it is off — inside the grace, under the threshold, or rolled over. */
    readonly reason: "within-grace" | "on-pace" | "window-elapsed";
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
 * @returns Whether the backlog tiers should be skipped, and the figures.
 */
export function claudeWeekPaceVerdict(
  budget: ClaudeTokenBudget,
  nowMs: number,
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

  const projectedShare = usedShare / elapsedShare;
  return projectedShare >= CLAUDE_WEEK_PACE_THRESHOLD
    ? { state: "engaged", reading: reading(projectedShare) }
    : { state: "off", reading: reading(projectedShare), reason: "on-pace" };
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
  /** Age past which the reading is re-probed. Defaults to the pool's ten minutes. */
  snapshotMaxAgeMs?: number;
  /** Current time source; defaults to the wall clock. */
  now?: () => number;
  /** Sink for the engaged/lifted lines; defaults to discarding them. */
  logInfo?: (message: string) => void;
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

      if (
        snapshot === null || snapshot.token !== token ||
        nowMs - snapshot.observedAtMs > maxAgeMs
      ) {
        snapshot = { budget: await readBudget(), observedAtMs: nowMs, token };
      }

      const verdict = claudeWeekPaceVerdict(snapshot.budget, nowMs);
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
