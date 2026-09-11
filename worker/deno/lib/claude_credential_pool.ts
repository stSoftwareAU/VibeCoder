/**
 * The process-wide Claude credential pool (Issue #1668, parent #1653).
 *
 * Worker start already ranks the host's Claude subscriptions and exports the
 * winner (#919, reshaped by #1623), but that decision was taken once and never
 * revisited: a subscription that ran out part-way through a run took the retry
 * ladder and failed the run while another token in the pool sat untouched, and
 * nothing on the record said which candidates existed or why one was chosen.
 *
 * This module is the missing middle. It holds one **budget snapshot per
 * token**, refreshes only what has gone stale, applies #1623's gate and
 * ranking on demand, and replaces the run's single exported token when asked:
 *
 * - {@link ClaudeCredentialPool.recordBudget} takes figures the run already
 *   has — the latest `rate_limit_event`, or a probe made elsewhere — so a
 *   selection made moments later costs no request at all.
 * - {@link ClaudeCredentialPool.recordExhaustion} marks a token's window spent
 *   from a usage-limit result. The API has just said the window is gone;
 *   probing to be told so again is a request spent to learn nothing.
 * - {@link ClaudeCredentialPool.selectEligible} refreshes any snapshot older
 *   than {@link CLAUDE_BUDGET_SNAPSHOT_MAX_AGE_MS}, ranks the pool, and
 *   returns the winner **only when it passes the five-hour gate**. Nothing
 *   worth switching to means `null`, never a token that would stall on its
 *   first call.
 * - {@link ClaudeCredentialPool.selectToken} is the same ranking wired as the
 *   start-up {@link ProviderTokenSelector} — with the gate applied as a
 *   *reason*, never as a filter. A start never refuses: refusing to spawn is
 *   a question for whatever gates a spawn, and a worker that would not start
 *   because every token is low is strictly worse than one that starts on the
 *   token which refills first.
 * - A credential the **active usage signal** names as spent is out of the
 *   running while another candidate exists (Issue #2002), at start-up and on
 *   a mid-run switch alike. Without it, a start whose every budget probe
 *   failed fell through to discovery order and re-picked the very
 *   subscription whose signal was pausing the host.
 * - {@link ClaudeCredentialPool.applySelection} sets exactly the selected
 *   file's subscription OAuth variable, **replacing** the previous value.
 *   `applyProviderCredentialEnv` deliberately never clobbers — right for
 *   start-up, wrong for a switch — hence a separate function here. Nothing
 *   else is exported, so the Issue #919 guarantee that the environment carries
 *   exactly one subscription's credential still holds.
 *
 * Start-up and mid-run therefore share **one** snapshot store and **one**
 * rule, and every selection logs every candidate through
 * {@link formatClaudeTokenSelectionLog}, so both surfaces read alike.
 *
 * ## What it costs
 *
 * Nothing, on the hosts that cannot use it. Fewer than two pool candidates —
 * every single-token host, and every other vendor — means zero requests, zero
 * log lines, and behaviour identical to today. Otherwise a selection probes
 * only the candidates whose snapshot has gone stale, and concurrent
 * selections share one in-flight probe per token rather than issuing one each.
 *
 * The environment is shared by every slot on the host, so a switch affects
 * spawns that start **after** it; agents already running keep the environment
 * they were given.
 *
 * Tokens are identified by **label** (`provider`, `provider-2`) throughout.
 * No token value is an input to anything this module logs, so none can reach a
 * log line, a comment or an error message.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  activeAgentProvider,
  type AgentProviderDescriptor,
} from "./agent_provider.ts";
import { recordActiveCredentialLabel } from "./active_credential.ts";
import {
  type ClaudeBudgetFetch,
  type ClaudeBudgetWindowName,
  type ClaudeTokenBudget,
  type ClaudeTokenBudgetWindow,
  probeClaudeTokenBudget,
} from "./claude_token_budget.ts";
import {
  formatClaudeTokenSelectionLog,
  rankClaudeTokenBudgets,
} from "./claude_token_selection.ts";
import {
  discoverProviderTokenFiles,
  type EnvLookup,
  providerPoolCandidates,
  type ProviderTokenFile,
  type ProviderTokenSelector,
  resolveCredentialDir,
  selectFirstProviderToken,
} from "./credential_preflight.ts";

/**
 * How old a budget snapshot may be before a selection re-measures it.
 *
 * Ten minutes: long enough that the probes of one start-up serve the
 * selections of the next few minutes for free, short enough that a token
 * burned down by a parallel slot is not chosen on figures describing a
 * subscription that no longer has them. Stated in `docs/SETUP.md` so an
 * operator reading the log knows when a fresh request is expected.
 */
export const CLAUDE_BUDGET_SNAPSHOT_MAX_AGE_MS = 10 * 60_000;

/** Prefix shared by every line this module logs itself. */
const LOG_PREFIX = "[SECURITY] claude token pool";

/** One window a usage-limit result reported as spent. */
export interface ClaudeExhaustedWindow {
  /** Which window ran out. */
  readonly window: ClaudeBudgetWindowName;
  /** When it rolls over, in epoch milliseconds. */
  readonly resetAt: number;
}

/** One token's last known budget, and when it was observed. */
export interface ClaudeBudgetSnapshot {
  /** The figures themselves. */
  readonly budget: ClaudeTokenBudget;
  /** When they were observed, in epoch milliseconds. */
  readonly observedAtMs: number;
}

/** Injection points and bounds; production passes only a log sink. */
export interface ClaudeCredentialPoolOptions {
  /** Injected `fetch`; production passes nothing and gets the global. */
  fetchFn?: ClaudeBudgetFetch;
  /** Per-probe timeout, forwarded to {@link probeClaudeTokenBudget}. */
  timeoutMs?: number;
  /** Endpoint override, for tests that assert what was called. */
  url?: string;
  /** Current time source; defaults to the wall clock. */
  now?: () => number;
  /** Where the decision log goes; defaults to discarding it. */
  log?: (message: string) => void;
  /** Snapshot age past which a candidate is re-probed. */
  snapshotMaxAgeMs?: number;
  /** Credential directory; defaults to the resolved one. */
  dir?: string;
  /** Environment lookup used to resolve the credential directory. */
  env?: EnvLookup;
  /** Provider whose pool this is; defaults to the active provider. */
  provider?: AgentProviderDescriptor;
  /** Token discovery seam; defaults to reading the credential directory. */
  discover?: () => Promise<readonly ProviderTokenFile[]>;
  /** Selector used at start-up when there is nothing to choose between. */
  fallback?: ProviderTokenSelector;
  /**
   * The credential an active usage signal says is spent, if any (Issue
   * #2002). Production reads the shared `.rate_limit_signal`; omitting it
   * keeps the pool's historical behaviour, where nothing told selection that
   * a token had already run out.
   *
   * Asked with the id of the provider this pool ranks: a label is a file stem
   * every vendor reproduces, so another vendor's exhaustion must not exclude
   * a healthy credential of the same name.
   */
  spentCredentialLabel?: (providerId: string) => Promise<string | undefined>;
}

/** The pool's operations. One instance serves a whole worker process. */
export interface ClaudeCredentialPool {
  /**
   * Record figures the run already holds, so the next selection need not
   * measure this token again.
   *
   * @param label - The token's file stem, never its value.
   * @param budget - The figures, exactly as a probe would report them.
   * @param observedAtMs - When they were observed, in epoch milliseconds.
   */
  recordBudget(
    label: string,
    budget: ClaudeTokenBudget,
    observedAtMs: number,
  ): void;

  /**
   * Mark a token's windows spent from a usage-limit result, with no probe.
   *
   * @param label - The token's file stem, never its value.
   * @param windows - The windows the result reported as exhausted, with their
   *   resets. Must name at least one — an exhaustion recording nothing would
   *   quietly leave the spent token eligible.
   */
  recordExhaustion(
    label: string,
    windows: readonly ClaudeExhaustedWindow[],
  ): void;

  /**
   * The best token worth switching to right now, or null when none is.
   *
   * @param now - Current time in epoch milliseconds; defaults to the clock.
   * @returns The winning token file, or null when nothing passes the gate or
   *   the host has fewer than two pool candidates.
   */
  selectEligible(now?: number): Promise<ProviderTokenFile | null>;

  /** The start-up selector: the ranking winner, with no gate filter. */
  readonly selectToken: ProviderTokenSelector;

  /**
   * Replace the run environment's Claude subscription token with this file's.
   *
   * @param token - The token file to switch to.
   * @param setEnv - Establishes a variable in the run environment.
   * @returns The single variable name that was set.
   * @throws When the file carries no subscription OAuth token to switch to.
   */
  applySelection(
    token: ProviderTokenFile,
    setEnv: (name: string, value: string) => void,
  ): string;
}

/**
 * Build a budget snapshot for a token whose windows are known to be spent.
 *
 * The headline figure is the soonest of them: with every named window at zero
 * the constraint that bites first is the one that reopens first.
 */
function exhaustedBudget(
  label: string,
  windows: readonly ClaudeExhaustedWindow[],
): ClaudeTokenBudget {
  const spent: ClaudeTokenBudgetWindow[] = windows.map((window) => ({
    window: window.window,
    remainingFraction: 0,
    resetAt: window.resetAt,
  }));
  const headline = spent.reduce((soonest, candidate) =>
    candidate.resetAt < soonest.resetAt ? candidate : soonest
  );
  return {
    known: true,
    label,
    remainingFraction: 0,
    resetAt: headline.resetAt,
    window: headline.window,
    windows: spent,
  };
}

/**
 * Create a Claude credential pool.
 *
 * The instance is built **once per worker process** (`run_worker.ts` builds
 * it in `createDefaultRunWorkerDeps`), so start-up and every later selection
 * share one snapshot store.
 *
 * @param options - Injected bounds, clock, log sink, discovery and fallback.
 * @returns The pool.
 */
export function createClaudeCredentialPool(
  options: ClaudeCredentialPoolOptions = {},
): ClaudeCredentialPool {
  const clock = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const maxAgeMs = options.snapshotMaxAgeMs ??
    CLAUDE_BUDGET_SNAPSHOT_MAX_AGE_MS;
  const fallback = options.fallback ?? selectFirstProviderToken;

  /** Last known figures per token label. */
  const snapshots = new Map<string, ClaudeBudgetSnapshot>();
  /** One shared promise per token being refreshed, so probes never double. */
  const inFlight = new Map<string, Promise<ClaudeTokenBudget>>();
  /** Discovery, resolved at most once and shared by concurrent callers. */
  let discovered: Promise<ProviderTokenFile[]> | null = null;
  /** The provider descriptor, resolved on first use rather than at build. */
  let provider: AgentProviderDescriptor | null = null;

  return {
    recordBudget(label, budget, observedAtMs) {
      const key = label.trim();
      if (key.length === 0) {
        throw new Error(
          `${LOG_PREFIX}: a budget snapshot needs the token's label`,
        );
      }
      if (!Number.isFinite(observedAtMs)) {
        throw new Error(
          `${LOG_PREFIX}: ${key} snapshot needs a finite observation time`,
        );
      }
      snapshots.set(key, { budget, observedAtMs });
    },

    recordExhaustion(label, windows) {
      const key = label.trim();
      if (key.length === 0) {
        throw new Error(
          `${LOG_PREFIX}: an exhaustion needs the token's label`,
        );
      }
      if (windows.length === 0) {
        // Recording nothing would leave the spent token eligible while
        // looking like the exhaustion had been handled.
        throw new Error(
          `${LOG_PREFIX}: ${key} exhaustion named no window`,
        );
      }
      snapshots.set(key, {
        budget: exhaustedBudget(key, windows),
        observedAtMs: clock(),
      });
      log(
        `${LOG_PREFIX}: ${key} recorded as spent on ` +
          `${windows.map((window) => window.window).join(", ")} ` +
          `without a probe`,
      );
    },

    async selectEligible(now = clock()) {
      const pool = await candidates();
      // Nothing to choose between: no probe, no log, no change from today.
      if (pool.length < 2) return null;
      // The filter removes at most one label from a pool of two or more, so
      // there is always something left to rank.
      const eligible = await withoutSpentCredential(pool);
      const ranking = await rankPool(eligible, now);
      const winner = ranking.winner;
      // The gate is the switch's own question — "is this worth running
      // against?" — so a winner that fails it is no selection at all.
      if (winner === null || !winner.passesFiveHourGate) return null;
      return eligible[winner.index] ?? null;
    },

    selectToken: async (tokens, provider) => {
      // Every enabled provider is offered this selector, and this pool holds
      // one vendor's snapshots, keyed by a file stem every vendor reproduces.
      // Another vendor's tokens are not ours to rank — or to send to
      // Anthropic's budget endpoint.
      if (provider.id !== poolProvider().id) {
        return await fallback(tokens, provider);
      }
      const pool = providerPoolCandidates(tokens);
      if (pool.length < 2) return await fallback(tokens, provider);
      // Discovery has already happened upstream; reuse it rather than reading
      // the credential directory a second time.
      discovered ??= Promise.resolve(pool);
      const now = clock();
      // Issue #2002: a token the active usage signal already calls spent is
      // out of the running while another candidate exists. Without this, a
      // start whose every probe failed fell through to discovery order and
      // re-picked the very subscription whose signal was pausing the host.
      const eligible = await withoutSpentCredential(pool);
      const ranked = eligible.length > 0 ? eligible : pool;
      const ranking = await rankPool(ranked, now);
      // A start never refuses: the gate is logged as the reason, not applied
      // as a filter. Ranking drops nothing, so a pool of two always has a
      // winner.
      return ranking.winner === null
        ? null
        : ranked[ranking.winner.index] ?? null;
    },

    applySelection(token, setEnv) {
      const name = token.poolMember ? token.name : null;
      const value = token.value;
      if (name === null || value === null || value.trim().length === 0) {
        throw new Error(
          `${LOG_PREFIX}: ${token.label} carries no subscription OAuth token ` +
            `to switch the run environment to`,
        );
      }
      // A switch replaces ONE variable. Start-up exports every recognised
      // entry of the file it chose, so a pool file carrying a second
      // credential beside its OAuth token would leave the previous file's
      // second credential standing next to the new token — two subscriptions
      // in one environment, which is the one thing #919 rules out. Refuse
      // loudly rather than half-switch.
      if (token.entries.length > 1) {
        throw new Error(
          `${LOG_PREFIX}: ${token.label} carries ${token.entries.length} ` +
            `credential variables, so switching to it cannot leave exactly ` +
            `one in the environment — keep one credential per pool file`,
        );
      }
      // Replacing, not adding: exactly one Claude token variable is left in
      // the environment, carrying the newly selected file's value.
      setEnv(name, value);
      // Issue #2002: the run is now holding this credential, so a usage
      // signal written after the switch names this one, not the one it
      // replaced.
      recordActiveCredentialLabel(poolProvider().id, token.label);
      log(
        `${LOG_PREFIX}: run environment switched to ${token.label} (${name})`,
      );
      return name;
    },
  };

  /**
   * The candidates minus the one an active usage signal calls spent.
   *
   * Never throws and never narrows on a signal that names nobody: a reader
   * that failed leaves the whole pool in the running, which is exactly the
   * behaviour the pool had before Issue #2002.
   */
  async function withoutSpentCredential(
    pool: readonly ProviderTokenFile[],
  ): Promise<ProviderTokenFile[]> {
    let spent: string | undefined;
    try {
      spent = await options.spentCredentialLabel?.(poolProvider().id);
    } catch (error: unknown) {
      // An unreadable signal names nobody and must not narrow the pool — but
      // it is said out loud, because a reader that keeps failing is the
      // difference between this defence working and quietly not.
      log(
        `${LOG_PREFIX}: could not read the active usage signal ` +
          `(${error instanceof Error ? error.message : String(error)}) — ` +
          `no candidate is excluded`,
      );
      spent = undefined;
    }
    const label = spent?.trim();
    if (!label) return [...pool];
    const kept = pool.filter((token) => token.label !== label);
    if (kept.length !== pool.length) {
      log(
        `${LOG_PREFIX}: ${label} is spent per the active usage signal — ` +
          `excluded from this selection`,
      );
    }
    return kept;
  }

  /** The pool candidates for this host, discovered at most once. */
  function candidates(): Promise<ProviderTokenFile[]> {
    discovered ??= discoverPool();
    return discovered;
  }

  /** The provider this pool belongs to, resolved once. */
  function poolProvider(): AgentProviderDescriptor {
    provider ??= options.provider ?? activeAgentProvider();
    return provider;
  }

  /** Read the credential directory and keep the subscription tokens. */
  async function discoverPool(): Promise<ProviderTokenFile[]> {
    const tokens = options.discover
      ? await options.discover()
      : await discoverProviderTokenFiles(
        options.dir ?? resolveCredentialDir(options.env),
        poolProvider(),
      );
    return providerPoolCandidates(tokens);
  }

  /** Refresh what has gone stale, rank the pool, and log every candidate. */
  async function rankPool(
    pool: readonly ProviderTokenFile[],
    now: number,
  ): Promise<ReturnType<typeof rankClaudeTokenBudgets>> {
    const budgets = await Promise.all(
      pool.map((token) => budgetFor(token, now)),
    );
    const ranking = rankClaudeTokenBudgets(budgets, now);
    for (const line of formatClaudeTokenSelectionLog(ranking)) log(line);
    return ranking;
  }

  /**
   * This token's budget: the snapshot while it is fresh, otherwise one probe.
   *
   * Deliberately not `async`: the in-flight promise is registered before this
   * function returns, so a second selection starting while the first is still
   * waiting joins that probe instead of issuing its own.
   */
  function budgetFor(
    token: ProviderTokenFile,
    now: number,
  ): Promise<ClaudeTokenBudget> {
    const snapshot = snapshots.get(token.label);
    if (snapshot && now - snapshot.observedAtMs <= maxAgeMs) {
      return Promise.resolve(snapshot.budget);
    }
    const pending = inFlight.get(token.label);
    if (pending) return pending;
    const refresh = probe(token, now).finally(() =>
      inFlight.delete(token.label)
    );
    inFlight.set(token.label, refresh);
    return refresh;
  }

  /**
   * One probe, recorded as a snapshot. Never throws: a failure is unknown.
   *
   * Stamped with the `now` the selection was made against rather than a
   * second clock reading, so staleness is always measured on the same time
   * source that decided the refresh was due.
   */
  async function probe(
    token: ProviderTokenFile,
    observedAtMs: number,
  ): Promise<ClaudeTokenBudget> {
    let budget: ClaudeTokenBudget;
    try {
      budget = await probeClaudeTokenBudget(token.value ?? "", {
        label: token.label,
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs,
        url: options.url,
      });
    } catch (error: unknown) {
      // The probe documents that it never throws; if it ever does, the answer
      // is an explicit unknown that ranks last, never an assumed budget.
      budget = {
        known: false,
        label: token.label,
        reason: "network-error",
        detail: error instanceof Error ? error.name : "probe threw",
      };
    }
    snapshots.set(token.label, { budget, observedAtMs });
    return budget;
  }
}
