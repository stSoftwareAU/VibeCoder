/** Per-invocation Claude Code turn cap (Issue #3701). */
import type { ClaudeRunResult } from "./claude_runner.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

export const DEFAULT_CLAUDE_MAX_TURNS = 100;
/** Internal transport settled from .config.json by the worker driver. */
export const CLAUDE_MAX_TURNS_ENV = "VIBE_CLAUDE_MAX_TURNS";

/** Reject disabled, fractional and unbounded limits at the config boundary. */
export function validateClaudeMaxTurns(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("claude_max_turns must be a positive safe integer");
  }
  return value as number;
}

/** Read the driver-set limit for every Claude-compatible CLI invocation. */
export function resolveClaudeMaxTurns(
  env: EnvLookup = processEnvLookup,
): number {
  const value = env(CLAUDE_MAX_TURNS_ENV);
  return value === undefined
    ? DEFAULT_CLAUDE_MAX_TURNS
    : validateClaudeMaxTurns(Number(value));
}

/** Terminal policy stop. The retry API returns this as Result.ok=false. */
export class AgentTurnLimitError extends Error {
  constructor(
    message: string,
    readonly executionResult?: ClaudeRunResult,
  ) {
    super(message);
    this.name = "AgentTurnLimitError";
  }
}
