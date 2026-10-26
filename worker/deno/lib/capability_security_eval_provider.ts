/** Text-only subscription-backed generation for the bounded evaluation (#4368). */
import type { TokenUsage } from "./token_usage.ts";
import { agentProviderById } from "./agent_provider.ts";
import { parseJsonlEvents } from "./agent_output.ts";
import { CLAUDE_NON_SUBSCRIPTION_CREDENTIAL_ENV_VARS } from "./claude_env.ts";
import {
  attributeUsageByModel,
  estimateRunCost,
  readModelUsageBreakdown,
} from "./cost_estimate.ts";
import { extractRunStats } from "./run_stats.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

export interface CapabilityModelRequest {
  model: string;
  effort: string;
  prompt: string;
  /** Total budget, including authentication and any retry. */
  timeoutMs: number;
}

export interface CapabilityModelAttempt {
  ok: boolean;
  servedModels: string[];
  usage?: TokenUsage;
  /** Existing API-equivalent estimate; never a subscription bill. */
  costUsd: number | null;
  elapsedMs: number;
  reason?: string;
}

export interface CapabilityModelResult {
  ok: boolean;
  text: string;
  attempts: CapabilityModelAttempt[];
  reason?: string;
}

/** Process and clock seams; the CLI adapter and billing rules remain real. */
export interface CapabilityProviderDeps {
  run: typeof runWithTimeout;
  env: () => Record<string, string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  makeTempDir: () => Promise<string>;
  removeTempDir: (path: string) => Promise<void>;
}

// Keep the argv prompt below Linux's per-argument 128 KiB bound. The
// evaluation supplies fixture text, never repository or hold-out contents.
const MAX_PROMPT_BYTES = 120 * 1024;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const SUBSCRIPTION_PLANS = new Set(["pro", "max", "team", "enterprise"]);

/**
 * Retain only the runtime and the selected subscription's login state.
 * An allowlist drops proxy/endpoint selectors, cloud credentials, API-key
 * helpers and executable injection variables even when their names are new.
 */
function subscriptionEnv(
  parent: Record<string, string>,
): Record<string, string> {
  const provider = agentProviderById("claude")!;
  const filtered = provider.buildChildEnv(parent);
  for (const name of CLAUDE_NON_SUBSCRIPTION_CREDENTIAL_ENV_VARS) {
    delete filtered[name];
  }
  const keep = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "CLAUDE_CONFIG_DIR",
    ...provider.billing.subscriptionEnvVars,
  ]);
  return Object.fromEntries(
    Object.entries(filtered).filter(([key]) => keep.has(key)),
  );
}

/** The auth CLI's positive billing proof; never retain the account metadata. */
function provesSubscription(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const auth = value as Record<string, unknown>;
    return auth.loggedIn === true && auth.authMethod === "claude.ai" &&
      auth.apiProvider === "firstParty" &&
      typeof auth.subscriptionType === "string" &&
      SUBSCRIPTION_PLANS.has(auth.subscriptionType);
  } catch {
    return false;
  }
}

/** The shared extractor defaults missing counters to zero; unknown is required here. */
function hasCompleteUsage(stdout: string): boolean {
  const result = parseJsonlEvents(stdout).events.map((event) => event.value)
    .findLast((event) => event.type === "result");
  const raw = result?.usage;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }
  const usage = raw as Record<string, unknown>;
  return [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ]
    .every((key) =>
      typeof usage[key] === "number" && Number.isSafeInteger(usage[key]) &&
      usage[key] >= 0
    );
}

function telemetry(
  stdout: string,
): Pick<CapabilityModelAttempt, "servedModels" | "usage" | "costUsd"> {
  const stats = extractRunStats(stdout);
  const servedModels = stats.servedModels.filter((model) =>
    MODEL_ID.test(model)
  );
  const usage = hasCompleteUsage(stdout) ? stats.tokenUsage : undefined;
  let costUsd: number | null = null;
  if (
    usage && servedModels.length > 0 &&
    servedModels.length === stats.servedModels.length &&
    (servedModels.length === 1 || readModelUsageBreakdown(stats.modelUsage))
  ) {
    const cost = estimateRunCost(
      attributeUsageByModel(usage, stats.modelUsage, servedModels[0]!),
    );
    // Even a zero-token unknown model remains unpriced, rather than $0.
    if (cost.perModel.every((entry) => entry.breakdown !== null)) {
      costUsd = cost.totalCost;
    }
  }
  return { servedModels, ...(usage ? { usage } : {}), costUsd };
}

const DEFAULT_DEPS: CapabilityProviderDeps = {
  run: runWithTimeout,
  env: () => Deno.env.toObject(),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  makeTempDir: () =>
    Deno.makeTempDir({ prefix: "vibe-capability-generation-" }),
  removeTempDir: (path) => Deno.remove(path, { recursive: true }),
};

/**
 * Generate text through a proven subscription, with no tool or repository access.
 *
 * The same model, effort, environment and prompt are used for at most two
 * attempts. Only a transient network/rate-limit failure may retry, within the
 * original wall-clock budget. Failed attempts retain their measured telemetry.
 */
export async function invokeCapabilityModel(
  request: CapabilityModelRequest,
  overrides: Partial<CapabilityProviderDeps> = {},
): Promise<CapabilityModelResult> {
  const attempts: CapabilityModelAttempt[] = [];
  const fail = (reason: string): CapabilityModelResult => ({
    ok: false,
    text: "",
    attempts,
    reason,
  });
  if (
    typeof request.model !== "string" || !MODEL_ID.test(request.model) ||
    typeof request.effort !== "string" || !EFFORTS.has(request.effort) ||
    typeof request.prompt !== "string" ||
    !Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0 ||
    request.timeoutMs > MAX_TIMEOUT_MS ||
    !request.prompt.trim() ||
    new TextEncoder().encode(request.prompt).length > MAX_PROMPT_BYTES
  ) {
    return fail("Invalid bounded capability-model request");
  }
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const deadline = deps.now() + request.timeoutMs;
  const remaining = () => Math.max(0, deadline - deps.now());
  const provider = agentProviderById("claude")!;
  const adapter = provider.output;
  if (!adapter) return fail("Claude output adapter unavailable");
  const env = subscriptionEnv(deps.env());
  const isolation = [
    "--safe-mode",
    "--setting-sources",
    "",
    "--strict-mcp-config",
  ];
  const args = provider.buildInvocation({
    model: request.model,
    effort: request.effort,
    prompt: request.prompt,
    env: (name) => name === "VIBE_CLAUDE_MAX_TURNS" ? "1" : undefined,
  });
  // The descriptor's final argument is the prompt. Put explicit isolation
  // flags before `--` so even a prompt beginning with '-' remains data.
  if (args.pop() !== request.prompt) {
    return fail("Claude invocation contract changed");
  }
  const boundedArgs = args.filter((arg) =>
    arg !== "--dangerously-skip-permissions"
  );
  boundedArgs.push(
    ...isolation,
    "--tools",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--no-chrome",
    "--",
    request.prompt,
  );
  let cwd: string;
  try {
    cwd = await deps.makeTempDir();
  } catch {
    return fail("Cannot provision the empty generation directory");
  }
  let result = fail("Claude invocation did not complete");
  try {
    const auth = await deps.run(provider.binary, [
      ...isolation,
      "auth",
      "status",
      "--json",
    ], {
      cwd,
      env,
      clearEnv: true,
      timeoutMs: Math.min(10_000, remaining()),
    });
    if (
      !auth.ok || !auth.value.success || auth.value.timedOut ||
      !provesSubscription(auth.value.stdout)
    ) {
      result = fail(
        "Claude subscription proof unavailable in the isolated invocation environment",
      );
    } else {
      for (let index = 0; index < 2 && remaining() > 0; index++) {
        const started = deps.now();
        const process = await deps.run(provider.binary, boundedArgs, {
          cwd,
          env,
          clearEnv: true,
          timeoutMs: remaining(),
          captureOutputOnTimeout: true,
        });
        const elapsedMs = Math.max(0, deps.now() - started);
        if (!process.ok) {
          const reason = "Claude CLI could not be started";
          attempts.push({
            ok: false,
            servedModels: [],
            costUsd: null,
            elapsedMs,
            reason,
          });
          result = fail(reason);
          break;
        }
        const raw = process.value;
        const decoded = adapter.decode(raw.stdout);
        const ok = raw.success && !raw.timedOut &&
          decoded.status === "completed" &&
          decoded.textSource === "final" && decoded.text.trim().length > 0 &&
          decoded.malformedLines === 0;
        const failure = ok ? undefined : adapter.classify({
          stdout: raw.stdout,
          stderr: raw.stderr,
          exitCode: raw.code || 1,
          timedOut: raw.timedOut,
          nowMs: deps.now(),
        }, decoded);
        // Never expose raw auth, error, account or prompt bytes in telemetry.
        const unsupportedFlags =
          /unknown option|unknown argument|unrecognised option|unrecognized option/i
            .test(raw.stderr);
        const reason = ok
          ? undefined
          : unsupportedFlags
          ? "Claude CLI does not support the required isolated invocation flags"
          : `Claude invocation failed (${
            failure?.category ?? "incomplete-output"
          })`;
        attempts.push({
          ok,
          ...telemetry(raw.stdout),
          elapsedMs,
          ...(reason ? { reason } : {}),
        });
        if (ok) {
          result = { ok: true, text: decoded.text, attempts };
          break;
        }
        result = fail(reason!);
        if (
          index !== 0 || !failure || failure.terminal ||
          (failure.category !== "network" && failure.category !== "rate-limit")
        ) break;
        const delay = Math.max(1_000, (failure.retryAfterSeconds ?? 0) * 1_000);
        if (delay > 10_000 || delay + 1_000 >= remaining()) break;
        await deps.sleep(delay);
      }
    }
  } catch {
    result = fail("Claude invocation infrastructure failed");
  } finally {
    try {
      await deps.removeTempDir(cwd);
    } catch {
      result = fail("Cannot remove the temporary generation directory");
    }
  }
  return result;
}
