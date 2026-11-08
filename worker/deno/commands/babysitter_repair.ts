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
import { BABYSITTER_REPAIR_TIMEOUT_MS } from "../lib/fleet_babysitter_container.ts";
import { redactSecrets } from "../lib/secret_redaction.ts";

/** Characters of redacted stderr quoted in a failure message. */
const STDERR_TAIL_CHARS = 500;

/** The seams the repair touches, injected so tests need no real agent. */
export interface BabysitterRepairDeps {
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, text: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
  chooseProvider: typeof chooseBabysitterProvider;
  runClaude: typeof runClaudeWithTimeout;
  log: (message: string) => void;
}

/** Production seams: real files, real provider choice, real runner. */
export const productionBabysitterRepairDeps: BabysitterRepairDeps = {
  readTextFile: (path) => Deno.readTextFile(path),
  writeTextFile: (path, text) => Deno.writeTextFile(path, text),
  removeFile: (path) => Deno.remove(path),
  chooseProvider: chooseBabysitterProvider,
  runClaude: runClaudeWithTimeout,
  log: (message) => console.error(message),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): CommandResult {
  return { success: false, message, exitCode: 1 };
}

/** A required flag must carry a real value; a bare flag parses as "true". */
function hasValue(value: unknown): boolean {
  const text = String(value ?? "");
  return text.trim() !== "" && text !== "true";
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

/** The repair body; every failure returns non-zero and leaves no response file. */
export async function runBabysitterRepair(
  args: Record<string, unknown>,
  config: WorkerConfig,
  deps: BabysitterRepairDeps = productionBabysitterRepairDeps,
): Promise<CommandResult> {
  // a. Validate the three required flags.
  for (const name of ["dir", "prompt-file", "response-file"]) {
    if (!hasValue(args[name])) return fail(`--${name} <value> is required`);
  }
  const dir = String(args["dir"]);
  const promptFile = String(args["prompt-file"]);
  const responseFile = String(args["response-file"]);

  // b. Clear any stale response so a failed run cannot leave an old one behind.
  try {
    await deps.removeFile(responseFile);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      return fail(
        `cannot remove stale response file ${responseFile}: ${
          errorMessage(error)
        }`,
      );
    }
  }

  // c. Read the prompt; an unreadable or blank prompt never reaches the agent.
  let prompt: string;
  try {
    prompt = await deps.readTextFile(promptFile);
  } catch (error) {
    return fail(
      `cannot read prompt file ${promptFile}: ${errorMessage(error)}`,
    );
  }
  if (prompt.trim() === "") return fail(`prompt file ${promptFile} is empty`);

  // d. Choose the provider; the choice owns the subscription-or-overflow policy.
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

  // e. Run the agent. Only the DeepSeek overflow choice carries a parent env.
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
    // Redact before truncating, so a secret straddling the cut is still masked.
    const tail = redactSecrets(run.stderr.trim()).slice(-STDERR_TAIL_CHARS);
    return fail(
      `agent exited ${run.exitCode}; stderr tail: ${tail || "(empty)"}`,
    );
  }
  if (run.output.trim() === "") {
    return fail("agent returned an empty final message");
  }

  // f. Only a complete, successful run writes the response file.
  try {
    await deps.writeTextFile(responseFile, run.output);
  } catch (error) {
    // A partial write must not survive as a response.
    await deps.removeFile(responseFile).catch(() => undefined);
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
