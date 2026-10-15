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
 * does not stop the fleet review while the pool holds another. When the whole
 * pool is exhausted the round runs once more on the fallback provider —
 * DeepSeek, in the worker's own pinned child environment — so fleet review
 * does not stop for the rest of a window the fleet itself has already
 * switched away from (Issue #3632).
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
  selectFirstProviderToken,
} from "./credential_preflight.ts";
import { createClaudeCredentialPool } from "./claude_credential_pool.ts";
import { detectUsageLimit } from "./claude_executor.ts";
import { DEEPSEEK_PROVIDER_ID } from "./agent_provider.ts";
import { buildDeepSeekChildEnv } from "./deepseek_env.ts";
import {
  REVIEW_RUN_FILE,
  type ReviewRunAttempt,
  type ReviewRunRecord,
} from "./review_run_record.ts";

export { REVIEW_RUN_FILE, type ReviewRunAttempt, type ReviewRunRecord };

/**
 * The fallback provider's model for a round (Issue #3632): DeepSeek's best.
 * The pinned `claude-opus-5-5` id would be silently remapped by the endpoint
 * anyway — asking for the model the operator chose is the honest spelling.
 */
export const REVIEW_FALLBACK_MODEL = "deepseek-v4-pro";

/** Options for {@link runReviewRound}. */
export interface ReviewRoundOptions {
  /**
   * The round's own directory. When set, each attempt is recorded in its
   * {@link REVIEW_RUN_FILE} and streams to its own file there.
   */
  roundDir?: string;
}

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
  /**
   * Export the fallback provider's credential and build its child
   * environment (Issue #3632), returning the provider id and the complete
   * environment for the fallback attempt — or null when the fallback
   * provider has no credential to export. The environment is the provider's
   * own: no Claude credential may reach the third-party endpoint.
   */
  exportFallbackCredential(
    setEnv: (name: string, value: string) => void,
  ): Promise<{ providerId: string; env: Record<string, string> } | null>;
  /**
   * Run `claude` with these arguments and this added environment, writing
   * its raw output to `streamFile` when one is given.
   */
  runClaude(
    args: string[],
    env: Record<string, string>,
    streamFile?: string,
  ): Promise<ReviewRoundAttempt>;
  /** Save the round's attempt log in its directory. */
  recordRun?(roundDir: string, record: ReviewRunRecord): Promise<void>;
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
 * @param options.roundDir - The round's directory, where each attempt is
 *   recorded and streams its output.
 * @returns The exit status of the last attempt.
 */
export async function runReviewRound(
  prompt: string,
  claudeArgs: readonly string[],
  deps: ReviewRoundDeps,
  options: ReviewRoundOptions = {},
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
  const roundDir = options.roundDir?.replace(/\/+$/, "");
  const record: ReviewRunRecord = {
    round: roundDir?.split("/").pop() ?? "",
    attempts: [],
  };
  // Each attempt is recorded before it starts, so a review posted while it
  // runs can name its provider and model, and again with its exit status.
  const runAttempt = async (
    attemptArgs: string[],
    attemptEnv: Record<string, string>,
    provider: string,
  ): Promise<ReviewRoundAttempt> => {
    if (roundDir === undefined) return deps.runClaude(attemptArgs, attemptEnv);
    const n = record.attempts.length + 1;
    const entry: ReviewRunAttempt = {
      attempt: n,
      provider,
      model: argValue(attemptArgs, "--model"),
      effort: argValue(attemptArgs, "--effort"),
      stream: `stream-${n}.jsonl`,
    };
    record.attempts.push(entry);
    await deps.recordRun?.(roundDir, record);
    const result = await deps.runClaude(
      attemptArgs,
      attemptEnv,
      `${roundDir}/${entry.stream}`,
    );
    entry.code = result.code;
    await deps.recordRun?.(roundDir, record);
    return result;
  };

  const held = await deps.exportStartCredential(setEnv);
  if (held !== undefined) {
    deps.log(`round on Claude subscription ${held}`);
  }
  let attempt = await runAttempt(args, env, CLAUDE_PROVIDER_ID);
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
      attempt = await runAttempt(args, env, CLAUDE_PROVIDER_ID);
    } else {
      deps.log("no other subscription has budget");
    }
  }
  // Issue #3632: when every Claude path is exhausted — no held label to
  // rotate, no subscription with budget, or the rotated retry hit the limit
  // too — the round runs once more on the fallback provider. Subscriptions
  // rotate blindly by label; a provider switch is a different class of
  // decision, so it is announced as such and runs in the fallback's own
  // child environment, never the Claude one.
  if (attempt.code !== 0 && detectUsageLimit(attempt.output)) {
    const fallback = await deps.exportFallbackCredential(setEnv);
    if (fallback !== null) {
      deps.log(`round fell back to provider ${fallback.providerId}`);
      attempt = await runAttempt(
        withModel(args, REVIEW_FALLBACK_MODEL),
        fallback.env,
        fallback.providerId,
      );
    } else {
      deps.log("no other subscription has budget; the round stays failed");
    }
  }
  return attempt.code;
}

/**
 * The round's CLI arguments with the `--model` value replaced, or the pair
 * appended when the runner passed none (Issue #3632). The value is replaced,
 * never added twice: a round re-run from a state file could otherwise carry
 * two model pins.
 */
function withModel(claudeArgs: readonly string[], model: string): string[] {
  const args = [...claudeArgs];
  const idx = args.indexOf("--model");
  if (idx >= 0 && idx + 1 < args.length) {
    args[idx + 1] = model;
  } else {
    args.push("--model", model);
  }
  return args;
}

/** The value after `flag` in a CLI argument list, or null when absent. */
function argValue(args: readonly string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1]! : null;
}

/**
 * One line of the CLI's stream-json output as the round's log shows it, or
 * null to leave it out. The runner's logs keep what the text output used to
 * show: each `result` line's text (the round's report, or the usage-limit
 * refusal {@link detectUsageLimit} reads), plus any line that is not JSON at
 * all. The full stream is in the attempt's own file.
 */
export function renderStreamLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  if (!trimmed.startsWith("{")) return line;
  let parsed: { type?: unknown; result?: unknown };
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return line;
  }
  return parsed.type === "result" && typeof parsed.result === "string"
    ? parsed.result
    : null;
}

/** How much of the CLI's output is kept for the usage-limit check. */
const OUTPUT_TAIL_BYTES = 64 * 1024;

/**
 * Run `claude`, passing its output straight through to this process's own
 * stdout and stderr (the runner logs the container's output) while keeping
 * the tail for {@link detectUsageLimit}.
 *
 * With `streamFile`, stdout is the CLI's stream-json: it is written there in
 * full, and only its readable lines ({@link renderStreamLine}) are passed
 * through and kept for the usage-limit check.
 */
export async function runClaudeCli(
  args: string[],
  env: Record<string, string>,
  streamFile?: string,
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
  const encoder = new TextEncoder();
  // Best effort: a stream file that cannot be opened leaves the attempt
  // uncosted ("cost unknown"), never a failed round.
  const file = streamFile === undefined ? undefined : await Deno.open(
    streamFile,
    { write: true, create: true, truncate: true },
  ).catch(() => undefined);
  const pumpStream = async (stream: ReadableStream<Uint8Array>) => {
    const lineDecoder = new TextDecoder();
    let pending = "";
    const emit = async (line: string) => {
      const shown = renderStreamLine(line);
      if (shown === null) return;
      await Deno.stdout.write(encoder.encode(`${shown}\n`));
      tail = (tail + shown + "\n").slice(-OUTPUT_TAIL_BYTES);
    };
    for await (const chunk of stream) {
      await file?.write(chunk).catch(() => 0);
      pending += lineDecoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) await emit(line);
    }
    await emit(pending + lineDecoder.decode());
    file?.close();
  };
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
    file === undefined
      ? pump(child.stdout, Deno.stdout)
      : pumpStream(child.stdout),
    pump(child.stderr, Deno.stderr),
  ]);
  return { code: status.code, output: tail };
}

/**
 * The production seams: one Claude credential pool for the round, built the
 * way the worker builds its own.
 *
 * @param log - Where the pool's decision log and the round's lines go.
 * @param options.credentialDir - Overrides the credential directory the
 *   fallback provider's credential is read from (Issue #3632). Production
 *   omits it and gets the environment-resolved directory; a wiring test
 *   points it at a fixture so no process environment is mutated. Scoped to
 *   the fallback export — the Claude pool keeps its own resolution.
 */
export function createReviewRoundDeps(
  log: (message: string) => void,
  options: { credentialDir?: string } = {},
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
    exportFallbackCredential: async (setEnv) => {
      // Issue #3632: the fallback is the worker's own DeepSeek provider — the
      // credential file provisioned under the `deepseek` sub-directory,
      // exported the way the worker's start-up exports every provider's.
      const fallbackProvider = resolveAgentProvider(DEEPSEEK_PROVIDER_ID);
      const values: Record<string, string> = {};
      const exported = await applyProviderCredentialEnv({
        dir: options.credentialDir,
        providers: [fallbackProvider],
        selectToken: selectFirstProviderToken,
        setEnv: (name, value) => {
          values[name] = value;
          setEnv(name, value);
        },
      });
      if (exported.length === 0) return null;
      // The child env is DeepSeek's own: the base URL and auth token are
      // pinned, no Claude credential may reach the third-party endpoint, and
      // the config dir is DeepSeek's so `--resume` cannot cross providers
      // (`deepseek_env.ts`). The exported values are overlaid on the process
      // environment so the build sees the credential it just exported.
      const env = buildDeepSeekChildEnv({
        ...Deno.env.toObject(),
        ...values,
      });
      env["CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"] = "0";
      return { providerId: DEEPSEEK_PROVIDER_ID, env };
    },
    runClaude: runClaudeCli,
    recordRun: async (roundDir, record) => {
      // Best effort: an unwritable round directory leaves the reviews
      // without a named model ("cost unknown"), never a failed round.
      await Deno.writeTextFile(
        `${roundDir}/${REVIEW_RUN_FILE}`,
        JSON.stringify(record) + "\n",
      ).catch((error) => log(`could not record the round's attempt: ${error}`));
    },
    log,
  };
}
