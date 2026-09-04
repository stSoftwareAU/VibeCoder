/**
 * Every `VIBE_*` name in the worker source, and what each one actually is
 * (Issue #874).
 *
 * #874 opens: "59 `VIBE_*` environment variables bypass `.config.json`".
 * The number could not be checked, because nothing listed them — so the first
 * thing this module does is make the claim falsifiable. Scanning `lib/`,
 * `commands/`, `setup/` and `mod.ts` for the `VIBE_*` shape finds **124**
 * names, and they are not one population:
 *
 * | Role | Count | Belongs in `.config.json`? |
 * | --- | --- | --- |
 * | {@linkcode VibeEnvRole `operator_config`} | 21 | **yes — this is the debt** |
 * | `setup_input` | 30 | already does; these fill it in |
 * | `launch_plumbing` | 23 | no — computed per run |
 * | `switch` | 30 | no — escape hatches and credentials |
 * | `marker` | 20 | not a variable at all |
 *
 * So the surface that genuinely bypasses the config file is **21**, not 59,
 * and 50 of the 124 were never configuration in the first place. That matters
 * for the plan as much as for the count: "give every `VIBE_*` a config key"
 * would have written a config key for a run id, a disk measurement and an
 * API key.
 *
 * The registry is not documentation that can rot. `vibe_env_registry_test.ts`
 * scans the same tree and fails when the set here and the set there differ in
 * **either** direction — an unclassified name is a new bypass nobody declared,
 * and a classified name that has left the tree is a stale entry, the trap a
 * stale `HOME_WORKDIR_ALLOWLIST` sprang on #805 and again on #808. The
 * `operator_config` count is capped the way the parallel-safety manifest is
 * capped: it may shrink, never grow.
 *
 * Modelled on {@link ./first_run_verification.ts}'s `WORKAROUND_ENV_VARS`,
 * which already declares a subset of these with a reason apiece.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/** What a `VIBE_*` name is, which decides whether it belongs in a config file. */
export type VibeEnvRole =
  /** Operator policy or a tunable. Belongs in `.config.json`; Issue #874. */
  | "operator_config"
  /** Read by `setup/` and written into `.config.json`. Stays. */
  | "setup_input"
  /** Computed at launch and handed to the guest. Stays. */
  | "launch_plumbing"
  /** A test, debug or setup switch, or a provisioned credential. Stays. */
  | "switch"
  /** A comment marker, delimiter or name that is not a variable at all. */
  | "marker";

/** One declared `VIBE_*` name. */
export interface VibeEnvEntry {
  /** What this name is. */
  readonly role: VibeEnvRole;
  /** What it does, in one line — the reason a reader can check the role. */
  readonly note: string;
  /**
   * The `.config.json` key. Required for `operator_config` (the key that will
   * replace it) and `setup_input` (the key it already writes); absent for
   * every other role, because there is nothing to configure.
   */
  readonly configKey?: string;
}

/**
 * Every `VIBE_*` name in `lib/`, `commands/`, `setup/` and `mod.ts`.
 *
 * To add one: declare it here with its role. If the role is
 * `operator_config`, the cap test fails — which is the point. A new operator
 * setting belongs in `.config.json`, where it is validated, diffable and
 * visible in one place; the environment is not where new configuration goes.
 */
export const VIBE_ENV_REGISTRY: Readonly<Record<string, VibeEnvEntry>> = {
  // ---------------------------------------------------------------------------
  // Operator configuration that still bypasses `.config.json`
  //
  // Policy and tunables an operator chooses. Each one is a setting a reader
  // cannot find by reading the config file, and each names the `.config.json`
  // key that will replace it. This is the group Issue #874 exists to drain, and
  // the only group whose count may not grow.
  // ---------------------------------------------------------------------------
  VIBE_AGENT_NICE: {
    role: "operator_config",
    note: "the nice level agent processes run at",
    configKey: "agent_nice",
  },
  VIBE_AGENT_PROVIDER: {
    role: "operator_config",
    note: "overrides the selected provider",
    configKey: "agent_provider",
  },
  VIBE_AGENT_PROVIDERS: {
    role: "operator_config",
    note: "overrides the enabled provider set",
    configKey: "agent_providers",
  },
  VIBE_BUMP_QUARANTINE_HOURS: {
    role: "operator_config",
    note: "how long a dependency bump is quarantined",
    configKey: "bump_quarantine_hours",
  },
  VIBE_BUILDER_FLOOR_PERCENT: {
    role: "operator_config",
    note: "the builder-prune disk floor",
    configKey: "builder_floor_percent",
  },
  VIBE_HOST_DISK_LOW_FLOOR_GB: {
    role: "operator_config",
    note: "the host disk claiming floor in GB",
    configKey: "host_disk_low_floor_gb",
  },
  VIBE_HOST_DISK_LOW_FLOOR_PERCENT: {
    role: "operator_config",
    note: "the host disk claiming floor as a percentage",
    configKey: "host_disk_low_floor_percent",
  },
  VIBE_HOST_DISK_HARD_FLOOR_GB: {
    role: "operator_config",
    note: "the host disk hard floor in GB",
    configKey: "host_disk_hard_floor_gb",
  },
  VIBE_CONTAINER_CPUS: {
    role: "operator_config",
    note: "CPU allocation for the run container",
    configKey: "container_cpus",
  },
  VIBE_CONTAINER_CPU_RESERVE: {
    role: "operator_config",
    note: "CPUs held back from the run container",
    configKey: "container_cpu_reserve",
  },
  VIBE_CONTAINER_MEMORY: {
    role: "operator_config",
    note: "memory allocation for the run container",
    configKey: "container_memory",
  },
  VIBE_CONTAINER_WATCHDOG_SECONDS: {
    role: "operator_config",
    note: "the container watchdog deadline",
    configKey: "container_watchdog_seconds",
  },
  VIBE_CONTAINER_REAP_GRACE_SECONDS: {
    role: "operator_config",
    note: "grace before a watchdog kill escalates",
    configKey: "container_reap_grace_seconds",
  },
  VIBE_DAILY_SPEND_CEILING_USD: {
    role: "operator_config",
    note: "the daily spend ceiling",
    configKey: "daily_spend_ceiling_usd",
  },
  VIBE_QUOTA_PAUSE_SLEEP_SECONDS: {
    role: "operator_config",
    note: "how long a quota pause sleeps",
    configKey: "quota_pause_sleep_seconds",
  },
  VIBE_CREDIT_LOG_DIR: {
    role: "operator_config",
    note: "where spend records are written",
    configKey: "credit_log_dir",
  },
  VIBE_LOGS_DIR: {
    role: "operator_config",
    note: "the log directory (Issues #872, #873)",
    configKey: "log_dir",
  },
  VIBE_SCREENSHOT_DIR: {
    role: "operator_config",
    note: "where screenshots are written",
    configKey: "screenshot_dir",
  },
  VIBE_BROWSER_PROFILE_DIR: {
    role: "operator_config",
    note: "the browser profile directory for screenshots",
    configKey: "browser_profile_dir",
  },
  VIBE_IMGBB_API_KEY: {
    role: "operator_config",
    note: "the imgbb upload key gating screenshot evidence",
    configKey: "imgbb_api_key",
  },
  VIBE_OPERATOR: {
    role: "operator_config",
    note: "the operator name recorded in the audit chain",
    configKey: "operator",
  },

  // ---------------------------------------------------------------------------
  // Setup-time seeds, which populate `.config.json` rather than bypassing it
  //
  // Read by `setup/` and written straight into `.config.json`. #874's problem
  // statement counted these as a parallel surface; they are the opposite — the
  // config file is still the single runtime source of truth, and these are one
  // way of filling it in. They stay, and each names the key it writes.
  // ---------------------------------------------------------------------------
  VIBE_CLAUDE_TIMEOUT: {
    role: "setup_input",
    note: "seeds claude_timeout",
    configKey: "claude_timeout",
  },
  VIBE_CLAUDE_KILL_AFTER: {
    role: "setup_input",
    note: "seeds claude_kill_after",
    configKey: "claude_kill_after",
  },
  VIBE_PLANNING_TIMEOUT: {
    role: "setup_input",
    note: "seeds planning_timeout",
    configKey: "planning_timeout",
  },
  VIBE_PLANNING_KILL_AFTER: {
    role: "setup_input",
    note: "seeds planning_kill_after",
    configKey: "planning_kill_after",
  },
  VIBE_REFINEMENT_TIMEOUT: {
    role: "setup_input",
    note: "seeds refinement_timeout",
    configKey: "refinement_timeout",
  },
  VIBE_REFINEMENT_KILL_AFTER: {
    role: "setup_input",
    note: "seeds refinement_kill_after",
    configKey: "refinement_kill_after",
  },
  VIBE_SUMMARISE_TIMEOUT: {
    role: "setup_input",
    note: "seeds summarise_timeout",
    configKey: "summarise_timeout",
  },
  VIBE_SUMMARISE_KILL_AFTER: {
    role: "setup_input",
    note: "seeds summarise_kill_after",
    configKey: "summarise_kill_after",
  },
  VIBE_CLARIFICATION_TIMEOUT: {
    role: "setup_input",
    note: "seeds clarification_timeout",
    configKey: "clarification_timeout",
  },
  VIBE_CLARIFICATION_KILL_AFTER: {
    role: "setup_input",
    note: "seeds clarification_kill_after",
    configKey: "clarification_kill_after",
  },
  VIBE_MAX_CLARIFICATION_ROUNDS: {
    role: "setup_input",
    note: "seeds max_clarification_rounds",
    configKey: "max_clarification_rounds",
  },
  VIBE_MAX_ISSUE_BODY_TOKENS: {
    role: "setup_input",
    note: "seeds max_issue_body_tokens",
    configKey: "max_issue_body_tokens",
  },
  VIBE_MAX_RATE_LIMIT_RETRIES: {
    role: "setup_input",
    note: "seeds max_rate_limit_retries",
    configKey: "max_rate_limit_retries",
  },
  VIBE_MAX_RATE_LIMIT_WAIT: {
    role: "setup_input",
    note: "seeds max_rate_limit_wait",
    configKey: "max_rate_limit_wait",
  },
  VIBE_RETRY_MAX_DELAY: {
    role: "setup_input",
    note: "seeds retry_max_delay",
    configKey: "retry_max_delay",
  },
  VIBE_SLEEP_INTERVAL: {
    role: "setup_input",
    note: "seeds sleep_interval",
    configKey: "sleep_interval",
  },
  VIBE_CREDIT_WAIT_INTERVAL: {
    role: "setup_input",
    note: "seeds credit_wait_interval",
    configKey: "credit_wait_interval",
  },
  VIBE_FEATURE_CHECK_TIMEOUT: {
    role: "setup_input",
    note: "seeds feature_check_timeout",
    configKey: "feature_check_timeout",
  },
  VIBE_REPOS: {
    role: "setup_input",
    note: "seeds the repos list",
    configKey: "repos",
  },
  VIBE_ADD_REPOS: {
    role: "setup_input",
    note: "appends to the repos list",
    configKey: "repos",
  },
  VIBE_ALLOWED_AUTHOR: {
    role: "setup_input",
    note: "seeds allowed_authors (singular spelling)",
    configKey: "allowed_authors",
  },
  VIBE_ALLOWED_AUTHORS: {
    role: "setup_input",
    note: "seeds allowed_authors",
    configKey: "allowed_authors",
  },
  VIBE_AUTHORIZED_COMMENTERS: {
    role: "setup_input",
    note: "seeds authorized_commenters",
    configKey: "authorized_commenters",
  },
  VIBE_INCLUDE_BOT_COMMENTERS: {
    role: "setup_input",
    note: "seeds the bot-commenter policy",
    configKey: "authorized_commenters",
  },
  VIBE_PR_REVIEWER: {
    role: "setup_input",
    note: "seeds pr_reviewers",
    configKey: "pr_reviewers",
  },
  VIBE_SERVICE_ACCOUNTS: {
    role: "setup_input",
    note: "seeds service_accounts",
    configKey: "service_accounts",
  },
  VIBE_GITHUB_APP_ID: {
    role: "setup_input",
    note: "seeds the GitHub App id",
    configKey: "github_app_id",
  },
  VIBE_GITHUB_APP_INSTALLATION_ID: {
    role: "setup_input",
    note: "seeds the GitHub App installation id",
    configKey: "github_app_installation_id",
  },
  VIBE_GITHUB_APP_PRIVATE_KEY_PATH: {
    role: "setup_input",
    note: "seeds the GitHub App private-key path",
    configKey: "github_app_private_key_path",
  },
  VIBE_UPDATE_GH_USER_STATUS: {
    role: "setup_input",
    note: "seeds update_gh_user_status",
    configKey: "update_gh_user_status",
  },

  // ---------------------------------------------------------------------------
  // Launcher-to-container plumbing, computed rather than chosen
  //
  // Decided at launch and handed to the guest. Nobody configures these: a run
  // id, the commit the image was built from, a disk MEASUREMENT. Moving them
  // into a config file would mean writing a file per run.
  // ---------------------------------------------------------------------------
  VIBE_BASE_DIR: {
    role: "launch_plumbing",
    note: "the checkout root the launcher hands the guest",
  },
  VIBE_BUILD_COMMIT: {
    role: "launch_plumbing",
    note: "the commit the image was built from",
  },
  VIBE_RUN_ID: {
    role: "launch_plumbing",
    note: "the launcher-generated run identifier",
  },
  VIBE_RUN_MODE: {
    role: "launch_plumbing",
    note: "host or container, decided by the launcher",
  },
  VIBE_RUN_MAX_SECONDS: {
    role: "launch_plumbing",
    note: "the resolved run cap, computed from config",
  },
  VIBE_RUN_STARTED_EPOCH: {
    role: "launch_plumbing",
    note: "the launch instant, a measurement",
  },
  VIBE_HOST_DISK_AVAIL_BYTES: {
    role: "launch_plumbing",
    note: "a disk MEASUREMENT handed to the guest, never a setting",
  },
  VIBE_HOST_DISK_TOTAL_BYTES: {
    role: "launch_plumbing",
    note: "a disk MEASUREMENT handed to the guest, never a setting",
  },
  VIBE_HOST_ID: {
    role: "launch_plumbing",
    note: "the host's identity, resolved once at launch",
  },
  VIBE_HOST_STORE_PATH: {
    role: "launch_plumbing",
    note: "the runtime's store path, discovered at launch",
  },
  VIBE_SCRATCH_DIR: {
    role: "launch_plumbing",
    note: "the per-run scratch directory the launcher creates",
  },
  VIBE_STATE_DIR: {
    role: "launch_plumbing",
    note: "the per-host state directory the launcher creates",
  },
  VIBE_LAUNCH_PHASE_FILE: {
    role: "launch_plumbing",
    note: "where the launcher records the phase it reached",
  },
  VIBE_IMAGE_AGENT_PROVIDERS: {
    role: "launch_plumbing",
    note: "the provider set the IMAGE was built with, stamped by the build",
  },
  VIBE_CONTAINER_TOOLS: {
    role: "launch_plumbing",
    note: "the build argument selecting extra tools (Issue #71)",
  },
  VIBE_UPDATE_MODE: {
    role: "launch_plumbing",
    note:
      "exported from the loaded config by load_config, not read back as config",
  },
  VIBE_FALLBACK_PATHS: {
    role: "launch_plumbing",
    note: "PATH fallbacks the launcher computed for the guest",
  },
  VIBE_AGENT_TRANSCRIPT: {
    role: "launch_plumbing",
    note: "the transcript path handed to the agent process",
  },
  VIBE_SIDE_REPO_CLONE_ARGS: {
    role: "launch_plumbing",
    note: "clone arguments the launcher resolved for side repositories",
  },
  VIBE_CODER_BASELINE_QUALITY_CACHE: {
    role: "launch_plumbing",
    note: "a cache path handed to the child gate run",
  },
  VIBE_CODER_DEFAULT_BRANCH_CACHE_PATH: {
    role: "launch_plumbing",
    note: "a cache path handed to the child",
  },
  VIBE_CREDENTIAL_DIR: {
    role: "launch_plumbing",
    note: "the mounted credential directory, decided by the launcher",
  },
  VIBE_MCP_CONFIG_DIR: {
    role: "launch_plumbing",
    note: "the MCP configuration directory the launcher stages",
  },

  // ---------------------------------------------------------------------------
  // Test, debug and setup switches, deliberately environment
  //
  // Escape hatches and setup-time inputs, including credentials that must never
  // be written to a file the repository can hold. `WORKAROUND_ENV_VARS` in
  // `first_run_verification.ts` already refuses a host carrying several of them.
  // ---------------------------------------------------------------------------
  VIBE_AUDIT_DISABLED: {
    role: "switch",
    note: "disables the audit hook; tests only",
  },
  VIBE_ALLOW_UNGUARDED_AGENT_GH: {
    role: "switch",
    note: "bypasses the gh guard shim; tests only",
  },
  VIBE_ALLOW_MISSING_PRECOMMIT_HOOK: {
    role: "switch",
    note: "bypasses the pre-commit hook requirement in setup",
  },
  VIBE_SKIP_PREREQ_CHECK: {
    role: "switch",
    note:
      "skips the prerequisite probe (CI only); refused by first-run verification",
  },
  VIBE_SKIP_AUTH_CHECK: {
    role: "switch",
    note:
      "skips the credential probe (CI only); refused by first-run verification",
  },
  VIBE_SKIP_CHECKOUT_UPDATE: {
    role: "switch",
    note: "leaves the checkout untouched; refused by first-run verification",
  },
  VIBE_SKIP_LAUNCHCTL: {
    role: "switch",
    note: "skips launchctl registration during setup",
  },
  VIBE_SKIP_SCHTASKS: {
    role: "switch",
    note: "skips Scheduled Tasks registration during setup",
  },
  VIBE_SKIP_SCREENSHOT_INSTALL: {
    role: "switch",
    note: "skips the screenshot toolchain install during setup",
  },
  VIBE_NO_AUTO_INSTALL: {
    role: "switch",
    note: "suppresses the prerequisite auto-install offer",
  },
  VIBE_PREFLIGHT_NO_CACHE: {
    role: "switch",
    note: "forces a cold credential preflight",
  },
  VIBE_SETUP_LAUNCHAGENT: {
    role: "switch",
    note: "opts setup into installing the LaunchAgent",
  },
  VIBE_SETUP_SCREENSHOT_SUPPORT: {
    role: "switch",
    note: "opts setup into screenshot support",
  },
  VIBE_TASK_USER: {
    role: "switch",
    note: "the Windows Scheduled Task user, a setup-time input",
  },
  VIBE_TASK_XML_PATH: {
    role: "switch",
    note: "where setup writes the Scheduled Task XML",
  },
  VIBE_LAUNCHAGENT_DIR: {
    role: "switch",
    note: "where setup writes the LaunchAgent plist",
  },
  VIBE_LAUNCHAGENT_FALLBACK_PATHS: {
    role: "switch",
    note: "PATH fallbacks baked into the LaunchAgent",
  },
  VIBE_LAUNCHAGENT_GH_TOKEN: {
    role: "switch",
    note: "a CREDENTIAL provisioned to setup; must never reach .config.json",
  },
  VIBE_LAUNCHAGENT_ANTHROPIC_API_KEY: {
    role: "switch",
    note: "a CREDENTIAL provisioned to setup; must never reach .config.json",
  },
  VIBE_LAUNCHAGENT_OPENAI_API_KEY: {
    role: "switch",
    note: "a CREDENTIAL provisioned to setup; must never reach .config.json",
  },
  VIBE_LAUNCHAGENT_GEMINI_API_KEY: {
    role: "switch",
    note: "a CREDENTIAL provisioned to setup; must never reach .config.json",
  },
  VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY: {
    role: "switch",
    note: "a CREDENTIAL provisioned to setup; must never reach .config.json",
  },
  VIBE_TABLETOP_CANARY: {
    role: "switch",
    note: "tabletop security exercise fixture",
  },
  VIBE_TABLETOP_EGRESS_URL: {
    role: "switch",
    note: "tabletop security exercise fixture",
  },
  VIBE_TABLETOP_HOST_PROBE: {
    role: "switch",
    note: "tabletop security exercise fixture",
  },
  VIBE_TABLETOP_HOSTILE_CLONE: {
    role: "switch",
    note: "tabletop security exercise fixture",
  },
  VIBE_TABLETOP_LOG_FILE: {
    role: "switch",
    note: "tabletop security exercise fixture",
  },
  VIBE_TABLETOP_OUTBOX: {
    role: "switch",
    note: "tabletop security exercise fixture",
  },
  VIBE_TABLETOP_SYMLINK: {
    role: "switch",
    note: "tabletop security exercise fixture",
  },
  VIBE_TABLETOP_WORKSPACE: {
    role: "switch",
    note: "tabletop security exercise fixture",
  },

  // ---------------------------------------------------------------------------
  // Not environment variables at all
  //
  // Comment markers, managed-block delimiters, a ruleset name and one regex
  // prefix. They match the `VIBE_*` shape and nothing more. Naming them here is
  // what lets the totality test scan for the shape rather than curate
  // exceptions — every match is accounted for, one way or the other.
  // ---------------------------------------------------------------------------
  VIBE_BUMP_SCRIPT_FAILURE: {
    role: "marker",
    note:
      "HTML-comment marker prefix in a bump-failure issue body (lib/bump_script_failure_streak.ts)",
  },
  VIBE_CODER_BLOCK_MARKER: {
    role: "marker",
    note:
      "managed-block delimiter written into .gitignore (lib/gitignore_enforcer.ts)",
  },
  VIBE_CODER_BLOCK_END_MARKER: {
    role: "marker",
    note: "the closing half of the .gitignore managed block",
  },
  VIBE_CODER_GITATTRIBUTES_BLOCK_MARKER: {
    role: "marker",
    note: "managed-block delimiter written into .gitattributes",
  },
  VIBE_CODER_GITATTRIBUTES_BLOCK_END_MARKER: {
    role: "marker",
    note: "the closing half of the .gitattributes managed block",
  },
  VIBE_CODER_HEARTBEAT: {
    role: "marker",
    note: "claim-heartbeat comment marker on an issue (lib/claim_issue.ts)",
  },
  VIBE_CONTAINER_ESCALATION: {
    role: "marker",
    note: "escalation-comment marker prefix (lib/container_restart_backoff.ts)",
  },
  VIBE_GH_GUARD_ALLOW: {
    role: "marker",
    note: "audit-line marker written by the gh guard shim",
  },
  VIBE_GH_GUARD_REFUSE: {
    role: "marker",
    note: "audit-line marker written by the gh guard shim",
  },
  VIBE_HOOK_MARKER: {
    role: "marker",
    note:
      "comment line identifying the managed pre-commit hook (setup/config_writer.ts)",
  },
  VIBE_IDLE_INVERSION: {
    role: "marker",
    note: "idle-inversion escalation comment marker prefix",
  },
  VIBE_PR_BRANCH_UPDATE_FAILURE: {
    role: "marker",
    note: "branch-update failure-streak marker prefix",
  },
  VIBE_RULESET_NAME: {
    role: "marker",
    note: "the GitHub ruleset's display name, not a variable",
  },
  VIBE_RUN_FAILURE: {
    role: "marker",
    note: "run-failure issue body marker prefix",
  },
  VIBE_RUN_FAILURE_FOLLOWUP: {
    role: "marker",
    note: "run-failure follow-up comment marker prefix",
  },
  VIBE_SELF_SCHEDULED: {
    role: "marker",
    note: "self-schedule announcement marker prefix",
  },
  VIBE_LAUNCHAGENT_: {
    role: "marker",
    note:
      "a regex prefix matching the provider provisioning variables (lib/setup_contract.ts), not a name",
  },
  VIBE_FLEET_METRICS_DIR: {
    role: "marker",
    note:
      "named only in a doc comment in lib/export_redact.ts; no code reads it",
  },
  VIBE_ISSUE_LABELS: {
    role: "marker",
    note:
      "retired by Issue #1834; survives only in the comment recording its removal",
  },
  VIBE_WORK_ON_LABEL: {
    role: "marker",
    note:
      "retired by Issue #1834; survives only in the comment recording its removal",
  },
};

/** Names in one role, sorted — the shape the cap test and the docs both want. */
export function vibeEnvNamesByRole(role: VibeEnvRole): string[] {
  return Object.entries(VIBE_ENV_REGISTRY)
    .filter(([, entry]) => entry.role === role)
    .map(([name]) => name)
    .sort();
}

/**
 * How many operator settings still bypass `.config.json`.
 *
 * The number Issue #874 is measured by. It may shrink, never grow: each
 * migration to a config key takes one off this count, and a new
 * `operator_config` entry fails {@link ./../tests/vibe_env_registry_test.ts}.
 */
export const OPERATOR_CONFIG_BYPASS_CAP = 21;
