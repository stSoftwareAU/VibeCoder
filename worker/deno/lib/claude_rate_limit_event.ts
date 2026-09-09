/**
 * Parse the Claude CLI's stream-json `rate_limit_event` (Issue #1666).
 *
 * The usage-limit detector historically read only assistant prose and stderr.
 * `extractStreamJsonText` keeps `result` / `assistant` lines and drops
 * everything else, so a structured event on the same stdout the runner tees
 * to the agent jsonl was invisible — the call then walked the short-backoff
 * ladder against an exhausted window.
 *
 * This module is the other half of that signal: every well-formed event
 * becomes a value a consumer can treat like a {@link ClaudeTokenBudgetWindow}
 * probe result (`remainingFraction = 1 - utilization`, `resetAt` in epoch
 * milliseconds). Malformed lines are skipped, never thrown on — a corrupt
 * stream must not take the runner down with it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type {
  ClaudeBudgetWindowName,
  ClaudeTokenBudgetWindow,
} from "./claude_token_budget.ts";

/** Window names the usage-limit path cares about. */
const USAGE_LIMIT_WINDOW_NAMES: readonly ClaudeBudgetWindowName[] = [
  "five_hour",
  "seven_day",
];

/** One parsed `rate_limit_event` from the CLI stream. */
export interface ClaudeRateLimitEvent {
  readonly status: string;
  readonly rateLimitType: string;
  /** `rate_limit_info.resetsAt` converted to epoch milliseconds. */
  readonly resetsAtEpochMs: number;
  /** Windows from `unifiedWindows`, in the same shape as a budget probe. */
  readonly windows: readonly ClaudeTokenBudgetWindow[];
}

/**
 * True when the event is a subscription-window refusal: `status` is
 * `rejected` and the type is the five-hour or seven-day window. Other
 * rejections (for example a tokens-per-minute cap) are not usage limits.
 */
export function isUsageLimitRejection(event: ClaudeRateLimitEvent): boolean {
  return event.status === "rejected" &&
    (event.rateLimitType === "five_hour" ||
      event.rateLimitType === "seven_day");
}

/**
 * Parse every well-formed `rate_limit_event` line out of raw stream-json.
 *
 * Lines that are not JSON, not this type, or missing the fields the usage
 * path needs (`status`, `rateLimitType`, numeric `resetsAt`) are skipped.
 */
export function parseRateLimitEvents(
  rawStreamJson: string,
): ClaudeRateLimitEvent[] {
  const events: ClaudeRateLimitEvent[] = [];
  for (const line of rawStreamJson.split("\n")) {
    const parsed = parseOneEvent(line);
    if (parsed) events.push(parsed);
  }
  return events;
}

function parseOneEvent(line: string): ClaudeRateLimitEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const record = asRecord(json);
  if (record === null || record.type !== "rate_limit_event") return null;
  const info = asRecord(record.rate_limit_info);
  if (info === null) return null;
  if (
    typeof info.status !== "string" || typeof info.rateLimitType !== "string"
  ) {
    return null;
  }
  const resetsAtEpochMs = epochSecondsToMs(info.resetsAt);
  if (resetsAtEpochMs === null) return null;
  return {
    status: info.status,
    rateLimitType: info.rateLimitType,
    resetsAtEpochMs,
    windows: parseUnifiedWindows(info.unifiedWindows),
  };
}

function parseUnifiedWindows(raw: unknown): ClaudeTokenBudgetWindow[] {
  const record = asRecord(raw);
  if (record === null) return [];
  const windows: ClaudeTokenBudgetWindow[] = [];
  for (const window of USAGE_LIMIT_WINDOW_NAMES) {
    const parsed = parseOneWindow(window, record[window]);
    if (parsed) windows.push(parsed);
  }
  return windows;
}

function parseOneWindow(
  window: ClaudeBudgetWindowName,
  raw: unknown,
): ClaudeTokenBudgetWindow | null {
  const record = asRecord(raw);
  if (record === null) return null;
  if (
    typeof record.utilization !== "number" ||
    !Number.isFinite(record.utilization)
  ) {
    return null;
  }
  const resetAt = epochSecondsToMs(record.resetsAt);
  if (resetAt === null) return null;
  return {
    window,
    remainingFraction: 1 - record.utilization,
    resetAt,
  };
}

function epochSecondsToMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value * 1000;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
