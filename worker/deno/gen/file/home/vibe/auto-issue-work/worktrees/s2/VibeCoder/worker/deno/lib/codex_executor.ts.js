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
 */ import { composeAgentPrompt } from "./agent_prompt.ts";
import { CODEX_PHASE_EFFORT_DEFAULTS, CODEX_PHASE_MODEL_DEFAULTS } from "./config_defaults.ts";
import { CODEX_HOME_ENV_VAR } from "./codex_auth.ts";
import { resolveCodexAuthMode } from "./codex_auth_mode.ts";
import { processEnvLookup } from "./env_lookup.ts";
import { resolvePhaseRoutedValue } from "./phase_routing.ts";
/** The Codex subcommand for a non-interactive run. */ const EXEC_SUBCOMMAND = "exec";
/** Resume a named thread (`codex exec resume <SESSION_ID>`). */ const RESUME_SUBCOMMAND = "resume";
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
 */ const STANDARD_FLAGS = [
  "--json",
  "--skip-git-repo-check",
  "--dangerously-bypass-approvals-and-sandbox"
];
/** Codex config key carrying the reasoning effort, set via `-c key=value`. */ const REASONING_EFFORT_KEY = "model_reasoning_effort";
/**
 * Compose the single prompt string `codex exec` takes.
 *
 * Codex has no separate system-prompt or disallowed-tools channel, so both are
 * folded into the prompt by the shared composer (Issue #4107), which every
 * provider in that position uses.
 *
 * @param parts - The prompt, the optional system prompt and disallowed tools.
 * @returns The composed prompt.
 */ export function composeCodexPrompt(parts) {
  return composeAgentPrompt(parts);
}
// ---------------------------------------------------------------------------
// Per-phase model and reasoning-effort routing (Issue #363, parent #357)
// ---------------------------------------------------------------------------
/** Global `.config.json` `codex_phase_model_overrides` (Issue #363). */ let _codexPhaseModelConfigOverrides = {};
/** Global `.config.json` `codex_phase_effort_overrides` (Issue #363). */ let _codexPhaseEffortConfigOverrides = {};
/** The active repo's Codex routing overrides (Issue #363). */ let _repoCodexModel = "";
let _repoCodexPhaseModelOverrides = {};
let _repoCodexPhaseEffortOverrides = {};
/**
 * Record the global per-phase Codex model overrides (Issue #363).
 *
 * Called during config loading with the `codex_phase_model_overrides` key.
 * These override {@link CODEX_PHASE_MODEL_DEFAULTS} and are themselves
 * overridden by the per-repo overrides and the `CODEX_MODEL_<PHASE>` env var.
 *
 * @param overrides - Phase-to-model mapping from `.config.json`.
 */ export function setCodexPhaseModelConfigOverrides(overrides) {
  _codexPhaseModelConfigOverrides = {
    ...overrides
  };
}
/**
 * Record the global per-phase Codex effort overrides (Issue #363).
 *
 * @param overrides - Phase-to-effort mapping from `.config.json`.
 */ export function setCodexPhaseEffortConfigOverrides(overrides) {
  _codexPhaseEffortConfigOverrides = {
    ...overrides
  };
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
 */ export function setActiveRepoCodexModelEffortOverrides(repoConfig) {
  _repoCodexModel = repoConfig?.codexModel ?? "";
  _repoCodexPhaseModelOverrides = {
    ...repoConfig?.codexPhaseModelOverrides ?? {}
  };
  _repoCodexPhaseEffortOverrides = {
    ...repoConfig?.codexPhaseEffortOverrides ?? {}
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
 *   5. {@link CODEX_PHASE_MODEL_DEFAULTS} — designed cost optimisation; a default
 *      this ChatGPT login refused (Issue #4221) resolves to no `--model`
 *   6. Base `CODEX_MODEL` env var — global fallback
 *
 * @param phase - Optional phase name (e.g. `"planning"`).
 * @param env - Environment lookup for steps 1 and 6 (Issue #957); defaults to
 *   the process environment.
 * @returns The resolved model, or `undefined` when no step supplies one — the
 *   CLI's configured default then stands, and a non-empty phase warns.
 */ export function resolveCodexModel(phase, env) {
  const model = resolvePhaseRoutedValue({
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
    phaseDefaultsName: "CODEX_PHASE_MODEL_DEFAULTS"
  }, phase);
  // (Issue #4221) A built-in default this ChatGPT login refused: when the value
  // came from the designed default, the CLI's own model stands for the run.
  // An explicit pin always wins.
  if (model && _refusedCodexModels.size > 0 && isCodexChatgptLogin(env) && _refusedCodexModels.has(model.trim().toLowerCase()) && codexBuiltInDefaultModel(phase, env) === model) {
    return undefined;
  }
  return model;
}
/**
 * Sentinel meaning "send no `--model`", so the Codex CLI picks its own (Issue #4221).
 */ export const CODEX_CLI_DEFAULT_MODEL = "codex-cli-default";
/** Built-in default models this ChatGPT login refused, lower-cased, for this run (Issue #4221). */ const _refusedCodexModels = new Set();
/** Refused model ids already reported, so each warns once per process (Issue #4221). */ const _refusedCodexModelsWarned = new Set();
/**
 * Whether Codex authenticates with a persisted ChatGPT login (Issue #4221).
 *
 * Mirrors the descriptor's `resolveStoredBilling`: only an explicit
 * `CODEX_HOME` is read, and no environment variable is consulted. That hook is
 * the twin of this check and must agree with it (a `codex-chatgpt-login`
 * reason is exactly the true answer here).
 *
 * @param env - Environment lookup; defaults to the process environment.
 * @returns True only when the explicit `CODEX_HOME` holds a ChatGPT login.
 */ export function isCodexChatgptLogin(env = processEnvLookup) {
  const home = (env(CODEX_HOME_ENV_VAR) ?? "").trim();
  if (!home) return false;
  return resolveCodexAuthMode(home, ()=>undefined).mode === "chatgpt";
}
/**
 * Forget every refused model and warning, for a fresh run (Issue #4221).
 */ export function clearRefusedCodexModels() {
  _refusedCodexModels.clear();
  _refusedCodexModelsWarned.clear();
}
/**
 * The built-in default model a phase resolves to, when no pin supplies one (Issue #4221).
 *
 * Returns the {@link CODEX_PHASE_MODEL_DEFAULTS} value only when steps 1–4 of
 * {@link resolveCodexModel} are all absent for the phase.
 *
 * @param phase - Optional phase name (e.g. `"health"`).
 * @param env - Environment lookup for the `CODEX_MODEL_<PHASE>` pin.
 * @returns The designed default for the phase, or `undefined` when pinned or unknown.
 */ export function codexBuiltInDefaultModel(phase, env) {
  if (!phase) return undefined;
  if ((env ?? processEnvLookup)(`CODEX_MODEL_${phase.toUpperCase()}`)) {
    return undefined;
  }
  if (_repoCodexPhaseModelOverrides[phase]) return undefined;
  if (_repoCodexModel) return undefined;
  if (_codexPhaseModelConfigOverrides[phase]) return undefined;
  return CODEX_PHASE_MODEL_DEFAULTS[phase];
}
/**
 * Record a built-in default model this ChatGPT login refused, for this run (Issue #4221).
 *
 * Warns once per refused id; the warning names the re-pin knobs.
 *
 * @param model - The refused model id.
 * @param phase - The phase the refused default was routed for, if known.
 */ export function markCodexModelRefused(model, phase) {
  const id = model.trim().toLowerCase();
  _refusedCodexModels.add(id);
  if (_refusedCodexModelsWarned.has(id)) return;
  _refusedCodexModelsWarned.add(id);
  console.warn(`[codex] Model ${JSON.stringify(model)} (built-in default for phase "${phase ?? "unknown"}") was refused by this ChatGPT login — omitting --model so the Codex CLI ` + `picks its own model for the rest of this run (Issue #4221). Re-pin it ` + `with codex_phase_model_overrides or provider_model_tiers.codex.`);
}
/**
 * The same-provider alternatives to a refused model: the CLI default, when a
 * ChatGPT login refused a phase's built-in default (Issue #4221).
 *
 * @param model - The model that probed unavailable.
 * @param phase - The phase the model was routed for, if known.
 * @param env - Environment lookup; defaults to the process environment.
 * @returns `[CODEX_CLI_DEFAULT_MODEL]` for a refused built-in default, else `[]`.
 */ export function codexAlternativeModels(model, phase, env) {
  const id = model.trim().toLowerCase();
  if (!isCodexChatgptLogin(env)) return [];
  const builtIn = codexBuiltInDefaultModel(phase, env);
  if (builtIn === undefined || builtIn.trim().toLowerCase() !== id) return [];
  return [
    CODEX_CLI_DEFAULT_MODEL
  ];
}
/**
 * Apply a Codex model adaptation for this run (Issue #4221): the refused model
 * is dropped, so the phase runs on the CLI's own default.
 *
 * @param unavailable - The model that probed unavailable.
 * @param _alternative - The alternative (always the CLI default).
 * @param phase - The phase the model was routed for, if known.
 */ export function applyCodexModelAdaptation(unavailable, _alternative, phase) {
  markCodexModelRefused(unavailable, phase);
}
/**
 * In-run counterpart of {@link codexAlternativeModels} (Issue #4221): an
 * invocation refused `model`, so mark it and let one retry drop `--model`.
 *
 * @param model - The model the refused invocation ran on.
 * @param phase - The phase the invocation ran for, if known.
 * @param env - Environment lookup; defaults to the process environment.
 * @returns True when the refusal was adapted and a retry should omit `--model`.
 */ export function adaptCodexAfterModelRefusal(model, phase, env) {
  if (codexAlternativeModels(model, phase, env).length === 0) return false;
  markCodexModelRefused(model, phase);
  return true;
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
 */ export function resolveCodexEffort(phase, env) {
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
    phaseDefaultsName: "CODEX_PHASE_EFFORT_DEFAULTS"
  }, phase);
}
/** A TOML string value, quoted. */ function tomlString(value) {
  return JSON.stringify(value);
}
/** A TOML array of strings. */ function tomlStringArray(values) {
  return `[${values.map(tomlString).join(", ")}]`;
}
/**
 * A TOML inline table of string values. Non-string entries are dropped
 * rather than stringified into a shape the CLI would refuse.
 */ function tomlInlineTable(record) {
  const parts = [];
  for (const [key, value] of Object.entries(record)){
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    if (typeof value !== "string") continue;
    parts.push(`${key} = ${tomlString(value)}`);
  }
  return `{ ${parts.join(", ")} }`;
}
/**
 * Build the `-c mcp_servers.<name>.*` overrides Codex understands
 * (Issue #1702).
 *
 * The shared Playwright config is Claude's `--mcp-config` JSON. Codex
 * reads MCP servers from `config.toml` keys, overridden per invocation
 * with `-c`. Unknown JSON yields no flags — the caller fails closed when
 * a path was given and nothing could be applied.
 */ export function buildCodexMcpConfigArgs(configJson) {
  let parsed;
  try {
    parsed = JSON.parse(configJson);
  } catch  {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const servers = parsed.mcpServers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    return [];
  }
  const args = [];
  for (const [name, spec] of Object.entries(servers)){
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      continue;
    }
    const server = spec;
    if (typeof server.command === "string") {
      args.push("-c", `mcp_servers.${name}.command=${tomlString(server.command)}`);
    }
    if (Array.isArray(server.args) && server.args.every((a)=>typeof a === "string")) {
      args.push("-c", `mcp_servers.${name}.args=${tomlStringArray(server.args)}`);
    }
    if (server.env !== null && typeof server.env === "object" && !Array.isArray(server.env)) {
      args.push("-c", `mcp_servers.${name}.env=${tomlInlineTable(server.env)}`);
    }
  }
  return args;
}
/**
 * Translate the worker's synchronous command hooks to Codex TOML (Issue #4121).
 * Codex presents shell tools to hooks as Bash with a string command, so RTK's
 * existing processor works unchanged. No user configuration file is written.
 */ function codexHookArgs(settingsJson) {
  const settings = JSON.parse(settingsJson);
  const groups = settings?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) {
    throw new Error("Codex hook settings require a PreToolUse array");
  }
  const entries = groups.map((group)=>{
    if (typeof group?.matcher !== "string" || !Array.isArray(group.hooks)) {
      throw new Error("Codex PreToolUse requires a matcher and hooks array");
    }
    const hooks = group.hooks.map((hook)=>{
      if (hook?.type !== "command" || typeof hook.command !== "string") {
        throw new Error("Codex PreToolUse requires command hooks with a string command");
      }
      return `{type="command",command=${tomlString(hook.command)}}`;
    });
    return `{matcher=${tomlString(group.matcher)},hooks=[${hooks.join(",")}]}`;
  });
  if (entries.length === 0) return [];
  return [
    "--dangerously-bypass-hook-trust",
    "-c",
    "features.hooks=true",
    "-c",
    `hooks.PreToolUse=[${entries.join(",")}]`
  ];
}
/**
 * Build the Codex CLI argument list for one non-interactive run.
 *
 * Session continuity uses `codex exec resume <SESSION_ID>` with the thread
 * the previous phase of *this* issue reported (Issue #1699). `--last` is
 * not used: concurrent slots share a working directory and would resume
 * each other's sessions.
 *
 * `codex exec resume` does not accept `--sandbox` (Issue #4333). A resumed
 * orchestrated run sets the same mode through `sandbox_mode` (`-c`). A fresh
 * `codex exec` still passes `--sandbox`.
 *
 * @param invocation - Prompt, model/effort selection and resume state.
 * @returns The argument list, prompt last (or `-` when stdin carries it).
 */ export function buildCodexArgs(invocation) {
  const args = [
    EXEC_SUBCOMMAND
  ];
  if (invocation.resumeSessionId) {
    args.push(RESUME_SUBCOMMAND, invocation.resumeSessionId);
  }
  // The container is the sandbox for orchestrated roles too (Issue #4356):
  // the CLI's own sandbox needs bubblewrap and a fresh procfs mount, which
  // the agent container cannot give it, so a sandboxed role could run no
  // command at all. The worker keeps the manager and reviewer read-only
  // instead (`orchestration/read_only_guard.ts`).
  args.push(...STANDARD_FLAGS);
  if (invocation.orchestrationRole) {
    args.push("-c", 'approval_policy="never"', "-c", "features.multi_agent=false");
  }
  if (invocation.model && invocation.model !== CODEX_CLI_DEFAULT_MODEL) {
    args.push("--model", invocation.model);
  }
  if (invocation.effort) {
    args.push("-c", `${REASONING_EFFORT_KEY}="${invocation.effort}"`);
  }
  if (invocation.settingsJson) {
    args.push(...codexHookArgs(invocation.settingsJson));
  }
  if (invocation.mcpConfigOverrides) {
    args.push(...invocation.mcpConfigOverrides);
  }
  args.push(invocation.promptViaStdin ? "-" : composeCodexPrompt(invocation));
  return args;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb2RleF9leGVjdXRvci50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENvZGV4IENMSSBpbnZvY2F0aW9uIGNvbnN0cnVjdGlvbiAoSXNzdWUgIzQxMDYsIHBhcmVudCAjNDEwMikuXG4gKlxuICogRXZlcnl0aGluZyB0aGlzIHdvcmtlciBrbm93cyBhYm91dCB0aGUgQ29kZXggY29tbWFuZCBsaW5lIGxpdmVzIGhlcmUsIHRoZVxuICogd2F5IGBjbGF1ZGVfZXhlY3V0b3IudHNgIG93bnMgQ2xhdWRlJ3Mg4oCUIHRoZSBwcm92aWRlciBkZXNjcmlwdG9yIGluXG4gKiBgYWdlbnRfcHJvdmlkZXIudHNgIGRlc2NyaWJlcyBDb2RleCwgaXQgZG9lcyBub3QgcmVzdGF0ZSB0aGUgQ0xJLlxuICpcbiAqIFRoZSBzaGFwZSBpcyBgY29kZXggZXhlYyBbT1BUSU9OU10gPFBST01QVD5gOiBvbmUgbm9uLWludGVyYWN0aXZlIHJ1biBvZiBvbmVcbiAqIHByb21wdCwgZW1pdHRpbmcgSlNPTkwgZXZlbnRzIG9uIHN0ZG91dCBzbyB0aGUgd29ya2VyIGNhbiByZWFkIHRoZSBydW5cbiAqIG1hY2hpbmUtcmVhZGFibHkgcmF0aGVyIHRoYW4gc2NyYXBpbmcgYSBUVUkuXG4gKlxuICogVHdvIENvZGV4IGZhY3RzIGRyaXZlIHRoZSB0cmFuc2xhdGlvbiBmcm9tIHtAbGluayBBZ2VudEludm9jYXRpb25SZXF1ZXN0fTpcbiAqXG4gKiAtICoqVGhlcmUgaXMgbm8gYC0tc3lzdGVtLXByb21wdGAuKiogRHJvcHBpbmcgdGhlIHN0YXRpYyBzeXN0ZW0gcHJvbXB0IHdvdWxkXG4gKiAgIHNpbGVudGx5IGRlbnkgQ29kZXggdGhlIGd1aWRhbmNlIGV2ZXJ5IGFnZW50IGlzIHJlcXVpcmVkIHRvIHJ1biB1bmRlciDigJRcbiAqICAgaW5jbHVkaW5nIHRoZSBzYW5kYm94ZWQtZW52aXJvbm1lbnQgZ3VpZGFuY2Ugb2YgSXNzdWUgIzQwNzAsIHdoaWNoIHJlYWNoZXNcbiAqICAgdGhlIGFnZW50IHRocm91Z2ggdGhhdCBwcm9tcHQuIEl0IGlzIHRoZXJlZm9yZSBjb21wb3NlZCBpbnRvIHRoZSBzaW5nbGVcbiAqICAgcHJvbXB0IENvZGV4IHRha2VzLCBub3QgZGlzY2FyZGVkLlxuICogLSAqKlRoZXJlIGlzIG5vIHBlci10b29sIGRpc2FibGUgZmxhZy4qKiBBIGRpc2FsbG93ZWQtdG9vbHMgbGlzdCBpcyBsaWtld2lzZVxuICogICBjYXJyaWVkIGludG8gdGhlIHByb21wdCByYXRoZXIgdGhhbiBkcm9wcGVkIG9uIHRoZSBmbG9vci5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB7IHR5cGUgQWdlbnRQcm9tcHRQYXJ0cywgY29tcG9zZUFnZW50UHJvbXB0IH0gZnJvbSBcIi4vYWdlbnRfcHJvbXB0LnRzXCI7XG5pbXBvcnQge1xuICBDT0RFWF9QSEFTRV9FRkZPUlRfREVGQVVMVFMsXG4gIENPREVYX1BIQVNFX01PREVMX0RFRkFVTFRTLFxufSBmcm9tIFwiLi9jb25maWdfZGVmYXVsdHMudHNcIjtcbmltcG9ydCB7IENPREVYX0hPTUVfRU5WX1ZBUiB9IGZyb20gXCIuL2NvZGV4X2F1dGgudHNcIjtcbmltcG9ydCB7IHJlc29sdmVDb2RleEF1dGhNb2RlIH0gZnJvbSBcIi4vY29kZXhfYXV0aF9tb2RlLnRzXCI7XG5pbXBvcnQgeyB0eXBlIEVudkxvb2t1cCwgcHJvY2Vzc0Vudkxvb2t1cCB9IGZyb20gXCIuL2Vudl9sb29rdXAudHNcIjtcbmltcG9ydCB7IHJlc29sdmVQaGFzZVJvdXRlZFZhbHVlIH0gZnJvbSBcIi4vcGhhc2Vfcm91dGluZy50c1wiO1xuaW1wb3J0IHR5cGUgeyBSZXBvQ29uZmlnIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbi8qKiBUaGUgQ29kZXggc3ViY29tbWFuZCBmb3IgYSBub24taW50ZXJhY3RpdmUgcnVuLiAqL1xuY29uc3QgRVhFQ19TVUJDT01NQU5EID0gXCJleGVjXCI7XG5cbi8qKiBSZXN1bWUgYSBuYW1lZCB0aHJlYWQgKGBjb2RleCBleGVjIHJlc3VtZSA8U0VTU0lPTl9JRD5gKS4gKi9cbmNvbnN0IFJFU1VNRV9TVUJDT01NQU5EID0gXCJyZXN1bWVcIjtcblxuLyoqXG4gKiBGbGFncyBldmVyeSB3b3JrZXItZHJpdmVuIENvZGV4IHJ1biBjYXJyaWVzLlxuICpcbiAqIC0gYC0tanNvbmAgcHJpbnRzIGV2ZW50cyBhcyBKU09OTCwgdGhlIG1hY2hpbmUtcmVhZGFibGUgb3V0cHV0IHRoZSB3b3JrZXJcbiAqICAgcGFyc2VzIChDbGF1ZGUncyBgLS1vdXRwdXQtZm9ybWF0IHN0cmVhbS1qc29uYCBlcXVpdmFsZW50KS5cbiAqIC0gYC0tc2tpcC1naXQtcmVwby1jaGVja2Ag4oCUIHRoZSB3b3JrZXIgY2hvb3NlcyB0aGUgd29ya2luZyB0cmVlIGl0c2VsZiBhbmQgYVxuICogICBwaGFzZSBtYXkgbGVnaXRpbWF0ZWx5IHJ1biBvdXRzaWRlIGEgcmVwb3NpdG9yeS5cbiAqIC0gYC0tZGFuZ2Vyb3VzbHktYnlwYXNzLWFwcHJvdmFscy1hbmQtc2FuZGJveGAg4oCUIHRoZSBjb250YWluZXIgKmlzKiB0aGVcbiAqICAgc2FuZGJveCAoSXNzdWUgIzQwNjApIGFuZCBubyBvcGVyYXRvciBpcyBwcmVzZW50IHRvIGFwcHJvdmUgYW55dGhpbmcsIHNvXG4gKiAgIENvZGV4J3Mgb3duIGFwcHJvdmFsIHByb21wdHMgd291bGQgZGVhZGxvY2sgYW4gdW5hdHRlbmRlZCBydW4uIFRoaXMgaXMgdGhlXG4gKiAgIGRvY3VtZW50ZWQgZmxhZyBmb3IgXCJydW5uaW5nIGluIGFuIGVudmlyb25tZW50IHRoYXQgaXMgZXh0ZXJuYWxseVxuICogICBzYW5kYm94ZWRcIiwgYW5kIGl0IG1pcnJvcnMgQ2xhdWRlJ3MgYC0tZGFuZ2Vyb3VzbHktc2tpcC1wZXJtaXNzaW9uc2AuXG4gKi9cbmNvbnN0IFNUQU5EQVJEX0ZMQUdTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgXCItLWpzb25cIixcbiAgXCItLXNraXAtZ2l0LXJlcG8tY2hlY2tcIixcbiAgXCItLWRhbmdlcm91c2x5LWJ5cGFzcy1hcHByb3ZhbHMtYW5kLXNhbmRib3hcIixcbl07XG5cbi8qKiBDb2RleCBjb25maWcga2V5IGNhcnJ5aW5nIHRoZSByZWFzb25pbmcgZWZmb3J0LCBzZXQgdmlhIGAtYyBrZXk9dmFsdWVgLiAqL1xuY29uc3QgUkVBU09OSU5HX0VGRk9SVF9LRVkgPSBcIm1vZGVsX3JlYXNvbmluZ19lZmZvcnRcIjtcblxuLyoqIE9uZSBDb2RleCBwcm9tcHQ6IHRoZSBzdGF0aWMgZ3VpZGFuY2UgcGx1cyB0aGUgcGVyLXJ1biBpbnN0cnVjdGlvbnMuICovXG5leHBvcnQgdHlwZSBDb2RleFByb21wdFBhcnRzID0gQWdlbnRQcm9tcHRQYXJ0cztcblxuLyoqXG4gKiBDb21wb3NlIHRoZSBzaW5nbGUgcHJvbXB0IHN0cmluZyBgY29kZXggZXhlY2AgdGFrZXMuXG4gKlxuICogQ29kZXggaGFzIG5vIHNlcGFyYXRlIHN5c3RlbS1wcm9tcHQgb3IgZGlzYWxsb3dlZC10b29scyBjaGFubmVsLCBzbyBib3RoIGFyZVxuICogZm9sZGVkIGludG8gdGhlIHByb21wdCBieSB0aGUgc2hhcmVkIGNvbXBvc2VyIChJc3N1ZSAjNDEwNyksIHdoaWNoIGV2ZXJ5XG4gKiBwcm92aWRlciBpbiB0aGF0IHBvc2l0aW9uIHVzZXMuXG4gKlxuICogQHBhcmFtIHBhcnRzIC0gVGhlIHByb21wdCwgdGhlIG9wdGlvbmFsIHN5c3RlbSBwcm9tcHQgYW5kIGRpc2FsbG93ZWQgdG9vbHMuXG4gKiBAcmV0dXJucyBUaGUgY29tcG9zZWQgcHJvbXB0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gY29tcG9zZUNvZGV4UHJvbXB0KHBhcnRzOiBDb2RleFByb21wdFBhcnRzKTogc3RyaW5nIHtcbiAgcmV0dXJuIGNvbXBvc2VBZ2VudFByb21wdChwYXJ0cyk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUGVyLXBoYXNlIG1vZGVsIGFuZCByZWFzb25pbmctZWZmb3J0IHJvdXRpbmcgKElzc3VlICMzNjMsIHBhcmVudCAjMzU3KVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBHbG9iYWwgYC5jb25maWcuanNvbmAgYGNvZGV4X3BoYXNlX21vZGVsX292ZXJyaWRlc2AgKElzc3VlICMzNjMpLiAqL1xubGV0IF9jb2RleFBoYXNlTW9kZWxDb25maWdPdmVycmlkZXM6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+ID0ge307XG5cbi8qKiBHbG9iYWwgYC5jb25maWcuanNvbmAgYGNvZGV4X3BoYXNlX2VmZm9ydF9vdmVycmlkZXNgIChJc3N1ZSAjMzYzKS4gKi9cbmxldCBfY29kZXhQaGFzZUVmZm9ydENvbmZpZ092ZXJyaWRlczogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4gPSB7fTtcblxuLyoqIFRoZSBhY3RpdmUgcmVwbydzIENvZGV4IHJvdXRpbmcgb3ZlcnJpZGVzIChJc3N1ZSAjMzYzKS4gKi9cbmxldCBfcmVwb0NvZGV4TW9kZWwgPSBcIlwiO1xubGV0IF9yZXBvQ29kZXhQaGFzZU1vZGVsT3ZlcnJpZGVzOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiA9IHt9O1xubGV0IF9yZXBvQ29kZXhQaGFzZUVmZm9ydE92ZXJyaWRlczogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4gPSB7fTtcblxuLyoqXG4gKiBSZWNvcmQgdGhlIGdsb2JhbCBwZXItcGhhc2UgQ29kZXggbW9kZWwgb3ZlcnJpZGVzIChJc3N1ZSAjMzYzKS5cbiAqXG4gKiBDYWxsZWQgZHVyaW5nIGNvbmZpZyBsb2FkaW5nIHdpdGggdGhlIGBjb2RleF9waGFzZV9tb2RlbF9vdmVycmlkZXNgIGtleS5cbiAqIFRoZXNlIG92ZXJyaWRlIHtAbGluayBDT0RFWF9QSEFTRV9NT0RFTF9ERUZBVUxUU30gYW5kIGFyZSB0aGVtc2VsdmVzXG4gKiBvdmVycmlkZGVuIGJ5IHRoZSBwZXItcmVwbyBvdmVycmlkZXMgYW5kIHRoZSBgQ09ERVhfTU9ERUxfPFBIQVNFPmAgZW52IHZhci5cbiAqXG4gKiBAcGFyYW0gb3ZlcnJpZGVzIC0gUGhhc2UtdG8tbW9kZWwgbWFwcGluZyBmcm9tIGAuY29uZmlnLmpzb25gLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0Q29kZXhQaGFzZU1vZGVsQ29uZmlnT3ZlcnJpZGVzKFxuICBvdmVycmlkZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXG4pOiB2b2lkIHtcbiAgX2NvZGV4UGhhc2VNb2RlbENvbmZpZ092ZXJyaWRlcyA9IHsgLi4ub3ZlcnJpZGVzIH07XG59XG5cbi8qKlxuICogUmVjb3JkIHRoZSBnbG9iYWwgcGVyLXBoYXNlIENvZGV4IGVmZm9ydCBvdmVycmlkZXMgKElzc3VlICMzNjMpLlxuICpcbiAqIEBwYXJhbSBvdmVycmlkZXMgLSBQaGFzZS10by1lZmZvcnQgbWFwcGluZyBmcm9tIGAuY29uZmlnLmpzb25gLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0Q29kZXhQaGFzZUVmZm9ydENvbmZpZ092ZXJyaWRlcyhcbiAgb3ZlcnJpZGVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxuKTogdm9pZCB7XG4gIF9jb2RleFBoYXNlRWZmb3J0Q29uZmlnT3ZlcnJpZGVzID0geyAuLi5vdmVycmlkZXMgfTtcbn1cblxuLyoqXG4gKiBTZXQgdGhlIGFjdGl2ZSByZXBvJ3MgQ29kZXggbW9kZWwvZWZmb3J0IHJvdXRpbmcgb3ZlcnJpZGVzIChJc3N1ZSAjMzYzKS5cbiAqXG4gKiBNaXJyb3JzIGBzZXRBY3RpdmVSZXBvTW9kZWxFZmZvcnRPdmVycmlkZXNgIGluIGBjbGF1ZGVfZXhlY3V0b3IudHNgOiBjYWxsIGl0XG4gKiBvbmNlIHdoZW4gdGhlIHdvcmtlciBzdGFydHMgd29yayBvbiBhIHJlcG8sIHBhc3NpbmcgdGhhdCByZXBvJ3MgbWVyZ2VkXG4gKiBSZXBvQ29uZmlnIChvciBgdW5kZWZpbmVkYCB0byBjbGVhcikuIEl0ICoqcmVwbGFjZXMqKiDigJQgbmV2ZXIgbWVyZ2VzIOKAlCB0aGVcbiAqIHByZXZpb3VzbHktYWN0aXZlIG92ZXJyaWRlcywgc28gYSBoaWdoLXZhbHVlIHJlcG8ncyBwcmVtaXVtIHJvdXRpbmcgY2FuIG5ldmVyXG4gKiBsZWFrIGludG8gYSBmaWxsZXIgcmVwbyB3aGVuIG9uZSB3b3JrZXIgcHJvY2VzcyBzZXJ2ZXMgc2V2ZXJhbCByZXBvcy5cbiAqXG4gKiBAcGFyYW0gcmVwb0NvbmZpZyAtIFRoZSBhY3RpdmUgcmVwbydzIFJlcG9Db25maWcsIG9yIHVuZGVmaW5lZCB0byBjbGVhci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldEFjdGl2ZVJlcG9Db2RleE1vZGVsRWZmb3J0T3ZlcnJpZGVzKFxuICByZXBvQ29uZmlnOiBSZXBvQ29uZmlnIHwgdW5kZWZpbmVkLFxuKTogdm9pZCB7XG4gIF9yZXBvQ29kZXhNb2RlbCA9IHJlcG9Db25maWc/LmNvZGV4TW9kZWwgPz8gXCJcIjtcbiAgX3JlcG9Db2RleFBoYXNlTW9kZWxPdmVycmlkZXMgPSB7XG4gICAgLi4uKHJlcG9Db25maWc/LmNvZGV4UGhhc2VNb2RlbE92ZXJyaWRlcyA/PyB7fSksXG4gIH07XG4gIF9yZXBvQ29kZXhQaGFzZUVmZm9ydE92ZXJyaWRlcyA9IHtcbiAgICAuLi4ocmVwb0NvbmZpZz8uY29kZXhQaGFzZUVmZm9ydE92ZXJyaWRlcyA/PyB7fSksXG4gIH07XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgbW9kZWwgQ29kZXggcnVucyBhIHBoYXNlIG9uIOKAlCB0aGUgdmFsdWUgYmVoaW5kIGAtLW1vZGVsYC5cbiAqXG4gKiBUaGUgc2l4LXN0ZXAgY2hhaW4gaXRzZWxmIGxpdmVzIGluIGBwaGFzZV9yb3V0aW5nLnRzYDsgdGhpcyBzdXBwbGllcyBDb2RleCdzXG4gKiBuYW1lcywgdGFibGVzIGFuZCBvdmVycmlkZSBzdGF0ZSwgc28gdGhlIHByZWNlZGVuY2UgaXMgQ2xhdWRlJ3MgcHJlY2VkZW5jZVxuICogd2l0aCBDb2RleC1uYW1lZCBrZXlzIChJc3N1ZSAjMzYzKTpcbiAqICAgMS4gYENPREVYX01PREVMXzxQSEFTRT5gIGVudiB2YXIg4oCUIG9wZXJhdG9yIGVzY2FwZSBoYXRjaFxuICogICAyLiBQZXItcmVwbyBgY29kZXhfcGhhc2VfbW9kZWxfb3ZlcnJpZGVzYFxuICogICAzLiBQZXItcmVwbyBgY29kZXhfbW9kZWxgIGJhc2UgdGllciDigJQgYXBwbGllcyB0byBhbGwgcGhhc2VzXG4gKiAgIDQuIEdsb2JhbCBjb25maWcgYGNvZGV4X3BoYXNlX21vZGVsX292ZXJyaWRlc2BcbiAqICAgNS4ge0BsaW5rIENPREVYX1BIQVNFX01PREVMX0RFRkFVTFRTfSDigJQgZGVzaWduZWQgY29zdCBvcHRpbWlzYXRpb247IGEgZGVmYXVsdFxuICogICAgICB0aGlzIENoYXRHUFQgbG9naW4gcmVmdXNlZCAoSXNzdWUgIzQyMjEpIHJlc29sdmVzIHRvIG5vIGAtLW1vZGVsYFxuICogICA2LiBCYXNlIGBDT0RFWF9NT0RFTGAgZW52IHZhciDigJQgZ2xvYmFsIGZhbGxiYWNrXG4gKlxuICogQHBhcmFtIHBoYXNlIC0gT3B0aW9uYWwgcGhhc2UgbmFtZSAoZS5nLiBgXCJwbGFubmluZ1wiYCkuXG4gKiBAcGFyYW0gZW52IC0gRW52aXJvbm1lbnQgbG9va3VwIGZvciBzdGVwcyAxIGFuZCA2IChJc3N1ZSAjOTU3KTsgZGVmYXVsdHMgdG9cbiAqICAgdGhlIHByb2Nlc3MgZW52aXJvbm1lbnQuXG4gKiBAcmV0dXJucyBUaGUgcmVzb2x2ZWQgbW9kZWwsIG9yIGB1bmRlZmluZWRgIHdoZW4gbm8gc3RlcCBzdXBwbGllcyBvbmUg4oCUIHRoZVxuICogICBDTEkncyBjb25maWd1cmVkIGRlZmF1bHQgdGhlbiBzdGFuZHMsIGFuZCBhIG5vbi1lbXB0eSBwaGFzZSB3YXJucy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVDb2RleE1vZGVsKFxuICBwaGFzZT86IHN0cmluZyxcbiAgZW52PzogRW52TG9va3VwLFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgbW9kZWwgPSByZXNvbHZlUGhhc2VSb3V0ZWRWYWx1ZSh7XG4gICAgbG9nUHJlZml4OiBcImNvZGV4LWV4ZWN1dG9yXCIsXG4gICAgd2hhdDogXCJtb2RlbFwiLFxuICAgIGZsYWc6IFwiLS1tb2RlbFwiLFxuICAgIGVudlZhcjogXCJDT0RFWF9NT0RFTFwiLFxuICAgIGVudixcbiAgICByZXBvUGhhc2VPdmVycmlkZXM6IF9yZXBvQ29kZXhQaGFzZU1vZGVsT3ZlcnJpZGVzLFxuICAgIHJlcG9QaGFzZU92ZXJyaWRlc0tleTogXCJjb2RleF9waGFzZV9tb2RlbF9vdmVycmlkZXNcIixcbiAgICByZXBvQmFzZTogX3JlcG9Db2RleE1vZGVsLFxuICAgIHJlcG9CYXNlS2V5OiBcImNvZGV4X21vZGVsXCIsXG4gICAgZ2xvYmFsUGhhc2VPdmVycmlkZXM6IF9jb2RleFBoYXNlTW9kZWxDb25maWdPdmVycmlkZXMsXG4gICAgZ2xvYmFsUGhhc2VPdmVycmlkZXNLZXk6IFwiY29kZXhfcGhhc2VfbW9kZWxfb3ZlcnJpZGVzXCIsXG4gICAgcGhhc2VEZWZhdWx0czogQ09ERVhfUEhBU0VfTU9ERUxfREVGQVVMVFMsXG4gICAgcGhhc2VEZWZhdWx0c05hbWU6IFwiQ09ERVhfUEhBU0VfTU9ERUxfREVGQVVMVFNcIixcbiAgfSwgcGhhc2UpO1xuXG4gIC8vIChJc3N1ZSAjNDIyMSkgQSBidWlsdC1pbiBkZWZhdWx0IHRoaXMgQ2hhdEdQVCBsb2dpbiByZWZ1c2VkOiB3aGVuIHRoZSB2YWx1ZVxuICAvLyBjYW1lIGZyb20gdGhlIGRlc2lnbmVkIGRlZmF1bHQsIHRoZSBDTEkncyBvd24gbW9kZWwgc3RhbmRzIGZvciB0aGUgcnVuLlxuICAvLyBBbiBleHBsaWNpdCBwaW4gYWx3YXlzIHdpbnMuXG4gIGlmIChcbiAgICBtb2RlbCAmJiBfcmVmdXNlZENvZGV4TW9kZWxzLnNpemUgPiAwICYmXG4gICAgaXNDb2RleENoYXRncHRMb2dpbihlbnYpICYmXG4gICAgX3JlZnVzZWRDb2RleE1vZGVscy5oYXMobW9kZWwudHJpbSgpLnRvTG93ZXJDYXNlKCkpICYmXG4gICAgY29kZXhCdWlsdEluRGVmYXVsdE1vZGVsKHBoYXNlLCBlbnYpID09PSBtb2RlbFxuICApIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIHJldHVybiBtb2RlbDtcbn1cblxuLyoqXG4gKiBTZW50aW5lbCBtZWFuaW5nIFwic2VuZCBubyBgLS1tb2RlbGBcIiwgc28gdGhlIENvZGV4IENMSSBwaWNrcyBpdHMgb3duIChJc3N1ZSAjNDIyMSkuXG4gKi9cbmV4cG9ydCBjb25zdCBDT0RFWF9DTElfREVGQVVMVF9NT0RFTCA9IFwiY29kZXgtY2xpLWRlZmF1bHRcIjtcblxuLyoqIEJ1aWx0LWluIGRlZmF1bHQgbW9kZWxzIHRoaXMgQ2hhdEdQVCBsb2dpbiByZWZ1c2VkLCBsb3dlci1jYXNlZCwgZm9yIHRoaXMgcnVuIChJc3N1ZSAjNDIyMSkuICovXG5jb25zdCBfcmVmdXNlZENvZGV4TW9kZWxzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbi8qKiBSZWZ1c2VkIG1vZGVsIGlkcyBhbHJlYWR5IHJlcG9ydGVkLCBzbyBlYWNoIHdhcm5zIG9uY2UgcGVyIHByb2Nlc3MgKElzc3VlICM0MjIxKS4gKi9cbmNvbnN0IF9yZWZ1c2VkQ29kZXhNb2RlbHNXYXJuZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuLyoqXG4gKiBXaGV0aGVyIENvZGV4IGF1dGhlbnRpY2F0ZXMgd2l0aCBhIHBlcnNpc3RlZCBDaGF0R1BUIGxvZ2luIChJc3N1ZSAjNDIyMSkuXG4gKlxuICogTWlycm9ycyB0aGUgZGVzY3JpcHRvcidzIGByZXNvbHZlU3RvcmVkQmlsbGluZ2A6IG9ubHkgYW4gZXhwbGljaXRcbiAqIGBDT0RFWF9IT01FYCBpcyByZWFkLCBhbmQgbm8gZW52aXJvbm1lbnQgdmFyaWFibGUgaXMgY29uc3VsdGVkLiBUaGF0IGhvb2sgaXNcbiAqIHRoZSB0d2luIG9mIHRoaXMgY2hlY2sgYW5kIG11c3QgYWdyZWUgd2l0aCBpdCAoYSBgY29kZXgtY2hhdGdwdC1sb2dpbmBcbiAqIHJlYXNvbiBpcyBleGFjdGx5IHRoZSB0cnVlIGFuc3dlciBoZXJlKS5cbiAqXG4gKiBAcGFyYW0gZW52IC0gRW52aXJvbm1lbnQgbG9va3VwOyBkZWZhdWx0cyB0byB0aGUgcHJvY2VzcyBlbnZpcm9ubWVudC5cbiAqIEByZXR1cm5zIFRydWUgb25seSB3aGVuIHRoZSBleHBsaWNpdCBgQ09ERVhfSE9NRWAgaG9sZHMgYSBDaGF0R1BUIGxvZ2luLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNDb2RleENoYXRncHRMb2dpbihcbiAgZW52OiBFbnZMb29rdXAgPSBwcm9jZXNzRW52TG9va3VwLFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGhvbWUgPSAoZW52KENPREVYX0hPTUVfRU5WX1ZBUikgPz8gXCJcIikudHJpbSgpO1xuICBpZiAoIWhvbWUpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHJlc29sdmVDb2RleEF1dGhNb2RlKGhvbWUsICgpID0+IHVuZGVmaW5lZCkubW9kZSA9PT0gXCJjaGF0Z3B0XCI7XG59XG5cbi8qKlxuICogRm9yZ2V0IGV2ZXJ5IHJlZnVzZWQgbW9kZWwgYW5kIHdhcm5pbmcsIGZvciBhIGZyZXNoIHJ1biAoSXNzdWUgIzQyMjEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJSZWZ1c2VkQ29kZXhNb2RlbHMoKTogdm9pZCB7XG4gIF9yZWZ1c2VkQ29kZXhNb2RlbHMuY2xlYXIoKTtcbiAgX3JlZnVzZWRDb2RleE1vZGVsc1dhcm5lZC5jbGVhcigpO1xufVxuXG4vKipcbiAqIFRoZSBidWlsdC1pbiBkZWZhdWx0IG1vZGVsIGEgcGhhc2UgcmVzb2x2ZXMgdG8sIHdoZW4gbm8gcGluIHN1cHBsaWVzIG9uZSAoSXNzdWUgIzQyMjEpLlxuICpcbiAqIFJldHVybnMgdGhlIHtAbGluayBDT0RFWF9QSEFTRV9NT0RFTF9ERUZBVUxUU30gdmFsdWUgb25seSB3aGVuIHN0ZXBzIDHigJM0IG9mXG4gKiB7QGxpbmsgcmVzb2x2ZUNvZGV4TW9kZWx9IGFyZSBhbGwgYWJzZW50IGZvciB0aGUgcGhhc2UuXG4gKlxuICogQHBhcmFtIHBoYXNlIC0gT3B0aW9uYWwgcGhhc2UgbmFtZSAoZS5nLiBgXCJoZWFsdGhcImApLlxuICogQHBhcmFtIGVudiAtIEVudmlyb25tZW50IGxvb2t1cCBmb3IgdGhlIGBDT0RFWF9NT0RFTF88UEhBU0U+YCBwaW4uXG4gKiBAcmV0dXJucyBUaGUgZGVzaWduZWQgZGVmYXVsdCBmb3IgdGhlIHBoYXNlLCBvciBgdW5kZWZpbmVkYCB3aGVuIHBpbm5lZCBvciB1bmtub3duLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY29kZXhCdWlsdEluRGVmYXVsdE1vZGVsKFxuICBwaGFzZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBlbnY/OiBFbnZMb29rdXAsXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAoIXBoYXNlKSByZXR1cm4gdW5kZWZpbmVkO1xuICBpZiAoKGVudiA/PyBwcm9jZXNzRW52TG9va3VwKShgQ09ERVhfTU9ERUxfJHtwaGFzZS50b1VwcGVyQ2FzZSgpfWApKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBpZiAoX3JlcG9Db2RleFBoYXNlTW9kZWxPdmVycmlkZXNbcGhhc2VdKSByZXR1cm4gdW5kZWZpbmVkO1xuICBpZiAoX3JlcG9Db2RleE1vZGVsKSByZXR1cm4gdW5kZWZpbmVkO1xuICBpZiAoX2NvZGV4UGhhc2VNb2RlbENvbmZpZ092ZXJyaWRlc1twaGFzZV0pIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiBDT0RFWF9QSEFTRV9NT0RFTF9ERUZBVUxUU1twaGFzZV07XG59XG5cbi8qKlxuICogUmVjb3JkIGEgYnVpbHQtaW4gZGVmYXVsdCBtb2RlbCB0aGlzIENoYXRHUFQgbG9naW4gcmVmdXNlZCwgZm9yIHRoaXMgcnVuIChJc3N1ZSAjNDIyMSkuXG4gKlxuICogV2FybnMgb25jZSBwZXIgcmVmdXNlZCBpZDsgdGhlIHdhcm5pbmcgbmFtZXMgdGhlIHJlLXBpbiBrbm9icy5cbiAqXG4gKiBAcGFyYW0gbW9kZWwgLSBUaGUgcmVmdXNlZCBtb2RlbCBpZC5cbiAqIEBwYXJhbSBwaGFzZSAtIFRoZSBwaGFzZSB0aGUgcmVmdXNlZCBkZWZhdWx0IHdhcyByb3V0ZWQgZm9yLCBpZiBrbm93bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hcmtDb2RleE1vZGVsUmVmdXNlZChtb2RlbDogc3RyaW5nLCBwaGFzZT86IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBpZCA9IG1vZGVsLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICBfcmVmdXNlZENvZGV4TW9kZWxzLmFkZChpZCk7XG4gIGlmIChfcmVmdXNlZENvZGV4TW9kZWxzV2FybmVkLmhhcyhpZCkpIHJldHVybjtcbiAgX3JlZnVzZWRDb2RleE1vZGVsc1dhcm5lZC5hZGQoaWQpO1xuICBjb25zb2xlLndhcm4oXG4gICAgYFtjb2RleF0gTW9kZWwgJHtKU09OLnN0cmluZ2lmeShtb2RlbCl9IChidWlsdC1pbiBkZWZhdWx0IGZvciBwaGFzZSBcIiR7XG4gICAgICBwaGFzZSA/PyBcInVua25vd25cIlxuICAgIH1cIikgd2FzIHJlZnVzZWQgYnkgdGhpcyBDaGF0R1BUIGxvZ2luIOKAlCBvbWl0dGluZyAtLW1vZGVsIHNvIHRoZSBDb2RleCBDTEkgYCArXG4gICAgICBgcGlja3MgaXRzIG93biBtb2RlbCBmb3IgdGhlIHJlc3Qgb2YgdGhpcyBydW4gKElzc3VlICM0MjIxKS4gUmUtcGluIGl0IGAgK1xuICAgICAgYHdpdGggY29kZXhfcGhhc2VfbW9kZWxfb3ZlcnJpZGVzIG9yIHByb3ZpZGVyX21vZGVsX3RpZXJzLmNvZGV4LmAsXG4gICk7XG59XG5cbi8qKlxuICogVGhlIHNhbWUtcHJvdmlkZXIgYWx0ZXJuYXRpdmVzIHRvIGEgcmVmdXNlZCBtb2RlbDogdGhlIENMSSBkZWZhdWx0LCB3aGVuIGFcbiAqIENoYXRHUFQgbG9naW4gcmVmdXNlZCBhIHBoYXNlJ3MgYnVpbHQtaW4gZGVmYXVsdCAoSXNzdWUgIzQyMjEpLlxuICpcbiAqIEBwYXJhbSBtb2RlbCAtIFRoZSBtb2RlbCB0aGF0IHByb2JlZCB1bmF2YWlsYWJsZS5cbiAqIEBwYXJhbSBwaGFzZSAtIFRoZSBwaGFzZSB0aGUgbW9kZWwgd2FzIHJvdXRlZCBmb3IsIGlmIGtub3duLlxuICogQHBhcmFtIGVudiAtIEVudmlyb25tZW50IGxvb2t1cDsgZGVmYXVsdHMgdG8gdGhlIHByb2Nlc3MgZW52aXJvbm1lbnQuXG4gKiBAcmV0dXJucyBgW0NPREVYX0NMSV9ERUZBVUxUX01PREVMXWAgZm9yIGEgcmVmdXNlZCBidWlsdC1pbiBkZWZhdWx0LCBlbHNlIGBbXWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb2RleEFsdGVybmF0aXZlTW9kZWxzKFxuICBtb2RlbDogc3RyaW5nLFxuICBwaGFzZT86IHN0cmluZyxcbiAgZW52PzogRW52TG9va3VwLFxuKTogc3RyaW5nW10ge1xuICBjb25zdCBpZCA9IG1vZGVsLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICBpZiAoIWlzQ29kZXhDaGF0Z3B0TG9naW4oZW52KSkgcmV0dXJuIFtdO1xuICBjb25zdCBidWlsdEluID0gY29kZXhCdWlsdEluRGVmYXVsdE1vZGVsKHBoYXNlLCBlbnYpO1xuICBpZiAoYnVpbHRJbiA9PT0gdW5kZWZpbmVkIHx8IGJ1aWx0SW4udHJpbSgpLnRvTG93ZXJDYXNlKCkgIT09IGlkKSByZXR1cm4gW107XG4gIHJldHVybiBbQ09ERVhfQ0xJX0RFRkFVTFRfTU9ERUxdO1xufVxuXG4vKipcbiAqIEFwcGx5IGEgQ29kZXggbW9kZWwgYWRhcHRhdGlvbiBmb3IgdGhpcyBydW4gKElzc3VlICM0MjIxKTogdGhlIHJlZnVzZWQgbW9kZWxcbiAqIGlzIGRyb3BwZWQsIHNvIHRoZSBwaGFzZSBydW5zIG9uIHRoZSBDTEkncyBvd24gZGVmYXVsdC5cbiAqXG4gKiBAcGFyYW0gdW5hdmFpbGFibGUgLSBUaGUgbW9kZWwgdGhhdCBwcm9iZWQgdW5hdmFpbGFibGUuXG4gKiBAcGFyYW0gX2FsdGVybmF0aXZlIC0gVGhlIGFsdGVybmF0aXZlIChhbHdheXMgdGhlIENMSSBkZWZhdWx0KS5cbiAqIEBwYXJhbSBwaGFzZSAtIFRoZSBwaGFzZSB0aGUgbW9kZWwgd2FzIHJvdXRlZCBmb3IsIGlmIGtub3duLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlDb2RleE1vZGVsQWRhcHRhdGlvbihcbiAgdW5hdmFpbGFibGU6IHN0cmluZyxcbiAgX2FsdGVybmF0aXZlOiBzdHJpbmcsXG4gIHBoYXNlPzogc3RyaW5nLFxuKTogdm9pZCB7XG4gIG1hcmtDb2RleE1vZGVsUmVmdXNlZCh1bmF2YWlsYWJsZSwgcGhhc2UpO1xufVxuXG4vKipcbiAqIEluLXJ1biBjb3VudGVycGFydCBvZiB7QGxpbmsgY29kZXhBbHRlcm5hdGl2ZU1vZGVsc30gKElzc3VlICM0MjIxKTogYW5cbiAqIGludm9jYXRpb24gcmVmdXNlZCBgbW9kZWxgLCBzbyBtYXJrIGl0IGFuZCBsZXQgb25lIHJldHJ5IGRyb3AgYC0tbW9kZWxgLlxuICpcbiAqIEBwYXJhbSBtb2RlbCAtIFRoZSBtb2RlbCB0aGUgcmVmdXNlZCBpbnZvY2F0aW9uIHJhbiBvbi5cbiAqIEBwYXJhbSBwaGFzZSAtIFRoZSBwaGFzZSB0aGUgaW52b2NhdGlvbiByYW4gZm9yLCBpZiBrbm93bi5cbiAqIEBwYXJhbSBlbnYgLSBFbnZpcm9ubWVudCBsb29rdXA7IGRlZmF1bHRzIHRvIHRoZSBwcm9jZXNzIGVudmlyb25tZW50LlxuICogQHJldHVybnMgVHJ1ZSB3aGVuIHRoZSByZWZ1c2FsIHdhcyBhZGFwdGVkIGFuZCBhIHJldHJ5IHNob3VsZCBvbWl0IGAtLW1vZGVsYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFkYXB0Q29kZXhBZnRlck1vZGVsUmVmdXNhbChcbiAgbW9kZWw6IHN0cmluZyxcbiAgcGhhc2U6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgZW52PzogRW52TG9va3VwLFxuKTogYm9vbGVhbiB7XG4gIGlmIChjb2RleEFsdGVybmF0aXZlTW9kZWxzKG1vZGVsLCBwaGFzZSwgZW52KS5sZW5ndGggPT09IDApIHJldHVybiBmYWxzZTtcbiAgbWFya0NvZGV4TW9kZWxSZWZ1c2VkKG1vZGVsLCBwaGFzZSk7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIHJlYXNvbmluZyBlZmZvcnQgQ29kZXggcnVucyBhIHBoYXNlIGF0IOKAlCB0aGUgdmFsdWUgYmVoaW5kXG4gKiBgLWMgbW9kZWxfcmVhc29uaW5nX2VmZm9ydD1cIuKAplwiYC5cbiAqXG4gKiBTYW1lIGNoYWluIGFzIHtAbGluayByZXNvbHZlQ29kZXhNb2RlbH0gd2l0aCB0aGUgZWZmb3J0IGtleXM6XG4gKiBgQ09ERVhfRUZGT1JUXzxQSEFTRT5gIOKGkiBwZXItcmVwbyBgY29kZXhfcGhhc2VfZWZmb3J0X292ZXJyaWRlc2Ag4oaSIGdsb2JhbFxuICogYGNvZGV4X3BoYXNlX2VmZm9ydF9vdmVycmlkZXNgIOKGkiB7QGxpbmsgQ09ERVhfUEhBU0VfRUZGT1JUX0RFRkFVTFRTfSDihpJcbiAqIGBDT0RFWF9FRkZPUlRgLiBFZmZvcnQgaGFzIG5vIHBlci1yZXBvIGJhc2UgdGllciwgZXhhY3RseSBhcyBDbGF1ZGUncyBoYXNcbiAqIG5vbmUsIGFuZCBubyBoYXJkY29kZWQgdGVybWluYWwgZmFsbGJhY2s6IGFuIHVucm91dGFibGUgcGhhc2UgbGVhdmVzIENvZGV4IG9uXG4gKiBpdHMgb3duIGNvbmZpZ3VyZWQgZWZmb3J0IHJhdGhlciB0aGFuIGludmVudGluZyBvbmUuXG4gKlxuICogQHBhcmFtIHBoYXNlIC0gT3B0aW9uYWwgcGhhc2UgbmFtZSAoZS5nLiBgXCJwbGFubmluZ1wiYCkuXG4gKiBAcGFyYW0gZW52IC0gRW52aXJvbm1lbnQgbG9va3VwIGZvciBzdGVwcyAxIGFuZCA2IChJc3N1ZSAjOTU3KTsgZGVmYXVsdHMgdG9cbiAqICAgdGhlIHByb2Nlc3MgZW52aXJvbm1lbnQuXG4gKiBAcmV0dXJucyBUaGUgcmVzb2x2ZWQgZWZmb3J0LCBvciBgdW5kZWZpbmVkYCB3aGVuIG5vIHN0ZXAgc3VwcGxpZXMgb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUNvZGV4RWZmb3J0KFxuICBwaGFzZT86IHN0cmluZyxcbiAgZW52PzogRW52TG9va3VwLFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIHJlc29sdmVQaGFzZVJvdXRlZFZhbHVlKHtcbiAgICBsb2dQcmVmaXg6IFwiY29kZXgtZXhlY3V0b3JcIixcbiAgICB3aGF0OiBcImVmZm9ydFwiLFxuICAgIGZsYWc6IGAtYyAke1JFQVNPTklOR19FRkZPUlRfS0VZfWAsXG4gICAgZW52VmFyOiBcIkNPREVYX0VGRk9SVFwiLFxuICAgIGVudixcbiAgICByZXBvUGhhc2VPdmVycmlkZXM6IF9yZXBvQ29kZXhQaGFzZUVmZm9ydE92ZXJyaWRlcyxcbiAgICByZXBvUGhhc2VPdmVycmlkZXNLZXk6IFwiY29kZXhfcGhhc2VfZWZmb3J0X292ZXJyaWRlc1wiLFxuICAgIGdsb2JhbFBoYXNlT3ZlcnJpZGVzOiBfY29kZXhQaGFzZUVmZm9ydENvbmZpZ092ZXJyaWRlcyxcbiAgICBnbG9iYWxQaGFzZU92ZXJyaWRlc0tleTogXCJjb2RleF9waGFzZV9lZmZvcnRfb3ZlcnJpZGVzXCIsXG4gICAgcGhhc2VEZWZhdWx0czogQ09ERVhfUEhBU0VfRUZGT1JUX0RFRkFVTFRTLFxuICAgIHBoYXNlRGVmYXVsdHNOYW1lOiBcIkNPREVYX1BIQVNFX0VGRk9SVF9ERUZBVUxUU1wiLFxuICB9LCBwaGFzZSk7XG59XG5cbi8qKiBXaGF0IHtAbGluayBidWlsZENvZGV4QXJnc30gbmVlZHMgdG8gYnVpbGQgb25lIGludm9jYXRpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIENvZGV4SW52b2NhdGlvbiBleHRlbmRzIENvZGV4UHJvbXB0UGFydHMge1xuICAvKiogRXh0ZXJuYWwgcm9sZSBjYWxscyBvcHQgaW50byB0aGUgQ0xJIHNhbmRib3ggaW5zdGVhZCBvZiBieXBhc3NpbmcgaXQuICovXG4gIG9yY2hlc3RyYXRpb25Sb2xlPzogXCJtYW5hZ2VyXCIgfCBcImV4ZWN1dG9yXCIgfCBcInJldmlld2VyXCI7XG4gIC8qKiBFeHBsaWNpdCBtb2RlbCBpZDsgb21pdHRlZCBsZWF2ZXMgQ29kZXggb24gaXRzIGNvbmZpZ3VyZWQgZGVmYXVsdC4gKi9cbiAgbW9kZWw/OiBzdHJpbmc7XG4gIC8qKiBFeHBsaWNpdCByZWFzb25pbmcgZWZmb3J0OyBvbWl0dGVkIGxlYXZlcyBDb2RleCBvbiBpdHMgZGVmYXVsdC4gKi9cbiAgZWZmb3J0Pzogc3RyaW5nO1xuICAvKipcbiAgICogUmVzdW1lIHRoaXMgQ29kZXggdGhyZWFkIChJc3N1ZSAjMTY5OSkuIFRoZSBwaW5uZWQgQ0xJJ3MgZXhwbGljaXRcbiAgICogYGNvZGV4IGV4ZWMgcmVzdW1lIDxTRVNTSU9OX0lEPmAg4oCUIG5ldmVyIGAtLWxhc3RgLCB3aGljaCByZXN1bWVzXG4gICAqIHdoaWNoZXZlciBzZXNzaW9uIGxhc3Qgd3JvdGUgaW4gdGhpcyB3b3JraW5nIGRpcmVjdG9yeS5cbiAgICovXG4gIHJlc3VtZVNlc3Npb25JZD86IHN0cmluZztcbiAgLyoqXG4gICAqIFRoZSBwcm9tcHQgd2lsbCBiZSB3cml0dGVuIHRvIHRoZSBjaGlsZCdzIHN0ZGluIChJc3N1ZSAjMTcwMik6IGFyZ3ZcbiAgICogY2FycmllcyBgLWAgc28gdGhlIENMSSByZWFkcyBpdCB0aGVyZSwgYW5kIG5vIHByb21wdCB0ZXh0IHNpdHMgaW5cbiAgICogYXJndiAoTGludXggTUFYX0FSR19TVFJMRU4pLlxuICAgKi9cbiAgcHJvbXB0VmlhU3RkaW4/OiBib29sZWFuO1xuICAvKipcbiAgICogYC1jIG1jcF9zZXJ2ZXJzLipgIG92ZXJyaWRlcyBmcm9tIHRoZSBwZXItcnVuIFBsYXl3cmlnaHQgY29uZmlnXG4gICAqIChJc3N1ZSAjMTcwMikuIENvZGV4IGhhcyBubyBgLS1tY3AtY29uZmlnYCBmbGFnLlxuICAgKi9cbiAgbWNwQ29uZmlnT3ZlcnJpZGVzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBXb3JrZXItYXV0aG9yZWQgY29tbWFuZCBob29rIHNldHRpbmdzLCB0cmFuc2xhdGVkIHRvIHBlci1zcGF3biBUT01MLiAqL1xuICBzZXR0aW5nc0pzb24/OiBzdHJpbmc7XG59XG5cbi8qKiBBIFRPTUwgc3RyaW5nIHZhbHVlLCBxdW90ZWQuICovXG5mdW5jdGlvbiB0b21sU3RyaW5nKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xufVxuXG4vKiogQSBUT01MIGFycmF5IG9mIHN0cmluZ3MuICovXG5mdW5jdGlvbiB0b21sU3RyaW5nQXJyYXkodmFsdWVzOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIHJldHVybiBgWyR7dmFsdWVzLm1hcCh0b21sU3RyaW5nKS5qb2luKFwiLCBcIil9XWA7XG59XG5cbi8qKlxuICogQSBUT01MIGlubGluZSB0YWJsZSBvZiBzdHJpbmcgdmFsdWVzLiBOb24tc3RyaW5nIGVudHJpZXMgYXJlIGRyb3BwZWRcbiAqIHJhdGhlciB0aGFuIHN0cmluZ2lmaWVkIGludG8gYSBzaGFwZSB0aGUgQ0xJIHdvdWxkIHJlZnVzZS5cbiAqL1xuZnVuY3Rpb24gdG9tbElubGluZVRhYmxlKHJlY29yZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBzdHJpbmcge1xuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocmVjb3JkKSkge1xuICAgIGlmICghL15bQS1aYS16MC05Xy1dKyQvLnRlc3Qoa2V5KSkgY29udGludWU7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIikgY29udGludWU7XG4gICAgcGFydHMucHVzaChgJHtrZXl9ID0gJHt0b21sU3RyaW5nKHZhbHVlKX1gKTtcbiAgfVxuICByZXR1cm4gYHsgJHtwYXJ0cy5qb2luKFwiLCBcIil9IH1gO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBgLWMgbWNwX3NlcnZlcnMuPG5hbWU+LipgIG92ZXJyaWRlcyBDb2RleCB1bmRlcnN0YW5kc1xuICogKElzc3VlICMxNzAyKS5cbiAqXG4gKiBUaGUgc2hhcmVkIFBsYXl3cmlnaHQgY29uZmlnIGlzIENsYXVkZSdzIGAtLW1jcC1jb25maWdgIEpTT04uIENvZGV4XG4gKiByZWFkcyBNQ1Agc2VydmVycyBmcm9tIGBjb25maWcudG9tbGAga2V5cywgb3ZlcnJpZGRlbiBwZXIgaW52b2NhdGlvblxuICogd2l0aCBgLWNgLiBVbmtub3duIEpTT04geWllbGRzIG5vIGZsYWdzIOKAlCB0aGUgY2FsbGVyIGZhaWxzIGNsb3NlZCB3aGVuXG4gKiBhIHBhdGggd2FzIGdpdmVuIGFuZCBub3RoaW5nIGNvdWxkIGJlIGFwcGxpZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZENvZGV4TWNwQ29uZmlnQXJncyhjb25maWdKc29uOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZShjb25maWdKc29uKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG4gIGlmIChwYXJzZWQgPT09IG51bGwgfHwgdHlwZW9mIHBhcnNlZCAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KHBhcnNlZCkpIHtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgY29uc3Qgc2VydmVycyA9IChwYXJzZWQgYXMgeyBtY3BTZXJ2ZXJzPzogdW5rbm93biB9KS5tY3BTZXJ2ZXJzO1xuICBpZiAoXG4gICAgc2VydmVycyA9PT0gbnVsbCB8fCB0eXBlb2Ygc2VydmVycyAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KHNlcnZlcnMpXG4gICkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBjb25zdCBhcmdzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKFxuICAgIGNvbnN0IFtuYW1lLCBzcGVjXSBvZiBPYmplY3QuZW50cmllcyhzZXJ2ZXJzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVxuICApIHtcbiAgICBpZiAoIS9eW0EtWmEtejAtOV8tXSskLy50ZXN0KG5hbWUpKSBjb250aW51ZTtcbiAgICBpZiAoc3BlYyA9PT0gbnVsbCB8fCB0eXBlb2Ygc3BlYyAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KHNwZWMpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3Qgc2VydmVyID0gc3BlYyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBpZiAodHlwZW9mIHNlcnZlci5jb21tYW5kID09PSBcInN0cmluZ1wiKSB7XG4gICAgICBhcmdzLnB1c2goXG4gICAgICAgIFwiLWNcIixcbiAgICAgICAgYG1jcF9zZXJ2ZXJzLiR7bmFtZX0uY29tbWFuZD0ke3RvbWxTdHJpbmcoc2VydmVyLmNvbW1hbmQpfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoXG4gICAgICBBcnJheS5pc0FycmF5KHNlcnZlci5hcmdzKSAmJlxuICAgICAgc2VydmVyLmFyZ3MuZXZlcnkoKGEpID0+IHR5cGVvZiBhID09PSBcInN0cmluZ1wiKVxuICAgICkge1xuICAgICAgYXJncy5wdXNoKFxuICAgICAgICBcIi1jXCIsXG4gICAgICAgIGBtY3Bfc2VydmVycy4ke25hbWV9LmFyZ3M9JHt0b21sU3RyaW5nQXJyYXkoc2VydmVyLmFyZ3MpfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoXG4gICAgICBzZXJ2ZXIuZW52ICE9PSBudWxsICYmXG4gICAgICB0eXBlb2Ygc2VydmVyLmVudiA9PT0gXCJvYmplY3RcIiAmJlxuICAgICAgIUFycmF5LmlzQXJyYXkoc2VydmVyLmVudilcbiAgICApIHtcbiAgICAgIGFyZ3MucHVzaChcbiAgICAgICAgXCItY1wiLFxuICAgICAgICBgbWNwX3NlcnZlcnMuJHtuYW1lfS5lbnY9JHtcbiAgICAgICAgICB0b21sSW5saW5lVGFibGUoc2VydmVyLmVudiBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilcbiAgICAgICAgfWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICByZXR1cm4gYXJncztcbn1cblxuLyoqXG4gKiBUcmFuc2xhdGUgdGhlIHdvcmtlcidzIHN5bmNocm9ub3VzIGNvbW1hbmQgaG9va3MgdG8gQ29kZXggVE9NTCAoSXNzdWUgIzQxMjEpLlxuICogQ29kZXggcHJlc2VudHMgc2hlbGwgdG9vbHMgdG8gaG9va3MgYXMgQmFzaCB3aXRoIGEgc3RyaW5nIGNvbW1hbmQsIHNvIFJUSydzXG4gKiBleGlzdGluZyBwcm9jZXNzb3Igd29ya3MgdW5jaGFuZ2VkLiBObyB1c2VyIGNvbmZpZ3VyYXRpb24gZmlsZSBpcyB3cml0dGVuLlxuICovXG5mdW5jdGlvbiBjb2RleEhvb2tBcmdzKHNldHRpbmdzSnNvbjogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBzZXR0aW5ncyA9IEpTT04ucGFyc2Uoc2V0dGluZ3NKc29uKTtcbiAgY29uc3QgZ3JvdXBzOiB1bmtub3duID0gc2V0dGluZ3M/Lmhvb2tzPy5QcmVUb29sVXNlO1xuICBpZiAoIUFycmF5LmlzQXJyYXkoZ3JvdXBzKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkNvZGV4IGhvb2sgc2V0dGluZ3MgcmVxdWlyZSBhIFByZVRvb2xVc2UgYXJyYXlcIik7XG4gIH1cbiAgY29uc3QgZW50cmllcyA9IGdyb3Vwcy5tYXAoKGdyb3VwKSA9PiB7XG4gICAgaWYgKHR5cGVvZiBncm91cD8ubWF0Y2hlciAhPT0gXCJzdHJpbmdcIiB8fCAhQXJyYXkuaXNBcnJheShncm91cC5ob29rcykpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNvZGV4IFByZVRvb2xVc2UgcmVxdWlyZXMgYSBtYXRjaGVyIGFuZCBob29rcyBhcnJheVwiKTtcbiAgICB9XG4gICAgY29uc3QgaG9va3MgPSBncm91cC5ob29rcy5tYXAoXG4gICAgICAoaG9vazogeyB0eXBlPzogdW5rbm93bjsgY29tbWFuZD86IHVua25vd24gfSB8IG51bGwpID0+IHtcbiAgICAgICAgaWYgKGhvb2s/LnR5cGUgIT09IFwiY29tbWFuZFwiIHx8IHR5cGVvZiBob29rLmNvbW1hbmQgIT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBcIkNvZGV4IFByZVRvb2xVc2UgcmVxdWlyZXMgY29tbWFuZCBob29rcyB3aXRoIGEgc3RyaW5nIGNvbW1hbmRcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBge3R5cGU9XCJjb21tYW5kXCIsY29tbWFuZD0ke3RvbWxTdHJpbmcoaG9vay5jb21tYW5kKX19YDtcbiAgICAgIH0sXG4gICAgKTtcbiAgICByZXR1cm4gYHttYXRjaGVyPSR7dG9tbFN0cmluZyhncm91cC5tYXRjaGVyKX0saG9va3M9WyR7aG9va3Muam9pbihcIixcIil9XX1gO1xuICB9KTtcbiAgaWYgKGVudHJpZXMubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG4gIHJldHVybiBbXG4gICAgXCItLWRhbmdlcm91c2x5LWJ5cGFzcy1ob29rLXRydXN0XCIsXG4gICAgXCItY1wiLFxuICAgIFwiZmVhdHVyZXMuaG9va3M9dHJ1ZVwiLFxuICAgIFwiLWNcIixcbiAgICBgaG9va3MuUHJlVG9vbFVzZT1bJHtlbnRyaWVzLmpvaW4oXCIsXCIpfV1gLFxuICBdO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBDb2RleCBDTEkgYXJndW1lbnQgbGlzdCBmb3Igb25lIG5vbi1pbnRlcmFjdGl2ZSBydW4uXG4gKlxuICogU2Vzc2lvbiBjb250aW51aXR5IHVzZXMgYGNvZGV4IGV4ZWMgcmVzdW1lIDxTRVNTSU9OX0lEPmAgd2l0aCB0aGUgdGhyZWFkXG4gKiB0aGUgcHJldmlvdXMgcGhhc2Ugb2YgKnRoaXMqIGlzc3VlIHJlcG9ydGVkIChJc3N1ZSAjMTY5OSkuIGAtLWxhc3RgIGlzXG4gKiBub3QgdXNlZDogY29uY3VycmVudCBzbG90cyBzaGFyZSBhIHdvcmtpbmcgZGlyZWN0b3J5IGFuZCB3b3VsZCByZXN1bWVcbiAqIGVhY2ggb3RoZXIncyBzZXNzaW9ucy5cbiAqXG4gKiBgY29kZXggZXhlYyByZXN1bWVgIGRvZXMgbm90IGFjY2VwdCBgLS1zYW5kYm94YCAoSXNzdWUgIzQzMzMpLiBBIHJlc3VtZWRcbiAqIG9yY2hlc3RyYXRlZCBydW4gc2V0cyB0aGUgc2FtZSBtb2RlIHRocm91Z2ggYHNhbmRib3hfbW9kZWAgKGAtY2ApLiBBIGZyZXNoXG4gKiBgY29kZXggZXhlY2Agc3RpbGwgcGFzc2VzIGAtLXNhbmRib3hgLlxuICpcbiAqIEBwYXJhbSBpbnZvY2F0aW9uIC0gUHJvbXB0LCBtb2RlbC9lZmZvcnQgc2VsZWN0aW9uIGFuZCByZXN1bWUgc3RhdGUuXG4gKiBAcmV0dXJucyBUaGUgYXJndW1lbnQgbGlzdCwgcHJvbXB0IGxhc3QgKG9yIGAtYCB3aGVuIHN0ZGluIGNhcnJpZXMgaXQpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRDb2RleEFyZ3MoaW52b2NhdGlvbjogQ29kZXhJbnZvY2F0aW9uKTogc3RyaW5nW10ge1xuICBjb25zdCBhcmdzOiBzdHJpbmdbXSA9IFtFWEVDX1NVQkNPTU1BTkRdO1xuICBpZiAoaW52b2NhdGlvbi5yZXN1bWVTZXNzaW9uSWQpIHtcbiAgICBhcmdzLnB1c2goUkVTVU1FX1NVQkNPTU1BTkQsIGludm9jYXRpb24ucmVzdW1lU2Vzc2lvbklkKTtcbiAgfVxuXG4gIC8vIFRoZSBjb250YWluZXIgaXMgdGhlIHNhbmRib3ggZm9yIG9yY2hlc3RyYXRlZCByb2xlcyB0b28gKElzc3VlICM0MzU2KTpcbiAgLy8gdGhlIENMSSdzIG93biBzYW5kYm94IG5lZWRzIGJ1YmJsZXdyYXAgYW5kIGEgZnJlc2ggcHJvY2ZzIG1vdW50LCB3aGljaFxuICAvLyB0aGUgYWdlbnQgY29udGFpbmVyIGNhbm5vdCBnaXZlIGl0LCBzbyBhIHNhbmRib3hlZCByb2xlIGNvdWxkIHJ1biBub1xuICAvLyBjb21tYW5kIGF0IGFsbC4gVGhlIHdvcmtlciBrZWVwcyB0aGUgbWFuYWdlciBhbmQgcmV2aWV3ZXIgcmVhZC1vbmx5XG4gIC8vIGluc3RlYWQgKGBvcmNoZXN0cmF0aW9uL3JlYWRfb25seV9ndWFyZC50c2ApLlxuICBhcmdzLnB1c2goLi4uU1RBTkRBUkRfRkxBR1MpO1xuICBpZiAoaW52b2NhdGlvbi5vcmNoZXN0cmF0aW9uUm9sZSkge1xuICAgIGFyZ3MucHVzaChcbiAgICAgIFwiLWNcIixcbiAgICAgICdhcHByb3ZhbF9wb2xpY3k9XCJuZXZlclwiJyxcbiAgICAgIFwiLWNcIixcbiAgICAgIFwiZmVhdHVyZXMubXVsdGlfYWdlbnQ9ZmFsc2VcIixcbiAgICApO1xuICB9XG5cbiAgaWYgKGludm9jYXRpb24ubW9kZWwgJiYgaW52b2NhdGlvbi5tb2RlbCAhPT0gQ09ERVhfQ0xJX0RFRkFVTFRfTU9ERUwpIHtcbiAgICBhcmdzLnB1c2goXCItLW1vZGVsXCIsIGludm9jYXRpb24ubW9kZWwpO1xuICB9XG4gIGlmIChpbnZvY2F0aW9uLmVmZm9ydCkge1xuICAgIGFyZ3MucHVzaChcIi1jXCIsIGAke1JFQVNPTklOR19FRkZPUlRfS0VZfT1cIiR7aW52b2NhdGlvbi5lZmZvcnR9XCJgKTtcbiAgfVxuICBpZiAoaW52b2NhdGlvbi5zZXR0aW5nc0pzb24pIHtcbiAgICBhcmdzLnB1c2goLi4uY29kZXhIb29rQXJncyhpbnZvY2F0aW9uLnNldHRpbmdzSnNvbikpO1xuICB9XG4gIGlmIChpbnZvY2F0aW9uLm1jcENvbmZpZ092ZXJyaWRlcykge1xuICAgIGFyZ3MucHVzaCguLi5pbnZvY2F0aW9uLm1jcENvbmZpZ092ZXJyaWRlcyk7XG4gIH1cblxuICBhcmdzLnB1c2goXG4gICAgaW52b2NhdGlvbi5wcm9tcHRWaWFTdGRpbiA/IFwiLVwiIDogY29tcG9zZUNvZGV4UHJvbXB0KGludm9jYXRpb24pLFxuICApO1xuICByZXR1cm4gYXJncztcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXNCQyxHQUVELFNBQWdDLGtCQUFrQixRQUFRLG9CQUFvQjtBQUM5RSxTQUNFLDJCQUEyQixFQUMzQiwwQkFBMEIsUUFDckIsdUJBQXVCO0FBQzlCLFNBQVMsa0JBQWtCLFFBQVEsa0JBQWtCO0FBQ3JELFNBQVMsb0JBQW9CLFFBQVEsdUJBQXVCO0FBQzVELFNBQXlCLGdCQUFnQixRQUFRLGtCQUFrQjtBQUNuRSxTQUFTLHVCQUF1QixRQUFRLHFCQUFxQjtBQUc3RCxvREFBb0QsR0FDcEQsTUFBTSxrQkFBa0I7QUFFeEIsOERBQThELEdBQzlELE1BQU0sb0JBQW9CO0FBRTFCOzs7Ozs7Ozs7Ozs7Q0FZQyxHQUNELE1BQU0saUJBQW9DO0VBQ3hDO0VBQ0E7RUFDQTtDQUNEO0FBRUQsNEVBQTRFLEdBQzVFLE1BQU0sdUJBQXVCO0FBSzdCOzs7Ozs7Ozs7Q0FTQyxHQUNELE9BQU8sU0FBUyxtQkFBbUIsS0FBdUI7RUFDeEQsT0FBTyxtQkFBbUI7QUFDNUI7QUFFQSw4RUFBOEU7QUFDOUUseUVBQXlFO0FBQ3pFLDhFQUE4RTtBQUU5RSxzRUFBc0UsR0FDdEUsSUFBSSxrQ0FBb0UsQ0FBQztBQUV6RSx1RUFBdUUsR0FDdkUsSUFBSSxtQ0FBcUUsQ0FBQztBQUUxRSw0REFBNEQsR0FDNUQsSUFBSSxrQkFBa0I7QUFDdEIsSUFBSSxnQ0FBa0UsQ0FBQztBQUN2RSxJQUFJLGlDQUFtRSxDQUFDO0FBRXhFOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxTQUFTLGtDQUNkLFNBQWlDO0VBRWpDLGtDQUFrQztJQUFFLEdBQUcsU0FBUztFQUFDO0FBQ25EO0FBRUE7Ozs7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
// denoCacheMetadata=12199815721595563465,10250412830356034699