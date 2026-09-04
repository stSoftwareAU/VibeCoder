/**
 * Remaining-budget probe for one Claude OAuth token (Issue #918, parent #902).
 *
 * When more than one Claude subscription token is configured, the worker wants
 * to start the run on whichever token has the most headroom left. That needs a
 * number per token, and this module is the half that produces it: give it one
 * token, get back either a budget or an explicit "unknown". Ranking across
 * tokens and wiring the winner into startup is #919; discovering the token
 * files is #917. The seam between them is deliberately narrow —
 * {@link probeClaudeTokenBudget} takes a token and returns a value, holds no
 * state, reads no environment and knows nothing about how many tokens exist —
 * so #919 can call it once per token and rank the results.
 *
 * ## What was confirmed against the live API
 *
 * No usage or rate-limit probe existed in this repository, so the endpoint and
 * its response shape were established by calling `api.anthropic.com` directly
 * on 2026-09-04 with a real `CLAUDE_CODE_OAUTH_TOKEN`. What that established:
 *
 * - **`GET /api/oauth/usage` is unusable for this.** The path exists (it
 *   answers, rather than 404s) but a Claude Code OAuth token is refused with
 *   `403 oauth_scope_insufficient`, `required_scopes: user:profile`. A setup
 *   token carries `user:inference` only, so the tidy-looking usage endpoint is
 *   not reachable with the credential the worker actually holds.
 * - **`POST /v1/messages/count_tokens` returns no rate-limit headers.** It
 *   answered `200 {"input_tokens":8}` with not one `anthropic-ratelimit-*`
 *   header, so the free endpoint carries no budget signal.
 * - **`POST /v1/messages` carries the budget in its response headers**, and is
 *   therefore what this probe calls. Confirmed present on a `200`:
 *   `anthropic-ratelimit-unified-5h-utilization: 0.28`,
 *   `anthropic-ratelimit-unified-5h-reset: 1788483600`,
 *   `anthropic-ratelimit-unified-7d-utilization: 0.62`,
 *   `anthropic-ratelimit-unified-7d-reset: 1788829200`,
 *   `anthropic-ratelimit-unified-representative-claim: five_hour`, plus
 *   `-status`, `-reset`, `-fallback-percentage` and the overage pair.
 *   Utilisation is a fraction in `[0, 1]`; each `-reset` is epoch **seconds**
 *   (hence the `* 1000` here, since {@link ClaudeTokenBudgetKnown.resetAt} is
 *   epoch milliseconds, matching `resetEpochMs` in `rate_limit_signal.ts`).
 * - **`max_tokens: 0` is answered `200`** with an empty `content` array and the
 *   full header set. That is what makes the probe affordable: it bills the
 *   handful of input tokens in {@link PROBE_PROMPT} and generates nothing.
 *   A rejected request is not an option — a `401` came back with **zero**
 *   `anthropic-ratelimit-*` headers, so the request has to be a valid one.
 *
 * Anything not on that list is not assumed. If the headers this module looks
 * for are absent or unparseable the answer is
 * `{ known: false, reason: "unrecognised-response-shape" }` — never a
 * fabricated number. That is the same fail-loud rule `provider_token_usage.ts`
 * documents for token counts: an absent figure, never a zero, because a zero
 * that looks authoritative is worse than a gap that admits it is one.
 *
 * ## Which window the headline figure comes from
 *
 * Anthropic reports two windows and names one of them "representative". This
 * module records that claim in {@link ClaudeTokenBudgetKnown.representativeClaim}
 * but reports the **most constrained** window as the headline
 * `remainingFraction`, because either window can block a run: a token whose
 * five-hour window is fresh but whose seven-day window is at 99% has almost no
 * budget left, and ranking it first would pick a token that stalls immediately.
 * Every parsed window is returned in {@link ClaudeTokenBudgetKnown.windows}, so
 * #919 can log them all and can rank differently without another request.
 *
 * ## Cost and blast radius
 *
 * Exactly **one** request per call, bounded by `timeoutMs`, with no retry loop:
 * worker startup must not stall behind an unresponsive endpoint, and a probe
 * that retried would multiply both the delay and the spend. The token value is
 * never returned, logged, interpolated into a message, or thrown — only
 * `label` identifies the token, and every operator-facing string this module
 * produces is scrubbed of the token before it leaves.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  describeFetchFailure,
  discardBody,
  withRequestTimeout,
} from "./bounded_fetch.ts";
import { redactSecrets } from "./secret_redaction.ts";

/** Endpoint whose response headers carry the unified rate-limit figures. */
export const CLAUDE_BUDGET_PROBE_URL = "https://api.anthropic.com/v1/messages";

/**
 * Model named on the probe request.
 *
 * The cheapest model in the family: with `max_tokens: 0` nothing is generated,
 * so the whole cost is the few input tokens of {@link PROBE_PROMPT}. The model
 * choice does not affect the headers — they describe the token's subscription
 * window, not the model.
 */
export const CLAUDE_BUDGET_PROBE_MODEL = "claude-haiku-4-5";

/** Shortest prompt that is still a valid request. */
const PROBE_PROMPT = ".";

/** Beta flag required for OAuth bearer authentication. */
const OAUTH_BETA = "oauth-2025-04-20";

/** Messages API version the probe pins. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Default probe timeout (10s).
 *
 * Deliberately far below `bounded_fetch.ts`'s 30s default: this runs at worker
 * start, before any work happens, and an unreachable endpoint must cost a
 * ranked-last token rather than a stalled startup (Issue #918).
 */
export const DEFAULT_CLAUDE_BUDGET_PROBE_TIMEOUT_MS = 10_000;

/** A rate-limit window Anthropic reports for a subscription token. */
export type ClaudeBudgetWindowName = "five_hour" | "seven_day";

/**
 * Header infix Anthropic uses for each window, and the name it uses for the
 * same window in `anthropic-ratelimit-unified-representative-claim`.
 */
const WINDOW_HEADER_INFIX: ReadonlyArray<
  { readonly window: ClaudeBudgetWindowName; readonly infix: string }
> = [
  { window: "five_hour", infix: "5h" },
  { window: "seven_day", infix: "7d" },
];

/** One window's remaining budget, as reported on this response. */
export interface ClaudeTokenBudgetWindow {
  /** Which window this is. */
  readonly window: ClaudeBudgetWindowName;
  /** Unused share of the window, in `[0, 1]`. */
  readonly remainingFraction: number;
  /** When the window rolls over, in epoch milliseconds. */
  readonly resetAt: number;
}

/**
 * Why a budget could not be determined — short, operator-facing, and safe to
 * log verbatim. `http-<status>` covers every rejected request (`http-401` for
 * a revoked token, `http-429` when the probe itself is throttled).
 */
export type ClaudeTokenBudgetUnknownReason =
  | "missing-token"
  | "timeout"
  | "network-error"
  | "unrecognised-response-shape"
  | `http-${number}`;

/** A token whose remaining budget was determined. */
export interface ClaudeTokenBudgetKnown {
  readonly known: true;
  /** How the token is identified in logs — never the token value. */
  readonly label: string;
  /** Remaining share of the most constrained window, in `[0, 1]`. */
  readonly remainingFraction: number;
  /** Reset of the most constrained window, in epoch milliseconds. */
  readonly resetAt: number;
  /** Which window {@link remainingFraction} came from. */
  readonly window: ClaudeBudgetWindowName;
  /** Every window parsed from the response, in the order reported. */
  readonly windows: readonly ClaudeTokenBudgetWindow[];
  /**
   * The window Anthropic called representative on this response, when it named
   * one this module recognises. Recorded, not obeyed — see the module comment.
   */
  readonly representativeClaim?: ClaudeBudgetWindowName;
}

/** A token whose remaining budget could not be determined. */
export interface ClaudeTokenBudgetUnknown {
  readonly known: false;
  /** How the token is identified in logs — never the token value. */
  readonly label: string;
  /** Which of the failures occurred. */
  readonly reason: ClaudeTokenBudgetUnknownReason;
  /** Extra operator-facing context, scrubbed of the token value. */
  readonly detail?: string;
}

/** The outcome of probing one token. */
export type ClaudeTokenBudget =
  | ClaudeTokenBudgetKnown
  | ClaudeTokenBudgetUnknown;

/** Injected `fetch`, so every test runs offline (Issue #906). */
export type ClaudeBudgetFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** Bounds and injection points for one probe. */
export interface ProbeClaudeTokenBudgetOptions {
  /** How the token is identified in logs — a file stem such as `provider-2`. */
  label: string;
  /** Injected `fetch`; production passes nothing and gets the global. */
  fetchFn?: ClaudeBudgetFetch;
  /** Hard timeout for the single request. */
  timeoutMs?: number;
  /** Endpoint override, for tests that assert what was called. */
  url?: string;
}

/**
 * Remove every occurrence of `token` from `text`.
 *
 * Belt and braces: nothing here interpolates the token in the first place, but
 * a rejected `fetch` hands back a message this module did not compose, and the
 * one thing #902 will not tolerate is a token value reaching a log. Literal
 * removal first (exact, and independent of whether the redaction rules happen
 * to know this credential's shape), then the shared rules for anything else.
 */
function scrub(text: string, token: string): string {
  const withoutToken = token.length > 0
    ? text.split(token).join("[token]")
    : text;
  return redactSecrets(withoutToken);
}

/** Parse a `[0, 1]` utilisation header, or null when it is not one. */
function parseUtilisation(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

/** Parse an epoch-seconds reset header into epoch milliseconds, or null. */
function parseResetMs(raw: string | null): number | null {
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

/** Read the window Anthropic named representative, when it named a known one. */
function parseRepresentativeClaim(
  headers: Headers,
): ClaudeBudgetWindowName | undefined {
  const raw = headers.get("anthropic-ratelimit-unified-representative-claim")
    ?.trim();
  if (raw === "five_hour" || raw === "seven_day") return raw;
  return undefined;
}

/**
 * Pull every well-formed window out of the response headers.
 *
 * A window contributes only when **both** its utilisation and its reset parse:
 * half a window is a shape we do not recognise, not a budget to guess at.
 */
function parseWindows(headers: Headers): ClaudeTokenBudgetWindow[] {
  const windows: ClaudeTokenBudgetWindow[] = [];
  for (const { window, infix } of WINDOW_HEADER_INFIX) {
    const utilisation = parseUtilisation(
      headers.get(`anthropic-ratelimit-unified-${infix}-utilization`),
    );
    const resetAt = parseResetMs(
      headers.get(`anthropic-ratelimit-unified-${infix}-reset`),
    );
    if (utilisation === null || resetAt === null) continue;
    windows.push({ window, remainingFraction: 1 - utilisation, resetAt });
  }
  return windows;
}

/**
 * The window that limits the token: least remaining, soonest reset on a tie.
 *
 * Ties are broken towards the sooner reset so the figure describes the wall the
 * run hits first, matching the tie-break #919 applies across tokens.
 */
function mostConstrained(
  windows: readonly ClaudeTokenBudgetWindow[],
): ClaudeTokenBudgetWindow | undefined {
  let best: ClaudeTokenBudgetWindow | undefined;
  for (const candidate of windows) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    if (candidate.remainingFraction < best.remainingFraction) best = candidate;
    else if (
      candidate.remainingFraction === best.remainingFraction &&
      candidate.resetAt < best.resetAt
    ) best = candidate;
  }
  return best;
}

/** The request body: valid, minimal, and generating nothing. */
function probeBody(): string {
  return JSON.stringify({
    model: CLAUDE_BUDGET_PROBE_MODEL,
    max_tokens: 0,
    messages: [{ role: "user", content: PROBE_PROMPT }],
  });
}

/**
 * Probe one Claude OAuth token's remaining budget with exactly one request.
 *
 * Never throws and never retries: every failure — a rejected `fetch`, a
 * timeout, a non-2xx status, headers that do not carry the figures — comes
 * back as `{ known: false, reason }` naming which one occurred, so a token that
 * could not be measured ranks last rather than blocking startup.
 *
 * Only OAuth subscription tokens are in scope (#902): an `ANTHROPIC_API_KEY`
 * would need `x-api-key` rather than the bearer header sent here, and stays on
 * the single-credential path.
 *
 * @param token - The OAuth token's value; never returned, logged or thrown
 * @param options - Label, and the injected bounds this probe runs under
 * @returns The token's remaining budget, or an explicit unknown with a reason
 */
export async function probeClaudeTokenBudget(
  token: string,
  options: ProbeClaudeTokenBudgetOptions,
): Promise<ClaudeTokenBudget> {
  const { label } = options;
  const timeoutMs = options.timeoutMs ??
    DEFAULT_CLAUDE_BUDGET_PROBE_TIMEOUT_MS;
  const fetchFn = options.fetchFn ??
    ((url: string, init: RequestInit) => globalThis.fetch(url, init));
  const url = options.url ?? CLAUDE_BUDGET_PROBE_URL;

  // An empty credential file is a configuration fault, not a budget of zero.
  if (token.trim().length === 0) {
    return { known: false, label, reason: "missing-token" };
  }

  let response: Response;
  try {
    response = await fetchFn(
      url,
      withRequestTimeout({
        method: "POST",
        headers: {
          "authorization": `Bearer ${token}`,
          "anthropic-beta": OAUTH_BETA,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: probeBody(),
      }, timeoutMs),
    );
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      known: false,
      label,
      reason: timedOut ? "timeout" : "network-error",
      detail: scrub(describeFetchFailure(error, timeoutMs), token),
    };
  }

  // The body is never read — the budget is in the headers — so cancel it
  // rather than leave a server streaming into a connection we are done with.
  try {
    await discardBody(response);

    if (!response.ok) {
      return { known: false, label, reason: `http-${response.status}` };
    }

    const windows = parseWindows(response.headers);
    const headline = mostConstrained(windows);
    if (headline === undefined) {
      return {
        known: false,
        label,
        reason: "unrecognised-response-shape",
        detail: "no anthropic-ratelimit-unified-* window headers were present",
      };
    }

    const claim = parseRepresentativeClaim(response.headers);
    return {
      known: true,
      label,
      remainingFraction: headline.remainingFraction,
      resetAt: headline.resetAt,
      window: headline.window,
      windows,
      ...(claim !== undefined ? { representativeClaim: claim } : {}),
    };
  } catch (error: unknown) {
    // A malformed Response (a header bag that throws, a body that will not
    // cancel) must not escape as an exception: #919 ranks unknowns, it does
    // not catch them.
    return {
      known: false,
      label,
      reason: "unrecognised-response-shape",
      detail: scrub(
        error instanceof Error ? error.message : String(error),
        token,
      ),
    };
  }
}
