/**
 * Codex CLI invocation construction (Issue #4106, parent #4102).
 *
 * Everything this worker knows about the Codex command line lives here, the
 * way `claude_executor.ts` owns Claude's — the provider descriptor in
 * `agent_provider.ts` describes Codex, it does not restate the CLI.
 *
 * The shape is `codex exec [OPTIONS] <PROMPT>`: one non-interactive run of one
 * prompt, emitting JSONL events on stdout so the worker can read the run
 * machine-readably rather than scraping a TUI.
 *
 * Two Codex facts drive the translation from {@link AgentInvocationRequest}:
 *
 * - **There is no `--system-prompt`.** Dropping the static system prompt would
 *   silently deny Codex the guidance every agent is required to run under —
 *   including the sandboxed-environment guidance of Issue #4070, which reaches
 *   the agent through that prompt. It is therefore composed into the single
 *   prompt Codex takes, not discarded.
 * - **There is no per-tool disable flag.** A disallowed-tools list is likewise
 *   carried into the prompt rather than dropped on the floor.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { type AgentPromptParts, composeAgentPrompt } from "./agent_prompt.ts";
import {
  CODEX_PHASE_EFFORT_DEFAULTS,
  CODEX_PHASE_MODEL_DEFAULTS,
} from "./config_defaults.ts";
import type { EnvLookup } from "./env_lookup.ts";
import { resolvePhaseRoutedValue } from "./phase_routing.ts";
import type { RepoConfig } from "../types.ts";

/** The Codex subcommand for a non-interactive run. */
const EXEC_SUBCOMMAND = "exec";

/** Resume the most recent recorded session (`codex exec resume --last`). */
const RESUME_SUBCOMMAND = "resume";

/**
 * Flags every worker-driven Codex run carries.
 *
 * - `--json` prints events as JSONL, the machine-readable output the worker
 *   parses (Claude's `--output-format stream-json` equivalent).
 * - `--skip-git-repo-check` — the worker chooses the working tree itself and a
 *   phase may legitimately run outside a repository.
 * - `--dangerously-bypass-approvals-and-sandbox` — the container *is* the
 *   sandbox (Issue #4060) and no operator is present to approve anything, so
 *   Codex's own approval prompts would deadlock an unattended run. This is the
 *   documented flag for "running in an environment that is externally
 *   sandboxed", and it mirrors Claude's `--dangerously-skip-permissions`.
 */
const STANDARD_FLAGS: readonly string[] = [
  "--json",
  "--skip-git-repo-check",
  "--dangerously-bypass-approvals-and-sandbox",
];

/** Codex config key carrying the reasoning effort, set via `-c key=value`. */
const REASONING_EFFORT_KEY = "model_reasoning_effort";

/** One Codex prompt: the static guidance plus the per-run instructions. */
export type CodexPromptParts = AgentPromptParts;

/**
 * Compose the single prompt string `codex exec` takes.
 *
 * Codex has no separate system-prompt or disallowed-tools channel, so both are
 * folded into the prompt by the shared composer (Issue #4107), which every
 * provider in that position uses.
 *
 * @param parts - The prompt, the optional system prompt and disallowed tools.
 * @returns The composed prompt.
 */
export function composeCodexPrompt(parts: CodexPromptParts): string {
  return composeAgentPrompt(parts);
}

// ---------------------------------------------------------------------------
// Per-phase model and reasoning-effort routing (Issue #363, parent #357)
// ---------------------------------------------------------------------------

/** Global `.config.json` `codex_phase_model_overrides` (Issue #363). */
let _codexPhaseModelConfigOverrides: Readonly<Record<string, string>> = {};

/** Global `.config.json` `codex_phase_effort_overrides` (Issue #363). */
let _codexPhaseEffortConfigOverrides: Readonly<Record<string, string>> = {};

/** The active repo's Codex routing overrides (Issue #363). */
let _repoCodexModel = "";
let _repoCodexPhaseModelOverrides: Readonly<Record<string, string>> = {};
let _repoCodexPhaseEffortOverrides: Readonly<Record<string, string>> = {};

/**
 * Record the global per-phase Codex model overrides (Issue #363).
 *
 * Called during config loading with the `codex_phase_model_overrides` key.
 * These override {@link CODEX_PHASE_MODEL_DEFAULTS} and are themselves
 * overridden by the per-repo overrides and the `CODEX_MODEL_<PHASE>` env var.
 *
 * @param overrides - Phase-to-model mapping from `.config.json`.
 */
export function setCodexPhaseModelConfigOverrides(
  overrides: Record<string, string>,
): void {
  _codexPhaseModelConfigOverrides = { ...overrides };
}

/**
 * Record the global per-phase Codex effort overrides (Issue #363).
 *
 * @param overrides - Phase-to-effort mapping from `.config.json`.
 */
export function setCodexPhaseEffortConfigOverrides(
  overrides: Record<string, string>,
): void {
  _codexPhaseEffortConfigOverrides = { ...overrides };
}

/**
 * Set the active repo's Codex model/effort routing overrides (Issue #363).
 *
 * Mirrors `setActiveRepoModelEffortOverrides` in `claude_executor.ts`: call it
 * once when the worker starts work on a repo, passing that repo's merged
 * RepoConfig (or `undefined` to clear). It **replaces** — never merges — the
 * previously-active overrides, so a high-value repo's premium routing can never
 * leak into a filler repo when one worker process serves several repos.
 *
 * @param repoConfig - The active repo's RepoConfig, or undefined to clear.
 */
export function setActiveRepoCodexModelEffortOverrides(
  repoConfig: RepoConfig | undefined,
): void {
  _repoCodexModel = repoConfig?.codexModel ?? "";
  _repoCodexPhaseModelOverrides = {
    ...(repoConfig?.codexPhaseModelOverrides ?? {}),
  };
  _repoCodexPhaseEffortOverrides = {
    ...(repoConfig?.codexPhaseEffortOverrides ?? {}),
  };
}

/**
 * Resolve the model Codex runs a phase on — the value behind `--model`.
 *
 * The six-step chain itself lives in `phase_routing.ts`; this supplies Codex's
 * names, tables and override state, so the precedence is Claude's precedence
 * with Codex-named keys (Issue #363):
 *   1. `CODEX_MODEL_<PHASE>` env var — operator escape hatch
 *   2. Per-repo `codex_phase_model_overrides`
 *   3. Per-repo `codex_model` base tier — applies to all phases
 *   4. Global config `codex_phase_model_overrides`
 *   5. {@link CODEX_PHASE_MODEL_DEFAULTS} — designed cost optimisation
 *   6. Base `CODEX_MODEL` env var — global fallback
 *
 * @param phase - Optional phase name (e.g. `"planning"`).
 * @param env - Environment lookup for steps 1 and 6 (Issue #957); defaults to
 *   the process environment.
 * @returns The resolved model, or `undefined` when no step supplies one — the
 *   CLI's configured default then stands, and a non-empty phase warns.
 */
export function resolveCodexModel(
  phase?: string,
  env?: EnvLookup,
): string | undefined {
  return resolvePhaseRoutedValue({
    logPrefix: "codex-executor",
    what: "model",
    flag: "--model",
    envVar: "CODEX_MODEL",
    env,
    repoPhaseOverrides: _repoCodexPhaseModelOverrides,
    repoPhaseOverridesKey: "codex_phase_model_overrides",
    repoBase: _repoCodexModel,
    repoBaseKey: "codex_model",
    globalPhaseOverrides: _codexPhaseModelConfigOverrides,
    globalPhaseOverridesKey: "codex_phase_model_overrides",
    phaseDefaults: CODEX_PHASE_MODEL_DEFAULTS,
    phaseDefaultsName: "CODEX_PHASE_MODEL_DEFAULTS",
  }, phase);
}

/**
 * Resolve the reasoning effort Codex runs a phase at — the value behind
 * `-c model_reasoning_effort="…"`.
 *
 * Same chain as {@link resolveCodexModel} with the effort keys:
 * `CODEX_EFFORT_<PHASE>` → per-repo `codex_phase_effort_overrides` → global
 * `codex_phase_effort_overrides` → {@link CODEX_PHASE_EFFORT_DEFAULTS} →
 * `CODEX_EFFORT`. Effort has no per-repo base tier, exactly as Claude's has
 * none, and no hardcoded terminal fallback: an unroutable phase leaves Codex on
 * its own configured effort rather than inventing one.
 *
 * @param phase - Optional phase name (e.g. `"planning"`).
 * @param env - Environment lookup for steps 1 and 6 (Issue #957); defaults to
 *   the process environment.
 * @returns The resolved effort, or `undefined` when no step supplies one.
 */
export function resolveCodexEffort(
  phase?: string,
  env?: EnvLookup,
): string | undefined {
  return resolvePhaseRoutedValue({
    logPrefix: "codex-executor",
    what: "effort",
    flag: `-c ${REASONING_EFFORT_KEY}`,
    envVar: "CODEX_EFFORT",
    env,
    repoPhaseOverrides: _repoCodexPhaseEffortOverrides,
    repoPhaseOverridesKey: "codex_phase_effort_overrides",
    globalPhaseOverrides: _codexPhaseEffortConfigOverrides,
    globalPhaseOverridesKey: "codex_phase_effort_overrides",
    phaseDefaults: CODEX_PHASE_EFFORT_DEFAULTS,
    phaseDefaultsName: "CODEX_PHASE_EFFORT_DEFAULTS",
  }, phase);
}

/** What {@link buildCodexArgs} needs to build one invocation. */
export interface CodexInvocation extends CodexPromptParts {
  /** Explicit model id; omitted leaves Codex on its configured default. */
  model?: string;
  /** Explicit reasoning effort; omitted leaves Codex on its default. */
  effort?: string;
  /** Continue the previous run of this issue rather than starting fresh. */
  resumeSession?: boolean;
}

/**
 * Build the Codex CLI argument list for one non-interactive run.
 *
 * Session continuity uses `codex exec resume --last`: Codex names sessions
 * with its own identifiers, so the worker resumes the most recent recorded
 * session — which, within a run, is the previous phase of the same issue —
 * rather than inventing an id Codex would reject.
 *
 * @param invocation - Prompt, model/effort selection and resume state.
 * @returns The argument list, prompt last.
 */
export function buildCodexArgs(invocation: CodexInvocation): string[] {
  const args: string[] = [EXEC_SUBCOMMAND];
  if (invocation.resumeSession) args.push(RESUME_SUBCOMMAND, "--last");

  args.push(...STANDARD_FLAGS);

  if (invocation.model) args.push("--model", invocation.model);
  if (invocation.effort) {
    args.push("-c", `${REASONING_EFFORT_KEY}="${invocation.effort}"`);
  }

  args.push(composeCodexPrompt(invocation));
  return args;
}
