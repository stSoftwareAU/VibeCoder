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
 * `gemini_env.ts` / `gemini_auth.ts` (Issue #4107) — rather than restating
 * any of it, so the
 * invocation the seam produces is the invocation the worker used before the
 * seam existed and no CLI knowledge accumulates in this registry.
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
 */

import {
  buildClaudeEffortArgs,
  buildClaudeModelArgs,
} from "./claude_executor.ts";
import {
  buildClaudeChildEnv,
  CLAUDE_ENV_DENYLIST,
  CLAUDE_ENV_SECRET_ALLOWLIST,
} from "./claude_env.ts";
import {
  claudeAuthActionableMessage,
  isClaudeAuthError,
} from "./claude_auth.ts";
import {
  buildSessionResumeArgs,
  buildSessionResumeFlags,
  type SessionResumeState,
} from "./session_resume.ts";
import { buildCodexArgs } from "./codex_executor.ts";
import {
  buildCodexChildEnv,
  CODEX_ENV_DENYLIST,
  CODEX_ENV_SECRET_ALLOWLIST,
} from "./codex_env.ts";
import {
  CODEX_CREDENTIAL_ENV_VARS,
  codexAuthActionableMessage,
  isCodexAuthError,
} from "./codex_auth.ts";
import { buildGeminiArgs } from "./gemini_executor.ts";
import {
  buildGeminiChildEnv,
  GEMINI_ENV_DENYLIST,
  GEMINI_ENV_SECRET_ALLOWLIST,
} from "./gemini_env.ts";
import {
  GEMINI_CREDENTIAL_ENV_VARS,
  geminiAuthActionableMessage,
  isGeminiAuthError,
} from "./gemini_auth.ts";

/** Directory, relative to `container/`, holding the per-provider fragments. */
export const PROVIDER_FRAGMENT_DIR = "providers";

/** `.config.json` key that selects the active provider. */
export const AGENT_PROVIDER_CONFIG_KEY = "agent_provider";

/** Environment variable that overrides the configured provider. */
export const AGENT_PROVIDER_ENV = "VIBE_AGENT_PROVIDER";

/**
 * `.config.json` key listing every provider enabled for a run (Issue #4108).
 *
 * The enabled set decides which vendors' credentials are provisioned, checked
 * by the preflight and mounted into the container. It defaults to the active
 * provider alone, so a deployment that never sets it is unchanged.
 */
export const ENABLED_AGENT_PROVIDERS_CONFIG_KEY = "agent_providers";

/** Environment variable that overrides the enabled provider set. */
export const ENABLED_AGENT_PROVIDERS_ENV = "VIBE_AGENT_PROVIDERS";

/**
 * Environment variable the container image stamps with the provider set it
 * installed (Issue #4105).
 *
 * `container/Containerfile` bakes it from the `AGENT_PROVIDERS` build
 * argument, so the running image reports the agents it actually carries
 * rather than the worker assuming the default set.
 */
export const IMAGE_AGENT_PROVIDERS_ENV = "VIBE_IMAGE_AGENT_PROVIDERS";

/** The provider id Claude Code is registered under. */
export const CLAUDE_PROVIDER_ID = "claude";

/** The provider id the OpenAI Codex CLI is registered under (Issue #4106). */
export const CODEX_PROVIDER_ID = "codex";

/** The provider id the Gemini CLI is registered under (Issue #4107). */
export const GEMINI_PROVIDER_ID = "gemini";

/** The provider used when neither configuration nor environment selects one. */
export const DEFAULT_AGENT_PROVIDER_ID = CLAUDE_PROVIDER_ID;

/** Where a provider's credentials live inside the Vibe credential directory. */
export interface AgentProviderCredentials {
  /** Sub-directory name, e.g. `claude`. */
  subdir: string;
  /** Credential file inside that sub-directory, e.g. `provider.env`. */
  file: string;
  /** Environment variables that carry a usable credential. */
  envVars: readonly string[];
  /** The `setup.sh` variable that provisions the credential file. */
  provisionEnvVar: string;
}

/** What the provider's child subprocess may and may not inherit. */
export interface AgentProviderEnvironment {
  /** Secret-shaped names the child genuinely needs. */
  secretAllowlist: readonly string[];
  /** Names the child must never inherit. */
  denylist: readonly string[];
}

/** How the container image installs the provider binary. */
export interface AgentProviderInstall {
  /** Fragment path relative to `container/`, e.g. `providers/claude.sh`. */
  fragment: string;
}

/** One invocation of the provider's CLI. */
export interface AgentInvocationRequest {
  /** The user prompt. */
  prompt: string;
  /** Static system prompt passed separately so the CLI can cache it. */
  systemPrompt?: string;
  /** Explicit model id; when absent the phase routing decides. */
  model?: string;
  /** Work phase driving model/effort routing. */
  phase?: string;
  /** Explicit reasoning effort; when absent the phase routing decides. */
  effort?: string;
  /** Tools the agent must not use. */
  disallowedTools?: readonly string[];
  /** Session continuity state, when session resume is enabled. */
  sessionResumeState?: SessionResumeState;
  /**
   * MCP server configuration file for this run (Issue #4355) — the
   * Playwright headless browser. Absent → no `--mcp-config` flag, exactly
   * as before.
   */
  mcpConfigPath?: string;
  /**
   * The prompt will be written to the child's stdin (Issue #4385): build
   * the argv so the CLI reads it from there, and put no prompt text in
   * argv. Only meaningful for a provider whose `promptTransport` is
   * `stdin`; providers that cannot read a stdin prompt ignore it.
   */
  promptViaStdin?: boolean;
}

/**
 * How the prompt reaches the CLI (Issue #4385). `stdin` is required for a
 * prompt of any size: Linux caps one argv element at 128 KiB
 * (MAX_ARG_STRLEN), and a grill-me round or a long issue thread exceeds
 * that — observed live as "Argument list too long (E2BIG)" at spawn in
 * container mode. `argv` is what a CLI that cannot read a stdin prompt
 * gets, with that limit still in force.
 */
export type PromptTransport = "stdin" | "argv";

/** Everything the worker needs to know about one coding-agent provider. */
export interface AgentProviderDescriptor {
  /** Stable id used in configuration and as the fragment filename. */
  id: string;
  /** Operator-facing name. */
  displayName: string;
  /** Executable the image installs and the worker spawns. */
  binary: string;
  credentials: AgentProviderCredentials;
  environment: AgentProviderEnvironment;
  install: AgentProviderInstall;
  /** How the prompt reaches the CLI (Issue #4385). */
  promptTransport: PromptTransport;
  /** Build the CLI argument list for one invocation. */
  buildInvocation(request: AgentInvocationRequest): string[];
  /** Build the child subprocess environment, minus worker-only secrets. */
  buildChildEnv(parentEnv?: Record<string, string>): Record<string, string>;
  /** Report whether CLI output indicates a provider authentication failure. */
  isAuthError(output: string): boolean;
  /** Operator-facing message for an authentication failure. */
  authActionableMessage(): string;
}

/**
 * Claude Code, the first registered provider.
 *
 * Every field delegates to the module that already owns that behaviour, so
 * the descriptor is a description of Claude rather than a second copy of it.
 */
const CLAUDE_PROVIDER: AgentProviderDescriptor = {
  id: CLAUDE_PROVIDER_ID,
  displayName: "Claude Code",
  binary: "claude",
  credentials: {
    subdir: "claude",
    file: "provider.env",
    envVars: [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ],
    provisionEnvVar: "VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY",
  },
  environment: {
    secretAllowlist: CLAUDE_ENV_SECRET_ALLOWLIST,
    denylist: CLAUDE_ENV_DENYLIST,
  },
  install: { fragment: `${PROVIDER_FRAGMENT_DIR}/claude.sh` },
  // `claude -p` with no positional prompt reads it from stdin (Issue #4385).
  promptTransport: "stdin",

  buildInvocation(request: AgentInvocationRequest): string[] {
    const args: string[] = [];

    // Model selection (Issue #260, #2625).
    args.push(
      ...(request.model
        ? ["--model", request.model]
        : buildClaudeModelArgs(request.phase)),
    );

    // Effort selection (Issue #1403).
    args.push(
      ...(request.effort
        ? ["--effort", request.effort]
        : buildClaudeEffortArgs(request.phase)),
    );

    args.push("--dangerously-skip-permissions");
    const disallowed = request.disallowedTools ?? [];
    if (disallowed.length > 0) {
      args.push("--disallowed-tools", disallowed.join(","));
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
      args.push(
        ...buildSessionResumeArgs(
          buildSessionResumeFlags(request.sessionResumeState),
        ),
      );
    }

    // The prompt itself: on stdin when the runner pipes it (Issue #4385) —
    // a bare `-p` tells the CLI to read it there — otherwise as before.
    if (request.promptViaStdin) args.push("-p");
    else args.push("-p", request.prompt);
    return args;
  },

  buildChildEnv(parentEnv?: Record<string, string>): Record<string, string> {
    return parentEnv ? buildClaudeChildEnv(parentEnv) : buildClaudeChildEnv();
  },

  isAuthError(output: string): boolean {
    return isClaudeAuthError(output);
  },

  authActionableMessage(): string {
    return claudeAuthActionableMessage();
  },
};

/**
 * The OpenAI Codex CLI, the second registered provider (Issue #4106).
 *
 * The first real test of the seam: adding it is this descriptor plus
 * `container/providers/codex.sh` and a `container/tools.json` pin — no change
 * to containment, the launcher's mounts, or the credential preflight. Every
 * field delegates to the Codex-owned modules (`codex_executor.ts`,
 * `codex_env.ts`, `codex_auth.ts`), so no Codex CLI knowledge lives here.
 */
const CODEX_PROVIDER: AgentProviderDescriptor = {
  id: CODEX_PROVIDER_ID,
  displayName: "Codex CLI",
  binary: "codex",
  credentials: {
    subdir: "codex",
    file: "provider.env",
    envVars: CODEX_CREDENTIAL_ENV_VARS,
    provisionEnvVar: "VIBE_LAUNCHAGENT_OPENAI_API_KEY",
  },
  environment: {
    secretAllowlist: CODEX_ENV_SECRET_ALLOWLIST,
    denylist: CODEX_ENV_DENYLIST,
  },
  install: { fragment: `${PROVIDER_FRAGMENT_DIR}/codex.sh` },
  promptTransport: "argv",

  buildInvocation(request: AgentInvocationRequest): string[] {
    return buildCodexArgs({
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      disallowedTools: request.disallowedTools,
      model: request.model,
      effort: request.effort,
      // Codex resumes its own most recent session; the first phase of an issue
      // starts one instead (`phaseCount === 0`).
      resumeSession: buildSessionResumeFlags(request.sessionResumeState).resume,
    });
  },

  buildChildEnv(parentEnv?: Record<string, string>): Record<string, string> {
    return parentEnv ? buildCodexChildEnv(parentEnv) : buildCodexChildEnv();
  },

  isAuthError(output: string): boolean {
    return isCodexAuthError(output);
  },

  authActionableMessage(): string {
    return codexAuthActionableMessage();
  },
};

/**
 * The Gemini CLI, the third registered provider (Issue #4107).
 *
 * In Quorum mode Gemini is the judge rather than a planner: it reads the two
 * planners' candidate plans and picks a winner, so its invocation asks for
 * machine-readable output where a planner's may stay prose. Every field
 * delegates to the Gemini-owned modules (`gemini_executor.ts`,
 * `gemini_env.ts`, `gemini_auth.ts`), so no Gemini CLI knowledge lives here.
 */
const GEMINI_PROVIDER: AgentProviderDescriptor = {
  id: GEMINI_PROVIDER_ID,
  displayName: "Gemini CLI",
  binary: "gemini",
  credentials: {
    subdir: "gemini",
    file: "provider.env",
    envVars: GEMINI_CREDENTIAL_ENV_VARS,
    provisionEnvVar: "VIBE_LAUNCHAGENT_GEMINI_API_KEY",
  },
  environment: {
    secretAllowlist: GEMINI_ENV_SECRET_ALLOWLIST,
    denylist: GEMINI_ENV_DENYLIST,
  },
  install: { fragment: `${PROVIDER_FRAGMENT_DIR}/gemini.sh` },
  promptTransport: "argv",

  buildInvocation(request: AgentInvocationRequest): string[] {
    return buildGeminiArgs({
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      disallowedTools: request.disallowedTools,
      model: request.model,
      // Gemini resumes its own most recent session; the first phase of an
      // issue starts one instead (`phaseCount === 0`). The CLI exposes no
      // reasoning-effort option, so `request.effort` has no flag to carry it.
      resumeSession: buildSessionResumeFlags(request.sessionResumeState).resume,
    });
  },

  buildChildEnv(parentEnv?: Record<string, string>): Record<string, string> {
    return parentEnv ? buildGeminiChildEnv(parentEnv) : buildGeminiChildEnv();
  },

  isAuthError(output: string): boolean {
    return isGeminiAuthError(output);
  },

  authActionableMessage(): string {
    return geminiAuthActionableMessage();
  },
};

/** Every registered provider, keyed by id. */
const AGENT_PROVIDERS = new Map<string, AgentProviderDescriptor>([
  [CLAUDE_PROVIDER.id, CLAUDE_PROVIDER],
  [CODEX_PROVIDER.id, CODEX_PROVIDER],
  [GEMINI_PROVIDER.id, GEMINI_PROVIDER],
]);

/**
 * The ids of every registered provider.
 *
 * @returns Provider ids in registration order.
 */
export function agentProviderIds(): string[] {
  return [...AGENT_PROVIDERS.keys()];
}

/**
 * Resolve a provider descriptor by id.
 *
 * @param id - Provider id from configuration, the environment, or a caller.
 * @returns The descriptor.
 * @throws When the id is blank or not registered — naming every supported id,
 *   so an operator sees what to choose instead (Issue #3234).
 */
export function resolveAgentProvider(id: string): AgentProviderDescriptor {
  const wanted = id.trim();
  const provider = wanted === "" ? undefined : AGENT_PROVIDERS.get(wanted);
  if (!provider) {
    throw new Error(
      `Unsupported coding-agent provider ${JSON.stringify(id)}. ` +
        `Supported providers: ${agentProviderIds().join(", ")}. ` +
        `Set "${AGENT_PROVIDER_CONFIG_KEY}" in .config.json (or ` +
        `${AGENT_PROVIDER_ENV}) to one of those ids.`,
    );
  }
  return provider;
}

/**
 * The provider `.config.json` selected, once configuration has been loaded.
 *
 * The low-level modules that spawn the agent hold no configuration handle, so
 * `loadConfig` records the selection here and they read it back through
 * {@link resolveAgentProviderId}.
 */
let configuredProviderId: string | undefined;

/**
 * Record the provider selected by configuration.
 *
 * @param id - Provider id from `.config.json`, or undefined to clear it.
 * @throws When the id is set but unsupported (Issue #3234).
 */
export function setConfiguredAgentProviderId(id: string | undefined): void {
  const wanted = id?.trim();
  configuredProviderId = wanted ? resolveAgentProvider(wanted).id : undefined;
}

/** Where a provider selection may come from. */
export interface AgentProviderSelection {
  /** The `.config.json` value, when set. */
  configured?: string;
  /** Environment lookup (defaults to the process environment). */
  env?: (name: string) => string | undefined;
}

/**
 * Resolve the active provider id.
 *
 * Precedence: `VIBE_AGENT_PROVIDER` (an explicit per-run override, which is
 * how the container is pointed at a provider), then the `.config.json`
 * `agent_provider` key, then Claude. Any value that is set but unsupported
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
 */
export function resolveAgentProviderId(
  selection: AgentProviderSelection = {},
): string {
  const env = selection.env ?? ((name: string) => Deno.env.get(name));

  const id = resolveSelectedProviderId(selection, env);
  assertImageInstalledProvider(id, { env });
  return id;
}

/** The id configuration, the environment, or the default selects. */
function resolveSelectedProviderId(
  selection: AgentProviderSelection,
  env: (name: string) => string | undefined,
): string {
  const override = env(AGENT_PROVIDER_ENV)?.trim();
  if (override) {
    try {
      return resolveAgentProvider(override).id;
    } catch (error) {
      throw new Error(
        `${AGENT_PROVIDER_ENV}: ${(error as Error).message}`,
      );
    }
  }

  const configured = (selection.configured ?? configuredProviderId)?.trim();
  if (configured) return resolveAgentProvider(configured).id;

  return DEFAULT_AGENT_PROVIDER_ID;
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
 */
export function imageAgentProviderIds(
  selection: AgentProviderSelection = {},
): string[] | undefined {
  const env = selection.env ?? ((name: string) => Deno.env.get(name));
  const stamped = env(IMAGE_AGENT_PROVIDERS_ENV);
  if (stamped === undefined || stamped.trim() === "") return undefined;

  const ids: string[] = [];
  for (const raw of stamped.split(",")) {
    const id = raw.trim();
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      throw new Error(
        `${IMAGE_AGENT_PROVIDERS_ENV}=${JSON.stringify(stamped)} is not a ` +
          `provider set: ${
            JSON.stringify(id)
          } is not a lower-case provider id.`,
      );
    }
    if (ids.includes(id)) {
      throw new Error(
        `${IMAGE_AGENT_PROVIDERS_ENV}=${JSON.stringify(stamped)} lists ` +
          `${JSON.stringify(id)} twice.`,
      );
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
 */
export function assertImageInstalledProvider(
  id: string,
  selection: AgentProviderSelection = {},
): void {
  const installed = imageAgentProviderIds(selection);
  if (installed === undefined || installed.includes(id)) return;
  throw new Error(
    `The running container image did not install the ${JSON.stringify(id)} ` +
      `coding-agent provider. Installed: ${
        installed.join(", ")
      }. Rebuild the ` +
      `image with AGENT_PROVIDERS including ${JSON.stringify(id)}.`,
  );
}

/**
 * Resolve the active provider descriptor.
 *
 * @param selection - Configured value and environment lookup.
 * @returns The active descriptor.
 * @throws When a set value names an unsupported provider.
 */
export function activeAgentProvider(
  selection: AgentProviderSelection = {},
): AgentProviderDescriptor {
  return resolveAgentProvider(resolveAgentProviderId(selection));
}

/**
 * How one invocation names its provider (Issue #4109).
 *
 * Either a registered id (`"codex"`) or a descriptor the caller already holds.
 * A descriptor is accepted directly so a caller — a Quorum member, a test —
 * can drive a provider it constructed itself without registering it globally.
 */
export type AgentProviderSelector = string | AgentProviderDescriptor;

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
 */
export function selectAgentProvider(
  selector?: AgentProviderSelector,
  selection: AgentProviderSelection = {},
): AgentProviderDescriptor {
  if (selector === undefined) return activeAgentProvider(selection);

  const provider = typeof selector === "string"
    ? resolveAgentProvider(selector)
    : selector;
  if (typeof provider?.id !== "string" || provider.id.trim() === "") {
    throw new Error(
      `The coding-agent provider named for this invocation has no id. ` +
        `Pass a registered id (${agentProviderIds().join(", ")}) or a ` +
        `descriptor with one.`,
    );
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
 */
let configuredEnabledProviderIds: readonly string[] | undefined;

/** Where an enabled-set selection may come from. */
export interface EnabledAgentProviderSelection extends AgentProviderSelection {
  /** The `.config.json` {@link ENABLED_AGENT_PROVIDERS_CONFIG_KEY} value. */
  configuredProviders?: readonly string[];
}

/**
 * Validate a set of provider ids, naming where they came from.
 *
 * @param values - Raw ids from configuration or the environment.
 * @param source - Operator-facing description of where they came from.
 * @returns The canonical ids, in the order given.
 * @throws When the set is empty, holds a blank or duplicate id, or names a
 *   provider that is not registered (Issue #3234).
 */
function parseEnabledProviderIds(
  values: readonly string[],
  source: string,
): string[] {
  const ids: string[] = [];
  for (const raw of values) {
    const wanted = raw.trim();
    if (wanted === "") {
      throw new Error(
        `${source} lists an empty coding-agent provider id. ` +
          `Supported providers: ${agentProviderIds().join(", ")}.`,
      );
    }
    let id: string;
    try {
      id = resolveAgentProvider(wanted).id;
    } catch (error) {
      throw new Error(`${source}: ${(error as Error).message}`);
    }
    if (ids.includes(id)) {
      throw new Error(`${source} lists ${JSON.stringify(id)} twice.`);
    }
    ids.push(id);
  }
  if (ids.length === 0) {
    throw new Error(
      `${source} enables no coding-agent provider — the run would have no ` +
        `agent to work with. Supported providers: ${
          agentProviderIds().join(", ")
        }.`,
    );
  }
  return ids;
}

/**
 * Record the enabled provider set selected by configuration.
 *
 * @param ids - Provider ids from `.config.json`, or undefined to clear the
 *   selection (which falls the set back to the active provider alone).
 * @throws When the set is set but unusable (Issue #3234).
 */
export function setConfiguredEnabledAgentProviderIds(
  ids: readonly string[] | undefined,
): void {
  configuredEnabledProviderIds = ids === undefined
    ? undefined
    : parseEnabledProviderIds(
      ids,
      `Configuration key "${ENABLED_AGENT_PROVIDERS_CONFIG_KEY}"`,
    );
}

/**
 * Resolve the ids of every provider enabled for this run (Issue #4108).
 *
 * Precedence mirrors {@link resolveAgentProviderId}:
 * {@link ENABLED_AGENT_PROVIDERS_ENV}, then the `.config.json`
 * {@link ENABLED_AGENT_PROVIDERS_CONFIG_KEY} key, then the active provider
 * alone — so a deployment that configures neither behaves exactly as it did
 * before the set existed.
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
 */
export function resolveEnabledAgentProviderIds(
  selection: EnabledAgentProviderSelection = {},
): string[] {
  const env = selection.env ?? ((name: string) => Deno.env.get(name));
  const activeId = resolveAgentProviderId(selection);

  const override = env(ENABLED_AGENT_PROVIDERS_ENV)?.trim();
  const configured = selection.configuredProviders ??
    configuredEnabledProviderIds;

  let ids: string[];
  if (override) {
    ids = parseEnabledProviderIds(
      override.split(","),
      `${ENABLED_AGENT_PROVIDERS_ENV}=${JSON.stringify(override)}`,
    );
  } else if (configured !== undefined) {
    ids = parseEnabledProviderIds(
      configured,
      `Configuration key "${ENABLED_AGENT_PROVIDERS_CONFIG_KEY}"`,
    );
  } else {
    ids = [activeId];
  }

  if (!ids.includes(activeId)) {
    throw new Error(
      `The enabled coding-agent providers (${ids.join(", ")}) exclude the ` +
        `active provider ${JSON.stringify(activeId)}, so its credentials ` +
        `would never be provisioned or mounted. Add it to ` +
        `"${ENABLED_AGENT_PROVIDERS_CONFIG_KEY}", or select one of the ` +
        `enabled providers with "${AGENT_PROVIDER_CONFIG_KEY}".`,
    );
  }
  for (const id of ids) assertImageInstalledProvider(id, { env });
  return ids;
}

/**
 * Resolve the descriptors of every provider enabled for this run.
 *
 * @param selection - Configured values and environment lookup.
 * @returns One descriptor per enabled provider.
 * @throws When the enabled set is unusable (see
 *   {@link resolveEnabledAgentProviderIds}).
 */
export function enabledAgentProviders(
  selection: EnabledAgentProviderSelection = {},
): AgentProviderDescriptor[] {
  return resolveEnabledAgentProviderIds(selection).map(resolveAgentProvider);
}
