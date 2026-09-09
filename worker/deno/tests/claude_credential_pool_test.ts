/**
 * Tests for lib/claude_credential_pool.ts — the process-wide Claude
 * credential pool (Issue #1668, parent #1653).
 *
 * What was missing: the run measured its tokens once at start and never again,
 * so a subscription that ran out part-way through took the retry ladder and
 * failed the run while another token in the pool sat untouched, and no log
 * line said which candidates existed or why one was chosen. The pool keeps a
 * per-token budget snapshot, refreshes only what has gone stale, applies
 * #1623's ranking and #1685's five-hour guard on demand, and replaces the
 * run's single exported token when asked.
 *
 * Each test below pins a rule that would degrade silently rather than fail
 * visibly if it regressed:
 *
 * - an exhaustion recorded from a usage-limit result makes that token
 *   ineligible with **no** probe — the figures are already known;
 * - a stale snapshot costs exactly one probe per stale candidate, even when
 *   two selections run concurrently;
 * - exhaustion is applied on `selectEligible` (0% five-hour loses to 60%),
 *   and every candidate is logged whichever way the decision goes;
 * - with every token under the five-hour guard but none exhausted,
 *   `selectEligible` still names one (Issue #1685) — it refuses only when
 *   every candidate is exhausted, while `selectToken`, which starts the run,
 *   never refuses at all;
 * - `applySelection` leaves exactly ONE Claude token variable in the
 *   environment, carrying the new value (Issue #919's guarantee);
 * - a single-token host makes no request and logs nothing at all.
 *
 * Every test injects `fetchFn`, the clock and the token list, so nothing here
 * touches the network, the filesystem, a clock or the process environment.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CLAUDE_BUDGET_SNAPSHOT_MAX_AGE_MS,
  createClaudeCredentialPool,
} from "../lib/claude_credential_pool.ts";
import { CLAUDE_FIVE_HOUR_GUARD_MIN_REMAINING } from "../lib/claude_token_selection.ts";
import type { ProviderTokenFile } from "../lib/credential_preflight.ts";
import {
  type AgentProviderDescriptor,
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";

/** A fixed "now" for every test — 2026-09-09T00:00:00Z. */
const NOW = Date.UTC(2026, 8, 9, 0, 0, 0);

/** One hour, in milliseconds. */
const HOUR = 3_600_000;

const CLAUDE: AgentProviderDescriptor = resolveAgentProvider(
  CLAUDE_PROVIDER_ID,
);

/** A discovered pool token file, with the value tests probe against. */
function tokenFile(
  label: string,
  overrides: Partial<ProviderTokenFile> = {},
): ProviderTokenFile {
  const name = "CLAUDE_CODE_OAUTH_TOKEN";
  const value = `token-${label}`;
  return {
    label,
    path: `/creds/claude/${label}.env`,
    name,
    value,
    primary: label === "provider",
    poolMember: true,
    entries: [{ name, value }],
    ...overrides,
  };
}

/** Remaining shares one fake response reports, per window. */
interface FakeBudget {
  fiveHourRemaining: number;
  fiveHourResetAt: number;
  sevenDayRemaining: number;
  sevenDayResetAt: number;
}

/**
 * A `fetch` that answers each token value with fixed window figures, and
 * counts the requests it was asked to make.
 *
 * @param byToken - Figures keyed by the token value the request carries.
 * @param gate - Resolved before any response is returned, so a test can hold
 *   every probe open while a second selection runs.
 */
function fetchWith(
  byToken: Record<string, FakeBudget>,
  gate: Promise<void> = Promise.resolve(),
) {
  const labels: string[] = [];
  const fn = async (_url: string, init: RequestInit) => {
    const auth = String(
      (init.headers as Record<string, string>)["authorization"] ?? "",
    );
    const token = auth.replace("Bearer ", "");
    labels.push(token);
    await gate;
    const figures = byToken[token];
    if (figures === undefined) {
      return new Response("nope", { status: 401 });
    }
    return new Response("{}", {
      status: 200,
      headers: {
        "anthropic-ratelimit-unified-5h-utilization": String(
          1 - figures.fiveHourRemaining,
        ),
        "anthropic-ratelimit-unified-5h-reset": String(
          Math.round(figures.fiveHourResetAt / 1000),
        ),
        "anthropic-ratelimit-unified-7d-utilization": String(
          1 - figures.sevenDayRemaining,
        ),
        "anthropic-ratelimit-unified-7d-reset": String(
          Math.round(figures.sevenDayResetAt / 1000),
        ),
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
      },
    });
  };
  return { fn, calls: () => labels.length, tokens: () => [...labels] };
}

/** Figures for a token that is comfortably usable. */
function healthy(overrides: Partial<FakeBudget> = {}): FakeBudget {
  return {
    fiveHourRemaining: 0.9,
    fiveHourResetAt: NOW + 4 * HOUR,
    sevenDayRemaining: 0.8,
    sevenDayResetAt: NOW + 120 * HOUR,
    ...overrides,
  };
}

Deno.test("claude credential pool - a recorded exhaustion makes a token ineligible with no probe", async () => {
  // The usage-limit result already carries the windows, so re-measuring what
  // the API just told us is a request spent to learn nothing.
  const probe = fetchWith({});
  const lines: string[] = [];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
    log: (line) => lines.push(line),
  });

  pool.recordExhaustion("provider", [
    { window: "five_hour", resetAt: NOW + 3 * HOUR },
  ]);
  pool.recordBudget(
    "provider-2",
    {
      known: true,
      label: "provider-2",
      remainingFraction: 0.7,
      resetAt: NOW + 4 * HOUR,
      window: "five_hour",
      windows: [
        {
          window: "five_hour",
          remainingFraction: 0.7,
          resetAt: NOW + 4 * HOUR,
        },
        {
          window: "seven_day",
          remainingFraction: 0.7,
          resetAt: NOW + 100 * HOUR,
        },
      ],
    },
    NOW,
  );

  const chosen = await pool.selectEligible(NOW);
  assertEquals(chosen?.label, "provider-2");
  assertEquals(probe.calls(), 0, "recorded figures are not re-probed");
  // Both candidates are on the record, spent one included.
  assert(lines.some((line) => line.includes("candidate provider (")));
  assert(lines.some((line) => line.includes("candidate provider-2 (")));
});

Deno.test("claude credential pool - a stale snapshot costs one probe per candidate, even concurrently", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probe = fetchWith(
    { "token-provider": healthy(), "token-provider-2": healthy() },
    gate,
  );
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
  });

  const stale = NOW - CLAUDE_BUDGET_SNAPSHOT_MAX_AGE_MS - 1;
  for (const label of ["provider", "provider-2"]) {
    pool.recordBudget(
      label,
      {
        known: true,
        label,
        remainingFraction: 0.5,
        resetAt: NOW + HOUR,
        window: "five_hour",
        windows: [
          { window: "five_hour", remainingFraction: 0.5, resetAt: NOW + HOUR },
        ],
      },
      stale,
    );
  }

  // Two selections in flight at once must share the refresh, not double it.
  const first = pool.selectEligible(NOW);
  const second = pool.selectEligible(NOW);
  release();
  const [a, b] = await Promise.all([first, second]);

  assertEquals(probe.calls(), 2, "one probe per stale candidate, not four");
  assertEquals(a?.label, b?.label);

  // The refreshed snapshot is now fresh, so a third selection probes nothing.
  await pool.selectEligible(NOW + 60_000);
  assertEquals(probe.calls(), 2);
});

Deno.test("claude credential pool - 0% and 60% five-hour: the 60% token wins and both shares are logged", async () => {
  const probe = fetchWith({
    "token-provider": healthy({ fiveHourRemaining: 0 }),
    "token-provider-2": healthy({ fiveHourRemaining: 0.6 }),
  });
  const lines: string[] = [];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
    log: (line) => lines.push(line),
  });

  const chosen = await pool.selectEligible(NOW);
  assertEquals(chosen?.label, "provider-2");

  const log = lines.join("\n");
  assertStringIncludes(log, "five_hour=0.0%");
  assertStringIncludes(log, "five_hour=60.0%");
  assertStringIncludes(log, "seven_day=80.0%");
  assertStringIncludes(log, "selected provider-2");
  // Labels only: no token value may reach a log line.
  assertEquals(log.includes("token-provider"), false);
});

Deno.test("claude credential pool - the higher seven-day remaining-per-hour wins among eligible tokens", async () => {
  // The parent's figures: 75% of a week that resets in seven days is worth
  // 0.45%/h, while 22% that resets in eleven hours is worth 2%/h. Use it or
  // lose it — the ranking is #1623's and this asserts the delegation.
  const probe = fetchWith({
    "token-provider": {
      fiveHourRemaining: 0.91,
      fiveHourResetAt: NOW + HOUR,
      sevenDayRemaining: 0.75,
      sevenDayResetAt: NOW + 168 * HOUR,
    },
    "token-provider-2": {
      fiveHourRemaining: 0.88,
      fiveHourResetAt: NOW + 2 * HOUR,
      sevenDayRemaining: 0.22,
      sevenDayResetAt: NOW + 11 * HOUR,
    },
  });
  const lines: string[] = [];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
    log: (line) => lines.push(line),
  });

  const chosen = await pool.selectEligible(NOW);
  assertEquals(chosen?.label, "provider-2");
  assertStringIncludes(
    lines.join("\n"),
    "selected provider-2 (#2) of 2: highest-remaining-per-hour",
  );
});

Deno.test("claude credential pool - every token under the guard still selects the best of them (Issue #1685)", async () => {
  // Both are under the 20% five-hour guard and neither is exhausted, so the
  // guard steps aside: a pool holding usable quota must never idle. provider
  // holds the better weekly rate — 40% over eight hours against 90% over 160
  // — so it is the one to switch to.
  const probe = fetchWith({
    "token-provider": healthy({
      fiveHourRemaining: 0.19,
      sevenDayRemaining: 0.4,
      sevenDayResetAt: NOW + 8 * HOUR,
    }),
    "token-provider-2": healthy({
      fiveHourRemaining: 0.05,
      sevenDayRemaining: 0.9,
      sevenDayResetAt: NOW + 160 * HOUR,
    }),
  });
  const lines: string[] = [];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
    log: (line) => lines.push(line),
  });

  assertEquals((await pool.selectEligible(NOW))?.label, "provider");
  const log = lines.join("\n");
  assert(lines.some((line) => line.includes("candidate provider (")));
  assert(lines.some((line) => line.includes("candidate provider-2 (")));
  assertStringIncludes(log, "guard=below");
  assertStringIncludes(
    log,
    "below-five-hour-guard-highest-remaining-per-hour",
  );
});

Deno.test("claude credential pool - exactly 20% of the five-hour window is eligible (Issue #1685)", async () => {
  // The guard's boundary belongs to the usable side, so a token holding
  // exactly the guard's share is switched to like any other.
  const probe = fetchWith({
    "token-provider": healthy({
      fiveHourRemaining: CLAUDE_FIVE_HOUR_GUARD_MIN_REMAINING,
      sevenDayRemaining: 0.5,
      sevenDayResetAt: NOW + 5 * HOUR,
    }),
    "token-provider-2": healthy({
      fiveHourRemaining: 0.9,
      sevenDayRemaining: 0.5,
      sevenDayResetAt: NOW + 150 * HOUR,
    }),
  });
  const lines: string[] = [];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
    log: (line) => lines.push(line),
  });

  assertEquals((await pool.selectEligible(NOW))?.label, "provider");
  assertStringIncludes(lines.join("\n"), "highest-remaining-per-hour");
});

Deno.test("claude credential pool - only an exhausted pool selects nothing, and still logs (Issue #1685)", async () => {
  // Exhaustion is the hard condition: with every window spent there is
  // nothing to switch to until one of them resets.
  const probe = fetchWith({
    "token-provider": healthy({ fiveHourRemaining: 0 }),
    "token-provider-2": healthy({ fiveHourRemaining: 0 }),
  });
  const lines: string[] = [];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
    log: (line) => lines.push(line),
  });

  assertEquals(await pool.selectEligible(NOW), null);
  const log = lines.join("\n");
  assert(lines.some((line) => line.includes("candidate provider (")));
  assertStringIncludes(log, "guard=exhausted");
});

Deno.test("claude credential pool - a start never refuses, and neither does a switch while quota is left (Issue #1685)", async () => {
  // Both are under the five-hour guard and neither is exhausted, so the
  // weekly rate decides on both surfaces: provider-2's 30% over six hours
  // beats provider's 80% over 120.
  const probe = fetchWith({
    "token-provider": healthy({ fiveHourRemaining: 0.05 }),
    "token-provider-2": healthy({
      fiveHourRemaining: 0.05,
      sevenDayRemaining: 0.3,
      sevenDayResetAt: NOW + 6 * HOUR,
    }),
  });
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
  });

  const started = await pool.selectToken(
    [tokenFile("provider"), tokenFile("provider-2")],
    CLAUDE,
  );
  assertEquals(
    started?.label,
    "provider-2",
    "the most weekly quota per hour starts the run",
  );
  assertEquals(
    (await pool.selectEligible(NOW))?.label,
    "provider-2",
    "and the same credential is worth switching to",
  );
  // Start-up and mid-run share one snapshot, so the second call probes nothing.
  assertEquals(probe.calls(), 2);
});

Deno.test("claude credential pool - a start on an exhausted pool takes the soonest reset (Issue #1685)", async () => {
  // Nothing can be spent now, so the run starts on the credential that
  // recovers first rather than refusing to start at all.
  const probe = fetchWith({
    "token-provider": healthy({
      fiveHourRemaining: 0,
      fiveHourResetAt: NOW + 4 * HOUR,
    }),
    "token-provider-2": healthy({
      fiveHourRemaining: 0,
      fiveHourResetAt: NOW + HOUR,
    }),
  });
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
  });

  const started = await pool.selectToken(
    [tokenFile("provider"), tokenFile("provider-2")],
    CLAUDE,
  );
  assertEquals(
    started?.label,
    "provider-2",
    "the soonest reset starts the run",
  );
  assertEquals(
    await pool.selectEligible(NOW),
    null,
    "but there is nothing worth switching to",
  );
  assertEquals(probe.calls(), 2);
});

Deno.test("claude credential pool - an unmeasured pool is not a switch target (Issue #1685)", async () => {
  // Every probe fails, so nothing is known about either credential.
  // Switching on figures we do not have is a guess; staying put is the
  // measured option, while the start still falls through to discovery order.
  const probe = fetchWith({});
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
  });

  assertEquals(await pool.selectEligible(NOW), null);
  const started = await pool.selectToken(
    [tokenFile("provider"), tokenFile("provider-2")],
    CLAUDE,
  );
  assertEquals(started?.label, "provider", "the start never refuses");
});

Deno.test("claude credential pool - applySelection leaves exactly one Claude token variable", async () => {
  const env = new Map<string, string>([[
    "CLAUDE_CODE_OAUTH_TOKEN",
    "token-provider",
  ]]);
  const probe = fetchWith({
    "token-provider": healthy({ fiveHourRemaining: 0.1 }),
    "token-provider-2": healthy(),
  });
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
  });

  const chosen = await pool.selectEligible(NOW);
  assert(chosen !== null);
  const applied = pool.applySelection(
    chosen,
    (name, value) => env.set(name, value),
  );

  assertEquals(applied, "CLAUDE_CODE_OAUTH_TOKEN");
  assertEquals([...env.keys()], ["CLAUDE_CODE_OAUTH_TOKEN"]);
  assertEquals(env.get("CLAUDE_CODE_OAUTH_TOKEN"), "token-provider-2");
});

Deno.test("claude credential pool - applySelection refuses a file carrying no subscription token", () => {
  const pool = createClaudeCredentialPool({ provider: CLAUDE });
  const metered = tokenFile("provider", {
    name: "ANTHROPIC_API_KEY",
    poolMember: false,
  });
  let threw = false;
  try {
    pool.applySelection(metered, () => {});
  } catch (error: unknown) {
    threw = true;
    assertStringIncludes(String(error), "provider");
  }
  assertEquals(threw, true, "a switch that cannot switch must fail loudly");
});

Deno.test("claude credential pool - applySelection refuses a file carrying a second credential", () => {
  // Start-up exports every recognised entry of the file it chose, so a pool
  // file holding an API key beside its OAuth token would leave the previous
  // file's key standing next to the new token — two subscriptions in one
  // environment. Refusing beats half-switching.
  const pool = createClaudeCredentialPool({ provider: CLAUDE });
  const twoCredentials = tokenFile("provider-2", {
    entries: [
      { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token-provider-2" },
      { name: "ANTHROPIC_API_KEY", value: "sk-not-a-subscription" },
    ],
  });
  const env = new Map<string, string>();
  let threw = false;
  try {
    pool.applySelection(twoCredentials, (name, value) => env.set(name, value));
  } catch (error: unknown) {
    threw = true;
    assertStringIncludes(String(error), "provider-2");
    // The refusal names the file, never either credential's value.
    assertEquals(String(error).includes("sk-not-a-subscription"), false);
  }
  assertEquals(threw, true);
  assertEquals(env.size, 0, "nothing is switched when the switch is refused");
});

Deno.test("claude credential pool - a single-token host makes no request and logs nothing", async () => {
  const probe = fetchWith({ "token-provider": healthy() });
  const lines: string[] = [];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () => Promise.resolve([tokenFile("provider")]),
    fetchFn: probe.fn,
    now: () => NOW,
    log: (line) => lines.push(line),
  });

  assertEquals(await pool.selectEligible(NOW), null);
  assertEquals(probe.calls(), 0);
  assertEquals(lines.length, 0);

  // Start-up on the same host falls straight through to discovery order.
  const started = await pool.selectToken([tokenFile("provider")], CLAUDE);
  assertEquals(started?.label, "provider");
  assertEquals(probe.calls(), 0);
  assertEquals(lines.length, 0);
});

Deno.test("claude credential pool - poolStatus separates a spent pool from no pool and from unmeasured (Issue #1669)", async () => {
  // All three answer null from `selectEligible`, and only this reading tells
  // them apart: only the spent pool may stop a spawn.
  const probe = fetchWith({});
  const spent = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
  });
  spent.recordExhaustion("provider", [
    { window: "five_hour", resetAt: NOW + 3 * HOUR },
  ]);
  spent.recordExhaustion("provider-2", [
    { window: "five_hour", resetAt: NOW + HOUR },
    { window: "seven_day", resetAt: NOW + 40 * HOUR },
  ]);
  assertEquals(await spent.selectEligible(NOW), null);
  assertEquals(await spent.poolStatus(NOW), {
    candidates: 2,
    spent: 2,
    // The soonest five-hour reset across the pool is what it is waiting on.
    soonestFiveHourReset: NOW + HOUR,
  });

  const single = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () => Promise.resolve([tokenFile("provider")]),
    fetchFn: probe.fn,
    now: () => NOW,
  });
  assertEquals(await single.selectEligible(NOW), null);
  assertEquals(await single.poolStatus(NOW), {
    candidates: 1,
    spent: 0,
    // Nothing measured, nothing to report — never a guessed instant.
    soonestFiveHourReset: null,
  });
  assertEquals(probe.calls(), 0);

  // A pool nobody could measure: NOT spent. Refusing to spawn because a
  // budget endpoint was unreachable would stop a host that has quota.
  const blind = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
  });
  assertEquals(await blind.selectEligible(NOW), null);
  const blindStatus = await blind.poolStatus(NOW);
  assertEquals(blindStatus.candidates, 2);
  assertEquals(blindStatus.spent, 0);
});

Deno.test("claude credential pool - activeLabel names the credential the environment carries (Issue #1669)", async () => {
  const probe = fetchWith({
    "token-provider": healthy(),
    "token-provider-2": healthy(),
  });
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
    // The run environment as worker start left it.
    env: (name) =>
      name === "CLAUDE_CODE_OAUTH_TOKEN" ? "token-provider" : undefined,
  });

  // Derived from the environment before anything has been switched, so a
  // usage limit hit on the very first spawn is recorded against the right
  // token rather than nothing at all.
  assertEquals(await pool.activeLabel(), "provider");

  pool.applySelection(tokenFile("provider-2"), () => {});
  assertEquals(await pool.activeLabel(), "provider-2");
});

Deno.test("claude credential pool - an unrecognised environment credential has no active label (Issue #1669)", async () => {
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: fetchWith({}).fn,
    now: () => NOW,
    env: () => undefined,
  });
  // Guessing here would strand a subscription that still has quota.
  assertEquals(await pool.activeLabel(), null);
});
