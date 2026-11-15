/**
 * What TokenEconomizer did in one run, and what it cost (Issue #4958, part of
 * #4953).
 *
 * The plugin keeps its own accounting under each `TOKENECONOMIZER_HOME`: a
 * `ledger.jsonl` of session and overhead records, and one `sessions/<id>.json`
 * per session. This module reads that state after the run and reduces it to a
 * small {@link TokenEconomizerRunStats}, which the run-stats comment renders as
 * one line ({@link buildTokenEconomizerStatsLine}) and the run callback carries
 * as an additive block ({@link tokenEconomizerCallbackBlock}). A reader judging
 * the trial can then see, from the issue alone, what the plugin did and what its
 * own model calls cost on top of the agent's.
 *
 * ## Absent, never zero
 *
 * A figure that could not be read is absent (rendered "unavailable"), never 0.
 * An unreadable file or a malformed JSON line makes the figures that depend on
 * it absent and is logged with its path and cause. A home that does not exist is
 * not an error: it simply holds no evidence the plugin ran.
 *
 * ## State layout
 *
 * Each home holds `repos/<repo-key>/<host>/ledger.jsonl` and
 * `repos/<repo-key>/<host>/sessions/<session_id>.json`. Exactly that two-level
 * shape is walked, with no recursion beyond it, and symlinks are ignored.
 *
 * Uses Australian English throughout (behaviour, recognised, organisation).
 */

import { join } from "node:path";
import {
  readTokenEconomizerStop,
  type TokenEconomizerStopRule,
} from "./token_economizer_plugin.ts";
import { lookupModelPricing } from "./token_usage.ts";

/** How the plugin figured in one run. */
export type TokenEconomizerRunStatus =
  | "on"
  | "fallback"
  | "stopped"
  | "not-run"
  | "off";

/** What TokenEconomizer did in one run. An absent figure is unavailable, never 0. */
export interface TokenEconomizerRunStats {
  /** The host's `token_economizer.enabled` switch. */
  enabled: boolean;
  status: TokenEconomizerRunStatus;
  /** Whether learnings persisted across runs. "unavailable" until #4957 lands a learnings store; never inferred from config. */
  persistence: "available" | "unavailable";
  stopRule?: TokenEconomizerStopRule;
  factsInjected?: number;
  judgeCalls?: number;
  redirects?: number;
  stillStuckNotices?: number;
  /** Upstream's mechanism-overhead total, in its effective (fresh-input-equivalent) tokens. */
  pluginEffectiveTokens?: number;
  /** USD estimate of the plugin's own model calls; absent when unpriceable. */
  pluginCostUsd?: number;
}

/**
 * The ledger overhead keys, mirroring upstream `ledger.py` `OVERHEAD_KEYS`
 * (the keys `accounting.summarize` sums into `overhead_tokens`).
 */
export const TOKEN_ECONOMIZER_OVERHEAD_KEYS: readonly string[] = [
  "optimizer_tokens",
  "untool_classify_tokens",
  "untool_judge_tokens",
  "codex_untool_adapt_tokens",
  "spiral_judge_tokens",
  "spiral_nudge_writer_tokens",
];

/**
 * The stats of a run in which the plugin never had the chance to act: the run
 * ended before the agent spawned, or the switch is off.
 *
 * @param enabled - The host's `token_economizer.enabled` switch
 */
export function tokenEconomizerNotRun(
  enabled: boolean,
): TokenEconomizerRunStats {
  return {
    enabled,
    status: enabled ? "not-run" : "off",
    persistence: "unavailable",
  };
}

/** Options for {@link summariseTokenEconomizerRun}. */
export interface SummariseTokenEconomizerRunOptions {
  /** The host's `token_economizer.enabled` switch. */
  enabled: boolean;
  /** Whether a provider that can load the plugin (Claude) served the run. */
  eligible: boolean;
  /** The parent work directory holding the stop record. */
  workDir: string;
  /** Every `TOKENECONOMIZER_HOME` the run's launches used. */
  stateHomes: readonly string[];
  /** The model to price the plugin's own calls at. */
  model?: string;
  logger?: { warn(m: string): void };
}

/** A parsed JSON record, or the reason it could not be read. */
type Loaded<T> = { ok: true; value: T } | { ok: false };

/** What was read from every state home. Each figure is `undefined` when unreadable. */
interface Figures {
  evidence: boolean;
  factsInjected: number | undefined;
  redirects: number | undefined;
  stillStuckNotices: number | undefined;
  pluginEffectiveTokens: number | undefined;
  judgeCalls: number | undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Real (non-symlink) directory entries of `dir`; a missing directory has none. */
async function listEntries(
  dir: string,
  logger: SummariseTokenEconomizerRunOptions["logger"],
): Promise<{ entries: Deno.DirEntry[]; ok: boolean }> {
  try {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isSymlink) continue;
      entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries, ok: true };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { entries: [], ok: true };
    logger?.warn(
      `token-economizer: cannot list ${dir}, its figures are unavailable: ${
        message(err)
      }`,
    );
    return { entries: [], ok: false };
  }
}

async function readJson(
  path: string,
  logger: SummariseTokenEconomizerRunOptions["logger"],
): Promise<Loaded<unknown>> {
  try {
    return { ok: true, value: JSON.parse(await Deno.readTextFile(path)) };
  } catch (err) {
    logger?.warn(
      `token-economizer: cannot read ${path}, its figures are unavailable: ${
        message(err)
      }`,
    );
    return { ok: false };
  }
}

/** Parse a ledger; one bad line makes the whole ledger unreadable. */
async function readLedger(
  path: string,
  logger: SummariseTokenEconomizerRunOptions["logger"],
): Promise<Loaded<Record<string, unknown>[]> | "missing"> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return "missing";
    logger?.warn(
      `token-economizer: cannot read ${path}, its figures are unavailable: ${
        message(err)
      }`,
    );
    return { ok: false };
  }
  const records: Record<string, unknown>[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error("not a JSON object");
      records.push(parsed);
    } catch (err) {
      logger?.warn(
        `token-economizer: malformed line ${
          i + 1
        } in ${path}, its figures are unavailable: ${message(err)}`,
      );
      return { ok: false };
    }
  }
  return { ok: true, value: records };
}

async function readFigures(
  homes: readonly string[],
  logger: SummariseTokenEconomizerRunOptions["logger"],
): Promise<Figures> {
  let evidence = false;
  let facts: number | undefined = 0;
  let redirects: number | undefined = 0;
  let stuck: number | undefined = 0;
  let overhead: number | undefined = 0;
  let judge: number | undefined = 0;

  for (const home of homes) {
    const repos = await listEntries(join(home, "repos"), logger);
    if (!repos.ok) {
      facts =
        redirects =
        stuck =
        overhead =
        judge =
          undefined;
    }
    for (const repo of repos.entries.filter((e) => e.isDirectory)) {
      const hosts = await listEntries(join(home, "repos", repo.name), logger);
      if (!hosts.ok) {
        facts =
          redirects =
          stuck =
          overhead =
          judge =
            undefined;
      }
      for (const host of hosts.entries.filter((e) => e.isDirectory)) {
        const base = join(home, "repos", repo.name, host.name);

        const sessions = await listEntries(join(base, "sessions"), logger);
        if (!sessions.ok) facts = redirects = stuck = undefined;
        for (
          const file of sessions.entries.filter((e) =>
            e.isFile && e.name.endsWith(".json")
          )
        ) {
          evidence = true;
          const loaded = await readJson(
            join(base, "sessions", file.name),
            logger,
          );
          if (!loaded.ok || !isRecord(loaded.value)) {
            if (loaded.ok) {
              logger?.warn(
                `token-economizer: ${
                  join(base, "sessions", file.name)
                } is not a JSON object, its figures are unavailable`,
              );
            }
            facts = redirects = stuck = undefined;
            continue;
          }
          const session = loaded.value;
          if (session.imported === true) continue;
          const injected = Array.isArray(session.injected_ids)
            ? session.injected_ids.length
            : 0;
          if (facts !== undefined) facts += injected;
          if (redirects !== undefined) redirects += num(session.nudges);
          if (stuck !== undefined) stuck += num(session.aborts);
        }

        const ledger = await readLedger(join(base, "ledger.jsonl"), logger);
        if (ledger === "missing") continue;
        if (!ledger.ok) {
          // A ledger that cannot be read may still hold session evidence, but
          // the run did write state, so the plugin was loaded.
          evidence = true;
          overhead = judge = undefined;
          continue;
        }
        for (const record of ledger.value) {
          if (record.kind === "session") evidence = true;
          if (record.imported === true) continue;
          if (record.kind !== "session" && record.kind !== "overhead") continue;
          const oh = isRecord(record.overhead) ? record.overhead : {};
          if (overhead !== undefined) {
            for (const key of TOKEN_ECONOMIZER_OVERHEAD_KEYS) {
              overhead += num(oh[key]);
            }
          }
          if (
            judge !== undefined && record.kind === "overhead" &&
            num(oh.spiral_judge_tokens) > 0
          ) judge += 1;
        }
      }
    }
  }
  return {
    evidence,
    factsInjected: facts,
    redirects,
    stillStuckNotices: stuck,
    pluginEffectiveTokens: overhead,
    judgeCalls: judge,
  };
}

/**
 * Reduce the plugin's own state to this run's {@link TokenEconomizerRunStats}.
 *
 * Never throws: an unexpected error is logged and the status is returned with
 * every figure absent.
 *
 * @param opts - See {@link SummariseTokenEconomizerRunOptions}
 */
export async function summariseTokenEconomizerRun(
  opts: SummariseTokenEconomizerRunOptions,
): Promise<TokenEconomizerRunStats> {
  const { enabled, logger } = opts;
  if (!enabled || !opts.eligible) {
    return { enabled, status: "off", persistence: "unavailable" };
  }
  let status: TokenEconomizerRunStatus = "fallback";
  try {
    const stop = await readTokenEconomizerStop(opts.workDir);
    const figures = await readFigures(opts.stateHomes, logger);
    status = stop !== null ? "stopped" : figures.evidence ? "on" : "fallback";
    const stats: TokenEconomizerRunStats = {
      enabled,
      status,
      persistence: "unavailable",
    };
    if (stop !== null) stats.stopRule = stop.rule;
    // No session evidence: nothing was measured, so no figure is reported.
    if (!figures.evidence) return stats;
    if (figures.factsInjected !== undefined) {
      stats.factsInjected = figures.factsInjected;
    }
    if (figures.judgeCalls !== undefined) stats.judgeCalls = figures.judgeCalls;
    if (figures.redirects !== undefined) stats.redirects = figures.redirects;
    if (figures.stillStuckNotices !== undefined) {
      stats.stillStuckNotices = figures.stillStuckNotices;
    }
    if (figures.pluginEffectiveTokens !== undefined) {
      stats.pluginEffectiveTokens = figures.pluginEffectiveTokens;
      // The plugin's judge runs as a separate CLI process, so these calls are
      // not in the agent's own stream totals: adding them double counts nothing.
      const pricing = opts.model === undefined
        ? null
        : lookupModelPricing(opts.model);
      if (pricing !== null) {
        stats.pluginCostUsd = figures.pluginEffectiveTokens *
          pricing.inputPerMillion / 1e6;
      }
    }
    return stats;
  } catch (err) {
    logger?.warn(
      `token-economizer: cannot summarise the run, its figures are unavailable: ${
        message(err)
      }`,
    );
    return { enabled, status, persistence: "unavailable" };
  }
}

/** The stats line's fixed prefix. */
export const TOKEN_ECONOMIZER_STATS_PREFIX = "- **TokenEconomizer:**";

function plural(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/**
 * Render the single TokenEconomizer line for a run's stats comment.
 *
 * @param stats - What the plugin did in the run
 * @param agentCostUsd - The agent's own estimated cost, for the combined figure
 */
export function buildTokenEconomizerStatsLine(
  stats: TokenEconomizerRunStats,
  agentCostUsd?: number,
): string {
  const prefix = TOKEN_ECONOMIZER_STATS_PREFIX;
  if (stats.status === "off") return `${prefix} off`;
  if (stats.status === "not-run") {
    return `${prefix} not-run — switched on, the run ended before the agent spawned`;
  }
  if (stats.status === "fallback") {
    return `${prefix} fallback — switched on, plugin not loaded`;
  }
  const head = stats.status === "stopped"
    ? `stopped${stats.stopRule ? ` (${stats.stopRule})` : ""}`
    : "on";
  const cost = stats.pluginCostUsd === undefined
    ? "plugin model calls unavailable"
    : `plugin model calls ~${usd(stats.pluginCostUsd)}${
      agentCostUsd === undefined
        ? ""
        : ` (run incl. plugin ~${usd(agentCostUsd + stats.pluginCostUsd)})`
    }`;
  const parts = [
    stats.persistence === "available"
      ? "learnings persisted"
      : "learnings not persisted",
    stats.factsInjected === undefined
      ? "facts injected unavailable"
      : `${stats.factsInjected} ${
        stats.factsInjected === 1 ? "fact" : "facts"
      } injected`,
    stats.judgeCalls === undefined
      ? "judge calls unavailable"
      : plural(stats.judgeCalls, "judge call", "judge calls"),
    stats.redirects === undefined
      ? "redirects unavailable"
      : plural(stats.redirects, "redirect", "redirects"),
    stats.stillStuckNotices === undefined
      ? "still-stuck notices unavailable"
      : plural(
        stats.stillStuckNotices,
        "still-stuck notice",
        "still-stuck notices",
      ),
    cost,
  ];
  return `${prefix} ${head} — ${parts.join("; ")}`;
}

/**
 * The additive `tokenEconomizer` block of the run callback document.
 *
 * @param stats - What the plugin did in the run
 * @param agentCostUsd - The agent's own estimated cost, for `runCostUsd`
 * @returns The block, or `undefined` on a switched-off host so its callback
 *   stays byte-identical to what it was before this block existed
 */
export function tokenEconomizerCallbackBlock(
  stats: TokenEconomizerRunStats | undefined,
  agentCostUsd?: number,
): Record<string, unknown> | undefined {
  if (stats === undefined || !stats.enabled) return undefined;
  const block: Record<string, unknown> = {
    enabled: stats.enabled,
    status: stats.status,
    persistence: stats.persistence,
  };
  if (stats.stopRule !== undefined) block.stopRule = stats.stopRule;
  if (stats.factsInjected !== undefined) {
    block.factsInjected = stats.factsInjected;
  }
  if (stats.judgeCalls !== undefined) block.judgeCalls = stats.judgeCalls;
  if (stats.redirects !== undefined) block.redirects = stats.redirects;
  if (stats.stillStuckNotices !== undefined) {
    block.stillStuckNotices = stats.stillStuckNotices;
  }
  if (stats.pluginEffectiveTokens !== undefined) {
    block.pluginEffectiveTokens = stats.pluginEffectiveTokens;
  }
  if (stats.pluginCostUsd !== undefined) {
    block.pluginCostUsd = stats.pluginCostUsd;
  }
  if (agentCostUsd !== undefined && stats.pluginCostUsd !== undefined) {
    block.runCostUsd = agentCostUsd + stats.pluginCostUsd;
  }
  return block;
}
