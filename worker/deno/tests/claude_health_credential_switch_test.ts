/**
 * Tests for the health check's response to a subscription usage limit
 * (Issue #1669, parent #1653).
 *
 * What was wrong: the health check answered a usage limit with exit 3 and a
 * `pauseSeconds`, and its consumer wrote the durable `usage` rate-limit
 * signal from that. `run_core` drains its whole slot pool while that signal
 * is active, so one subscription's spent window idled the host — including
 * every task that needs no agent at all — while another credential in the
 * pool sat untouched.
 *
 * What it does now: record the window as spent on the credential pool, ask
 * for another credential, and either switch and report **healthy** (no second
 * billed probe — the next spawn's own gate confirms it) or report unhealthy
 * with no pause at all. A host with fewer than two pool candidates consults
 * nothing and keeps its old exit-3 answer.
 *
 * Each test drives a stub agent by path and a pool whose figures are already
 * recorded, so nothing here probes the network or writes the process
 * environment.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkClaudeHealth,
  NO_ELIGIBLE_CREDENTIAL_EXIT_CODE,
} from "../lib/claude_runner.ts";
import { createClaudeCredentialPool } from "../lib/claude_credential_pool.ts";
import { createClaudeSpawnGate } from "../lib/claude_spawn_gate.ts";
import type { ClaudeTokenBudget } from "../lib/claude_token_budget.ts";
import type { ProviderTokenFile } from "../lib/credential_preflight.ts";
import {
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import { withAgentStub } from "./support/agent_stub.ts";

/** One hour, in milliseconds. */
const HOUR = 3_600_000;

/** The Claude provider descriptor the pool fixtures are built against. */
const CLAUDE = resolveAgentProvider(CLAUDE_PROVIDER_ID);

/** The refusal the CLI prints when the five-hour window is spent (#1665). */
const SESSION_LIMIT = "You've hit your session limit · resets 1:50pm (UTC)";

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

/** Measured figures for one token, as a probe would have reported them. */
function budget(
  label: string,
  fiveHourRemaining: number,
  now: number,
): ClaudeTokenBudget {
  return {
    known: true,
    label,
    remainingFraction: fiveHourRemaining,
    resetAt: now + 2 * HOUR,
    window: "five_hour",
    windows: [
      {
        window: "five_hour",
        remainingFraction: fiveHourRemaining,
        resetAt: now + 2 * HOUR,
      },
      {
        window: "seven_day",
        remainingFraction: 0.7,
        resetAt: now + 100 * HOUR,
      },
    ],
  };
}

/**
 * A gate over a pool of `labels`, with figures recorded before the check.
 *
 * The run environment carries the first label's token, exactly as worker
 * start leaves it, so the pool can tell which credential hit the limit.
 */
function pooledGate(
  labels: readonly string[],
  record: (pool: ReturnType<typeof createClaudeCredentialPool>) => void,
) {
  const applied: string[] = [];
  const lines: string[] = [];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    env: (name) =>
      name === "CLAUDE_CODE_OAUTH_TOKEN" ? `token-${labels[0]}` : undefined,
    discover: () => Promise.resolve(labels.map(tokenFile)),
    fetchFn: () => {
      throw new Error("the health check must not probe a recorded figure");
    },
    log: (line) => lines.push(line),
  });
  record(pool);
  return {
    gate: createClaudeSpawnGate(pool, {
      setEnv: (name, value) => applied.push(`${name}=${value}`),
      log: (line) => lines.push(line),
    }),
    applied,
    lines,
  };
}

/**
 * Run the health check against a stub that refuses with `stdoutMessage`,
 * counting how many times the stub was invoked.
 */
async function healthCheckAgainst(
  stdoutMessage: string,
  gate: Parameters<typeof checkClaudeHealth>[4],
) {
  const body = `printf 'x' >> "$(dirname "$0")/runs.log"\n` +
    `printf '%s\\n' ${JSON.stringify(stdoutMessage)}\n` +
    `exit 1\n`;
  return await withAgentStub(body, async (stub) => {
    const result = await checkClaudeHealth(
      10,
      undefined,
      undefined,
      stub.path,
      gate,
    );
    const probes = (await Deno.readTextFile(`${stub.dir}/runs.log`)
      .catch(() => "")).length;
    return { result, probes };
  }, { prefix: "claude_health_gate_" });
}

Deno.test({
  name:
    "checkClaudeHealth - a usage limit switches to an eligible credential and reports healthy (Issue #1669)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const now = Date.now();
    const { gate, applied } = pooledGate(["provider", "provider-2"], (pool) => {
      pool.recordBudget("provider", budget("provider", 0.9, now), now);
      pool.recordBudget("provider-2", budget("provider-2", 0.9, now), now);
    });

    const { result, probes } = await healthCheckAgainst(SESSION_LIMIT, gate);

    assertEquals(result.healthy, true);
    assertEquals(result.exitCode, 0);
    assertEquals(result.pauseSeconds, undefined);
    // ONE billed probe: the switch is confirmed by the next spawn's gate,
    // not by a second health check.
    assertEquals(probes, 1);
    // The credential that hit the limit was recorded spent, so the switch
    // must be to the other one.
    assertEquals(applied, ["CLAUDE_CODE_OAUTH_TOKEN=token-provider-2"]);
    assertStringIncludes(result.message, "provider-2");
  },
});

Deno.test({
  name:
    "checkClaudeHealth - a usage limit with no eligible credential is unhealthy with no pause (Issue #1669)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const now = Date.now();
    const { gate, applied } = pooledGate(["provider", "provider-2"], (pool) => {
      // The other subscription is already spent, and the probed one is about
      // to be recorded spent by the check itself.
      pool.recordExhaustion("provider-2", [
        { window: "five_hour", resetAt: now + 3 * HOUR },
      ]);
      pool.recordBudget("provider", budget("provider", 0.5, now), now);
    });

    const { result } = await healthCheckAgainst(SESSION_LIMIT, gate);

    assertEquals(result.healthy, false);
    // Deliberately not 3: exit 3 is what makes the consumer write the
    // `usage` signal and drain the slot pool.
    assertEquals(result.exitCode, NO_ELIGIBLE_CREDENTIAL_EXIT_CODE);
    assert(result.exitCode !== 3, "a usage limit must not pause the loop");
    assertEquals(result.pauseSeconds, undefined);
    assertEquals(applied, []);
  },
});

Deno.test({
  name:
    "checkClaudeHealth - a single-token host keeps the pausing exit 3 and consults no pool (Issue #1669)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { gate, applied, lines } = pooledGate(["provider"], () => {});

    const { result } = await healthCheckAgainst(SESSION_LIMIT, gate);

    assertEquals(result.healthy, false);
    assertEquals(result.exitCode, 3);
    assert(
      (result.pauseSeconds ?? 0) > 0,
      "the single-token host still pauses until its window resets",
    );
    assertEquals(applied, []);
    // No ranking, no switch, no new log line.
    assertEquals(lines, []);
  },
});

Deno.test({
  name:
    "checkClaudeHealth - a rate limit keeps its exit-3 pause even with a pool (Issue #1669)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const now = Date.now();
    const { gate, applied } = pooledGate(["provider", "provider-2"], (pool) => {
      pool.recordBudget("provider-2", budget("provider-2", 0.9, now), now);
    });

    const { result } = await healthCheckAgainst(
      "HTTP 429 rate limit exceeded, please retry",
      gate,
    );

    assertEquals(result.healthy, false);
    assertEquals(result.exitCode, 3);
    assertEquals(result.pauseSeconds, 600);
    // A per-minute cap is not a spent subscription window: no switch.
    assertEquals(applied, []);
  },
});
