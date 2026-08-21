/**
 * Low-level Claude CLI subprocess execution (Issue #913).
 *
 * Provides the foundational layer for running the Claude CLI as a subprocess
 * with timeout protection via AbortController. Handles stream-json output
 * extraction, escape code stripping, and orphan process cleanup.
 *
 * Higher-level concerns (retry, heartbeat, health checks) live in
 * claude_runner.ts which builds on this module.
 *
 * Migrated from worker/shared/claude_runner.sh (low-level functions).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  DEFAULT_EFFORT,
  PHASE_EFFORT_DEFAULTS,
  PHASE_MODEL_DEFAULTS,
} from "./config_defaults.ts";
import { incrementCounter } from "./fault_tolerance_counters.ts";
import type { RepoConfig } from "../types.ts";
import type { RunStats } from "./run_stats.ts";
import type { ExtensionTelemetry } from "./timeout_extension_telemetry.ts";

/** Exit code returned when a process times out. */
export const TIMEOUT_EXIT_CODE = 124;

/**
 * Exit code the run loop returns for a terminal out-of-memory failure
 * (Issue #2741, parent #2721).
 *
 * `137` is `128 + 9` (SIGKILL — the Linux OOM-killer's signal), so it is the
 * natural code for a heap-exhaustion kill. It is deliberately distinct from
 * {@link TIMEOUT_EXIT_CODE} (124) and the rate-limit give-up code (2) so the
 * caller can tell OOM apart from a timeout or a rate limit: an OOM is
 * terminal — waiting and retrying cannot fix it.
 */
export const OOM_EXIT_CODE = 137;

/** Default characters per token for estimation heuristic. */
const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Reason a Claude execution timed out.
 *
 * - `"hard-timeout"` — the wall-clock `timeoutSeconds` watchdog fired.
 * - `"no-output"` — the silence watchdog fired because stdout was idle for
 *   `noOutputTimeout` seconds (Issue #1825).
 */
export type ClaudeTimeoutReason = "hard-timeout" | "no-output";

/** Result of a Claude CLI execution. */
export interface ClaudeExecutionResult {
  /** Exit code from the process (124 = timeout, 137 = SIGKILL). */
  exitCode: number;
  /**
   * The child's true exit status, before any classification (Issue #4202).
   * When a watchdog fires, `exitCode` is remapped to 124 but this field
   * keeps what the process really exited with (typically the signal death
   * from the watchdog's own kill), so diagnostics never destroy evidence.
   */
  rawExitCode?: number;
  /** The extracted text output from Claude. */
  output: string;
  /**
   * Captured stderr text (decoded, trimmed) from the Claude CLI subprocess
   * (Issue #1980). Surfaced so callers can diagnose failures with the real
   * error rather than relying on the historical catch-all
   * "rate-limited or unresponsive" message.
   */
  stderr: string;
  /** Whether the process timed out. */
  /**
   * Killed from outside by SIGTERM with no watchdog asking (Issue #4369) —
   * run end or handler abandonment. Terminal; never a rate limit.
   */
  terminated?: boolean;
  /**
   * A SIGTERM the worker never requested (Issue #46): `isAgentRunsTerminating()`
   * was false, so it came from outside — a tool the agent ran, the CLI, the
   * container, a stray signal. Unlike {@link terminated} (our own shutdown),
   * this is an external kill — a retryable failure carrying kill diagnostics.
   */
  externalSigterm?: boolean;
  timedOut: boolean;
  /**
   * Which timeout fired, when `timedOut` is true (Issue #1825). Distinguishes
   * the hard wall-clock timeout from the no-output silence watchdog so
   * diagnostics can record the correct reason.
   */
  timeoutReason?: ClaudeTimeoutReason;
  /**
   * Seconds the hard watchdog fired past its configured budget
   * (Issue #4254) — a starved VM delays Deno timers, and host-25 saw the
   * 3600 s watchdog fire 487 s and 3470 s late. Present only when late.
   */
  watchdogLateSeconds?: number;
  /**
   * Set when the post-kill wait expired before the child settled
   * (Issue #4254): the runner abandoned `child.status` and the stream
   * pumps after this many seconds rather than blocking for hours. When
   * set, `exitCode`/`rawExitCode` are synthesised — the child never
   * reported a status.
   */
  killIncompleteSeconds?: number;
  /**
   * Bounded kill-time evidence (Issue #4382): the top processes by RSS at
   * the moment an external kill was observed (the agent's own tree marked)
   * and any readable kernel OOM lines. Present only after such a kill.
   */
  killDiagnostics?: string;
  /**
   * Per-run generation stats (Issue #2647): served model IDs declared by the
   * API, requested model/effort, token usage, turn count, and durations.
   * Optional — present on every completed run, omitted only on spawn failure.
   */
  runStats?: RunStats;
  /**
   * Id of the coding-agent provider that produced this result (Issue #4109).
   *
   * Set on every completed run, so a Quorum run can attribute two drafts and a
   * verdict without inferring the agent from the output. Optional only because
   * a spawn failure never reaches the provider.
   */
  provider?: string;
  /**
   * Cheaper model the run fell back to after rate-limit exhaustion (#1113).
   * Populated only by the retry wrapper (`runClaudeWithRetry`); the low-level
   * executor never sets it. Surfaced here so seams that adapt a
   * {@link RunClaudeResult} into a {@link ClaudeExecutionResult} (e.g. the
   * clarification path, Issue #3232) can carry the degraded-model signal.
   */
  fallbackModel?: string;
  /**
   * Explicit pre-flight Fable-reroute degraded flag (Issue #3231/#3232).
   * Populated only by the retry wrapper; carried here for the same seam-adapt
   * reason as {@link fallbackModel}.
   */
  preflightDegraded?: boolean;
  /** Human-readable reason accompanying {@link preflightDegraded}. */
  preflightDegradedReason?: string;
  /**
   * What the re-armable hard deadline did to this run (Issue #4298, part of
   * #4290): extensions granted, seconds added, the final deadline, the true
   * elapsed time and why the last extension was refused.
   *
   * Present only when the progress-extension feature was active for the run
   * ({@link RunClaudeOptions.progressExtension} supplied and enabled), so
   * every other caller's result shape is unchanged.
   */
  extensions?: ExtensionTelemetry;
}

// ---------------------------------------------------------------------------
// Escape code stripping
// ---------------------------------------------------------------------------

// deno-lint-ignore no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*[\x07]|\x1b\][^\x07\x1b]*\x1b\\/g;

// deno-lint-ignore no-control-regex
const CSI_RE = /\x1b\[[\?0-9;]*[A-Za-z]/g;

/**
 * Remove terminal escape sequences from text.
 *
 * Filters out OSC (Operating System Command) sequences and CSI (Control
 * Sequence Introducer) sequences that terminals emit. This ensures logs
 * contain only human-readable text.
 *
 * @param text - Text potentially containing escape codes
 * @returns Clean text with escape codes removed
 */
export function stripEscapeCodes(text: string): string {
  return text.replace(OSC_RE, "").replace(CSI_RE, "");
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the number of tokens in text.
 *
 * Uses a simple heuristic: approximately 4 characters per token.
 * This is a rough estimate but sufficient for detecting large content.
 *
 * @param text - The text to estimate
 * @param charsPerToken - Characters per token (default: 4)
 * @returns Estimated token count
 */
export function getTokenEstimate(
  text: string,
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): number {
  return Math.floor(text.length / charsPerToken);
}

// ---------------------------------------------------------------------------
// Stream-JSON extraction
// ---------------------------------------------------------------------------

/**
 * Extract plain text from Claude's stream-json (NDJSON) output.
 *
 * Extraction order:
 *   1. Look for a "result" type line and extract the .result field
 *   2. Fall back to concatenating assistant text content blocks
 *   3. Last resort: return raw content
 *
 * @param rawContent - The raw stream-json content
 * @returns Extracted plain text
 */
export function extractStreamJsonText(rawContent: string): string {
  if (!rawContent.trim()) return "";

  const lines = rawContent.split("\n").filter((l) => l.trim());

  // Strategy 1: Extract from the "result" line (present on successful completion)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.includes('"type"') && line.includes('"result"')) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.result) {
          return String(parsed.result);
        }
      } catch (err) {
        console.warn(
          `[claude-executor] Failed to parse stream-json result line: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // Strategy 2: Concatenate assistant text blocks (for partial output on timeout)
  const textBlocks: string[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "assistant" && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === "text" && block.text) {
            textBlocks.push(String(block.text));
          }
        }
      }
    } catch {
      // Expected for non-JSON lines in stream output
    }
  }
  if (textBlocks.length > 0) {
    return textBlocks.join("");
  }

  // Strategy 3: Fall back to raw content
  return rawContent;
}

// ---------------------------------------------------------------------------
// Error pattern extraction
// ---------------------------------------------------------------------------

/** Common error patterns across languages and tools. */
const ERROR_PATTERN_RE =
  /(^\s+at .+\(|Traceback \(most recent|^[A-Za-z]*Error:|^[A-Za-z]*Exception:|FATAL:|PANIC:|[Ss]egmentation fault|[Ss]tack overflow|[Oo]ut of memory|[Pp]ermission denied|command not found|No such file or directory)/;

/**
 * Extract recognisable error patterns from output text.
 *
 * Scans for common error indicators: stack traces, error messages,
 * panic/fatal keywords, and common failure patterns.
 *
 * @param output - The output text to scan
 * @returns Matching error lines (empty array if no patterns found)
 */
export function extractErrorPatterns(output: string): string[] {
  if (!output.trim()) return [];

  return output
    .split("\n")
    .filter((line) => ERROR_PATTERN_RE.test(line));
}

/** Failure explanation patterns from Claude's output. */
const FAILURE_PATTERN_RE =
  /(could not find|cannot find|does not exist|doesn't exist|was unable to|unable to locate|not been merged|not merged into|cannot access|could not access|is missing from|is missing|not available in|not found in the|not found in this)/i;

/**
 * Extract actionable failure reasons from Claude's output.
 *
 * Scans for patterns that explain WHY Claude could not complete the task.
 *
 * @param output - The output text to scan
 * @param maxLines - Maximum number of failure lines to return (default: 10)
 * @returns Matching failure lines
 */
export function extractFailureSummary(
  output: string,
  maxLines: number = 10,
): string[] {
  if (!output.trim()) return [];

  return output
    .split("\n")
    .filter((line) => FAILURE_PATTERN_RE.test(line))
    .slice(0, maxLines);
}

// ---------------------------------------------------------------------------
// Already-complete detection (Issue #519)
// ---------------------------------------------------------------------------

/** Patterns indicating issue is already complete/implemented/resolved. */
const ALREADY_COMPLETE_RE =
  /(already (been )?(complete|implemented|merged|fixed|resolved|done|exists)|implementation is complete|nothing (left )?to (implement|do|change|fix)|no changes (are )?(needed|required|necessary))/i;

/**
 * Check if output indicates the issue is already complete.
 *
 * Used by the worker to auto-close issues instead of treating them as
 * failures — these machines are unattended (Issue #519).
 *
 * @param output - The output text to scan
 * @returns true if the output indicates the issue is already complete
 */
export function detectAlreadyComplete(output: string): boolean {
  if (!output.trim()) return false;
  return ALREADY_COMPLETE_RE.test(output);
}

// ---------------------------------------------------------------------------
// GitHub API success detection (Issue #534)
// ---------------------------------------------------------------------------

/** Patterns indicating successful GitHub API operations. */
const GITHUB_API_SUCCESS_RE =
  /(gh (issue|pr) (edit|close|comment|create)|(edited|updated|closed) issue|(added|removed) label|successfully (edited|updated|closed)|issue (description|body) updated|updated (the )?issue (description|body))/i;

/**
 * Check if output indicates Claude performed GitHub API operations
 * successfully.
 *
 * When an issue requires only GitHub API work, there will be no git diff
 * but the task was still successful.
 *
 * @param output - The output text to scan
 * @returns true if GitHub API operations were detected
 */
export function detectGithubApiSuccess(output: string): boolean {
  if (!output.trim()) return false;
  return GITHUB_API_SUCCESS_RE.test(output);
}

// ---------------------------------------------------------------------------
// Rate-limit detection
// ---------------------------------------------------------------------------

/**
 * Patterns indicating rate limiting or credit exhaustion — the SHORT-BACKOFF
 * class. `overloaded`/529 (Anthropic transient overload) added by Issue
 * #4315: it is exactly the retry-with-jitter case this class handles.
 */
const RATE_LIMIT_RE =
  /(rate limit|credit|quota|exceeded|too many requests|429|overloaded|\b529\b)/i;

/** Secondary patterns suggesting rate limiting. */
const RATE_LIMIT_SECONDARY_RE = /(try again|retry|limit)/i;

/**
 * Check if the tail of output indicates rate limiting.
 *
 * Only checks the last N lines to avoid false positives from Claude
 * discussing rate limits in its output.
 *
 * @param output - The output text to scan
 * @param tailLines - Number of lines from the end to check (default: 30)
 * @returns Object with isRateLimited flag and whether it's a primary match
 */
export function detectRateLimit(
  output: string,
  tailLines: number = 30,
): { isRateLimited: boolean; isPrimary: boolean } {
  if (!output.trim()) return { isRateLimited: false, isPrimary: false };

  const lines = output.split("\n");
  const tail = lines.slice(-tailLines).join("\n");

  if (RATE_LIMIT_RE.test(tail)) {
    return { isRateLimited: true, isPrimary: true };
  }
  if (RATE_LIMIT_SECONDARY_RE.test(tail)) {
    return { isRateLimited: true, isPrimary: false };
  }

  return { isRateLimited: false, isPrimary: false };
}

// ---------------------------------------------------------------------------
// Usage-limit detection — the subscription window (Issue #4315)
// ---------------------------------------------------------------------------

/**
 * Patterns for the Max-subscription usage window (5-hour / weekly caps).
 *
 * Deliberately NARROW and separate from {@link RATE_LIMIT_RE}: a usage limit
 * is account-wide and time-boxed, so the right response is to stop spending
 * until the window resets — no model fallback (every model bills the same
 * window), no issue blame. Widening the rate-limit regex instead would drag
 * these into the short-backoff + fallback ladder, burning the exhausted
 * window further. Vocabulary ported from the operator-side check in
 * setup.sh, which had known these strings all along.
 */
const USAGE_LIMIT_RE =
  /(claude (ai )?usage limit reached|(you'?ve|you have) (hit|reached) your (usage )?limit|\b(5|five)[- ]hour (usage )?(limit|window)\b|\bweekly (usage )?limit\b|out of extra usage)/i;

/**
 * Check whether the tail of `output` reports a subscription usage limit.
 * Tail-only for the same reason as {@link detectRateLimit}: the agent may
 * *discuss* limits mid-transcript.
 */
export function detectUsageLimit(
  output: string,
  tailLines: number = 30,
): boolean {
  if (!output.trim()) return false;
  const tail = output.split("\n").slice(-tailLines).join("\n");
  return USAGE_LIMIT_RE.test(tail);
}

/**
 * In-progress / not-finished phrasing an agent emits when its turn ends before
 * it could deliver — blocked on a slow quality gate, out of turn budget, or
 * otherwise cut off mid-task (Issue #108). This is the tell that separates a
 * *truncated* no-changes run from a genuinely analysis-only one: the agent
 * announced it intended to keep going, it did not conclude.
 *
 * Deliberately narrow — each alternative is a forward-looking "I will continue"
 * statement or an explicit "still running / not finished", not something a
 * finished analysis would say. A genuine recommendation ("the fix is …", "no
 * change is needed because …") matches none of these, so the analysis-only
 * hand-off those runs belong in is preserved.
 */
const RUN_INTERRUPTED_RE =
  /\b(?:i'?ll|i will|let me|going to|about to)\s+(?:pick(?:ing)?\s+(?:this\s+)?up|continue|resume|carry on|finish|proceed|retry|re-?run|come back)\b|\b(?:still|currently)\s+(?:running|in progress|building|cloning|compiling|installing|waiting)\b|\bas soon as (?:it|the|this)\b[^\n]*\b(?:finish|finishes|complete|completes|done)\b|\bran out of time\b|\bnot (?:yet )?(?:finished|complete|done)\b|\bhaven'?t (?:finished|completed|started)\b|\bquality (?:gate|check)s? (?:is|are) still\b/i;

/**
 * Check whether the tail of `output` shows the run was cut off before it could
 * finish (Issue #108). Tail-only, mirroring {@link detectUsageLimit}: an agent
 * may *describe* being interrupted earlier in a transcript it then recovered
 * from — only the final lines report how the run actually ended.
 */
export function detectRunInterrupted(
  output: string,
  tailLines: number = 15,
): boolean {
  if (!output.trim()) return false;
  const tail = output.split("\n").slice(-tailLines).join("\n");
  return RUN_INTERRUPTED_RE.test(tail);
}

/**
 * Parse the reset time from a usage-limit message into epoch milliseconds,
 * or null when nothing parseable is present.
 *
 * Handles: the CLI's machine-readable `|<epoch-seconds>` suffix; `resets
 * 3am` / `resets at 3 pm`; `reset at 14:30`. Clock forms resolve to the
 * NEXT future occurrence in `timeZone` (default: the process zone) — a
 * time already past today means tomorrow.
 */
export function parseUsageLimitReset(
  text: string,
  nowMs: number = Date.now(),
  timeZone?: string,
): number | null {
  const epoch = /\|(\d{9,11})\b/.exec(text);
  if (epoch) return Number(epoch[1]) * 1000;

  const clock = /reset[s]?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
    .exec(text);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = clock[2] ? Number(clock[2]) : 0;
  const meridiem = clock[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (!meridiem && !clock[2] && hour > 24) return null;
  if (hour > 23 || minute > 59) return null;

  // Build "today at HH:MM" in the target zone, then roll forward if past.
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const y = get("year"), mo = get("month"), d = get("day");
  const localNowMs = Date.UTC(
    y,
    mo - 1,
    d,
    get("hour"),
    get("minute"),
    get("second"),
  );
  // Offset between the zone's wall clock and UTC at this instant.
  const offsetMs = localNowMs - Math.floor(nowMs / 1000) * 1000;
  let candidate = Date.UTC(y, mo - 1, d, hour, minute, 0) - offsetMs;
  if (candidate <= nowMs) candidate += 24 * 60 * 60 * 1000;
  return candidate;
}

// ---------------------------------------------------------------------------
// Model-unavailable detection (Issue #2724)
// ---------------------------------------------------------------------------

/**
 * Patterns indicating the requested model is unavailable or not permitted —
 * suspended, revoked, removed, unrecognised, or access-denied — as distinct
 * from a transient rate limit.
 *
 * The motivating incident (Issue #2724) was the export-control suspension of
 * Fable 5 / Mythos 5: every `claude --model fable` invocation began failing
 * with an availability/permission error rather than a rate limit, so the
 * rate-limit-only fallback never fired and the top tier could not degrade to
 * the next-best model. Retrying the same model is futile here — the only
 * recovery is a fallback — so this is detected separately and triggers an
 * immediate, wait-free downgrade.
 *
 * Kept deliberately narrow to model/access/authorisation phrasing (plus the
 * HTTP `403`/`forbidden` signals) so unrelated failures — git/ssh
 * "permission denied", filesystem errors — are not misclassified. The cost of
 * a rare false positive is bounded anyway: one wasted retry on a cheaper model
 * before the run returns its failure.
 *
 * Issue #2735 (parent #2720, the Fable export-control suspension) added
 * `restricted`/`export control` to the model-alias branch so export-control
 * wording that names the tier without an `access`/`use` prefix — e.g. "Fable
 * is restricted in your region due to export controls" — still matches and
 * drives the immediate `fable → opus` downgrade.
 */
const MODEL_UNAVAILABLE_RE =
  /(?:unknown|invalid|unsupported|unrecogni[sz]ed) model|model[^\n]{0,40}(?:not available|unavailable|not found|no longer available|not supported|is disabled|been disabled)|(?:access|use)[^\n]{0,40}(?:suspended|revoked|disabled|not permitted|restricted)|(?:fable|opus|sonnet|haiku)[^\n]{0,40}(?:suspended|revoked|disabled|not available|unavailable|not permitted|restricted|export control)|not authori[sz]ed to (?:use|access)|do(?:es)? not have access|\bforbidden\b|\b403\b/i;

/**
 * Check if the tail of output indicates the requested model is unavailable or
 * not permitted (as opposed to rate-limited).
 *
 * Only checks the last N lines — like {@link detectRateLimit} — so that Claude
 * merely discussing model availability earlier in an otherwise-successful run
 * does not trigger a false positive (this is only consulted on a non-zero
 * exit, where the tail is the CLI's own error).
 *
 * @param output - The output text to scan
 * @param tailLines - Number of lines from the end to check (default: 30)
 * @returns true if the failure looks like a model-unavailable / not-permitted error
 */
export function detectModelUnavailable(
  output: string,
  tailLines: number = 30,
): boolean {
  if (!output.trim()) return false;

  const lines = output.split("\n");
  const tail = lines.slice(-tailLines).join("\n");

  return MODEL_UNAVAILABLE_RE.test(tail);
}

// ---------------------------------------------------------------------------
// Invalid-session-id detection (Issue #204)
// ---------------------------------------------------------------------------

/**
 * The Claude CLI's refusal of a `--session-id` it will not accept.
 *
 * The CLI validates the flag as a UUID and, when it fails, exits ~0.2 s after
 * spawn with `Error: Invalid session ID. Must be a valid UUID.` — before it
 * ever reaches a model call. Anchored to session-id phrasing so an unrelated
 * "invalid" (a bad model alias, a git reference) cannot match: the remedy here
 * is to drop the session flags, which would silently discard continuity if it
 * fired on the wrong failure.
 */
const INVALID_SESSION_ID_RE =
  /invalid session id|session id[^\n]{0,40}must be[^\n]{0,20}uuid/i;

/**
 * Check if the tail of output indicates the CLI rejected the session id.
 *
 * Tail-scoped like {@link detectModelUnavailable} — only consulted on a
 * non-zero exit, where the tail is the CLI's own error.
 *
 * @param output - The output text to scan (stdout and stderr)
 * @param tailLines - Number of lines from the end to check (default: 30)
 * @returns true if the failure is a rejected `--session-id`
 */
export function detectInvalidSessionId(
  output: string,
  tailLines: number = 30,
): boolean {
  if (!output.trim()) return false;

  const lines = output.split("\n");
  const tail = lines.slice(-tailLines).join("\n");

  return INVALID_SESSION_ID_RE.test(tail);
}

// ---------------------------------------------------------------------------
// Out-of-memory detection (Issue #2740, parent #2721)
// ---------------------------------------------------------------------------

/**
 * Patterns indicating a Node/V8 heap-exhaustion (out-of-memory) failure.
 *
 * The Claude CLI runs on Node, so a V8 heap OOM prints lines such as
 * "...near heap limit ... JavaScript heap out of memory". The word "limit" in
 * "heap limit" matches the secondary rate-limit regex in {@link detectRateLimit}
 * (`/(try again|retry|limit)/i`), so an OOM is currently mistaken for a rate
 * limit and the run waits-and-retries instead of failing fast. OOM must
 * therefore be classified separately from rate limits and timeouts.
 *
 * Kept deliberately narrow and anchored to memory phrasing — following the
 * precedent of the narrow {@link MODEL_UNAVAILABLE_RE} — so unrelated output
 * (a task that merely mentions "memory") is not misclassified. The generic
 * "out of memory" branch is word-bounded for the same reason.
 */
const OUT_OF_MEMORY_RE =
  /javascript heap out of memory|reached heap limit allocation failed|ineffective mark-compacts near heap limit|fatal error:[^\n]*heap|cannot allocate memory|std::bad_alloc|\bout of memory\b/i;

/**
 * Check if the tail of output indicates an out-of-memory (heap-exhaustion)
 * failure.
 *
 * Only checks the last N lines — like {@link detectRateLimit} and
 * {@link detectModelUnavailable} — so that an in-run discussion of "memory"
 * earlier in an otherwise-successful run cannot trigger a false positive.
 *
 * @param output - The output text to scan
 * @param tailLines - Number of lines from the end to check (default: 30)
 * @returns true if the failure looks like an out-of-memory error
 */
export function detectOutOfMemory(
  output: string,
  tailLines: number = 30,
): boolean {
  if (!output.trim()) return false;

  const lines = output.split("\n");
  const tail = lines.slice(-tailLines).join("\n");

  return OUT_OF_MEMORY_RE.test(tail);
}

// ---------------------------------------------------------------------------
// Claude model args
// ---------------------------------------------------------------------------

/**
 * Module-level config-based phase model overrides (Issue #1265).
 *
 * Set via setPhaseModelConfigOverrides() during config loading.
 * These take precedence over PHASE_MODEL_DEFAULTS but are overridden
 * by environment variables.
 */
let _phaseModelConfigOverrides: Readonly<Record<string, string>> = {};

/**
 * Set config-based phase model overrides (Issue #1265).
 *
 * Called during config loading to apply phase_model_overrides from
 * .config.json. These override the hardcoded PHASE_MODEL_DEFAULTS
 * but are themselves overridden by environment variables.
 *
 * @param overrides - Phase-to-model mapping from config file
 */
export function setPhaseModelConfigOverrides(
  overrides: Record<string, string>,
): void {
  _phaseModelConfigOverrides = { ...overrides };
}

/**
 * Active per-repo model/effort routing overrides (Issue #2625).
 *
 * Set via setActiveRepoModelEffortOverrides() when the worker begins
 * processing a repo and replaced (or cleared) on every repo switch, so a
 * high-value repo's premium routing never leaks into a filler repo.
 *
 * These sit between the operator escape-hatch env vars (highest) and the
 * global config / built-in defaults (lowest) — see buildClaudeModelArgs and
 * buildClaudeEffortArgs for the full precedence chain.
 */
let _repoClaudeModel = "";
let _repoPhaseModelOverrides: Readonly<Record<string, string>> = {};
let _repoPhaseEffortOverrides: Readonly<Record<string, string>> = {};

/**
 * Describe which built-in per-phase model defaults a per-repo `claude_model`
 * base tier overrides (Issue #2716, audit #2702 F2/F3).
 *
 * The base tier sits above `PHASE_MODEL_DEFAULTS` in the precedence chain, so
 * setting it silently reroutes every phase that has its own default — demoting
 * `planning`/`grill_me` off the Fable top tier when the base is cheaper, and
 * promoting the trivial Haiku phases (`spelling_fix`/`summarise`/`health`) off
 * Haiku when the base is `fable` (~5× their intended cost). This builds a
 * one-line, human-readable summary of those reroutes so the surprise is visible
 * in the logs rather than only in the cost report after the fact.
 *
 * Comparison is case-insensitive; a phase whose default already equals the base
 * tier is not a reroute and is omitted. Returns `null` when the base tier is
 * empty or reroutes nothing, so the caller can stay silent in the common case.
 *
 * @param claudeModel - The active per-repo base tier (alias or full model id).
 * @returns A summary message, or `null` when there is nothing to report.
 */
export function describeRepoBaseTierOverride(
  claudeModel: string,
): string | null {
  const base = claudeModel.trim();
  if (!base) return null;

  const baseLower = base.toLowerCase();
  const reroutes: string[] = [];
  for (const [phase, phaseDefault] of Object.entries(PHASE_MODEL_DEFAULTS)) {
    if (phaseDefault.toLowerCase() !== baseLower) {
      reroutes.push(`${phase} (${phaseDefault}→${base})`);
    }
  }
  if (reroutes.length === 0) return null;

  return `[claude-executor] Per-repo claude_model base tier "${base}" ` +
    `overrides the built-in per-phase model default for ${reroutes.length} ` +
    `phase(s): ${reroutes.join(", ")}. Re-pin a phase with a per-repo ` +
    `phase_model_override to keep it on its own tier (Issue #2716).`;
}

/**
 * Set the active repo's model/effort routing overrides (Issue #2625).
 *
 * Call this once when the worker starts work on a repo, passing the repo's
 * merged RepoConfig (or `undefined` to clear). It replaces — never merges —
 * the previously-active repo overrides, guaranteeing routing never leaks
 * across repos when one long-running worker process serves several repos.
 *
 * When the new config carries a non-empty `claude_model` base tier that
 * reroutes one or more phases off their `PHASE_MODEL_DEFAULTS` entry, a single
 * informational line is logged (Issue #2716) so the silent demotion/promotion
 * is visible. It is logged once per repo switch, not per phase.
 *
 * @param repoConfig - The active repo's RepoConfig, or undefined to clear.
 */
export function setActiveRepoModelEffortOverrides(
  repoConfig: RepoConfig | undefined,
): void {
  _repoClaudeModel = repoConfig?.claudeModel ?? "";
  _repoPhaseModelOverrides = { ...(repoConfig?.phaseModelOverrides ?? {}) };
  _repoPhaseEffortOverrides = { ...(repoConfig?.phaseEffortOverrides ?? {}) };

  const baseTierNote = describeRepoBaseTierOverride(_repoClaudeModel);
  if (baseTierNote) {
    console.info(baseTierNote);
  }
}

/** Known model-tier aliases the Claude CLI accepts (Issue #2711). */
const KNOWN_MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

/**
 * A value is a recognisable model if it is a known tier alias or a plausible
 * full model id (`claude-*`). Anything else is most likely a typo
 * (`fabel`, `opue`) — the CLI would reject it at runtime (Issue #2711).
 */
function isRecognisedModel(value: string): boolean {
  const lower = value.toLowerCase();
  return (KNOWN_MODEL_ALIASES as readonly string[]).includes(lower) ||
    lower.startsWith("claude-");
}

/**
 * Build the `["--model", value]` arg pair for a resolved model value, warning
 * once when the value is neither a known alias nor a `claude-*` id (Issue
 * #2711, audit #2702 F3). The value is still forwarded verbatim — full model
 * ids must keep working and the CLI is the authority — but a typo at any
 * precedence level is now visible in the logs rather than silently producing
 * a wrong `--model`.
 *
 * @param level - Human-readable precedence level (named for the log message).
 * @param value - The resolved model value to forward to `--model`.
 */
function modelArg(level: string, value: string): string[] {
  if (!isRecognisedModel(value)) {
    console.warn(
      `[claude-executor] Model "${value}" resolved from ${level} is not a ` +
        `known alias (${KNOWN_MODEL_ALIASES.join("/")}) or a claude-* model ` +
        `id; forwarding to --model verbatim. Check for a typo.`,
    );
  }
  return ["--model", value];
}

/**
 * Build the model arguments for the Claude CLI.
 *
 * Priority order (most specific wins — Issue #1265, #1270, #2625):
 *   1. Phase-specific env var (e.g. CLAUDE_MODEL_REFINEMENT) — operator escape hatch
 *   2. Per-repo phase_model_overrides (Issue #2625)
 *   3. Per-repo claude_model base tier (Issue #2625) — applies to all phases
 *   4. Global config phase_model_overrides (Issue #1265)
 *   5. Phase-specific default from PHASE_MODEL_DEFAULTS — designed cost optimisation
 *   6. Base CLAUDE_MODEL env var — global fallback for phases without a default
 *
 * When called without a phase, the per-repo base tier and base CLAUDE_MODEL
 * env var are still honoured.
 *
 * A resolved value that is neither a known alias nor a `claude-*` id emits a
 * single warning naming the level and value (Issue #2711) — the value is still
 * forwarded verbatim so full model ids keep working.
 *
 * @param phase - Optional phase name (e.g., "planning")
 * @returns Array of CLI args (e.g., ["--model", "claude-sonnet-4-6"]) or empty
 */
export function buildClaudeModelArgs(phase?: string): string[] {
  if (phase) {
    // 1. Phase-specific env var (explicit operator override for this phase)
    const phaseVar = `CLAUDE_MODEL_${phase.toUpperCase()}`;
    const phaseModel = Deno.env.get(phaseVar) ?? "";
    if (phaseModel) {
      return modelArg(`${phaseVar} env var`, phaseModel);
    }

    // 2. Per-repo phase_model_overrides (Issue #2625)
    if (phase in _repoPhaseModelOverrides && _repoPhaseModelOverrides[phase]) {
      return modelArg(
        `per-repo phase_model_overrides["${phase}"]`,
        _repoPhaseModelOverrides[phase] as string,
      );
    }
  }

  // 3. Per-repo claude_model base tier (Issue #2625) — overrides the global
  //    base for every phase in this repo, including phase-less calls.
  if (_repoClaudeModel) {
    return modelArg("per-repo claude_model base tier", _repoClaudeModel);
  }

  if (phase) {
    // 4. Global config phase_model_overrides (Issue #1265)
    if (
      phase in _phaseModelConfigOverrides && _phaseModelConfigOverrides[phase]
    ) {
      return modelArg(
        `global phase_model_overrides["${phase}"]`,
        _phaseModelConfigOverrides[phase] as string,
      );
    }

    // 5. Phase-specific default from config_defaults (Issue #1071)
    const phaseDefault = PHASE_MODEL_DEFAULTS[phase];
    if (phaseDefault) {
      return modelArg(`PHASE_MODEL_DEFAULTS["${phase}"]`, phaseDefault);
    }
  }

  // 6. Base CLAUDE_MODEL env var (global fallback)
  const model = Deno.env.get("CLAUDE_MODEL") ?? "";
  if (model) {
    return modelArg("CLAUDE_MODEL env var", model);
  }

  // A non-empty phase that reaches here has no resolvable model and will run on
  // the CLI default with no observability (Issue #2712, audit #2702 F4). Warn so
  // a missing PHASE_MODEL_DEFAULTS entry — a typo or a new phase whose author
  // forgot to add a default — is caught rather than shipping silently.
  // Phase-less calls are intentional and stay quiet.
  if (phase) {
    console.warn(
      `[claude-executor] Phase "${phase}" resolved to no --model arg; ` +
        `falling back to the CLI default. Add a PHASE_MODEL_DEFAULTS entry ` +
        `for "${phase}" or set CLAUDE_MODEL to make the model explicit.`,
    );
  }
  return [];
}

// ---------------------------------------------------------------------------
// Claude effort args (Issue #1403)
// ---------------------------------------------------------------------------

/**
 * Module-level config-based phase effort overrides (Issue #1403).
 *
 * Set via setPhaseEffortConfigOverrides() during config loading.
 * These take precedence over PHASE_EFFORT_DEFAULTS but are overridden
 * by environment variables.
 */
let _phaseEffortConfigOverrides: Readonly<Record<string, string>> = {};

/**
 * Set config-based phase effort overrides (Issue #1403).
 *
 * Called during config loading to apply phase_effort_overrides from
 * .config.json. These override the hardcoded PHASE_EFFORT_DEFAULTS
 * but are themselves overridden by environment variables.
 *
 * @param overrides - Phase-to-effort mapping from config file
 */
export function setPhaseEffortConfigOverrides(
  overrides: Record<string, string>,
): void {
  _phaseEffortConfigOverrides = { ...overrides };
}

/**
 * Build the effort arguments for the Claude CLI.
 *
 * Priority order (most specific wins — Issue #1403, #2625):
 *   1. Phase-specific env var (e.g. CLAUDE_EFFORT_PLANNING) — operator escape hatch
 *   2. Per-repo phase_effort_overrides (Issue #2625)
 *   3. Global config phase_effort_overrides (Issue #1403)
 *   4. Phase-specific default from PHASE_EFFORT_DEFAULTS — designed cost optimisation
 *   5. Base CLAUDE_EFFORT env var — global fallback for phases without a default
 *   6. DEFAULT_EFFORT constant — hardcoded fallback
 *
 * Effort has no per-repo base equivalent of `claude_model` — a repo tunes
 * effort per-phase only.
 *
 * When called without a phase, only the base CLAUDE_EFFORT env var and
 * DEFAULT_EFFORT constant are checked.
 *
 * @param phase - Optional phase name (e.g., "planning")
 * @returns Array of CLI args (e.g., ["--effort", "max"]) or empty
 */
export function buildClaudeEffortArgs(phase?: string): string[] {
  if (phase) {
    // 1. Phase-specific env var (explicit operator override for this phase)
    const phaseVar = `CLAUDE_EFFORT_${phase.toUpperCase()}`;
    const phaseEffort = Deno.env.get(phaseVar) ?? "";
    if (phaseEffort) {
      return ["--effort", phaseEffort];
    }

    // 2. Per-repo phase_effort_overrides (Issue #2625)
    if (
      phase in _repoPhaseEffortOverrides && _repoPhaseEffortOverrides[phase]
    ) {
      return ["--effort", _repoPhaseEffortOverrides[phase] as string];
    }

    // 3. Global config phase_effort_overrides (Issue #1403)
    if (
      phase in _phaseEffortConfigOverrides && _phaseEffortConfigOverrides[phase]
    ) {
      return ["--effort", _phaseEffortConfigOverrides[phase] as string];
    }

    // 4. Phase-specific default from config_defaults (Issue #1402)
    const phaseDefault = PHASE_EFFORT_DEFAULTS[phase];
    if (phaseDefault) {
      return ["--effort", phaseDefault];
    }
  }

  // 5. Base CLAUDE_EFFORT env var (global fallback)
  const effort = Deno.env.get("CLAUDE_EFFORT") ?? "";
  if (effort) {
    return ["--effort", effort];
  }

  // 6. DEFAULT_EFFORT constant
  return ["--effort", DEFAULT_EFFORT];
}

// ---------------------------------------------------------------------------
// Explicit-override predicates (Issue #3231)
// ---------------------------------------------------------------------------

/**
 * Whether an **explicit** operator effort override exists for `phase`.
 *
 * "Explicit" means any effort source in {@link buildClaudeEffortArgs} *other
 * than* the designed `PHASE_EFFORT_DEFAULTS` / hardcoded fallback — i.e. a
 * per-phase env var, a per-repo phase override, a global phase override, or the
 * global `CLAUDE_EFFORT` env var. Companion to {@link hasExplicitModelOverride}
 * for the pre-flight Fable reroute (#3231).
 *
 * @param phase - The phase name (undefined checks only the global env source).
 * @returns true when an explicit effort override is present.
 */
export function hasExplicitEffortOverride(phase?: string): boolean {
  if (phase) {
    if (Deno.env.get(`CLAUDE_EFFORT_${phase.toUpperCase()}`)) return true;
    if (_repoPhaseEffortOverrides[phase]) return true;
    if (_phaseEffortConfigOverrides[phase]) return true;
  }
  if (Deno.env.get("CLAUDE_EFFORT")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Timeout diagnostics (Issue #334)
// ---------------------------------------------------------------------------

/** Result of capturing timeout diagnostics. */
export interface TimeoutDiagnostics {
  /** The diagnostic report text. */
  report: string;
  /** Detected error patterns. */
  errorPatterns: string[];
  /** Number of lines captured from the tail. */
  linesCaptured: number;
}

/**
 * Capture diagnostic context from timed-out process output.
 *
 * Preserves the last N lines of output and any detected error patterns
 * into a diagnostic report.
 *
 * @param output - The output from the timed-out process
 * @param operation - Brief description of the operation that timed out
 * @param diagnosticLines - Number of lines to capture (default: 50)
 * @returns Diagnostic information
 */
export function captureTimeoutDiagnostics(
  output: string,
  operation: string = "unknown",
  diagnosticLines: number = 50,
): TimeoutDiagnostics {
  incrementCounter("timeouts");
  const lines = output.split("\n");
  const tailLines = lines.slice(-diagnosticLines);
  const errorPatterns = extractErrorPatterns(output);
  const timestamp = new Date().toISOString();

  const parts = [
    "=== Timeout Diagnostic Context ===",
    `Operation: ${operation}`,
    `Timestamp: ${timestamp}`,
    `Diagnostic lines: ${diagnosticLines}`,
    "",
    `--- Last ${diagnosticLines} lines of output ---`,
    ...tailLines,
    "",
  ];

  if (errorPatterns.length > 0) {
    parts.push("--- Detected error patterns ---");
    parts.push(...errorPatterns);
    parts.push("");
  }

  return {
    report: parts.join("\n"),
    errorPatterns,
    linesCaptured: tailLines.length,
  };
}
