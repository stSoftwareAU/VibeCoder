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
  assertEquals(pool.soonestFiveHourReset(), NOW + 2 * HOUR);
});
