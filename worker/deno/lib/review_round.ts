/**
 * One headless review-fleet-prs round, inside the worker container
 * (Issue #3293).
 *
 * The skill's runner (`.claude/skills/review-fleet-prs/scripts/run.sh`) used to start
 * each round as `claude -p` on the host, so the round ran on the host's own
 * `claude` login, and #3289 then copied the worker's credential plumbing into
 * a host script to choose a subscription. The runner now starts the round as
 * a `container run` of the worker image, and the entrypoint's `review-round`
 * mode lands here: the round's subscription is chosen by the same Claude
 * credential pool the worker uses at start-up
 * ({@link createClaudeCredentialPool}), and a round the usage limit stopped
 * is run once more on the next subscription that still has budget
 * ({@link ClaudeCredentialPool.selectAvailable}), so one exhausted window
 * does not stop the fleet review while the pool holds another.
 *
 * Subscriptions are named by label (`provider`, `provider-2`) only. No token
 * value is an input to anything logged here.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { CLAUDE_PROVIDER_ID, resolveAgentProvider } from "./agent_provider.ts";
import {
  applyProviderCredentialEnv,
  heldProviderCredentialLabel,
} from "./credential_preflight.ts";
import { createClaudeCredentialPool } from "./claude_credential_pool.ts";
import { detectUsageLimit } from "./claude_executor.ts";

/** What one `claude -p` attempt ended with. */
export interface ReviewRoundAttempt {
  /** The CLI's exit status; 127 when it could not be started. */
  code: number;
  /** The tail of its combined output, read for the usage-limit refusal. */
  output: string;
}

/** The round's seams; production uses {@link createReviewRoundDeps}. */
export interface ReviewRoundDeps {
  /**
   * Export the subscription start-up ranking picks into the round's
   * environment, returning its label, or undefined when no pool file was
   * exported (a token already in the environment, or no pool at all).
   */
  exportStartCredential(
    setEnv: (name: string, value: string) => void,
  ): Promise<string | undefined>;
  /**
   * Switch the round's environment to the best other subscription that still
   * has budget, returning its label, or null when none has.
   */
  switchCredential(
    exclude: string,
    setEnv: (name: string, value: string) => void,
  ): Promise<string | null>;
  /** Run `claude` with these arguments and this added environment. */
  runClaude(
    args: string[],
    env: Record<string, string>,
  ): Promise<ReviewRoundAttempt>;
  /** Where the round's own lines go. */
  log(message: string): void;
}

/**
 * Run one review round: `claude -p <prompt> <claudeArgs...>` on the pool's
 * subscription, retried once on another after a usage-limit refusal.
 *
 * @param prompt - The round's prompt, built by the runner.
 * @param claudeArgs - The remaining CLI arguments (model, tools).
 * @param deps - The seams; production passes {@link createReviewRoundDeps}.
 * @returns The exit status of the last attempt.
 */
export async function runReviewRound(
  prompt: string,
  claudeArgs: readonly string[],
  deps: ReviewRoundDeps,
): Promise<number> {
  // `claude -p` otherwise stops waiting for its reviewer agents 600s in and
  // ends the round with their PRs unreviewed; the runner's alarm is the
  // round's only limit.
  const env: Record<string, string> = {
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
  };
  const setEnv = (name: string, value: string) => {
    env[name] = value;
  };
  const args = ["-p", prompt, ...claudeArgs];

  const held = await deps.exportStartCredential(setEnv);
  if (held !== undefined) {
    deps.log(`round on Claude subscription ${held}`);
  }
  let attempt = await deps.runClaude(args, env);
  // A token that came from no pool file cannot say which one ran out, so
  // rotating could hand it straight back: only a held label is rotated.
  if (
    attempt.code !== 0 && held !== undefined && detectUsageLimit(attempt.output)
  ) {
    deps.log(
      `round hit the usage limit on subscription ${held}; selecting another`,
    );
    const next = await deps.switchCredential(held, setEnv);
    if (next !== null && next !== held) {
      deps.log(`retrying the round once on subscription ${next}`);
      attempt = await deps.runClaude(args, env);
    } else {
      deps.log("no other subscription has budget; the round stays failed");
    }
  }
  return attempt.code;
}

/** How much of the CLI's output is kept for the usage-limit check. */
const OUTPUT_TAIL_BYTES = 64 * 1024;

/**
 * Run `claude`, passing its output straight through to this process's own
 * stdout and stderr (the runner logs the container's output) while keeping
 * the tail for {@link detectUsageLimit}.
 */
export async function runClaudeCli(
  args: string[],
  env: Record<string, string>,
): Promise<ReviewRoundAttempt> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("claude", {
      args,
      env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    const message = `cannot run claude: ${
      error instanceof Error ? error.message : String(error)
    }\n`;
    await Deno.stderr.write(new TextEncoder().encode(message));
    return { code: 127, output: message };
  }
  let tail = "";
  const decoder = new TextDecoder();
  const pump = async (
    stream: ReadableStream<Uint8Array>,
    sink: { write(p: Uint8Array): Promise<number> },
  ) => {
    for await (const chunk of stream) {
      await sink.write(chunk);
      tail = (tail + decoder.decode(chunk, { stream: true }))
        .slice(-OUTPUT_TAIL_BYTES);
    }
  };
  const [status] = await Promise.all([
    child.status,
    pump(child.stdout, Deno.stdout),
    pump(child.stderr, Deno.stderr),
  ]);
  return { code: status.code, output: tail };
}

/**
 * The production seams: one Claude credential pool for the round, built the
 * way the worker builds its own.
 *
 * @param log - Where the pool's decision log and the round's lines go.
 */
export function createReviewRoundDeps(
  log: (message: string) => void,
): ReviewRoundDeps {
  const provider = resolveAgentProvider(CLAUDE_PROVIDER_ID);
  const pool = createClaudeCredentialPool({ log, provider });
  return {
    exportStartCredential: async (setEnv) => {
      await applyProviderCredentialEnv({
        providers: [provider],
        selectToken: pool.selectToken,
        setEnv,
      });
      return heldProviderCredentialLabel(CLAUDE_PROVIDER_ID);
    },
    switchCredential: async (exclude, setEnv) => {
      const token = await pool.selectAvailable({ exclude });
      if (token === null) return null;
      pool.applySelection(token, setEnv);
      return token.label;
    },
    runClaude: runClaudeCli,
    log,
  };
}
