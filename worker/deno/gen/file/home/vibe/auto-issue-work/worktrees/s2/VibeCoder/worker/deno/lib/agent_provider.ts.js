/**
 * The coding-agent provider seam (Issue #4067, parent #4060).
 *
 * A provider is described here as data — its id, the binary the container
 * image installs, the credential material it needs inside the Vibe credential
 * directory, the environment its child subprocess receives, and how it is
 * invoked. The worker resolves all four through this module, so adding the
 * next provider is a new descriptor plus a new
 * `container/providers/<id>.sh` fragment — not a redesign of containment, the
 * launcher's mount construction, or the credential preflight.
 *
 * Each provider is registered from the modules that already own its behaviour
 * — Claude from `claude_executor.ts` / `claude_env.ts` / `claude_auth.ts` /
 * `session_resume.ts`, Codex from `codex_executor.ts` / `codex_env.ts` /
 * `codex_auth.ts` (Issue #4106), Gemini from `gemini_executor.ts` /
 * `gemini_env.ts` / `gemini_auth.ts` (Issue #4107), DeepSeek from
 * `deepseek_executor.ts` / `deepseek_env.ts` / `deepseek_auth.ts`
 * (Issue #414) — rather than restating any of it, so the invocation the seam
 * produces is the invocation the worker used before the seam existed and no
 * CLI knowledge accumulates in this registry.
 *
 * Fail loud (Issue #3234): an unknown provider id throws with the supported
 * ids named — never a silent fall back to the default, which would run the
 * wrong agent under an operator's explicit selection.
 *
 * ```mermaid
 * flowchart LR
 *     C[".config.json<br/>agent_provider"] --> R["resolveAgentProviderId()"]
 *     E["VIBE_AGENT_PROVIDER"] --> R
 *     R --> D["AgentProviderDescriptor"]
 *     D --> I["invocation<br/>(claude_runner)"]
 *     D --> K["credentials<br/>(credential_preflight)"]
 *     D --> M["mounts<br/>(container_launch)"]
 *     D --> F["install fragment<br/>(container/providers)"]
 * ```
 *
 * Australian English spelling throughout (behaviour, organisation).
 */ import { resolveClaudeEffort, resolveClaudeModel } from "./claude_executor.ts";
import { resolveSetting, warnDeprecatedEnvSetting } from "./config_precedence.ts";
import { CONTAINER_IMAGE_STAMP_ENV, runningInContainerImage } from "./container_stamp.ts";
import { getCheaperModel } from "./config_defaults.ts";
import { buildClaudeChildEnv, CLAUDE_ENV_DENYLIST, CLAUDE_ENV_SECRET_ALLOWLIST } from "./claude_env.ts";
import { claudeAuthActionableMessage, isClaudeAuthError } from "./claude_auth.ts";
import { resolveClaudeMaxTurns } from "./claude_turn_limit.ts";
import { CLAUDE_OUTPUT_ADAPTER, DEEPSEEK_OUTPUT_ADAPTER } from "./claude_output_adapter.ts";
import { CODEX_OUTPUT_ADAPTER } from "./codex_output_adapter.ts";
import { buildSessionResumeArgs, buildSessionResumeFlags, codexResumeSessionId, sessionResumeForProvider } from "./session_resume.ts";
import { adaptCodexAfterModelRefusal, applyCodexModelAdaptation, buildCodexArgs, buildCodexMcpConfigArgs, codexAlternativeModels, composeCodexPrompt, resolveCodexEffort, resolveCodexModel } from "./codex_executor.ts";
import { buildIsolatedCodexChildEnv, CODEX_ENV_DENYLIST, CODEX_ENV_SECRET_ALLOWLIST } from "./codex_env.ts";
import { CODEX_API_KEY_ENV_VARS, CODEX_CREDENTIAL_ENV_VARS, CODEX_HOME_ENV_VAR, codexAuthActionableMessage, isCodexAuthError } from "./codex_auth.ts";
import { initialiseCodexHome, resolveCodexAuthMode } from "./codex_auth_mode.ts";
import { buildGeminiArgs, resolveGeminiEffort, resolveGeminiModel } from "./gemini_executor.ts";
import { buildGeminiChildEnv, GEMINI_ENV_DENYLIST, GEMINI_ENV_SECRET_ALLOWLIST } from "./gemini_env.ts";
import { GEMINI_CREDENTIAL_ENV_VARS, geminiAuthActionableMessage, isGeminiAuthError } from "./gemini_auth.ts";
import { applyDeepSeekModelAdaptation, deepSeekAlternativeModels, deepSeekServedModelSatisfies, resolveDeepSeekEffort, resolveDeepSeekModel, warnDeepSeekAgentsUnsupported, warnDeepSeekEffortUnsupported } from "./deepseek_executor.ts";
import { buildDeepSeekChildEnv, DEEPSEEK_ENV_DENYLIST, DEEPSEEK_ENV_SECRET_ALLOWLIST } from "./deepseek_env.ts";
import { DEEPSEEK_CREDENTIAL_ENV_VARS, deepSeekAuthActionableMessage, isDeepSeekAuthError } from "./deepseek_auth.ts";
/** Directory, relative to `container/`, holding the per-provider fragments. */ export const PROVIDER_FRAGMENT_DIR = "providers";
/** `.config.json` key that selects the active provider. */ export const AGENT_PROVIDER_CONFIG_KEY = "agent_provider";
/** Environment variable that overrides the configured provider. */ export const AGENT_PROVIDER_ENV = "VIBE_AGENT_PROVIDER";
/**
 * `.config.json` key listing every provider enabled for a run (Issue #4108).
 *
 * The enabled set decides which vendors' credentials are provisioned, checked
 * by the preflight and mounted into the container. It defaults to the active
 * provider alone, so a deployment that never sets it is unchanged.
 */ export const ENABLED_AGENT_PROVIDERS_CONFIG_KEY = "agent_providers";
/** Environment variable that overrides the enabled provider set. */ export const ENABLED_AGENT_PROVIDERS_ENV = "VIBE_AGENT_PROVIDERS";
/**
 * Environment variable the container image stamps with the provider set it
 * installed (Issue #4105).
 *
 * `container/Containerfile` bakes it from the `AGENT_PROVIDERS` build
 * argument, so the running image reports the agents it actually carries
 * rather than the worker assuming the default set.
 *
 * The canonical spelling lives in `container_stamp.ts`, which also owns the
 * one rule for reading it (Issue #1262), so the two cannot drift.
 */ export const IMAGE_AGENT_PROVIDERS_ENV = CONTAINER_IMAGE_STAMP_ENV;
/**
 * Build argument the Containerfile selects the installed set with (#729).
 *
 * The launchers pass it from the deployment's enabled set, so a `.config.json`
 * selecting Codex builds a Codex image instead of taking the Containerfile's
 * Claude default.
 */ export const AGENT_PROVIDERS_BUILD_ARG = "AGENT_PROVIDERS";
/**
 * The shape every provider id has: the id is also a filename
 * (`container/providers/<id>.sh`) and a build-argument element, so anything
 * outside this alphabet is refused rather than passed on.
 */ const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
/** The provider id Claude Code is registered under. */ export const CLAUDE_PROVIDER_ID = "claude";
/** The provider id the OpenAI Codex CLI is registered under (Issue #4106). */ export const CODEX_PROVIDER_ID = "codex";
/** The provider id the Gemini CLI is registered under (Issue #4107). */ export const GEMINI_PROVIDER_ID = "gemini";
/**
 * The provider id DeepSeek is registered under (Issue #414, parent #396).
 *
 * DeepSeek ships no CLI of its own: it is carried on the Claude Code CLI
 * pointed at DeepSeek's Anthropic-compatible endpoint, installed under its own
 * command name so a `claude,deepseek` image carries both.
 */ export const DEEPSEEK_PROVIDER_ID = "deepseek";
/** The provider used when neither configuration nor environment selects one. */ export const DEFAULT_AGENT_PROVIDER_ID = CLAUDE_PROVIDER_ID;
/**
 * Resolve the model and effort for one invocation (Issue #362).
 *
 * The precedence is stated here once, for every provider: an explicit
 * `request.model` / `request.effort` always wins, otherwise the provider's own
 * phase routing decides, and when neither supplies a value the CLI's default
 * stands. The six-step chain behind a provider's routing lives in that
 * provider's resolver — Claude's in `claude_executor.ts` — never restated here.
 *
 * @param provider - The descriptor whose routing applies to this invocation.
 * @param request - The invocation, carrying any explicit model/effort and the
 *   phase driving routing.
 * @returns The model and effort this invocation must use.
 */ export function resolveInvocationRouting(provider, request) {
  return {
    // A blank explicit value is no value: it falls through to phase routing,
    // exactly as the pre-seam `request.model ? … : …` test did.
    model: request.model || provider.resolveModel(request.phase, request.env),
    effort: request.effort || provider.resolveEffort(request.phase, request.env)
  };
}
/**
 * The Claude Code CLI's argument list, shared by every provider carried on
 * that binary (Issue #414).
 *
 * Claude and DeepSeek run the *same* executable — DeepSeek's is the same
 * upstream artefact installed under its own command name and pointed at
 * DeepSeek's Anthropic-compatible endpoint — so they take the same argv shape.
 * It is built here once rather than copied into each descriptor: a second
 * verbatim copy is how the two drift, and a flag added for one provider but
 * not the other is a mid-run CLI failure rather than a compile error.
 *
 * The routing is a parameter rather than resolved here, because the two
 * providers do not carry the same levers: Claude passes both model and effort,
 * while DeepSeek's endpoint implements no effort control and passes the model
 * alone (Issue #364's precedent). An absent value emits no flag, leaving the
 * CLI on its own default.
 *
 * @param request - The invocation being built.
 * @param routing - The model and effort this invocation may carry as flags.
 * @returns The CLI argument list, prompt last.
 */ function buildClaudeCliArgs(request, routing) {
  const args = [];
  // Model (Issue #260, #2625) and effort (Issue #1403) selection, through
  // the provider-agnostic seam.
  if (routing.model) args.push("--model", routing.model);
  if (routing.effort) args.push("--effort", routing.effort);
  args.push("--max-turns", String(resolveClaudeMaxTurns(request.env)));
  args.push("--dangerously-skip-permissions");
  const disallowed = request.disallowedTools ?? [];
  if (disallowed.length > 0) {
    args.push("--disallowed-tools", disallowed.join(","));
  }
  // No project or user settings and no ambient MCP servers (Issue #4657).
  if (request.isolateClaudeConfig) {
    args.push("--setting-sources", "", "--strict-mcp-config");
  }
  // Sub-agent definitions (Issue #2342), beside the tool policy they extend.
  // Absent — no sub-agent definitions were built (see `buildIssueRunAgents` in
  // `issue_executor_agents.ts`) — pushes nothing, so the argv below it is
  // unchanged. There is no fallback if the CLI rejects the flag: an older
  // binary fails the run with its own error rather than quietly reverting to
  // single-model routing.
  if (request.agents) {
    args.push("--agents", JSON.stringify(request.agents));
  }
  // One --settings for this spawn (Issues #2344, #2383, #4139). The caller
  // has already merged the edit guard and the hooks into settingsJson, and
  // the CLI keeps a single settings payload, so the flag is emitted once.
  // Absent pushes nothing.
  if (request.settingsJson) {
    args.push("--settings", request.settingsJson);
  }
  args.push("--verbose");
  args.push("--output-format", "stream-json");
  // The headless browser the guidelines promise (Issue #4355): handed to
  // the agent explicitly, so it does not depend on a `.mcp.json` in a
  // directory the agent never runs from.
  if (request.mcpConfigPath) {
    args.push("--mcp-config", request.mcpConfigPath);
  }
  // Static content passed separately so the CLI caches it (Issue #1262).
  if (request.systemPrompt) {
    args.push("--system-prompt", request.systemPrompt);
  }
  // Session continuity across phases of one issue (Issue #1324).
  if (request.sessionResumeState) {
    args.push(...buildSessionResumeArgs(buildSessionResumeFlags(request.sessionResumeState)));
  }
  // The prompt itself: on stdin when the runner pipes it (Issue #4385) —
  // a bare `-p` tells the CLI to read it there — otherwise as before.
  if (request.promptViaStdin) args.push("-p");
  else args.push("-p", request.prompt);
  return args;
}
/**
 * Claude Code, the first registered provider.
 *
 * Every field delegates to the module that already owns that behaviour, so
 * the descriptor is a description of Claude rather than a second copy of it.
 */ const CLAUDE_PROVIDER = {
  supportsPreToolUseHooks: true,
  id: CLAUDE_PROVIDER_ID,
  displayName: "Claude Code",
  binary: "claude",
  credentials: {
    subdir: "claude",
    file: "provider.env",
    envVars: [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN"
    ],
    provisionEnvVar: "VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY",
    // An operator may hold several Claude subscriptions and wants them spent
    // evenly (Issue #917, parent #902), so extra tokens live beside
    // provider.env as provider-2.env, provider-3.env, ... Only the
    // subscription OAuth token joins the pool: a metered ANTHROPIC_API_KEY
    // has no per-token budget to weigh, and ANTHROPIC_AUTH_TOKEN is a bearer
    // for a proxied endpoint rather than a subscription.
    tokenPool: {
      filePattern: "provider-*.env",
      fileMatch: /^provider-(\d+)\.env$/,
      envVars: [
        "CLAUDE_CODE_OAUTH_TOKEN"
      ]
    }
  },
  // Fixed-price subscription vs metered spend (Issue #1923). The OAuth token
  // is the Claude subscription; `withholdNonSubscriptionCredentials` keeps
  // every other Anthropic credential out of a subscription run's child.
  billing: {
    subscriptionEnvVars: [
      "CLAUDE_CODE_OAUTH_TOKEN"
    ],
    // ANTHROPIC_AUTH_TOKEN is deliberately absent: it is a bearer for a
    // proxied endpoint, so what it bills is the proxy's business and this
    // module cannot prove it is metered. It stays `unknown`, which agrees
    // with `claudeStatus`'s `non-subscription-bearer`, and is withheld from a
    // subscription child anyway by CLAUDE_NON_SUBSCRIPTION_CREDENTIAL_ENV_VARS.
    meteredEnvVars: [
      "ANTHROPIC_API_KEY"
    ]
  },
  environment: {
    secretAllowlist: CLAUDE_ENV_SECRET_ALLOWLIST,
    denylist: CLAUDE_ENV_DENYLIST
  },
  install: {
    fragment: `${PROVIDER_FRAGMENT_DIR}/claude.sh`
  },
  // `claude -p` with no positional prompt reads it from stdin (Issue #4385).
  promptTransport: "stdin",
  // The Claude `stream-json` decoder and failure classifier (Issue #1695).
  // A getter, not a value (the `defaultQuorumPlanners()` precedent): the
  // adapter module reaches `claude_executor.ts`, which imports
  // `config_defaults.ts`, which imports this module back, so reading the
  // constant at module-evaluation time throws a temporal-dead-zone error.
  // Deferring the read to property access keeps the descriptor declarative
  // without the cycle.
  get output () {
    return CLAUDE_OUTPUT_ADAPTER;
  },
  // Claude is the provider with phase routing today: both resolvers delegate
  // to the chain `claude_executor.ts` owns (Issue #362).
  resolveModel (phase, env) {
    return resolveClaudeModel(phase, env);
  },
  resolveEffort (phase, env) {
    return resolveClaudeEffort(phase, env);
  },
  // The tier ladder `config_defaults.ts` owns (fable → opus → sonnet → haiku),
  // never restated here (Issue #365).
  cheaperModel (model) {
    return getCheaperModel(model);
  },
  buildInvocation (request) {
    return buildClaudeCliArgs({
      ...request,
      sessionResumeState: sessionResumeForProvider(request.sessionResumeState, this.id)
    }, resolveInvocationRouting(this, request));
  },
  buildChildEnv (parentEnv) {
    return parentEnv ? buildClaudeChildEnv(parentEnv) : buildClaudeChildEnv();
  },
  isAuthError (output) {
    return isClaudeAuthError(output);
  },
  authActionableMessage () {
    return claudeAuthActionableMessage();
  }
};
/**
 * The OpenAI Codex CLI, the second registered provider (Issue #4106).
 *
 * The first real test of the seam: adding it is this descriptor plus
 * `container/providers/codex.sh` and a `container/tools.json` pin — no change
 * to containment, the launcher's mounts, or the credential preflight. Every
 * field delegates to the Codex-owned modules (`codex_executor.ts`,
 * `codex_env.ts`, `codex_auth.ts`), so no Codex CLI knowledge lives here.
 */ const CODEX_PROVIDER = {
  supportsPreToolUseHooks: true,
  id: CODEX_PROVIDER_ID,
  displayName: "Codex CLI",
  binary: "codex",
  credentials: {
    subdir: "codex",
    file: "provider.env",
    envVars: CODEX_CREDENTIAL_ENV_VARS,
    stateEnvVars: [
      CODEX_HOME_ENV_VAR
    ],
    initialiseState: initialiseCodexHome,
    provisionEnvVar: "VIBE_LAUNCHAGENT_OPENAI_API_KEY"
  },
  // Fixed-price subscription vs metered spend (Issue #1923). No environment
  // variable carries a ChatGPT subscription: it lives in the auth state the
  // CLI persists under CODEX_HOME, so the proof is a probe rather than a
  // name. The probe reads only an EXPLICIT CODEX_HOME (Issue #3955): that is
  // the one home `buildIsolatedCodexChildEnv` gives the child. Without it the
  // child gets no home, the CLI falls back to $HOME/.codex, which the worker
  // never probes, so the answer comes from the metered-key check instead.
  billing: {
    subscriptionEnvVars: [],
    meteredEnvVars: CODEX_API_KEY_ENV_VARS,
    resolveStoredBilling (context) {
      const explicitHome = (context.env(CODEX_HOME_ENV_VAR) ?? "").trim();
      if (!explicitHome) return undefined;
      // An explicit CODEX_HOME withholds OPENAI_API_KEY / CODEX_API_KEY from
      // the child, so the environment is not consulted here: a persisted
      // ChatGPT login is what the run spends even when a metered key sits in
      // the worker's own environment.
      const { mode, source, detail } = resolveCodexAuthMode(explicitHome, ()=>undefined);
      if (mode === "chatgpt") {
        return {
          mode: "fixed-subscription",
          reason: "codex-chatgpt-login"
        };
      }
      if (mode === "api-key") {
        // With the environment withheld, a key can only come from auth.json,
        // where no variable is set at all.
        return {
          mode: "metered",
          reason: "codex-auth-json-api-key"
        };
      }
      if (source === "read-error") {
        // A login that cannot be read is a fault, not an absent login. Say
        // which fault, so it is not reported as "never authenticated".
        return {
          mode: "unknown",
          reason: `codex-auth-json-unreadable (${detail ?? "no detail"})`
        };
      }
      return undefined;
    }
  },
  environment: {
    secretAllowlist: CODEX_ENV_SECRET_ALLOWLIST,
    denylist: CODEX_ENV_DENYLIST
  },
  install: {
    fragment: `${PROVIDER_FRAGMENT_DIR}/codex.sh`
  },
  // The prompt travels on stdin (Issue #1702): Linux caps one argv element
  // at 128 KiB, and a long issue thread exceeds that. Codex reads `-` as
  // "the prompt is on stdin".
  promptTransport: "stdin",
  // The `codex exec --json` decoder and failure classifier (Issue #1695),
  // deferred for the same import cycle as Claude's above.
  get output () {
    return CODEX_OUTPUT_ADAPTER;
  },
  // Codex routes `phase` through its own tables (Issue #363), the way Claude
  // does: the chain lives in `codex_executor.ts` and is never restated here.
  resolveModel (phase, env) {
    return resolveCodexModel(phase, env);
  },
  // A ChatGPT login may refuse a built-in default (Issue #4221): the alternative
  // is the CLI's own default, i.e. no --model.
  alternativeModels (model, phase, env) {
    return codexAlternativeModels(model, phase, env);
  },
  applyModelAdaptation (unavailable, alternative, phase) {
    applyCodexModelAdaptation(unavailable, alternative, phase);
  },
  adaptAfterModelRefusal (model, phase, env) {
    return adaptCodexAfterModelRefusal(model, phase, env);
  },
  resolveEffort (phase, env) {
    return resolveCodexEffort(phase, env);
  },
  buildInvocation (request) {
    const routing = resolveInvocationRouting(this, request);
    let mcpConfigOverrides;
    if (request.mcpConfigPath) {
      let json;
      try {
        json = Deno.readTextFileSync(request.mcpConfigPath);
      } catch (error) {
        throw new Error(`Codex MCP config at ${request.mcpConfigPath} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      mcpConfigOverrides = buildCodexMcpConfigArgs(json);
      if (mcpConfigOverrides.length === 0) {
        throw new Error(`Codex MCP config at ${request.mcpConfigPath} produced no ` + `mcp_servers overrides; refusing to run without the requested ` + `browser server (Issue #1702).`);
      }
    }
    return buildCodexArgs({
      prompt: request.prompt,
      orchestrationRole: request.orchestrationRole,
      settingsJson: request.settingsJson,
      systemPrompt: request.systemPrompt,
      disallowedTools: request.disallowedTools,
      model: routing.model,
      effort: routing.effort,
      // Resume the thread this issue's previous Codex phase reported
      // (Issue #1699). A Claude UUID, a missing capture, or `--last` is
      // never a substitute — concurrent slots share a working directory.
      resumeSessionId: codexResumeSessionId(request.sessionResumeState),
      promptViaStdin: request.promptViaStdin,
      ...mcpConfigOverrides ? {
        mcpConfigOverrides
      } : {}
    });
  },
  stdinBody (request) {
    return composeCodexPrompt({
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      disallowedTools: request.disallowedTools
    });
  },
  buildChildEnv (parentEnv) {
    const source = parentEnv ?? Deno.env.toObject();
    // Issue #1698: only the selected account's Codex secrets are copied
    // back after the denylist strip. The parent object is not mutated.
    return buildIsolatedCodexChildEnv(source, {
      openaiApiKey: source.OPENAI_API_KEY,
      codexApiKey: source.CODEX_API_KEY,
      codexHome: source.CODEX_HOME
    });
  },
  isAuthError (output) {
    return isCodexAuthError(output);
  },
  authActionableMessage () {
    return codexAuthActionableMessage();
  }
};
/**
 * The Gemini CLI, the third registered provider (Issue #4107).
 *
 * In Quorum mode Gemini is the judge rather than a planner: it reads the two
 * planners' candidate plans and picks a winner, so its invocation asks for
 * machine-readable output where a planner's may stay prose. Every field
 * delegates to the Gemini-owned modules (`gemini_executor.ts`,
 * `gemini_env.ts`, `gemini_auth.ts`), so no Gemini CLI knowledge lives here.
 *
 * It carries **no** `output` adapter (Issue #1695): its event shapes were not
 * confirmable against the pinned CLI here, and decoding them with Claude's
 * parser is exactly the guesswork this seam exists to end. The runner keeps
 * the shared text extraction for it and reports no normalised result — an
 * absent decode, never a fabricated one.
 */ const GEMINI_PROVIDER = {
  id: GEMINI_PROVIDER_ID,
  displayName: "Gemini CLI",
  binary: "gemini",
  credentials: {
    subdir: "gemini",
    file: "provider.env",
    envVars: GEMINI_CREDENTIAL_ENV_VARS,
    provisionEnvVar: "VIBE_LAUNCHAGENT_GEMINI_API_KEY"
  },
  // Gemini bills per token against an API key (Issue #1923): there is no
  // fixed-price subscription VibeCoder can run unattended, so it is never an
  // automatic-routing candidate.
  billing: {
    subscriptionEnvVars: [],
    meteredEnvVars: GEMINI_CREDENTIAL_ENV_VARS
  },
  environment: {
    secretAllowlist: GEMINI_ENV_SECRET_ALLOWLIST,
    denylist: GEMINI_ENV_DENYLIST
  },
  install: {
    fragment: `${PROVIDER_FRAGMENT_DIR}/gemini.sh`
  },
  promptTransport: "argv",
  // Gemini routes `phase` to a model through its own table (Issue #364), the
  // way Claude and Codex do; the chain lives in `gemini_executor.ts` and is
  // never restated here. The effort resolver reports what a phase was *asked*
  // to run at — the CLI has no effort option to honour it with, so the value
  // is warned about rather than turned into an argument.
  resolveModel (phase, env) {
    return resolveGeminiModel(phase, env);
  },
  resolveEffort (phase) {
    return resolveGeminiEffort(phase);
  },
  buildInvocation (request) {
    const routing = resolveInvocationRouting(this, request);
    return buildGeminiArgs({
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      disallowedTools: request.disallowedTools,
      model: routing.model,
      // No flag carries an effort under Gemini, so this adds no argv element —
      // it is passed so the executor can warn once rather than drop it
      // silently (Issue #364, fail-loud standard #3234).
      effort: routing.effort,
      phase: request.phase,
      // Gemini resumes its own most recent session; the first phase of an
      // issue starts one instead (`phaseCount === 0`).
      resumeSession: buildSessionResumeFlags(request.sessionResumeState).resume
    });
  },
  buildChildEnv (parentEnv) {
    return parentEnv ? buildGeminiChildEnv(parentEnv) : buildGeminiChildEnv();
  },
  isAuthError (output) {
    return isGeminiAuthError(output);
  },
  authActionableMessage () {
    return geminiAuthActionableMessage();
  }
};
/**
 * DeepSeek, the fourth registered provider (Issue #414, parent #396).
 *
 * The one provider that ships no CLI of its own: it is the **Claude Code CLI**
 * pointed at DeepSeek's Anthropic-compatible endpoint, which decides three of
 * this descriptor's fields.
 *
 * - `binary` is `deepseek`, **not** `claude`. Both fragments install to
 *   `/usr/local/bin/<binary>`, so an image built with
 *   `AGENT_PROVIDERS="claude,deepseek"` — the Quorum deployment this provider
 *   exists for — would otherwise have the second fragment clobber the first.
 *   A distinct command name also makes the process table say which provider is
 *   running.
 * - The argv is Claude's, built by {@link buildClaudeCliArgs} rather than
 *   copied, because it is literally the same CLI parsing it.
 * - No `--effort` is ever emitted: the endpoint does not implement Anthropic's
 *   effort control, so the effort the phase was *asked* to run at is warned
 *   about once rather than passed (Issue #364's Gemini treatment). There is no
 *   `cheaperModel` either — DeepSeek publishes no cheaper rung, and the
 *   optional method being absent is what makes the rate-limit fallback report
 *   `no-ladder-for-provider` instead of a silent no-op (Issue #365).
 *
 * Everything else delegates to the DeepSeek-owned modules
 * (`deepseek_executor.ts`, `deepseek_env.ts`, `deepseek_auth.ts`).
 */ const DEEPSEEK_PROVIDER = {
  id: DEEPSEEK_PROVIDER_ID,
  displayName: "DeepSeek",
  binary: "deepseek",
  credentials: {
    subdir: "deepseek",
    file: "provider.env",
    envVars: DEEPSEEK_CREDENTIAL_ENV_VARS,
    provisionEnvVar: "VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY"
  },
  // DeepSeek bills per token against an API key (Issue #1923), the same as
  // Gemini: metered, and never an automatic-routing candidate.
  billing: {
    subscriptionEnvVars: [],
    meteredEnvVars: DEEPSEEK_CREDENTIAL_ENV_VARS
  },
  environment: {
    secretAllowlist: DEEPSEEK_ENV_SECRET_ALLOWLIST,
    denylist: DEEPSEEK_ENV_DENYLIST
  },
  install: {
    fragment: `${PROVIDER_FRAGMENT_DIR}/deepseek.sh`
  },
  // The same CLI as Claude, so a bare `-p` reads the prompt from stdin
  // (Issue #4385).
  promptTransport: "stdin",
  // The same CLI as Claude, so the same event decoder (Issue #1695), but
  // refusals that name DeepSeek (Issue #2633); deferred for the same import
  // cycle.
  get output () {
    return DEEPSEEK_OUTPUT_ADAPTER;
  },
  // Every phase is pinned to a real DeepSeek model id: Claude's routing
  // resolves to Anthropic tier aliases the endpoint cannot resolve, and a
  // provider with no routing of its own would send one (Issue #413).
  resolveModel (phase, env) {
    return resolveDeepSeekModel(phase, env);
  },
  resolveEffort (phase) {
    return resolveDeepSeekEffort(phase);
  },
  // The vendor serves upgrades and its documented legacy alias instead of the
  // requested id; only a downgrade fails the served-vs-expected check
  // (Issue #2053).
  servedModelSatisfies (served, expected) {
    return deepSeekServedModelSatisfies(served, expected);
  },
  // A tier outage adapts in place: the base tier's phases move to the top
  // tier for this run, and the health gate drives the probe (Issue #2059).
  alternativeModels (model) {
    return deepSeekAlternativeModels(model);
  },
  applyModelAdaptation (unavailable, alternative) {
    applyDeepSeekModelAdaptation(unavailable, alternative);
  },
  buildInvocation (request) {
    const routing = resolveInvocationRouting(this, request);
    // The effort resolver reports what the phase was asked to run at; no flag
    // can carry it here, so it is stated loudly once per phase rather than
    // dropped in silence (Issue #3234) — and never reaches the argv, where the
    // Anthropic CLI would happily forward it to an endpoint that rejects it.
    if (routing.effort) {
      warnDeepSeekEffortUnsupported(routing.effort, request.phase);
    }
    // Sub-agent definitions (Issue #2342) name Anthropic tier aliases this
    // endpoint cannot resolve, so they are dropped from the argv — but stated,
    // never in silence. The issue-run path reroutes such a run to Claude or
    // strips the definitions before spawn (lib/issue_run_provider_agents.ts);
    // the runner's refusal of a native run whose argv lost its `--agents`
    // (Issue #4010) is only a backstop, so a split configured under DeepSeek
    // never runs as one that looks split and is not.
    // The advisor edit guard goes with them (Issue #2344): without executors
    // to make the edits, a guard here would deny the advisor's own and leave
    // the run unable to edit anything.
    const { agents, settingsJson: _guard, ...deepSeekRequest } = request;
    if (agents) warnDeepSeekAgentsUnsupported(request.phase);
    return buildClaudeCliArgs({
      ...deepSeekRequest,
      sessionResumeState: sessionResumeForProvider(request.sessionResumeState, this.id),
      // Hooks are an Anthropic-endpoint feature (Issue #2383): the shared
      // binary would forward `--settings` to an endpoint that runs nothing,
      // so the payload is dropped here rather than in the caller.
      settingsJson: undefined
    }, {
      model: routing.model
    });
  },
  buildChildEnv (parentEnv) {
    return parentEnv ? buildDeepSeekChildEnv(parentEnv) : buildDeepSeekChildEnv();
  },
  isAuthError (output) {
    return isDeepSeekAuthError(output);
  },
  authActionableMessage () {
    return deepSeekAuthActionableMessage();
  }
};
/** Every registered provider, keyed by id. */ const AGENT_PROVIDERS = new Map([
  [
    CLAUDE_PROVIDER.id,
    CLAUDE_PROVIDER
  ],
  [
    CODEX_PROVIDER.id,
    CODEX_PROVIDER
  ],
  [
    GEMINI_PROVIDER.id,
    GEMINI_PROVIDER
  ],
  [
    DEEPSEEK_PROVIDER.id,
    DEEPSEEK_PROVIDER
  ]
]);
/**
 * The ids of every registered provider.
 *
 * @returns Provider ids in registration order.
 */ export function agentProviderIds() {
  return [
    ...AGENT_PROVIDERS.keys()
  ];
}
/**
 * Look up a registered provider without failing on an unknown id.
 *
 * {@link resolveAgentProvider} throws, which is right where an operator
 * stated a provider and got it wrong. A caller merely *asking about* an id —
 * the billing classifier (Issue #1923) — needs "no such provider" as an
 * answer rather than an exception.
 *
 * @param id - Provider id, trimmed before lookup.
 * @returns The descriptor, or undefined when nothing is registered under it.
 */ export function agentProviderById(id) {
  return AGENT_PROVIDERS.get(id.trim());
}
/**
 * The provider standing in for the configured one **for this run**
 * (Issue #2062), set by the health gate's fallback switch.
 *
 * Module-level rather than a file (Issue #2065): the observed revert was
 * in-process — the best-effort config loaders reload the config and reset
 * the module state to the file's preferred id — so a module record the
 * resolver consults **before** the file's value survives every reload and
 * needs no filesystem write (the file beside the read-only config staging
 * dir crashed the run).
 */ let _runProviderOverrideId;
/**
 * Record the per-run provider override (Issue #2062).
 *
 * The health gate sets it when its fallback switch fires; the run-core
 * command clears it at run start so each run re-evaluates the configured
 * preferred provider first. An unregistered id fails loudly — the gate
 * only sets ids it probed healthy.
 *
 * @param id - The provider id to stand in for the configured one, or
 *   undefined to clear.
 */ export function setRunProviderOverride(id) {
  _runProviderOverrideId = id === undefined ? undefined : resolveAgentProvider(id).id;
}
/**
 * The per-run provider override currently in force (Issue #2062).
 *
 * @returns The canonical override id, or undefined when there is none.
 */ export function runProviderOverrideId() {
  return _runProviderOverrideId;
}
/**
 * Resolve a provider descriptor by id.
 *
 * @param id - Provider id from configuration, the environment, or a caller.
 * @returns The descriptor.
 * @throws When the id is blank or not registered — naming every supported id,
 *   so an operator sees what to choose instead (Issue #3234).
 */ export function resolveAgentProvider(id) {
  const wanted = id.trim();
  const provider = wanted === "" ? undefined : AGENT_PROVIDERS.get(wanted);
  if (!provider) {
    throw new Error(`Unsupported coding-agent provider ${JSON.stringify(id)}. ` + `Supported providers: ${agentProviderIds().join(", ")}. ` + `Set "${AGENT_PROVIDER_CONFIG_KEY}" in .config.json (or ` + `${AGENT_PROVIDER_ENV}) to one of those ids.`);
  }
  return provider;
}
/**
 * The provider a repository pinned in `repo_config.<repo>.agent_provider`
 * (Issue #2048), validated.
 *
 * Every source that states a value is validated, not just the one that binds
 * (Issue #3234): a repo pin naming an unregistered id throws here, naming the
 * key it was written under. A blank pin is the same as no pin — an empty
 * string can never select a provider.
 *
 * @param repoConfig - The repo's merged RepoConfig, or undefined.
 * @returns The canonical provider id, or undefined when the repo pins none.
 * @throws When the pin names an unregistered provider.
 */ export function repoPinnedAgentProvider(repoConfig) {
  const pinned = repoConfig?.agentProvider?.trim();
  if (!pinned) return undefined;
  const provider = AGENT_PROVIDERS.get(pinned);
  if (!provider) {
    throw new Error(`Unsupported coding-agent provider ${JSON.stringify(pinned)} in ` + `repo_config.<repo>.agent_provider. Supported providers: ` + `${agentProviderIds().join(", ")}.`);
  }
  return provider.id;
}
/**
 * Resolve the provider selection for one invocation, repo pin layered in
 * (Issue #2048).
 *
 * An explicit per-invocation selection — a Quorum draft naming its provider,
 * a caller pin — stays absolute (Issue #4109). Otherwise the repository's own
 * pin binds; with neither, the result is `undefined` and the caller keeps the
 * process-wide default, which is also how `agent_provider_mode: "auto"` moves
 * the default between work items — a repo pin is an explicit operator pin and
 * wins over the rank, exactly like `VIBE_AGENT_PROVIDER` does.
 *
 * @param explicit - The caller's per-invocation selection, when any.
 * @param repoConfig - The invocation's repo config, when known.
 * @returns The selection to hand to {@link selectAgentProvider}, or undefined.
 */ export function resolveInvocationAgentProvider(explicit, repoConfig) {
  return explicit ?? repoPinnedAgentProvider(repoConfig);
}
/**
 * The provider `.config.json` selected, once configuration has been loaded.
 *
 * The low-level modules that spawn the agent hold no configuration handle, so
 * `loadConfig` records the selection here and they read it back through
 * {@link resolveAgentProviderId}.
 */ let configuredProviderId;
/**
 * Record the provider selected by configuration.
 *
 * @param id - Provider id from `.config.json`, or undefined to clear it.
 * @throws When the id is set but unsupported (Issue #3234).
 */ export function setConfiguredAgentProviderId(id) {
  const wanted = id?.trim();
  configuredProviderId = wanted ? resolveAgentProvider(wanted).id : undefined;
}
/**
 * Resolve the active provider id.
 *
 * Precedence is the rule `config_precedence.ts` states for every knob
 * (Issue #1032): the `.config.json` `agent_provider` key, then
 * `VIBE_AGENT_PROVIDER`, then Claude. Any value that is set but unsupported
 * fails loudly rather than falling back.
 *
 * The resolved id is checked against the set the running image installed
 * (Issue #4105), so asking for an agent this image does not carry fails here
 * rather than as a "command not found" mid-run.
 *
 * @param selection - Configured value and environment lookup.
 * @returns The active provider id.
 * @throws When a set value names an unsupported provider, or the running
 *   image did not install the resolved one.
 */ export function resolveAgentProviderId(selection = {}) {
  const env = selection.env ?? ((name)=>Deno.env.get(name));
  const id = resolveSelectedProviderId(selection, env);
  assertImageInstalledProvider(id, {
    env
  });
  return id;
}
/**
 * The configured preferred provider — {@link resolveAgentProviderId} without
 * the per-run fallback override (Issue #2638).
 *
 * A stream session recorded before its creator was stored is presumed to be
 * this provider's: the fallback only ever stood in for it, so the preferred
 * provider is the one that built every conversation the record could hold.
 *
 * @param selection - Configured value and environment lookup.
 * @returns The preferred provider id.
 * @throws When a set value names an unsupported provider.
 */ export function preferredAgentProviderId(selection = {}) {
  const env = selection.env ?? ((name)=>Deno.env.get(name));
  return resolveSelectedProviderId(selection, env, {
    honourOverride: false
  });
}
/**
 * The id configuration, the environment, or the default selects.
 *
 * The order is `resolveSetting`'s, not this module's own (Issue #1032): the
 * file wins, `VIBE_AGENT_PROVIDER` applies when the file selects nothing, and
 * Claude applies when neither does. A run that still takes its provider from
 * the variable is told once, naming the key that replaces it.
 *
 * Every source that states a value is validated, not just the one that binds:
 * an unregistered id throws wherever it was written (Issue #3234). Losing to
 * the file must not turn a typo in the variable into silence — the operator
 * who exported `VIBE_AGENT_PROVIDER=aider` still has to be told the id does
 * not exist.
 */ function resolveSelectedProviderId(selection, env, options = {}) {
  // The per-run override (Issue #2062) beats the file and the recorded
  // configured value: the health gate's fallback switch must survive every
  // in-process config reload, which would otherwise reset the choice to
  // the file's preferred id (Issue #2065's crash came from the file
  // variant). An explicit per-invocation selector never reaches here.
  const override = options.honourOverride === false ? undefined : _runProviderOverrideId;
  const configured = (override ?? selection.configured ?? configuredProviderId)?.trim();
  const resolved = resolveSetting({
    configKey: AGENT_PROVIDER_CONFIG_KEY,
    envVar: AGENT_PROVIDER_ENV,
    env,
    configured: configured ? resolveAgentProvider(configured).id : null,
    fallback: DEFAULT_AGENT_PROVIDER_ID,
    parse: parseEnvProviderId
  });
  // The file short-circuits the resolution, so the variable is checked here as
  // well — set-but-unsupported fails loudly whichever source wins.
  if (resolved.source !== "env") parseEnvProviderId(env(AGENT_PROVIDER_ENV));
  warnDeprecatedEnvSetting(resolved, AGENT_PROVIDER_CONFIG_KEY);
  return resolved.value;
}
/**
 * Validate an id stated in {@link AGENT_PROVIDER_ENV}.
 *
 * @param raw - The variable's value; blank or absent states nothing.
 * @returns The canonical id, or null when the variable states nothing.
 * @throws When the variable names a provider that is not registered, with the
 *   variable named so the operator knows which of the two sources to fix.
 */ function parseEnvProviderId(raw) {
  const wanted = raw?.trim();
  if (!wanted) return null;
  try {
    return resolveAgentProvider(wanted).id;
  } catch (error) {
    throw new Error(`${AGENT_PROVIDER_ENV}: ${error.message}`);
  }
}
/**
 * The providers the running container image installed (Issue #4105).
 *
 * Reads the set the image stamped into {@link IMAGE_AGENT_PROVIDERS_ENV}, so
 * a worker in a Quorum image can tell which agent CLIs it actually carries.
 *
 * @param selection - Environment lookup (defaults to the process environment).
 * @returns The installed provider ids, or `undefined` when the stamp is
 *   absent — an uncontained worker installs its agents on the host, so there
 *   is no image set to check against.
 * @throws When the stamp is present but malformed (empty, a bad id, or a
 *   duplicate): a stamp that cannot be trusted fails loudly rather than
 *   passing for "no stamp" (Issue #3234).
 */ export function imageAgentProviderIds(selection = {}) {
  const env = selection.env ?? ((name)=>Deno.env.get(name));
  // Blank reads as absent, on the shared stamp rule (Issue #1262): an empty
  // stamp names no provider set, so it cannot stand in for one.
  if (!runningInContainerImage(env)) return undefined;
  const stamped = env(IMAGE_AGENT_PROVIDERS_ENV) ?? "";
  const ids = [];
  for (const raw of stamped.split(",")){
    const id = raw.trim();
    if (!PROVIDER_ID_PATTERN.test(id)) {
      throw new Error(`${IMAGE_AGENT_PROVIDERS_ENV}=${JSON.stringify(stamped)} is not a ` + `provider set: ${JSON.stringify(id)} is not a lower-case provider id.`);
    }
    if (ids.includes(id)) {
      throw new Error(`${IMAGE_AGENT_PROVIDERS_ENV}=${JSON.stringify(stamped)} lists ` + `${JSON.stringify(id)} twice.`);
    }
    ids.push(id);
  }
  return ids;
}
/**
 * Assert the running image carries a provider before it is used.
 *
 * @param id - The provider the caller (a phase, a Quorum member) wants.
 * @param selection - Environment lookup (defaults to the process environment).
 * @throws When the image stamped a set that excludes `id`, naming the
 *   providers it does carry. A no-op when the image stamped no set.
 */ export function assertImageInstalledProvider(id, selection = {}) {
  const installed = imageAgentProviderIds(selection);
  if (installed === undefined || installed.includes(id)) return;
  throw new Error(`The running container image did not install the ${JSON.stringify(id)} ` + `coding-agent provider. Installed: ${installed.join(", ")}. Rebuild the ` + `image with AGENT_PROVIDERS including ${JSON.stringify(id)}.`);
}
/**
 * Resolve the active provider descriptor.
 *
 * @param selection - Configured value and environment lookup.
 * @returns The active descriptor.
 * @throws When a set value names an unsupported provider.
 */ export function activeAgentProvider(selection = {}) {
  return resolveAgentProvider(resolveAgentProviderId(selection));
}
/**
 * Resolve the active provider for pre-spawn planning (Issue #4109).
 *
 * Planning only needs to know what the provider can carry, so this skips the
 * installed-set check that {@link activeAgentProvider} runs. An uninstalled
 * provider is still refused later by the runner's install assert (Issue
 * #4105), so this must not throw earlier than the base code did (Issue #4109).
 *
 * @param selection - Configured value and environment lookup.
 * @returns The active descriptor, without the installed-set check.
 * @throws When a set value names an unsupported provider.
 */ export function plannedActiveAgentProvider(selection = {}) {
  const env = selection.env ?? ((name)=>Deno.env.get(name));
  return resolveAgentProvider(resolveSelectedProviderId(selection, env));
}
/**
 * Resolve the provider for **one** invocation (Issue #4109).
 *
 * This is the per-call selection path Quorum needs: naming a provider here
 * selects it for this invocation only and never touches
 * {@link setConfiguredAgentProviderId} or the environment, so two invocations
 * naming different providers can run concurrently in one process. The returned
 * descriptor is a frozen value the caller holds for the whole invocation —
 * nothing downstream re-reads module-level state mid-run.
 *
 * Omitting `selector` falls back to {@link activeAgentProvider}, so a caller
 * that names nothing behaves exactly as it did before this seam existed.
 *
 * Fail loud (Issue #3234): an unregistered id names every supported id, and a
 * provider the running image did not install names the installed set — neither
 * falls back to the default, which would silently run the wrong agent.
 *
 * @param selector - Provider id or descriptor; omit for the active provider.
 * @param selection - Configured value and environment lookup.
 * @returns The descriptor this invocation must use.
 * @throws When the id is not registered, the descriptor is malformed, or the
 *   running image did not install the named provider.
 */ export function selectAgentProvider(selector, selection = {}) {
  if (selector === undefined) return activeAgentProvider(selection);
  const provider = typeof selector === "string" ? resolveAgentProvider(selector) : selector;
  if (typeof provider?.id !== "string" || provider.id.trim() === "") {
    throw new Error(`The coding-agent provider named for this invocation has no id. ` + `Pass a registered id (${agentProviderIds().join(", ")}) or a ` + `descriptor with one.`);
  }
  assertImageInstalledProvider(provider.id, selection);
  return provider;
}
/**
 * The enabled set `.config.json` selected, once configuration has been loaded.
 *
 * Mirrors {@link configuredProviderId}: the credential preflight and the
 * launcher hold no configuration handle, so `loadConfig` records the selection
 * here and they read it back.
 */ let configuredEnabledProviderIds;
/**
 * Validate a set of provider ids, naming where they came from.
 *
 * @param values - Raw ids from configuration or the environment.
 * @param source - Operator-facing description of where they came from.
 * @returns The canonical ids, in the order given.
 * @throws When the set is empty, holds a blank or duplicate id, or names a
 *   provider that is not registered (Issue #3234).
 */ function parseEnabledProviderIds(values, source) {
  const ids = [];
  for (const raw of values){
    const wanted = raw.trim();
    if (wanted === "") {
      throw new Error(`${source} lists an empty coding-agent provider id. ` + `Supported providers: ${agentProviderIds().join(", ")}.`);
    }
    let id;
    try {
      id = resolveAgentProvider(wanted).id;
    } catch (error) {
      throw new Error(`${source}: ${error.message}`);
    }
    if (ids.includes(id)) {
      throw new Error(`${source} lists ${JSON.stringify(id)} twice.`);
    }
    ids.push(id);
  }
  if (ids.length === 0) {
    throw new Error(`${source} enables no coding-agent provider — the run would have no ` + `agent to work with. Supported providers: ${agentProviderIds().join(", ")}.`);
  }
  return ids;
}
/**
 * Record the enabled provider set selected by configuration.
 *
 * @param ids - Provider ids from `.config.json`, or undefined to clear the
 *   selection (which falls the set back to the active provider alone).
 * @throws When the set is set but unusable (Issue #3234).
 */ export function setConfiguredEnabledAgentProviderIds(ids) {
  configuredEnabledProviderIds = ids === undefined ? undefined : parseEnabledProviderIds(ids, `Configuration key "${ENABLED_AGENT_PROVIDERS_CONFIG_KEY}"`);
}
/**
 * Resolve the ids of every provider enabled for this run (Issue #4108).
 *
 * Precedence mirrors {@link resolveAgentProviderId}, which is the rule
 * `config_precedence.ts` states (Issue #1032): the `.config.json`
 * {@link ENABLED_AGENT_PROVIDERS_CONFIG_KEY} key, then
 * {@link ENABLED_AGENT_PROVIDERS_ENV}, then the active provider alone — so a
 * deployment that configures neither behaves exactly as it did before the set
 * existed.
 *
 * Every enabled id is checked against the set the running image installed, so
 * enabling an agent this image does not carry fails here rather than as a
 * "command not found" mid-run.
 *
 * @param selection - Configured values and environment lookup.
 * @returns The enabled provider ids, active provider first when it was
 *   selected implicitly.
 * @throws When the set is unusable, or excludes the active provider — a run
 *   whose own agent has no mounted credential must not start (Issue #3234).
 */ export function resolveEnabledAgentProviderIds(selection = {}) {
  const env = selection.env ?? ((name)=>Deno.env.get(name));
  const activeId = resolveAgentProviderId(selection);
  const configured = selection.configuredProviders ?? configuredEnabledProviderIds;
  const parseEnvSet = (raw)=>parseEnabledProviderIds(raw.split(","), `${ENABLED_AGENT_PROVIDERS_ENV}=${JSON.stringify(raw)}`);
  const resolved = resolveSetting({
    configKey: ENABLED_AGENT_PROVIDERS_CONFIG_KEY,
    envVar: ENABLED_AGENT_PROVIDERS_ENV,
    env,
    configured: configured === undefined ? null : parseEnabledProviderIds(configured, `Configuration key "${ENABLED_AGENT_PROVIDERS_CONFIG_KEY}"`),
    fallback: [
      activeId
    ],
    parse: parseEnvSet
  });
  // As with the active provider: the file short-circuits the resolution, so an
  // unusable variable is checked here too rather than passing in silence.
  if (resolved.source !== "env") {
    const stated = env(ENABLED_AGENT_PROVIDERS_ENV)?.trim();
    if (stated) parseEnvSet(stated);
  }
  warnDeprecatedEnvSetting(resolved, ENABLED_AGENT_PROVIDERS_CONFIG_KEY);
  const ids = [
    ...resolved.value
  ];
  if (!ids.includes(activeId)) {
    throw new Error(`The enabled coding-agent providers (${ids.join(", ")}) exclude the ` + `active provider ${JSON.stringify(activeId)}, so its credentials ` + `would never be provisioned or mounted. Add it to ` + `"${ENABLED_AGENT_PROVIDERS_CONFIG_KEY}", or select one of the ` + `enabled providers with "${AGENT_PROVIDER_CONFIG_KEY}".`);
  }
  for (const id of ids)assertImageInstalledProvider(id, {
    env
  });
  return ids;
}
/**
 * Resolve the descriptors of every provider enabled for this run.
 *
 * @param selection - Configured values and environment lookup.
 * @returns One descriptor per enabled provider.
 * @throws When the enabled set is unusable (see
 *   {@link resolveEnabledAgentProviderIds}).
 */ export function enabledAgentProviders(selection = {}) {
  return resolveEnabledAgentProviderIds(selection).map(resolveAgentProvider);
}
/**
 * The {@link AGENT_PROVIDERS_BUILD_ARG} value one image build needs (#729).
 *
 * The set handed in is the very one the credential and mount path resolved —
 * `resolveEnabledAgentProviderIds` for a configured deployment, or the ids of
 * the descriptors a caller drove the plan with — so a single `.config.json`
 * value cannot mean one thing to the build and another to the mounts. Only the
 * *shape* is re-checked here: registration is settled upstream, and the
 * per-invocation seam deliberately accepts a descriptor a caller constructed
 * without registering it ({@link selectAgentProvider}).
 *
 * `undefined` means the set is already what the image installs by default
 * (`container/tools.json` `installedProviders`, which the Containerfile
 * restates as the argument's default), so no `--build-arg` is passed and the
 * default fleet build stays byte-for-byte what it was. Order is significant:
 * the fragments install in the order requested, so a re-ordered set is a
 * different build and a different image.
 *
 * @param enabled - The providers this deployment enabled, in install order.
 * @param imageDefault - The set a default image build installs.
 * @returns The comma-separated set, or undefined when it is the default.
 * @throws When the set is empty, or holds a blank, malformed or duplicated id
 *   — a build argument that cannot name a fragment must fail here, not as a
 *   half-installed image (Issue #3234).
 */ export function agentProvidersBuildValue(enabled, imageDefault) {
  const ids = [];
  for (const raw of enabled){
    const id = raw.trim();
    if (!PROVIDER_ID_PATTERN.test(id)) {
      throw new Error(`The coding-agent providers the image build was given include ` + `${JSON.stringify(raw)}, which is not a lower-case provider id.`);
    }
    if (ids.includes(id)) {
      throw new Error(`The coding-agent providers the image build was given list ` + `${JSON.stringify(id)} twice.`);
    }
    ids.push(id);
  }
  if (ids.length === 0) {
    throw new Error(`The coding-agent providers the image build was given enable no ` + `provider — the image would install no coding agent. Supported ` + `providers: ${agentProviderIds().join(", ")}.`);
  }
  const value = ids.join(",");
  return value === imageDefault.join(",") ? undefined : value;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9hZ2VudF9wcm92aWRlci50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFRoZSBjb2RpbmctYWdlbnQgcHJvdmlkZXIgc2VhbSAoSXNzdWUgIzQwNjcsIHBhcmVudCAjNDA2MCkuXG4gKlxuICogQSBwcm92aWRlciBpcyBkZXNjcmliZWQgaGVyZSBhcyBkYXRhIOKAlCBpdHMgaWQsIHRoZSBiaW5hcnkgdGhlIGNvbnRhaW5lclxuICogaW1hZ2UgaW5zdGFsbHMsIHRoZSBjcmVkZW50aWFsIG1hdGVyaWFsIGl0IG5lZWRzIGluc2lkZSB0aGUgVmliZSBjcmVkZW50aWFsXG4gKiBkaXJlY3RvcnksIHRoZSBlbnZpcm9ubWVudCBpdHMgY2hpbGQgc3VicHJvY2VzcyByZWNlaXZlcywgYW5kIGhvdyBpdCBpc1xuICogaW52b2tlZC4gVGhlIHdvcmtlciByZXNvbHZlcyBhbGwgZm91ciB0aHJvdWdoIHRoaXMgbW9kdWxlLCBzbyBhZGRpbmcgdGhlXG4gKiBuZXh0IHByb3ZpZGVyIGlzIGEgbmV3IGRlc2NyaXB0b3IgcGx1cyBhIG5ld1xuICogYGNvbnRhaW5lci9wcm92aWRlcnMvPGlkPi5zaGAgZnJhZ21lbnQg4oCUIG5vdCBhIHJlZGVzaWduIG9mIGNvbnRhaW5tZW50LCB0aGVcbiAqIGxhdW5jaGVyJ3MgbW91bnQgY29uc3RydWN0aW9uLCBvciB0aGUgY3JlZGVudGlhbCBwcmVmbGlnaHQuXG4gKlxuICogRWFjaCBwcm92aWRlciBpcyByZWdpc3RlcmVkIGZyb20gdGhlIG1vZHVsZXMgdGhhdCBhbHJlYWR5IG93biBpdHMgYmVoYXZpb3VyXG4gKiDigJQgQ2xhdWRlIGZyb20gYGNsYXVkZV9leGVjdXRvci50c2AgLyBgY2xhdWRlX2Vudi50c2AgLyBgY2xhdWRlX2F1dGgudHNgIC9cbiAqIGBzZXNzaW9uX3Jlc3VtZS50c2AsIENvZGV4IGZyb20gYGNvZGV4X2V4ZWN1dG9yLnRzYCAvIGBjb2RleF9lbnYudHNgIC9cbiAqIGBjb2RleF9hdXRoLnRzYCAoSXNzdWUgIzQxMDYpLCBHZW1pbmkgZnJvbSBgZ2VtaW5pX2V4ZWN1dG9yLnRzYCAvXG4gKiBgZ2VtaW5pX2Vudi50c2AgLyBgZ2VtaW5pX2F1dGgudHNgIChJc3N1ZSAjNDEwNyksIERlZXBTZWVrIGZyb21cbiAqIGBkZWVwc2Vla19leGVjdXRvci50c2AgLyBgZGVlcHNlZWtfZW52LnRzYCAvIGBkZWVwc2Vla19hdXRoLnRzYFxuICogKElzc3VlICM0MTQpIOKAlCByYXRoZXIgdGhhbiByZXN0YXRpbmcgYW55IG9mIGl0LCBzbyB0aGUgaW52b2NhdGlvbiB0aGUgc2VhbVxuICogcHJvZHVjZXMgaXMgdGhlIGludm9jYXRpb24gdGhlIHdvcmtlciB1c2VkIGJlZm9yZSB0aGUgc2VhbSBleGlzdGVkIGFuZCBub1xuICogQ0xJIGtub3dsZWRnZSBhY2N1bXVsYXRlcyBpbiB0aGlzIHJlZ2lzdHJ5LlxuICpcbiAqIEZhaWwgbG91ZCAoSXNzdWUgIzMyMzQpOiBhbiB1bmtub3duIHByb3ZpZGVyIGlkIHRocm93cyB3aXRoIHRoZSBzdXBwb3J0ZWRcbiAqIGlkcyBuYW1lZCDigJQgbmV2ZXIgYSBzaWxlbnQgZmFsbCBiYWNrIHRvIHRoZSBkZWZhdWx0LCB3aGljaCB3b3VsZCBydW4gdGhlXG4gKiB3cm9uZyBhZ2VudCB1bmRlciBhbiBvcGVyYXRvcidzIGV4cGxpY2l0IHNlbGVjdGlvbi5cbiAqXG4gKiBgYGBtZXJtYWlkXG4gKiBmbG93Y2hhcnQgTFJcbiAqICAgICBDW1wiLmNvbmZpZy5qc29uPGJyLz5hZ2VudF9wcm92aWRlclwiXSAtLT4gUltcInJlc29sdmVBZ2VudFByb3ZpZGVySWQoKVwiXVxuICogICAgIEVbXCJWSUJFX0FHRU5UX1BST1ZJREVSXCJdIC0tPiBSXG4gKiAgICAgUiAtLT4gRFtcIkFnZW50UHJvdmlkZXJEZXNjcmlwdG9yXCJdXG4gKiAgICAgRCAtLT4gSVtcImludm9jYXRpb248YnIvPihjbGF1ZGVfcnVubmVyKVwiXVxuICogICAgIEQgLS0+IEtbXCJjcmVkZW50aWFsczxici8+KGNyZWRlbnRpYWxfcHJlZmxpZ2h0KVwiXVxuICogICAgIEQgLS0+IE1bXCJtb3VudHM8YnIvPihjb250YWluZXJfbGF1bmNoKVwiXVxuICogICAgIEQgLS0+IEZbXCJpbnN0YWxsIGZyYWdtZW50PGJyLz4oY29udGFpbmVyL3Byb3ZpZGVycylcIl1cbiAqIGBgYFxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuaW1wb3J0IHsgcmVzb2x2ZUNsYXVkZUVmZm9ydCwgcmVzb2x2ZUNsYXVkZU1vZGVsIH0gZnJvbSBcIi4vY2xhdWRlX2V4ZWN1dG9yLnRzXCI7XG5pbXBvcnQge1xuICByZXNvbHZlU2V0dGluZyxcbiAgd2FybkRlcHJlY2F0ZWRFbnZTZXR0aW5nLFxufSBmcm9tIFwiLi9jb25maWdfcHJlY2VkZW5jZS50c1wiO1xuaW1wb3J0IHR5cGUgeyBFbnZMb29rdXAgfSBmcm9tIFwiLi9lbnZfbG9va3VwLnRzXCI7XG5pbXBvcnQge1xuICBDT05UQUlORVJfSU1BR0VfU1RBTVBfRU5WLFxuICBydW5uaW5nSW5Db250YWluZXJJbWFnZSxcbn0gZnJvbSBcIi4vY29udGFpbmVyX3N0YW1wLnRzXCI7XG5pbXBvcnQgeyBnZXRDaGVhcGVyTW9kZWwgfSBmcm9tIFwiLi9jb25maWdfZGVmYXVsdHMudHNcIjtcbmltcG9ydCB7XG4gIGJ1aWxkQ2xhdWRlQ2hpbGRFbnYsXG4gIENMQVVERV9FTlZfREVOWUxJU1QsXG4gIENMQVVERV9FTlZfU0VDUkVUX0FMTE9XTElTVCxcbn0gZnJvbSBcIi4vY2xhdWRlX2Vudi50c1wiO1xuaW1wb3J0IHtcbiAgY2xhdWRlQXV0aEFjdGlvbmFibGVNZXNzYWdlLFxuICBpc0NsYXVkZUF1dGhFcnJvcixcbn0gZnJvbSBcIi4vY2xhdWRlX2F1dGgudHNcIjtcbmltcG9ydCB7IHJlc29sdmVDbGF1ZGVNYXhUdXJucyB9IGZyb20gXCIuL2NsYXVkZV90dXJuX2xpbWl0LnRzXCI7XG5pbXBvcnQgdHlwZSB7IEFnZW50T3V0cHV0QWRhcHRlciB9IGZyb20gXCIuL2FnZW50X291dHB1dC50c1wiO1xuaW1wb3J0IHtcbiAgQ0xBVURFX09VVFBVVF9BREFQVEVSLFxuICBERUVQU0VFS19PVVRQVVRfQURBUFRFUixcbn0gZnJvbSBcIi4vY2xhdWRlX291dHB1dF9hZGFwdGVyLnRzXCI7XG5pbXBvcnQgeyBDT0RFWF9PVVRQVVRfQURBUFRFUiB9IGZyb20gXCIuL2NvZGV4X291dHB1dF9hZGFwdGVyLnRzXCI7XG5pbXBvcnQge1xuICBidWlsZFNlc3Npb25SZXN1bWVBcmdzLFxuICBidWlsZFNlc3Npb25SZXN1bWVGbGFncyxcbiAgY29kZXhSZXN1bWVTZXNzaW9uSWQsXG4gIHNlc3Npb25SZXN1bWVGb3JQcm92aWRlcixcbiAgdHlwZSBTZXNzaW9uUmVzdW1lU3RhdGUsXG59IGZyb20gXCIuL3Nlc3Npb25fcmVzdW1lLnRzXCI7XG5pbXBvcnQge1xuICBhZGFwdENvZGV4QWZ0ZXJNb2RlbFJlZnVzYWwsXG4gIGFwcGx5Q29kZXhNb2RlbEFkYXB0YXRpb24sXG4gIGJ1aWxkQ29kZXhBcmdzLFxuICBidWlsZENvZGV4TWNwQ29uZmlnQXJncyxcbiAgY29kZXhBbHRlcm5hdGl2ZU1vZGVscyxcbiAgY29tcG9zZUNvZGV4UHJvbXB0LFxuICByZXNvbHZlQ29kZXhFZmZvcnQsXG4gIHJlc29sdmVDb2RleE1vZGVsLFxufSBmcm9tIFwiLi9jb2RleF9leGVjdXRvci50c1wiO1xuaW1wb3J0IHtcbiAgYnVpbGRJc29sYXRlZENvZGV4Q2hpbGRFbnYsXG4gIENPREVYX0VOVl9ERU5ZTElTVCxcbiAgQ09ERVhfRU5WX1NFQ1JFVF9BTExPV0xJU1QsXG59IGZyb20gXCIuL2NvZGV4X2Vudi50c1wiO1xuaW1wb3J0IHtcbiAgQ09ERVhfQVBJX0tFWV9FTlZfVkFSUyxcbiAgQ09ERVhfQ1JFREVOVElBTF9FTlZfVkFSUyxcbiAgQ09ERVhfSE9NRV9FTlZfVkFSLFxuICBjb2RleEF1dGhBY3Rpb25hYmxlTWVzc2FnZSxcbiAgaXNDb2RleEF1dGhFcnJvcixcbn0gZnJvbSBcIi4vY29kZXhfYXV0aC50c1wiO1xuaW1wb3J0IHtcbiAgaW5pdGlhbGlzZUNvZGV4SG9tZSxcbiAgcmVzb2x2ZUNvZGV4QXV0aE1vZGUsXG59IGZyb20gXCIuL2NvZGV4X2F1dGhfbW9kZS50c1wiO1xuaW1wb3J0IHtcbiAgYnVpbGRHZW1pbmlBcmdzLFxuICByZXNvbHZlR2VtaW5pRWZmb3J0LFxuICByZXNvbHZlR2VtaW5pTW9kZWwsXG59IGZyb20gXCIuL2dlbWluaV9leGVjdXRvci50c1wiO1xuaW1wb3J0IHtcbiAgYnVpbGRHZW1pbmlDaGlsZEVudixcbiAgR0VNSU5JX0VOVl9ERU5ZTElTVCxcbiAgR0VNSU5JX0VOVl9TRUNSRVRfQUxMT1dMSVNULFxufSBmcm9tIFwiLi9nZW1pbmlfZW52LnRzXCI7XG5pbXBvcnQge1xuICBHRU1JTklfQ1JFREVOVElBTF9FTlZfVkFSUyxcbiAgZ2VtaW5pQXV0aEFjdGlvbmFibGVNZXNzYWdlLFxuICBpc0dlbWluaUF1dGhFcnJvcixcbn0gZnJvbSBcIi4vZ2VtaW5pX2F1dGgudHNcIjtcbmltcG9ydCB7XG4gIGFwcGx5RGVlcFNlZWtNb2RlbEFkYXB0YXRpb24sXG4gIGRlZXBTZWVrQWx0ZXJuYXRpdmVNb2RlbHMsXG4gIGRlZXBTZWVrU2VydmVkTW9kZWxTYXRpc2ZpZXMsXG4gIHJlc29sdmVEZWVwU2Vla0VmZm9ydCxcbiAgcmVzb2x2ZURlZXBTZWVrTW9kZWwsXG4gIHdhcm5EZWVwU2Vla0FnZW50c1Vuc3VwcG9ydGVkLFxuICB3YXJuRGVlcFNlZWtFZmZvcnRVbnN1cHBvcnRlZCxcbn0gZnJvbSBcIi4vZGVlcHNlZWtfZXhlY3V0b3IudHNcIjtcbmltcG9ydCB7XG4gIGJ1aWxkRGVlcFNlZWtDaGlsZEVudixcbiAgREVFUFNFRUtfRU5WX0RFTllMSVNULFxuICBERUVQU0VFS19FTlZfU0VDUkVUX0FMTE9XTElTVCxcbn0gZnJvbSBcIi4vZGVlcHNlZWtfZW52LnRzXCI7XG5pbXBvcnQge1xuICBERUVQU0VFS19DUkVERU5USUFMX0VOVl9WQVJTLFxuICBkZWVwU2Vla0F1dGhBY3Rpb25hYmxlTWVzc2FnZSxcbiAgaXNEZWVwU2Vla0F1dGhFcnJvcixcbn0gZnJvbSBcIi4vZGVlcHNlZWtfYXV0aC50c1wiO1xuaW1wb3J0IHR5cGUgeyBSZXBvQ29uZmlnIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbi8qKiBEaXJlY3RvcnksIHJlbGF0aXZlIHRvIGBjb250YWluZXIvYCwgaG9sZGluZyB0aGUgcGVyLXByb3ZpZGVyIGZyYWdtZW50cy4gKi9cbmV4cG9ydCBjb25zdCBQUk9WSURFUl9GUkFHTUVOVF9ESVIgPSBcInByb3ZpZGVyc1wiO1xuXG4vKiogYC5jb25maWcuanNvbmAga2V5IHRoYXQgc2VsZWN0cyB0aGUgYWN0aXZlIHByb3ZpZGVyLiAqL1xuZXhwb3J0IGNvbnN0IEFHRU5UX1BST1ZJREVSX0NPTkZJR19LRVkgPSBcImFnZW50X3Byb3ZpZGVyXCI7XG5cbi8qKiBFbnZpcm9ubWVudCB2YXJpYWJsZSB0aGF0IG92ZXJyaWRlcyB0aGUgY29uZmlndXJlZCBwcm92aWRlci4gKi9cbmV4cG9ydCBjb25zdCBBR0VOVF9QUk9WSURFUl9FTlYgPSBcIlZJQkVfQUdFTlRfUFJPVklERVJcIjtcblxuLyoqXG4gKiBgLmNvbmZpZy5qc29uYCBrZXkgbGlzdGluZyBldmVyeSBwcm92aWRlciBlbmFibGVkIGZvciBhIHJ1biAoSXNzdWUgIzQxMDgpLlxuICpcbiAqIFRoZSBlbmFibGVkIHNldCBkZWNpZGVzIHdoaWNoIHZlbmRvcnMnIGNyZWRlbnRpYWxzIGFyZSBwcm92aXNpb25lZCwgY2hlY2tlZFxuICogYnkgdGhlIHByZWZsaWdodCBhbmQgbW91bnRlZCBpbnRvIHRoZSBjb250YWluZXIuIEl0IGRlZmF1bHRzIHRvIHRoZSBhY3RpdmVcbiAqIHByb3ZpZGVyIGFsb25lLCBzbyBhIGRlcGxveW1lbnQgdGhhdCBuZXZlciBzZXRzIGl0IGlzIHVuY2hhbmdlZC5cbiAqL1xuZXhwb3J0IGNvbnN0IEVOQUJMRURfQUdFTlRfUFJPVklERVJTX0NPTkZJR19LRVkgPSBcImFnZW50X3Byb3ZpZGVyc1wiO1xuXG4vKiogRW52aXJvbm1lbnQgdmFyaWFibGUgdGhhdCBvdmVycmlkZXMgdGhlIGVuYWJsZWQgcHJvdmlkZXIgc2V0LiAqL1xuZXhwb3J0IGNvbnN0IEVOQUJMRURfQUdFTlRfUFJPVklERVJTX0VOViA9IFwiVklCRV9BR0VOVF9QUk9WSURFUlNcIjtcblxuLyoqXG4gKiBFbnZpcm9ubWVudCB2YXJpYWJsZSB0aGUgY29udGFpbmVyIGltYWdlIHN0YW1wcyB3aXRoIHRoZSBwcm92aWRlciBzZXQgaXRcbiAqIGluc3RhbGxlZCAoSXNzdWUgIzQxMDUpLlxuICpcbiAqIGBjb250YWluZXIvQ29udGFpbmVyZmlsZWAgYmFrZXMgaXQgZnJvbSB0aGUgYEFHRU5UX1BST1ZJREVSU2AgYnVpbGRcbiAqIGFyZ3VtZW50LCBzbyB0aGUgcnVubmluZyBpbWFnZSByZXBvcnRzIHRoZSBhZ2VudHMgaXQgYWN0dWFsbHkgY2Fycmllc1xuICogcmF0aGVyIHRoYW4gdGhlIHdvcmtlciBhc3N1bWluZyB0aGUgZGVmYXVsdCBzZXQuXG4gKlxuICogVGhlIGNhbm9uaWNhbCBzcGVsbGluZyBsaXZlcyBpbiBgY29udGFpbmVyX3N0YW1wLnRzYCwgd2hpY2ggYWxzbyBvd25zIHRoZVxuICogb25lIHJ1bGUgZm9yIHJlYWRpbmcgaXQgKElzc3VlICMxMjYyKSwgc28gdGhlIHR3byBjYW5ub3QgZHJpZnQuXG4gKi9cbmV4cG9ydCBjb25zdCBJTUFHRV9BR0VOVF9QUk9WSURFUlNfRU5WID0gQ09OVEFJTkVSX0lNQUdFX1NUQU1QX0VOVjtcblxuLyoqXG4gKiBCdWlsZCBhcmd1bWVudCB0aGUgQ29udGFpbmVyZmlsZSBzZWxlY3RzIHRoZSBpbnN0YWxsZWQgc2V0IHdpdGggKCM3MjkpLlxuICpcbiAqIFRoZSBsYXVuY2hlcnMgcGFzcyBpdCBmcm9tIHRoZSBkZXBsb3ltZW50J3MgZW5hYmxlZCBzZXQsIHNvIGEgYC5jb25maWcuanNvbmBcbiAqIHNlbGVjdGluZyBDb2RleCBidWlsZHMgYSBDb2RleCBpbWFnZSBpbnN0ZWFkIG9mIHRha2luZyB0aGUgQ29udGFpbmVyZmlsZSdzXG4gKiBDbGF1ZGUgZGVmYXVsdC5cbiAqL1xuZXhwb3J0IGNvbnN0IEFHRU5UX1BST1ZJREVSU19CVUlMRF9BUkcgPSBcIkFHRU5UX1BST1ZJREVSU1wiO1xuXG4vKipcbiAqIFRoZSBzaGFwZSBldmVyeSBwcm92aWRlciBpZCBoYXM6IHRoZSBpZCBpcyBhbHNvIGEgZmlsZW5hbWVcbiAqIChgY29udGFpbmVyL3Byb3ZpZGVycy88aWQ+LnNoYCkgYW5kIGEgYnVpbGQtYXJndW1lbnQgZWxlbWVudCwgc28gYW55dGhpbmdcbiAqIG91dHNpZGUgdGhpcyBhbHBoYWJldCBpcyByZWZ1c2VkIHJhdGhlciB0aGFuIHBhc3NlZCBvbi5cbiAqL1xuY29uc3QgUFJPVklERVJfSURfUEFUVEVSTiA9IC9eW2Etel1bYS16MC05LV0qJC87XG5cbi8qKiBUaGUgcHJvdmlkZXIgaWQgQ2xhdWRlIENvZGUgaXMgcmVnaXN0ZXJlZCB1bmRlci4gKi9cbmV4cG9ydCBjb25zdCBDTEFVREVfUFJPVklERVJfSUQgPSBcImNsYXVkZVwiO1xuXG4vKiogVGhlIHByb3ZpZGVyIGlkIHRoZSBPcGVuQUkgQ29kZXggQ0xJIGlzIHJlZ2lzdGVyZWQgdW5kZXIgKElzc3VlICM0MTA2KS4gKi9cbmV4cG9ydCBjb25zdCBDT0RFWF9QUk9WSURFUl9JRCA9IFwiY29kZXhcIjtcblxuLyoqIFRoZSBwcm92aWRlciBpZCB0aGUgR2VtaW5pIENMSSBpcyByZWdpc3RlcmVkIHVuZGVyIChJc3N1ZSAjNDEwNykuICovXG5leHBvcnQgY29uc3QgR0VNSU5JX1BST1ZJREVSX0lEID0gXCJnZW1pbmlcIjtcblxuLyoqXG4gKiBUaGUgcHJvdmlkZXIgaWQgRGVlcFNlZWsgaXMgcmVnaXN0ZXJlZCB1bmRlciAoSXNzdWUgIzQxNCwgcGFyZW50ICMzOTYpLlxuICpcbiAqIERlZXBTZWVrIHNoaXBzIG5vIENMSSBvZiBpdHMgb3duOiBpdCBpcyBjYXJyaWVkIG9uIHRoZSBDbGF1ZGUgQ29kZSBDTElcbiAqIHBvaW50ZWQgYXQgRGVlcFNlZWsncyBBbnRocm9waWMtY29tcGF0aWJsZSBlbmRwb2ludCwgaW5zdGFsbGVkIHVuZGVyIGl0cyBvd25cbiAqIGNvbW1hbmQgbmFtZSBzbyBhIGBjbGF1ZGUsZGVlcHNlZWtgIGltYWdlIGNhcnJpZXMgYm90aC5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRVBTRUVLX1BST1ZJREVSX0lEID0gXCJkZWVwc2Vla1wiO1xuXG4vKiogVGhlIHByb3ZpZGVyIHVzZWQgd2hlbiBuZWl0aGVyIGNvbmZpZ3VyYXRpb24gbm9yIGVudmlyb25tZW50IHNlbGVjdHMgb25lLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQUdFTlRfUFJPVklERVJfSUQgPSBDTEFVREVfUFJPVklERVJfSUQ7XG5cbi8qKlxuICogQSBwcm92aWRlciB0aGF0IGFjY2VwdHMgTU9SRSB0aGFuIG9uZSBjcmVkZW50aWFsIGZpbGUgKElzc3VlICM5MTcsIHBhcmVudFxuICogIzkwMikuXG4gKlxuICogT25seSBhIHZlbmRvciB3aG9zZSBzdWJzY3JpcHRpb25zIGNhbiBiZSBoZWxkIHNldmVyYWwgYXQgYSB0aW1lIGVhcm5zIGFcbiAqIHBvb2w6IGFuIG9wZXJhdG9yIHdpdGggdHdvIENsYXVkZSBzdWJzY3JpcHRpb25zIHdhbnRzIHRoZSB3b3JrZXIgdG8gc3BlbmRcbiAqIHRoZW0gZXZlbmx5LCB3aGljaCBuZWVkcyBldmVyeSB0b2tlbiB2aXNpYmxlIGF0IG9uY2UuIEEgdmVuZG9yIHdpdGhvdXQgdGhpc1xuICogZmllbGQga2VlcHMgZXhhY3RseSBvbmUgY3JlZGVudGlhbCBmaWxlLCBzbyByZWdpc3RlcmluZyBhIHNlY29uZCBwcm92aWRlclxuICogZ2FpbnMgbm90aGluZyBpdCBkaWQgbm90IGFzayBmb3IuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQWdlbnRQcm92aWRlclRva2VuUG9vbCB7XG4gIC8qKiBPcGVyYXRvci1mYWNpbmcgZmlsZW5hbWUgcGF0dGVybiwgZS5nLiBgcHJvdmlkZXItKi5lbnZgLiAqL1xuICBmaWxlUGF0dGVybjogc3RyaW5nO1xuICAvKipcbiAgICogTWF0Y2hlcyBhbiBBRERJVElPTkFMIGNyZWRlbnRpYWwgZmlsZSdzIG5hbWUsIGNhcHR1cmluZyBpdHMgb3JkaW5hbCBpblxuICAgKiBncm91cCAxIHNvIGRpc2NvdmVyeSBjYW4gb3JkZXIgdGhlIHBvb2wgbnVtZXJpY2FsbHkgcmF0aGVyIHRoYW4gYnkgdGhlXG4gICAqIHN0cmluZyBvcmRlciBhIGRpcmVjdG9yeSBsaXN0aW5nIGhhcHBlbnMgdG8gcmV0dXJuIChgcHJvdmlkZXItMTAuZW52YFxuICAgKiBzb3J0cyBiZWZvcmUgYHByb3ZpZGVyLTIuZW52YCBhcyB0ZXh0KS5cbiAgICovXG4gIGZpbGVNYXRjaDogUmVnRXhwO1xuICAvKipcbiAgICogVGhlIGNyZWRlbnRpYWwgdmFyaWFibGVzIHdob3NlIGZpbGVzIGpvaW4gdGhlIHNlbGVjdGlvbiBwb29sIOKAlCB0aGVcbiAgICogc3Vic2NyaXB0aW9uIE9BdXRoIHRva2Vucy4gQSBmaWxlIGNhcnJ5aW5nIGFueSBvdGhlciByZWNvZ25pc2VkIHZhcmlhYmxlXG4gICAqIChhIG1ldGVyZWQgYEFOVEhST1BJQ19BUElfS0VZYCkgaXMgc3RpbGwgYSB2YWxpZCBjcmVkZW50aWFsLCBpdCBzaW1wbHlcbiAgICogaGFzIG5vIGJ1ZGdldCB0byBjb21wYXJlLCBzbyBpdCBzdGF5cyBvbiB0aGUgc2luZ2xlLWNyZWRlbnRpYWwgcGF0aC5cbiAgICovXG4gIGVudlZhcnM6IHJlYWRvbmx5IHN0cmluZ1tdO1xufVxuXG4vKiogV2hhdCBhIGJpbGxpbmcgY2xhc3NpZmljYXRpb24gaXMgYWxsb3dlZCB0byByZWFkIChJc3N1ZSAjMTkyMykuICovXG5leHBvcnQgaW50ZXJmYWNlIEFnZW50UHJvdmlkZXJCaWxsaW5nQ29udGV4dCB7XG4gIC8qKiBUaGUgd29ya2VyJ3Mgd29yayBkaXJlY3RvcnksIGZvciBzdGF0ZSBrZXB0IGJlc2lkZSBpdC4gKi9cbiAgcmVhZG9ubHkgd29ya0Rpcjogc3RyaW5nO1xuICAvKipcbiAgICogRW52aXJvbm1lbnQgbG9va3VwLiBBIGRlc2NyaXB0b3IgaG9vayBhbHdheXMgcmVjZWl2ZXMgb25lIGV4cGxpY2l0bHk7XG4gICAqIHRoZSBzaGFyZWQgY2xhc3NpZmllciBpcyB3aGF0IGRlY2lkZXMgd2hldGhlciB0aGF0IGlzIHRoZSBjYWxsZXIncyBvd25cbiAgICogbG9va3VwIG9yIHRoZSBwcm9jZXNzIGVudmlyb25tZW50LlxuICAgKi9cbiAgcmVhZG9ubHkgZW52OiBFbnZMb29rdXA7XG59XG5cbi8qKiBBIGJpbGxpbmcgbW9kZSBhIHByb3ZpZGVyIHByb3ZlZCwgYW5kIHRoZSBsb2ctc2FmZSBsYWJlbCB0aGF0IHByb3ZlcyBpdC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQWdlbnRQcm92aWRlckJpbGxpbmdQcm9vZiB7XG4gIC8qKlxuICAgKiBgdW5rbm93bmAgaXMgaG93IGEgcHJvYmUgcmVwb3J0cyB0aGF0IGl0ICoqbG9va2VkIGFuZCBmYWlsZWQqKiDigJQgYVxuICAgKiBjb3JydXB0IGBhdXRoLmpzb25gLCBub3QgYW4gYWJzZW50IG9uZS4gSXQgY2FycmllcyBhIHJlYXNvbiBzbyB0aGUgZmF1bHRcbiAgICogcmVhY2hlcyB0aGUgb3BlcmF0b3IgaW5zdGVhZCBvZiBiZWluZyBmbGF0dGVuZWQgaW50byB0aGUgc2FtZSBzaWxlbmNlIGFzXG4gICAqIGEgaG9zdCB0aGF0IHNpbXBseSBuZXZlciBsb2dnZWQgaW4sIGFuZCBpdCBkb2VzIG5vdCBzZXR0bGUgdGhlIHF1ZXN0aW9uOlxuICAgKiB0aGUgY2xhc3NpZmllciBzdGlsbCBjb25zdWx0cyB0aGUgZGVjbGFyZWQgbWV0ZXJlZCB2YXJpYWJsZXMgYWZ0ZXIgaXQuXG4gICAqL1xuICByZWFkb25seSBtb2RlOiBcImZpeGVkLXN1YnNjcmlwdGlvblwiIHwgXCJtZXRlcmVkXCIgfCBcInVua25vd25cIjtcbiAgLyoqIEEgdmFyaWFibGUgTkFNRSBvciBhIHN0YXRlIGxhYmVsLiBOZXZlciBhIGNyZWRlbnRpYWwgdmFsdWUuICovXG4gIHJlYWRvbmx5IHJlYXNvbjogc3RyaW5nO1xufVxuXG4vKipcbiAqIEhvdyBvbmUgcHJvdmlkZXIncyBjcmVkZW50aWFscyBhcmUgYmlsbGVkIChJc3N1ZSAjMTkyMykuXG4gKlxuICogVmliZUNvZGVyJ3Mgcm91dGluZyBwb2xpY3kgaXMgZml4ZWQtcHJpY2Ugc3Vic2NyaXB0aW9ucyBvbmx5LCBzbyBldmVyeVxuICogcHJvdmlkZXIgc3RhdGVzIHdoaWNoIG9mIGl0cyBjcmVkZW50aWFscyBwcm92ZSBhIHN1YnNjcmlwdGlvbiBhbmQgd2hpY2hcbiAqIHByb3ZlIG1ldGVyZWQsIHBlci10b2tlbiBzcGVuZC4gRGVjbGFyaW5nIGl0IGhlcmUgaXMgd2hhdCBsZXRzIHRoZSBzaGFyZWRcbiAqIGNsYXNzaWZpZXIgYW5zd2VyIHRoZSBxdWVzdGlvbiBmb3IgYSB2ZW5kb3IgaXQga25vd3Mgbm90aGluZyBhYm91dCwgaW5zdGVhZFxuICogb2YgZWFjaCByb3V0aW5nIHBhdGggZ3Jvd2luZyBpdHMgb3duIGBpZiAocHJvdmlkZXJJZCA9PT0gXCJjbGF1ZGVcIilgIGNoYWluLlxuICpcbiAqIEEgcHJvdmlkZXIgdGhhdCBwcm92ZXMgbmVpdGhlciBpcyBgdW5rbm93bmAg4oCUIGFuZCB1bmtub3duIGlzIG5ldmVyIHRyZWF0ZWRcbiAqIGFzIGZpeGVkLXByaWNlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFnZW50UHJvdmlkZXJCaWxsaW5nIHtcbiAgLyoqXG4gICAqIFZhcmlhYmxlcyB3aG9zZSBub24tYmxhbmsgcHJlc2VuY2UgcHJvdmVzIGEgZml4ZWQtcHJpY2Ugc3Vic2NyaXB0aW9uLlxuICAgKiBFbXB0eSBtZWFucyBubyBlbnZpcm9ubWVudCB2YXJpYWJsZSBjYW4gcHJvdmUgb25lIGZvciB0aGlzIHByb3ZpZGVyLlxuICAgKi9cbiAgcmVhZG9ubHkgc3Vic2NyaXB0aW9uRW52VmFyczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBWYXJpYWJsZXMgd2hvc2Ugbm9uLWJsYW5rIHByZXNlbmNlIHByb3ZlcyBtZXRlcmVkLCBwZXItdG9rZW4gYmlsbGluZy4gKi9cbiAgcmVhZG9ubHkgbWV0ZXJlZEVudlZhcnM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKipcbiAgICogQmlsbGluZyBzdGF0ZSB0aGlzIHByb3ZpZGVyIGtlZXBzICoqb3V0c2lkZSoqIHRoZSBlbnZpcm9ubWVudCDigJQgQ29kZXgnc1xuICAgKiBwZXJzaXN0ZW50IENoYXRHUFQgbG9naW4gdW5kZXIgYENPREVYX0hPTUVgLiBDb25zdWx0ZWQgYmVmb3JlIHRoZVxuICAgKiBkZWNsYXJlZCBtZXRlcmVkIHZhcmlhYmxlcywgc28gYSBwcm92aWRlciB3aG9zZSBDTEkgZ2l2ZXMgYW4gQVBJIGtleVxuICAgKiBwcmVjZWRlbmNlIGNhbiBzYXkgc28uIEFic2VudCBtZWFucyB0aGUgZGVjbGFyZWQgdmFyaWFibGVzIGFyZSB0aGUgb25seVxuICAgKiBwcm9vZjsgYHVuZGVmaW5lZGAgbWVhbnMgdGhpcyBwcm9iZSBwcm92ZWQgbm90aGluZy4gVGhlIHByb2JlIG11c3QgcmVhZFxuICAgKiBvbmx5IHRoZSBob21lIHRoZSBjaGlsZCBpcyBhY3R1YWxseSBnaXZlbiwgc28gYSBwcm92aWRlciB3aG9zZSBjaGlsZFxuICAgKiBnZXRzIG5vIGhvbWUgbWF5IGFuc3dlciBgdW5kZWZpbmVkYCByYXRoZXIgdGhhbiBndWVzcyBvbmUuXG4gICAqL1xuICByZXNvbHZlU3RvcmVkQmlsbGluZz8oXG4gICAgY29udGV4dDogQWdlbnRQcm92aWRlckJpbGxpbmdDb250ZXh0LFxuICApOiBBZ2VudFByb3ZpZGVyQmlsbGluZ1Byb29mIHwgdW5kZWZpbmVkO1xufVxuXG4vKiogV2hlcmUgYSBwcm92aWRlcidzIGNyZWRlbnRpYWxzIGxpdmUgaW5zaWRlIHRoZSBWaWJlIGNyZWRlbnRpYWwgZGlyZWN0b3J5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBZ2VudFByb3ZpZGVyQ3JlZGVudGlhbHMge1xuICAvKiogU3ViLWRpcmVjdG9yeSBuYW1lLCBlLmcuIGBjbGF1ZGVgLiAqL1xuICBzdWJkaXI6IHN0cmluZztcbiAgLyoqIENyZWRlbnRpYWwgZmlsZSBpbnNpZGUgdGhhdCBzdWItZGlyZWN0b3J5LCBlLmcuIGBwcm92aWRlci5lbnZgLiAqL1xuICBmaWxlOiBzdHJpbmc7XG4gIC8qKiBFbnZpcm9ubWVudCB2YXJpYWJsZXMgdGhhdCBjYXJyeSBhIHVzYWJsZSBjcmVkZW50aWFsLiAqL1xuICBlbnZWYXJzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIE5vbi1zZWNyZXQgcnVudGltZSBzZWxlY3RvcnMsIHNlcGFyYXRlIGZyb20gc2V0dXAncyBwYXN0ZWFibGUgY3JlZGVudGlhbHMuICovXG4gIHN0YXRlRW52VmFycz86IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogUHJlcGFyZSBkdXJhYmxlIGxvZ2luIHN0YXRlIGFmdGVyIHRoZSBjcmVkZW50aWFsIGVudmlyb25tZW50IGlzIGxvYWRlZC4gKi9cbiAgaW5pdGlhbGlzZVN0YXRlPzogKGRpcmVjdG9yeTogc3RyaW5nLCBlbnY6IEVudkxvb2t1cCkgPT4gUHJvbWlzZTx2b2lkPjtcbiAgLyoqIFRoZSBgc2V0dXAuc2hgIHZhcmlhYmxlIHRoYXQgcHJvdmlzaW9ucyB0aGUgY3JlZGVudGlhbCBmaWxlLiAqL1xuICBwcm92aXNpb25FbnZWYXI6IHN0cmluZztcbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgY3JlZGVudGlhbCBmaWxlcyBiZXNpZGUge0BsaW5rIGZpbGV9LCB3aGVuIHRoaXMgcHJvdmlkZXJcbiAgICogc3VwcG9ydHMgYSBwb29sIG9mIHRva2VucyAoSXNzdWUgIzkxNykuIEFic2VudCDigJQgdGhlIGRlZmF1bHQg4oCUIG1lYW5zIHRoZVxuICAgKiBwcm92aWRlciBoYXMgZXhhY3RseSBvbmUgY3JlZGVudGlhbCBmaWxlLCBhcyBldmVyeSB2ZW5kb3IgZGlkIGJlZm9yZS5cbiAgICovXG4gIHRva2VuUG9vbD86IEFnZW50UHJvdmlkZXJUb2tlblBvb2w7XG59XG5cbi8qKiBXaGF0IHRoZSBwcm92aWRlcidzIGNoaWxkIHN1YnByb2Nlc3MgbWF5IGFuZCBtYXkgbm90IGluaGVyaXQuICovXG5leHBvcnQgaW50ZXJmYWNlIEFnZW50UHJvdmlkZXJFbnZpcm9ubWVudCB7XG4gIC8qKiBTZWNyZXQtc2hhcGVkIG5hbWVzIHRoZSBjaGlsZCBnZW51aW5lbHkgbmVlZHMuICovXG4gIHNlY3JldEFsbG93bGlzdDogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBOYW1lcyB0aGUgY2hpbGQgbXVzdCBuZXZlciBpbmhlcml0LiAqL1xuICBkZW55bGlzdDogcmVhZG9ubHkgc3RyaW5nW107XG59XG5cbi8qKiBIb3cgdGhlIGNvbnRhaW5lciBpbWFnZSBpbnN0YWxscyB0aGUgcHJvdmlkZXIgYmluYXJ5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBZ2VudFByb3ZpZGVySW5zdGFsbCB7XG4gIC8qKiBGcmFnbWVudCBwYXRoIHJlbGF0aXZlIHRvIGBjb250YWluZXIvYCwgZS5nLiBgcHJvdmlkZXJzL2NsYXVkZS5zaGAuICovXG4gIGZyYWdtZW50OiBzdHJpbmc7XG59XG5cbi8qKlxuICogT25lIHN1Yi1hZ2VudCB0aGUgQ2xhdWRlIENMSSBtYXkgZGVsZWdhdGUgdG8sIGFzIGAtLWFnZW50c2AgZGVmaW5lcyBpdFxuICogKElzc3VlICMyMzQyKS5cbiAqXG4gKiBUaGUgQ0xJIHRha2VzIGEgSlNPTiBvYmplY3Qga2V5ZWQgYnkgc3ViLWFnZW50IG5hbWU7IHRoaXMgaXMgb25lIHZhbHVlIGluXG4gKiB0aGF0IG9iamVjdC4gTmFtaW5nIGEgYG1vZGVsYCBoZXJlIGlzIHdoYXQgbGV0cyBhIHJ1biBzcGxpdCBpdHMgd29yayBhY3Jvc3NcbiAqIHR3byB0aWVycyDigJQgYW4gYWR2aXNvciBvbiB0aGUgcGhhc2UncyBtb2RlbCBkZWxlZ2F0aW5nIHRvIGNoZWFwZXJcbiAqIGV4ZWN1dG9ycyDigJQgaW5zdGVhZCBvZiBldmVyeSBzdWItYWdlbnQgaW5oZXJpdGluZyB0aGUgcGhhc2UncyBtb2RlbCwgd2hpY2hcbiAqIGlzIHdoYXQgYW4gaW52b2NhdGlvbiBjYXJyeWluZyBubyBgLS1hZ2VudHNgIGdldHMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQWdlbnREZWZpbml0aW9uIHtcbiAgLyoqIFdoYXQgdGhlIHN1Yi1hZ2VudCBpcyBmb3I7IHRoZSBDTEkgc2hvd3MgaXQgd2hlbiByb3V0aW5nIHdvcmsuICovXG4gIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3ViLWFnZW50J3Mgb3duIHN5c3RlbSBwcm9tcHQuICovXG4gIHByb21wdDogc3RyaW5nO1xuICAvKiogTW9kZWwgaWQgb3IgdGllciBhbGlhcyB0aGUgc3ViLWFnZW50IHJ1bnMgb247IGFic2VudCDihpIgaXQgaW5oZXJpdHMuICovXG4gIG1vZGVsPzogc3RyaW5nO1xuICAvKiogUmVhc29uaW5nIGVmZm9ydCB0aGUgc3ViLWFnZW50IHJ1bnMgYXQ7IGFic2VudCDihpIgdGhlIENMSSdzIGRlZmF1bHQuICovXG4gIGVmZm9ydD86IHN0cmluZztcbiAgLyoqIFRoZSBvbmx5IHRvb2xzIHRoZSBzdWItYWdlbnQgbWF5IHVzZTsgYWJzZW50IOKGkiBpdCBpbmhlcml0cyB0aGUgc2V0LiAqL1xuICB0b29scz86IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogVG9vbHMgdGhlIHN1Yi1hZ2VudCBtdXN0IG5vdCB1c2UsIHdoYXRldmVyIGB0b29sc2AgZ3JhbnRzLiAqL1xuICBkaXNhbGxvd2VkVG9vbHM/OiByZWFkb25seSBzdHJpbmdbXTtcbn1cblxuLyoqIE9uZSBpbnZvY2F0aW9uIG9mIHRoZSBwcm92aWRlcidzIENMSS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQWdlbnRJbnZvY2F0aW9uUmVxdWVzdCB7XG4gIC8qKiBFbmZvcmNlZCBzYW5kYm94IGZvciBvcmNoZXN0cmF0b3Itb3duZWQgQ29kZXggcm9sZSBjYWxscy4gKi9cbiAgb3JjaGVzdHJhdGlvblJvbGU/OiBcIm1hbmFnZXJcIiB8IFwiZXhlY3V0b3JcIiB8IFwicmV2aWV3ZXJcIjtcbiAgLyoqIFRoZSB1c2VyIHByb21wdC4gKi9cbiAgcHJvbXB0OiBzdHJpbmc7XG4gIC8qKiBTdGF0aWMgc3lzdGVtIHByb21wdCBwYXNzZWQgc2VwYXJhdGVseSBzbyB0aGUgQ0xJIGNhbiBjYWNoZSBpdC4gKi9cbiAgc3lzdGVtUHJvbXB0Pzogc3RyaW5nO1xuICAvKiogRXhwbGljaXQgbW9kZWwgaWQ7IHdoZW4gYWJzZW50IHRoZSBwaGFzZSByb3V0aW5nIGRlY2lkZXMuICovXG4gIG1vZGVsPzogc3RyaW5nO1xuICAvKiogV29yayBwaGFzZSBkcml2aW5nIG1vZGVsL2VmZm9ydCByb3V0aW5nLiAqL1xuICBwaGFzZT86IHN0cmluZztcbiAgLyoqXG4gICAqIEVudmlyb25tZW50IGxvb2t1cCB0aGUgcGhhc2Ugcm91dGluZyByZWFkcyBpdHMgdmFyaWFibGVzIHRocm91Z2hcbiAgICogKElzc3VlICM5NTcpLiBEZWZhdWx0cyB0byB0aGUgcHJvY2VzcyBlbnZpcm9ubWVudCwgc28gYSBwcm9kdWN0aW9uXG4gICAqIGNhbGxlciBzdXBwbGllcyBub3RoaW5nLlxuICAgKi9cbiAgZW52PzogRW52TG9va3VwO1xuICAvKiogRXhwbGljaXQgcmVhc29uaW5nIGVmZm9ydDsgd2hlbiBhYnNlbnQgdGhlIHBoYXNlIHJvdXRpbmcgZGVjaWRlcy4gKi9cbiAgZWZmb3J0Pzogc3RyaW5nO1xuICAvKipcbiAgICogVG9vbCBuYW1lcyByZXF1ZXN0ZWQgYXMgdW5hdmFpbGFibGUuIENsYXVkZSdzIENMSSBlbmZvcmNlcyB0aGVzZSB0aHJvdWdoXG4gICAqIGAtLWRpc2FsbG93ZWQtdG9vbHNgOyBDb2RleCBhbmQgR2VtaW5pIHJlY2VpdmUgdGhlbSBhcyBwcm9tcHQgdGV4dCBvbmx5LlxuICAgKiBBIGNhbGxlciByZWx5aW5nIG9uIGVuZm9yY2VtZW50IG11c3QgY2hlY2sgdGhpcyBhZGFwdGVyIGFuZCBldmVyeVxuICAgKiBwZXJtaXR0ZWQgZmFsbGJhY2suIFRoaXMgbGlzdCBkb2VzIG5vdCBwcm92aWRlIHByb2Nlc3MsIGZpbGVzeXN0ZW0gb3JcbiAgICogbmV0d29yayBpc29sYXRpb24uXG4gICAqL1xuICBkaXNhbGxvd2VkVG9vbHM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqXG4gICAqIFN0YXJ0IHRoZSBDbGF1ZGUgQ0xJIHdpdGhvdXQgcHJvamVjdCBvciB1c2VyIHNldHRpbmdzIChob29rcykgYW5kIHdpdGhvdXRcbiAgICogTUNQIHNlcnZlcnMgb3RoZXIgdGhhbiBhbiBleHBsaWNpdCBgbWNwQ29uZmlnUGF0aGAgKElzc3VlICM0NjU3KS4gQSBtb2RlbFxuICAgKiB3b3JraW5nIGluIGEgY2hlY2tvdXQgb2YgdW50cnVzdGVkIGNvZGUgbXVzdCBub3QgbG9hZCBhIGAuY2xhdWRlL3NldHRpbmdzLmpzb25gXG4gICAqIGZyb20gaXQ6IGEgaG9vayB0aGVyZSBydW5zIGEgc2hlbGwgY29tbWFuZCBvdXRzaWRlIGV2ZXJ5IHRvb2wgcnVsZS5cbiAgICogQWJzZW50IGVtaXRzIG5vdGhpbmcuIE9ubHkgdGhlIENsYXVkZSBDTEkgdGFrZXMgdGhlc2UgZmxhZ3MuXG4gICAqL1xuICBpc29sYXRlQ2xhdWRlQ29uZmlnPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIFN1Yi1hZ2VudCBkZWZpbml0aW9ucyBoYW5kZWQgdG8gdGhlIENMSSBhcyBgLS1hZ2VudHNgIChJc3N1ZSAjMjM0MiksXG4gICAqIGtleWVkIGJ5IHN1Yi1hZ2VudCBuYW1lLlxuICAgKlxuICAgKiAqKkFic2VudCDigJQgdGhlIGRlZmF1bHQg4oCUIGVtaXRzIG5vIGFyZ3VtZW50IGF0IGFsbCoqLCBzbyBhbiBpbnZvY2F0aW9uXG4gICAqIHRoYXQgZG9lcyBub3QgYXNrIGZvciB0aGUgc3BsaXQgaXMgYnl0ZS1mb3ItYnl0ZSB0aGUgYXJndiB0aGUgd29ya2VyIGhhc1xuICAgKiBhbHdheXMgYnVpbHQgYW5kIGV2ZXJ5IHN1Yi1hZ2VudCBpbmhlcml0cyB0aGUgcGhhc2UncyBtb2RlbC4gT25seSB0aGVcbiAgICogQ2xhdWRlIENMSSB0YWtlcyB0aGUgZmxhZzsgdGhlIG90aGVyIHByb3ZpZGVycycgYXJndiBuZXZlciBjYXJyaWVzIGl0LlxuICAgKiBUaGUgaXNzdWUtcnVuIHBhdGggZGVjaWRlcyB0aGlzIGJlZm9yZSBzcGF3bjogaXQgcmVyb3V0ZXMgdGhlIHJ1biB0b1xuICAgKiBDbGF1ZGUgb3Igc3RyaXBzIHRoZSBkZWZpbml0aW9ucyAoc2VlIGBsaWIvaXNzdWVfcnVuX3Byb3ZpZGVyX2FnZW50cy50c2ApLlxuICAgKiBUaGUgcnVubmVyJ3MgcmVmdXNhbCBvZiBhIG5hdGl2ZSBydW4gdGhhdCBzdGlsbCBhc2tzIGZvciB0aGVtIChJc3N1ZVxuICAgKiAjNDAxMCkgaXMgYSBiYWNrc3RvcDogaXQgZmlyZXMgZm9yIGEgY2FsbGVyIHRoYXQgYnlwYXNzZXMgdGhhdCBwbGFubmVyIGFuZFxuICAgKiB3aGVuIHRoZSByZXRyeSBsYWRkZXIgc3dpdGNoZXMgdG8gYGFnZW50X3Byb3ZpZGVyX2ZhbGxiYWNrYCB3aXRoIGBhZ2VudHNgXG4gICAqIGtlcHQuXG4gICAqL1xuICBhZ2VudHM/OiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBBZ2VudERlZmluaXRpb24+PjtcbiAgLyoqIFNlc3Npb24gY29udGludWl0eSBzdGF0ZSwgd2hlbiBzZXNzaW9uIHJlc3VtZSBpcyBlbmFibGVkLiAqL1xuICBzZXNzaW9uUmVzdW1lU3RhdGU/OiBTZXNzaW9uUmVzdW1lU3RhdGU7XG4gIC8qKlxuICAgKiBNQ1Agc2VydmVyIGNvbmZpZ3VyYXRpb24gZm9yIHRoaXMgcnVuIChJc3N1ZSAjNDM1NSkg4oCUIHRoZSBQbGF5d3JpZ2h0XG4gICAqIGhlYWRsZXNzIGJyb3dzZXIuIENsYXVkZSB0YWtlcyB0aGUgcGF0aCBhcyBgLS1tY3AtY29uZmlnYC4gQ29kZXggaGFzXG4gICAqIG5vIHN1Y2ggZmxhZzogdGhlIGRlc2NyaXB0b3IgdHVybnMgdGhlIHNhbWUgSlNPTiBpbnRvIGAtYyBtY3Bfc2VydmVycy4qYFxuICAgKiBvdmVycmlkZXMgKElzc3VlICMxNzAyKS4gQWJzZW50IOKGkiBubyBicm93c2VyIGNhcGFiaWxpdHkuXG4gICAqL1xuICBtY3BDb25maWdQYXRoPzogc3RyaW5nO1xuICAvKipcbiAgICogRXh0cmEgc2V0dGluZ3MgZm9yIHRoaXMgaW52b2NhdGlvbiwgYXMgdGhlIEpTT04gc3RyaW5nIGAtLXNldHRpbmdzYCB0YWtlc1xuICAgKiBiZXNpZGUgYSBwYXRoIChJc3N1ZSAjMjM0NCksIGFscmVhZHkgc2VyaWFsaXNlZCBmb3IgdGhpcyBvbmUgc3Bhd25cbiAgICogKElzc3VlICMyMzgzKS5cbiAgICpcbiAgICogQ2FycmllcyBob29rcyBhIHJ1biBuZWVkcyB3aXRob3V0IHdyaXRpbmcgYW55dGhpbmcgdG9cbiAgICogYH4vLmNsYXVkZS9zZXR0aW5ncy5qc29uYCwgc28gdGhlIGltYWdlIHN0YXlzIGhvb2stZnJlZTogdGhlIHNwbGl0IHJ1bidzXG4gICAqIGBQcmVUb29sVXNlYCBndWFyZCwgd2hpY2ggZGVuaWVzIHRoZSBhZHZpc29yJ3Mgb3duIGBFZGl0YC9gV3JpdGVgIGNhbGxzXG4gICAqIHdoaWxlIGFsbG93aW5nIGFuIGV4ZWN1dG9yJ3Mg4oCUIGEgZGlzdGluY3Rpb24gYGRpc2FsbG93ZWRUb29sc2AgY2Fubm90XG4gICAqIGV4cHJlc3MsIGJlY2F1c2UgYSB0b29sIHJlbW92ZWQgZnJvbSB0aGUgc2Vzc2lvbiBwb29sIGlzIGdvbmUgZm9yXG4gICAqIHN1Yi1hZ2VudHMgdG9vIOKAlCBhbmQgUlRLJ3MgYFByZVRvb2xVc2VgIEJhc2ggZW50cnkuIEFic2VudCBvciBlbXB0eSDigJQgYVxuICAgKiBydW4gd2l0aCBuZWl0aGVyIHRoZSBzcGxpdCBndWFyZCBub3IgUlRLJ3MgaG9vayAodGhlIHNwbGl0IGlzIG9uIGJ5XG4gICAqIGRlZmF1bHQgZm9yIGBpc3N1ZWAgcnVuczsgYGlzc3VlX2V4ZWN1dG9yX3NwbGl0OiBmYWxzZWAgdHVybnMgaXQgb2ZmKSDigJRcbiAgICogZW1pdHMgbm8gYXJndW1lbnQsIGFuZCB0aGUgYXJndiBpcyB0aGUgb25lIGV2ZXJ5IGhvc3Qgc3Bhd25lZCBiZWZvcmUuXG4gICAqIENvZGV4IHRyYW5zbGF0ZXMgdGhlIGNvbW1hbmQgaG9va3MgaW50byBwZXItc3Bhd24gVE9NTCBvdmVycmlkZXMuXG4gICAqIERlZXBTZWVrIHNoYXJlcyB0aGUgQ2xhdWRlIENMSSBidXQgaXRzIGVuZHBvaW50IGltcGxlbWVudHMgbm8gaG9va3MsXG4gICAqIHNvIHRoYXQgZGVzY3JpcHRvciBzdHJpcHMgdGhlIGZpZWxkOyBHZW1pbmkgZG9lcyBub3QgY29uc3VtZSBpdC5cbiAgICovXG4gIHNldHRpbmdzSnNvbj86IHN0cmluZztcbiAgLyoqXG4gICAqIFRoZSBwcm9tcHQgd2lsbCBiZSB3cml0dGVuIHRvIHRoZSBjaGlsZCdzIHN0ZGluIChJc3N1ZSAjNDM4NSk6IGJ1aWxkXG4gICAqIHRoZSBhcmd2IHNvIHRoZSBDTEkgcmVhZHMgaXQgZnJvbSB0aGVyZSwgYW5kIHB1dCBubyBwcm9tcHQgdGV4dCBpblxuICAgKiBhcmd2LiBPbmx5IG1lYW5pbmdmdWwgZm9yIGEgcHJvdmlkZXIgd2hvc2UgYHByb21wdFRyYW5zcG9ydGAgaXNcbiAgICogYHN0ZGluYDsgcHJvdmlkZXJzIHRoYXQgY2Fubm90IHJlYWQgYSBzdGRpbiBwcm9tcHQgaWdub3JlIGl0LlxuICAgKi9cbiAgcHJvbXB0VmlhU3RkaW4/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIEhvdyB0aGUgcHJvbXB0IHJlYWNoZXMgdGhlIENMSSAoSXNzdWUgIzQzODUpLiBgc3RkaW5gIGlzIHJlcXVpcmVkIGZvciBhXG4gKiBwcm9tcHQgb2YgYW55IHNpemU6IExpbnV4IGNhcHMgb25lIGFyZ3YgZWxlbWVudCBhdCAxMjggS2lCXG4gKiAoTUFYX0FSR19TVFJMRU4pLCBhbmQgYSBncmlsbC1tZSByb3VuZCBvciBhIGxvbmcgaXNzdWUgdGhyZWFkIGV4Y2VlZHNcbiAqIHRoYXQg4oCUIG9ic2VydmVkIGxpdmUgYXMgXCJBcmd1bWVudCBsaXN0IHRvbyBsb25nIChFMkJJRylcIiBhdCBzcGF3biBpblxuICogY29udGFpbmVyIG1vZGUuIGBhcmd2YCBpcyB3aGF0IGEgQ0xJIHRoYXQgY2Fubm90IHJlYWQgYSBzdGRpbiBwcm9tcHRcbiAqIGdldHMsIHdpdGggdGhhdCBsaW1pdCBzdGlsbCBpbiBmb3JjZS5cbiAqL1xuZXhwb3J0IHR5cGUgUHJvbXB0VHJhbnNwb3J0ID0gXCJzdGRpblwiIHwgXCJhcmd2XCI7XG5cbi8qKiBFdmVyeXRoaW5nIHRoZSB3b3JrZXIgbmVlZHMgdG8ga25vdyBhYm91dCBvbmUgY29kaW5nLWFnZW50IHByb3ZpZGVyLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBZ2VudFByb3ZpZGVyRGVzY3JpcHRvciB7XG4gIC8qKiBTdGFibGUgaWQgdXNlZCBpbiBjb25maWd1cmF0aW9uIGFuZCBhcyB0aGUgZnJhZ21lbnQgZmlsZW5hbWUuICovXG4gIGlkOiBzdHJpbmc7XG4gIC8qKiBPcGVyYXRvci1mYWNpbmcgbmFtZS4gKi9cbiAgZGlzcGxheU5hbWU6IHN0cmluZztcbiAgLyoqIEV4ZWN1dGFibGUgdGhlIGltYWdlIGluc3RhbGxzIGFuZCB0aGUgd29ya2VyIHNwYXducy4gKi9cbiAgYmluYXJ5OiBzdHJpbmc7XG4gIGNyZWRlbnRpYWxzOiBBZ2VudFByb3ZpZGVyQ3JlZGVudGlhbHM7XG4gIC8qKiBIb3cgdGhpcyBwcm92aWRlcidzIGNyZWRlbnRpYWxzIGFyZSBiaWxsZWQgKElzc3VlICMxOTIzKS4gKi9cbiAgYmlsbGluZzogQWdlbnRQcm92aWRlckJpbGxpbmc7XG4gIGVudmlyb25tZW50OiBBZ2VudFByb3ZpZGVyRW52aXJvbm1lbnQ7XG4gIGluc3RhbGw6IEFnZW50UHJvdmlkZXJJbnN0YWxsO1xuICAvKiogSG93IHRoZSBwcm9tcHQgcmVhY2hlcyB0aGUgQ0xJIChJc3N1ZSAjNDM4NSkuICovXG4gIHByb21wdFRyYW5zcG9ydDogUHJvbXB0VHJhbnNwb3J0O1xuICAvKiogV2hldGhlciB3b3JrZXItYXV0aG9yZWQgUHJlVG9vbFVzZSBjb21tYW5kIGhvb2tzIGNhbiBiZSBpbnN0YWxsZWQgcGVyIHNwYXduLiAqL1xuICBzdXBwb3J0c1ByZVRvb2xVc2VIb29rcz86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBUaGUgbW9kZWwgdGhpcyBwcm92aWRlciByb3V0ZXMgYHBoYXNlYCB0byAoSXNzdWUgIzM2MikuXG4gICAqXG4gICAqIGB1bmRlZmluZWRgIG1lYW5zIHRoZSBwcm92aWRlciBoYXMgbm8gcGhhc2Ugcm91dGluZyBvZiBpdHMgb3duLCBzbyB0aGVcbiAgICogQ0xJJ3MgY29uZmlndXJlZCBkZWZhdWx0IHN0YW5kcyDigJQgd2hhdCBDb2RleCBhbmQgR2VtaW5pIGRvIHRvZGF5LlxuICAgKlxuICAgKiBgZW52YCBpcyB0aGUgbG9va3VwIHRoZSBwcm92aWRlcidzIHJvdXRpbmcgY2hhaW4gcmVhZHMgaXRzIHZhcmlhYmxlc1xuICAgKiB0aHJvdWdoIChJc3N1ZSAjOTU3KTsgb21pdHRlZCBtZWFucyB0aGUgcHJvY2VzcyBlbnZpcm9ubWVudC5cbiAgICovXG4gIHJlc29sdmVNb2RlbChwaGFzZT86IHN0cmluZywgZW52PzogRW52TG9va3VwKTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKipcbiAgICogVGhlIHJlYXNvbmluZyBlZmZvcnQgdGhpcyBwcm92aWRlciByb3V0ZXMgYHBoYXNlYCB0byAoSXNzdWUgIzM2MikuXG4gICAqXG4gICAqIGB1bmRlZmluZWRgIG1lYW5zIHRoZSBwcm92aWRlciBoYXMgbm8gcGhhc2Ugcm91dGluZyBvZiBpdHMgb3duLiBBIHByb3ZpZGVyXG4gICAqIHdob3NlIENMSSBoYXMgbm8gZWZmb3J0IG9wdGlvbiBhdCBhbGwgKEdlbWluaSkgc3RpbGwgcmVwb3J0cyB0aGUgZWZmb3J0IHRoZVxuICAgKiBwaGFzZSB3YXMgKmFza2VkKiB0byBydW4gYXQsIHNvIGBidWlsZEludm9jYXRpb25gIGNhbiBzYXkgbG91ZGx5IHRoYXQgaXRcbiAgICogY2Fubm90IGJlIGhvbm91cmVkIChJc3N1ZSAjMzY0KSBpbnN0ZWFkIG9mIGRyb3BwaW5nIGl0IGluIHNpbGVuY2UuXG4gICAqXG4gICAqIGBlbnZgIGlzIHRoZSBsb29rdXAgdGhlIHByb3ZpZGVyJ3Mgcm91dGluZyBjaGFpbiByZWFkcyBpdHMgdmFyaWFibGVzXG4gICAqIHRocm91Z2ggKElzc3VlICM5NTcpOyBvbWl0dGVkIG1lYW5zIHRoZSBwcm9jZXNzIGVudmlyb25tZW50LlxuICAgKi9cbiAgcmVzb2x2ZUVmZm9ydChwaGFzZT86IHN0cmluZywgZW52PzogRW52TG9va3VwKTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKipcbiAgICogVGhlIG5leHQtY2hlYXBlciBtb2RlbCBiZWxvdyBgbW9kZWxgLCB3aGVuIHRoaXMgcHJvdmlkZXIgaGFzIGFcbiAgICogY2hlYXBlci1tb2RlbCBsYWRkZXIgKElzc3VlICMzNjUpLlxuICAgKlxuICAgKiBgbnVsbGAgbWVhbnMgdGhlIGxhZGRlciBleGlzdHMgYW5kIGBtb2RlbGAgaXMgYWxyZWFkeSBvbiBpdHMgY2hlYXBlc3RcbiAgICogcnVuZy4gVGhlIG1ldGhvZCBiZWluZyAqKmFic2VudCoqIG1lYW5zIHRoZSBwcm92aWRlciBoYXMgbm8gbGFkZGVyIGF0XG4gICAqIGFsbCDigJQgYSBkaXN0aW5jdGlvbiB0aGUgcmF0ZS1saW1pdCBmYWxsYmFjayByZXBvcnRzIGFzXG4gICAqIGBuby1sYWRkZXItZm9yLXByb3ZpZGVyYCByYXRoZXIgdGhhbiBzaWxlbnRseSBhcyBcImFscmVhZHkgY2hlYXBlc3RcIixcbiAgICogd2hpY2ggaXMgd2hhdCBtYWRlIHRoZSBkb3duZ3JhZGUgYSBuby1vcCB1bmRlciBDb2RleCBhbmQgR2VtaW5pLlxuICAgKi9cbiAgY2hlYXBlck1vZGVsPyhtb2RlbDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIFdoZXRoZXIgYSBydW4gc2VydmVkIGBzZXJ2ZWRgIHNhdGlzZmllcyB0aGUgZXhwZWN0YXRpb24gYGV4cGVjdGVkYFxuICAgKiAoSXNzdWUgIzIwNTMpLiBBYnNlbnQg4oaSIHRoZSB0aWVyLWF3YXJlIHtAbGluayBwbGFubmluZ19ydW5fc3RhdHN9XG4gICAqIGBtb2RlbHNNYXRjaChleHBlY3RlZCwgc2VydmVkKWAgc3RhbmRzLlxuICAgKlxuICAgKiBBIHByb3ZpZGVyIGltcGxlbWVudHMgaXQgd2hlbiBpdHMgdmVuZG9yIHJlbWFwcyByZXF1ZXN0ZWQgaWRzIHRvIG90aGVyXG4gICAqIGlkcyBvZiBpdHMgb3duIGxpbmUtdXA6IERlZXBTZWVrJ3MgZW5kcG9pbnQgc2VydmVzIGBkZWVwc2Vlay12NC1wcm9gXG4gICAqIHdoZW4gdGhlIGJhc2UgdGllciBpcyBhc2tlZCwgYW5kIGl0cyBkb2N1bWVudGVkIGxlZ2FjeSBhbGlhc1xuICAgKiBgZGVlcHNlZWstdjQtZmxhc2gqYCBmb3IgRmxhc2gtdGllciByZXF1ZXN0cy4gU2VydmluZyBhICpiZXR0ZXIqIHRpZXJcbiAgICogdGhhbiByZXF1ZXN0ZWQgaXMgbm90IGRlZ3JhZGF0aW9uIOKAlCB0aGUgZGV0ZWN0b3IgZXhpc3RzIHRvIGNhdGNoIHJ1bnNcbiAgICogc2VydmVkIGEgd29yc2UgbW9kZWwgdGhhbiBkZXNpZ25lZCwgc28gb25seSBkb3duZ3JhZGVzIG11c3QgZmFpbCB0aGVcbiAgICogY2hlY2suXG4gICAqL1xuICBzZXJ2ZWRNb2RlbFNhdGlzZmllcz8oc2VydmVkOiBzdHJpbmcsIGV4cGVjdGVkOiBzdHJpbmcpOiBib29sZWFuO1xuICAvKipcbiAgICogU2FtZS1wcm92aWRlciB0aWVycyB0byB0cnkgd2hlbiBgbW9kZWxgIHByb2JlcyB1bmF2YWlsYWJsZSAoSXNzdWUgIzIwNTkpLlxuICAgKiBgcGhhc2VgIGFuZCBgZW52YCBsZXQgYSBwcm92aWRlciBhbnN3ZXIgZm9yIG9uZSBwaGFzZSdzIGJ1aWx0LWluIGRlZmF1bHRcbiAgICogKElzc3VlICM0MjIxKS4gQWJzZW50IOKGkiBubyB0aWVyIGFkYXB0YXRpb24gZm9yIHRoaXMgcHJvdmlkZXI7IHRoZSBoZWFsdGhcbiAgICogZ2F0ZSdzIHByb3ZpZGVyLWxldmVsIHZlcmRpY3RzIChmYWxsYmFjaywgc2tpcCkgb3duIHRoZSByZXNwb25zZS5cbiAgICovXG4gIGFsdGVybmF0aXZlTW9kZWxzPyhtb2RlbDogc3RyaW5nLCBwaGFzZT86IHN0cmluZywgZW52PzogRW52TG9va3VwKTogc3RyaW5nW107XG4gIC8qKlxuICAgKiBBcHBseSBhIHRpZXIgYWRhcHRhdGlvbiBmb3IgdGhpcyBydW4gKElzc3VlICMyMDU5KTogcm91dGVzIHBoYXNlcyB3aG9zZVxuICAgKiBkZXNpZ25lZCBkZWZhdWx0IGlzIGB1bmF2YWlsYWJsZWAgb250byBgYWx0ZXJuYXRpdmVgIOKAlCBuZXZlciBvdmVycmlkaW5nXG4gICAqIGFuIGV4cGxpY2l0IG9wZXJhdG9yL3JlcG8vZW52IHBpbi4gYHBoYXNlYCBuYW1lcyB0aGUgcGhhc2UgdGhlIHByb2JlIHJhblxuICAgKiBmb3IgKElzc3VlICM0MjIxKS4gQWJzZW50IOKGkiBubyBhZGFwdGF0aW9uIGZvciB0aGlzIHByb3ZpZGVyLlxuICAgKi9cbiAgYXBwbHlNb2RlbEFkYXB0YXRpb24/KFxuICAgIHVuYXZhaWxhYmxlOiBzdHJpbmcsXG4gICAgYWx0ZXJuYXRpdmU6IHN0cmluZyxcbiAgICBwaGFzZT86IHN0cmluZyxcbiAgKTogdm9pZDtcbiAgLyoqXG4gICAqIEluLXJ1biBjb3VudGVycGFydCBvZiBhbHRlcm5hdGl2ZU1vZGVscyAoSXNzdWUgIzQyMjEpOiBjYWxsZWQgd2hlbiBhblxuICAgKiBpbnZvY2F0aW9uIHdhcyByZWZ1c2VkIGBtb2RlbGA7IHJldHVybnMgdHJ1ZSB3aGVuIHRoZSBwcm92aWRlciBhZGFwdGVkIGl0c1xuICAgKiByb3V0aW5nIHNvIG9uZSByZXRyeSBvbiB0aGUgc2FtZSBwcm92aWRlciB3aWxsIG9taXQvcmVwbGFjZSB0aGUgcmVmdXNlZCBpZC5cbiAgICogQWJzZW50IOKGkiBubyBpbi1ydW4gYWRhcHRhdGlvbi5cbiAgICovXG4gIGFkYXB0QWZ0ZXJNb2RlbFJlZnVzYWw/KFxuICAgIG1vZGVsOiBzdHJpbmcsXG4gICAgcGhhc2U6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICBlbnY/OiBFbnZMb29rdXAsXG4gICk6IGJvb2xlYW47XG4gIC8qKiBCdWlsZCB0aGUgQ0xJIGFyZ3VtZW50IGxpc3QgZm9yIG9uZSBpbnZvY2F0aW9uLiAqL1xuICBidWlsZEludm9jYXRpb24ocmVxdWVzdDogQWdlbnRJbnZvY2F0aW9uUmVxdWVzdCk6IHN0cmluZ1tdO1xuICAvKipcbiAgICogQm9keSB3cml0dGVuIHRvIHRoZSBjaGlsZCdzIHN0ZGluIHdoZW4ge0BsaW5rIHByb21wdFRyYW5zcG9ydH0gaXNcbiAgICogYHN0ZGluYCAoSXNzdWUgIzE3MDIpLiBBYnNlbnQg4oaSIHRoZSBydW5uZXIgd3JpdGVzIHtAbGluayBBZ2VudEludm9jYXRpb25SZXF1ZXN0LnByb21wdH1cbiAgICogdW5jaGFuZ2VkLiBDb2RleCBmb2xkcyB0aGUgc3lzdGVtIHByb21wdCBhbmQgZGlzYWxsb3dlZC10b29scyBsaXN0XG4gICAqIGludG8gdGhpcyBib2R5IGJlY2F1c2UgaXQgaGFzIG5vIHNlcGFyYXRlIGZsYWdzIGZvciB0aGVtLlxuICAgKi9cbiAgc3RkaW5Cb2R5PyhyZXF1ZXN0OiBBZ2VudEludm9jYXRpb25SZXF1ZXN0KTogc3RyaW5nO1xuICAvKiogQnVpbGQgdGhlIGNoaWxkIHN1YnByb2Nlc3MgZW52aXJvbm1lbnQsIG1pbnVzIHdvcmtlci1vbmx5IHNlY3JldHMuICovXG4gIGJ1aWxkQ2hpbGRFbnYocGFyZW50RW52PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIC8qKlxuICAgKiBIb3cgdGhpcyBwcm92aWRlcidzIENMSSBvdXRwdXQgaXMgZGVjb2RlZCBhbmQgaXRzIGZhaWx1cmVzIGNsYXNzaWZpZWRcbiAgICogKElzc3VlICMxNjk1KS5cbiAgICpcbiAgICogVGhlIGFkYXB0ZXIgb3ducyB0aGUgQ0xJJ3MgZXZlbnQgc2hhcGVzOyB0aGUgc2hhcmVkIGNvbnRyYWN0IGluXG4gICAqIGBhZ2VudF9vdXRwdXQudHNgIG93bnMgdGhlIHJlc3VsdCBhbmQgZmFpbHVyZSB0eXBlcyBldmVyeSBwcm92aWRlciBpc1xuICAgKiBkZWNvZGVkIGludG8uIE5hbWluZyBpdCBoZXJlIGlzIHdoYXQga2VlcHMgdmVuZG9yIGtub3dsZWRnZSBvdXQgb2ZcbiAgICogYGNsYXVkZV9ydW5uZXIudHNgIOKAlCB0aGUgcnVubmVyIGFza3MgdGhlIGRlc2NyaXB0b3IsIG5ldmVyIGFuIGlkLlxuICAgKlxuICAgKiAqKkFic2VudCoqIG1lYW5zIG5vIGFkYXB0ZXIgaGFzIGJlZW4gd3JpdHRlbiBmb3IgdGhpcyBDTEkgeWV0OiB0aGUgcnVubmVyXG4gICAqIGtlZXBzIHRoZSBzaGFyZWQgYHN0cmVhbS1qc29uYCB0ZXh0IGV4dHJhY3Rpb24gaXQgaGFzIGFsd2F5cyB1c2VkIGFuZFxuICAgKiByZXBvcnRzIG5vIG5vcm1hbGlzZWQgcmVzdWx0LCByYXRoZXIgdGhhbiBkZWNvZGluZyBvbmUgdmVuZG9yJ3MgZXZlbnRzXG4gICAqIHdpdGggYW5vdGhlcidzIHBhcnNlci5cbiAgICovXG4gIG91dHB1dD86IEFnZW50T3V0cHV0QWRhcHRlcjtcbiAgLyoqIFJlcG9ydCB3aGV0aGVyIENMSSBvdXRwdXQgaW5kaWNhdGVzIGEgcHJvdmlkZXIgYXV0aGVudGljYXRpb24gZmFpbHVyZS4gKi9cbiAgaXNBdXRoRXJyb3Iob3V0cHV0OiBzdHJpbmcpOiBib29sZWFuO1xuICAvKiogT3BlcmF0b3ItZmFjaW5nIG1lc3NhZ2UgZm9yIGFuIGF1dGhlbnRpY2F0aW9uIGZhaWx1cmUuICovXG4gIGF1dGhBY3Rpb25hYmxlTWVzc2FnZSgpOiBzdHJpbmc7XG59XG5cbi8qKiBUaGUgbW9kZWwgYW5kIGVmZm9ydCBvbmUgaW52b2NhdGlvbiBydW5zIHdpdGguICovXG5leHBvcnQgaW50ZXJmYWNlIEFnZW50SW52b2NhdGlvblJvdXRpbmcge1xuICAvKiogTW9kZWwgaWQsIG9yIHVuZGVmaW5lZCB0byBsZWF2ZSB0aGUgQ0xJIG9uIGl0cyBvd24gZGVmYXVsdC4gKi9cbiAgbW9kZWw/OiBzdHJpbmc7XG4gIC8qKiBSZWFzb25pbmcgZWZmb3J0LCBvciB1bmRlZmluZWQgdG8gbGVhdmUgdGhlIENMSSBvbiBpdHMgb3duIGRlZmF1bHQuICovXG4gIGVmZm9ydD86IHN0cmluZztcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBtb2RlbCBhbmQgZWZmb3J0IGZvciBvbmUgaW52b2NhdGlvbiAoSXNzdWUgIzM2MikuXG4gKlxuICogVGhlIHByZWNlZGVuY2UgaXMgc3RhdGVkIGhlcmUgb25jZSwgZm9yIGV2ZXJ5IHByb3ZpZGVyOiBhbiBleHBsaWNpdFxuICogYHJlcXVlc3QubW9kZWxgIC8gYHJlcXVlc3QuZWZmb3J0YCBhbHdheXMgd2lucywgb3RoZXJ3aXNlIHRoZSBwcm92aWRlcidzIG93blxuICogcGhhc2Ugcm91dGluZyBkZWNpZGVzLCBhbmQgd2hlbiBuZWl0aGVyIHN1cHBsaWVzIGEgdmFsdWUgdGhlIENMSSdzIGRlZmF1bHRcbiAqIHN0YW5kcy4gVGhlIHNpeC1zdGVwIGNoYWluIGJlaGluZCBhIHByb3ZpZGVyJ3Mgcm91dGluZyBsaXZlcyBpbiB0aGF0XG4gKiBwcm92aWRlcidzIHJlc29sdmVyIOKAlCBDbGF1ZGUncyBpbiBgY2xhdWRlX2V4ZWN1dG9yLnRzYCDigJQgbmV2ZXIgcmVzdGF0ZWQgaGVyZS5cbiAqXG4gKiBAcGFyYW0gcHJvdmlkZXIgLSBUaGUgZGVzY3JpcHRvciB3aG9zZSByb3V0aW5nIGFwcGxpZXMgdG8gdGhpcyBpbnZvY2F0aW9uLlxuICogQHBhcmFtIHJlcXVlc3QgLSBUaGUgaW52b2NhdGlvbiwgY2FycnlpbmcgYW55IGV4cGxpY2l0IG1vZGVsL2VmZm9ydCBhbmQgdGhlXG4gKiAgIHBoYXNlIGRyaXZpbmcgcm91dGluZy5cbiAqIEByZXR1cm5zIFRoZSBtb2RlbCBhbmQgZWZmb3J0IHRoaXMgaW52b2NhdGlvbiBtdXN0IHVzZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVJbnZvY2F0aW9uUm91dGluZyhcbiAgcHJvdmlkZXI6IEFnZW50UHJvdmlkZXJEZXNjcmlwdG9yLFxuICByZXF1ZXN0OiBBZ2VudEludm9jYXRpb25SZXF1ZXN0LFxuKTogQWdlbnRJbnZvY2F0aW9uUm91dGluZyB7XG4gIHJldHVybiB7XG4gICAgLy8gQSBibGFuayBleHBsaWNpdCB2YWx1ZSBpcyBubyB2YWx1ZTogaXQgZmFsbHMgdGhyb3VnaCB0byBwaGFzZSByb3V0aW5nLFxuICAgIC8vIGV4YWN0bHkgYXMgdGhlIHByZS1zZWFtIGByZXF1ZXN0Lm1vZGVsID8g4oCmIDog4oCmYCB0ZXN0IGRpZC5cbiAgICBtb2RlbDogcmVxdWVzdC5tb2RlbCB8fCBwcm92aWRlci5yZXNvbHZlTW9kZWwocmVxdWVzdC5waGFzZSwgcmVxdWVzdC5lbnYpLFxuICAgIGVmZm9ydDogcmVxdWVzdC5lZmZvcnQgfHxcbiAgICAgIHByb3ZpZGVyLnJlc29sdmVFZmZvcnQocmVxdWVzdC5waGFzZSwgcmVxdWVzdC5lbnYpLFxuICB9O1xufVxuXG4vKipcbiAqIFRoZSBDbGF1ZGUgQ29kZSBDTEkncyBhcmd1bWVudCBsaXN0LCBzaGFyZWQgYnkgZXZlcnkgcHJvdmlkZXIgY2FycmllZCBvblxuICogdGhhdCBiaW5hcnkgKElzc3VlICM0MTQpLlxuICpcbiAqIENsYXVkZSBhbmQgRGVlcFNlZWsgcnVuIHRoZSAqc2FtZSogZXhlY3V0YWJsZSDigJQgRGVlcFNlZWsncyBpcyB0aGUgc2FtZVxuICogdXBzdHJlYW0gYXJ0ZWZhY3QgaW5zdGFsbGVkIHVuZGVyIGl0cyBvd24gY29tbWFuZCBuYW1lIGFuZCBwb2ludGVkIGF0XG4gKiBEZWVwU2VlaydzIEFudGhyb3BpYy1jb21wYXRpYmxlIGVuZHBvaW50IOKAlCBzbyB0aGV5IHRha2UgdGhlIHNhbWUgYXJndiBzaGFwZS5cbiAqIEl0IGlzIGJ1aWx0IGhlcmUgb25jZSByYXRoZXIgdGhhbiBjb3BpZWQgaW50byBlYWNoIGRlc2NyaXB0b3I6IGEgc2Vjb25kXG4gKiB2ZXJiYXRpbSBjb3B5IGlzIGhvdyB0aGUgdHdvIGRyaWZ0LCBhbmQgYSBmbGFnIGFkZGVkIGZvciBvbmUgcHJvdmlkZXIgYnV0XG4gKiBub3QgdGhlIG90aGVyIGlzIGEgbWlkLXJ1biBDTEkgZmFpbHVyZSByYXRoZXIgdGhhbiBhIGNvbXBpbGUgZXJyb3IuXG4gKlxuICogVGhlIHJvdXRpbmcgaXMgYSBwYXJhbWV0ZXIgcmF0aGVyIHRoYW4gcmVzb2x2ZWQgaGVyZSwgYmVjYXVzZSB0aGUgdHdvXG4gKiBwcm92aWRlcnMgZG8gbm90IGNhcnJ5IHRoZSBzYW1lIGxldmVyczogQ2xhdWRlIHBhc3NlcyBib3RoIG1vZGVsIGFuZCBlZmZvcnQsXG4gKiB3aGlsZSBEZWVwU2VlaydzIGVuZHBvaW50IGltcGxlbWVudHMgbm8gZWZmb3J0IGNvbnRyb2wgYW5kIHBhc3NlcyB0aGUgbW9kZWxcbiAqIGFsb25lIChJc3N1ZSAjMzY0J3MgcHJlY2VkZW50KS4gQW4gYWJzZW50IHZhbHVlIGVtaXRzIG5vIGZsYWcsIGxlYXZpbmcgdGhlXG4gKiBDTEkgb24gaXRzIG93biBkZWZhdWx0LlxuICpcbiAqIEBwYXJhbSByZXF1ZXN0IC0gVGhlIGludm9jYXRpb24gYmVpbmcgYnVpbHQuXG4gKiBAcGFyYW0gcm91dGluZyAtIFRoZSBtb2RlbCBhbmQgZWZmb3J0IHRoaXMgaW52b2NhdGlvbiBtYXkgY2FycnkgYXMgZmxhZ3MuXG4gKiBAcmV0dXJucyBUaGUgQ0xJIGFyZ3VtZW50IGxpc3QsIHByb21wdCBsYXN0LlxuICovXG5mdW5jdGlvbiBidWlsZENsYXVkZUNsaUFyZ3MoXG4gIHJlcXVlc3Q6IEFnZW50SW52b2NhdGlvblJlcXVlc3QsXG4gIHJvdXRpbmc6IEFnZW50SW52b2NhdGlvblJvdXRpbmcsXG4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGFyZ3M6IHN0cmluZ1tdID0gW107XG5cbiAgLy8gTW9kZWwgKElzc3VlICMyNjAsICMyNjI1KSBhbmQgZWZmb3J0IChJc3N1ZSAjMTQwMykgc2VsZWN0aW9uLCB0aHJvdWdoXG4gIC8vIHRoZSBwcm92aWRlci1hZ25vc3RpYyBzZWFtLlxuICBpZiAocm91dGluZy5tb2RlbCkgYXJncy5wdXNoKFwiLS1tb2RlbFwiLCByb3V0aW5nLm1vZGVsKTtcbiAgaWYgKHJvdXRpbmcuZWZmb3J0KSBhcmdzLnB1c2goXCItLWVmZm9ydFwiLCByb3V0aW5nLmVmZm9ydCk7XG5cbiAgYXJncy5wdXNoKFwiLS1tYXgtdHVybnNcIiwgU3RyaW5nKHJlc29sdmVDbGF1ZGVNYXhUdXJucyhyZXF1ZXN0LmVudikpKTtcbiAgYXJncy5wdXNoKFwiLS1kYW5nZXJvdXNseS1za2lwLXBlcm1pc3Npb25zXCIpO1xuICBjb25zdCBkaXNhbGxvd2VkID0gcmVxdWVzdC5kaXNhbGxvd2VkVG9vbHMgPz8gW107XG4gIGlmIChkaXNhbGxvd2VkLmxlbmd0aCA+IDApIHtcbiAgICBhcmdzLnB1c2goXCItLWRpc2FsbG93ZWQtdG9vbHNcIiwgZGlzYWxsb3dlZC5qb2luKFwiLFwiKSk7XG4gIH1cbiAgLy8gTm8gcHJvamVjdCBvciB1c2VyIHNldHRpbmdzIGFuZCBubyBhbWJpZW50IE1DUCBzZXJ2ZXJzIChJc3N1ZSAjNDY1NykuXG4gIGlmIChyZXF1ZXN0Lmlzb2xhdGVDbGF1ZGVDb25maWcpIHtcbiAgICBhcmdzLnB1c2goXCItLXNldHRpbmctc291cmNlc1wiLCBcIlwiLCBcIi0tc3RyaWN0LW1jcC1jb25maWdcIik7XG4gIH1cbiAgLy8gU3ViLWFnZW50IGRlZmluaXRpb25zIChJc3N1ZSAjMjM0MiksIGJlc2lkZSB0aGUgdG9vbCBwb2xpY3kgdGhleSBleHRlbmQuXG4gIC8vIEFic2VudCDigJQgbm8gc3ViLWFnZW50IGRlZmluaXRpb25zIHdlcmUgYnVpbHQgKHNlZSBgYnVpbGRJc3N1ZVJ1bkFnZW50c2AgaW5cbiAgLy8gYGlzc3VlX2V4ZWN1dG9yX2FnZW50cy50c2ApIOKAlCBwdXNoZXMgbm90aGluZywgc28gdGhlIGFyZ3YgYmVsb3cgaXQgaXNcbiAgLy8gdW5jaGFuZ2VkLiBUaGVyZSBpcyBubyBmYWxsYmFjayBpZiB0aGUgQ0xJIHJlamVjdHMgdGhlIGZsYWc6IGFuIG9sZGVyXG4gIC8vIGJpbmFyeSBmYWlscyB0aGUgcnVuIHdpdGggaXRzIG93biBlcnJvciByYXRoZXIgdGhhbiBxdWlldGx5IHJldmVydGluZyB0b1xuICAvLyBzaW5nbGUtbW9kZWwgcm91dGluZy5cbiAgaWYgKHJlcXVlc3QuYWdlbnRzKSB7XG4gICAgYXJncy5wdXNoKFwiLS1hZ2VudHNcIiwgSlNPTi5zdHJpbmdpZnkocmVxdWVzdC5hZ2VudHMpKTtcbiAgfVxuICAvLyBPbmUgLS1zZXR0aW5ncyBmb3IgdGhpcyBzcGF3biAoSXNzdWVzICMyMzQ0LCAjMjM4MywgIzQxMzkpLiBUaGUgY2FsbGVyXG4gIC8vIGhhcyBhbHJlYWR5IG1lcmdlZCB0aGUgZWRpdCBndWFyZCBhbmQgdGhlIGhvb2tzIGludG8gc2V0dGluZ3NKc29uLCBhbmRcbiAgLy8gdGhlIENMSSBrZWVwcyBhIHNpbmdsZSBzZXR0aW5ncyBwYXlsb2FkLCBzbyB0aGUgZmxhZyBpcyBlbWl0dGVkIG9uY2UuXG4gIC8vIEFic2VudCBwdXNoZXMgbm90aGluZy5cbiAgaWYgKHJlcXVlc3Quc2V0dGluZ3NKc29uKSB7XG4gICAgYXJncy5wdXNoKFwiLS1zZXR0aW5nc1wiLCByZXF1ZXN0LnNldHRpbmdzSnNvbik7XG4gIH1cbiAgYXJncy5wdXNoKFwiLS12ZXJib3NlXCIpO1xuICBhcmdzLnB1c2goXCItLW91dHB1dC1mb3JtYXRcIiwgXCJzdHJlYW0tanNvblwiKTtcblxuICAvLyBUaGUgaGVhZGxlc3MgYnJvd3NlciB0aGUgZ3VpZGVsaW5lcyBwcm9taXNlIChJc3N1ZSAjNDM1NSk6IGhhbmRlZCB0b1xuICAvLyB0aGUgYWdlbnQgZXhwbGljaXRseSwgc28gaXQgZG9lcyBub3QgZGVwZW5kIG9uIGEgYC5tY3AuanNvbmAgaW4gYVxuICAvLyBkaXJlY3RvcnkgdGhlIGFnZW50IG5ldmVyIHJ1bnMgZnJvbS5cbiAgaWYgKHJlcXVlc3QubWNwQ29uZmlnUGF0aCkge1xuICAgIGFyZ3MucHVzaChcIi0tbWNwLWNvbmZpZ1wiLCByZXF1ZXN0Lm1jcENvbmZpZ1BhdGgpO1xuICB9XG5cbiAgLy8gU3RhdGljIGNvbnRlbnQgcGFzc2VkIHNlcGFyYXRlbHkgc28gdGhlIENMSSBjYWNoZXMgaXQgKElzc3VlICMxMjYyKS5cbiAgaWYgKHJlcXVlc3Quc3lzdGVtUHJvbXB0KSB7XG4gICAgYXJncy5wdXNoKFwiLS1zeXN0ZW0tcHJvbXB0XCIsIHJlcXVlc3Quc3lzdGVtUHJvbXB0KTtcbiAgfVxuXG4gIC8vIFNlc3Npb24gY29udGludWl0eSBhY3Jvc3MgcGhhc2VzIG9mIG9uZSBpc3N1ZSAoSXNzdWUgIzEzMjQpLlxuICBpZiAocmVxdWVzdC5zZXNzaW9uUmVzdW1lU3RhdGUpIHtcbiAgICBhcmdzLnB1c2goXG4gICAgICAuLi5idWlsZFNlc3Npb25SZXN1bWVBcmdzKFxuICAgICAgICBidWlsZFNlc3Npb25SZXN1bWVGbGFncyhyZXF1ZXN0LnNlc3Npb25SZXN1bWVTdGF0ZSksXG4gICAgICApLFxuICAgICk7XG4gIH1cblxuICAvLyBUaGUgcHJvbXB0IGl0c2VsZjogb24gc3RkaW4gd2hlbiB0aGUgcnVubmVyIHBpcGVzIGl0IChJc3N1ZSAjNDM4NSkg4oCUXG4gIC8vIGEgYmFyZSBgLXBgIHRlbGxzIHRoZSBDTEkgdG8gcmVhZCBpdCB0aGVyZSDigJQgb3RoZXJ3aXNlIGFzIGJlZm9yZS5cbiAgaWYgKHJlcXVlc3QucHJvbXB0VmlhU3RkaW4pIGFyZ3MucHVzaChcIi1wXCIpO1xuICBlbHNlIGFyZ3MucHVzaChcIi1wXCIsIHJlcXVlc3QucHJvbXB0KTtcbiAgcmV0dXJuIGFyZ3M7XG59XG5cbi8qKlxuICogQ2xhdWRlIENvZGUsIHRoZSBmaXJzdCByZWdpc3RlcmVkIHByb3ZpZGVyLlxuICpcbiAqIEV2ZXJ5IGZpZWxkIGRlbGVnYXRlcyB0byB0aGUgbW9kdWxlIHRoYXQgYWxyZWFkeSBvd25zIHRoYXQgYmVoYXZpb3VyLCBzb1xuICogdGhlIGRlc2NyaXB0b3IgaXMgYSBkZXNjcmlwdGlvbiBvZiBDbGF1ZGUgcmF0aGVyIHRoYW4gYSBzZWNvbmQgY29weSBvZiBpdC5cbiAqL1xuY29uc3QgQ0xBVURFX1BST1ZJREVSOiBBZ2VudFByb3ZpZGVyRGVzY3JpcHRvciA9IHtcbiAgc3VwcG9ydHNQcmVUb29sVXNlSG9va3M6IHRydWUsXG4gIGlkOiBDTEFVREVfUFJPVklERVJfSUQsXG4gIGRpc3BsYXlOYW1lOiBcIkNsYXVkZSBDb2RlXCIsXG4gIGJpbmFyeTogXCJjbGF1ZGVcIixcbiAgY3JlZGVudGlhbHM6IHtcbiAgICBzdWJkaXI6IFwiY2xhdWRlXCIsXG4gICAgZmlsZTogXCJwcm92aWRlci5lbnZcIixcbiAgICBlbnZWYXJzOiBbXG4gICAgICBcIkFOVEhST1BJQ19BUElfS0VZXCIsXG4gICAgICBcIkFOVEhST1BJQ19BVVRIX1RPS0VOXCIsXG4gICAgICBcIkNMQVVERV9DT0RFX09BVVRIX1RPS0VOXCIsXG4gICAgXSxcbiAgICBwcm92aXNpb25FbnZWYXI6IFwiVklCRV9MQVVOQ0hBR0VOVF9BTlRIUk9QSUNfQVBJX0tFWVwiLFxuICAgIC8vIEFuIG9wZXJhdG9yIG1heSBob2xkIHNldmVyYWwgQ2xhdWRlIHN1YnNjcmlwdGlvbnMgYW5kIHdhbnRzIHRoZW0gc3BlbnRcbiAgICAvLyBldmVubHkgKElzc3VlICM5MTcsIHBhcmVudCAjOTAyKSwgc28gZXh0cmEgdG9rZW5zIGxpdmUgYmVzaWRlXG4gICAgLy8gcHJvdmlkZXIuZW52IGFzIHByb3ZpZGVyLTIuZW52LCBwcm92aWRlci0zLmVudiwgLi4uIE9ubHkgdGhlXG4gICAgLy8gc3Vic2NyaXB0aW9uIE9BdXRoIHRva2VuIGpvaW5zIHRoZSBwb29sOiBhIG1ldGVyZWQgQU5USFJPUElDX0FQSV9LRVlcbiAgICAvLyBoYXMgbm8gcGVyLXRva2VuIGJ1ZGdldCB0byB3ZWlnaCwgYW5kIEFOVEhST1BJQ19BVVRIX1RPS0VOIGlzIGEgYmVhcmVyXG4gICAgLy8gZm9yIGEgcHJveGllZCBlbmRwb2ludCByYXRoZXIgdGhhbiBhIHN1YnNjcmlwdGlvbi5cbiAgICB0b2tlblBvb2w6IHtcbiAgICAgIGZpbGVQYXR0ZXJuOiBcInByb3ZpZGVyLSouZW52XCIsXG4gICAgICBmaWxlTWF0Y2g6IC9ecHJvdmlkZXItKFxcZCspXFwuZW52JC8sXG4gICAgICBlbnZWYXJzOiBbXCJDTEFVREVfQ09ERV9PQVVUSF9UT0tFTlwiXSxcbiAgICB9LFxuICB9LFxuICAvLyBGaXhlZC1wcmljZSBzdWJzY3JpcHRpb24gdnMgbWV0ZXJlZCBzcGVuZCAoSXNzdWUgIzE5MjMpLiBUaGUgT0F1dGggdG9rZW5cbiAgLy8gaXMgdGhlIENsYXVkZSBzdWJzY3JpcHRpb247IGB3aXRoaG9sZE5vblN1YnNjcmlwdGlvbkNyZWRlbnRpYWxzYCBrZWVwc1xuICAvLyBldmVyeSBvdGhlciBBbnRocm9waWMgY3JlZGVudGlhbCBvdXQgb2YgYSBzdWJzY3JpcHRpb24gcnVuJ3MgY2hpbGQuXG4gIGJpbGxpbmc6IHtcbiAgICBzdWJzY3JpcHRpb25FbnZWYXJzOiBbXCJDTEFVREVfQ09ERV9PQVVUSF9UT0tFTlwiXSxcbiAgICAvLyBBTlRIUk9QSUNfQVVUSF9UT0tFTiBpcyBkZWxpYmVyYXRlbHkgYWJzZW50OiBpdCBpcyBhIGJlYXJlciBmb3IgYVxuICAgIC8vIHByb3hpZWQgZW5kcG9pbnQsIHNvIHdoYXQgaXQgYmlsbHMgaXMgdGhlIHByb3h5J3MgYnVzaW5lc3MgYW5kIHRoaXNcbiAgICAvLyBtb2R1bGUgY2Fubm90IHByb3ZlIGl0IGlzIG1ldGVyZWQuIEl0IHN0YXlzIGB1bmtub3duYCwgd2hpY2ggYWdyZWVzXG4gICAgLy8gd2l0aCBgY2xhdWRlU3RhdHVzYCdzIGBub24tc3Vic2NyaXB0aW9uLWJlYXJlcmAsIGFuZCBpcyB3aXRoaGVsZCBmcm9tIGFcbiAgICAvLyBzdWJzY3JpcHRpb24gY2hpbGQgYW55d2F5IGJ5IENMQVVERV9OT05fU1VCU0NSSVBUSU9OX0NSRURFTlRJQUxfRU5WX1ZBUlMuXG4gICAgbWV0ZXJlZEVudlZhcnM6IFtcIkFOVEhST1BJQ19BUElfS0VZXCJdLFxuICB9LFxuICBlbnZpcm9ubWVudDoge1xuICAgIHNlY3JldEFsbG93bGlzdDogQ0xBVURFX0VOVl9TRUNSRVRfQUxMT1dMSVNULFxuICAgIGRlbnlsaXN0OiBDTEFVREVfRU5WX0RFTllMSVNULFxuICB9LFxuICBpbnN0YWxsOiB7IGZyYWdtZW50OiBgJHtQUk9WSURFUl9GUkFHTUVOVF9ESVJ9L2NsYXVkZS5zaGAgfSxcbiAgLy8gYGNsYXVkZSAtcGAgd2l0aCBubyBwb3NpdGlvbmFsIHByb21wdCByZWFkcyBpdCBmcm9tIHN0ZGluIChJc3N1ZSAjNDM4NSkuXG4gIHByb21wdFRyYW5zcG9ydDogXCJzdGRpblwiLFxuICAvLyBUaGUgQ2xhdWRlIGBzdHJlYW0tanNvbmAgZGVjb2RlciBhbmQgZmFpbHVyZSBjbGFzc2lmaWVyIChJc3N1ZSAjMTY5NSkuXG4gIC8vIEEgZ2V0dGVyLCBub3QgYSB2YWx1ZSAodGhlIGBkZWZhdWx0UXVvcnVtUGxhbm5lcnMoKWAgcHJlY2VkZW50KTogdGhlXG4gIC8vIGFkYXB0ZXIgbW9kdWxlIHJlYWNoZXMgYGNsYXVkZV9leGVjdXRvci50c2AsIHdoaWNoIGltcG9ydHNcbiAgLy8gYGNvbmZpZ19kZWZhdWx0cy50c2AsIHdoaWNoIGltcG9ydHMgdGhpcyBtb2R1bGUgYmFjaywgc28gcmVhZGluZyB0aGVcbiAgLy8gY29uc3RhbnQgYXQgbW9kdWxlLWV2YWx1YXRpb24gdGltZSB0aHJvd3MgYSB0ZW1wb3JhbC1kZWFkLXpvbmUgZXJyb3IuXG4gIC8vIERlZmVycmluZyB0aGUgcmVhZCB0byBwcm9wZXJ0eSBhY2Nlc3Mga2VlcHMgdGhlIGRlc2NyaXB0b3IgZGVjbGFyYXRpdmVcbiAgLy8gd2l0aG91dCB0aGUgY3ljbGUuXG4gIGdldCBvdXRwdXQoKTogQWdlbnRPdXRwdXRBZGFwdGVyIHtcbiAgICByZXR1cm4gQ0xBVURFX09VVFBVVF9BREFQVEVSO1xuICB9LFxuXG4gIC8vIENsYXVkZSBpcyB0aGUgcHJvdmlkZXIgd2l0aCBwaGFzZSByb3V0aW5nIHRvZGF5OiBib3RoIHJlc29sdmVycyBkZWxlZ2F0ZVxuICAvLyB0byB0aGUgY2hhaW4gYGNsYXVkZV9leGVjdXRvci50c2Agb3ducyAoSXNzdWUgIzM2MikuXG4gIHJlc29sdmVNb2RlbChwaGFzZT86IHN0cmluZywgZW52PzogRW52TG9va3VwKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gcmVzb2x2ZUNsYXVkZU1vZGVsKHBoYXNlLCBlbnYpO1xuICB9LFxuXG4gIHJlc29sdmVFZmZvcnQocGhhc2U/OiBzdHJpbmcsIGVudj86IEVudkxvb2t1cCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHJlc29sdmVDbGF1ZGVFZmZvcnQocGhhc2UsIGVudik7XG4gIH0sXG5cbiAgLy8gVGhlIHRpZXIgbGFkZGVyIGBjb25maWdfZGVmYXVsdHMudHNgIG93bnMgKGZhYmxlIOKGkiBvcHVzIOKGkiBzb25uZXQg4oaSIGhhaWt1KSxcbiAgLy8gbmV2ZXIgcmVzdGF0ZWQgaGVyZSAoSXNzdWUgIzM2NSkuXG4gIGNoZWFwZXJNb2RlbChtb2RlbDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIGdldENoZWFwZXJNb2RlbChtb2RlbCk7XG4gIH0sXG5cbiAgYnVpbGRJbnZvY2F0aW9uKHJlcXVlc3Q6IEFnZW50SW52b2NhdGlvblJlcXVlc3QpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIGJ1aWxkQ2xhdWRlQ2xpQXJncyhcbiAgICAgIHtcbiAgICAgICAgLi4ucmVxdWVzdCxcbiAgICAgICAgc2Vzc2lvblJlc3VtZVN0YXRlOiBzZXNzaW9uUmVzdW1lRm9yUHJvdmlkZXIoXG4gICAgICAgICAgcmVxdWVzdC5zZXNzaW9uUmVzdW1lU3RhdGUsXG4gICAgICAgICAgdGhpcy5pZCxcbiAgICAgICAgKSxcbiAgICAgIH0sXG4gICAgICByZXNvbHZlSW52b2NhdGlvblJvdXRpbmcodGhpcywgcmVxdWVzdCksXG4gICAgKTtcbiAgfSxcblxuICBidWlsZENoaWxkRW52KHBhcmVudEVudj86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgICByZXR1cm4gcGFyZW50RW52ID8gYnVpbGRDbGF1ZGVDaGlsZEVudihwYXJlbnRFbnYpIDogYnVpbGRDbGF1ZGVDaGlsZEVudigpO1xuICB9LFxuXG4gIGlzQXV0aEVycm9yKG91dHB1dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIGlzQ2xhdWRlQXV0aEVycm9yKG91dHB1dCk7XG4gIH0sXG5cbiAgYXV0aEFjdGlvbmFibGVNZXNzYWdlKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGNsYXVkZUF1dGhBY3Rpb25hYmxlTWVzc2FnZSgpO1xuICB9LFxufTtcblxuLyoqXG4gKiBUaGUgT3BlbkFJIENvZGV4IENMSSwgdGhlIHNlY29uZCByZWdpc3RlcmVkIHByb3ZpZGVyIChJc3N1ZSAjNDEwNikuXG4gKlxuICogVGhlIGZpcnN0IHJlYWwgdGVzdCBvZiB0aGUgc2VhbTogYWRkaW5nIGl0IGlzIHRoaXMgZGVzY3JpcHRvciBwbHVzXG4gKiBgY29udGFpbmVyL3Byb3ZpZGVycy9jb2RleC5zaGAgYW5kIGEgYGNvbnRhaW5lci90b29scy5qc29uYCBwaW4g4oCUIG5vIGNoYW5nZVxuICogdG8gY29udGFpbm1lbnQsIHRoZSBsYXVuY2hlcidzIG1vdW50cywgb3IgdGhlIGNyZWRlbnRpYWwgcHJlZmxpZ2h0LiBFdmVyeVxuICogZmllbGQgZGVsZWdhdGVzIHRvIHRoZSBDb2RleC1vd25lZCBtb2R1bGVzIChgY29kZXhfZXhlY3V0b3IudHNgLFxuICogYGNvZGV4X2Vudi50c2AsIGBjb2RleF9hdXRoLnRzYCksIHNvIG5vIENvZGV4IENMSSBrbm93bGVkZ2UgbGl2ZXMgaGVyZS5cbiAqL1xuY29uc3QgQ09ERVhfUFJPVklERVI6IEFnZW50UHJvdmlkZXJEZXNjcmlwdG9yID0ge1xuICBzdXBwb3J0c1ByZVRvb2xVc2VIb29rczogdHJ1ZSxcbiAgaWQ6IENPREVYX1BST1ZJREVSX0lELFxuICBkaXNwbGF5TmFtZTogXCJDb2RleCBDTElcIixcbiAgYmluYXJ5OiBcImNvZGV4XCIsXG4gIGNyZWRlbnRpYWxzOiB7XG4gICAgc3ViZGlyOiBcImNvZGV4XCIsXG4gICAgZmlsZTogXCJwcm92aWRlci5lbnZcIixcbiAgICBlbnZWYXJzOiBDT0RFWF9DUkVERU5USUFMX0VOVl9WQVJTLFxuICAgIHN0YXRlRW52VmFyczogW0NPREVYX0hPTUVfRU5WX1ZBUl0sXG4gICAgaW5pdGlhbGlzZVN0YXRlOiBpbml0aWFsaXNlQ29kZXhIb21lLFxuICAgIHByb3Zpc2lvbkVudlZhcjogXCJWSUJFX0xBVU5DSEFHRU5UX09QRU5BSV9BUElfS0VZXCIsXG4gIH0sXG4gIC8vIEZpeGVkLXByaWNlIHN1YnNjcmlwdGlvbiB2cyBtZXRlcmVkIHNwZW5kIChJc3N1ZSAjMTkyMykuIE5vIGVudmlyb25tZW50XG4gIC8vIHZhcmlhYmxlIGNhcnJpZXMgYSBDaGF0R1BUIHN1YnNjcmlwdGlvbjogaXQgbGl2ZXMgaW4gdGhlIGF1dGggc3RhdGUgdGhlXG4gIC8vIENMSSBwZXJzaXN0cyB1bmRlciBDT0RFWF9IT01FLCBzbyB0aGUgcHJvb2YgaXMgYSBwcm9iZSByYXRoZXIgdGhhbiBhXG4gIC8vIG5hbWUuIFRoZSBwcm9iZSByZWFkcyBvbmx5IGFuIEVYUExJQ0lUIENPREVYX0hPTUUgKElzc3VlICMzOTU1KTogdGhhdCBpc1xuICAvLyB0aGUgb25lIGhvbWUgYGJ1aWxkSXNvbGF0ZWRDb2RleENoaWxkRW52YCBnaXZlcyB0aGUgY2hpbGQuIFdpdGhvdXQgaXQgdGhlXG4gIC8vIGNoaWxkIGdldHMgbm8gaG9tZSwgdGhlIENMSSBmYWxscyBiYWNrIHRvICRIT01FLy5jb2RleCwgd2hpY2ggdGhlIHdvcmtlclxuICAvLyBuZXZlciBwcm9iZXMsIHNvIHRoZSBhbnN3ZXIgY29tZXMgZnJvbSB0aGUgbWV0ZXJlZC1rZXkgY2hlY2sgaW5zdGVhZC5cbiAgYmlsbGluZzoge1xuICAgIHN1YnNjcmlwdGlvbkVudlZhcnM6IFtdLFxuICAgIG1ldGVyZWRFbnZWYXJzOiBDT0RFWF9BUElfS0VZX0VOVl9WQVJTLFxuICAgIHJlc29sdmVTdG9yZWRCaWxsaW5nKGNvbnRleHQpIHtcbiAgICAgIGNvbnN0IGV4cGxpY2l0SG9tZSA9IChjb250ZXh0LmVudihDT0RFWF9IT01FX0VOVl9WQVIpID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgIGlmICghZXhwbGljaXRIb21lKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgLy8gQW4gZXhwbGljaXQgQ09ERVhfSE9NRSB3aXRoaG9sZHMgT1BFTkFJX0FQSV9LRVkgLyBDT0RFWF9BUElfS0VZIGZyb21cbiAgICAgIC8vIHRoZSBjaGlsZCwgc28gdGhlIGVudmlyb25tZW50IGlzIG5vdCBjb25zdWx0ZWQgaGVyZTogYSBwZXJzaXN0ZWRcbiAgICAgIC8vIENoYXRHUFQgbG9naW4gaXMgd2hhdCB0aGUgcnVuIHNwZW5kcyBldmVuIHdoZW4gYSBtZXRlcmVkIGtleSBzaXRzIGluXG4gICAgICAvLyB0aGUgd29ya2VyJ3Mgb3duIGVudmlyb25tZW50LlxuICAgICAgY29uc3QgeyBtb2RlLCBzb3VyY2UsIGRldGFpbCB9ID0gcmVzb2x2ZUNvZGV4QXV0aE1vZGUoXG4gICAgICAgIGV4cGxpY2l0SG9tZSxcbiAgICAgICAgKCkgPT4gdW5kZWZpbmVkLFxuICAgICAgKTtcbiAgICAgIGlmIChtb2RlID09PSBcImNoYXRncHRcIikge1xuICAgICAgICByZXR1cm4geyBtb2RlOiBcImZpeGVkLXN1YnNjcmlwdGlvblwiLCByZWFzb246IFwiY29kZXgtY2hhdGdwdC1sb2dpblwiIH07XG4gICAgICB9XG4gICAgICBpZiAobW9kZSA9PT0gXCJhcGkta2V5XCIpIHtcbiAgICAgICAgLy8gV2l0aCB0aGUgZW52aXJvbm1lbnQgd2l0aGhlbGQsIGEga2V5IGNhbiBvbmx5IGNvbWUgZnJvbSBhdXRoLmpzb24sXG4gICAgICAgIC8vIHdoZXJlIG5vIHZhcmlhYmxlIGlzIHNldCBhdCBhbGwuXG4gICAgICAgIHJldHVybiB7IG1vZGU6IFwibWV0ZXJlZFwiLCByZWFzb246IFwiY29kZXgtYXV0aC1qc29uLWFwaS1rZXlcIiB9O1xuICAgICAgfVxuICAgICAgaWYgKHNvdXJjZSA9PT0gXCJyZWFkLWVycm9yXCIpIHtcbiAgICAgICAgLy8gQSBsb2dpbiB0aGF0IGNhbm5vdCBiZSByZWFkIGlzIGEgZmF1bHQsIG5vdCBhbiBhYnNlbnQgbG9naW4uIFNheVxuICAgICAgICAvLyB3aGljaCBmYXVsdCwgc28gaXQgaXMgbm90IHJlcG9ydGVkIGFzIFwibmV2ZXIgYXV0aGVudGljYXRlZFwiLlxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG1vZGU6IFwidW5rbm93blwiLFxuICAgICAgICAgIHJlYXNvbjogYGNvZGV4LWF1dGgtanNvbi11bnJlYWRhYmxlICgke2RldGFpbCA/PyBcIm5vIGRldGFpbFwifSlgLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9LFxuICB9LFxuICBlbnZpcm9ubWVudDoge1xuICAgIHNlY3JldEFsbG93bGlzdDogQ09ERVhfRU5WX1NFQ1JFVF9BTExPV0xJU1QsXG4gICAgZGVueWxpc3Q6IENPREVYX0VOVl9ERU5ZTElTVCxcbiAgfSxcbiAgaW5zdGFsbDogeyBmcmFnbWVudDogYCR7UFJPVklERVJfRlJBR01FTlRfRElSfS9jb2RleC5zaGAgfSxcbiAgLy8gVGhlIHByb21wdCB0cmF2ZWxzIG9uIHN0ZGluIChJc3N1ZSAjMTcwMik6IExpbnV4IGNhcHMgb25lIGFyZ3YgZWxlbWVudFxuICAvLyBhdCAxMjggS2lCLCBhbmQgYSBsb25nIGlzc3VlIHRocmVhZCBleGNlZWRzIHRoYXQuIENvZGV4IHJlYWRzIGAtYCBhc1xuICAvLyBcInRoZSBwcm9tcHQgaXMgb24gc3RkaW5cIi5cbiAgcHJvbXB0VHJhbnNwb3J0OiBcInN0ZGluXCIsXG4gIC8vIFRoZSBgY29kZXggZXhlYyAtLWpzb25gIGRlY29kZXIgYW5kIGZhaWx1cmUgY2xhc3NpZmllciAoSXNzdWUgIzE2OTUpLFxuICAvLyBkZWZlcnJlZCBmb3IgdGhlIHNhbWUgaW1wb3J0IGN5Y2xlIGFzIENsYXVkZSdzIGFib3ZlLlxuICBnZXQgb3V0cHV0KCk6IEFnZW50T3V0cHV0QWRhcHRlciB7XG4gICAgcmV0dXJuIENPREVYX09VVFBVVF9BREFQVEVSO1xuICB9LFxuXG4gIC8vIENvZGV4IHJvdXRlcyBgcGhhc2VgIHRocm91Z2ggaXRzIG93biB0YWJsZXMgKElzc3VlICMzNjMpLCB0aGUgd2F5IENsYXVkZVxuICAvLyBkb2VzOiB0aGUgY2hhaW4gbGl2ZXMgaW4gYGNvZGV4X2V4ZWN1dG9yLnRzYCBhbmQgaXMgbmV2ZXIgcmVzdGF0ZWQgaGVyZS5cbiAgcmVzb2x2ZU1vZGVsKHBoYXNlPzogc3RyaW5nLCBlbnY/OiBFbnZMb29rdXApOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiByZXNvbHZlQ29kZXhNb2RlbChwaGFzZSwgZW52KTtcbiAgfSxcblxuICAvLyBBIENoYXRHUFQgbG9naW4gbWF5IHJlZnVzZSBhIGJ1aWx0LWluIGRlZmF1bHQgKElzc3VlICM0MjIxKTogdGhlIGFsdGVybmF0aXZlXG4gIC8vIGlzIHRoZSBDTEkncyBvd24gZGVmYXVsdCwgaS5lLiBubyAtLW1vZGVsLlxuICBhbHRlcm5hdGl2ZU1vZGVscyhtb2RlbDogc3RyaW5nLCBwaGFzZT86IHN0cmluZywgZW52PzogRW52TG9va3VwKTogc3RyaW5nW10ge1xuICAgIHJldHVybiBjb2RleEFsdGVybmF0aXZlTW9kZWxzKG1vZGVsLCBwaGFzZSwgZW52KTtcbiAgfSxcblxuICBhcHBseU1vZGVsQWRhcHRhdGlvbihcbiAgICB1bmF2YWlsYWJsZTogc3RyaW5nLFxuICAgIGFsdGVybmF0aXZlOiBzdHJpbmcsXG4gICAgcGhhc2U/OiBzdHJpbmcsXG4gICk6IHZvaWQge1xuICAgIGFwcGx5Q29kZXhNb2RlbEFkYXB0YXRpb24odW5hdmFpbGFibGUsIGFsdGVybmF0aXZlLCBwaGFzZSk7XG4gIH0sXG5cbiAgYWRhcHRBZnRlck1vZGVsUmVmdXNhbChcbiAgICBtb2RlbDogc3RyaW5nLFxuICAgIHBoYXNlOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgZW52PzogRW52TG9va3VwLFxuICApOiBib29sZWFuIHtcbiAgICByZXR1cm4gYWRhcHRDb2RleEFmdGVyTW9kZWxSZWZ1c2FsKG1vZGVsLCBwaGFzZSwgZW52KTtcbiAgfSxcblxuICByZXNvbHZlRWZmb3J0KHBoYXNlPzogc3RyaW5nLCBlbnY/OiBFbnZMb29rdXApOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiByZXNvbHZlQ29kZXhFZmZvcnQocGhhc2UsIGVudik7XG4gIH0sXG5cbiAgYnVpbGRJbnZvY2F0aW9uKHJlcXVlc3Q6IEFnZW50SW52b2NhdGlvblJlcXVlc3QpOiBzdHJpbmdbXSB7XG4gICAgY29uc3Qgcm91dGluZyA9IHJlc29sdmVJbnZvY2F0aW9uUm91dGluZyh0aGlzLCByZXF1ZXN0KTtcbiAgICBsZXQgbWNwQ29uZmlnT3ZlcnJpZGVzOiByZWFkb25seSBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcbiAgICBpZiAocmVxdWVzdC5tY3BDb25maWdQYXRoKSB7XG4gICAgICBsZXQganNvbjogc3RyaW5nO1xuICAgICAgdHJ5IHtcbiAgICAgICAganNvbiA9IERlbm8ucmVhZFRleHRGaWxlU3luYyhyZXF1ZXN0Lm1jcENvbmZpZ1BhdGgpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBDb2RleCBNQ1AgY29uZmlnIGF0ICR7cmVxdWVzdC5tY3BDb25maWdQYXRofSBjb3VsZCBub3QgYmUgcmVhZDogJHtcbiAgICAgICAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKVxuICAgICAgICAgIH1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgbWNwQ29uZmlnT3ZlcnJpZGVzID0gYnVpbGRDb2RleE1jcENvbmZpZ0FyZ3MoanNvbik7XG4gICAgICBpZiAobWNwQ29uZmlnT3ZlcnJpZGVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYENvZGV4IE1DUCBjb25maWcgYXQgJHtyZXF1ZXN0Lm1jcENvbmZpZ1BhdGh9IHByb2R1Y2VkIG5vIGAgK1xuICAgICAgICAgICAgYG1jcF9zZXJ2ZXJzIG92ZXJyaWRlczsgcmVmdXNpbmcgdG8gcnVuIHdpdGhvdXQgdGhlIHJlcXVlc3RlZCBgICtcbiAgICAgICAgICAgIGBicm93c2VyIHNlcnZlciAoSXNzdWUgIzE3MDIpLmAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBidWlsZENvZGV4QXJncyh7XG4gICAgICBwcm9tcHQ6IHJlcXVlc3QucHJvbXB0LFxuICAgICAgb3JjaGVzdHJhdGlvblJvbGU6IHJlcXVlc3Qub3JjaGVzdHJhdGlvblJvbGUsXG4gICAgICBzZXR0aW5nc0pzb246IHJlcXVlc3Quc2V0dGluZ3NKc29uLFxuICAgICAgc3lzdGVtUHJvbXB0OiByZXF1ZXN0LnN5c3RlbVByb21wdCxcbiAgICAgIGRpc2FsbG93ZWRUb29sczogcmVxdWVzdC5kaXNhbGxvd2VkVG9vbHMsXG4gICAgICBtb2RlbDogcm91dGluZy5tb2RlbCxcbiAgICAgIGVmZm9ydDogcm91dGluZy5lZmZvcnQsXG4gICAgICAvLyBSZXN1bWUgdGhlIHRocmVhZCB0aGlzIGlzc3VlJ3MgcHJldmlvdXMgQ29kZXggcGhhc2UgcmVwb3J0ZWRcbiAgICAgIC8vIChJc3N1ZSAjMTY5OSkuIEEgQ2xhdWRlIFVVSUQsIGEgbWlzc2luZyBjYXB0dXJlLCBvciBgLS1sYXN0YCBpc1xuICAgICAgLy8gbmV2ZXIgYSBzdWJzdGl0dXRlIOKAlCBjb25jdXJyZW50IHNsb3RzIHNoYXJlIGEgd29ya2luZyBkaXJlY3RvcnkuXG4gICAgICByZXN1bWVTZXNzaW9uSWQ6IGNvZGV4UmVzdW1lU2Vzc2lvbklkKHJlcXVlc3Quc2Vzc2lvblJlc3VtZVN0YXRlKSxcbiAgICAgIHByb21wdFZpYVN0ZGluOiByZXF1ZXN0LnByb21wdFZpYVN0ZGluLFxuICAgICAgLi4uKG1jcENvbmZpZ092ZXJyaWRlcyA/IHsgbWNwQ29uZmlnT3ZlcnJpZGVzIH0gOiB7fSksXG4gICAgfSk7XG4gIH0sXG5cbiAgc3RkaW5Cb2R5KHJlcXVlc3Q6IEFnZW50SW52b2NhdGlvblJlcXVlc3QpOiBzdHJpbmcge1xuICAgIHJldHVybiBjb21wb3NlQ29kZXhQcm9tcHQoe1xuICAgICAgcHJvbXB0OiByZXF1ZXN0LnByb21wdCxcbiAgICAgIHN5c3RlbVByb21wdDogcmVxdWVzdC5zeXN0ZW1Qcm9tcHQsXG4gICAgICBkaXNhbGxvd2VkVG9vbHM6IHJlcXVlc3QuZGlzYWxsb3dlZFRvb2xzLFxuICAgIH0pO1xuICB9LFxuXG4gIGJ1aWxkQ2hpbGRFbnYocGFyZW50RW52PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICAgIGNvbnN0IHNvdXJjZSA9IHBhcmVudEVudiA/PyBEZW5vLmVudi50b09iamVjdCgpO1xuICAgIC8vIElzc3VlICMxNjk4OiBvbmx5IHRoZSBzZWxlY3RlZCBhY2NvdW50J3MgQ29kZXggc2VjcmV0cyBhcmUgY29waWVkXG4gICAgLy8gYmFjayBhZnRlciB0aGUgZGVueWxpc3Qgc3RyaXAuIFRoZSBwYXJlbnQgb2JqZWN0IGlzIG5vdCBtdXRhdGVkLlxuICAgIHJldHVybiBidWlsZElzb2xhdGVkQ29kZXhDaGlsZEVudihzb3VyY2UsIHtcbiAgICAgIG9wZW5haUFwaUtleTogc291cmNlLk9QRU5BSV9BUElfS0VZLFxuICAgICAgY29kZXhBcGlLZXk6IHNvdXJjZS5DT0RFWF9BUElfS0VZLFxuICAgICAgY29kZXhIb21lOiBzb3VyY2UuQ09ERVhfSE9NRSxcbiAgICB9KTtcbiAgfSxcblxuICBpc0F1dGhFcnJvcihvdXRwdXQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBpc0NvZGV4QXV0aEVycm9yKG91dHB1dCk7XG4gIH0sXG5cbiAgYXV0aEFjdGlvbmFibGVNZXNzYWdlKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGNvZGV4QXV0aEFjdGlvbmFibGVNZXNzYWdlKCk7XG4gIH0sXG59O1xuXG4vKipcbiAqIFRoZSBHZW1pbmkgQ0xJLCB0aGUgdGhpcmQgcmVnaXN0ZXJlZCBwcm92aWRlciAoSXNzdWUgIzQxMDcpLlxuICpcbiAqIEluIFF1b3J1bSBtb2RlIEdlbWluaSBpcyB0aGUganVkZ2UgcmF0aGVyIHRoYW4gYSBwbGFubmVyOiBpdCByZWFkcyB0aGUgdHdvXG4gKiBwbGFubmVycycgY2FuZGlkYXRlIHBsYW5zIGFuZCBwaWNrcyBhIHdpbm5lciwgc28gaXRzIGludm9jYXRpb24gYXNrcyBmb3JcbiAqIG1hY2hpbmUtcmVhZGFibGUgb3V0cHV0IHdoZXJlIGEgcGxhbm5lcidzIG1heSBzdGF5IHByb3NlLiBFdmVyeSBmaWVsZFxuICogZGVsZWdhdGVzIHRvIHRoZSBHZW1pbmktb3duZWQgbW9kdWxlcyAoYGdlbWluaV9leGVjdXRvci50c2AsXG4gKiBgZ2VtaW5pX2Vudi50c2AsIGBnZW1pbmlfYXV0aC50c2ApLCBzbyBubyBHZW1pbmkgQ0xJIGtub3dsZWRnZSBsaXZlcyBoZXJlLlxuICpcbiAqIEl0IGNhcnJpZXMgKipubyoqIGBvdXRwdXRgIGFkYXB0ZXIgKElzc3VlICMxNjk1KTogaXRzIGV2ZW50IHNoYXBlcyB3ZXJlIG5vdFxuICogY29uZmlybWFibGUgYWdhaW5zdCB0aGUgcGlubmVkIENMSSBoZXJlLCBhbmQgZGVjb2RpbmcgdGhlbSB3aXRoIENsYXVkZSdzXG4gKiBwYXJzZXIgaXMgZXhhY3RseSB0aGUgZ3Vlc3N3b3JrIHRoaXMgc2VhbSBleGlzdHMgdG8gZW5kLiBUaGUgcnVubmVyIGtlZXBzXG4gKiB0aGUgc2hhcmVkIHRleHQgZXh0cmFjdGlvbiBmb3IgaXQgYW5kIHJlcG9ydHMgbm8gbm9ybWFsaXNlZCByZXN1bHQg4oCUIGFuXG4gKiBhYnNlbnQgZGVjb2RlLCBuZXZlciBhIGZhYnJpY2F0ZWQgb25lLlxuICovXG5jb25zdCBHRU1JTklfUFJPVklERVI6IEFnZW50UHJvdmlkZXJEZXNjcmlwdG9yID0ge1xuICBpZDogR0VNSU5JX1BST1ZJREVSX0lELFxuICBkaXNwbGF5TmFtZTogXCJHZW1pbmkgQ0xJXCIsXG4gIGJpbmFyeTogXCJnZW1pbmlcIixcbiAgY3JlZGVudGlhbHM6IHtcbiAgICBzdWJkaXI6IFwiZ2VtaW5pXCIsXG4gICAgZmlsZTogXCJwcm92aWRlci5lbnZcIixcbiAgICBlbnZWYXJzOiBHRU1JTklfQ1JFREVOVElBTF9FTlZfVkFSUyxcbiAgICBwcm92aXNpb25FbnZWYXI6IFwiVklCRV9MQVVOQ0hBR0VOVF9HRU1JTklfQVBJX0tFWVwiLFxuICB9LFxuICAvLyBHZW1pbmkgYmlsbHMgcGVyIHRva2VuIGFnYWluc3QgYW4gQVBJIGtleSAoSXNzdWUgIzE5MjMpOiB0aGVyZSBpcyBub1xuICAvLyBmaXhlZC1wcmljZSBzdWJzY3JpcHRpb24gVmliZUNvZGVyIGNhbiBydW4gdW5hdHRlbmRlZCwgc28gaXQgaXMgbmV2ZXIgYW5cbiAgLy8gYXV0b21hdGljLXJvdXRpbmcgY2FuZGlkYXRlLlxuICBiaWxsaW5nOiB7XG4gICAgc3Vic2NyaXB0aW9uRW52VmFyczogW10sXG4gICAgbWV0ZXJlZEVudlZhcnM6IEdFTUlOSV9DUkVERU5USUFMX0VOVl9WQVJTLFxuICB9LFxuICBlbnZpcm9ubWVudDoge1xuICAgIHNlY3JldEFsbG93bGlzdDogR0VNSU5JX0VOVl9TRUNSRVRfQUxMT1dMSVNULFxuICAgIGRlbnlsaXN0OiBHRU1JTklfRU5WX0RFTllMSVNULFxuICB9LFxuICBpbnN0YWxsOiB7IGZyYWdtZW50OiBgJHtQUk9WSURFUl9GUkFHTUVOVF9ESVJ9L2dlbWluaS5zaGAgfSxcbiAgcHJvbXB0VHJhbnNwb3J0OiBcImFyZ3ZcIixcblxuICAvLyBHZW1pbmkgcm91dGVzIGBwaGFzZWAgdG8gYSBtb2RlbCB0aHJvdWdoIGl0cyBvd24gdGFibGUgKElzc3VlICMzNjQpLCB0aGVcbiAgLy8gd2F5IENsYXVkZSBhbmQgQ29kZXggZG87IHRoZSBjaGFpbiBsaXZlcyBpbiBgZ2VtaW5pX2V4ZWN1dG9yLnRzYCBhbmQgaXNcbiAgLy8gbmV2ZXIgcmVzdGF0ZWQgaGVyZS4gVGhlIGVmZm9ydCByZXNvbHZlciByZXBvcnRzIHdoYXQgYSBwaGFzZSB3YXMgKmFza2VkKlxuICAvLyB0byBydW4gYXQg4oCUIHRoZSBDTEkgaGFzIG5vIGVmZm9ydCBvcHRpb24gdG8gaG9ub3VyIGl0IHdpdGgsIHNvIHRoZSB2YWx1ZVxuICAvLyBpcyB3YXJuZWQgYWJvdXQgcmF0aGVyIHRoYW4gdHVybmVkIGludG8gYW4gYXJndW1lbnQuXG4gIHJlc29sdmVNb2RlbChwaGFzZT86IHN0cmluZywgZW52PzogRW52TG9va3VwKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gcmVzb2x2ZUdlbWluaU1vZGVsKHBoYXNlLCBlbnYpO1xuICB9LFxuXG4gIHJlc29sdmVFZmZvcnQocGhhc2U/OiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiByZXNvbHZlR2VtaW5pRWZmb3J0KHBoYXNlKTtcbiAgfSxcblxuICBidWlsZEludm9jYXRpb24ocmVxdWVzdDogQWdlbnRJbnZvY2F0aW9uUmVxdWVzdCk6IHN0cmluZ1tdIHtcbiAgICBjb25zdCByb3V0aW5nID0gcmVzb2x2ZUludm9jYXRpb25Sb3V0aW5nKHRoaXMsIHJlcXVlc3QpO1xuICAgIHJldHVybiBidWlsZEdlbWluaUFyZ3Moe1xuICAgICAgcHJvbXB0OiByZXF1ZXN0LnByb21wdCxcbiAgICAgIHN5c3RlbVByb21wdDogcmVxdWVzdC5zeXN0ZW1Qcm9tcHQsXG4gICAgICBkaXNhbGxvd2VkVG9vbHM6IHJlcXVlc3QuZGlzYWxsb3dlZFRvb2xzLFxuICAgICAgbW9kZWw6IHJvdXRpbmcubW9kZWwsXG4gICAgICAvLyBObyBmbGFnIGNhcnJpZXMgYW4gZWZmb3J0IHVuZGVyIEdlbWluaSwgc28gdGhpcyBhZGRzIG5vIGFyZ3YgZWxlbWVudCDigJRcbiAgICAgIC8vIGl0IGlzIHBhc3NlZCBzbyB0aGUgZXhlY3V0b3IgY2FuIHdhcm4gb25jZSByYXRoZXIgdGhhbiBkcm9wIGl0XG4gICAgICAvLyBzaWxlbnRseSAoSXNzdWUgIzM2NCwgZmFpbC1sb3VkIHN0YW5kYXJkICMzMjM0KS5cbiAgICAgIGVmZm9ydDogcm91dGluZy5lZmZvcnQsXG4gICAgICBwaGFzZTogcmVxdWVzdC5waGFzZSxcbiAgICAgIC8vIEdlbWluaSByZXN1bWVzIGl0cyBvd24gbW9zdCByZWNlbnQgc2Vzc2lvbjsgdGhlIGZpcnN0IHBoYXNlIG9mIGFuXG4gICAgICAvLyBpc3N1ZSBzdGFydHMgb25lIGluc3RlYWQgKGBwaGFzZUNvdW50ID09PSAwYCkuXG4gICAgICByZXN1bWVTZXNzaW9uOiBidWlsZFNlc3Npb25SZXN1bWVGbGFncyhyZXF1ZXN0LnNlc3Npb25SZXN1bWVTdGF0ZSkucmVzdW1lLFxuICAgIH0pO1xuICB9LFxuXG4gIGJ1aWxkQ2hpbGRFbnYocGFyZW50RW52PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICAgIHJldHVybiBwYXJlbnRFbnYgPyBidWlsZEdlbWluaUNoaWxkRW52KHBhcmVudEVudikgOiBidWlsZEdlbWluaUNoaWxkRW52KCk7XG4gIH0sXG5cbiAgaXNBdXRoRXJyb3Iob3V0cHV0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gaXNHZW1pbmlBdXRoRXJyb3Iob3V0cHV0KTtcbiAgfSxcblxuICBhdXRoQWN0aW9uYWJsZU1lc3NhZ2UoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gZ2VtaW5pQXV0aEFjdGlvbmFibGVNZXNzYWdlKCk7XG4gIH0sXG59O1xuXG4vKipcbiAqIERlZXBTZWVrLCB0aGUgZm91cnRoIHJlZ2lzdGVyZWQgcHJvdmlkZXIgKElzc3VlICM0MTQsIHBhcmVudCAjMzk2KS5cbiAqXG4gKiBUaGUgb25lIHByb3ZpZGVyIHRoYXQgc2hpcHMgbm8gQ0xJIG9mIGl0cyBvd246IGl0IGlzIHRoZSAqKkNsYXVkZSBDb2RlIENMSSoqXG4gKiBwb2ludGVkIGF0IERlZXBTZWVrJ3MgQW50aHJvcGljLWNvbXBhdGlibGUgZW5kcG9pbnQsIHdoaWNoIGRlY2lkZXMgdGhyZWUgb2ZcbiAqIHRoaXMgZGVzY3JpcHRvcidzIGZpZWxkcy5cbiAqXG4gKiAtIGBiaW5hcnlgIGlzIGBkZWVwc2Vla2AsICoqbm90KiogYGNsYXVkZWAuIEJvdGggZnJhZ21lbnRzIGluc3RhbGwgdG9cbiAqICAgYC91c3IvbG9jYWwvYmluLzxiaW5hcnk+YCwgc28gYW4gaW1hZ2UgYnVpbHQgd2l0aFxuICogICBgQUdFTlRfUFJPVklERVJTPVwiY2xhdWRlLGRlZXBzZWVrXCJgIOKAlCB0aGUgUXVvcnVtIGRlcGxveW1lbnQgdGhpcyBwcm92aWRlclxuICogICBleGlzdHMgZm9yIOKAlCB3b3VsZCBvdGhlcndpc2UgaGF2ZSB0aGUgc2Vjb25kIGZyYWdtZW50IGNsb2JiZXIgdGhlIGZpcnN0LlxuICogICBBIGRpc3RpbmN0IGNvbW1hbmQgbmFtZSBhbHNvIG1ha2VzIHRoZSBwcm9jZXNzIHRhYmxlIHNheSB3aGljaCBwcm92aWRlciBpc1xuICogICBydW5uaW5nLlxuICogLSBUaGUgYXJndiBpcyBDbGF1ZGUncywgYnVpbHQgYnkge0BsaW5rIGJ1aWxkQ2xhdWRlQ2xpQXJnc30gcmF0aGVyIHRoYW5cbiAqICAgY29waWVkLCBiZWNhdXNlIGl0IGlzIGxpdGVyYWxseSB0aGUgc2FtZSBDTEkgcGFyc2luZyBpdC5cbiAqIC0gTm8gYC0tZWZmb3J0YCBpcyBldmVyIGVtaXR0ZWQ6IHRoZSBlbmRwb2ludCBkb2VzIG5vdCBpbXBsZW1lbnQgQW50aHJvcGljJ3NcbiAqICAgZWZmb3J0IGNvbnRyb2wsIHNvIHRoZSBlZmZvcnQgdGhlIHBoYXNlIHdhcyAqYXNrZWQqIHRvIHJ1biBhdCBpcyB3YXJuZWRcbiAqICAgYWJvdXQgb25jZSByYXRoZXIgdGhhbiBwYXNzZWQgKElzc3VlICMzNjQncyBHZW1pbmkgdHJlYXRtZW50KS4gVGhlcmUgaXMgbm9cbiAqICAgYGNoZWFwZXJNb2RlbGAgZWl0aGVyIOKAlCBEZWVwU2VlayBwdWJsaXNoZXMgbm8gY2hlYXBlciBydW5nLCBhbmQgdGhlXG4gKiAgIG9wdGlvbmFsIG1ldGhvZCBiZWluZyBhYnNlbnQgaXMgd2hhdCBtYWtlcyB0aGUgcmF0ZS1saW1pdCBmYWxsYmFjayByZXBvcnRcbiAqICAgYG5vLWxhZGRlci1mb3ItcHJvdmlkZXJgIGluc3RlYWQgb2YgYSBzaWxlbnQgbm8tb3AgKElzc3VlICMzNjUpLlxuICpcbiAqIEV2ZXJ5dGhpbmcgZWxzZSBkZWxlZ2F0ZXMgdG8gdGhlIERlZXBTZWVrLW93bmVkIG1vZHVsZXNcbiAqIChgZGVlcHNlZWtfZXhlY3V0b3IudHNgLCBgZGVlcHNlZWtfZW52LnRzYCwgYGRlZXBzZWVrX2F1dGgudHNgKS5cbiAqL1xuY29uc3QgREVFUFNFRUtfUFJPVklERVI6IEFnZW50UHJvdmlkZXJEZXNjcmlwdG9yID0ge1xuICBpZDogREVFUFNFRUtfUFJPVklERVJfSUQsXG4gIGRpc3BsYXlOYW1lOiBcIkRlZXBTZWVrXCIsXG4gIGJpbmFyeTogXCJkZWVwc2Vla1wiLFxuICBjcmVkZW50aWFsczoge1xuICAgIHN1YmRpcjogXCJkZWVwc2Vla1wiLFxuICAgIGZpbGU6IFwicHJvdmlkZXIuZW52XCIsXG4gICAgZW52VmFyczogREVFUFNFRUtfQ1JFREVOVElBTF9FTlZfVkFSUyxcbiAgICBwcm92aXNpb25FbnZWYXI6IFwiVklCRV9MQVVOQ0hBR0VOVF9ERUVQU0VFS19BUElfS0VZXCIsXG4gIH0sXG4gIC8vIERlZXBTZWVrIGJpbGxzIHBlciB0b2tlbiBhZ2FpbnN0IGFuIEFQSSBrZXkgKElzc3VlICMxOTIzKSwgdGhlIHNhbWUgYXNcbiAgLy8gR2VtaW5pOiBtZXRlcmVkLCBhbmQgbmV2ZXIgYW4gYXV0b21hdGljLXJvdXRpbmcgY2FuZGlkYXRlLlxuICBiaWxsaW5nOiB7XG4gICAgc3Vic2NyaXB0aW9uRW52VmFyczogW10sXG4gICAgbWV0ZXJlZEVudlZhcnM6IERFRVBTRUVLX0NSRURFTlRJQUxfRU5WX1ZBUlMsXG4gIH0sXG4gIGVudmlyb25tZW50OiB7XG4gICAgc2VjcmV0QWxsb3dsaXN0OiBERUVQU0VFS19FTlZfU0VDUkVUX0FMTE9XTElTVCxcbiAgICBkZW55bGlzdDogREVFUFNFRUtfRU5WX0RFTllMSVNULFxuICB9LFxuICBpbnN0YWxsOiB7IGZyYWdtZW50OiBgJHtQUk9WSURFUl9GUkFHTUVOVF9ESVJ9L2RlZXBzZWVrLnNoYCB9LFxuICAvLyBUaGUgc2FtZSBDTEkgYXMgQ2xhdWRlLCBzbyBhIGJhcmUgYC1wYCByZWFkcyB0aGUgcHJvbXB0IGZyb20gc3RkaW5cbiAgLy8gKElzc3VlICM0Mzg1KS5cbiAgcHJvbXB0VHJhbnNwb3J0OiBcInN0ZGluXCIsXG4gIC8vIFRoZSBzYW1lIENMSSBhcyBDbGF1ZGUsIHNvIHRoZSBzYW1lIGV2ZW50IGRlY29kZXIgKElzc3VlICMxNjk1KSwgYnV0XG4gIC8vIHJlZnVzYWxzIHRoYXQgbmFtZSBEZWVwU2VlayAoSXNzdWUgIzI2MzMpOyBkZWZlcnJlZCBmb3IgdGhlIHNhbWUgaW1wb3J0XG4gIC8vIGN5Y2xlLlxuICBnZXQgb3V0cHV0KCk6IEFnZW50T3V0cHV0QWRhcHRlciB7XG4gICAgcmV0dXJuIERFRVBTRUVLX09VVFBVVF9BREFQVEVSO1xuICB9LFxuXG4gIC8vIEV2ZXJ5IHBoYXNlIGlzIHBpbm5lZCB0byBhIHJlYWwgRGVlcFNlZWsgbW9kZWwgaWQ6IENsYXVkZSdzIHJvdXRpbmdcbiAgLy8gcmVzb2x2ZXMgdG8gQW50aHJvcGljIHRpZXIgYWxpYXNlcyB0aGUgZW5kcG9pbnQgY2Fubm90IHJlc29sdmUsIGFuZCBhXG4gIC8vIHByb3ZpZGVyIHdpdGggbm8gcm91dGluZyBvZiBpdHMgb3duIHdvdWxkIHNlbmQgb25lIChJc3N1ZSAjNDEzKS5cbiAgcmVzb2x2ZU1vZGVsKHBoYXNlPzogc3RyaW5nLCBlbnY/OiBFbnZMb29rdXApOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiByZXNvbHZlRGVlcFNlZWtNb2RlbChwaGFzZSwgZW52KTtcbiAgfSxcblxuICByZXNvbHZlRWZmb3J0KHBoYXNlPzogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gcmVzb2x2ZURlZXBTZWVrRWZmb3J0KHBoYXNlKTtcbiAgfSxcblxuICAvLyBUaGUgdmVuZG9yIHNlcnZlcyB1cGdyYWRlcyBhbmQgaXRzIGRvY3VtZW50ZWQgbGVnYWN5IGFsaWFzIGluc3RlYWQgb2YgdGhlXG4gIC8vIHJlcXVlc3RlZCBpZDsgb25seSBhIGRvd25ncmFkZSBmYWlscyB0aGUgc2VydmVkLXZzLWV4cGVjdGVkIGNoZWNrXG4gIC8vIChJc3N1ZSAjMjA1MykuXG4gIHNlcnZlZE1vZGVsU2F0aXNmaWVzKHNlcnZlZDogc3RyaW5nLCBleHBlY3RlZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIGRlZXBTZWVrU2VydmVkTW9kZWxTYXRpc2ZpZXMoc2VydmVkLCBleHBlY3RlZCk7XG4gIH0sXG5cbiAgLy8gQSB0aWVyIG91dGFnZSBhZGFwdHMgaW4gcGxhY2U6IHRoZSBiYXNlIHRpZXIncyBwaGFzZXMgbW92ZSB0byB0aGUgdG9wXG4gIC8vIHRpZXIgZm9yIHRoaXMgcnVuLCBhbmQgdGhlIGhlYWx0aCBnYXRlIGRyaXZlcyB0aGUgcHJvYmUgKElzc3VlICMyMDU5KS5cbiAgYWx0ZXJuYXRpdmVNb2RlbHMobW9kZWw6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gZGVlcFNlZWtBbHRlcm5hdGl2ZU1vZGVscyhtb2RlbCk7XG4gIH0sXG5cbiAgYXBwbHlNb2RlbEFkYXB0YXRpb24odW5hdmFpbGFibGU6IHN0cmluZywgYWx0ZXJuYXRpdmU6IHN0cmluZyk6IHZvaWQge1xuICAgIGFwcGx5RGVlcFNlZWtNb2RlbEFkYXB0YXRpb24odW5hdmFpbGFibGUsIGFsdGVybmF0aXZlKTtcbiAgfSxcblxuICBidWlsZEludm9jYXRpb24ocmVxdWVzdDogQWdlbnRJbnZvY2F0aW9uUmVxdWVzdCk6IHN0cmluZ1tdIHtcbiAgICBjb25zdCByb3V0aW5nID0gcmVzb2x2ZUludm9jYXRpb25Sb3V0aW5nKHRoaXMsIHJlcXVlc3QpO1xuICAgIC8vIFRoZSBlZmZvcnQgcmVzb2x2ZXIgcmVwb3J0cyB3aGF0IHRoZSBwaGFzZSB3YXMgYXNrZWQgdG8gcnVuIGF0OyBubyBmbGFnXG4gICAgLy8gY2FuIGNhcnJ5IGl0IGhlcmUsIHNvIGl0IGlzIHN0YXRlZCBsb3VkbHkgb25jZSBwZXIgcGhhc2UgcmF0aGVyIHRoYW5cbiAgICAvLyBkcm9wcGVkIGluIHNpbGVuY2UgKElzc3VlICMzMjM0KSDigJQgYW5kIG5ldmVyIHJlYWNoZXMgdGhlIGFyZ3YsIHdoZXJlIHRoZVxuICAgIC8vIEFudGhyb3BpYyBDTEkgd291bGQgaGFwcGlseSBmb3J3YXJkIGl0IHRvIGFuIGVuZHBvaW50IHRoYXQgcmVqZWN0cyBpdC5cbiAgICBpZiAocm91dGluZy5lZmZvcnQpIHtcbiAgICAgIHdhcm5EZWVwU2Vla0VmZm9ydFVuc3VwcG9ydGVkKHJvdXRpbmcuZWZmb3J0LCByZXF1ZXN0LnBoYXNlKTtcbiAgICB9XG4gICAgLy8gU3ViLWFnZW50IGRlZmluaXRpb25zIChJc3N1ZSAjMjM0MikgbmFtZSBBbnRocm9waWMgdGllciBhbGlhc2VzIHRoaXNcbiAgICAvLyBlbmRwb2ludCBjYW5ub3QgcmVzb2x2ZSwgc28gdGhleSBhcmUgZHJvcHBlZCBmcm9tIHRoZSBhcmd2IOKAlCBidXQgc3RhdGVkLFxuICAgIC8vIG5ldmVyIGluIHNpbGVuY2UuIFRoZSBpc3N1ZS1ydW4gcGF0aCByZXJvdXRlcyBzdWNoIGEgcnVuIHRvIENsYXVkZSBvclxuICAgIC8vIHN0cmlwcyB0aGUgZGVmaW5pdGlvbnMgYmVmb3JlIHNwYXduIChsaWIvaXNzdWVfcnVuX3Byb3ZpZGVyX2FnZW50cy50cyk7XG4gICAgLy8gdGhlIHJ1bm5lcidzIHJlZnVzYWwgb2YgYSBuYXRpdmUgcnVuIHdob3NlIGFyZ3YgbG9zdCBpdHMgYC0tYWdlbnRzYFxuICAgIC8vIChJc3N1ZSAjNDAxMCkgaXMgb25seSBhIGJhY2tzdG9wLCBzbyBhIHNwbGl0IGNvbmZpZ3VyZWQgdW5kZXIgRGVlcFNlZWtcbiAgICAvLyBuZXZlciBydW5zIGFzIG9uZSB0aGF0IGxvb2tzIHNwbGl0IGFuZCBpcyBub3QuXG4gICAgLy8gVGhlIGFkdmlzb3IgZWRpdCBndWFyZCBnb2VzIHdpdGggdGhlbSAoSXNzdWUgIzIzNDQpOiB3aXRob3V0IGV4ZWN1dG9yc1xuICAgIC8vIHRvIG1ha2UgdGhlIGVkaXRzLCBhIGd1YXJkIGhlcmUgd291bGQgZGVueSB0aGUgYWR2aXNvcidzIG93biBhbmQgbGVhdmVcbiAgICAvLyB0aGUgcnVuIHVuYWJsZSB0byBlZGl0IGFueXRoaW5nLlxuICAgIGNvbnN0IHsgYWdlbnRzLCBzZXR0aW5nc0pzb246IF9ndWFyZCwgLi4uZGVlcFNlZWtSZXF1ZXN0IH0gPSByZXF1ZXN0O1xuICAgIGlmIChhZ2VudHMpIHdhcm5EZWVwU2Vla0FnZW50c1Vuc3VwcG9ydGVkKHJlcXVlc3QucGhhc2UpO1xuICAgIHJldHVybiBidWlsZENsYXVkZUNsaUFyZ3MoXG4gICAgICB7XG4gICAgICAgIC4uLmRlZXBTZWVrUmVxdWVzdCxcbiAgICAgICAgc2Vzc2lvblJlc3VtZVN0YXRlOiBzZXNzaW9uUmVzdW1lRm9yUHJvdmlkZXIoXG4gICAgICAgICAgcmVxdWVzdC5zZXNzaW9uUmVzdW1lU3RhdGUsXG4gICAgICAgICAgdGhpcy5pZCxcbiAgICAgICAgKSxcbiAgICAgICAgLy8gSG9va3MgYXJlIGFuIEFudGhyb3BpYy1lbmRwb2ludCBmZWF0dXJlIChJc3N1ZSAjMjM4Myk6IHRoZSBzaGFyZWRcbiAgICAgICAgLy8gYmluYXJ5IHdvdWxkIGZvcndhcmQgYC0tc2V0dGluZ3NgIHRvIGFuIGVuZHBvaW50IHRoYXQgcnVucyBub3RoaW5nLFxuICAgICAgICAvLyBzbyB0aGUgcGF5bG9hZCBpcyBkcm9wcGVkIGhlcmUgcmF0aGVyIHRoYW4gaW4gdGhlIGNhbGxlci5cbiAgICAgICAgc2V0dGluZ3NKc29uOiB1bmRlZmluZWQsXG4gICAgICB9LFxuICAgICAgeyBtb2RlbDogcm91dGluZy5tb2RlbCB9LFxuICAgICk7XG4gIH0sXG5cbiAgYnVpbGRDaGlsZEVudihwYXJlbnRFbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gICAgcmV0dXJuIHBhcmVudEVudlxuICAgICAgPyBidWlsZERlZXBTZWVrQ2hpbGRFbnYocGFyZW50RW52KVxuICAgICAgOiBidWlsZERlZXBTZWVrQ2hpbGRFbnYoKTtcbiAgfSxcblxuICBpc0F1dGhFcnJvcihvdXRwdXQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIHJldHVybiBpc0RlZXBTZWVrQXV0aEVycm9yKG91dHB1dCk7XG4gIH0sXG5cbiAgYXV0aEFjdGlvbmFibGVNZXNzYWdlKCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGRlZXBTZWVrQXV0aEFjdGlvbmFibGVNZXNzYWdlKCk7XG4gIH0sXG59O1xuXG4vKiogRXZlcnkgcmVnaXN0ZXJlZCBwcm92aWRlciwga2V5ZWQgYnkgaWQuICovXG5jb25zdCBBR0VOVF9QUk9WSURFUlMgPSBuZXcgTWFwPHN0cmluZywgQWdlbnRQcm92aWRlckRlc2NyaXB0b3I+KFtcbiAgW0NMQVVERV9QUk9WSURFUi5pZCwgQ0xBVURFX1BST1ZJREVSXSxcbiAgW0NPREVYX1BST1ZJREVSLmlkLCBDT0RFWF9QUk9WSURFUl0sXG4gIFtHRU1JTklfUFJPVklERVIuaWQsIEdFTUlOSV9QUk9WSURFUl0sXG4gIFtERUVQU0VFS19QUk9WSURFUi5pZCwgREVFUFNFRUtfUFJPVklERVJdLFxuXSk7XG5cbi8qKlxuICogVGhlIGlkcyBvZiBldmVyeSByZWdpc3RlcmVkIHByb3ZpZGVyLlxuICpcbiAqIEByZXR1cm5zIFByb3ZpZGVyIGlkcyBpbiByZWdpc3RyYXRpb24gb3JkZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhZ2VudFByb3ZpZGVySWRzKCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFsuLi5BR0VOVF9QUk9WSURFUlMua2V5cygpXTtcbn1cblxuLyoqXG4gKiBMb29rIHVwIGEgcmVnaXN0ZXJlZCBwcm92aWRlciB3aXRob3V0IGZhaWxpbmcgb24gYW4gdW5rbm93biBpZC5cbiAqXG4gKiB7QGxpbmsgcmVzb2x2ZUFnZW50UHJvdmlkZXJ9IHRocm93cywgd2hpY2ggaXMgcmlnaHQgd2hlcmUgYW4gb3BlcmF0b3JcbiAqIHN0YXRlZCBhIHByb3ZpZGVyIGFuZCBnb3QgaXQgd3JvbmcuIEEgY2FsbGVyIG1lcmVseSAqYXNraW5nIGFib3V0KiBhbiBpZCDigJRcbiAqIHRoZSBiaWxsaW5nIGNsYXNzaWZpZXIgKElzc3VlICMxOTIzKSDigJQgbmVlZHMgXCJubyBzdWNoIHByb3ZpZGVyXCIgYXMgYW5cbiAqIGFuc3dlciByYXRoZXIgdGhhbiBhbiBleGNlcHRpb24uXG4gKlxuICogQHBhcmFtIGlkIC0gUHJvdmlkZXIgaWQsIHRyaW1tZWQgYmVmb3JlIGxvb2t1cC5cbiAqIEByZXR1cm5zIFRoZSBkZXNjcmlwdG9yLCBvciB1bmRlZmluZWQgd2hlbiBub3RoaW5nIGlzIHJlZ2lzdGVyZWQgdW5kZXIgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhZ2VudFByb3ZpZGVyQnlJZChcbiAgaWQ6IHN0cmluZyxcbik6IEFnZW50UHJvdmlkZXJEZXNjcmlwdG9yIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIEFHRU5UX1BST1ZJREVSUy5nZXQoaWQudHJpbSgpKTtcbn1cblxuLyoqXG4gKiBUaGUgcHJvdmlkZXIgc3RhbmRpbmcgaW4gZm9yIHRoZSBjb25maWd1cmVkIG9uZSAqKmZvciB0aGlzIHJ1bioqXG4gKiAoSXNzdWUgIzIwNjIpLCBzZXQgYnkgdGhlIGhlYWx0aCBnYXRlJ3MgZmFsbGJhY2sgc3dpdGNoLlxuICpcbiAqIE1vZHVsZS1sZXZlbCByYXRoZXIgdGhhbiBhIGZpbGUgKElzc3VlICMyMDY1KTogdGhlIG9ic2VydmVkIHJldmVydCB3YXNcbiAqIGluLXByb2Nlc3Mg4oCUIHRoZSBiZXN0LWVmZm9ydCBjb25maWcgbG9hZGVycyByZWxvYWQgdGhlIGNvbmZpZyBhbmQgcmVzZXRcbiAqIHRoZSBtb2R1bGUgc3RhdGUgdG8gdGhlIGZpbGUncyBwcmVmZXJyZWQgaWQg4oCUIHNvIGEgbW9kdWxlIHJlY29yZCB0aGVcbiAqIHJlc29sdmVyIGNvbnN1bHRzICoqYmVmb3JlKiogdGhlIGZpbGUncyB2YWx1ZSBzdXJ2aXZlcyBldmVyeSByZWxvYWQgYW5kXG4gKiBuZWVkcyBubyBmaWxlc3lzdGVtIHdyaXRlICh0aGUgZmlsZSBiZXNpZGUgdGhlIHJlYWQtb25seSBjb25maWcgc3RhZ2luZ1xuICogZGlyIGNyYXNoZWQgdGhlIHJ1bikuXG4gKi9cbmxldCBfcnVuUHJvdmlkZXJPdmVycmlkZUlkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cbi8qKlxuICogUmVjb3JkIHRoZSBwZXItcnVuIHByb3ZpZGVyIG92ZXJyaWRlIChJc3N1ZSAjMjA2MikuXG4gKlxuICogVGhlIGhlYWx0aCBnYXRlIHNldHMgaXQgd2hlbiBpdHMgZmFsbGJhY2sgc3dpdGNoIGZpcmVzOyB0aGUgcnVuLWNvcmVcbiAqIGNvbW1hbmQgY2xlYXJzIGl0IGF0IHJ1biBzdGFydCBzbyBlYWNoIHJ1biByZS1ldmFsdWF0ZXMgdGhlIGNvbmZpZ3VyZWRcbiAqIHByZWZlcnJlZCBwcm92aWRlciBmaXJzdC4gQW4gdW5yZWdpc3RlcmVkIGlkIGZhaWxzIGxvdWRseSDigJQgdGhlIGdhdGVcbiAqIG9ubHkgc2V0cyBpZHMgaXQgcHJvYmVkIGhlYWx0aHkuXG4gKlxuICogQHBhcmFtIGlkIC0gVGhlIHByb3ZpZGVyIGlkIHRvIHN0YW5kIGluIGZvciB0aGUgY29uZmlndXJlZCBvbmUsIG9yXG4gKiAgIHVuZGVmaW5lZCB0byBjbGVhci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldFJ1blByb3ZpZGVyT3ZlcnJpZGUoaWQ6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHZvaWQge1xuICBfcnVuUHJvdmlkZXJPdmVycmlkZUlkID0gaWQgPT09IHVuZGVmaW5lZFxuICAgID8gdW5kZWZpbmVkXG4gICAgOiByZXNvbHZlQWdlbnRQcm92aWRlcihpZCkuaWQ7XG59XG5cbi8qKlxuICogVGhlIHBlci1ydW4gcHJvdmlkZXIgb3ZlcnJpZGUgY3VycmVudGx5IGluIGZvcmNlIChJc3N1ZSAjMjA2MikuXG4gKlxuICogQHJldHVybnMgVGhlIGNhbm9uaWNhbCBvdmVycmlkZSBpZCwgb3IgdW5kZWZpbmVkIHdoZW4gdGhlcmUgaXMgbm9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJ1blByb3ZpZGVyT3ZlcnJpZGVJZCgpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICByZXR1cm4gX3J1blByb3ZpZGVyT3ZlcnJpZGVJZDtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIGEgcHJvdmlkZXIgZGVzY3JpcHRvciBieSBpZC5cbiAqXG4gKiBAcGFyYW0gaWQgLSBQcm92aWRlciBpZCBmcm9tIGNvbmZpZ3VyYXRpb24sIHRoZSBlbnZpcm9ubWVudCwgb3IgYSBjYWxsZXIuXG4gKiBAcmV0dXJucyBUaGUgZGVzY3JpcHRvci5cbiAqIEB0aHJvd3MgV2hlbiB0aGUgaWQgaXMgYmxhbmsgb3Igbm90IHJlZ2lzdGVyZWQg4oCUIG5hbWluZyBldmVyeSBzdXBwb3J0ZWQgaWQsXG4gKiAgIHNvIGFuIG9wZXJhdG9yIHNlZXMgd2hhdCB0byBjaG9vc2UgaW5zdGVhZCAoSXNzdWUgIzMyMzQpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUFnZW50UHJvdmlkZXIoaWQ6IHN0cmluZyk6IEFnZW50UHJvdmlkZXJEZXNjcmlwdG9yIHtcbiAgY29uc3Qgd2FudGVkID0gaWQudHJpbSgpO1xuICBjb25zdCBwcm92aWRlciA9IHdhbnRlZCA9PT0gXCJcIiA/IHVuZGVmaW5lZCA6IEFHRU5UX1BST1ZJREVSUy5nZXQod2FudGVkKTtcbiAgaWYgKCFwcm92aWRlcikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBVbnN1cHBvcnRlZCBjb2RpbmctYWdlbnQgcHJvdmlkZXIgJHtKU09OLnN0cmluZ2lmeShpZCl9LiBgICtcbiAgICAgICAgYFN1cHBvcnRlZCBwcm92aWRlcnM6ICR7YWdlbnRQcm92aWRlcklkcygpLmpvaW4oXCIsIFwiKX0uIGAgK1xuICAgICAgICBgU2V0IFwiJHtBR0VOVF9QUk9WSURFUl9DT05GSUdfS0VZfVwiIGluIC5jb25maWcuanNvbiAob3IgYCArXG4gICAgICAgIGAke0FHRU5UX1BST1ZJREVSX0VOVn0pIHRvIG9uZSBvZiB0aG9zZSBpZHMuYCxcbiAgICApO1xuICB9XG4gIHJldHVybiBwcm92aWRlcjtcbn1cblxuLyoqXG4gKiBUaGUgcHJvdmlkZXIgYSByZXBvc2l0b3J5IHBpbm5lZCBpbiBgcmVwb19jb25maWcuPHJlcG8+LmFnZW50X3Byb3ZpZGVyYFxuICogKElzc3VlICMyMDQ4KSwgdmFsaWRhdGVkLlxuICpcbiAqIEV2ZXJ5IHNvdXJjZSB0aGF0IHN0YXRlcyBhIHZhbHVlIGlzIHZhbGlkYXRlZCwgbm90IGp1c3QgdGhlIG9uZSB0aGF0IGJpbmRzXG4gKiAoSXNzdWUgIzMyMzQpOiBhIHJlcG8gcGluIG5hbWluZyBhbiB1bnJlZ2lzdGVyZWQgaWQgdGhyb3dzIGhlcmUsIG5hbWluZyB0aGVcbiAqIGtleSBpdCB3YXMgd3JpdHRlbiB1bmRlci4gQSBibGFuayBwaW4gaXMgdGhlIHNhbWUgYXMgbm8gcGluIOKAlCBhbiBlbXB0eVxuICogc3RyaW5nIGNhbiBuZXZlciBzZWxlY3QgYSBwcm92aWRlci5cbiAqXG4gKiBAcGFyYW0gcmVwb0NvbmZpZyAtIFRoZSByZXBvJ3MgbWVyZ2VkIFJlcG9Db25maWcsIG9yIHVuZGVmaW5lZC5cbiAqIEByZXR1cm5zIFRoZSBjYW5vbmljYWwgcHJvdmlkZXIgaWQsIG9yIHVuZGVmaW5lZCB3aGVuIHRoZSByZXBvIHBpbnMgbm9uZS5cbiAqIEB0aHJvd3MgV2hlbiB0aGUgcGluIG5hbWVzIGFuIHVucmVnaXN0ZXJlZCBwcm92aWRlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9QaW5uZWRBZ2VudFByb3ZpZGVyKFxuICByZXBvQ29uZmlnOiBSZXBvQ29uZmlnIHwgdW5kZWZpbmVkLFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcGlubmVkID0gcmVwb0NvbmZpZz8uYWdlbnRQcm92aWRlcj8udHJpbSgpO1xuICBpZiAoIXBpbm5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgcHJvdmlkZXIgPSBBR0VOVF9QUk9WSURFUlMuZ2V0KHBpbm5lZCk7XG4gIGlmICghcHJvdmlkZXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgVW5zdXBwb3J0ZWQgY29kaW5nLWFnZW50IHByb3ZpZGVyICR7SlNPTi5zdHJpbmdpZnkocGlubmVkKX0gaW4gYCArXG4gICAgICAgIGByZXBvX2NvbmZpZy48cmVwbz4uYWdlbnRfcHJvdmlkZXIuIFN1cHBvcnRlZCBwcm92aWRlcnM6IGAgK1xuICAgICAgICBgJHthZ2VudFByb3ZpZGVySWRzKCkuam9pbihcIiwgXCIpfS5gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHByb3ZpZGVyLmlkO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIHByb3ZpZGVyIHNlbGVjdGlvbiBmb3Igb25lIGludm9jYXRpb24sIHJlcG8gcGluIGxheWVyZWQgaW5cbiAqIChJc3N1ZSAjMjA0OCkuXG4gKlxuICogQW4gZXhwbGljaXQgcGVyLWludm9jYXRpb24gc2VsZWN0aW9uIOKAlCBhIFF1b3J1bSBkcmFmdCBuYW1pbmcgaXRzIHByb3ZpZGVyLFxuICogYSBjYWxsZXIgcGluIOKAlCBzdGF5cyBhYnNvbHV0ZSAoSXNzdWUgIzQxMDkpLiBPdGhlcndpc2UgdGhlIHJlcG9zaXRvcnkncyBvd25cbiAqIHBpbiBiaW5kczsgd2l0aCBuZWl0aGVyLCB0aGUgcmVzdWx0IGlzIGB1bmRlZmluZWRgIGFuZCB0aGUgY2FsbGVyIGtlZXBzIHRoZVxuICogcHJvY2Vzcy13aWRlIGRlZmF1bHQsIHdoaWNoIGlzIGFsc28gaG93IGBhZ2VudF9wcm92aWRlcl9tb2RlOiBcImF1dG9cImAgbW92ZXNcbiAqIHRoZSBkZWZhdWx0IGJldHdlZW4gd29yayBpdGVtcyDigJQgYSByZXBvIHBpbiBpcyBhbiBleHBsaWNpdCBvcGVyYXRvciBwaW4gYW5kXG4gKiB3aW5zIG92ZXIgdGhlIHJhbmssIGV4YWN0bHkgbGlrZSBgVklCRV9BR0VOVF9QUk9WSURFUmAgZG9lcy5cbiAqXG4gKiBAcGFyYW0gZXhwbGljaXQgLSBUaGUgY2FsbGVyJ3MgcGVyLWludm9jYXRpb24gc2VsZWN0aW9uLCB3aGVuIGFueS5cbiAqIEBwYXJhbSByZXBvQ29uZmlnIC0gVGhlIGludm9jYXRpb24ncyByZXBvIGNvbmZpZywgd2hlbiBrbm93bi5cbiAqIEByZXR1cm5zIFRoZSBzZWxlY3Rpb24gdG8gaGFuZCB0byB7QGxpbmsgc2VsZWN0QWdlbnRQcm92aWRlcn0sIG9yIHVuZGVmaW5lZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVJbnZvY2F0aW9uQWdlbnRQcm92aWRlcihcbiAgZXhwbGljaXQ6IEFnZW50UHJvdmlkZXJTZWxlY3RvciB8IHVuZGVmaW5lZCxcbiAgcmVwb0NvbmZpZzogUmVwb0NvbmZpZyB8IHVuZGVmaW5lZCxcbik6IEFnZW50UHJvdmlkZXJTZWxlY3RvciB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBleHBsaWNpdCA/PyByZXBvUGlubmVkQWdlbnRQcm92aWRlcihyZXBvQ29uZmlnKTtcbn1cblxuLyoqXG4gKiBUaGUgcHJvdmlkZXIgYC5jb25maWcuanNvbmAgc2VsZWN0ZWQsIG9uY2UgY29uZmlndXJhdGlvbiBoYXMgYmVlbiBsb2FkZWQuXG4gKlxuICogVGhlIGxvdy1sZXZlbCBtb2R1bGVzIHRoYXQgc3Bhd24gdGhlIGFnZW50IGhvbGQgbm8gY29uZmlndXJhdGlvbiBoYW5kbGUsIHNvXG4gKiBgbG9hZENvbmZpZ2AgcmVjb3JkcyB0aGUgc2VsZWN0aW9uIGhlcmUgYW5kIHRoZXkgcmVhZCBpdCBiYWNrIHRocm91Z2hcbiAqIHtAbGluayByZXNvbHZlQWdlbnRQcm92aWRlcklkfS5cbiAqL1xubGV0IGNvbmZpZ3VyZWRQcm92aWRlcklkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cbi8qKlxuICogUmVjb3JkIHRoZSBwcm92aWRlciBzZWxlY3RlZCBieSBjb25maWd1cmF0aW9uLlxuICpcbiAqIEBwYXJhbSBpZCAtIFByb3ZpZGVyIGlkIGZyb20gYC5jb25maWcuanNvbmAsIG9yIHVuZGVmaW5lZCB0byBjbGVhciBpdC5cbiAqIEB0aHJvd3MgV2hlbiB0aGUgaWQgaXMgc2V0IGJ1dCB1bnN1cHBvcnRlZCAoSXNzdWUgIzMyMzQpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0Q29uZmlndXJlZEFnZW50UHJvdmlkZXJJZChpZDogc3RyaW5nIHwgdW5kZWZpbmVkKTogdm9pZCB7XG4gIGNvbnN0IHdhbnRlZCA9IGlkPy50cmltKCk7XG4gIGNvbmZpZ3VyZWRQcm92aWRlcklkID0gd2FudGVkID8gcmVzb2x2ZUFnZW50UHJvdmlkZXIod2FudGVkKS5pZCA6IHVuZGVmaW5lZDtcbn1cblxuLyoqIFdoZXJlIGEgcHJvdmlkZXIgc2VsZWN0aW9uIG1heSBjb21lIGZyb20uICovXG5leHBvcnQgaW50ZXJmYWNlIEFnZW50UHJvdmlkZXJTZWxlY3Rpb24ge1xuICAvKiogVGhlIGAuY29uZmlnLmpzb25gIHZhbHVlLCB3aGVuIHNldC4gKi9cbiAgY29uZmlndXJlZD86IHN0cmluZztcbiAgLyoqIEVudmlyb25tZW50IGxvb2t1cCAoZGVmYXVsdHMgdG8gdGhlIHByb2Nlc3MgZW52aXJvbm1lbnQpLiAqL1xuICBlbnY/OiAobmFtZTogc3RyaW5nKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgYWN0aXZlIHByb3ZpZGVyIGlkLlxuICpcbiAqIFByZWNlZGVuY2UgaXMgdGhlIHJ1bGUgYGNvbmZpZ19wcmVjZWRlbmNlLnRzYCBzdGF0ZXMgZm9yIGV2ZXJ5IGtub2JcbiAqIChJc3N1ZSAjMTAzMik6IHRoZSBgLmNvbmZpZy5qc29uYCBgYWdlbnRfcHJvdmlkZXJgIGtleSwgdGhlblxuICogYFZJQkVfQUdFTlRfUFJPVklERVJgLCB0aGVuIENsYXVkZS4gQW55IHZhbHVlIHRoYXQgaXMgc2V0IGJ1dCB1bnN1cHBvcnRlZFxuICogZmFpbHMgbG91ZGx5IHJhdGhlciB0aGFuIGZhbGxpbmcgYmFjay5cbiAqXG4gKiBUaGUgcmVzb2x2ZWQgaWQgaXMgY2hlY2tlZCBhZ2FpbnN0IHRoZSBzZXQgdGhlIHJ1bm5pbmcgaW1hZ2UgaW5zdGFsbGVkXG4gKiAoSXNzdWUgIzQxMDUpLCBzbyBhc2tpbmcgZm9yIGFuIGFnZW50IHRoaXMgaW1hZ2UgZG9lcyBub3QgY2FycnkgZmFpbHMgaGVyZVxuICogcmF0aGVyIHRoYW4gYXMgYSBcImNvbW1hbmQgbm90IGZvdW5kXCIgbWlkLXJ1bi5cbiAqXG4gKiBAcGFyYW0gc2VsZWN0aW9uIC0gQ29uZmlndXJlZCB2YWx1ZSBhbmQgZW52aXJvbm1lbnQgbG9va3VwLlxuICogQHJldHVybnMgVGhlIGFjdGl2ZSBwcm92aWRlciBpZC5cbiAqIEB0aHJvd3MgV2hlbiBhIHNldCB2YWx1ZSBuYW1lcyBhbiB1bnN1cHBvcnRlZCBwcm92aWRlciwgb3IgdGhlIHJ1bm5pbmdcbiAqICAgaW1hZ2UgZGlkIG5vdCBpbnN0YWxsIHRoZSByZXNvbHZlZCBvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQWdlbnRQcm92aWRlcklkKFxuICBzZWxlY3Rpb246IEFnZW50UHJvdmlkZXJTZWxlY3Rpb24gPSB7fSxcbik6IHN0cmluZyB7XG4gIGNvbnN0IGVudiA9IHNlbGVjdGlvbi5lbnYgPz8gKChuYW1lOiBzdHJpbmcpID0+IERlbm8uZW52LmdldChuYW1lKSk7XG5cbiAgY29uc3QgaWQgPSByZXNvbHZlU2VsZWN0ZWRQcm92aWRlcklkKHNlbGVjdGlvbiwgZW52KTtcbiAgYXNzZXJ0SW1hZ2VJbnN0YWxsZWRQcm92aWRlcihpZCwgeyBlbnYgfSk7XG4gIHJldHVybiBpZDtcbn1cblxuLyoqXG4gKiBUaGUgY29uZmlndXJlZCBwcmVmZXJyZWQgcHJvdmlkZXIg4oCUIHtAbGluayByZXNvbHZlQWdlbnRQcm92aWRlcklkfSB3aXRob3V0XG4gKiB0aGUgcGVyLXJ1biBmYWxsYmFjayBvdmVycmlkZSAoSXNzdWUgIzI2MzgpLlxuICpcbiAqIEEgc3RyZWFtIHNlc3Npb24gcmVjb3JkZWQgYmVmb3JlIGl0cyBjcmVhdG9yIHdhcyBzdG9yZWQgaXMgcHJlc3VtZWQgdG8gYmVcbiAqIHRoaXMgcHJvdmlkZXInczogdGhlIGZhbGxiYWNrIG9ubHkgZXZlciBzdG9vZCBpbiBmb3IgaXQsIHNvIHRoZSBwcmVmZXJyZWRcbiAqIHByb3ZpZGVyIGlzIHRoZSBvbmUgdGhhdCBidWlsdCBldmVyeSBjb252ZXJzYXRpb24gdGhlIHJlY29yZCBjb3VsZCBob2xkLlxuICpcbiAqIEBwYXJhbSBzZWxlY3Rpb24gLSBDb25maWd1cmVkIHZhbHVlIGFuZCBlbnZpcm9ubWVudCBsb29rdXAuXG4gKiBAcmV0dXJucyBUaGUgcHJlZmVycmVkIHByb3ZpZGVyIGlkLlxuICogQHRocm93cyBXaGVuIGEgc2V0IHZhbHVlIG5hbWVzIGFuIHVuc3VwcG9ydGVkIHByb3ZpZGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcHJlZmVycmVkQWdlbnRQcm92aWRlcklkKFxuICBzZWxlY3Rpb246IEFnZW50UHJvdmlkZXJTZWxlY3Rpb24gPSB7fSxcbik6IHN0cmluZyB7XG4gIGNvbnN0IGVudiA9IHNlbGVjdGlvbi5lbnYgPz8gKChuYW1lOiBzdHJpbmcpID0+IERlbm8uZW52LmdldChuYW1lKSk7XG4gIHJldHVybiByZXNvbHZlU2VsZWN0ZWRQcm92aWRlcklkKHNlbGVjdGlvbiwgZW52LCB7IGhvbm91ck92ZXJyaWRlOiBmYWxzZSB9KTtcbn1cblxuLyoqXG4gKiBUaGUgaWQgY29uZmlndXJhdGlvbiwgdGhlIGVudmlyb25tZW50LCBvciB0aGUgZGVmYXVsdCBzZWxlY3RzLlxuICpcbiAqIFRoZSBvcmRlciBpcyBgcmVzb2x2ZVNldHRpbmdgJ3MsIG5vdCB0aGlzIG1vZHVsZSdzIG93biAoSXNzdWUgIzEwMzIpOiB0aGVcbiAqIGZpbGUgd2lucywgYFZJQkVfQUdFTlRfUFJPVklERVJgIGFwcGxpZXMgd2hlbiB0aGUgZmlsZSBzZWxlY3RzIG5vdGhpbmcsIGFuZFxuICogQ2xhdWRlIGFwcGxpZXMgd2hlbiBuZWl0aGVyIGRvZXMuIEEgcnVuIHRoYXQgc3RpbGwgdGFrZXMgaXRzIHByb3ZpZGVyIGZyb21cbiAqIHRoZSB2YXJpYWJsZSBpcyB0b2xkIG9uY2UsIG5hbWluZyB0aGUga2V5IHRoYXQgcmVwbGFjZXMgaXQuXG4gKlxuICogRXZlcnkgc291cmNlIHRoYXQgc3RhdGVzIGEgdmFsdWUgaXMgdmFsaWRhdGVkLCBub3QganVzdCB0aGUgb25lIHRoYXQgYmluZHM6XG4gKiBhbiB1bnJlZ2lzdGVyZWQgaWQgdGhyb3dzIHdoZXJldmVyIGl0IHdhcyB3cml0dGVuIChJc3N1ZSAjMzIzNCkuIExvc2luZyB0b1xuICogdGhlIGZpbGUgbXVzdCBub3QgdHVybiBhIHR5cG8gaW4gdGhlIHZhcmlhYmxlIGludG8gc2lsZW5jZSDigJQgdGhlIG9wZXJhdG9yXG4gKiB3aG8gZXhwb3J0ZWQgYFZJQkVfQUdFTlRfUFJPVklERVI9YWlkZXJgIHN0aWxsIGhhcyB0byBiZSB0b2xkIHRoZSBpZCBkb2VzXG4gKiBub3QgZXhpc3QuXG4gKi9cbmZ1bmN0aW9uIHJlc29sdmVTZWxlY3RlZFByb3ZpZGVySWQoXG4gIHNlbGVjdGlvbjogQWdlbnRQcm92aWRlclNlbGVjdGlvbixcbiAgZW52OiAobmFtZTogc3RyaW5nKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIG9wdGlvbnM6IHsgaG9ub3VyT3ZlcnJpZGU/OiBib29sZWFuIH0gPSB7fSxcbik6IHN0cmluZyB7XG4gIC8vIFRoZSBwZXItcnVuIG92ZXJyaWRlIChJc3N1ZSAjMjA2MikgYmVhdHMgdGhlIGZpbGUgYW5kIHRoZSByZWNvcmRlZFxuICAvLyBjb25maWd1cmVkIHZhbHVlOiB0aGUgaGVhbHRoIGdhdGUncyBmYWxsYmFjayBzd2l0Y2ggbXVzdCBzdXJ2aXZlIGV2ZXJ5XG4gIC8vIGluLXByb2Nlc3MgY29uZmlnIHJlbG9hZCwgd2hpY2ggd291bGQgb3RoZXJ3aXNlIHJlc2V0IHRoZSBjaG9pY2UgdG9cbiAgLy8gdGhlIGZpbGUncyBwcmVmZXJyZWQgaWQgKElzc3VlICMyMDY1J3MgY3Jhc2ggY2FtZSBmcm9tIHRoZSBmaWxlXG4gIC8vIHZhcmlhbnQpLiBBbiBleHBsaWNpdCBwZXItaW52b2NhdGlvbiBzZWxlY3RvciBuZXZlciByZWFjaGVzIGhlcmUuXG4gIGNvbnN0IG92ZXJyaWRlID0gb3B0aW9ucy5ob25vdXJPdmVycmlkZSA9PT0gZmFsc2VcbiAgICA/IHVuZGVmaW5lZFxuICAgIDogX3J1blByb3ZpZGVyT3ZlcnJpZGVJZDtcbiAgY29uc3QgY29uZmlndXJlZCA9IChcbiAgICBvdmVycmlkZSA/PyBzZWxlY3Rpb24uY29uZmlndXJlZCA/PyBjb25maWd1cmVkUHJvdmlkZXJJZFxuICApPy50cmltKCk7XG4gIGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZVNldHRpbmc8c3RyaW5nPih7XG4gICAgY29uZmlnS2V5OiBBR0VOVF9QUk9WSURFUl9DT05GSUdfS0VZLFxuICAgIGVudlZhcjogQUdFTlRfUFJPVklERVJfRU5WLFxuICAgIGVudixcbiAgICBjb25maWd1cmVkOiBjb25maWd1cmVkID8gcmVzb2x2ZUFnZW50UHJvdmlkZXIoY29uZmlndXJlZCkuaWQgOiBudWxsLFxuICAgIGZhbGxiYWNrOiBERUZBVUxUX0FHRU5UX1BST1ZJREVSX0lELFxuICAgIHBhcnNlOiBwYXJzZUVudlByb3ZpZGVySWQsXG4gIH0pO1xuICAvLyBUaGUgZmlsZSBzaG9ydC1jaXJjdWl0cyB0aGUgcmVzb2x1dGlvbiwgc28gdGhlIHZhcmlhYmxlIGlzIGNoZWNrZWQgaGVyZSBhc1xuICAvLyB3ZWxsIOKAlCBzZXQtYnV0LXVuc3VwcG9ydGVkIGZhaWxzIGxvdWRseSB3aGljaGV2ZXIgc291cmNlIHdpbnMuXG4gIGlmIChyZXNvbHZlZC5zb3VyY2UgIT09IFwiZW52XCIpIHBhcnNlRW52UHJvdmlkZXJJZChlbnYoQUdFTlRfUFJPVklERVJfRU5WKSk7XG4gIHdhcm5EZXByZWNhdGVkRW52U2V0dGluZyhyZXNvbHZlZCwgQUdFTlRfUFJPVklERVJfQ09ORklHX0tFWSk7XG4gIHJldHVybiByZXNvbHZlZC52YWx1ZTtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBhbiBpZCBzdGF0ZWQgaW4ge0BsaW5rIEFHRU5UX1BST1ZJREVSX0VOVn0uXG4gKlxuICogQHBhcmFtIHJhdyAtIFRoZSB2YXJpYWJsZSdzIHZhbHVlOyBibGFuayBvciBhYnNlbnQgc3RhdGVzIG5vdGhpbmcuXG4gKiBAcmV0dXJucyBUaGUgY2Fub25pY2FsIGlkLCBvciBudWxsIHdoZW4gdGhlIHZhcmlhYmxlIHN0YXRlcyBub3RoaW5nLlxuICogQHRocm93cyBXaGVuIHRoZSB2YXJpYWJsZSBuYW1lcyBhIHByb3ZpZGVyIHRoYXQgaXMgbm90IHJlZ2lzdGVyZWQsIHdpdGggdGhlXG4gKiAgIHZhcmlhYmxlIG5hbWVkIHNvIHRoZSBvcGVyYXRvciBrbm93cyB3aGljaCBvZiB0aGUgdHdvIHNvdXJjZXMgdG8gZml4LlxuICovXG5mdW5jdGlvbiBwYXJzZUVudlByb3ZpZGVySWQocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3Qgd2FudGVkID0gcmF3Py50cmltKCk7XG4gIGlmICghd2FudGVkKSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVzb2x2ZUFnZW50UHJvdmlkZXIod2FudGVkKS5pZDtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYCR7QUdFTlRfUFJPVklERVJfRU5WfTogJHsoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgcHJvdmlkZXJzIHRoZSBydW5uaW5nIGNvbnRhaW5lciBpbWFnZSBpbnN0YWxsZWQgKElzc3VlICM0MTA1KS5cbiAqXG4gKiBSZWFkcyB0aGUgc2V0IHRoZSBpbWFnZSBzdGFtcGVkIGludG8ge0BsaW5rIElNQUdFX0FHRU5UX1BST1ZJREVSU19FTlZ9LCBzb1xuICogYSB3b3JrZXIgaW4gYSBRdW9ydW0gaW1hZ2UgY2FuIHRlbGwgd2hpY2ggYWdlbnQgQ0xJcyBpdCBhY3R1YWxseSBjYXJyaWVzLlxuICpcbiAqIEBwYXJhbSBzZWxlY3Rpb24gLSBFbnZpcm9ubWVudCBsb29rdXAgKGRlZmF1bHRzIHRvIHRoZSBwcm9jZXNzIGVudmlyb25tZW50KS5cbiAqIEByZXR1cm5zIFRoZSBpbnN0YWxsZWQgcHJvdmlkZXIgaWRzLCBvciBgdW5kZWZpbmVkYCB3aGVuIHRoZSBzdGFtcCBpc1xuICogICBhYnNlbnQg4oCUIGFuIHVuY29udGFpbmVkIHdvcmtlciBpbnN0YWxscyBpdHMgYWdlbnRzIG9uIHRoZSBob3N0LCBzbyB0aGVyZVxuICogICBpcyBubyBpbWFnZSBzZXQgdG8gY2hlY2sgYWdhaW5zdC5cbiAqIEB0aHJvd3MgV2hlbiB0aGUgc3RhbXAgaXMgcHJlc2VudCBidXQgbWFsZm9ybWVkIChlbXB0eSwgYSBiYWQgaWQsIG9yIGFcbiAqICAgZHVwbGljYXRlKTogYSBzdGFtcCB0aGF0IGNhbm5vdCBiZSB0cnVzdGVkIGZhaWxzIGxvdWRseSByYXRoZXIgdGhhblxuICogICBwYXNzaW5nIGZvciBcIm5vIHN0YW1wXCIgKElzc3VlICMzMjM0KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGltYWdlQWdlbnRQcm92aWRlcklkcyhcbiAgc2VsZWN0aW9uOiBBZ2VudFByb3ZpZGVyU2VsZWN0aW9uID0ge30sXG4pOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGVudiA9IHNlbGVjdGlvbi5lbnYgPz8gKChuYW1lOiBzdHJpbmcpID0+IERlbm8uZW52LmdldChuYW1lKSk7XG4gIC8vIEJsYW5rIHJlYWRzIGFzIGFic2VudCwgb24gdGhlIHNoYXJlZCBzdGFtcCBydWxlIChJc3N1ZSAjMTI2Mik6IGFuIGVtcHR5XG4gIC8vIHN0YW1wIG5hbWVzIG5vIHByb3ZpZGVyIHNldCwgc28gaXQgY2Fubm90IHN0YW5kIGluIGZvciBvbmUuXG4gIGlmICghcnVubmluZ0luQ29udGFpbmVySW1hZ2UoZW52KSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3Qgc3RhbXBlZCA9IGVudihJTUFHRV9BR0VOVF9QUk9WSURFUlNfRU5WKSA/PyBcIlwiO1xuXG4gIGNvbnN0IGlkczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCByYXcgb2Ygc3RhbXBlZC5zcGxpdChcIixcIikpIHtcbiAgICBjb25zdCBpZCA9IHJhdy50cmltKCk7XG4gICAgaWYgKCFQUk9WSURFUl9JRF9QQVRURVJOLnRlc3QoaWQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGAke0lNQUdFX0FHRU5UX1BST1ZJREVSU19FTlZ9PSR7SlNPTi5zdHJpbmdpZnkoc3RhbXBlZCl9IGlzIG5vdCBhIGAgK1xuICAgICAgICAgIGBwcm92aWRlciBzZXQ6ICR7XG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeShpZClcbiAgICAgICAgICB9IGlzIG5vdCBhIGxvd2VyLWNhc2UgcHJvdmlkZXIgaWQuYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChpZHMuaW5jbHVkZXMoaWQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGAke0lNQUdFX0FHRU5UX1BST1ZJREVSU19FTlZ9PSR7SlNPTi5zdHJpbmdpZnkoc3RhbXBlZCl9IGxpc3RzIGAgK1xuICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KGlkKX0gdHdpY2UuYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlkcy5wdXNoKGlkKTtcbiAgfVxuICByZXR1cm4gaWRzO1xufVxuXG4vKipcbiAqIEFzc2VydCB0aGUgcnVubmluZyBpbWFnZSBjYXJyaWVzIGEgcHJvdmlkZXIgYmVmb3JlIGl0IGlzIHVzZWQuXG4gKlxuICogQHBhcmFtIGlkIC0gVGhlIHByb3ZpZGVyIHRoZSBjYWxsZXIgKGEgcGhhc2UsIGEgUXVvcnVtIG1lbWJlcikgd2FudHMuXG4gKiBAcGFyYW0gc2VsZWN0aW9uIC0gRW52aXJvbm1lbnQgbG9va3VwIChkZWZhdWx0cyB0byB0aGUgcHJvY2VzcyBlbnZpcm9ubWVudCkuXG4gKiBAdGhyb3dzIFdoZW4gdGhlIGltYWdlIHN0YW1wZWQgYSBzZXQgdGhhdCBleGNsdWRlcyBgaWRgLCBuYW1pbmcgdGhlXG4gKiAgIHByb3ZpZGVycyBpdCBkb2VzIGNhcnJ5LiBBIG5vLW9wIHdoZW4gdGhlIGltYWdlIHN0YW1wZWQgbm8gc2V0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0SW1hZ2VJbnN0YWxsZWRQcm92aWRlcihcbiAgaWQ6IHN0cmluZyxcbiAgc2VsZWN0aW9uOiBBZ2VudFByb3ZpZGVyU2VsZWN0aW9uID0ge30sXG4pOiB2b2lkIHtcbiAgY29uc3QgaW5zdGFsbGVkID0gaW1hZ2VBZ2VudFByb3ZpZGVySWRzKHNlbGVjdGlvbik7XG4gIGlmIChpbnN0YWxsZWQgPT09IHVuZGVmaW5lZCB8fCBpbnN0YWxsZWQuaW5jbHVkZXMoaWQpKSByZXR1cm47XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBgVGhlIHJ1bm5pbmcgY29udGFpbmVyIGltYWdlIGRpZCBub3QgaW5zdGFsbCB0aGUgJHtKU09OLnN0cmluZ2lmeShpZCl9IGAgK1xuICAgICAgYGNvZGluZy1hZ2VudCBwcm92aWRlci4gSW5zdGFsbGVkOiAke1xuICAgICAgICBpbnN0YWxsZWQuam9pbihcIiwgXCIpXG4gICAgICB9LiBSZWJ1aWxkIHRoZSBgICtcbiAgICAgIGBpbWFnZSB3aXRoIEFHRU5UX1BST1ZJREVSUyBpbmNsdWRpbmcgJHtKU09OLnN0cmluZ2lmeShpZCl9LmAsXG4gICk7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgYWN0aXZlIHByb3ZpZGVyIGRlc2NyaXB0b3IuXG4gKlxuICogQHBhcmFtIHNlbGVjdGlvbiAtIENvbmZpZ3VyZWQgdmFsdWUgYW5kIGVudmlyb25tZW50IGxvb2t1cC5cbiAqIEByZXR1cm5zIFRoZSBhY3RpdmUgZGVzY3JpcHRvci5cbiAqIEB0aHJvd3MgV2hlbiBhIHNldCB2YWx1ZSBuYW1lcyBhbiB1bnN1cHBvcnRlZCBwcm92aWRlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFjdGl2ZUFnZW50UHJvdmlkZXIoXG4gIHNlbGVjdGlvbjogQWdlbnRQcm92aWRlclNlbGVjdGlvbiA9IHt9LFxuKTogQWdlbnRQcm92aWRlckRlc2NyaXB0b3Ige1xuICByZXR1cm4gcmVzb2x2ZUFnZW50UHJvdmlkZXIocmVzb2x2ZUFnZW50UHJvdmlkZXJJZChzZWxlY3Rpb24pKTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBhY3RpdmUgcHJvdmlkZXIgZm9yIHByZS1zcGF3biBwbGFubmluZyAoSXNzdWUgIzQxMDkpLlxuICpcbiAqIFBsYW5uaW5nIG9ubHkgbmVlZHMgdG8ga25vdyB3aGF0IHRoZSBwcm92aWRlciBjYW4gY2FycnksIHNvIHRoaXMgc2tpcHMgdGhlXG4gKiBpbnN0YWxsZWQtc2V0IGNoZWNrIHRoYXQge0BsaW5rIGFjdGl2ZUFnZW50UHJvdmlkZXJ9IHJ1bnMuIEFuIHVuaW5zdGFsbGVkXG4gKiBwcm92aWRlciBpcyBzdGlsbCByZWZ1c2VkIGxhdGVyIGJ5IHRoZSBydW5uZXIncyBpbnN0YWxsIGFzc2VydCAoSXNzdWVcbiAqICM0MTA1KSwgc28gdGhpcyBtdXN0IG5vdCB0aHJvdyBlYXJsaWVyIHRoYW4gdGhlIGJhc2UgY29kZSBkaWQgKElzc3VlICM0MTA5KS5cbiAqXG4gKiBAcGFyYW0gc2VsZWN0aW9uIC0gQ29uZmlndXJlZCB2YWx1ZSBhbmQgZW52aXJvbm1lbnQgbG9va3VwLlxuICogQHJldHVybnMgVGhlIGFjdGl2ZSBkZXNjcmlwdG9yLCB3aXRob3V0IHRoZSBpbnN0YWxsZWQtc2V0IGNoZWNrLlxuICogQHRocm93cyBXaGVuIGEgc2V0IHZhbHVlIG5hbWVzIGFuIHVuc3VwcG9ydGVkIHByb3ZpZGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhbm5lZEFjdGl2ZUFnZW50UHJvdmlkZXIoXG4gIHNlbGVjdGlvbjogQWdlbnRQcm92aWRlclNlbGVjdGlvbiA9IHt9LFxuKTogQWdlbnRQcm92aWRlckRlc2NyaXB0b3Ige1xuICBjb25zdCBlbnYgPSBzZWxlY3Rpb24uZW52ID8/ICgobmFtZTogc3RyaW5nKSA9PiBEZW5vLmVudi5nZXQobmFtZSkpO1xuICByZXR1cm4gcmVzb2x2ZUFnZW50UHJvdmlkZXIocmVzb2x2ZVNlbGVjdGVkUHJvdmlkZXJJZChzZWxlY3Rpb24sIGVudikpO1xufVxuXG4vKipcbiAqIEhvdyBvbmUgaW52b2NhdGlvbiBuYW1lcyBpdHMgcHJvdmlkZXIgKElzc3VlICM0MTA5KS5cbiAqXG4gKiBFaXRoZXIgYSByZWdpc3RlcmVkIGlkIChgXCJjb2RleFwiYCkgb3IgYSBkZXNjcmlwdG9yIHRoZSBjYWxsZXIgYWxyZWFkeSBob2xkcy5cbiAqIEEgZGVzY3JpcHRvciBpcyBhY2NlcHRlZCBkaXJlY3RseSBzbyBhIGNhbGxlciDigJQgYSBRdW9ydW0gbWVtYmVyLCBhIHRlc3Qg4oCUXG4gKiBjYW4gZHJpdmUgYSBwcm92aWRlciBpdCBjb25zdHJ1Y3RlZCBpdHNlbGYgd2l0aG91dCByZWdpc3RlcmluZyBpdCBnbG9iYWxseS5cbiAqL1xuZXhwb3J0IHR5cGUgQWdlbnRQcm92aWRlclNlbGVjdG9yID0gc3RyaW5nIHwgQWdlbnRQcm92aWRlckRlc2NyaXB0b3I7XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgcHJvdmlkZXIgZm9yICoqb25lKiogaW52b2NhdGlvbiAoSXNzdWUgIzQxMDkpLlxuICpcbiAqIFRoaXMgaXMgdGhlIHBlci1jYWxsIHNlbGVjdGlvbiBwYXRoIFF1b3J1bSBuZWVkczogbmFtaW5nIGEgcHJvdmlkZXIgaGVyZVxuICogc2VsZWN0cyBpdCBmb3IgdGhpcyBpbnZvY2F0aW9uIG9ubHkgYW5kIG5ldmVyIHRvdWNoZXNcbiAqIHtAbGluayBzZXRDb25maWd1cmVkQWdlbnRQcm92aWRlcklkfSBvciB0aGUgZW52aXJvbm1lbnQsIHNvIHR3byBpbnZvY2F0aW9uc1xuICogbmFtaW5nIGRpZmZlcmVudCBwcm92aWRlcnMgY2FuIHJ1biBjb25jdXJyZW50bHkgaW4gb25lIHByb2Nlc3MuIFRoZSByZXR1cm5lZFxuICogZGVzY3JpcHRvciBpcyBhIGZyb3plbiB2YWx1ZSB0aGUgY2FsbGVyIGhvbGRzIGZvciB0aGUgd2hvbGUgaW52b2NhdGlvbiDigJRcbiAqIG5vdGhpbmcgZG93bnN0cmVhbSByZS1yZWFkcyBtb2R1bGUtbGV2ZWwgc3RhdGUgbWlkLXJ1bi5cbiAqXG4gKiBPbWl0dGluZyBgc2VsZWN0b3JgIGZhbGxzIGJhY2sgdG8ge0BsaW5rIGFjdGl2ZUFnZW50UHJvdmlkZXJ9LCBzbyBhIGNhbGxlclxuICogdGhhdCBuYW1lcyBub3RoaW5nIGJlaGF2ZXMgZXhhY3RseSBhcyBpdCBkaWQgYmVmb3JlIHRoaXMgc2VhbSBleGlzdGVkLlxuICpcbiAqIEZhaWwgbG91ZCAoSXNzdWUgIzMyMzQpOiBhbiB1bnJlZ2lzdGVyZWQgaWQgbmFtZXMgZXZlcnkgc3VwcG9ydGVkIGlkLCBhbmQgYVxuICogcHJvdmlkZXIgdGhlIHJ1bm5pbmcgaW1hZ2UgZGlkIG5vdCBpbnN0YWxsIG5hbWVzIHRoZSBpbnN0YWxsZWQgc2V0IOKAlCBuZWl0aGVyXG4gKiBmYWxscyBiYWNrIHRvIHRoZSBkZWZhdWx0LCB3aGljaCB3b3VsZCBzaWxlbnRseSBydW4gdGhlIHdyb25nIGFnZW50LlxuICpcbiAqIEBwYXJhbSBzZWxlY3RvciAtIFByb3ZpZGVyIGlkIG9yIGRlc2NyaXB0b3I7IG9taXQgZm9yIHRoZSBhY3RpdmUgcHJvdmlkZXIuXG4gKiBAcGFyYW0gc2VsZWN0aW9uIC0gQ29uZmlndXJlZCB2YWx1ZSBhbmQgZW52aXJvbm1lbnQgbG9va3VwLlxuICogQHJldHVybnMgVGhlIGRlc2NyaXB0b3IgdGhpcyBpbnZvY2F0aW9uIG11c3QgdXNlLlxuICogQHRocm93cyBXaGVuIHRoZSBpZCBpcyBub3QgcmVnaXN0ZXJlZCwgdGhlIGRlc2NyaXB0b3IgaXMgbWFsZm9ybWVkLCBvciB0aGVcbiAqICAgcnVubmluZyBpbWFnZSBkaWQgbm90IGluc3RhbGwgdGhlIG5hbWVkIHByb3ZpZGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VsZWN0QWdlbnRQcm92aWRlcihcbiAgc2VsZWN0b3I/OiBBZ2VudFByb3ZpZGVyU2VsZWN0b3IsXG4gIHNlbGVjdGlvbjogQWdlbnRQcm92aWRlclNlbGVjdGlvbiA9IHt9LFxuKTogQWdlbnRQcm92aWRlckRlc2NyaXB0b3Ige1xuICBpZiAoc2VsZWN0b3IgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGFjdGl2ZUFnZW50UHJvdmlkZXIoc2VsZWN0aW9uKTtcblxuICBjb25zdCBwcm92aWRlciA9IHR5cGVvZiBzZWxlY3RvciA9PT0gXCJzdHJpbmdcIlxuICAgID8gcmVzb2x2ZUFnZW50UHJvdmlkZXIoc2VsZWN0b3IpXG4gICAgOiBzZWxlY3RvcjtcbiAgaWYgKHR5cGVvZiBwcm92aWRlcj8uaWQgIT09IFwic3RyaW5nXCIgfHwgcHJvdmlkZXIuaWQudHJpbSgpID09PSBcIlwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFRoZSBjb2RpbmctYWdlbnQgcHJvdmlkZXIgbmFtZWQgZm9yIHRoaXMgaW52b2NhdGlvbiBoYXMgbm8gaWQuIGAgK1xuICAgICAgICBgUGFzcyBhIHJlZ2lzdGVyZWQgaWQgKCR7YWdlbnRQcm92aWRlcklkcygpLmpvaW4oXCIsIFwiKX0pIG9yIGEgYCArXG4gICAgICAgIGBkZXNjcmlwdG9yIHdpdGggb25lLmAsXG4gICAgKTtcbiAgfVxuICBhc3NlcnRJbWFnZUluc3RhbGxlZFByb3ZpZGVyKHByb3ZpZGVyLmlkLCBzZWxlY3Rpb24pO1xuICByZXR1cm4gcHJvdmlkZXI7XG59XG5cbi8qKlxuICogVGhlIGVuYWJsZWQgc2V0IGAuY29uZmlnLmpzb25gIHNlbGVjdGVkLCBvbmNlIGNvbmZpZ3VyYXRpb24gaGFzIGJlZW4gbG9hZGVkLlxuICpcbiAqIE1pcnJvcnMge0BsaW5rIGNvbmZpZ3VyZWRQcm92aWRlcklkfTogdGhlIGNyZWRlbnRpYWwgcHJlZmxpZ2h0IGFuZCB0aGVcbiAqIGxhdW5jaGVyIGhvbGQgbm8gY29uZmlndXJhdGlvbiBoYW5kbGUsIHNvIGBsb2FkQ29uZmlnYCByZWNvcmRzIHRoZSBzZWxlY3Rpb25cbiAqIGhlcmUgYW5kIHRoZXkgcmVhZCBpdCBiYWNrLlxuICovXG5sZXQgY29uZmlndXJlZEVuYWJsZWRQcm92aWRlcklkczogcmVhZG9ubHkgc3RyaW5nW10gfCB1bmRlZmluZWQ7XG5cbi8qKiBXaGVyZSBhbiBlbmFibGVkLXNldCBzZWxlY3Rpb24gbWF5IGNvbWUgZnJvbS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRW5hYmxlZEFnZW50UHJvdmlkZXJTZWxlY3Rpb24gZXh0ZW5kcyBBZ2VudFByb3ZpZGVyU2VsZWN0aW9uIHtcbiAgLyoqIFRoZSBgLmNvbmZpZy5qc29uYCB7QGxpbmsgRU5BQkxFRF9BR0VOVF9QUk9WSURFUlNfQ09ORklHX0tFWX0gdmFsdWUuICovXG4gIGNvbmZpZ3VyZWRQcm92aWRlcnM/OiByZWFkb25seSBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBhIHNldCBvZiBwcm92aWRlciBpZHMsIG5hbWluZyB3aGVyZSB0aGV5IGNhbWUgZnJvbS5cbiAqXG4gKiBAcGFyYW0gdmFsdWVzIC0gUmF3IGlkcyBmcm9tIGNvbmZpZ3VyYXRpb24gb3IgdGhlIGVudmlyb25tZW50LlxuICogQHBhcmFtIHNvdXJjZSAtIE9wZXJhdG9yLWZhY2luZyBkZXNjcmlwdGlvbiBvZiB3aGVyZSB0aGV5IGNhbWUgZnJvbS5cbiAqIEByZXR1cm5zIFRoZSBjYW5vbmljYWwgaWRzLCBpbiB0aGUgb3JkZXIgZ2l2ZW4uXG4gKiBAdGhyb3dzIFdoZW4gdGhlIHNldCBpcyBlbXB0eSwgaG9sZHMgYSBibGFuayBvciBkdXBsaWNhdGUgaWQsIG9yIG5hbWVzIGFcbiAqICAgcHJvdmlkZXIgdGhhdCBpcyBub3QgcmVnaXN0ZXJlZCAoSXNzdWUgIzMyMzQpLlxuICovXG5mdW5jdGlvbiBwYXJzZUVuYWJsZWRQcm92aWRlcklkcyhcbiAgdmFsdWVzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgc291cmNlOiBzdHJpbmcsXG4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGlkczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCByYXcgb2YgdmFsdWVzKSB7XG4gICAgY29uc3Qgd2FudGVkID0gcmF3LnRyaW0oKTtcbiAgICBpZiAod2FudGVkID09PSBcIlwiKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGAke3NvdXJjZX0gbGlzdHMgYW4gZW1wdHkgY29kaW5nLWFnZW50IHByb3ZpZGVyIGlkLiBgICtcbiAgICAgICAgICBgU3VwcG9ydGVkIHByb3ZpZGVyczogJHthZ2VudFByb3ZpZGVySWRzKCkuam9pbihcIiwgXCIpfS5gLFxuICAgICAgKTtcbiAgICB9XG4gICAgbGV0IGlkOiBzdHJpbmc7XG4gICAgdHJ5IHtcbiAgICAgIGlkID0gcmVzb2x2ZUFnZW50UHJvdmlkZXIod2FudGVkKS5pZDtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGAke3NvdXJjZX06ICR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIH1cbiAgICBpZiAoaWRzLmluY2x1ZGVzKGlkKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGAke3NvdXJjZX0gbGlzdHMgJHtKU09OLnN0cmluZ2lmeShpZCl9IHR3aWNlLmApO1xuICAgIH1cbiAgICBpZHMucHVzaChpZCk7XG4gIH1cbiAgaWYgKGlkcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgJHtzb3VyY2V9IGVuYWJsZXMgbm8gY29kaW5nLWFnZW50IHByb3ZpZGVyIOKAlCB0aGUgcnVuIHdvdWxkIGhhdmUgbm8gYCArXG4gICAgICAgIGBhZ2VudCB0byB3b3JrIHdpdGguIFN1cHBvcnRlZCBwcm92aWRlcnM6ICR7XG4gICAgICAgICAgYWdlbnRQcm92aWRlcklkcygpLmpvaW4oXCIsIFwiKVxuICAgICAgICB9LmAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gaWRzO1xufVxuXG4vKipcbiAqIFJlY29yZCB0aGUgZW5hYmxlZCBwcm92aWRlciBzZXQgc2VsZWN0ZWQgYnkgY29uZmlndXJhdGlvbi5cbiAqXG4gKiBAcGFyYW0gaWRzIC0gUHJvdmlkZXIgaWRzIGZyb20gYC5jb25maWcuanNvbmAsIG9yIHVuZGVmaW5lZCB0byBjbGVhciB0aGVcbiAqICAgc2VsZWN0aW9uICh3aGljaCBmYWxscyB0aGUgc2V0IGJhY2sgdG8gdGhlIGFjdGl2ZSBwcm92aWRlciBhbG9uZSkuXG4gKiBAdGhyb3dzIFdoZW4gdGhlIHNldCBpcyBzZXQgYnV0IHVudXNhYmxlIChJc3N1ZSAjMzIzNCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRDb25maWd1cmVkRW5hYmxlZEFnZW50UHJvdmlkZXJJZHMoXG4gIGlkczogcmVhZG9ubHkgc3RyaW5nW10gfCB1bmRlZmluZWQsXG4pOiB2b2lkIHtcbiAgY29uZmlndXJlZEVuYWJsZWRQcm92aWRlcklkcyA9IGlkcyA9PT0gdW5kZWZpbmVkXG4gICAgPyB1bmRlZmluZWRcbiAgICA6IHBhcnNlRW5hYmxlZFByb3ZpZGVySWRzKFxuICAgICAgaWRzLFxuICAgICAgYENvbmZpZ3VyYXRpb24ga2V5IFwiJHtFTkFCTEVEX0FHRU5UX1BST1ZJREVSU19DT05GSUdfS0VZfVwiYCxcbiAgICApO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIGlkcyBvZiBldmVyeSBwcm92aWRlciBlbmFibGVkIGZvciB0aGlzIHJ1biAoSXNzdWUgIzQxMDgpLlxuICpcbiAqIFByZWNlZGVuY2UgbWlycm9ycyB7QGxpbmsgcmVzb2x2ZUFnZW50UHJvdmlkZXJJZH0sIHdoaWNoIGlzIHRoZSBydWxlXG4gKiBgY29uZmlnX3ByZWNlZGVuY2UudHNgIHN0YXRlcyAoSXNzdWUgIzEwMzIpOiB0aGUgYC5jb25maWcuanNvbmBcbiAqIHtAbGluayBFTkFCTEVEX0FHRU5UX1BST1ZJREVSU19DT05GSUdfS0VZfSBrZXksIHRoZW5cbiAqIHtAbGluayBFTkFCTEVEX0FHRU5UX1BST1ZJREVSU19FTlZ9LCB0aGVuIHRoZSBhY3RpdmUgcHJvdmlkZXIgYWxvbmUg4oCUIHNvIGFcbiAqIGRlcGxveW1lbnQgdGhhdCBjb25maWd1cmVzIG5laXRoZXIgYmVoYXZlcyBleGFjdGx5IGFzIGl0IGRpZCBiZWZvcmUgdGhlIHNldFxuICogZXhpc3RlZC5cbiAqXG4gKiBFdmVyeSBlbmFibGVkIGlkIGlzIGNoZWNrZWQgYWdhaW5zdCB0aGUgc2V0IHRoZSBydW5uaW5nIGltYWdlIGluc3RhbGxlZCwgc29cbiAqIGVuYWJsaW5nIGFuIGFnZW50IHRoaXMgaW1hZ2UgZG9lcyBub3QgY2FycnkgZmFpbHMgaGVyZSByYXRoZXIgdGhhbiBhcyBhXG4gKiBcImNvbW1hbmQgbm90IGZvdW5kXCIgbWlkLXJ1bi5cbiAqXG4gKiBAcGFyYW0gc2VsZWN0aW9uIC0gQ29uZmlndXJlZCB2YWx1ZXMgYW5kIGVudmlyb25tZW50IGxvb2t1cC5cbiAqIEByZXR1cm5zIFRoZSBlbmFibGVkIHByb3ZpZGVyIGlkcywgYWN0aXZlIHByb3ZpZGVyIGZpcnN0IHdoZW4gaXQgd2FzXG4gKiAgIHNlbGVjdGVkIGltcGxpY2l0bHkuXG4gKiBAdGhyb3dzIFdoZW4gdGhlIHNldCBpcyB1bnVzYWJsZSwgb3IgZXhjbHVkZXMgdGhlIGFjdGl2ZSBwcm92aWRlciDigJQgYSBydW5cbiAqICAgd2hvc2Ugb3duIGFnZW50IGhhcyBubyBtb3VudGVkIGNyZWRlbnRpYWwgbXVzdCBub3Qgc3RhcnQgKElzc3VlICMzMjM0KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVFbmFibGVkQWdlbnRQcm92aWRlcklkcyhcbiAgc2VsZWN0aW9uOiBFbmFibGVkQWdlbnRQcm92aWRlclNlbGVjdGlvbiA9IHt9LFxuKTogc3RyaW5nW10ge1xuICBjb25zdCBlbnYgPSBzZWxlY3Rpb24uZW52ID8/ICgobmFtZTogc3RyaW5nKSA9PiBEZW5vLmVudi5nZXQobmFtZSkpO1xuICBjb25zdCBhY3RpdmVJZCA9IHJlc29sdmVBZ2VudFByb3ZpZGVySWQoc2VsZWN0aW9uKTtcblxuICBjb25zdCBjb25maWd1cmVkID0gc2VsZWN0aW9uLmNvbmZpZ3VyZWRQcm92aWRlcnMgPz9cbiAgICBjb25maWd1cmVkRW5hYmxlZFByb3ZpZGVySWRzO1xuXG4gIGNvbnN0IHBhcnNlRW52U2V0ID0gKHJhdzogc3RyaW5nKSA9PlxuICAgIHBhcnNlRW5hYmxlZFByb3ZpZGVySWRzKFxuICAgICAgcmF3LnNwbGl0KFwiLFwiKSxcbiAgICAgIGAke0VOQUJMRURfQUdFTlRfUFJPVklERVJTX0VOVn09JHtKU09OLnN0cmluZ2lmeShyYXcpfWAsXG4gICAgKTtcblxuICBjb25zdCByZXNvbHZlZCA9IHJlc29sdmVTZXR0aW5nPHJlYWRvbmx5IHN0cmluZ1tdPih7XG4gICAgY29uZmlnS2V5OiBFTkFCTEVEX0FHRU5UX1BST1ZJREVSU19DT05GSUdfS0VZLFxuICAgIGVudlZhcjogRU5BQkxFRF9BR0VOVF9QUk9WSURFUlNfRU5WLFxuICAgIGVudixcbiAgICBjb25maWd1cmVkOiBjb25maWd1cmVkID09PSB1bmRlZmluZWQgPyBudWxsIDogcGFyc2VFbmFibGVkUHJvdmlkZXJJZHMoXG4gICAgICBjb25maWd1cmVkLFxuICAgICAgYENvbmZpZ3VyYXRpb24ga2V5IFwiJHtFTkFCTEVEX0FHRU5UX1BST1ZJREVSU19DT05GSUdfS0VZfVwiYCxcbiAgICApLFxuICAgIGZhbGxiYWNrOiBbYWN0aXZlSWRdLFxuICAgIHBhcnNlOiBwYXJzZUVudlNldCxcbiAgfSk7XG4gIC8vIEFzIHdpdGggdGhlIGFjdGl2ZSBwcm92aWRlcjogdGhlIGZpbGUgc2hvcnQtY2lyY3VpdHMgdGhlIHJlc29sdXRpb24sIHNvIGFuXG4gIC8vIHVudXNhYmxlIHZhcmlhYmxlIGlzIGNoZWNrZWQgaGVyZSB0b28gcmF0aGVyIHRoYW4gcGFzc2luZyBpbiBzaWxlbmNlLlxuICBpZiAocmVzb2x2ZWQuc291cmNlICE9PSBcImVudlwiKSB7XG4gICAgY29uc3Qgc3RhdGVkID0gZW52KEVOQUJMRURfQUdFTlRfUFJPVklERVJTX0VOVik/LnRyaW0oKTtcbiAgICBpZiAoc3RhdGVkKSBwYXJzZUVudlNldChzdGF0ZWQpO1xuICB9XG4gIHdhcm5EZXByZWNhdGVkRW52U2V0dGluZyhyZXNvbHZlZCwgRU5BQkxFRF9BR0VOVF9QUk9WSURFUlNfQ09ORklHX0tFWSk7XG4gIGNvbnN0IGlkcyA9IFsuLi5yZXNvbHZlZC52YWx1ZV07XG5cbiAgaWYgKCFpZHMuaW5jbHVkZXMoYWN0aXZlSWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFRoZSBlbmFibGVkIGNvZGluZy1hZ2VudCBwcm92aWRlcnMgKCR7aWRzLmpvaW4oXCIsIFwiKX0pIGV4Y2x1ZGUgdGhlIGAgK1xuICAgICAgICBgYWN0aXZlIHByb3ZpZGVyICR7SlNPTi5zdHJpbmdpZnkoYWN0aXZlSWQpfSwgc28gaXRzIGNyZWRlbnRpYWxzIGAgK1xuICAgICAgICBgd291bGQgbmV2ZXIgYmUgcHJvdmlzaW9uZWQgb3IgbW91bnRlZC4gQWRkIGl0IHRvIGAgK1xuICAgICAgICBgXCIke0VOQUJMRURfQUdFTlRfUFJPVklERVJTX0NPTkZJR19LRVl9XCIsIG9yIHNlbGVjdCBvbmUgb2YgdGhlIGAgK1xuICAgICAgICBgZW5hYmxlZCBwcm92aWRlcnMgd2l0aCBcIiR7QUdFTlRfUFJPVklERVJfQ09ORklHX0tFWX1cIi5gLFxuICAgICk7XG4gIH1cbiAgZm9yIChjb25zdCBpZCBvZiBpZHMpIGFzc2VydEltYWdlSW5zdGFsbGVkUHJvdmlkZXIoaWQsIHsgZW52IH0pO1xuICByZXR1cm4gaWRzO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIGRlc2NyaXB0b3JzIG9mIGV2ZXJ5IHByb3ZpZGVyIGVuYWJsZWQgZm9yIHRoaXMgcnVuLlxuICpcbiAqIEBwYXJhbSBzZWxlY3Rpb24gLSBDb25maWd1cmVkIHZhbHVlcyBhbmQgZW52aXJvbm1lbnQgbG9va3VwLlxuICogQHJldHVybnMgT25lIGRlc2NyaXB0b3IgcGVyIGVuYWJsZWQgcHJvdmlkZXIuXG4gKiBAdGhyb3dzIFdoZW4gdGhlIGVuYWJsZWQgc2V0IGlzIHVudXNhYmxlIChzZWVcbiAqICAge0BsaW5rIHJlc29sdmVFbmFibGVkQWdlbnRQcm92aWRlcklkc30pLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW5hYmxlZEFnZW50UHJvdmlkZXJzKFxuICBzZWxlY3Rpb246IEVuYWJsZWRBZ2VudFByb3ZpZGVyU2VsZWN0aW9uID0ge30sXG4pOiBBZ2VudFByb3ZpZGVyRGVzY3JpcHRvcltdIHtcbiAgcmV0dXJuIHJlc29sdmVFbmFibGVkQWdlbnRQcm92aWRlcklkcyhzZWxlY3Rpb24pLm1hcChyZXNvbHZlQWdlbnRQcm92aWRlcik7XG59XG5cbi8qKlxuICogVGhlIHtAbGluayBBR0VOVF9QUk9WSURFUlNfQlVJTERfQVJHfSB2YWx1ZSBvbmUgaW1hZ2UgYnVpbGQgbmVlZHMgKCM3MjkpLlxuICpcbiAqIFRoZSBzZXQgaGFuZGVkIGluIGlzIHRoZSB2ZXJ5IG9uZSB0aGUgY3JlZGVudGlhbCBhbmQgbW91bnQgcGF0aCByZXNvbHZlZCDigJRcbiAqIGByZXNvbHZlRW5hYmxlZEFnZW50UHJvdmlkZXJJZHNgIGZvciBhIGNvbmZpZ3VyZWQgZGVwbG95bWVudCwgb3IgdGhlIGlkcyBvZlxuICogdGhlIGRlc2NyaXB0b3JzIGEgY2FsbGVyIGRyb3ZlIHRoZSBwbGFuIHdpdGgg4oCUIHNvIGEgc2luZ2xlIGAuY29uZmlnLmpzb25gXG4gKiB2YWx1ZSBjYW5ub3QgbWVhbiBvbmUgdGhpbmcgdG8gdGhlIGJ1aWxkIGFuZCBhbm90aGVyIHRvIHRoZSBtb3VudHMuIE9ubHkgdGhlXG4gKiAqc2hhcGUqIGlzIHJlLWNoZWNrZWQgaGVyZTogcmVnaXN0cmF0aW9uIGlzIHNldHRsZWQgdXBzdHJlYW0sIGFuZCB0aGVcbiAqIHBlci1pbnZvY2F0aW9uIHNlYW0gZGVsaWJlcmF0ZWx5IGFjY2VwdHMgYSBkZXNjcmlwdG9yIGEgY2FsbGVyIGNvbnN0cnVjdGVkXG4gKiB3aXRob3V0IHJlZ2lzdGVyaW5nIGl0ICh7QGxpbmsgc2VsZWN0QWdlbnRQcm92aWRlcn0pLlxuICpcbiAqIGB1bmRlZmluZWRgIG1lYW5zIHRoZSBzZXQgaXMgYWxyZWFkeSB3aGF0IHRoZSBpbWFnZSBpbnN0YWxscyBieSBkZWZhdWx0XG4gKiAoYGNvbnRhaW5lci90b29scy5qc29uYCBgaW5zdGFsbGVkUHJvdmlkZXJzYCwgd2hpY2ggdGhlIENvbnRhaW5lcmZpbGVcbiAqIHJlc3RhdGVzIGFzIHRoZSBhcmd1bWVudCdzIGRlZmF1bHQpLCBzbyBubyBgLS1idWlsZC1hcmdgIGlzIHBhc3NlZCBhbmQgdGhlXG4gKiBkZWZhdWx0IGZsZWV0IGJ1aWxkIHN0YXlzIGJ5dGUtZm9yLWJ5dGUgd2hhdCBpdCB3YXMuIE9yZGVyIGlzIHNpZ25pZmljYW50OlxuICogdGhlIGZyYWdtZW50cyBpbnN0YWxsIGluIHRoZSBvcmRlciByZXF1ZXN0ZWQsIHNvIGEgcmUtb3JkZXJlZCBzZXQgaXMgYVxuICogZGlmZmVyZW50IGJ1aWxkIGFuZCBhIGRpZmZlcmVudCBpbWFnZS5cbiAqXG4gKiBAcGFyYW0gZW5hYmxlZCAtIFRoZSBwcm92aWRlcnMgdGhpcyBkZXBsb3ltZW50IGVuYWJsZWQsIGluIGluc3RhbGwgb3JkZXIuXG4gKiBAcGFyYW0gaW1hZ2VEZWZhdWx0IC0gVGhlIHNldCBhIGRlZmF1bHQgaW1hZ2UgYnVpbGQgaW5zdGFsbHMuXG4gKiBAcmV0dXJucyBUaGUgY29tbWEtc2VwYXJhdGVkIHNldCwgb3IgdW5kZWZpbmVkIHdoZW4gaXQgaXMgdGhlIGRlZmF1bHQuXG4gKiBAdGhyb3dzIFdoZW4gdGhlIHNldCBpcyBlbXB0eSwgb3IgaG9sZHMgYSBibGFuaywgbWFsZm9ybWVkIG9yIGR1cGxpY2F0ZWQgaWRcbiAqICAg4oCUIGEgYnVpbGQgYXJndW1lbnQgdGhhdCBjYW5ub3QgbmFtZSBhIGZyYWdtZW50IG11c3QgZmFpbCBoZXJlLCBub3QgYXMgYVxuICogICBoYWxmLWluc3RhbGxlZCBpbWFnZSAoSXNzdWUgIzMyMzQpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYWdlbnRQcm92aWRlcnNCdWlsZFZhbHVlKFxuICBlbmFibGVkOiByZWFkb25seSBzdHJpbmdbXSxcbiAgaW1hZ2VEZWZhdWx0OiByZWFkb25seSBzdHJpbmdbXSxcbik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGlkczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCByYXcgb2YgZW5hYmxlZCkge1xuICAgIGNvbnN0IGlkID0gcmF3LnRyaW0oKTtcbiAgICBpZiAoIVBST1ZJREVSX0lEX1BBVFRFUk4udGVzdChpZCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYFRoZSBjb2RpbmctYWdlbnQgcHJvdmlkZXJzIHRoZSBpbWFnZSBidWlsZCB3YXMgZ2l2ZW4gaW5jbHVkZSBgICtcbiAgICAgICAgICBgJHtKU09OLnN0cmluZ2lmeShyYXcpfSwgd2hpY2ggaXMgbm90IGEgbG93ZXItY2FzZSBwcm92aWRlciBpZC5gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKGlkcy5pbmNsdWRlcyhpZCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYFRoZSBjb2RpbmctYWdlbnQgcHJvdmlkZXJzIHRoZSBpbWFnZSBidWlsZCB3YXMgZ2l2ZW4gbGlzdCBgICtcbiAgICAgICAgICBgJHtKU09OLnN0cmluZ2lmeShpZCl9IHR3aWNlLmAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZHMucHVzaChpZCk7XG4gIH1cbiAgaWYgKGlkcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgVGhlIGNvZGluZy1hZ2VudCBwcm92aWRlcnMgdGhlIGltYWdlIGJ1aWxkIHdhcyBnaXZlbiBlbmFibGUgbm8gYCArXG4gICAgICAgIGBwcm92aWRlciDigJQgdGhlIGltYWdlIHdvdWxkIGluc3RhbGwgbm8gY29kaW5nIGFnZW50LiBTdXBwb3J0ZWQgYCArXG4gICAgICAgIGBwcm92aWRlcnM6ICR7YWdlbnRQcm92aWRlcklkcygpLmpvaW4oXCIsIFwiKX0uYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHZhbHVlID0gaWRzLmpvaW4oXCIsXCIpO1xuICByZXR1cm4gdmFsdWUgPT09IGltYWdlRGVmYXVsdC5qb2luKFwiLFwiKSA/IHVuZGVmaW5lZCA6IHZhbHVlO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBcUNDLEdBRUQsU0FBUyxtQkFBbUIsRUFBRSxrQkFBa0IsUUFBUSx1QkFBdUI7QUFDL0UsU0FDRSxjQUFjLEVBQ2Qsd0JBQXdCLFFBQ25CLHlCQUF5QjtBQUVoQyxTQUNFLHlCQUF5QixFQUN6Qix1QkFBdUIsUUFDbEIsdUJBQXVCO0FBQzlCLFNBQVMsZUFBZSxRQUFRLHVCQUF1QjtBQUN2RCxTQUNFLG1CQUFtQixFQUNuQixtQkFBbUIsRUFDbkIsMkJBQTJCLFFBQ3RCLGtCQUFrQjtBQUN6QixTQUNFLDJCQUEyQixFQUMzQixpQkFBaUIsUUFDWixtQkFBbUI7QUFDMUIsU0FBUyxxQkFBcUIsUUFBUSx5QkFBeUI7QUFFL0QsU0FDRSxxQkFBcUIsRUFDckIsdUJBQXVCLFFBQ2xCLDZCQUE2QjtBQUNwQyxTQUFTLG9CQUFvQixRQUFRLDRCQUE0QjtBQUNqRSxTQUNFLHNC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
// denoCacheMetadata=13066713249843383714,5516367265499800418