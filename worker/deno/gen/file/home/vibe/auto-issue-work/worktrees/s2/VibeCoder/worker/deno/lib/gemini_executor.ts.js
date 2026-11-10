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
 */ import { composeAgentPrompt } from "./agent_prompt.ts";
import { GEMINI_PHASE_MODEL_DEFAULTS, PHASE_EFFORT_DEFAULTS } from "./config_defaults.ts";
import { resolvePhaseRoutedValue } from "./phase_routing.ts";
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
 */ const STANDARD_FLAGS = [
  "--output-format",
  "stream-json",
  "--approval-mode",
  "yolo",
  "--skip-trust"
];
/** Resume the most recent recorded session (`--resume latest`). */ const RESUME_LATEST = [
  "--resume",
  "latest"
];
// ---------------------------------------------------------------------------
// Per-phase model routing (Issue #364, parent #357)
// ---------------------------------------------------------------------------
/** Global `.config.json` `gemini_phase_model_overrides` (Issue #364). */ let _geminiPhaseModelConfigOverrides = {};
/** The active repo's Gemini routing overrides (Issue #364). */ let _repoGeminiModel = "";
let _repoGeminiPhaseModelOverrides = {};
/**
 * Record the global per-phase Gemini model overrides (Issue #364).
 *
 * Called during config loading with the `gemini_phase_model_overrides` key.
 * These override {@link GEMINI_PHASE_MODEL_DEFAULTS} and are themselves
 * overridden by the per-repo overrides and the `GEMINI_MODEL_<PHASE>` env var.
 *
 * @param overrides - Phase-to-model mapping from `.config.json`.
 */ export function setGeminiPhaseModelConfigOverrides(overrides) {
  _geminiPhaseModelConfigOverrides = {
    ...overrides
  };
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
 */ export function setActiveRepoGeminiModelOverrides(repoConfig) {
  _repoGeminiModel = repoConfig?.geminiModel ?? "";
  _repoGeminiPhaseModelOverrides = {
    ...repoConfig?.geminiPhaseModelOverrides ?? {}
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
 */ export function resolveGeminiModel(phase, env) {
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
    phaseDefaultsName: "GEMINI_PHASE_MODEL_DEFAULTS"
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
 */ export function resolveGeminiEffort(phase) {
  return phase ? PHASE_EFFORT_DEFAULTS[phase] : undefined;
}
/**
 * Phases already warned about an unhonourable effort, once per worker process.
 *
 * One warning per phase per process: a multi-phase run states the gap for each
 * distinct phase it routes, and a phase that is invoked repeatedly (a retry, a
 * quality-fix loop) states it once. The key of a phase-less invocation is the
 * empty string, so it too warns once.
 */ const _effortWarnedPhases = new Set();
/**
 * Clear the per-process effort-warning state (Issue #364).
 *
 * Exposed so a test — or any caller that deliberately re-runs a phase as a
 * fresh scenario — can observe the first warning again.
 */ export function clearGeminiEffortWarnings() {
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
 */ function warnEffortUnsupported(effort, phase) {
  const key = phase ?? "";
  if (_effortWarnedPhases.has(key)) return;
  _effortWarnedPhases.add(key);
  const where = phase ? `phase "${phase}"` : "a phase-less invocation";
  console.warn(`[gemini] Reasoning effort ${JSON.stringify(effort)} requested for ` + `${where} but the Gemini CLI has no effort option; the request is ` + `ignored. Run this phase under a provider that has the lever (claude, ` + `codex), or clear the effort configuration for it.`);
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
 */ export function buildGeminiArgs(invocation) {
  const args = [
    ...STANDARD_FLAGS
  ];
  if (invocation.effort) {
    warnEffortUnsupported(invocation.effort, invocation.phase);
  }
  if (invocation.model) args.push("--model", invocation.model);
  if (invocation.resumeSession) args.push(...RESUME_LATEST);
  args.push("--prompt", composeAgentPrompt(invocation));
  return args;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9nZW1pbmlfZXhlY3V0b3IudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBHZW1pbmkgQ0xJIGludm9jYXRpb24gY29uc3RydWN0aW9uIChJc3N1ZSAjNDEwNywgcGFyZW50ICM0MTAyKS5cbiAqXG4gKiBFdmVyeXRoaW5nIHRoaXMgd29ya2VyIGtub3dzIGFib3V0IHRoZSBHZW1pbmkgY29tbWFuZCBsaW5lIGxpdmVzIGhlcmUsIHRoZVxuICogd2F5IGBjbGF1ZGVfZXhlY3V0b3IudHNgIG93bnMgQ2xhdWRlJ3MgYW5kIGBjb2RleF9leGVjdXRvci50c2Agb3ducyBDb2RleCdzXG4gKiDigJQgdGhlIHByb3ZpZGVyIGRlc2NyaXB0b3IgaW4gYGFnZW50X3Byb3ZpZGVyLnRzYCBkZXNjcmliZXMgR2VtaW5pLCBpdCBkb2VzXG4gKiBub3QgcmVzdGF0ZSB0aGUgQ0xJLlxuICpcbiAqIFRoZSBzaGFwZSBpcyBgZ2VtaW5pIC0tcHJvbXB0IDxQUk9NUFQ+YDogdGhlIENMSSBpcyBpbnRlcmFjdGl2ZSBieSBkZWZhdWx0XG4gKiBhbmQgYC1wLy0tcHJvbXB0YCBpcyB3aGF0IG1ha2VzIG9uZSBydW4gaGVhZGxlc3MsIHdoaWNoIGlzIHRoZSBvbmx5IG1vZGUgYW5cbiAqIHVuYXR0ZW5kZWQgd29ya2VyIGNhbiB1c2UuXG4gKlxuICogSW4gUXVvcnVtIG1vZGUgR2VtaW5pIGlzIHRoZSBqdWRnZSwgc28gaXRzIHZlcmRpY3QgaGFzIHRvIGJlIHJlYWQgcmF0aGVyXG4gKiB0aGFuIGd1ZXNzZWQgYXQuIFRocmVlIENMSSBmYWN0cyBkcml2ZSB0aGUgdHJhbnNsYXRpb24gZnJvbVxuICoge0BsaW5rIEdlbWluaUludm9jYXRpb259OlxuICpcbiAqIC0gKipPdXRwdXQgaXMgc3RydWN0dXJlZC4qKiBgLS1vdXRwdXQtZm9ybWF0YCBvZmZlcnMgYHRleHRgLCBganNvbmAgYW5kXG4gKiAgIGBzdHJlYW0tanNvbmA7IHRoZSBzdHJlYW1pbmcgZm9ybSBpcyBjaG9zZW4gYmVjYXVzZSBpdCBpcyBib3RoIHBhcnNlYWJsZVxuICogICAqYW5kKiBpbmNyZW1lbnRhbC4gYGNsYXVkZV9ydW5uZXIudHNgIGtpbGxzIGEgY2hpbGQgdGhhdCBwcm9kdWNlcyBub1xuICogICBzdGRvdXQgZm9yIHRoZSBzaWxlbmNlIHRpbWVvdXQsIHNvIGEgc2luZ2xlIEpTT04gb2JqZWN0IGVtaXR0ZWQgb25seSBhdFxuICogICB0aGUgZW5kIHdvdWxkIHJpc2sgYSBsb25nIGp1ZGdpbmcgcnVuIGJlaW5nIGtpbGxlZCBhcyBzaWxlbnQuXG4gKiAtICoqVGhlcmUgaXMgbm8gYC0tc3lzdGVtLXByb21wdGAgYW5kIG5vIHBlci10b29sIGRpc2FibGUgZmxhZy4qKiBCb3RoIGFyZVxuICogICBjb21wb3NlZCBpbnRvIHRoZSBzaW5nbGUgcHJvbXB0IGJ5IHRoZSBzaGFyZWQgY29tcG9zZXIgcmF0aGVyIHRoYW5cbiAqICAgZHJvcHBlZCDigJQgdGhlIHNhbmRib3hlZC1lbnZpcm9ubWVudCBndWlkYW5jZSBvZiBJc3N1ZSAjNDA3MCByZWFjaGVzIHRoaXNcbiAqICAgcHJvdmlkZXIgdGhyb3VnaCB0aGF0IHByb21wdC5cbiAqIC0gKipUaGVyZSBpcyBubyByZWFzb25pbmctZWZmb3J0IG9wdGlvbi4qKiBBbiBlZmZvcnQgdGhlIGNhbGxlciBzdXBwbGllcyBpc1xuICogICB0aGVyZWZvcmUgbm90IHRyYW5zbGF0ZWQgaW50byBhIGZsYWcgdGhlIENMSSBkb2VzIG5vdCBoYXZlOiBpbnZlbnRpbmcgb25lXG4gKiAgIHdvdWxkIGZhaWwgdGhlIHJ1biBvdXRyaWdodC4gSXQgaXMgbm90IGRyb3BwZWQgaW4gc2lsZW5jZSBlaXRoZXJcbiAqICAgKElzc3VlICMzNjQpOiB0aGUgcmVxdWVzdCBpcyByZXBvcnRlZCBvbmNlIHNvIGFuIG9wZXJhdG9yIHNlZXMgdGhhdCB0aGVcbiAqICAgbGV2ZXIgZG9lcyBub3RoaW5nIHVuZGVyIEdlbWluaS5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB7IHR5cGUgQWdlbnRQcm9tcHRQYXJ0cywgY29tcG9zZUFnZW50UHJvbXB0IH0gZnJvbSBcIi4vYWdlbnRfcHJvbXB0LnRzXCI7XG5pbXBvcnQge1xuICBHRU1JTklfUEhBU0VfTU9ERUxfREVGQVVMVFMsXG4gIFBIQVNFX0VGRk9SVF9ERUZBVUxUUyxcbn0gZnJvbSBcIi4vY29uZmlnX2RlZmF1bHRzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEVudkxvb2t1cCB9IGZyb20gXCIuL2Vudl9sb29rdXAudHNcIjtcbmltcG9ydCB7IHJlc29sdmVQaGFzZVJvdXRlZFZhbHVlIH0gZnJvbSBcIi4vcGhhc2Vfcm91dGluZy50c1wiO1xuaW1wb3J0IHR5cGUgeyBSZXBvQ29uZmlnIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbi8qKlxuICogRmxhZ3MgZXZlcnkgd29ya2VyLWRyaXZlbiBHZW1pbmkgcnVuIGNhcnJpZXMuXG4gKlxuICogLSBgLS1vdXRwdXQtZm9ybWF0IHN0cmVhbS1qc29uYCBzdHJlYW1zIG1hY2hpbmUtcmVhZGFibGUgZXZlbnRzLCBzbyB0aGVcbiAqICAganVkZ2UncyB2ZXJkaWN0IGlzIHBhcnNlZCByYXRoZXIgdGhhbiBzY3JhcGVkLCBhbmQgdGhlIHJ1biBrZWVwc1xuICogICBwcm9kdWNpbmcgb3V0cHV0IHdoaWxlIGl0IHRoaW5rcy5cbiAqIC0gYC0tYXBwcm92YWwtbW9kZSB5b2xvYCDigJQgdGhlIGNvbnRhaW5lciAqaXMqIHRoZSBzYW5kYm94IChJc3N1ZSAjNDA2MCkgYW5kXG4gKiAgIG5vIG9wZXJhdG9yIGlzIHByZXNlbnQgdG8gYXBwcm92ZSBhbnl0aGluZywgc28gdGhlIENMSSdzIG93biBhcHByb3ZhbFxuICogICBwcm9tcHRzIHdvdWxkIGRlYWRsb2NrIGFuIHVuYXR0ZW5kZWQgcnVuLiBJdCBtaXJyb3JzIENsYXVkZSdzXG4gKiAgIGAtLWRhbmdlcm91c2x5LXNraXAtcGVybWlzc2lvbnNgLiBUaGUgQ0xJJ3Mgb3duIGAtLXNhbmRib3hgIGlzXG4gKiAgIGRlbGliZXJhdGVseSBhYnNlbnQ6IGNvbnRhaW5tZW50IGlzIHRoZSBjb250YWluZXIncyBqb2IuXG4gKiAtIGAtLXNraXAtdHJ1c3RgIOKAlCB0aGUgd29ya2VyIGNob29zZXMgdGhlIHdvcmtpbmcgdHJlZSBpdHNlbGYsIHNvIHRoZVxuICogICB3b3Jrc3BhY2UtdHJ1c3QgcHJvbXB0IGhhcyBub2JvZHkgdG8gYW5zd2VyIGl0LlxuICovXG5jb25zdCBTVEFOREFSRF9GTEFHUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIFwiLS1vdXRwdXQtZm9ybWF0XCIsXG4gIFwic3RyZWFtLWpzb25cIixcbiAgXCItLWFwcHJvdmFsLW1vZGVcIixcbiAgXCJ5b2xvXCIsXG4gIFwiLS1za2lwLXRydXN0XCIsXG5dO1xuXG4vKiogUmVzdW1lIHRoZSBtb3N0IHJlY2VudCByZWNvcmRlZCBzZXNzaW9uIChgLS1yZXN1bWUgbGF0ZXN0YCkuICovXG5jb25zdCBSRVNVTUVfTEFURVNUOiByZWFkb25seSBzdHJpbmdbXSA9IFtcIi0tcmVzdW1lXCIsIFwibGF0ZXN0XCJdO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFBlci1waGFzZSBtb2RlbCByb3V0aW5nIChJc3N1ZSAjMzY0LCBwYXJlbnQgIzM1Nylcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogR2xvYmFsIGAuY29uZmlnLmpzb25gIGBnZW1pbmlfcGhhc2VfbW9kZWxfb3ZlcnJpZGVzYCAoSXNzdWUgIzM2NCkuICovXG5sZXQgX2dlbWluaVBoYXNlTW9kZWxDb25maWdPdmVycmlkZXM6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+ID0ge307XG5cbi8qKiBUaGUgYWN0aXZlIHJlcG8ncyBHZW1pbmkgcm91dGluZyBvdmVycmlkZXMgKElzc3VlICMzNjQpLiAqL1xubGV0IF9yZXBvR2VtaW5pTW9kZWwgPSBcIlwiO1xubGV0IF9yZXBvR2VtaW5pUGhhc2VNb2RlbE92ZXJyaWRlczogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4gPSB7fTtcblxuLyoqXG4gKiBSZWNvcmQgdGhlIGdsb2JhbCBwZXItcGhhc2UgR2VtaW5pIG1vZGVsIG92ZXJyaWRlcyAoSXNzdWUgIzM2NCkuXG4gKlxuICogQ2FsbGVkIGR1cmluZyBjb25maWcgbG9hZGluZyB3aXRoIHRoZSBgZ2VtaW5pX3BoYXNlX21vZGVsX292ZXJyaWRlc2Aga2V5LlxuICogVGhlc2Ugb3ZlcnJpZGUge0BsaW5rIEdFTUlOSV9QSEFTRV9NT0RFTF9ERUZBVUxUU30gYW5kIGFyZSB0aGVtc2VsdmVzXG4gKiBvdmVycmlkZGVuIGJ5IHRoZSBwZXItcmVwbyBvdmVycmlkZXMgYW5kIHRoZSBgR0VNSU5JX01PREVMXzxQSEFTRT5gIGVudiB2YXIuXG4gKlxuICogQHBhcmFtIG92ZXJyaWRlcyAtIFBoYXNlLXRvLW1vZGVsIG1hcHBpbmcgZnJvbSBgLmNvbmZpZy5qc29uYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldEdlbWluaVBoYXNlTW9kZWxDb25maWdPdmVycmlkZXMoXG4gIG92ZXJyaWRlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcbik6IHZvaWQge1xuICBfZ2VtaW5pUGhhc2VNb2RlbENvbmZpZ092ZXJyaWRlcyA9IHsgLi4ub3ZlcnJpZGVzIH07XG59XG5cbi8qKlxuICogU2V0IHRoZSBhY3RpdmUgcmVwbydzIEdlbWluaSBtb2RlbCByb3V0aW5nIG92ZXJyaWRlcyAoSXNzdWUgIzM2NCkuXG4gKlxuICogTWlycm9ycyBgc2V0QWN0aXZlUmVwb0NvZGV4TW9kZWxFZmZvcnRPdmVycmlkZXNgIGluIGBjb2RleF9leGVjdXRvci50c2A6IGNhbGxcbiAqIGl0IG9uY2Ugd2hlbiB0aGUgd29ya2VyIHN0YXJ0cyB3b3JrIG9uIGEgcmVwbywgcGFzc2luZyB0aGF0IHJlcG8ncyBtZXJnZWRcbiAqIFJlcG9Db25maWcgKG9yIGB1bmRlZmluZWRgIHRvIGNsZWFyKS4gSXQgKipyZXBsYWNlcyoqIOKAlCBuZXZlciBtZXJnZXMg4oCUIHRoZVxuICogcHJldmlvdXNseS1hY3RpdmUgb3ZlcnJpZGVzLCBzbyBhIGhpZ2gtdmFsdWUgcmVwbydzIHByZW1pdW0gcm91dGluZyBjYW4gbmV2ZXJcbiAqIGxlYWsgaW50byBhIGZpbGxlciByZXBvIHdoZW4gb25lIHdvcmtlciBwcm9jZXNzIHNlcnZlcyBzZXZlcmFsIHJlcG9zLlxuICpcbiAqIEBwYXJhbSByZXBvQ29uZmlnIC0gVGhlIGFjdGl2ZSByZXBvJ3MgUmVwb0NvbmZpZywgb3IgdW5kZWZpbmVkIHRvIGNsZWFyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0QWN0aXZlUmVwb0dlbWluaU1vZGVsT3ZlcnJpZGVzKFxuICByZXBvQ29uZmlnOiBSZXBvQ29uZmlnIHwgdW5kZWZpbmVkLFxuKTogdm9pZCB7XG4gIF9yZXBvR2VtaW5pTW9kZWwgPSByZXBvQ29uZmlnPy5nZW1pbmlNb2RlbCA/PyBcIlwiO1xuICBfcmVwb0dlbWluaVBoYXNlTW9kZWxPdmVycmlkZXMgPSB7XG4gICAgLi4uKHJlcG9Db25maWc/LmdlbWluaVBoYXNlTW9kZWxPdmVycmlkZXMgPz8ge30pLFxuICB9O1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIG1vZGVsIEdlbWluaSBydW5zIGEgcGhhc2Ugb24g4oCUIHRoZSB2YWx1ZSBiZWhpbmQgYC0tbW9kZWxgLlxuICpcbiAqIFRoZSBzaXgtc3RlcCBjaGFpbiBpdHNlbGYgbGl2ZXMgaW4gYHBoYXNlX3JvdXRpbmcudHNgOyB0aGlzIHN1cHBsaWVzIEdlbWluaSdzXG4gKiBuYW1lcywgdGFibGVzIGFuZCBvdmVycmlkZSBzdGF0ZSwgc28gdGhlIHByZWNlZGVuY2UgaXMgQ2xhdWRlJ3MgcHJlY2VkZW5jZVxuICogd2l0aCBHZW1pbmktbmFtZWQga2V5cyAoSXNzdWUgIzM2NCk6XG4gKiAgIDEuIGBHRU1JTklfTU9ERUxfPFBIQVNFPmAgZW52IHZhciDigJQgb3BlcmF0b3IgZXNjYXBlIGhhdGNoXG4gKiAgIDIuIFBlci1yZXBvIGBnZW1pbmlfcGhhc2VfbW9kZWxfb3ZlcnJpZGVzYFxuICogICAzLiBQZXItcmVwbyBgZ2VtaW5pX21vZGVsYCBiYXNlIHRpZXIg4oCUIGFwcGxpZXMgdG8gYWxsIHBoYXNlc1xuICogICA0LiBHbG9iYWwgY29uZmlnIGBnZW1pbmlfcGhhc2VfbW9kZWxfb3ZlcnJpZGVzYFxuICogICA1LiB7QGxpbmsgR0VNSU5JX1BIQVNFX01PREVMX0RFRkFVTFRTfSDigJQgZGVzaWduZWQgY29zdCBvcHRpbWlzYXRpb25cbiAqICAgNi4gQmFzZSBgR0VNSU5JX01PREVMYCBlbnYgdmFyIOKAlCBnbG9iYWwgZmFsbGJhY2tcbiAqXG4gKiBAcGFyYW0gcGhhc2UgLSBPcHRpb25hbCBwaGFzZSBuYW1lIChlLmcuIGBcInBsYW5uaW5nXCJgKS5cbiAqIEBwYXJhbSBlbnYgLSBFbnZpcm9ubWVudCBsb29rdXAgZm9yIHN0ZXBzIDEgYW5kIDYgKElzc3VlICM5NTcpOyBkZWZhdWx0cyB0b1xuICogICB0aGUgcHJvY2VzcyBlbnZpcm9ubWVudC5cbiAqIEByZXR1cm5zIFRoZSByZXNvbHZlZCBtb2RlbCwgb3IgYHVuZGVmaW5lZGAgd2hlbiBubyBzdGVwIHN1cHBsaWVzIG9uZSDigJQgdGhlXG4gKiAgIENMSSdzIGNvbmZpZ3VyZWQgZGVmYXVsdCB0aGVuIHN0YW5kcywgYW5kIGEgbm9uLWVtcHR5IHBoYXNlIHdhcm5zLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUdlbWluaU1vZGVsKFxuICBwaGFzZT86IHN0cmluZyxcbiAgZW52PzogRW52TG9va3VwLFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIHJlc29sdmVQaGFzZVJvdXRlZFZhbHVlKHtcbiAgICBsb2dQcmVmaXg6IFwiZ2VtaW5pLWV4ZWN1dG9yXCIsXG4gICAgd2hhdDogXCJtb2RlbFwiLFxuICAgIGZsYWc6IFwiLS1tb2RlbFwiLFxuICAgIGVudlZhcjogXCJHRU1JTklfTU9ERUxcIixcbiAgICBlbnYsXG4gICAgcmVwb1BoYXNlT3ZlcnJpZGVzOiBfcmVwb0dlbWluaVBoYXNlTW9kZWxPdmVycmlkZXMsXG4gICAgcmVwb1BoYXNlT3ZlcnJpZGVzS2V5OiBcImdlbWluaV9waGFzZV9tb2RlbF9vdmVycmlkZXNcIixcbiAgICByZXBvQmFzZTogX3JlcG9HZW1pbmlNb2RlbCxcbiAgICByZXBvQmFzZUtleTogXCJnZW1pbmlfbW9kZWxcIixcbiAgICBnbG9iYWxQaGFzZU92ZXJyaWRlczogX2dlbWluaVBoYXNlTW9kZWxDb25maWdPdmVycmlkZXMsXG4gICAgZ2xvYmFsUGhhc2VPdmVycmlkZXNLZXk6IFwiZ2VtaW5pX3BoYXNlX21vZGVsX292ZXJyaWRlc1wiLFxuICAgIHBoYXNlRGVmYXVsdHM6IEdFTUlOSV9QSEFTRV9NT0RFTF9ERUZBVUxUUyxcbiAgICBwaGFzZURlZmF1bHRzTmFtZTogXCJHRU1JTklfUEhBU0VfTU9ERUxfREVGQVVMVFNcIixcbiAgfSwgcGhhc2UpO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIHJlYXNvbmluZyBlZmZvcnQgYSBwaGFzZSBpcyAqYXNrZWQqIHRvIHJ1biBhdCAoSXNzdWUgIzM2NCkuXG4gKlxuICogVGhlIEdlbWluaSBDTEkgaGFzIG5vIHJlYXNvbmluZy1lZmZvcnQgb3B0aW9uLCBzbyB0aGlzIHZhbHVlIG5ldmVyIGJlY29tZXMgYW5cbiAqIGFyZ3VtZW50IOKAlCB0aGVyZSBpcyBkZWxpYmVyYXRlbHkgbm8gR2VtaW5pIGVmZm9ydCB0YWJsZSwgYW5kIG5vIEdlbWluaSBlZmZvcnRcbiAqIGNvbmZpZyBrZXksIGJlY2F1c2UgZWl0aGVyIHdvdWxkIGJlIGNvbmZpZ3VyYXRpb24gdGhlIENMSSBjYW4gbmV2ZXIgYXBwbHkuXG4gKiBXaGF0IGl0IGRvZXMgc3VwcGx5IGlzIHRoZSBzaWduYWwgdGhlIGZhaWwtbG91ZCBzdGFuZGFyZCByZXF1aXJlc1xuICogKElzc3VlICMzMjM0KTogdGhlIHdvcmtlcidzIG93biBwaGFzZSBlZmZvcnQgZGVzaWduXG4gKiAoe0BsaW5rIFBIQVNFX0VGRk9SVF9ERUZBVUxUU30pIGlzIHdoYXQgYW4gb3BlcmF0b3IgcmVseWluZyBvbiBkZWZhdWx0c1xuICogZXhwZWN0cyB0byBiZSBob25vdXJlZCwgc28ge0BsaW5rIGJ1aWxkR2VtaW5pQXJnc30gcmVwb3J0cyB0aGUgZ2FwIGluc3RlYWQgb2ZcbiAqIGRpc2NhcmRpbmcgdGhlIHJlcXVlc3Qgc2lsZW50bHkuIEFuIGV4cGxpY2l0IGByZXF1ZXN0LmVmZm9ydGAgYmVhdHMgdGhpc1xuICogdGhyb3VnaCBgcmVzb2x2ZUludm9jYXRpb25Sb3V0aW5nYCwgYW5kIGlzIHJlcG9ydGVkIHRoZSBzYW1lIHdheS5cbiAqXG4gKiBAcGFyYW0gcGhhc2UgLSBPcHRpb25hbCBwaGFzZSBuYW1lIChlLmcuIGBcInBsYW5uaW5nXCJgKS5cbiAqIEByZXR1cm5zIFRoZSBlZmZvcnQgdGhlIHBoYXNlIGRlc2lnbiBhc2tzIGZvciwgb3IgYHVuZGVmaW5lZGAgd2hlbiB0aGUgcGhhc2VcbiAqICAgaXMgYWJzZW50IG9yIGhhcyBubyBkZXNpZ25lZCBlZmZvcnQg4oCUIG5vdGhpbmcgdG8gcmVwb3J0IGluIGVpdGhlciBjYXNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUdlbWluaUVmZm9ydChwaGFzZT86IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBwaGFzZSA/IFBIQVNFX0VGRk9SVF9ERUZBVUxUU1twaGFzZV0gOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogUGhhc2VzIGFscmVhZHkgd2FybmVkIGFib3V0IGFuIHVuaG9ub3VyYWJsZSBlZmZvcnQsIG9uY2UgcGVyIHdvcmtlciBwcm9jZXNzLlxuICpcbiAqIE9uZSB3YXJuaW5nIHBlciBwaGFzZSBwZXIgcHJvY2VzczogYSBtdWx0aS1waGFzZSBydW4gc3RhdGVzIHRoZSBnYXAgZm9yIGVhY2hcbiAqIGRpc3RpbmN0IHBoYXNlIGl0IHJvdXRlcywgYW5kIGEgcGhhc2UgdGhhdCBpcyBpbnZva2VkIHJlcGVhdGVkbHkgKGEgcmV0cnksIGFcbiAqIHF1YWxpdHktZml4IGxvb3ApIHN0YXRlcyBpdCBvbmNlLiBUaGUga2V5IG9mIGEgcGhhc2UtbGVzcyBpbnZvY2F0aW9uIGlzIHRoZVxuICogZW1wdHkgc3RyaW5nLCBzbyBpdCB0b28gd2FybnMgb25jZS5cbiAqL1xuY29uc3QgX2VmZm9ydFdhcm5lZFBoYXNlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4vKipcbiAqIENsZWFyIHRoZSBwZXItcHJvY2VzcyBlZmZvcnQtd2FybmluZyBzdGF0ZSAoSXNzdWUgIzM2NCkuXG4gKlxuICogRXhwb3NlZCBzbyBhIHRlc3Qg4oCUIG9yIGFueSBjYWxsZXIgdGhhdCBkZWxpYmVyYXRlbHkgcmUtcnVucyBhIHBoYXNlIGFzIGFcbiAqIGZyZXNoIHNjZW5hcmlvIOKAlCBjYW4gb2JzZXJ2ZSB0aGUgZmlyc3Qgd2FybmluZyBhZ2Fpbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyR2VtaW5pRWZmb3J0V2FybmluZ3MoKTogdm9pZCB7XG4gIF9lZmZvcnRXYXJuZWRQaGFzZXMuY2xlYXIoKTtcbn1cblxuLyoqXG4gKiBSZXBvcnQgYW4gZWZmb3J0IHRoZSBHZW1pbmkgQ0xJIGNhbm5vdCBob25vdXIsIG9uY2UgcGVyIHBoYXNlLlxuICpcbiAqIEZhaWwgbG91ZCwgZG8gbm90IGZhaWwgdGhlIHJ1biAoSXNzdWUgIzM2NCk6IHRoZSBpbnZvY2F0aW9uIGlzIHZhbGlkLCBpdFxuICogc2ltcGx5IGNhbm5vdCBjYXJyeSB0aGUgbGV2ZXIsIHNvIHRoZSB3YXJuaW5nICppcyogdGhlIGZpeC4gSW52ZW50aW5nIGEgZmxhZ1xuICogdGhlIENMSSBkb2VzIG5vdCBoYXZlIHdvdWxkIGZhaWwgdGhlIHJ1biBvdXRyaWdodC5cbiAqXG4gKiBAcGFyYW0gZWZmb3J0IC0gVGhlIHJlcXVlc3RlZCByZWFzb25pbmcgZWZmb3J0LlxuICogQHBhcmFtIHBoYXNlIC0gVGhlIHBoYXNlIGl0IHdhcyByZXF1ZXN0ZWQgZm9yLCB3aGVuIHRoZXJlIGlzIG9uZS5cbiAqL1xuZnVuY3Rpb24gd2FybkVmZm9ydFVuc3VwcG9ydGVkKGVmZm9ydDogc3RyaW5nLCBwaGFzZT86IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBrZXkgPSBwaGFzZSA/PyBcIlwiO1xuICBpZiAoX2VmZm9ydFdhcm5lZFBoYXNlcy5oYXMoa2V5KSkgcmV0dXJuO1xuICBfZWZmb3J0V2FybmVkUGhhc2VzLmFkZChrZXkpO1xuXG4gIGNvbnN0IHdoZXJlID0gcGhhc2UgPyBgcGhhc2UgXCIke3BoYXNlfVwiYCA6IFwiYSBwaGFzZS1sZXNzIGludm9jYXRpb25cIjtcbiAgY29uc29sZS53YXJuKFxuICAgIGBbZ2VtaW5pXSBSZWFzb25pbmcgZWZmb3J0ICR7SlNPTi5zdHJpbmdpZnkoZWZmb3J0KX0gcmVxdWVzdGVkIGZvciBgICtcbiAgICAgIGAke3doZXJlfSBidXQgdGhlIEdlbWluaSBDTEkgaGFzIG5vIGVmZm9ydCBvcHRpb247IHRoZSByZXF1ZXN0IGlzIGAgK1xuICAgICAgYGlnbm9yZWQuIFJ1biB0aGlzIHBoYXNlIHVuZGVyIGEgcHJvdmlkZXIgdGhhdCBoYXMgdGhlIGxldmVyIChjbGF1ZGUsIGAgK1xuICAgICAgYGNvZGV4KSwgb3IgY2xlYXIgdGhlIGVmZm9ydCBjb25maWd1cmF0aW9uIGZvciBpdC5gLFxuICApO1xufVxuXG4vKiogV2hhdCB7QGxpbmsgYnVpbGRHZW1pbmlBcmdzfSBuZWVkcyB0byBidWlsZCBvbmUgaW52b2NhdGlvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgR2VtaW5pSW52b2NhdGlvbiBleHRlbmRzIEFnZW50UHJvbXB0UGFydHMge1xuICAvKiogRXhwbGljaXQgbW9kZWwgaWQ7IG9taXR0ZWQgbGVhdmVzIEdlbWluaSBvbiBpdHMgY29uZmlndXJlZCBkZWZhdWx0LiAqL1xuICBtb2RlbD86IHN0cmluZztcbiAgLyoqXG4gICAqIFRoZSByZWFzb25pbmcgZWZmb3J0IHRoaXMgaW52b2NhdGlvbiB3YXMgYXNrZWQgdG8gcnVuIGF0IChJc3N1ZSAjMzY0KS5cbiAgICogR2VtaW5pIGhhcyBubyBmbGFnIHRvIGNhcnJ5IGl0LCBzbyBpdCBwcm9kdWNlcyBvbmUgd2FybmluZyBhbmQgbm9cbiAgICogYXJndW1lbnQuXG4gICAqL1xuICBlZmZvcnQ/OiBzdHJpbmc7XG4gIC8qKiBUaGUgcGhhc2UgdGhlIGVmZm9ydCB3YXMgcmVxdWVzdGVkIGZvciwgbmFtZWQgaW4gdGhhdCB3YXJuaW5nLiAqL1xuICBwaGFzZT86IHN0cmluZztcbiAgLyoqIENvbnRpbnVlIHRoZSBwcmV2aW91cyBydW4gb2YgdGhpcyBpc3N1ZSByYXRoZXIgdGhhbiBzdGFydGluZyBmcmVzaC4gKi9cbiAgcmVzdW1lU2Vzc2lvbj86IGJvb2xlYW47XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIEdlbWluaSBDTEkgYXJndW1lbnQgbGlzdCBmb3Igb25lIG5vbi1pbnRlcmFjdGl2ZSBydW4uXG4gKlxuICogU2Vzc2lvbiBjb250aW51aXR5IHVzZXMgYC0tcmVzdW1lIGxhdGVzdGA6IEdlbWluaSBuYW1lcyBzZXNzaW9ucyB3aXRoIGl0c1xuICogb3duIGlkZW50aWZpZXJzLCBzbyB0aGUgd29ya2VyIHJlc3VtZXMgdGhlIG1vc3QgcmVjZW50IHJlY29yZGVkIHNlc3Npb24g4oCUXG4gKiB3aGljaCwgd2l0aGluIGEgcnVuLCBpcyB0aGUgcHJldmlvdXMgcGhhc2Ugb2YgdGhlIHNhbWUgaXNzdWUg4oCUIHJhdGhlciB0aGFuXG4gKiBpbnZlbnRpbmcgYW4gaWQgR2VtaW5pIHdvdWxkIHJlamVjdC5cbiAqXG4gKiBBIHJlcXVlc3RlZCByZWFzb25pbmcgZWZmb3J0IGFkZHMgbm8gYXJndW1lbnQg4oCUIHRoZSBDTEkgaGFzIG5vIHN1Y2ggb3B0aW9uIOKAlFxuICogYnV0IGl0IGRvZXMgZW1pdCBvbmUgd2FybmluZyBuYW1pbmcgdGhlIHBoYXNlIGFuZCB0aGUgZWZmb3J0IChJc3N1ZSAjMzY0KSwgc29cbiAqIGEgY29uZmlndXJlZCBsZXZlciB0aGF0IGRvZXMgbm90aGluZyBpcyB2aXNpYmxlIHJhdGhlciB0aGFuIHNpbGVudC5cbiAqXG4gKiBAcGFyYW0gaW52b2NhdGlvbiAtIFByb21wdCwgbW9kZWwvZWZmb3J0IHNlbGVjdGlvbiBhbmQgcmVzdW1lIHN0YXRlLlxuICogQHJldHVybnMgVGhlIGFyZ3VtZW50IGxpc3QsIHByb21wdCBsYXN0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRHZW1pbmlBcmdzKGludm9jYXRpb246IEdlbWluaUludm9jYXRpb24pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGFyZ3M6IHN0cmluZ1tdID0gWy4uLlNUQU5EQVJEX0ZMQUdTXTtcblxuICBpZiAoaW52b2NhdGlvbi5lZmZvcnQpIHtcbiAgICB3YXJuRWZmb3J0VW5zdXBwb3J0ZWQoaW52b2NhdGlvbi5lZmZvcnQsIGludm9jYXRpb24ucGhhc2UpO1xuICB9XG4gIGlmIChpbnZvY2F0aW9uLm1vZGVsKSBhcmdzLnB1c2goXCItLW1vZGVsXCIsIGludm9jYXRpb24ubW9kZWwpO1xuICBpZiAoaW52b2NhdGlvbi5yZXN1bWVTZXNzaW9uKSBhcmdzLnB1c2goLi4uUkVTVU1FX0xBVEVTVCk7XG5cbiAgYXJncy5wdXNoKFwiLS1wcm9tcHRcIiwgY29tcG9zZUFnZW50UHJvbXB0KGludm9jYXRpb24pKTtcbiAgcmV0dXJuIGFyZ3M7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBZ0NDLEdBRUQsU0FBZ0Msa0JBQWtCLFFBQVEsb0JBQW9CO0FBQzlFLFNBQ0UsMkJBQTJCLEVBQzNCLHFCQUFxQixRQUNoQix1QkFBdUI7QUFFOUIsU0FBUyx1QkFBdUIsUUFBUSxxQkFBcUI7QUFHN0Q7Ozs7Ozs7Ozs7Ozs7Q0FhQyxHQUNELE1BQU0saUJBQW9DO0VBQ3hDO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7Q0FDRDtBQUVELGlFQUFpRSxHQUNqRSxNQUFNLGdCQUFtQztFQUFDO0VBQVk7Q0FBUztBQUUvRCw4RUFBOEU7QUFDOUUsb0RBQW9EO0FBQ3BELDhFQUE4RTtBQUU5RSx1RUFBdUUsR0FDdkUsSUFBSSxtQ0FBcUUsQ0FBQztBQUUxRSw2REFBNkQsR0FDN0QsSUFBSSxtQkFBbUI7QUFDdkIsSUFBSSxpQ0FBbUUsQ0FBQztBQUV4RTs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sU0FBUyxtQ0FDZCxTQUFpQztFQUVqQyxtQ0FBbUM7SUFBRSxHQUFHLFNBQVM7RUFBQztBQUNwRDtBQUVBOzs7Ozs7Ozs7O0NBVUMsR0FDRCxPQUFPLFNBQVMsa0NBQ2QsVUFBa0M7RUFFbEMsbUJBQW1CLFlBQVksZUFBZTtFQUM5QyxpQ0FBaUM7SUFDL0IsR0FBSSxZQUFZLDZCQUE2QixDQUFDLENBQUM7RUFDakQ7QUFDRjtBQUVBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FrQkMsR0FDRCxPQUFPLFNBQVMsbUJBQ2QsS0FBYyxFQUNkLEdBQWU7RUFFZixPQUFPLHdCQUF3QjtJQUM3QixXQUFXO0lBQ1gsTUFBTTtJQUNOLE1BQU07SUFDTixRQUFRO0lBQ1I7SUFDQSxvQkFBb0I7SUFDcEIsdUJBQXVCO0lBQ3ZCLFVBQVU7SUFDVixhQUFhO0lBQ2Isc0JBQXNCO0lBQ3RCLHlCQUF5QjtJQUN6QixlQUFlO0lBQ2YsbUJBQW1CO0VBQ3JCLEdBQUc7QUFDTDtBQUVBOzs7Ozs7Ozs7Ozs7Ozs7O0NBZ0JDLEdBQ0QsT0FBTyxTQUFTLG9CQUFvQixLQUFjO0VBQ2hELE9BQU8sUUFBUSxxQkFBcUIsQ0FBQyxNQUFNLEdBQUc7QUFDaEQ7QUFFQTs7Ozs7OztDQU9DLEdBQ0QsTUFBTSxzQkFBc0IsSUFBSTtBQUVoQzs7Ozs7Q0FLQyxHQUNELE9BQU8sU0FBUztFQUNkLG9CQUFvQixLQUFLO0FBQzNCO0FBRUE7Ozs7Ozs7OztDQVNDLEdBQ0QsU0FBUyxzQkFBc0IsTUFBYyxFQUFFLEtBQWM7RUFDM0QsTUFBTSxNQUFNLFNBQVM7RUFDckIsSUFBSSxvQkFBb0IsR0FBRyxDQUFDLE1BQU07RUFDbEMsb0JBQW9CLEdBQUcsQ0FBQztFQUV4QixNQUFNLFFBQVEsUUFBUSxDQUFDLE9BQU8sRUFBRSxNQUFNLENBQUMsQ0FBQyxHQUFHO0VBQzNDLFFBQVEsSUFBSSxDQUNWLENBQUMsMEJBQTBCLEVBQUUsS0FBSyxTQUFTLENBQUMsUUFBUSxlQUFlLENBQUMsR0FDbEUsR0FBRyxNQUFNLHlEQUF5RCxDQUFDLEdBQ25FLENBQUMscUVBQXFFLENBQUMsR0FDdkUsQ0FBQyxpREFBaUQsQ0FBQztBQUV6RDtBQWtCQTs7Ozs7Ozs7Ozs7Ozs7Q0FjQyxHQUNELE9BQU8sU0FBUyxnQkFBZ0IsVUFBNEI7RUFDMUQsTUFBTSxPQUFpQjtPQUFJO0dBQWU7RUFFMUMsSUFBSSxXQUFXLE1BQU0sRUFBRTtJQUNyQixzQkFBc0IsV0FBVyxNQUFNLEVBQUUsV0FBVyxLQUFLO0VBQzNEO0VBQ0EsSUFBSSxXQUFXLEtBQUssRUFBRSxLQUFLLElBQUksQ0FBQyxXQUFXLFdBQVcsS0FBSztFQUMzRCxJQUFJLFdBQVcsYUFBYSxFQUFFLEtBQUssSUFBSSxJQUFJO0VBRTNDLEtBQUssSUFBSSxDQUFDLFlBQVksbUJBQW1CO0VBQ3pDLE9BQU87QUFDVCJ9
// denoCacheMetadata=15252372242787483649,16314395727286318420