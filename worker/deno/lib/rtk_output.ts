/**
 * Condensing one run's Bash output with RTK (Issue #2382, part of #2328).
 *
 * `rtk_output_config.ts` owns the single host switch, `rtk_output.enabled`
 * (Issue #2380). This module is the one place that turns that switch into the
 * four things a run needs: the `PreToolUse` hook settings Claude Code is
 * spawned with, the prompt line telling the agent its Bash output is condensed,
 * the status the run stats report, and the saved-token figure the trial page
 * quotes. It is shaped after `codegraph_context.ts` plus `codegraph_run.ts`,
 * collapsed into one file because RTK has no index step to separate.
 *
 * ## The pair is indivisible
 *
 * The hook entry and the prompt line are installed together or not at all.
 * The line without the hook tells the agent its output was filtered when it was
 * not, and sends it chasing a recall id that no failure printed; the hook
 * without the line leaves an agent that reads a truncated failure and never
 * learns `rtk recall` exists. {@link RtkRun.hookSettings} and
 * {@link RtkRun.applyPrompt} therefore read the *same* status, and no caller
 * gets to decide one without the other.
 *
 * ## Nothing here fails a run
 *
 * RTK is an accelerator. Every failure mode — a missing binary, a non-zero
 * exit, a timeout, a seam that throws, and gain figures that cannot be read —
 * logs exactly one `[RTK_UNAVAILABLE] <reason>` line at `warn`, records
 * `status: "failed"`, and never throws or rejects. `failed` is a recorded
 * outcome rather than a silently clean run: the switch was on and the run got
 * no filtering, which is precisely what the trial's figure reader must see.
 *
 * ## Where the figures come from
 *
 * Read from RTK (github.com/rtk-ai/rtk) at v0.37.2, because nothing in this
 * repository described these surfaces before this module:
 *
 * - `rtk hook claude` is RTK's own `PreToolUse` hook command (`src/hooks/
 *   constants.rs`), so the settings below need no `jq` wrapper script.
 * - `rtk gain --all --format json` reports `summary.total_saved`
 *   (`docs/guide/analytics/gain.md`) — the cumulative tokens RTK's filtering
 *   has saved, not this run's.
 *
 * Cumulative is why {@link RtkRun.record} subtracts a baseline taken at
 * preparation time rather than reading one number at the end. The store behind
 * it is `$XDG_DATA_HOME/rtk/tracking.db` (`src/core/tracking.rs`), and
 * `container/entrypoint.sh` points `XDG_DATA_HOME` at the *durable* state root
 * under the work root, which is deliberately group-shared and setgid. There
 * is one such root per volume rather than one per lane, so a sibling container
 * running concurrently writes the same store: `savedTokens` is RTK's own
 * indicative figure and may be inflated by a neighbour. The trial bar is read
 * from run-stats tokens and cost, never from this number.
 *
 * ## Injectable seams
 *
 * `run` defaults to {@link runWithTimeout}, so no test here spawns anything and
 * none waits on a clock. `env` carries whatever environment the `rtk`
 * invocations need — in production the state-root variables that decide which
 * tracking store is read.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { runWithTimeout, type SubprocessResult } from "./subprocess_timeout.ts";
import { CLAUDE_PROVIDER_ID } from "./agent_provider.ts";
import type { Result } from "../types.ts";

/**
 * Cap on each `rtk` probe.
 *
 * Both probes are local and trivial — a version string and one SQLite read —
 * so ten seconds is generous. A wedged store must cost the run a short pause
 * and a `failed` status, never the run itself.
 */
export const RTK_PREFLIGHT_TIMEOUT_MS = 10_000;

/** Prefix on the one warn line any RTK fault logs. */
export const RTK_UNAVAILABLE_MARKER = "[RTK_UNAVAILABLE]";

/** The tool RTK's hook rewrites the output of. */
export const RTK_HOOK_MATCHER = "Bash";

/** RTK's own hook command — no wrapper script (`src/hooks/constants.rs`). */
export const RTK_HOOK_COMMAND = "rtk hook claude";

/**
 * The line the agent is told when the hook is installed.
 *
 * Exactly one line, with no trailing newline, so a caller interpolates it into
 * a list or a paragraph without reflowing anything around it.
 */
export const RTK_PROMPT_LINE =
  "Bash output on this run is condensed by RTK to save tokens: when a " +
  "command fails, run `rtk recall <id>` — the id is printed with the " +
  "failure — to read its full, unfiltered output.";

/** Longest diagnostic kept in a warn line, so the line stays readable. */
const MAX_REASON_DETAIL_CHARS = 300;

/** What an RTK preparation decided. */
export type RtkStatus = "ok" | "failed" | "off" | "unsupported";

/** The outcome one run's stats report. */
export interface RtkOutputResult {
  /** Whether the host switch was on. */
  enabled: boolean;
  /** What the preparation decided. */
  status: RtkStatus;
  /**
   * Tokens RTK says it saved while this run was in flight.
   *
   * Present only once {@link RtkRun.record} has read the gain store a second
   * time and both reads succeeded. Indicative — see the module docstring on
   * the shared tracking store.
   */
  savedTokens?: number;
  /**
   * The provider that could not take the hook.
   *
   * Set only on `unsupported`, and only when the run named a provider, so the
   * stats line reads `unsupported (codex)` rather than `unsupported ()`.
   */
  provider?: string;
}

/** The result every switched-off run shares. */
export const RTK_OFF: Readonly<RtkOutputResult> = Object.freeze({
  enabled: false,
  status: "off" as const,
});

/** Options this module passes to the subprocess seam. */
export interface RtkRunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** The subprocess seam — {@link runWithTimeout} in production. */
export type RtkRunner = (
  executable: string,
  args: string[],
  options?: RtkRunOptions,
) => Promise<Result<SubprocessResult>>;

/**
 * The logging surface this module needs.
 *
 * Structurally satisfied by the worker's `Logger`, so every caller passes its
 * own straight through and a test passes a two-method stub.
 */
export interface RtkOutputLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

/** Options for {@link prepareRtkRun}. */
export interface PrepareRtkRunOptions {
  /** The host switch, from `config.rtkOutput.enabled`. */
  enabled: boolean;
  /** The provider id this run will use; only Claude Code takes the hook. */
  providerId: string;
  /** Sink for the one status line and any `[RTK_UNAVAILABLE]` line. */
  logger: RtkOutputLogger;
  /** Working directory for the `rtk` probes. */
  cwd?: string;
  /** Environment for the `rtk` probes — which tracking store is read. */
  env?: Record<string, string>;
  /** The subprocess seam; defaults to {@link runWithTimeout}. */
  run?: RtkRunner;
}

/** The decisions one prepared run hands its caller. */
export interface RtkRun {
  /** What the preparation produced, carrying `savedTokens` once recorded. */
  readonly result: RtkOutputResult;
  /**
   * The user prompt this run sends.
   *
   * The RTK line is appended on `ok` and the prompt is returned unchanged on
   * every other status. Appending — rather than injecting into the template —
   * keeps the prompt cache untouched and puts the line outside the untrusted
   * issue fences the builder wrote.
   */
  applyPrompt(prompt: string): string;
  /**
   * The `PreToolUse` settings this run is spawned with, or `undefined`.
   *
   * On `ok` this is RTK's Bash entry alone; a caller that already builds
   * settings of its own combines the two with
   * {@link mergePreToolUseSettings}. On every other status the answer is
   * `undefined`, so the run is spawned with byte-identical settings to a host
   * that never had the switch.
   */
  hookSettings(): Record<string, unknown> | undefined;
  /**
   * Re-read the gain store and record what this run saved.
   *
   * Called once the invocation has finished. Does nothing unless the
   * preparation reported `ok`, since only then was a baseline taken. A read
   * that fails logs the marker and leaves `savedTokens` absent — no figure
   * beats a wrong one — while the status stays `ok`, because the hook did run.
   */
  record(): Promise<void>;
}

/**
 * Prepare RTK output filtering for one run and report what it decided.
 *
 * Logs exactly one status line per run. Never throws and never rejects: see
 * the module docstring.
 *
 * @param options - Host switch, provider, logger and seams
 * @returns The run's hook, prompt and figure decisions
 */
export async function prepareRtkRun(
  options: PrepareRtkRunOptions,
): Promise<RtkRun> {
  const { enabled, providerId, logger, cwd, env, run = runWithTimeout } =
    options;

  const probe = (args: string[]) => runRtk(run, args, { cwd, env });
  const fail = (reason: string): RtkOutputResult => {
    logger.warn(`${RTK_UNAVAILABLE_MARKER} ${reason}`);
    return { enabled: true, status: "failed" };
  };

  let result: RtkOutputResult;
  let baseline: number | undefined;

  if (!enabled) {
    result = RTK_OFF;
  } else if (providerId !== CLAUDE_PROVIDER_ID) {
    // Only Claude Code takes per-spawn `PreToolUse` settings. Every other
    // provider gets an unchanged prompt and no hook, and the run says so
    // rather than reporting a filtering that never happened.
    result = {
      enabled: true,
      status: "unsupported",
      ...(providerId === "" ? {} : { provider: providerId }),
    };
  } else {
    const version = await probe(["--version"]);
    if (!version.ok) {
      result = fail(`rtk ${version.reason}`);
    } else {
      const gain = await readTotalSaved(probe);
      if (!gain.ok) {
        result = fail(gain.reason);
      } else {
        baseline = gain.totalSaved;
        result = { enabled: true, status: "ok" };
      }
    }
  }

  // Exactly one status line per run, on every path through this function.
  logger.info(describeRtkRun(result), {
    rtkStatus: result.status,
    ...(result.provider === undefined ? {} : { provider: result.provider }),
  });

  return buildRun(result, baseline, probe, logger);
}

/**
 * The `PreToolUse` settings that install RTK's Bash hook.
 *
 * The shape Claude Code reads from `--settings`: one entry matching the `Bash`
 * tool, running RTK's own hook command.
 *
 * @returns A fresh settings object the caller may merge or mutate
 */
export function buildRtkHookSettings(): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: RTK_HOOK_MATCHER,
          hooks: [{ type: "command", command: RTK_HOOK_COMMAND }],
        },
      ],
    },
  };
}

/**
 * Combine two settings objects so both `PreToolUse` entries survive.
 *
 * A run can have settings of its own already — the split guard's `Edit|Write`
 * entry, for one — and a spawn takes a single settings object, so the two
 * `PreToolUse` arrays are concatenated rather than one overwriting the other.
 * Pure: neither argument is mutated, so a caller may hand in settings it keeps
 * using afterwards. An absent base yields `extra` alone, which is what a run
 * with nothing but the RTK hook needs.
 *
 * @param base - The caller's own settings, or `undefined`
 * @param extra - The settings to fold in, typically RTK's
 * @returns A new settings object carrying both sets of entries
 */
export function mergePreToolUseSettings(
  base: Record<string, unknown> | undefined,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  if (base === undefined) return { ...extra };

  const baseHooks = recordOf(base.hooks);
  const extraHooks = recordOf(extra.hooks);
  const entries = [
    ...preToolUseEntries(baseHooks),
    ...preToolUseEntries(extraHooks),
  ];

  return {
    ...base,
    ...extra,
    hooks: {
      ...baseHooks,
      ...extraHooks,
      PreToolUse: entries,
    },
  };
}

/** The one status line a run logs, naming the status and whatever figures. */
export function describeRtkRun(result: RtkOutputResult): string {
  const figures = [
    result.provider === undefined ? undefined : `provider=${result.provider}`,
    result.savedTokens === undefined
      ? undefined
      : `savedTokens=${result.savedTokens}`,
  ].filter((part): part is string => part !== undefined);
  return `RTK output: status=${result.status}` +
    (figures.length > 0 ? `, ${figures.join(", ")}` : "") +
    " (Issue #2382)";
}

/** A probe that ran, or the reason it did not. */
type RtkProbeOutcome =
  | { ok: true; stdout: string }
  | { ok: false; reason: string };

/** A probe, bound to this run's working directory and environment. */
type RtkProbe = (args: string[]) => Promise<RtkProbeOutcome>;

/**
 * Run one `rtk` invocation, turning every failure into a reason.
 *
 * The argv is fixed by the caller and carries nothing derived from an issue,
 * a comment or a repository, so there is no interpolation to escape.
 */
async function runRtk(
  run: RtkRunner,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> },
): Promise<RtkProbeOutcome> {
  let result: Result<SubprocessResult>;
  try {
    result = await run("rtk", args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      timeoutMs: RTK_PREFLIGHT_TIMEOUT_MS,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `could not be started: ${detail(message(err))}`,
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      reason: `could not be started: ${detail(result.error.message)} ` +
        `(is the rtk binary installed on this host?)`,
    };
  }
  const output = result.value;
  if (output.timedOut) {
    return {
      ok: false,
      reason: `timed out after ${RTK_PREFLIGHT_TIMEOUT_MS}ms`,
    };
  }
  if (!output.success || output.code !== 0) {
    return {
      ok: false,
      reason: `exited ${output.code}: ${detail(output.stderr)}`,
    };
  }
  return { ok: true, stdout: output.stdout };
}

/** A gain read, or the reason there is no figure. */
type GainOutcome =
  | { ok: true; totalSaved: number }
  | { ok: false; reason: string };

/**
 * Read `summary.total_saved` from `rtk gain --all --format json`.
 *
 * An unreadable, unparseable or figure-less answer is an error, not a zero:
 * reporting nothing saved when the store could not be read would put a false
 * figure on the trial page.
 */
async function readTotalSaved(probe: RtkProbe): Promise<GainOutcome> {
  const gain = await probe(["gain", "--all", "--format", "json"]);
  if (!gain.ok) return { ok: false, reason: `rtk gain ${gain.reason}` };

  let parsed: unknown;
  try {
    parsed = JSON.parse(gain.stdout);
  } catch (err) {
    return {
      ok: false,
      reason: `rtk gain printed no readable JSON: ${detail(message(err))}`,
    };
  }
  const summary = recordOf(recordOf(parsed).summary);
  const totalSaved = summary.total_saved;
  if (
    typeof totalSaved !== "number" || !Number.isFinite(totalSaved) ||
    totalSaved < 0
  ) {
    return {
      ok: false,
      reason: "rtk gain reported no usable summary.total_saved: " +
        detail(gain.stdout),
    };
  }
  return { ok: true, totalSaved };
}

/**
 * Bind the decisions to one prepared result.
 *
 * `wired` is read once and drives both halves of the indivisible pair, so the
 * hook and the prompt line cannot come apart.
 */
function buildRun(
  result: RtkOutputResult,
  baseline: number | undefined,
  probe: RtkProbe,
  logger: RtkOutputLogger,
): RtkRun {
  const wired = result.status === "ok";
  return {
    result,
    applyPrompt: (prompt: string) =>
      wired ? `${prompt}\n\n${RTK_PROMPT_LINE}` : prompt,
    hookSettings: () => wired ? buildRtkHookSettings() : undefined,
    record: async () => {
      if (!wired || baseline === undefined) return;
      const gain = await readTotalSaved(probe);
      if (!gain.ok) {
        logger.warn(
          `${RTK_UNAVAILABLE_MARKER} ${gain.reason}, so this run reports no ` +
            `saved-token figure`,
        );
        return;
      }
      // Clamped: the store is shared, so a neighbour rotating or trimming it
      // mid-run can leave the second read lower than the first. A negative
      // saving is not a figure anyone should read.
      result.savedTokens = Math.max(0, gain.totalSaved - baseline);
    },
  };
}

/** The `PreToolUse` entries of a hooks object, or none. */
function preToolUseEntries(hooks: Record<string, unknown>): unknown[] {
  const entries = hooks.PreToolUse;
  return Array.isArray(entries) ? entries : [];
}

/** A value read as an object, or an empty one when it is anything else. */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Collapse a diagnostic to one bounded line, so the warn line stays readable. */
function detail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "(no output)";
  return flat.length > MAX_REASON_DETAIL_CHARS
    ? `${flat.slice(0, MAX_REASON_DETAIL_CHARS - 1)}…`
    : flat;
}

/** The message of an unknown thrown value. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
