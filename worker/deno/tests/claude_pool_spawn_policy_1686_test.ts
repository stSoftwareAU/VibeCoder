/**
 * The Claude credential policy as the run actually applies it (Issue #1686,
 * parent #1653).
 *
 * `claude_pool_policy_matrix_1686_test.ts` pins the ranking. This file pins
 * what the ranking is *for*: whether a `claude` child is spawned at all, and
 * which single credential its environment carries. The two halves fail
 * differently — a ranking regression picks the wrong subscription, a wiring
 * regression idles the host or hands the child a token the run did not select
 * — so both are asserted, on the real start-up path rather than a stand-in:
 *
 * `checkWorkerCredentials` → `applyProviderCredentialEnv` →
 * `ClaudeCredentialPool.selectToken` → `buildClaudeChildEnv`.
 *
 * The rules held here, each a regression that would degrade silently:
 *
 * - every non-exhausted credential being below the 20% five-hour guard still
 *   spawns exactly one child, on the best weekly rate of them (Issue #1685
 *   corrected an eligibility gate that stopped the fleet here);
 * - the child's environment carries the selected credential and no trace of
 *   any other, whether it was chosen at start-up or switched to mid-run;
 * - an explicitly exhausted credential is never the switch target;
 * - a usage limit recorded mid-run moves the next selection to another usable
 *   credential, with no probe, even though the cached snapshot still showed
 *   quota;
 * - with every credential exhausted there is no switch target at all, so no
 *   child is spawned on a spent subscription — while a *start* still names
 *   the soonest to recover rather than refusing to run;
 * - a single-token host makes no request and behaves exactly as it always has.
 *
 * Every test injects the credential directory, the environment, the clock and
 * `fetch`, so nothing here touches the network, the wall clock or the process
 * environment — the file stays parallel-safe.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { createClaudeCredentialPool } from "../lib/claude_credential_pool.ts";
import { buildClaudeChildEnv } from "../lib/claude_env.ts";
import { checkWorkerCredentials } from "../lib/run_worker.ts";
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

/** The one variable a Claude subscription credential is carried in. */
const OAUTH_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * The token value stored in `claude/<label>.env`.
 *
 * Suffixed so no label's value is a prefix of another's — `provider` must not
 * be a substring of `provider-2`, or a leak assertion would pass by accident.
 */
function tokenValue(label: string): string {
  return `sk-ant-oat01-${label}-secret`;
}

/** Remaining shares one fake probe response reports, per window. */
interface Figures {
  readonly fiveHourRemaining: number;
  readonly fiveHourResetInHours: number;
  readonly sevenDayRemaining: number;
  readonly sevenDayResetInHours: number;
}

/** Comfortable figures, varied per test by the overrides. */
function figures(overrides: Partial<Figures> = {}): Figures {
  return {
    fiveHourRemaining: 0.9,
    fiveHourResetInHours: 4,
    sevenDayRemaining: 0.5,
    sevenDayResetInHours: 144,
    ...overrides,
  };
}

/**
 * A credential directory holding one `claude/<label>.env` per label, plus the
 * GitHub material the preflight requires.
 *
 * @param labels - The pool file stems, in the order discovery will find them.
 * @returns The directory path; the caller removes it.
 */
async function credentialDir(
  labels: readonly string[],
): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/gh`, { recursive: true });
  await Deno.mkdir(`${dir}/claude`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/gh/hosts.yml`,
    "github.com:\n    oauth_token: ghs_installationtoken\n    user: vibe\n",
    { mode: 0o600 },
  );
  for (const label of labels) {
    await Deno.writeTextFile(
      `${dir}/claude/${label}.env`,
      `${OAUTH_VAR}=${tokenValue(label)}\n`,
      { mode: 0o600 },
    );
  }
  return dir;
}

/**
 * A `fetch` answering the budget probe with fixed figures per token value,
 * and counting the requests it was asked to make.
 */
function probeStub(byLabel: Record<string, Figures>) {
  let calls = 0;
  const fetchFn = (_url: string, init: RequestInit) => {
    calls += 1;
    const auth = String(
      (init.headers as Record<string, string>)["authorization"] ?? "",
    );
    const label = Object.keys(byLabel).find(
      (candidate) => auth === `Bearer ${tokenValue(candidate)}`,
    );
    const figure = label === undefined ? undefined : byLabel[label];
    if (figure === undefined) {
      return Promise.resolve(new Response("nope", { status: 401 }));
    }
    return Promise.resolve(
      new Response("{}", {
        status: 200,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": String(
            1 - figure.fiveHourRemaining,
          ),
          "anthropic-ratelimit-unified-5h-reset": String(
            Math.round((NOW + figure.fiveHourResetInHours * HOUR) / 1000),
          ),
          "anthropic-ratelimit-unified-7d-utilization": String(
            1 - figure.sevenDayRemaining,
          ),
          "anthropic-ratelimit-unified-7d-reset": String(
            Math.round((NOW + figure.sevenDayResetInHours * HOUR) / 1000),
          ),
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
        },
      }),
    );
  };
  return { fetchFn, calls: () => calls };
}

/** A worker environment as the run holds it, with no Claude credential yet. */
function workerEnvironment(): Record<string, string> {
  return {
    PATH: "/usr/bin",
    HOME: "/home/vibe",
    GH_TOKEN: "ghs_installationtoken",
    WORK_DIR: "/home/vibe/auto-issue-work",
  };
}

/** Names in `env` that carry, or could carry, an Anthropic credential. */
function anthropicNames(env: Record<string, string>): string[] {
  return Object.keys(env)
    .filter((name) => /^(ANTHROPIC_|CLAUDE_CODE_)/.test(name))
    .sort();
}

/** Variables whose value contains any of `needles`, for leak assertions. */
function leaks(
  env: Record<string, string>,
  needles: readonly string[],
): string[] {
  return Object.entries(env)
    .filter(([, value]) => needles.some((needle) => value.includes(needle)))
    .map(([name]) => name)
    .sort();
}

/**
 * The pool the run would build, wired to a stubbed probe, clock and
 * credential directory.
 *
 * `dir` is always passed: without it the pool resolves the *host's* real
 * credential directory, and the test would silently rank whatever that host
 * happens to hold.
 */
function poolFor(dir: string, byLabel: Record<string, Figures>) {
  const stub = probeStub(byLabel);
  const lines: string[] = [];
  const pool = createClaudeCredentialPool({
    dir,
    provider: CLAUDE,
    now: () => NOW,
    fetchFn: stub.fetchFn,
    log: (message) => lines.push(message),
  });
  return { pool, lines, probes: stub.calls };
}

/**
 * Run the real start-up credential path and return the environment it left.
 *
 * @param dir - The credential directory.
 * @param pool - The pool whose `selectToken` decides which file is exported.
 * @returns The worker environment, and the preflight's failure message (null
 *   when the credentials are usable and a child may therefore be spawned).
 */
async function startUp(
  dir: string,
  pool: ReturnType<typeof poolFor>["pool"],
): Promise<{ env: Record<string, string>; failure: string | null }> {
  const env = workerEnvironment();
  const failure = await checkWorkerCredentials({
    dir,
    providers: [CLAUDE],
    env: (name) => env[name],
    setEnv: (name, value) => {
      env[name] = value;
    },
    selectToken: pool.selectToken,
  });
  return { env, failure };
}

// ---------------------------------------------------------------------------
// Every credential below the guard: the fleet keeps running
// ---------------------------------------------------------------------------

/** Three credentials, all under the guard, provider-2 holding the best week. */
const ALL_LOW: Record<string, Figures> = {
  "provider": figures({
    fiveHourRemaining: 0.19,
    sevenDayRemaining: 0.4,
    sevenDayResetInHours: 100,
  }),
  "provider-2": figures({
    fiveHourRemaining: 0.05,
    sevenDayRemaining: 0.6,
    sevenDayResetInHours: 24,
  }),
  "provider-3": figures({
    fiveHourRemaining: 0.12,
    sevenDayRemaining: 0.1,
    sevenDayResetInHours: 150,
  }),
};

Deno.test("claude pool spawn - every credential under the guard still spawns one child, on the best week (Issue #1686)", async () => {
  const dir = await credentialDir(["provider", "provider-2", "provider-3"]);
  try {
    const { pool, probes } = poolFor(dir, ALL_LOW);
    const { env, failure } = await startUp(dir, pool);

    // The start is not refused: a host holding usable quota must never idle
    // because every five-hour window happens to be low.
    assertEquals(failure, null);
    // Exactly one credential variable exists to spawn a child with, and it is
    // the best weekly rate of the three (0.6 over 24h = 2.5%/h).
    assertEquals(anthropicNames(env), [OAUTH_VAR]);
    assertEquals(env[OAUTH_VAR], tokenValue("provider-2"));
    // One probe per candidate, no more.
    assertEquals(probes(), 3);

    // And the mid-run question agrees: there is a credential worth spawning
    // on, which is what makes this a spawn rather than a park.
    const eligible = await pool.selectEligible(NOW);
    assertEquals(eligible?.label, "provider-2");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("claude pool spawn - the child environment carries the selected credential and no other (Issue #1686)", async () => {
  const dir = await credentialDir(["provider", "provider-2", "provider-3"]);
  try {
    const { pool } = poolFor(dir, ALL_LOW);
    const { env } = await startUp(dir, pool);

    const child = buildClaudeChildEnv(env);
    assertEquals(anthropicNames(child), [OAUTH_VAR]);
    assertEquals(child[OAUTH_VAR], tokenValue("provider-2"));
    // No unselected subscription reaches the child, by value or by path.
    assertEquals(
      leaks(child, [tokenValue("provider"), tokenValue("provider-3")]),
      [],
    );
    assertEquals(leaks(child, [dir, "provider-3.env"]), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Exhaustion: the hard exclusion, at start and mid-run
// ---------------------------------------------------------------------------

Deno.test("claude pool spawn - an explicitly exhausted credential is not selected (Issue #1686)", async () => {
  const dir = await credentialDir(["provider", "provider-2"]);
  try {
    // provider holds the far better week and nothing of its five hours; the
    // hard exclusion beats the primary balancing rule.
    const { pool } = poolFor(dir, {
      "provider": figures({
        fiveHourRemaining: 0,
        sevenDayRemaining: 0.9,
        sevenDayResetInHours: 3,
      }),
      "provider-2": figures({
        fiveHourRemaining: 0.15,
        sevenDayRemaining: 0.2,
        sevenDayResetInHours: 150,
      }),
    });
    const { env, failure } = await startUp(dir, pool);

    assertEquals(failure, null);
    assertEquals(env[OAUTH_VAR], tokenValue("provider-2"));
    assertEquals((await pool.selectEligible(NOW))?.label, "provider-2");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("claude pool spawn - a mid-run usage limit moves the next spawn to another usable credential (Issue #1686)", async () => {
  const dir = await credentialDir(["provider", "provider-2"]);
  try {
    const { pool, probes } = poolFor(dir, {
      "provider": figures({
        sevenDayRemaining: 0.6,
        sevenDayResetInHours: 24,
      }),
      "provider-2": figures({
        sevenDayRemaining: 0.5,
        sevenDayResetInHours: 144,
      }),
    });
    const { env } = await startUp(dir, pool);
    assertEquals(env[OAUTH_VAR], tokenValue("provider"));
    const startProbes = probes();

    // The CLI then reports a usage limit against the running credential. Its
    // cached snapshot still says 90% of five hours, so only the structured
    // exhaustion can stop the next call going straight back to it.
    pool.recordExhaustion("provider", [
      { window: "five_hour", resetAt: NOW + 3 * HOUR },
    ]);

    const next = await pool.selectEligible(NOW);
    assert(next !== null, "the pool named no credential to switch to");
    assertEquals(next.label, "provider-2");
    // The API has just said the window is gone; asking it again learns
    // nothing, so the switch costs no request.
    assertEquals(probes(), startProbes);

    // The switch replaces the credential rather than adding to it, so the
    // next child still sees exactly one subscription — the new one.
    const applied = pool.applySelection(next, (name, value) => {
      env[name] = value;
    });
    assertEquals(applied, OAUTH_VAR);
    const child = buildClaudeChildEnv(env);
    assertEquals(anthropicNames(child), [OAUTH_VAR]);
    assertEquals(child[OAUTH_VAR], tokenValue("provider-2"));
    assertEquals(leaks(child, [tokenValue("provider")]), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("claude pool spawn - with every credential exhausted there is no spawn target, and a start still names the soonest to recover (Issue #1686)", async () => {
  const dir = await credentialDir(["provider", "provider-2"]);
  try {
    const { pool, lines } = poolFor(dir, {
      "provider": figures({
        fiveHourRemaining: 0,
        fiveHourResetInHours: 6,
        sevenDayRemaining: 0,
        sevenDayResetInHours: 100,
      }),
      "provider-2": figures({
        fiveHourRemaining: 0,
        fiveHourResetInHours: 2,
        sevenDayRemaining: 0.2,
        sevenDayResetInHours: 100,
      }),
    });

    // Nothing can serve a call, so nothing is worth spawning a child on. This
    // null is the signal the checkpoint/park path consumes.
    assertEquals(await pool.selectEligible(NOW), null);

    // A start is a different question and never refuses: the run comes up on
    // the credential whose spent windows reopen first, so the host is ready
    // the moment quota returns rather than dead until an operator looks.
    const { env, failure } = await startUp(dir, pool);
    assertEquals(failure, null);
    assertEquals(env[OAUTH_VAR], tokenValue("provider-2"));

    // The decision is on the record either way, with no token value in it.
    assert(
      lines.some((line) => line.includes("exhausted-soonest-reset")),
      `no exhaustion reason logged: ${lines.join(" | ")}`,
    );
    assertEquals(
      leaks(
        Object.fromEntries(lines.map((line, index) => [String(index), line])),
        [tokenValue("provider"), tokenValue("provider-2")],
      ),
      [],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The host every operator actually has today
// ---------------------------------------------------------------------------

Deno.test("claude pool spawn - a single-credential host makes no request and starts on its one credential (Issue #1686)", async () => {
  const dir = await credentialDir(["provider"]);
  try {
    const { pool, probes, lines } = poolFor(dir, {
      "provider": figures({ fiveHourRemaining: 0.02 }),
    });
    const { env, failure } = await startUp(dir, pool);

    assertEquals(failure, null);
    assertEquals(env[OAUTH_VAR], tokenValue("provider"));
    // Nothing to choose between: no probe, no log, no change from today —
    // not even when the one credential is far under the guard.
    assertEquals(probes(), 0);
    assertEquals(lines, []);
    // And no switch is offered either, so a single-token host cannot be sent
    // round a credential-switch loop it has no second credential for.
    assertEquals(await pool.selectEligible(NOW), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
