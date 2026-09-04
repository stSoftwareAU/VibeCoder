/**
 * Issue #949: a dropped packet on the first GitHub call must not end the run.
 *
 * Resolving the authenticated user is the first GitHub call a run makes,
 * seconds after the container starts, and it had no retry. On a host behind
 * an intermittent link — a laptop on a mobile hotspot, which is an ordinary
 * unattended-host condition — that cost an hour of fleet time in one
 * afternoon:
 *
 * ```text
 * GITHUB-USER-FAILED: Could not resolve authenticated GitHub user
 * [02:10:59Z] ERROR: gh could not resolve the authenticated user:
 *   Get "https://api.github.com/user": dial tcp 4.237.22.34:443: i/o timeout
 * loop.sh: ./run.sh exited with status 1 — backing off and retrying
 * Sleeping 960s...
 * ```
 *
 * Five launches died that way in a row while the host itself resolved
 * `api.github.com` in 0.17s throughout. One dropped second earned sixteen
 * minutes of doing nothing.
 *
 * The two properties pull against each other, and both are pinned here: a
 * transient fault must be ridden out, while a broken credential must fail
 * **immediately**, because only a human can fix that one and the log is how
 * they find out. Retrying an auth error for minutes would bury the message
 * that matters.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { resolveGithubUserWithRetry } from "../lib/github_user_resolution.ts";
import type { Result } from "../types.ts";

/** The error the fleet actually saw, verbatim. */
const DIAL_TIMEOUT =
  'Failed to get GitHub user: Get "https://api.github.com/user": ' +
  "dial tcp 4.237.22.34:443: i/o timeout";

const ok = (login: string): Result<string> => ({ ok: true, value: login });
const fails = (message: string): Result<string> => ({
  ok: false,
  error: new Error(message),
});

/** A probe that returns each scripted result in turn, and counts calls. */
function scripted(results: Result<string>[]) {
  const calls = { count: 0 };
  const getUser = () => {
    const result = results[Math.min(calls.count, results.length - 1)];
    calls.count += 1;
    return Promise.resolve(result as Result<string>);
  };
  return { getUser, calls };
}

/** Records the delays asked for instead of waiting them out. */
function recordingSleep() {
  const slept: number[] = [];
  return {
    slept,
    sleepFn: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

Deno.test("github user - a timeout that clears is ridden out (Issue #949)", async () => {
  // The exact scenario: the link is down when the container comes up and
  // back moments later. This run should start, not sleep for 960s.
  const { getUser, calls } = scripted([
    fails(DIAL_TIMEOUT),
    fails(DIAL_TIMEOUT),
    ok("vibe-worker"),
  ]);
  const { slept, sleepFn } = recordingSleep();

  const outcome = await resolveGithubUserWithRetry({ getUser, sleepFn });

  assertEquals(outcome.ok, true);
  if (outcome.ok) {
    assertEquals(outcome.login, "vibe-worker");
    assertEquals(outcome.attempts, 3);
  }
  assertEquals(calls.count, 3);
  assertEquals(slept.length, 2);
});

Deno.test("github user - a healthy host pays nothing (Issue #949)", async () => {
  // The cost of the ladder when it is not needed has to be zero, or it is a
  // tax on every start.
  const { getUser, calls } = scripted([ok("vibe-worker")]);
  const { slept, sleepFn } = recordingSleep();

  const outcome = await resolveGithubUserWithRetry({ getUser, sleepFn });

  assertEquals(outcome.ok, true);
  assertEquals(calls.count, 1);
  assertEquals(slept, []);
});

Deno.test("github user - a link that never returns reports network, not fatal (Issue #949)", async () => {
  // The classification is what lets the supervisor re-probe soon instead of
  // serving the long backoff meant for a host that needs a human.
  const { getUser, calls } = scripted([fails(DIAL_TIMEOUT)]);
  const { sleepFn } = recordingSleep();

  const outcome = await resolveGithubUserWithRetry({
    getUser,
    sleepFn,
    attempts: 4,
  });

  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.kind, "network");
    assertEquals(outcome.attempts, 4);
  }
  assertEquals(calls.count, 4);
});

Deno.test("github user - a bad credential fails on the first attempt (Issue #949)", async () => {
  // Retrying this would delay by minutes the one message a human must read.
  const { getUser, calls } = scripted([
    fails("Failed to get GitHub user: HTTP 401: Bad credentials"),
  ]);
  const { slept, sleepFn } = recordingSleep();

  const outcome = await resolveGithubUserWithRetry({ getUser, sleepFn });

  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.kind, "fatal");
    assertEquals(outcome.attempts, 1);
  }
  assertEquals(calls.count, 1);
  assertEquals(slept, []);
});

Deno.test("github user - an empty login is fatal, not retried (Issue #949)", async () => {
  // `gh` answered; it simply had no login to give. That is not a blip.
  const { getUser, calls } = scripted([ok("")]);
  const { slept, sleepFn } = recordingSleep();

  const outcome = await resolveGithubUserWithRetry({ getUser, sleepFn });

  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.kind, "fatal");
    assertEquals(outcome.reason, "gh returned an empty login");
    assertEquals(outcome.attempts, 1);
  }
  assertEquals(calls.count, 1);
  assertEquals(slept, []);
});

Deno.test("github user - the delay doubles and starts small (Issue #949)", async () => {
  // Small because a healthy host answers in under a second, so the ladder
  // must not add perceptible latency to a start that was going to work.
  const { getUser } = scripted([fails(DIAL_TIMEOUT)]);
  const { slept, sleepFn } = recordingSleep();

  await resolveGithubUserWithRetry({
    getUser,
    sleepFn,
    attempts: 4,
    initialDelayMs: 2_000,
  });

  assertEquals(slept, [2_000, 4_000, 8_000]);
});

Deno.test("github user - each retried attempt is reported (Issue #949)", async () => {
  // Silence for minutes looks identical to a hang. The operator sees the
  // link being waited on.
  const { getUser } = scripted([fails(DIAL_TIMEOUT), ok("vibe-worker")]);
  const { sleepFn } = recordingSleep();
  const notices: string[] = [];

  await resolveGithubUserWithRetry({
    getUser,
    sleepFn,
    onRetry: (attempt, attempts, reason) =>
      notices.push(`${attempt}/${attempts} ${reason}`),
  });

  assertEquals(notices.length, 1);
  assertEquals(notices[0]?.startsWith("1/4 "), true);
});
