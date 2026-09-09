/**
 * Tests for lib/claude_spawn_gate.ts — the quota gate every agent spawn
 * passes through (Issue #1669, parent #1653).
 *
 * Three rules that would degrade silently rather than fail visibly:
 *
 * - a host with fewer than two pool candidates is answered `"no-pool"`, which
 *   the runner spawns on; a pool whose every candidate is spent is answered
 *   `"none-eligible"`, which the runner refuses to spawn on. `selectEligible`
 *   returns null for both, so only the gate separates them;
 * - another vendor's spawn is gated on nothing and switched by nothing — this
 *   pool holds Claude subscriptions, and a Codex run must neither be refused
 *   because they are spent nor have its environment rewritten;
 * - a usage limit is recorded against the credential the run is actually
 *   carrying, never a guessed one.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { createClaudeCredentialPool } from "../lib/claude_credential_pool.ts";
import { createClaudeSpawnGate } from "../lib/claude_spawn_gate.ts";
import type { ProviderTokenFile } from "../lib/credential_preflight.ts";
import {
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";

/** A fixed "now" for every test — 2026-09-09T00:00:00Z. */
const NOW = Date.UTC(2026, 8, 9, 0, 0, 0);

/** One hour, in milliseconds. */
const HOUR = 3_600_000;

const CLAUDE = resolveAgentProvider(CLAUDE_PROVIDER_ID);

/** A discovered pool token file. */
function tokenFile(label: string): ProviderTokenFile {
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
  };
}

/** A pool of `labels` whose every candidate is already spent. */
function spentPool(labels: readonly string[]) {
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () => Promise.resolve(labels.map(tokenFile)),
    fetchFn: () => {
      throw new Error("a spent pool needs no probe");
    },
    now: () => NOW,
    env: (name) =>
      name === "CLAUDE_CODE_OAUTH_TOKEN" ? `token-${labels[0]}` : undefined,
  });
  for (const label of labels) {
    pool.recordExhaustion(label, [
      { window: "five_hour", resetAt: NOW + 2 * HOUR },
    ]);
  }
  return pool;
}

Deno.test("claude spawn gate - a spent pool refuses the spawn, a single-token host does not", async () => {
  const applied: string[] = [];
  const setEnv = (name: string) => applied.push(name);

  const pooled = createClaudeSpawnGate(
    spentPool(["provider", "provider-2"]),
    { setEnv },
  );
  assertEquals(await pooled.beforeSpawn(), {
    outcome: "none-eligible",
    resetEpochMs: NOW + 2 * HOUR,
  });

  // A pool nobody could measure is NOT a spent pool: refusing every spawn
  // because a budget endpoint was unreachable would stop a host that still
  // has quota, and no signal would say why.
  const blind = createClaudeSpawnGate(
    createClaudeCredentialPool({
      provider: CLAUDE,
      discover: () =>
        Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
      fetchFn: () => Promise.resolve(new Response("nope", { status: 503 })),
      now: () => NOW,
    }),
    { setEnv },
  );
  assertEquals(await blind.beforeSpawn(), { outcome: "no-pool" });

  // The same spent window on a host with nothing to switch to: today's path,
  // because refusing there would idle a host that has no alternative anyway.
  const single = createClaudeSpawnGate(spentPool(["provider"]), { setEnv });
  assertEquals(await single.beforeSpawn(), { outcome: "no-pool" });
  assertEquals(applied, []);
});

Deno.test("claude spawn gate - another vendor's spawn is gated on nothing", async () => {
  const applied: string[] = [];
  const pool = spentPool(["provider", "provider-2"]);
  const gate = createClaudeSpawnGate(pool, {
    setEnv: (name) => applied.push(name),
  });

  // Claude's subscriptions are spent; a Codex run does not bill them and
  // must not be refused because of them.
  assertEquals(await gate.beforeSpawn("codex"), { outcome: "no-pool" });
  await gate.recordUsageLimit(
    [{ window: "five_hour", resetAt: NOW + HOUR }],
    "codex",
  );
  assertEquals(applied, []);
  // The Claude figures are untouched by the foreign refusal.
  assertEquals(
    (await pool.poolStatus(NOW)).soonestFiveHourReset,
    NOW + 2 * HOUR,
  );
});

Deno.test("claude spawn gate - an unrecognisable credential drops nothing silently", async () => {
  const lines: string[] = [];
  const applied: string[] = [];
  // The run environment carries a token none of the pool files hold, so the
  // gate cannot know which credential hit the limit.
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: () => {
      throw new Error("no probe is needed to answer this");
    },
    now: () => NOW,
    env: () => "token-from-somewhere-else",
    log: (line) => lines.push(line),
  });
  pool.recordBudget("provider", {
    known: true,
    label: "provider",
    remainingFraction: 0.9,
    resetAt: NOW + 2 * HOUR,
    window: "five_hour",
    windows: [
      { window: "five_hour", remainingFraction: 0.9, resetAt: NOW + 2 * HOUR },
    ],
  }, NOW);
  const gate = createClaudeSpawnGate(pool, {
    setEnv: (name) => applied.push(name),
    log: (line) => lines.push(line),
  });

  await gate.recordUsageLimit([{ window: "five_hour", resetAt: NOW + HOUR }]);

  // Recording it against a guessed label would strand a credential that
  // still has quota, so it says so instead of doing it quietly.
  assertEquals(
    lines.some((line) => line.includes("does not recognise")),
    true,
    lines.join(" | "),
  );
  // And the selection that follows must not claim a switch it did not make.
  const verdict = await gate.beforeSpawn();
  assertEquals(verdict, {
    outcome: "selected",
    label: "provider",
    switched: true,
  });
  assertEquals(applied, ["CLAUDE_CODE_OAUTH_TOKEN"]);
});

Deno.test("claude spawn gate - the credential already in use is not re-applied", async () => {
  const applied: string[] = [];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () =>
      Promise.resolve([tokenFile("provider"), tokenFile("provider-2")]),
    fetchFn: () => {
      throw new Error("no probe is needed to answer this");
    },
    now: () => NOW,
    env: (name) =>
      name === "CLAUDE_CODE_OAUTH_TOKEN" ? "token-provider" : undefined,
  });
  const usable = (label: string, remaining: number) => ({
    known: true as const,
    label,
    remainingFraction: remaining,
    resetAt: NOW + 2 * HOUR,
    window: "five_hour" as const,
    windows: [
      {
        window: "five_hour" as const,
        remainingFraction: remaining,
        resetAt: NOW + 2 * HOUR,
      },
    ],
  });
  pool.recordBudget("provider", usable("provider", 0.9), NOW);
  pool.recordBudget("provider-2", usable("provider-2", 0.3), NOW);

  const gate = createClaudeSpawnGate(pool, {
    setEnv: (name) => applied.push(name),
  });

  // The winner is the credential the run already carries: a selection, but
  // not a switch, and nothing is written to the environment for it.
  assertEquals(await gate.beforeSpawn(), {
    outcome: "selected",
    label: "provider",
    switched: false,
  });
  assertEquals(applied, []);
});
