/**
 * Configuration loader for the Vibe Coder worker.
 *
 * Issue #266: All configuration is now loaded from .config.json only.
 * Issue #277: Operational settings (timeouts, intervals) are also loaded
 * from .config.json. Only overrides are stored — defaults flow from code.
 *
 * Environment variable overrides are no longer supported at runtime.
 * Use setup.sh to configure via .config.json.
 */ import { DEFAULT_CLAUDE_MAX_TURNS, validateClaudeMaxTurns } from "./claude_turn_limit.ts";
import { parseAllocationPolicy } from "./subscription_allocation.ts";
import { parseCompletionPolicy } from "./completion_admission.ts";
import { registerAgentPreFlightConfigs } from "./agent_pre_flight.ts";
import { processEnvLookup } from "./env_lookup.ts";
import { modelTierOverrides } from "./phase_routing.ts";
import { EXCLUSION_TEAM_PATTERN, validateConfigFileJson } from "./validation.ts";
import { resolveAgentProviderId, resolveEnabledAgentProviderIds, setConfiguredAgentProviderId, setConfiguredEnabledAgentProviderIds } from "./agent_provider.ts";
import { isAutomaticProviderRoutingActive } from "./provider_auto_state.ts";
import { resolveProviderFallbackPolicy, setConfiguredProviderFallbackPolicy } from "./provider_fallback_policy.ts";
import { DEFAULT_LONG_JOB_LABELS } from "./claim_runway_evidence.ts";
import { DEFAULT_RUN_TARGET_SECONDS } from "./run_timeline.ts";
import { resolveRunMode } from "./run_mode.ts";
import { resolveEffectiveFleetPrAuthors } from "./fleet_authors.ts";
import { parsePreFlightCommands } from "./repo_config.ts";
import { parseIdleTaskCadence } from "./idle_task_cadence_config.ts";
import { TOOL_CALL_HISTORY_MAX, TOOL_CALL_HISTORY_MS } from "./agent_progress.ts";
import { parseContainerTools } from "./container_tools_config.ts";
import { parseContainerExtension } from "./container_extension_config.ts";
import { parseCodegraphContext } from "./codegraph_context_config.ts";
import { parseRtkOutput } from "./rtk_output_config.ts";
import { assertCallbacksConfig } from "./run_callbacks_config.ts";
import { assertGraftContextConfig } from "./graft_context_config.ts";
import { assertCustomLabelPrompts } from "./custom_label_prompts_config.ts";
import { parseOrchestrationSettings, validateRoleProviders } from "./orchestration/role_config.ts";
import { resolveHostIssueSubAgentTier } from "./issue_sub_agent_tier.ts";
import { CUSTOM_PROMPT_PATH_MAP_ENV, customPromptPathResolver } from "./custom_prompt_mounts.ts";
import { parseCopilotCodeReview, validateUpdateModeSettings } from "./config_validator.ts";
import { detectUnknownConfigKeys, formatUnknownKeyWarnings } from "./config_unknown_keys.ts";
import { resolveEgressAllowlist } from "./egress_allowlist.ts";
import { readImgbbApiKeyFromEnv } from "./imgbb_upload.ts";
import { FLEET_LOGIN_CONFIG_KEYS, resolveVibeCoderLogins } from "./trust_exclusions.ts";
import { DEFAULT_BEST_PLANNING_MODEL, DEFAULT_SHUFFLE_REPOS, DEFAULT_TRUSTED_INPUT_BOTS, DEFAULT_TRUSTED_REVIEW_BOTS, DEFAULT_UPDATE_MODE, DEFAULT_VERBOSITY, DEFAULT_WORKER_NAME, defaultQuorumJudge, defaultQuorumPlanners, LABEL_DEFAULTS, OPERATIONAL_DEFAULTS, PROVIDER_MODEL_TIERS } from "./config_defaults.ts";
import { dedupeRepoSlugs, duplicateRepoSlugWarnings, REPO_SLUG_PATTERN } from "./repo_slug.ts";
/**
 * Pattern matching a valid GitHub `owner/repo` slug.
 *
 * Defined once in `lib/repo_slug.ts` and re-exported here so the existing
 * importers (`validateConfig`, the add-repo flow in `add_repo.ts` —
 * Issue #2575) are unchanged, while the setup CLI can apply the same guard
 * without pulling in this module's whole graph (Issue #1291).
 */ export { REPO_SLUG_PATTERN } from "./repo_slug.ts";
/**
 * Get an environment variable or return a default value.
 *
 * @param name - Environment variable name
 * @param defaultValue - Default value if env var is not set
 * @param env - Environment lookup (Issue #956). Defaults to the process
 *   environment, so every existing caller is unchanged; a test injects a
 *   fixed map instead of mutating `Deno.env`, which races under
 *   `deno test --parallel`.
 * @returns The environment variable value or default
 */ export function getEnvOrDefault(name, defaultValue, env = processEnvLookup) {
  return env(name) ?? defaultValue;
}
/**
 * Get an environment variable as a number or return a default value.
 *
 * @param name - Environment variable name
 * @param defaultValue - Default value if env var is not set
 * @param env - Environment lookup (Issue #956); defaults to the process
 *   environment.
 * @returns The environment variable value as number or default
 */ export function getEnvNumberOrDefault(name, defaultValue, env = processEnvLookup) {
  const value = env(name);
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}
/**
 * Read a non-negative number from the environment, or `undefined` when the
 * variable is unset, empty, or not a finite non-negative number (Issue #289).
 *
 * Distinct from {@link getEnvNumberOrDefault}: the caller needs to tell "the
 * operator set nothing" from "the operator set a value", so that a
 * `.config.json` key can take precedence over the environment without a
 * sentinel default standing in for an absent variable.
 *
 * @param name - Environment variable name
 * @param env - Environment lookup (Issue #956); defaults to the process
 *   environment.
 * @returns The parsed value, or `undefined` when there is no usable one
 */ export function readNonNegativeNumberEnv(name, env = processEnvLookup) {
  const raw = env(name);
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
/**
 * Get an environment variable as a comma-separated array or return a default value.
 *
 * @param name - Environment variable name
 * @param defaultValue - Default value if env var is not set
 * @param env - Environment lookup (Issue #956); defaults to the process
 *   environment.
 * @returns The environment variable value as array or default
 */ export function getEnvArrayOrDefault(name, defaultValue, env = processEnvLookup) {
  const value = env(name);
  if (value === undefined || value === "") {
    return defaultValue;
  }
  return value.split(",").map((s)=>s.trim()).filter((s)=>s !== "");
}
/**
 * Load configuration from a JSON file.
 *
 * @param configPath - Path to the .config.json file
 * @returns Parsed config file or empty object if file doesn't exist
 */ /**
 * Map of snake_case JSON keys to camelCase RepoConfig field names.
 *
 * The `.config.json` documentation uses snake_case for repo_config fields
 * (e.g., `skip_screenshot_check`), but the TypeScript `RepoConfig` interface
 * uses camelCase (e.g., `skipScreenshotCheck`). This map normalises the
 * JSON-parsed keys so both formats are accepted (Issue #1296).
 */ const REPO_CONFIG_KEY_MAP = {
  pre_setup_command: "preSetupCommand",
  skip_quality_check: "skipQualityCheck",
  quality_command: "qualityCommand",
  custom_instructions: "customInstructions",
  skip_auto_merge: "skipAutoMerge",
  skip_reviewer_request: "skipReviewerRequest",
  skip_screenshot_check: "skipScreenshotCheck",
  skip_security_fix_check: "skipSecurityFixCheck",
  // Diff-scoped mutation gate (Issue #3393).
  skip_mutation_check: "skipMutationCheck",
  mutation_check_budget_seconds: "mutationCheckBudgetSeconds",
  // Coverage carry-over gate (Issue #3795).
  skip_coverage_carryover_check: "skipCoverageCarryOverCheck",
  // Credentials this repository's checks need (Issues #573, #574).
  quality_credentials: "qualityCredentials",
  docker_image: "dockerImage",
  quality_check_timeout: "qualityCheckTimeout",
  // Per-repo nice value — lower = sooner (Issue #2772). Key is identical
  // in snake_case and camelCase; mapped explicitly for documentation parity.
  nice: "nice",
  // Per-repo model/effort routing (Issue #2625).
  claude_model: "claudeModel",
  // Per-repo best planning model for degraded-model detection (Issue #2654).
  best_planning_model: "bestPlanningModel",
  phase_model_overrides: "phaseModelOverrides",
  phase_effort_overrides: "phaseEffortOverrides",
  // Per-repo issue-executor split override (Issue #2341).
  issue_executor_split: "issueExecutorSplit",
  // Per-repo issue sub-agent tier override (Issue #3401).
  issue_sub_agent_tier: "issueSubAgentTier",
  // Per-repo Codex model/effort routing (Issue #363).
  codex_model: "codexModel",
  codex_phase_model_overrides: "codexPhaseModelOverrides",
  codex_phase_effort_overrides: "codexPhaseEffortOverrides",
  // Per-repo Gemini model routing (Issue #364). Model only — the Gemini CLI
  // has no reasoning-effort option to override.
  gemini_model: "geminiModel",
  gemini_phase_model_overrides: "geminiPhaseModelOverrides",
  // Per-repo DeepSeek model routing (Issue #413). Model only — DeepSeek's
  // Anthropic-compatible endpoint has no effort control to override.
  deepseek_model: "deepseekModel",
  deepseek_phase_model_overrides: "deepseekPhaseModelOverrides",
  // Per-repo coding-agent provider pin (Issue #2048).
  agent_provider: "agentProvider",
  external_orchestration: "externalOrchestration",
  external_orchestration_settings: "externalOrchestrationSettings",
  // Pre-flight enforcement gate (Issue #3577). Accept the kebab-case form
  // shown in the issue/docs example (`"pre-flight"`) and the snake_case form
  // (`pre_flight`); camelCase (`preFlight`) passes through unchanged.
  "pre-flight": "preFlight",
  pre_flight: "preFlight",
  // Issue-mode CI-failure log auto-fetch (Issue #3581).
  ci_failure_labels: "ciFailureLabels",
  ci_failure_job_path: "ciFailureJobPath",
  // Per-repo auto-fix attempt cap (Issue #3582).
  max_auto_fix_attempts: "maxAutoFixAttempts",
  // Per-repo blocking-PR stall threshold (Issue #4025).
  blocking_pr_stall_threshold_seconds: "blockingPrStallThresholdSeconds",
  // Per-repo fleet PR cap on the default-branch stream (Issue #2663).
  fleet_pr_slots: "fleetPrSlots",
  completion_admission: "completionAdmission"
};
/**
 * Normalise a single RepoConfig object from snake_case to camelCase keys.
 *
 * Accepts both snake_case and camelCase — snake_case keys are converted,
 * camelCase keys are kept as-is. Unknown keys are dropped.
 */ function normaliseRepoConfig(raw) {
  const normalised = {};
  for (const [key, value] of Object.entries(raw)){
    const mappedKey = REPO_CONFIG_KEY_MAP[key];
    if (mappedKey) {
      // Snake_case key — map to camelCase
      normalised[mappedKey] = value;
    } else {
      // Already camelCase or unknown — keep as-is
      normalised[key] = value;
    }
  }
  if (normalised.externalOrchestration !== undefined && typeof normalised.externalOrchestration !== "boolean") {
    throw new Error("repo external_orchestration must be boolean");
  }
  if (normalised.externalOrchestrationSettings !== undefined) {
    normalised.externalOrchestrationSettings = parseOrchestrationSettings(normalised.externalOrchestrationSettings);
  }
  if (normalised.completionAdmission !== undefined) {
    normalised.completionAdmission = parseCompletionPolicy(normalised.completionAdmission);
  }
  return normalised;
}
/**
 * Normalise all repo configs in a repo_config map.
 *
 * Each repo's config object gets its snake_case keys converted to camelCase
 * so that `getRepoConfig()` can find them by their TypeScript field names.
 */ function normaliseRepoConfigs(raw) {
  if (!raw) return undefined;
  const result = {};
  for (const [repo, config] of Object.entries(raw)){
    result[repo] = normaliseRepoConfig(config);
  }
  return result;
}
/**
 * Read, validate and return the raw `.config.json`.
 *
 * @param configPath - Path to the config file
 * @param env - Environment lookup the validators read through (Issue #956);
 *   the `container_extension` containment rule needs the host home directory.
 * @returns The validated config file contents (empty when the file is absent)
 */ async function loadConfigFile(configPath, env = processEnvLookup) {
  let content;
  try {
    content = await Deno.readTextFile(configPath);
  } catch  {
    // File doesn't exist - return empty config
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch  {
    throw new Error(`Config file ${configPath} contains invalid JSON`);
  }
  const validated = validateConfigFileJson(parsed);
  if (!validated.ok) {
    throw new Error(`Config file ${configPath} has invalid structure: ${validated.error.field} - ${validated.error.message}`);
  }
  // Issue #1334: Detect unknown keys and warn about typos / camelCase mistakes
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const warnings = detectUnknownConfigKeys(parsed);
    if (warnings.length > 0) {
      const formatted = formatUnknownKeyWarnings(warnings);
      console.error(formatted);
    }
  }
  // Issue #69 (parent #5): deployer-supplied container tool specs are the
  // trust boundary for an unverified download — a malformed spec fails the
  // config load loudly rather than reaching the image build.
  const tools = parseContainerTools(validated.value.container_tools);
  if (!tools.ok) {
    throw new Error(`Config file ${configPath} is invalid: ${tools.error}`);
  }
  // Issue #978 (parent #933): the private environment extension is the trust
  // boundary for what the operator's own layer builds and runs — a malformed
  // declaration fails the config load loudly, naming the field, rather than
  // reaching the build. An absent key declares no extension and changes
  // nothing.
  const extension = parseContainerExtension(validated.value.container_extension, {
    env
  });
  if (!extension.ok) {
    throw new Error(`Config file ${configPath} is invalid: ${extension.error}`);
  }
  // Issue #622 (part of #583): the pinned ref and tool versions are meant to
  // be hand-edited without re-running setup, so a bad edit fails here —
  // naming the offending field — rather than checking out the wrong thing or
  // installing a version nobody asked for.
  const file = validated.value;
  const updateModeErrors = validateUpdateModeSettings({
    updateMode: file.update_mode,
    pinnedRef: file.pinned_ref,
    pinnedToolVersions: file.pinned_tool_versions
  });
  if (updateModeErrors.length > 0) {
    throw new Error(`Config file ${configPath} is invalid: ${updateModeErrors.join(" ")}`);
  }
  // Issue #2701: only setup acts on it, but a hand-edited typo fails here,
  // naming the field, rather than reading as "leave" and billing on.
  const copilotCodeReview = parseCopilotCodeReview(file.copilot_code_review);
  if (!copilotCodeReview.ok) {
    throw new Error(`Config file ${configPath} is invalid: ${copilotCodeReview.error}`);
  }
  return file;
}
/**
 * Load worker configuration from config file only (Issue #266, #277).
 *
 * All values come from the config file, with hardcoded defaults as fallback.
 * Environment variable overrides are no longer supported at runtime.
 * Only values that differ from defaults need to be stored in .config.json.
 *
 * @param configPath - Path to the .config.json file
 * @param options - Optional behaviour overrides
 * @returns Complete worker configuration
 */ export async function loadConfig(configPath, options) {
  // The one environment seam this loader reads through (Issue #956).
  const env = options?.env ?? processEnvLookup;
  const file = await loadConfigFile(configPath, env);
  warnRemovedTrustKeys(file);
  // Issue #1066: `allowed_authors` no longer grants anything. Who may direct
  // work is derived from repository collaborators every cycle, so trust
  // starts **closed** here and is opened only by a successful resolve. The
  // file's array survives for one non-trust purpose: the default PR reviewer
  // and assignee when `pr_reviewers` is unset.
  const allowedAuthors = [];
  const configuredAuthors = file.allowed_authors ?? [];
  const allowedAuthor = configuredAuthors[0] ?? "";
  // Load PR reviewers array (Issue #141)
  const prReviewers = file.pr_reviewers ?? [];
  const prReviewer = prReviewers[0] ?? allowedAuthor ?? "";
  // Issue #1546: GitHub repository names are case-insensitive, so two
  // spellings of one repository are one repository. Left alone, the second
  // entry ran every per-repository scan a second time and let the worker's
  // own slots race each other for its issues.
  const { repos, duplicates } = dedupeRepoSlugs(file.repos ?? []);
  warnDuplicateRepos(duplicates, Object.keys(file.repo_config ?? {}));
  // Issue #1834: the three discovery labels (top-priority, work-on,
  // low-priority) are hardwired and NOT configurable. issueLabels is the
  // configured-label tier that the label-based collector iterates; only
  // top-priority belongs here, since work-on and low-priority have
  // dedicated, author-checked collectors with stricter authorisation
  // checks. Routing them through the label collector would bypass those
  // checks.
  const issueLabels = [
    LABEL_DEFAULTS.topPriorityLabel
  ];
  // Issue #1066, axis 2: the *known* logins whose input the worker acts on —
  // Copilot, Actions, and any other bot the operator names. A GitHub App is
  // never a repository collaborator, so this cannot be derived; it is an
  // explicit allowlist by necessity. It grants input only, never the right to
  // direct work. An operator who sets the key keeps exactly what they wrote.
  const authorisedCommenters = file.authorized_commenters ?? [
    ...DEFAULT_TRUSTED_INPUT_BOTS
  ];
  const exclusionTeam = file.exclusion_team;
  // Issue #3528: allowlist of service-account logins the identity guard
  // validates the resolved `gh` login against. Empty leaves the guard
  // inactive (loudly warned), never silently permissive.
  const serviceAccounts = file.service_accounts ?? [];
  // Issue #3530: service-account auth env sources. Kept raw (no ~ expansion)
  // — applyServiceAccountEnv expands when it sets GH_CONFIG_DIR /
  // GIT_SSH_COMMAND on the shared command path.
  const ghConfigDir = file.gh_config_dir ?? "";
  const sshKeyPath = file.ssh_key_path ?? "";
  // Trusted review bots (Issue #1856). Precedence: TRUSTED_REVIEW_BOTS
  // env var > .config.json (`trusted_review_bots`) > built-in defaults.
  const trustedReviewBots = getEnvArrayOrDefault("TRUSTED_REVIEW_BOTS", file.trusted_review_bots ?? [
    ...DEFAULT_TRUSTED_REVIEW_BOTS
  ], env);
  // Sibling fleet PR authors (fleet-aware PR maintenance). Precedence:
  // FLEET_PR_AUTHORS env var > .config.json (`fleet_pr_authors`) > [].
  const configuredFleetPrAuthors = getEnvArrayOrDefault("FLEET_PR_AUTHORS", file.fleet_pr_authors ?? [], env);
  // Issue #209: `service_accounts` names fleet accounts too, so the two
  // keys resolve to one effective sibling list here. A fleet that listed
  // its siblings only under `service_accounts` had an empty
  // `fleet_pr_authors`, which left every sibling outside the PR guards:
  // their open PRs did not block a claim and their merged PRs did not
  // close one, so two hosts worked the same issue minutes apart. Unioning
  // once at load means no consumer — including the ones that build their
  // own author list from `fleetPrAuthors` — can see one key without the
  // other.
  const fleetPrAuthors = resolveEffectiveFleetPrAuthors(configuredFleetPrAuthors, serviceAccounts);
  // Label configuration — all from LABEL_DEFAULTS. Issue #1834 hardwires
  // workOnLabel and lowPriorityLabel; the remaining labels still load
  // from .config.json so admins can rename workflow labels (failed,
  // needs-clarification, etc.) when integrating with existing repos.
  const workOnLabel = LABEL_DEFAULTS.workOnLabel;
  const failedOnceLabel = file.failed_once_label ?? LABEL_DEFAULTS.failedOnceLabel;
  const failedLabel = file.failed_label ?? LABEL_DEFAULTS.failedLabel;
  const refineIssueLabel = file.refine_issue_label ?? LABEL_DEFAULTS.refineIssueLabel;
  const planningLabel = file.planning_label ?? LABEL_DEFAULTS.planningLabel;
  const questionLabel = file.question_label ?? LABEL_DEFAULTS.questionLabel;
  const needsRevisionLabel = file.needs_revision_label ?? LABEL_DEFAULTS.needsRevisionLabel;
  const needsHumanLabel = file.needs_human_label ?? LABEL_DEFAULTS.needsHumanLabel;
  const grillMeLabel = file.grill_me_label ?? LABEL_DEFAULTS.grillMeLabel;
  const quorumLabel = file.quorum_label ?? LABEL_DEFAULTS.quorumLabel;
  // Issue #1834: lowPriorityLabel is hardwired — `.config.json` may not override.
  const lowPriorityLabel = LABEL_DEFAULTS.lowPriorityLabel;
  const home = env("HOME") ?? "/tmp";
  const workDir = `${home}/auto-issue-work`;
  // Where this host runs the worker (Issue #4146). Container by default;
  // `native` is an explicit opt-in, and an unrecognised value fails loudly
  // here rather than quietly launching in the mode nobody asked for.
  // `env` goes through: `VIBE_RUN_MODE` beats the file, and a loader given an
  // explicit lookup must not have that override answered by the process
  // instead (Issue #969 — the seam #956 added stopped one call short here).
  const runMode = resolveRunMode({
    configured: file.run_mode,
    env
  });
  // How this host tracks releases (Issue #622, part of #583). Absent means
  // `dynamic`, so a host with no update-mode keys behaves exactly as before.
  // The pins are carried through in either mode — nothing acts on them under
  // `dynamic`, but keeping them lets a host flip back without re-editing.
  const updateMode = file.update_mode ?? DEFAULT_UPDATE_MODE;
  const pinnedRef = file.pinned_ref;
  const pinnedToolVersions = file.pinned_tool_versions;
  // Coding-agent provider selection (Issue #4067). Resolved here so an
  // unsupported id fails loudly at startup, naming the supported providers,
  // rather than surfacing as a missing binary mid-run. Outside automatic
  // routing the selection is also recorded on the seam, because the low-level
  // modules that spawn the agent hold no configuration handle. While routing
  // is active, the router owns that seam between its refreshes (Issue #4024).
  // The resolver consults the per-run provider override (Issue #2062)
  // before the file's value: the health gate's fallback switch therefore
  // survives every in-process config reload, which would otherwise reset
  // the choice to the file's preferred id (Issue #2065).
  // `env` goes through for the same reason it does below (Issue #2086): the
  // `VIBE_AGENT_PROVIDER` fallback and the running image's installed-provider
  // stamp decide this id, so a loader given an explicit lookup must not have
  // them answered by the process environment instead — the seam #956 added
  // stopped one call short here, exactly as it did at `resolveRunMode`
  // (Issue #969).
  const agentProvider = resolveAgentProviderId({
    configured: file.agent_provider,
    env
  });
  // (Issue #4024) Automatic routing owns the active provider between its
  // refreshes: a best-effort config reload — the allowlist and
  // trusted-author readers call this full loader for one small field — must
  // not reset the seam to the file's preferred id, or every maintenance
  // phase after the reload runs the provider the router just deselected
  // (GRQ-23: PR feedback ran Codex while the router had switched to Claude).
  // The run override is already immune (Issue #2062), so only the
  // auto-router's selection needs this guard; a pinned-mode host — routing
  // inactive — keeps the historical reload behaviour.
  if (!isAutomaticProviderRoutingActive()) {
    setConfiguredAgentProviderId(agentProvider);
  }
  // The providers enabled for this run (Issue #4108). Each one is provisioned,
  // preflighted and mounted separately; a provider outside the set has no
  // credential mount at all. Resolved here so an unusable set — an unknown id,
  // a duplicate, or one that excludes the active provider — fails loudly at
  // startup, and recorded on the seam for the modules that hold no
  // configuration handle.
  // Cleared first so a selection recorded by an earlier load cannot leak into
  // this one: the file in hand decides the set on its own.
  setConfiguredEnabledAgentProviderIds(undefined);
  const enabledAgentProviderIds = resolveEnabledAgentProviderIds({
    // The same lookup the rest of the load reads through (Issue #962): the
    // VIBE_AGENT_PROVIDER(S) fallbacks and the running image's stamp decide
    // which agent this run dispatches to when the file states none, so they
    // must not come from a different environment to everything else here.
    env,
    configured: file.agent_provider,
    configuredProviders: file.agent_providers
  });
  setConfiguredEnabledAgentProviderIds(enabledAgentProviderIds);
  // Egress allowlist (Issue #4045): invalid hosts fail the load. The launch
  // plan (Issue #4047) resolves the same list and hands it to the proxy.
  try {
    resolveEgressAllowlist({
      enabledProviderIds: enabledAgentProviderIds,
      imgbbConfigured: (file.imgbb_api_key ?? "").trim() !== "" || readImgbbApiKeyFromEnv(env) !== "",
      anthropicBaseUrl: env("ANTHROPIC_BASE_URL"),
      extraHosts: file.egress_allow_hosts
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Config file ${configPath} is invalid: ${message}`);
  }
  // Opt-in ordered fallback (Issue #1700). Validated here so an unconfigured
  // alternative fails at startup, not mid-run. The empty default is pinned.
  // Recorded on the seam for the agent runner, which moves a phase whose
  // model the provider refused onto these alternatives (Issue #4034).
  const providerFallbackPolicy = resolveProviderFallbackPolicy({
    preferred: agentProvider,
    enabled: enabledAgentProviderIds,
    fallback: file.agent_provider_fallback
  });
  setConfiguredProviderFallbackPolicy(providerFallbackPolicy);
  const agentProviderFallback = providerFallbackPolicy.alternatives;
  // Claude model selection (Issue #260). Empty when the host sets no
  // `claude_model`: call sites pass `config.claudeModel || undefined` as an
  // explicit `--model`, which beats phase routing, so defaulting it to Opus
  // put every issue manager on Opus instead of the Sonnet `issue` default
  // (Issue #4117).
  const claudeModel = file.claude_model ?? "";
  // Configured best planning model for degraded-model detection (Issue #2654).
  // Empty default → expected model derived from the planning routing chain.
  const bestPlanningModel = file.best_planning_model ?? DEFAULT_BEST_PLANNING_MODEL;
  // Operational settings — all from .config.json with defaults (Issue #277)
  const claudeMaxTurns = validateClaudeMaxTurns(file.claude_max_turns ?? DEFAULT_CLAUDE_MAX_TURNS);
  const claudeTimeout = file.claude_timeout ?? OPERATIONAL_DEFAULTS.claudeTimeout;
  // Claim-runway floor (Issue #289). Config first, then the legacy
  // environment variables, then the default. The env vars are never
  // forwarded into the worker container (`container_launch.ts` passes only
  // the five it sets itself), so on a containerised host the config key is
  // the only interface that works — hence the key, and hence config winning.
  const minClaimRunwaySeconds = file.min_claim_runway_seconds ?? readNonNegativeNumberEnv("MIN_CLAIM_RUNWAY_SECONDS", env) ?? OPERATIONAL_DEFAULTS.minClaimRunwaySeconds;
  // Run finish deadline (Issue #4242): seconds from run start. Validated
  // here and published by the run timeline. Agent sessions, extension
  // grants, the claim floor and the drain read it (Issues #4244, #4245,
  // #4246). A finish at or before the one-hour run target leaves no time
  // to finish, so it is refused loudly rather than logged as a live deadline.
  const runFinishSeconds = file.run_finish_seconds ?? OPERATIONAL_DEFAULTS.runFinishSeconds;
  if (!Number.isFinite(runFinishSeconds)) {
    throw new Error(`run_finish_seconds must be a finite number, got ` + `${String(runFinishSeconds)}.`);
  }
  if (runFinishSeconds <= DEFAULT_RUN_TARGET_SECONDS) {
    throw new Error(`run_finish_seconds must be greater than the run duration target ` + `(${DEFAULT_RUN_TARGET_SECONDS}), got ${runFinishSeconds}. The finish ` + `deadline is measured from run start, so a value at or below the ` + `target leaves the run no time to finish after it.`);
  }
  // Adaptive claim floor (Issue #245): labels that mark an issue as a long
  // job, alongside the preserved-WIP and prior-execute-timeout evidence.
  const claimLongJobLabels = file.claim_long_job_labels ?? [
    ...DEFAULT_LONG_JOB_LABELS
  ];
  // Re-armable issue-work deadline (Issue #4296, part of #4290). Off by
  // default; only issue work consults it. Non-positive tunables are rejected
  // loudly rather than silently disabling or extending forever (#3234).
  const progressExtensionEnabled = file.progress_extension_enabled ?? OPERATIONAL_DEFAULTS.progressExtensionEnabled;
  // Agent transcript tee (Issue #1141). `.config.json` is the only operator
  // switch: every one of the twenty fleet run records archived on 2026-09-05
  // carried "agent transcript tee not enabled for this run" because nothing
  // set the environment variable and there was no key that could. Off by
  // default — the transcript is the raw agent stream, so a deployment opts in.
  const agentTranscriptEnabled = file.agent_transcript_enabled ?? OPERATIONAL_DEFAULTS.agentTranscriptEnabled;
  const progressExtensionGrantSeconds = file.progress_extension_grant_seconds ?? OPERATIONAL_DEFAULTS.progressExtensionGrantSeconds;
  const progressExtensionStallSeconds = file.progress_extension_stall_seconds ?? OPERATIONAL_DEFAULTS.progressExtensionStallSeconds;
  if (progressExtensionGrantSeconds <= 0) {
    throw new Error(`progress_extension_grant_seconds must be positive, got ` + `${progressExtensionGrantSeconds}. A non-positive grant would re-arm ` + `the deadline in the past and spin the watchdog.`);
  }
  if (progressExtensionStallSeconds <= 0) {
    throw new Error(`progress_extension_stall_seconds must be positive, got ` + `${progressExtensionStallSeconds}. A non-positive stall window would ` + `treat every run as inactive and kill it on schedule.`);
  }
  const progressExtensionCheckSeconds = file.progress_extension_check_seconds ?? OPERATIONAL_DEFAULTS.progressExtensionCheckSeconds;
  if (progressExtensionCheckSeconds <= 0) {
    throw new Error(`progress_extension_check_seconds must be positive, got ` + `${progressExtensionCheckSeconds}. A non-positive interval would ` + `spin the watchdog instead of sampling the working tree.`);
  }
  // Issue #2960: timeout for the screenshot gate's one extra in-run agent
  // turn. Rejected loudly rather than silently hanging or firing instantly.
  const screenshotRetryTimeoutSeconds = file.screenshot_retry_timeout_seconds ?? OPERATIONAL_DEFAULTS.screenshotRetryTimeoutSeconds;
  if (typeof screenshotRetryTimeoutSeconds !== "number" || !Number.isFinite(screenshotRetryTimeoutSeconds) || screenshotRetryTimeoutSeconds <= 0) {
    throw new Error(`screenshot_retry_timeout_seconds must be a positive finite number, ` + `got ${JSON.stringify(file.screenshot_retry_timeout_seconds)}`);
  }
  // Issue #4128: timeout for the pre-push gate's one extra in-run agent turn.
  // Rejected loudly rather than silently hanging or firing instantly.
  const prePushRetryTimeoutSeconds = file.pre_push_retry_timeout_seconds ?? OPERATIONAL_DEFAULTS.prePushRetryTimeoutSeconds;
  if (typeof prePushRetryTimeoutSeconds !== "number" || !Number.isFinite(prePushRetryTimeoutSeconds) || prePushRetryTimeoutSeconds <= 0) {
    throw new Error(`pre_push_retry_timeout_seconds must be a positive finite number, ` + `got ${JSON.stringify(file.pre_push_retry_timeout_seconds)}`);
  }
  if (progressExtensionStallSeconds < progressExtensionCheckSeconds) {
    // The deadline decision reads tree evidence up to one check interval old,
    // so a shorter activity window kills runs that demonstrably progressed
    // inside that same window (Issue #4295).
    throw new Error(`progress_extension_stall_seconds must be at least ` + `progress_extension_check_seconds, got ` + `${progressExtensionStallSeconds} < ${progressExtensionCheckSeconds}. ` + `A stall window shorter than the check interval would kill a healthy ` + `run whose tool activity landed between checks.`);
  }
  // Call-storm stall guard (Issue #2230). On by default; the tunables are
  // refused loudly rather than silently disabling the guard or stopping every
  // run, exactly as the progress-extension tunables above are.
  const callStormEnabled = file.call_storm_enabled ?? OPERATIONAL_DEFAULTS.callStormEnabled;
  const callStormCalls = file.call_storm_calls ?? OPERATIONAL_DEFAULTS.callStormCalls;
  const callStormWindowSeconds = file.call_storm_window_seconds ?? OPERATIONAL_DEFAULTS.callStormWindowSeconds;
  const callStormNovelShare = file.call_storm_novel_share ?? OPERATIONAL_DEFAULTS.callStormNovelShare;
  // A share of 0 or less can never be undercut, so the guard would never
  // fire; above 1 is not a share at all (Issue #2773).
  if (!Number.isFinite(callStormNovelShare) || callStormNovelShare <= 0 || callStormNovelShare > 1) {
    throw new Error(`call_storm_novel_share must be above 0 and at most 1, got ` + `${callStormNovelShare}. A share of 0 or less would never stop a ` + `run. Set call_storm_enabled: false to turn the guard off instead.`);
  }
  if (callStormCalls <= 0) {
    throw new Error(`call_storm_calls must be positive, got ${callStormCalls}. A ` + `non-positive threshold would stop every run that reached a check. ` + `Set call_storm_enabled: false to turn the guard off instead.`);
  }
  if (callStormWindowSeconds <= 0) {
    throw new Error(`call_storm_window_seconds must be positive, got ` + `${callStormWindowSeconds}. A non-positive window has no rate to ` + `measure. Set call_storm_enabled: false to turn the guard off instead.`);
  }
  // The tracker's history is what the guard can see (Issue #2230). A window
  // or a threshold beyond it would be accepted and then quietly under-count
  // or never fire, which is the silent failure this codebase refuses.
  const callStormHistorySeconds = TOOL_CALL_HISTORY_MS / 1000;
  if (callStormWindowSeconds > callStormHistorySeconds) {
    throw new Error(`call_storm_window_seconds must not exceed the ` + `${callStormHistorySeconds}s of tool-call history the progress ` + `tracker retains, got ${callStormWindowSeconds}. A wider window ` + `would count only the part of itself the tracker still remembers.`);
  }
  if (callStormCalls > TOOL_CALL_HISTORY_MAX) {
    throw new Error(`call_storm_calls must not exceed the ${TOOL_CALL_HISTORY_MAX} tool ` + `calls the progress tracker retains, got ${callStormCalls}. A higher ` + `threshold could never be reached, so the guard would never fire.`);
  }
  // Quota-aware polling gate (Issue #3628). On by default; the floors are
  // refused loudly rather than silently disabling a tier — a non-integer or
  // negative floor is not a number of points, and an idle floor above the
  // park floor would never be reached so the idle tier could never defer.
  const quotaPollParkFloor = file.quota_poll_park_floor ?? OPERATIONAL_DEFAULTS.quotaPollParkFloor;
  const quotaPollParkNice = file.quota_poll_park_nice ?? OPERATIONAL_DEFAULTS.quotaPollParkNice;
  const quotaPollIdleFloor = file.quota_poll_idle_floor ?? OPERATIONAL_DEFAULTS.quotaPollIdleFloor;
  if (!Number.isInteger(quotaPollParkFloor) || quotaPollParkFloor < 0) {
    throw new Error(`quota_poll_park_floor must be a whole number of points at or above ` + `0, got ${quotaPollParkFloor}. Set it to 0 to turn the park tier off.`);
  }
  if (!Number.isInteger(quotaPollParkNice)) {
    throw new Error(`quota_poll_park_nice must be a whole number (it is a nice ` + `comparison), got ${quotaPollParkNice}.`);
  }
  if (!Number.isInteger(quotaPollIdleFloor) || quotaPollIdleFloor < 0) {
    throw new Error(`quota_poll_idle_floor must be a whole number of points at or above ` + `0, got ${quotaPollIdleFloor}. Set it to 0 to turn the idle tier off.`);
  }
  if (quotaPollIdleFloor > quotaPollParkFloor) {
    throw new Error(`quota_poll_idle_floor must not exceed quota_poll_park_floor, got ` + `${quotaPollIdleFloor} above ${quotaPollParkFloor}. The idle tier ` + `could then never defer, because the park floor is crossed first. ` + `Set both floors to 0 to turn the polling gate off.`);
  }
  // Nice-derived poll cadence (Issue #3667). On by default; a cadence that
  // is not a whole number of cycles of at least 1 is refused loudly — 1 is
  // "every cycle", the way to turn a tier's cadence off.
  const pollCadenceLowCycles = file.poll_cadence_low_cycles ?? OPERATIONAL_DEFAULTS.pollCadenceLowCycles;
  const pollCadenceParkCycles = file.poll_cadence_park_cycles ?? OPERATIONAL_DEFAULTS.pollCadenceParkCycles;
  for (const [key, value] of [
    [
      "poll_cadence_low_cycles",
      pollCadenceLowCycles
    ],
    [
      "poll_cadence_park_cycles",
      pollCadenceParkCycles
    ]
  ]){
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${key} must be a whole number of cycles at or above 1, got ` + `${value}. Set it to 1 to poll that tier every cycle.`);
    }
  }
  // Self-scheduling for auto-filed worker diagnostics (Issue #505). On by
  // default; `false` restores the wait-for-a-human behaviour exactly. The
  // in-flight cap is refused loudly when it is not a whole number — a
  // fractional or negative cap would silently disable a feature the operator
  // believes is on.
  const selfScheduleDiagnosticsEnabled = file.self_schedule_diagnostics_enabled ?? OPERATIONAL_DEFAULTS.selfScheduleDiagnosticsEnabled;
  const selfScheduleDiagnosticsMaxInFlight = file.self_schedule_diagnostics_max_in_flight ?? OPERATIONAL_DEFAULTS.selfScheduleDiagnosticsMaxInFlight;
  if (!Number.isInteger(selfScheduleDiagnosticsMaxInFlight) || selfScheduleDiagnosticsMaxInFlight < 0) {
    throw new Error(`self_schedule_diagnostics_max_in_flight must be a non-negative ` + `integer, got ${selfScheduleDiagnosticsMaxInFlight}. Use 0 to refuse ` + `every self-scheduled diagnostic, or ` + `self_schedule_diagnostics_enabled: false to turn the path off.`);
  }
  // Issue #1824: distinct hard timeouts for reactive phases — PR feedback
  // and CI fix should not inherit the larger issue-work budget. Falls back
  // to claude_timeout if explicitly set in config (back-compat), then to
  // the phase-specific operational default.
  const prFeedbackTimeout = file.pr_feedback_timeout ?? file.claude_timeout ?? OPERATIONAL_DEFAULTS.prFeedbackTimeout;
  const ciFixTimeout = file.ci_fix_timeout ?? file.claude_timeout ?? OPERATIONAL_DEFAULTS.ciFixTimeout;
  const claudeKillAfter = file.claude_kill_after ?? OPERATIONAL_DEFAULTS.claudeKillAfter;
  const maxClarificationRounds = file.max_clarification_rounds ?? OPERATIONAL_DEFAULTS.maxClarificationRounds;
  const sleepInterval = file.sleep_interval ?? OPERATIONAL_DEFAULTS.sleepInterval;
  if (file.pr_scanning_enabled !== undefined && typeof file.pr_scanning_enabled !== "boolean") {
    throw new Error("pr_scanning_enabled must be a boolean");
  }
  const prScanningEnabled = file.pr_scanning_enabled ?? true;
  const maxConcurrentIssues = file.max_concurrent_issues ?? OPERATIONAL_DEFAULTS.maxConcurrentIssues;
  const creditWaitInterval = file.credit_wait_interval ?? OPERATIONAL_DEFAULTS.creditWaitInterval;
  const refinementTimeout = file.refinement_timeout ?? OPERATIONAL_DEFAULTS.refinementTimeout;
  const refinementKillAfter = file.refinement_kill_after ?? OPERATIONAL_DEFAULTS.refinementKillAfter;
  const planningTimeout = file.planning_timeout ?? OPERATIONAL_DEFAULTS.planningTimeout;
  const planningKillAfter = file.planning_kill_after ?? OPERATIONAL_DEFAULTS.planningKillAfter;
  const questionTimeout = file.question_timeout ?? OPERATIONAL_DEFAULTS.questionTimeout;
  const questionKillAfter = file.question_kill_after ?? OPERATIONAL_DEFAULTS.questionKillAfter;
  const clarificationTimeout = file.clarification_timeout ?? OPERATIONAL_DEFAULTS.clarificationTimeout;
  const clarificationKillAfter = file.clarification_kill_after ?? OPERATIONAL_DEFAULTS.clarificationKillAfter;
  const maxGrillMeRounds = file.max_grill_me_rounds ?? OPERATIONAL_DEFAULTS.maxGrillMeRounds;
  const grillMeTimeout = file.grill_me_timeout ?? OPERATIONAL_DEFAULTS.grillMeTimeout;
  const grillMeKillAfter = file.grill_me_kill_after ?? OPERATIONAL_DEFAULTS.grillMeKillAfter;
  // Quorum bounds and provider trio (Issue #4112). A configured planner list
  // that is not exactly two ids is rejected loudly rather than padded or
  // truncated — a one-sided "quorum" would have nothing to judge (#3234).
  const quorumTimeout = file.quorum_timeout ?? OPERATIONAL_DEFAULTS.quorumTimeout;
  const quorumKillAfter = file.quorum_kill_after ?? OPERATIONAL_DEFAULTS.quorumKillAfter;
  const quorumPlanners = file.quorum_planners ?? defaultQuorumPlanners();
  if (quorumPlanners.length !== 2) {
    throw new Error(`quorum_planners must name exactly two drafting providers, got ` + `${quorumPlanners.length}. Quorum judges two plans against each other.`);
  }
  const quorumJudge = file.quorum_judge ?? defaultQuorumJudge();
  const maxRateLimitRetries = file.max_rate_limit_retries ?? OPERATIONAL_DEFAULTS.maxRateLimitRetries;
  const maxRateLimitWait = file.max_rate_limit_wait ?? OPERATIONAL_DEFAULTS.maxRateLimitWait;
  // Issue #1453: how long the trusted-author snapshot is reused. Bounded at a
  // day — a revoked collaborator must not stay trusted longer than that — and
  // `0` keeps the per-cycle refresh for a deployment that wants it.
  const trustedAuthorsCacheHours = file.trusted_authors_cache_hours ?? OPERATIONAL_DEFAULTS.trustedAuthorsCacheHours;
  if (typeof trustedAuthorsCacheHours !== "number" || !Number.isFinite(trustedAuthorsCacheHours) || trustedAuthorsCacheHours < 0 || trustedAuthorsCacheHours > 24) {
    throw new Error(`trusted_authors_cache_hours must be a number between 0 and 24, got ` + `${JSON.stringify(file.trusted_authors_cache_hours)}`);
  }
  const retryMaxDelay = file.retry_max_delay ?? OPERATIONAL_DEFAULTS.retryMaxDelay;
  const maxIssueBodyTokens = file.max_issue_body_tokens ?? OPERATIONAL_DEFAULTS.maxIssueBodyTokens;
  const summariseTimeout = file.summarise_timeout ?? OPERATIONAL_DEFAULTS.summariseTimeout;
  const summariseKillAfter = file.summarise_kill_after ?? OPERATIONAL_DEFAULTS.summariseKillAfter;
  const featureCheckTimeout = file.feature_check_timeout ?? OPERATIONAL_DEFAULTS.featureCheckTimeout;
  const claudeNoOutputTimeout = file.claude_no_output_timeout ?? OPERATIONAL_DEFAULTS.claudeNoOutputTimeout;
  const qualityCheckTimeout = file.quality_check_timeout ?? OPERATIONAL_DEFAULTS.qualityCheckTimeout;
  // Health check cache TTL (Issue #1070)
  const healthCacheTtl = file.health_cache_ttl ?? OPERATIONAL_DEFAULTS.healthCacheTtl;
  // Repository scanning order (Issue #435)
  const shuffleRepos = file.shuffle_repos ?? DEFAULT_SHUFFLE_REPOS;
  // Worker name for multi-worker visibility (Issue #436)
  const workerName = file.worker_name ?? DEFAULT_WORKER_NAME;
  // Model fallback on rate limit (Issue #1113)
  const enableModelFallback = file.enable_model_fallback ?? OPERATIONAL_DEFAULTS.enableModelFallback;
  // Minimum free disk space before large git operations (Issue #1174)
  const minDiskSpaceMb = file.min_disk_space_mb ?? OPERATIONAL_DEFAULTS.minDiskSpaceMb;
  // The claiming floor's two terms (Issue #732). Deliberately *not* defaulted
  // here: `resolveDiskFloors` applies the defaults, so an unset key falls
  // through to the environment override and then to DEFAULT_LOW_FLOOR_*,
  // rather than this file restating a number that would then drift.
  const hostDiskLowFloorGb = file.host_disk_low_floor_gb;
  const hostDiskLowFloorPercent = file.host_disk_low_floor_percent;
  // Periodic milestone branch sync (Issue #1238)
  const syncMilestoneBranches = file.sync_milestone_branches ?? OPERATIONAL_DEFAULTS.syncMilestoneBranches;
  // Stale workflow thresholds (Issue #1240, #2031 — needs-clarification retired)
  const staleFailedDiagnosticDays = file.stale_failed_diagnostic_days ?? OPERATIONAL_DEFAULTS.staleFailedDiagnosticDays;
  const stalePlanningWarningDays = file.stale_planning_warning_days ?? OPERATIONAL_DEFAULTS.stalePlanningWarningDays;
  // Per-repository fast-failure back-off (Issue #1950)
  const fastFailureSeconds = file.fast_failure_seconds ?? OPERATIONAL_DEFAULTS.fastFailureSeconds;
  const repoFastFailureThreshold = file.repo_fast_failure_threshold ?? OPERATIONAL_DEFAULTS.repoFastFailureThreshold;
  const repoFastFailureWindowHours = file.repo_fast_failure_window_hours ?? OPERATIONAL_DEFAULTS.repoFastFailureWindowHours;
  const tierModels = modelTierOverrides(file.phase_model_tiers, file.provider_model_tiers, PROVIDER_MODEL_TIERS);
  // Phase-specific model overrides (Issue #1265)
  const phaseModelOverrides = {
    ...tierModels.claude,
    ...file.phase_model_overrides ?? {}
  };
  // Phase-specific effort overrides (Issue #1403)
  const phaseEffortOverrides = file.phase_effort_overrides ?? {};
  // Phase-specific Codex model/effort overrides (Issue #363)
  const codexPhaseModelOverrides = {
    ...tierModels.codex,
    ...file.codex_phase_model_overrides ?? {}
  };
  const codexPhaseEffortOverrides = file.codex_phase_effort_overrides ?? {};
  // Phase-specific Gemini model overrides (Issue #364)
  const geminiPhaseModelOverrides = {
    ...tierModels.gemini,
    ...file.gemini_phase_model_overrides ?? {}
  };
  // Phase-specific DeepSeek model overrides (Issue #413)
  const deepseekPhaseModelOverrides = {
    ...tierModels.deepseek,
    ...file.deepseek_phase_model_overrides ?? {}
  };
  // Issue-executor split, host-wide (Issue #2341). A `repo_config` entry of
  // the same name overrides it per repository.
  const issueExecutorSplit = file.issue_executor_split ?? OPERATIONAL_DEFAULTS.issueExecutorSplit;
  // Issue sub-agent tier, host-wide (Issue #3401). A `repo_config` entry of
  // the same name overrides it per repository.
  const issueSubAgentTier = resolveHostIssueSubAgentTier(file.issue_sub_agent_tier);
  // Reviewer sub-agents, host-wide only (Issue #2575).
  const issueReviewerAgents = file.issue_reviewer_agents ?? OPERATIONAL_DEFAULTS.issueReviewerAgents;
  // External orchestrator, host-wide only (Issue #3642). Off by default, so
  // an unconfigured host keeps the Claude-native `--agents` path.
  const externalOrchestration = file.external_orchestration ?? OPERATIONAL_DEFAULTS.externalOrchestration;
  if (typeof externalOrchestration !== "boolean") {
    throw new Error(`external_orchestration must be true or false, got ` + `${JSON.stringify(file.external_orchestration)}`);
  }
  const externalOrchestrationSettings = parseOrchestrationSettings(file.external_orchestration_settings);
  // Fleet-wide run archive repo slug for measurement issues (Issue #2930).
  // Unset (or blank) leaves the feature off.
  const fleetRunArchiveTrimmed = file.fleet_run_archive?.trim();
  const fleetRunArchive = fleetRunArchiveTrimmed === "" || fleetRunArchiveTrimmed === undefined ? undefined : fleetRunArchiveTrimmed;
  // Validated verbatim; whitespace is refused (Issue #3752).
  const subscriptionAllocationLabel = file.subscription_allocation_label;
  // Session resume for multi-phase issue processing (Issue #1324)
  const enableSessionResume = file.enable_session_resume ?? OPERATIONAL_DEFAULTS.enableSessionResume;
  // Verbosity level (Issue #1330)
  const verbosity = file.verbosity ?? DEFAULT_VERBOSITY;
  // Context budget monitoring thresholds (Issue #1327)
  const contextBudgetWarningPercent = file.context_budget_warning_percent ?? OPERATIONAL_DEFAULTS.contextBudgetWarningPercent;
  const contextBudgetErrorPercent = file.context_budget_error_percent ?? OPERATIONAL_DEFAULTS.contextBudgetErrorPercent;
  // Hard context-budget ceiling (Issue #3713)
  const contextBudgetBlockPercent = file.context_budget_block_percent ?? OPERATIONAL_DEFAULTS.contextBudgetBlockPercent;
  // Untrusted comment inclusion (Issue #1340)
  const includeUntrustedComments = file.include_untrusted_comments ?? OPERATIONAL_DEFAULTS.includeUntrustedComments;
  // Closed PR cooldown (Issue #1427)
  const closedPrCooldownSeconds = file.closed_pr_cooldown_seconds ?? OPERATIONAL_DEFAULTS.closedPrCooldownSeconds;
  // Unassign worker after successful PR creation (Issue #1453)
  const unassignOnPrCreated = file.unassign_on_pr_created ?? OPERATIONAL_DEFAULTS.unassignOnPrCreated;
  // Stale work directory age threshold (Issue #1493)
  const staleWorkDirDays = file.stale_work_dir_days ?? OPERATIONAL_DEFAULTS.staleWorkDirDays;
  // Software update retry settings (Issue #1496)
  const updateRetryMaxAttempts = file.update_retry_max_attempts ?? OPERATIONAL_DEFAULTS.updateRetryMaxAttempts;
  const updateRetryBackoffSeconds = file.update_retry_backoff_seconds ?? [
    ...OPERATIONAL_DEFAULTS.updateRetryBackoffSeconds
  ];
  // Treat post-Claude quality failures as passed when no new findings vs baseline (Issue #1549)
  const baselineAwareQualityGate = file.baseline_aware_quality_gate ?? OPERATIONAL_DEFAULTS.baselineAwareQualityGate;
  // In-process retry backoff for infrastructure-category phase failures (Issue #1550)
  const infraRetryBackoffMs = file.infra_retry_backoff_ms ?? OPERATIONAL_DEFAULTS.infraRetryBackoffMs;
  // Auto-fix attempt cap per failure signature (Issue #3582)
  const maxAutoFixAttempts = file.max_auto_fix_attempts ?? OPERATIONAL_DEFAULTS.maxAutoFixAttempts;
  // Blocking-PR stall watchdog threshold (Issue #4025). Left undefined when
  // unset so `resolveBlockingPrStallThresholdSeconds` applies its default.
  const blockingPrStallThresholdSeconds = file.blocking_pr_stall_threshold_seconds;
  // Fleet PR cap on the default-branch stream (Issue #2663). Left undefined
  // when unset so `resolveFleetPrSlots` applies its documented default.
  const fleetPrSlots = file.fleet_pr_slots;
  // Per-template weights for the idle-task draw (Issue #2401)
  const idleTaskTemplateWeights = file.idle_task_template_weights ?? {};
  // Cadence floor for the important idle-task templates (Issues #4003, #4011).
  // Warn-and-fall-back: a malformed block never stops the worker.
  const idleTaskCadence = parseIdleTaskCadence(file.idle_task_cadence);
  // Per-tool minimum version floors for software auto-update (Issue #2622)
  const softwareMinVersions = file.software_min_versions ?? {
    ...OPERATIONAL_DEFAULTS.softwareMinVersions
  };
  // Custom label → non-public prompt file mappings (Issue #846, part of
  // #843). Fail loud: assertCustomLabelPrompts throws naming the offending
  // entry rather than silently dropping a mapping — a silently ignored
  // mapping is exactly the failure #843 rules out.
  //
  // Issue #849: the configured label names decide which entries are overrides
  // of a built-in phase, so they are passed in rather than assumed.
  //
  // In container mode the configured paths are *host* paths the container
  // cannot see, so the launcher hands over where it mounted each one
  // (Issue #850) and the mapping resolves onto that. A read outside the
  // container — the launcher's own, setup, a dev run — sets no variable and
  // uses the configured path unchanged, so one `.config.json` serves both.
  const customLabelPrompts = assertCustomLabelPrompts(file.custom_label_prompts, {
    workOnLabel,
    planningLabel,
    questionLabel,
    grillMeLabel,
    quorumLabel,
    refineIssueLabel,
    resolvePath: customPromptPathResolver(env(CUSTOM_PROMPT_PATH_MAP_ENV))
  });
  // Recent activity settings (Issue #1326)
  const includeRecentActivity = file.include_recent_activity ?? OPERATIONAL_DEFAULTS.includeRecentActivity;
  const recentActivityMergedPrLimit = file.recent_activity_merged_pr_limit ?? OPERATIONAL_DEFAULTS.recentActivityMergedPrLimit;
  const recentActivityCommitLimit = file.recent_activity_commit_limit ?? OPERATIONAL_DEFAULTS.recentActivityCommitLimit;
  const recentActivityMaxTokens = file.recent_activity_max_tokens ?? OPERATIONAL_DEFAULTS.recentActivityMaxTokens;
  const recentActivityCacheTtlSeconds = file.recent_activity_cache_ttl_seconds ?? OPERATIONAL_DEFAULTS.recentActivityCacheTtlSeconds;
  const timelineCacheTtlSeconds = file.timeline_cache_ttl_seconds ?? OPERATIONAL_DEFAULTS.timelineCacheTtlSeconds;
  // Codebase map injection (Issue #4281)
  const includeCodebaseMap = file.include_codebase_map ?? OPERATIONAL_DEFAULTS.includeCodebaseMap;
  // CodeGraph repo context (Issue #2154, part of #2145). Off unless the host
  // asks for it; a malformed block fails the load loudly here rather than
  // reading as off and silently withholding the index the operator configured.
  const parsedCodegraphContext = parseCodegraphContext(file.codegraph_context);
  if (!parsedCodegraphContext.ok) {
    throw new Error(`Config file ${configPath} is invalid: ${parsedCodegraphContext.error}`);
  }
  const codegraphContext = parsedCodegraphContext.value;
  // RTK output (Issue #2380, part of #2328). On unless the host opts out
  // (Issue #2432); a malformed block fails the load loudly here rather than
  // reading as the default and silently ignoring what the operator wrote.
  const parsedRtkOutput = parseRtkOutput(file.rtk_output);
  if (!parsedRtkOutput.ok) {
    throw new Error(`Config file ${configPath} is invalid: ${parsedRtkOutput.error}`);
  }
  const rtkOutput = parsedRtkOutput.value;
  const config = {
    allowedAuthors,
    allowedAuthor,
    prReviewer,
    prReviewers,
    repos,
    issueLabels,
    authorisedCommenters,
    exclusionTeam,
    serviceAccounts,
    ghConfigDir,
    sshKeyPath,
    trustedReviewBots,
    fleetPrAuthors,
    workOnLabel,
    failedOnceLabel,
    failedLabel,
    refineIssueLabel,
    planningLabel,
    questionLabel,
    needsRevisionLabel,
    needsHumanLabel,
    grillMeLabel,
    quorumLabel,
    lowPriorityLabel,
    workDir,
    runMode,
    updateMode,
    pinnedRef,
    pinnedToolVersions,
    agentProvider,
    enabledAgentProviders: enabledAgentProviderIds,
    agentProviderFallback: [
      ...agentProviderFallback
    ],
    claudeWeekPaceDrain: file.claude_week_pace_drain === true,
    claudeModel,
    bestPlanningModel,
    claudeTimeout,
    claudeMaxTurns,
    minClaimRunwaySeconds,
    runFinishSeconds,
    claimLongJobLabels,
    progressExtensionEnabled,
    agentTranscriptEnabled,
    progressExtensionGrantSeconds,
    progressExtensionStallSeconds,
    progressExtensionCheckSeconds,
    screenshotRetryTimeoutSeconds,
    prePushRetryTimeoutSeconds,
    callStormEnabled,
    callStormCalls,
    callStormWindowSeconds,
    callStormNovelShare,
    quotaPollParkFloor,
    quotaPollParkNice,
    quotaPollIdleFloor,
    pollCadenceLowCycles,
    pollCadenceParkCycles,
    selfScheduleDiagnosticsEnabled,
    selfScheduleDiagnosticsMaxInFlight,
    prFeedbackTimeout,
    ciFixTimeout,
    claudeKillAfter,
    maxClarificationRounds,
    sleepInterval,
    trustedAuthorsCacheHours,
    maxConcurrentIssues,
    prScanningEnabled,
    creditWaitInterval,
    refinementTimeout,
    refinementKillAfter,
    planningTimeout,
    planningKillAfter,
    questionTimeout,
    questionKillAfter,
    clarificationTimeout,
    clarificationKillAfter,
    maxGrillMeRounds,
    grillMeTimeout,
    grillMeKillAfter,
    quorumTimeout,
    quorumKillAfter,
    quorumPlanners,
    quorumJudge,
    maxRateLimitRetries,
    maxRateLimitWait,
    retryMaxDelay,
    maxIssueBodyTokens,
    summariseTimeout,
    summariseKillAfter,
    featureCheckTimeout,
    claudeNoOutputTimeout,
    qualityCheckTimeout,
    healthCacheTtl,
    shuffleRepos,
    workerName,
    enableModelFallback,
    minDiskSpaceMb,
    ...hostDiskLowFloorGb === undefined ? {} : {
      hostDiskLowFloorGb
    },
    ...hostDiskLowFloorPercent === undefined ? {} : {
      hostDiskLowFloorPercent
    },
    syncMilestoneBranches,
    staleFailedDiagnosticDays,
    stalePlanningWarningDays,
    fastFailureSeconds,
    repoFastFailureThreshold,
    repoFastFailureWindowHours,
    phaseModelOverrides,
    phaseEffortOverrides,
    codexPhaseModelOverrides,
    codexPhaseEffortOverrides,
    geminiPhaseModelOverrides,
    deepseekPhaseModelOverrides,
    issueExecutorSplit,
    issueSubAgentTier,
    issueReviewerAgents,
    externalOrchestration,
    externalOrchestrationSettings,
    fleetRunArchive,
    subscriptionAllocationLabel,
    includeRecentActivity,
    includeCodebaseMap,
    codegraphContext,
    rtkOutput,
    recentActivityMergedPrLimit,
    recentActivityCommitLimit,
    recentActivityMaxTokens,
    recentActivityCacheTtlSeconds,
    timelineCacheTtlSeconds,
    enableSessionResume,
    verbosity,
    contextBudgetWarningPercent,
    contextBudgetErrorPercent,
    contextBudgetBlockPercent,
    includeUntrustedComments,
    closedPrCooldownSeconds,
    unassignOnPrCreated,
    staleWorkDirDays,
    updateRetryMaxAttempts,
    updateRetryBackoffSeconds,
    baselineAwareQualityGate,
    infraRetryBackoffMs,
    maxAutoFixAttempts,
    blockingPrStallThresholdSeconds,
    fleetPrSlots,
    idleTaskTemplateWeights,
    idleTaskCadence,
    softwareMinVersions,
    customLabelPrompts,
    // Issue #806 (parent #796): `assertCallbacksConfig` is the only trusted
    // producer of the typed block, and it throws on any fault — a hook the
    // operator believes is wired, but that silently never runs, is the exact
    // failure the contract exists to prevent.
    callbacks: assertCallbacksConfig(file.callbacks),
    // Issue #2098 (part of #2060): off unless this host opted in. A malformed
    // block stops the worker here rather than reading as off on a host whose
    // operator believes Graft is on.
    graftContext: assertGraftContextConfig(file.graft_context),
    repoConfig: normaliseRepoConfigs(file.repo_config),
    subscriptionAllocation: parseAllocationPolicy(file.subscription_allocation)
  };
  // Issue #3577: reject a malformed pre-flight gate loudly at config load,
  // rather than silently ignoring it and running the repo unguarded.
  validatePreFlightConfigs(config.repoConfig);
  validateRoleProviders(config);
  // Issue #3394: make the pre-flight commands available to agent spawns.
  registerAgentPreFlightConfigs(config.repoConfig);
  // Issue #630: Optionally validate required fields at load time
  if (options?.validate) {
    validateConfig(config);
  }
  return config;
}
/**
 * Validate every repo's `preFlight` gate configuration at load time
 * (Issue #3577).
 *
 * Throws with a clear per-repo message on the first malformed entry so a
 * typo in `.config.json` fails loudly instead of silently disabling the gate.
 */ function validatePreFlightConfigs(repoConfig) {
  if (!repoConfig) return;
  for (const [repo, cfg] of Object.entries(repoConfig)){
    const raw = cfg.preFlight;
    if (raw === undefined) continue;
    const result = parsePreFlightCommands(raw);
    if (!result.ok) {
      throw new Error(`Invalid pre-flight for ${repo}: ${result.error}`);
    }
  }
}
/**
 * Validate that the configuration has all required fields.
 *
 * @param config - Configuration to validate
 * @throws Error if required fields are missing or invalid
 */ export function validateConfig(config) {
  if (config.exclusionTeam !== undefined) {
    if (!EXCLUSION_TEAM_PATTERN.test(config.exclusionTeam)) {
      throw new Error(`Configuration error: Invalid exclusion_team "${config.exclusionTeam}". ` + "Expected org/slug (e.g. stSoftwareAU/vibe-workers).");
    }
  }
  if (config.repos.length === 0) {
    throw new Error("Configuration error: repos is required. " + "Set via .config.json (run setup.sh to configure).");
  }
  // Issue #1834: issueLabels is hardwired in code, so an empty list here
  // signals an internal bug rather than user misconfiguration.
  if (config.issueLabels.length === 0) {
    throw new Error("Configuration error: issueLabels is empty. The discovery label set " + "is hardwired in lib/config_defaults.ts; this indicates a build " + "bug rather than a configuration problem.");
  }
  // Validate repo format (must be owner/repo)
  for (const repo of config.repos){
    if (!REPO_SLUG_PATTERN.test(repo)) {
      throw new Error(`Configuration error: Invalid repository format "${repo}". ` + "Repositories must be in owner/repo format.");
    }
  }
  // Validate username format for all allowed authors (Issue #137)
  const usernamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*(\[bot\])?$/;
  for (const author of config.allowedAuthors){
    if (!usernamePattern.test(author)) {
      throw new Error(`Configuration error: Invalid username format "${author}" in allowed_authors.`);
    }
  }
  // Issue #1066: `allowed_authors` is no longer required, and no longer
  // grants anything — who may direct work is derived from repository
  // collaborators every cycle. What IS required is something to *subtract*:
  // the Vibe Coder accounts hold write access by necessity, so an empty
  // fleet login set would leave the workers trusted to raise and schedule
  // their own work. Fail loudly rather than run open. Checked last so a host
  // with several problems still hears about the shape errors first.
  if (resolveVibeCoderLogins({
    serviceAccounts: config.serviceAccounts ?? [],
    fleetPrAuthors: config.fleetPrAuthors ?? []
  }).size === 0) {
    throw new Error("Configuration error: the fleet login set is empty, so the Vibe Coder " + "accounts — which hold repository write access in order to push " + "branches — would be trusted to raise and schedule their own work. " + `Set ${FLEET_LOGIN_CONFIG_KEYS.join(" and/or ")} in .config.json to ` + "the fleet's own GitHub logins (run setup.sh to configure).");
  }
}
/** Guards {@link warnDuplicateRepos} to one notice per process. */ let warnedDuplicateRepos = false;
/** Re-arm the duplicate-repository notice. Test-only. */ export function _resetDuplicateRepoWarning() {
  warnedDuplicateRepos = false;
}
/**
 * Name every `repos` entry dropped as a case-variant (Issue #1546).
 *
 * A warning rather than a hard failure, so a host is not stood down over a
 * casing slip — but loud, because the operator's file has a defect worth
 * fixing: whatever is keyed by the configured spelling (watermarks, caches,
 * the write-repo allowlist) forks in two until it is.
 */ function warnDuplicateRepos(duplicates, repoConfigKeys) {
  if (duplicates.length === 0) return;
  // Once per process: `loadConfig` is re-entered by sub-commands, and the
  // same defect repeated on every read is noise an operator scrolls past.
  if (warnedDuplicateRepos) return;
  warnedDuplicateRepos = true;
  for (const warning of duplicateRepoSlugWarnings(duplicates, repoConfigKeys)){
    console.warn(`⚠️  ${warning}`);
  }
}
/** Guards {@link warnRemovedTrustKeys} to one notice per process. */ let warnedRemovedTrustKeys = false;
/** Re-arm the migration notice. Test-only. */ export function _resetRemovedTrustKeyWarning() {
  warnedRemovedTrustKeys = false;
}
/**
 * Name what a still-deployed `.config.json` carries that no longer does what
 * it used to (Issue #1066).
 *
 * `author_source` is *removed* and refused outright by `REMOVED_CONFIG_KEYS`,
 * the convention Issue #805 established: a setting that reads as live and
 * does nothing is the silent failure the config load exists to prevent, and
 * `./setup.sh` strips it automatically.
 *
 * `allowed_authors` is different — it survives with a narrower purpose, so
 * refusing it would strand every deployed host for no gain. It is warned
 * about instead, once per load, naming what it no longer does.
 */ function warnRemovedTrustKeys(file) {
  // Once per process: `loadConfig` is re-entered by sub-commands and by the
  // escape-hatch follow-up gate, and a migration notice repeated on every
  // read is noise an operator learns to scroll past.
  if (warnedRemovedTrustKeys) return;
  warnedRemovedTrustKeys = true;
  const configuredAuthors = file.allowed_authors ?? [];
  if (configuredAuthors.length > 0) {
    console.warn("⚠️  CHANGED: `allowed_authors` no longer grants the right to raise, " + "label or schedule work (Issue #1066); who may direct the worker is " + `derived from repository collaborators. Ignored for trust: ${configuredAuthors.join(", ")}. The first entry is still used as the default PR reviewer when ` + "`pr_reviewers` is unset — set `pr_reviewers` and remove this key.");
  }
}
/**
 * Check whether a username may direct work — axis 1 of the trust model.
 *
 * Case-insensitive, because GitHub logins are (Issue #1066): `allowedAuthors`
 * is the derived collaborator set, normalised to lower case, while a login
 * under test arrives in the account's own casing.
 *
 * @param config - Worker configuration
 * @param username - Username to check
 * @returns true if the username may raise, label and schedule work
 */ export function isAllowedAuthor(config, username) {
  const key = username.trim().toLowerCase();
  if (!key) return false;
  return config.allowedAuthors.some((a)=>a.trim().toLowerCase() === key);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb25maWcudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDb25maWd1cmF0aW9uIGxvYWRlciBmb3IgdGhlIFZpYmUgQ29kZXIgd29ya2VyLlxuICpcbiAqIElzc3VlICMyNjY6IEFsbCBjb25maWd1cmF0aW9uIGlzIG5vdyBsb2FkZWQgZnJvbSAuY29uZmlnLmpzb24gb25seS5cbiAqIElzc3VlICMyNzc6IE9wZXJhdGlvbmFsIHNldHRpbmdzICh0aW1lb3V0cywgaW50ZXJ2YWxzKSBhcmUgYWxzbyBsb2FkZWRcbiAqIGZyb20gLmNvbmZpZy5qc29uLiBPbmx5IG92ZXJyaWRlcyBhcmUgc3RvcmVkIOKAlCBkZWZhdWx0cyBmbG93IGZyb20gY29kZS5cbiAqXG4gKiBFbnZpcm9ubWVudCB2YXJpYWJsZSBvdmVycmlkZXMgYXJlIG5vIGxvbmdlciBzdXBwb3J0ZWQgYXQgcnVudGltZS5cbiAqIFVzZSBzZXR1cC5zaCB0byBjb25maWd1cmUgdmlhIC5jb25maWcuanNvbi5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0NMQVVERV9NQVhfVFVSTlMsXG4gIHZhbGlkYXRlQ2xhdWRlTWF4VHVybnMsXG59IGZyb20gXCIuL2NsYXVkZV90dXJuX2xpbWl0LnRzXCI7XG5pbXBvcnQgeyBwYXJzZUFsbG9jYXRpb25Qb2xpY3kgfSBmcm9tIFwiLi9zdWJzY3JpcHRpb25fYWxsb2NhdGlvbi50c1wiO1xuaW1wb3J0IHsgcGFyc2VDb21wbGV0aW9uUG9saWN5IH0gZnJvbSBcIi4vY29tcGxldGlvbl9hZG1pc3Npb24udHNcIjtcbmltcG9ydCB7IHJlZ2lzdGVyQWdlbnRQcmVGbGlnaHRDb25maWdzIH0gZnJvbSBcIi4vYWdlbnRfcHJlX2ZsaWdodC50c1wiO1xuaW1wb3J0IHR5cGUgeyBDb25maWdGaWxlLCBSZXBvQ29uZmlnLCBXb3JrZXJDb25maWcgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7IHR5cGUgRW52TG9va3VwLCBwcm9jZXNzRW52TG9va3VwIH0gZnJvbSBcIi4vZW52X2xvb2t1cC50c1wiO1xuaW1wb3J0IHsgbW9kZWxUaWVyT3ZlcnJpZGVzIH0gZnJvbSBcIi4vcGhhc2Vfcm91dGluZy50c1wiO1xuaW1wb3J0IHtcbiAgRVhDTFVTSU9OX1RFQU1fUEFUVEVSTixcbiAgdmFsaWRhdGVDb25maWdGaWxlSnNvbixcbn0gZnJvbSBcIi4vdmFsaWRhdGlvbi50c1wiO1xuaW1wb3J0IHtcbiAgcmVzb2x2ZUFnZW50UHJvdmlkZXJJZCxcbiAgcmVzb2x2ZUVuYWJsZWRBZ2VudFByb3ZpZGVySWRzLFxuICBzZXRDb25maWd1cmVkQWdlbnRQcm92aWRlcklkLFxuICBzZXRDb25maWd1cmVkRW5hYmxlZEFnZW50UHJvdmlkZXJJZHMsXG59IGZyb20gXCIuL2FnZW50X3Byb3ZpZGVyLnRzXCI7XG5pbXBvcnQgeyBpc0F1dG9tYXRpY1Byb3ZpZGVyUm91dGluZ0FjdGl2ZSB9IGZyb20gXCIuL3Byb3ZpZGVyX2F1dG9fc3RhdGUudHNcIjtcbmltcG9ydCB7XG4gIHJlc29sdmVQcm92aWRlckZhbGxiYWNrUG9saWN5LFxuICBzZXRDb25maWd1cmVkUHJvdmlkZXJGYWxsYmFja1BvbGljeSxcbn0gZnJvbSBcIi4vcHJvdmlkZXJfZmFsbGJhY2tfcG9saWN5LnRzXCI7XG5pbXBvcnQgeyBERUZBVUxUX0xPTkdfSk9CX0xBQkVMUyB9IGZyb20gXCIuL2NsYWltX3J1bndheV9ldmlkZW5jZS50c1wiO1xuaW1wb3J0IHsgREVGQVVMVF9SVU5fVEFSR0VUX1NFQ09ORFMgfSBmcm9tIFwiLi9ydW5fdGltZWxpbmUudHNcIjtcbmltcG9ydCB7IHJlc29sdmVSdW5Nb2RlIH0gZnJvbSBcIi4vcnVuX21vZGUudHNcIjtcbmltcG9ydCB7IHJlc29sdmVFZmZlY3RpdmVGbGVldFByQXV0aG9ycyB9IGZyb20gXCIuL2ZsZWV0X2F1dGhvcnMudHNcIjtcbmltcG9ydCB7IHBhcnNlUHJlRmxpZ2h0Q29tbWFuZHMgfSBmcm9tIFwiLi9yZXBvX2NvbmZpZy50c1wiO1xuaW1wb3J0IHsgcGFyc2VJZGxlVGFza0NhZGVuY2UgfSBmcm9tIFwiLi9pZGxlX3Rhc2tfY2FkZW5jZV9jb25maWcudHNcIjtcbmltcG9ydCB7XG4gIFRPT0xfQ0FMTF9ISVNUT1JZX01BWCxcbiAgVE9PTF9DQUxMX0hJU1RPUllfTVMsXG59IGZyb20gXCIuL2FnZW50X3Byb2dyZXNzLnRzXCI7XG5pbXBvcnQgeyBwYXJzZUNvbnRhaW5lclRvb2xzIH0gZnJvbSBcIi4vY29udGFpbmVyX3Rvb2xzX2NvbmZpZy50c1wiO1xuaW1wb3J0IHsgcGFyc2VDb250YWluZXJFeHRlbnNpb24gfSBmcm9tIFwiLi9jb250YWluZXJfZXh0ZW5zaW9uX2NvbmZpZy50c1wiO1xuaW1wb3J0IHsgcGFyc2VDb2RlZ3JhcGhDb250ZXh0IH0gZnJvbSBcIi4vY29kZWdyYXBoX2NvbnRleHRfY29uZmlnLnRzXCI7XG5pbXBvcnQgeyBwYXJzZVJ0a091dHB1dCB9IGZyb20gXCIuL3J0a19vdXRwdXRfY29uZmlnLnRzXCI7XG5pbXBvcnQgeyBhc3NlcnRDYWxsYmFja3NDb25maWcgfSBmcm9tIFwiLi9ydW5fY2FsbGJhY2tzX2NvbmZpZy50c1wiO1xuaW1wb3J0IHsgYXNzZXJ0R3JhZnRDb250ZXh0Q29uZmlnIH0gZnJvbSBcIi4vZ3JhZnRfY29udGV4dF9jb25maWcudHNcIjtcbmltcG9ydCB7IGFzc2VydEN1c3RvbUxhYmVsUHJvbXB0cyB9IGZyb20gXCIuL2N1c3RvbV9sYWJlbF9wcm9tcHRzX2NvbmZpZy50c1wiO1xuaW1wb3J0IHtcbiAgcGFyc2VPcmNoZXN0cmF0aW9uU2V0dGluZ3MsXG4gIHZhbGlkYXRlUm9sZVByb3ZpZGVycyxcbn0gZnJvbSBcIi4vb3JjaGVzdHJhdGlvbi9yb2xlX2NvbmZpZy50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZUhvc3RJc3N1ZVN1YkFnZW50VGllciB9IGZyb20gXCIuL2lzc3VlX3N1Yl9hZ2VudF90aWVyLnRzXCI7XG5pbXBvcnQge1xuICBDVVNUT01fUFJPTVBUX1BBVEhfTUFQX0VOVixcbiAgY3VzdG9tUHJvbXB0UGF0aFJlc29sdmVyLFxufSBmcm9tIFwiLi9jdXN0b21fcHJvbXB0X21vdW50cy50c1wiO1xuaW1wb3J0IHtcbiAgcGFyc2VDb3BpbG90Q29kZVJldmlldyxcbiAgdmFsaWRhdGVVcGRhdGVNb2RlU2V0dGluZ3MsXG59IGZyb20gXCIuL2NvbmZpZ192YWxpZGF0b3IudHNcIjtcbmltcG9ydCB7XG4gIGRldGVjdFVua25vd25Db25maWdLZXlzLFxuICBmb3JtYXRVbmtub3duS2V5V2FybmluZ3MsXG59IGZyb20gXCIuL2NvbmZpZ191bmtub3duX2tleXMudHNcIjtcbmltcG9ydCB7IHJlc29sdmVFZ3Jlc3NBbGxvd2xpc3QgfSBmcm9tIFwiLi9lZ3Jlc3NfYWxsb3dsaXN0LnRzXCI7XG5pbXBvcnQgeyByZWFkSW1nYmJBcGlLZXlGcm9tRW52IH0gZnJvbSBcIi4vaW1nYmJfdXBsb2FkLnRzXCI7XG5pbXBvcnQge1xuICBGTEVFVF9MT0dJTl9DT05GSUdfS0VZUyxcbiAgcmVzb2x2ZVZpYmVDb2RlckxvZ2lucyxcbn0gZnJvbSBcIi4vdHJ1c3RfZXhjbHVzaW9ucy50c1wiO1xuaW1wb3J0IHtcbiAgREVGQVVMVF9CRVNUX1BMQU5OSU5HX01PREVMLFxuICBERUZBVUxUX1NIVUZGTEVfUkVQT1MsXG4gIERFRkFVTFRfVFJVU1RFRF9JTlBVVF9CT1RTLFxuICBERUZBVUxUX1RSVVNURURfUkVWSUVXX0JPVFMsXG4gIERFRkFVTFRfVVBEQVRFX01PREUsXG4gIERFRkFVTFRfVkVSQk9TSVRZLFxuICBERUZBVUxUX1dPUktFUl9OQU1FLFxuICBkZWZhdWx0UXVvcnVtSnVkZ2UsXG4gIGRlZmF1bHRRdW9ydW1QbGFubmVycyxcbiAgTEFCRUxfREVGQVVMVFMsXG4gIE9QRVJBVElPTkFMX0RFRkFVTFRTLFxuICBQUk9WSURFUl9NT0RFTF9USUVSUyxcbn0gZnJvbSBcIi4vY29uZmlnX2RlZmF1bHRzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IFZlcmJvc2l0eUxldmVsIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IER1cGxpY2F0ZVJlcG9TbHVnIH0gZnJvbSBcIi4vcmVwb19zbHVnLnRzXCI7XG5pbXBvcnQge1xuICBkZWR1cGVSZXBvU2x1Z3MsXG4gIGR1cGxpY2F0ZVJlcG9TbHVnV2FybmluZ3MsXG4gIFJFUE9fU0xVR19QQVRURVJOLFxufSBmcm9tIFwiLi9yZXBvX3NsdWcudHNcIjtcblxuLyoqXG4gKiBQYXR0ZXJuIG1hdGNoaW5nIGEgdmFsaWQgR2l0SHViIGBvd25lci9yZXBvYCBzbHVnLlxuICpcbiAqIERlZmluZWQgb25jZSBpbiBgbGliL3JlcG9fc2x1Zy50c2AgYW5kIHJlLWV4cG9ydGVkIGhlcmUgc28gdGhlIGV4aXN0aW5nXG4gKiBpbXBvcnRlcnMgKGB2YWxpZGF0ZUNvbmZpZ2AsIHRoZSBhZGQtcmVwbyBmbG93IGluIGBhZGRfcmVwby50c2Ag4oCUXG4gKiBJc3N1ZSAjMjU3NSkgYXJlIHVuY2hhbmdlZCwgd2hpbGUgdGhlIHNldHVwIENMSSBjYW4gYXBwbHkgdGhlIHNhbWUgZ3VhcmRcbiAqIHdpdGhvdXQgcHVsbGluZyBpbiB0aGlzIG1vZHVsZSdzIHdob2xlIGdyYXBoIChJc3N1ZSAjMTI5MSkuXG4gKi9cbmV4cG9ydCB7IFJFUE9fU0xVR19QQVRURVJOIH0gZnJvbSBcIi4vcmVwb19zbHVnLnRzXCI7XG5cbi8qKlxuICogR2V0IGFuIGVudmlyb25tZW50IHZhcmlhYmxlIG9yIHJldHVybiBhIGRlZmF1bHQgdmFsdWUuXG4gKlxuICogQHBhcmFtIG5hbWUgLSBFbnZpcm9ubWVudCB2YXJpYWJsZSBuYW1lXG4gKiBAcGFyYW0gZGVmYXVsdFZhbHVlIC0gRGVmYXVsdCB2YWx1ZSBpZiBlbnYgdmFyIGlzIG5vdCBzZXRcbiAqIEBwYXJhbSBlbnYgLSBFbnZpcm9ubWVudCBsb29rdXAgKElzc3VlICM5NTYpLiBEZWZhdWx0cyB0byB0aGUgcHJvY2Vzc1xuICogICBlbnZpcm9ubWVudCwgc28gZXZlcnkgZXhpc3RpbmcgY2FsbGVyIGlzIHVuY2hhbmdlZDsgYSB0ZXN0IGluamVjdHMgYVxuICogICBmaXhlZCBtYXAgaW5zdGVhZCBvZiBtdXRhdGluZyBgRGVuby5lbnZgLCB3aGljaCByYWNlcyB1bmRlclxuICogICBgZGVubyB0ZXN0IC0tcGFyYWxsZWxgLlxuICogQHJldHVybnMgVGhlIGVudmlyb25tZW50IHZhcmlhYmxlIHZhbHVlIG9yIGRlZmF1bHRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEVudk9yRGVmYXVsdChcbiAgbmFtZTogc3RyaW5nLFxuICBkZWZhdWx0VmFsdWU6IHN0cmluZyxcbiAgZW52OiBFbnZMb29rdXAgPSBwcm9jZXNzRW52TG9va3VwLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGVudihuYW1lKSA/PyBkZWZhdWx0VmFsdWU7XG59XG5cbi8qKlxuICogR2V0IGFuIGVudmlyb25tZW50IHZhcmlhYmxlIGFzIGEgbnVtYmVyIG9yIHJldHVybiBhIGRlZmF1bHQgdmFsdWUuXG4gKlxuICogQHBhcmFtIG5hbWUgLSBFbnZpcm9ubWVudCB2YXJpYWJsZSBuYW1lXG4gKiBAcGFyYW0gZGVmYXVsdFZhbHVlIC0gRGVmYXVsdCB2YWx1ZSBpZiBlbnYgdmFyIGlzIG5vdCBzZXRcbiAqIEBwYXJhbSBlbnYgLSBFbnZpcm9ubWVudCBsb29rdXAgKElzc3VlICM5NTYpOyBkZWZhdWx0cyB0byB0aGUgcHJvY2Vzc1xuICogICBlbnZpcm9ubWVudC5cbiAqIEByZXR1cm5zIFRoZSBlbnZpcm9ubWVudCB2YXJpYWJsZSB2YWx1ZSBhcyBudW1iZXIgb3IgZGVmYXVsdFxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0RW52TnVtYmVyT3JEZWZhdWx0KFxuICBuYW1lOiBzdHJpbmcsXG4gIGRlZmF1bHRWYWx1ZTogbnVtYmVyLFxuICBlbnY6IEVudkxvb2t1cCA9IHByb2Nlc3NFbnZMb29rdXAsXG4pOiBudW1iZXIge1xuICBjb25zdCB2YWx1ZSA9IGVudihuYW1lKTtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gZGVmYXVsdFZhbHVlO1xuICB9XG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlSW50KHZhbHVlLCAxMCk7XG4gIHJldHVybiBpc05hTihwYXJzZWQpID8gZGVmYXVsdFZhbHVlIDogcGFyc2VkO1xufVxuXG4vKipcbiAqIFJlYWQgYSBub24tbmVnYXRpdmUgbnVtYmVyIGZyb20gdGhlIGVudmlyb25tZW50LCBvciBgdW5kZWZpbmVkYCB3aGVuIHRoZVxuICogdmFyaWFibGUgaXMgdW5zZXQsIGVtcHR5LCBvciBub3QgYSBmaW5pdGUgbm9uLW5lZ2F0aXZlIG51bWJlciAoSXNzdWUgIzI4OSkuXG4gKlxuICogRGlzdGluY3QgZnJvbSB7QGxpbmsgZ2V0RW52TnVtYmVyT3JEZWZhdWx0fTogdGhlIGNhbGxlciBuZWVkcyB0byB0ZWxsIFwidGhlXG4gKiBvcGVyYXRvciBzZXQgbm90aGluZ1wiIGZyb20gXCJ0aGUgb3BlcmF0b3Igc2V0IGEgdmFsdWVcIiwgc28gdGhhdCBhXG4gKiBgLmNvbmZpZy5qc29uYCBrZXkgY2FuIHRha2UgcHJlY2VkZW5jZSBvdmVyIHRoZSBlbnZpcm9ubWVudCB3aXRob3V0IGFcbiAqIHNlbnRpbmVsIGRlZmF1bHQgc3RhbmRpbmcgaW4gZm9yIGFuIGFic2VudCB2YXJpYWJsZS5cbiAqXG4gKiBAcGFyYW0gbmFtZSAtIEVudmlyb25tZW50IHZhcmlhYmxlIG5hbWVcbiAqIEBwYXJhbSBlbnYgLSBFbnZpcm9ubWVudCBsb29rdXAgKElzc3VlICM5NTYpOyBkZWZhdWx0cyB0byB0aGUgcHJvY2Vzc1xuICogICBlbnZpcm9ubWVudC5cbiAqIEByZXR1cm5zIFRoZSBwYXJzZWQgdmFsdWUsIG9yIGB1bmRlZmluZWRgIHdoZW4gdGhlcmUgaXMgbm8gdXNhYmxlIG9uZVxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZE5vbk5lZ2F0aXZlTnVtYmVyRW52KFxuICBuYW1lOiBzdHJpbmcsXG4gIGVudjogRW52TG9va3VwID0gcHJvY2Vzc0Vudkxvb2t1cCxcbik6IG51bWJlciB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHJhdyA9IGVudihuYW1lKTtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkIHx8IHJhdy50cmltKCkgPT09IFwiXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHBhcnNlZCA9IE51bWJlcihyYXcpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHBhcnNlZCkgJiYgcGFyc2VkID49IDAgPyBwYXJzZWQgOiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogR2V0IGFuIGVudmlyb25tZW50IHZhcmlhYmxlIGFzIGEgY29tbWEtc2VwYXJhdGVkIGFycmF5IG9yIHJldHVybiBhIGRlZmF1bHQgdmFsdWUuXG4gKlxuICogQHBhcmFtIG5hbWUgLSBFbnZpcm9ubWVudCB2YXJpYWJsZSBuYW1lXG4gKiBAcGFyYW0gZGVmYXVsdFZhbHVlIC0gRGVmYXVsdCB2YWx1ZSBpZiBlbnYgdmFyIGlzIG5vdCBzZXRcbiAqIEBwYXJhbSBlbnYgLSBFbnZpcm9ubWVudCBsb29rdXAgKElzc3VlICM5NTYpOyBkZWZhdWx0cyB0byB0aGUgcHJvY2Vzc1xuICogICBlbnZpcm9ubWVudC5cbiAqIEByZXR1cm5zIFRoZSBlbnZpcm9ubWVudCB2YXJpYWJsZSB2YWx1ZSBhcyBhcnJheSBvciBkZWZhdWx0XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRFbnZBcnJheU9yRGVmYXVsdChcbiAgbmFtZTogc3RyaW5nLFxuICBkZWZhdWx0VmFsdWU6IHN0cmluZ1tdLFxuICBlbnY6IEVudkxvb2t1cCA9IHByb2Nlc3NFbnZMb29rdXAsXG4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHZhbHVlID0gZW52KG5hbWUpO1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gXCJcIikge1xuICAgIHJldHVybiBkZWZhdWx0VmFsdWU7XG4gIH1cbiAgcmV0dXJuIHZhbHVlLnNwbGl0KFwiLFwiKS5tYXAoKHMpID0+IHMudHJpbSgpKS5maWx0ZXIoKHMpID0+IHMgIT09IFwiXCIpO1xufVxuXG4vKipcbiAqIExvYWQgY29uZmlndXJhdGlvbiBmcm9tIGEgSlNPTiBmaWxlLlxuICpcbiAqIEBwYXJhbSBjb25maWdQYXRoIC0gUGF0aCB0byB0aGUgLmNvbmZpZy5qc29uIGZpbGVcbiAqIEByZXR1cm5zIFBhcnNlZCBjb25maWcgZmlsZSBvciBlbXB0eSBvYmplY3QgaWYgZmlsZSBkb2Vzbid0IGV4aXN0XG4gKi9cbi8qKlxuICogTWFwIG9mIHNuYWtlX2Nhc2UgSlNPTiBrZXlzIHRvIGNhbWVsQ2FzZSBSZXBvQ29uZmlnIGZpZWxkIG5hbWVzLlxuICpcbiAqIFRoZSBgLmNvbmZpZy5qc29uYCBkb2N1bWVudGF0aW9uIHVzZXMgc25ha2VfY2FzZSBmb3IgcmVwb19jb25maWcgZmllbGRzXG4gKiAoZS5nLiwgYHNraXBfc2NyZWVuc2hvdF9jaGVja2ApLCBidXQgdGhlIFR5cGVTY3JpcHQgYFJlcG9Db25maWdgIGludGVyZmFjZVxuICogdXNlcyBjYW1lbENhc2UgKGUuZy4sIGBza2lwU2NyZWVuc2hvdENoZWNrYCkuIFRoaXMgbWFwIG5vcm1hbGlzZXMgdGhlXG4gKiBKU09OLXBhcnNlZCBrZXlzIHNvIGJvdGggZm9ybWF0cyBhcmUgYWNjZXB0ZWQgKElzc3VlICMxMjk2KS5cbiAqL1xuY29uc3QgUkVQT19DT05GSUdfS0VZX01BUDogUmVjb3JkPHN0cmluZywga2V5b2YgUmVwb0NvbmZpZz4gPSB7XG4gIHByZV9zZXR1cF9jb21tYW5kOiBcInByZVNldHVwQ29tbWFuZFwiLFxuICBza2lwX3F1YWxpdHlfY2hlY2s6IFwic2tpcFF1YWxpdHlDaGVja1wiLFxuICBxdWFsaXR5X2NvbW1hbmQ6IFwicXVhbGl0eUNvbW1hbmRcIixcbiAgY3VzdG9tX2luc3RydWN0aW9uczogXCJjdXN0b21JbnN0cnVjdGlvbnNcIixcbiAgc2tpcF9hdXRvX21lcmdlOiBcInNraXBBdXRvTWVyZ2VcIixcbiAgc2tpcF9yZXZpZXdlcl9yZXF1ZXN0OiBcInNraXBSZXZpZXdlclJlcXVlc3RcIixcbiAgc2tpcF9zY3JlZW5zaG90X2NoZWNrOiBcInNraXBTY3JlZW5zaG90Q2hlY2tcIixcbiAgc2tpcF9zZWN1cml0eV9maXhfY2hlY2s6IFwic2tpcFNlY3VyaXR5Rml4Q2hlY2tcIixcbiAgLy8gRGlmZi1zY29wZWQgbXV0YXRpb24gZ2F0ZSAoSXNzdWUgIzMzOTMpLlxuICBza2lwX211dGF0aW9uX2NoZWNrOiBcInNraXBNdXRhdGlvbkNoZWNrXCIsXG4gIG11dGF0aW9uX2NoZWNrX2J1ZGdldF9zZWNvbmRzOiBcIm11dGF0aW9uQ2hlY2tCdWRnZXRTZWNvbmRzXCIsXG4gIC8vIENvdmVyYWdlIGNhcnJ5LW92ZXIgZ2F0ZSAoSXNzdWUgIzM3OTUpLlxuICBza2lwX2NvdmVyYWdlX2NhcnJ5b3Zlcl9jaGVjazogXCJza2lwQ292ZXJhZ2VDYXJyeU92ZXJDaGVja1wiLFxuICAvLyBDcmVkZW50aWFscyB0aGlzIHJlcG9zaXRvcnkncyBjaGVja3MgbmVlZCAoSXNzdWVzICM1NzMsICM1NzQpLlxuICBxdWFsaXR5X2NyZWRlbnRpYWxzOiBcInF1YWxpdHlDcmVkZW50aWFsc1wiLFxuICBkb2NrZXJfaW1hZ2U6IFwiZG9ja2VySW1hZ2VcIixcbiAgcXVhbGl0eV9jaGVja190aW1lb3V0OiBcInF1YWxpdHlDaGVja1RpbWVvdXRcIixcbiAgLy8gUGVyLXJlcG8gbmljZSB2YWx1ZSDigJQgbG93ZXIgPSBzb29uZXIgKElzc3VlICMyNzcyKS4gS2V5IGlzIGlkZW50aWNhbFxuICAvLyBpbiBzbmFrZV9jYXNlIGFuZCBjYW1lbENhc2U7IG1hcHBlZCBleHBsaWNpdGx5IGZvciBkb2N1bWVudGF0aW9uIHBhcml0eS5cbiAgbmljZTogXCJuaWNlXCIsXG4gIC8vIFBlci1yZXBvIG1vZGVsL2VmZm9ydCByb3V0aW5nIChJc3N1ZSAjMjYyNSkuXG4gIGNsYXVkZV9tb2RlbDogXCJjbGF1ZGVNb2RlbFwiLFxuICAvLyBQZXItcmVwbyBiZXN0IHBsYW5uaW5nIG1vZGVsIGZvciBkZWdyYWRlZC1tb2RlbCBkZXRlY3Rpb24gKElzc3VlICMyNjU0KS5cbiAgYmVzdF9wbGFubmluZ19tb2RlbDogXCJiZXN0UGxhbm5pbmdNb2RlbFwiLFxuICBwaGFzZV9tb2RlbF9vdmVycmlkZXM6IFwicGhhc2VNb2RlbE92ZXJyaWRlc1wiLFxuICBwaGFzZV9lZmZvcnRfb3ZlcnJpZGVzOiBcInBoYXNlRWZmb3J0T3ZlcnJpZGVzXCIsXG4gIC8vIFBlci1yZXBvIGlzc3VlLWV4ZWN1dG9yIHNwbGl0IG92ZXJyaWRlIChJc3N1ZSAjMjM0MSkuXG4gIGlzc3VlX2V4ZWN1dG9yX3NwbGl0OiBcImlzc3VlRXhlY3V0b3JTcGxpdFwiLFxuICAvLyBQZXItcmVwbyBpc3N1ZSBzdWItYWdlbnQgdGllciBvdmVycmlkZSAoSXNzdWUgIzM0MDEpLlxuICBpc3N1ZV9zdWJfYWdlbnRfdGllcjogXCJpc3N1ZVN1YkFnZW50VGllclwiLFxuICAvLyBQZXItcmVwbyBDb2RleCBtb2RlbC9lZmZvcnQgcm91dGluZyAoSXNzdWUgIzM2MykuXG4gIGNvZGV4X21vZGVsOiBcImNvZGV4TW9kZWxcIixcbiAgY29kZXhfcGhhc2VfbW9kZWxfb3ZlcnJpZGVzOiBcImNvZGV4UGhhc2VNb2RlbE92ZXJyaWRlc1wiLFxuICBjb2RleF9waGFzZV9lZmZvcnRfb3ZlcnJpZGVzOiBcImNvZGV4UGhhc2VFZmZvcnRPdmVycmlkZXNcIixcbiAgLy8gUGVyLXJlcG8gR2VtaW5pIG1vZGVsIHJvdXRpbmcgKElzc3VlICMzNjQpLiBNb2RlbCBvbmx5IOKAlCB0aGUgR2VtaW5pIENMSVxuICAvLyBoYXMgbm8gcmVhc29uaW5nLWVmZm9ydCBvcHRpb24gdG8gb3ZlcnJpZGUuXG4gIGdlbWluaV9tb2RlbDogXCJnZW1pbmlNb2RlbFwiLFxuICBnZW1pbmlfcGhhc2VfbW9kZWxfb3ZlcnJpZGVzOiBcImdlbWluaVBoYXNlTW9kZWxPdmVycmlkZXNcIixcbiAgLy8gUGVyLXJlcG8gRGVlcFNlZWsgbW9kZWwgcm91dGluZyAoSXNzdWUgIzQxMykuIE1vZGVsIG9ubHkg4oCUIERlZXBTZWVrJ3NcbiAgLy8gQW50aHJvcGljLWNvbXBhdGlibGUgZW5kcG9pbnQgaGFzIG5vIGVmZm9ydCBjb250cm9sIHRvIG92ZXJyaWRlLlxuICBkZWVwc2Vla19tb2RlbDogXCJkZWVwc2Vla01vZGVsXCIsXG4gIGRlZXBzZWVrX3BoYXNlX21vZGVsX292ZXJyaWRlczogXCJkZWVwc2Vla1BoYXNlTW9kZWxPdmVycmlkZXNcIixcbiAgLy8gUGVyLXJlcG8gY29kaW5nLWFnZW50IHByb3ZpZGVyIHBpbiAoSXNzdWUgIzIwNDgpLlxuICBhZ2VudF9wcm92aWRlcjogXCJhZ2VudFByb3ZpZGVyXCIsXG4gIGV4dGVybmFsX29yY2hlc3RyYXRpb246IFwiZXh0ZXJuYWxPcmNoZXN0cmF0aW9uXCIsXG4gIGV4dGVybmFsX29yY2hlc3RyYXRpb25fc2V0dGluZ3M6IFwiZXh0ZXJuYWxPcmNoZXN0cmF0aW9uU2V0dGluZ3NcIixcbiAgLy8gUHJlLWZsaWdodCBlbmZvcmNlbWVudCBnYXRlIChJc3N1ZSAjMzU3NykuIEFjY2VwdCB0aGUga2ViYWItY2FzZSBmb3JtXG4gIC8vIHNob3duIGluIHRoZSBpc3N1ZS9kb2NzIGV4YW1wbGUgKGBcInByZS1mbGlnaHRcImApIGFuZCB0aGUgc25ha2VfY2FzZSBmb3JtXG4gIC8vIChgcHJlX2ZsaWdodGApOyBjYW1lbENhc2UgKGBwcmVGbGlnaHRgKSBwYXNzZXMgdGhyb3VnaCB1bmNoYW5nZWQuXG4gIFwicHJlLWZsaWdodFwiOiBcInByZUZsaWdodFwiLFxuICBwcmVfZmxpZ2h0OiBcInByZUZsaWdodFwiLFxuICAvLyBJc3N1ZS1tb2RlIENJLWZhaWx1cmUgbG9nIGF1dG8tZmV0Y2ggKElzc3VlICMzNTgxKS5cbiAgY2lfZmFpbHVyZV9sYWJlbHM6IFwiY2lGYWlsdXJlTGFiZWxzXCIsXG4gIGNpX2ZhaWx1cmVfam9iX3BhdGg6IFwiY2lGYWlsdXJlSm9iUGF0aFwiLFxuICAvLyBQZXItcmVwbyBhdXRvLWZpeCBhdHRlbXB0IGNhcCAoSXNzdWUgIzM1ODIpLlxuICBtYXhfYXV0b19maXhfYXR0ZW1wdHM6IFwibWF4QXV0b0ZpeEF0dGVtcHRzXCIsXG4gIC8vIFBlci1yZXBvIGJsb2NraW5nLVBSIHN0YWxsIHRocmVzaG9sZCAoSXNzdWUgIzQwMjUpLlxuICBibG9ja2luZ19wcl9zdGFsbF90aHJlc2hvbGRfc2Vjb25kczogXCJibG9ja2luZ1ByU3RhbGxUaHJlc2hvbGRTZWNvbmRzXCIsXG4gIC8vIFBlci1yZXBvIGZsZWV0IFBSIGNhcCBvbiB0aGUgZGVmYXVsdC1icmFuY2ggc3RyZWFtIChJc3N1ZSAjMjY2MykuXG4gIGZsZWV0X3ByX3Nsb3RzOiBcImZsZWV0UHJTbG90c1wiLFxuICBjb21wbGV0aW9uX2FkbWlzc2lvbjogXCJjb21wbGV0aW9uQWRtaXNzaW9uXCIsXG59O1xuXG4vKipcbiAqIE5vcm1hbGlzZSBhIHNpbmdsZSBSZXBvQ29uZmlnIG9iamVjdCBmcm9tIHNuYWtlX2Nhc2UgdG8gY2FtZWxDYXNlIGtleXMuXG4gKlxuICogQWNjZXB0cyBib3RoIHNuYWtlX2Nhc2UgYW5kIGNhbWVsQ2FzZSDigJQgc25ha2VfY2FzZSBrZXlzIGFyZSBjb252ZXJ0ZWQsXG4gKiBjYW1lbENhc2Uga2V5cyBhcmUga2VwdCBhcy1pcy4gVW5rbm93biBrZXlzIGFyZSBkcm9wcGVkLlxuICovXG5mdW5jdGlvbiBub3JtYWxpc2VSZXBvQ29uZmlnKHJhdzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBSZXBvQ29uZmlnIHtcbiAgY29uc3Qgbm9ybWFsaXNlZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcblxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhyYXcpKSB7XG4gICAgY29uc3QgbWFwcGVkS2V5ID0gUkVQT19DT05GSUdfS0VZX01BUFtrZXldO1xuICAgIGlmIChtYXBwZWRLZXkpIHtcbiAgICAgIC8vIFNuYWtlX2Nhc2Uga2V5IOKAlCBtYXAgdG8gY2FtZWxDYXNlXG4gICAgICBub3JtYWxpc2VkW21hcHBlZEtleV0gPSB2YWx1ZTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gQWxyZWFkeSBjYW1lbENhc2Ugb3IgdW5rbm93biDigJQga2VlcCBhcy1pc1xuICAgICAgbm9ybWFsaXNlZFtrZXldID0gdmFsdWU7XG4gICAgfVxuICB9XG5cbiAgaWYgKFxuICAgIG5vcm1hbGlzZWQuZXh0ZXJuYWxPcmNoZXN0cmF0aW9uICE9PSB1bmRlZmluZWQgJiZcbiAgICB0eXBlb2Ygbm9ybWFsaXNlZC5leHRlcm5hbE9yY2hlc3RyYXRpb24gIT09IFwiYm9vbGVhblwiXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcInJlcG8gZXh0ZXJuYWxfb3JjaGVzdHJhdGlvbiBtdXN0IGJlIGJvb2xlYW5cIik7XG4gIH1cbiAgaWYgKG5vcm1hbGlzZWQuZXh0ZXJuYWxPcmNoZXN0cmF0aW9uU2V0dGluZ3MgIT09IHVuZGVmaW5lZCkge1xuICAgIG5vcm1hbGlzZWQuZXh0ZXJuYWxPcmNoZXN0cmF0aW9uU2V0dGluZ3MgPSBwYXJzZU9yY2hlc3RyYXRpb25TZXR0aW5ncyhcbiAgICAgIG5vcm1hbGlzZWQuZXh0ZXJuYWxPcmNoZXN0cmF0aW9uU2V0dGluZ3MsXG4gICAgKTtcbiAgfVxuICBpZiAobm9ybWFsaXNlZC5jb21wbGV0aW9uQWRtaXNzaW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICBub3JtYWxpc2VkLmNvbXBsZXRpb25BZG1pc3Npb24gPSBwYXJzZUNvbXBsZXRpb25Qb2xpY3koXG4gICAgICBub3JtYWxpc2VkLmNvbXBsZXRpb25BZG1pc3Npb24sXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXNlZCBhcyBSZXBvQ29uZmlnO1xufVxuXG4vKipcbiAqIE5vcm1hbGlzZSBhbGwgcmVwbyBjb25maWdzIGluIGEgcmVwb19jb25maWcgbWFwLlxuICpcbiAqIEVhY2ggcmVwbydzIGNvbmZpZyBvYmplY3QgZ2V0cyBpdHMgc25ha2VfY2FzZSBrZXlzIGNvbnZlcnRlZCB0byBjYW1lbENhc2VcbiAqIHNvIHRoYXQgYGdldFJlcG9Db25maWcoKWAgY2FuIGZpbmQgdGhlbSBieSB0aGVpciBUeXBlU2NyaXB0IGZpZWxkIG5hbWVzLlxuICovXG5mdW5jdGlvbiBub3JtYWxpc2VSZXBvQ29uZmlncyhcbiAgcmF3OiBSZWNvcmQ8c3RyaW5nLCBSZXBvQ29uZmlnPiB8IHVuZGVmaW5lZCxcbik6IFJlY29yZDxzdHJpbmcsIFJlcG9Db25maWc+IHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFyYXcpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCBSZXBvQ29uZmlnPiA9IHt9O1xuICBmb3IgKGNvbnN0IFtyZXBvLCBjb25maWddIG9mIE9iamVjdC5lbnRyaWVzKHJhdykpIHtcbiAgICByZXN1bHRbcmVwb10gPSBub3JtYWxpc2VSZXBvQ29uZmlnKFxuICAgICAgY29uZmlnIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgKTtcbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKipcbiAqIFJlYWQsIHZhbGlkYXRlIGFuZCByZXR1cm4gdGhlIHJhdyBgLmNvbmZpZy5qc29uYC5cbiAqXG4gKiBAcGFyYW0gY29uZmlnUGF0aCAtIFBhdGggdG8gdGhlIGNvbmZpZyBmaWxlXG4gKiBAcGFyYW0gZW52IC0gRW52aXJvbm1lbnQgbG9va3VwIHRoZSB2YWxpZGF0b3JzIHJlYWQgdGhyb3VnaCAoSXNzdWUgIzk1Nik7XG4gKiAgIHRoZSBgY29udGFpbmVyX2V4dGVuc2lvbmAgY29udGFpbm1lbnQgcnVsZSBuZWVkcyB0aGUgaG9zdCBob21lIGRpcmVjdG9yeS5cbiAqIEByZXR1cm5zIFRoZSB2YWxpZGF0ZWQgY29uZmlnIGZpbGUgY29udGVudHMgKGVtcHR5IHdoZW4gdGhlIGZpbGUgaXMgYWJzZW50KVxuICovXG5hc3luYyBmdW5jdGlvbiBsb2FkQ29uZmlnRmlsZShcbiAgY29uZmlnUGF0aDogc3RyaW5nLFxuICBlbnY6IEVudkxvb2t1cCA9IHByb2Nlc3NFbnZMb29rdXAsXG4pOiBQcm9taXNlPENvbmZpZ0ZpbGU+IHtcbiAgbGV0IGNvbnRlbnQ6IHN0cmluZztcbiAgdHJ5IHtcbiAgICBjb250ZW50ID0gYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUoY29uZmlnUGF0aCk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIEZpbGUgZG9lc24ndCBleGlzdCAtIHJldHVybiBlbXB0eSBjb25maWdcbiAgICByZXR1cm4ge307XG4gIH1cblxuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2UoY29udGVudCk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDb25maWcgZmlsZSAke2NvbmZpZ1BhdGh9IGNvbnRhaW5zIGludmFsaWQgSlNPTmAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHZhbGlkYXRlZCA9IHZhbGlkYXRlQ29uZmlnRmlsZUpzb24ocGFyc2VkKTtcbiAgaWYgKCF2YWxpZGF0ZWQub2spIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQ29uZmlnIGZpbGUgJHtjb25maWdQYXRofSBoYXMgaW52YWxpZCBzdHJ1Y3R1cmU6ICR7dmFsaWRhdGVkLmVycm9yLmZpZWxkfSAtICR7dmFsaWRhdGVkLmVycm9yLm1lc3NhZ2V9YCxcbiAgICApO1xuICB9XG5cbiAgLy8gSXNzdWUgIzEzMzQ6IERldGVjdCB1bmtub3duIGtleXMgYW5kIHdhcm4gYWJvdXQgdHlwb3MgLyBjYW1lbENhc2UgbWlzdGFrZXNcbiAgaWYgKHR5cGVvZiBwYXJzZWQgPT09IFwib2JqZWN0XCIgJiYgcGFyc2VkICE9PSBudWxsICYmICFBcnJheS5pc0FycmF5KHBhcnNlZCkpIHtcbiAgICBjb25zdCB3YXJuaW5ncyA9IGRldGVjdFVua25vd25Db25maWdLZXlzKFxuICAgICAgcGFyc2VkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICk7XG4gICAgaWYgKHdhcm5pbmdzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IGZvcm1hdHRlZCA9IGZvcm1hdFVua25vd25LZXlXYXJuaW5ncyh3YXJuaW5ncyk7XG4gICAgICBjb25zb2xlLmVycm9yKGZvcm1hdHRlZCk7XG4gICAgfVxuICB9XG5cbiAgLy8gSXNzdWUgIzY5IChwYXJlbnQgIzUpOiBkZXBsb3llci1zdXBwbGllZCBjb250YWluZXIgdG9vbCBzcGVjcyBhcmUgdGhlXG4gIC8vIHRydXN0IGJvdW5kYXJ5IGZvciBhbiB1bnZlcmlmaWVkIGRvd25sb2FkIOKAlCBhIG1hbGZvcm1lZCBzcGVjIGZhaWxzIHRoZVxuICAvLyBjb25maWcgbG9hZCBsb3VkbHkgcmF0aGVyIHRoYW4gcmVhY2hpbmcgdGhlIGltYWdlIGJ1aWxkLlxuICBjb25zdCB0b29scyA9IHBhcnNlQ29udGFpbmVyVG9vbHMoXG4gICAgKHZhbGlkYXRlZC52YWx1ZSBhcyBDb25maWdGaWxlKS5jb250YWluZXJfdG9vbHMsXG4gICk7XG4gIGlmICghdG9vbHMub2spIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYENvbmZpZyBmaWxlICR7Y29uZmlnUGF0aH0gaXMgaW52YWxpZDogJHt0b29scy5lcnJvcn1gKTtcbiAgfVxuXG4gIC8vIElzc3VlICM5NzggKHBhcmVudCAjOTMzKTogdGhlIHByaXZhdGUgZW52aXJvbm1lbnQgZXh0ZW5zaW9uIGlzIHRoZSB0cnVzdFxuICAvLyBib3VuZGFyeSBmb3Igd2hhdCB0aGUgb3BlcmF0b3IncyBvd24gbGF5ZXIgYnVpbGRzIGFuZCBydW5zIOKAlCBhIG1hbGZvcm1lZFxuICAvLyBkZWNsYXJhdGlvbiBmYWlscyB0aGUgY29uZmlnIGxvYWQgbG91ZGx5LCBuYW1pbmcgdGhlIGZpZWxkLCByYXRoZXIgdGhhblxuICAvLyByZWFjaGluZyB0aGUgYnVpbGQuIEFuIGFic2VudCBrZXkgZGVjbGFyZXMgbm8gZXh0ZW5zaW9uIGFuZCBjaGFuZ2VzXG4gIC8vIG5vdGhpbmcuXG4gIGNvbnN0IGV4dGVuc2lvbiA9IHBhcnNlQ29udGFpbmVyRXh0ZW5zaW9uKFxuICAgICh2YWxpZGF0ZWQudmFsdWUgYXMgQ29uZmlnRmlsZSkuY29udGFpbmVyX2V4dGVuc2lvbixcbiAgICB7IGVudiB9LFxuICApO1xuICBpZiAoIWV4dGVuc2lvbi5vaykge1xuICAgIHRocm93IG5ldyBFcnJvcihgQ29uZmlnIGZpbGUgJHtjb25maWdQYXRofSBpcyBpbnZhbGlkOiAke2V4dGVuc2lvbi5lcnJvcn1gKTtcbiAgfVxuXG4gIC8vIElzc3VlICM2MjIgKHBhcnQgb2YgIzU4Myk6IHRoZSBwaW5uZWQgcmVmIGFuZCB0b29sIHZlcnNpb25zIGFyZSBtZWFudCB0b1xuICAvLyBiZSBoYW5kLWVkaXRlZCB3aXRob3V0IHJlLXJ1bm5pbmcgc2V0dXAsIHNvIGEgYmFkIGVkaXQgZmFpbHMgaGVyZSDigJRcbiAgLy8gbmFtaW5nIHRoZSBvZmZlbmRpbmcgZmllbGQg4oCUIHJhdGhlciB0aGFuIGNoZWNraW5nIG91dCB0aGUgd3JvbmcgdGhpbmcgb3JcbiAgLy8gaW5zdGFsbGluZyBhIHZlcnNpb24gbm9ib2R5IGFza2VkIGZvci5cbiAgY29uc3QgZmlsZSA9IHZhbGlkYXRlZC52YWx1ZSBhcyBDb25maWdGaWxlO1xuICBjb25zdCB1cGRhdGVNb2RlRXJyb3JzID0gdmFsaWRhdGVVcGRhdGVNb2RlU2V0dGluZ3Moe1xuICAgIHVwZGF0ZU1vZGU6IGZpbGUudXBkYXRlX21vZGUsXG4gICAgcGlubmVkUmVmOiBmaWxlLnBpbm5lZF9yZWYsXG4gICAgcGlubmVkVG9vbFZlcnNpb25zOiBmaWxlLnBpbm5lZF90b29sX3ZlcnNpb25zLFxuICB9KTtcbiAgaWYgKHVwZGF0ZU1vZGVFcnJvcnMubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDb25maWcgZmlsZSAke2NvbmZpZ1BhdGh9IGlzIGludmFsaWQ6ICR7dXBkYXRlTW9kZUVycm9ycy5qb2luKFwiIFwiKX1gLFxuICAgICk7XG4gIH1cblxuICAvLyBJc3N1ZSAjMjcwMTogb25seSBzZXR1cCBhY3RzIG9uIGl0LCBidXQgYSBoYW5kLWVkaXRlZCB0eXBvIGZhaWxzIGhlcmUsXG4gIC8vIG5hbWluZyB0aGUgZmllbGQsIHJhdGhlciB0aGFuIHJlYWRpbmcgYXMgXCJsZWF2ZVwiIGFuZCBiaWxsaW5nIG9uLlxuICBjb25zdCBjb3BpbG90Q29kZVJldmlldyA9IHBhcnNlQ29waWxvdENvZGVSZXZpZXcoZmlsZS5jb3BpbG90X2NvZGVfcmV2aWV3KTtcbiAgaWYgKCFjb3BpbG90Q29kZVJldmlldy5vaykge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDb25maWcgZmlsZSAke2NvbmZpZ1BhdGh9IGlzIGludmFsaWQ6ICR7Y29waWxvdENvZGVSZXZpZXcuZXJyb3J9YCxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIGZpbGU7XG59XG5cbi8qKlxuICogT3B0aW9ucyBmb3IgbG9hZENvbmZpZyBiZWhhdmlvdXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTG9hZENvbmZpZ09wdGlvbnMge1xuICAvKiogV2hlbiB0cnVlLCB2YWxpZGF0ZXMgcmVxdWlyZWQgZmllbGRzIGF0IGxvYWQgdGltZSAoSXNzdWUgIzYzMCkgKi9cbiAgdmFsaWRhdGU/OiBib29sZWFuO1xuICAvKipcbiAgICogRW52aXJvbm1lbnQgbG9va3VwIGZvciB0aGUgaGFuZGZ1bCBvZiB2YXJpYWJsZXMgdGhhdCBzdGlsbCBvdmVycmlkZSB0aGVcbiAgICogZmlsZSAoSXNzdWUgIzk1NikuIERlZmF1bHRzIHRvIHRoZSBwcm9jZXNzIGVudmlyb25tZW50LCBzbyBwcm9kdWN0aW9uXG4gICAqIGJlaGF2aW91ciBpcyB1bmNoYW5nZWQ7IGEgdGVzdCBpbmplY3RzIGEgZml4ZWQgbWFwIGFuZCBuZWVkcyBub1xuICAgKiBgRGVuby5lbnYuc2V0YC5cbiAgICovXG4gIGVudj86IEVudkxvb2t1cDtcbn1cblxuLyoqXG4gKiBMb2FkIHdvcmtlciBjb25maWd1cmF0aW9uIGZyb20gY29uZmlnIGZpbGUgb25seSAoSXNzdWUgIzI2NiwgIzI3NykuXG4gKlxuICogQWxsIHZhbHVlcyBjb21lIGZyb20gdGhlIGNvbmZpZyBmaWxlLCB3aXRoIGhhcmRjb2RlZCBkZWZhdWx0cyBhcyBmYWxsYmFjay5cbiAqIEVudmlyb25tZW50IHZhcmlhYmxlIG92ZXJyaWRlcyBhcmUgbm8gbG9uZ2VyIHN1cHBvcnRlZCBhdCBydW50aW1lLlxuICogT25seSB2YWx1ZXMgdGhhdCBkaWZmZXIgZnJvbSBkZWZhdWx0cyBuZWVkIHRvIGJlIHN0b3JlZCBpbiAuY29uZmlnLmpzb24uXG4gKlxuICogQHBhcmFtIGNvbmZpZ1BhdGggLSBQYXRoIHRvIHRoZSAuY29uZmlnLmpzb24gZmlsZVxuICogQHBhcmFtIG9wdGlvbnMgLSBPcHRpb25hbCBiZWhhdmlvdXIgb3ZlcnJpZGVzXG4gKiBAcmV0dXJucyBDb21wbGV0ZSB3b3JrZXIgY29uZmlndXJhdGlvblxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZENvbmZpZyhcbiAgY29uZmlnUGF0aDogc3RyaW5nLFxuICBvcHRpb25zPzogTG9hZENvbmZpZ09wdGlvbnMsXG4pOiBQcm9taXNlPFdvcmtlckNvbmZpZz4ge1xuICAvLyBUaGUgb25lIGVudmlyb25tZW50IHNlYW0gdGhpcyBsb2FkZXIgcmVhZHMgdGhyb3VnaCAoSXNzdWUgIzk1NikuXG4gIGNvbnN0IGVudiA9IG9wdGlvbnM/LmVudiA/PyBwcm9jZXNzRW52TG9va3VwO1xuICBjb25zdCBmaWxlID0gYXdhaXQgbG9hZENvbmZpZ0ZpbGUoY29uZmlnUGF0aCwgZW52KTtcbiAgd2FyblJlbW92ZWRUcnVzdEtleXMoZmlsZSk7XG5cbiAgLy8gSXNzdWUgIzEwNjY6IGBhbGxvd2VkX2F1dGhvcnNgIG5vIGxvbmdlciBncmFudHMgYW55dGhpbmcuIFdobyBtYXkgZGlyZWN0XG4gIC8vIHdvcmsgaXMgZGVyaXZlZCBmcm9tIHJlcG9zaXRvcnkgY29sbGFib3JhdG9ycyBldmVyeSBjeWNsZSwgc28gdHJ1c3RcbiAgLy8gc3RhcnRzICoqY2xvc2VkKiogaGVyZSBhbmQgaXMgb3BlbmVkIG9ubHkgYnkgYSBzdWNjZXNzZnVsIHJlc29sdmUuIFRoZVxuICAvLyBmaWxlJ3MgYXJyYXkgc3Vydml2ZXMgZm9yIG9uZSBub24tdHJ1c3QgcHVycG9zZTogdGhlIGRlZmF1bHQgUFIgcmV2aWV3ZXJcbiAgLy8gYW5kIGFzc2lnbmVlIHdoZW4gYHByX3Jldmlld2Vyc2AgaXMgdW5zZXQuXG4gIGNvbnN0IGFsbG93ZWRBdXRob3JzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBjb25maWd1cmVkQXV0aG9ycyA9IGZpbGUuYWxsb3dlZF9hdXRob3JzID8/IFtdO1xuICBjb25zdCBhbGxvd2VkQXV0aG9yOiBzdHJpbmcgPSBjb25maWd1cmVkQXV0aG9yc1swXSA/PyBcIlwiO1xuXG4gIC8vIExvYWQgUFIgcmV2aWV3ZXJzIGFycmF5IChJc3N1ZSAjMTQxKVxuICBjb25zdCBwclJldmlld2VycyA9IGZpbGUucHJfcmV2aWV3ZXJzID8/IFtdO1xuICBjb25zdCBwclJldmlld2VyID0gcHJSZXZpZXdlcnNbMF0gPz8gYWxsb3dlZEF1dGhvciA/PyBcIlwiO1xuXG4gIC8vIElzc3VlICMxNTQ2OiBHaXRIdWIgcmVwb3NpdG9yeSBuYW1lcyBhcmUgY2FzZS1pbnNlbnNpdGl2ZSwgc28gdHdvXG4gIC8vIHNwZWxsaW5ncyBvZiBvbmUgcmVwb3NpdG9yeSBhcmUgb25lIHJlcG9zaXRvcnkuIExlZnQgYWxvbmUsIHRoZSBzZWNvbmRcbiAgLy8gZW50cnkgcmFuIGV2ZXJ5IHBlci1yZXBvc2l0b3J5IHNjYW4gYSBzZWNvbmQgdGltZSBhbmQgbGV0IHRoZSB3b3JrZXInc1xuICAvLyBvd24gc2xvdHMgcmFjZSBlYWNoIG90aGVyIGZvciBpdHMgaXNzdWVzLlxuICBjb25zdCB7IHJlcG9zLCBkdXBsaWNhdGVzIH0gPSBkZWR1cGVSZXBvU2x1Z3MoZmlsZS5yZXBvcyA/PyBbXSk7XG4gIHdhcm5EdXBsaWNhdGVSZXBvcyhkdXBsaWNhdGVzLCBPYmplY3Qua2V5cyhmaWxlLnJlcG9fY29uZmlnID8/IHt9KSk7XG5cbiAgLy8gSXNzdWUgIzE4MzQ6IHRoZSB0aHJlZSBkaXNjb3ZlcnkgbGFiZWxzICh0b3AtcHJpb3JpdHksIHdvcmstb24sXG4gIC8vIGxvdy1wcmlvcml0eSkgYXJlIGhhcmR3aXJlZCBhbmQgTk9UIGNvbmZpZ3VyYWJsZS4gaXNzdWVMYWJlbHMgaXMgdGhlXG4gIC8vIGNvbmZpZ3VyZWQtbGFiZWwgdGllciB0aGF0IHRoZSBsYWJlbC1iYXNlZCBjb2xsZWN0b3IgaXRlcmF0ZXM7IG9ubHlcbiAgLy8gdG9wLXByaW9yaXR5IGJlbG9uZ3MgaGVyZSwgc2luY2Ugd29yay1vbiBhbmQgbG93LXByaW9yaXR5IGhhdmVcbiAgLy8gZGVkaWNhdGVkLCBhdXRob3ItY2hlY2tlZCBjb2xsZWN0b3JzIHdpdGggc3RyaWN0ZXIgYXV0aG9yaXNhdGlvblxuICAvLyBjaGVja3MuIFJvdXRpbmcgdGhlbSB0aHJvdWdoIHRoZSBsYWJlbCBjb2xsZWN0b3Igd291bGQgYnlwYXNzIHRob3NlXG4gIC8vIGNoZWNrcy5cbiAgY29uc3QgaXNzdWVMYWJlbHMgPSBbTEFCRUxfREVGQVVMVFMudG9wUHJpb3JpdHlMYWJlbF07XG5cbiAgLy8gSXNzdWUgIzEwNjYsIGF4aXMgMjogdGhlICprbm93biogbG9naW5zIHdob3NlIGlucHV0IHRoZSB3b3JrZXIgYWN0cyBvbiDigJRcbiAgLy8gQ29waWxvdCwgQWN0aW9ucywgYW5kIGFueSBvdGhlciBib3QgdGhlIG9wZXJhdG9yIG5hbWVzLiBBIEdpdEh1YiBBcHAgaXNcbiAgLy8gbmV2ZXIgYSByZXBvc2l0b3J5IGNvbGxhYm9yYXRvciwgc28gdGhpcyBjYW5ub3QgYmUgZGVyaXZlZDsgaXQgaXMgYW5cbiAgLy8gZXhwbGljaXQgYWxsb3dsaXN0IGJ5IG5lY2Vzc2l0eS4gSXQgZ3JhbnRzIGlucHV0IG9ubHksIG5ldmVyIHRoZSByaWdodCB0b1xuICAvLyBkaXJlY3Qgd29yay4gQW4gb3BlcmF0b3Igd2hvIHNldHMgdGhlIGtleSBrZWVwcyBleGFjdGx5IHdoYXQgdGhleSB3cm90ZS5cbiAgY29uc3QgYXV0aG9yaXNlZENvbW1lbnRlcnMgPSBmaWxlLmF1dGhvcml6ZWRfY29tbWVudGVycyA/P1xuICAgIFsuLi5ERUZBVUxUX1RSVVNURURfSU5QVVRfQk9UU107XG5cbiAgY29uc3QgZXhjbHVzaW9uVGVhbSA9IGZpbGUuZXhjbHVzaW9uX3RlYW07XG5cbiAgLy8gSXNzdWUgIzM1Mjg6IGFsbG93bGlzdCBvZiBzZXJ2aWNlLWFjY291bnQgbG9naW5zIHRoZSBpZGVudGl0eSBndWFyZFxuICAvLyB2YWxpZGF0ZXMgdGhlIHJlc29sdmVkIGBnaGAgbG9naW4gYWdhaW5zdC4gRW1wdHkgbGVhdmVzIHRoZSBndWFyZFxuICAvLyBpbmFjdGl2ZSAobG91ZGx5IHdhcm5lZCksIG5ldmVyIHNpbGVudGx5IHBlcm1pc3NpdmUuXG4gIGNvbnN0IHNlcnZpY2VBY2NvdW50cyA9IGZpbGUuc2VydmljZV9hY2NvdW50cyA/PyBbXTtcblxuICAvLyBJc3N1ZSAjMzUzMDogc2VydmljZS1hY2NvdW50IGF1dGggZW52IHNvdXJjZXMuIEtlcHQgcmF3IChubyB+IGV4cGFuc2lvbilcbiAgLy8g4oCUIGFwcGx5U2VydmljZUFjY291bnRFbnYgZXhwYW5kcyB3aGVuIGl0IHNldHMgR0hfQ09ORklHX0RJUiAvXG4gIC8vIEdJVF9TU0hfQ09NTUFORCBvbiB0aGUgc2hhcmVkIGNvbW1hbmQgcGF0aC5cbiAgY29uc3QgZ2hDb25maWdEaXIgPSBmaWxlLmdoX2NvbmZpZ19kaXIgPz8gXCJcIjtcbiAgY29uc3Qgc3NoS2V5UGF0aCA9IGZpbGUuc3NoX2tleV9wYXRoID8/IFwiXCI7XG5cbiAgLy8gVHJ1c3RlZCByZXZpZXcgYm90cyAoSXNzdWUgIzE4NTYpLiBQcmVjZWRlbmNlOiBUUlVTVEVEX1JFVklFV19CT1RTXG4gIC8vIGVudiB2YXIgPiAuY29uZmlnLmpzb24gKGB0cnVzdGVkX3Jldmlld19ib3RzYCkgPiBidWlsdC1pbiBkZWZhdWx0cy5cbiAgY29uc3QgdHJ1c3RlZFJldmlld0JvdHM6IHN0cmluZ1tdID0gZ2V0RW52QXJyYXlPckRlZmF1bHQoXG4gICAgXCJUUlVTVEVEX1JFVklFV19CT1RTXCIsXG4gICAgZmlsZS50cnVzdGVkX3Jldmlld19ib3RzID8/IFsuLi5ERUZBVUxUX1RSVVNURURfUkVWSUVXX0JPVFNdLFxuICAgIGVudixcbiAgKTtcblxuICAvLyBTaWJsaW5nIGZsZWV0IFBSIGF1dGhvcnMgKGZsZWV0LWF3YXJlIFBSIG1haW50ZW5hbmNlKS4gUHJlY2VkZW5jZTpcbiAgLy8gRkxFRVRfUFJfQVVUSE9SUyBlbnYgdmFyID4gLmNvbmZpZy5qc29uIChgZmxlZXRfcHJfYXV0aG9yc2ApID4gW10uXG4gIGNvbnN0IGNvbmZpZ3VyZWRGbGVldFByQXV0aG9yczogc3RyaW5nW10gPSBnZXRFbnZBcnJheU9yRGVmYXVsdChcbiAgICBcIkZMRUVUX1BSX0FVVEhPUlNcIixcbiAgICBmaWxlLmZsZWV0X3ByX2F1dGhvcnMgPz8gW10sXG4gICAgZW52LFxuICApO1xuXG4gIC8vIElzc3VlICMyMDk6IGBzZXJ2aWNlX2FjY291bnRzYCBuYW1lcyBmbGVldCBhY2NvdW50cyB0b28sIHNvIHRoZSB0d29cbiAgLy8ga2V5cyByZXNvbHZlIHRvIG9uZSBlZmZlY3RpdmUgc2libGluZyBsaXN0IGhlcmUuIEEgZmxlZXQgdGhhdCBsaXN0ZWRcbiAgLy8gaXRzIHNpYmxpbmdzIG9ubHkgdW5kZXIgYHNlcnZpY2VfYWNjb3VudHNgIGhhZCBhbiBlbXB0eVxuICAvLyBgZmxlZXRfcHJfYXV0aG9yc2AsIHdoaWNoIGxlZnQgZXZlcnkgc2libGluZyBvdXRzaWRlIHRoZSBQUiBndWFyZHM6XG4gIC8vIHRoZWlyIG9wZW4gUFJzIGRpZCBub3QgYmxvY2sgYSBjbGFpbSBhbmQgdGhlaXIgbWVyZ2VkIFBScyBkaWQgbm90XG4gIC8vIGNsb3NlIG9uZSwgc28gdHdvIGhvc3RzIHdvcmtlZCB0aGUgc2FtZSBpc3N1ZSBtaW51dGVzIGFwYXJ0LiBVbmlvbmluZ1xuICAvLyBvbmNlIGF0IGxvYWQgbWVhbnMgbm8gY29uc3VtZXIg4oCUIGluY2x1ZGluZyB0aGUgb25lcyB0aGF0IGJ1aWxkIHRoZWlyXG4gIC8vIG93biBhdXRob3IgbGlzdCBmcm9tIGBmbGVldFByQXV0aG9yc2Ag4oCUIGNhbiBzZWUgb25lIGtleSB3aXRob3V0IHRoZVxuICAvLyBvdGhlci5cbiAgY29uc3QgZmxlZXRQckF1dGhvcnMgPSByZXNvbHZlRWZmZWN0aXZlRmxlZXRQckF1dGhvcnMoXG4gICAgY29uZmlndXJlZEZsZWV0UHJBdXRob3JzLFxuICAgIHNlcnZpY2VBY2NvdW50cyxcbiAgKTtcblxuICAvLyBMYWJlbCBjb25maWd1cmF0aW9uIOKAlCBhbGwgZnJvbSBMQUJFTF9ERUZBVUxUUy4gSXNzdWUgIzE4MzQgaGFyZHdpcmVzXG4gIC8vIHdvcmtPbkxhYmVsIGFuZCBsb3dQcmlvcml0eUxhYmVsOyB0aGUgcmVtYWluaW5nIGxhYmVscyBzdGlsbCBsb2FkXG4gIC8vIGZyb20gLmNvbmZpZy5qc29uIHNvIGFkbWlucyBjYW4gcmVuYW1lIHdvcmtmbG93IGxhYmVscyAoZmFpbGVkLFxuICAvLyBuZWVkcy1jbGFyaWZpY2F0aW9uLCBldGMuKSB3aGVuIGludGVncmF0aW5nIHdpdGggZXhpc3RpbmcgcmVwb3MuXG4gIGNvbnN0IHdvcmtPbkxhYmVsID0gTEFCRUxfREVGQVVMVFMud29ya09uTGFiZWw7XG4gIGNvbnN0IGZhaWxlZE9uY2VMYWJlbCA9IGZpbGUuZmFpbGVkX29uY2VfbGFiZWwgPz9cbiAgICBMQUJFTF9ERUZBVUxUUy5mYWlsZWRPbmNlTGFiZWw7XG4gIGNvbnN0IGZhaWxlZExhYmVsID0gZmlsZS5mYWlsZWRfbGFiZWwgPz8gTEFCRUxfREVGQVVMVFMuZmFpbGVkTGFiZWw7XG4gIGNvbnN0IHJlZmluZUlzc3VlTGFiZWwgPSBmaWxlLnJlZmluZV9pc3N1ZV9sYWJlbCA/P1xuICAgIExBQkVMX0RFRkFVTFRTLnJlZmluZUlzc3VlTGFiZWw7XG4gIGNvbnN0IHBsYW5uaW5nTGFiZWwgPSBmaWxlLnBsYW5uaW5nX2xhYmVsID8/IExBQkVMX0RFRkFVTFRTLnBsYW5uaW5nTGFiZWw7XG4gIGNvbnN0IHF1ZXN0aW9uTGFiZWwgPSBmaWxlLnF1ZXN0aW9uX2xhYmVsID8/IExBQkVMX0RFRkFVTFRTLnF1ZXN0aW9uTGFiZWw7XG4gIGNvbnN0IG5lZWRzUmV2aXNpb25MYWJlbCA9IGZpbGUubmVlZHNfcmV2aXNpb25fbGFiZWwgPz9cbiAgICBMQUJFTF9ERUZBVUxUUy5uZWVkc1JldmlzaW9uTGFiZWw7XG4gIGNvbnN0IG5lZWRzSHVtYW5MYWJlbCA9IGZpbGUubmVlZHNfaHVtYW5fbGFiZWwgPz9cbiAgICBMQUJFTF9ERUZBVUxUUy5uZWVkc0h1bWFuTGFiZWw7XG4gIGNvbnN0IGdyaWxsTWVMYWJlbCA9IGZpbGUuZ3JpbGxfbWVfbGFiZWwgPz8gTEFCRUxfREVGQVVMVFMuZ3JpbGxNZUxhYmVsO1xuICBjb25zdCBxdW9ydW1MYWJlbCA9IGZpbGUucXVvcnVtX2xhYmVsID8/IExBQkVMX0RFRkFVTFRTLnF1b3J1bUxhYmVsO1xuICAvLyBJc3N1ZSAjMTgzNDogbG93UHJpb3JpdHlMYWJlbCBpcyBoYXJkd2lyZWQg4oCUIGAuY29uZmlnLmpzb25gIG1heSBub3Qgb3ZlcnJpZGUuXG4gIGNvbnN0IGxvd1ByaW9yaXR5TGFiZWwgPSBMQUJFTF9ERUZBVUxUUy5sb3dQcmlvcml0eUxhYmVsO1xuXG4gIGNvbnN0IGhvbWUgPSBlbnYoXCJIT01FXCIpID8/IFwiL3RtcFwiO1xuICBjb25zdCB3b3JrRGlyID0gYCR7aG9tZX0vYXV0by1pc3N1ZS13b3JrYDtcblxuICAvLyBXaGVyZSB0aGlzIGhvc3QgcnVucyB0aGUgd29ya2VyIChJc3N1ZSAjNDE0NikuIENvbnRhaW5lciBieSBkZWZhdWx0O1xuICAvLyBgbmF0aXZlYCBpcyBhbiBleHBsaWNpdCBvcHQtaW4sIGFuZCBhbiB1bnJlY29nbmlzZWQgdmFsdWUgZmFpbHMgbG91ZGx5XG4gIC8vIGhlcmUgcmF0aGVyIHRoYW4gcXVpZXRseSBsYXVuY2hpbmcgaW4gdGhlIG1vZGUgbm9ib2R5IGFza2VkIGZvci5cbiAgLy8gYGVudmAgZ29lcyB0aHJvdWdoOiBgVklCRV9SVU5fTU9ERWAgYmVhdHMgdGhlIGZpbGUsIGFuZCBhIGxvYWRlciBnaXZlbiBhblxuICAvLyBleHBsaWNpdCBsb29rdXAgbXVzdCBub3QgaGF2ZSB0aGF0IG92ZXJyaWRlIGFuc3dlcmVkIGJ5IHRoZSBwcm9jZXNzXG4gIC8vIGluc3RlYWQgKElzc3VlICM5Njkg4oCUIHRoZSBzZWFtICM5NTYgYWRkZWQgc3RvcHBlZCBvbmUgY2FsbCBzaG9ydCBoZXJlKS5cbiAgY29uc3QgcnVuTW9kZSA9IHJlc29sdmVSdW5Nb2RlKHsgY29uZmlndXJlZDogZmlsZS5ydW5fbW9kZSwgZW52IH0pO1xuXG4gIC8vIEhvdyB0aGlzIGhvc3QgdHJhY2tzIHJlbGVhc2VzIChJc3N1ZSAjNjIyLCBwYXJ0IG9mICM1ODMpLiBBYnNlbnQgbWVhbnNcbiAgLy8gYGR5bmFtaWNgLCBzbyBhIGhvc3Qgd2l0aCBubyB1cGRhdGUtbW9kZSBrZXlzIGJlaGF2ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gIC8vIFRoZSBwaW5zIGFyZSBjYXJyaWVkIHRocm91Z2ggaW4gZWl0aGVyIG1vZGUg4oCUIG5vdGhpbmcgYWN0cyBvbiB0aGVtIHVuZGVyXG4gIC8vIGBkeW5hbWljYCwgYnV0IGtlZXBpbmcgdGhlbSBsZXRzIGEgaG9zdCBmbGlwIGJhY2sgd2l0aG91dCByZS1lZGl0aW5nLlxuICBjb25zdCB1cGRhdGVNb2RlID0gZmlsZS51cGRhdGVfbW9kZSA/PyBERUZBVUxUX1VQREFURV9NT0RFO1xuICBjb25zdCBwaW5uZWRSZWYgPSBmaWxlLnBpbm5lZF9yZWY7XG4gIGNvbnN0IHBpbm5lZFRvb2xWZXJzaW9ucyA9IGZpbGUucGlubmVkX3Rvb2xfdmVyc2lvbnM7XG5cbiAgLy8gQ29kaW5nLWFnZW50IHByb3ZpZGVyIHNlbGVjdGlvbiAoSXNzdWUgIzQwNjcpLiBSZXNvbHZlZCBoZXJlIHNvIGFuXG4gIC8vIHVuc3VwcG9ydGVkIGlkIGZhaWxzIGxvdWRseSBhdCBzdGFydHVwLCBuYW1pbmcgdGhlIHN1cHBvcnRlZCBwcm92aWRlcnMsXG4gIC8vIHJhdGhlciB0aGFuIHN1cmZhY2luZyBhcyBhIG1pc3NpbmcgYmluYXJ5IG1pZC1ydW4uIE91dHNpZGUgYXV0b21hdGljXG4gIC8vIHJvdXRpbmcgdGhlIHNlbGVjdGlvbiBpcyBhbHNvIHJlY29yZGVkIG9uIHRoZSBzZWFtLCBiZWNhdXNlIHRoZSBsb3ctbGV2ZWxcbiAgLy8gbW9kdWxlcyB0aGF0IHNwYXduIHRoZSBhZ2VudCBob2xkIG5vIGNvbmZpZ3VyYXRpb24gaGFuZGxlLiBXaGlsZSByb3V0aW5nXG4gIC8vIGlzIGFjdGl2ZSwgdGhlIHJvdXRlciBvd25zIHRoYXQgc2VhbSBiZXR3ZWVuIGl0cyByZWZyZXNoZXMgKElzc3VlICM0MDI0KS5cbiAgLy8gVGhlIHJlc29sdmVyIGNvbnN1bHRzIHRoZSBwZXItcnVuIHByb3ZpZGVyIG92ZXJyaWRlIChJc3N1ZSAjMjA2MilcbiAgLy8gYmVmb3JlIHRoZSBmaWxlJ3MgdmFsdWU6IHRoZSBoZWFsdGggZ2F0ZSdzIGZhbGxiYWNrIHN3aXRjaCB0aGVyZWZvcmVcbiAgLy8gc3Vydml2ZXMgZXZlcnkgaW4tcHJvY2VzcyBjb25maWcgcmVsb2FkLCB3aGljaCB3b3VsZCBvdGhlcndpc2UgcmVzZXRcbiAgLy8gdGhlIGNob2ljZSB0byB0aGUgZmlsZSdzIHByZWZlcnJlZCBpZCAoSXNzdWUgIzIwNjUpLlxuICAvLyBgZW52YCBnb2VzIHRocm91Z2ggZm9yIHRoZSBzYW1lIHJlYXNvbiBpdCBkb2VzIGJlbG93IChJc3N1ZSAjMjA4Nik6IHRoZVxuICAvLyBgVklCRV9BR0VOVF9QUk9WSURFUmAgZmFsbGJhY2sgYW5kIHRoZSBydW5uaW5nIGltYWdlJ3MgaW5zdGFsbGVkLXByb3ZpZGVyXG4gIC8vIHN0YW1wIGRlY2lkZSB0aGlzIGlkLCBzbyBhIGxvYWRlciBnaXZlbiBhbiBleHBsaWNpdCBsb29rdXAgbXVzdCBub3QgaGF2ZVxuICAvLyB0aGVtIGFuc3dlcmVkIGJ5IHRoZSBwcm9jZXNzIGVudmlyb25tZW50IGluc3RlYWQg4oCUIHRoZSBzZWFtICM5NTYgYWRkZWRcbiAgLy8gc3RvcHBlZCBvbmUgY2FsbCBzaG9ydCBoZXJlLCBleGFjdGx5IGFzIGl0IGRpZCBhdCBgcmVzb2x2ZVJ1bk1vZGVgXG4gIC8vIChJc3N1ZSAjOTY5KS5cbiAgY29uc3QgYWdlbnRQcm92aWRlciA9IHJlc29sdmVBZ2VudFByb3ZpZGVySWQoe1xuICAgIGNvbmZpZ3VyZWQ6IGZpbGUuYWdlbnRfcHJvdmlkZXIsXG4gICAgZW52LFxuICB9KTtcbiAgLy8gKElzc3VlICM0MDI0KSBBdXRvbWF0aWMgcm91dGluZyBvd25zIHRoZSBhY3RpdmUgcHJvdmlkZXIgYmV0d2VlbiBpdHNcbiAgLy8gcmVmcmVzaGVzOiBhIGJlc3QtZWZmb3J0IGNvbmZpZyByZWxvYWQg4oCUIHRoZSBhbGxvd2xpc3QgYW5kXG4gIC8vIHRydXN0ZWQtYXV0aG9yIHJlYWRlcnMgY2FsbCB0aGlzIGZ1bGwgbG9hZGVyIGZvciBvbmUgc21hbGwgZmllbGQg4oCUIG11c3RcbiAgLy8gbm90IHJlc2V0IHRoZSBzZWFtIHRvIHRoZSBmaWxlJ3MgcHJlZmVycmVkIGlkLCBvciBldmVyeSBtYWludGVuYW5jZVxuICAvLyBwaGFzZSBhZnRlciB0aGUgcmVsb2FkIHJ1bnMgdGhlIHByb3ZpZGVyIHRoZSByb3V0ZXIganVzdCBkZXNlbGVjdGVkXG4gIC8vIChHUlEtMjM6IFBSIGZlZWRiYWNrIHJhbiBDb2RleCB3aGlsZSB0aGUgcm91dGVyIGhhZCBzd2l0Y2hlZCB0byBDbGF1ZGUpLlxuICAvLyBUaGUgcnVuIG92ZXJyaWRlIGlzIGFscmVhZHkgaW1tdW5lIChJc3N1ZSAjMjA2MiksIHNvIG9ubHkgdGhlXG4gIC8vIGF1dG8tcm91dGVyJ3Mgc2VsZWN0aW9uIG5lZWRzIHRoaXMgZ3VhcmQ7IGEgcGlubmVkLW1vZGUgaG9zdCDigJQgcm91dGluZ1xuICAvLyBpbmFjdGl2ZSDigJQga2VlcHMgdGhlIGhpc3RvcmljYWwgcmVsb2FkIGJlaGF2aW91ci5cbiAgaWYgKCFpc0F1dG9tYXRpY1Byb3ZpZGVyUm91dGluZ0FjdGl2ZSgpKSB7XG4gICAgc2V0Q29uZmlndXJlZEFnZW50UHJvdmlkZXJJZChhZ2VudFByb3ZpZGVyKTtcbiAgfVxuXG4gIC8vIFRoZSBwcm92aWRlcnMgZW5hYmxlZCBmb3IgdGhpcyBydW4gKElzc3VlICM0MTA4KS4gRWFjaCBvbmUgaXMgcHJvdmlzaW9uZWQsXG4gIC8vIHByZWZsaWdodGVkIGFuZCBtb3VudGVkIHNlcGFyYXRlbHk7IGEgcHJvdmlkZXIgb3V0c2lkZSB0aGUgc2V0IGhhcyBub1xuICAvLyBjcmVkZW50aWFsIG1vdW50IGF0IGFsbC4gUmVzb2x2ZWQgaGVyZSBzbyBhbiB1bnVzYWJsZSBzZXQg4oCUIGFuIHVua25vd24gaWQsXG4gIC8vIGEgZHVwbGljYXRlLCBvciBvbmUgdGhhdCBleGNsdWRlcyB0aGUgYWN0aXZlIHByb3ZpZGVyIOKAlCBmYWlscyBsb3VkbHkgYXRcbiAgLy8gc3RhcnR1cCwgYW5kIHJlY29yZGVkIG9uIHRoZSBzZWFtIGZvciB0aGUgbW9kdWxlcyB0aGF0IGhvbGQgbm9cbiAgLy8gY29uZmlndXJhdGlvbiBoYW5kbGUuXG4gIC8vIENsZWFyZWQgZmlyc3Qgc28gYSBzZWxlY3Rpb24gcmVjb3JkZWQgYnkgYW4gZWFybGllciBsb2FkIGNhbm5vdCBsZWFrIGludG9cbiAgLy8gdGhpcyBvbmU6IHRoZSBmaWxlIGluIGhhbmQgZGVjaWRlcyB0aGUgc2V0IG9uIGl0cyBvd24uXG4gIHNldENvbmZpZ3VyZWRFbmFibGVkQWdlbnRQcm92aWRlcklkcyh1bmRlZmluZWQpO1xuICBjb25zdCBlbmFibGVkQWdlbnRQcm92aWRlcklkcyA9IHJlc29sdmVFbmFibGVkQWdlbnRQcm92aWRlcklkcyh7XG4gICAgLy8gVGhlIHNhbWUgbG9va3VwIHRoZSByZXN0IG9mIHRoZSBsb2FkIHJlYWRzIHRocm91Z2ggKElzc3VlICM5NjIpOiB0aGVcbiAgICAvLyBWSUJFX0FHRU5UX1BST1ZJREVSKFMpIGZhbGxiYWNrcyBhbmQgdGhlIHJ1bm5pbmcgaW1hZ2UncyBzdGFtcCBkZWNpZGVcbiAgICAvLyB3aGljaCBhZ2VudCB0aGlzIHJ1biBkaXNwYXRjaGVzIHRvIHdoZW4gdGhlIGZpbGUgc3RhdGVzIG5vbmUsIHNvIHRoZXlcbiAgICAvLyBtdXN0IG5vdCBjb21lIGZyb20gYSBkaWZmZXJlbnQgZW52aXJvbm1lbnQgdG8gZXZlcnl0aGluZyBlbHNlIGhlcmUuXG4gICAgZW52LFxuICAgIGNvbmZpZ3VyZWQ6IGZpbGUuYWdlbnRfcHJvdmlkZXIsXG4gICAgY29uZmlndXJlZFByb3ZpZGVyczogZmlsZS5hZ2VudF9wcm92aWRlcnMsXG4gIH0pO1xuICBzZXRDb25maWd1cmVkRW5hYmxlZEFnZW50UHJvdmlkZXJJZHMoZW5hYmxlZEFnZW50UHJvdmlkZXJJZHMpO1xuXG4gIC8vIEVncmVzcyBhbGxvd2xpc3QgKElzc3VlICM0MDQ1KTogaW52YWxpZCBob3N0cyBmYWlsIHRoZSBsb2FkLiBUaGUgbGF1bmNoXG4gIC8vIHBsYW4gKElzc3VlICM0MDQ3KSByZXNvbHZlcyB0aGUgc2FtZSBsaXN0IGFuZCBoYW5kcyBpdCB0byB0aGUgcHJveHkuXG4gIHRyeSB7XG4gICAgcmVzb2x2ZUVncmVzc0FsbG93bGlzdCh7XG4gICAgICBlbmFibGVkUHJvdmlkZXJJZHM6IGVuYWJsZWRBZ2VudFByb3ZpZGVySWRzLFxuICAgICAgaW1nYmJDb25maWd1cmVkOiAoZmlsZS5pbWdiYl9hcGlfa2V5ID8/IFwiXCIpLnRyaW0oKSAhPT0gXCJcIiB8fFxuICAgICAgICByZWFkSW1nYmJBcGlLZXlGcm9tRW52KGVudikgIT09IFwiXCIsXG4gICAgICBhbnRocm9waWNCYXNlVXJsOiBlbnYoXCJBTlRIUk9QSUNfQkFTRV9VUkxcIiksXG4gICAgICBleHRyYUhvc3RzOiBmaWxlLmVncmVzc19hbGxvd19ob3N0cyxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYENvbmZpZyBmaWxlICR7Y29uZmlnUGF0aH0gaXMgaW52YWxpZDogJHttZXNzYWdlfWApO1xuICB9XG5cbiAgLy8gT3B0LWluIG9yZGVyZWQgZmFsbGJhY2sgKElzc3VlICMxNzAwKS4gVmFsaWRhdGVkIGhlcmUgc28gYW4gdW5jb25maWd1cmVkXG4gIC8vIGFsdGVybmF0aXZlIGZhaWxzIGF0IHN0YXJ0dXAsIG5vdCBtaWQtcnVuLiBUaGUgZW1wdHkgZGVmYXVsdCBpcyBwaW5uZWQuXG4gIC8vIFJlY29yZGVkIG9uIHRoZSBzZWFtIGZvciB0aGUgYWdlbnQgcnVubmVyLCB3aGljaCBtb3ZlcyBhIHBoYXNlIHdob3NlXG4gIC8vIG1vZGVsIHRoZSBwcm92aWRlciByZWZ1c2VkIG9udG8gdGhlc2UgYWx0ZXJuYXRpdmVzIChJc3N1ZSAjNDAzNCkuXG4gIGNvbnN0IHByb3ZpZGVyRmFsbGJhY2tQb2xpY3kgPSByZXNvbHZlUHJvdmlkZXJGYWxsYmFja1BvbGljeSh7XG4gICAgcHJlZmVycmVkOiBhZ2VudFByb3ZpZGVyLFxuICAgIGVuYWJsZWQ6IGVuYWJsZWRBZ2VudFByb3ZpZGVySWRzLFxuICAgIGZhbGxiYWNrOiBmaWxlLmFnZW50X3Byb3ZpZGVyX2ZhbGxiYWNrLFxuICB9KTtcbiAgc2V0Q29uZmlndXJlZFByb3ZpZGVyRmFsbGJhY2tQb2xpY3kocHJvdmlkZXJGYWxsYmFja1BvbGljeSk7XG4gIGNvbnN0IGFnZW50UHJvdmlkZXJGYWxsYmFjayA9IHByb3ZpZGVyRmFsbGJhY2tQb2xpY3kuYWx0ZXJuYXRpdmVzO1xuXG4gIC8vIENsYXVkZSBtb2RlbCBzZWxlY3Rpb24gKElzc3VlICMyNjApLiBFbXB0eSB3aGVuIHRoZSBob3N0IHNldHMgbm9cbiAgLy8gYGNsYXVkZV9tb2RlbGA6IGNhbGwgc2l0ZXMgcGFzcyBgY29uZmlnLmNsYXVkZU1vZGVsIHx8IHVuZGVmaW5lZGAgYXMgYW5cbiAgLy8gZXhwbGljaXQgYC0tbW9kZWxgLCB3aGljaCBiZWF0cyBwaGFzZSByb3V0aW5nLCBzbyBkZWZhdWx0aW5nIGl0IHRvIE9wdXNcbiAgLy8gcHV0IGV2ZXJ5IGlzc3VlIG1hbmFnZXIgb24gT3B1cyBpbnN0ZWFkIG9mIHRoZSBTb25uZXQgYGlzc3VlYCBkZWZhdWx0XG4gIC8vIChJc3N1ZSAjNDExNykuXG4gIGNvbnN0IGNsYXVkZU1vZGVsID0gZmlsZS5jbGF1ZGVfbW9kZWwgPz8gXCJcIjtcblxuICAvLyBDb25maWd1cmVkIGJlc3QgcGxhbm5pbmcgbW9kZWwgZm9yIGRlZ3JhZGVkLW1vZGVsIGRldGVjdGlvbiAoSXNzdWUgIzI2NTQpLlxuICAvLyBFbXB0eSBkZWZhdWx0IOKGkiBleHBlY3RlZCBtb2RlbCBkZXJpdmVkIGZyb20gdGhlIHBsYW5uaW5nIHJvdXRpbmcgY2hhaW4uXG4gIGNvbnN0IGJlc3RQbGFubmluZ01vZGVsID0gZmlsZS5iZXN0X3BsYW5uaW5nX21vZGVsID8/XG4gICAgREVGQVVMVF9CRVNUX1BMQU5OSU5HX01PREVMO1xuXG4gIC8vIE9wZXJhdGlvbmFsIHNldHRpbmdzIOKAlCBhbGwgZnJvbSAuY29uZmlnLmpzb24gd2l0aCBkZWZhdWx0cyAoSXNzdWUgIzI3NylcbiAgY29uc3QgY2xhdWRlTWF4VHVybnMgPSB2YWxpZGF0ZUNsYXVkZU1heFR1cm5zKFxuICAgIGZpbGUuY2xhdWRlX21heF90dXJucyA/PyBERUZBVUxUX0NMQVVERV9NQVhfVFVSTlMsXG4gICk7XG4gIGNvbnN0IGNsYXVkZVRpbWVvdXQgPSBmaWxlLmNsYXVkZV90aW1lb3V0ID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuY2xhdWRlVGltZW91dDtcbiAgLy8gQ2xhaW0tcnVud2F5IGZsb29yIChJc3N1ZSAjMjg5KS4gQ29uZmlnIGZpcnN0LCB0aGVuIHRoZSBsZWdhY3lcbiAgLy8gZW52aXJvbm1lbnQgdmFyaWFibGVzLCB0aGVuIHRoZSBkZWZhdWx0LiBUaGUgZW52IHZhcnMgYXJlIG5ldmVyXG4gIC8vIGZvcndhcmRlZCBpbnRvIHRoZSB3b3JrZXIgY29udGFpbmVyIChgY29udGFpbmVyX2xhdW5jaC50c2AgcGFzc2VzIG9ubHlcbiAgLy8gdGhlIGZpdmUgaXQgc2V0cyBpdHNlbGYpLCBzbyBvbiBhIGNvbnRhaW5lcmlzZWQgaG9zdCB0aGUgY29uZmlnIGtleSBpc1xuICAvLyB0aGUgb25seSBpbnRlcmZhY2UgdGhhdCB3b3JrcyDigJQgaGVuY2UgdGhlIGtleSwgYW5kIGhlbmNlIGNvbmZpZyB3aW5uaW5nLlxuICBjb25zdCBtaW5DbGFpbVJ1bndheVNlY29uZHMgPSBmaWxlLm1pbl9jbGFpbV9ydW53YXlfc2Vjb25kcyA/P1xuICAgIHJlYWROb25OZWdhdGl2ZU51bWJlckVudihcIk1JTl9DTEFJTV9SVU5XQVlfU0VDT05EU1wiLCBlbnYpID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMubWluQ2xhaW1SdW53YXlTZWNvbmRzO1xuICAvLyBSdW4gZmluaXNoIGRlYWRsaW5lIChJc3N1ZSAjNDI0Mik6IHNlY29uZHMgZnJvbSBydW4gc3RhcnQuIFZhbGlkYXRlZFxuICAvLyBoZXJlIGFuZCBwdWJsaXNoZWQgYnkgdGhlIHJ1biB0aW1lbGluZS4gQWdlbnQgc2Vzc2lvbnMsIGV4dGVuc2lvblxuICAvLyBncmFudHMsIHRoZSBjbGFpbSBmbG9vciBhbmQgdGhlIGRyYWluIHJlYWQgaXQgKElzc3VlcyAjNDI0NCwgIzQyNDUsXG4gIC8vICM0MjQ2KS4gQSBmaW5pc2ggYXQgb3IgYmVmb3JlIHRoZSBvbmUtaG91ciBydW4gdGFyZ2V0IGxlYXZlcyBubyB0aW1lXG4gIC8vIHRvIGZpbmlzaCwgc28gaXQgaXMgcmVmdXNlZCBsb3VkbHkgcmF0aGVyIHRoYW4gbG9nZ2VkIGFzIGEgbGl2ZSBkZWFkbGluZS5cbiAgY29uc3QgcnVuRmluaXNoU2Vjb25kcyA9IGZpbGUucnVuX2ZpbmlzaF9zZWNvbmRzID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucnVuRmluaXNoU2Vjb25kcztcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocnVuRmluaXNoU2Vjb25kcykpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgcnVuX2ZpbmlzaF9zZWNvbmRzIG11c3QgYmUgYSBmaW5pdGUgbnVtYmVyLCBnb3QgYCArXG4gICAgICAgIGAke1N0cmluZyhydW5GaW5pc2hTZWNvbmRzKX0uYCxcbiAgICApO1xuICB9XG4gIGlmIChydW5GaW5pc2hTZWNvbmRzIDw9IERFRkFVTFRfUlVOX1RBUkdFVF9TRUNPTkRTKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYHJ1bl9maW5pc2hfc2Vjb25kcyBtdXN0IGJlIGdyZWF0ZXIgdGhhbiB0aGUgcnVuIGR1cmF0aW9uIHRhcmdldCBgICtcbiAgICAgICAgYCgke0RFRkFVTFRfUlVOX1RBUkdFVF9TRUNPTkRTfSksIGdvdCAke3J1bkZpbmlzaFNlY29uZHN9LiBUaGUgZmluaXNoIGAgK1xuICAgICAgICBgZGVhZGxpbmUgaXMgbWVhc3VyZWQgZnJvbSBydW4gc3RhcnQsIHNvIGEgdmFsdWUgYXQgb3IgYmVsb3cgdGhlIGAgK1xuICAgICAgICBgdGFyZ2V0IGxlYXZlcyB0aGUgcnVuIG5vIHRpbWUgdG8gZmluaXNoIGFmdGVyIGl0LmAsXG4gICAgKTtcbiAgfVxuICAvLyBBZGFwdGl2ZSBjbGFpbSBmbG9vciAoSXNzdWUgIzI0NSk6IGxhYmVscyB0aGF0IG1hcmsgYW4gaXNzdWUgYXMgYSBsb25nXG4gIC8vIGpvYiwgYWxvbmdzaWRlIHRoZSBwcmVzZXJ2ZWQtV0lQIGFuZCBwcmlvci1leGVjdXRlLXRpbWVvdXQgZXZpZGVuY2UuXG4gIGNvbnN0IGNsYWltTG9uZ0pvYkxhYmVscyA9IGZpbGUuY2xhaW1fbG9uZ19qb2JfbGFiZWxzID8/XG4gICAgWy4uLkRFRkFVTFRfTE9OR19KT0JfTEFCRUxTXTtcbiAgLy8gUmUtYXJtYWJsZSBpc3N1ZS13b3JrIGRlYWRsaW5lIChJc3N1ZSAjNDI5NiwgcGFydCBvZiAjNDI5MCkuIE9mZiBieVxuICAvLyBkZWZhdWx0OyBvbmx5IGlzc3VlIHdvcmsgY29uc3VsdHMgaXQuIE5vbi1wb3NpdGl2ZSB0dW5hYmxlcyBhcmUgcmVqZWN0ZWRcbiAgLy8gbG91ZGx5IHJhdGhlciB0aGFuIHNpbGVudGx5IGRpc2FibGluZyBvciBleHRlbmRpbmcgZm9yZXZlciAoIzMyMzQpLlxuICBjb25zdCBwcm9ncmVzc0V4dGVuc2lvbkVuYWJsZWQgPSBmaWxlLnByb2dyZXNzX2V4dGVuc2lvbl9lbmFibGVkID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucHJvZ3Jlc3NFeHRlbnNpb25FbmFibGVkO1xuICAvLyBBZ2VudCB0cmFuc2NyaXB0IHRlZSAoSXNzdWUgIzExNDEpLiBgLmNvbmZpZy5qc29uYCBpcyB0aGUgb25seSBvcGVyYXRvclxuICAvLyBzd2l0Y2g6IGV2ZXJ5IG9uZSBvZiB0aGUgdHdlbnR5IGZsZWV0IHJ1biByZWNvcmRzIGFyY2hpdmVkIG9uIDIwMjYtMDktMDVcbiAgLy8gY2FycmllZCBcImFnZW50IHRyYW5zY3JpcHQgdGVlIG5vdCBlbmFibGVkIGZvciB0aGlzIHJ1blwiIGJlY2F1c2Ugbm90aGluZ1xuICAvLyBzZXQgdGhlIGVudmlyb25tZW50IHZhcmlhYmxlIGFuZCB0aGVyZSB3YXMgbm8ga2V5IHRoYXQgY291bGQuIE9mZiBieVxuICAvLyBkZWZhdWx0IOKAlCB0aGUgdHJhbnNjcmlwdCBpcyB0aGUgcmF3IGFnZW50IHN0cmVhbSwgc28gYSBkZXBsb3ltZW50IG9wdHMgaW4uXG4gIGNvbnN0IGFnZW50VHJhbnNjcmlwdEVuYWJsZWQgPSBmaWxlLmFnZW50X3RyYW5zY3JpcHRfZW5hYmxlZCA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLmFnZW50VHJhbnNjcmlwdEVuYWJsZWQ7XG4gIGNvbnN0IHByb2dyZXNzRXh0ZW5zaW9uR3JhbnRTZWNvbmRzID0gZmlsZS5wcm9ncmVzc19leHRlbnNpb25fZ3JhbnRfc2Vjb25kcyA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLnByb2dyZXNzRXh0ZW5zaW9uR3JhbnRTZWNvbmRzO1xuICBjb25zdCBwcm9ncmVzc0V4dGVuc2lvblN0YWxsU2Vjb25kcyA9IGZpbGUucHJvZ3Jlc3NfZXh0ZW5zaW9uX3N0YWxsX3NlY29uZHMgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5wcm9ncmVzc0V4dGVuc2lvblN0YWxsU2Vjb25kcztcbiAgaWYgKHByb2dyZXNzRXh0ZW5zaW9uR3JhbnRTZWNvbmRzIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgcHJvZ3Jlc3NfZXh0ZW5zaW9uX2dyYW50X3NlY29uZHMgbXVzdCBiZSBwb3NpdGl2ZSwgZ290IGAgK1xuICAgICAgICBgJHtwcm9ncmVzc0V4dGVuc2lvbkdyYW50U2Vjb25kc30uIEEgbm9uLXBvc2l0aXZlIGdyYW50IHdvdWxkIHJlLWFybSBgICtcbiAgICAgICAgYHRoZSBkZWFkbGluZSBpbiB0aGUgcGFzdCBhbmQgc3BpbiB0aGUgd2F0Y2hkb2cuYCxcbiAgICApO1xuICB9XG4gIGlmIChwcm9ncmVzc0V4dGVuc2lvblN0YWxsU2Vjb25kcyA8PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYHByb2dyZXNzX2V4dGVuc2lvbl9zdGFsbF9zZWNvbmRzIG11c3QgYmUgcG9zaXRpdmUsIGdvdCBgICtcbiAgICAgICAgYCR7cHJvZ3Jlc3NFeHRlbnNpb25TdGFsbFNlY29uZHN9LiBBIG5vbi1wb3NpdGl2ZSBzdGFsbCB3aW5kb3cgd291bGQgYCArXG4gICAgICAgIGB0cmVhdCBldmVyeSBydW4gYXMgaW5hY3RpdmUgYW5kIGtpbGwgaXQgb24gc2NoZWR1bGUuYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHByb2dyZXNzRXh0ZW5zaW9uQ2hlY2tTZWNvbmRzID0gZmlsZS5wcm9ncmVzc19leHRlbnNpb25fY2hlY2tfc2Vjb25kcyA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLnByb2dyZXNzRXh0ZW5zaW9uQ2hlY2tTZWNvbmRzO1xuICBpZiAocHJvZ3Jlc3NFeHRlbnNpb25DaGVja1NlY29uZHMgPD0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBwcm9ncmVzc19leHRlbnNpb25fY2hlY2tfc2Vjb25kcyBtdXN0IGJlIHBvc2l0aXZlLCBnb3QgYCArXG4gICAgICAgIGAke3Byb2dyZXNzRXh0ZW5zaW9uQ2hlY2tTZWNvbmRzfS4gQSBub24tcG9zaXRpdmUgaW50ZXJ2YWwgd291bGQgYCArXG4gICAgICAgIGBzcGluIHRoZSB3YXRjaGRvZyBpbnN0ZWFkIG9mIHNhbXBsaW5nIHRoZSB3b3JraW5nIHRyZWUuYCxcbiAgICApO1xuICB9XG4gIC8vIElzc3VlICMyOTYwOiB0aW1lb3V0IGZvciB0aGUgc2NyZWVuc2hvdCBnYXRlJ3Mgb25lIGV4dHJhIGluLXJ1biBhZ2VudFxuICAvLyB0dXJuLiBSZWplY3RlZCBsb3VkbHkgcmF0aGVyIHRoYW4gc2lsZW50bHkgaGFuZ2luZyBvciBmaXJpbmcgaW5zdGFudGx5LlxuICBjb25zdCBzY3JlZW5zaG90UmV0cnlUaW1lb3V0U2Vjb25kcyA9IGZpbGUuc2NyZWVuc2hvdF9yZXRyeV90aW1lb3V0X3NlY29uZHMgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5zY3JlZW5zaG90UmV0cnlUaW1lb3V0U2Vjb25kcztcbiAgaWYgKFxuICAgIHR5cGVvZiBzY3JlZW5zaG90UmV0cnlUaW1lb3V0U2Vjb25kcyAhPT0gXCJudW1iZXJcIiB8fFxuICAgICFOdW1iZXIuaXNGaW5pdGUoc2NyZWVuc2hvdFJldHJ5VGltZW91dFNlY29uZHMpIHx8XG4gICAgc2NyZWVuc2hvdFJldHJ5VGltZW91dFNlY29uZHMgPD0gMFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgc2NyZWVuc2hvdF9yZXRyeV90aW1lb3V0X3NlY29uZHMgbXVzdCBiZSBhIHBvc2l0aXZlIGZpbml0ZSBudW1iZXIsIGAgK1xuICAgICAgICBgZ290ICR7SlNPTi5zdHJpbmdpZnkoZmlsZS5zY3JlZW5zaG90X3JldHJ5X3RpbWVvdXRfc2Vjb25kcyl9YCxcbiAgICApO1xuICB9XG4gIC8vIElzc3VlICM0MTI4OiB0aW1lb3V0IGZvciB0aGUgcHJlLXB1c2ggZ2F0ZSdzIG9uZSBleHRyYSBpbi1ydW4gYWdlbnQgdHVybi5cbiAgLy8gUmVqZWN0ZWQgbG91ZGx5IHJhdGhlciB0aGFuIHNpbGVudGx5IGhhbmdpbmcgb3IgZmlyaW5nIGluc3RhbnRseS5cbiAgY29uc3QgcHJlUHVzaFJldHJ5VGltZW91dFNlY29uZHMgPSBmaWxlLnByZV9wdXNoX3JldHJ5X3RpbWVvdXRfc2Vjb25kcyA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLnByZVB1c2hSZXRyeVRpbWVvdXRTZWNvbmRzO1xuICBpZiAoXG4gICAgdHlwZW9mIHByZVB1c2hSZXRyeVRpbWVvdXRTZWNvbmRzICE9PSBcIm51bWJlclwiIHx8XG4gICAgIU51bWJlci5pc0Zpbml0ZShwcmVQdXNoUmV0cnlUaW1lb3V0U2Vjb25kcykgfHxcbiAgICBwcmVQdXNoUmV0cnlUaW1lb3V0U2Vjb25kcyA8PSAwXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBwcmVfcHVzaF9yZXRyeV90aW1lb3V0X3NlY29uZHMgbXVzdCBiZSBhIHBvc2l0aXZlIGZpbml0ZSBudW1iZXIsIGAgK1xuICAgICAgICBgZ290ICR7SlNPTi5zdHJpbmdpZnkoZmlsZS5wcmVfcHVzaF9yZXRyeV90aW1lb3V0X3NlY29uZHMpfWAsXG4gICAgKTtcbiAgfVxuICBpZiAocHJvZ3Jlc3NFeHRlbnNpb25TdGFsbFNlY29uZHMgPCBwcm9ncmVzc0V4dGVuc2lvbkNoZWNrU2Vjb25kcykge1xuICAgIC8vIFRoZSBkZWFkbGluZSBkZWNpc2lvbiByZWFkcyB0cmVlIGV2aWRlbmNlIHVwIHRvIG9uZSBjaGVjayBpbnRlcnZhbCBvbGQsXG4gICAgLy8gc28gYSBzaG9ydGVyIGFjdGl2aXR5IHdpbmRvdyBraWxscyBydW5zIHRoYXQgZGVtb25zdHJhYmx5IHByb2dyZXNzZWRcbiAgICAvLyBpbnNpZGUgdGhhdCBzYW1lIHdpbmRvdyAoSXNzdWUgIzQyOTUpLlxuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBwcm9ncmVzc19leHRlbnNpb25fc3RhbGxfc2Vjb25kcyBtdXN0IGJlIGF0IGxlYXN0IGAgK1xuICAgICAgICBgcHJvZ3Jlc3NfZXh0ZW5zaW9uX2NoZWNrX3NlY29uZHMsIGdvdCBgICtcbiAgICAgICAgYCR7cHJvZ3Jlc3NFeHRlbnNpb25TdGFsbFNlY29uZHN9IDwgJHtwcm9ncmVzc0V4dGVuc2lvbkNoZWNrU2Vjb25kc30uIGAgK1xuICAgICAgICBgQSBzdGFsbCB3aW5kb3cgc2hvcnRlciB0aGFuIHRoZSBjaGVjayBpbnRlcnZhbCB3b3VsZCBraWxsIGEgaGVhbHRoeSBgICtcbiAgICAgICAgYHJ1biB3aG9zZSB0b29sIGFjdGl2aXR5IGxhbmRlZCBiZXR3ZWVuIGNoZWNrcy5gLFxuICAgICk7XG4gIH1cbiAgLy8gQ2FsbC1zdG9ybSBzdGFsbCBndWFyZCAoSXNzdWUgIzIyMzApLiBPbiBieSBkZWZhdWx0OyB0aGUgdHVuYWJsZXMgYXJlXG4gIC8vIHJlZnVzZWQgbG91ZGx5IHJhdGhlciB0aGFuIHNpbGVudGx5IGRpc2FibGluZyB0aGUgZ3VhcmQgb3Igc3RvcHBpbmcgZXZlcnlcbiAgLy8gcnVuLCBleGFjdGx5IGFzIHRoZSBwcm9ncmVzcy1leHRlbnNpb24gdHVuYWJsZXMgYWJvdmUgYXJlLlxuICBjb25zdCBjYWxsU3Rvcm1FbmFibGVkID0gZmlsZS5jYWxsX3N0b3JtX2VuYWJsZWQgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5jYWxsU3Rvcm1FbmFibGVkO1xuICBjb25zdCBjYWxsU3Rvcm1DYWxscyA9IGZpbGUuY2FsbF9zdG9ybV9jYWxscyA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLmNhbGxTdG9ybUNhbGxzO1xuICBjb25zdCBjYWxsU3Rvcm1XaW5kb3dTZWNvbmRzID0gZmlsZS5jYWxsX3N0b3JtX3dpbmRvd19zZWNvbmRzID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuY2FsbFN0b3JtV2luZG93U2Vjb25kcztcbiAgY29uc3QgY2FsbFN0b3JtTm92ZWxTaGFyZSA9IGZpbGUuY2FsbF9zdG9ybV9ub3ZlbF9zaGFyZSA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLmNhbGxTdG9ybU5vdmVsU2hhcmU7XG4gIC8vIEEgc2hhcmUgb2YgMCBvciBsZXNzIGNhbiBuZXZlciBiZSB1bmRlcmN1dCwgc28gdGhlIGd1YXJkIHdvdWxkIG5ldmVyXG4gIC8vIGZpcmU7IGFib3ZlIDEgaXMgbm90IGEgc2hhcmUgYXQgYWxsIChJc3N1ZSAjMjc3MykuXG4gIGlmIChcbiAgICAhTnVtYmVyLmlzRmluaXRlKGNhbGxTdG9ybU5vdmVsU2hhcmUpIHx8IGNhbGxTdG9ybU5vdmVsU2hhcmUgPD0gMCB8fFxuICAgIGNhbGxTdG9ybU5vdmVsU2hhcmUgPiAxXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBjYWxsX3N0b3JtX25vdmVsX3NoYXJlIG11c3QgYmUgYWJvdmUgMCBhbmQgYXQgbW9zdCAxLCBnb3QgYCArXG4gICAgICAgIGAke2NhbGxTdG9ybU5vdmVsU2hhcmV9LiBBIHNoYXJlIG9mIDAgb3IgbGVzcyB3b3VsZCBuZXZlciBzdG9wIGEgYCArXG4gICAgICAgIGBydW4uIFNldCBjYWxsX3N0b3JtX2VuYWJsZWQ6IGZhbHNlIHRvIHR1cm4gdGhlIGd1YXJkIG9mZiBpbnN0ZWFkLmAsXG4gICAgKTtcbiAgfVxuICBpZiAoY2FsbFN0b3JtQ2FsbHMgPD0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBjYWxsX3N0b3JtX2NhbGxzIG11c3QgYmUgcG9zaXRpdmUsIGdvdCAke2NhbGxTdG9ybUNhbGxzfS4gQSBgICtcbiAgICAgICAgYG5vbi1wb3NpdGl2ZSB0aHJlc2hvbGQgd291bGQgc3RvcCBldmVyeSBydW4gdGhhdCByZWFjaGVkIGEgY2hlY2suIGAgK1xuICAgICAgICBgU2V0IGNhbGxfc3Rvcm1fZW5hYmxlZDogZmFsc2UgdG8gdHVybiB0aGUgZ3VhcmQgb2ZmIGluc3RlYWQuYCxcbiAgICApO1xuICB9XG4gIGlmIChjYWxsU3Rvcm1XaW5kb3dTZWNvbmRzIDw9IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgY2FsbF9zdG9ybV93aW5kb3dfc2Vjb25kcyBtdXN0IGJlIHBvc2l0aXZlLCBnb3QgYCArXG4gICAgICAgIGAke2NhbGxTdG9ybVdpbmRvd1NlY29uZHN9LiBBIG5vbi1wb3NpdGl2ZSB3aW5kb3cgaGFzIG5vIHJhdGUgdG8gYCArXG4gICAgICAgIGBtZWFzdXJlLiBTZXQgY2FsbF9zdG9ybV9lbmFibGVkOiBmYWxzZSB0byB0dXJuIHRoZSBndWFyZCBvZmYgaW5zdGVhZC5gLFxuICAgICk7XG4gIH1cbiAgLy8gVGhlIHRyYWNrZXIncyBoaXN0b3J5IGlzIHdoYXQgdGhlIGd1YXJkIGNhbiBzZWUgKElzc3VlICMyMjMwKS4gQSB3aW5kb3dcbiAgLy8gb3IgYSB0aHJlc2hvbGQgYmV5b25kIGl0IHdvdWxkIGJlIGFjY2VwdGVkIGFuZCB0aGVuIHF1aWV0bHkgdW5kZXItY291bnRcbiAgLy8gb3IgbmV2ZXIgZmlyZSwgd2hpY2ggaXMgdGhlIHNpbGVudCBmYWlsdXJlIHRoaXMgY29kZWJhc2UgcmVmdXNlcy5cbiAgY29uc3QgY2FsbFN0b3JtSGlzdG9yeVNlY29uZHMgPSBUT09MX0NBTExfSElTVE9SWV9NUyAvIDEwMDA7XG4gIGlmIChjYWxsU3Rvcm1XaW5kb3dTZWNvbmRzID4gY2FsbFN0b3JtSGlzdG9yeVNlY29uZHMpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgY2FsbF9zdG9ybV93aW5kb3dfc2Vjb25kcyBtdXN0IG5vdCBleGNlZWQgdGhlIGAgK1xuICAgICAgICBgJHtjYWxsU3Rvcm1IaXN0b3J5U2Vjb25kc31zIG9mIHRvb2wtY2FsbCBoaXN0b3J5IHRoZSBwcm9ncmVzcyBgICtcbiAgICAgICAgYHRyYWNrZXIgcmV0YWlucywgZ290ICR7Y2FsbFN0b3JtV2luZG93U2Vjb25kc30uIEEgd2lkZXIgd2luZG93IGAgK1xuICAgICAgICBgd291bGQgY291bnQgb25seSB0aGUgcGFydCBvZiBpdHNlbGYgdGhlIHRyYWNrZXIgc3RpbGwgcmVtZW1iZXJzLmAsXG4gICAgKTtcbiAgfVxuICBpZiAoY2FsbFN0b3JtQ2FsbHMgPiBUT09MX0NBTExfSElTVE9SWV9NQVgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgY2FsbF9zdG9ybV9jYWxscyBtdXN0IG5vdCBleGNlZWQgdGhlICR7VE9PTF9DQUxMX0hJU1RPUllfTUFYfSB0b29sIGAgK1xuICAgICAgICBgY2FsbHMgdGhlIHByb2dyZXNzIHRyYWNrZXIgcmV0YWlucywgZ290ICR7Y2FsbFN0b3JtQ2FsbHN9LiBBIGhpZ2hlciBgICtcbiAgICAgICAgYHRocmVzaG9sZCBjb3VsZCBuZXZlciBiZSByZWFjaGVkLCBzbyB0aGUgZ3VhcmQgd291bGQgbmV2ZXIgZmlyZS5gLFxuICAgICk7XG4gIH1cbiAgLy8gUXVvdGEtYXdhcmUgcG9sbGluZyBnYXRlIChJc3N1ZSAjMzYyOCkuIE9uIGJ5IGRlZmF1bHQ7IHRoZSBmbG9vcnMgYXJlXG4gIC8vIHJlZnVzZWQgbG91ZGx5IHJhdGhlciB0aGFuIHNpbGVudGx5IGRpc2FibGluZyBhIHRpZXIg4oCUIGEgbm9uLWludGVnZXIgb3JcbiAgLy8gbmVnYXRpdmUgZmxvb3IgaXMgbm90IGEgbnVtYmVyIG9mIHBvaW50cywgYW5kIGFuIGlkbGUgZmxvb3IgYWJvdmUgdGhlXG4gIC8vIHBhcmsgZmxvb3Igd291bGQgbmV2ZXIgYmUgcmVhY2hlZCBzbyB0aGUgaWRsZSB0aWVyIGNvdWxkIG5ldmVyIGRlZmVyLlxuICBjb25zdCBxdW90YVBvbGxQYXJrRmxvb3IgPSBmaWxlLnF1b3RhX3BvbGxfcGFya19mbG9vciA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLnF1b3RhUG9sbFBhcmtGbG9vcjtcbiAgY29uc3QgcXVvdGFQb2xsUGFya05pY2UgPSBmaWxlLnF1b3RhX3BvbGxfcGFya19uaWNlID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucXVvdGFQb2xsUGFya05pY2U7XG4gIGNvbnN0IHF1b3RhUG9sbElkbGVGbG9vciA9IGZpbGUucXVvdGFfcG9sbF9pZGxlX2Zsb29yID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucXVvdGFQb2xsSWRsZUZsb29yO1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIocXVvdGFQb2xsUGFya0Zsb29yKSB8fCBxdW90YVBvbGxQYXJrRmxvb3IgPCAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYHF1b3RhX3BvbGxfcGFya19mbG9vciBtdXN0IGJlIGEgd2hvbGUgbnVtYmVyIG9mIHBvaW50cyBhdCBvciBhYm92ZSBgICtcbiAgICAgICAgYDAsIGdvdCAke3F1b3RhUG9sbFBhcmtGbG9vcn0uIFNldCBpdCB0byAwIHRvIHR1cm4gdGhlIHBhcmsgdGllciBvZmYuYCxcbiAgICApO1xuICB9XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcihxdW90YVBvbGxQYXJrTmljZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgcXVvdGFfcG9sbF9wYXJrX25pY2UgbXVzdCBiZSBhIHdob2xlIG51bWJlciAoaXQgaXMgYSBuaWNlIGAgK1xuICAgICAgICBgY29tcGFyaXNvbiksIGdvdCAke3F1b3RhUG9sbFBhcmtOaWNlfS5gLFxuICAgICk7XG4gIH1cbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHF1b3RhUG9sbElkbGVGbG9vcikgfHwgcXVvdGFQb2xsSWRsZUZsb29yIDwgMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBxdW90YV9wb2xsX2lkbGVfZmxvb3IgbXVzdCBiZSBhIHdob2xlIG51bWJlciBvZiBwb2ludHMgYXQgb3IgYWJvdmUgYCArXG4gICAgICAgIGAwLCBnb3QgJHtxdW90YVBvbGxJZGxlRmxvb3J9LiBTZXQgaXQgdG8gMCB0byB0dXJuIHRoZSBpZGxlIHRpZXIgb2ZmLmAsXG4gICAgKTtcbiAgfVxuICBpZiAocXVvdGFQb2xsSWRsZUZsb29yID4gcXVvdGFQb2xsUGFya0Zsb29yKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYHF1b3RhX3BvbGxfaWRsZV9mbG9vciBtdXN0IG5vdCBleGNlZWQgcXVvdGFfcG9sbF9wYXJrX2Zsb29yLCBnb3QgYCArXG4gICAgICAgIGAke3F1b3RhUG9sbElkbGVGbG9vcn0gYWJvdmUgJHtxdW90YVBvbGxQYXJrRmxvb3J9LiBUaGUgaWRsZSB0aWVyIGAgK1xuICAgICAgICBgY291bGQgdGhlbiBuZXZlciBkZWZlciwgYmVjYXVzZSB0aGUgcGFyayBmbG9vciBpcyBjcm9zc2VkIGZpcnN0LiBgICtcbiAgICAgICAgYFNldCBib3RoIGZsb29ycyB0byAwIHRvIHR1cm4gdGhlIHBvbGxpbmcgZ2F0ZSBvZmYuYCxcbiAgICApO1xuICB9XG4gIC8vIE5pY2UtZGVyaXZlZCBwb2xsIGNhZGVuY2UgKElzc3VlICMzNjY3KS4gT24gYnkgZGVmYXVsdDsgYSBjYWRlbmNlIHRoYXRcbiAgLy8gaXMgbm90IGEgd2hvbGUgbnVtYmVyIG9mIGN5Y2xlcyBvZiBhdCBsZWFzdCAxIGlzIHJlZnVzZWQgbG91ZGx5IOKAlCAxIGlzXG4gIC8vIFwiZXZlcnkgY3ljbGVcIiwgdGhlIHdheSB0byB0dXJuIGEgdGllcidzIGNhZGVuY2Ugb2ZmLlxuICBjb25zdCBwb2xsQ2FkZW5jZUxvd0N5Y2xlcyA9IGZpbGUucG9sbF9jYWRlbmNlX2xvd19jeWNsZXMgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5wb2xsQ2FkZW5jZUxvd0N5Y2xlcztcbiAgY29uc3QgcG9sbENhZGVuY2VQYXJrQ3ljbGVzID0gZmlsZS5wb2xsX2NhZGVuY2VfcGFya19jeWNsZXMgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5wb2xsQ2FkZW5jZVBhcmtDeWNsZXM7XG4gIGZvciAoXG4gICAgY29uc3QgW2tleSwgdmFsdWVdIG9mIFtcbiAgICAgIFtcInBvbGxfY2FkZW5jZV9sb3dfY3ljbGVzXCIsIHBvbGxDYWRlbmNlTG93Q3ljbGVzXSxcbiAgICAgIFtcInBvbGxfY2FkZW5jZV9wYXJrX2N5Y2xlc1wiLCBwb2xsQ2FkZW5jZVBhcmtDeWNsZXNdLFxuICAgIF0gYXMgY29uc3RcbiAgKSB7XG4gICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8IDEpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYCR7a2V5fSBtdXN0IGJlIGEgd2hvbGUgbnVtYmVyIG9mIGN5Y2xlcyBhdCBvciBhYm92ZSAxLCBnb3QgYCArXG4gICAgICAgICAgYCR7dmFsdWV9LiBTZXQgaXQgdG8gMSB0byBwb2xsIHRoYXQgdGllciBldmVyeSBjeWNsZS5gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgLy8gU2VsZi1zY2hlZHVsaW5nIGZvciBhdXRvLWZpbGVkIHdvcmtlciBkaWFnbm9zdGljcyAoSXNzdWUgIzUwNSkuIE9uIGJ5XG4gIC8vIGRlZmF1bHQ7IGBmYWxzZWAgcmVzdG9yZXMgdGhlIHdhaXQtZm9yLWEtaHVtYW4gYmVoYXZpb3VyIGV4YWN0bHkuIFRoZVxuICAvLyBpbi1mbGlnaHQgY2FwIGlzIHJlZnVzZWQgbG91ZGx5IHdoZW4gaXQgaXMgbm90IGEgd2hvbGUgbnVtYmVyIOKAlCBhXG4gIC8vIGZyYWN0aW9uYWwgb3IgbmVnYXRpdmUgY2FwIHdvdWxkIHNpbGVudGx5IGRpc2FibGUgYSBmZWF0dXJlIHRoZSBvcGVyYXRvclxuICAvLyBiZWxpZXZlcyBpcyBvbi5cbiAgY29uc3Qgc2VsZlNjaGVkdWxlRGlhZ25vc3RpY3NFbmFibGVkID1cbiAgICBmaWxlLnNlbGZfc2NoZWR1bGVfZGlhZ25vc3RpY3NfZW5hYmxlZCA/P1xuICAgICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuc2VsZlNjaGVkdWxlRGlhZ25vc3RpY3NFbmFibGVkO1xuICBjb25zdCBzZWxmU2NoZWR1bGVEaWFnbm9zdGljc01heEluRmxpZ2h0ID1cbiAgICBmaWxlLnNlbGZfc2NoZWR1bGVfZGlhZ25vc3RpY3NfbWF4X2luX2ZsaWdodCA/P1xuICAgICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuc2VsZlNjaGVkdWxlRGlhZ25vc3RpY3NNYXhJbkZsaWdodDtcbiAgaWYgKFxuICAgICFOdW1iZXIuaXNJbnRlZ2VyKHNlbGZTY2hlZHVsZURpYWdub3N0aWNzTWF4SW5GbGlnaHQpIHx8XG4gICAgc2VsZlNjaGVkdWxlRGlhZ25vc3RpY3NNYXhJbkZsaWdodCA8IDBcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYHNlbGZfc2NoZWR1bGVfZGlhZ25vc3RpY3NfbWF4X2luX2ZsaWdodCBtdXN0IGJlIGEgbm9uLW5lZ2F0aXZlIGAgK1xuICAgICAgICBgaW50ZWdlciwgZ290ICR7c2VsZlNjaGVkdWxlRGlhZ25vc3RpY3NNYXhJbkZsaWdodH0uIFVzZSAwIHRvIHJlZnVzZSBgICtcbiAgICAgICAgYGV2ZXJ5IHNlbGYtc2NoZWR1bGVkIGRpYWdub3N0aWMsIG9yIGAgK1xuICAgICAgICBgc2VsZl9zY2hlZHVsZV9kaWFnbm9zdGljc19lbmFibGVkOiBmYWxzZSB0byB0dXJuIHRoZSBwYXRoIG9mZi5gLFxuICAgICk7XG4gIH1cblxuICAvLyBJc3N1ZSAjMTgyNDogZGlzdGluY3QgaGFyZCB0aW1lb3V0cyBmb3IgcmVhY3RpdmUgcGhhc2VzIOKAlCBQUiBmZWVkYmFja1xuICAvLyBhbmQgQ0kgZml4IHNob3VsZCBub3QgaW5oZXJpdCB0aGUgbGFyZ2VyIGlzc3VlLXdvcmsgYnVkZ2V0LiBGYWxscyBiYWNrXG4gIC8vIHRvIGNsYXVkZV90aW1lb3V0IGlmIGV4cGxpY2l0bHkgc2V0IGluIGNvbmZpZyAoYmFjay1jb21wYXQpLCB0aGVuIHRvXG4gIC8vIHRoZSBwaGFzZS1zcGVjaWZpYyBvcGVyYXRpb25hbCBkZWZhdWx0LlxuICBjb25zdCBwckZlZWRiYWNrVGltZW91dCA9IGZpbGUucHJfZmVlZGJhY2tfdGltZW91dCA/P1xuICAgIGZpbGUuY2xhdWRlX3RpbWVvdXQgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5wckZlZWRiYWNrVGltZW91dDtcbiAgY29uc3QgY2lGaXhUaW1lb3V0ID0gZmlsZS5jaV9maXhfdGltZW91dCA/P1xuICAgIGZpbGUuY2xhdWRlX3RpbWVvdXQgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5jaUZpeFRpbWVvdXQ7XG4gIGNvbnN0IGNsYXVkZUtpbGxBZnRlciA9IGZpbGUuY2xhdWRlX2tpbGxfYWZ0ZXIgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5jbGF1ZGVLaWxsQWZ0ZXI7XG4gIGNvbnN0IG1heENsYXJpZmljYXRpb25Sb3VuZHMgPSBmaWxlLm1heF9jbGFyaWZpY2F0aW9uX3JvdW5kcyA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLm1heENsYXJpZmljYXRpb25Sb3VuZHM7XG4gIGNvbnN0IHNsZWVwSW50ZXJ2YWwgPSBmaWxlLnNsZWVwX2ludGVydmFsID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuc2xlZXBJbnRlcnZhbDtcbiAgaWYgKFxuICAgIGZpbGUucHJfc2Nhbm5pbmdfZW5hYmxlZCAhPT0gdW5kZWZpbmVkICYmXG4gICAgdHlwZW9mIGZpbGUucHJfc2Nhbm5pbmdfZW5hYmxlZCAhPT0gXCJib29sZWFuXCJcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwicHJfc2Nhbm5pbmdfZW5hYmxlZCBtdXN0IGJlIGEgYm9vbGVhblwiKTtcbiAgfVxuICBjb25zdCBwclNjYW5uaW5nRW5hYmxlZCA9IGZpbGUucHJfc2Nhbm5pbmdfZW5hYmxlZCA/PyB0cnVlO1xuICBjb25zdCBtYXhDb25jdXJyZW50SXNzdWVzID0gZmlsZS5tYXhfY29uY3VycmVudF9pc3N1ZXMgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5tYXhDb25jdXJyZW50SXNzdWVzO1xuICBjb25zdCBjcmVkaXRXYWl0SW50ZXJ2YWwgPSBmaWxlLmNyZWRpdF93YWl0X2ludGVydmFsID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuY3JlZGl0V2FpdEludGVydmFsO1xuICBjb25zdCByZWZpbmVtZW50VGltZW91dCA9IGZpbGUucmVmaW5lbWVudF90aW1lb3V0ID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucmVmaW5lbWVudFRpbWVvdXQ7XG4gIGNvbnN0IHJlZmluZW1lbnRLaWxsQWZ0ZXIgPSBmaWxlLnJlZmluZW1lbnRfa2lsbF9hZnRlciA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLnJlZmluZW1lbnRLaWxsQWZ0ZXI7XG4gIGNvbnN0IHBsYW5uaW5nVGltZW91dCA9IGZpbGUucGxhbm5pbmdfdGltZW91dCA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLnBsYW5uaW5nVGltZW91dDtcbiAgY29uc3QgcGxhbm5pbmdLaWxsQWZ0ZXIgPSBmaWxlLnBsYW5uaW5nX2tpbGxfYWZ0ZXIgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5wbGFubmluZ0tpbGxBZnRlcjtcbiAgY29uc3QgcXVlc3Rpb25UaW1lb3V0ID0gZmlsZS5xdWVzdGlvbl90aW1lb3V0ID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucXVlc3Rpb25UaW1lb3V0O1xuICBjb25zdCBxdWVzdGlvbktpbGxBZnRlciA9IGZpbGUucXVlc3Rpb25fa2lsbF9hZnRlciA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLnF1ZXN0aW9uS2lsbEFmdGVyO1xuICBjb25zdCBjbGFyaWZpY2F0aW9uVGltZW91dCA9IGZpbGUuY2xhcmlmaWNhdGlvbl90aW1lb3V0ID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuY2xhcmlmaWNhdGlvblRpbWVvdXQ7XG4gIGNvbnN0IGNsYXJpZmljYXRpb25LaWxsQWZ0ZXIgPSBmaWxlLmNsYXJpZmljYXRpb25fa2lsbF9hZnRlciA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLmNsYXJpZmljYXRpb25LaWxsQWZ0ZXI7XG4gIGNvbnN0IG1heEdyaWxsTWVSb3VuZHMgPSBmaWxlLm1heF9ncmlsbF9tZV9yb3VuZHMgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5tYXhHcmlsbE1lUm91bmRzO1xuICBjb25zdCBncmlsbE1lVGltZW91dCA9IGZpbGUuZ3JpbGxfbWVfdGltZW91dCA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLmdyaWxsTWVUaW1lb3V0O1xuICBjb25zdCBncmlsbE1lS2lsbEFmdGVyID0gZmlsZS5ncmlsbF9tZV9raWxsX2FmdGVyID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuZ3JpbGxNZUtpbGxBZnRlcjtcbiAgLy8gUXVvcnVtIGJvdW5kcyBhbmQgcHJvdmlkZXIgdHJpbyAoSXNzdWUgIzQxMTIpLiBBIGNvbmZpZ3VyZWQgcGxhbm5lciBsaXN0XG4gIC8vIHRoYXQgaXMgbm90IGV4YWN0bHkgdHdvIGlkcyBpcyByZWplY3RlZCBsb3VkbHkgcmF0aGVyIHRoYW4gcGFkZGVkIG9yXG4gIC8vIHRydW5jYXRlZCDigJQgYSBvbmUtc2lkZWQgXCJxdW9ydW1cIiB3b3VsZCBoYXZlIG5vdGhpbmcgdG8ganVkZ2UgKCMzMjM0KS5cbiAgY29uc3QgcXVvcnVtVGltZW91dCA9IGZpbGUucXVvcnVtX3RpbWVvdXQgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5xdW9ydW1UaW1lb3V0O1xuICBjb25zdCBxdW9ydW1LaWxsQWZ0ZXIgPSBmaWxlLnF1b3J1bV9raWxsX2FmdGVyID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucXVvcnVtS2lsbEFmdGVyO1xuICBjb25zdCBxdW9ydW1QbGFubmVycyA9IGZpbGUucXVvcnVtX3BsYW5uZXJzID8/IGRlZmF1bHRRdW9ydW1QbGFubmVycygpO1xuICBpZiAocXVvcnVtUGxhbm5lcnMubGVuZ3RoICE9PSAyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYHF1b3J1bV9wbGFubmVycyBtdXN0IG5hbWUgZXhhY3RseSB0d28gZHJhZnRpbmcgcHJvdmlkZXJzLCBnb3QgYCArXG4gICAgICAgIGAke3F1b3J1bVBsYW5uZXJzLmxlbmd0aH0uIFF1b3J1bSBqdWRnZXMgdHdvIHBsYW5zIGFnYWluc3QgZWFjaCBvdGhlci5gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcXVvcnVtSnVkZ2UgPSBmaWxlLnF1b3J1bV9qdWRnZSA/PyBkZWZhdWx0UXVvcnVtSnVkZ2UoKTtcbiAgY29uc3QgbWF4UmF0ZUxpbWl0UmV0cmllcyA9IGZpbGUubWF4X3JhdGVfbGltaXRfcmV0cmllcyA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLm1heFJhdGVMaW1pdFJldHJpZXM7XG4gIGNvbnN0IG1heFJhdGVMaW1pdFdhaXQgPSBmaWxlLm1heF9yYXRlX2xpbWl0X3dhaXQgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5tYXhSYXRlTGltaXRXYWl0O1xuICAvLyBJc3N1ZSAjMTQ1MzogaG93IGxvbmcgdGhlIHRydXN0ZWQtYXV0aG9yIHNuYXBzaG90IGlzIHJldXNlZC4gQm91bmRlZCBhdCBhXG4gIC8vIGRheSDigJQgYSByZXZva2VkIGNvbGxhYm9yYXRvciBtdXN0IG5vdCBzdGF5IHRydXN0ZWQgbG9uZ2VyIHRoYW4gdGhhdCDigJQgYW5kXG4gIC8vIGAwYCBrZWVwcyB0aGUgcGVyLWN5Y2xlIHJlZnJlc2ggZm9yIGEgZGVwbG95bWVudCB0aGF0IHdhbnRzIGl0LlxuICBjb25zdCB0cnVzdGVkQXV0aG9yc0NhY2hlSG91cnMgPSBmaWxlLnRydXN0ZWRfYXV0aG9yc19jYWNoZV9ob3VycyA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLnRydXN0ZWRBdXRob3JzQ2FjaGVIb3VycztcbiAgaWYgKFxuICAgIHR5cGVvZiB0cnVzdGVkQXV0aG9yc0NhY2hlSG91cnMgIT09IFwibnVtYmVyXCIgfHxcbiAgICAhTnVtYmVyLmlzRmluaXRlKHRydXN0ZWRBdXRob3JzQ2FjaGVIb3VycykgfHxcbiAgICB0cnVzdGVkQXV0aG9yc0NhY2hlSG91cnMgPCAwIHx8IHRydXN0ZWRBdXRob3JzQ2FjaGVIb3VycyA+IDI0XG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGB0cnVzdGVkX2F1dGhvcnNfY2FjaGVfaG91cnMgbXVzdCBiZSBhIG51bWJlciBiZXR3ZWVuIDAgYW5kIDI0LCBnb3QgYCArXG4gICAgICAgIGAke0pTT04uc3RyaW5naWZ5KGZpbGUudHJ1c3RlZF9hdXRob3JzX2NhY2hlX2hvdXJzKX1gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcmV0cnlNYXhEZWxheSA9IGZpbGUucmV0cnlfbWF4X2RlbGF5ID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucmV0cnlNYXhEZWxheTtcbiAgY29uc3QgbWF4SXNzdWVCb2R5VG9rZW5zID0gZmlsZS5tYXhfaXNzdWVfYm9keV90b2tlbnMgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5tYXhJc3N1ZUJvZHlUb2tlbnM7XG4gIGNvbnN0IHN1bW1hcmlzZVRpbWVvdXQgPSBmaWxlLnN1bW1hcmlzZV90aW1lb3V0ID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuc3VtbWFyaXNlVGltZW91dDtcbiAgY29uc3Qgc3VtbWFyaXNlS2lsbEFmdGVyID0gZmlsZS5zdW1tYXJpc2Vfa2lsbF9hZnRlciA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLnN1bW1hcmlzZUtpbGxBZnRlcjtcbiAgY29uc3QgZmVhdHVyZUNoZWNrVGltZW91dCA9IGZpbGUuZmVhdHVyZV9jaGVja190aW1lb3V0ID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuZmVhdHVyZUNoZWNrVGltZW91dDtcbiAgY29uc3QgY2xhdWRlTm9PdXRwdXRUaW1lb3V0ID0gZmlsZS5jbGF1ZGVfbm9fb3V0cHV0X3RpbWVvdXQgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5jbGF1ZGVOb091dHB1dFRpbWVvdXQ7XG4gIGNvbnN0IHF1YWxpdHlDaGVja1RpbWVvdXQgPSBmaWxlLnF1YWxpdHlfY2hlY2tfdGltZW91dCA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLnF1YWxpdHlDaGVja1RpbWVvdXQ7XG5cbiAgLy8gSGVhbHRoIGNoZWNrIGNhY2hlIFRUTCAoSXNzdWUgIzEwNzApXG4gIGNvbnN0IGhlYWx0aENhY2hlVHRsID0gZmlsZS5oZWFsdGhfY2FjaGVfdHRsID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuaGVhbHRoQ2FjaGVUdGw7XG5cbiAgLy8gUmVwb3NpdG9yeSBzY2FubmluZyBvcmRlciAoSXNzdWUgIzQzNSlcbiAgY29uc3Qgc2h1ZmZsZVJlcG9zID0gZmlsZS5zaHVmZmxlX3JlcG9zID8/IERFRkFVTFRfU0hVRkZMRV9SRVBPUztcblxuICAvLyBXb3JrZXIgbmFtZSBmb3IgbXVsdGktd29ya2VyIHZpc2liaWxpdHkgKElzc3VlICM0MzYpXG4gIGNvbnN0IHdvcmtlck5hbWUgPSBmaWxlLndvcmtlcl9uYW1lID8/IERFRkFVTFRfV09SS0VSX05BTUU7XG5cbiAgLy8gTW9kZWwgZmFsbGJhY2sgb24gcmF0ZSBsaW1pdCAoSXNzdWUgIzExMTMpXG4gIGNvbnN0IGVuYWJsZU1vZGVsRmFsbGJhY2sgPSBmaWxlLmVuYWJsZV9tb2RlbF9mYWxsYmFjayA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLmVuYWJsZU1vZGVsRmFsbGJhY2s7XG5cbiAgLy8gTWluaW11bSBmcmVlIGRpc2sgc3BhY2UgYmVmb3JlIGxhcmdlIGdpdCBvcGVyYXRpb25zIChJc3N1ZSAjMTE3NClcbiAgY29uc3QgbWluRGlza1NwYWNlTWIgPSBmaWxlLm1pbl9kaXNrX3NwYWNlX21iID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMubWluRGlza1NwYWNlTWI7XG5cbiAgLy8gVGhlIGNsYWltaW5nIGZsb29yJ3MgdHdvIHRlcm1zIChJc3N1ZSAjNzMyKS4gRGVsaWJlcmF0ZWx5ICpub3QqIGRlZmF1bHRlZFxuICAvLyBoZXJlOiBgcmVzb2x2ZURpc2tGbG9vcnNgIGFwcGxpZXMgdGhlIGRlZmF1bHRzLCBzbyBhbiB1bnNldCBrZXkgZmFsbHNcbiAgLy8gdGhyb3VnaCB0byB0aGUgZW52aXJvbm1lbnQgb3ZlcnJpZGUgYW5kIHRoZW4gdG8gREVGQVVMVF9MT1dfRkxPT1JfKixcbiAgLy8gcmF0aGVyIHRoYW4gdGhpcyBmaWxlIHJlc3RhdGluZyBhIG51bWJlciB0aGF0IHdvdWxkIHRoZW4gZHJpZnQuXG4gIGNvbnN0IGhvc3REaXNrTG93Rmxvb3JHYiA9IGZpbGUuaG9zdF9kaXNrX2xvd19mbG9vcl9nYjtcbiAgY29uc3QgaG9zdERpc2tMb3dGbG9vclBlcmNlbnQgPSBmaWxlLmhvc3RfZGlza19sb3dfZmxvb3JfcGVyY2VudDtcblxuICAvLyBQZXJpb2RpYyBtaWxlc3RvbmUgYnJhbmNoIHN5bmMgKElzc3VlICMxMjM4KVxuICBjb25zdCBzeW5jTWlsZXN0b25lQnJhbmNoZXMgPSBmaWxlLnN5bmNfbWlsZXN0b25lX2JyYW5jaGVzID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuc3luY01pbGVzdG9uZUJyYW5jaGVzO1xuXG4gIC8vIFN0YWxlIHdvcmtmbG93IHRocmVzaG9sZHMgKElzc3VlICMxMjQwLCAjMjAzMSDigJQgbmVlZHMtY2xhcmlmaWNhdGlvbiByZXRpcmVkKVxuICBjb25zdCBzdGFsZUZhaWxlZERpYWdub3N0aWNEYXlzID0gZmlsZS5zdGFsZV9mYWlsZWRfZGlhZ25vc3RpY19kYXlzID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuc3RhbGVGYWlsZWREaWFnbm9zdGljRGF5cztcbiAgY29uc3Qgc3RhbGVQbGFubmluZ1dhcm5pbmdEYXlzID0gZmlsZS5zdGFsZV9wbGFubmluZ193YXJuaW5nX2RheXMgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5zdGFsZVBsYW5uaW5nV2FybmluZ0RheXM7XG5cbiAgLy8gUGVyLXJlcG9zaXRvcnkgZmFzdC1mYWlsdXJlIGJhY2stb2ZmIChJc3N1ZSAjMTk1MClcbiAgY29uc3QgZmFzdEZhaWx1cmVTZWNvbmRzID0gZmlsZS5mYXN0X2ZhaWx1cmVfc2Vjb25kcyA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLmZhc3RGYWlsdXJlU2Vjb25kcztcbiAgY29uc3QgcmVwb0Zhc3RGYWlsdXJlVGhyZXNob2xkID0gZmlsZS5yZXBvX2Zhc3RfZmFpbHVyZV90aHJlc2hvbGQgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5yZXBvRmFzdEZhaWx1cmVUaHJlc2hvbGQ7XG4gIGNvbnN0IHJlcG9GYXN0RmFpbHVyZVdpbmRvd0hvdXJzID0gZmlsZS5yZXBvX2Zhc3RfZmFpbHVyZV93aW5kb3dfaG91cnMgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5yZXBvRmFzdEZhaWx1cmVXaW5kb3dIb3VycztcblxuICBjb25zdCB0aWVyTW9kZWxzID0gbW9kZWxUaWVyT3ZlcnJpZGVzKFxuICAgIGZpbGUucGhhc2VfbW9kZWxfdGllcnMsXG4gICAgZmlsZS5wcm92aWRlcl9tb2RlbF90aWVycyxcbiAgICBQUk9WSURFUl9NT0RFTF9USUVSUyxcbiAgKTtcblxuICAvLyBQaGFzZS1zcGVjaWZpYyBtb2RlbCBvdmVycmlkZXMgKElzc3VlICMxMjY1KVxuICBjb25zdCBwaGFzZU1vZGVsT3ZlcnJpZGVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgIC4uLnRpZXJNb2RlbHMuY2xhdWRlLFxuICAgIC4uLihmaWxlLnBoYXNlX21vZGVsX292ZXJyaWRlcyA/PyB7fSksXG4gIH07XG5cbiAgLy8gUGhhc2Utc3BlY2lmaWMgZWZmb3J0IG92ZXJyaWRlcyAoSXNzdWUgIzE0MDMpXG4gIGNvbnN0IHBoYXNlRWZmb3J0T3ZlcnJpZGVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID1cbiAgICBmaWxlLnBoYXNlX2VmZm9ydF9vdmVycmlkZXMgPz8ge307XG5cbiAgLy8gUGhhc2Utc3BlY2lmaWMgQ29kZXggbW9kZWwvZWZmb3J0IG92ZXJyaWRlcyAoSXNzdWUgIzM2MylcbiAgY29uc3QgY29kZXhQaGFzZU1vZGVsT3ZlcnJpZGVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgIC4uLnRpZXJNb2RlbHMuY29kZXgsXG4gICAgLi4uKGZpbGUuY29kZXhfcGhhc2VfbW9kZWxfb3ZlcnJpZGVzID8/IHt9KSxcbiAgfTtcbiAgY29uc3QgY29kZXhQaGFzZUVmZm9ydE92ZXJyaWRlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9XG4gICAgZmlsZS5jb2RleF9waGFzZV9lZmZvcnRfb3ZlcnJpZGVzID8/IHt9O1xuXG4gIC8vIFBoYXNlLXNwZWNpZmljIEdlbWluaSBtb2RlbCBvdmVycmlkZXMgKElzc3VlICMzNjQpXG4gIGNvbnN0IGdlbWluaVBoYXNlTW9kZWxPdmVycmlkZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgLi4udGllck1vZGVscy5nZW1pbmksXG4gICAgLi4uKGZpbGUuZ2VtaW5pX3BoYXNlX21vZGVsX292ZXJyaWRlcyA/PyB7fSksXG4gIH07XG5cbiAgLy8gUGhhc2Utc3BlY2lmaWMgRGVlcFNlZWsgbW9kZWwgb3ZlcnJpZGVzIChJc3N1ZSAjNDEzKVxuICBjb25zdCBkZWVwc2Vla1BoYXNlTW9kZWxPdmVycmlkZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgLi4udGllck1vZGVscy5kZWVwc2VlayxcbiAgICAuLi4oZmlsZS5kZWVwc2Vla19waGFzZV9tb2RlbF9vdmVycmlkZXMgPz8ge30pLFxuICB9O1xuXG4gIC8vIElzc3VlLWV4ZWN1dG9yIHNwbGl0LCBob3N0LXdpZGUgKElzc3VlICMyMzQxKS4gQSBgcmVwb19jb25maWdgIGVudHJ5IG9mXG4gIC8vIHRoZSBzYW1lIG5hbWUgb3ZlcnJpZGVzIGl0IHBlciByZXBvc2l0b3J5LlxuICBjb25zdCBpc3N1ZUV4ZWN1dG9yU3BsaXQgPSBmaWxlLmlzc3VlX2V4ZWN1dG9yX3NwbGl0ID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuaXNzdWVFeGVjdXRvclNwbGl0O1xuXG4gIC8vIElzc3VlIHN1Yi1hZ2VudCB0aWVyLCBob3N0LXdpZGUgKElzc3VlICMzNDAxKS4gQSBgcmVwb19jb25maWdgIGVudHJ5IG9mXG4gIC8vIHRoZSBzYW1lIG5hbWUgb3ZlcnJpZGVzIGl0IHBlciByZXBvc2l0b3J5LlxuICBjb25zdCBpc3N1ZVN1YkFnZW50VGllciA9IHJlc29sdmVIb3N0SXNzdWVTdWJBZ2VudFRpZXIoXG4gICAgZmlsZS5pc3N1ZV9zdWJfYWdlbnRfdGllcixcbiAgKTtcblxuICAvLyBSZXZpZXdlciBzdWItYWdlbnRzLCBob3N0LXdpZGUgb25seSAoSXNzdWUgIzI1NzUpLlxuICBjb25zdCBpc3N1ZVJldmlld2VyQWdlbnRzID0gZmlsZS5pc3N1ZV9yZXZpZXdlcl9hZ2VudHMgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5pc3N1ZVJldmlld2VyQWdlbnRzO1xuXG4gIC8vIEV4dGVybmFsIG9yY2hlc3RyYXRvciwgaG9zdC13aWRlIG9ubHkgKElzc3VlICMzNjQyKS4gT2ZmIGJ5IGRlZmF1bHQsIHNvXG4gIC8vIGFuIHVuY29uZmlndXJlZCBob3N0IGtlZXBzIHRoZSBDbGF1ZGUtbmF0aXZlIGAtLWFnZW50c2AgcGF0aC5cbiAgY29uc3QgZXh0ZXJuYWxPcmNoZXN0cmF0aW9uID0gZmlsZS5leHRlcm5hbF9vcmNoZXN0cmF0aW9uID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuZXh0ZXJuYWxPcmNoZXN0cmF0aW9uO1xuICBpZiAodHlwZW9mIGV4dGVybmFsT3JjaGVzdHJhdGlvbiAhPT0gXCJib29sZWFuXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgZXh0ZXJuYWxfb3JjaGVzdHJhdGlvbiBtdXN0IGJlIHRydWUgb3IgZmFsc2UsIGdvdCBgICtcbiAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoZmlsZS5leHRlcm5hbF9vcmNoZXN0cmF0aW9uKX1gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgZXh0ZXJuYWxPcmNoZXN0cmF0aW9uU2V0dGluZ3MgPSBwYXJzZU9yY2hlc3RyYXRpb25TZXR0aW5ncyhcbiAgICBmaWxlLmV4dGVybmFsX29yY2hlc3RyYXRpb25fc2V0dGluZ3MsXG4gICk7XG5cbiAgLy8gRmxlZXQtd2lkZSBydW4gYXJjaGl2ZSByZXBvIHNsdWcgZm9yIG1lYXN1cmVtZW50IGlzc3VlcyAoSXNzdWUgIzI5MzApLlxuICAvLyBVbnNldCAob3IgYmxhbmspIGxlYXZlcyB0aGUgZmVhdHVyZSBvZmYuXG4gIGNvbnN0IGZsZWV0UnVuQXJjaGl2ZVRyaW1tZWQgPSBmaWxlLmZsZWV0X3J1bl9hcmNoaXZlPy50cmltKCk7XG4gIGNvbnN0IGZsZWV0UnVuQXJjaGl2ZSA9IGZsZWV0UnVuQXJjaGl2ZVRyaW1tZWQgPT09IFwiXCIgfHxcbiAgICAgIGZsZWV0UnVuQXJjaGl2ZVRyaW1tZWQgPT09IHVuZGVmaW5lZFxuICAgID8gdW5kZWZpbmVkXG4gICAgOiBmbGVldFJ1bkFyY2hpdmVUcmltbWVkO1xuXG4gIC8vIFZhbGlkYXRlZCB2ZXJiYXRpbTsgd2hpdGVzcGFjZSBpcyByZWZ1c2VkIChJc3N1ZSAjMzc1MikuXG4gIGNvbnN0IHN1YnNjcmlwdGlvbkFsbG9jYXRpb25MYWJlbCA9IGZpbGUuc3Vic2NyaXB0aW9uX2FsbG9jYXRpb25fbGFiZWw7XG5cbiAgLy8gU2Vzc2lvbiByZXN1bWUgZm9yIG11bHRpLXBoYXNlIGlzc3VlIHByb2Nlc3NpbmcgKElzc3VlICMxMzI0KVxuICBjb25zdCBlbmFibGVTZXNzaW9uUmVzdW1lID0gZmlsZS5lbmFibGVfc2Vzc2lvbl9yZXN1bWUgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5lbmFibGVTZXNzaW9uUmVzdW1lO1xuXG4gIC8vIFZlcmJvc2l0eSBsZXZlbCAoSXNzdWUgIzEzMzApXG4gIGNvbnN0IHZlcmJvc2l0eTogVmVyYm9zaXR5TGV2ZWwgPVxuICAgIChmaWxlLnZlcmJvc2l0eSBhcyBWZXJib3NpdHlMZXZlbCB8IHVuZGVmaW5lZCkgPz8gREVGQVVMVF9WRVJCT1NJVFk7XG5cbiAgLy8gQ29udGV4dCBidWRnZXQgbW9uaXRvcmluZyB0aHJlc2hvbGRzIChJc3N1ZSAjMTMyNylcbiAgY29uc3QgY29udGV4dEJ1ZGdldFdhcm5pbmdQZXJjZW50ID0gZmlsZS5jb250ZXh0X2J1ZGdldF93YXJuaW5nX3BlcmNlbnQgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5jb250ZXh0QnVkZ2V0V2FybmluZ1BlcmNlbnQ7XG4gIGNvbnN0IGNvbnRleHRCdWRnZXRFcnJvclBlcmNlbnQgPSBmaWxlLmNvbnRleHRfYnVkZ2V0X2Vycm9yX3BlcmNlbnQgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5jb250ZXh0QnVkZ2V0RXJyb3JQZXJjZW50O1xuICAvLyBIYXJkIGNvbnRleHQtYnVkZ2V0IGNlaWxpbmcgKElzc3VlICMzNzEzKVxuICBjb25zdCBjb250ZXh0QnVkZ2V0QmxvY2tQZXJjZW50ID0gZmlsZS5jb250ZXh0X2J1ZGdldF9ibG9ja19wZXJjZW50ID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuY29udGV4dEJ1ZGdldEJsb2NrUGVyY2VudDtcblxuICAvLyBVbnRydXN0ZWQgY29tbWVudCBpbmNsdXNpb24gKElzc3VlICMxMzQwKVxuICBjb25zdCBpbmNsdWRlVW50cnVzdGVkQ29tbWVudHMgPSBmaWxlLmluY2x1ZGVfdW50cnVzdGVkX2NvbW1lbnRzID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuaW5jbHVkZVVudHJ1c3RlZENvbW1lbnRzO1xuXG4gIC8vIENsb3NlZCBQUiBjb29sZG93biAoSXNzdWUgIzE0MjcpXG4gIGNvbnN0IGNsb3NlZFByQ29vbGRvd25TZWNvbmRzID0gZmlsZS5jbG9zZWRfcHJfY29vbGRvd25fc2Vjb25kcyA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLmNsb3NlZFByQ29vbGRvd25TZWNvbmRzO1xuXG4gIC8vIFVuYXNzaWduIHdvcmtlciBhZnRlciBzdWNjZXNzZnVsIFBSIGNyZWF0aW9uIChJc3N1ZSAjMTQ1MylcbiAgY29uc3QgdW5hc3NpZ25PblByQ3JlYXRlZCA9IGZpbGUudW5hc3NpZ25fb25fcHJfY3JlYXRlZCA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLnVuYXNzaWduT25QckNyZWF0ZWQ7XG5cbiAgLy8gU3RhbGUgd29yayBkaXJlY3RvcnkgYWdlIHRocmVzaG9sZCAoSXNzdWUgIzE0OTMpXG4gIGNvbnN0IHN0YWxlV29ya0RpckRheXMgPSBmaWxlLnN0YWxlX3dvcmtfZGlyX2RheXMgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5zdGFsZVdvcmtEaXJEYXlzO1xuXG4gIC8vIFNvZnR3YXJlIHVwZGF0ZSByZXRyeSBzZXR0aW5ncyAoSXNzdWUgIzE0OTYpXG4gIGNvbnN0IHVwZGF0ZVJldHJ5TWF4QXR0ZW1wdHMgPSBmaWxlLnVwZGF0ZV9yZXRyeV9tYXhfYXR0ZW1wdHMgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy51cGRhdGVSZXRyeU1heEF0dGVtcHRzO1xuICBjb25zdCB1cGRhdGVSZXRyeUJhY2tvZmZTZWNvbmRzID0gZmlsZS51cGRhdGVfcmV0cnlfYmFja29mZl9zZWNvbmRzID8/XG4gICAgWy4uLk9QRVJBVElPTkFMX0RFRkFVTFRTLnVwZGF0ZVJldHJ5QmFja29mZlNlY29uZHNdO1xuXG4gIC8vIFRyZWF0IHBvc3QtQ2xhdWRlIHF1YWxpdHkgZmFpbHVyZXMgYXMgcGFzc2VkIHdoZW4gbm8gbmV3IGZpbmRpbmdzIHZzIGJhc2VsaW5lIChJc3N1ZSAjMTU0OSlcbiAgY29uc3QgYmFzZWxpbmVBd2FyZVF1YWxpdHlHYXRlID0gZmlsZS5iYXNlbGluZV9hd2FyZV9xdWFsaXR5X2dhdGUgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5iYXNlbGluZUF3YXJlUXVhbGl0eUdhdGU7XG5cbiAgLy8gSW4tcHJvY2VzcyByZXRyeSBiYWNrb2ZmIGZvciBpbmZyYXN0cnVjdHVyZS1jYXRlZ29yeSBwaGFzZSBmYWlsdXJlcyAoSXNzdWUgIzE1NTApXG4gIGNvbnN0IGluZnJhUmV0cnlCYWNrb2ZmTXMgPSBmaWxlLmluZnJhX3JldHJ5X2JhY2tvZmZfbXMgPz9cbiAgICBPUEVSQVRJT05BTF9ERUZBVUxUUy5pbmZyYVJldHJ5QmFja29mZk1zO1xuXG4gIC8vIEF1dG8tZml4IGF0dGVtcHQgY2FwIHBlciBmYWlsdXJlIHNpZ25hdHVyZSAoSXNzdWUgIzM1ODIpXG4gIGNvbnN0IG1heEF1dG9GaXhBdHRlbXB0cyA9IGZpbGUubWF4X2F1dG9fZml4X2F0dGVtcHRzID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMubWF4QXV0b0ZpeEF0dGVtcHRzO1xuXG4gIC8vIEJsb2NraW5nLVBSIHN0YWxsIHdhdGNoZG9nIHRocmVzaG9sZCAoSXNzdWUgIzQwMjUpLiBMZWZ0IHVuZGVmaW5lZCB3aGVuXG4gIC8vIHVuc2V0IHNvIGByZXNvbHZlQmxvY2tpbmdQclN0YWxsVGhyZXNob2xkU2Vjb25kc2AgYXBwbGllcyBpdHMgZGVmYXVsdC5cbiAgY29uc3QgYmxvY2tpbmdQclN0YWxsVGhyZXNob2xkU2Vjb25kcyA9XG4gICAgZmlsZS5ibG9ja2luZ19wcl9zdGFsbF90aHJlc2hvbGRfc2Vjb25kcztcblxuICAvLyBGbGVldCBQUiBjYXAgb24gdGhlIGRlZmF1bHQtYnJhbmNoIHN0cmVhbSAoSXNzdWUgIzI2NjMpLiBMZWZ0IHVuZGVmaW5lZFxuICAvLyB3aGVuIHVuc2V0IHNvIGByZXNvbHZlRmxlZXRQclNsb3RzYCBhcHBsaWVzIGl0cyBkb2N1bWVudGVkIGRlZmF1bHQuXG4gIGNvbnN0IGZsZWV0UHJTbG90cyA9IGZpbGUuZmxlZXRfcHJfc2xvdHM7XG5cbiAgLy8gUGVyLXRlbXBsYXRlIHdlaWdodHMgZm9yIHRoZSBpZGxlLXRhc2sgZHJhdyAoSXNzdWUgIzI0MDEpXG4gIGNvbnN0IGlkbGVUYXNrVGVtcGxhdGVXZWlnaHRzOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID1cbiAgICBmaWxlLmlkbGVfdGFza190ZW1wbGF0ZV93ZWlnaHRzID8/IHt9O1xuXG4gIC8vIENhZGVuY2UgZmxvb3IgZm9yIHRoZSBpbXBvcnRhbnQgaWRsZS10YXNrIHRlbXBsYXRlcyAoSXNzdWVzICM0MDAzLCAjNDAxMSkuXG4gIC8vIFdhcm4tYW5kLWZhbGwtYmFjazogYSBtYWxmb3JtZWQgYmxvY2sgbmV2ZXIgc3RvcHMgdGhlIHdvcmtlci5cbiAgY29uc3QgaWRsZVRhc2tDYWRlbmNlID0gcGFyc2VJZGxlVGFza0NhZGVuY2UoZmlsZS5pZGxlX3Rhc2tfY2FkZW5jZSk7XG5cbiAgLy8gUGVyLXRvb2wgbWluaW11bSB2ZXJzaW9uIGZsb29ycyBmb3Igc29mdHdhcmUgYXV0by11cGRhdGUgKElzc3VlICMyNjIyKVxuICBjb25zdCBzb2Z0d2FyZU1pblZlcnNpb25zOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID1cbiAgICBmaWxlLnNvZnR3YXJlX21pbl92ZXJzaW9ucyA/P1xuICAgICAgeyAuLi5PUEVSQVRJT05BTF9ERUZBVUxUUy5zb2Z0d2FyZU1pblZlcnNpb25zIH07XG5cbiAgLy8gQ3VzdG9tIGxhYmVsIOKGkiBub24tcHVibGljIHByb21wdCBmaWxlIG1hcHBpbmdzIChJc3N1ZSAjODQ2LCBwYXJ0IG9mXG4gIC8vICM4NDMpLiBGYWlsIGxvdWQ6IGFzc2VydEN1c3RvbUxhYmVsUHJvbXB0cyB0aHJvd3MgbmFtaW5nIHRoZSBvZmZlbmRpbmdcbiAgLy8gZW50cnkgcmF0aGVyIHRoYW4gc2lsZW50bHkgZHJvcHBpbmcgYSBtYXBwaW5nIOKAlCBhIHNpbGVudGx5IGlnbm9yZWRcbiAgLy8gbWFwcGluZyBpcyBleGFjdGx5IHRoZSBmYWlsdXJlICM4NDMgcnVsZXMgb3V0LlxuICAvL1xuICAvLyBJc3N1ZSAjODQ5OiB0aGUgY29uZmlndXJlZCBsYWJlbCBuYW1lcyBkZWNpZGUgd2hpY2ggZW50cmllcyBhcmUgb3ZlcnJpZGVzXG4gIC8vIG9mIGEgYnVpbHQtaW4gcGhhc2UsIHNvIHRoZXkgYXJlIHBhc3NlZCBpbiByYXRoZXIgdGhhbiBhc3N1bWVkLlxuICAvL1xuICAvLyBJbiBjb250YWluZXIgbW9kZSB0aGUgY29uZmlndXJlZCBwYXRocyBhcmUgKmhvc3QqIHBhdGhzIHRoZSBjb250YWluZXJcbiAgLy8gY2Fubm90IHNlZSwgc28gdGhlIGxhdW5jaGVyIGhhbmRzIG92ZXIgd2hlcmUgaXQgbW91bnRlZCBlYWNoIG9uZVxuICAvLyAoSXNzdWUgIzg1MCkgYW5kIHRoZSBtYXBwaW5nIHJlc29sdmVzIG9udG8gdGhhdC4gQSByZWFkIG91dHNpZGUgdGhlXG4gIC8vIGNvbnRhaW5lciDigJQgdGhlIGxhdW5jaGVyJ3Mgb3duLCBzZXR1cCwgYSBkZXYgcnVuIOKAlCBzZXRzIG5vIHZhcmlhYmxlIGFuZFxuICAvLyB1c2VzIHRoZSBjb25maWd1cmVkIHBhdGggdW5jaGFuZ2VkLCBzbyBvbmUgYC5jb25maWcuanNvbmAgc2VydmVzIGJvdGguXG4gIGNvbnN0IGN1c3RvbUxhYmVsUHJvbXB0cyA9IGFzc2VydEN1c3RvbUxhYmVsUHJvbXB0cyhcbiAgICBmaWxlLmN1c3RvbV9sYWJlbF9wcm9tcHRzLFxuICAgIHtcbiAgICAgIHdvcmtPbkxhYmVsLFxuICAgICAgcGxhbm5pbmdMYWJlbCxcbiAgICAgIHF1ZXN0aW9uTGFiZWwsXG4gICAgICBncmlsbE1lTGFiZWwsXG4gICAgICBxdW9ydW1MYWJlbCxcbiAgICAgIHJlZmluZUlzc3VlTGFiZWwsXG4gICAgICByZXNvbHZlUGF0aDogY3VzdG9tUHJvbXB0UGF0aFJlc29sdmVyKGVudihDVVNUT01fUFJPTVBUX1BBVEhfTUFQX0VOVikpLFxuICAgIH0sXG4gICk7XG5cbiAgLy8gUmVjZW50IGFjdGl2aXR5IHNldHRpbmdzIChJc3N1ZSAjMTMyNilcbiAgY29uc3QgaW5jbHVkZVJlY2VudEFjdGl2aXR5ID0gZmlsZS5pbmNsdWRlX3JlY2VudF9hY3Rpdml0eSA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLmluY2x1ZGVSZWNlbnRBY3Rpdml0eTtcbiAgY29uc3QgcmVjZW50QWN0aXZpdHlNZXJnZWRQckxpbWl0ID0gZmlsZS5yZWNlbnRfYWN0aXZpdHlfbWVyZ2VkX3ByX2xpbWl0ID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucmVjZW50QWN0aXZpdHlNZXJnZWRQckxpbWl0O1xuICBjb25zdCByZWNlbnRBY3Rpdml0eUNvbW1pdExpbWl0ID0gZmlsZS5yZWNlbnRfYWN0aXZpdHlfY29tbWl0X2xpbWl0ID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucmVjZW50QWN0aXZpdHlDb21taXRMaW1pdDtcbiAgY29uc3QgcmVjZW50QWN0aXZpdHlNYXhUb2tlbnMgPSBmaWxlLnJlY2VudF9hY3Rpdml0eV9tYXhfdG9rZW5zID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucmVjZW50QWN0aXZpdHlNYXhUb2tlbnM7XG4gIGNvbnN0IHJlY2VudEFjdGl2aXR5Q2FjaGVUdGxTZWNvbmRzID1cbiAgICBmaWxlLnJlY2VudF9hY3Rpdml0eV9jYWNoZV90dGxfc2Vjb25kcyA/P1xuICAgICAgT1BFUkFUSU9OQUxfREVGQVVMVFMucmVjZW50QWN0aXZpdHlDYWNoZVR0bFNlY29uZHM7XG4gIGNvbnN0IHRpbWVsaW5lQ2FjaGVUdGxTZWNvbmRzID0gZmlsZS50aW1lbGluZV9jYWNoZV90dGxfc2Vjb25kcyA/P1xuICAgIE9QRVJBVElPTkFMX0RFRkFVTFRTLnRpbWVsaW5lQ2FjaGVUdGxTZWNvbmRzO1xuXG4gIC8vIENvZGViYXNlIG1hcCBpbmplY3Rpb24gKElzc3VlICM0MjgxKVxuICBjb25zdCBpbmNsdWRlQ29kZWJhc2VNYXAgPSBmaWxlLmluY2x1ZGVfY29kZWJhc2VfbWFwID8/XG4gICAgT1BFUkFUSU9OQUxfREVGQVVMVFMuaW5jbHVkZUNvZGViYXNlTWFwO1xuXG4gIC8vIENvZGVHcmFwaCByZXBvIGNvbnRleHQgKElzc3VlICMyMTU0LCBwYXJ0IG9mICMyMTQ1KS4gT2ZmIHVubGVzcyB0aGUgaG9zdFxuICAvLyBhc2tzIGZvciBpdDsgYSBtYWxmb3JtZWQgYmxvY2sgZmFpbHMgdGhlIGxvYWQgbG91ZGx5IGhlcmUgcmF0aGVyIHRoYW5cbiAgLy8gcmVhZGluZyBhcyBvZmYgYW5kIHNpbGVudGx5IHdpdGhob2xkaW5nIHRoZSBpbmRleCB0aGUgb3BlcmF0b3IgY29uZmlndXJlZC5cbiAgY29uc3QgcGFyc2VkQ29kZWdyYXBoQ29udGV4dCA9IHBhcnNlQ29kZWdyYXBoQ29udGV4dChmaWxlLmNvZGVncmFwaF9jb250ZXh0KTtcbiAgaWYgKCFwYXJzZWRDb2RlZ3JhcGhDb250ZXh0Lm9rKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYENvbmZpZyBmaWxlICR7Y29uZmlnUGF0aH0gaXMgaW52YWxpZDogJHtwYXJzZWRDb2RlZ3JhcGhDb250ZXh0LmVycm9yfWAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBjb2RlZ3JhcGhDb250ZXh0ID0gcGFyc2VkQ29kZWdyYXBoQ29udGV4dC52YWx1ZTtcblxuICAvLyBSVEsgb3V0cHV0IChJc3N1ZSAjMjM4MCwgcGFydCBvZiAjMjMyOCkuIE9uIHVubGVzcyB0aGUgaG9zdCBvcHRzIG91dFxuICAvLyAoSXNzdWUgIzI0MzIpOyBhIG1hbGZvcm1lZCBibG9jayBmYWlscyB0aGUgbG9hZCBsb3VkbHkgaGVyZSByYXRoZXIgdGhhblxuICAvLyByZWFkaW5nIGFzIHRoZSBkZWZhdWx0IGFuZCBzaWxlbnRseSBpZ25vcmluZyB3aGF0IHRoZSBvcGVyYXRvciB3cm90ZS5cbiAgY29uc3QgcGFyc2VkUnRrT3V0cHV0ID0gcGFyc2VSdGtPdXRwdXQoZmlsZS5ydGtfb3V0cHV0KTtcbiAgaWYgKCFwYXJzZWRSdGtPdXRwdXQub2spIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQ29uZmlnIGZpbGUgJHtjb25maWdQYXRofSBpcyBpbnZhbGlkOiAke3BhcnNlZFJ0a091dHB1dC5lcnJvcn1gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcnRrT3V0cHV0ID0gcGFyc2VkUnRrT3V0cHV0LnZhbHVlO1xuXG4gIGNvbnN0IGNvbmZpZzogV29ya2VyQ29uZmlnID0ge1xuICAgIGFsbG93ZWRBdXRob3JzLFxuICAgIGFsbG93ZWRBdXRob3IsXG4gICAgcHJSZXZpZXdlcixcbiAgICBwclJldmlld2VycyxcbiAgICByZXBvcyxcbiAgICBpc3N1ZUxhYmVscyxcbiAgICBhdXRob3Jpc2VkQ29tbWVudGVycyxcbiAgICBleGNsdXNpb25UZWFtLFxuICAgIHNlcnZpY2VBY2NvdW50cyxcbiAgICBnaENvbmZpZ0RpcixcbiAgICBzc2hLZXlQYXRoLFxuICAgIHRydXN0ZWRSZXZpZXdCb3RzLFxuICAgIGZsZWV0UHJBdXRob3JzLFxuICAgIHdvcmtPbkxhYmVsLFxuICAgIGZhaWxlZE9uY2VMYWJlbCxcbiAgICBmYWlsZWRMYWJlbCxcbiAgICByZWZpbmVJc3N1ZUxhYmVsLFxuICAgIHBsYW5uaW5nTGFiZWwsXG4gICAgcXVlc3Rpb25MYWJlbCxcbiAgICBuZWVkc1JldmlzaW9uTGFiZWwsXG4gICAgbmVlZHNIdW1hbkxhYmVsLFxuICAgIGdyaWxsTWVMYWJlbCxcbiAgICBxdW9ydW1MYWJlbCxcbiAgICBsb3dQcmlvcml0eUxhYmVsLFxuICAgIHdvcmtEaXIsXG4gICAgcnVuTW9kZSxcbiAgICB1cGRhdGVNb2RlLFxuICAgIHBpbm5lZFJlZixcbiAgICBwaW5uZWRUb29sVmVyc2lvbnMsXG4gICAgYWdlbnRQcm92aWRlcixcbiAgICBlbmFibGVkQWdlbnRQcm92aWRlcnM6IGVuYWJsZWRBZ2VudFByb3ZpZGVySWRzLFxuICAgIGFnZW50UHJvdmlkZXJGYWxsYmFjazogWy4uLmFnZW50UHJvdmlkZXJGYWxsYmFja10sXG4gICAgY2xhdWRlV2Vla1BhY2VEcmFpbjogZmlsZS5jbGF1ZGVfd2Vla19wYWNlX2RyYWluID09PSB0cnVlLFxuICAgIGNsYXVkZU1vZGVsLFxuICAgIGJlc3RQbGFubmluZ01vZGVsLFxuICAgIGNsYXVkZVRpbWVvdXQsXG4gICAgY2xhdWRlTWF4VHVybnMsXG4gICAgbWluQ2xhaW1SdW53YXlTZWNvbmRzLFxuICAgIHJ1bkZpbmlzaFNlY29uZHMsXG4gICAgY2xhaW1Mb25nSm9iTGFiZWxzLFxuICAgIHByb2dyZXNzRXh0ZW5zaW9uRW5hYmxlZCxcbiAgICBhZ2VudFRyYW5zY3JpcHRFbmFibGVkLFxuICAgIHByb2dyZXNzRXh0ZW5zaW9uR3JhbnRTZWNvbmRzLFxuICAgIHByb2dyZXNzRXh0ZW5zaW9uU3RhbGxTZWNvbmRzLFxuICAgIHByb2dyZXNzRXh0ZW5zaW9uQ2hlY2tTZWNvbmRzLFxuICAgIHNjcmVlbnNob3RSZXRyeVRpbWVvdXRTZWNvbmRzLFxuICAgIHByZVB1c2hSZXRyeVRpbWVvdXRTZWNvbmRzLFxuICAgIGNhbGxTdG9ybUVuYWJsZWQsXG4gICAgY2FsbFN0b3JtQ2FsbHMsXG4gICAgY2FsbFN0b3JtV2luZG93U2Vjb25kcyxcbiAgICBjYWxsU3Rvcm1Ob3ZlbFNoYXJlLFxuICAgIHF1b3RhUG9sbFBhcmtGbG9vcixcbiAgICBxdW90YVBvbGxQYXJrTmljZSxcbiAgICBxdW90YVBvbGxJZGxlRmxvb3IsXG4gICAgcG9sbENhZGVuY2VMb3dDeWNsZXMsXG4gICAgcG9sbENhZGVuY2VQYXJrQ3ljbGVzLFxuICAgIHNlbGZTY2hlZHVsZURpYWdub3N0aWNzRW5hYmxlZCxcbiAgICBzZWxmU2NoZWR1bGVEaWFnbm9zdGljc01heEluRmxpZ2h0LFxuICAgIHByRmVlZGJhY2tUaW1lb3V0LFxuICAgIGNpRml4VGltZW91dCxcbiAgICBjbGF1ZGVLaWxsQWZ0ZXIsXG4gICAgbWF4Q2xhcmlmaWNhdGlvblJvdW5kcyxcbiAgICBzbGVlcEludGVydmFsLFxuICAgIHRydXN0ZWRBdXRob3JzQ2FjaGVIb3VycyxcbiAgICBtYXhDb25jdXJyZW50SXNzdWVzLFxuICAgIHByU2Nhbm5pbmdFbmFibGVkLFxuICAgIGNyZWRpdFdhaXRJbnRlcnZhbCxcbiAgICByZWZpbmVtZW50VGltZW91dCxcbiAgICByZWZpbmVtZW50S2lsbEFmdGVyLFxuICAgIHBsYW5uaW5nVGltZW91dCxcbiAgICBwbGFubmluZ0tpbGxBZnRlcixcbiAgICBxdWVzdGlvblRpbWVvdXQsXG4gICAgcXVlc3Rpb25LaWxsQWZ0ZXIsXG4gICAgY2xhcmlmaWNhdGlvblRpbWVvdXQsXG4gICAgY2xhcmlmaWNhdGlvbktpbGxBZnRlcixcbiAgICBtYXhHcmlsbE1lUm91bmRzLFxuICAgIGdyaWxsTWVUaW1lb3V0LFxuICAgIGdyaWxsTWVLaWxsQWZ0ZXIsXG4gICAgcXVvcnVtVGltZW91dCxcbiAgICBxdW9ydW1LaWxsQWZ0ZXIsXG4gICAgcXVvcnVtUGxhbm5lcnMsXG4gICAgcXVvcnVtSnVkZ2UsXG4gICAgbWF4UmF0ZUxpbWl0UmV0cmllcyxcbiAgICBtYXhSYXRlTGltaXRXYWl0LFxuICAgIHJldHJ5TWF4RGVsYXksXG4gICAgbWF4SXNzdWVCb2R5VG9rZW5zLFxuICAgIHN1bW1hcmlzZVRpbWVvdXQsXG4gICAgc3VtbWFyaXNlS2lsbEFmdGVyLFxuICAgIGZlYXR1cmVDaGVja1RpbWVvdXQsXG4gICAgY2xhdWRlTm9PdXRwdXRUaW1lb3V0LFxuICAgIHF1YWxpdHlDaGVja1RpbWVvdXQsXG4gICAgaGVhbHRoQ2FjaGVUdGwsXG4gICAgc2h1ZmZsZVJlcG9zLFxuICAgIHdvcmtlck5hbWUsXG4gICAgZW5hYmxlTW9kZWxGYWxsYmFjayxcbiAgICBtaW5EaXNrU3BhY2VNYixcbiAgICAuLi4oaG9zdERpc2tMb3dGbG9vckdiID09PSB1bmRlZmluZWQgPyB7fSA6IHsgaG9zdERpc2tMb3dGbG9vckdiIH0pLFxuICAgIC4uLihob3N0RGlza0xvd0Zsb29yUGVyY2VudCA9PT0gdW5kZWZpbmVkXG4gICAgICA/IHt9XG4gICAgICA6IHsgaG9zdERpc2tMb3dGbG9vclBlcmNlbnQgfSksXG4gICAgc3luY01pbGVzdG9uZUJyYW5jaGVzLFxuICAgIHN0YWxlRmFpbGVkRGlhZ25vc3RpY0RheXMsXG4gICAgc3RhbGVQbGFubmluZ1dhcm5pbmdEYXlzLFxuICAgIGZhc3RGYWlsdXJlU2Vjb25kcyxcbiAgICByZXBvRmFzdEZhaWx1cmVUaHJlc2hvbGQsXG4gICAgcmVwb0Zhc3RGYWlsdXJlV2luZG93SG91cnMsXG4gICAgcGhhc2VNb2RlbE92ZXJyaWRlcyxcbiAgICBwaGFzZUVmZm9ydE92ZXJyaWRlcyxcbiAgICBjb2RleFBoYXNlTW9kZWxPdmVycmlkZXMsXG4gICAgY29kZXhQaGFzZUVmZm9ydE92ZXJyaWRlcyxcbiAgICBnZW1pbmlQaGFzZU1vZGVsT3ZlcnJpZGVzLFxuICAgIGRlZXBzZWVrUGhhc2VNb2RlbE92ZXJyaWRlcyxcbiAgICBpc3N1ZUV4ZWN1dG9yU3BsaXQsXG4gICAgaXNzdWVTdWJBZ2VudFRpZXIsXG4gICAgaXNzdWVSZXZpZXdlckFnZW50cyxcbiAgICBleHRlcm5hbE9yY2hlc3RyYXRpb24sXG4gICAgZXh0ZXJuYWxPcmNoZXN0cmF0aW9uU2V0dGluZ3MsXG4gICAgZmxlZXRSdW5BcmNoaXZlLFxuICAgIHN1YnNjcmlwdGlvbkFsbG9jYXRpb25MYWJlbCxcbiAgICBpbmNsdWRlUmVjZW50QWN0aXZpdHksXG4gICAgaW5jbHVkZUNvZGViYXNlTWFwLFxuICAgIGNvZGVncmFwaENvbnRleHQsXG4gICAgcnRrT3V0cHV0LFxuICAgIHJlY2VudEFjdGl2aXR5TWVyZ2VkUHJMaW1pdCxcbiAgICByZWNlbnRBY3Rpdml0eUNvbW1pdExpbWl0LFxuICAgIHJlY2VudEFjdGl2aXR5TWF4VG9rZW5zLFxuICAgIHJlY2VudEFjdGl2aXR5Q2FjaGVUdGxTZWNvbmRzLFxuICAgIHRpbWVsaW5lQ2FjaGVUdGxTZWNvbmRzLFxuICAgIGVuYWJsZVNlc3Npb25SZXN1bWUsXG4gICAgdmVyYm9zaXR5LFxuICAgIGNvbnRleHRCdWRnZXRXYXJuaW5nUGVyY2VudCxcbiAgICBjb250ZXh0QnVkZ2V0RXJyb3JQZXJjZW50LFxuICAgIGNvbnRleHRCdWRnZXRCbG9ja1BlcmNlbnQsXG4gICAgaW5jbHVkZVVudHJ1c3RlZENvbW1lbnRzLFxuICAgIGNsb3NlZFByQ29vbGRvd25TZWNvbmRzLFxuICAgIHVuYXNzaWduT25QckNyZWF0ZWQsXG4gICAgc3RhbGVXb3JrRGlyRGF5cyxcbiAgICB1cGRhdGVSZXRyeU1heEF0dGVtcHRzLFxuICAgIHVwZGF0ZVJldHJ5QmFja29mZlNlY29uZHMsXG4gICAgYmFzZWxpbmVBd2FyZVF1YWxpdHlHYXRlLFxuICAgIGluZnJhUmV0cnlCYWNrb2ZmTXMsXG4gICAgbWF4QXV0b0ZpeEF0dGVtcHRzLFxuICAgIGJsb2NraW5nUHJTdGFsbFRocmVzaG9sZFNlY29uZHMsXG4gICAgZmxlZXRQclNsb3RzLFxuICAgIGlkbGVUYXNrVGVtcGxhdGVXZWlnaHRzLFxuICAgIGlkbGVUYXNrQ2FkZW5jZSxcbiAgICBzb2Z0d2FyZU1pblZlcnNpb25zLFxuICAgIGN1c3RvbUxhYmVsUHJvbXB0cyxcbiAgICAvLyBJc3N1ZSAjODA2IChwYXJlbnQgIzc5Nik6IGBhc3NlcnRDYWxsYmFja3NDb25maWdgIGlzIHRoZSBvbmx5IHRydXN0ZWRcbiAgICAvLyBwcm9kdWNlciBvZiB0aGUgdHlwZWQgYmxvY2ssIGFuZCBpdCB0aHJvd3Mgb24gYW55IGZhdWx0IOKAlCBhIGhvb2sgdGhlXG4gICAgLy8gb3BlcmF0b3IgYmVsaWV2ZXMgaXMgd2lyZWQsIGJ1dCB0aGF0IHNpbGVudGx5IG5ldmVyIHJ1bnMsIGlzIHRoZSBleGFjdFxuICAgIC8vIGZhaWx1cmUgdGhlIGNvbnRyYWN0IGV4aXN0cyB0byBwcmV2ZW50LlxuICAgIGNhbGxiYWNrczogYXNzZXJ0Q2FsbGJhY2tzQ29uZmlnKGZpbGUuY2FsbGJhY2tzKSxcbiAgICAvLyBJc3N1ZSAjMjA5OCAocGFydCBvZiAjMjA2MCk6IG9mZiB1bmxlc3MgdGhpcyBob3N0IG9wdGVkIGluLiBBIG1hbGZvcm1lZFxuICAgIC8vIGJsb2NrIHN0b3BzIHRoZSB3b3JrZXIgaGVyZSByYXRoZXIgdGhhbiByZWFkaW5nIGFzIG9mZiBvbiBhIGhvc3Qgd2hvc2VcbiAgICAvLyBvcGVyYXRvciBiZWxpZXZlcyBHcmFmdCBpcyBvbi5cbiAgICBncmFmdENvbnRleHQ6IGFzc2VydEdyYWZ0Q29udGV4dENvbmZpZyhmaWxlLmdyYWZ0X2NvbnRleHQpLFxuICAgIHJlcG9Db25maWc6IG5vcm1hbGlzZVJlcG9Db25maWdzKGZpbGUucmVwb19jb25maWcpLFxuICAgIHN1YnNjcmlwdGlvbkFsbG9jYXRpb246IHBhcnNlQWxsb2NhdGlvblBvbGljeShmaWxlLnN1YnNjcmlwdGlvbl9hbGxvY2F0aW9uKSxcbiAgfTtcblxuICAvLyBJc3N1ZSAjMzU3NzogcmVqZWN0IGEgbWFsZm9ybWVkIHByZS1mbGlnaHQgZ2F0ZSBsb3VkbHkgYXQgY29uZmlnIGxvYWQsXG4gIC8vIHJhdGhlciB0aGFuIHNpbGVudGx5IGlnbm9yaW5nIGl0IGFuZCBydW5uaW5nIHRoZSByZXBvIHVuZ3VhcmRlZC5cbiAgdmFsaWRhdGVQcmVGbGlnaHRDb25maWdzKGNvbmZpZy5yZXBvQ29uZmlnKTtcbiAgdmFsaWRhdGVSb2xlUHJvdmlkZXJzKGNvbmZpZyk7XG4gIC8vIElzc3VlICMzMzk0OiBtYWtlIHRoZSBwcmUtZmxpZ2h0IGNvbW1hbmRzIGF2YWlsYWJsZSB0byBhZ2VudCBzcGF3bnMuXG4gIHJlZ2lzdGVyQWdlbnRQcmVGbGlnaHRDb25maWdzKGNvbmZpZy5yZXBvQ29uZmlnKTtcblxuICAvLyBJc3N1ZSAjNjMwOiBPcHRpb25hbGx5IHZhbGlkYXRlIHJlcXVpcmVkIGZpZWxkcyBhdCBsb2FkIHRpbWVcbiAgaWYgKG9wdGlvbnM/LnZhbGlkYXRlKSB7XG4gICAgdmFsaWRhdGVDb25maWcoY29uZmlnKTtcbiAgfVxuXG4gIHJldHVybiBjb25maWc7XG59XG5cbi8qKlxuICogVmFsaWRhdGUgZXZlcnkgcmVwbydzIGBwcmVGbGlnaHRgIGdhdGUgY29uZmlndXJhdGlvbiBhdCBsb2FkIHRpbWVcbiAqIChJc3N1ZSAjMzU3NykuXG4gKlxuICogVGhyb3dzIHdpdGggYSBjbGVhciBwZXItcmVwbyBtZXNzYWdlIG9uIHRoZSBmaXJzdCBtYWxmb3JtZWQgZW50cnkgc28gYVxuICogdHlwbyBpbiBgLmNvbmZpZy5qc29uYCBmYWlscyBsb3VkbHkgaW5zdGVhZCBvZiBzaWxlbnRseSBkaXNhYmxpbmcgdGhlIGdhdGUuXG4gKi9cbmZ1bmN0aW9uIHZhbGlkYXRlUHJlRmxpZ2h0Q29uZmlncyhcbiAgcmVwb0NvbmZpZzogUmVjb3JkPHN0cmluZywgUmVwb0NvbmZpZz4gfCB1bmRlZmluZWQsXG4pOiB2b2lkIHtcbiAgaWYgKCFyZXBvQ29uZmlnKSByZXR1cm47XG4gIGZvciAoY29uc3QgW3JlcG8sIGNmZ10gb2YgT2JqZWN0LmVudHJpZXMocmVwb0NvbmZpZykpIHtcbiAgICBjb25zdCByYXcgPSAoY2ZnIGFzIHsgcHJlRmxpZ2h0PzogdW5rbm93biB9KS5wcmVGbGlnaHQ7XG4gICAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICBjb25zdCByZXN1bHQgPSBwYXJzZVByZUZsaWdodENvbW1hbmRzKHJhdyk7XG4gICAgaWYgKCFyZXN1bHQub2spIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEludmFsaWQgcHJlLWZsaWdodCBmb3IgJHtyZXBvfTogJHtyZXN1bHQuZXJyb3J9YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG59XG5cbi8qKlxuICogVmFsaWRhdGUgdGhhdCB0aGUgY29uZmlndXJhdGlvbiBoYXMgYWxsIHJlcXVpcmVkIGZpZWxkcy5cbiAqXG4gKiBAcGFyYW0gY29uZmlnIC0gQ29uZmlndXJhdGlvbiB0byB2YWxpZGF0ZVxuICogQHRocm93cyBFcnJvciBpZiByZXF1aXJlZCBmaWVsZHMgYXJlIG1pc3Npbmcgb3IgaW52YWxpZFxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVDb25maWcoY29uZmlnOiBXb3JrZXJDb25maWcpOiB2b2lkIHtcbiAgaWYgKGNvbmZpZy5leGNsdXNpb25UZWFtICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAoIUVYQ0xVU0lPTl9URUFNX1BBVFRFUk4udGVzdChjb25maWcuZXhjbHVzaW9uVGVhbSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYENvbmZpZ3VyYXRpb24gZXJyb3I6IEludmFsaWQgZXhjbHVzaW9uX3RlYW0gXCIke2NvbmZpZy5leGNsdXNpb25UZWFtfVwiLiBgICtcbiAgICAgICAgICBcIkV4cGVjdGVkIG9yZy9zbHVnIChlLmcuIHN0U29mdHdhcmVBVS92aWJlLXdvcmtlcnMpLlwiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBpZiAoY29uZmlnLnJlcG9zLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQ29uZmlndXJhdGlvbiBlcnJvcjogcmVwb3MgaXMgcmVxdWlyZWQuIFwiICtcbiAgICAgICAgXCJTZXQgdmlhIC5jb25maWcuanNvbiAocnVuIHNldHVwLnNoIHRvIGNvbmZpZ3VyZSkuXCIsXG4gICAgKTtcbiAgfVxuXG4gIC8vIElzc3VlICMxODM0OiBpc3N1ZUxhYmVscyBpcyBoYXJkd2lyZWQgaW4gY29kZSwgc28gYW4gZW1wdHkgbGlzdCBoZXJlXG4gIC8vIHNpZ25hbHMgYW4gaW50ZXJuYWwgYnVnIHJhdGhlciB0aGFuIHVzZXIgbWlzY29uZmlndXJhdGlvbi5cbiAgaWYgKGNvbmZpZy5pc3N1ZUxhYmVscy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkNvbmZpZ3VyYXRpb24gZXJyb3I6IGlzc3VlTGFiZWxzIGlzIGVtcHR5LiBUaGUgZGlzY292ZXJ5IGxhYmVsIHNldCBcIiArXG4gICAgICAgIFwiaXMgaGFyZHdpcmVkIGluIGxpYi9jb25maWdfZGVmYXVsdHMudHM7IHRoaXMgaW5kaWNhdGVzIGEgYnVpbGQgXCIgK1xuICAgICAgICBcImJ1ZyByYXRoZXIgdGhhbiBhIGNvbmZpZ3VyYXRpb24gcHJvYmxlbS5cIixcbiAgICApO1xuICB9XG5cbiAgLy8gVmFsaWRhdGUgcmVwbyBmb3JtYXQgKG11c3QgYmUgb3duZXIvcmVwbylcbiAgZm9yIChjb25zdCByZXBvIG9mIGNvbmZpZy5yZXBvcykge1xuICAgIGlmICghUkVQT19TTFVHX1BBVFRFUk4udGVzdChyZXBvKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQ29uZmlndXJhdGlvbiBlcnJvcjogSW52YWxpZCByZXBvc2l0b3J5IGZvcm1hdCBcIiR7cmVwb31cIi4gYCArXG4gICAgICAgICAgXCJSZXBvc2l0b3JpZXMgbXVzdCBiZSBpbiBvd25lci9yZXBvIGZvcm1hdC5cIixcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gVmFsaWRhdGUgdXNlcm5hbWUgZm9ybWF0IGZvciBhbGwgYWxsb3dlZCBhdXRob3JzIChJc3N1ZSAjMTM3KVxuICBjb25zdCB1c2VybmFtZVBhdHRlcm4gPSAvXlthLXpBLVowLTldW2EtekEtWjAtOV8tXSooXFxbYm90XFxdKT8kLztcbiAgZm9yIChjb25zdCBhdXRob3Igb2YgY29uZmlnLmFsbG93ZWRBdXRob3JzKSB7XG4gICAgaWYgKCF1c2VybmFtZVBhdHRlcm4udGVzdChhdXRob3IpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBDb25maWd1cmF0aW9uIGVycm9yOiBJbnZhbGlkIHVzZXJuYW1lIGZvcm1hdCBcIiR7YXV0aG9yfVwiIGluIGFsbG93ZWRfYXV0aG9ycy5gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvLyBJc3N1ZSAjMTA2NjogYGFsbG93ZWRfYXV0aG9yc2AgaXMgbm8gbG9uZ2VyIHJlcXVpcmVkLCBhbmQgbm8gbG9uZ2VyXG4gIC8vIGdyYW50cyBhbnl0aGluZyDigJQgd2hvIG1heSBkaXJlY3Qgd29yayBpcyBkZXJpdmVkIGZyb20gcmVwb3NpdG9yeVxuICAvLyBjb2xsYWJvcmF0b3JzIGV2ZXJ5IGN5Y2xlLiBXaGF0IElTIHJlcXVpcmVkIGlzIHNvbWV0aGluZyB0byAqc3VidHJhY3QqOlxuICAvLyB0aGUgVmliZSBDb2RlciBhY2NvdW50cyBob2xkIHdyaXRlIGFjY2VzcyBieSBuZWNlc3NpdHksIHNvIGFuIGVtcHR5XG4gIC8vIGZsZWV0IGxvZ2luIHNldCB3b3VsZCBsZWF2ZSB0aGUgd29ya2VycyB0cnVzdGVkIHRvIHJhaXNlIGFuZCBzY2hlZHVsZVxuICAvLyB0aGVpciBvd24gd29yay4gRmFpbCBsb3VkbHkgcmF0aGVyIHRoYW4gcnVuIG9wZW4uIENoZWNrZWQgbGFzdCBzbyBhIGhvc3RcbiAgLy8gd2l0aCBzZXZlcmFsIHByb2JsZW1zIHN0aWxsIGhlYXJzIGFib3V0IHRoZSBzaGFwZSBlcnJvcnMgZmlyc3QuXG4gIGlmIChcbiAgICByZXNvbHZlVmliZUNvZGVyTG9naW5zKHtcbiAgICAgIHNlcnZpY2VBY2NvdW50czogY29uZmlnLnNlcnZpY2VBY2NvdW50cyA/PyBbXSxcbiAgICAgIGZsZWV0UHJBdXRob3JzOiBjb25maWcuZmxlZXRQckF1dGhvcnMgPz8gW10sXG4gICAgfSkuc2l6ZSA9PT0gMFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkNvbmZpZ3VyYXRpb24gZXJyb3I6IHRoZSBmbGVldCBsb2dpbiBzZXQgaXMgZW1wdHksIHNvIHRoZSBWaWJlIENvZGVyIFwiICtcbiAgICAgICAgXCJhY2NvdW50cyDigJQgd2hpY2ggaG9sZCByZXBvc2l0b3J5IHdyaXRlIGFjY2VzcyBpbiBvcmRlciB0byBwdXNoIFwiICtcbiAgICAgICAgXCJicmFuY2hlcyDigJQgd291bGQgYmUgdHJ1c3RlZCB0byByYWlzZSBhbmQgc2NoZWR1bGUgdGhlaXIgb3duIHdvcmsuIFwiICtcbiAgICAgICAgYFNldCAke0ZMRUVUX0xPR0lOX0NPTkZJR19LRVlTLmpvaW4oXCIgYW5kL29yIFwiKX0gaW4gLmNvbmZpZy5qc29uIHRvIGAgK1xuICAgICAgICBcInRoZSBmbGVldCdzIG93biBHaXRIdWIgbG9naW5zIChydW4gc2V0dXAuc2ggdG8gY29uZmlndXJlKS5cIixcbiAgICApO1xuICB9XG59XG5cbi8qKiBHdWFyZHMge0BsaW5rIHdhcm5EdXBsaWNhdGVSZXBvc30gdG8gb25lIG5vdGljZSBwZXIgcHJvY2Vzcy4gKi9cbmxldCB3YXJuZWREdXBsaWNhdGVSZXBvcyA9IGZhbHNlO1xuXG4vKiogUmUtYXJtIHRoZSBkdXBsaWNhdGUtcmVwb3NpdG9yeSBub3RpY2UuIFRlc3Qtb25seS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfcmVzZXREdXBsaWNhdGVSZXBvV2FybmluZygpOiB2b2lkIHtcbiAgd2FybmVkRHVwbGljYXRlUmVwb3MgPSBmYWxzZTtcbn1cblxuLyoqXG4gKiBOYW1lIGV2ZXJ5IGByZXBvc2AgZW50cnkgZHJvcHBlZCBhcyBhIGNhc2UtdmFyaWFudCAoSXNzdWUgIzE1NDYpLlxuICpcbiAqIEEgd2FybmluZyByYXRoZXIgdGhhbiBhIGhhcmQgZmFpbHVyZSwgc28gYSBob3N0IGlzIG5vdCBzdG9vZCBkb3duIG92ZXIgYVxuICogY2FzaW5nIHNsaXAg4oCUIGJ1dCBsb3VkLCBiZWNhdXNlIHRoZSBvcGVyYXRvcidzIGZpbGUgaGFzIGEgZGVmZWN0IHdvcnRoXG4gKiBmaXhpbmc6IHdoYXRldmVyIGlzIGtleWVkIGJ5IHRoZSBjb25maWd1cmVkIHNwZWxsaW5nICh3YXRlcm1hcmtzLCBjYWNoZXMsXG4gKiB0aGUgd3JpdGUtcmVwbyBhbGxvd2xpc3QpIGZvcmtzIGluIHR3byB1bnRpbCBpdCBpcy5cbiAqL1xuZnVuY3Rpb24gd2FybkR1cGxpY2F0ZVJlcG9zKFxuICBkdXBsaWNhdGVzOiByZWFkb25seSBEdXBsaWNhdGVSZXBvU2x1Z1tdLFxuICByZXBvQ29uZmlnS2V5czogcmVhZG9ubHkgc3RyaW5nW10sXG4pOiB2b2lkIHtcbiAgaWYgKGR1cGxpY2F0ZXMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIC8vIE9uY2UgcGVyIHByb2Nlc3M6IGBsb2FkQ29uZmlnYCBpcyByZS1lbnRlcmVkIGJ5IHN1Yi1jb21tYW5kcywgYW5kIHRoZVxuICAvLyBzYW1lIGRlZmVjdCByZXBlYXRlZCBvbiBldmVyeSByZWFkIGlzIG5vaXNlIGFuIG9wZXJhdG9yIHNjcm9sbHMgcGFzdC5cbiAgaWYgKHdhcm5lZER1cGxpY2F0ZVJlcG9zKSByZXR1cm47XG4gIHdhcm5lZER1cGxpY2F0ZVJlcG9zID0gdHJ1ZTtcblxuICBmb3IgKGNvbnN0IHdhcm5pbmcgb2YgZHVwbGljYXRlUmVwb1NsdWdXYXJuaW5ncyhkdXBsaWNhdGVzLCByZXBvQ29uZmlnS2V5cykpIHtcbiAgICBjb25zb2xlLndhcm4oYOKaoO+4jyAgJHt3YXJuaW5nfWApO1xuICB9XG59XG5cbi8qKiBHdWFyZHMge0BsaW5rIHdhcm5SZW1vdmVkVHJ1c3RLZXlzfSB0byBvbmUgbm90aWNlIHBlciBwcm9jZXNzLiAqL1xubGV0IHdhcm5lZFJlbW92ZWRUcnVzdEtleXMgPSBmYWxzZTtcblxuLyoqIFJlLWFybSB0aGUgbWlncmF0aW9uIG5vdGljZS4gVGVzdC1vbmx5LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIF9yZXNldFJlbW92ZWRUcnVzdEtleVdhcm5pbmcoKTogdm9pZCB7XG4gIHdhcm5lZFJlbW92ZWRUcnVzdEtleXMgPSBmYWxzZTtcbn1cblxuLyoqXG4gKiBOYW1lIHdoYXQgYSBzdGlsbC1kZXBsb3llZCBgLmNvbmZpZy5qc29uYCBjYXJyaWVzIHRoYXQgbm8gbG9uZ2VyIGRvZXMgd2hhdFxuICogaXQgdXNlZCB0byAoSXNzdWUgIzEwNjYpLlxuICpcbiAqIGBhdXRob3Jfc291cmNlYCBpcyAqcmVtb3ZlZCogYW5kIHJlZnVzZWQgb3V0cmlnaHQgYnkgYFJFTU9WRURfQ09ORklHX0tFWVNgLFxuICogdGhlIGNvbnZlbnRpb24gSXNzdWUgIzgwNSBlc3RhYmxpc2hlZDogYSBzZXR0aW5nIHRoYXQgcmVhZHMgYXMgbGl2ZSBhbmRcbiAqIGRvZXMgbm90aGluZyBpcyB0aGUgc2lsZW50IGZhaWx1cmUgdGhlIGNvbmZpZyBsb2FkIGV4aXN0cyB0byBwcmV2ZW50LCBhbmRcbiAqIGAuL3NldHVwLnNoYCBzdHJpcHMgaXQgYXV0b21hdGljYWxseS5cbiAqXG4gKiBgYWxsb3dlZF9hdXRob3JzYCBpcyBkaWZmZXJlbnQg4oCUIGl0IHN1cnZpdmVzIHdpdGggYSBuYXJyb3dlciBwdXJwb3NlLCBzb1xuICogcmVmdXNpbmcgaXQgd291bGQgc3RyYW5kIGV2ZXJ5IGRlcGxveWVkIGhvc3QgZm9yIG5vIGdhaW4uIEl0IGlzIHdhcm5lZFxuICogYWJvdXQgaW5zdGVhZCwgb25jZSBwZXIgbG9hZCwgbmFtaW5nIHdoYXQgaXQgbm8gbG9uZ2VyIGRvZXMuXG4gKi9cbmZ1bmN0aW9uIHdhcm5SZW1vdmVkVHJ1c3RLZXlzKGZpbGU6IENvbmZpZ0ZpbGUpOiB2b2lkIHtcbiAgLy8gT25jZSBwZXIgcHJvY2VzczogYGxvYWRDb25maWdgIGlzIHJlLWVudGVyZWQgYnkgc3ViLWNvbW1hbmRzIGFuZCBieSB0aGVcbiAgLy8gZXNjYXBlLWhhdGNoIGZvbGxvdy11cCBnYXRlLCBhbmQgYSBtaWdyYXRpb24gbm90aWNlIHJlcGVhdGVkIG9uIGV2ZXJ5XG4gIC8vIHJlYWQgaXMgbm9pc2UgYW4gb3BlcmF0b3IgbGVhcm5zIHRvIHNjcm9sbCBwYXN0LlxuICBpZiAod2FybmVkUmVtb3ZlZFRydXN0S2V5cykgcmV0dXJuO1xuICB3YXJuZWRSZW1vdmVkVHJ1c3RLZXlzID0gdHJ1ZTtcblxuICBjb25zdCBjb25maWd1cmVkQXV0aG9ycyA9IGZpbGUuYWxsb3dlZF9hdXRob3JzID8/IFtdO1xuICBpZiAoY29uZmlndXJlZEF1dGhvcnMubGVuZ3RoID4gMCkge1xuICAgIGNvbnNvbGUud2FybihcbiAgICAgIFwi4pqg77iPICBDSEFOR0VEOiBgYWxsb3dlZF9hdXRob3JzYCBubyBsb25nZXIgZ3JhbnRzIHRoZSByaWdodCB0byByYWlzZSwgXCIgK1xuICAgICAgICBcImxhYmVsIG9yIHNjaGVkdWxlIHdvcmsgKElzc3VlICMxMDY2KTsgd2hvIG1heSBkaXJlY3QgdGhlIHdvcmtlciBpcyBcIiArXG4gICAgICAgIGBkZXJpdmVkIGZyb20gcmVwb3NpdG9yeSBjb2xsYWJvcmF0b3JzLiBJZ25vcmVkIGZvciB0cnVzdDogJHtcbiAgICAgICAgICBjb25maWd1cmVkQXV0aG9ycy5qb2luKFwiLCBcIilcbiAgICAgICAgfS4gVGhlIGZpcnN0IGVudHJ5IGlzIHN0aWxsIHVzZWQgYXMgdGhlIGRlZmF1bHQgUFIgcmV2aWV3ZXIgd2hlbiBgICtcbiAgICAgICAgXCJgcHJfcmV2aWV3ZXJzYCBpcyB1bnNldCDigJQgc2V0IGBwcl9yZXZpZXdlcnNgIGFuZCByZW1vdmUgdGhpcyBrZXkuXCIsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgYSB1c2VybmFtZSBtYXkgZGlyZWN0IHdvcmsg4oCUIGF4aXMgMSBvZiB0aGUgdHJ1c3QgbW9kZWwuXG4gKlxuICogQ2FzZS1pbnNlbnNpdGl2ZSwgYmVjYXVzZSBHaXRIdWIgbG9naW5zIGFyZSAoSXNzdWUgIzEwNjYpOiBgYWxsb3dlZEF1dGhvcnNgXG4gKiBpcyB0aGUgZGVyaXZlZCBjb2xsYWJvcmF0b3Igc2V0LCBub3JtYWxpc2VkIHRvIGxvd2VyIGNhc2UsIHdoaWxlIGEgbG9naW5cbiAqIHVuZGVyIHRlc3QgYXJyaXZlcyBpbiB0aGUgYWNjb3VudCdzIG93biBjYXNpbmcuXG4gKlxuICogQHBhcmFtIGNvbmZpZyAtIFdvcmtlciBjb25maWd1cmF0aW9uXG4gKiBAcGFyYW0gdXNlcm5hbWUgLSBVc2VybmFtZSB0byBjaGVja1xuICogQHJldHVybnMgdHJ1ZSBpZiB0aGUgdXNlcm5hbWUgbWF5IHJhaXNlLCBsYWJlbCBhbmQgc2NoZWR1bGUgd29ya1xuICovXG5leHBvcnQgZnVuY3Rpb24gaXNBbGxvd2VkQXV0aG9yKFxuICBjb25maWc6IFdvcmtlckNvbmZpZyxcbiAgdXNlcm5hbWU6IHN0cmluZyxcbik6IGJvb2xlYW4ge1xuICBjb25zdCBrZXkgPSB1c2VybmFtZS50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgaWYgKCFrZXkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGNvbmZpZy5hbGxvd2VkQXV0aG9ycy5zb21lKChhKSA9PiBhLnRyaW0oKS50b0xvd2VyQ2FzZSgpID09PSBrZXkpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Q0FTQyxHQUVELFNBQ0Usd0JBQXdCLEVBQ3hCLHNCQUFzQixRQUNqQix5QkFBeUI7QUFDaEMsU0FBUyxxQkFBcUIsUUFBUSwrQkFBK0I7QUFDckUsU0FBUyxxQkFBcUIsUUFBUSw0QkFBNEI7QUFDbEUsU0FBUyw2QkFBNkIsUUFBUSx3QkFBd0I7QUFFdEUsU0FBeUIsZ0JBQWdCLFFBQVEsa0JBQWtCO0FBQ25FLFNBQVMsa0JBQWtCLFFBQVEscUJBQXFCO0FBQ3hELFNBQ0Usc0JBQXNCLEVBQ3RCLHNCQUFzQixRQUNqQixrQkFBa0I7QUFDekIsU0FDRSxzQkFBc0IsRUFDdEIsOEJBQThCLEVBQzlCLDRCQUE0QixFQUM1QixvQ0FBb0MsUUFDL0Isc0JBQXNCO0FBQzdCLFNBQVMsZ0NBQWdDLFFBQVEsMkJBQTJCO0FBQzVFLFNBQ0UsNkJBQTZCLEVBQzdCLG1DQUFtQyxRQUM5QixnQ0FBZ0M7QUFDdkMsU0FBUyx1QkFBdUIsUUFBUSw2QkFBNkI7QUFDckUsU0FBUywwQkFBMEIsUUFBUSxvQkFBb0I7QUFDL0QsU0FBUyxjQUFjLFFBQVEsZ0JBQWdCO0FBQy9DLFNBQVMsOEJBQThCLFFBQVEscUJBQXFCO0FBQ3BFLFNBQVMsc0JBQXNCLFFBQVEsbUJBQW1CO0FBQzFELFNBQVMsb0JBQW9CLFFBQVEsZ0NBQWdDO0FBQ3JFLFNBQ0UscUJBQXFCLEVBQ3JCLG9CQUFvQixRQUNmLHNCQUFzQjtBQUM3QixTQUFTLG1CQUFtQixRQUFRLDhCQUE4QjtBQUNsRSxTQUFTLHVCQUF1QixRQUFRLGtDQUFrQztBQUMxRSxTQUFTLHFCQUFxQixRQUFRLGdDQUFnQztBQUN0RSxTQUFTLGNBQWMsUUFBUSx5QkFBeUI7QUFDeEQsU0FBUyxxQkFBcUIsUUFBUSw0QkFBNEI7QUFDbEUsU0FBUyx3QkFBd0IsUUFBUSw0QkFBNEI7QUFDckUsU0FBUyx3QkFBd0IsUUFBUSxtQ0FBbUM7QUFDNUUsU0FDRSwwQkFBMEIsRUFDMUIscUJBQXFCLFFBQ2hCLGlDQUFpQztBQUN4QyxTQUFTLDRCQUE0QixRQUFRLDRCQUE0QjtBQUN6RSxTQUNFLDBCQUEwQixFQUMxQix3QkFBd0IsUUFDbkIsNEJBQTRCO0FBQ25DLFNBQ0Usc0JBQXNCLEVBQ3RCLDBCQUEwQixRQUNyQix3QkFBd0I7QUFDL0IsU0FDRSx1QkFBdUIsRUFDdkIsd0JBQXdCLFFBQ25CLDJCQUEyQjtBQUNsQyxTQUFTLHNCQUFzQixRQUFRLHdCQUF3QjtBQUMvRCxTQUFTLHNCQUFzQixRQUFRLG9CQUFvQjtBQUMzRCxTQUNFLHVCQUF1QixFQUN2QixzQkFBc0IsUUFDakIsd0JBQXdCO0FBQy9CLFNBQ0UsMkJBQTJCLEVBQzNCLHFCQUFxQixFQUNyQiwwQkFBMEIsRUFDMUIsMkJBQTJCLEVBQzNCLG1CQUFtQixFQUNuQixpQkFBaUIsRUFDakIsbUJBQW1CLEVBQ25CLGtCQUFrQixFQUNsQixxQkFBcUIsRUFDckIsY0FBYyxFQUNkLG9CQUFvQixFQUNwQixvQkFBb0IsUUFDZix1QkFBdUI7QUFHOUIsU0FDRSxlQUFlLEVBQ2YseUJBQXlCLEVBQ3pCLGlCQUFpQixRQUNaLGlCQUFpQjtBQUV4Qjs7Ozs7OztDQU9DLEdBQ0QsU0FBUyxpQkFBaUIsUUFBUSxpQkFBaUI7QUFFbkQ7Ozs7Ozs7Ozs7Q0FVQyxHQUNELE9BQU8sU0FBUyxnQkFDZCxJQUFZLEVBQ1osWUFBb0IsRUFDcEIsTUFBaUIsZ0JBQWdCO0VBRWpDLE9BQU8sSUFBSSxTQUFTO0FBQ3RCO0FBRUE7Ozs7Ozs7O0NBUUMsR0FDRCxPQUFPLFNBQVMsc0JBQ2QsSUFBWSxFQUNaLFlBQW9CLEVBQ3BCLE1BQWlCLGdCQUFnQjtFQUVqQyxNQUFNLFFBQVEsSUFBSTtFQUNsQixJQUFJLFVBQVUsV0FBVztJQUN2QixPQUFPO0VBQ1Q7RUFDQSxNQUFNLFNBQVMsU0FBUyxPQUFPO0VBQy9CLE9BQU8sTUFBTSxVQUFVLGVBQWU7QUFDeEM7QUFFQTs7Ozs7Ozs7Ozs7OztDQWFDLEdBQ0QsT0FBTyxTQUFTLHlCQUNkLElBQVksRUFDWixNQUFpQixnQkFBZ0I7RUFFakMsTUFBTSxNQUFNLElBQUk7RUFDaEIsSUFBSSxRQUFRLGFBQWEsSUFBSSxJQUFJLE9BQU8sSUFBSSxPQUFPO0VBQ25ELE1BQU0sU0FBUyxPQUFPO0VBQ3RCLE9BQU8sT0FBTyxRQUFRLENBQUMsV0FBVyxVQUFVLElBQUksU0FBUztBQUMzRDtBQUVBOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxTQUFTLHFCQUNkLElBQVksRUFDWixZQUFzQixFQUN0QixNQUFpQixnQkFBZ0I7RUFFakMsTUFBTSxRQUFRLElBQUk7RUFDbEIsSUFBSSxVQUFVLGFBQWEsVUFBVSxJQUFJO0lBQ3ZDLE9BQU87RUFDVDtFQUNBLE9BQU8sTUFBTSxLQUFLLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxJQUFNLEVBQUUsSUFBSSxJQUFJLE1BQU0sQ0FBQyxDQUFDLElBQU0sTUFBTTtBQUNuRTtBQUVBOzs7OztDQUtDLEdBQ0Q7Ozs7Ozs7Q0FPQyxHQUNELE1BQU0sc0JBQXdEO0VBQzVELG1CQUFtQjtFQUNuQixvQkFBb0I7RUFDcEIsaUJBQWlCO0VBQ2pCLHFCQUFxQjtFQUNyQixpQkFBaUI7RUFDakIsdUJBQXVCO0VBQ3ZCLHVCQUF1QjtFQUN2Qix5QkFBeUI7RUFDekIsMkNBQTJDO0VBQzNDLHFCQUFxQjtFQUNyQiwrQkFBK0I7RUFDL0IsMENBQTBDO0VBQzFDLCtCQUErQjtFQUMvQixpRUFBaUU7RUFDakUscUJBQXFCO0VBQ3JCLGNBQWM7RUFDZCx1QkFBdUI7RUFDdkIsdUVBQXVFO0VBQ3ZFLDJFQUEyRTtFQUMzRSxNQUFNO0VBQ04sK0NBQStDO0VBQy9DLGNBQWM7RUFDZCwyRUFBMkU7RUFDM0UscUJBQXFCO0VBQ3JCLHVCQUF1QjtFQUN2Qix3QkFBd0I7RUFDeEIsd0RBQXdEO0VBQ3hELHNCQUFzQjtFQUN0Qix3REFBd0Q7RUFDeEQsc0JBQXNCO0VBQ3RCLG9EQUFvRDtFQUNwRCxhQUFhO0VBQ2IsNkJBQTZCO0VBQzdCLDhCQUE4QjtFQUM5QiwwRUFBMEU7RUFDMUUsOENBQThDO0VBQzlDLGNBQWM7RUFDZCw4QkFBOEI7RUFDOUIsd0VBQXdFO0VBQ3hFLG1FQUFtRTtFQUNuRSxnQkFBZ0I7RUFDaEIsZ0NBQWdDO0VBQ2hDLG9EQUFvRDtFQUNwRCxnQkFBZ0I7RUFDaEIsd0JBQXdCO0VBQ3hCLGlDQUFpQztFQUNqQyx3RUFBd0U7RUFDeEUsMkVBQTJFO0VBQzNFLG9FQUFvRTtFQUNwRSxjQUFjO0VBQ2QsWUFBWTtFQUNaLHNEQUFzRDtFQUN0RCxtQkFBbUI7RUFDbkIscUJBQXFCO0VBQ3JCLCtDQUErQztFQUMvQyx1QkFBdUI7RUFDdkIsc0RBQXNEO0VBQ3RELHFDQUFxQztFQUNyQyxvRUFBb0U7RUFDcEUsZ0JBQWdCO0VBQ2hCLHNCQUFzQjtBQUN4QjtBQUVBOzs7OztDQUtDLEdBQ0QsU0FBUyxvQkFBb0IsR0FBNEI7RUFDdkQsTUFBTSxhQUFzQyxDQUFDO0VBRTdDLEtBQUssTUFBTSxDQUFDLEtBQUssTUFBTSxJQUFJLE9BQU8sT0FBTyxDQUFDLEtBQU07SUFDOUMsTUFBTSxZQUFZLG1CQUFtQixDQUFDLElBQUk7SUFDMUMsSUFBSSxXQUFXO01BQ2Isb0NBQW9DO01BQ3BDLFVBQVUsQ0FBQyxVQUFVLEdBQUc7SUFDMUIsT0FBTztNQUNMLDRDQUE0QztNQUM1QyxVQUFVLENBQUMsSUFBSSxHQUFHO0lBQ3BCO0VBQ0Y7RUFFQSxJQUNFLFdBQVcscUJBQXFCLEtBQUssYUFDckMsT0FBTyxXQUFXLHFCQUFxQixLQUFLLFdBQzVDO0lBQ0EsTUFBTSxJQUFJLE1BQU07RUFDbEI7RUFDQSxJQUFJLFdBQVcsNkJBQTZCLEtBQUssV0FBVztJQUMxRCxXQUFXLDZCQUE2QixHQUFHLDJCQUN6QyxXQUFXLDZCQUE2QjtFQUU1QztFQUNBLElBQUksV0FBVyxtQkFBbUIsS0FBSyxXQUFXO0lBQ2hELFdBQVcsbUJBQW1CLEdBQUcsc0JBQy9CLFdBQVcsbUJBQW1CO0VBRWxDO0VBQ0EsT0FBTztBQUNUO0FBRUE7Ozs7O0NBS0MsR0FDRCxTQUFTLHFCQUNQLEdBQTJDO0VBRTNDLElBQUksQ0FBQyxLQUFLLE9BQU87RUFFakIsTUFBTSxTQUFxQyxDQUFDO0VBQzVDLEtBQUssTUFBTSxDQUFDLE1BQU0sT0FBTyxJQUFJLE9BQU8sT0FBTyxDQUFDLEtBQU07SUFDaEQsTUFBTSxDQUFDLEtBQUssR0FBRyxvQkFDYjtFQUVKO0VBQ0EsT0FBTztBQUNUO0FBRUE7Ozs7Ozs7Q0FPQyxHQUNELGVBQWUsZUFDYixVQUFrQixFQUNsQixNQUFpQixnQkFBZ0I7RUFFakMsSUFBSTtFQUNKLElBQUk7SUFDRixVQUFVLE1BQU0sS0FBSyxZQUFZLENBQUM7RUFDcEMsRUFBRSxPQUFNO0lBQ04sMkNBQTJDO0lBQzNDLE9BQU8sQ0FBQztFQUNWO0VBRUEsSUFBSTtFQUNKLElBQUk7SUFDRixTQUFTLEtBQUssS0FBSyxDQUFDO0VBQ3RCLEVBQUUsT0FBTTtJQUNOLE1BQU0sSUFBSSxNQUNSLENBQUMsWUFBWSxFQUFFLFdBQVcsc0JBQXNCLENBQUM7RUFFckQ7RUFFQSxNQUFNLFlBQVksdUJBQXVCO0VBQ3pDLElBQUksQ0FBQyxVQUFVLEVBQUUsRUFBRTtJQUNqQixNQUFNLElBQUksTUFDUixDQUFDLFlBQVksRUFBRSxXQUFXLHdCQUF3QixFQUFFLFVBQVUsS0FBSyxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsVUFBVSxLQUFLLENBQUMsT0FBTyxFQUFFO0VBRTVHO0VBRUEsNkVBQTZFO0VBQzdFLElBQUksT0FBTyxXQUFXLFlBQVksV0FBVyxRQUFRLENBQUMsTUFBTSxPQUFPLENBQUMsU0FBUztJQUMzRSxNQUFNLFdBQVcsd0JBQ2Y7SUFFRixJQUFJLFNBQVMsTUFBTSxHQUFHLEdBQUc7TUFDdkIsTUFBTSxZQUFZLHlCQUF5QjtNQUMzQyxRQUFRLEtBQUssQ0FBQztJQUNoQjtFQUNGO0VBRUEsd0VBQXdFO0VBQ3hFLHlFQUF5RTtFQUN6RSwyREFBMkQ7RUFDM0QsTUFBTSxRQUFRLG9CQUNaLEFBQUMsVUFBVSxLQUFLLENBQWdCLGVBQWU7RUFFakQsSUFBSSxDQUFDLE1BQU0sRUFBRSxFQUFFO0lBQ2IsTUFBTSxJQUFJLE1BQU0sQ0FBQyxZQUFZLEVBQUUsV0FBVyxhQUFhLEVBQUUsTUFBTSxLQUFLLEVBQUU7RUFDeEU7RUFFQSwyRUFBMkU7RUFDM0UsMkVBQTJFO0VBQzNFLDBFQUEwRTtFQUMxRSxzRUFBc0U7RUFDdEUsV0FBVztFQUNYLE1BQU0sWUFBWSx3QkFDaEIsQUFBQyxVQUFVLEtBQUssQ0FBZ0IsbUJBQW1CLEVBQ25EO0lBQUU7RUFBSTtFQUVSLElBQUksQ0FBQyxVQUFVLEVBQUUsRUFBRTtJQUNqQixNQUFNLElBQUksTUFBTSxDQUFDLFlBQVksRUFBRSxXQUFXLGFBQWEsRUFBRSxVQUFVLEtBQUssRUFBRTtFQUM1RTtFQUVBLDJFQUEyRTtFQUMzRSxzRUFBc0U7RUFDdEUsMkVBQTJFO0VBQzNFLHlDQUF5QztFQUN6QyxNQUFNLE9BQU8sVUFBVSxLQUFLO0VBQzVCLE1BQU0sbUJBQW1CLDJCQUEyQjtJQUNsRCxZQUFZLEtBQUssV0FBVztJQUM1QixXQUFXLEtBQUssVUFBVTtJQUMxQixvQkFBb0IsS0FBSyxvQkFBb0I7RUFDL0M7RUFDQSxJQUFJLGlCQUFpQixNQUFNLEdBQUcsR0FBRztJQUMvQixNQUFNLElBQUksTUFDUixDQUFDLFlBQVksRUFBRSxXQUFXLGFBQWEsRUFBRSxpQkFBaUIsSUFBSSxDQUFDLE1BQU07RUFFekU7RUFFQSx5RUFBeUU7RUFDekUsbUVBQW1FO0VBQ25FLE1BQU0sb0JBQW9CLHVCQUF1QixLQUFLLG1CQUFtQjtFQUN6RSxJQUFJLENBQUMsa0JBQWtCLEVBQUUsRUFBRTtJQUN6QixNQUFNLElBQUksTUFDUixDQUFDLFlBQVksRUFBRSxXQUFXLGFBQWEsRUFBRSxrQkFBa0IsS0FBSyxFQUFFO0VBRXRFO0VBRUEsT0FBTztBQUNUO0FBaUJBOzs7Ozs7Ozs7O0NBVUMsR0FDRCxPQUFPLGVBQWUsV0FDcEIsVUFBa0IsRUFDbEIsT0FBMkI7RUFFM0IsbUVBQW1FO0VBQ25FLE1BQU0sTUFBTSxTQUFTLE9BQU87RUFDNUIsTUFBTSxPQUFPLE1BQU0sZUFBZSxZQUFZO0VBQzlDLHFCQUFxQjtFQUVyQiwyRUFBMkU7RUFDM0Usc0VBQXNFO0VBQ3RFLHlFQUF5RTtFQUN6RSwyRUFBMkU7RUFDM0UsNkNBQTZDO0VBQzdDLE1BQU0saUJBQTJCLEVBQUU7RUFDbkMsTUFBTSxvQkFBb0IsS0FBSyxlQUFlLElBQUksRUFBRTtFQUNwRCxNQUFNLGdCQUF3QixpQkFBaUIsQ0FBQyxFQUFFLElBQUk7RUFFdEQsdUNBQXVDO0VBQ3ZDLE1BQU0sY0FBYyxLQUFLLFlBQVksSUFBSSxFQUFFO0VBQzNDLE1BQU0sYUFBYSxXQUFXLENBQUMsRUFBRSxJQUFJLGlCQUFpQjtFQUV0RCxvRUFBb0U7RUFDcEUseUVBQXlFO0VBQ3pFLHlFQUF5RTtFQUN6RSw0Q0FBNEM7RUFDNUMsTUFBTSxFQUFFLEtBQUssRUFBRSxVQUFVLEVBQUUsR0FBRyxnQkFBZ0IsS0FBSyxLQUFLLElBQUksRUFBRTtFQUM5RCxtQkFBbUIsWUFBWSxPQUFPLElBQUksQ0FBQyxLQUFLLFdBQVcsSUFBSSxDQUFDO0VBRWhFLGtFQUFrRTtFQUNsRSx1RUFBdUU7RUFDdkUsc0VBQXNFO0VBQ3RFLGlFQUFpRTtFQUNqRSxtRUFBbUU7RUFDbkUsc0VBQXNFO0VBQ3RFLFVBQVU7RUFDVixNQUFNLGNBQWM7SUFBQyxlQUFlLGdCQUFnQjtHQUFDO0VBRXJELDJFQUEyRTtFQUMzRSwwRUFBMEU7RUFDMUUsdUVBQXVFO0VBQ3ZFLDRFQUE0RTtFQUM1RSwyRUFBMkU7RUFDM0UsTUFBTSx1QkFBdUIsS0FBSyxxQkFBcUIsSUFDckQ7T0FBSTtHQUEyQjtFQUVqQyxNQUFNLGdCQUFnQixLQUFLLGNBQWM7RUFFekMsc0VBQXNFO0VBQ3RFLG9FQUFvRTtFQUNwRSx1REFBdUQ7RUFDdkQsTUFBTSxrQkFBa0IsS0FBSyxnQkFBZ0IsSUFBSSxFQUFFO0VBRW5ELDJFQUEyRTtFQUMzRSxnRUFBZ0U7RUFDaEUsOENBQThDO0VBQzlDLE1BQU0sY0FBYyxLQUFLLGFBQWEsSUFBSTtFQUMxQyxNQUFNLGFBQWEsS0FBSyxZQUFZLElBQUk7RUFFeEMscUVBQXFFO0VBQ3JFLHNFQUFzRTtFQUN0RSxNQUFNLG9CQUE4QixxQkFDbEMsdUJBQ0EsS0FBSyxtQkFBbUIsSUFBSTtPQUFJO0dBQTRCLEVBQzVEO0VBR0YscUVBQXFFO0VBQ3JFLHFFQUFxRTtFQUNyRSxNQUFNLDJCQUFxQyxxQkFDekMsb0JBQ0EsS0FBSyxnQkFBZ0IsSUFBSSxFQUFFLEVBQzNCO0VBR0Ysc0VBQXNFO0VBQ3RFLHVFQUF1RTtFQUN2RSwwREFBMEQ7RUFDMUQsc0VBQXNFO0VBQ3RFLG9FQUFvRTtFQUNwRSx3RUFBd0U7RUFDeEUsdUVBQXVFO0VBQ3ZFLHNFQUFzRTtFQUN0RSxTQUFTO0VBQ1QsTUFBTSxpQkFBaUIsK0JBQ3JCLDBCQUNBO0VBR0YsdUVBQXVFO0VBQ3ZFLG9FQUFvRTtFQUNwRSxrRUFBa0U7RUFDbEUsbUVBQW1FO0VBQ25FLE1BQU0sY0FBYyxlQUFlLFdBQVc7RUFDOUMsTUFBTSxrQkFBa0IsS0FBSyxpQkFBaUIsSUFDNUMsZUFBZSxlQUFlO0VBQ2hDLE1BQU0sY0FBYyxLQUFLLFlBQVksSUFBSSxlQUFlLFdBQVc7RUFDbkUsTUFBTSxtQkFBbUIsS0FBSyxrQkFBa0IsSUFDOUMsZUFBZSxnQkFBZ0I7RUFDakMsTUFBTSxnQkFBZ0IsS0FBSyxjQUFjLElBQUksZUFBZSxhQUFhO0VBQ3pFLE1BQU0sZ0JBQWdCLEtBQUssY0FBYyxJQUFJLGVBQWUsYUFBYTtFQUN6RSxNQUFNLHFCQUFxQixLQUFLLG9CQUFvQixJQUNsRCxlQUFlLGtCQUFrQjtFQUNuQyxNQUFNLGtCQUFrQixLQUFLLGlCQUFpQixJQUM1QyxlQUFlLGVBQWU7RUFDaEMsTUFBTSxlQUFlLEtBQUssY0FBYyxJQUFJLGVBQWUsWUFBWTtFQUN2RSxNQUFNLGNBQWMsS0FBSyxZQUFZLElBQUksZUFBZSxXQUFXO0VBQ25FLGdGQUFnRjtFQUNoRixNQUFNLG1CQUFtQixlQUFlLGdCQUFnQjtFQUV4RCxNQUFNLE9BQU8sSUFBSSxXQUFXO0VBQzVCLE1BQU0sVUFBVSxHQUFHLEtBQUssZ0JBQWdCLENBQUM7RUFFekMsdUVBQXVFO0VBQ3ZFLHlFQUF5RTtFQUN6RSxtRUFBbUU7RUFDbkUsNEVBQTRFO0VBQzVFLHNFQUFzRTtFQUN0RSwwRUFBMEU7RUFDMUUsTUFBTSxVQUFVLGVBQWU7SUFBRSxZQUFZLEtBQUssUUFBUTtJQUFFO0VBQUk7RUFFaEUseUVBQXlFO0VBQ3pFLDJFQUEyRTtFQUMzRSwyRUFBMkU7RUFDM0Usd0VBQXdFO0VBQ3hFLE1BQU0sYUFBYSxLQUFLLFdBQVcsSUFBSTtFQUN2QyxNQUFNLFlBQVksS0FBSyxVQUFVO0VBQ2pDLE1BQU0scUJBQXFCLEtBQUssb0JBQW9CO0VBRXBELHFFQUFxRTtFQUNyRSwwRUFBMEU7RUFDMUUsdUVBQXVFO0VBQ3ZFLDRFQUE0RTtFQUM1RSwyRUFBMkU7RUFDM0UsNEVBQTRFO0VBQzVFLG9FQUFvRTtFQUNwRSx1RUFBdUU7RUFDdkUsdUVBQXVFO0VBQ3ZFLHVEQUF1RDtFQUN2RCwwRUFBMEU7RUFDMUUsNEVBQTRFO0VBQzVFLDJFQUEyRTtFQUMzRSx5RUFBeUU7RUFDekUscUVBQXFFO0VBQ3JFLGdCQUFnQjtFQUNoQixNQUFNLGdCQUFnQix1QkFBdUI7SUFDM0MsWUFBWSxLQUFLLGNBQWM7SUFDL0I7RUFDRjtFQUNBLHVFQUF1RTtFQUN2RSw2REFBNkQ7RUFDN0QsMEVBQTBFO0VBQzFFLHNFQUFzRTtFQUN0RSxzRUFBc0U7RUFDdEUsMkVBQTJFO0VBQzNFLGdFQUFnRTtFQUNoRSx5RUFBeUU7RUFDekUsb0RBQW9EO0VBQ3BELElBQUksQ0FBQyxvQ0FBb0M7SUFDdkMsNkJBQTZCO0VBQy9CO0VBRUEsNkVBQTZFO0VBQzdFLHdFQUF3RTtFQUN4RSw2RUFBNkU7RUFDN0UsMEVBQTBFO0VBQzFFLGlFQUFpRTtFQUNqRSx3QkFBd0I7RUFDeEIsNEVBQTRFO0VBQzVFLHlEQUF5RDtFQUN6RCxxQ0FBcUM7RUFDckMsTUFBTSwwQkFBMEIsK0JBQStCO0lBQzdELHVFQUF1RTtJQUN2RSx3RUFBd0U7SUFDeEUsd0VBQXdFO0lBQ3hFLHNFQUFzRTtJQUN0RTtJQUNBLFlBQVksS0FBSyxjQUFjO0lBQy9CLHFCQUFxQixLQUFLLGVBQWU7RUFDM0M7RUFDQSxxQ0FBcUM7RUFFckMsMEVBQTBFO0VBQzFFLHVFQUF1RTtFQUN2RSxJQUFJO0lBQ0YsdUJBQXVCO01BQ3JCLG9CQUFvQjtNQUNwQixpQkFBaUIsQ0FBQyxLQUFLLGFBQWEsSUFBSSxFQUFFLEVBQUUsSUFBSSxPQUFPLE1BQ3JELHVCQUF1QixTQUFTO01BQ2xDLGtCQUFrQixJQUFJO01BQ3RCLFlBQVksS0FBSyxrQkFBa0I7SUFDckM7RUFDRixFQUFFLE9BQU8sS0FBSztJQUNaLE1BQU0sVUFBVSxlQUFlLFFBQVEsSUFBSSxPQUFPLEdBQUcsT0FBTztJQUM1RCxNQUFNLElBQUksTUFBTSxDQUFDLFlBQVksRUFBRSxXQUFXLGFBQWEsRUFBRSxTQUFTO0VBQ3BFO0VBRUEsMkVBQTJFO0VBQzNFLDBFQUEwRTtFQUMxRSx1RUFBdUU7RUFDdkUsb0VBQW9FO0VBQ3BFLE1BQU0seUJBQXlCLDhCQUE4QjtJQUMzRCxXQUFXO0lBQ1gsU0FBUztJQUNULFVBQVUsS0FBSyx1QkFBdUI7RUFDeEM7RUFDQSxvQ0FBb0M7RUFDcEMsTUFBTSx3QkFBd0IsdUJBQXVCLFlBQVk7RUFFakUsbUVBQW1FO0VBQ25FLDBFQUEwRTtFQUMxRSwwRUFBMEU7RUFDMUUsd0VBQXdFO0VBQ3hFLGlCQUFpQjtFQUNqQixNQUFNLGNBQWMsS0FBSyxZQUFZLElBQUk7RUFFekMsNkVBQTZFO0VBQzdFLDBFQUEwRTtFQUMxRSxNQUFNLG9CQUFvQixLQUFLLG1CQUFtQixJQUNoRDtFQUVGLDBFQUEwRTtFQUMxRSxNQUFNLGlCQUFpQix1QkFDckIsS0FBSyxnQkFBZ0IsSUFBSTtFQUUzQixNQUFNLGdCQUFnQixLQUFLLGNBQWMsSUFDdkMscUJBQXFCLGFBQWE7RUFDcEMsaUVBQWlFO0VBQ2pFLGtFQUFrRTtFQUNsRSx5RUFBeUU7RUFDekUseUVBQXlFO0VBQ3pFLDJFQUEyRTtFQUMzRSxNQUFNLHdCQUF3QixLQUFLLHdCQUF3QixJQUN6RCx5QkFBeUIsNEJBQTRCLFFBQ3JELHFCQUFxQixxQkFBcUI7RUFDNUMsdUVBQXVFO0VBQ3ZFLG9FQUFvRTtFQUNwRSxzRUFBc0U7RUFDdEUsdUVBQXVFO0VBQ3ZFLDRFQUE0RTtFQUM1RSxNQUFNLG1CQUFtQixLQUFLLGtCQUFrQixJQUM5QyxxQkFBcUIsZ0JBQWdCO0VBQ3ZDLElBQUksQ0FBQyxPQUFPLFFBQVEsQ0FBQyxtQkFBbUI7SUFDdEMsTUFBTSxJQUFJLE1BQ1IsQ0FBQyxnREFBZ0QsQ0FBQyxHQUNoRCxHQUFHLE9BQU8sa0JBQWtCLENBQUMsQ0FBQztFQUVwQztFQUNBLElBQUksb0JBQW9CLDRCQUE0QjtJQUNsRCxNQUFNLElBQUksTUFDUixDQUFDLGdFQUFnRSxDQUFDLEdBQ2hFLENBQUMsQ0FBQyxFQUFFLDJCQUEyQixPQUFPLEVBQUUsaUJBQWlCLGFBQWEsQ0FBQyxHQUN2RSxDQUFDLGdFQUFnRSxDQUFDLEdBQ2xFLENBQUMsaURBQWlELENBQUM7RUFFekQ7RUFDQSx5RUFBeUU7RUFDekUsdUVBQXVFO0VBQ3ZFLE1BQU0scUJBQXFCLEtBQUsscUJBQXFCLElBQ25EO09BQUk7R0FBd0I7RUFDOUIsc0VBQXNFO0VBQ3RFLDJFQUEyRTtFQUMzRSxzRUFBc0U7RUFDdEUsTUFBTSwyQkFBMkIsS0FBSywwQkFBMEIsSUFDOUQscUJBQXFCLHdCQUF3QjtFQUMvQywwRUFBMEU7RUFDMUUsMkVBQTJFO0VBQzNFLDBFQUEwRTtFQUMxRSx1RUFBdUU7RUFDdkUsNkVBQTZFO0VBQzdFLE1BQU0seUJBQXlCLEtBQUssd0JBQXdCLElBQzFELHFCQUFxQixzQkFBc0I7RUFDN0MsTUFBTSxnQ0FBZ0MsS0FBSyxnQ0FBZ0MsSUFDekUscUJBQXFCLDZCQUE2QjtFQUNwRCxNQUFNLGdDQUFnQyxLQUFLLGdDQUFnQyxJQUN6RSxxQkFBcUIsNkJBQTZCO0VBQ3BELElBQUksaUNBQWlDLEdBQUc7SUFDdEMsTUFBTSxJQUFJLE1BQ1IsQ0FBQyx1REFBdUQsQ0FBQyxHQUN2RCxHQUFHLDhCQUE4QixvQ0FBb0MsQ0FBQyxHQUN0RSxDQUFDLCtDQUErQyxDQUFDO0VBRXZEO0VBQ0EsSUFBSSxpQ0FBaUMsR0FBRztJQUN0QyxNQUFNLElBQUksTUFDUixDQUFDLHVEQUF1RCxDQUFDLEdBQ3ZELEdBQUcsOEJBQThCLG9DQUFvQyxDQUFDLEdBQ3RFLENBQUMsb0RBQW9ELENBQUM7RUFFNUQ7RUFDQSxNQUFNLGdDQUFnQyxLQUFLLGdDQUFnQyxJQUN6RSxxQkFBcUIsNkJBQTZCO0VBQ3BELElBQUksaUNBQWlDLEdBQUc7SUFDdEMsTUFBTSxJQUFJLE1BQ1IsQ0FBQyx1REFBdUQsQ0FBQyxHQUN2RCxHQUFHLDhCQUE4QixnQ0FBZ0MsQ0FBQyxHQUNsRSxDQUFDLHVEQUF1RCxDQUFDO0VBRS9EO0VBQ0Esd0VBQXdFO0VBQ3hFLDBFQUEwRTtFQUMxRSxNQUFNLGdDQUFnQyxLQUFLLGdDQUFnQyxJQUN6RSxxQkFBcUIsNkJBQTZCO0VBQ3BELElBQ0UsT0FBTyxrQ0FBa0MsWUFDekMsQ0FBQyxPQUFPLFFBQVEsQ0FBQyxrQ0FDakIsaUNBQWlDLEdBQ2pDO0lBQ0EsTUFBTSxJQUFJLE1BQ1IsQ0FBQyxtRUFBbUUsQ0FBQyxHQUNuRSxDQUFDLElBQUksRUFBRSxLQUFLLFNBQVMsQ0FBQyxLQUFLLGdDQUFnQyxHQUFHO0VBRXBFO0VBQ0EsNEVBQTRFO0VBQzVFLG9FQUFvRTtFQUNwRSxNQUFNLDZCQUE2QixLQUFLLDhCQUE4QixJQUNwRSxxQkFBcUIsMEJBQTBCO0VBQ2pELElBQ0UsT0FBTywrQkFBK0IsWUFDdEMsQ0FBQyxPQUFPLFFBQVEsQ0FBQywrQkFDakIsOEJBQThCLEdBQzlCO0lBQ0EsTUFBTSxJQUFJLE1BQ1IsQ0FBQyxpRUFBaUUsQ0FBQyxHQUNqRSxDQUFDLElBQUksRUFBRSxLQUFLLFNBQVMsQ0FBQyxLQUFLLDhCQUE4QixHQUFHO0VBRWxFO0VBQ0EsSUFBSSxnQ0FBZ0MsK0JBQStCO0lBQ2pFLDBFQUEwRTtJQUMxRSx1RUFBdUU7SUFDdkUseUNBQXlDO0lBQ3pDLE1BQU0sSUFBSSxNQUNSLENBQUMsa0RBQWtELENBQUMsR0FDbEQsQ0FBQyxzQ0FBc0MsQ0FBQyxHQUN4QyxHQUFHLDhCQUE4QixHQUFHLEVBQUUsOEJBQThCLEVBQUUsQ0FBQyxHQUN2RSxDQUFDLG9FQUFvRSxDQUFDLEdBQ3RFLENBQUMsOENBQThDLENBQUM7RUFFdEQ7RUFDQSx3RUFBd0U7RUFDeEUsNEVBQTRFO0VBQzVFLDZEQUE2RDtFQUM3RCxNQUFNLG1CQUFtQixLQUFLLGtCQUFrQixJQUM5QyxxQkFBcUIsZ0JBQWdCO0VBQ3ZDLE1BQU0saUJBQWlCLEtBQUssZ0JBQWdCLElBQzFDLHFCQUFxQixjQUFjO0VBQ3JDLE1BQU0seUJBQXlCLEtBQUsseUJBQXlCLElBQzNELHFCQUFxQixzQkFBc0I7RUFDN0MsTUFBTSxzQkFBc0IsS0FBSyxzQkFBc0IsSUFDckQscUJBQXFCLG1CQUFtQjtFQUMxQyx1RUFBdUU7RUFDdkUscURBQXFEO0VBQ3JELElBQ0UsQ0FBQyxPQUFPLFFBQVEsQ0FBQyx3QkFBd0IsdUJBQXVCLEtBQ2hFLHNCQUFzQixHQUN0QjtJQUNBLE1BQU0sSUFBSSxNQUNSLENBQUMsMERBQTBELENBQUMsR0FDMUQsR0FBRyxvQkFBb0IsMENBQTBDLENBQUMsR0FDbEUsQ0FBQyxpRUFBaUUsQ0FBQztFQUV6RTtFQUNBLElBQUksa0JBQWtCLEdBQUc7SUFDdkIsTUFBTSxJQUFJLE1BQ1IsQ0FBQyx1Q0FBdUMsRUFBRSxlQUFlLElBQUksQ0FBQyxHQUM1RCxDQUFDLGtFQUFrRSxDQUFDLEdBQ3BFLENBQUMsNERBQTRELENBQUM7RUFFcEU7RUFDQSxJQUFJLDBCQUEwQixHQUFHO0lBQy9CLE1BQU0sSUFBSSxNQUNSLENBQUMsZ0RBQWdELENBQUMsR0FDaEQsR0FBRyx1QkFBdUIsdUNBQXVDLENBQUMsR0FDbEUsQ0FBQyxxRUFBcUUsQ0FBQztFQUU3RTtFQUNBLDBFQUEwRTtFQUMxRSwwRUFBMEU7RUFDMUUsb0VBQW9FO0VBQ3BFLE1BQU0sMEJBQTBCLHVCQUF1QjtFQUN2RCxJQUFJLHlCQUF5Qix5QkFBeUI7SUFDcEQsTUFBTSxJQUFJLE1BQ1IsQ0FBQyw4Q0FBOEMsQ0FBQyxHQUM5QyxHQUFHLHdCQUF3QixvQ0FBb0MsQ0FBQyxHQUNoRSxDQUFDLHFCQUFxQixFQUFFLHVCQUF1QixpQkFBaUIsQ0FBQyxHQUNqRSxDQUFDLGdFQUFnRSxDQUFDO0VBRXhFO0VBQ0EsSUFBSSxpQkFBaUIsdUJBQXVCO0lBQzFDLE1BQU0sSUFBSSxNQUNSLENBQUMscUNBQXFDLEVBQUUsc0JBQXNCLE1BQU0sQ0FBQyxHQUNuRSxDQUFDLHdDQUF3QyxFQUFFLGVBQWUsV0FBVyxDQUFDLEdBQ3RFLENBQUMsZ0VBQWdFLENBQUM7RUFFeEU7RUFDQSx3RUFBd0U7RUFDeEUsMEVBQTBFO0VBQzFFLHdFQUF3RTtFQUN4RSx3RUFBd0U7RUFDeEUsTUFBTSxxQkFBcUIsS0FBSyxxQkFBcUIsSUFDbkQscUJBQXFCLGtCQUFrQjtFQUN6QyxNQUFNLG9CQUFvQixLQUFLLG9CQUFvQixJQUNqRCxxQkFBcUIsaUJBQWlCO0VBQ3hDLE1BQU0scUJBQXFCLEtBQUsscUJBQXFCLElBQ25ELHFCQUFxQixrQkFBa0I7RUFDekMsSUFBSSxDQUFDLE9BQU8sU0FBUyxDQUFDLHVCQUF1QixxQkFBcUIsR0FBRztJQUNuRSxNQUFNLElBQUksTUFDUixDQUFDLG1FQUFtRSxDQUFDLEdBQ25FLENBQUMsT0FBTyxFQUFFLG1CQUFtQix3Q0FBd0MsQ0FBQztFQUU1RTtFQUNBLElBQUksQ0FBQyxPQUFPLFNBQVMsQ0FBQyxvQkFBb0I7SUFDeEMsTUFBTSxJQUFJLE1BQ1IsQ0FBQywwREFBMEQsQ0FBQyxHQUMxRCxDQUFDLGlCQUFpQixFQUFFLGtCQUFrQixDQUFDLENBQUM7RUFFOUM7RUFDQSxJQUFJLENBQUMsT0FBTyxTQUFTLENBQUMsdUJBQXVCLHFCQUFxQixHQUFHO0lBQ25FLE1BQU0sSUFBSSxNQUNSLENBQUMsbUVBQW1FLENBQUMsR0FDbkUsQ0FBQyxPQUFPLEVBQUUsbUJBQW1CLHdDQUF3QyxDQUFDO0VBRTVFO0VBQ0EsSUFBSSxxQkFBcUIsb0JBQW9CO0lBQzNDLE1BQU0sSUFBSSxNQUNSLENBQUMsaUVBQWlFLENBQUMsR0FDakUsR0FBRyxtQkFBbUIsT0FBTyxFQUFFLG1CQUFtQixnQkFBZ0IsQ0FBQyxHQUNuRSxDQUFDLGlFQUFpRSxDQUFDLEdBQ25FLENBQUMsa0RBQWtELENBQUM7RUFFMUQ7RUFDQSx5RUFBeUU7RUFDekUseUVBQXlFO0VBQ3pFLHVEQUF1RDtFQUN2RCxNQUFNLHVCQUF1QixLQUFLLHVCQUF1QixJQUN2RCxxQkFBcUIsb0JBQW9CO0VBQzNDLE1BQU0sd0JBQXdCLEtBQUssd0JBQXdCLElBQ3pELHFCQUFxQixxQkFBcUI7RUFDNUMsS0FDRSxNQUFNLENBQUMsS0FBSyxNQUFNLElBQUk7SUFDcEI7TUFBQztNQUEyQjtLQUFxQjtJQUNqRDtNQUFDO01BQTRCO0tBQXNCO0dBQ3BELENBQ0Q7SUFDQSxJQUFJLENBQUMsT0FBTyxTQUFTLENBQUMsVUFBVSxRQUFRLEdBQUc7TUFDekMsTUFBTSxJQUFJLE1BQ1IsR0FBRyxJQUFJLHFEQUFxRCxDQUFDLEdBQzNELEdBQUcsTUFBTSw0Q0FBNEMsQ0FBQztJQUU1RDtFQUNGO0VBQ0Esd0VBQXdFO0VBQ3hFLHdFQUF3RTtFQUN4RSxvRUFBb0U7RUFDcEUsMkVBQTJFO0VBQzNFLGtCQUFrQjtFQUNsQixNQUFNLGlDQUNKLEtBQUssaUNBQWlDLElBQ3BDLHFCQUFxQiw4QkFBOEI7RUFDdkQsTUFBTSxxQ0FDSixLQUFLLHVDQUF1QyxJQUMxQyxxQkFBcUIsa0NBQWtDO0VBQzNELElBQ0UsQ0FBQyxPQUFPLFNBQVMsQ0FBQyx1Q0FDbEIscUNBQXFDLEdBQ3JDO0lBQ0EsTUFBTSxJQUFJLE1BQ1IsQ0FBQywrREFBK0QsQ0FBQyxHQUMvRCxDQUFDLGFBQWEsRUFBRSxtQ0FBbUMsa0JBQWtCLENBQUMsR0FDdEUsQ0FBQyxvQ0FBb0MsQ0FBQyxHQUN0QyxDQUFDLDhEQUE4RCxDQUFDO0VBRXRFO0VBRUEsd0VBQXdFO0VBQ3hFLHlFQUF5RTtFQUN6RSx1RUFBdUU7RUFDdkUsMENBQTBDO0VBQzFDLE1BQU0sb0JBQW9CLEtBQUssbUJBQW1CLElBQ2hELEtBQUssY0FBYyxJQUNuQixxQkFBcUIsaUJBQWlCO0VBQ3hDLE1BQU0sZUFBZSxLQUFLLGNBQWMsSUFDdEMsS0FBSyxjQUFjLElBQ25CLHFCQUFxQixZQUFZO0VBQ25DLE1BQU0sa0JBQWtCLEtBQUssaUJBQWlCLElBQzVDLHFCQUFxQixlQUFlO0VBQ3RDLE1BQU0seUJBQXlCLEtBQUssd0JBQXdCLElBQzFELHFCQUFxQixzQkFBc0I7RUFDN0MsTUFBTSxnQkFBZ0IsS0FBSyxjQUFjLElBQ3ZDLHFCQUFxQixhQUFhO0VBQ3BDLElBQ0UsS0FBSyxtQkFBbUIsS0FBSyxhQUM3QixPQUFPLEtBQUssbUJBQW1CLEtBQUssV0FDcEM7SUFDQSxNQUFNLElBQUksTUFBTTtFQUNsQjtFQUNBLE1BQU0sb0JBQW9CLEtBQUssbUJBQW1CLElBQUk7RUFDdEQsTUFBTSxzQkFBc0IsS0FBSyxxQkFBcUIsSUFDcEQscUJBQXFCLG1CQUFtQjtFQUMxQyxNQUFNLHFCQUFxQixLQUFLLG9CQUFvQixJQUNsRCxxQkFBcUIsa0JBQWtCO0VBQ3pDLE1BQU0sb0JBQW9CLEtBQUssa0JBQWtCLElBQy9DLHFCQUFxQixpQkFBaUI7RUFDeEMsTUFBTSxzQkFBc0IsS0FBSyxxQkFBcUIsSUFDcEQscUJBQXFCLG1CQUFtQjtFQUMxQyxNQUFNLGtCQUFrQixLQUFLLGdCQUFnQixJQUMzQyxxQkFBcUIsZUFBZTtFQUN0QyxNQUFNLG9CQUFvQixLQUFLLG1CQUFtQixJQUNoRCxxQkFBcUIsaUJBQWlCO0VBQ3hDLE1BQU0sa0JBQWtCLEtBQUssZ0JBQWdCLElBQzNDLHFCQUFxQixlQUFlO0VBQ3RDLE1BQU0sb0JBQW9CLEtBQUssbUJBQW1CLElBQ2hELHFCQUFxQixpQkFBaUI7RUFDeEMsTUFBTSx1QkFBdUIsS0FBSyxxQkFBcUIsSUFDckQscUJBQXFCLG9CQUFvQjtFQUMzQyxNQUFNLHlCQUF5QixLQUFLLHdCQUF3QixJQUMxRCxxQkFBcUIsc0JBQXNCO0VBQzdDLE1BQU0sbUJBQW1CLEtBQUssbUJBQW1CLElBQy9DLHFCQUFxQixnQkFBZ0I7RUFDdkMsTUFBTSxpQkFBaUIsS0FBSyxnQkFBZ0IsSUFDMUMscUJBQXFCLGNBQWM7RUFDckMsTUFBTSxtQkFBbUIsS0FBSyxtQkFBbUIsSUFDL0MscUJBQXFCLGdCQUFnQjtFQUN2QywyRUFBMkU7RUFDM0UsdUVBQXVFO0VBQ3ZFLHdFQUF3RTtFQUN4RSxNQUFNLGdCQUFnQixLQUFLLGNBQWMsSUFDdkMscUJBQXFCLGFBQWE7RUFDcEMsTUFBTSxrQkFBa0IsS0FBSyxpQkFBaUIsSUFDNUMscUJBQXFCLGVBQWU7RUFDdEMsTUFBTSxpQkFBaUIsS0FBSyxlQUFlLElBQUk7RUFDL0MsSUFBSSxlQUFlLE1BQU0sS0FBSyxHQUFHO0lBQy9CLE1BQU0sSUFBSSxNQUNSLENBQUMsOERBQThELENBQUMsR0FDOUQsR0FBRyxlQUFlLE1BQU0sQ0FBQyw2Q0FBNkMsQ0FBQztFQUU3RTtFQUNBLE1BQU0sY0FBYyxLQUFLLFlBQVksSUFBSTtFQUN6QyxNQUFNLHNCQUFzQixLQUFLLHNCQUFzQixJQUNyRCxxQkFBcUIsbUJBQW1CO0VBQzFDLE1BQU0sbUJBQW1CLEtBQUssbUJBQW1CLElBQy9DLHFCQUFxQixnQkFBZ0I7RUFDdkMsNEVBQTRFO0VBQzVFLDRFQUE0RTtFQUM1RSxrRUFBa0U7RUFDbEUsTUFBTSwyQkFBMkIsS0FBSywyQkFBMkIsSUFDL0QscUJBQXFCLHdCQUF3QjtFQUMvQyxJQUNFLE9BQU8sNkJBQTZCLFlBQ3BDLENBQUMsT0FBTyxRQUFRLENBQUMsNkJBQ2pCLDJCQUEyQixLQUFLLDJCQUEyQixJQUMzRDtJQUNBLE1BQU0sSUFBSSxNQUNSLENBQUMsbUVBQW1FLENBQUMsR0FDbkUsR0FBRyxLQUFLLFNBQVMsQ0FBQyxLQUFLLDJCQUEyQixHQUFHO0VBRTNEO0VBQ0EsTUFBTSxnQkFBZ0IsS0FBSyxlQUFlLElBQ3hDLHFCQUFxQixhQUFhO0VBQ3BDLE1BQU0scUJBQXFCLEtBQUsscUJBQXFCLElBQ25ELHFCQUFxQixrQkFBa0I7RUFDekMsTUFBTSxtQkFBbUIsS0FBSyxpQkFBaUIsSUFDN0MscUJBQXFCLGdCQUFnQjtFQUN2QyxNQUFNLHFCQUFxQixLQUFLLG9CQUFvQixJQUNsRCxxQkFBcUIsa0JBQWtCO0VBQ3pDLE1BQU0sc0JBQXNCLEtBQUsscUJBQXFCLElBQ3BELHFCQUFxQixtQkFBbUI7RUFDMUMsTUFBTSx3QkFBd0IsS0FBSyx3QkFBd0IsSUFDekQscUJBQXFCLHFCQUFxQjtFQUM1QyxNQUFNLHNCQUFzQixLQUFLLHFCQUFxQixJQUNwRCxxQkFBcUIsbUJBQW1CO0VBRTFDLHVDQUF1QztFQUN2QyxNQUFNLGlCQUFpQixLQUFLLGdCQUFnQixJQUMxQyxxQkFBcUIsY0FBYztFQUVyQyx5Q0FBeUM7RUFDekMsTUFBTSxlQUFlLEtBQUssYUFBYSxJQUFJO0VBRTNDLHVEQUF1RDtFQUN2RCxNQUFNLGFBQWEsS0FBSyxXQUFXLElBQUk7RUFFdkMsNkNBQTZDO0VBQzdDLE1BQU0sc0JBQXNCLEtBQUsscUJBQXFCLElBQ3BELHFCQUFxQixtQkFBbUI7RUFFMUMsb0VBQW9FO0VBQ3BFLE1BQU0saUJBQWlCLEtBQUssaUJBQWlCLElBQzNDLHFCQUFxQixjQUFjO0VBRXJDLDRFQUE0RTtFQUM1RSx3RUFBd0U7RUFDeEUsdUVBQXVFO0VBQ3ZFLGtFQUFrRTtFQUNsRSxNQUFNLHFCQUFxQixLQUFLLHNCQUFzQjtFQUN0RCxNQUFNLDBCQUEwQixLQUFLLDJCQUEyQjtFQUVoRSwrQ0FBK0M7RUFDL0MsTUFBTSx3QkFBd0IsS0FBSyx1QkFBdUIsSUFDeEQscUJBQXFCLHFCQUFxQjtFQUU1QywrRUFBK0U7RUFDL0UsTUFBTSw0QkFBNEIsS0FBSyw0QkFBNEIsSUFDakUscUJBQXFCLHlCQUF5QjtFQUNoRCxNQUFNLDJCQUEyQixLQUFLLDJCQUEyQixJQUMvRCxxQkFBcUIsd0JBQXdCO0VBRS9DLHFEQUFxRDtFQUNyRCxNQUFNLHFCQUFxQixLQUFLLG9CQUFvQixJQUNsRCxxQkFBcUIsa0JBQWtCO0VBQ3pDLE1BQU0sMkJBQTJCLEtBQUssMkJBQTJCLElBQy9ELHFCQUFxQix3QkFBd0I7RUFDL0MsTUFBTSw2QkFBNkIsS0FBSyw4QkFBOEIsSUFDcEUscUJBQXFCLDBCQUEwQjtFQUVqRCxNQUFNLGFBQWEsbUJBQ2pCLEtBQUssaUJBQWlCLEVBQ3RCLEtBQUssb0JBQW9CLEVBQ3pCO0VBR0YsK0NBQStDO0VBQy9DLE1BQU0sc0JBQThDO0lBQ2xELEdBQUcsV0FBVyxNQUFNO0lBQ3BCLEdBQUksS0FBSyxxQkFBcUIsSUFBSSxDQUFDLENBQUM7RUFDdEM7RUFFQSxnREFBZ0Q7RUFDaEQsTUFBTSx1QkFDSixLQUFLLHNCQUFzQixJQUFJLENBQUM7RUFFbEMsMkRBQTJEO0VBQzNELE1BQU0sMkJBQW1EO0lBQ3ZELEdBQUcsV0FBVyxLQUFLO0lBQ25CLEdBQUksS0FBSywyQkFBMkIsSUFBSSxDQUFDLENBQUM7RUFDNUM7RUFDQSxNQUFNLDRCQUNKLEtBQUssNEJBQTRCLElBQUksQ0FBQztFQUV4QyxxREFBcUQ7RUFDckQsTUFBTSw0QkFBb0Q7SUFDeEQsR0FBRyxXQUFXLE1BQU07SUFDcEIsR0FBSSxLQUFLLDRCQUE0QixJQUFJLENBQUMsQ0FBQztFQUM3QztFQUVBLHVEQUF1RDtFQUN2RCxNQUFNLDhCQUFzRDtJQUMxRCxHQUFHLFdBQVcsUUFBUTtJQUN0QixHQUFJLEtBQUssOEJBQThCLElBQUksQ0FBQyxDQUFDO0VBQy9DO0VBRUEsMEVBQTBFO0VBQzFFLDZDQUE2QztFQUM3QyxNQUFNLHFCQUFxQixLQUFLLG9CQUFvQixJQUNsRCxxQkFBcUIsa0JBQWtCO0VBRXpDLDBFQUEwRTtFQUMxRSw2Q0FBNkM7RUFDN0MsTUFBTSxvQkFBb0IsNkJBQ3hCLEtBQUssb0JBQW9CO0VBRzNCLHFEQUFxRDtFQUNyRCxNQUFNLHNCQUFzQixLQUFLLHFCQUFxQixJQUNwRCxxQkFBcUIsbUJBQW1CO0VBRTFDLDBFQUEwRTtFQUMxRSxnRUFBZ0U7RUFDaEUsTUFBTSx3QkFBd0IsS0FBSyxzQkFBc0IsSUFDdkQscUJBQXFCLHFCQUFxQjtFQUM1QyxJQUFJLE9BQU8sMEJBQTBCLFdBQVc7SUFDOUMsTUFBTSxJQUFJLE1BQ1IsQ0FBQyxrREFBa0QsQ0FBQyxHQUNsRCxHQUFHLEtBQUssU0FBUyxDQUFDLEtBQUssc0JBQXNCLEdBQUc7RUFFdEQ7RUFDQSxNQUFNLGdDQUFnQywyQkFDcEMsS0FBSywrQkFBK0I7RUFHdEMseUVBQXlFO0VBQ3pFLDJDQUEyQztFQUMzQyxNQUFNLHlCQUF5QixLQUFLLGlCQUFpQixFQUFFO0VBQ3ZELE1BQU0sa0JBQWtCLDJCQUEyQixNQUMvQywyQkFBMkIsWUFDM0IsWUFDQTtFQUVKLDJEQUEyRDtFQUMzRCxNQUFNLDhCQUE4QixLQUFLLDZCQUE2QjtFQUV0RSxnRUFBZ0U7RUFDaEUsTUFBTSxzQkFBc0IsS0FBSyxxQkFBcUIsSUFDcEQscUJBQXFCLG1CQUFtQjtFQUUxQyxnQ0FBZ0M7RUFDaEMsTUFBTSxZQUNKLEFBQUMsS0FBSyxTQUFTLElBQW1DO0VBRXBELHFEQUFxRDtFQUNyRCxNQUFNLDhCQUE4QixLQUFLLDhCQUE4QixJQUNyRSxxQkFBcUIsMkJBQTJCO0VBQ2xELE1BQU0sNEJBQTRCLEtBQUssNEJBQTRCLElBQ2pFLHFCQUFxQix5QkFBeUI7RUFDaEQsNENBQTRDO0VBQzVDLE1BQU0sNEJBQTRCLEtBQUssNEJBQTRCLElBQ2pFLHFCQUFxQix5QkFBeUI7RUFFaEQsNENBQTRDO0VBQzVDLE1BQU0sMkJBQTJCLEtBQUssMEJBQTBCLElBQzlELHFCQUFxQix3QkFBd0I7RUFFL0MsbUNBQW1DO0VBQ25DLE1BQU0sMEJBQTBCLEtBQUssMEJBQTBCLElBQzdELHFCQUFxQix1QkFBdUI7RUFFOUMsNkRBQTZEO0VBQzdELE1BQU0sc0JBQXNCLEtBQUssc0JBQXNCLElBQ3JELHFCQUFxQixtQkFBbUI7RUFFMUMsbURBQW1EO0VBQ25ELE1BQU0sbUJBQW1CLEtBQUssbUJBQW1CLElBQy9DLHFCQUFxQixnQkFBZ0I7RUFFdkMsK0NBQStDO0VBQy9DLE1BQU0seUJBQXlCLEtBQUsseUJBQXlCLElBQzNELHFCQUFxQixzQkFBc0I7RUFDN0MsTUFBTSw0QkFBNEIsS0FBSyw0QkFBNEIsSUFDakU7T0FBSSxxQkFBcUIseUJBQXlCO0dBQUM7RUFFckQsOEZBQThGO0VBQzlGLE1BQU0sMkJBQTJCLEtBQUssMkJBQTJCLElBQy9ELHFCQUFxQix3QkFBd0I7RUFFL0Msb0ZBQW9GO0VBQ3BGLE1BQU0sc0JBQXNCLEtBQUssc0JBQXNCLElBQ3JELHFCQUFxQixtQkFBbUI7RUFFMUMsMkRBQTJEO0VBQzNELE1BQU0scUJBQXFCLEtBQUsscUJBQXFCLElBQ25ELHFCQUFxQixrQkFBa0I7RUFFekMsMEVBQTBFO0VBQzFFLHlFQUF5RTtFQUN6RSxNQUFNLGtDQUNKLEtBQUssbUNBQW1DO0VBRTFDLDBFQUEwRTtFQUMxRSxzRUFBc0U7RUFDdEUsTUFBTSxlQUFlLEtBQUssY0FBYztFQUV4Qyw0REFBNEQ7RUFDNUQsTUFBTSwwQkFDSixLQUFLLDBCQUEwQixJQUFJLENBQUM7RUFFdEMsNkVBQTZFO0VBQzdFLGdFQUFnRTtFQUNoRSxNQUFNLGtCQUFrQixxQkFBcUIsS0FBSyxpQkFBaUI7RUFFbkUseUVBQXlFO0VBQ3pFLE1BQU0sc0JBQ0osS0FBSyxxQkFBcUIsSUFDeEI7SUFBRSxHQUFHLHFCQUFxQixtQkFBbUI7RUFBQztFQUVsRCxzRUFBc0U7RUFDdEUseUVBQXlFO0VBQ3pFLHFFQUFxRTtFQUNyRSxpREFBaUQ7RUFDakQsRUFBRTtFQUNGLDRFQUE0RTtFQUM1RSxrRUFBa0U7RUFDbEUsRUFBRTtFQUNGLHdFQUF3RTtFQUN4RSxtRUFBbUU7RUFDbkUsc0VBQXNFO0VBQ3RFLDBFQUEwRTtFQUMxRSx5RUFBeUU7RUFDekUsTUFBTSxxQkFBcUIseUJBQ3pCLEtBQUssb0JBQW9CLEVBQ3pCO0lBQ0U7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0EsYUFBYSx5QkFBeUIsSUFBSTtFQUM1QztFQUdGLHlDQUF5QztFQUN6QyxNQUFNLHdCQUF3QixLQUFLLHVCQUF1QixJQUN4RCxxQkFBcUIscUJBQXFCO0VBQzVDLE1BQU0sOEJBQThCLEtBQUssK0JBQStCLElBQ3RFLHFCQUFxQiwyQkFBMkI7RUFDbEQsTUFBTSw0QkFBNEIsS0FBSyw0QkFBNEIsSUFDakUscUJBQXFCLHlCQUF5QjtFQUNoRCxNQUFNLDBCQUEwQixLQUFLLDBCQUEwQixJQUM3RCxxQkFBcUIsdUJBQXVCO0VBQzlDLE1BQU0sZ0NBQ0osS0FBSyxpQ0FBaUMsSUFDcEMscUJBQXFCLDZCQUE2QjtFQUN0RCxNQUFNLDBCQUEwQixLQUFLLDBCQUEwQixJQUM3RCxxQkFBcUIsdUJBQXVCO0VBRTlDLHVDQUF1QztFQUN2QyxNQUFNLHFCQUFxQixLQUFLLG9CQUFvQixJQUNsRCxxQkFBcUIsa0JBQWtCO0VBRXpDLDJFQUEyRTtFQUMzRSx3RUFBd0U7RUFDeEUsNkVBQTZFO0VBQzdFLE1BQU0seUJBQXlCLHNCQUFzQixLQUFLLGlCQUFpQjtFQUMzRSxJQUFJLENBQUMsdUJBQXVCLEVBQUUsRUFBRTtJQUM5QixNQUFNLElBQUksTUFDUixDQUFDLFlBQVksRUFBRSxXQUFXLGFBQWEsRUFBRSx1QkFBdUIsS0FBSyxFQUFFO0VBRTNFO0VBQ0EsTUFBTSxtQkFBbUIsdUJBQXVCLEtBQUs7RUFFckQsdUVBQXVFO0VBQ3ZFLDBFQUEwRTtFQUMxRSx3RUFBd0U7RUFDeEUsTUFBTSxrQkFBa0IsZUFBZSxLQUFLLFVBQVU7RUFDdEQsSUFBSSxDQUFDLGdCQUFnQixFQUFFLEVBQUU7SUFDdkIsTUFBTSxJQUFJLE1BQ1IsQ0FBQyxZQUFZLEVBQUUsV0FBVyxhQUFhLEVBQUUsZ0JBQWdCLEtBQUssRUFBRTtFQUVwRTtFQUNBLE1BQU0sWUFBWSxnQkFBZ0IsS0FBSztFQUV2QyxNQUFNLFNBQXVCO0lBQzNCO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBLHVCQUF1QjtJQUN2Qix1QkFBdUI7U0FBSTtLQUFzQjtJQUNqRCxxQkFBcUIsS0FBSyxzQkFBc0IsS0FBSztJQUNyRDtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQSxHQUFJLHVCQUF1QixZQUFZLENBQUMsSUFBSTtNQUFFO0lBQW1CLENBQUM7SUFDbEUsR0FBSSw0QkFBNEIsWUFDNUIsQ0FBQyxJQUNEO01BQUU7SUFBd0IsQ0FBQztJQUMvQjtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0E7SUFDQSx3RUFBd0U7SUFDeEUsdUVBQXVFO0lBQ3ZFLHlFQUF5RTtJQUN6RSwwQ0FBMEM7SUFDMUMsV0FBVyxzQkFBc0IsS0FBSyxTQUFTO0lBQy9DLDBFQUEwRTtJQUMxRSx5RUFBeUU7SUFDekUsaUNBQWlDO0lBQ2pDLGNBQWMseUJBQXlCLEtBQUssYUFBYTtJQUN6RCxZQUFZLHFCQUFxQixLQUFLLFdBQVc7SUFDakQsd0JBQXdCLHNCQUFzQixLQUFLLHVCQUF1QjtFQUM1RTtFQUVBLHlFQUF5RTtFQUN6RSxtRUFBbUU7RUFDbkUseUJBQXlCLE9BQU8sVUFBVTtFQUMxQyxzQkFBc0I7RUFDdEIsdUVBQXVFO0VBQ3ZFLDhCQUE4QixPQUFPLFVBQVU7RUFFL0MsK0RBQStEO0VBQy9ELElBQUksU0FBUyxVQUFVO0lBQ3JCLGVBQWU7RUFDakI7RUFFQSxPQUFPO0FBQ1Q7QUFFQTs7Ozs7O0NBTUMsR0FDRCxTQUFTLHlCQUNQLFVBQWtEO0VBRWxELElBQUksQ0FBQyxZQUFZO0VBQ2pCLEtBQUssTUFBTSxDQUFDLE1BQU0sSUFBSSxJQUFJLE9BQU8sT0FBTyxDQUFDLFlBQWE7SUFDcEQsTUFBTSxNQUFNLEFBQUMsSUFBZ0MsU0FBUztJQUN0RCxJQUFJLFFBQVEsV0FBVztJQUN2QixNQUFNLFNBQVMsdUJBQXVCO0lBQ3RDLElBQUksQ0FBQyxPQUFPLEVBQUUsRUFBRTtNQUNkLE1BQU0sSUFBSSxNQUNSLENBQUMsdUJBQXVCLEVBQUUsS0FBSyxFQUFFLEVBQUUsT0FBTyxLQUFLLEVBQUU7SUFFckQ7RUFDRjtBQUNGO0FBRUE7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVMsZUFBZSxNQUFvQjtFQUNqRCxJQUFJLE9BQU8sYUFBYSxLQUFLLFdBQVc7SUFDdEMsSUFBSSxDQUFDLHVCQUF1QixJQUFJLENBQUMsT0FBTyxhQUFhLEdBQUc7TUFDdEQsTUFBTSxJQUFJLE1BQ1IsQ0FBQyw2Q0FBNkMsRUFBRSxPQUFPLGFBQWEsQ0FBQyxHQUFHLENBQUMsR0FDdkU7SUFFTjtFQUNGO0VBRUEsSUFBSSxPQUFPLEtBQUssQ0FBQyxNQUFNLEtBQUssR0FBRztJQUM3QixNQUFNLElBQUksTUFDUiw2Q0FDRTtFQUVOO0VBRUEsdUVBQXVFO0VBQ3ZFLDZEQUE2RDtFQUM3RCxJQUFJLE9BQU8sV0FBVyxDQUFDLE1BQU0sS0FBSyxHQUFHO0lBQ25DLE1BQU0sSUFBSSxNQUNSLHdFQUNFLG9FQUNBO0VBRU47RUFFQSw0Q0FBNEM7RUFDNUMsS0FBSyxNQUFNLFFBQVEsT0FBTyxLQUFLLENBQUU7SUFDL0IsSUFBSSxDQUFDLGtCQUFrQixJQUFJLENBQUMsT0FBTztNQUNqQyxNQUFNLElBQUksTUFDUixDQUFDLGdEQUFnRCxFQUFFLEtBQUssR0FBRyxDQUFDLEdBQzFEO0lBRU47RUFDRjtFQUVBLGdFQUFnRTtFQUNoRSxNQUFNLGtCQUFrQjtFQUN4QixLQUFLLE1BQU0sVUFBVSxPQUFPLGNBQWMsQ0FBRTtJQUMxQyxJQUFJLENBQUMsZ0JBQWdCLElBQUksQ0FBQyxTQUFTO01BQ2pDLE1BQU0sSUFBSSxNQUNSLENBQUMsOENBQThDLEVBQUUsT0FBTyxxQkFBcUIsQ0FBQztJQUVsRjtFQUNGO0VBRUEsc0VBQXNFO0VBQ3RFLG1FQUFtRTtFQUNuRSwwRUFBMEU7RUFDMUUsc0VBQXNFO0VBQ3RFLHdFQUF3RTtFQUN4RSwyRUFBMkU7RUFDM0Usa0VBQWtFO0VBQ2xFLElBQ0UsdUJBQXVCO0lBQ3JCLGlCQUFpQixPQUFPLGVBQWUsSUFBSSxFQUFFO0lBQzdDLGdCQUFnQixPQUFPLGNBQWMsSUFBSSxFQUFFO0VBQzdDLEdBQUcsSUFBSSxLQUFLLEdBQ1o7SUFDQSxNQUFNLElBQUksTUFDUiwwRUFDRSxvRUFDQSx1RUFDQSxDQUFDLElBQUksRUFBRSx3QkFBd0IsSUFBSSxDQUFDLFlBQVksb0JBQW9CLENBQUMsR0FDckU7RUFFTjtBQUNGO0FBRUEsaUVBQWlFLEdBQ2pFLElBQUksdUJBQXVCO0FBRTNCLHVEQUF1RCxHQUN2RCxPQUFPLFNBQVM7RUFDZCx1QkFBdUI7QUFDekI7QUFFQTs7Ozs7OztDQU9DLEdBQ0QsU0FBUyxtQkFDUCxVQUF3QyxFQUN4QyxjQUFpQztFQUVqQyxJQUFJLFdBQVcsTUFBTSxLQUFLLEdBQUc7RUFDN0Isd0VBQXdFO0VBQ3hFLHdFQUF3RTtFQUN4RSxJQUFJLHNCQUFzQjtFQUMxQix1QkFBdUI7RUFFdkIsS0FBSyxNQUFNLFdBQVcsMEJBQTBCLFlBQVksZ0JBQWlCO0lBQzNFLFFBQVEsSUFBSSxDQUFDLENBQUMsSUFBSSxFQUFFLFNBQVM7RUFDL0I7QUFDRjtBQUVBLG1FQUFtRSxHQUNuRSxJQUFJLHlCQUF5QjtBQUU3Qiw0Q0FBNEMsR0FDNUMsT0FBTyxTQUFTO0VBQ2QseUJBQXlCO0FBQzNCO0FBRUE7Ozs7Ozs7Ozs7OztDQVlDLEdBQ0QsU0FBUyxxQkFBcUIsSUFBZ0I7RUFDNUMsMEVBQTBFO0VBQzFFLHdFQUF3RTtFQUN4RSxtREFBbUQ7RUFDbkQsSUFBSSx3QkFBd0I7RUFDNUIseUJBQXlCO0VBRXpCLE1BQU0sb0JBQW9CLEtBQUssZUFBZSxJQUFJLEVBQUU7RUFDcEQsSUFBSSxrQkFBa0IsTUFBTSxHQUFHLEdBQUc7SUFDaEMsUUFBUSxJQUFJLENBQ1YseUVBQ0Usd0VBQ0EsQ0FBQywwREFBMEQsRUFDekQsa0JBQWtCLElBQUksQ0FBQyxNQUN4QixnRUFBZ0UsQ0FBQyxHQUNsRTtFQUVOO0FBQ0Y7QUFFQTs7Ozs7Ozs7OztDQVVDLEdBQ0QsT0FBTyxTQUFTLGdCQUNkLE1BQW9CLEVBQ3BCLFFBQWdCO0VBRWhCLE1BQU0sTUFBTSxTQUFTLElBQUksR0FBRyxXQUFXO0VBQ3ZDLElBQUksQ0FBQyxLQUFLLE9BQU87RUFDakIsT0FBTyxPQUFPLGNBQWMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFNLEVBQUUsSUFBSSxHQUFHLFdBQVcsT0FBTztBQUN0RSJ9
// denoCacheMetadata=16975802218695334949,16306303545272161841