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
 * When the whole Claude side is spent the round moves on along a fixed chain
 * (Issues #3632, #5081, #5083):
 *
 *   Fable 5.2 → Opus 5.5 `xhigh` on the same subscription
 *     → the Claude pool's next subscription with budget
 *     → Codex `gpt-6-astra` at `high` effort, when a Codex credential is provisioned
 *     → DeepSeek, in the worker's own pinned child environment
 *
 * Each link runs only once the one before it is spent. A usage limit is the
 * only thing that moves the round on: an attempt that fails for any other
 * reason ends the round there. Every provider or model switch is logged once,
 * as an `INFO:` line that names what it switched to; a quota is never logged
 * as an error.
 *
 * Subscriptions are named by label (`provider`, `provider-2`) only. No token
 * value is an input to anything logged here.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  resolveAgentProvider,
} from "./agent_provider.ts";
import {
  applyProviderCredentialEnv,
  heldProviderCredentialLabel,
  selectFirstProviderToken,
} from "./credential_preflight.ts";
import { createClaudeCredentialPool } from "./claude_credential_pool.ts";
import { detectUsageLimit } from "./claude_executor.ts";
import { DEEPSEEK_PROVIDER_ID } from "./agent_provider.ts";
import { CODEX_API_KEY_ENV_VARS, CODEX_HOME_ENV_VAR } from "./codex_auth.ts";
import { buildCodexArgs, composeCodexPrompt } from "./codex_executor.ts";
import { CODEX_OUTPUT_ADAPTER } from "./codex_output_adapter.ts";
import { DEFAULT_CODEX_MODEL_TOP_TIER } from "./config_defaults.ts";
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

/**
 * Where a Fable round steps down to on the same subscription when it hits a
 * usage limit (Issue #5081). Fable can be capped at a share of the weekly
 * limit apart from the rest of the plan, so Opus 5.5 — the previous reviewer —
 * may still have budget; `xhigh` because Opus at `xhigh` is what reviewed
 * before Fable 5.2 at `high` replaced it.
 */
export const REVIEW_STEP_DOWN_MODEL = "claude-opus-5-5";
export const REVIEW_STEP_DOWN_EFFORT = "xhigh";

/**
 * The Codex link's model (Issue #5083): the top tier the Codex CLI serves,
 * the id `config_defaults.ts` routes Codex's best tier to.
 */
export const REVIEW_CODEX_MODEL = DEFAULT_CODEX_MODEL_TOP_TIER;

/**
 * The Codex link's reasoning effort (Issue #5083). Codex has no `xhigh` or
 * `max`, so `high` is the most effort it takes.
 */
export const REVIEW_CODEX_EFFORT = "high";

/**
 * What Codex is told about the round it has been handed (Issue #5083). The
 * round's own prompt follows it on stdin. The skill it names is the one the
 * Claude round reads, so both reviewers judge by the same rules.
 */
export const CODEX_ROUND_NOTE = [
  "You are running this review round as the Codex CLI, not Claude Code: Claude skills and the Agent tool are not available here.",
  "Read the skill file .claude/skills/review-fleet-prs/SKILL.md (relative to the working directory, the read-only checkout) and follow it.",
  "Where it says to launch a fleet-pr-reviewer agent, review that PR yourself under .claude/agents/fleet-pr-reviewer.md and the brief it names, and hand post.ts the same review JSON it would have received.",
  "The checkout is read-only, so write files only under /tmp and the round's own directory, and never push, edit or comment on GitHub except through post.ts.",
].join("\n");

/** Options for {@link runReviewRound}. */
export interface ReviewRoundOptions {
  /**
   * The round's own directory. When set, each attempt is recorded in its
   * {@link REVIEW_RUN_FILE} and streams to its own file there.
   */
  roundDir?: string;
  deployment?: {
    component: "reviewer";
    hostId?: string;
    codeRevision: string;
    policyFingerprint: string;
  };
}

/** What one CLI attempt ended with. */
export interface ReviewRoundAttempt {
  /** The CLI's exit status; 127 when it could not be started. */
  code: number;
  /** The tail of its combined output, read for the usage-limit refusal. */
  output: string;
  /**
   * Set by a runner that classified its own output (Codex, Issue #5083). When
   * absent, {@link detectUsageLimit} reads {@link output}.
   */
  usageLimited?: boolean;
}

/** The provider, model and effort an attempt is recorded under (Issue #5083). */
interface AttemptIdentity {
  provider: string;
  model: string | null;
  effort: string | null;
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
   * Export the Codex provider's credential into a Codex-only child
   * environment (Issue #5083), or null when no Codex credential is
   * provisioned. No Claude credential may reach that environment.
   */
  exportCodexCredential(): Promise<{ env: Record<string, string> } | null>;
  /**
   * Run `claude` with these arguments and this added environment, writing
   * its raw output to `streamFile` when one is given.
   */
  runClaude(
    args: string[],
    env: Record<string, string>,
    streamFile?: string,
  ): Promise<ReviewRoundAttempt>;
  /**
   * Run `codex exec` with these arguments, this prompt on stdin and this
   * environment, writing its raw stream to `streamFile` when one is given
   * (Issue #5083).
   */
  runCodex(
    args: string[],
    stdin: string,
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
 * subscription, then the fallback chain when the subscription runs out
 * (Issues #3293, #5081, #3632, #5083):
 *
 * 1. a Fable round that hit a usage limit steps down to Opus on the same
 *    subscription;
 * 2. a held subscription that hit the limit is retried once on another with
 *    budget;
 * 3. the round runs once on Codex ({@link REVIEW_CODEX_MODEL}) with the same
 *    prompt, when a Codex credential is provisioned;
 * 4. the round runs once on DeepSeek, when the attempt is still usage-limited.
 *
 * A link runs only when the one before it ended on a usage limit. An attempt
 * that fails for any other reason ends the round at that point.
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
    ...(options.deployment
      ? {
        deployment: {
          ...options.deployment,
          observedAt: new Date().toISOString(),
        },
      }
      : {}),
  };
  // Each attempt is recorded before it starts, so a review posted while it
  // runs can name its provider and model, and again with its exit status.
  const runAttempt = async (
    identity: AttemptIdentity,
    run: (streamFile?: string) => Promise<ReviewRoundAttempt>,
  ): Promise<ReviewRoundAttempt> => {
    if (roundDir === undefined) return run();
    const n = record.attempts.length + 1;
    const entry: ReviewRunAttempt = {
      attempt: n,
      provider: identity.provider,
      model: identity.model,
      effort: identity.effort,
      stream: `stream-${n}.jsonl`,
    };
    record.attempts.push(entry);
    if (options.deployment) {
      record.deployment = {
        ...options.deployment,
        observedAt: new Date().toISOString(),
      };
    }
    await deps.recordRun?.(roundDir, record);
    const result = await run(`${roundDir}/${entry.stream}`);
    entry.code = result.code;
    await deps.recordRun?.(roundDir, record);
    return result;
  };

  const held = await deps.exportStartCredential(setEnv);
  if (held !== undefined) {
    deps.log(`round on Claude subscription ${held}`);
  }
  let attempt = await runAttempt(
    claudeIdentity(args),
    (stream) => deps.runClaude(args, env, stream),
  );
  // Issue #5081: a Fable round that hit a usage limit first tries Opus on the
  // same subscription — Fable's own cap is not the whole plan's.
  const requested = argValue(args, "--model") ?? "";
  if (
    attempt.code !== 0 && /^(claude-)?fable/.test(requested) &&
    usageLimited(attempt)
  ) {
    deps.log(
      `INFO: round hit a usage limit on ${requested}; stepping down to ` +
        `${REVIEW_STEP_DOWN_MODEL} on the same subscription`,
    );
    const stepDownArgs = withEffort(
      withModel(args, REVIEW_STEP_DOWN_MODEL),
      REVIEW_STEP_DOWN_EFFORT,
    );
    attempt = await runAttempt(
      claudeIdentity(stepDownArgs),
      (stream) => deps.runClaude(stepDownArgs, env, stream),
    );
  }
  // A token that came from no pool file cannot say which one ran out, so
  // rotating could hand it straight back: only a held label is rotated.
  if (
    attempt.code !== 0 && held !== undefined && usageLimited(attempt)
  ) {
    deps.log(
      `round hit the usage limit on subscription ${held}; selecting another`,
    );
    const next = await deps.switchCredential(held, setEnv);
    if (next !== null && next !== held) {
      deps.log(`INFO: retrying the round once on subscription ${next}`);
      attempt = await runAttempt(
        claudeIdentity(args),
        (stream) => deps.runClaude(args, env, stream),
      );
    } else {
      deps.log("no other subscription has budget");
    }
  }
  // Issue #5083: when every Claude path is spent the round runs once on Codex
  // with the same prompt. Codex is another vendor's subscription, so a refusal
  // from it that is not a usage limit ends the round here, before DeepSeek.
  if (attempt.code !== 0 && usageLimited(attempt)) {
    const codex = await deps.exportCodexCredential();
    if (codex !== null) {
      deps.log(
        `INFO: round fell back to provider ${CODEX_PROVIDER_ID} ` +
          `(model ${REVIEW_CODEX_MODEL})`,
      );
      const codexArgs = buildCodexArgs({
        prompt: "",
        systemPrompt: CODEX_ROUND_NOTE,
        orchestrationRole: "reviewer",
        model: REVIEW_CODEX_MODEL,
        effort: REVIEW_CODEX_EFFORT,
        promptViaStdin: true,
      });
      const codexStdin = composeCodexPrompt({
        prompt,
        systemPrompt: CODEX_ROUND_NOTE,
      });
      attempt = await runAttempt(
        {
          provider: CODEX_PROVIDER_ID,
          model: REVIEW_CODEX_MODEL,
          effort: REVIEW_CODEX_EFFORT,
        },
        (stream) => deps.runCodex(codexArgs, codexStdin, codex.env, stream),
      );
    } else {
      deps.log("no Codex credential; skipping the codex fallback");
    }
  }
  // Issue #3632: when every link above is spent — no held label to rotate, no
  // subscription with budget, the rotated retry hit the limit too, or there is
  // no Codex credential — or Codex itself hit its limit, the round runs once
  // more on the fallback provider. A provider switch is a different class of
  // decision, so it is announced as such and runs in the fallback's own
  // child environment, never the Claude one.
  if (attempt.code !== 0 && usageLimited(attempt)) {
    const fallback = await deps.exportFallbackCredential(setEnv);
    if (fallback !== null) {
      deps.log(`INFO: round fell back to provider ${fallback.providerId}`);
      const fallbackArgs = withModel(args, REVIEW_FALLBACK_MODEL);
      attempt = await runAttempt(
        { ...claudeIdentity(fallbackArgs), provider: fallback.providerId },
        (stream) => deps.runClaude(fallbackArgs, fallback.env, stream),
      );
    } else {
      deps.log("no other subscription has budget; the round stays failed");
    }
  }
  return attempt.code;
}

/**
 * Whether an attempt ended on a usage limit (Issue #5083). A runner that
 * classified its own output says so; otherwise the Claude output is read.
 */
function usageLimited(attempt: ReviewRoundAttempt): boolean {
  return attempt.usageLimited ?? detectUsageLimit(attempt.output);
}

/**
 * The provider, model and effort of a `claude -p` attempt: its model and
 * effort are the flags it was given (Issue #5083).
 */
function claudeIdentity(claudeArgs: readonly string[]): AttemptIdentity {
  return {
    provider: CLAUDE_PROVIDER_ID,
    model: argValue(claudeArgs, "--model"),
    effort: argValue(claudeArgs, "--effort"),
  };
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

/** The round's CLI arguments with the `--effort` value set (Issue #5081). */
function withEffort(claudeArgs: readonly string[], effort: string): string[] {
  const args = [...claudeArgs];
  const idx = args.indexOf("--effort");
  if (idx >= 0 && idx + 1 < args.length) {
    args[idx + 1] = effort;
  } else {
    args.push("--effort", effort);
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

/**
 * One line of `codex exec --json` output as the round's log shows it, or null
 * to leave it out (Issue #5083). The agent's message and any error the run
 * reports are shown; every other event is left to the attempt's own file. A
 * line that is not JSON at all is shown as it is.
 */
export function renderCodexStreamLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  if (!trimmed.startsWith("{")) return line;
  try {
    JSON.parse(trimmed);
  } catch {
    return line;
  }
  const decoded = CODEX_OUTPUT_ADAPTER.decode(trimmed);
  if (decoded.textSource === "final" && decoded.text !== "") {
    return decoded.text;
  }
  const messages = decoded.errors.map((error) => error.message);
  return messages.length > 0 ? messages.join("\n") : null;
}

/** How much of the CLI's output is kept for the usage-limit check. */
const OUTPUT_TAIL_BYTES = 64 * 1024;

/**
 * How much of Codex's raw stdout is kept for its failure classifier (Issue
 * #5083). Characters stand in for bytes, as the other tails here do.
 */
const CODEX_RAW_TAIL_BYTES = 1024 * 1024;

export const CLAUDE_REVIEW_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Run `claude`, passing its output straight through to this process's own
 * stdout and stderr (the runner logs the container's output) while keeping
 * the tail for {@link detectUsageLimit}.
 *
 * With `streamFile`, stdout is the CLI's stream-json: it is written there in
 * full, and only its readable lines ({@link renderStreamLine}) are passed
 * through and kept for the usage-limit check.
 *
 * A non-positive `timeoutMs` is a timed-out attempt and does not spawn.
 */
export async function runClaudeCli(
  args: string[],
  env: Record<string, string>,
  streamFile?: string,
  timeoutMs: number = CLAUDE_REVIEW_TIMEOUT_MS,
): Promise<ReviewRoundAttempt> {
  if (!(timeoutMs > 0)) {
    const message = `claude timed out after ${timeoutMs}ms\n`;
    await Deno.stderr.write(new TextEncoder().encode(message));
    return { code: 124, output: message };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("claude", {
      args,
      env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).spawn();
  } catch (error) {
    const message = `cannot run claude: ${
      error instanceof Error ? error.message : String(error)
    }\n`;
    await Deno.stderr.write(new TextEncoder().encode(message));
    clearTimeout(timer);
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
  try {
    const [status] = await Promise.all([
      child.status,
      file === undefined
        ? pump(child.stdout, Deno.stdout)
        : pumpStream(child.stdout),
      pump(child.stderr, Deno.stderr),
    ]);
    if (controller.signal.aborted) {
      return {
        code: 124,
        output: `claude timed out after ${timeoutMs}ms\n${tail}`,
      };
    }
    return { code: status.code, output: tail };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run `codex exec` with its prompt on stdin (Issue #5083), passing its output
 * straight through to this process's own stdout and stderr, as
 * {@link runClaudeCli} does for Claude.
 *
 * Stdout is the CLI's JSONL. It is written to `streamFile` in full, its
 * readable lines ({@link renderCodexStreamLine}) are passed through, and its
 * raw tail is classified by the Codex output adapter. `usageLimited` is true
 * only when that classification is a spent subscription window.
 *
 * A non-positive `timeoutMs` is a timed-out attempt and does not spawn.
 * `binary` is the command run; production passes nothing, so it is `codex`.
 */
export async function runCodexCli(
  args: string[],
  stdin: string,
  env: Record<string, string>,
  streamFile?: string,
  timeoutMs: number = CLAUDE_REVIEW_TIMEOUT_MS,
  binary = "codex",
): Promise<ReviewRoundAttempt> {
  const encoder = new TextEncoder();
  if (!(timeoutMs > 0)) {
    const message = `${binary} timed out after ${timeoutMs}ms\n`;
    await Deno.stderr.write(encoder.encode(message));
    return { code: 124, output: message, usageLimited: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(binary, {
      args,
      env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).spawn();
  } catch (error) {
    const message = `cannot run ${binary}: ${
      error instanceof Error ? error.message : String(error)
    }\n`;
    await Deno.stderr.write(encoder.encode(message));
    clearTimeout(timer);
    return { code: 127, output: message, usageLimited: false };
  }
  const feedStdin = async () => {
    try {
      const writer = child.stdin.getWriter();
      await writer.write(encoder.encode(stdin));
      await writer.close();
    } catch {
      // The CLI exited before reading its prompt; its exit status says why.
    }
  };
  // Best effort, as for Claude: a stream file that cannot be opened leaves
  // the attempt uncosted, never a failed round.
  const file = streamFile === undefined ? undefined : await Deno.open(
    streamFile,
    { write: true, create: true, truncate: true },
  ).catch(() => undefined);
  let rawStdout = "";
  let rendered = "";
  let stderrTail = "";
  const emit = async (line: string) => {
    const shown = renderCodexStreamLine(line);
    if (shown === null) return;
    await Deno.stdout.write(encoder.encode(`${shown}\n`));
    rendered = (rendered + shown + "\n").slice(-OUTPUT_TAIL_BYTES);
  };
  const pumpStdout = async (stream: ReadableStream<Uint8Array>) => {
    const lineDecoder = new TextDecoder();
    let pending = "";
    for await (const chunk of stream) {
      await file?.write(chunk).catch(() => 0);
      const text = lineDecoder.decode(chunk, { stream: true });
      rawStdout = (rawStdout + text).slice(-CODEX_RAW_TAIL_BYTES);
      const lines = (pending + text).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) await emit(line);
    }
    const rest = lineDecoder.decode();
    rawStdout = (rawStdout + rest).slice(-CODEX_RAW_TAIL_BYTES);
    await emit(pending + rest);
    file?.close();
  };
  const pumpStderr = async (stream: ReadableStream<Uint8Array>) => {
    const stderrDecoder = new TextDecoder();
    for await (const chunk of stream) {
      await Deno.stderr.write(chunk);
      stderrTail = (stderrTail + stderrDecoder.decode(chunk, { stream: true }))
        .slice(-OUTPUT_TAIL_BYTES);
    }
  };
  try {
    const [status] = await Promise.all([
      child.status,
      pumpStdout(child.stdout),
      pumpStderr(child.stderr),
      feedStdin(),
    ]);
    const timedOut = controller.signal.aborted;
    const decoded = CODEX_OUTPUT_ADAPTER.decode(rawStdout);
    const failure = CODEX_OUTPUT_ADAPTER.classify(
      {
        stdout: rawStdout,
        stderr: stderrTail,
        exitCode: status.code,
        timedOut,
      },
      decoded,
    );
    const isUsageLimited = failure?.category === "quota-exhausted";
    const output = (rendered + stderrTail).slice(-OUTPUT_TAIL_BYTES);
    if (timedOut) {
      return {
        code: 124,
        output: `${binary} timed out after ${timeoutMs}ms\n${output}`,
        usageLimited: isUsageLimited,
      };
    }
    return { code: status.code, output, usageLimited: isUsageLimited };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An environment lookup over a plain environment object. Only the object's own
 * variables count, so a name such as `constructor` is not reported as set.
 */
function envLookup(
  env: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => Object.hasOwn(env, name) ? env[name] : undefined;
}

/**
 * The production seams: one Claude credential pool for the round, built the
 * way the worker builds its own.
 *
 * @param log - Where the pool's decision log and the round's lines go.
 * @param options.credentialDir - Overrides the credential directory the
 *   fallback providers' credentials are read from: DeepSeek's (Issue #3632)
 *   and Codex's (Issue #5083). Production omits it and gets the
 *   environment-resolved directory; a wiring test points it at a fixture and
 *   passes `env` rather than mutating the process environment, so no process
 *   environment is mutated. Scoped to the fallback exports — the Claude pool
 *   keeps its own resolution.
 * @param options.env - The process environment the fallback exports read
 *   (the "already set" check) and merge into their child environments.
 *   Production omits it and gets `Deno.env.toObject()`; a wiring test passes
 *   its own variables here. Scoped to the fallback exports, as
 *   `credentialDir` is.
 */
export function createReviewRoundDeps(
  log: (message: string) => void,
  options: { credentialDir?: string; env?: Record<string, string> } = {},
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
      const processEnv = options.env ?? Deno.env.toObject();
      const values: Record<string, string> = {};
      const exported = await applyProviderCredentialEnv({
        dir: options.credentialDir,
        env: envLookup(processEnv),
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
        ...processEnv,
        ...values,
      });
      env["CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"] = "0";
      return { providerId: DEEPSEEK_PROVIDER_ID, env };
    },
    exportCodexCredential: async () => {
      // Issue #5083: the Codex credential the worker provisions under the
      // `codex` sub-directory, read the way the DeepSeek fallback's is. The
      // values are collected for the Codex child only, so the Claude
      // environment is never touched. The child env is Codex's own: its
      // denylist strips the Claude and Anthropic credentials (`codex_env.ts`).
      const codexProvider = resolveAgentProvider(CODEX_PROVIDER_ID);
      const processEnv = options.env ?? Deno.env.toObject();
      const values: Record<string, string> = {};
      const exported = await applyProviderCredentialEnv({
        dir: options.credentialDir,
        env: envLookup(processEnv),
        providers: [codexProvider],
        selectToken: selectFirstProviderToken,
        setEnv: (name, value) => {
          values[name] = value;
        },
      });
      const env = {
        ...processEnv,
        ...values,
      };
      // applyProviderCredentialEnv never overwrites a variable already in the
      // process environment, so a Codex credential the operator exported
      // themselves is not in `exported` yet is still usable. Defer only when
      // nothing was exported AND no Codex credential variable is set.
      const ambientCredential = [...CODEX_API_KEY_ENV_VARS, CODEX_HOME_ENV_VAR]
        .some((name) => Boolean(env[name]));
      if (exported.length === 0 && !ambientCredential) return null;
      return { env: codexProvider.buildChildEnv(env) };
    },
    runClaude: runClaudeCli,
    runCodex: runCodexCli,
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
