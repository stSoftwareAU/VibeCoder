// The Claude subscription a headless review round runs on (Issue #3289).
//
// run.sh used to start every round with a bare `claude -p`, so the round ran
// on whatever account the host's `claude` was signed in to, and one exhausted
// subscription stopped the fleet review while the host's credential pool
// (`~/.vibe-coder/credentials/claude/provider*.env`) held others with budget.
// The worker already discovers that pool, probes each token's remaining
// budget and ranks them (worker/deno/lib: credential_preflight.ts,
// claude_token_budget.ts, claude_token_selection.ts); this script is the
// runner's call into the same code, so both pick the same way.
//
// Usage: deno run --allow-read --allow-env --allow-net=api.anthropic.com
//          claude_credential.ts [--exclude=<label>[,<label>]]
//        deno run --allow-read claude_credential.ts --usage-limit-log=<file>
// Output: one line of JSON, {"label","name","value"} for the selected
// subscription (the value is the token: never log it), or {"label":null}
// when the pool holds nothing usable, so the round falls back to the host's
// `claude` login as before. With --usage-limit-log, prints `true` when the
// file holds the CLI's usage-limit refusal, else `false`, so run.sh can
// retry the round once on another subscription. Every candidate and the
// reason it won or lost is logged to stderr by label only.
//
// The skill lives at <checkout>/.claude/skills/review-fleet-prs/.

import { detectUsageLimit } from "../../../worker/deno/lib/claude_executor.ts";
import {
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
} from "../../../worker/deno/lib/agent_provider.ts";
import {
  discoverProviderTokenFiles,
  providerPoolCandidates,
  type ProviderTokenSelector,
  resolveCredentialDir,
} from "../../../worker/deno/lib/credential_preflight.ts";
import type { ClaudeBudgetFetch } from "../../../worker/deno/lib/claude_token_budget.ts";
import { createClaudeBudgetTokenSelector } from "../../../worker/deno/lib/claude_token_selection.ts";

export interface RunnerCredential {
  /** File stem (`provider`, `provider-2`, …): safe to log. */
  label: string;
  /** The environment variable the token belongs in. */
  name: string;
  /** The token itself. NEVER log it. */
  value: string;
}

export interface SelectRunnerCredentialOptions {
  /** The credential directory; defaults to the worker's resolution of it. */
  dir?: string;
  /** Labels to leave out: the subscription a round just exhausted. */
  exclude?: readonly string[];
  /** Where the selection log goes; defaults to discarding it. */
  log?: (message: string) => void;
  /** Injected `fetch` for the budget probe; production gets the global. */
  fetchFn?: ClaudeBudgetFetch;
  /** Current time source for the ranking; defaults to the wall clock. */
  now?: () => number;
  /** Selector override, for tests that pin the wiring alone. */
  selector?: ProviderTokenSelector;
}

/**
 * Pick the subscription for a round from the host's Claude credential pool,
 * ranked by remaining budget exactly as the worker ranks it at start-up.
 * Fewer than two candidates means no probe: one file is used as it is, none
 * yields null.
 */
export async function selectRunnerCredential(
  options: SelectRunnerCredentialOptions = {},
): Promise<RunnerCredential | null> {
  const log = options.log ?? (() => {});
  const provider = resolveAgentProvider(CLAUDE_PROVIDER_ID);
  const dir = options.dir ?? resolveCredentialDir();
  const tokens = await discoverProviderTokenFiles(dir, provider);
  const exclude = new Set(options.exclude ?? []);
  const pool = providerPoolCandidates(tokens).filter((token) =>
    !exclude.has(token.label)
  );
  if (pool.length === 0) {
    log(
      exclude.size > 0
        ? `claude credential pool: no subscription left after excluding ${
          [...exclude].join(", ")
        }`
        : `claude credential pool: no subscription in ${dir}/claude`,
    );
    return null;
  }
  const selector = options.selector ?? createClaudeBudgetTokenSelector({
    log,
    fetchFn: options.fetchFn,
    now: options.now,
  });
  const chosen = await selector(pool, provider);
  if (chosen === null || chosen.name === null || chosen.value === null) {
    return null;
  }
  log(`claude credential pool: round runs on subscription ${chosen.label}`);
  return { label: chosen.label, name: chosen.name, value: chosen.value };
}

/** Whether a round's output holds the CLI's usage-limit refusal. */
export function roundHitUsageLimit(text: string): boolean {
  return detectUsageLimit(text);
}

function arg(name: string): string | undefined {
  const hit = Deno.args.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main() {
  const logPath = arg("usage-limit-log");
  if (logPath !== undefined) {
    const text = await Deno.readTextFile(logPath).catch(() => "");
    console.log(roundHitUsageLimit(text) ? "true" : "false");
    return;
  }
  const exclude = (arg("exclude") ?? "").split(",").filter((l) => l !== "");
  const chosen = await selectRunnerCredential({
    exclude,
    log: (message) => console.error(message),
  });
  console.log(JSON.stringify(chosen ?? { label: null }));
}

if (import.meta.main) await main();
