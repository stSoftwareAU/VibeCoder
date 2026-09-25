/**
 * Production wiring for the pool-wide weekly pace verdict (Issue #2647).
 *
 * The real `createProductionRunCoreDeps` builds the pace gate from the same
 * Claude credential pool the health gate rotates through, so a pooled host
 * is judged across every credential. Both directions: a pool with a fresh
 * credential beside a nearly spent held one keeps the backlog tiers; a pool
 * that runs out before anything reopens drops them. Either way the one
 * verdict the scan computed is what the census and the filer read.
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
  setRunProviderOverride,
} from "../lib/agent_provider.ts";
import { createClaudeCredentialPool } from "../lib/claude_credential_pool.ts";
import type { ClaudeTokenBudget } from "../lib/claude_token_budget.ts";
import type { ProviderTokenFile } from "../lib/credential_preflight.ts";
import { resetHeldProviderCredentials } from "../lib/credential_preflight.ts";
import { envFrom } from "./support/env_lookup.ts";

const HOUR = 3_600_000;
const HELD = "token-provider"; // gitleaks:allow fake fixture, not a real key

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

/** A seven-day reading `used` spent, reopening `resetInHours` from `now`. */
function weekly(
  label: string,
  used: number,
  resetInHours: number,
  now: number,
): ClaudeTokenBudget {
  const resetAt = now + resetInHours * HOUR;
  return {
    known: true,
    label,
    remainingFraction: 1 - used,
    resetAt,
    window: "seven_day",
    windows: [{ window: "seven_day", remainingFraction: 1 - used, resetAt }],
  };
}

for (const fresh of [true, false]) {
  Deno.test(
    `production deps - the pace gate judges the whole pool: ${
      fresh
        ? "a fresh credential beside a spent held one keeps the backlog"
        : "a pool that runs out first drops the backlog"
    } (Issue #2647)`,
    async () => {
      const workDir = await Deno.makeTempDir({ prefix: "pool-pace-2647-" });
      try {
        setRunProviderOverride(undefined);
        const now = Date.now();
        const pool = createClaudeCredentialPool({
          provider: resolveAgentProvider(CLAUDE_PROVIDER_ID),
          discover: () =>
            Promise.resolve([
              tokenFile("provider"),
              tokenFile("provider-2"),
              tokenFile("provider-3"),
            ]),
          // Every reading is recorded below; a probe would be a bug.
          fetchFn: () => Promise.resolve(new Response("", { status: 401 })),
          now: () => now,
        });
        // The held token alone is well over pace (95% in three days).
        pool.recordBudget("provider", weekly("provider", 0.95, 96, now), now);
        pool.recordBudget(
          "provider-2",
          weekly("provider-2", fresh ? 0 : 0.9, 96, now),
          now,
        );
        pool.recordBudget(
          "provider-3",
          weekly("provider-3", fresh ? 0.2 : 0.9, 96, now),
          now,
        );
        const lines: string[] = [];
        const { deps, cleanup } = await createProductionRunCoreDeps({
          repoDir: workDir,
          workDir,
          githubUser: "worker-bot",
          logger: createLogger({ write: (line: string) => lines.push(line) }),
          config: {
            ...buildDefaultWorkerConfig(),
            repos: [],
            workDir,
            agentProvider: CLAUDE_PROVIDER_ID,
            // The guard itself, not the #2474 drain mode that parks it.
            claudeWeekPaceDrain: false,
          },
          env: envFrom({
            CLAUDE_CODE_OAUTH_TOKEN: HELD,
            HOME: workDir,
            TMPDIR: workDir,
          }),
          claudeCredentialPool: pool,
          idleDetectGhCommandFn: () => Promise.resolve("[]"),
          fleetPrefetchGhCommandFn: () => Promise.resolve("[]"),
        });
        try {
          await deps.findNextIssue();
          // The scan, the census and the filer all read this one verdict.
          assertEquals(deps.weekPaceEngaged?.(), !fresh);
          const pace = lines.filter((l) => l.includes("claude-week-pace:"));
          if (fresh) {
            assertEquals(pace, [], "an on-pace pool logs nothing");
          } else {
            assert(
              pace.some((l) => l.includes("engaged — pool counted=3/3")),
              `expected a pool engaged line, got: ${pace.join(" | ")}`,
            );
          }
          for (const line of lines) {
            assert(!line.includes(HELD), "no token value reaches a log line");
          }
        } finally {
          cleanup();
        }
      } finally {
        setRunProviderOverride(undefined);
        resetHeldProviderCredentials();
        await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
      }
    },
  );
}
