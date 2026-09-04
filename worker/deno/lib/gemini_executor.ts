/**
 * Gemini CLI invocation construction (Issue #4107, parent #4102).
 *
 * Everything this worker knows about the Gemini command line lives here, the
 * way `claude_executor.ts` owns Claude's and `codex_executor.ts` owns Codex's
 * — the provider descriptor in `agent_provider.ts` describes Gemini, it does
 * not restate the CLI.
 *
 * The shape is `gemini --prompt <PROMPT>`: the CLI is interactive by default
 * and `-p/--prompt` is what makes one run headless, which is the only mode an
 * unattended worker can use.
 *
 * In Quorum mode Gemini is the judge, so its verdict has to be read rather
 * than guessed at. Three CLI facts drive the translation from
 * {@link GeminiInvocation}:
 *
 * - **Output is structured.** `--output-format` offers `text`, `json` and
 *   `stream-json`; the streaming form is chosen because it is both parseable
 *   *and* incremental. `claude_runner.ts` kills a child that produces no
 *   stdout for the silence timeout, so a single JSON object emitted only at
 *   the end would risk a long judging run being killed as silent.
 * - **There is no `--system-prompt` and no per-tool disable flag.** Both are
 *   composed into the single prompt by the shared composer rather than
 *   dropped — the sandboxed-environment guidance of Issue #4070 reaches this
 *   provider through that prompt.
 * - **There is no reasoning-effort option.** An effort the caller supplies is
 *   therefore not translated into a flag the CLI does not have: inventing one
 *   would fail the run outright. It is not dropped in silence either
 *   (Issue #364): the request is reported once so an operator sees that the
 *   lever does nothing under Gemini.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { type AgentPromptParts, composeAgentPrompt } from "./agent_prompt.ts";
import {
  GEMINI_PHASE_MODEL_DEFAULTS,
  PHASE_EFFORT_DEFAULTS,
} from "./config_defaults.ts";
import type { EnvLookup } from "./env_lookup.ts";
import { resolvePhaseRoutedValue } from "./phase_routing.ts";
import type { RepoConfig } from "../types.ts";

/**
 * Flags every worker-driven Gemini run carries.
 *
 * - `--output-format stream-json` streams machine-readable events, so the
 *   judge's verdict is parsed rather than scraped, and the run keeps
 *   producing output while it thinks.
 * - `--approval-mode yolo` — the container *is* the sandbox (Issue #4060) and
 *   no operator is present to approve anything, so the CLI's own approval
 *   prompts would deadlock an unattended run. It mirrors Claude's
 *   `--dangerously-skip-permissions`. The CLI's own `--sandbox` is
 *   deliberately absent: containment is the container's job.
 * - `--skip-trust` — the worker chooses the working tree itself, so the
 *   workspace-trust prompt has nobody to answer it.
 */
const STANDARD_FLAGS: readonly string[] = [
  "--output-format",
  "stream-json",
  "--approval-mode",
  "yolo",
  "--skip-trust",
];

/** Resume the most recent recorded session (`--resume latest`). */
const RESUME_LATEST: readonly string[] = ["--resume", "latest"];

// ---------------------------------------------------------------------------
// Per-phase model routing (Issue #364, parent #357)
// ---------------------------------------------------------------------------

/** Global `.config.json` `gemini_phase_model_overrides` (Issue #364). */
let _geminiPhaseModelConfigOverrides: Readonly<Record<string, string>> = {};

/** The active repo's Gemini routing overrides (Issue #364). */
let _repoGeminiModel = "";
let _repoGeminiPhaseModelOverrides: Readonly<Record<string, string>> = {};

/**
 * Record the global per-phase Gemini model overrides (Issue #364).
 *
 * Called during config loading with the `gemini_phase_model_overrides` key.
 * These override {@link GEMINI_PHASE_MODEL_DEFAULTS} and are themselves
 * overridden by the per-repo overrides and the `GEMINI_MODEL_<PHASE>` env var.
 *
 * @param overrides - Phase-to-model mapping from `.config.json`.
 */
export function setGeminiPhaseModelConfigOverrides(
  overrides: Record<string, string>,
): void {
  _geminiPhaseModelConfigOverrides = { ...overrides };
}

/**
 * Set the active repo's Gemini model routing overrides (Issue #364).
 *
 * Mirrors `setActiveRepoCodexModelEffortOverrides` in `codex_executor.ts`: call
 * it once when the worker starts work on a repo, passing that repo's merged
 * RepoConfig (or `undefined` to clear). It **replaces** — never merges — the
 * previously-active overrides, so a high-value repo's premium routing can never
 * leak into a filler repo when one worker process serves several repos.
 *
 * @param repoConfig - The active repo's RepoConfig, or undefined to clear.
 */
export function setActiveRepoGeminiModelOverrides(
  repoConfig: RepoConfig | undefined,
): void {
  _repoGeminiModel = repoConfig?.geminiModel ?? "";
  _repoGeminiPhaseModelOverrides = {
    ...(repoConfig?.geminiPhaseModelOverrides ?? {}),
  };
}

/**
 * Resolve the model Gemini runs a phase on — the value behind `--model`.
 *
 * The six-step chain itself lives in `phase_routing.ts`; this supplies Gemini's
 * names, tables and override state, so the precedence is Claude's precedence
 * with Gemini-named keys (Issue #364):
 *   1. `GEMINI_MODEL_<PHASE>` env var — operator escape hatch
 *   2. Per-repo `gemini_phase_model_overrides`
 *   3. Per-repo `gemini_model` base tier — applies to all phases
 *   4. Global config `gemini_phase_model_overrides`
 *   5. {@link GEMINI_PHASE_MODEL_DEFAULTS} — designed cost optimisation
 *   6. Base `GEMINI_MODEL` env var — global fallback
 *
 * @param phase - Optional phase name (e.g. `"planning"`).
 * @param env - Environment lookup for steps 1 and 6 (Issue #957); defaults to
 *   the process environment.
 * @returns The resolved model, or `undefined` when no step supplies one — the
 *   CLI's configured default then stands, and a non-empty phase warns.
 */
export function resolveGeminiModel(
  phase?: string,
  env?: EnvLookup,
): string | undefined {
  return resolvePhaseRoutedValue({
    logPrefix: "gemini-executor",
    what: "model",
    flag: "--model",
    envVar: "GEMINI_MODEL",
    env,
    repoPhaseOverrides: _repoGeminiPhaseModelOverrides,
    repoPhaseOverridesKey: "gemini_phase_model_overrides",
    repoBase: _repoGeminiModel,
    repoBaseKey: "gemini_model",
    globalPhaseOverrides: _geminiPhaseModelConfigOverrides,
    globalPhaseOverridesKey: "gemini_phase_model_overrides",
    phaseDefaults: GEMINI_PHASE_MODEL_DEFAULTS,
    phaseDefaultsName: "GEMINI_PHASE_MODEL_DEFAULTS",
  }, phase);
}

/**
 * Resolve the reasoning effort a phase is *asked* to run at (Issue #364).
 *
 * The Gemini CLI has no reasoning-effort option, so this value never becomes an
 * argument — there is deliberately no Gemini effort table, and no Gemini effort
 * config key, because either would be configuration the CLI can never apply.
 * What it does supply is the signal the fail-loud standard requires
 * (Issue #3234): the worker's own phase effort design
 * ({@link PHASE_EFFORT_DEFAULTS}) is what an operator relying on defaults
 * expects to be honoured, so {@link buildGeminiArgs} reports the gap instead of
 * discarding the request silently. An explicit `request.effort` beats this
 * through `resolveInvocationRouting`, and is reported the same way.
 *
 * @param phase - Optional phase name (e.g. `"planning"`).
 * @returns The effort the phase design asks for, or `undefined` when the phase
 *   is absent or has no designed effort — nothing to report in either case.
 */
export function resolveGeminiEffort(phase?: string): string | undefined {
  return phase ? PHASE_EFFORT_DEFAULTS[phase] : undefined;
}

/**
 * Phases already warned about an unhonourable effort, once per worker process.
 *
 * One warning per phase per process: a multi-phase run states the gap for each
 * distinct phase it routes, and a phase that is invoked repeatedly (a retry, a
 * quality-fix loop) states it once. The key of a phase-less invocation is the
 * empty string, so it too warns once.
 */
const _effortWarnedPhases = new Set<string>();

/**
 * Clear the per-process effort-warning state (Issue #364).
 *
 * Exposed so a test — or any caller that deliberately re-runs a phase as a
 * fresh scenario — can observe the first warning again.
 */
export function clearGeminiEffortWarnings(): void {
  _effortWarnedPhases.clear();
}

/**
 * Report an effort the Gemini CLI cannot honour, once per phase.
 *
 * Fail loud, do not fail the run (Issue #364): the invocation is valid, it
 * simply cannot carry the lever, so the warning *is* the fix. Inventing a flag
 * the CLI does not have would fail the run outright.
 *
 * @param effort - The requested reasoning effort.
 * @param phase - The phase it was requested for, when there is one.
 */
function warnEffortUnsupported(effort: string, phase?: string): void {
  const key = phase ?? "";
  if (_effortWarnedPhases.has(key)) return;
  _effortWarnedPhases.add(key);

  const where = phase ? `phase "${phase}"` : "a phase-less invocation";
  console.warn(
    `[gemini] Reasoning effort ${JSON.stringify(effort)} requested for ` +
      `${where} but the Gemini CLI has no effort option; the request is ` +
      `ignored. Run this phase under a provider that has the lever (claude, ` +
      `codex), or clear the effort configuration for it.`,
  );
}

/** What {@link buildGeminiArgs} needs to build one invocation. */
export interface GeminiInvocation extends AgentPromptParts {
  /** Explicit model id; omitted leaves Gemini on its configured default. */
  model?: string;
  /**
   * The reasoning effort this invocation was asked to run at (Issue #364).
   * Gemini has no flag to carry it, so it produces one warning and no
   * argument.
   */
  effort?: string;
  /** The phase the effort was requested for, named in that warning. */
  phase?: string;
  /** Continue the previous run of this issue rather than starting fresh. */
  resumeSession?: boolean;
}

/**
 * Build the Gemini CLI argument list for one non-interactive run.
 *
 * Session continuity uses `--resume latest`: Gemini names sessions with its
 * own identifiers, so the worker resumes the most recent recorded session —
 * which, within a run, is the previous phase of the same issue — rather than
 * inventing an id Gemini would reject.
 *
 * A requested reasoning effort adds no argument — the CLI has no such option —
 * but it does emit one warning naming the phase and the effort (Issue #364), so
 * a configured lever that does nothing is visible rather than silent.
 *
 * @param invocation - Prompt, model/effort selection and resume state.
 * @returns The argument list, prompt last.
 */
export function buildGeminiArgs(invocation: GeminiInvocation): string[] {
  const args: string[] = [...STANDARD_FLAGS];

  if (invocation.effort) {
    warnEffortUnsupported(invocation.effort, invocation.phase);
  }
  if (invocation.model) args.push("--model", invocation.model);
  if (invocation.resumeSession) args.push(...RESUME_LATEST);

  args.push("--prompt", composeAgentPrompt(invocation));
  return args;
}
