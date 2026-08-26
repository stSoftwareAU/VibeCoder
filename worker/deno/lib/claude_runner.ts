/**
 * Claude execution with retry, timeout, and health checking (Issue #913).
 *
 * Provides the high-level Claude CLI execution wrapper with:
 *   - Timeout management via watchdog with process-tree kill
 *   - Rate-limit retry with exponential backoff
 *   - Pre-flight health checks
 *   - Content summarisation for large inputs
 *   - Heartbeat updater for stuck issue detection
 *
 * Builds on claude_executor.ts for low-level subprocess and text handling.
 *
 * Migrated from worker/shared/claude_runner.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { ensureAgentMcpConfig } from "./agent_mcp_config.ts";
import { formatCoarseDuration } from "./rate_limit_wait.ts";
import {
  describeMemoryPressure,
  memoryPressureLogFields,
  type MemoryPressureReading,
  probeHostMemoryPressure,
} from "./memory_pressure.ts";
import type { Logger, Result } from "../types.ts";
import {
  buildClaudeModelArgs,
  captureTimeoutDiagnostics,
  type ClaudeExecutionResult,
  detectInvalidSessionId,
  detectModelUnavailable,
  detectOutOfMemory,
  detectRateLimit,
  detectUsageLimit,
  extractStreamJsonText,
  getTokenEstimate,
  hasExplicitEffortOverride,
  OOM_EXIT_CODE,
  parseUsageLimitReset,
  stripEscapeCodes,
  TIMEOUT_EXIT_CODE,
  type TimeoutDiagnostics,
} from "./claude_executor.ts";
import {
  applyFablePreflightRouting,
  isFablePreferringPhase,
} from "./fable_routing.ts";
import {
  type GhGuardShim,
  prepareGhGuardShim,
  UNGUARDED_AGENT_GH_ENV,
} from "./gh_guard_shim.ts";
import { modelFamily } from "./planning_run_stats.ts";
import { summariseHealthFailure } from "./claude_health_message.ts";
import {
  DEFAULT_HEALTH_CACHE_TTL,
  type FableAvailability,
  readFableAvailability,
  recordFableAvailability,
} from "./health_check_cache.ts";
import { terminateDescendants, terminateProcessTree } from "./pid_guard.ts";
import {
  captureKillDiagnostics,
  describeCgroupMemory,
  formatMemoryPressureWarning,
  parseProcessTable,
} from "./kill_diagnostics.ts";
import {
  DEFAULT_DESCENDANT_SNAPSHOT_INTERVAL_MS,
  DescendantTracker,
  type OrphanCollectorDeps,
} from "./orphan_collector.ts";
import { applyJitter } from "./rate_limit_jitter.ts";
import { writeRateLimitSignal } from "./rate_limit_signal.ts";
import { logInvocation } from "./credit_tracker.ts";
import { extractProviderTokenUsage } from "./provider_token_usage.ts";
import {
  cacheHitRateWarning,
  computeCacheHitRate,
  formatCacheHitRate,
} from "./prompt_cache_telemetry.ts";
import { buildRunStats, type RunStats } from "./run_stats.ts";
import {
  type AgentActivitySnapshot,
  AgentProgressTracker,
} from "./agent_progress.ts";
import {
  type AgentTranscriptWriter,
  maybeCreateAgentTranscriptWriter,
} from "./agent_transcript.ts";
import {
  combineTreeEvidence,
  decideProgressExtension,
  nextProgressCheckDelayMs,
  progressCheckIntervalMs,
  type ProgressExtensionOptions,
  type TreeProgressSample,
  type TreeProgressState,
} from "./progress_extension.ts";
import {
  buildExtensionTelemetry,
  buildTimeoutKillMessage,
  type ExtensionTelemetry,
} from "./timeout_extension_telemetry.ts";
import {
  attemptModelFallback,
  resolveCurrentModel,
  warnNoModelLadder,
} from "./model_fallback.ts";
import { selectModelForLargeInput } from "./phase_model_escalation.ts";
import type { SessionResumeState } from "./session_resume.ts";
import {
  activeAgentProvider,
  type AgentProviderSelector,
  selectAgentProvider,
} from "./agent_provider.ts";

// Re-export for convenience
export {
  buildClaudeEffortArgs,
  buildClaudeModelArgs,
  captureTimeoutDiagnostics,
  extractStreamJsonText,
  getTokenEstimate,
  OOM_EXIT_CODE,
  stripEscapeCodes,
  TIMEOUT_EXIT_CODE,
} from "./claude_executor.ts";
export type {
  ClaudeExecutionResult,
  TimeoutDiagnostics,
} from "./claude_executor.ts";
import { spawnGh } from "./gh_spawn.ts";
import { redactSecrets } from "./secret_redaction.ts";

/** A run shorter than this with no output reads as a start-up failure (#35). */
const STARTUP_FAILURE_MS = 2000;

/**
 * Build the log line for a non-rate-limit Claude failure (Issue #35).
 *
 * The generic failure path used to log only `exited with status N` and drop
 * the captured stderr, so a transient start-up refusal (a lock held by the
 * just-finished session, a bad flag, an auth refusal, a stdin race on the
 * streamed prompt) was indistinguishable from a mid-run crash. This surfaces
 * the CLI's own signal: a bounded, secret-redacted stderr tail (the 5-line
 * shape the 137 path uses) and the wall time since spawn. An exit within
 * {@link STARTUP_FAILURE_MS} of spawn with no output is named a start-up
 * failure — a different instruction to the operator than a run that failed
 * after working.
 */
export function buildClaudeFailureLog(input: {
  exitCode: number;
  stderr: string;
  output: string;
  wallClockMs: number;
}): string {
  const stderrTail = redactSecrets(
    input.stderr.trim().split("\n").slice(-5).join("\n"),
  );
  const elapsedSeconds = Math.round(input.wallClockMs / 100) / 10;
  const startupFailure = input.wallClockMs < STARTUP_FAILURE_MS &&
    input.output.trim().length === 0;
  const heading = startupFailure
    ? `Claude Code exited ${input.exitCode} ${elapsedSeconds}s after spawn ` +
      `with no output — a start-up failure (the CLI never reached a model call)`
    : `Claude Code exited with status ${input.exitCode} after ${elapsedSeconds}s`;
  return heading +
    (stderrTail ? `; stderr tail:\n${stderrTail}` : " (stderr empty)");
}
export type { RunStats } from "./run_stats.ts";

/** Default error scan tail lines. */
const DEFAULT_ERROR_SCAN_TAIL_LINES = 30;

/** Result from a Claude run with retry. */
export interface ClaudeRunResult {
  /**
   * Exit code (0 = success, 124 = timeout, 2 = rate limit exhaustion,
   * 137 = out of memory or killed — see {@link outOfMemory} and
   * {@link killed}).
   */
  exitCode: number;
  /**
   * The child's true exit status before any classification (Issue #4202).
   * Present whenever a child process actually ran. A watchdog timeout
   * remaps `exitCode` to 124; this field keeps the real status so a
   * SIGKILL, an OOM and a genuine timeout stay distinguishable in the
   * diagnostics.
   */
  rawExitCode?: number;
  /**
   * The run was SIGKILLed (exit 137) with neither worker watchdog firing
   * and no memory evidence in the output (Issue #4202). The usual culprit
   * is the VM's out-of-memory killer — a SIGKILLed process prints nothing,
   * so {@link outOfMemory} cannot fire. Terminal at the runner level;
   * classified as infrastructure by the phases so the bounded #1550 retry
   * may run. Observed live: such a kill at 539 s of a 3600 s budget was
   * reported as "timed out", which this flag ends.
   */
  killed?: boolean;
  /**
   * The host/VM memory-pressure reading taken at the moment of a
   * {@link killed} result (Issue #4374). Logged beside `AGENT_KILLED` so
   * the OOM attribution is evidence, not an inference from exit 137, and
   * carried here so the phase can refuse the in-process retry when the
   * pressure is still high — a retry re-runs the same workload into the
   * same memory. `unknown` when the probe cannot read.
   */
  memoryPressureAtKill?: MemoryPressureReading;
  /**
   * The run hit the subscription usage window (Issue #4315). Terminal at
   * the runner level — no retry, no model fallback — and reported with
   * exit code 2 so the phases classify it as infrastructure (the issue is
   * never blamed). `waitSeconds` is how long the durable signal pauses
   * agent work; `resetEpochMs` is present when the message named a time.
   */
  usageLimit?: { waitSeconds: number; resetEpochMs?: number };
  /** Path to the output file (if written). */
  outputFile?: string;
  /** The output text from Claude. */
  output: string;
  /**
   * Captured stderr (Issue #4237) — carried on the killed classification so
   * the phase diagnostics can show the stream a V8 heap abort or CLI
   * self-termination actually writes to.
   */
  stderr?: string;
  /** Whether the run timed out. */
  timedOut: boolean;
  /**
   * Whether the run failed with an out-of-memory (heap-exhaustion) error
   * (Issue #2741, parent #2721).
   *
   * OOM is terminal: the run loop returns immediately with {@link exitCode}
   * set to {@link OOM_EXIT_CODE} (137) and never enters the rate-limit
   * wait-and-retry loop, never sleeps, and never waits on a model fallback —
   * waiting cannot recover memory. This flag is the unambiguous, code-value-
   * independent signal for the caller (`execute_claude_phase.ts`).
   */
  outOfMemory?: boolean;
  /**
   * Which timeout fired, when `timedOut` is true (Issue #1825).
   *
   * - `"hard-timeout"` — wall-clock `timeoutSeconds` watchdog fired.
   * - `"no-output"` — silence watchdog fired (`noOutputTimeout`).
   */
  timeoutReason?: "hard-timeout" | "no-output";
  /**
   * Seconds the hard watchdog fired past its configured budget
   * (Issue #4254). Deno timers in a starved VM are not a reliable clock —
   * host-25 saw the 3600 s watchdog fire 487 s and 3470 s late. Present on
   * hard-timeout results so the diagnostics can say so.
   */
  watchdogLateSeconds?: number;
  /**
   * Set when the post-kill wait expired before the child settled
   * (Issue #4254): the runner abandoned `child.status` and the stream
   * pumps after this many seconds rather than blocking for hours. When
   * set, `exitCode`/`rawExitCode` are synthesised — the child never
   * reported a status; the pre-spawn orphan sweep collects any survivor.
   */
  killIncompleteSeconds?: number;
  /**
   * Bounded kill-time evidence (Issue #4382) — who held the memory when the
   * agent was killed from outside, and any kernel OOM lines. Carried into
   * the failure diagnostics beside {@link memoryPressureAtKill}.
   */
  killDiagnostics?: string;
  /**
   * What the re-armable deadline did to this run (Issue #4298, part of
   * #4290): extensions granted, seconds added, the final deadline, the true
   * elapsed and why the last extension was refused. Present only when the
   * progress-extension feature was active for the run, so every message
   * built from it is byte-identical to the pre-#4290 wording when absent.
   */
  extensions?: ExtensionTelemetry;
  /** Timeout diagnostics (if applicable). */
  diagnostics?: TimeoutDiagnostics;
  /**
   * The agent was terminated from outside by SIGTERM with no watchdog
   * asking for it (Issue #4369) — the run is ending or a handler was
   * abandoned. Terminal: never classified as a rate limit, never retried.
   */
  terminated?: boolean;
  /**
   * The agent received a SIGTERM the worker never requested (Issue #46):
   * `isAgentRunsTerminating()` was false, so it came from outside — a tool the
   * agent ran, the CLI, the container, a stray signal. Unlike {@link
   * terminated} (our own shutdown), this is an external kill: it carries the
   * kill diagnostics and is a retryable failure, never a silent run-end.
   */
  externalSigterm?: boolean;
  /** The fallback model used when the original was rate-limited (Issue #1113). */
  fallbackModel?: string;
  /**
   * Per-run generation stats (Issue #2647): served model IDs declared by the
   * API, requested model/effort, token usage, turn count, and durations.
   * Present on every completed run; the observability foundation for the
   * per-plan-run stats comment and degraded-model detection (#2646).
   */
  runStats?: RunStats;
  /**
   * Whether this run was flagged **degraded** by the pre-flight Fable reroute
   * (Issue #3231): the cached probe said Fable was unavailable, so a
   * Fable-preferring phase was dispatched on Opus @ `max` instead. Present
   * (`true`) only when the reroute fired; the recording sub-issue consumes this
   * explicit signal to apply the `degraded-model` label / post the stats
   * comment, independently of the served-vs-expected check (#2720).
   */
  preflightDegraded?: boolean;
  /**
   * Human-readable reason accompanying {@link preflightDegraded}
   * (`"fable-unavailable (pre-flight health probe)"`).
   */
  preflightDegradedReason?: string;
  /**
   * Id of the coding-agent provider that produced this result (Issue #4109).
   *
   * Carried on every result the agent actually ran for, so a Quorum run
   * attributes two drafts and a verdict to the right agent. Absent only when
   * no invocation was made (e.g. the invocation budget was already spent).
   */
  provider?: string;
}

/** Options for running Claude with timeout. */
export interface RunClaudeOptions {
  /** The prompt to send to Claude. */
  prompt: string;
  /**
   * Static system prompt for Claude prompt caching (Issue #1262).
   *
   * Passed via `--system-prompt` flag to the Claude CLI. Content in the system
   * prompt is cached independently by the Claude CLI, reducing costs by 70–90%
   * when the same static content (coding guidelines, tool instructions) is
   * reused across consecutive invocations.
   *
   * Leave undefined to omit the --system-prompt flag entirely.
   */
  systemPrompt?: string;
  /** Timeout in seconds (default from config). */
  timeoutSeconds?: number;
  /** Kill-after grace period in seconds (default from config). */
  killAfterSeconds?: number;
  /**
   * Override for the post-kill settle cap in seconds (Issue #4254) — how
   * long the runner waits for `child.status` and the stream pumps after a
   * watchdog kill before abandoning the wait. Test seam: production leaves
   * this unset and uses {@link killCompletionCapMs}.
   */
  killCompletionCapSeconds?: number;
  /**
   * Seconds to keep draining the child's streams after its status has
   * settled (Issue #325). Short by design: the process is already gone, and
   * anything still holding the pipe is a survivor we will not outlast. Test
   * seam; production leaves this unset and uses five seconds.
   */
  streamDrainCapSeconds?: number;
  /**
   * Milliseconds between agent-progress lines (Issue #4169). Test seam:
   * production leaves this unset and uses the one-minute default.
   */
  progressIntervalMs?: number;
  /**
   * Activity observer (Issue #4293, part of #4290): called with the
   * progress tracker's snapshot after every stdout chunk, so a
   * progress-aware watchdog can ask whether the run is still doing
   * anything. Purely observational — never blocks the stream, never
   * changes timeout behaviour on its own.
   */
  onActivity?: (snapshot: AgentActivitySnapshot) => void;
  /**
   * Opt-in re-armable hard deadline (Issue #4296, part of #4290).
   *
   * Present, the hard watchdog stops being a one-shot kill: when the
   * deadline expires the runner takes the activity snapshot (#4293) and a
   * fresh working-tree verdict (#4294), asks the policy (#4295), and either
   * moves the deadline or fires the ordinary hard-timeout kill.
   *
   * Absent — every caller other than issue work: PR feedback, CI fix,
   * planning, grill-me, health checks — behaviour is bit-for-bit unchanged,
   * one timer and one kill at `timeoutSeconds`, and the probe is never
   * called. The #1825 silence watchdog is untouched either way.
   */
  progressExtension?: ProgressExtensionOptions;
  /**
   * Issue number this invocation is working, for the transcript file name
   * (Issue #4169) and any other per-issue telemetry. Optional — phases
   * without an issue (health checks, summaries) leave it unset.
   */
  issueNumber?: number;
  /**
   * Explicit transcript destination (Issue #4169). Test seam / caller
   * override: production leaves this unset and the tee is created only
   * when `VIBE_AGENT_TRANSCRIPT=true` or `DEBUG=true`, writing to
   * `~/logs/agent-<runid>[-<issue>].jsonl`.
   */
  transcriptPath?: string;
  /**
   * Silence watchdog: kill the process tree if no bytes have been written to
   * stdout for this many seconds (Issue #1825). Distinct from the hard
   * `timeoutSeconds`. When omitted or non-positive, the silence watchdog is
   * disabled and only the hard timeout applies.
   */
  noOutputTimeout?: number;
  /** Claude model override. */
  model?: string;
  /** Phase name for model selection (e.g., "planning"). */
  phase?: string;
  /** Working directory. */
  cwd?: string;
  /** Logger instance. */
  logger?: Logger;
  /** Disallowed tools (default: ["EnterPlanMode", "ExitPlanMode"]). */
  disallowedTools?: string[];
  /**
   * Hand the agent the Playwright MCP server for this run (Issue #4355),
   * narrowed to an explicit need signal by Issue #192.
   *
   * Opt-in: the browser — outbound HTTP through a full browser context — is
   * wired only when the caller sets this `true` *and* a `cwd` (the clone the
   * server is configured against) is set. Every other run gets no browser
   * tool, so a prompt-injected agent working a backend issue cannot reach
   * arbitrary or internal hosts through it. Absent or `false` means no
   * browser.
   */
  mcpConfig?: boolean;
  /**
   * Memory-pressure probe consulted when the run is SIGKILLed with no
   * watchdog firing (Issue #4374). Defaults to the host probe; injectable
   * for tests. Never throws through — a failed probe reads `unknown`.
   */
  probeMemoryPressure?: () => Promise<MemoryPressureReading>;
  /**
   * Cadence of the descendant-tree snapshot taken while the child runs
   * (Issue #4382), so the survivors of an external kill can be collected.
   * `0` disables the snapshot and the collection. Default 20 s.
   */
  descendantSnapshotIntervalMs?: number;
  /** Process-table seams for the orphan collector — tests only. */
  orphanCollectorDeps?: OrphanCollectorDeps;
  /**
   * Minimum gap between two "memory pressure high" evidence lines during
   * one run (Issue #4384). Default 60 s; the watch itself rides on the
   * descendant snapshot tick.
   */
  memoryWatchMinIntervalMs?: number;
  /** `ps` reader for the memory watch — tests only. */
  memoryWatchRunPs?: () => Promise<string>;
  /**
   * Kill-time evidence capture (Issue #4382); defaults to the real process
   * table and dmesg. Injectable for tests.
   */
  captureKillDiagnostics?: (
    agentPid: number,
    knownDescendants: readonly number[],
  ) => Promise<string>;
  /** Number of tail lines to scan for errors (default: 30). */
  errorScanTailLines?: number;
  /** Directory for credit usage logs (Issue #1074). When set, invocations are logged. */
  creditLogDir?: string;
  /** Worker name for credit tracking (Issue #1074). */
  workerName?: string;
  /** Repository identifier for credit tracking (Issue #1074). */
  repo?: string;
  /** Whether to attempt cheaper model fallback on rate limit (Issue #1113, default: true). */
  enableModelFallback?: boolean;
  /**
   * Original model this invocation was downgraded *from* (Issue #2707).
   *
   * Set by `runClaudeWithRetry()` when a rate-limit or model-unavailable
   * fallback re-invokes `runClaudeWithTimeout()` on a cheaper tier. Forwarded
   * verbatim to `logInvocation()` so the credit log records the
   * original→cheaper transition (populating the daily-summary `byFallback`
   * aggregation). Left undefined on the first, un-downgraded invocation.
   */
  fallbackFrom?: string;
  /** SHA of the static prompt content for monitoring (Issue #1273). */
  promptSha?: string;
  /** Whether the prompt cache was hit for this invocation (Issue #1273). */
  promptCacheHit?: boolean;
  /** Session resume state for multi-phase continuity (Issue #1324). */
  sessionResumeState?: SessionResumeState;
  /** Effort level override — low, medium, high, xhigh, max (Issue #1403, #2620). */
  effort?: string;
  /**
   * Coding-agent provider for **this invocation only** (Issue #4109).
   *
   * A registered id (`"codex"`) or a descriptor. Selecting a provider here
   * mutates no process-wide state, so a Quorum run can drive two planners and
   * a judge concurrently in one worker process. Omit it and the invocation
   * uses the active provider exactly as before.
   *
   * Naming a provider the running image did not install fails loudly, naming
   * the installed set (Issue #3234).
   */
  agentProvider?: AgentProviderSelector;
}

/** Options for retry behaviour. */
/**
 * Default ceiling on billed `claude` invocations per `runClaudeWithRetry`
 * call, across every rung of the model-fallback ladder (Issue #3648).
 *
 * With the default `maxRetries = 2` and a four-tier ladder the previous
 * behaviour could bill ~12 invocations, because both `retryCount` and
 * `totalWaitTime` reset on each fallback. Six leaves room for a full retry
 * cycle plus a fallback tier with its own retries, and halves the worst case.
 */
export const DEFAULT_MAX_TOTAL_INVOCATIONS = 6;

/**
 * Requested-model value used when the routing chain resolves no `--model` arg.
 *
 * The CLI then runs on its own built-in default, which the worker cannot know
 * up front. The sentinel matches no pricing row, so the credit log substitutes
 * the served model id where the stream reported one (Issue #3870); where it did
 * not, the daily summary charges the tokens at the unpriced upper bound rather
 * than counting them as `$0`.
 */
export const UNRESOLVED_MODEL_SENTINEL = "default";

/**
 * Wait when a usage-limit message carries no parseable reset time (Issue
 * #4315). An hour is short against a 5-hour window but long enough that
 * the worker is not re-probing a dead window every cycle.
 */
export const USAGE_LIMIT_DEFAULT_WAIT_SECONDS = 3600;

/**
 * Longest single usage-limit pause (Issue #333).
 *
 * The reset time and the retry cadence are deliberately separate. A weekly
 * window can reopen two days out, but the quota may be *extended* before
 * then, and a worker asleep until the stated reset would not notice. So the
 * pause is `min(time-until-reset, this)` — re-probe about hourly, and pick up
 * a topped-up quota within that window. Matches the safety cap
 * `rate_limit_wait.ts` already applies for the same reason.
 */
export const USAGE_LIMIT_MAX_WAIT_SECONDS = 3600;

/**
 * Where the fleet-wide rate/usage-limit signal lives (Issue #4315): the
 * durable WORK_DIR every worker on the volume reads, never the per-issue
 * clone the agent happens to run in. Falls back to cwd only when WORK_DIR
 * is unset (tests, ad-hoc CLI use).
 */
function resolveSignalDir(cwd: string | undefined): string | undefined {
  let workDir: string | undefined;
  try {
    workDir = Deno.env.get("WORK_DIR")?.trim() || undefined;
  } catch {
    workDir = undefined;
  }
  return workDir ?? cwd;
}

export interface RetryOptions {
  /** Maximum retries on rate limit (default from config). */
  maxRetries?: number;
  /** Maximum total wait time in seconds (default from config). */
  maxWaitSeconds?: number;
  /** Initial wait interval in seconds (default from config). */
  initialWaitInterval?: number;
  /**
   * Hard ceiling on billed `claude` invocations across the whole call,
   * including every rung of the model-fallback ladder (Issue #3648).
   *
   * `maxRetries` and the accumulated wait are reset on each fallback, so
   * without a call-scoped cap a `maxRetries = 2` run could bill roughly a
   * dozen invocations while walking four model tiers. Defaults to
   * {@link DEFAULT_MAX_TOTAL_INVOCATIONS}.
   */
  maxTotalInvocations?: number;
}

/** Health check result. */
export interface HealthCheckResult {
  /** Whether Claude is responsive. */
  healthy: boolean;
  /**
   * 0 = healthy, 1 = unresponsive, 2 = auth failure,
   * 3 = rate/usage limited (Issue #4315 — the caller pauses instead of
   * re-probing; every probe is a billed invocation).
   */
  exitCode: number;
  /** Human-readable message. */
  message: string;
  /**
   * Seconds to pause agent work when `exitCode` is 3 (Issue #4315): the
   * parsed usage-window reset when the message named one, otherwise the
   * default hour for a usage limit / ten minutes for a rate limit.
   */
  pauseSeconds?: number;
}

// ---------------------------------------------------------------------------
// Child-environment sanitisation (Issue #3203)
// ---------------------------------------------------------------------------

/**
 * Child-environment sanitisation, re-exported from its own module.
 *
 * The agent runs with `--dangerously-skip-permissions` (unrestricted bash), so
 * any secret in its inherited environment is reachable by a prompt-injected
 * model. `claude_env.ts` owns the denylist and the shape-based denial of
 * unknown credential-looking names (Issue #3707); this module previously
 * carried a second, narrower copy that silently drifted from it.
 */
export {
  buildClaudeChildEnv,
  CLAUDE_ENV_DENYLIST,
  CLAUDE_ENV_SECRET_ALLOWLIST,
  CLAUDE_ENV_SECRET_NAME_PATTERN,
  isDeniedClaudeEnvVar,
} from "./claude_env.ts";

// ---------------------------------------------------------------------------
// Run Claude with timeout
// ---------------------------------------------------------------------------

/**
 * Read the value that follows a flag in a built argument list.
 *
 * The argument list comes from the provider descriptor (Issue #4067), so the
 * resolved model and effort are read back from it rather than re-derived.
 *
 * @param args - The built argument list.
 * @param flag - The flag whose value is wanted.
 * @returns The value, or undefined when the flag is absent.
 */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * Run Claude CLI with timeout and process cleanup.
 *
 * Uses --output-format stream-json for real-time output visibility.
 * Disables EnterPlanMode/ExitPlanMode by default.
 *
 * @param options - Execution options
 * @returns Result containing the execution result
 */
/**
 * Post-kill settle cap (Issue #4254): after a watchdog kill, the child gets
 * `killAfterSeconds × KILL_COMPLETION_MULTIPLIER` seconds (never less than
 * the floor) to report its status before the runner abandons the wait.
 */
export const KILL_COMPLETION_MULTIPLIER = 4;
export const KILL_COMPLETION_FLOOR_SECONDS = 60;

// ---------------------------------------------------------------------------
// Active agent runs (Issue #4369)
// ---------------------------------------------------------------------------

/** One agent subprocess the worker is currently awaiting. */
interface ActiveAgentRun {
  pid: number;
  label: string;
  killAfterSeconds: number;
  logger?: Logger;
}

const activeAgentRuns = new Map<number, ActiveAgentRun>();
let agentRunsTerminating = false;

/** Live agent subprocesses, for status and tests. */
export function listActiveAgentRuns(): { pid: number; label: string }[] {
  return [...activeAgentRuns.values()].map(({ pid, label }) => ({
    pid,
    label,
  }));
}

/**
 * Whether the worker has begun terminating agent runs (run end, handler
 * abandonment, shutdown). Once set, an in-flight retry loop never spawns
 * another agent — observed live: an agent SIGTERMed by the run-end cleanup
 * was misread as a rate limit and relaunched five minutes AFTER
 * "Run complete" (Issue #4369).
 */
export function isAgentRunsTerminating(): boolean {
  return agentRunsTerminating;
}

/** Set the terminating flag without killing anything (run end, tests). */
export function markAgentRunsTerminating(): void {
  agentRunsTerminating = true;
}

/** Clear the flag — a fresh run in the same process (tests). */
export function resetAgentRunsTerminating(): void {
  agentRunsTerminating = false;
}

/**
 * Terminate every active agent run and refuse new ones (Issue #4369).
 * Called when a handler is abandoned by the watchdog and when the run
 * ends, so no agent keeps running detached from the loop that awaited it.
 * Best-effort; returns the pids it signalled.
 *
 * Issue #55: the terminating flag is process-global. Leaving it set is correct
 * only when the whole run is ending; a watchdog HANDLER abandonment is
 * transient — the loop continues to the next priority, which must be able to
 * launch its own agent. Pass `keepTerminating: false` for that case: the flag
 * is cleared once the abandoned agents are confirmed dead (their runners
 * already returned on the SIGTERM, so they cannot relaunch), so a single
 * abandonment no longer silently refuses every agent for the rest of the run.
 */
export async function terminateActiveAgentRuns(
  reason: string,
  logger?: Logger,
  options: { keepTerminating?: boolean } = {},
): Promise<number[]> {
  const keepTerminating = options.keepTerminating ?? true;
  agentRunsTerminating = true;
  try {
    const runs = [...activeAgentRuns.values()];
    if (runs.length === 0) return [];
    (logger ?? runs[0]?.logger)?.warn(
      `Terminating ${runs.length} active agent run(s) — ${reason}: ${
        runs.map((r) => `${r.label} (pid ${r.pid})`).join(", ")
      }`,
    );
    await Promise.all(runs.map(async (run) => {
      try {
        await killClaudeProcessTree(run.pid, run.killAfterSeconds, run.logger);
      } catch (err) {
        run.logger?.warn(
          `Failed to terminate agent pid ${run.pid}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }));
    return runs.map((r) => r.pid);
  } finally {
    if (!keepTerminating) agentRunsTerminating = false;
  }
}

/** Milliseconds the runner waits for the child to settle after a kill. */
/** Default niceness for the agent process (Issue #324). */
export const DEFAULT_AGENT_NICENESS = 5;

/**
 * Scheduler niceness for the agent, or `undefined` to spawn it unwrapped
 * (Issue #324).
 *
 * `VIBE_AGENT_NICE` overrides the default; `0` or an unparseable value means
 * "do not wrap", so an operator can turn this off without editing code and a
 * typo degrades to today's behaviour rather than to something surprising.
 * Only positive values are accepted: a *negative* niceness would raise the
 * agent above the worker, which is the opposite of the point and needs
 * privileges the container does not have.
 */
/**
 * Absolute path to `nice`, or `undefined` where it is not present
 * (Issue #324).
 *
 * Resolved by absolute path rather than through `PATH`. The agent is spawned
 * with `clearEnv: true` and a curated environment, so a `PATH`-based lookup
 * depends on that environment containing a directory it was never guaranteed
 * to contain — which is how the first cut of this change broke the
 * `withGhLessStubClaude` tests, whose `PATH` holds only the stub. Where `nice`
 * is absent the agent is spawned unwrapped, exactly as before.
 */
export function resolveNiceBinary(
  exists: (path: string) => boolean = (path) => {
    try {
      return Deno.statSync(path).isFile;
    } catch {
      return false;
    }
  },
): string | undefined {
  for (const candidate of ["/usr/bin/nice", "/bin/nice"]) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

export function resolveAgentNiceness(
  env: (key: string) => string | undefined = (k) => Deno.env.get(k),
): number | undefined {
  const raw = env("VIBE_AGENT_NICE");
  if (raw === undefined || raw.trim() === "") return DEFAULT_AGENT_NICENESS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(19, Math.floor(parsed));
}

export function killCompletionCapMs(killAfterSeconds: number): number {
  return Math.max(
    KILL_COMPLETION_FLOOR_SECONDS,
    killAfterSeconds * KILL_COMPLETION_MULTIPLIER,
  ) * 1000;
}

export async function runClaudeWithTimeout(
  options: RunClaudeOptions,
): Promise<Result<ClaudeExecutionResult>> {
  const {
    prompt,
    systemPrompt,
    timeoutSeconds = 14400,
    killAfterSeconds = 30,
    noOutputTimeout = 0,
    model,
    phase,
    cwd,
    logger,
    disallowedTools = ["EnterPlanMode", "ExitPlanMode"],
    creditLogDir,
    workerName,
    repo,
  } = options;

  // The provider seam (Issue #4067) owns the binary, the argument list and
  // the child environment, so a second provider is a new descriptor rather
  // than an edit here. Resolved once, per invocation (Issue #4109): the
  // descriptor is held as a local for the whole call, so a concurrent
  // invocation naming a different provider cannot change this one's binary,
  // arguments or child environment mid-run.
  const provider = selectAgentProvider(options.agentProvider);
  // The Playwright MCP server for this run (Issue #4355): written per clone
  // to the worker cache and passed as --mcp-config. Wired only when the
  // caller declares the browser needed (Issue #192) — a cwd alone no longer
  // grants outbound browser/network capability to a run that has no use for
  // it. Best-effort even then: absent on failure.
  const mcpConfigPath = options.mcpConfig === true && cwd
    ? await ensureAgentMcpConfig({
      cwd,
      log: (message) => logger?.warn?.(message),
    })
    : undefined;
  // The prompt travels on stdin when the provider can read it there
  // (Issue #4385): Linux caps one argv element at 128 KiB, and a grill-me
  // round or a long issue thread exceeds that — "Argument list too long"
  // at spawn, observed live in container mode.
  const promptViaStdin = provider.promptTransport === "stdin";
  const args = provider.buildInvocation({
    prompt,
    systemPrompt,
    model,
    phase,
    effort: options.effort,
    disallowedTools,
    sessionResumeState: options.sessionResumeState,
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    promptViaStdin,
  });

  const timeoutMs = timeoutSeconds * 1000;
  const noOutputMs = noOutputTimeout > 0 ? noOutputTimeout * 1000 : 0;

  let timedOut = false;
  let timeoutReason: "hard-timeout" | "no-output" | undefined;
  let hardWatchdog: ReturnType<typeof setTimeout> | undefined;
  let silenceWatchdog: ReturnType<typeof setTimeout> | undefined;
  let killBoundTimer: ReturnType<typeof setTimeout> | undefined;
  // Descendant-tree snapshot (Issue #4382): what the child had spawned, so
  // the survivors of an external kill can be collected after the fact.
  let descendantSnapshotTimer: ReturnType<typeof setInterval> | undefined;
  let descendantTracker: DescendantTracker | undefined;
  let ghGuard: GhGuardShim | undefined;
  let transcript: AgentTranscriptWriter | undefined;
  // The prompt file (Issue #4385): the prompt is written to disk and
  // streamed from there into the child's stdin — inspectable after the
  // fact, never an argv element.
  let promptFilePath: string | undefined;
  let stdinFeed: Promise<void> | undefined;
  // In-flight deadline check (Issue #4296). Tracked like `killPromise` so the
  // awaited tree probe — and any timer it re-arms — cannot outlive the call.
  let extensionWork: Promise<void> | undefined;
  // Set once the child has settled: a check still in flight then abandons its
  // decision rather than killing a process that has already exited.
  let runFinished = false;

  try {
    // Sanitise the child environment (Issue #3203): clear it and pass an
    // explicit copy with the GitHub App private-key material dropped, so a
    // prompt-injected model running unrestricted bash cannot read the PEM.
    const baseEnv = provider.buildChildEnv();
    // Interpose the `gh` guard on the child's PATH (Issue #3643): the agent
    // holds GH_TOKEN and runs unrestricted bash, so without this its own `gh`
    // writes bypass the write-repo allowlist and the reserved-label guard the
    // worker enforces at `runGhCommandRaw`.
    // Fail closed (Issue #3869): while the write-repo allowlist is active an
    // uninstallable shim aborts the phase rather than silently downgrading to
    // the raw environment, which would run the agent with no egress
    // containment at all.
    const shimOutcome = await prepareGhGuardShim(
      baseEnv,
      (m) => (logger?.warn(m) ?? console.error(m)),
    );
    if (shimOutcome.status === "blocked") {
      return {
        ok: false,
        error: new Error(
          `Refused to start the agent: the gh guard shim could not be ` +
            `installed (${shimOutcome.reason}), so the agent's own gh calls ` +
            `would bypass the write-repo allowlist and the reserved-label ` +
            `guard. Set ${UNGUARDED_AGENT_GH_ENV}=1 to permit a degraded, ` +
            `unguarded run.`,
        ),
      };
    }
    ghGuard = shimOutcome.status === "installed" ? shimOutcome.shim : undefined;

    // Issue #324: run the agent at a lower scheduler priority.
    //
    // On 2026-08-22 two agents each wrote an unbounded bash busy-wait — one
    // with no `sleep` at all — and pinned the container. The worker's own
    // watchdogs then fired 1350 s and 2737 s late, `vminitd` stopped
    // answering, and the cycle had to be killed by hand. The guards were not
    // wrong; they were starved by the thing they were guarding.
    //
    // `quality.sh` already nices itself for precisely this reason, and the
    // Containerfile names the hazard outright ("kill-on-unresponsive monitors
    // exist in this ecosystem: vminitd's vsock health checks"). The agent —
    // and every shell it spawns, since priority is inherited — is the other
    // way the container gets saturated, and it was not covered.
    //
    // `nice` is a priority, not a quota: the agent still gets every idle
    // core and only yields under contention, so a healthy run is unaffected.
    // It `execvp`s, so the child PID is still the agent's and the existing
    // process-tree kill is unchanged. Where `nice` is absent the prefix is
    // empty and behaviour is exactly as before.
    const agentNice = resolveAgentNiceness();
    const niceBinary = agentNice === undefined
      ? undefined
      : resolveNiceBinary();
    const wrapped = agentNice !== undefined && niceBinary !== undefined;
    const spawnBinary = wrapped ? niceBinary! : provider.binary;
    const spawnArgs = wrapped
      ? ["-n", String(agentNice), provider.binary, ...args]
      : args;

    const command = new Deno.Command(spawnBinary, {
      args: spawnArgs,
      cwd,
      clearEnv: true,
      env: ghGuard?.env ?? baseEnv,
      stdout: "piped",
      stderr: "piped",
      stdin: promptViaStdin ? "piped" : "null",
    });

    logger?.info(
      // Name the provider that is about to run (Issue #4109) so a Quorum
      // run's interleaved log lines attribute to the agent that produced them.
      `Running ${provider.displayName} with ${timeoutSeconds}s timeout (${killAfterSeconds}s grace period)` +
        (noOutputMs > 0 ? `, no-output watchdog ${noOutputTimeout}s` : "") +
        "...",
    );

    // Log prompt SHA and cache status for monitoring (Issue #1273)
    if (options.promptSha) {
      const shaPrefix = options.promptSha.slice(0, 12);
      const cacheStatus = options.promptCacheHit === true
        ? "hit"
        : options.promptCacheHit === false
        ? "miss"
        : "unknown";
      logger?.info(
        `Prompt SHA: ${shaPrefix}... (cache ${cacheStatus}) repo=${
          repo ?? "unknown"
        }`,
      );
    }

    // Spawn so we have a PID for the watchdog. Previous AbortController-based
    // approach only delivered SIGTERM to the immediate child; when claude was
    // wedged on a hung descendant (e.g. a `tail -f` whose writer had died) it
    // ignored the signal because it was blocked on wait(). The watchdog kills
    // descendants first to free claude from wait(), then claude itself,
    // escalating to SIGKILL after the grace period.
    // Wall-clock start for per-run stats (Issue #2647). Measured around the
    // whole subprocess lifetime; used as the duration fallback when the CLI
    // result line does not report its own `duration_ms`.
    if (promptViaStdin) {
      // Written before the spawn so the file exists for the whole run; a
      // kill mid-stream leaves it for post-mortem when the transcript tee
      // is on, otherwise it is removed with the run.
      promptFilePath = await Deno.makeTempFile({
        prefix: "vibe-agent-prompt-",
        suffix: ".md",
      });
      await Deno.writeTextFile(promptFilePath, prompt);
      logger?.info(
        `Prompt file: ${promptFilePath} (${
          new TextEncoder().encode(prompt).length
        } bytes, streamed to the agent's stdin)`,
      );
    }
    const startMs = Date.now();
    const child = command.spawn();
    const childPid = child.pid;
    if (promptViaStdin && promptFilePath) {
      // Stream the file into stdin and close it at EOF (pipeTo closes the
      // writable). A child that exits before reading — an auth failure —
      // breaks the pipe; that is its problem, not the runner's.
      const promptFile = await Deno.open(promptFilePath, { read: true });
      stdinFeed = promptFile.readable.pipeTo(child.stdin).catch(() => {
        // EPIPE / early exit: the child's exit status tells the story.
      });
    }
    activeAgentRuns.set(childPid, {
      pid: childPid,
      label: `${phase ?? "agent"}${repo ? ` ${repo}` : ""}`,
      killAfterSeconds,
      logger,
    });

    // Remember the child's descendants while it lives (Issue #4382). After
    // an external SIGKILL the kernel has re-parented them, so they can only
    // be found from a snapshot taken beforehand. Interval-driven for the
    // long silent tool calls (a whole-tree `deno test`), and topped up on
    // stdout activity so a shell spawned between ticks is seen soon after.
    const snapshotIntervalMs = options.descendantSnapshotIntervalMs ??
      DEFAULT_DESCENDANT_SNAPSHOT_INTERVAL_MS;
    let lastSnapshotRequestMs = 0;
    // Pre-kill evidence (Issue #4384): the post-kill table only shows the
    // survivors, so while the run is alive each tick probes the memory
    // pressure and, when it reads high, logs the top processes — the
    // eventual victim included — at most once per window.
    let lastMemoryWarnMs = 0;
    let memoryWatchInFlight = false;
    const memoryWatchMinIntervalMs = options.memoryWatchMinIntervalMs ??
      DEFAULT_MEMORY_WATCH_MIN_INTERVAL_MS;
    const memoryWatch = async () => {
      if (memoryWatchInFlight || runFinished) return;
      memoryWatchInFlight = true;
      try {
        const reading = await readMemoryPressureAtKill(
          options.probeMemoryPressure,
        );
        if (reading.level !== "high") return;
        const now = Date.now();
        if (now - lastMemoryWarnMs < memoryWatchMinIntervalMs) return;
        lastMemoryWarnMs = now;
        const psText = await (options.memoryWatchRunPs ?? defaultRunPs)();
        const cgroup = await describeCgroupMemory((path) =>
          Deno.readTextFile(path)
        );
        logger?.warn(formatMemoryPressureWarning({
          reading,
          rows: parseProcessTable(psText),
          agentPid: childPid,
          knownDescendants: descendantTracker?.snapshot() ?? [],
          ...(cgroup !== undefined ? { cgroup } : {}),
        }));
      } catch {
        // Evidence only — never a reason to disturb the run.
      } finally {
        memoryWatchInFlight = false;
      }
    };
    const requestDescendantSnapshot = () => {
      if (!descendantTracker || runFinished) return;
      lastSnapshotRequestMs = Date.now();
      void descendantTracker.refresh();
      void memoryWatch();
    };
    if (snapshotIntervalMs > 0) {
      descendantTracker = new DescendantTracker(
        childPid,
        options.orphanCollectorDeps,
      );
      descendantSnapshotTimer = setInterval(
        requestDescendantSnapshot,
        snapshotIntervalMs,
      );
    }

    // The watchdog kill is fire-and-forget from the timer callback's point of
    // view but we track the promise so the caller can await full cleanup
    // (descendant kills, SIGTERM→SIGKILL escalation) before returning.
    // Without this, kill timers from terminateDescendants/terminateProcessTree
    // leak past the test boundary and Deno's leak detector flags them.
    let killPromise: Promise<void> | undefined;

    // Bounded post-kill wait (Issue #4254): once a watchdog kill fires, the
    // child gets a hard cap to settle before the runner abandons the wait —
    // host-25 spent 1 h 40 m and 8 h 37 m blocked here when an orphan
    // survived the tree kill and held the stdout pipe open.
    let killFiredMs = 0;
    let watchdogLateSeconds: number | undefined;
    let killBoundResolve: ((v: "kill-bound") => void) | undefined;
    const killBound = new Promise<"kill-bound">((resolve) => {
      killBoundResolve = resolve;
    });
    const killBoundMs = options.killCompletionCapSeconds !== undefined
      ? options.killCompletionCapSeconds * 1000
      : killCompletionCapMs(killAfterSeconds);

    // Issue #325: how long to keep draining the streams after the child's
    // status has settled. Short by design — at this point the process is gone
    // and anything still holding the pipe is a survivor we are not going to
    // outlast. Armed only when the drain is actually reached, so a normal run
    // never creates the timer.
    const streamDrainMs = options.streamDrainCapSeconds !== undefined
      ? options.streamDrainCapSeconds * 1000
      : 5_000;
    let streamDrainTimer: ReturnType<typeof setTimeout> | undefined;
    const streamDrainBound = new Promise<void>((resolve) => {
      streamDrainTimer = setTimeout(resolve, streamDrainMs);
    });

    const fireKill = (
      reason: "hard-timeout" | "no-output",
      message: string,
    ) => {
      if (timedOut) return; // already firing — don't double-kill
      timedOut = true;
      timeoutReason = reason;
      killFiredMs = Date.now();
      logger?.error(message);
      killPromise = killClaudeProcessTree(childPid, killAfterSeconds, logger)
        .catch((err) => {
          logger?.error(
            `Watchdog kill failed for PID ${childPid}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      killBoundTimer = setTimeout(
        () => killBoundResolve?.("kill-bound"),
        killBoundMs,
      );
    };

    // Periodic progress lines (Issue #4169): the same stream the silence
    // watchdog reads, folded into one compact line per interval so a long
    // agent phase is no longer a black box in the worker log. Chunk-driven,
    // no timers; the streaming decoder keeps multi-byte characters whole
    // across chunk boundaries.
    // Constructed unconditionally (Issue #4293): the activity signal must
    // exist for logger-less callers too. Without a logger the log sink is
    // a no-op, so nothing is emitted — existing log output is unchanged
    // when a logger IS supplied. Built before the watchdog (Issue #4296),
    // which reads its snapshot when the deadline expires.
    const progress = new AgentProgressTracker({
      phase: phase ?? "agent",
      log: logger ? (message) => logger.info(message) : () => undefined,
      ...(options.progressIntervalMs !== undefined
        ? { intervalMs: options.progressIntervalMs }
        : {}),
    });
    const progressDecoder = new TextDecoder();

    // The hard deadline, epoch-ms (Issue #4296). Without the opt-in it is
    // `startMs + timeoutMs` for the whole run and every figure below reduces
    // to what it was; with it, each granted extension moves it forward.
    let deadlineMs = startMs + timeoutMs;
    let extensionsGranted = 0;
    let extensionInFlight = false;
    const extension = options.progressExtension;
    // The most recent interim working-tree sample (Issue #4295), carried
    // into the next deadline decision so a check landing moments before the
    // deadline cannot shrink the observed window to nothing.
    let lastTreeSample:
      | { outcome: TreeProgressState; atMs: number }
      | undefined;

    // Extension telemetry (Issue #4298) is produced only when the feature is
    // genuinely active: no opt-in, or a policy present but disabled, means no
    // telemetry and every operator-facing message keeps its legacy wording.
    const telemetryActive = extension?.policy.enabled === true;
    // The policy's own reason for refusing the last extension, recorded so
    // the kill log and the issue comment can name the stalled signal.
    let lastRefusalReason: string | undefined;
    // The snapshot taken when the watchdog killed, kept for the result.
    let killTelemetry: ExtensionTelemetry | undefined;

    /** Snapshot what the deadline has done to this run so far. */
    const snapshotExtensions = (
      nowMs: number,
    ): ExtensionTelemetry | undefined =>
      telemetryActive
        ? buildExtensionTelemetry({
          baseTimeoutSeconds: timeoutSeconds,
          startMs,
          deadlineMs,
          nowMs,
          granted: extensionsGranted,
          ...(lastRefusalReason ? { refusalReason: lastRefusalReason } : {}),
        })
        : undefined;

    const fireHardTimeout = (trigger: "timer" | "wall-clock") => {
      // Late-fire visibility (Issue #4254): a starved VM delays Deno
      // timers — host-25 saw this watchdog fire 487 s and 3470 s late.
      const firedAfterSeconds = Math.round((Date.now() - startMs) / 1000);
      // Measured against the deadline actually armed (Issue #4296), which is
      // the configured budget until an extension moves it.
      const budgetSeconds = Math.round((deadlineMs - startMs) / 1000);
      const late = Math.max(0, firedAfterSeconds - budgetSeconds);
      watchdogLateSeconds = late;
      // Say what actually happened (Issue #4298): an extended run reports its
      // true elapsed and extension history, not the budget it started with.
      killTelemetry = snapshotExtensions(Date.now());
      fireKill(
        "hard-timeout",
        buildTimeoutKillMessage({
          pid: childPid,
          budgetSeconds,
          ...(killTelemetry ? { extensions: killTelemetry } : {}),
        }) +
          (late > 0 || trigger === "wall-clock"
            ? ` (fired at +${firedAfterSeconds}s via ${trigger} — ${late}s late)`
            : ""),
      );
    };

    /**
     * Arm the hard watchdog for the next wake.
     *
     * That is the deadline, or the configured check interval when one is set
     * and lands sooner (Issue #4295). Any pending timer is cleared first, so
     * a re-arm from the wall-clock backstop cannot leave two running.
     */
    const armHardWatchdog = () => {
      if (hardWatchdog) clearTimeout(hardWatchdog);
      const delay = extension
        ? nextProgressCheckDelayMs(Date.now(), deadlineMs, extension.policy)
        : Math.max(0, deadlineMs - Date.now());
      hardWatchdog = setTimeout(() => onWatchdogWake("timer"), delay);
    };

    /**
     * An interim check inside the budget (Issue #4295): sample the working
     * tree and re-arm. It can never kill — the deadline is what guards the
     * budget — so a fault only downgrades the sample to `unknown`.
     */
    const sampleTree = async (
      opts: ProgressExtensionOptions,
    ): Promise<void> => {
      let outcome: TreeProgressState;
      try {
        outcome = await opts.treeProbe();
      } catch (err) {
        logger?.warn(
          `[progress-extension] interim working-tree probe failed: ${
            err instanceof Error ? err.message : String(err)
          } — treating as unknown`,
        );
        outcome = "unknown";
      }
      if (timedOut || runFinished) return;
      lastTreeSample = { outcome, atMs: Date.now() };
      armHardWatchdog();
    };

    /**
     * The deadline expired and the caller opted in (Issue #4296): gather both
     * progress signals, ask the policy, then extend or kill.
     */
    const evaluateDeadline = async (
      opts: ProgressExtensionOptions,
      trigger: "timer" | "wall-clock",
    ): Promise<void> => {
      let treeState: TreeProgressState;
      try {
        treeState = await opts.treeProbe();
      } catch (err) {
        // A probe fault is not evidence of progress (Issue #4294): say so
        // loudly and let the policy kill on schedule.
        logger?.warn(
          `[progress-extension] working-tree probe failed: ${
            err instanceof Error ? err.message : String(err)
          } — treating as unknown`,
        );
        treeState = "unknown";
      }
      if (timedOut || runFinished) return;

      const nowMs = Date.now();
      // Fold in the last interim sample (Issue #4295) and spend it: evidence
      // may justify one grant, never every grant after it.
      const sample: TreeProgressSample | undefined = lastTreeSample
        ? {
          outcome: lastTreeSample.outcome,
          ageMs: nowMs - lastTreeSample.atMs,
        }
        : undefined;
      lastTreeSample = undefined;
      const combinedTreeState = combineTreeEvidence(
        treeState,
        sample,
        opts.policy,
      );
      const snapshot = progress.snapshot();
      const decision = decideProgressExtension({
        nowMs,
        startMs,
        deadlineMs,
        ...(snapshot.lastToolCallAtMs !== undefined
          ? { lastToolCallAtMs: snapshot.lastToolCallAtMs }
          : {}),
        treeState: combinedTreeState,
        extensionsGranted,
      }, opts.policy);

      const elapsedSeconds = Math.round((nowMs - startMs) / 1000);
      if (decision.action === "kill") {
        // Name the stalled signal in the telemetry (Issue #4298).
        lastRefusalReason = decision.reason;
        logger?.info(
          `[progress-extension] not extending after ${elapsedSeconds}s ` +
            `(extensions granted ${extensionsGranted}): ${decision.reason}`,
        );
        fireHardTimeout(trigger);
        return;
      }

      extensionsGranted++;
      deadlineMs = decision.newDeadlineMs;
      // Tell whoever is watching that this run now lives past the original
      // budget (Issue #4297) — the shutdown drain accounts for it as
      // in-flight rather than as a hang. Never let telemetry kill the run.
      try {
        opts.onExtension?.({ deadlineMs, extensionsGranted });
      } catch (err) {
        logger?.warn(
          `[progress-extension] deadline reporter threw: ${
            err instanceof Error ? err.message : String(err)
          } — the extension stands`,
        );
      }
      logger?.info(
        `[progress-extension] ${decision.reason} — extension ` +
          `${extensionsGranted} at ${elapsedSeconds}s elapsed, new deadline ` +
          `in ${Math.round((deadlineMs - nowMs) / 1000)}s ` +
          `(+${Math.round((deadlineMs - startMs) / 1000)}s from start)`,
      );
      armHardWatchdog();
    };

    /**
     * The watchdog woke, whichever trigger noticed. Without the opt-in this
     * is the one-shot kill it has always been; with it the wake is either an
     * interim tree sample (still inside the budget, Issue #4295) or the
     * deadline decision itself.
     */
    const onWatchdogWake = (trigger: "timer" | "wall-clock") => {
      if (timedOut || runFinished) return;
      if (!extension) {
        fireHardTimeout(trigger);
        return;
      }
      // One check at a time: a burst of chunks past the deadline must not
      // launch a probe each.
      if (extensionInFlight) return;
      // An interim wake only happens when a check interval is configured;
      // without one the sole wake is the deadline itself (Issue #4295).
      const interim = progressCheckIntervalMs(extension.policy) > 0 &&
        Date.now() < deadlineMs;
      extensionInFlight = true;
      const work =
        (interim ? sampleTree(extension) : evaluateDeadline(extension, trigger))
          .catch((err: unknown) => {
            // Never let a fault in the check mask an expired deadline
            // (Issue #3234) — fail loud. Inside the budget the deadline has not
            // expired, so the loud part is the log and a re-armed watchdog.
            logger?.error(
              `[progress-extension] ${
                interim ? "interim" : "deadline"
              } check failed: ${
                err instanceof Error ? err.message : String(err)
              } — falling back to the hard timeout`,
            );
            if (timedOut || runFinished) return;
            if (interim) armHardWatchdog();
            else fireHardTimeout(trigger);
          })
          .finally(() => {
            extensionInFlight = false;
          });
      extensionWork = extensionWork ? extensionWork.then(() => work) : work;
    };

    armHardWatchdog();

    const resetSilenceWatchdog = () => {
      // Wall-clock backstop (Issue #4254): every stdout chunk re-checks the
      // hard budget against real elapsed time, so a starved timer is not
      // the only trigger. It follows the *current* deadline (Issue #4296),
      // or it would kill a run the policy has just extended.
      if (!timedOut && Date.now() >= deadlineMs) {
        onWatchdogWake("wall-clock");
        // Without the opt-in the run is already dying — nothing to re-arm,
        // exactly as before. With it the decision is still in flight, so the
        // silence watchdog keeps its own clock running.
        if (!extension || timedOut) return;
      }
      if (noOutputMs <= 0) return;
      if (silenceWatchdog) clearTimeout(silenceWatchdog);
      silenceWatchdog = setTimeout(() => {
        fireKill(
          "no-output",
          `Claude produced no output for ${noOutputTimeout}s — killing process tree (PID ${childPid})`,
        );
      }, noOutputMs);
    };

    // Stream stdout through the silence watchdog. Each chunk resets the
    // silence timer; if the timer ever fires the process tree is killed.
    // stderr is collected without resetting the silence watchdog — Claude
    // emits its real work to stdout via stream-json, so a process spinning
    // on stderr-only chatter is still considered silent.
    resetSilenceWatchdog();

    // Raw-transcript tee (Issue #4169, proposal 2): with the debug flag
    // set, the same decoded stream lands redacted in ~/logs so a stuck or
    // misbehaving session can be diagnosed after the fact without
    // re-running it. Without the flag nothing extra is written.
    transcript = maybeCreateAgentTranscriptWriter({
      ...(options.issueNumber !== undefined
        ? { issueNumber: options.issueNumber }
        : {}),
      ...(options.transcriptPath !== undefined
        ? { explicitPath: options.transcriptPath }
        : {}),
      ...(logger ? { warn: (m: string) => logger.warn(m) } : {}),
    });
    if (transcript) {
      logger?.info(`Agent transcript tee: ${transcript.filePath}`);
    }

    const stdoutChunks: Uint8Array[] = [];
    const stdoutPump = (async () => {
      const reader = child.stdout.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            stdoutChunks.push(value);
            resetSilenceWatchdog();
            // A tool call has just started or ended — re-snapshot soon,
            // throttled to a quarter of the interval (Issue #4382).
            if (
              descendantTracker &&
              Date.now() - lastSnapshotRequestMs >= snapshotIntervalMs / 4
            ) {
              requestDescendantSnapshot();
            }
            const text = progressDecoder.decode(value, { stream: true });
            progress.feed(text);
            transcript?.feed(text);
            // Observational only (Issue #4293): a throwing observer must
            // never take the stream pump down with it.
            if (options.onActivity) {
              try {
                options.onActivity(progress.snapshot());
              } catch {
                // observer error is the observer's problem
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    })();

    const stderrChunks: Uint8Array[] = [];
    const stderrPump = (async () => {
      const reader = child.stderr.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) stderrChunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    })();

    // The settle promise gathers everything the runner used to await
    // unconditionally. After a watchdog kill it races the kill-completion
    // cap (Issue #4254) instead of blocking without bound.
    //
    // Issue #325: the child's *status* and the stream *pumps* fail
    // independently, and lumping them together is what held a pool slot for
    // 2473 s against a 120 s cap on 2026-08-22. After SIGKILL the direct
    // child is reaped promptly — `child.status` is about the process — but a
    // surviving descendant can hold the write end of the stdout pipe open
    // indefinitely, and the pump only ends at EOF. Awaiting the pumps as part
    // of "settled" therefore made an unkillable *grandchild* able to wedge
    // the slot, and with both slots wedged the cycle could not end.
    //
    // The status is now the settle condition. The pumps are drained as a
    // bounded courtesy: whatever has arrived is kept, and a pipe nobody will
    // ever close is abandoned rather than waited on. Losing the tail of
    // stdout on a run that is already a timeout failure is a far smaller harm
    // than never releasing the slot.
    const settle = (async () => {
      const s = await child.status;
      await Promise.race([
        Promise.all([
          stdoutPump.catch(() => {/* reader closed by kill */}),
          stderrPump.catch(() => {/* reader closed by kill */}),
        ]),
        streamDrainBound,
      ]);
      return s;
    })();

    const settled = await Promise.race([settle, killBound]);

    // The child is done, so no deadline check may still decide anything
    // (Issue #4296). Flagging first makes an in-flight check abandon its
    // decision; awaiting it settles the tree probe and stops it re-arming a
    // timer after the clear below — the leak Deno's sanitisers would flag.
    runFinished = true;
    if (extensionWork) await extensionWork;

    let status: { success: boolean; code: number; signal: Deno.Signal | null };
    let killIncompleteSeconds: number | undefined;
    if (settled === "kill-bound") {
      killIncompleteSeconds = Math.round((Date.now() - killFiredMs) / 1000);
      logger?.error(
        `Kill of PID ${childPid} did not complete within ` +
          `${killIncompleteSeconds}s of the ${
            timeoutReason ?? "watchdog"
          } firing (cap ${Math.round(killBoundMs / 1000)}s): child status ` +
          `and streams still unsettled after SIGTERM→SIGKILL escalation — ` +
          `likely an orphaned descendant holding the stdout pipe. ` +
          `Abandoning the wait with ${stdoutChunks.length} stdout / ` +
          `${stderrChunks.length} stderr chunks collected; the descendant ` +
          `snapshot collects any survivor (Issue #4382).`,
      );
      // Detach the abandoned waits so a late settle cannot surface as an
      // unhandled rejection.
      settle.catch(() => {/* abandoned */});
      killPromise?.catch(() => {/* abandoned */});
      // Synthesised: the child never reported a status (Issue #4254).
      status = { success: false, code: TIMEOUT_EXIT_CODE, signal: "SIGKILL" };
    } else {
      status = settled;
    }

    if (killBoundTimer) {
      clearTimeout(killBoundTimer);
      killBoundTimer = undefined;
    }
    // Issue #325: the drain timer is armed unconditionally, so it must be
    // cleared on every path or Deno's sanitisers flag a leaked timer on a
    // perfectly healthy run.
    if (streamDrainTimer !== undefined) {
      clearTimeout(streamDrainTimer);
      streamDrainTimer = undefined;
    }
    if (hardWatchdog) {
      clearTimeout(hardWatchdog);
      hardWatchdog = undefined;
    }
    if (silenceWatchdog) {
      clearTimeout(silenceWatchdog);
      silenceWatchdog = undefined;
    }
    if (descendantSnapshotTimer) {
      clearInterval(descendantSnapshotTimer);
      descendantSnapshotTimer = undefined;
    }

    // Wait for any kill cascade to finish so its internal timers complete
    // before we return — otherwise they outlive the call and leak. Skipped
    // when the kill-completion cap expired: that cascade is already known
    // to be stuck and is exactly what we are refusing to wait for.
    if (killPromise && killIncompleteSeconds === undefined) {
      await killPromise;
    }

    const stdoutBytes = concatChunks(stdoutChunks);
    const rawOutput = new TextDecoder().decode(stdoutBytes);
    const output = extractStreamJsonText(rawOutput);
    const stderrBytes = concatChunks(stderrChunks);
    const stderr = stripEscapeCodes(
      new TextDecoder().decode(stderrBytes),
    ).trim();

    // Resolve the requested model and effort once (Issue #2392, #2647) so both
    // credit logging and the per-run stats reuse the same resolution rather
    // than re-deriving it.
    const resolvedModel = model ??
      flagValue(args, "--model") ?? UNRESOLVED_MODEL_SENTINEL;
    // Read the explicit effort first (Issue #4109): a provider that carries
    // effort in its own syntax — Codex's `-c model_reasoning_effort=…` — has no
    // `--effort` flag to read back, so reading only the argument list would
    // drop the level from that provider's stats and credit log.
    const resolvedEffort = options.effort ?? flagValue(args, "--effort");

    // Per-run generation stats (Issue #2647) — served model IDs, requested
    // model/effort, token usage, turn count, and durations. Parsed from the
    // same raw stream-json; the effort string is passed through verbatim so
    // new levels (e.g. xhigh, #2620) flow untouched.
    const runStats = buildRunStats(rawOutput, {
      requestedModel: resolvedModel,
      ...(resolvedEffort ? { effort: resolvedEffort } : {}),
      wallClockMs: Date.now() - startMs,
      // Attribute the run to the provider that produced it (Issue #4109).
      provider: provider.id,
    });

    // Anthropic prompt-cache effectiveness for this invocation (Issue #4282).
    // Distinct from the disk prompt cache logged above: this is the share of
    // prompt tokens the API served from its own cache. Logging it per
    // invocation makes a prefix regression visible at the run that caused it,
    // not a fortnight later in the bill.
    const cacheRate = computeCacheHitRate(runStats.tokenUsage);
    if (cacheRate.measured) {
      const context = `${repo ?? "unknown"} phase=${phase ?? "unknown"}`;
      logger?.info(
        `Anthropic prompt cache: ${formatCacheHitRate(cacheRate)} ${context}`,
      );
      const warning = cacheHitRateWarning(cacheRate, context);
      if (warning) logger?.warn(warning);
    }

    // Credit-log model (Issue #3870). When the routing chain resolved no
    // `--model` arg the request ran on the CLI's own default, and logging the
    // literal `"default"` sentinel matched no pricing row — the invocation was
    // billed by Anthropic yet counted as $0 against the daily spend ceiling.
    // Prefer the id the API says it served, which the pricing table can match.
    const billedModel = resolvedModel === UNRESOLVED_MODEL_SENTINEL
      ? runStats.servedModels[0] ?? UNRESOLVED_MODEL_SENTINEL
      : resolvedModel;

    // Token usage for this run (Issue #366). Extraction is Claude-shaped, so a
    // non-Claude provider whose output it cannot parse is marked UNKNOWN and
    // warned about once — never recorded as a silent zero (Issue #3234). The
    // warning fires whether or not credit logging is configured, because the
    // run stats under-report just the same.
    const providerUsage = extractProviderTokenUsage(rawOutput, {
      provider: provider.id,
      displayName: provider.displayName,
      ...(repo ? { repo } : {}),
      ...(phase ? { phase } : {}),
      ...(billedModel ? { model: billedModel } : {}),
    });
    if (providerUsage.warning) logger?.warn(providerUsage.warning);

    // Log credit usage (Issue #1074) — fire-and-forget, never block execution
    if (creditLogDir && workerName) {
      const tokenUsage = providerUsage.usage;
      logInvocation({
        logDir: creditLogDir,
        workerName,
        phase: phase ?? "unknown",
        repo: repo ?? "unknown",
        model: billedModel,
        // Which agent CLI was billed (Issue #4109) — a Quorum run's three
        // invocations land in one log, on three different vendors.
        provider: provider.id,
        ...(options.fallbackFrom ? { fallbackFrom: options.fallbackFrom } : {}),
        ...(resolvedEffort ? { effort: resolvedEffort } : {}),
        ...(providerUsage.usageUnknown ? { usageUnknown: true } : {}),
        tokenUsage,
      }).catch(() => {/* Credit logging must never fail the main flow */});
    }

    // A killed run reports the snapshot taken at the kill; one that finished
    // reports where the deadline ended up (Issue #4298).
    const extensions = killTelemetry ?? snapshotExtensions(Date.now());

    activeAgentRuns.delete(childPid);
    const gotSigterm = !timedOut &&
      (status.signal === "SIGTERM" || status.code === 143);
    // Issue #46: a SIGTERM is only "our shutdown" when the worker actually
    // requested the termination (`terminateActiveAgentRuns` set the flag).
    // #4369 fixed the flag-true case; the flag-FALSE case is an external kill
    // — a tool the agent ran, the CLI, the container, a stray signal — and
    // must be surfaced and retried like the SIGKILL path, not accepted as a
    // silent run-end that lets the phase continue over a half-done tree.
    const ourShutdown = isAgentRunsTerminating();
    const terminated = gotSigterm && ourShutdown;
    const externalSigterm = gotSigterm && !ourShutdown;
    // The child died from outside, or our kill never settled: collect the
    // descendants it left behind before anything else starts (Issue #4382).
    const externallyKilled = !timedOut &&
      (status.code === 137 || status.signal === "SIGKILL" || gotSigterm);
    // Who held the memory at the kill (Issue #4382)? Captured before the
    // orphans are collected, so the table still shows them.
    let killDiagnostics: string | undefined;
    if (externallyKilled) {
      const capture = options.captureKillDiagnostics ??
        ((pid: number, known: readonly number[]) =>
          captureKillDiagnostics({ agentPid: pid, knownDescendants: known }));
      try {
        await descendantTracker?.settle();
        killDiagnostics = await capture(
          childPid,
          descendantTracker?.snapshot() ?? [],
        );
      } catch (err) {
        killDiagnostics = `kill diagnostics unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
    if (descendantTracker) {
      if (externallyKilled || killIncompleteSeconds !== undefined) {
        const collection = await descendantTracker.collectOrphans({
          reason: killIncompleteSeconds !== undefined
            ? "KILL_INCOMPLETE"
            : terminated
            ? "AGENT_TERMINATED"
            : "AGENT_KILLED",
          maxWaitSeconds: killAfterSeconds,
          logger,
        });
        // Did the collection give the memory back (Issue #4382)? A VM that
        // still reads high after its orphans are gone is evidence for the
        // operator's restart decision — named, not inferred.
        if (externallyKilled && collection.collected.length > 0) {
          const after = await readMemoryPressureAtKill(
            options.probeMemoryPressure,
          );
          if (after.level === "high") {
            logger?.security?.(
              "VM_MEMORY_NOT_RECLAIMED",
              `after_orphan_collection ${memoryPressureLogFields(after)} ` +
                `collected=${collection.collected.join(",")}`,
            );
          }
        }
      } else {
        await descendantTracker.settle();
      }
    }
    return {
      ok: true,
      value: {
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : status.code,
        // The unclassified truth (Issue #4202): what the process really
        // exited with, kept alongside whatever the classification says.
        rawExitCode: status.code,
        output,
        stderr,
        timedOut,
        timeoutReason,
        ...(terminated ? { terminated: true } : {}),
        ...(externalSigterm ? { externalSigterm: true } : {}),
        ...(watchdogLateSeconds !== undefined && watchdogLateSeconds > 0
          ? { watchdogLateSeconds }
          : {}),
        ...(killIncompleteSeconds !== undefined
          ? { killIncompleteSeconds }
          : {}),
        ...(killDiagnostics !== undefined ? { killDiagnostics } : {}),
        ...(extensions ? { extensions } : {}),
        runStats,
        provider: provider.id,
      },
    };
  } catch (error: unknown) {
    // Same ordering as the success path (Issue #4296): stop any in-flight
    // deadline check before the timers are cleared, so it cannot re-arm one.
    runFinished = true;
    if (extensionWork) await extensionWork.catch(() => {/* already logged */});
    if (hardWatchdog) clearTimeout(hardWatchdog);
    if (silenceWatchdog) clearTimeout(silenceWatchdog);
    if (killBoundTimer) clearTimeout(killBoundTimer);
    if (descendantSnapshotTimer) clearInterval(descendantSnapshotTimer);
    if (descendantTracker) await descendantTracker.settle();
    for (const [pid, run] of activeAgentRuns) {
      if (run.logger === logger && run.label.startsWith(phase ?? "agent")) {
        activeAgentRuns.delete(pid);
      }
    }

    return {
      ok: false,
      error: new Error(
        `Failed to execute Claude: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  } finally {
    // Flush the transcript's trailing partial line, whatever path exits.
    transcript?.close();
    // The shim directory is per-spawn — remove it once the child has exited.
    if (ghGuard) await ghGuard.cleanup();
    // The stdin feed has either completed or broken by now; settle it so
    // no pending write outlives the call, then drop the prompt file unless
    // the transcript tee is keeping evidence (Issue #4385).
    if (stdinFeed) await stdinFeed;
    if (promptFilePath && !transcript) {
      await Deno.remove(promptFilePath).catch(() => {/* already gone */});
    }
  }
}

/** Concatenate Uint8Array chunks into a single buffer. */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Kill a claude process tree on timeout: descendants first, then the parent.
 *
 * Killing descendants first frees a parent that may be blocked on `wait()`
 * for a hung child (the failure mode that left workers stuck for hours).
 * `terminateProcessTree` then handles the parent and its process group with
 * SIGTERM → SIGKILL escalation. Targeted at the known PID only (Issue #4275):
 * the old broad `pgrep claude`/`pkill deno test` sweep is gone — a stuck
 * container is run.sh's kill-and-reap responsibility (#4173), not an
 * in-container process hunt that could match the live agent.
 */
export async function killClaudeProcessTree(
  pid: number,
  killAfterSeconds: number,
  logger?: Logger,
): Promise<void> {
  try {
    await terminateDescendants(pid, killAfterSeconds);
  } catch (err) {
    logger?.error(
      `Failed to kill claude descendants (PID ${pid}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    await terminateProcessTree(pid, killAfterSeconds);
  } catch (err) {
    logger?.error(
      `Failed to kill claude process (PID ${pid}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Default gap between two memory-pressure evidence lines (Issue #4384). */
export const DEFAULT_MEMORY_WATCH_MIN_INTERVAL_MS = 60_000;

/** `ps -eo pid,ppid,rss,etime,args` for the memory watch. */
async function defaultRunPs(): Promise<string> {
  const out = await new Deno.Command("ps", {
    args: ["-eo", "pid,ppid,rss,etime,args"],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!out.success) throw new Error("ps failed");
  return new TextDecoder().decode(out.stdout);
}

/**
 * Take the memory-pressure reading at a kill (Issue #4374). The probe never
 * blocks a result: a throwing probe reads `unknown`.
 */
async function readMemoryPressureAtKill(
  probe: (() => Promise<MemoryPressureReading>) | undefined,
): Promise<MemoryPressureReading> {
  try {
    return await (probe ?? probeHostMemoryPressure)();
  } catch {
    return { level: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// Run Claude with retry
// ---------------------------------------------------------------------------

/**
 * Run Claude CLI with rate-limit retry logic and exponential backoff.
 *
 * @param options - Execution options
 * @param retryOptions - Retry configuration
 * @returns Result containing the run result
 */
export async function runClaudeWithRetry(
  options: RunClaudeOptions,
  retryOptions: RetryOptions = {},
): Promise<Result<ClaudeRunResult>> {
  const {
    maxRetries = 2,
    maxWaitSeconds = 600,
    initialWaitInterval = 300,
    maxTotalInvocations = DEFAULT_MAX_TOTAL_INVOCATIONS,
  } = retryOptions;

  const errorScanTailLines = options.errorScanTailLines ??
    DEFAULT_ERROR_SCAN_TAIL_LINES;
  const enableFallback = options.enableModelFallback ?? true;

  // Pre-flight Fable reroute (Issue #3231, parent #3217). This is the single
  // chokepoint every Fable-preferring phase (planning, grill_me, refinement,
  // revision, question, clarification) dispatches through. When the cached
  // probe (#3230) says Fable is unavailable and the operator has NOT pinned the
  // phase, force this one invocation onto Opus @ `max` and flag the run
  // degraded. The override is applied at the invocation layer only — it never
  // rewrites PHASE_MODEL_DEFAULTS, so `buildClaudeModelArgs(phase)` still
  // resolves to `fable` and the #2720 served-vs-expected check keeps working.
  let preflightDegraded = false;
  let preflightDegradedReason: string | undefined;
  if (isFablePreferringPhase(options.phase)) {
    // Detect a genuine operator override so the probe never second-guesses a
    // pinned phase. Model overrides cannot be detected by env-var presence:
    // `load_config` exports the *default* fable routing as `CLAUDE_MODEL_<PHASE>`,
    // so the reliable signal is the resolved model tier — if the phase no
    // longer resolves to fable, an operator moved it off the tier. Effort has
    // no default env export, so a call-site or env/config effort value is a
    // genuine pin.
    const effectiveModel = options.model ??
      buildClaudeModelArgs(options.phase)[1] ?? "";
    const routedToFable = modelFamily(effectiveModel) === "fable";
    const hasExplicitOverride = !routedToFable ||
      options.effort != null ||
      hasExplicitEffortOverride(options.phase);
    const fableVerdict = readFableAvailability(options.cwd ?? ".");
    const applied = applyFablePreflightRouting(
      options,
      fableVerdict,
      hasExplicitOverride,
    );
    options = applied.options;
    preflightDegraded = applied.routing.degraded;
    preflightDegradedReason = applied.routing.reason;
    if (preflightDegraded) {
      options.logger?.warn(
        `Fable unavailable (pre-flight probe): rerouting phase ` +
          `"${options.phase}" to --model opus --effort max ` +
          `(run flagged degraded).`,
      );
    }
  }

  /**
   * Id of the provider the last invocation actually ran (Issue #4109), stamped
   * onto every result so retries and model fallbacks stay attributed to the
   * agent that produced them. Call-scoped, so a concurrent call naming another
   * provider cannot disturb it.
   */
  let invokedProvider: string | undefined;

  /**
   * Extension telemetry from the last invocation (Issue #4298), stamped onto
   * every result so the honest timeout wording survives the retry wrapper.
   * Absent while the feature is off, and before the first invocation.
   */
  let invokedExtensions: ExtensionTelemetry | undefined;

  /**
   * Thread the pre-flight degraded flag, the invoked provider and the
   * extension telemetry onto a run result. The degraded fields stay absent
   * when the reroute did not fire, so a normal run's result shape is
   * otherwise unchanged.
   */
  const withPreflight = (value: ClaudeRunResult): ClaudeRunResult => ({
    ...value,
    ...(invokedProvider ? { provider: invokedProvider } : {}),
    ...(invokedExtensions ? { extensions: invokedExtensions } : {}),
    ...(preflightDegraded
      ? { preflightDegraded: true, preflightDegradedReason }
      : {}),
  });

  // Track the current effective options (may be mutated on fallback)
  let currentOptions = { ...options };
  let fallbackModel: string | undefined;
  let retryCount = 0;
  let totalWaitTime = 0;
  let waitInterval = initialWaitInterval;
  // Issue #3648: call-scoped invocation budget. `retryCount` and
  // `totalWaitTime` are deliberately reset on each fallback rung so each model
  // tier gets a fresh backoff, which means neither bounds the total spend of
  // the call. This counter never resets.
  let totalInvocations = 0;

  while (true) {
    if (totalInvocations >= maxTotalInvocations) {
      currentOptions.logger?.error(
        `Invocation budget exhausted: ${totalInvocations} billed ` +
          `\`claude\` invocations reached the call ceiling of ` +
          `${maxTotalInvocations} (Issue #3648). Giving up.`,
      );
      currentOptions.logger?.security?.(
        "INVOCATION_BUDGET_EXHAUSTED",
        `total_invocations=${totalInvocations} max=${maxTotalInvocations}`,
      );
      return {
        ok: true,
        value: withPreflight({
          exitCode: 2,
          output: "",
          timedOut: false,
          fallbackModel,
        }),
      };
    }
    // The worker is terminating agent runs (run end, handler abandonment,
    // shutdown — Issue #4369): never spawn another agent from a retry loop.
    if (agentRunsTerminating) {
      currentOptions.logger?.warn(
        "Agent runs are terminating — not launching the agent (no retry, no wait).",
      );
      return {
        ok: true,
        value: withPreflight({
          exitCode: 143,
          rawExitCode: 143,
          output: "",
          timedOut: false,
          terminated: true,
          fallbackModel,
        }),
      };
    }
    totalInvocations++;
    const result = await runClaudeWithTimeout(currentOptions);

    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
      };
    }
    if (result.value.terminated) {
      // Killed by our own cleanup/abandonment, not by the API (Issue #4369):
      // the output tail may well contain "rate limit"/"exceeded" from the
      // agent's own tool output, so it must never reach detectRateLimit.
      currentOptions.logger?.warn(
        `Agent terminated (SIGTERM, exit ${
          result.value.rawExitCode ?? 143
        }) — the run is ending; no retry, no wait.`,
      );
      return { ok: true, value: withPreflight(result.value) };
    }
    if (result.value.externalSigterm) {
      // Issue #46: a SIGTERM the worker never requested — an external kill.
      // Surface it like the SIGKILL path (stderr tail, elapsed, kill
      // diagnostics) instead of accepting it as run-end; the execute phase
      // then fails the phase (not `continue`) and the bounded infrastructure
      // retry applies.
      const stderrTail = redactSecrets(
        (result.value.stderr ?? "").trim().split("\n").slice(-5).join("\n"),
      );
      const elapsedSeconds = Math.round(
        (result.value.runStats?.wallClockMs ?? 0) / 1000,
      );
      currentOptions.logger?.warn(
        `Agent killed by an external SIGTERM (exit ${
          result.value.rawExitCode ?? 143
        }) after ${elapsedSeconds}s — the worker did not request this ` +
          `shutdown` +
          (stderrTail ? `; stderr tail:\n${stderrTail}` : " (stderr empty)") +
          (result.value.killDiagnostics
            ? `\nKill diagnostics:\n${result.value.killDiagnostics}`
            : ""),
      );
      currentOptions.logger?.security?.(
        "AGENT_KILLED",
        `raw_exit_code=${
          result.value.rawExitCode ?? 143
        } external_sigterm=true`,
      );
      return { ok: true, value: withPreflight(result.value) };
    }

    const {
      exitCode,
      rawExitCode,
      output,
      stderr,
      timedOut,
      timeoutReason,
      runStats,
    } = result.value;
    invokedProvider = result.value.provider ?? invokedProvider;
    invokedExtensions = result.value.extensions ?? invokedExtensions;

    // Out of memory (Issue #2741, parent #2721) — TERMINAL. Checked first,
    // before the timeout and rate-limit paths, for two reasons:
    //   1. An OOM's "heap limit" wording matches the secondary rate-limit
    //      pattern (`/(try again|retry|limit)/i`), so without this short-circuit
    //      the run would be paused-and-retried — waiting cannot reclaim memory.
    //   2. A `137` exit (128 + 9, SIGKILL — the Linux OOM-killer) would
    //      otherwise be lumped in with timeouts by the branch below.
    // A genuine watchdog timeout (`timedOut === true`) is a real timeout
    // regardless of output, so OOM reclassification only fires when the
    // watchdog did NOT trip and the exit is non-zero: a `137` with memory
    // evidence becomes OOM, while a `137` without it keeps timeout semantics.
    // Both streams are scanned (Issue #4237): a Node/V8 heap abort prints
    // its FATAL ERROR to STDERR, and scanning stdout alone misclassified
    // the agent's own heap ceiling as an external SIGKILL.
    if (
      exitCode !== 0 && !timedOut &&
      detectOutOfMemory(`${output}\n${stderr ?? ""}`, errorScanTailLines)
    ) {
      currentOptions.logger?.warn(
        `Out of memory detected (exit code: ${exitCode}). Terminal — no retry, no wait.`,
      );
      currentOptions.logger?.security?.(
        "OUT_OF_MEMORY",
        `exit_code=${exitCode}`,
      );
      return {
        ok: true,
        value: withPreflight({
          exitCode: OOM_EXIT_CODE,
          rawExitCode,
          output,
          timedOut: false,
          outOfMemory: true,
          fallbackModel,
          runStats,
        }),
      };
    }

    // Timeout — return immediately. ONLY a genuine watchdog fire is a
    // timeout (Issue #4202): the old `exitCode === 124 || exitCode === 137`
    // arms remapped a self-exited 124 and a bare SIGKILL onto the timeout
    // code, destroying the evidence — observed live, a VM OOM-kill at 539 s
    // of a 3600 s budget was reported as "timed out".
    if (timedOut) {
      const diagnostics = captureTimeoutDiagnostics(
        output,
        "claude execution",
      );
      return {
        ok: true,
        value: withPreflight({
          exitCode: TIMEOUT_EXIT_CODE,
          rawExitCode,
          output,
          timedOut: true,
          timeoutReason,
          // Carry the #4254 evidence: a late-firing watchdog and an
          // abandoned post-kill wait must survive into the diagnostics.
          ...(result.value.watchdogLateSeconds !== undefined
            ? { watchdogLateSeconds: result.value.watchdogLateSeconds }
            : {}),
          ...(result.value.killIncompleteSeconds !== undefined
            ? { killIncompleteSeconds: result.value.killIncompleteSeconds }
            : {}),
          diagnostics,
          fallbackModel,
          runStats,
        }),
      };
    }

    // SIGKILL with no watchdog and no memory evidence (the OOM branch above
    // already claimed 137-with-evidence): report the kill faithfully
    // (Issue #4202). Terminal here — waiting cannot un-kill a process, and
    // the phase-level infrastructure retry (#1550) owns the one bounded
    // retry, because transient memory pressure may have passed.
    if (exitCode === 137) {
      const stderrTail = (stderr ?? "").trim().split("\n").slice(-5).join(
        "\n",
      );
      // Read the memory pressure now, at the kill (Issue #4374): the
      // reading is the OOM evidence the release comment and the auto-filed
      // issue carry, and the phase's retry decision consults it.
      const memoryPressureAtKill = await readMemoryPressureAtKill(
        currentOptions.probeMemoryPressure,
      );
      currentOptions.logger?.warn(
        `Claude exited 137 (SIGKILL) with no watchdog firing — killed ` +
          `externally; memory pressure: ${
            describeMemoryPressure(memoryPressureAtKill)
          }.` +
          (stderrTail ? ` stderr tail:\n${stderrTail}` : " (stderr empty)"),
      );
      currentOptions.logger?.security?.(
        "AGENT_KILLED",
        `raw_exit_code=${rawExitCode ?? exitCode} ${
          memoryPressureLogFields(memoryPressureAtKill)
        }`,
      );
      // The evidence the operator asks for at a kill (Issue #4382): who
      // held the memory, and whether the kernel says it was an OOM.
      const killDiagnostics = result.value.killDiagnostics;
      if (killDiagnostics) {
        currentOptions.logger?.warn(`Kill diagnostics:\n${killDiagnostics}`);
      }
      return {
        ok: true,
        value: withPreflight({
          exitCode: 137,
          rawExitCode,
          output,
          stderr,
          timedOut: false,
          killed: true,
          memoryPressureAtKill,
          ...(killDiagnostics ? { killDiagnostics } : {}),
          diagnostics: captureTimeoutDiagnostics(
            output,
            "claude execution (killed: SIGKILL, no watchdog)",
          ),
          fallbackModel,
          runStats,
        }),
      };
    }

    if (exitCode !== 0) {
      // Model unavailable / not permitted (Issue #2724) — e.g. a top-tier
      // model suspended or removed. This is checked BEFORE the rate-limit
      // path: such an error is terminal for the current model (retrying it is
      // futile), and its wording can incidentally match the secondary
      // rate-limit pattern, which would otherwise route it into the
      // wait-and-retry loop. Fall back to the next-best model immediately,
      // with no wait.
      // Both streams (Issue #4315): the CLI writes its refusals to stderr,
      // and with no stream-json `result` line stdout is empty — scanning
      // stdout alone made every stderr-only refusal an "unknown" failure.
      const bothStreams = `${output}\n${stderr ?? ""}`;

      // The CLI refused the session id (Issue #204) — checked first because it
      // is a start-up failure: the process died before any model call, so
      // nothing downstream (rate limit, model availability) can be read from
      // this output. The remedy is the flags, not the model or a wait: drop
      // them and retry once. Clearing the state is also what bounds the retry —
      // a second refusal has no session flags left to blame and falls through
      // to the ordinary failure path. Loud, because the run continues without
      // CLI session continuity and the caller must see that in the log.
      if (
        currentOptions.sessionResumeState &&
        detectInvalidSessionId(bothStreams, errorScanTailLines)
      ) {
        const rejectedId = currentOptions.sessionResumeState.sessionId;
        currentOptions.logger?.warn(
          `Claude CLI rejected the session id "${rejectedId}" ` +
            `("Invalid session ID") and exited ${exitCode} without running. ` +
            `Retrying once without --session-id/--resume — this run loses CLI ` +
            `session continuity (Issue #204).`,
        );
        currentOptions.logger?.security?.(
          "INVALID_SESSION_ID",
          `exit_code=${exitCode} session_id=${rejectedId}`,
        );
        currentOptions = { ...currentOptions, sessionResumeState: undefined };
        continue;
      }

      if (detectModelUnavailable(bothStreams, errorScanTailLines)) {
        const currentModel = resolveCurrentModel(
          currentOptions.model,
          currentOptions.phase,
          currentOptions.agentProvider,
        );
        const fallbackResult = attemptModelFallback(
          currentModel,
          enableFallback,
          currentOptions.agentProvider,
        );

        if (fallbackResult.ok) {
          fallbackModel = fallbackResult.cheaperModel;
          // Record the pre-fallback model so the post-fallback credit-log
          // entry carries the original→cheaper transition (Issue #2707).
          currentOptions = {
            ...currentOptions,
            model: fallbackModel,
            fallbackFrom: currentModel,
          };
          currentOptions.logger?.warn(
            `Model "${currentModel}" unavailable or not permitted (exit code: ${exitCode}). Falling back to "${fallbackModel}" without waiting.`,
          );
          currentOptions.logger?.security?.(
            "MODEL_UNAVAILABLE",
            `from=${currentModel} to=${fallbackModel} exit_code=${exitCode}`,
          );

          // Reset retry state for the new model tier. No wait — the previous
          // model is gone, not throttled.
          retryCount = 0;
          totalWaitTime = 0;
          waitInterval = initialWaitInterval;
          continue;
        }

        // No cheaper model available — give up rather than re-run an
        // unavailable model. Name the provider when it has no ladder at all
        // (Issue #365), so "no downgrade attempted" is visible rather than
        // inferred.
        warnNoModelLadder(fallbackResult, currentModel, currentOptions.logger);
        currentOptions.logger?.error(
          `Model "${currentModel}" unavailable and no cheaper fallback available (${fallbackResult.reason}). Giving up.`,
        );
        return {
          ok: true,
          value: withPreflight({
            exitCode,
            rawExitCode,
            output,
            timedOut: false,
            fallbackModel,
            runStats,
          }),
        };
      }

      // Subscription usage limit (Issue #4315) — TERMINAL for this call,
      // checked before the rate-limit branch. The 5-hour/weekly window is
      // account-wide: retrying burns it further and a model downgrade bills
      // the same window, so there is no fallback ladder here. The durable
      // signal (WORK_DIR, not cwd) tells run_core and every other worker on
      // the volume to pause until the parsed reset — or an hour when the
      // message carries no time.
      if (detectUsageLimit(bothStreams, errorScanTailLines)) {
        const resetMs = parseUsageLimitReset(bothStreams);
        // Issue #333: cap the pause so an extended quota is picked up within
        // the hour, whatever the stated reset. The reset is reported, not
        // slept on.
        const untilResetSeconds = resetMs !== null
          ? Math.max(60, Math.ceil((resetMs - Date.now()) / 1000))
          : USAGE_LIMIT_DEFAULT_WAIT_SECONDS;
        const waitSeconds = Math.min(
          untilResetSeconds,
          USAGE_LIMIT_MAX_WAIT_SECONDS,
        );
        currentOptions.logger?.error(
          `Claude usage limit reached (subscription window) — exit code ` +
            `${exitCode}. Not retrying and not falling back (every model ` +
            `bills the same window). Pausing agent work for ${waitSeconds}s` +
            // Issue #333: say what the message actually said. This used to
            // claim "no reset time in the message" against a message reading
            // `resets Aug 25, 1am (UTC)`, which is what hid the missing
            // dated-form parse for a day and a half.
            (resetMs === null
              ? " (the message carried no parseable reset time)"
              : waitSeconds < untilResetSeconds
              ? ` — the window reopens in ${
                formatCoarseDuration(untilResetSeconds)
              } (${
                new Date(resetMs).toISOString()
              }); re-probing every ${waitSeconds}s in case the quota is extended`
              : ` (until ${new Date(resetMs).toISOString()})`) +
            ".",
        );
        currentOptions.logger?.security?.(
          "USAGE_LIMIT",
          `exit_code=${exitCode} wait_seconds=${waitSeconds}`,
        );
        const signalDir = resolveSignalDir(currentOptions.cwd);
        if (signalDir) {
          // Issue #333: carry the true reset beside the capped wait, so the
          // FLEET report can say "no quota until Tuesday" rather than only
          // "unhealthy".
          const signalResult = await writeRateLimitSignal(
            signalDir,
            waitSeconds,
            resetMs ?? undefined,
          );
          if (!signalResult.ok) {
            currentOptions.logger?.warn(
              `Could not write usage-limit signal: ${signalResult.error.message}`,
            );
          }
        }
        return {
          ok: true,
          value: withPreflight({
            exitCode: 2,
            rawExitCode,
            output,
            stderr,
            timedOut: false,
            fallbackModel,
            runStats,
            usageLimit: {
              waitSeconds,
              ...(resetMs !== null ? { resetEpochMs: resetMs } : {}),
            },
          }),
        };
      }

      // Check for rate limiting on non-zero exit
      const { isRateLimited, isPrimary } = detectRateLimit(
        bothStreams,
        errorScanTailLines,
      );

      if (isRateLimited) {
        retryCount++;
        currentOptions.logger?.warn(
          isPrimary
            ? `Credits exhausted or rate limited (exit code: ${exitCode}).`
            : `Possible rate limit detected (exit code: ${exitCode}).`,
        );
        currentOptions.logger?.security?.(
          "RATE_LIMIT",
          `retry_count=${retryCount} max_retries=${maxRetries} total_wait=${totalWaitTime}s max_wait=${maxWaitSeconds}s`,
        );

        // When retries or wait time exhausted, attempt model fallback (Issue #1113)
        if (retryCount > maxRetries || totalWaitTime >= maxWaitSeconds) {
          const currentModel = resolveCurrentModel(
            currentOptions.model,
            currentOptions.phase,
            currentOptions.agentProvider,
          );
          const fallbackResult = attemptModelFallback(
            currentModel,
            enableFallback,
            currentOptions.agentProvider,
          );

          if (fallbackResult.ok) {
            fallbackModel = fallbackResult.cheaperModel;
            // Record the pre-fallback model so the post-fallback credit-log
            // entry carries the original→cheaper transition (Issue #2707).
            currentOptions = {
              ...currentOptions,
              model: fallbackModel,
              fallbackFrom: currentModel,
            };
            currentOptions.logger?.info(
              `Model fallback: downgrading from "${currentModel}" to "${fallbackModel}" after rate limit exhaustion.`,
            );

            // Reset retry state for the new model tier
            retryCount = 0;
            totalWaitTime = 0;
            waitInterval = initialWaitInterval;
            continue;
          }

          // No fallback available — give up. A provider with no ladder is
          // named once (Issue #365) rather than left to look like a run that
          // was already on the cheapest tier.
          warnNoModelLadder(
            fallbackResult,
            currentModel,
            currentOptions.logger,
          );
          const reason = retryCount > maxRetries
            ? `Rate limit retry count exceeded (${retryCount} > ${maxRetries}).`
            : `Rate limit wait time exceeded (${totalWaitTime}s >= ${maxWaitSeconds}s).`;
          currentOptions.logger?.error(
            `${reason} No cheaper model available (${fallbackResult.reason}). Giving up.`,
          );
          return {
            ok: true,
            value: withPreflight({
              exitCode: 2,
              rawExitCode,
              output,
              timedOut: false,
              fallbackModel,
              runStats,
            }),
          };
        }

        // Calculate wait with jitter (±30%) and cap (Issue #1073)
        const jitteredWait = applyJitter(waitInterval);
        const remainingWait = maxWaitSeconds - totalWaitTime;
        const actualWait = Math.min(jitteredWait, remainingWait);

        // Signal other workers on this machine about the rate limit. The
        // signal lives in WORK_DIR (Issue #4315): it used to be written to
        // cwd — the per-issue clone — which run_core never reads, and the
        // main execute path passed no cwd at all, so it was never written.
        const rateSignalDir = resolveSignalDir(currentOptions.cwd);
        if (rateSignalDir) {
          const signalResult = await writeRateLimitSignal(
            rateSignalDir,
            actualWait,
          );
          if (!signalResult.ok) {
            currentOptions.logger?.warn(
              `Could not write rate-limit signal: ${signalResult.error.message}`,
            );
          }
        }

        currentOptions.logger?.info(
          `Retry ${retryCount} of ${maxRetries}. Waiting ${actualWait}s (jittered from ${waitInterval}s, total waited: ${totalWaitTime}s, max: ${maxWaitSeconds}s)...`,
        );

        await new Promise((resolve) => setTimeout(resolve, actualWait * 1000));
        totalWaitTime += actualWait;
        waitInterval *= 2; // Exponential backoff
        continue;
      }

      // Non-rate-limit failure (Issue #35): the old log said only the exit
      // status and dropped the captured stderr, so a transient start-up
      // refusal was indistinguishable from a mid-run crash and its cause was
      // lost. See buildClaudeFailureLog.
      currentOptions.logger?.warn(
        buildClaudeFailureLog({
          exitCode,
          stderr: stderr ?? "",
          output,
          wallClockMs: runStats?.wallClockMs ?? 0,
        }),
      );
      return {
        ok: true,
        value: withPreflight(
          {
            exitCode,
            rawExitCode,
            output,
            timedOut: false,
            fallbackModel,
            runStats,
          },
        ),
      };
    }

    // Success
    return {
      ok: true,
      value: withPreflight(
        {
          exitCode: 0,
          rawExitCode,
          output,
          timedOut: false,
          fallbackModel,
          runStats,
        },
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// Health check (Issue #387)
// ---------------------------------------------------------------------------

/**
 * Pre-flight health check to verify Claude CLI is responsive.
 *
 * Runs a trivial prompt with a short timeout to detect rate limiting
 * or authentication issues BEFORE attempting real work.
 *
 * @param timeoutSeconds - Timeout for the health check (default: 30)
 * @param logger - Optional logger
 * @param agentProvider - Provider to probe for this call only (Issue #4109);
 *   omit for the active provider.
 * @returns Health check result
 */
export async function checkClaudeHealth(
  timeoutSeconds: number = 30,
  logger?: Logger,
  agentProvider?: AgentProviderSelector,
): Promise<HealthCheckResult> {
  // Resolve once, per call: the probe, the auth message and the log lines all
  // describe the same agent even while another provider is probed
  // concurrently (Issue #4109).
  const provider = selectAgentProvider(agentProvider);
  logger?.info(
    `Running ${provider.displayName} health check (${timeoutSeconds}s timeout)...`,
  );

  const result = await runClaudeWithTimeout({
    prompt: "Respond with exactly: OK",
    timeoutSeconds,
    killAfterSeconds: 5,
    phase: "health",
    logger,
    disallowedTools: [],
    agentProvider: provider,
  });

  if (!result.ok) {
    return {
      healthy: false,
      exitCode: 1,
      message: `Health check error: ${result.error.message}`,
    };
  }

  const { exitCode, output, stderr } = result.value;

  if (exitCode === 0 && output.trim().length > 0) {
    logger?.info(
      `${provider.displayName} health check passed (${output.length} bytes output)`,
    );
    return {
      healthy: true,
      exitCode: 0,
      message: `${provider.displayName} is responsive`,
    };
  }

  // Build an accurate, evidence-based failure summary (Issue #1980). Replaces
  // the historical catch-all "rate-limited or unresponsive" warning that
  // discarded stderr and mis-attributed every failure mode to rate limiting.
  const summary = summariseHealthFailure(exitCode, output, stderr);

  // Auth errors keep their specific message + actionable instructions.
  if (summary.category === "auth") {
    // Provider-auth classification goes through the seam (Issue #4067), for
    // the provider this call probed rather than the process-wide active one
    // (Issue #4109).
    const actionable = provider.authActionableMessage();
    logger?.error(`${provider.displayName} requires login`);
    logger?.error(`ACTION REQUIRED: ${actionable}`);
    logger?.error(
      `Health check failed: exit=${exitCode} stderr=${summary.stderrPreview} stdout=${summary.stdoutPreview}`,
    );
    return { healthy: false, exitCode: 2, message: actionable };
  }

  logger?.warn(summary.message);
  logger?.warn(
    `Health check details: exit=${exitCode} stderr=${summary.stderrPreview} stdout=${summary.stdoutPreview}`,
  );

  // Rate/usage limited (Issue #4315): report it as such so the caller
  // pauses until the window resets instead of firing a fresh billed probe
  // every cycle — observed as ~120 probes/hour for the whole window.
  if (summary.category === "usage-limit" || summary.category === "rate-limit") {
    const resetMs = summary.category === "usage-limit"
      ? parseUsageLimitReset(`${output}\n${stderr}`)
      : null;
    const pauseSeconds = resetMs !== null
      ? Math.max(60, Math.ceil((resetMs - Date.now()) / 1000))
      : summary.category === "usage-limit"
      ? USAGE_LIMIT_DEFAULT_WAIT_SECONDS
      : 600;
    return {
      healthy: false,
      exitCode: 3,
      message: summary.message,
      pauseSeconds,
    };
  }

  return {
    healthy: false,
    exitCode: 1,
    message: summary.message,
  };
}

// ---------------------------------------------------------------------------
// Fable-availability probe (Issue #3230, parent #3217)
// ---------------------------------------------------------------------------

/** Injectable Claude runner for the Fable probe — test seam. */
export type FableProbeRunner = (
  options: RunClaudeOptions,
) => Promise<Result<ClaudeExecutionResult>>;

/**
 * Probe whether Fable 5 is currently reachable by running the trivial health
 * prompt with `--model fable` and classifying the outcome.
 *
 * Classification (deliberately optimistic — a transient error must never be
 * mistaken for "Fable removed"):
 *   - Exit 0 with output ⇒ **available**.
 *   - Non-zero *and* {@link detectModelUnavailable} matches (model-access / 403
 *     / suspended / export-control) ⇒ **unavailable**.
 *   - Any other failure (rate-limit, timeout, transient network, runner error)
 *     ⇒ **available** (not conclusive).
 *
 * @param timeoutSeconds - Timeout for the probe (default: 30)
 * @param logger - Optional logger
 * @param runner - Injectable Claude runner (default: runClaudeWithTimeout)
 * @returns The Fable-availability verdict
 */
export async function checkFableAvailable(
  timeoutSeconds: number = 30,
  logger?: Logger,
  runner: FableProbeRunner = runClaudeWithTimeout,
): Promise<FableAvailability> {
  logger?.info(`Probing Fable availability (${timeoutSeconds}s timeout)...`);

  const result = await runner({
    prompt: "Respond with exactly: OK",
    model: "fable",
    timeoutSeconds,
    killAfterSeconds: 5,
    phase: "health",
    logger,
    disallowedTools: [],
  });

  if (!result.ok) {
    // Runner error (spawn failure etc.) — not conclusive. Optimistic.
    logger?.warn(
      `Fable probe inconclusive (runner error): ${result.error.message}. Assuming available.`,
    );
    return "available";
  }

  const { exitCode, output, stderr } = result.value;

  if (exitCode === 0 && output.trim().length > 0) {
    logger?.info("Fable probe: available");
    return "available";
  }

  // Scan both stdout and stderr — the CLI's model-access error may land on
  // either stream.
  const combined = `${output}\n${stderr ?? ""}`;
  if (detectModelUnavailable(combined)) {
    logger?.warn("Fable probe: unavailable (model-access failure)");
    return "unavailable";
  }

  // Rate-limit / timeout / other transient failure — not conclusive.
  logger?.warn(
    `Fable probe inconclusive (exit ${exitCode}). Assuming available.`,
  );
  return "available";
}

/** Options for {@link checkFableAvailability}. */
export interface CheckFableAvailabilityOptions {
  /** Directory containing the `.health_cache_fable` file. */
  workDir: string;
  /** Cache TTL in seconds (default: DEFAULT_HEALTH_CACHE_TTL). */
  ttlSeconds?: number;
  /** Timeout for the probe when it runs (default: 30). */
  timeoutSeconds?: number;
  /** Optional logger. */
  logger?: Logger;
  /** Injectable probe — test seam (default: checkFableAvailable). */
  probe?: (
    timeoutSeconds: number,
    logger?: Logger,
  ) => Promise<FableAvailability>;
  /** Injectable time source (default: Date.now). */
  now?: () => number;
}

/**
 * Cached Fable-availability read path (Issue #3230).
 *
 * Returns the cached verdict when the `.health_cache_fable` entry is still
 * fresh; otherwise runs {@link checkFableAvailable}, records the result for the
 * TTL, and returns it. Fable being unavailable only sets the cache — it never
 * throws, so callers can run it best-effort alongside the Claude health-check
 * cadence without risk of blocking the worker. A probe error is logged and
 * treated as `available` (optimistic).
 *
 * @param opts - Cache directory, TTL, and injectable probe/clock
 * @returns The Fable-availability verdict (never throws)
 */
export async function checkFableAvailability(
  opts: CheckFableAvailabilityOptions,
): Promise<FableAvailability> {
  const {
    workDir,
    ttlSeconds = DEFAULT_HEALTH_CACHE_TTL,
    timeoutSeconds = 30,
    logger,
    probe = checkFableAvailable,
    now,
  } = opts;

  const cached = readFableAvailability(workDir, ttlSeconds, now);
  if (cached !== "unknown") {
    return cached;
  }

  let verdict: FableAvailability;
  try {
    verdict = await probe(timeoutSeconds, logger);
  } catch (err) {
    logger?.warn(
      `Fable availability probe threw: ${
        err instanceof Error ? err.message : String(err)
      }. Assuming available.`,
    );
    verdict = "available";
  }

  const recorded = recordFableAvailability(
    workDir,
    verdict === "available",
    now,
  );
  if (!recorded.ok) {
    logger?.warn(
      `Failed to record Fable availability: ${recorded.error.message}`,
    );
  }

  return verdict;
}

// ---------------------------------------------------------------------------
// Content summarisation (Issue #43)
// ---------------------------------------------------------------------------

/**
 * Static system prompt for the summarise phase (Issue #2395).
 *
 * Carries the standardised summarisation instructions that are byte-identical
 * across every invocation, so the Claude CLI can route them through the
 * `--system-prompt` cache breakpoint. Opus 4.8 lowered the prompt-cache
 * minimum to 1,024 tokens; this constant is below that floor on its own, but
 * structuring the call this way keeps the dynamic `content` out of the cached
 * prefix and lets the prefix cache as soon as it grows past the threshold or
 * the model in use lowers it further.
 */
export const SUMMARISE_SYSTEM_PROMPT =
  `You are summarising a large GitHub issue or comment to reduce token usage.
Read the content and create a concise summary that:

1. Preserves ALL technical requirements and instructions
2. Keeps code snippets, file paths, and technical details intact
3. Maintains the original intent and action items
4. Removes verbose explanations, repeated information, and unnecessary context
5. Uses bullet points for clarity where appropriate

IMPORTANT:
- Do NOT add any preamble like "Here is a summary" - just output the summary directly
- Keep all code blocks and technical specifications
- Preserve any URLs, issue references, or file paths mentioned
- The summary should be self-contained and actionable

Output ONLY the summarised content, nothing else.`;

/**
 * Build the user-prompt payload for `summariseLargeContent` (Issue #2395).
 *
 * Carries only the dynamic content to be summarised, so the static
 * instructions in {@link SUMMARISE_SYSTEM_PROMPT} stay a stable, cacheable
 * prefix across invocations.
 *
 * Exported for direct unit testing of the prompt structure.
 */
export function buildSummariseUserPrompt(content: string): string {
  return `---\nContent to summarise:\n${content}\n---`;
}

/** Options for content summarisation. */
export interface SummariseOptions {
  /** The content to summarise. */
  content: string;
  /** Context description (e.g., "issue body", "PR comment"). */
  context?: string;
  /** Timeout in seconds for summarisation. */
  timeoutSeconds?: number;
  /** Kill-after grace period in seconds. */
  killAfterSeconds?: number;
  /** Logger instance. */
  logger?: Logger;
  /**
   * Injectable Claude runner — test seam (Issue #3037).
   *
   * Defaults to {@link runClaudeWithTimeout}. Tests pass a stub so the
   * summarisation path (payload assembly, success/error mapping) can be
   * exercised without spawning the Claude CLI.
   */
  runner?: (
    options: RunClaudeOptions,
  ) => Promise<Result<ClaudeExecutionResult>>;
}

/**
 * Summarise large content using Claude.
 *
 * When issue bodies or comments exceed token limits, this creates a concise
 * summary preserving key technical details.
 *
 * @param options - Summarisation options
 * @returns Result with the summarised content, or error if summarisation failed
 */
export async function summariseLargeContent(
  options: SummariseOptions,
): Promise<Result<string>> {
  const {
    content,
    context = "content",
    timeoutSeconds = 120,
    killAfterSeconds = 10,
    logger,
    runner = runClaudeWithTimeout,
  } = options;

  const tokenEstimate = getTokenEstimate(content);
  logger?.info(
    `Summarising large ${context} (estimated ${tokenEstimate} tokens)...`,
  );

  // Guard the Haiku 200k context window (Issue #2393). `summarise` is pinned
  // to Haiku for cost, but is the phase most likely to be fed an input that
  // exceeds the Haiku window — silently truncating the input degrades the
  // summary without any signal. When the estimate approaches/exceeds the
  // Haiku window we escalate to a larger-window tier for this run only.
  const escalation = selectModelForLargeInput("summarise", tokenEstimate);
  if (escalation.escalated) {
    logger?.info(`Phase model escalation: ${escalation.reason}`);
  }

  const result = await runner({
    prompt: buildSummariseUserPrompt(content),
    systemPrompt: SUMMARISE_SYSTEM_PROMPT,
    timeoutSeconds,
    killAfterSeconds,
    phase: "summarise",
    model: escalation.escalated ? escalation.model : undefined,
    logger,
    disallowedTools: [],
  });

  if (!result.ok) {
    logger?.warn(`Summarisation failed: ${result.error.message}`);
    return { ok: false, error: result.error };
  }

  const { exitCode, output } = result.value;
  const cleanOutput = stripEscapeCodes(output).trim();

  if (exitCode !== 0 || !cleanOutput) {
    logger?.warn(
      `Summarisation failed (exit code ${exitCode}), using original content`,
    );
    return {
      ok: false,
      error: new Error(`Summarisation failed with exit code ${exitCode}`),
    };
  }

  const newTokens = getTokenEstimate(cleanOutput);
  logger?.info(
    `Summarisation reduced content from ~${tokenEstimate} to ~${newTokens} tokens`,
  );

  return {
    ok: true,
    value:
      `**Note: This content has been automatically summarised to reduce token usage.**\n\n${cleanOutput}`,
  };
}

// ---------------------------------------------------------------------------
// Dependency checking
// ---------------------------------------------------------------------------

/**
 * Required CLI tools for the worker.
 *
 * The agent binary comes from the provider seam (Issue #4067), so selecting a
 * different provider checks for that provider's binary instead.
 */
function requiredTools(): string[] {
  return ["gh", "git", activeAgentProvider().binary, "jq"];
}

/**
 * Check whether a CLI tool is available.
 *
 * @param tool - The tool name to check
 * @returns true if the tool is found in PATH
 */
async function isCommandAvailable(tool: string): Promise<boolean> {
  try {
    const command = new Deno.Command("which", {
      args: [tool],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    return output.success;
  } catch {
    return false;
  }
}

/**
 * Validate that required CLI tools are installed.
 *
 * Checks for: gh, git, the active provider's binary, jq, and
 * timeout/gtimeout.
 *
 * @returns Result with the timeout command name on success, or error describing
 *          missing dependencies
 */
export async function checkDependencies(): Promise<Result<string>> {
  const missing: string[] = [];

  for (const tool of requiredTools()) {
    if (!(await isCommandAvailable(tool))) {
      missing.push(tool);
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      error: new Error(`Missing required tools: ${missing.join(", ")}`),
    };
  }

  // Check for timeout command (gtimeout on macOS)
  if (await isCommandAvailable("timeout")) {
    return { ok: true, value: "timeout" };
  }
  if (await isCommandAvailable("gtimeout")) {
    return { ok: true, value: "gtimeout" };
  }

  return {
    ok: false,
    error: new Error(
      "timeout command is not installed. Install with: brew install coreutils",
    ),
  };
}

// ---------------------------------------------------------------------------
// GitHub user
// ---------------------------------------------------------------------------

/**
 * Get the authenticated GitHub username.
 *
 * @returns Result with the GitHub login
 */
export async function getGithubUser(): Promise<Result<string>> {
  try {
    const output = await spawnGh(["api", "user", "--jq", ".login"]);
    if (!output.success) {
      return {
        ok: false,
        error: new Error(
          `Failed to get GitHub user: ${output.stderr.trim()}`,
        ),
      };
    }
    return { ok: true, value: output.stdout.trim() };
  } catch (error: unknown) {
    return {
      ok: false,
      error: new Error(
        `Failed to get GitHub user: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }
}
