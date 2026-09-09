/**
 * Codex budget telemetry: the verified sources, and the parsers for them
 * (Issue #1697, parent #1694).
 *
 * Claude's budget comes from `anthropic-ratelimit-*` response headers on a
 * `POST /v1/messages` probe (`claude_token_budget.ts`). **None of that
 * transfers.** Codex is a different vendor with a different credential, a
 * different header family and a different quota model, so this module states
 * what was actually confirmed against the CLI this image pins — Codex
 * `0.147.0`, `container/tools.json` — and parses only those shapes.
 *
 * ## What was verified, and how
 *
 * The Codex CLI is not installed in the worker's own container (a default
 * image is Claude-only), so the verification is a **source reading of the
 * pinned release** — `openai/codex` at tag `rust-v0.147.0`, the exact tag
 * `container/providers/codex.sh` downloads and checksums — rather than
 * captured live output. Every claim below cites the file it came from, so a
 * version bump can re-check it. `docs/CODEX-BUDGET-SOURCES.md` is the long
 * form.
 *
 * - **`codex exec --json` carries no quota at all.** Under `--json` the exec
 *   front end emits `ThreadEvent` (`codex-rs/exec/src/exec_events.rs`):
 *   `thread.started`, `turn.started`, `turn.completed`, `turn.failed`,
 *   `item.*` and `error`. There is no `rate_limits` field anywhere in that
 *   enum — the rate-limit-bearing `token_count` event belongs to the internal
 *   `EventMsg` protocol, which `--json` does not print. Parsing the worker's
 *   existing Codex stdout for quota would therefore find nothing, for ever.
 * - **The rollout session file does carry it.** `should_persist_event_msg`
 *   (`codex-rs/rollout/src/policy.rs`) returns `true` for
 *   `EventMsg::TokenCount(_)`, and `TokenCountEvent`
 *   (`codex-rs/protocol/src/protocol.rs`) is
 *   `{ info, rate_limits: Option<RateLimitSnapshot> }`. Rollout lines are
 *   written to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`
 *   (`codex-rs/rollout/src/recorder.rs`) as
 *   `{"timestamp":…,"type":"event_msg","payload":{"type":"token_count",…}}`
 *   — `RolloutLine` flattens `RolloutItem`, which is
 *   `#[serde(tag = "type", content = "payload", rename_all = "snake_case")]`.
 *   **This is the budget source**: a file the CLI already wrote during a run
 *   the worker already paid for, so reading it consumes no quota whatsoever.
 * - **`RateLimitWindow` is a percentage, not a fraction.** `used_percent` is
 *   documented in `protocol.rs` as "Percentage (0-100) of the window that has
 *   been consumed", `window_minutes` as "Rolling window duration, in
 *   minutes", and `resets_at` as "Unix timestamp (**seconds** since epoch)".
 *   Hence the `* 1000` in {@link parseCodexRateLimitSnapshot} — this repo's
 *   `resetEpochMs` convention is milliseconds.
 * - **Exhaustion arrives as prose, and its reset time is unparseable.**
 *   A 429 becomes `CodexErrorDetails::UsageLimitReached`, whose `Display`
 *   (`codex-rs/protocol/src/error.rs`) renders the reset through
 *   `format_retry_timestamp` — `resets_at.with_timezone(&Local)` formatted
 *   `%-I:%M %p`, or `%b %-d…, %Y %-I:%M %p` on another day. That is the
 *   *host's* local time, with no offset and no year for a same-day reset, so
 *   it cannot be converted back to an instant. This module therefore records
 *   the exhaustion and its kind and leaves the reset **unknown** rather than
 *   guessing a timezone — see {@link parseCodexExhaustion}.
 * - **There is no retry-after for a caller to read.** `CodexErr` carries a
 *   `retry_delay: Option<Duration>`, but it drives the CLI's *own* retry loop
 *   and is never serialised: `ThreadErrorEvent`, the only error shape `--json`
 *   emits, is `{ message: String }` and nothing else.
 *
 * ## What was rejected, and why
 *
 * - **Claude's OAuth usage endpoint and `anthropic-ratelimit-*` headers.**
 *   Different vendor; not tried, not assumed.
 * - **Browser cookies / a broader OAuth scope.** Neither is a supported Codex
 *   mechanism and both widen the credential blast radius for a number.
 * - **A synthetic prompt to read the quota off the response.** Codex has no
 *   `max_tokens: 0` equivalent that returns headers, so a probe would have to
 *   run a real turn: spending quota to measure quota. Forbidden outright.
 * - **`codex app-server`'s `account/getRateLimits`.** It exists
 *   (`codex-rs/app-server-protocol/src/protocol/v2/account.rs`) and would give
 *   a free reading, but the whole `AppServer` subcommand is marked
 *   `[experimental]` in `codex-rs/cli/src/main.rs` and the request is tagged
 *   `ExperimentalApi`. Wiring an unattended fleet to an experimental JSON-RPC
 *   daemon is a bigger commitment than this issue's read-only adapter, so it
 *   is recorded as the upgrade path, not taken.
 * - **A token count converted to a percentage.** `TokenUsage` describes the
 *   context window, not the subscription window; dividing one by the other
 *   would invent a figure. Absent, never fabricated.
 *
 * Australian English spelling throughout (behaviour, organisation, utilise).
 */

/** Which of the two windows a `RateLimitSnapshot` reports. */
export type CodexBudgetWindowName = "primary" | "secondary";

/**
 * Largest `resets_at` accepted as epoch **seconds** — 2100-01-01T00:00:00Z.
 *
 * A backend that ever sent milliseconds would land far beyond this, and a
 * reset a thousand times too distant reads as "loads of budget left" — the
 * most dangerous possible misreading. Out-of-range values drop the reset and
 * keep the utilisation, rather than fabricating either.
 */
export const MAX_PLAUSIBLE_RESET_EPOCH_SECONDS = 4_102_444_800;

/**
 * Smallest `resets_at` accepted as epoch **seconds** — 2020-01-01T00:00:00Z.
 *
 * Without a floor, a *relative* value — `3600`, the `resets_in_seconds`
 * convention earlier Codex releases used for this very field — passes every
 * other check and becomes a reset instant in 1970: a fabricated rollover
 * silently in the past, which reads as "the window has already reset, go
 * again". Anything below the floor is not an absolute epoch, so the reset is
 * dropped and the utilisation kept.
 */
export const MIN_PLAUSIBLE_RESET_EPOCH_SECONDS = 1_577_836_800;

/** One rolling window, as the pinned CLI reports it. */
export interface CodexBudgetWindow {
  /** Which window this is. */
  readonly window: CodexBudgetWindowName;
  /** Consumed share of the window, `0`–`100`, exactly as reported. */
  readonly usedPercent: number;
  /** Unused share, in `[0, 1]` — `usedPercent` normalised and clamped. */
  readonly remainingFraction: number;
  /** Rolling window duration in minutes, when reported. */
  readonly windowMinutes?: number;
  /** Window rollover in epoch **milliseconds**, when reported and plausible. */
  readonly resetAt?: number;
}

/** Credit state, when the response carried it. Balance is deliberately dropped. */
export interface CodexCreditsState {
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
}

/** Why a Codex budget could not be determined — safe to log verbatim. */
export type CodexBudgetUnknownReason =
  /** No `rate_limits` object, or not an object. */
  | "no-rate-limit-data"
  /** An object was present but no window parsed out of it. */
  | "unrecognised-snapshot-shape"
  /** No rollout session file exists yet for this `CODEX_HOME`. */
  | "no-session-file"
  /** Session files exist but none carries a `token_count` with rate limits. */
  | "no-rate-limit-event"
  /** A session directory or file could not be read. */
  | "read-error"
  /**
   * A transient `429` throttle, which is NOT evidence of a spent window: the
   * pinned CLI words a genuine usage limit as `UsageLimitReached`, so a bare
   * `unexpected status 429` is a per-request throttle and the remaining
   * budget is simply unknown.
   */
  | "transient-rate-limit"
  /**
   * The credential is an API key, so no subscription window exists — spend is
   * bounded by the account's own rate limits and billing, NOT by a weekly
   * allowance the worker could invent.
   */
  | "api-key-account"
  /** The CLI reported an authentication failure (401/403-shaped). */
  | "auth-rejected";

/** A Codex budget that was determined. */
export interface CodexBudgetKnown {
  readonly known: true;
  /** Remaining share of the most constrained window, in `[0, 1]`. */
  readonly remainingFraction: number;
  /**
   * Which window {@link remainingFraction} came from.
   *
   * Absent when no window was reported — an exhaustion message evidences that
   * *a* window is spent without ever naming which, and naming one anyway would
   * be an inference the CLI never made.
   */
  readonly window?: CodexBudgetWindowName;
  /** Rollover of the most constrained window, epoch ms, when reported. */
  readonly resetAt?: number;
  /** Every window parsed, primary first. */
  readonly windows: readonly CodexBudgetWindow[];
  /** Server-side limit family, e.g. `codex`, `codex_secondary`. */
  readonly limitId?: string;
  /** Human limit name when the server named one, e.g. a model-specific limit. */
  readonly limitName?: string;
  /** ChatGPT plan the snapshot was reported under, when present. */
  readonly planType?: string;
  /** Credit state, when present. */
  readonly credits?: CodexCreditsState;
  /**
   * Exhaustion the backend itself declared on this snapshot.
   *
   * `RateLimitSnapshot.rate_limit_reached_type` is machine-readable, carries
   * no timezone and costs nothing to read, so it is better evidence than the
   * prose message — and it arrives on the same rollout line as the
   * percentages.
   */
  readonly rateLimitReachedType?: CodexExhaustionKind;
  /** Backend-reported spend-control state, when it reported one. */
  readonly spendControlReached?: boolean;
}

/** A Codex budget that could not be determined. */
export interface CodexBudgetUnknown {
  readonly known: false;
  /** Which failure occurred. */
  readonly reason: CodexBudgetUnknownReason;
  /** Operator-facing context; never carries a credential. */
  readonly detail?: string;
}

/** The outcome of reading one budget source. */
export type CodexBudget = CodexBudgetKnown | CodexBudgetUnknown;

/**
 * How a run ran out, using the CLI's own vocabulary.
 *
 * `rate_limit_reached`, `workspace_*_credits_depleted` and
 * `workspace_*_usage_limit_reached` are `RateLimitReachedType`'s own
 * `snake_case` names; the remaining three cover the error variants that carry
 * no `RateLimitReachedType` at all.
 */
export type CodexExhaustionKind =
  | "rate_limit_reached"
  | "workspace_credits_depleted"
  | "workspace_spend_cap_reached"
  | "quota_exceeded"
  | "usage_not_included"
  | "http_429";

/** Explicit evidence that a credential is spent, taken from CLI output. */
export interface CodexExhaustion {
  /** Which exhaustion the CLI reported. */
  readonly kind: CodexExhaustionKind;
  /** The specific limit named, when the message named one. */
  readonly limitName?: string;
  /**
   * Always absent, and deliberately so: the CLI renders the reset in the
   * host's local time with no offset (`format_retry_timestamp`), so no instant
   * can be recovered from the message. Callers recheck conservatively instead.
   */
  readonly resetAt?: undefined;
}

/**
 * `RateLimitReachedType`'s own `snake_case` names, mapped to the kinds this
 * module reports. Owner and member differ only in whom the CLI tells to fix
 * it, which is not a distinction a budget cares about.
 */
const REACHED_TYPE_KINDS: Readonly<Record<string, CodexExhaustionKind>> = {
  rate_limit_reached: "rate_limit_reached",
  workspace_owner_credits_depleted: "workspace_credits_depleted",
  workspace_member_credits_depleted: "workspace_credits_depleted",
  workspace_owner_usage_limit_reached: "workspace_spend_cap_reached",
  workspace_member_usage_limit_reached: "workspace_spend_cap_reached",
};

/** Read a finite number from an unknown field, or `undefined`. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Read a non-empty trimmed string from an unknown field, or `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** True for a plain object (and not an array or null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Convert a `resets_at` epoch-seconds field to epoch milliseconds.
 *
 * @param value - The raw `resets_at` field.
 * @returns Epoch milliseconds, or `undefined` when absent, non-integral, or
 *   outside {@link MIN_PLAUSIBLE_RESET_EPOCH_SECONDS} —
 *   {@link MAX_PLAUSIBLE_RESET_EPOCH_SECONDS}.
 */
export function codexResetAtToEpochMs(value: unknown): number | undefined {
  const seconds = finiteNumber(value);
  if (seconds === undefined) return undefined;
  if (!Number.isInteger(seconds)) return undefined;
  if (
    seconds < MIN_PLAUSIBLE_RESET_EPOCH_SECONDS ||
    seconds > MAX_PLAUSIBLE_RESET_EPOCH_SECONDS
  ) {
    return undefined;
  }
  return seconds * 1000;
}

/** Parse one `RateLimitWindow`, or `undefined` when it carries no figure. */
function parseWindow(
  window: CodexBudgetWindowName,
  value: unknown,
): CodexBudgetWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = finiteNumber(value.used_percent);
  if (usedPercent === undefined) return undefined;

  const minutes = finiteNumber(value.window_minutes);
  const windowMinutes = minutes !== undefined && Number.isInteger(minutes) &&
      minutes > 0
    ? minutes
    : undefined;
  const resetAt = codexResetAtToEpochMs(value.resets_at);

  // Clamped: a backend that reports 103% has over-consumed, not gone negative.
  const remainingFraction = Math.min(1, Math.max(0, (100 - usedPercent) / 100));

  return {
    window,
    usedPercent,
    remainingFraction,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

/**
 * Parse a Codex `RateLimitSnapshot` into a budget.
 *
 * The headline `remainingFraction` is the **most constrained** window, not the
 * primary one: a credential whose hourly window is fresh but whose weekly
 * window is at 99% has almost nothing left, and reporting the primary figure
 * would send a run at a credential that stalls on its first turn. Every parsed
 * window is returned so a caller can rank differently without re-reading.
 *
 * @param value - The `rate_limits` object from a `token_count` event, an
 *   `account/getRateLimits` response, or any other source of the same shape.
 * @returns The budget, or an explicit unknown with a safe reason code.
 */
export function parseCodexRateLimitSnapshot(value: unknown): CodexBudget {
  if (!isRecord(value)) {
    return { known: false, reason: "no-rate-limit-data" };
  }

  const windows: CodexBudgetWindow[] = [];
  const primary = parseWindow("primary", value.primary);
  if (primary) windows.push(primary);
  const secondary = parseWindow("secondary", value.secondary);
  if (secondary) windows.push(secondary);

  if (windows.length === 0) {
    return {
      known: false,
      reason: "unrecognised-snapshot-shape",
      detail: "rate_limits carried no parseable primary or secondary window",
    };
  }

  let constrained = windows[0]!;
  for (const window of windows) {
    if (window.remainingFraction < constrained.remainingFraction) {
      constrained = window;
    }
  }

  const creditsRaw = value.credits;
  const credits = isRecord(creditsRaw) &&
      typeof creditsRaw.has_credits === "boolean" &&
      typeof creditsRaw.unlimited === "boolean"
    ? { hasCredits: creditsRaw.has_credits, unlimited: creditsRaw.unlimited }
    : undefined;

  const reachedTypeRaw = nonEmptyString(value.rate_limit_reached_type);
  const rateLimitReachedType = reachedTypeRaw !== undefined
    ? REACHED_TYPE_KINDS[reachedTypeRaw.toLowerCase()]
    : undefined;
  const spendControlReached = typeof value.spend_control_reached === "boolean"
    ? value.spend_control_reached
    : undefined;

  const limitId = nonEmptyString(value.limit_id);
  const limitName = nonEmptyString(value.limit_name);
  const planType = nonEmptyString(value.plan_type);

  return {
    known: true,
    remainingFraction: constrained.remainingFraction,
    window: constrained.window,
    ...(constrained.resetAt !== undefined
      ? { resetAt: constrained.resetAt }
      : {}),
    windows,
    ...(limitId !== undefined ? { limitId } : {}),
    ...(limitName !== undefined ? { limitName } : {}),
    ...(planType !== undefined ? { planType } : {}),
    ...(credits !== undefined ? { credits } : {}),
    ...(rateLimitReachedType !== undefined ? { rateLimitReachedType } : {}),
    ...(spendControlReached !== undefined ? { spendControlReached } : {}),
  };
}

/** One rate-limit reading recovered from a rollout session file. */
export interface CodexRolloutRateLimits {
  /** The rollout line's own `timestamp`, in epoch ms, when parseable. */
  readonly capturedAt?: number;
  /** The parsed budget — known, or an explicit unknown. */
  readonly budget: CodexBudget;
}

/**
 * Extract the rate limits from one line of a rollout session file.
 *
 * Recognises exactly the persisted shape confirmed above — a `RolloutLine`
 * whose flattened `RolloutItem` is `event_msg` carrying a `token_count`
 * `EventMsg`. Every other line (and every unparseable one) answers `null`, so
 * a caller can scan a whole file without a try/catch per line.
 *
 * @param line - One raw JSONL line.
 * @returns The reading, or `null` when the line is not a rate-limit-bearing
 *   `token_count` event.
 */
export function parseCodexRolloutLine(
  line: string,
): CodexRolloutRateLimits | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.type !== "event_msg") return null;

  const payload = parsed.payload;
  if (!isRecord(payload) || payload.type !== "token_count") return null;
  // A `token_count` with `rate_limits: null` (or no such key) is the common
  // case — the CLI emits one per turn and only some carry a snapshot, so that
  // line is simply not a reading. A field that is *present* but the wrong
  // shape is a different thing, and is retained as `no-rate-limit-data`
  // rather than silently skipped.
  const rateLimits = payload.rate_limits;
  if (rateLimits === undefined || rateLimits === null) return null;

  const timestamp = nonEmptyString(parsed.timestamp);
  const capturedAt = timestamp !== undefined
    ? Date.parse(timestamp)
    : Number.NaN;

  return {
    ...(Number.isFinite(capturedAt) ? { capturedAt } : {}),
    budget: parseCodexRateLimitSnapshot(rateLimits),
  };
}

/**
 * Exhaustion wordings, in the order they must be tested.
 *
 * Every pattern is the literal copy from `UsageLimitReachedError`'s `Display`
 * or the neighbouring `CodexErrorDetails` variants, lowercased. The workspace
 * wordings come first because they are more specific than the generic
 * "you've hit your usage limit" prefix that follows them.
 */
const EXHAUSTION_PATTERNS: ReadonlyArray<
  { readonly needle: string; readonly kind: CodexExhaustionKind }
> = [
  { needle: "out of credits", kind: "workspace_credits_depleted" },
  { needle: "spend cap", kind: "workspace_spend_cap_reached" },
  { needle: "you've hit your usage limit", kind: "rate_limit_reached" },
  { needle: "you hit your usage limit", kind: "rate_limit_reached" },
  { needle: "quota exceeded", kind: "quota_exceeded" },
  {
    needle: "to use codex with your chatgpt plan",
    kind: "usage_not_included",
  },
  { needle: "unexpected status 429", kind: "http_429" },
  { needle: "429 too many requests", kind: "http_429" },
];

/**
 * `You've hit your usage limit for <name>. Switch to another model now,…`
 *
 * Lazy up to a full stop **followed by whitespace or the end**, so a limit
 * name containing a dot — `gpt-5.2-codex-sonic`, the shape the pinned CLI's
 * own test uses — is captured whole rather than cut at its first dot.
 */
const LIMIT_NAME_PATTERN = /hit your usage limit for (.+?)\.(?:\s|$)/i;

/**
 * Recognise explicit exhaustion in a Codex `turn.failed` / `error` message.
 *
 * This is the **immediate** evidence path: it needs no probe, costs nothing,
 * and is the only signal the pinned CLI gives an unattended caller at the
 * moment a credential runs out. The reset instant is deliberately not
 * recovered — see {@link CodexExhaustion.resetAt}.
 *
 * @param message - The `message` field of a `turn.failed` or `error` event.
 * @returns The exhaustion, or `null` when the message is an ordinary failure.
 */
export function parseCodexExhaustion(
  message: string,
): CodexExhaustion | null {
  if (typeof message !== "string" || message.trim().length === 0) return null;
  const lower = message.toLowerCase();

  for (const { needle, kind } of EXHAUSTION_PATTERNS) {
    if (!lower.includes(needle)) continue;
    const named = LIMIT_NAME_PATTERN.exec(message);
    const limitName = named ? nonEmptyString(named[1]) : undefined;
    return { kind, ...(limitName !== undefined ? { limitName } : {}) };
  }
  return null;
}
