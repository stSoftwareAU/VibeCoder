/**
 * babysitter-repair command (Issue #4768).
 *
 * One fleet-babysitter repair inside the worker container. The agent works in
 * the clone at --dir, from the prompt in --prompt-file, and its final message
 * is written to --response-file for the babysitter to act on.
 *
 * Usage (inside the container):
 *   babysitter-repair --dir <clone> --prompt-file <path> --response-file <path>
 *
 * `ClaudeExecutionResult.output` is the agent's FINAL message for every
 * provider: each provider's output adapter (lib/claude_output_adapter.ts for
 * Claude and DeepSeek, lib/codex_output_adapter.ts for Codex) sets the text
 * from the final result. Success requires exitCode 0 and no timeout, so partial
 * text is never written to the response file.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { Command, CommandResult, Result, WorkerConfig } from "../types.ts";
import {
  type BabysitterProviderChoice,
  chooseBabysitterProvider,
} from "../lib/babysitter_provider_choice.ts";
import {
  type ClaudeExecutionResult,
  type RunClaudeOptions,
  runClaudeWithTimeout,
} from "../lib/claude_runner.ts";
import {
  BABYSITTER_QUOTA_PARK_EXIT_CODE,
  BABYSITTER_REPAIR_TIMEOUT_MS,
  BABYSITTER_TASK_FAILURE_EXIT_CODE,
} from "../lib/fleet_babysitter_container.ts";
import {
  CLAUDE_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import { createClaudeCredentialPool } from "../lib/claude_credential_pool.ts";
import { applyProviderCredentialEnv } from "../lib/credential_preflight.ts";
import type { EnvLookup } from "../lib/env_lookup.ts";
import { redactSecrets } from "../lib/secret_redaction.ts";

/** Redacted stderr up to this length is quoted whole in a failure message. */
const STDERR_QUOTE_CHARS = 500;

/** Characters kept from each end of longer redacted stderr. */
const STDERR_EDGE_CHARS = 250;

/** What {@link exportBabysitterSubscriptionCredentials} needs. */
export interface BabysitterCredentialExportOptions {
  readonly enabledProviderIds: readonly string[];
  readonly log: (message: string) => void;
  /** Credential directory; production resolves it from the environment. */
  readonly dir?: string;
  readonly env?: EnvLookup;
  readonly setEnv?: (name: string, value: string) => void;
}

/**
 * Exports the enabled subscription providers' logins into this process, the
 * way the worker loop and reviewer rounds do, so the automatic choice can see
 * them (Issue #5072). Without this every subscription read as billing-unknown
 * and each repair bought paid DeepSeek overflow. DeepSeek is left out: its
 * credential is exported only by the overflow choice, into an isolated env.
 *
 * @returns The variable names exported, for names-only logging.
 */
export async function exportBabysitterSubscriptionCredentials(
  options: BabysitterCredentialExportOptions,
): Promise<string[]> {
  const providers = options.enabledProviderIds
    .map((id) => id.trim())
    .filter((id) => id !== "" && id !== DEEPSEEK_PROVIDER_ID)
    .map(resolveAgentProvider);
  const pool = createClaudeCredentialPool({
    log: options.log,
    provider: resolveAgentProvider(CLAUDE_PROVIDER_ID),
  });
  return await applyProviderCredentialEnv({
    dir: options.dir,
    env: options.env,
    setEnv: options.setEnv,
    providers,
    selectToken: pool.selectToken,
  });
}

/** The seams the repair touches, injected so tests need no real agent. */
export interface BabysitterRepairDeps {
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, text: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  exportSubscriptionCredentials: (
    options: BabysitterCredentialExportOptions,
  ) => Promise<string[]>;
  chooseProvider: typeof chooseBabysitterProvider;
  runClaude: typeof runClaudeWithTimeout;
  log: (message: string) => void;
}

/** Production seams: real files, real provider choice, real runner. */
export const productionBabysitterRepairDeps: BabysitterRepairDeps = {
  readTextFile: (path) => Deno.readTextFile(path),
  writeTextFile: (path, text) => Deno.writeTextFile(path, text),
  removeFile: (path) => Deno.remove(path),
  exportSubscriptionCredentials: exportBabysitterSubscriptionCredentials,
  chooseProvider: chooseBabysitterProvider,
  runClaude: runClaudeWithTimeout,
  log: (message) => console.error(message),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string, exitCode = 1): CommandResult {
  return { success: false, message, exitCode };
}

/** A required flag must carry a real value; a bare flag parses as "true". */
function hasValue(value: unknown): boolean {
  const text = String(value ?? "");
  return text.trim() !== "" && text !== "true";
}

/**
 * Removes the response file at `path`. Returns undefined when it was removed
 * or was already absent; otherwise the cause, for the caller to report.
 */
async function clearResponse(
  path: string,
  deps: BabysitterRepairDeps,
): Promise<string | undefined> {
  try {
    await deps.removeFile(path);
    return undefined;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    return errorMessage(error);
  }
}

/**
 * Redacts stderr first, then cuts it: whole when short, otherwise its first
 * and last STDERR_EDGE_CHARS so a cause at either end survives.
 */
function quoteStderr(stderr: string): string {
  const redacted = redactSecrets(stderr.trim());
  if (redacted.length <= STDERR_QUOTE_CHARS) return redacted;
  return `${redacted.slice(0, STDERR_EDGE_CHARS)} … ${
    redacted.slice(-STDERR_EDGE_CHARS)
  }`;
}

export const babysitterRepairCommand: Command = {
  name: "babysitter-repair",
  description:
    "Run one fleet babysitter repair in the worker container and write its final message (Issue #4768)",

  execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult> {
    return runBabysitterRepair(args, config);
  },
};

/**
 * The repair body. Once --response-file is known, every failure result returns
 * non-zero and leaves no response file: the stale response is cleared first, and
 * any failure afterwards clears the path again, which also removes a file the
 * agent (run in the clone, where the path may sit) wrote itself.
 */
export async function runBabysitterRepair(
  args: Record<string, unknown>,
  config: WorkerConfig,
  deps: BabysitterRepairDeps = productionBabysitterRepairDeps,
): Promise<CommandResult> {
  const reportFailure = (message: string, exitCode = 1): CommandResult => {
    const redacted = redactSecrets(message);
    deps.log(redacted);
    return fail(redacted, exitCode);
  };
  // a. The response path comes first, so every later failure can clear it.
  if (!hasValue(args["response-file"])) {
    return reportFailure("--response-file <value> is required");
  }
  const responseFile = String(args["response-file"]);

  // b. Clear any stale response so a failed run cannot leave an old one behind.
  const staleError = await clearResponse(responseFile, deps);
  if (staleError !== undefined) {
    return reportFailure(
      `cannot remove stale response file ${responseFile}: ${staleError}`,
    );
  }

  // c. Run the rest; a failed result clears the response file before returning.
  // A dep that throws outside its own try must still reach the clear below.
  let result: CommandResult;
  try {
    result = await repairResponse(args, config, responseFile, deps);
  } catch (error) {
    result = fail(`unexpected error: ${errorMessage(error)}`);
  }
  if (result.success) return result;
  const clearError = await clearResponse(responseFile, deps);
  return reportFailure(
    clearError === undefined
      ? result.message
      : `${result.message}; also could not remove ${responseFile}: ${clearError}`,
    result.exitCode,
  );
}

/** The steps after the response path is cleared; each failure is returned. */
async function repairResponse(
  args: Record<string, unknown>,
  config: WorkerConfig,
  responseFile: string,
  deps: BabysitterRepairDeps,
): Promise<CommandResult> {
  // d. Validate the other two required flags.
  for (const name of ["dir", "prompt-file"]) {
    if (!hasValue(args[name])) return fail(`--${name} <value> is required`);
  }
  const dir = String(args["dir"]);
  const promptFile = String(args["prompt-file"]);

  // e. Read the prompt; an unreadable or blank prompt never reaches the agent.
  let prompt: string;
  try {
    prompt = await deps.readTextFile(promptFile);
  } catch (error) {
    return fail(
      `cannot read prompt file ${promptFile}: ${errorMessage(error)}`,
    );
  }
  if (prompt.trim() === "") return fail(`prompt file ${promptFile} is empty`);

  // f. Load the subscription logins first: the choice can only rank what it
  // can see, and an unseen subscription must never become paid overflow.
  try {
    const exported = await deps.exportSubscriptionCredentials({
      enabledProviderIds: config.enabledAgentProviders,
      log: deps.log,
    });
    if (exported.length > 0) {
      deps.log(
        `[babysitter-repair] subscription credentials exported: ${
          exported.join(", ")
        }`,
      );
    }
  } catch (error) {
    return fail(
      `subscription credential export failed: ${errorMessage(error)}`,
    );
  }

  // g. Choose the provider; the choice owns the subscription-or-overflow policy.
  let choice: BabysitterProviderChoice;
  try {
    choice = await deps.chooseProvider({
      workDir: config.workDir,
      enabledProviderIds: config.enabledAgentProviders,
      log: deps.log,
    });
  } catch (error) {
    return fail(`provider choice failed: ${errorMessage(error)}`);
  }
  deps.log(
    `[babysitter-repair] provider=${choice.providerId} overflow=${choice.overflow}`,
  );

  // h. Run the agent. Only the DeepSeek overflow choice carries a parent env.
  const runOptions: RunClaudeOptions = {
    prompt,
    cwd: dir,
    timeoutSeconds: BABYSITTER_REPAIR_TIMEOUT_MS / 1000,
    agentProvider: choice.providerId,
    ...(choice.overflow ? { parentEnv: choice.env } : {}),
  };
  const result: Result<ClaudeExecutionResult> = await deps.runClaude(
    runOptions,
  );
  if (!result.ok) {
    return fail(`agent run failed: ${errorMessage(result.error)}`);
  }
  const run = result.value;
  if (run.timedOut) {
    return fail(
      `agent run timed out (reason: ${run.timeoutReason ?? "unknown"})`,
    );
  }
  if (run.exitCode !== 0) {
    const cause = run.agentFailure
      ? `${run.agentFailure.category}: ${
        redactSecrets(run.agentFailure.message)
      }`
      : `stderr: ${quoteStderr(run.stderr) || "(empty)"}`;
    return fail(
      `agent exited ${run.exitCode}; ${cause}`,
      run.agentFailure?.category === "task-failure"
        ? BABYSITTER_TASK_FAILURE_EXIT_CODE
        : run.agentFailure?.category === "quota-exhausted"
        ? BABYSITTER_QUOTA_PARK_EXIT_CODE
        : 1,
    );
  }
  if (run.output.trim() === "") {
    return fail("agent returned an empty final message");
  }

  // i. Only a complete, successful run writes the response file. A partial
  // write is cleared by the caller's failure path.
  try {
    await deps.writeTextFile(responseFile, run.output);
  } catch (error) {
    return fail(
      `cannot write response file ${responseFile}: ${errorMessage(error)}`,
    );
  }
  return {
    success: true,
    message: `babysitter repair wrote ${responseFile}`,
    exitCode: 0,
  };
}
