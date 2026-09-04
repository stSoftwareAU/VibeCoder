/**
 * Resolving the authenticated GitHub user, tolerantly (Issue #949).
 *
 * This is the **first** GitHub call a run makes, and it decided whether the
 * run happened at all. It had no retry. On a host whose link comes and goes
 * — a laptop on a mobile hotspot, which is a normal unattended-host
 * condition rather than an exceptional one — that cost an hour of fleet time
 * in a single afternoon:
 *
 * ```text
 * [02:09:50Z] INFO: [run-worker] run mode: container
 * GITHUB-USER-FAILED: Could not resolve authenticated GitHub user
 * [02:10:59Z] ERROR: [run-worker] gh could not resolve the authenticated user:
 *   Get "https://api.github.com/user": dial tcp 4.237.22.34:443: i/o timeout
 * loop.sh: ./run.sh exited with status 1 — backing off and retrying
 * Sleeping 960s...
 * ```
 *
 * Five launches in a row died that way while the host itself resolved
 * `api.github.com` in 0.17s throughout. One dropped second earned sixteen
 * minutes of doing nothing.
 *
 * Two properties matter here and they pull in opposite directions. A
 * transient fault must not end the run — but a genuinely broken credential
 * must not be retried for minutes before saying so, because only a human can
 * fix it and the log is how they find out. So the retry is conditional on
 * the error being network-class, judged by the same {@link isRetryableError}
 * the rest of the worker uses, and an auth failure still fails on the first
 * attempt exactly as before.
 *
 * The ladder is deliberately short in delay and small in attempts. A healthy
 * host answers in well under a second, so the delays cost nothing when
 * things work; when they do not, each attempt already carries `gh`'s own
 * timeout (~69s observed), and the point is to outlast a blip, not to wait
 * out an outage.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { Result } from "../types.ts";
import { getGithubUser } from "./claude_runner.ts";
import { isRetryableError } from "./retry.ts";

/** How the resolution ended, so the caller can choose an exit code. */
export type GithubUserOutcome =
  | { ok: true; login: string; attempts: number }
  | {
    ok: false;
    /**
     * `network` when every attempt failed on a retryable, network-class
     * error — the run could not start, but nothing is wrong with this host
     * that waiting will not fix. `fatal` for anything else: an empty login,
     * a bad credential, a `gh` that will not run.
     */
    kind: "network" | "fatal";
    reason: string;
    attempts: number;
  };

/** Injection points. Production passes none of them. */
export interface ResolveGithubUserOptions {
  /** The probe. Defaults to the real `getGithubUser`. */
  getUser?: () => Promise<Result<string>>;
  /** Sleep between attempts. Injected so tests do not wait. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Told about each failed attempt that will be retried. */
  onRetry?: (
    attempt: number,
    attempts: number,
    reason: string,
    delayMs: number,
  ) => void;
  /** Total attempts, including the first. */
  attempts?: number;
  /** Delay before the second attempt; doubles thereafter. */
  initialDelayMs?: number;
}

/**
 * Marker the run prints when it could not reach GitHub at all.
 *
 * The supervisor's backoff reads the launch log, so this is how a failure
 * that only a working link can fix is told apart from one that needs a
 * human. Matched by `isNetworkUnavailableLaunch`; changing the text without
 * changing that is caught by `container_restart_backoff_network_test.ts`.
 */
export const NETWORK_UNAVAILABLE_MARKER = "VIBE-NETWORK-UNAVAILABLE";

/** Attempts, including the first. */
export const DEFAULT_ATTEMPTS = 4;

/** Delay before the second attempt, in milliseconds. */
export const DEFAULT_INITIAL_DELAY_MS = 2_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolve the authenticated GitHub user, retrying network-class failures.
 *
 * Retries only while the error is retryable: a non-retryable failure — a bad
 * token, an empty login — returns `fatal` on the first attempt, so the
 * operator who has to act sees it immediately rather than four attempts
 * later.
 */
export async function resolveGithubUserWithRetry(
  options: ResolveGithubUserOptions = {},
): Promise<GithubUserOutcome> {
  const getUser = options.getUser ?? getGithubUser;
  const sleepFn = options.sleepFn ?? defaultSleep;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;

  let delayMs = initialDelayMs;
  let reason = "";
  let retryable = false;
  // The attempts actually made, so a fatal failure on the first try reports
  // 1 rather than the ladder's length.
  let made = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    made = attempt;
    const result = await getUser();
    if (result.ok && result.value) {
      return { ok: true, login: result.value, attempts: attempt };
    }
    // An empty login is not a network fault — `gh` answered, with nothing.
    // Retrying it would delay a message only a human can act on.
    reason = result.ok ? "gh returned an empty login" : result.error.message;
    retryable = !result.ok && isRetryableError(result.error.message);
    if (!retryable || attempt === attempts) break;
    options.onRetry?.(attempt, attempts, reason, delayMs);
    await sleepFn(delayMs);
    delayMs *= 2;
  }

  return {
    ok: false,
    kind: retryable ? "network" : "fatal",
    reason,
    attempts: made,
  };
}
