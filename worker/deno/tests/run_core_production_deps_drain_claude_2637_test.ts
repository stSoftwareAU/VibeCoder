/**
 * Production wiring for "drain Claude completely before flipping" (Issue
 * #2637).
 *
 * On GRQ-23 (2026-09-25) the weekly-pace guard engaged with Claude at 68% of
 * its week, and the #2470 pace fallback switched the whole host to DeepSeek —
 * top-priority and work-on claims included — which answered `402 Insufficient
 * Balance` three minutes later. The owner's rule since: a pace *projection*
 * never moves work to the fallback provider, and the fallback takes over only
 * once every Claude credential in the pool is exhausted on its five-hour
 * window or its weekly limit.
 *
 * These tests drive the real `createProductionRunCoreDeps` in both
 * directions:
 *
 * - pace engaged with an `ordered` fallback configured: the scan switches no
 *   provider, and the one verdict the scan, the census and the filer share
 *   still drops the backlog tiers; pace not engaged: nothing drops and
 *   nothing switches;
 * - two of three credentials exhausted: the health gate's rotation hook
 *   switches the run's token to the third, so the run stays on Claude; all
 *   three exhausted: it answers null, so the loop's fallback path may run.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
  runProviderOverrideId,
  setRunProviderOverride,
} from "../lib/agent_provider.ts";
import type { ClaudeWeekPaceGate } from "../lib/claude_week_pace.ts";
import { createClaudeCredentialPool } from "../lib/claude_credential_pool.ts";
import {
  type ProviderTokenFile,
  recordHeldProviderCredential,
  resetHeldProviderCredentials,
} from "../lib/credential_preflight.ts";
import type { WorkerConfig } from "../types.ts";

const HOUR = 3_600_000;

/** A pace gate holding a fixed verdict, as the scan and census read it. */
function paceGate(engaged: boolean): ClaudeWeekPaceGate {
  return {
    isEngaged: () => Promise.resolve(engaged),
    lastEngaged: () => engaged,
  };
}

/** A host preferring Claude with DeepSeek as its ordered fallback. */
function fallbackConfig(workDir: string): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: [],
    workDir,
    agentProvider: CLAUDE_PROVIDER_ID,
    enabledAgentProviders: [CLAUDE_PROVIDER_ID, "deepseek"],
    agentProviderFallback: ["deepseek"],
  };
}

/** Every `gh` probe answers empty, so nothing here reaches the network. */
const emptyGh = () => Promise.resolve("[]");

/** A pool token file, the shape discovery produces for `claude/<label>.env`. */
function tokenFile(label: string): ProviderTokenFile {
  const name = "CLAUDE_CODE_OAUTH_TOKEN";
  const value = `token-${label}`; // gitleaks:allow fake fixture, not a real key
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

async function withWorkDir(
  fn: (workDir: string) => Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "drain-claude-2637-" });
  try {
    await fn(workDir);
  } finally {
    setRunProviderOverride(undefined);
    resetHeldProviderCredentials();
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

for (const engaged of [true, false]) {
  Deno.test(
    `production deps - pace ${
      engaged ? "engaged" : "not engaged"
    } with a fallback configured: no provider switch, and the shared verdict ${
      engaged ? "drops" : "keeps"
    } the backlog tiers (Issue #2637)`,
    async () => {
      await withWorkDir(async (workDir) => {
        setRunProviderOverride(undefined);
        const lines: string[] = [];
        const { deps, cleanup } = await createProductionRunCoreDeps({
          repoDir: workDir,
          workDir,
          githubUser: "worker-bot",
          logger: createLogger({ write: (line: string) => lines.push(line) }),
          config: fallbackConfig(workDir),
          weekPaceGate: paceGate(engaged),
          idleDetectGhCommandFn: emptyGh,
          fleetPrefetchGhCommandFn: emptyGh,
        });
        try {
          await deps.findNextIssue();

          assertEquals(
            runProviderOverrideId(),
            undefined,
            "a pace projection never switches the active provider",
          );
          assertEquals(
            lines.filter((l) => l.includes("[pace-fallback]")),
            [],
            "no pace-driven switch is attempted or announced",
          );
          // The census and the filer read this same verdict, so they model
          // exactly the refusal the scan applied — the #2470 invariant.
          assertEquals(deps.weekPaceEngaged?.(), engaged);
        } finally {
          cleanup();
        }
      });
    },
  );
}

/** A `fetch` answering one token's probe with a healthy budget. */
function healthyProbeFor(token: string, now: number) {
  return (_url: string, init: RequestInit) => {
    const auth = String(
      (init.headers as Record<string, string>)["authorization"] ?? "",
    );
    if (auth !== `Bearer ${token}`) {
      return Promise.resolve(new Response("nope", { status: 401 }));
    }
    return Promise.resolve(
      new Response("{}", {
        status: 200,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "0.3",
          "anthropic-ratelimit-unified-5h-reset": String(
            Math.round((now + 3 * HOUR) / 1000),
          ),
          "anthropic-ratelimit-unified-7d-utilization": "0.4",
          "anthropic-ratelimit-unified-7d-reset": String(
            Math.round((now + 90 * HOUR) / 1000),
          ),
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
        },
      }),
    );
  };
}

for (const allSpent of [false, true]) {
  Deno.test(
    `production deps - ${
      allSpent ? "three" : "two"
    } of three Claude credentials exhausted: ${
      allSpent
        ? "no credential is chosen, so the fallback may take over"
        : "the run's token rotates to the third"
    } (Issue #2637)`,
    async () => {
      await withWorkDir(async (workDir) => {
        const now = Date.now();
        const pool = createClaudeCredentialPool({
          provider: resolveAgentProvider(CLAUDE_PROVIDER_ID),
          discover: () =>
            Promise.resolve([
              tokenFile("provider"),
              tokenFile("provider-2"),
              tokenFile("provider-3"),
            ]),
          fetchFn: healthyProbeFor("token-provider-3", now),
          now: () => now,
        });
        // provider is held and spent on its five-hour window; provider-2 on
        // its weekly limit.
        recordHeldProviderCredential(CLAUDE_PROVIDER_ID, "provider");
        pool.recordExhaustion("provider", [
          { window: "five_hour", resetAt: now + 2 * HOUR },
        ]);
        pool.recordExhaustion("provider-2", [
          { window: "seven_day", resetAt: now + 60 * HOUR },
        ]);
        if (allSpent) {
          pool.recordExhaustion("provider-3", [
            { window: "seven_day", resetAt: now + 80 * HOUR },
          ]);
        }
        const set: Array<[string, string]> = [];
        const { deps, cleanup } = await createProductionRunCoreDeps({
          repoDir: workDir,
          workDir,
          githubUser: "worker-bot",
          logger: createLogger({ write: () => {} }),
          config: fallbackConfig(workDir),
          weekPaceGate: paceGate(false),
          claudeCredentialPool: pool,
          setEnv: (name, value) => set.push([name, value]),
        });
        try {
          assert(deps.selectPreferredCredential, "the hook must be wired");
          const label = await deps.selectPreferredCredential({
            excludeHeld: true,
          });
          if (allSpent) {
            assertEquals(label, null);
            assertEquals(set, [], "the run environment is left alone");
          } else {
            assertEquals(label, "provider-3");
            assertEquals(set, [[
              "CLAUDE_CODE_OAUTH_TOKEN",
              "token-provider-3", // gitleaks:allow fake fixture, not a real key
            ]]);
          }
        } finally {
          cleanup();
        }
      });
    },
  );
}
