/**
 * Tests for lib/claude_credential_pool.ts — the process-wide Claude
 * credential pool (Issue #1668, parent #1653).
 *
 * What was missing: the run measured its tokens once at start and never again,
 * so a subscription that ran out part-way through took the retry ladder and
 * failed the run while another token in the pool sat untouched, and no log
 * line said which candidates existed or why one was chosen. The pool keeps a
 * per-token budget snapshot, refreshes only what has gone stale, applies
 * #1623's gate and ranking on demand, and replaces the run's single exported
 * token when asked.
 *
 * Each test below pins a rule that would degrade silently rather than fail
 * visibly if it regressed:
 *
 * - an exhaustion recorded from a usage-limit result makes that token
 *   ineligible with **no** probe — the figures are already known;
 * - a stale snapshot costs exactly one probe per stale candidate, even when
 *   two selections run concurrently;
 * - the gate is applied on `selectEligible` (0% five-hour loses to 60%), and
 *   every candidate is logged whichever way the decision goes;
 * - with every token at or below the gate, `selectEligible` refuses — while
 *   `selectToken`, which starts the run, never does;
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
  exhaustionFromUsageSignal,
  primeClaudePoolFromUsageSignal,
} from "../lib/claude_credential_pool.ts";
import {
  heldProviderCredentialLabel,
  resetHeldProviderCredentials,
} from "../lib/credential_preflight.ts";
import {
  type RateLimitSignalData,
  writeRateLimitSignal,
} from "../lib/rate_limit_signal.ts";
import { CLAUDE_FIVE_HOUR_GATE_MIN_REMAINING } from "../lib/claude_token_selection.ts";
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

Deno.test("claude credential pool - every token at or below the gate selects nothing, and still logs", async () => {
  // Exactly at the gate, and below it: neither can spend what its week holds.
  const probe = fetchWith({
    "token-provider": healthy({
      fiveHourRemaining: CLAUDE_FIVE_HOUR_GATE_MIN_REMAINING,
    }),
    "token-provider-2": healthy({ fiveHourRemaining: 0.05 }),
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
  assert(lines.some((line) => line.includes("candidate provider-2 (")));
  assertStringIncludes(log, "gate=fail");
});

Deno.test("claude credential pool - a start never refuses, even when the gate would", async () => {
  // selectEligible protects a mid-run switch; selectToken starts the run, and
  // a run that refuses to start because every token is low is worse than a
  // run that starts on the token which refills first.
  const probe = fetchWith({
    "token-provider": healthy({
      fiveHourRemaining: 0.05,
      fiveHourResetAt: NOW + 4 * HOUR,
    }),
    "token-provider-2": healthy({
      fiveHourRemaining: 0.05,
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
    "the soonest refill starts the run",
  );
  assertEquals(
    await pool.selectEligible(NOW),
    null,
    "but no switch is worth it",
  );
  // Start-up and mid-run share one snapshot, so the second call probes nothing.
  assertEquals(probe.calls(), 2);
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

// ---------------------------------------------------------------------------
// A start does not re-export a subscription it knows to be spent (Issue #2002)
// ---------------------------------------------------------------------------

Deno.test("claude credential pool - a start leaves a recorded-spent token out of the ranking, even when every probe fails (Issue #2002)", async () => {
  // Every probe answers 429 — the shape of the 16:29Z start on GRQ-25 — so
  // every budget is unknown and, without the exclusion, the spent token
  // would rank FIRST: its recorded exhaustion is a measured budget.
  const probe = fetchWith({});
  const lines: string[] = [];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([
        tokenFile("provider"),
        tokenFile("provider-2"),
        tokenFile("provider-3"),
      ]),
    fetchFn: probe.fn,
    now: () => NOW,
    log: (line) => lines.push(line),
  });
  pool.recordExhaustion("provider", [
    { window: "seven_day", resetAt: NOW + 80 * HOUR },
  ]);

  const chosen = await pool.selectToken(
    [tokenFile("provider"), tokenFile("provider-2"), tokenFile("provider-3")],
    CLAUDE,
  );
  assert(
    chosen !== null && chosen.label !== "provider",
    `chose ${chosen?.label}`,
  );
  assertEquals(probe.calls(), 2, "the spent token is not even probed");
  assert(
    lines.some((line) =>
      line.includes("provider is recorded as spent until") &&
      line.includes("left out of the start-up ranking")
    ),
    lines.join("\n"),
  );
  assertEquals(
    lines.some((line) => line.includes("candidate provider (")),
    false,
    "and is not on the candidate list",
  );
});

Deno.test("claude credential pool - a recorded exhaustion whose reset has passed is ranked normally (Issue #2002)", async () => {
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
  });
  pool.recordExhaustion("provider", [
    { window: "five_hour", resetAt: NOW - HOUR },
  ]);
  // Fresh snapshot, so the recorded (elapsed) window stands in for a probe
  // and counts as full; nothing is excluded and both are ranked.
  const chosen = await pool.selectToken(
    [tokenFile("provider"), tokenFile("provider-2")],
    CLAUDE,
  );
  assert(chosen !== null);
  assertEquals(probe.calls(), 1, "only the unrecorded token is probed");
});

Deno.test("claude credential pool - when every token is recorded spent the start still ranks them all (Issue #2002)", async () => {
  const probe = fetchWith({});
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: probe.fn,
    now: () => NOW,
  });
  pool.recordExhaustion("provider", [
    { window: "five_hour", resetAt: NOW + 3 * HOUR },
  ]);
  pool.recordExhaustion("provider-2", [
    { window: "five_hour", resetAt: NOW + 1 * HOUR },
  ]);
  const chosen = await pool.selectToken(
    [tokenFile("provider"), tokenFile("provider-2")],
    CLAUDE,
  );
  // A start never refuses: with nothing better, the soonest reset wins.
  assertEquals(chosen?.label, "provider-2");
  assertEquals(probe.calls(), 0);
});

Deno.test("claude credential pool - applySelection records the credential the run now holds (Issue #2002)", () => {
  resetHeldProviderCredentials();
  try {
    const pool = createClaudeCredentialPool({ provider: CLAUDE });
    const env: Record<string, string> = {};
    pool.applySelection(tokenFile("provider-2"), (name, value) => {
      env[name] = value;
    });
    assertEquals(heldProviderCredentialLabel(CLAUDE_PROVIDER_ID), "provider-2");
  } finally {
    resetHeldProviderCredentials();
  }
});

// ---------------------------------------------------------------------------
// Reading the exhaustion back out of a usage-limit signal (Issue #2002)
// ---------------------------------------------------------------------------

function usageSignal(
  overrides: Partial<RateLimitSignalData> = {},
): RateLimitSignalData {
  return {
    timestamp: Math.floor(NOW / 1000),
    waitSeconds: 289_493,
    kind: "usage",
    provider: "claude",
    credentialLabel: "provider",
    resetEpochMs: NOW + 80 * HOUR,
    ...overrides,
  };
}

Deno.test("exhaustionFromUsageSignal - a labelled Claude usage signal names the spent token and a week window", () => {
  const exhaustion = exhaustionFromUsageSignal(usageSignal(), NOW);
  assertEquals(exhaustion?.label, "provider");
  assertEquals(exhaustion?.windows, [
    { window: "seven_day", resetAt: NOW + 80 * HOUR },
  ]);
});

Deno.test("exhaustionFromUsageSignal - a reset within five hours is the five-hour window", () => {
  const exhaustion = exhaustionFromUsageSignal(
    usageSignal({ resetEpochMs: NOW + 3 * HOUR }),
    NOW,
  );
  assertEquals(exhaustion?.windows[0]?.window, "five_hour");
});

Deno.test("exhaustionFromUsageSignal - without resetEpochMs the wait derives the reset", () => {
  const signal = usageSignal({ waitSeconds: 3600 });
  delete signal.resetEpochMs;
  const exhaustion = exhaustionFromUsageSignal(signal, NOW);
  assertEquals(exhaustion?.windows[0], {
    window: "five_hour",
    resetAt: NOW + HOUR,
  });
});

Deno.test("exhaustionFromUsageSignal - nothing to record: GitHub, another provider, no label, already reset", () => {
  assertEquals(
    exhaustionFromUsageSignal(usageSignal({ kind: "github" }), NOW),
    null,
  );
  assertEquals(
    exhaustionFromUsageSignal(usageSignal({ provider: "codex" }), NOW),
    null,
  );
  const unlabelled = usageSignal();
  delete unlabelled.credentialLabel;
  assertEquals(exhaustionFromUsageSignal(unlabelled, NOW), null);
  assertEquals(
    exhaustionFromUsageSignal(usageSignal({ credentialLabel: "  " }), NOW),
    null,
  );
  assertEquals(
    exhaustionFromUsageSignal(usageSignal({ resetEpochMs: NOW - 1 }), NOW),
    null,
  );
});

Deno.test("exhaustionFromUsageSignal - a legacy usage signal with no provider is Claude's", () => {
  const legacy = usageSignal();
  delete legacy.provider;
  assertEquals(exhaustionFromUsageSignal(legacy, NOW)?.label, "provider");
});

Deno.test("primeClaudePoolFromUsageSignal - an active labelled signal is recorded before start-up ranks the pool (Issue #2002)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "pool_prime_2002_" });
  try {
    const written = await writeRateLimitSignal(
      workDir,
      289_493,
      NOW + 80 * HOUR,
      "usage",
      { provider: "claude", credentialLabel: "provider" },
    );
    assertEquals(written.ok, true);
    // The signal's own timestamp is the wall clock, so "now" for the
    // activity check is the wall clock too; the recorded reset is NOW-based.
    const recorded: Array<{ label: string; windows: unknown }> = [];
    const lines: string[] = [];
    const primed = await primeClaudePoolFromUsageSignal(
      {
        recordExhaustion(label, windows) {
          recorded.push({ label, windows });
        },
      },
      workDir,
      { now: () => Date.now(), log: (line) => lines.push(line) },
    );
    assertEquals(primed, true);
    assertEquals(recorded.length, 1);
    assertEquals(recorded[0]?.label, "provider");
    assert(
      lines.some((line) =>
        line.includes("names provider as the spent subscription")
      ),
      lines.join("\n"),
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("primeClaudePoolFromUsageSignal - no directory, no signal, an expired one or a GitHub one records nothing", async () => {
  const recorded: string[] = [];
  const pool = {
    recordExhaustion(label: string) {
      recorded.push(label);
    },
  };
  assertEquals(await primeClaudePoolFromUsageSignal(pool, undefined), false);
  const workDir = await Deno.makeTempDir({ prefix: "pool_prime_2002_" });
  try {
    assertEquals(await primeClaudePoolFromUsageSignal(pool, workDir), false);
    await writeRateLimitSignal(workDir, 600, undefined, "github");
    assertEquals(await primeClaudePoolFromUsageSignal(pool, workDir), false);
    await writeRateLimitSignal(
      workDir,
      1,
      undefined,
      "usage",
      { provider: "claude", credentialLabel: "provider" },
    );
    assertEquals(
      await primeClaudePoolFromUsageSignal(pool, workDir, {
        now: () => Date.now() + 10_000,
      }),
      false,
      "an expired signal is not a current exhaustion",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
  assertEquals(recorded, []);
});
