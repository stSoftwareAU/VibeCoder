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
 */ import { DEFAULT_EFFORT, PHASE_EFFORT_DEFAULTS, PHASE_MODEL_DEFAULTS } from "./config_defaults.ts";
import { incrementCounter } from "./fault_tolerance_counters.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { resolvePhaseRoutedValue } from "./phase_routing.ts";
import { BALANCE_EXHAUSTED_RE } from "./agent_output.ts";
/** Exit code returned when a process times out. */ export const TIMEOUT_EXIT_CODE = 124;
/**
 * Exit code the run loop returns for a terminal out-of-memory failure
 * (Issue #2741, parent #2721).
 *
 * `137` is `128 + 9` (SIGKILL — the Linux OOM-killer's signal), so it is the
 * natural code for a heap-exhaustion kill. It is deliberately distinct from
 * {@link TIMEOUT_EXIT_CODE} (124) and the rate-limit give-up code (2) so the
 * caller can tell OOM apart from a timeout or a rate limit: an OOM is
 * terminal — waiting and retrying cannot fix it.
 */ export const OOM_EXIT_CODE = 137;
/** Default characters per token for estimation heuristic. */ const DEFAULT_CHARS_PER_TOKEN = 4;
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
 */ export function stripEscapeCodes(text) {
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
 */ export function getTokenEstimate(text, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
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
 */ export function extractStreamJsonText(rawContent) {
  if (!rawContent.trim()) return "";
  const lines = rawContent.split("\n").filter((l)=>l.trim());
  // Strategy 1: Extract from the "result" line (present on successful completion)
  for(let i = lines.length - 1; i >= 0; i--){
    const line = lines[i];
    if (line.includes('"type"') && line.includes('"result"')) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.result) {
          return String(parsed.result);
        }
      } catch (err) {
        console.warn(`[claude-executor] Failed to parse stream-json result line: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // Strategy 2: Concatenate assistant text blocks (for partial output on timeout)
  const textBlocks = [];
  for (const line of lines){
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "assistant" && parsed.message?.content) {
        for (const block of parsed.message.content){
          if (block.type === "text" && block.text) {
            textBlocks.push(String(block.text));
          }
        }
      }
    } catch  {
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
/** Common error patterns across languages and tools. */ const ERROR_PATTERN_RE = /(^\s+at .+\(|Traceback \(most recent|^[A-Za-z]*Error:|^[A-Za-z]*Exception:|FATAL:|PANIC:|[Ss]egmentation fault|[Ss]tack overflow|[Oo]ut of memory|[Pp]ermission denied|command not found|No such file or directory)/;
/**
 * Extract recognisable error patterns from output text.
 *
 * Scans for common error indicators: stack traces, error messages,
 * panic/fatal keywords, and common failure patterns.
 *
 * @param output - The output text to scan
 * @returns Matching error lines (empty array if no patterns found)
 */ export function extractErrorPatterns(output) {
  if (!output.trim()) return [];
  return output.split("\n").filter((line)=>ERROR_PATTERN_RE.test(line));
}
/** Failure explanation patterns from Claude's output. */ const FAILURE_PATTERN_RE = /(could not find|cannot find|does not exist|doesn't exist|was unable to|unable to locate|not been merged|not merged into|cannot access|could not access|is missing from|is missing|not available in|not found in the|not found in this)/i;
/**
 * Extract actionable failure reasons from Claude's output.
 *
 * Scans for patterns that explain WHY Claude could not complete the task.
 *
 * @param output - The output text to scan
 * @param maxLines - Maximum number of failure lines to return (default: 10)
 * @returns Matching failure lines
 */ export function extractFailureSummary(output, maxLines = 10) {
  if (!output.trim()) return [];
  return output.split("\n").filter((line)=>FAILURE_PATTERN_RE.test(line)).slice(0, maxLines);
}
// ---------------------------------------------------------------------------
// Already-complete detection (Issue #519)
// ---------------------------------------------------------------------------
/** Patterns indicating issue is already complete/implemented/resolved. */ const ALREADY_COMPLETE_RE = /(already (been )?(complete|implemented|merged|fixed|resolved|done|exists)|implementation is complete|nothing (left )?to (implement|do|change|fix)|no changes (are )?(needed|required|necessary))/i;
/**
 * Check if output indicates the issue is already complete.
 *
 * Used by the worker to auto-close issues instead of treating them as
 * failures — these machines are unattended (Issue #519).
 *
 * @param output - The output text to scan
 * @returns true if the output indicates the issue is already complete
 */ export function detectAlreadyComplete(output) {
  if (!output.trim()) return false;
  return ALREADY_COMPLETE_RE.test(output);
}
// ---------------------------------------------------------------------------
// GitHub API success detection (Issue #534)
// ---------------------------------------------------------------------------
/** Patterns indicating successful GitHub API operations. */ const GITHUB_API_SUCCESS_RE = /(gh (issue|pr) (edit|close|comment|create)|(edited|updated|closed) issue|(added|removed) label|successfully (edited|updated|closed)|issue (description|body) updated|updated (the )?issue (description|body))/i;
/**
 * Check if output indicates Claude performed GitHub API operations
 * successfully.
 *
 * When an issue requires only GitHub API work, there will be no git diff
 * but the task was still successful.
 *
 * @param output - The output text to scan
 * @returns true if GitHub API operations were detected
 */ export function detectGithubApiSuccess(output) {
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
 */ const RATE_LIMIT_RE = /(rate limit|credit|quota|exceeded|too many requests|429|overloaded|\b529\b)/i;
/**
 * Check if the tail of output indicates rate limiting.
 *
 * Only checks the last N lines to avoid false positives from Claude
 * discussing rate limits in its output. Callers pass the CLI's error surface,
 * not the agent's transcript: there used to be a secondary
 * `try again|retry|limit` match, and the agent's own words ("add a retry",
 * "--limit 30") walked ordinary exit-1 runs down the model ladder
 * (Issue #4114). It is gone; `isPrimary` is kept for existing callers and is
 * now always equal to `isRateLimited`.
 *
 * @param output - The output text to scan
 * @param tailLines - Number of lines from the end to check (default: 30)
 * @returns Whether it matched, and the last matching line (unredacted)
 */ export function detectRateLimit(output, tailLines = 30) {
  if (!output.trim()) return {
    isRateLimited: false,
    isPrimary: false
  };
  const tail = output.split("\n").slice(-tailLines);
  const matchedLine = tail.findLast((line)=>RATE_LIMIT_RE.test(line));
  return matchedLine === undefined ? {
    isRateLimited: false,
    isPrimary: false
  } : {
    isRateLimited: true,
    isPrimary: true,
    matchedLine
  };
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
 *
 * Issue #1665 added `session limit`: the CLI now refuses with "You've hit
 * your session limit · resets 1:50pm (UTC)". Without it that line fell
 * through to the secondary rate-limit pattern (`/limit/`) and drove the
 * short-backoff ladder against an exhausted subscription window.
 */ const USAGE_LIMIT_RE = /(claude (ai )?usage limit reached|(you'?ve|you have) (hit|reached) your (usage |session )?limit|\b(5|five)[- ]hour (usage )?(limit|window)\b|\bweekly (usage )?limit\b|out of extra usage)/i;
/**
 * Issue #2613: a spent provider balance (HTTP 402) is the same shape of
 * refusal — account-wide, not the task's fault, cured only by time or a
 * top-up — so it takes the same terminal pause rather than the rate-limit
 * ladder (whose `credit` match would otherwise retry it into the ground).
 */ function isUsageLimitText(text) {
  return USAGE_LIMIT_RE.test(text) || BALANCE_EXHAUSTED_RE.test(text);
}
/**
 * Check whether the tail of `output` reports a subscription usage limit.
 * Tail-only for the same reason as {@link detectRateLimit}: the agent may
 * *discuss* limits mid-transcript.
 */ export function detectUsageLimit(output, tailLines = 30) {
  if (!output.trim()) return false;
  const tail = output.split("\n").slice(-tailLines).join("\n");
  return isUsageLimitText(tail);
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
 */ const RUN_INTERRUPTED_RE = /\b(?:i'?ll|i will|let me|going to|about to)\s+(?:pick(?:ing)?\s+(?:this\s+)?up|continue|resume|carry on|finish|proceed|retry|re-?run|come back)\b|\b(?:still|currently)\s+(?:running|in progress|building|cloning|compiling|installing|waiting)\b|\bas soon as (?:it|the|this)\b[^\n]*\b(?:finish|finishes|complete|completes|done)\b|\bran out of time\b|\bnot (?:yet )?(?:finished|complete|done)\b|\bhaven'?t (?:finished|completed|started)\b|\bquality (?:gate|check)s? (?:is|are) still\b/i;
/**
 * Check whether the tail of `output` shows the run was cut off before it could
 * finish (Issue #108). Tail-only, mirroring {@link detectUsageLimit}: an agent
 * may *describe* being interrupted earlier in a transcript it then recovered
 * from — only the final lines report how the run actually ended.
 */ export function detectRunInterrupted(output, tailLines = 15) {
  if (!output.trim()) return false;
  const tail = output.split("\n").slice(-tailLines).join("\n");
  return RUN_INTERRUPTED_RE.test(tail);
}
/** Month names the CLI's reset messages use, full or abbreviated. */ const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
];
/** Zero-based month for a full or abbreviated name, or null if unknown. */ function monthIndex(name) {
  const lowered = name.toLowerCase();
  if (lowered.length < 3) return null;
  const index = MONTH_NAMES.findIndex((month)=>month.startsWith(lowered));
  return index === -1 ? null : index;
}
/**
 * A reset time qualified by a DATE — `resets Aug 25, 1am (UTC)`, `resets on
 * 25 Aug 2026 at 13:30` (Issue #333). The weekly window puts the date between
 * "resets" and the clock, which the clock-only pattern below cannot see.
 */ const DATED_RESET_RE = /reset[s]?(?:\s+(?:at|on))?\s+(?:(?<mon>[A-Za-z]{3,9})\.?\s+(?<day>\d{1,2})|(?<day2>\d{1,2})\s+(?<mon2>[A-Za-z]{3,9})\.?)(?:st|nd|rd|th)?(?:,?\s*(?<year>\d{4}))?[,\s]+(?:at\s+)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)?\b/i;
/** A reset time given as a bare clock — `resets 3am`, `reset at 14:30`. */ const CLOCK_RESET_RE = /reset[s]?(?:\s+at)?\s+(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)?\b/i;
/**
 * An explicit zone qualifier on the reset time — `(UTC)`, `(Australia/Sydney)`.
 * When present it wins over the host zone: the message states the zone its own
 * clock is in, and the host's is irrelevant to it (Issue #333).
 */ const ZONE_QUALIFIER_RE = /\(\s*(UTC|GMT|Z|[A-Za-z_]+\/[A-Za-z_+\-0-9]+)\s*\)/;
/** The qualifier's zone if it names one Intl accepts, else null. */ function explicitZone(text) {
  const match = ZONE_QUALIFIER_RE.exec(text);
  if (!match?.[1]) return null;
  const zone = match[1] === "Z" ? "UTC" : match[1];
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone
    });
    return zone;
  } catch  {
    return null;
  }
}
/** Wall-clock fields of `utcMs` as read in `zone`. */ function zoneWallParts(utcMs, zone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(utcMs));
  const get = (type)=>Number(parts.find((p)=>p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second")
  };
}
/** Offset between `zone`'s wall clock and UTC at the instant `utcMs`. */ function zoneOffsetMs(utcMs, zone) {
  const p = zoneWallParts(utcMs, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}
/**
 * Epoch ms for a wall clock in `zone`. Two passes because the offset itself
 * depends on the instant: the first pass gets close enough to pick the right
 * side of a DST transition, the second settles on it.
 */ function wallClockToEpochMs(year, month, day, hour, minute, zone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstPass = naive - zoneOffsetMs(naive, zone);
  return naive - zoneOffsetMs(firstPass, zone);
}
/** Normalise a matched clock to 24-hour fields, or null if out of range. */ function normaliseClock(hourRaw, minuteRaw, meridiemRaw) {
  let hour = Number(hourRaw);
  const minute = minuteRaw ? Number(minuteRaw) : 0;
  const meridiem = meridiemRaw?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return {
    hour,
    minute
  };
}
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Parse the reset time from a usage-limit message into epoch milliseconds,
 * or null when nothing parseable is present.
 *
 * Handles: the CLI's machine-readable `|<epoch-seconds>` suffix; the weekly
 * window's date-qualified form `resets Aug 25, 1am (UTC)` (Issue #333); and
 * the 5-hour window's bare clock `resets 3am` / `reset at 14:30`.
 *
 * Zone resolution, in order: an explicit qualifier in the message (`(UTC)`),
 * then `timeZone`, then the process zone. Bare-clock forms resolve to the
 * NEXT future occurrence — a time already past today means tomorrow — while
 * a date-qualified form is taken at its word, which is what a weekly reset up
 * to seven days out needs.
 */ export function parseUsageLimitReset(text, nowMs = Date.now(), timeZone) {
  const epoch = /\|(\d{9,11})\b/.exec(text);
  if (epoch?.[1]) return Number(epoch[1]) * 1000;
  const hostZone = ()=>timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Date-qualified first: its date sits exactly where the clock-only pattern
  // expects digits, so trying that one first would only ever miss.
  const dated = DATED_RESET_RE.exec(text);
  const dg = dated?.groups;
  if (dated && dg) {
    const month = monthIndex(dg.mon ?? dg.mon2 ?? "");
    const day = Number(dg.day ?? dg.day2);
    const clock = normaliseClock(dg.hour ?? "", dg.minute, dg.meridiem);
    if (month !== null && clock) {
      const zone = explicitZone(text.slice(dated.index)) ?? hostZone();
      const year = dg.year ? Number(dg.year) : zoneWallParts(nowMs, zone).year;
      // Reject impossible dates (Feb 31) instead of letting them overflow.
      const probe = new Date(Date.UTC(year, month, day));
      if (probe.getUTCMonth() === month && probe.getUTCDate() === day) {
        const at = (y)=>wallClockToEpochMs(y, month + 1, day, clock.hour, clock.minute, zone);
        const candidate = at(year);
        // No year in the message and the date has passed: it means next year.
        return !dg.year && candidate < nowMs - DAY_MS ? at(year + 1) : candidate;
      }
    }
  }
  const bare = CLOCK_RESET_RE.exec(text);
  const bg = bare?.groups;
  if (!bare || !bg) return null;
  const clock = normaliseClock(bg.hour ?? "", bg.minute, bg.meridiem);
  if (!clock) return null;
  // Build "today at HH:MM" in the target zone, then roll forward if past.
  const zone = explicitZone(text.slice(bare.index)) ?? hostZone();
  const today = zoneWallParts(nowMs, zone);
  const candidate = wallClockToEpochMs(today.year, today.month, today.day, clock.hour, clock.minute, zone);
  if (candidate > nowMs) return candidate;
  return wallClockToEpochMs(today.year, today.month, today.day + 1, clock.hour, clock.minute, zone);
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
 */ const MODEL_UNAVAILABLE_RE = /(?:unknown|invalid|unsupported|unrecogni[sz]ed) model|model[^\n]{0,40}(?:not available|unavailable|not found|no longer available|not supported|is disabled|been disabled)|(?:access|use)[^\n]{0,40}(?:suspended|revoked|disabled|not permitted|restricted)|(?:fable|opus|sonnet|haiku)[^\n]{0,40}(?:suspended|revoked|disabled|not available|unavailable|not permitted|restricted|export control)|not authori[sz]ed to (?:use|access)|do(?:es)? not have access|\bforbidden\b|\b403\b/i;
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
 */ export function detectModelUnavailable(output, tailLines = 30) {
  if (!output.trim()) return false;
  const lines = output.split("\n");
  const tail = lines.slice(-tailLines).join("\n");
  return MODEL_UNAVAILABLE_RE.test(tail);
}
// ---------------------------------------------------------------------------
// Invalid-session-id detection (Issue #204)
// ---------------------------------------------------------------------------
/**
 * The Claude CLI's refusal of the session flags it was given.
 *
 * Two shapes, both start-up failures — the process exits ~0.2 s after spawn,
 * before it ever reaches a model call:
 *
 * - `Error: Invalid session ID. Must be a valid UUID.` — the id itself
 *   (Issue #204);
 * - `Error: --session-id can only be used with --continue or --resume if
 *   --fork-session is also specified.` — the flag pairing (Issue #1580,
 *   Claude Code 2.1.261). The worker no longer sends that pairing, but a
 *   refusal of the flags is still the flags' fault, and the remedy is the
 *   same: drop them and retry once, loudly;
 * - `Error: --resume requires a valid session ID or session title when used
 *   with --print.` — what 2.1.261 actually prints for a non-UUID id
 *   (Issue #1695, recorded in
 *   `tests/fixtures/agent_output/claude-2.1.261-invalid-session.stderr`).
 *   None of the arms above matched it, so the recorded refusal was reaching
 *   the ordinary failure path instead of dropping the flags.
 *
 * Anchored to session-id phrasing so an unrelated "invalid" (a bad model
 * alias, a git reference) cannot match: dropping the session flags would
 * silently discard continuity if it fired on the wrong failure.
 */ const INVALID_SESSION_ID_RE = /invalid session id|session id[^\n]{0,40}must be[^\n]{0,20}uuid|--session-id can only be used with|--resume requires a valid session|no conversation found with session id/i;
/**
 * The CLI aborting because its autocompaction cannot keep the context under
 * the window (Issue #4147). On a resumed session that is the inherited
 * transcript's size, not the task's, so a fresh session can still do the
 * work.
 */ const AUTOCOMPACT_THRASH_RE = /autocompact is thrashing/i;
/**
 * Check if the tail of output indicates the CLI rejected the session id.
 *
 * Tail-scoped like {@link detectModelUnavailable} — only consulted on a
 * non-zero exit, where the tail is the CLI's own error.
 *
 * @param output - The output text to scan (stdout and stderr)
 * @param tailLines - Number of lines from the end to check (default: 30)
 * @returns true if the failure is a rejected `--session-id`
 */ export function detectInvalidSessionId(output, tailLines = 30) {
  if (!output.trim()) return false;
  const lines = output.split("\n");
  const tail = lines.slice(-tailLines).join("\n");
  return INVALID_SESSION_ID_RE.test(tail);
}
/**
 * Check if the tail of output shows a resumed session cannot carry the run:
 * the CLI refused or could not find it ({@link detectInvalidSessionId}), or
 * the inherited transcript thrashed autocompaction (Issue #4147). Either way
 * no model did the task's work, and a fresh session can.
 *
 * @param output - The output text to scan (stdout and stderr)
 * @param tailLines - Number of lines from the end to check (default: 30)
 * @returns true if retrying without the session flags is the remedy
 */ export function detectResumedSessionUnusable(output, tailLines = 30) {
  if (detectInvalidSessionId(output, tailLines)) return true;
  const tail = output.split("\n").slice(-tailLines).join("\n");
  return AUTOCOMPACT_THRASH_RE.test(tail);
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
 */ const OUT_OF_MEMORY_RE = /javascript heap out of memory|reached heap limit allocation failed|ineffective mark-compacts near heap limit|fatal error:[^\n]*heap|cannot allocate memory|std::bad_alloc|\bout of memory\b/i;
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
 */ export function detectOutOfMemory(output, tailLines = 30) {
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
 */ let _phaseModelConfigOverrides = {};
/**
 * Set config-based phase model overrides (Issue #1265).
 *
 * Called during config loading to apply phase_model_overrides from
 * .config.json. These override the hardcoded PHASE_MODEL_DEFAULTS
 * but are themselves overridden by environment variables.
 *
 * @param overrides - Phase-to-model mapping from config file
 */ export function setPhaseModelConfigOverrides(overrides) {
  _phaseModelConfigOverrides = {
    ...overrides
  };
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
 */ let _repoClaudeModel = "";
let _repoPhaseModelOverrides = {};
let _repoPhaseEffortOverrides = {};
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
 */ export function describeRepoBaseTierOverride(claudeModel) {
  const base = claudeModel.trim();
  if (!base) return null;
  const baseLower = base.toLowerCase();
  const reroutes = [];
  for (const [phase, phaseDefault] of Object.entries(PHASE_MODEL_DEFAULTS)){
    if (phaseDefault.toLowerCase() !== baseLower) {
      reroutes.push(`${phase} (${phaseDefault}→${base})`);
    }
  }
  if (reroutes.length === 0) return null;
  return `[claude-executor] Per-repo claude_model base tier "${base}" ` + `overrides the built-in per-phase model default for ${reroutes.length} ` + `phase(s): ${reroutes.join(", ")}. Re-pin a phase with a per-repo ` + `phase_model_override to keep it on its own tier (Issue #2716).`;
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
 */ export function setActiveRepoModelEffortOverrides(repoConfig) {
  _repoClaudeModel = repoConfig?.claudeModel ?? "";
  _repoPhaseModelOverrides = {
    ...repoConfig?.phaseModelOverrides ?? {}
  };
  _repoPhaseEffortOverrides = {
    ...repoConfig?.phaseEffortOverrides ?? {}
  };
  const baseTierNote = describeRepoBaseTierOverride(_repoClaudeModel);
  if (baseTierNote) {
    console.info(baseTierNote);
  }
}
/** Known model-tier aliases the Claude CLI accepts (Issue #2711). */ const KNOWN_MODEL_ALIASES = [
  "fable",
  "opus",
  "sonnet",
  "haiku"
];
/**
 * A value is a recognisable model if it is a known tier alias or a plausible
 * full model id (`claude-*`). Anything else is most likely a typo
 * (`fabel`, `opue`) — the CLI would reject it at runtime (Issue #2711).
 */ function isRecognisedModel(value) {
  const lower = value.toLowerCase();
  return KNOWN_MODEL_ALIASES.includes(lower) || lower.startsWith("claude-");
}
/**
 * Return a resolved model value, warning once when it is neither a known alias
 * nor a `claude-*` id (Issue #2711, audit #2702 F3). The value is still
 * forwarded verbatim — full model ids must keep working and the CLI is the
 * authority — but a typo at any precedence level is now visible in the logs
 * rather than silently producing a wrong `--model`.
 *
 * @param level - Human-readable precedence level (named for the log message).
 * @param value - The resolved model value.
 * @returns The value, unchanged.
 */ function checkedModel(level, value) {
  if (!isRecognisedModel(value)) {
    console.warn(`[claude-executor] Model "${value}" resolved from ${level} is not a ` + `known alias (${KNOWN_MODEL_ALIASES.join("/")}) or a claude-* model ` + `id; forwarding to --model verbatim. Check for a typo.`);
  }
  return value;
}
/**
 * Resolve the model Claude runs a phase on — the value behind `--model`.
 *
 * The provider seam in `agent_provider.ts` reaches routing through here
 * (Issue #362), and {@link buildClaudeModelArgs} is a thin argv wrapper over
 * it. The six steps themselves live once in `phase_routing.ts` (Issue #363);
 * this function supplies Claude's names, tables and override state.
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
 * returned verbatim so full model ids keep working.
 *
 * @param phase - Optional phase name (e.g., "planning")
 * @param env - Environment lookup for steps 1 and 6 (Issue #957); defaults to
 *   the process environment.
 * @returns The resolved model value, or undefined when no step supplies one —
 *   the CLI's own default then stands.
 */ export function resolveClaudeModel(phase, env) {
  return resolvePhaseRoutedValue({
    logPrefix: "claude-executor",
    what: "model",
    flag: "--model",
    envVar: "CLAUDE_MODEL",
    env,
    repoPhaseOverrides: _repoPhaseModelOverrides,
    repoPhaseOverridesKey: "phase_model_overrides",
    repoBase: _repoClaudeModel,
    repoBaseKey: "claude_model",
    globalPhaseOverrides: _phaseModelConfigOverrides,
    globalPhaseOverridesKey: "phase_model_overrides",
    phaseDefaults: PHASE_MODEL_DEFAULTS,
    phaseDefaultsName: "PHASE_MODEL_DEFAULTS",
    check: checkedModel
  }, phase);
}
/**
 * Build the model arguments for the Claude CLI.
 *
 * A thin argv wrapper over {@link resolveClaudeModel}, which states the
 * precedence chain.
 *
 * @param phase - Optional phase name (e.g., "planning")
 * @param env - Environment lookup forwarded to the chain (Issue #957).
 * @returns Array of CLI args (e.g., ["--model", "claude-sonnet-4-6"]) or empty
 */ export function buildClaudeModelArgs(phase, env) {
  const model = resolveClaudeModel(phase, env);
  return model ? [
    "--model",
    model
  ] : [];
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
 */ let _phaseEffortConfigOverrides = {};
/**
 * Set config-based phase effort overrides (Issue #1403).
 *
 * Called during config loading to apply phase_effort_overrides from
 * .config.json. These override the hardcoded PHASE_EFFORT_DEFAULTS
 * but are themselves overridden by environment variables.
 *
 * @param overrides - Phase-to-effort mapping from config file
 */ export function setPhaseEffortConfigOverrides(overrides) {
  _phaseEffortConfigOverrides = {
    ...overrides
  };
}
/**
 * Resolve the reasoning effort Claude runs a phase at — the value behind
 * `--effort`.
 *
 * The provider seam in `agent_provider.ts` reaches routing through here
 * (Issue #362), and {@link buildClaudeEffortArgs} is a thin argv wrapper over
 * it. The six steps themselves live once in `phase_routing.ts` (Issue #363);
 * this function supplies Claude's names, tables and override state.
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
 * @param env - Environment lookup for steps 1 and 5 (Issue #957); defaults to
 *   the process environment.
 * @returns The resolved effort value; step 6 guarantees one.
 */ export function resolveClaudeEffort(phase, env) {
  return resolvePhaseRoutedValue({
    logPrefix: "claude-executor",
    what: "effort",
    flag: "--effort",
    envVar: "CLAUDE_EFFORT",
    env,
    repoPhaseOverrides: _repoPhaseEffortOverrides,
    repoPhaseOverridesKey: "phase_effort_overrides",
    // Effort has no per-repo base equivalent of `claude_model`.
    globalPhaseOverrides: _phaseEffortConfigOverrides,
    globalPhaseOverridesKey: "phase_effort_overrides",
    phaseDefaults: PHASE_EFFORT_DEFAULTS,
    phaseDefaultsName: "PHASE_EFFORT_DEFAULTS",
    // Step 6: the hardcoded fallback, so effort always resolves to something.
    fallback: DEFAULT_EFFORT
  }, phase);
}
/**
 * Build the effort arguments for the Claude CLI.
 *
 * A thin argv wrapper over {@link resolveClaudeEffort}, which states the
 * precedence chain.
 *
 * @param phase - Optional phase name (e.g., "planning")
 * @param env - Environment lookup forwarded to the chain (Issue #957).
 * @returns Array of CLI args (e.g., ["--effort", "max"])
 */ export function buildClaudeEffortArgs(phase, env) {
  return [
    "--effort",
    resolveClaudeEffort(phase, env)
  ];
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
 * @param env - Environment lookup for the two env sources (Issue #957);
 *   defaults to the process environment.
 * @returns true when an explicit effort override is present.
 */ export function hasExplicitEffortOverride(phase, env = (name)=>Deno.env.get(name)) {
  if (phase) {
    if (env(`CLAUDE_EFFORT_${phase.toUpperCase()}`)) return true;
    if (_repoPhaseEffortOverrides[phase]) return true;
    if (_phaseEffortConfigOverrides[phase]) return true;
  }
  if (env("CLAUDE_EFFORT")) return true;
  return false;
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
 */ export function captureTimeoutDiagnostics(output, operation = "unknown", diagnosticLines = 50) {
  incrementCounter("timeouts");
  // Redacted whole, then cut (Issue #1257): the report is embedded in the
  // failure comment the worker posts, and the agent's stdout is exactly where
  // a credential it echoed would sit. Cutting first would split it.
  const redactedOutput = redactSecrets(output);
  const lines = redactedOutput.split("\n");
  const tailLines = lines.slice(-diagnosticLines);
  const errorPatterns = extractErrorPatterns(redactedOutput);
  const timestamp = new Date().toISOString();
  const parts = [
    "=== Timeout Diagnostic Context ===",
    `Operation: ${operation}`,
    `Timestamp: ${timestamp}`,
    `Diagnostic lines: ${diagnosticLines}`,
    "",
    `--- Last ${diagnosticLines} lines of output ---`,
    ...tailLines,
    ""
  ];
  if (errorPatterns.length > 0) {
    parts.push("--- Detected error patterns ---");
    parts.push(...errorPatterns);
    parts.push("");
  }
  return {
    report: parts.join("\n"),
    errorPatterns,
    linesCaptured: tailLines.length
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jbGF1ZGVfZXhlY3V0b3IudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBMb3ctbGV2ZWwgQ2xhdWRlIENMSSBzdWJwcm9jZXNzIGV4ZWN1dGlvbiAoSXNzdWUgIzkxMykuXG4gKlxuICogUHJvdmlkZXMgdGhlIGZvdW5kYXRpb25hbCBsYXllciBmb3IgcnVubmluZyB0aGUgQ2xhdWRlIENMSSBhcyBhIHN1YnByb2Nlc3NcbiAqIHdpdGggdGltZW91dCBwcm90ZWN0aW9uIHZpYSBBYm9ydENvbnRyb2xsZXIuIEhhbmRsZXMgc3RyZWFtLWpzb24gb3V0cHV0XG4gKiBleHRyYWN0aW9uLCBlc2NhcGUgY29kZSBzdHJpcHBpbmcsIGFuZCBvcnBoYW4gcHJvY2VzcyBjbGVhbnVwLlxuICpcbiAqIEhpZ2hlci1sZXZlbCBjb25jZXJucyAocmV0cnksIGhlYXJ0YmVhdCwgaGVhbHRoIGNoZWNrcykgbGl2ZSBpblxuICogY2xhdWRlX3J1bm5lci50cyB3aGljaCBidWlsZHMgb24gdGhpcyBtb2R1bGUuXG4gKlxuICogTWlncmF0ZWQgZnJvbSB3b3JrZXIvc2hhcmVkL2NsYXVkZV9ydW5uZXIuc2ggKGxvdy1sZXZlbCBmdW5jdGlvbnMpLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7XG4gIERFRkFVTFRfRUZGT1JULFxuICBQSEFTRV9FRkZPUlRfREVGQVVMVFMsXG4gIFBIQVNFX01PREVMX0RFRkFVTFRTLFxufSBmcm9tIFwiLi9jb25maWdfZGVmYXVsdHMudHNcIjtcbmltcG9ydCB7IGluY3JlbWVudENvdW50ZXIgfSBmcm9tIFwiLi9mYXVsdF90b2xlcmFuY2VfY291bnRlcnMudHNcIjtcbmltcG9ydCB7IHJlZGFjdFNlY3JldHMgfSBmcm9tIFwiLi9zZWNyZXRfcmVkYWN0aW9uLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEVudkxvb2t1cCB9IGZyb20gXCIuL2Vudl9sb29rdXAudHNcIjtcbmltcG9ydCB7IHJlc29sdmVQaGFzZVJvdXRlZFZhbHVlIH0gZnJvbSBcIi4vcGhhc2Vfcm91dGluZy50c1wiO1xuaW1wb3J0IHR5cGUgeyBSZXBvQ29uZmlnIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IFJ1blN0YXRzIH0gZnJvbSBcIi4vcnVuX3N0YXRzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvblRlbGVtZXRyeSB9IGZyb20gXCIuL3RpbWVvdXRfZXh0ZW5zaW9uX3RlbGVtZXRyeS50c1wiO1xuaW1wb3J0IHR5cGUgeyBTY2hlZHVsZWRSZWxlYXNlUmVhc29uIH0gZnJvbSBcIi4vZmFpbHVyZV9kaWFnbm9zaXMudHNcIjtcbmltcG9ydCB0eXBlIHsgQWdlbnREZWNvZGVkT3V0cHV0LCBBZ2VudEZhaWx1cmUgfSBmcm9tIFwiLi9hZ2VudF9vdXRwdXQudHNcIjtcbmltcG9ydCB7IEJBTEFOQ0VfRVhIQVVTVEVEX1JFIH0gZnJvbSBcIi4vYWdlbnRfb3V0cHV0LnRzXCI7XG5cbi8qKiBFeGl0IGNvZGUgcmV0dXJuZWQgd2hlbiBhIHByb2Nlc3MgdGltZXMgb3V0LiAqL1xuZXhwb3J0IGNvbnN0IFRJTUVPVVRfRVhJVF9DT0RFID0gMTI0O1xuXG4vKipcbiAqIEV4aXQgY29kZSB0aGUgcnVuIGxvb3AgcmV0dXJucyBmb3IgYSB0ZXJtaW5hbCBvdXQtb2YtbWVtb3J5IGZhaWx1cmVcbiAqIChJc3N1ZSAjMjc0MSwgcGFyZW50ICMyNzIxKS5cbiAqXG4gKiBgMTM3YCBpcyBgMTI4ICsgOWAgKFNJR0tJTEwg4oCUIHRoZSBMaW51eCBPT00ta2lsbGVyJ3Mgc2lnbmFsKSwgc28gaXQgaXMgdGhlXG4gKiBuYXR1cmFsIGNvZGUgZm9yIGEgaGVhcC1leGhhdXN0aW9uIGtpbGwuIEl0IGlzIGRlbGliZXJhdGVseSBkaXN0aW5jdCBmcm9tXG4gKiB7QGxpbmsgVElNRU9VVF9FWElUX0NPREV9ICgxMjQpIGFuZCB0aGUgcmF0ZS1saW1pdCBnaXZlLXVwIGNvZGUgKDIpIHNvIHRoZVxuICogY2FsbGVyIGNhbiB0ZWxsIE9PTSBhcGFydCBmcm9tIGEgdGltZW91dCBvciBhIHJhdGUgbGltaXQ6IGFuIE9PTSBpc1xuICogdGVybWluYWwg4oCUIHdhaXRpbmcgYW5kIHJldHJ5aW5nIGNhbm5vdCBmaXggaXQuXG4gKi9cbmV4cG9ydCBjb25zdCBPT01fRVhJVF9DT0RFID0gMTM3O1xuXG4vKiogRGVmYXVsdCBjaGFyYWN0ZXJzIHBlciB0b2tlbiBmb3IgZXN0aW1hdGlvbiBoZXVyaXN0aWMuICovXG5jb25zdCBERUZBVUxUX0NIQVJTX1BFUl9UT0tFTiA9IDQ7XG5cbi8qKlxuICogUmVhc29uIGEgQ2xhdWRlIGV4ZWN1dGlvbiB0aW1lZCBvdXQuXG4gKlxuICogLSBgXCJoYXJkLXRpbWVvdXRcImAg4oCUIHRoZSB3YWxsLWNsb2NrIGB0aW1lb3V0U2Vjb25kc2Agd2F0Y2hkb2cgZmlyZWQuXG4gKiAtIGBcIm5vLW91dHB1dFwiYCDigJQgdGhlIHNpbGVuY2Ugd2F0Y2hkb2cgZmlyZWQgYmVjYXVzZSBzdGRvdXQgd2FzIGlkbGUgZm9yXG4gKiAgIGBub091dHB1dFRpbWVvdXRgIHNlY29uZHMgKElzc3VlICMxODI1KS5cbiAqIC0gYFwiY2FsbC1zdG9ybVwiYCDigJQgdGhlIGNhbGwtc3Rvcm0gZ3VhcmQgc3RvcHBlZCBhIHJ1biB0aGF0IHdhcyBwb2xsaW5nXG4gKiAgIHJhdGhlciB0aGFuIHdvcmtpbmc6IGRvemVucyBvZiB0b29sIGNhbGxzIGEgbWludXRlIHdpdGggbm8gd29ya2luZy10cmVlXG4gKiAgIGNoYW5nZSAoSXNzdWUgIzIyMzApLlxuICovXG5leHBvcnQgdHlwZSBDbGF1ZGVUaW1lb3V0UmVhc29uID0gXCJoYXJkLXRpbWVvdXRcIiB8IFwibm8tb3V0cHV0XCIgfCBcImNhbGwtc3Rvcm1cIjtcblxuLyoqIFJlc3VsdCBvZiBhIENsYXVkZSBDTEkgZXhlY3V0aW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBDbGF1ZGVFeGVjdXRpb25SZXN1bHQge1xuICAvKiogRXhpdCBjb2RlIGZyb20gdGhlIHByb2Nlc3MgKDEyNCA9IHRpbWVvdXQsIDEzNyA9IFNJR0tJTEwpLiAqL1xuICBleGl0Q29kZTogbnVtYmVyO1xuICAvKipcbiAgICogVGhlIGNoaWxkJ3MgdHJ1ZSBleGl0IHN0YXR1cywgYmVmb3JlIGFueSBjbGFzc2lmaWNhdGlvbiAoSXNzdWUgIzQyMDIpLlxuICAgKiBXaGVuIGEgd2F0Y2hkb2cgZmlyZXMsIGBleGl0Q29kZWAgaXMgcmVtYXBwZWQgdG8gMTI0IGJ1dCB0aGlzIGZpZWxkXG4gICAqIGtlZXBzIHdoYXQgdGhlIHByb2Nlc3MgcmVhbGx5IGV4aXRlZCB3aXRoICh0eXBpY2FsbHkgdGhlIHNpZ25hbCBkZWF0aFxuICAgKiBmcm9tIHRoZSB3YXRjaGRvZydzIG93biBraWxsKSwgc28gZGlhZ25vc3RpY3MgbmV2ZXIgZGVzdHJveSBldmlkZW5jZS5cbiAgICovXG4gIHJhd0V4aXRDb2RlPzogbnVtYmVyO1xuICAvKiogVGhlIGV4dHJhY3RlZCB0ZXh0IG91dHB1dCBmcm9tIENsYXVkZS4gKi9cbiAgb3V0cHV0OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBDYXB0dXJlZCBzdGRlcnIgdGV4dCAoZGVjb2RlZCwgdHJpbW1lZCkgZnJvbSB0aGUgQ2xhdWRlIENMSSBzdWJwcm9jZXNzXG4gICAqIChJc3N1ZSAjMTk4MCkuIFN1cmZhY2VkIHNvIGNhbGxlcnMgY2FuIGRpYWdub3NlIGZhaWx1cmVzIHdpdGggdGhlIHJlYWxcbiAgICogZXJyb3IgcmF0aGVyIHRoYW4gcmVseWluZyBvbiB0aGUgaGlzdG9yaWNhbCBjYXRjaC1hbGxcbiAgICogXCJyYXRlLWxpbWl0ZWQgb3IgdW5yZXNwb25zaXZlXCIgbWVzc2FnZS5cbiAgICovXG4gIHN0ZGVycjogc3RyaW5nO1xuICAvKiogV2hldGhlciB0aGUgcHJvY2VzcyB0aW1lZCBvdXQuICovXG4gIC8qKlxuICAgKiBLaWxsZWQgZnJvbSBvdXRzaWRlIGJ5IFNJR1RFUk0gd2l0aCBubyB3YXRjaGRvZyBhc2tpbmcgKElzc3VlICM0MzY5KSDigJRcbiAgICogcnVuIGVuZCBvciBoYW5kbGVyIGFiYW5kb25tZW50LiBUZXJtaW5hbDsgbmV2ZXIgYSByYXRlIGxpbWl0LlxuICAgKi9cbiAgdGVybWluYXRlZD86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBBIFNJR1RFUk0gdGhlIHdvcmtlciBuZXZlciByZXF1ZXN0ZWQgKElzc3VlICM0Nik6IGBpc0FnZW50UnVuc1Rlcm1pbmF0aW5nKClgXG4gICAqIHdhcyBmYWxzZSwgc28gaXQgY2FtZSBmcm9tIG91dHNpZGUg4oCUIGEgdG9vbCB0aGUgYWdlbnQgcmFuLCB0aGUgQ0xJLCB0aGVcbiAgICogY29udGFpbmVyLCBhIHN0cmF5IHNpZ25hbC4gVW5saWtlIHtAbGluayB0ZXJtaW5hdGVkfSAob3VyIG93biBzaHV0ZG93biksXG4gICAqIHRoaXMgaXMgYW4gZXh0ZXJuYWwga2lsbCDigJQgYSByZXRyeWFibGUgZmFpbHVyZSBjYXJyeWluZyBraWxsIGRpYWdub3N0aWNzLlxuICAgKi9cbiAgZXh0ZXJuYWxTaWd0ZXJtPzogYm9vbGVhbjtcbiAgdGltZWRPdXQ6IGJvb2xlYW47XG4gIC8qKlxuICAgKiBXaGljaCB0aW1lb3V0IGZpcmVkLCB3aGVuIGB0aW1lZE91dGAgaXMgdHJ1ZSAoSXNzdWUgIzE4MjUpLiBEaXN0aW5ndWlzaGVzXG4gICAqIHRoZSBoYXJkIHdhbGwtY2xvY2sgdGltZW91dCBmcm9tIHRoZSBuby1vdXRwdXQgc2lsZW5jZSB3YXRjaGRvZyBzb1xuICAgKiBkaWFnbm9zdGljcyBjYW4gcmVjb3JkIHRoZSBjb3JyZWN0IHJlYXNvbi5cbiAgICovXG4gIHRpbWVvdXRSZWFzb24/OiBDbGF1ZGVUaW1lb3V0UmVhc29uO1xuICAvKipcbiAgICogVGhlIHJ1biB3YXMgc3RvcHBlZCBvbiBzY2hlZHVsZSwgbm90IGJlY2F1c2UgaXQgZmFpbGVkIChJc3N1ZSAjNDI0LFxuICAgKiBwYXJlbnQgIzM5Nykg4oCUIHRoZSBzdXBlcnZpc29yJ3MgaGFyZCBjYXAgbGVmdCBubyBydW53YXkgd2hpbGUgdGhlIHJ1blxuICAgKiB3YXMgc3RpbGwgcHJvZ3Jlc3NpbmcuIEEgaGFyZC1jYXAgcmVsZWFzZSBmaXJlcyB0aGUgc2FtZSB3YXRjaGRvZyBhbmRcbiAgICogZXhpdHMgd2l0aCB0aGUgc2FtZSBzdGF0dXMgYXMgYSBnZW51aW5lIHRpbWVvdXQsIHNvIHRoaXMgZmxhZyBpcyB0aGVcbiAgICogb25seSB0aGluZyB0aGF0IHRlbGxzIHRoZSB0d28gYXBhcnQgZG93bnN0cmVhbS5cbiAgICovXG4gIHNjaGVkdWxlZFJlbGVhc2U/OiBTY2hlZHVsZWRSZWxlYXNlUmVhc29uO1xuICAvKipcbiAgICogVGhlIHNlc3Npb24gd2FzIGJvdW5kZWQgYnkgdGhlIHJ1bidzIGZpbmlzaCBkZWFkbGluZSAoSXNzdWUgIzQyNDQpLlxuICAgKlxuICAgKiBTZXQgd2hlbiB0aGUgZmluaXNoIGRlYWRsaW5lIGxlZnQgbGVzcyB0aGFuIHRoZSBtaW5pbXVtIHNlc3Npb24gYW5kIHRoZVxuICAgKiBhZ2VudCB3YXMgbm90IHNwYXduZWQsIGFuZCB3aGVuIGEgc3Bhd25lZCBzZXNzaW9uIGVuZGVkIGJlY2F1c2UgdGhlXG4gICAqIGNsYW1wZWQgdGltZW91dCBmaXJlZC4gQWJzZW50IG9uIGEgcnVuIHRoYXQgdXNlZCB1cCBpdHMgb3duXG4gICAqIGB0aW1lb3V0U2Vjb25kc2AsIGFuZCBhYnNlbnQgd2hlbiBubyB0aW1lbGluZSBpcyBzZXQuXG4gICAqL1xuICBmaW5pc2hEZWFkbGluZT86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBTZWNvbmRzIHRoZSBoYXJkIHdhdGNoZG9nIGZpcmVkIHBhc3QgaXRzIGNvbmZpZ3VyZWQgYnVkZ2V0XG4gICAqIChJc3N1ZSAjNDI1NCkg4oCUIGEgc3RhcnZlZCBWTSBkZWxheXMgRGVubyB0aW1lcnMsIGFuZCBob3N0LTI1IHNhdyB0aGVcbiAgICogMzYwMCBzIHdhdGNoZG9nIGZpcmUgNDg3IHMgYW5kIDM0NzAgcyBsYXRlLiBQcmVzZW50IG9ubHkgd2hlbiBsYXRlLlxuICAgKi9cbiAgd2F0Y2hkb2dMYXRlU2Vjb25kcz86IG51bWJlcjtcbiAgLyoqXG4gICAqIFdoeSB0aGUgY2FsbC1zdG9ybSBndWFyZCBzdG9wcGVkIHRoZSBydW4gKElzc3VlICMyMjMwKS5cbiAgICpcbiAgICogUHJlc2VudCBvbmx5IHdpdGggYHRpbWVvdXRSZWFzb246IFwiY2FsbC1zdG9ybVwiYC4gSXRzIG93biBmaWVsZCwgbm90IHRoZVxuICAgKiBleHRlbnNpb24gdGVsZW1ldHJ5J3MgYHJlZnVzYWxSZWFzb25gOiBubyBleHRlbnNpb24gd2FzIHJlZnVzZWQsIGFuZCB0aGVcbiAgICogZXhlY3V0ZSBwaGFzZSBwdXRzIHRoaXMgc3RyaW5nIGluIHRoZSBmYWlsdXJlIHJlYXNvbiBzbyB0aGUgaXNzdWUgY29tbWVudFxuICAgKiBuYW1lcyB0aGUgbG9vcCByYXRoZXIgdGhhbiBibGFtaW5nIHRoZSBjbG9jay5cbiAgICovXG4gIHN0YWxsUmVhc29uPzogc3RyaW5nO1xuICAvKipcbiAgICogU2V0IHdoZW4gdGhlIHBvc3Qta2lsbCB3YWl0IGV4cGlyZWQgYmVmb3JlIHRoZSBjaGlsZCBzZXR0bGVkXG4gICAqIChJc3N1ZSAjNDI1NCk6IHRoZSBydW5uZXIgYWJhbmRvbmVkIGBjaGlsZC5zdGF0dXNgIGFuZCB0aGUgc3RyZWFtXG4gICAqIHB1bXBzIGFmdGVyIHRoaXMgbWFueSBzZWNvbmRzIHJhdGhlciB0aGFuIGJsb2NraW5nIGZvciBob3Vycy4gV2hlblxuICAgKiBzZXQsIGBleGl0Q29kZWAvYHJhd0V4aXRDb2RlYCBhcmUgc3ludGhlc2lzZWQg4oCUIHRoZSBjaGlsZCBuZXZlclxuICAgKiByZXBvcnRlZCBhIHN0YXR1cy5cbiAgICovXG4gIGtpbGxJbmNvbXBsZXRlU2Vjb25kcz86IG51bWJlcjtcbiAgLyoqXG4gICAqIEJvdW5kZWQga2lsbC10aW1lIGV2aWRlbmNlIChJc3N1ZSAjNDM4Mik6IHRoZSB0b3AgcHJvY2Vzc2VzIGJ5IFJTUyBhdFxuICAgKiB0aGUgbW9tZW50IGFuIGV4dGVybmFsIGtpbGwgd2FzIG9ic2VydmVkICh0aGUgYWdlbnQncyBvd24gdHJlZSBtYXJrZWQpXG4gICAqIGFuZCBhbnkgcmVhZGFibGUga2VybmVsIE9PTSBsaW5lcy4gUHJlc2VudCBvbmx5IGFmdGVyIHN1Y2ggYSBraWxsLlxuICAgKi9cbiAga2lsbERpYWdub3N0aWNzPzogc3RyaW5nO1xuICAvKipcbiAgICogUGVyLXJ1biBnZW5lcmF0aW9uIHN0YXRzIChJc3N1ZSAjMjY0Nyk6IHNlcnZlZCBtb2RlbCBJRHMgZGVjbGFyZWQgYnkgdGhlXG4gICAqIEFQSSwgcmVxdWVzdGVkIG1vZGVsL2VmZm9ydCwgdG9rZW4gdXNhZ2UsIHR1cm4gY291bnQsIGFuZCBkdXJhdGlvbnMuXG4gICAqIE9wdGlvbmFsIOKAlCBwcmVzZW50IG9uIGV2ZXJ5IGNvbXBsZXRlZCBydW4sIG9taXR0ZWQgb25seSBvbiBzcGF3biBmYWlsdXJlLlxuICAgKi9cbiAgcnVuU3RhdHM/OiBSdW5TdGF0cztcbiAgLyoqXG4gICAqIElkIG9mIHRoZSBjb2RpbmctYWdlbnQgcHJvdmlkZXIgdGhhdCBwcm9kdWNlZCB0aGlzIHJlc3VsdCAoSXNzdWUgIzQxMDkpLlxuICAgKlxuICAgKiBTZXQgb24gZXZlcnkgY29tcGxldGVkIHJ1biwgc28gYSBRdW9ydW0gcnVuIGNhbiBhdHRyaWJ1dGUgdHdvIGRyYWZ0cyBhbmQgYVxuICAgKiB2ZXJkaWN0IHdpdGhvdXQgaW5mZXJyaW5nIHRoZSBhZ2VudCBmcm9tIHRoZSBvdXRwdXQuIE9wdGlvbmFsIG9ubHkgYmVjYXVzZVxuICAgKiBhIHNwYXduIGZhaWx1cmUgbmV2ZXIgcmVhY2hlcyB0aGUgcHJvdmlkZXIuXG4gICAqL1xuICBwcm92aWRlcj86IHN0cmluZztcbiAgLyoqXG4gICAqIFRoaXMgaW52b2NhdGlvbiBkZWNvZGVkIGludG8gdGhlIHByb3ZpZGVyLW5ldXRyYWwgY29udHJhY3QgKElzc3VlICMxNjk1KS5cbiAgICpcbiAgICogUHJvZHVjZWQgYnkgdGhlIHByb3ZpZGVyIGRlc2NyaXB0b3IncyBvd24gb3V0cHV0IGFkYXB0ZXIsIHNvIHRoZSBzaGFwZSBpc1xuICAgKiB0aGUgc2FtZSB3aGljaGV2ZXIgQ0xJIHJhbi4gQWJzZW50IGZvciBhIHByb3ZpZGVyIHRoYXQgaGFzIG5vIGFkYXB0ZXIgeWV0XG4gICAqIOKAlCBhbiBhYnNlbnQgZGVjb2RlLCBuZXZlciBvbmUgdmVuZG9yJ3MgZXZlbnRzIHJlYWQgd2l0aCBhbm90aGVyJ3MgcGFyc2VyLlxuICAgKi9cbiAgYWdlbnRPdXRwdXQ/OiBBZ2VudERlY29kZWRPdXRwdXQ7XG4gIC8qKlxuICAgKiBUaGlzIGludm9jYXRpb24ncyBmYWlsdXJlLCBub3JtYWxpc2VkIGludG8gb25lIG5hbWVkIGNhdGVnb3J5IHdpdGggdGhlXG4gICAqIGV2aWRlbmNlIGl0IHdhcyByZWFkIGZyb20gKElzc3VlICMxNjk1KS4gQWJzZW50IHdoZW4gdGhlIHJ1biBkaWQgbm90XG4gICAqIGZhaWwuXG4gICAqL1xuICBhZ2VudEZhaWx1cmU/OiBBZ2VudEZhaWx1cmU7XG4gIC8qKlxuICAgKiBDaGVhcGVyIG1vZGVsIHRoZSBydW4gZmVsbCBiYWNrIHRvIGFmdGVyIHJhdGUtbGltaXQgZXhoYXVzdGlvbiAoIzExMTMpLlxuICAgKiBQb3B1bGF0ZWQgb25seSBieSB0aGUgcmV0cnkgd3JhcHBlciAoYHJ1bkNsYXVkZVdpdGhSZXRyeWApOyB0aGUgbG93LWxldmVsXG4gICAqIGV4ZWN1dG9yIG5ldmVyIHNldHMgaXQuIFN1cmZhY2VkIGhlcmUgc28gc2VhbXMgdGhhdCBhZGFwdCBhXG4gICAqIHtAbGluayBSdW5DbGF1ZGVSZXN1bHR9IGludG8gYSB7QGxpbmsgQ2xhdWRlRXhlY3V0aW9uUmVzdWx0fSAoZS5nLiB0aGVcbiAgICogY2xhcmlmaWNhdGlvbiBwYXRoLCBJc3N1ZSAjMzIzMikgY2FuIGNhcnJ5IHRoZSBkZWdyYWRlZC1tb2RlbCBzaWduYWwuXG4gICAqL1xuICBmYWxsYmFja01vZGVsPzogc3RyaW5nO1xuICAvKipcbiAgICogRXhwbGljaXQgcHJlLWZsaWdodCBGYWJsZS1yZXJvdXRlIGRlZ3JhZGVkIGZsYWcgKElzc3VlICMzMjMxLyMzMjMyKS5cbiAgICogUG9wdWxhdGVkIG9ubHkgYnkgdGhlIHJldHJ5IHdyYXBwZXI7IGNhcnJpZWQgaGVyZSBmb3IgdGhlIHNhbWUgc2VhbS1hZGFwdFxuICAgKiByZWFzb24gYXMge0BsaW5rIGZhbGxiYWNrTW9kZWx9LlxuICAgKi9cbiAgcHJlZmxpZ2h0RGVncmFkZWQ/OiBib29sZWFuO1xuICAvKiogSHVtYW4tcmVhZGFibGUgcmVhc29uIGFjY29tcGFueWluZyB7QGxpbmsgcHJlZmxpZ2h0RGVncmFkZWR9LiAqL1xuICBwcmVmbGlnaHREZWdyYWRlZFJlYXNvbj86IHN0cmluZztcbiAgLyoqXG4gICAqIFdoYXQgdGhlIHJlLWFybWFibGUgaGFyZCBkZWFkbGluZSBkaWQgdG8gdGhpcyBydW4gKElzc3VlICM0Mjk4LCBwYXJ0IG9mXG4gICAqICM0MjkwKTogZXh0ZW5zaW9ucyBncmFudGVkLCBzZWNvbmRzIGFkZGVkLCB0aGUgZmluYWwgZGVhZGxpbmUsIHRoZSB0cnVlXG4gICAqIGVsYXBzZWQgdGltZSBhbmQgd2h5IHRoZSBsYXN0IGV4dGVuc2lvbiB3YXMgcmVmdXNlZC5cbiAgICpcbiAgICogUHJlc2VudCBvbmx5IHdoZW4gdGhlIHByb2dyZXNzLWV4dGVuc2lvbiBmZWF0dXJlIHdhcyBhY3RpdmUgZm9yIHRoZSBydW5cbiAgICogKHtAbGluayBSdW5DbGF1ZGVPcHRpb25zLnByb2dyZXNzRXh0ZW5zaW9ufSBzdXBwbGllZCBhbmQgZW5hYmxlZCksIHNvXG4gICAqIGV2ZXJ5IG90aGVyIGNhbGxlcidzIHJlc3VsdCBzaGFwZSBpcyB1bmNoYW5nZWQuXG4gICAqL1xuICBleHRlbnNpb25zPzogRXh0ZW5zaW9uVGVsZW1ldHJ5O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEVzY2FwZSBjb2RlIHN0cmlwcGluZ1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8vIGRlbm8tbGludC1pZ25vcmUgbm8tY29udHJvbC1yZWdleFxuY29uc3QgT1NDX1JFID0gL1xceDFiXFxdW15cXHgwN1xceDFiXSpbXFx4MDddfFxceDFiXFxdW15cXHgwN1xceDFiXSpcXHgxYlxcXFwvZztcblxuLy8gZGVuby1saW50LWlnbm9yZSBuby1jb250cm9sLXJlZ2V4XG5jb25zdCBDU0lfUkUgPSAvXFx4MWJcXFtbXFw/MC05O10qW0EtWmEtel0vZztcblxuLyoqXG4gKiBSZW1vdmUgdGVybWluYWwgZXNjYXBlIHNlcXVlbmNlcyBmcm9tIHRleHQuXG4gKlxuICogRmlsdGVycyBvdXQgT1NDIChPcGVyYXRpbmcgU3lzdGVtIENvbW1hbmQpIHNlcXVlbmNlcyBhbmQgQ1NJIChDb250cm9sXG4gKiBTZXF1ZW5jZSBJbnRyb2R1Y2VyKSBzZXF1ZW5jZXMgdGhhdCB0ZXJtaW5hbHMgZW1pdC4gVGhpcyBlbnN1cmVzIGxvZ3NcbiAqIGNvbnRhaW4gb25seSBodW1hbi1yZWFkYWJsZSB0ZXh0LlxuICpcbiAqIEBwYXJhbSB0ZXh0IC0gVGV4dCBwb3RlbnRpYWxseSBjb250YWluaW5nIGVzY2FwZSBjb2Rlc1xuICogQHJldHVybnMgQ2xlYW4gdGV4dCB3aXRoIGVzY2FwZSBjb2RlcyByZW1vdmVkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdHJpcEVzY2FwZUNvZGVzKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB0ZXh0LnJlcGxhY2UoT1NDX1JFLCBcIlwiKS5yZXBsYWNlKENTSV9SRSwgXCJcIik7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVG9rZW4gZXN0aW1hdGlvblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogRXN0aW1hdGUgdGhlIG51bWJlciBvZiB0b2tlbnMgaW4gdGV4dC5cbiAqXG4gKiBVc2VzIGEgc2ltcGxlIGhldXJpc3RpYzogYXBwcm94aW1hdGVseSA0IGNoYXJhY3RlcnMgcGVyIHRva2VuLlxuICogVGhpcyBpcyBhIHJvdWdoIGVzdGltYXRlIGJ1dCBzdWZmaWNpZW50IGZvciBkZXRlY3RpbmcgbGFyZ2UgY29udGVudC5cbiAqXG4gKiBAcGFyYW0gdGV4dCAtIFRoZSB0ZXh0IHRvIGVzdGltYXRlXG4gKiBAcGFyYW0gY2hhcnNQZXJUb2tlbiAtIENoYXJhY3RlcnMgcGVyIHRva2VuIChkZWZhdWx0OiA0KVxuICogQHJldHVybnMgRXN0aW1hdGVkIHRva2VuIGNvdW50XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRUb2tlbkVzdGltYXRlKFxuICB0ZXh0OiBzdHJpbmcsXG4gIGNoYXJzUGVyVG9rZW46IG51bWJlciA9IERFRkFVTFRfQ0hBUlNfUEVSX1RPS0VOLFxuKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGguZmxvb3IodGV4dC5sZW5ndGggLyBjaGFyc1BlclRva2VuKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBTdHJlYW0tSlNPTiBleHRyYWN0aW9uXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBFeHRyYWN0IHBsYWluIHRleHQgZnJvbSBDbGF1ZGUncyBzdHJlYW0tanNvbiAoTkRKU09OKSBvdXRwdXQuXG4gKlxuICogRXh0cmFjdGlvbiBvcmRlcjpcbiAqICAgMS4gTG9vayBmb3IgYSBcInJlc3VsdFwiIHR5cGUgbGluZSBhbmQgZXh0cmFjdCB0aGUgLnJlc3VsdCBmaWVsZFxuICogICAyLiBGYWxsIGJhY2sgdG8gY29uY2F0ZW5hdGluZyBhc3Npc3RhbnQgdGV4dCBjb250ZW50IGJsb2Nrc1xuICogICAzLiBMYXN0IHJlc29ydDogcmV0dXJuIHJhdyBjb250ZW50XG4gKlxuICogQHBhcmFtIHJhd0NvbnRlbnQgLSBUaGUgcmF3IHN0cmVhbS1qc29uIGNvbnRlbnRcbiAqIEByZXR1cm5zIEV4dHJhY3RlZCBwbGFpbiB0ZXh0XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0U3RyZWFtSnNvblRleHQocmF3Q29udGVudDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFyYXdDb250ZW50LnRyaW0oKSkgcmV0dXJuIFwiXCI7XG5cbiAgY29uc3QgbGluZXMgPSByYXdDb250ZW50LnNwbGl0KFwiXFxuXCIpLmZpbHRlcigobCkgPT4gbC50cmltKCkpO1xuXG4gIC8vIFN0cmF0ZWd5IDE6IEV4dHJhY3QgZnJvbSB0aGUgXCJyZXN1bHRcIiBsaW5lIChwcmVzZW50IG9uIHN1Y2Nlc3NmdWwgY29tcGxldGlvbilcbiAgZm9yIChsZXQgaSA9IGxpbmVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgY29uc3QgbGluZSA9IGxpbmVzW2ldITtcbiAgICBpZiAobGluZS5pbmNsdWRlcygnXCJ0eXBlXCInKSAmJiBsaW5lLmluY2x1ZGVzKCdcInJlc3VsdFwiJykpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UobGluZSk7XG4gICAgICAgIGlmIChwYXJzZWQucmVzdWx0KSB7XG4gICAgICAgICAgcmV0dXJuIFN0cmluZyhwYXJzZWQucmVzdWx0KTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgICBgW2NsYXVkZS1leGVjdXRvcl0gRmFpbGVkIHRvIHBhcnNlIHN0cmVhbS1qc29uIHJlc3VsdCBsaW5lOiAke1xuICAgICAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICAgICAgfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gU3RyYXRlZ3kgMjogQ29uY2F0ZW5hdGUgYXNzaXN0YW50IHRleHQgYmxvY2tzIChmb3IgcGFydGlhbCBvdXRwdXQgb24gdGltZW91dClcbiAgY29uc3QgdGV4dEJsb2Nrczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UobGluZSk7XG4gICAgICBpZiAocGFyc2VkLnR5cGUgPT09IFwiYXNzaXN0YW50XCIgJiYgcGFyc2VkLm1lc3NhZ2U/LmNvbnRlbnQpIHtcbiAgICAgICAgZm9yIChjb25zdCBibG9jayBvZiBwYXJzZWQubWVzc2FnZS5jb250ZW50KSB7XG4gICAgICAgICAgaWYgKGJsb2NrLnR5cGUgPT09IFwidGV4dFwiICYmIGJsb2NrLnRleHQpIHtcbiAgICAgICAgICAgIHRleHRCbG9ja3MucHVzaChTdHJpbmcoYmxvY2sudGV4dCkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gRXhwZWN0ZWQgZm9yIG5vbi1KU09OIGxpbmVzIGluIHN0cmVhbSBvdXRwdXRcbiAgICB9XG4gIH1cbiAgaWYgKHRleHRCbG9ja3MubGVuZ3RoID4gMCkge1xuICAgIHJldHVybiB0ZXh0QmxvY2tzLmpvaW4oXCJcIik7XG4gIH1cblxuICAvLyBTdHJhdGVneSAzOiBGYWxsIGJhY2sgdG8gcmF3IGNvbnRlbnRcbiAgcmV0dXJuIHJhd0NvbnRlbnQ7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRXJyb3IgcGF0dGVybiBleHRyYWN0aW9uXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIENvbW1vbiBlcnJvciBwYXR0ZXJucyBhY3Jvc3MgbGFuZ3VhZ2VzIGFuZCB0b29scy4gKi9cbmNvbnN0IEVSUk9SX1BBVFRFUk5fUkUgPVxuICAvKF5cXHMrYXQgLitcXCh8VHJhY2ViYWNrIFxcKG1vc3QgcmVjZW50fF5bQS1aYS16XSpFcnJvcjp8XltBLVphLXpdKkV4Y2VwdGlvbjp8RkFUQUw6fFBBTklDOnxbU3NdZWdtZW50YXRpb24gZmF1bHR8W1NzXXRhY2sgb3ZlcmZsb3d8W09vXXV0IG9mIG1lbW9yeXxbUHBdZXJtaXNzaW9uIGRlbmllZHxjb21tYW5kIG5vdCBmb3VuZHxObyBzdWNoIGZpbGUgb3IgZGlyZWN0b3J5KS87XG5cbi8qKlxuICogRXh0cmFjdCByZWNvZ25pc2FibGUgZXJyb3IgcGF0dGVybnMgZnJvbSBvdXRwdXQgdGV4dC5cbiAqXG4gKiBTY2FucyBmb3IgY29tbW9uIGVycm9yIGluZGljYXRvcnM6IHN0YWNrIHRyYWNlcywgZXJyb3IgbWVzc2FnZXMsXG4gKiBwYW5pYy9mYXRhbCBrZXl3b3JkcywgYW5kIGNvbW1vbiBmYWlsdXJlIHBhdHRlcm5zLlxuICpcbiAqIEBwYXJhbSBvdXRwdXQgLSBUaGUgb3V0cHV0IHRleHQgdG8gc2NhblxuICogQHJldHVybnMgTWF0Y2hpbmcgZXJyb3IgbGluZXMgKGVtcHR5IGFycmF5IGlmIG5vIHBhdHRlcm5zIGZvdW5kKVxuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdEVycm9yUGF0dGVybnMob3V0cHV0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGlmICghb3V0cHV0LnRyaW0oKSkgcmV0dXJuIFtdO1xuXG4gIHJldHVybiBvdXRwdXRcbiAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAuZmlsdGVyKChsaW5lKSA9PiBFUlJPUl9QQVRURVJOX1JFLnRlc3QobGluZSkpO1xufVxuXG4vKiogRmFpbHVyZSBleHBsYW5hdGlvbiBwYXR0ZXJucyBmcm9tIENsYXVkZSdzIG91dHB1dC4gKi9cbmNvbnN0IEZBSUxVUkVfUEFUVEVSTl9SRSA9XG4gIC8oY291bGQgbm90IGZpbmR8Y2Fubm90IGZpbmR8ZG9lcyBub3QgZXhpc3R8ZG9lc24ndCBleGlzdHx3YXMgdW5hYmxlIHRvfHVuYWJsZSB0byBsb2NhdGV8bm90IGJlZW4gbWVyZ2VkfG5vdCBtZXJnZWQgaW50b3xjYW5ub3QgYWNjZXNzfGNvdWxkIG5vdCBhY2Nlc3N8aXMgbWlzc2luZyBmcm9tfGlzIG1pc3Npbmd8bm90IGF2YWlsYWJsZSBpbnxub3QgZm91bmQgaW4gdGhlfG5vdCBmb3VuZCBpbiB0aGlzKS9pO1xuXG4vKipcbiAqIEV4dHJhY3QgYWN0aW9uYWJsZSBmYWlsdXJlIHJlYXNvbnMgZnJvbSBDbGF1ZGUncyBvdXRwdXQuXG4gKlxuICogU2NhbnMgZm9yIHBhdHRlcm5zIHRoYXQgZXhwbGFpbiBXSFkgQ2xhdWRlIGNvdWxkIG5vdCBjb21wbGV0ZSB0aGUgdGFzay5cbiAqXG4gKiBAcGFyYW0gb3V0cHV0IC0gVGhlIG91dHB1dCB0ZXh0IHRvIHNjYW5cbiAqIEBwYXJhbSBtYXhMaW5lcyAtIE1heGltdW0gbnVtYmVyIG9mIGZhaWx1cmUgbGluZXMgdG8gcmV0dXJuIChkZWZhdWx0OiAxMClcbiAqIEByZXR1cm5zIE1hdGNoaW5nIGZhaWx1cmUgbGluZXNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RGYWlsdXJlU3VtbWFyeShcbiAgb3V0cHV0OiBzdHJpbmcsXG4gIG1heExpbmVzOiBudW1iZXIgPSAxMCxcbik6IHN0cmluZ1tdIHtcbiAgaWYgKCFvdXRwdXQudHJpbSgpKSByZXR1cm4gW107XG5cbiAgcmV0dXJuIG91dHB1dFxuICAgIC5zcGxpdChcIlxcblwiKVxuICAgIC5maWx0ZXIoKGxpbmUpID0+IEZBSUxVUkVfUEFUVEVSTl9SRS50ZXN0KGxpbmUpKVxuICAgIC5zbGljZSgwLCBtYXhMaW5lcyk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQWxyZWFkeS1jb21wbGV0ZSBkZXRlY3Rpb24gKElzc3VlICM1MTkpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIFBhdHRlcm5zIGluZGljYXRpbmcgaXNzdWUgaXMgYWxyZWFkeSBjb21wbGV0ZS9pbXBsZW1lbnRlZC9yZXNvbHZlZC4gKi9cbmNvbnN0IEFMUkVBRFlfQ09NUExFVEVfUkUgPVxuICAvKGFscmVhZHkgKGJlZW4gKT8oY29tcGxldGV8aW1wbGVtZW50ZWR8bWVyZ2VkfGZpeGVkfHJlc29sdmVkfGRvbmV8ZXhpc3RzKXxpbXBsZW1lbnRhdGlvbiBpcyBjb21wbGV0ZXxub3RoaW5nIChsZWZ0ICk/dG8gKGltcGxlbWVudHxkb3xjaGFuZ2V8Zml4KXxubyBjaGFuZ2VzIChhcmUgKT8obmVlZGVkfHJlcXVpcmVkfG5lY2Vzc2FyeSkpL2k7XG5cbi8qKlxuICogQ2hlY2sgaWYgb3V0cHV0IGluZGljYXRlcyB0aGUgaXNzdWUgaXMgYWxyZWFkeSBjb21wbGV0ZS5cbiAqXG4gKiBVc2VkIGJ5IHRoZSB3b3JrZXIgdG8gYXV0by1jbG9zZSBpc3N1ZXMgaW5zdGVhZCBvZiB0cmVhdGluZyB0aGVtIGFzXG4gKiBmYWlsdXJlcyDigJQgdGhlc2UgbWFjaGluZXMgYXJlIHVuYXR0ZW5kZWQgKElzc3VlICM1MTkpLlxuICpcbiAqIEBwYXJhbSBvdXRwdXQgLSBUaGUgb3V0cHV0IHRleHQgdG8gc2NhblxuICogQHJldHVybnMgdHJ1ZSBpZiB0aGUgb3V0cHV0IGluZGljYXRlcyB0aGUgaXNzdWUgaXMgYWxyZWFkeSBjb21wbGV0ZVxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0QWxyZWFkeUNvbXBsZXRlKG91dHB1dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghb3V0cHV0LnRyaW0oKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gQUxSRUFEWV9DT01QTEVURV9SRS50ZXN0KG91dHB1dCk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gR2l0SHViIEFQSSBzdWNjZXNzIGRldGVjdGlvbiAoSXNzdWUgIzUzNClcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogUGF0dGVybnMgaW5kaWNhdGluZyBzdWNjZXNzZnVsIEdpdEh1YiBBUEkgb3BlcmF0aW9ucy4gKi9cbmNvbnN0IEdJVEhVQl9BUElfU1VDQ0VTU19SRSA9XG4gIC8oZ2ggKGlzc3VlfHByKSAoZWRpdHxjbG9zZXxjb21tZW50fGNyZWF0ZSl8KGVkaXRlZHx1cGRhdGVkfGNsb3NlZCkgaXNzdWV8KGFkZGVkfHJlbW92ZWQpIGxhYmVsfHN1Y2Nlc3NmdWxseSAoZWRpdGVkfHVwZGF0ZWR8Y2xvc2VkKXxpc3N1ZSAoZGVzY3JpcHRpb258Ym9keSkgdXBkYXRlZHx1cGRhdGVkICh0aGUgKT9pc3N1ZSAoZGVzY3JpcHRpb258Ym9keSkpL2k7XG5cbi8qKlxuICogQ2hlY2sgaWYgb3V0cHV0IGluZGljYXRlcyBDbGF1ZGUgcGVyZm9ybWVkIEdpdEh1YiBBUEkgb3BlcmF0aW9uc1xuICogc3VjY2Vzc2Z1bGx5LlxuICpcbiAqIFdoZW4gYW4gaXNzdWUgcmVxdWlyZXMgb25seSBHaXRIdWIgQVBJIHdvcmssIHRoZXJlIHdpbGwgYmUgbm8gZ2l0IGRpZmZcbiAqIGJ1dCB0aGUgdGFzayB3YXMgc3RpbGwgc3VjY2Vzc2Z1bC5cbiAqXG4gKiBAcGFyYW0gb3V0cHV0IC0gVGhlIG91dHB1dCB0ZXh0IHRvIHNjYW5cbiAqIEByZXR1cm5zIHRydWUgaWYgR2l0SHViIEFQSSBvcGVyYXRpb25zIHdlcmUgZGV0ZWN0ZWRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdEdpdGh1YkFwaVN1Y2Nlc3Mob3V0cHV0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKCFvdXRwdXQudHJpbSgpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBHSVRIVUJfQVBJX1NVQ0NFU1NfUkUudGVzdChvdXRwdXQpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFJhdGUtbGltaXQgZGV0ZWN0aW9uXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBQYXR0ZXJucyBpbmRpY2F0aW5nIHJhdGUgbGltaXRpbmcgb3IgY3JlZGl0IGV4aGF1c3Rpb24g4oCUIHRoZSBTSE9SVC1CQUNLT0ZGXG4gKiBjbGFzcy4gYG92ZXJsb2FkZWRgLzUyOSAoQW50aHJvcGljIHRyYW5zaWVudCBvdmVybG9hZCkgYWRkZWQgYnkgSXNzdWVcbiAqICM0MzE1OiBpdCBpcyBleGFjdGx5IHRoZSByZXRyeS13aXRoLWppdHRlciBjYXNlIHRoaXMgY2xhc3MgaGFuZGxlcy5cbiAqL1xuY29uc3QgUkFURV9MSU1JVF9SRSA9XG4gIC8ocmF0ZSBsaW1pdHxjcmVkaXR8cXVvdGF8ZXhjZWVkZWR8dG9vIG1hbnkgcmVxdWVzdHN8NDI5fG92ZXJsb2FkZWR8XFxiNTI5XFxiKS9pO1xuXG4vKipcbiAqIENoZWNrIGlmIHRoZSB0YWlsIG9mIG91dHB1dCBpbmRpY2F0ZXMgcmF0ZSBsaW1pdGluZy5cbiAqXG4gKiBPbmx5IGNoZWNrcyB0aGUgbGFzdCBOIGxpbmVzIHRvIGF2b2lkIGZhbHNlIHBvc2l0aXZlcyBmcm9tIENsYXVkZVxuICogZGlzY3Vzc2luZyByYXRlIGxpbWl0cyBpbiBpdHMgb3V0cHV0LiBDYWxsZXJzIHBhc3MgdGhlIENMSSdzIGVycm9yIHN1cmZhY2UsXG4gKiBub3QgdGhlIGFnZW50J3MgdHJhbnNjcmlwdDogdGhlcmUgdXNlZCB0byBiZSBhIHNlY29uZGFyeVxuICogYHRyeSBhZ2FpbnxyZXRyeXxsaW1pdGAgbWF0Y2gsIGFuZCB0aGUgYWdlbnQncyBvd24gd29yZHMgKFwiYWRkIGEgcmV0cnlcIixcbiAqIFwiLS1saW1pdCAzMFwiKSB3YWxrZWQgb3JkaW5hcnkgZXhpdC0xIHJ1bnMgZG93biB0aGUgbW9kZWwgbGFkZGVyXG4gKiAoSXNzdWUgIzQxMTQpLiBJdCBpcyBnb25lOyBgaXNQcmltYXJ5YCBpcyBrZXB0IGZvciBleGlzdGluZyBjYWxsZXJzIGFuZCBpc1xuICogbm93IGFsd2F5cyBlcXVhbCB0byBgaXNSYXRlTGltaXRlZGAuXG4gKlxuICogQHBhcmFtIG91dHB1dCAtIFRoZSBvdXRwdXQgdGV4dCB0byBzY2FuXG4gKiBAcGFyYW0gdGFpbExpbmVzIC0gTnVtYmVyIG9mIGxpbmVzIGZyb20gdGhlIGVuZCB0byBjaGVjayAoZGVmYXVsdDogMzApXG4gKiBAcmV0dXJucyBXaGV0aGVyIGl0IG1hdGNoZWQsIGFuZCB0aGUgbGFzdCBtYXRjaGluZyBsaW5lICh1bnJlZGFjdGVkKVxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0UmF0ZUxpbWl0KFxuICBvdXRwdXQ6IHN0cmluZyxcbiAgdGFpbExpbmVzOiBudW1iZXIgPSAzMCxcbik6IHsgaXNSYXRlTGltaXRlZDogYm9vbGVhbjsgaXNQcmltYXJ5OiBib29sZWFuOyBtYXRjaGVkTGluZT86IHN0cmluZyB9IHtcbiAgaWYgKCFvdXRwdXQudHJpbSgpKSByZXR1cm4geyBpc1JhdGVMaW1pdGVkOiBmYWxzZSwgaXNQcmltYXJ5OiBmYWxzZSB9O1xuXG4gIGNvbnN0IHRhaWwgPSBvdXRwdXQuc3BsaXQoXCJcXG5cIikuc2xpY2UoLXRhaWxMaW5lcyk7XG4gIGNvbnN0IG1hdGNoZWRMaW5lID0gdGFpbC5maW5kTGFzdCgobGluZSkgPT4gUkFURV9MSU1JVF9SRS50ZXN0KGxpbmUpKTtcbiAgcmV0dXJuIG1hdGNoZWRMaW5lID09PSB1bmRlZmluZWRcbiAgICA/IHsgaXNSYXRlTGltaXRlZDogZmFsc2UsIGlzUHJpbWFyeTogZmFsc2UgfVxuICAgIDogeyBpc1JhdGVMaW1pdGVkOiB0cnVlLCBpc1ByaW1hcnk6IHRydWUsIG1hdGNoZWRMaW5lIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVXNhZ2UtbGltaXQgZGV0ZWN0aW9uIOKAlCB0aGUgc3Vic2NyaXB0aW9uIHdpbmRvdyAoSXNzdWUgIzQzMTUpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBQYXR0ZXJucyBmb3IgdGhlIE1heC1zdWJzY3JpcHRpb24gdXNhZ2Ugd2luZG93ICg1LWhvdXIgLyB3ZWVrbHkgY2FwcykuXG4gKlxuICogRGVsaWJlcmF0ZWx5IE5BUlJPVyBhbmQgc2VwYXJhdGUgZnJvbSB7QGxpbmsgUkFURV9MSU1JVF9SRX06IGEgdXNhZ2UgbGltaXRcbiAqIGlzIGFjY291bnQtd2lkZSBhbmQgdGltZS1ib3hlZCwgc28gdGhlIHJpZ2h0IHJlc3BvbnNlIGlzIHRvIHN0b3Agc3BlbmRpbmdcbiAqIHVudGlsIHRoZSB3aW5kb3cgcmVzZXRzIOKAlCBubyBtb2RlbCBmYWxsYmFjayAoZXZlcnkgbW9kZWwgYmlsbHMgdGhlIHNhbWVcbiAqIHdpbmRvdyksIG5vIGlzc3VlIGJsYW1lLiBXaWRlbmluZyB0aGUgcmF0ZS1saW1pdCByZWdleCBpbnN0ZWFkIHdvdWxkIGRyYWdcbiAqIHRoZXNlIGludG8gdGhlIHNob3J0LWJhY2tvZmYgKyBmYWxsYmFjayBsYWRkZXIsIGJ1cm5pbmcgdGhlIGV4aGF1c3RlZFxuICogd2luZG93IGZ1cnRoZXIuIFZvY2FidWxhcnkgcG9ydGVkIGZyb20gdGhlIG9wZXJhdG9yLXNpZGUgY2hlY2sgaW5cbiAqIHNldHVwLnNoLCB3aGljaCBoYWQga25vd24gdGhlc2Ugc3RyaW5ncyBhbGwgYWxvbmcuXG4gKlxuICogSXNzdWUgIzE2NjUgYWRkZWQgYHNlc3Npb24gbGltaXRgOiB0aGUgQ0xJIG5vdyByZWZ1c2VzIHdpdGggXCJZb3UndmUgaGl0XG4gKiB5b3VyIHNlc3Npb24gbGltaXQgwrcgcmVzZXRzIDE6NTBwbSAoVVRDKVwiLiBXaXRob3V0IGl0IHRoYXQgbGluZSBmZWxsXG4gKiB0aHJvdWdoIHRvIHRoZSBzZWNvbmRhcnkgcmF0ZS1saW1pdCBwYXR0ZXJuIChgL2xpbWl0L2ApIGFuZCBkcm92ZSB0aGVcbiAqIHNob3J0LWJhY2tvZmYgbGFkZGVyIGFnYWluc3QgYW4gZXhoYXVzdGVkIHN1YnNjcmlwdGlvbiB3aW5kb3cuXG4gKi9cbmNvbnN0IFVTQUdFX0xJTUlUX1JFID1cbiAgLyhjbGF1ZGUgKGFpICk/dXNhZ2UgbGltaXQgcmVhY2hlZHwoeW91Jz92ZXx5b3UgaGF2ZSkgKGhpdHxyZWFjaGVkKSB5b3VyICh1c2FnZSB8c2Vzc2lvbiApP2xpbWl0fFxcYig1fGZpdmUpWy0gXWhvdXIgKHVzYWdlICk/KGxpbWl0fHdpbmRvdylcXGJ8XFxid2Vla2x5ICh1c2FnZSApP2xpbWl0XFxifG91dCBvZiBleHRyYSB1c2FnZSkvaTtcblxuLyoqXG4gKiBJc3N1ZSAjMjYxMzogYSBzcGVudCBwcm92aWRlciBiYWxhbmNlIChIVFRQIDQwMikgaXMgdGhlIHNhbWUgc2hhcGUgb2ZcbiAqIHJlZnVzYWwg4oCUIGFjY291bnQtd2lkZSwgbm90IHRoZSB0YXNrJ3MgZmF1bHQsIGN1cmVkIG9ubHkgYnkgdGltZSBvciBhXG4gKiB0b3AtdXAg4oCUIHNvIGl0IHRha2VzIHRoZSBzYW1lIHRlcm1pbmFsIHBhdXNlIHJhdGhlciB0aGFuIHRoZSByYXRlLWxpbWl0XG4gKiBsYWRkZXIgKHdob3NlIGBjcmVkaXRgIG1hdGNoIHdvdWxkIG90aGVyd2lzZSByZXRyeSBpdCBpbnRvIHRoZSBncm91bmQpLlxuICovXG5mdW5jdGlvbiBpc1VzYWdlTGltaXRUZXh0KHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gVVNBR0VfTElNSVRfUkUudGVzdCh0ZXh0KSB8fCBCQUxBTkNFX0VYSEFVU1RFRF9SRS50ZXN0KHRleHQpO1xufVxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgdGhlIHRhaWwgb2YgYG91dHB1dGAgcmVwb3J0cyBhIHN1YnNjcmlwdGlvbiB1c2FnZSBsaW1pdC5cbiAqIFRhaWwtb25seSBmb3IgdGhlIHNhbWUgcmVhc29uIGFzIHtAbGluayBkZXRlY3RSYXRlTGltaXR9OiB0aGUgYWdlbnQgbWF5XG4gKiAqZGlzY3VzcyogbGltaXRzIG1pZC10cmFuc2NyaXB0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0VXNhZ2VMaW1pdChcbiAgb3V0cHV0OiBzdHJpbmcsXG4gIHRhaWxMaW5lczogbnVtYmVyID0gMzAsXG4pOiBib29sZWFuIHtcbiAgaWYgKCFvdXRwdXQudHJpbSgpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHRhaWwgPSBvdXRwdXQuc3BsaXQoXCJcXG5cIikuc2xpY2UoLXRhaWxMaW5lcykuam9pbihcIlxcblwiKTtcbiAgcmV0dXJuIGlzVXNhZ2VMaW1pdFRleHQodGFpbCk7XG59XG5cbi8qKlxuICogSW4tcHJvZ3Jlc3MgLyBub3QtZmluaXNoZWQgcGhyYXNpbmcgYW4gYWdlbnQgZW1pdHMgd2hlbiBpdHMgdHVybiBlbmRzIGJlZm9yZVxuICogaXQgY291bGQgZGVsaXZlciDigJQgYmxvY2tlZCBvbiBhIHNsb3cgcXVhbGl0eSBnYXRlLCBvdXQgb2YgdHVybiBidWRnZXQsIG9yXG4gKiBvdGhlcndpc2UgY3V0IG9mZiBtaWQtdGFzayAoSXNzdWUgIzEwOCkuIFRoaXMgaXMgdGhlIHRlbGwgdGhhdCBzZXBhcmF0ZXMgYVxuICogKnRydW5jYXRlZCogbm8tY2hhbmdlcyBydW4gZnJvbSBhIGdlbnVpbmVseSBhbmFseXNpcy1vbmx5IG9uZTogdGhlIGFnZW50XG4gKiBhbm5vdW5jZWQgaXQgaW50ZW5kZWQgdG8ga2VlcCBnb2luZywgaXQgZGlkIG5vdCBjb25jbHVkZS5cbiAqXG4gKiBEZWxpYmVyYXRlbHkgbmFycm93IOKAlCBlYWNoIGFsdGVybmF0aXZlIGlzIGEgZm9yd2FyZC1sb29raW5nIFwiSSB3aWxsIGNvbnRpbnVlXCJcbiAqIHN0YXRlbWVudCBvciBhbiBleHBsaWNpdCBcInN0aWxsIHJ1bm5pbmcgLyBub3QgZmluaXNoZWRcIiwgbm90IHNvbWV0aGluZyBhXG4gKiBmaW5pc2hlZCBhbmFseXNpcyB3b3VsZCBzYXkuIEEgZ2VudWluZSByZWNvbW1lbmRhdGlvbiAoXCJ0aGUgZml4IGlzIOKAplwiLCBcIm5vXG4gKiBjaGFuZ2UgaXMgbmVlZGVkIGJlY2F1c2Ug4oCmXCIpIG1hdGNoZXMgbm9uZSBvZiB0aGVzZSwgc28gdGhlIGFuYWx5c2lzLW9ubHlcbiAqIGhhbmQtb2ZmIHRob3NlIHJ1bnMgYmVsb25nIGluIGlzIHByZXNlcnZlZC5cbiAqL1xuY29uc3QgUlVOX0lOVEVSUlVQVEVEX1JFID1cbiAgL1xcYig/OmknP2xsfGkgd2lsbHxsZXQgbWV8Z29pbmcgdG98YWJvdXQgdG8pXFxzKyg/OnBpY2soPzppbmcpP1xccysoPzp0aGlzXFxzKyk/dXB8Y29udGludWV8cmVzdW1lfGNhcnJ5IG9ufGZpbmlzaHxwcm9jZWVkfHJldHJ5fHJlLT9ydW58Y29tZSBiYWNrKVxcYnxcXGIoPzpzdGlsbHxjdXJyZW50bHkpXFxzKyg/OnJ1bm5pbmd8aW4gcHJvZ3Jlc3N8YnVpbGRpbmd8Y2xvbmluZ3xjb21waWxpbmd8aW5zdGFsbGluZ3x3YWl0aW5nKVxcYnxcXGJhcyBzb29uIGFzICg/Oml0fHRoZXx0aGlzKVxcYlteXFxuXSpcXGIoPzpmaW5pc2h8ZmluaXNoZXN8Y29tcGxldGV8Y29tcGxldGVzfGRvbmUpXFxifFxcYnJhbiBvdXQgb2YgdGltZVxcYnxcXGJub3QgKD86eWV0ICk/KD86ZmluaXNoZWR8Y29tcGxldGV8ZG9uZSlcXGJ8XFxiaGF2ZW4nP3QgKD86ZmluaXNoZWR8Y29tcGxldGVkfHN0YXJ0ZWQpXFxifFxcYnF1YWxpdHkgKD86Z2F0ZXxjaGVjaylzPyAoPzppc3xhcmUpIHN0aWxsXFxiL2k7XG5cbi8qKlxuICogQ2hlY2sgd2hldGhlciB0aGUgdGFpbCBvZiBgb3V0cHV0YCBzaG93cyB0aGUgcnVuIHdhcyBjdXQgb2ZmIGJlZm9yZSBpdCBjb3VsZFxuICogZmluaXNoIChJc3N1ZSAjMTA4KS4gVGFpbC1vbmx5LCBtaXJyb3Jpbmcge0BsaW5rIGRldGVjdFVzYWdlTGltaXR9OiBhbiBhZ2VudFxuICogbWF5ICpkZXNjcmliZSogYmVpbmcgaW50ZXJydXB0ZWQgZWFybGllciBpbiBhIHRyYW5zY3JpcHQgaXQgdGhlbiByZWNvdmVyZWRcbiAqIGZyb20g4oCUIG9ubHkgdGhlIGZpbmFsIGxpbmVzIHJlcG9ydCBob3cgdGhlIHJ1biBhY3R1YWxseSBlbmRlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdFJ1bkludGVycnVwdGVkKFxuICBvdXRwdXQ6IHN0cmluZyxcbiAgdGFpbExpbmVzOiBudW1iZXIgPSAxNSxcbik6IGJvb2xlYW4ge1xuICBpZiAoIW91dHB1dC50cmltKCkpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgdGFpbCA9IG91dHB1dC5zcGxpdChcIlxcblwiKS5zbGljZSgtdGFpbExpbmVzKS5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gUlVOX0lOVEVSUlVQVEVEX1JFLnRlc3QodGFpbCk7XG59XG5cbi8qKiBNb250aCBuYW1lcyB0aGUgQ0xJJ3MgcmVzZXQgbWVzc2FnZXMgdXNlLCBmdWxsIG9yIGFiYnJldmlhdGVkLiAqL1xuY29uc3QgTU9OVEhfTkFNRVMgPSBbXG4gIFwiamFudWFyeVwiLFxuICBcImZlYnJ1YXJ5XCIsXG4gIFwibWFyY2hcIixcbiAgXCJhcHJpbFwiLFxuICBcIm1heVwiLFxuICBcImp1bmVcIixcbiAgXCJqdWx5XCIsXG4gIFwiYXVndXN0XCIsXG4gIFwic2VwdGVtYmVyXCIsXG4gIFwib2N0b2JlclwiLFxuICBcIm5vdmVtYmVyXCIsXG4gIFwiZGVjZW1iZXJcIixcbl07XG5cbi8qKiBaZXJvLWJhc2VkIG1vbnRoIGZvciBhIGZ1bGwgb3IgYWJicmV2aWF0ZWQgbmFtZSwgb3IgbnVsbCBpZiB1bmtub3duLiAqL1xuZnVuY3Rpb24gbW9udGhJbmRleChuYW1lOiBzdHJpbmcpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgbG93ZXJlZCA9IG5hbWUudG9Mb3dlckNhc2UoKTtcbiAgaWYgKGxvd2VyZWQubGVuZ3RoIDwgMykgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGluZGV4ID0gTU9OVEhfTkFNRVMuZmluZEluZGV4KChtb250aCkgPT4gbW9udGguc3RhcnRzV2l0aChsb3dlcmVkKSk7XG4gIHJldHVybiBpbmRleCA9PT0gLTEgPyBudWxsIDogaW5kZXg7XG59XG5cbi8qKlxuICogQSByZXNldCB0aW1lIHF1YWxpZmllZCBieSBhIERBVEUg4oCUIGByZXNldHMgQXVnIDI1LCAxYW0gKFVUQylgLCBgcmVzZXRzIG9uXG4gKiAyNSBBdWcgMjAyNiBhdCAxMzozMGAgKElzc3VlICMzMzMpLiBUaGUgd2Vla2x5IHdpbmRvdyBwdXRzIHRoZSBkYXRlIGJldHdlZW5cbiAqIFwicmVzZXRzXCIgYW5kIHRoZSBjbG9jaywgd2hpY2ggdGhlIGNsb2NrLW9ubHkgcGF0dGVybiBiZWxvdyBjYW5ub3Qgc2VlLlxuICovXG5jb25zdCBEQVRFRF9SRVNFVF9SRSA9XG4gIC9yZXNldFtzXT8oPzpcXHMrKD86YXR8b24pKT9cXHMrKD86KD88bW9uPltBLVphLXpdezMsOX0pXFwuP1xccysoPzxkYXk+XFxkezEsMn0pfCg/PGRheTI+XFxkezEsMn0pXFxzKyg/PG1vbjI+W0EtWmEtel17Myw5fSlcXC4/KSg/OnN0fG5kfHJkfHRoKT8oPzosP1xccyooPzx5ZWFyPlxcZHs0fSkpP1ssXFxzXSsoPzphdFxccyspPyg/PGhvdXI+XFxkezEsMn0pKD86Oig/PG1pbnV0ZT5cXGR7Mn0pKT9cXHMqKD88bWVyaWRpZW0+YW18cG0pP1xcYi9pO1xuXG4vKiogQSByZXNldCB0aW1lIGdpdmVuIGFzIGEgYmFyZSBjbG9jayDigJQgYHJlc2V0cyAzYW1gLCBgcmVzZXQgYXQgMTQ6MzBgLiAqL1xuY29uc3QgQ0xPQ0tfUkVTRVRfUkUgPVxuICAvcmVzZXRbc10/KD86XFxzK2F0KT9cXHMrKD88aG91cj5cXGR7MSwyfSkoPzo6KD88bWludXRlPlxcZHsyfSkpP1xccyooPzxtZXJpZGllbT5hbXxwbSk/XFxiL2k7XG5cbi8qKlxuICogQW4gZXhwbGljaXQgem9uZSBxdWFsaWZpZXIgb24gdGhlIHJlc2V0IHRpbWUg4oCUIGAoVVRDKWAsIGAoQXVzdHJhbGlhL1N5ZG5leSlgLlxuICogV2hlbiBwcmVzZW50IGl0IHdpbnMgb3ZlciB0aGUgaG9zdCB6b25lOiB0aGUgbWVzc2FnZSBzdGF0ZXMgdGhlIHpvbmUgaXRzIG93blxuICogY2xvY2sgaXMgaW4sIGFuZCB0aGUgaG9zdCdzIGlzIGlycmVsZXZhbnQgdG8gaXQgKElzc3VlICMzMzMpLlxuICovXG5jb25zdCBaT05FX1FVQUxJRklFUl9SRSA9IC9cXChcXHMqKFVUQ3xHTVR8WnxbQS1aYS16X10rXFwvW0EtWmEtel8rXFwtMC05XSspXFxzKlxcKS87XG5cbi8qKiBUaGUgcXVhbGlmaWVyJ3Mgem9uZSBpZiBpdCBuYW1lcyBvbmUgSW50bCBhY2NlcHRzLCBlbHNlIG51bGwuICovXG5mdW5jdGlvbiBleHBsaWNpdFpvbmUodGV4dDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IG1hdGNoID0gWk9ORV9RVUFMSUZJRVJfUkUuZXhlYyh0ZXh0KTtcbiAgaWYgKCFtYXRjaD8uWzFdKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgem9uZSA9IG1hdGNoWzFdID09PSBcIlpcIiA/IFwiVVRDXCIgOiBtYXRjaFsxXTtcbiAgdHJ5IHtcbiAgICBuZXcgSW50bC5EYXRlVGltZUZvcm1hdChcImVuLVVTXCIsIHsgdGltZVpvbmU6IHpvbmUgfSk7XG4gICAgcmV0dXJuIHpvbmU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKiBXYWxsLWNsb2NrIGZpZWxkcyBvZiBgdXRjTXNgIGFzIHJlYWQgaW4gYHpvbmVgLiAqL1xuZnVuY3Rpb24gem9uZVdhbGxQYXJ0cyh1dGNNczogbnVtYmVyLCB6b25lOiBzdHJpbmcpIHtcbiAgY29uc3QgcGFydHMgPSBuZXcgSW50bC5EYXRlVGltZUZvcm1hdChcImVuLVVTXCIsIHtcbiAgICB0aW1lWm9uZTogem9uZSxcbiAgICB5ZWFyOiBcIm51bWVyaWNcIixcbiAgICBtb250aDogXCIyLWRpZ2l0XCIsXG4gICAgZGF5OiBcIjItZGlnaXRcIixcbiAgICBob3VyOiBcIjItZGlnaXRcIixcbiAgICBtaW51dGU6IFwiMi1kaWdpdFwiLFxuICAgIHNlY29uZDogXCIyLWRpZ2l0XCIsXG4gICAgaG91ckN5Y2xlOiBcImgyM1wiLFxuICB9KS5mb3JtYXRUb1BhcnRzKG5ldyBEYXRlKHV0Y01zKSk7XG4gIGNvbnN0IGdldCA9ICh0eXBlOiBzdHJpbmcpID0+XG4gICAgTnVtYmVyKHBhcnRzLmZpbmQoKHApID0+IHAudHlwZSA9PT0gdHlwZSk/LnZhbHVlKTtcbiAgcmV0dXJuIHtcbiAgICB5ZWFyOiBnZXQoXCJ5ZWFyXCIpLFxuICAgIG1vbnRoOiBnZXQoXCJtb250aFwiKSxcbiAgICBkYXk6IGdldChcImRheVwiKSxcbiAgICBob3VyOiBnZXQoXCJob3VyXCIpLFxuICAgIG1pbnV0ZTogZ2V0KFwibWludXRlXCIpLFxuICAgIHNlY29uZDogZ2V0KFwic2Vjb25kXCIpLFxuICB9O1xufVxuXG4vKiogT2Zmc2V0IGJldHdlZW4gYHpvbmVgJ3Mgd2FsbCBjbG9jayBhbmQgVVRDIGF0IHRoZSBpbnN0YW50IGB1dGNNc2AuICovXG5mdW5jdGlvbiB6b25lT2Zmc2V0TXModXRjTXM6IG51bWJlciwgem9uZTogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgcCA9IHpvbmVXYWxsUGFydHModXRjTXMsIHpvbmUpO1xuICByZXR1cm4gRGF0ZS5VVEMocC55ZWFyLCBwLm1vbnRoIC0gMSwgcC5kYXksIHAuaG91ciwgcC5taW51dGUsIHAuc2Vjb25kKSAtXG4gICAgTWF0aC5mbG9vcih1dGNNcyAvIDEwMDApICogMTAwMDtcbn1cblxuLyoqXG4gKiBFcG9jaCBtcyBmb3IgYSB3YWxsIGNsb2NrIGluIGB6b25lYC4gVHdvIHBhc3NlcyBiZWNhdXNlIHRoZSBvZmZzZXQgaXRzZWxmXG4gKiBkZXBlbmRzIG9uIHRoZSBpbnN0YW50OiB0aGUgZmlyc3QgcGFzcyBnZXRzIGNsb3NlIGVub3VnaCB0byBwaWNrIHRoZSByaWdodFxuICogc2lkZSBvZiBhIERTVCB0cmFuc2l0aW9uLCB0aGUgc2Vjb25kIHNldHRsZXMgb24gaXQuXG4gKi9cbmZ1bmN0aW9uIHdhbGxDbG9ja1RvRXBvY2hNcyhcbiAgeWVhcjogbnVtYmVyLFxuICBtb250aDogbnVtYmVyLCAvLyAxLTEyXG4gIGRheTogbnVtYmVyLFxuICBob3VyOiBudW1iZXIsXG4gIG1pbnV0ZTogbnVtYmVyLFxuICB6b25lOiBzdHJpbmcsXG4pOiBudW1iZXIge1xuICBjb25zdCBuYWl2ZSA9IERhdGUuVVRDKHllYXIsIG1vbnRoIC0gMSwgZGF5LCBob3VyLCBtaW51dGUsIDApO1xuICBjb25zdCBmaXJzdFBhc3MgPSBuYWl2ZSAtIHpvbmVPZmZzZXRNcyhuYWl2ZSwgem9uZSk7XG4gIHJldHVybiBuYWl2ZSAtIHpvbmVPZmZzZXRNcyhmaXJzdFBhc3MsIHpvbmUpO1xufVxuXG4vKiogTm9ybWFsaXNlIGEgbWF0Y2hlZCBjbG9jayB0byAyNC1ob3VyIGZpZWxkcywgb3IgbnVsbCBpZiBvdXQgb2YgcmFuZ2UuICovXG5mdW5jdGlvbiBub3JtYWxpc2VDbG9jayhcbiAgaG91clJhdzogc3RyaW5nLFxuICBtaW51dGVSYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgbWVyaWRpZW1SYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbik6IHsgaG91cjogbnVtYmVyOyBtaW51dGU6IG51bWJlciB9IHwgbnVsbCB7XG4gIGxldCBob3VyID0gTnVtYmVyKGhvdXJSYXcpO1xuICBjb25zdCBtaW51dGUgPSBtaW51dGVSYXcgPyBOdW1iZXIobWludXRlUmF3KSA6IDA7XG4gIGNvbnN0IG1lcmlkaWVtID0gbWVyaWRpZW1SYXc/LnRvTG93ZXJDYXNlKCk7XG4gIGlmIChtZXJpZGllbSA9PT0gXCJwbVwiICYmIGhvdXIgPCAxMikgaG91ciArPSAxMjtcbiAgaWYgKG1lcmlkaWVtID09PSBcImFtXCIgJiYgaG91ciA9PT0gMTIpIGhvdXIgPSAwO1xuICBpZiAoaG91ciA+IDIzIHx8IG1pbnV0ZSA+IDU5KSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgaG91ciwgbWludXRlIH07XG59XG5cbmNvbnN0IERBWV9NUyA9IDI0ICogNjAgKiA2MCAqIDEwMDA7XG5cbi8qKlxuICogUGFyc2UgdGhlIHJlc2V0IHRpbWUgZnJvbSBhIHVzYWdlLWxpbWl0IG1lc3NhZ2UgaW50byBlcG9jaCBtaWxsaXNlY29uZHMsXG4gKiBvciBudWxsIHdoZW4gbm90aGluZyBwYXJzZWFibGUgaXMgcHJlc2VudC5cbiAqXG4gKiBIYW5kbGVzOiB0aGUgQ0xJJ3MgbWFjaGluZS1yZWFkYWJsZSBgfDxlcG9jaC1zZWNvbmRzPmAgc3VmZml4OyB0aGUgd2Vla2x5XG4gKiB3aW5kb3cncyBkYXRlLXF1YWxpZmllZCBmb3JtIGByZXNldHMgQXVnIDI1LCAxYW0gKFVUQylgIChJc3N1ZSAjMzMzKTsgYW5kXG4gKiB0aGUgNS1ob3VyIHdpbmRvdydzIGJhcmUgY2xvY2sgYHJlc2V0cyAzYW1gIC8gYHJlc2V0IGF0IDE0OjMwYC5cbiAqXG4gKiBab25lIHJlc29sdXRpb24sIGluIG9yZGVyOiBhbiBleHBsaWNpdCBxdWFsaWZpZXIgaW4gdGhlIG1lc3NhZ2UgKGAoVVRDKWApLFxuICogdGhlbiBgdGltZVpvbmVgLCB0aGVuIHRoZSBwcm9jZXNzIHpvbmUuIEJhcmUtY2xvY2sgZm9ybXMgcmVzb2x2ZSB0byB0aGVcbiAqIE5FWFQgZnV0dXJlIG9jY3VycmVuY2Ug4oCUIGEgdGltZSBhbHJlYWR5IHBhc3QgdG9kYXkgbWVhbnMgdG9tb3Jyb3cg4oCUIHdoaWxlXG4gKiBhIGRhdGUtcXVhbGlmaWVkIGZvcm0gaXMgdGFrZW4gYXQgaXRzIHdvcmQsIHdoaWNoIGlzIHdoYXQgYSB3ZWVrbHkgcmVzZXQgdXBcbiAqIHRvIHNldmVuIGRheXMgb3V0IG5lZWRzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VVc2FnZUxpbWl0UmVzZXQoXG4gIHRleHQ6IHN0cmluZyxcbiAgbm93TXM6IG51bWJlciA9IERhdGUubm93KCksXG4gIHRpbWVab25lPzogc3RyaW5nLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGNvbnN0IGVwb2NoID0gL1xcfChcXGR7OSwxMX0pXFxiLy5leGVjKHRleHQpO1xuICBpZiAoZXBvY2g/LlsxXSkgcmV0dXJuIE51bWJlcihlcG9jaFsxXSkgKiAxMDAwO1xuXG4gIGNvbnN0IGhvc3Rab25lID0gKCkgPT5cbiAgICB0aW1lWm9uZSA/PyBJbnRsLkRhdGVUaW1lRm9ybWF0KCkucmVzb2x2ZWRPcHRpb25zKCkudGltZVpvbmU7XG5cbiAgLy8gRGF0ZS1xdWFsaWZpZWQgZmlyc3Q6IGl0cyBkYXRlIHNpdHMgZXhhY3RseSB3aGVyZSB0aGUgY2xvY2stb25seSBwYXR0ZXJuXG4gIC8vIGV4cGVjdHMgZGlnaXRzLCBzbyB0cnlpbmcgdGhhdCBvbmUgZmlyc3Qgd291bGQgb25seSBldmVyIG1pc3MuXG4gIGNvbnN0IGRhdGVkID0gREFURURfUkVTRVRfUkUuZXhlYyh0ZXh0KTtcbiAgY29uc3QgZGcgPSBkYXRlZD8uZ3JvdXBzO1xuICBpZiAoZGF0ZWQgJiYgZGcpIHtcbiAgICBjb25zdCBtb250aCA9IG1vbnRoSW5kZXgoZGcubW9uID8/IGRnLm1vbjIgPz8gXCJcIik7XG4gICAgY29uc3QgZGF5ID0gTnVtYmVyKGRnLmRheSA/PyBkZy5kYXkyKTtcbiAgICBjb25zdCBjbG9jayA9IG5vcm1hbGlzZUNsb2NrKGRnLmhvdXIgPz8gXCJcIiwgZGcubWludXRlLCBkZy5tZXJpZGllbSk7XG4gICAgaWYgKG1vbnRoICE9PSBudWxsICYmIGNsb2NrKSB7XG4gICAgICBjb25zdCB6b25lID0gZXhwbGljaXRab25lKHRleHQuc2xpY2UoZGF0ZWQuaW5kZXgpKSA/PyBob3N0Wm9uZSgpO1xuICAgICAgY29uc3QgeWVhciA9IGRnLnllYXIgPyBOdW1iZXIoZGcueWVhcikgOiB6b25lV2FsbFBhcnRzKG5vd01zLCB6b25lKS55ZWFyO1xuICAgICAgLy8gUmVqZWN0IGltcG9zc2libGUgZGF0ZXMgKEZlYiAzMSkgaW5zdGVhZCBvZiBsZXR0aW5nIHRoZW0gb3ZlcmZsb3cuXG4gICAgICBjb25zdCBwcm9iZSA9IG5ldyBEYXRlKERhdGUuVVRDKHllYXIsIG1vbnRoLCBkYXkpKTtcbiAgICAgIGlmIChwcm9iZS5nZXRVVENNb250aCgpID09PSBtb250aCAmJiBwcm9iZS5nZXRVVENEYXRlKCkgPT09IGRheSkge1xuICAgICAgICBjb25zdCBhdCA9ICh5OiBudW1iZXIpID0+XG4gICAgICAgICAgd2FsbENsb2NrVG9FcG9jaE1zKHksIG1vbnRoICsgMSwgZGF5LCBjbG9jay5ob3VyLCBjbG9jay5taW51dGUsIHpvbmUpO1xuICAgICAgICBjb25zdCBjYW5kaWRhdGUgPSBhdCh5ZWFyKTtcbiAgICAgICAgLy8gTm8geWVhciBpbiB0aGUgbWVzc2FnZSBhbmQgdGhlIGRhdGUgaGFzIHBhc3NlZDogaXQgbWVhbnMgbmV4dCB5ZWFyLlxuICAgICAgICByZXR1cm4gIWRnLnllYXIgJiYgY2FuZGlkYXRlIDwgbm93TXMgLSBEQVlfTVNcbiAgICAgICAgICA/IGF0KHllYXIgKyAxKVxuICAgICAgICAgIDogY2FuZGlkYXRlO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGJhcmUgPSBDTE9DS19SRVNFVF9SRS5leGVjKHRleHQpO1xuICBjb25zdCBiZyA9IGJhcmU/Lmdyb3VwcztcbiAgaWYgKCFiYXJlIHx8ICFiZykgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGNsb2NrID0gbm9ybWFsaXNlQ2xvY2soYmcuaG91ciA/PyBcIlwiLCBiZy5taW51dGUsIGJnLm1lcmlkaWVtKTtcbiAgaWYgKCFjbG9jaykgcmV0dXJuIG51bGw7XG5cbiAgLy8gQnVpbGQgXCJ0b2RheSBhdCBISDpNTVwiIGluIHRoZSB0YXJnZXQgem9uZSwgdGhlbiByb2xsIGZvcndhcmQgaWYgcGFzdC5cbiAgY29uc3Qgem9uZSA9IGV4cGxpY2l0Wm9uZSh0ZXh0LnNsaWNlKGJhcmUuaW5kZXgpKSA/PyBob3N0Wm9uZSgpO1xuICBjb25zdCB0b2RheSA9IHpvbmVXYWxsUGFydHMobm93TXMsIHpvbmUpO1xuICBjb25zdCBjYW5kaWRhdGUgPSB3YWxsQ2xvY2tUb0Vwb2NoTXMoXG4gICAgdG9kYXkueWVhcixcbiAgICB0b2RheS5tb250aCxcbiAgICB0b2RheS5kYXksXG4gICAgY2xvY2suaG91cixcbiAgICBjbG9jay5taW51dGUsXG4gICAgem9uZSxcbiAgKTtcbiAgaWYgKGNhbmRpZGF0ZSA+IG5vd01zKSByZXR1cm4gY2FuZGlkYXRlO1xuICByZXR1cm4gd2FsbENsb2NrVG9FcG9jaE1zKFxuICAgIHRvZGF5LnllYXIsXG4gICAgdG9kYXkubW9udGgsXG4gICAgdG9kYXkuZGF5ICsgMSxcbiAgICBjbG9jay5ob3VyLFxuICAgIGNsb2NrLm1pbnV0ZSxcbiAgICB6b25lLFxuICApO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIE1vZGVsLXVuYXZhaWxhYmxlIGRldGVjdGlvbiAoSXNzdWUgIzI3MjQpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBQYXR0ZXJucyBpbmRpY2F0aW5nIHRoZSByZXF1ZXN0ZWQgbW9kZWwgaXMgdW5hdmFpbGFibGUgb3Igbm90IHBlcm1pdHRlZCDigJRcbiAqIHN1c3BlbmRlZCwgcmV2b2tlZCwgcmVtb3ZlZCwgdW5yZWNvZ25pc2VkLCBvciBhY2Nlc3MtZGVuaWVkIOKAlCBhcyBkaXN0aW5jdFxuICogZnJvbSBhIHRyYW5zaWVudCByYXRlIGxpbWl0LlxuICpcbiAqIFRoZSBtb3RpdmF0aW5nIGluY2lkZW50IChJc3N1ZSAjMjcyNCkgd2FzIHRoZSBleHBvcnQtY29udHJvbCBzdXNwZW5zaW9uIG9mXG4gKiBGYWJsZSA1IC8gTXl0aG9zIDU6IGV2ZXJ5IGBjbGF1ZGUgLS1tb2RlbCBmYWJsZWAgaW52b2NhdGlvbiBiZWdhbiBmYWlsaW5nXG4gKiB3aXRoIGFuIGF2YWlsYWJpbGl0eS9wZXJtaXNzaW9uIGVycm9yIHJhdGhlciB0aGFuIGEgcmF0ZSBsaW1pdCwgc28gdGhlXG4gKiByYXRlLWxpbWl0LW9ubHkgZmFsbGJhY2sgbmV2ZXIgZmlyZWQgYW5kIHRoZSB0b3AgdGllciBjb3VsZCBub3QgZGVncmFkZSB0b1xuICogdGhlIG5leHQtYmVzdCBtb2RlbC4gUmV0cnlpbmcgdGhlIHNhbWUgbW9kZWwgaXMgZnV0aWxlIGhlcmUg4oCUIHRoZSBvbmx5XG4gKiByZWNvdmVyeSBpcyBhIGZhbGxiYWNrIOKAlCBzbyB0aGlzIGlzIGRldGVjdGVkIHNlcGFyYXRlbHkgYW5kIHRyaWdnZXJzIGFuXG4gKiBpbW1lZGlhdGUsIHdhaXQtZnJlZSBkb3duZ3JhZGUuXG4gKlxuICogS2VwdCBkZWxpYmVyYXRlbHkgbmFycm93IHRvIG1vZGVsL2FjY2Vzcy9hdXRob3Jpc2F0aW9uIHBocmFzaW5nIChwbHVzIHRoZVxuICogSFRUUCBgNDAzYC9gZm9yYmlkZGVuYCBzaWduYWxzKSBzbyB1bnJlbGF0ZWQgZmFpbHVyZXMg4oCUIGdpdC9zc2hcbiAqIFwicGVybWlzc2lvbiBkZW5pZWRcIiwgZmlsZXN5c3RlbSBlcnJvcnMg4oCUIGFyZSBub3QgbWlzY2xhc3NpZmllZC4gVGhlIGNvc3Qgb2ZcbiAqIGEgcmFyZSBmYWxzZSBwb3NpdGl2ZSBpcyBib3VuZGVkIGFueXdheTogb25lIHdhc3RlZCByZXRyeSBvbiBhIGNoZWFwZXIgbW9kZWxcbiAqIGJlZm9yZSB0aGUgcnVuIHJldHVybnMgaXRzIGZhaWx1cmUuXG4gKlxuICogSXNzdWUgIzI3MzUgKHBhcmVudCAjMjcyMCwgdGhlIEZhYmxlIGV4cG9ydC1jb250cm9sIHN1c3BlbnNpb24pIGFkZGVkXG4gKiBgcmVzdHJpY3RlZGAvYGV4cG9ydCBjb250cm9sYCB0byB0aGUgbW9kZWwtYWxpYXMgYnJhbmNoIHNvIGV4cG9ydC1jb250cm9sXG4gKiB3b3JkaW5nIHRoYXQgbmFtZXMgdGhlIHRpZXIgd2l0aG91dCBhbiBgYWNjZXNzYC9gdXNlYCBwcmVmaXgg4oCUIGUuZy4gXCJGYWJsZVxuICogaXMgcmVzdHJpY3RlZCBpbiB5b3VyIHJlZ2lvbiBkdWUgdG8gZXhwb3J0IGNvbnRyb2xzXCIg4oCUIHN0aWxsIG1hdGNoZXMgYW5kXG4gKiBkcml2ZXMgdGhlIGltbWVkaWF0ZSBgZmFibGUg4oaSIG9wdXNgIGRvd25ncmFkZS5cbiAqL1xuY29uc3QgTU9ERUxfVU5BVkFJTEFCTEVfUkUgPVxuICAvKD86dW5rbm93bnxpbnZhbGlkfHVuc3VwcG9ydGVkfHVucmVjb2duaVtzel1lZCkgbW9kZWx8bW9kZWxbXlxcbl17MCw0MH0oPzpub3QgYXZhaWxhYmxlfHVuYXZhaWxhYmxlfG5vdCBmb3VuZHxubyBsb25nZXIgYXZhaWxhYmxlfG5vdCBzdXBwb3J0ZWR8aXMgZGlzYWJsZWR8YmVlbiBkaXNhYmxlZCl8KD86YWNjZXNzfHVzZSlbXlxcbl17MCw0MH0oPzpzdXNwZW5kZWR8cmV2b2tlZHxkaXNhYmxlZHxub3QgcGVybWl0dGVkfHJlc3RyaWN0ZWQpfCg/OmZhYmxlfG9wdXN8c29ubmV0fGhhaWt1KVteXFxuXXswLDQwfSg/OnN1c3BlbmRlZHxyZXZva2VkfGRpc2FibGVkfG5vdCBhdmFpbGFibGV8dW5hdmFpbGFibGV8bm90IHBlcm1pdHRlZHxyZXN0cmljdGVkfGV4cG9ydCBjb250cm9sKXxub3QgYXV0aG9yaVtzel1lZCB0byAoPzp1c2V8YWNjZXNzKXxkbyg/OmVzKT8gbm90IGhhdmUgYWNjZXNzfFxcYmZvcmJpZGRlblxcYnxcXGI0MDNcXGIvaTtcblxuLyoqXG4gKiBDaGVjayBpZiB0aGUgdGFpbCBvZiBvdXRwdXQgaW5kaWNhdGVzIHRoZSByZXF1ZXN0ZWQgbW9kZWwgaXMgdW5hdmFpbGFibGUgb3JcbiAqIG5vdCBwZXJtaXR0ZWQgKGFzIG9wcG9zZWQgdG8gcmF0ZS1saW1pdGVkKS5cbiAqXG4gKiBPbmx5IGNoZWNrcyB0aGUgbGFzdCBOIGxpbmVzIOKAlCBsaWtlIHtAbGluayBkZXRlY3RSYXRlTGltaXR9IOKAlCBzbyB0aGF0IENsYXVkZVxuICogbWVyZWx5IGRpc2N1c3NpbmcgbW9kZWwgYXZhaWxhYmlsaXR5IGVhcmxpZXIgaW4gYW4gb3RoZXJ3aXNlLXN1Y2Nlc3NmdWwgcnVuXG4gKiBkb2VzIG5vdCB0cmlnZ2VyIGEgZmFsc2UgcG9zaXRpdmUgKHRoaXMgaXMgb25seSBjb25zdWx0ZWQgb24gYSBub24temVyb1xuICogZXhpdCwgd2hlcmUgdGhlIHRhaWwgaXMgdGhlIENMSSdzIG93biBlcnJvcikuXG4gKlxuICogQHBhcmFtIG91dHB1dCAtIFRoZSBvdXRwdXQgdGV4dCB0byBzY2FuXG4gKiBAcGFyYW0gdGFpbExpbmVzIC0gTnVtYmVyIG9mIGxpbmVzIGZyb20gdGhlIGVuZCB0byBjaGVjayAoZGVmYXVsdDogMzApXG4gKiBAcmV0dXJucyB0cnVlIGlmIHRoZSBmYWlsdXJlIGxvb2tzIGxpa2UgYSBtb2RlbC11bmF2YWlsYWJsZSAvIG5vdC1wZXJtaXR0ZWQgZXJyb3JcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdE1vZGVsVW5hdmFpbGFibGUoXG4gIG91dHB1dDogc3RyaW5nLFxuICB0YWlsTGluZXM6IG51bWJlciA9IDMwLFxuKTogYm9vbGVhbiB7XG4gIGlmICghb3V0cHV0LnRyaW0oKSkgcmV0dXJuIGZhbHNlO1xuXG4gIGNvbnN0IGxpbmVzID0gb3V0cHV0LnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCB0YWlsID0gbGluZXMuc2xpY2UoLXRhaWxMaW5lcykuam9pbihcIlxcblwiKTtcblxuICByZXR1cm4gTU9ERUxfVU5BVkFJTEFCTEVfUkUudGVzdCh0YWlsKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBJbnZhbGlkLXNlc3Npb24taWQgZGV0ZWN0aW9uIChJc3N1ZSAjMjA0KVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogVGhlIENsYXVkZSBDTEkncyByZWZ1c2FsIG9mIHRoZSBzZXNzaW9uIGZsYWdzIGl0IHdhcyBnaXZlbi5cbiAqXG4gKiBUd28gc2hhcGVzLCBib3RoIHN0YXJ0LXVwIGZhaWx1cmVzIOKAlCB0aGUgcHJvY2VzcyBleGl0cyB+MC4yIHMgYWZ0ZXIgc3Bhd24sXG4gKiBiZWZvcmUgaXQgZXZlciByZWFjaGVzIGEgbW9kZWwgY2FsbDpcbiAqXG4gKiAtIGBFcnJvcjogSW52YWxpZCBzZXNzaW9uIElELiBNdXN0IGJlIGEgdmFsaWQgVVVJRC5gIOKAlCB0aGUgaWQgaXRzZWxmXG4gKiAgIChJc3N1ZSAjMjA0KTtcbiAqIC0gYEVycm9yOiAtLXNlc3Npb24taWQgY2FuIG9ubHkgYmUgdXNlZCB3aXRoIC0tY29udGludWUgb3IgLS1yZXN1bWUgaWZcbiAqICAgLS1mb3JrLXNlc3Npb24gaXMgYWxzbyBzcGVjaWZpZWQuYCDigJQgdGhlIGZsYWcgcGFpcmluZyAoSXNzdWUgIzE1ODAsXG4gKiAgIENsYXVkZSBDb2RlIDIuMS4yNjEpLiBUaGUgd29ya2VyIG5vIGxvbmdlciBzZW5kcyB0aGF0IHBhaXJpbmcsIGJ1dCBhXG4gKiAgIHJlZnVzYWwgb2YgdGhlIGZsYWdzIGlzIHN0aWxsIHRoZSBmbGFncycgZmF1bHQsIGFuZCB0aGUgcmVtZWR5IGlzIHRoZVxuICogICBzYW1lOiBkcm9wIHRoZW0gYW5kIHJldHJ5IG9uY2UsIGxvdWRseTtcbiAqIC0gYEVycm9yOiAtLXJlc3VtZSByZXF1aXJlcyBhIHZhbGlkIHNlc3Npb24gSUQgb3Igc2Vzc2lvbiB0aXRsZSB3aGVuIHVzZWRcbiAqICAgd2l0aCAtLXByaW50LmAg4oCUIHdoYXQgMi4xLjI2MSBhY3R1YWxseSBwcmludHMgZm9yIGEgbm9uLVVVSUQgaWRcbiAqICAgKElzc3VlICMxNjk1LCByZWNvcmRlZCBpblxuICogICBgdGVzdHMvZml4dHVyZXMvYWdlbnRfb3V0cHV0L2NsYXVkZS0yLjEuMjYxLWludmFsaWQtc2Vzc2lvbi5zdGRlcnJgKS5cbiAqICAgTm9uZSBvZiB0aGUgYXJtcyBhYm92ZSBtYXRjaGVkIGl0LCBzbyB0aGUgcmVjb3JkZWQgcmVmdXNhbCB3YXMgcmVhY2hpbmdcbiAqICAgdGhlIG9yZGluYXJ5IGZhaWx1cmUgcGF0aCBpbnN0ZWFkIG9mIGRyb3BwaW5nIHRoZSBmbGFncy5cbiAqXG4gKiBBbmNob3JlZCB0byBzZXNzaW9uLWlkIHBocmFzaW5nIHNvIGFuIHVucmVsYXRlZCBcImludmFsaWRcIiAoYSBiYWQgbW9kZWxcbiAqIGFsaWFzLCBhIGdpdCByZWZlcmVuY2UpIGNhbm5vdCBtYXRjaDogZHJvcHBpbmcgdGhlIHNlc3Npb24gZmxhZ3Mgd291bGRcbiAqIHNpbGVudGx5IGRpc2NhcmQgY29udGludWl0eSBpZiBpdCBmaXJlZCBvbiB0aGUgd3JvbmcgZmFpbHVyZS5cbiAqL1xuY29uc3QgSU5WQUxJRF9TRVNTSU9OX0lEX1JFID1cbiAgL2ludmFsaWQgc2Vzc2lvbiBpZHxzZXNzaW9uIGlkW15cXG5dezAsNDB9bXVzdCBiZVteXFxuXXswLDIwfXV1aWR8LS1zZXNzaW9uLWlkIGNhbiBvbmx5IGJlIHVzZWQgd2l0aHwtLXJlc3VtZSByZXF1aXJlcyBhIHZhbGlkIHNlc3Npb258bm8gY29udmVyc2F0aW9uIGZvdW5kIHdpdGggc2Vzc2lvbiBpZC9pO1xuXG4vKipcbiAqIFRoZSBDTEkgYWJvcnRpbmcgYmVjYXVzZSBpdHMgYXV0b2NvbXBhY3Rpb24gY2Fubm90IGtlZXAgdGhlIGNvbnRleHQgdW5kZXJcbiAqIHRoZSB3aW5kb3cgKElzc3VlICM0MTQ3KS4gT24gYSByZXN1bWVkIHNlc3Npb24gdGhhdCBpcyB0aGUgaW5oZXJpdGVkXG4gKiB0cmFuc2NyaXB0J3Mgc2l6ZSwgbm90IHRoZSB0YXNrJ3MsIHNvIGEgZnJlc2ggc2Vzc2lvbiBjYW4gc3RpbGwgZG8gdGhlXG4gKiB3b3JrLlxuICovXG5jb25zdCBBVVRPQ09NUEFDVF9USFJBU0hfUkUgPSAvYXV0b2NvbXBhY3QgaXMgdGhyYXNoaW5nL2k7XG5cbi8qKlxuICogQ2hlY2sgaWYgdGhlIHRhaWwgb2Ygb3V0cHV0IGluZGljYXRlcyB0aGUgQ0xJIHJlamVjdGVkIHRoZSBzZXNzaW9uIGlkLlxuICpcbiAqIFRhaWwtc2NvcGVkIGxpa2Uge0BsaW5rIGRldGVjdE1vZGVsVW5hdmFpbGFibGV9IOKAlCBvbmx5IGNvbnN1bHRlZCBvbiBhXG4gKiBub24temVybyBleGl0LCB3aGVyZSB0aGUgdGFpbCBpcyB0aGUgQ0xJJ3Mgb3duIGVycm9yLlxuICpcbiAqIEBwYXJhbSBvdXRwdXQgLSBUaGUgb3V0cHV0IHRleHQgdG8gc2NhbiAoc3Rkb3V0IGFuZCBzdGRlcnIpXG4gKiBAcGFyYW0gdGFpbExpbmVzIC0gTnVtYmVyIG9mIGxpbmVzIGZyb20gdGhlIGVuZCB0byBjaGVjayAoZGVmYXVsdDogMzApXG4gKiBAcmV0dXJucyB0cnVlIGlmIHRoZSBmYWlsdXJlIGlzIGEgcmVqZWN0ZWQgYC0tc2Vzc2lvbi1pZGBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdEludmFsaWRTZXNzaW9uSWQoXG4gIG91dHB1dDogc3RyaW5nLFxuICB0YWlsTGluZXM6IG51bWJlciA9IDMwLFxuKTogYm9vbGVhbiB7XG4gIGlmICghb3V0cHV0LnRyaW0oKSkgcmV0dXJuIGZhbHNlO1xuXG4gIGNvbnN0IGxpbmVzID0gb3V0cHV0LnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCB0YWlsID0gbGluZXMuc2xpY2UoLXRhaWxMaW5lcykuam9pbihcIlxcblwiKTtcblxuICByZXR1cm4gSU5WQUxJRF9TRVNTSU9OX0lEX1JFLnRlc3QodGFpbCk7XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgdGhlIHRhaWwgb2Ygb3V0cHV0IHNob3dzIGEgcmVzdW1lZCBzZXNzaW9uIGNhbm5vdCBjYXJyeSB0aGUgcnVuOlxuICogdGhlIENMSSByZWZ1c2VkIG9yIGNvdWxkIG5vdCBmaW5kIGl0ICh7QGxpbmsgZGV0ZWN0SW52YWxpZFNlc3Npb25JZH0pLCBvclxuICogdGhlIGluaGVyaXRlZCB0cmFuc2NyaXB0IHRocmFzaGVkIGF1dG9jb21wYWN0aW9uIChJc3N1ZSAjNDE0NykuIEVpdGhlciB3YXlcbiAqIG5vIG1vZGVsIGRpZCB0aGUgdGFzaydzIHdvcmssIGFuZCBhIGZyZXNoIHNlc3Npb24gY2FuLlxuICpcbiAqIEBwYXJhbSBvdXRwdXQgLSBUaGUgb3V0cHV0IHRleHQgdG8gc2NhbiAoc3Rkb3V0IGFuZCBzdGRlcnIpXG4gKiBAcGFyYW0gdGFpbExpbmVzIC0gTnVtYmVyIG9mIGxpbmVzIGZyb20gdGhlIGVuZCB0byBjaGVjayAoZGVmYXVsdDogMzApXG4gKiBAcmV0dXJucyB0cnVlIGlmIHJldHJ5aW5nIHdpdGhvdXQgdGhlIHNlc3Npb24gZmxhZ3MgaXMgdGhlIHJlbWVkeVxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0UmVzdW1lZFNlc3Npb25VbnVzYWJsZShcbiAgb3V0cHV0OiBzdHJpbmcsXG4gIHRhaWxMaW5lczogbnVtYmVyID0gMzAsXG4pOiBib29sZWFuIHtcbiAgaWYgKGRldGVjdEludmFsaWRTZXNzaW9uSWQob3V0cHV0LCB0YWlsTGluZXMpKSByZXR1cm4gdHJ1ZTtcbiAgY29uc3QgdGFpbCA9IG91dHB1dC5zcGxpdChcIlxcblwiKS5zbGljZSgtdGFpbExpbmVzKS5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gQVVUT0NPTVBBQ1RfVEhSQVNIX1JFLnRlc3QodGFpbCk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gT3V0LW9mLW1lbW9yeSBkZXRlY3Rpb24gKElzc3VlICMyNzQwLCBwYXJlbnQgIzI3MjEpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBQYXR0ZXJucyBpbmRpY2F0aW5nIGEgTm9kZS9WOCBoZWFwLWV4aGF1c3Rpb24gKG91dC1vZi1tZW1vcnkpIGZhaWx1cmUuXG4gKlxuICogVGhlIENsYXVkZSBDTEkgcnVucyBvbiBOb2RlLCBzbyBhIFY4IGhlYXAgT09NIHByaW50cyBsaW5lcyBzdWNoIGFzXG4gKiBcIi4uLm5lYXIgaGVhcCBsaW1pdCAuLi4gSmF2YVNjcmlwdCBoZWFwIG91dCBvZiBtZW1vcnlcIi4gVGhlIHdvcmQgXCJsaW1pdFwiIGluXG4gKiBcImhlYXAgbGltaXRcIiBtYXRjaGVzIHRoZSBzZWNvbmRhcnkgcmF0ZS1saW1pdCByZWdleCBpbiB7QGxpbmsgZGV0ZWN0UmF0ZUxpbWl0fVxuICogKGAvKHRyeSBhZ2FpbnxyZXRyeXxsaW1pdCkvaWApLCBzbyBhbiBPT00gaXMgY3VycmVudGx5IG1pc3Rha2VuIGZvciBhIHJhdGVcbiAqIGxpbWl0IGFuZCB0aGUgcnVuIHdhaXRzLWFuZC1yZXRyaWVzIGluc3RlYWQgb2YgZmFpbGluZyBmYXN0LiBPT00gbXVzdFxuICogdGhlcmVmb3JlIGJlIGNsYXNzaWZpZWQgc2VwYXJhdGVseSBmcm9tIHJhdGUgbGltaXRzIGFuZCB0aW1lb3V0cy5cbiAqXG4gKiBLZXB0IGRlbGliZXJhdGVseSBuYXJyb3cgYW5kIGFuY2hvcmVkIHRvIG1lbW9yeSBwaHJhc2luZyDigJQgZm9sbG93aW5nIHRoZVxuICogcHJlY2VkZW50IG9mIHRoZSBuYXJyb3cge0BsaW5rIE1PREVMX1VOQVZBSUxBQkxFX1JFfSDigJQgc28gdW5yZWxhdGVkIG91dHB1dFxuICogKGEgdGFzayB0aGF0IG1lcmVseSBtZW50aW9ucyBcIm1lbW9yeVwiKSBpcyBub3QgbWlzY2xhc3NpZmllZC4gVGhlIGdlbmVyaWNcbiAqIFwib3V0IG9mIG1lbW9yeVwiIGJyYW5jaCBpcyB3b3JkLWJvdW5kZWQgZm9yIHRoZSBzYW1lIHJlYXNvbi5cbiAqL1xuY29uc3QgT1VUX09GX01FTU9SWV9SRSA9XG4gIC9qYXZhc2NyaXB0IGhlYXAgb3V0IG9mIG1lbW9yeXxyZWFjaGVkIGhlYXAgbGltaXQgYWxsb2NhdGlvbiBmYWlsZWR8aW5lZmZlY3RpdmUgbWFyay1jb21wYWN0cyBuZWFyIGhlYXAgbGltaXR8ZmF0YWwgZXJyb3I6W15cXG5dKmhlYXB8Y2Fubm90IGFsbG9jYXRlIG1lbW9yeXxzdGQ6OmJhZF9hbGxvY3xcXGJvdXQgb2YgbWVtb3J5XFxiL2k7XG5cbi8qKlxuICogQ2hlY2sgaWYgdGhlIHRhaWwgb2Ygb3V0cHV0IGluZGljYXRlcyBhbiBvdXQtb2YtbWVtb3J5IChoZWFwLWV4aGF1c3Rpb24pXG4gKiBmYWlsdXJlLlxuICpcbiAqIE9ubHkgY2hlY2tzIHRoZSBsYXN0IE4gbGluZXMg4oCUIGxpa2Uge0BsaW5rIGRldGVjdFJhdGVMaW1pdH0gYW5kXG4gKiB7QGxpbmsgZGV0ZWN0TW9kZWxVbmF2YWlsYWJsZX0g4oCUIHNvIHRoYXQgYW4gaW4tcnVuIGRpc2N1c3Npb24gb2YgXCJtZW1vcnlcIlxuICogZWFybGllciBpbiBhbiBvdGhlcndpc2Utc3VjY2Vzc2Z1bCBydW4gY2Fubm90IHRyaWdnZXIgYSBmYWxzZSBwb3NpdGl2ZS5cbiAqXG4gKiBAcGFyYW0gb3V0cHV0IC0gVGhlIG91dHB1dCB0ZXh0IHRvIHNjYW5cbiAqIEBwYXJhbSB0YWlsTGluZXMgLSBOdW1iZXIgb2YgbGluZXMgZnJvbSB0aGUgZW5kIHRvIGNoZWNrIChkZWZhdWx0OiAzMClcbiAqIEByZXR1cm5zIHRydWUgaWYgdGhlIGZhaWx1cmUgbG9va3MgbGlrZSBhbiBvdXQtb2YtbWVtb3J5IGVycm9yXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3RPdXRPZk1lbW9yeShcbiAgb3V0cHV0OiBzdHJpbmcsXG4gIHRhaWxMaW5lczogbnVtYmVyID0gMzAsXG4pOiBib29sZWFuIHtcbiAgaWYgKCFvdXRwdXQudHJpbSgpKSByZXR1cm4gZmFsc2U7XG5cbiAgY29uc3QgbGluZXMgPSBvdXRwdXQuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IHRhaWwgPSBsaW5lcy5zbGljZSgtdGFpbExpbmVzKS5qb2luKFwiXFxuXCIpO1xuXG4gIHJldHVybiBPVVRfT0ZfTUVNT1JZX1JFLnRlc3QodGFpbCk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQ2xhdWRlIG1vZGVsIGFyZ3Ncbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIE1vZHVsZS1sZXZlbCBjb25maWctYmFzZWQgcGhhc2UgbW9kZWwgb3ZlcnJpZGVzIChJc3N1ZSAjMTI2NSkuXG4gKlxuICogU2V0IHZpYSBzZXRQaGFzZU1vZGVsQ29uZmlnT3ZlcnJpZGVzKCkgZHVyaW5nIGNvbmZpZyBsb2FkaW5nLlxuICogVGhlc2UgdGFrZSBwcmVjZWRlbmNlIG92ZXIgUEhBU0VfTU9ERUxfREVGQVVMVFMgYnV0IGFyZSBvdmVycmlkZGVuXG4gKiBieSBlbnZpcm9ubWVudCB2YXJpYWJsZXMuXG4gKi9cbmxldCBfcGhhc2VNb2RlbENvbmZpZ092ZXJyaWRlczogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4gPSB7fTtcblxuLyoqXG4gKiBTZXQgY29uZmlnLWJhc2VkIHBoYXNlIG1vZGVsIG92ZXJyaWRlcyAoSXNzdWUgIzEyNjUpLlxuICpcbiAqIENhbGxlZCBkdXJpbmcgY29uZmlnIGxvYWRpbmcgdG8gYXBwbHkgcGhhc2VfbW9kZWxfb3ZlcnJpZGVzIGZyb21cbiAqIC5jb25maWcuanNvbi4gVGhlc2Ugb3ZlcnJpZGUgdGhlIGhhcmRjb2RlZCBQSEFTRV9NT0RFTF9ERUZBVUxUU1xuICogYnV0IGFyZSB0aGVtc2VsdmVzIG92ZXJyaWRkZW4gYnkgZW52aXJvbm1lbnQgdmFyaWFibGVzLlxuICpcbiAqIEBwYXJhbSBvdmVycmlkZXMgLSBQaGFzZS10by1tb2RlbCBtYXBwaW5nIGZyb20gY29uZmlnIGZpbGVcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldFBoYXNlTW9kZWxDb25maWdPdmVycmlkZXMoXG4gIG92ZXJyaWRlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcbik6IHZvaWQge1xuICBfcGhhc2VNb2RlbENvbmZpZ092ZXJyaWRlcyA9IHsgLi4ub3ZlcnJpZGVzIH07XG59XG5cbi8qKlxuICogQWN0aXZlIHBlci1yZXBvIG1vZGVsL2VmZm9ydCByb3V0aW5nIG92ZXJyaWRlcyAoSXNzdWUgIzI2MjUpLlxuICpcbiAqIFNldCB2aWEgc2V0QWN0aXZlUmVwb01vZGVsRWZmb3J0T3ZlcnJpZGVzKCkgd2hlbiB0aGUgd29ya2VyIGJlZ2luc1xuICogcHJvY2Vzc2luZyBhIHJlcG8gYW5kIHJlcGxhY2VkIChvciBjbGVhcmVkKSBvbiBldmVyeSByZXBvIHN3aXRjaCwgc28gYVxuICogaGlnaC12YWx1ZSByZXBvJ3MgcHJlbWl1bSByb3V0aW5nIG5ldmVyIGxlYWtzIGludG8gYSBmaWxsZXIgcmVwby5cbiAqXG4gKiBUaGVzZSBzaXQgYmV0d2VlbiB0aGUgb3BlcmF0b3IgZXNjYXBlLWhhdGNoIGVudiB2YXJzIChoaWdoZXN0KSBhbmQgdGhlXG4gKiBnbG9iYWwgY29uZmlnIC8gYnVpbHQtaW4gZGVmYXVsdHMgKGxvd2VzdCkg4oCUIHNlZSBidWlsZENsYXVkZU1vZGVsQXJncyBhbmRcbiAqIGJ1aWxkQ2xhdWRlRWZmb3J0QXJncyBmb3IgdGhlIGZ1bGwgcHJlY2VkZW5jZSBjaGFpbi5cbiAqL1xubGV0IF9yZXBvQ2xhdWRlTW9kZWwgPSBcIlwiO1xubGV0IF9yZXBvUGhhc2VNb2RlbE92ZXJyaWRlczogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4gPSB7fTtcbmxldCBfcmVwb1BoYXNlRWZmb3J0T3ZlcnJpZGVzOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiA9IHt9O1xuXG4vKipcbiAqIERlc2NyaWJlIHdoaWNoIGJ1aWx0LWluIHBlci1waGFzZSBtb2RlbCBkZWZhdWx0cyBhIHBlci1yZXBvIGBjbGF1ZGVfbW9kZWxgXG4gKiBiYXNlIHRpZXIgb3ZlcnJpZGVzIChJc3N1ZSAjMjcxNiwgYXVkaXQgIzI3MDIgRjIvRjMpLlxuICpcbiAqIFRoZSBiYXNlIHRpZXIgc2l0cyBhYm92ZSBgUEhBU0VfTU9ERUxfREVGQVVMVFNgIGluIHRoZSBwcmVjZWRlbmNlIGNoYWluLCBzb1xuICogc2V0dGluZyBpdCBzaWxlbnRseSByZXJvdXRlcyBldmVyeSBwaGFzZSB0aGF0IGhhcyBpdHMgb3duIGRlZmF1bHQg4oCUIGRlbW90aW5nXG4gKiBgcGxhbm5pbmdgL2BncmlsbF9tZWAgb2ZmIHRoZSBGYWJsZSB0b3AgdGllciB3aGVuIHRoZSBiYXNlIGlzIGNoZWFwZXIsIGFuZFxuICogcHJvbW90aW5nIHRoZSB0cml2aWFsIEhhaWt1IHBoYXNlcyAoYHNwZWxsaW5nX2ZpeGAvYHN1bW1hcmlzZWAvYGhlYWx0aGApIG9mZlxuICogSGFpa3Ugd2hlbiB0aGUgYmFzZSBpcyBgZmFibGVgICh+NcOXIHRoZWlyIGludGVuZGVkIGNvc3QpLiBUaGlzIGJ1aWxkcyBhXG4gKiBvbmUtbGluZSwgaHVtYW4tcmVhZGFibGUgc3VtbWFyeSBvZiB0aG9zZSByZXJvdXRlcyBzbyB0aGUgc3VycHJpc2UgaXMgdmlzaWJsZVxuICogaW4gdGhlIGxvZ3MgcmF0aGVyIHRoYW4gb25seSBpbiB0aGUgY29zdCByZXBvcnQgYWZ0ZXIgdGhlIGZhY3QuXG4gKlxuICogQ29tcGFyaXNvbiBpcyBjYXNlLWluc2Vuc2l0aXZlOyBhIHBoYXNlIHdob3NlIGRlZmF1bHQgYWxyZWFkeSBlcXVhbHMgdGhlIGJhc2VcbiAqIHRpZXIgaXMgbm90IGEgcmVyb3V0ZSBhbmQgaXMgb21pdHRlZC4gUmV0dXJucyBgbnVsbGAgd2hlbiB0aGUgYmFzZSB0aWVyIGlzXG4gKiBlbXB0eSBvciByZXJvdXRlcyBub3RoaW5nLCBzbyB0aGUgY2FsbGVyIGNhbiBzdGF5IHNpbGVudCBpbiB0aGUgY29tbW9uIGNhc2UuXG4gKlxuICogQHBhcmFtIGNsYXVkZU1vZGVsIC0gVGhlIGFjdGl2ZSBwZXItcmVwbyBiYXNlIHRpZXIgKGFsaWFzIG9yIGZ1bGwgbW9kZWwgaWQpLlxuICogQHJldHVybnMgQSBzdW1tYXJ5IG1lc3NhZ2UsIG9yIGBudWxsYCB3aGVuIHRoZXJlIGlzIG5vdGhpbmcgdG8gcmVwb3J0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVzY3JpYmVSZXBvQmFzZVRpZXJPdmVycmlkZShcbiAgY2xhdWRlTW9kZWw6IHN0cmluZyxcbik6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBiYXNlID0gY2xhdWRlTW9kZWwudHJpbSgpO1xuICBpZiAoIWJhc2UpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IGJhc2VMb3dlciA9IGJhc2UudG9Mb3dlckNhc2UoKTtcbiAgY29uc3QgcmVyb3V0ZXM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgW3BoYXNlLCBwaGFzZURlZmF1bHRdIG9mIE9iamVjdC5lbnRyaWVzKFBIQVNFX01PREVMX0RFRkFVTFRTKSkge1xuICAgIGlmIChwaGFzZURlZmF1bHQudG9Mb3dlckNhc2UoKSAhPT0gYmFzZUxvd2VyKSB7XG4gICAgICByZXJvdXRlcy5wdXNoKGAke3BoYXNlfSAoJHtwaGFzZURlZmF1bHR94oaSJHtiYXNlfSlgKTtcbiAgICB9XG4gIH1cbiAgaWYgKHJlcm91dGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cbiAgcmV0dXJuIGBbY2xhdWRlLWV4ZWN1dG9yXSBQZXItcmVwbyBjbGF1ZGVfbW9kZWwgYmFzZSB0aWVyIFwiJHtiYXNlfVwiIGAgK1xuICAgIGBvdmVycmlkZXMgdGhlIGJ1aWx0LWluIHBlci1waGFzZSBtb2RlbCBkZWZhdWx0IGZvciAke3Jlcm91dGVzLmxlbmd0aH0gYCArXG4gICAgYHBoYXNlKHMpOiAke3Jlcm91dGVzLmpvaW4oXCIsIFwiKX0uIFJlLXBpbiBhIHBoYXNlIHdpdGggYSBwZXItcmVwbyBgICtcbiAgICBgcGhhc2VfbW9kZWxfb3ZlcnJpZGUgdG8ga2VlcCBpdCBvbiBpdHMgb3duIHRpZXIgKElzc3VlICMyNzE2KS5gO1xufVxuXG4vKipcbiAqIFNldCB0aGUgYWN0aXZlIHJlcG8ncyBtb2RlbC9lZmZvcnQgcm91dGluZyBvdmVycmlkZXMgKElzc3VlICMyNjI1KS5cbiAqXG4gKiBDYWxsIHRoaXMgb25jZSB3aGVuIHRoZSB3b3JrZXIgc3RhcnRzIHdvcmsgb24gYSByZXBvLCBwYXNzaW5nIHRoZSByZXBvJ3NcbiAqIG1lcmdlZCBSZXBvQ29uZmlnIChvciBgdW5kZWZpbmVkYCB0byBjbGVhcikuIEl0IHJlcGxhY2VzIOKAlCBuZXZlciBtZXJnZXMg4oCUXG4gKiB0aGUgcHJldmlvdXNseS1hY3RpdmUgcmVwbyBvdmVycmlkZXMsIGd1YXJhbnRlZWluZyByb3V0aW5nIG5ldmVyIGxlYWtzXG4gKiBhY3Jvc3MgcmVwb3Mgd2hlbiBvbmUgbG9uZy1ydW5uaW5nIHdvcmtlciBwcm9jZXNzIHNlcnZlcyBzZXZlcmFsIHJlcG9zLlxuICpcbiAqIFdoZW4gdGhlIG5ldyBjb25maWcgY2FycmllcyBhIG5vbi1lbXB0eSBgY2xhdWRlX21vZGVsYCBiYXNlIHRpZXIgdGhhdFxuICogcmVyb3V0ZXMgb25lIG9yIG1vcmUgcGhhc2VzIG9mZiB0aGVpciBgUEhBU0VfTU9ERUxfREVGQVVMVFNgIGVudHJ5LCBhIHNpbmdsZVxuICogaW5mb3JtYXRpb25hbCBsaW5lIGlzIGxvZ2dlZCAoSXNzdWUgIzI3MTYpIHNvIHRoZSBzaWxlbnQgZGVtb3Rpb24vcHJvbW90aW9uXG4gKiBpcyB2aXNpYmxlLiBJdCBpcyBsb2dnZWQgb25jZSBwZXIgcmVwbyBzd2l0Y2gsIG5vdCBwZXIgcGhhc2UuXG4gKlxuICogQHBhcmFtIHJlcG9Db25maWcgLSBUaGUgYWN0aXZlIHJlcG8ncyBSZXBvQ29uZmlnLCBvciB1bmRlZmluZWQgdG8gY2xlYXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRBY3RpdmVSZXBvTW9kZWxFZmZvcnRPdmVycmlkZXMoXG4gIHJlcG9Db25maWc6IFJlcG9Db25maWcgfCB1bmRlZmluZWQsXG4pOiB2b2lkIHtcbiAgX3JlcG9DbGF1ZGVNb2RlbCA9IHJlcG9Db25maWc/LmNsYXVkZU1vZGVsID8/IFwiXCI7XG4gIF9yZXBvUGhhc2VNb2RlbE92ZXJyaWRlcyA9IHsgLi4uKHJlcG9Db25maWc/LnBoYXNlTW9kZWxPdmVycmlkZXMgPz8ge30pIH07XG4gIF9yZXBvUGhhc2VFZmZvcnRPdmVycmlkZXMgPSB7IC4uLihyZXBvQ29uZmlnPy5waGFzZUVmZm9ydE92ZXJyaWRlcyA/PyB7fSkgfTtcblxuICBjb25zdCBiYXNlVGllck5vdGUgPSBkZXNjcmliZVJlcG9CYXNlVGllck92ZXJyaWRlKF9yZXBvQ2xhdWRlTW9kZWwpO1xuICBpZiAoYmFzZVRpZXJOb3RlKSB7XG4gICAgY29uc29sZS5pbmZvKGJhc2VUaWVyTm90ZSk7XG4gIH1cbn1cblxuLyoqIEtub3duIG1vZGVsLXRpZXIgYWxpYXNlcyB0aGUgQ2xhdWRlIENMSSBhY2NlcHRzIChJc3N1ZSAjMjcxMSkuICovXG5jb25zdCBLTk9XTl9NT0RFTF9BTElBU0VTID0gW1wiZmFibGVcIiwgXCJvcHVzXCIsIFwic29ubmV0XCIsIFwiaGFpa3VcIl0gYXMgY29uc3Q7XG5cbi8qKlxuICogQSB2YWx1ZSBpcyBhIHJlY29nbmlzYWJsZSBtb2RlbCBpZiBpdCBpcyBhIGtub3duIHRpZXIgYWxpYXMgb3IgYSBwbGF1c2libGVcbiAqIGZ1bGwgbW9kZWwgaWQgKGBjbGF1ZGUtKmApLiBBbnl0aGluZyBlbHNlIGlzIG1vc3QgbGlrZWx5IGEgdHlwb1xuICogKGBmYWJlbGAsIGBvcHVlYCkg4oCUIHRoZSBDTEkgd291bGQgcmVqZWN0IGl0IGF0IHJ1bnRpbWUgKElzc3VlICMyNzExKS5cbiAqL1xuZnVuY3Rpb24gaXNSZWNvZ25pc2VkTW9kZWwodmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBsb3dlciA9IHZhbHVlLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiAoS05PV05fTU9ERUxfQUxJQVNFUyBhcyByZWFkb25seSBzdHJpbmdbXSkuaW5jbHVkZXMobG93ZXIpIHx8XG4gICAgbG93ZXIuc3RhcnRzV2l0aChcImNsYXVkZS1cIik7XG59XG5cbi8qKlxuICogUmV0dXJuIGEgcmVzb2x2ZWQgbW9kZWwgdmFsdWUsIHdhcm5pbmcgb25jZSB3aGVuIGl0IGlzIG5laXRoZXIgYSBrbm93biBhbGlhc1xuICogbm9yIGEgYGNsYXVkZS0qYCBpZCAoSXNzdWUgIzI3MTEsIGF1ZGl0ICMyNzAyIEYzKS4gVGhlIHZhbHVlIGlzIHN0aWxsXG4gKiBmb3J3YXJkZWQgdmVyYmF0aW0g4oCUIGZ1bGwgbW9kZWwgaWRzIG11c3Qga2VlcCB3b3JraW5nIGFuZCB0aGUgQ0xJIGlzIHRoZVxuICogYXV0aG9yaXR5IOKAlCBidXQgYSB0eXBvIGF0IGFueSBwcmVjZWRlbmNlIGxldmVsIGlzIG5vdyB2aXNpYmxlIGluIHRoZSBsb2dzXG4gKiByYXRoZXIgdGhhbiBzaWxlbnRseSBwcm9kdWNpbmcgYSB3cm9uZyBgLS1tb2RlbGAuXG4gKlxuICogQHBhcmFtIGxldmVsIC0gSHVtYW4tcmVhZGFibGUgcHJlY2VkZW5jZSBsZXZlbCAobmFtZWQgZm9yIHRoZSBsb2cgbWVzc2FnZSkuXG4gKiBAcGFyYW0gdmFsdWUgLSBUaGUgcmVzb2x2ZWQgbW9kZWwgdmFsdWUuXG4gKiBAcmV0dXJucyBUaGUgdmFsdWUsIHVuY2hhbmdlZC5cbiAqL1xuZnVuY3Rpb24gY2hlY2tlZE1vZGVsKGxldmVsOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIWlzUmVjb2duaXNlZE1vZGVsKHZhbHVlKSkge1xuICAgIGNvbnNvbGUud2FybihcbiAgICAgIGBbY2xhdWRlLWV4ZWN1dG9yXSBNb2RlbCBcIiR7dmFsdWV9XCIgcmVzb2x2ZWQgZnJvbSAke2xldmVsfSBpcyBub3QgYSBgICtcbiAgICAgICAgYGtub3duIGFsaWFzICgke0tOT1dOX01PREVMX0FMSUFTRVMuam9pbihcIi9cIil9KSBvciBhIGNsYXVkZS0qIG1vZGVsIGAgK1xuICAgICAgICBgaWQ7IGZvcndhcmRpbmcgdG8gLS1tb2RlbCB2ZXJiYXRpbS4gQ2hlY2sgZm9yIGEgdHlwby5gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIG1vZGVsIENsYXVkZSBydW5zIGEgcGhhc2Ugb24g4oCUIHRoZSB2YWx1ZSBiZWhpbmQgYC0tbW9kZWxgLlxuICpcbiAqIFRoZSBwcm92aWRlciBzZWFtIGluIGBhZ2VudF9wcm92aWRlci50c2AgcmVhY2hlcyByb3V0aW5nIHRocm91Z2ggaGVyZVxuICogKElzc3VlICMzNjIpLCBhbmQge0BsaW5rIGJ1aWxkQ2xhdWRlTW9kZWxBcmdzfSBpcyBhIHRoaW4gYXJndiB3cmFwcGVyIG92ZXJcbiAqIGl0LiBUaGUgc2l4IHN0ZXBzIHRoZW1zZWx2ZXMgbGl2ZSBvbmNlIGluIGBwaGFzZV9yb3V0aW5nLnRzYCAoSXNzdWUgIzM2Myk7XG4gKiB0aGlzIGZ1bmN0aW9uIHN1cHBsaWVzIENsYXVkZSdzIG5hbWVzLCB0YWJsZXMgYW5kIG92ZXJyaWRlIHN0YXRlLlxuICpcbiAqIFByaW9yaXR5IG9yZGVyIChtb3N0IHNwZWNpZmljIHdpbnMg4oCUIElzc3VlICMxMjY1LCAjMTI3MCwgIzI2MjUpOlxuICogICAxLiBQaGFzZS1zcGVjaWZpYyBlbnYgdmFyIChlLmcuIENMQVVERV9NT0RFTF9SRUZJTkVNRU5UKSDigJQgb3BlcmF0b3IgZXNjYXBlIGhhdGNoXG4gKiAgIDIuIFBlci1yZXBvIHBoYXNlX21vZGVsX292ZXJyaWRlcyAoSXNzdWUgIzI2MjUpXG4gKiAgIDMuIFBlci1yZXBvIGNsYXVkZV9tb2RlbCBiYXNlIHRpZXIgKElzc3VlICMyNjI1KSDigJQgYXBwbGllcyB0byBhbGwgcGhhc2VzXG4gKiAgIDQuIEdsb2JhbCBjb25maWcgcGhhc2VfbW9kZWxfb3ZlcnJpZGVzIChJc3N1ZSAjMTI2NSlcbiAqICAgNS4gUGhhc2Utc3BlY2lmaWMgZGVmYXVsdCBmcm9tIFBIQVNFX01PREVMX0RFRkFVTFRTIOKAlCBkZXNpZ25lZCBjb3N0IG9wdGltaXNhdGlvblxuICogICA2LiBCYXNlIENMQVVERV9NT0RFTCBlbnYgdmFyIOKAlCBnbG9iYWwgZmFsbGJhY2sgZm9yIHBoYXNlcyB3aXRob3V0IGEgZGVmYXVsdFxuICpcbiAqIFdoZW4gY2FsbGVkIHdpdGhvdXQgYSBwaGFzZSwgdGhlIHBlci1yZXBvIGJhc2UgdGllciBhbmQgYmFzZSBDTEFVREVfTU9ERUxcbiAqIGVudiB2YXIgYXJlIHN0aWxsIGhvbm91cmVkLlxuICpcbiAqIEEgcmVzb2x2ZWQgdmFsdWUgdGhhdCBpcyBuZWl0aGVyIGEga25vd24gYWxpYXMgbm9yIGEgYGNsYXVkZS0qYCBpZCBlbWl0cyBhXG4gKiBzaW5nbGUgd2FybmluZyBuYW1pbmcgdGhlIGxldmVsIGFuZCB2YWx1ZSAoSXNzdWUgIzI3MTEpIOKAlCB0aGUgdmFsdWUgaXMgc3RpbGxcbiAqIHJldHVybmVkIHZlcmJhdGltIHNvIGZ1bGwgbW9kZWwgaWRzIGtlZXAgd29ya2luZy5cbiAqXG4gKiBAcGFyYW0gcGhhc2UgLSBPcHRpb25hbCBwaGFzZSBuYW1lIChlLmcuLCBcInBsYW5uaW5nXCIpXG4gKiBAcGFyYW0gZW52IC0gRW52aXJvbm1lbnQgbG9va3VwIGZvciBzdGVwcyAxIGFuZCA2IChJc3N1ZSAjOTU3KTsgZGVmYXVsdHMgdG9cbiAqICAgdGhlIHByb2Nlc3MgZW52aXJvbm1lbnQuXG4gKiBAcmV0dXJucyBUaGUgcmVzb2x2ZWQgbW9kZWwgdmFsdWUsIG9yIHVuZGVmaW5lZCB3aGVuIG5vIHN0ZXAgc3VwcGxpZXMgb25lIOKAlFxuICogICB0aGUgQ0xJJ3Mgb3duIGRlZmF1bHQgdGhlbiBzdGFuZHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQ2xhdWRlTW9kZWwoXG4gIHBoYXNlPzogc3RyaW5nLFxuICBlbnY/OiBFbnZMb29rdXAsXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICByZXR1cm4gcmVzb2x2ZVBoYXNlUm91dGVkVmFsdWUoe1xuICAgIGxvZ1ByZWZpeDogXCJjbGF1ZGUtZXhlY3V0b3JcIixcbiAgICB3aGF0OiBcIm1vZGVsXCIsXG4gICAgZmxhZzogXCItLW1vZGVsXCIsXG4gICAgZW52VmFyOiBcIkNMQVVERV9NT0RFTFwiLFxuICAgIGVudixcbiAgICByZXBvUGhhc2VPdmVycmlkZXM6IF9yZXBvUGhhc2VNb2RlbE92ZXJyaWRlcyxcbiAgICByZXBvUGhhc2VPdmVycmlkZXNLZXk6IFwicGhhc2VfbW9kZWxfb3ZlcnJpZGVzXCIsXG4gICAgcmVwb0Jhc2U6IF9yZXBvQ2xhdWRlTW9kZWwsXG4gICAgcmVwb0Jhc2VLZXk6IFwiY2xhdWRlX21vZGVsXCIsXG4gICAgZ2xvYmFsUGhhc2VPdmVycmlkZXM6IF9waGFzZU1vZGVsQ29uZmlnT3ZlcnJpZGVzLFxuICAgIGdsb2JhbFBoYXNlT3ZlcnJpZGVzS2V5OiBcInBoYXNlX21vZGVsX292ZXJyaWRlc1wiLFxuICAgIHBoYXNlRGVmYXVsdHM6IFBIQVNFX01PREVMX0RFRkFVTFRTLFxuICAgIHBoYXNlRGVmYXVsdHNOYW1lOiBcIlBIQVNFX01PREVMX0RFRkFVTFRTXCIsXG4gICAgY2hlY2s6IGNoZWNrZWRNb2RlbCxcbiAgfSwgcGhhc2UpO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBtb2RlbCBhcmd1bWVudHMgZm9yIHRoZSBDbGF1ZGUgQ0xJLlxuICpcbiAqIEEgdGhpbiBhcmd2IHdyYXBwZXIgb3ZlciB7QGxpbmsgcmVzb2x2ZUNsYXVkZU1vZGVsfSwgd2hpY2ggc3RhdGVzIHRoZVxuICogcHJlY2VkZW5jZSBjaGFpbi5cbiAqXG4gKiBAcGFyYW0gcGhhc2UgLSBPcHRpb25hbCBwaGFzZSBuYW1lIChlLmcuLCBcInBsYW5uaW5nXCIpXG4gKiBAcGFyYW0gZW52IC0gRW52aXJvbm1lbnQgbG9va3VwIGZvcndhcmRlZCB0byB0aGUgY2hhaW4gKElzc3VlICM5NTcpLlxuICogQHJldHVybnMgQXJyYXkgb2YgQ0xJIGFyZ3MgKGUuZy4sIFtcIi0tbW9kZWxcIiwgXCJjbGF1ZGUtc29ubmV0LTQtNlwiXSkgb3IgZW1wdHlcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkQ2xhdWRlTW9kZWxBcmdzKFxuICBwaGFzZT86IHN0cmluZyxcbiAgZW52PzogRW52TG9va3VwLFxuKTogc3RyaW5nW10ge1xuICBjb25zdCBtb2RlbCA9IHJlc29sdmVDbGF1ZGVNb2RlbChwaGFzZSwgZW52KTtcbiAgcmV0dXJuIG1vZGVsID8gW1wiLS1tb2RlbFwiLCBtb2RlbF0gOiBbXTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBDbGF1ZGUgZWZmb3J0IGFyZ3MgKElzc3VlICMxNDAzKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogTW9kdWxlLWxldmVsIGNvbmZpZy1iYXNlZCBwaGFzZSBlZmZvcnQgb3ZlcnJpZGVzIChJc3N1ZSAjMTQwMykuXG4gKlxuICogU2V0IHZpYSBzZXRQaGFzZUVmZm9ydENvbmZpZ092ZXJyaWRlcygpIGR1cmluZyBjb25maWcgbG9hZGluZy5cbiAqIFRoZXNlIHRha2UgcHJlY2VkZW5jZSBvdmVyIFBIQVNFX0VGRk9SVF9ERUZBVUxUUyBidXQgYXJlIG92ZXJyaWRkZW5cbiAqIGJ5IGVudmlyb25tZW50IHZhcmlhYmxlcy5cbiAqL1xubGV0IF9waGFzZUVmZm9ydENvbmZpZ092ZXJyaWRlczogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4gPSB7fTtcblxuLyoqXG4gKiBTZXQgY29uZmlnLWJhc2VkIHBoYXNlIGVmZm9ydCBvdmVycmlkZXMgKElzc3VlICMxNDAzKS5cbiAqXG4gKiBDYWxsZWQgZHVyaW5nIGNvbmZpZyBsb2FkaW5nIHRvIGFwcGx5IHBoYXNlX2VmZm9ydF9vdmVycmlkZXMgZnJvbVxuICogLmNvbmZpZy5qc29uLiBUaGVzZSBvdmVycmlkZSB0aGUgaGFyZGNvZGVkIFBIQVNFX0VGRk9SVF9ERUZBVUxUU1xuICogYnV0IGFyZSB0aGVtc2VsdmVzIG92ZXJyaWRkZW4gYnkgZW52aXJvbm1lbnQgdmFyaWFibGVzLlxuICpcbiAqIEBwYXJhbSBvdmVycmlkZXMgLSBQaGFzZS10by1lZmZvcnQgbWFwcGluZyBmcm9tIGNvbmZpZyBmaWxlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRQaGFzZUVmZm9ydENvbmZpZ092ZXJyaWRlcyhcbiAgb3ZlcnJpZGVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxuKTogdm9pZCB7XG4gIF9waGFzZUVmZm9ydENvbmZpZ092ZXJyaWRlcyA9IHsgLi4ub3ZlcnJpZGVzIH07XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgcmVhc29uaW5nIGVmZm9ydCBDbGF1ZGUgcnVucyBhIHBoYXNlIGF0IOKAlCB0aGUgdmFsdWUgYmVoaW5kXG4gKiBgLS1lZmZvcnRgLlxuICpcbiAqIFRoZSBwcm92aWRlciBzZWFtIGluIGBhZ2VudF9wcm92aWRlci50c2AgcmVhY2hlcyByb3V0aW5nIHRocm91Z2ggaGVyZVxuICogKElzc3VlICMzNjIpLCBhbmQge0BsaW5rIGJ1aWxkQ2xhdWRlRWZmb3J0QXJnc30gaXMgYSB0aGluIGFyZ3Ygd3JhcHBlciBvdmVyXG4gKiBpdC4gVGhlIHNpeCBzdGVwcyB0aGVtc2VsdmVzIGxpdmUgb25jZSBpbiBgcGhhc2Vfcm91dGluZy50c2AgKElzc3VlICMzNjMpO1xuICogdGhpcyBmdW5jdGlvbiBzdXBwbGllcyBDbGF1ZGUncyBuYW1lcywgdGFibGVzIGFuZCBvdmVycmlkZSBzdGF0ZS5cbiAqXG4gKiBQcmlvcml0eSBvcmRlciAobW9zdCBzcGVjaWZpYyB3aW5zIOKAlCBJc3N1ZSAjMTQwMywgIzI2MjUpOlxuICogICAxLiBQaGFzZS1zcGVjaWZpYyBlbnYgdmFyIChlLmcuIENMQVVERV9FRkZPUlRfUExBTk5JTkcpIOKAlCBvcGVyYXRvciBlc2NhcGUgaGF0Y2hcbiAqICAgMi4gUGVyLXJlcG8gcGhhc2VfZWZmb3J0X292ZXJyaWRlcyAoSXNzdWUgIzI2MjUpXG4gKiAgIDMuIEdsb2JhbCBjb25maWcgcGhhc2VfZWZmb3J0X292ZXJyaWRlcyAoSXNzdWUgIzE0MDMpXG4gKiAgIDQuIFBoYXNlLXNwZWNpZmljIGRlZmF1bHQgZnJvbSBQSEFTRV9FRkZPUlRfREVGQVVMVFMg4oCUIGRlc2lnbmVkIGNvc3Qgb3B0aW1pc2F0aW9uXG4gKiAgIDUuIEJhc2UgQ0xBVURFX0VGRk9SVCBlbnYgdmFyIOKAlCBnbG9iYWwgZmFsbGJhY2sgZm9yIHBoYXNlcyB3aXRob3V0IGEgZGVmYXVsdFxuICogICA2LiBERUZBVUxUX0VGRk9SVCBjb25zdGFudCDigJQgaGFyZGNvZGVkIGZhbGxiYWNrXG4gKlxuICogRWZmb3J0IGhhcyBubyBwZXItcmVwbyBiYXNlIGVxdWl2YWxlbnQgb2YgYGNsYXVkZV9tb2RlbGAg4oCUIGEgcmVwbyB0dW5lc1xuICogZWZmb3J0IHBlci1waGFzZSBvbmx5LlxuICpcbiAqIFdoZW4gY2FsbGVkIHdpdGhvdXQgYSBwaGFzZSwgb25seSB0aGUgYmFzZSBDTEFVREVfRUZGT1JUIGVudiB2YXIgYW5kXG4gKiBERUZBVUxUX0VGRk9SVCBjb25zdGFudCBhcmUgY2hlY2tlZC5cbiAqXG4gKiBAcGFyYW0gcGhhc2UgLSBPcHRpb25hbCBwaGFzZSBuYW1lIChlLmcuLCBcInBsYW5uaW5nXCIpXG4gKiBAcGFyYW0gZW52IC0gRW52aXJvbm1lbnQgbG9va3VwIGZvciBzdGVwcyAxIGFuZCA1IChJc3N1ZSAjOTU3KTsgZGVmYXVsdHMgdG9cbiAqICAgdGhlIHByb2Nlc3MgZW52aXJvbm1lbnQuXG4gKiBAcmV0dXJucyBUaGUgcmVzb2x2ZWQgZWZmb3J0IHZhbHVlOyBzdGVwIDYgZ3VhcmFudGVlcyBvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQ2xhdWRlRWZmb3J0KFxuICBwaGFzZT86IHN0cmluZyxcbiAgZW52PzogRW52TG9va3VwLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmVQaGFzZVJvdXRlZFZhbHVlKHtcbiAgICBsb2dQcmVmaXg6IFwiY2xhdWRlLWV4ZWN1dG9yXCIsXG4gICAgd2hhdDogXCJlZmZvcnRcIixcbiAgICBmbGFnOiBcIi0tZWZmb3J0XCIsXG4gICAgZW52VmFyOiBcIkNMQVVERV9FRkZPUlRcIixcbiAgICBlbnYsXG4gICAgcmVwb1BoYXNlT3ZlcnJpZGVzOiBfcmVwb1BoYXNlRWZmb3J0T3ZlcnJpZGVzLFxuICAgIHJlcG9QaGFzZU92ZXJyaWRlc0tleTogXCJwaGFzZV9lZmZvcnRfb3ZlcnJpZGVzXCIsXG4gICAgLy8gRWZmb3J0IGhhcyBubyBwZXItcmVwbyBiYXNlIGVxdWl2YWxlbnQgb2YgYGNsYXVkZV9tb2RlbGAuXG4gICAgZ2xvYmFsUGhhc2VPdmVycmlkZXM6IF9waGFzZUVmZm9ydENvbmZpZ092ZXJyaWRlcyxcbiAgICBnbG9iYWxQaGFzZU92ZXJyaWRlc0tleTogXCJwaGFzZV9lZmZvcnRfb3ZlcnJpZGVzXCIsXG4gICAgcGhhc2VEZWZhdWx0czogUEhBU0VfRUZGT1JUX0RFRkFVTFRTLFxuICAgIHBoYXNlRGVmYXVsdHNOYW1lOiBcIlBIQVNFX0VGRk9SVF9ERUZBVUxUU1wiLFxuICAgIC8vIFN0ZXAgNjogdGhlIGhhcmRjb2RlZCBmYWxsYmFjaywgc28gZWZmb3J0IGFsd2F5cyByZXNvbHZlcyB0byBzb21ldGhpbmcuXG4gICAgZmFsbGJhY2s6IERFRkFVTFRfRUZGT1JULFxuICB9LCBwaGFzZSk7XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIGVmZm9ydCBhcmd1bWVudHMgZm9yIHRoZSBDbGF1ZGUgQ0xJLlxuICpcbiAqIEEgdGhpbiBhcmd2IHdyYXBwZXIgb3ZlciB7QGxpbmsgcmVzb2x2ZUNsYXVkZUVmZm9ydH0sIHdoaWNoIHN0YXRlcyB0aGVcbiAqIHByZWNlZGVuY2UgY2hhaW4uXG4gKlxuICogQHBhcmFtIHBoYXNlIC0gT3B0aW9uYWwgcGhhc2UgbmFtZSAoZS5nLiwgXCJwbGFubmluZ1wiKVxuICogQHBhcmFtIGVudiAtIEVudmlyb25tZW50IGxvb2t1cCBmb3J3YXJkZWQgdG8gdGhlIGNoYWluIChJc3N1ZSAjOTU3KS5cbiAqIEByZXR1cm5zIEFycmF5IG9mIENMSSBhcmdzIChlLmcuLCBbXCItLWVmZm9ydFwiLCBcIm1heFwiXSlcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkQ2xhdWRlRWZmb3J0QXJncyhcbiAgcGhhc2U/OiBzdHJpbmcsXG4gIGVudj86IEVudkxvb2t1cCxcbik6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFtcIi0tZWZmb3J0XCIsIHJlc29sdmVDbGF1ZGVFZmZvcnQocGhhc2UsIGVudildO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEV4cGxpY2l0LW92ZXJyaWRlIHByZWRpY2F0ZXMgKElzc3VlICMzMjMxKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogV2hldGhlciBhbiAqKmV4cGxpY2l0Kiogb3BlcmF0b3IgZWZmb3J0IG92ZXJyaWRlIGV4aXN0cyBmb3IgYHBoYXNlYC5cbiAqXG4gKiBcIkV4cGxpY2l0XCIgbWVhbnMgYW55IGVmZm9ydCBzb3VyY2UgaW4ge0BsaW5rIGJ1aWxkQ2xhdWRlRWZmb3J0QXJnc30gKm90aGVyXG4gKiB0aGFuKiB0aGUgZGVzaWduZWQgYFBIQVNFX0VGRk9SVF9ERUZBVUxUU2AgLyBoYXJkY29kZWQgZmFsbGJhY2sg4oCUIGkuZS4gYVxuICogcGVyLXBoYXNlIGVudiB2YXIsIGEgcGVyLXJlcG8gcGhhc2Ugb3ZlcnJpZGUsIGEgZ2xvYmFsIHBoYXNlIG92ZXJyaWRlLCBvciB0aGVcbiAqIGdsb2JhbCBgQ0xBVURFX0VGRk9SVGAgZW52IHZhci4gQ29tcGFuaW9uIHRvIHtAbGluayBoYXNFeHBsaWNpdE1vZGVsT3ZlcnJpZGV9XG4gKiBmb3IgdGhlIHByZS1mbGlnaHQgRmFibGUgcmVyb3V0ZSAoIzMyMzEpLlxuICpcbiAqIEBwYXJhbSBwaGFzZSAtIFRoZSBwaGFzZSBuYW1lICh1bmRlZmluZWQgY2hlY2tzIG9ubHkgdGhlIGdsb2JhbCBlbnYgc291cmNlKS5cbiAqIEBwYXJhbSBlbnYgLSBFbnZpcm9ubWVudCBsb29rdXAgZm9yIHRoZSB0d28gZW52IHNvdXJjZXMgKElzc3VlICM5NTcpO1xuICogICBkZWZhdWx0cyB0byB0aGUgcHJvY2VzcyBlbnZpcm9ubWVudC5cbiAqIEByZXR1cm5zIHRydWUgd2hlbiBhbiBleHBsaWNpdCBlZmZvcnQgb3ZlcnJpZGUgaXMgcHJlc2VudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhc0V4cGxpY2l0RWZmb3J0T3ZlcnJpZGUoXG4gIHBoYXNlPzogc3RyaW5nLFxuICBlbnY6IEVudkxvb2t1cCA9IChuYW1lKSA9PiBEZW5vLmVudi5nZXQobmFtZSksXG4pOiBib29sZWFuIHtcbiAgaWYgKHBoYXNlKSB7XG4gICAgaWYgKGVudihgQ0xBVURFX0VGRk9SVF8ke3BoYXNlLnRvVXBwZXJDYXNlKCl9YCkpIHJldHVybiB0cnVlO1xuICAgIGlmIChfcmVwb1BoYXNlRWZmb3J0T3ZlcnJpZGVzW3BoYXNlXSkgcmV0dXJuIHRydWU7XG4gICAgaWYgKF9waGFzZUVmZm9ydENvbmZpZ092ZXJyaWRlc1twaGFzZV0pIHJldHVybiB0cnVlO1xuICB9XG4gIGlmIChlbnYoXCJDTEFVREVfRUZGT1JUXCIpKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRpbWVvdXQgZGlhZ25vc3RpY3MgKElzc3VlICMzMzQpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIFJlc3VsdCBvZiBjYXB0dXJpbmcgdGltZW91dCBkaWFnbm9zdGljcy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgVGltZW91dERpYWdub3N0aWNzIHtcbiAgLyoqIFRoZSBkaWFnbm9zdGljIHJlcG9ydCB0ZXh0LiAqL1xuICByZXBvcnQ6IHN0cmluZztcbiAgLyoqIERldGVjdGVkIGVycm9yIHBhdHRlcm5zLiAqL1xuICBlcnJvclBhdHRlcm5zOiBzdHJpbmdbXTtcbiAgLyoqIE51bWJlciBvZiBsaW5lcyBjYXB0dXJlZCBmcm9tIHRoZSB0YWlsLiAqL1xuICBsaW5lc0NhcHR1cmVkOiBudW1iZXI7XG59XG5cbi8qKlxuICogQ2FwdHVyZSBkaWFnbm9zdGljIGNvbnRleHQgZnJvbSB0aW1lZC1vdXQgcHJvY2VzcyBvdXRwdXQuXG4gKlxuICogUHJlc2VydmVzIHRoZSBsYXN0IE4gbGluZXMgb2Ygb3V0cHV0IGFuZCBhbnkgZGV0ZWN0ZWQgZXJyb3IgcGF0dGVybnNcbiAqIGludG8gYSBkaWFnbm9zdGljIHJlcG9ydC5cbiAqXG4gKiBAcGFyYW0gb3V0cHV0IC0gVGhlIG91dHB1dCBmcm9tIHRoZSB0aW1lZC1vdXQgcHJvY2Vzc1xuICogQHBhcmFtIG9wZXJhdGlvbiAtIEJyaWVmIGRlc2NyaXB0aW9uIG9mIHRoZSBvcGVyYXRpb24gdGhhdCB0aW1lZCBvdXRcbiAqIEBwYXJhbSBkaWFnbm9zdGljTGluZXMgLSBOdW1iZXIgb2YgbGluZXMgdG8gY2FwdHVyZSAoZGVmYXVsdDogNTApXG4gKiBAcmV0dXJucyBEaWFnbm9zdGljIGluZm9ybWF0aW9uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjYXB0dXJlVGltZW91dERpYWdub3N0aWNzKFxuICBvdXRwdXQ6IHN0cmluZyxcbiAgb3BlcmF0aW9uOiBzdHJpbmcgPSBcInVua25vd25cIixcbiAgZGlhZ25vc3RpY0xpbmVzOiBudW1iZXIgPSA1MCxcbik6IFRpbWVvdXREaWFnbm9zdGljcyB7XG4gIGluY3JlbWVudENvdW50ZXIoXCJ0aW1lb3V0c1wiKTtcbiAgLy8gUmVkYWN0ZWQgd2hvbGUsIHRoZW4gY3V0IChJc3N1ZSAjMTI1Nyk6IHRoZSByZXBvcnQgaXMgZW1iZWRkZWQgaW4gdGhlXG4gIC8vIGZhaWx1cmUgY29tbWVudCB0aGUgd29ya2VyIHBvc3RzLCBhbmQgdGhlIGFnZW50J3Mgc3Rkb3V0IGlzIGV4YWN0bHkgd2hlcmVcbiAgLy8gYSBjcmVkZW50aWFsIGl0IGVjaG9lZCB3b3VsZCBzaXQuIEN1dHRpbmcgZmlyc3Qgd291bGQgc3BsaXQgaXQuXG4gIGNvbnN0IHJlZGFjdGVkT3V0cHV0ID0gcmVkYWN0U2VjcmV0cyhvdXRwdXQpO1xuICBjb25zdCBsaW5lcyA9IHJlZGFjdGVkT3V0cHV0LnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCB0YWlsTGluZXMgPSBsaW5lcy5zbGljZSgtZGlhZ25vc3RpY0xpbmVzKTtcbiAgY29uc3QgZXJyb3JQYXR0ZXJucyA9IGV4dHJhY3RFcnJvclBhdHRlcm5zKHJlZGFjdGVkT3V0cHV0KTtcbiAgY29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXG4gIGNvbnN0IHBhcnRzID0gW1xuICAgIFwiPT09IFRpbWVvdXQgRGlhZ25vc3RpYyBDb250ZXh0ID09PVwiLFxuICAgIGBPcGVyYXRpb246ICR7b3BlcmF0aW9ufWAsXG4gICAgYFRpbWVzdGFtcDogJHt0aW1lc3RhbXB9YCxcbiAgICBgRGlhZ25vc3RpYyBsaW5lczogJHtkaWFnbm9zdGljTGluZXN9YCxcbiAgICBcIlwiLFxuICAgIGAtLS0gTGFzdCAke2RpYWdub3N0aWNMaW5lc30gbGluZXMgb2Ygb3V0cHV0IC0tLWAsXG4gICAgLi4udGFpbExpbmVzLFxuICAgIFwiXCIsXG4gIF07XG5cbiAgaWYgKGVycm9yUGF0dGVybnMubGVuZ3RoID4gMCkge1xuICAgIHBhcnRzLnB1c2goXCItLS0gRGV0ZWN0ZWQgZXJyb3IgcGF0dGVybnMgLS0tXCIpO1xuICAgIHBhcnRzLnB1c2goLi4uZXJyb3JQYXR0ZXJucyk7XG4gICAgcGFydHMucHVzaChcIlwiKTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgcmVwb3J0OiBwYXJ0cy5qb2luKFwiXFxuXCIpLFxuICAgIGVycm9yUGF0dGVybnMsXG4gICAgbGluZXNDYXB0dXJlZDogdGFpbExpbmVzLmxlbmd0aCxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7OztDQWFDLEdBRUQsU0FDRSxjQUFjLEVBQ2QscUJBQXFCLEVBQ3JCLG9CQUFvQixRQUNmLHVCQUF1QjtBQUM5QixTQUFTLGdCQUFnQixRQUFRLGdDQUFnQztBQUNqRSxTQUFTLGFBQWEsUUFBUSx3QkFBd0I7QUFFdEQsU0FBUyx1QkFBdUIsUUFBUSxxQkFBcUI7QUFNN0QsU0FBUyxvQkFBb0IsUUFBUSxvQkFBb0I7QUFFekQsaURBQWlELEdBQ2pELE9BQU8sTUFBTSxvQkFBb0IsSUFBSTtBQUVyQzs7Ozs7Ozs7O0NBU0MsR0FDRCxPQUFPLE1BQU0sZ0JBQWdCLElBQUk7QUFFakMsMkRBQTJELEdBQzNELE1B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
// denoCacheMetadata=17544125297163593029,4126472006581022579