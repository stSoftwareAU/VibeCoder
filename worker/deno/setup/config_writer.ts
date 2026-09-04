/**
 * Configuration file generation for VibeCoder setup.
 *
 * Delegates the core "overrides only" logic to the config_setup module.
 * This module adds:
 *   - Pre-commit hook installation
 *   - Git info/exclude pattern management
 *   - Retired hook cleanup
 *   - The update-mode fields a frozen host pins (Issue #626)
 *
 * Issue #923: Migrate setup scripts to Deno TypeScript.
 */

import {
  applyServiceAccountDefault,
  loadExistingConfig,
  mergeNonInteractive,
  pruneOrphanRepoConfig,
  stripRemovedConfigKeys,
  writeConfigFile,
} from "./config_setup.ts";
import { UPDATE_MODES } from "../lib/config_defaults.ts";
import { atomicWrite } from "../lib/file_utils.ts";
import type { PinnedToolVersions, Result, UpdateMode } from "../types.ts";

export {
  applyServiceAccountDefault,
  buildOverridesOnly,
  loadExistingConfig,
  mergeNonInteractive,
  parseCsv,
  pruneOrphanRepoConfig,
  runNonInteractive,
  stripRemovedConfigKeys,
  writeConfigFile,
} from "./config_setup.ts";

export type {
  RepoConfigPruneResult,
  ServiceAccountDefaultResult,
  SetupConfig,
} from "./config_setup.ts";

const VIBE_HOOK_MARKER = "# VibeCoder config file protection";

/** Env var an operator sets deliberately to bypass a missing tracked hook. */
const HOOK_BYPASS_ENV = "VIBE_ALLOW_MISSING_PRECOMMIT_HOOK";

/**
 * Shell body of the installed shim: invoke the tracked hook, and fail closed
 * when it is absent (Issue #3956). A missing hook must reject the commit — the
 * shim is the final safety net against `git add -f` of a config file, so
 * skipping it silently would let secrets through. The bypass env var is the
 * documented, explicit escape hatch.
 */
function buildShimBody(scriptDir: string): string {
  const hook = `${scriptDir}/hooks/pre-commit`;
  return `if [[ -f "${hook}" ]]; then
    "${hook}" || exit $?
elif [[ -n "\${${HOOK_BYPASS_ENV}:-}" ]]; then
    echo "WARNING: VibeCoder pre-commit hook missing at ${hook} — bypass allowed by ${HOOK_BYPASS_ENV}." >&2
else
    echo "ERROR: VibeCoder pre-commit hook missing at ${hook}." >&2
    echo "Commit rejected: config file protection cannot run (see SECURITY.md)." >&2
    echo "Restore the hook and re-run ./setup.sh, or set ${HOOK_BYPASS_ENV}=1 to bypass deliberately." >&2
    exit 1
fi`;
}

/** Result type for config writer operations. */
export interface ConfigWriterResult {
  ok: boolean;
  message: string;
  /** Non-blocking notices the caller must surface (Issue #4033). */
  warnings?: string[];
}

/** Injectable side effects for {@link runConfigSetup} (Issue #4030). */
export interface ConfigSetupDeps {
  /** Resolve the login `gh` is authenticated as; tests inject a fixed value. */
  resolveWorkerLogin?: (ghConfigDir?: string) => Promise<string | undefined>;
}

/** Expand a leading `~` to $HOME so `gh` reads the right config dir. */
function expandHome(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.replace(/^~/, Deno.env.get("HOME") ?? "~");
}

/**
 * Resolve the authenticated worker login via `gh api user` (Issue #4030).
 *
 * Mirrors the lookup the collaborator precheck does. Returns undefined on any
 * failure — the caller must warn loudly, because an unresolved login leaves
 * the identity guard inactive.
 */
async function resolveWorkerLoginViaGh(
  ghConfigDir?: string,
): Promise<string | undefined> {
  try {
    const env = ghConfigDir
      ? { ...Deno.env.toObject(), GH_CONFIG_DIR: ghConfigDir }
      : undefined;
    const output = await new Deno.Command("gh", {
      args: ["api", "user", "--jq", ".login"],
      stdout: "piped",
      stderr: "piped",
      env,
    }).output();
    if (!output.success) return undefined;
    const login = new TextDecoder().decode(output.stdout).trim();
    return login.length > 0 ? login : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run non-interactive config setup from environment variables.
 *
 * Reads VIBE_* env vars, merges with existing config, and writes
 * only overridden values to .config.json.
 */
export async function runConfigSetup(
  configPath: string,
  env?: (name: string) => string | undefined,
  deps: ConfigSetupDeps = {},
): Promise<ConfigWriterResult> {
  try {
    const existing = await loadExistingConfig(configPath);
    const merged = mergeNonInteractive(existing, env);
    // Issue #4033: drop dead per-repo config, reporting every removal.
    const { config: pruned, removed } = pruneOrphanRepoConfig(merged);
    const warnings = removed.map((repo) =>
      `Removed repo_config entry for '${repo}' — not in repos`
    );

    // Issue #4030: never leave the #3528 identity guard inactive. Resolve the
    // worker login only when the allowlist is empty — one `gh` call at most.
    const configured = (pruned.service_accounts ?? [])
      .filter((account) => account.trim().length > 0);
    const login = configured.length > 0 ? undefined : await (
      deps.resolveWorkerLogin ?? resolveWorkerLoginViaGh
    )(expandHome(pruned.gh_config_dir));
    const { config: final, defaulted } = applyServiceAccountDefault(
      pruned,
      login,
    );
    if (defaulted) {
      warnings.push(
        `Set service_accounts to ['${
          final.service_accounts?.[0]
        }'] (the resolved worker login) — the identity guard now enforces on ` +
          `this host. Add every service account this fleet uses with ` +
          `VIBE_SERVICE_ACCOUNTS.`,
      );
    } else if (configured.length === 0) {
      warnings.push(
        `[SECURITY] Could not resolve the worker GitHub login, so ` +
          `'service_accounts' is still empty and the worker identity guard ` +
          `stays INACTIVE. Set VIBE_SERVICE_ACCOUNTS and re-run ./setup.sh.`,
      );
    }

    // Issue #805: a key the worker has removed must not survive the rewrite,
    // and must not disappear without a word either.
    const { config: migrated, warnings: removedKeyWarnings } =
      stripRemovedConfigKeys(final);
    warnings.push(...removedKeyWarnings);

    await writeConfigFile(configPath, migrated);
    return {
      ok: true,
      message: `Configuration written to: ${configPath}`,
      warnings,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Failed to write config: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Install the pre-commit hook to prevent accidental config file commits.
 *
 * @param scriptDir - Root directory of the VibeCoder project
 * @returns Result indicating success or skip reason
 */
export async function installPreCommitHook(
  scriptDir: string,
): Promise<ConfigWriterResult> {
  const gitDir = `${scriptDir}/.git`;
  try {
    const stat = await Deno.stat(gitDir);
    if (!stat.isDirectory) {
      return {
        ok: true,
        message:
          "Not in a git repository, skipping pre-commit hook installation",
      };
    }
  } catch {
    return {
      ok: true,
      message: "Not in a git repository, skipping pre-commit hook installation",
    };
  }

  const hookSource = `${scriptDir}/hooks/pre-commit`;
  try {
    await Deno.stat(hookSource);
  } catch {
    return {
      ok: true,
      message: `Pre-commit hook source not found at ${hookSource}`,
    };
  }

  const hookDir = `${gitDir}/hooks`;
  const hookDest = `${hookDir}/pre-commit`;

  // Ensure hooks directory exists
  try {
    await Deno.mkdir(hookDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  // Check if hook already exists
  try {
    const existing = await Deno.readTextFile(hookDest);

    if (existing.includes(VIBE_HOOK_MARKER)) {
      return { ok: true, message: "Pre-commit hook already installed" };
    }

    if (existing.includes("hooks/pre-commit")) {
      return {
        ok: true,
        message: "Existing hook already includes VibeCoder protection",
      };
    }

    // Append our hook invocation to the existing hook
    const addition = `
${VIBE_HOOK_MARKER}
# Added by VibeCoder setup - prevents accidental config file commits
${buildShimBody(scriptDir)}
`;
    await Deno.writeTextFile(hookDest, existing + addition);
    return {
      ok: true,
      message: "Integrated VibeCoder protection into existing pre-commit hook",
    };
  } catch {
    // No existing hook — create a new one
    const hookContent = `#!/bin/bash
${VIBE_HOOK_MARKER}
# This hook prevents accidental commits of sensitive configuration files.
# See SECURITY.md for more information.

# Call the VibeCoder pre-commit hook
${buildShimBody(scriptDir)}

exit 0
`;
    await Deno.writeTextFile(hookDest, hookContent);
    // Make executable
    if (Deno.build.os !== "windows") {
      await new Deno.Command("chmod", { args: ["+x", hookDest] }).output();
    }
    return {
      ok: true,
      message: "Installed pre-commit hook for config file protection",
    };
  }
}

/**
 * Remove the retired pre-push hook if it was installed by VibeCoder.
 */
export async function removePrePushHook(
  scriptDir: string,
): Promise<ConfigWriterResult> {
  const hookDest = `${scriptDir}/.git/hooks/pre-push`;

  try {
    const content = await Deno.readTextFile(hookDest);
    if (content.includes("# VibeCoder pre-push quality gate")) {
      await Deno.remove(hookDest);
      return {
        ok: true,
        message: "Removed retired pre-push quality gate hook",
      };
    }
  } catch {
    // File doesn't exist — nothing to do
  }

  return { ok: true, message: "No retired pre-push hook to remove" };
}

/**
 * Update .git/info/exclude with config file patterns.
 */
export async function updateGitInfoExclude(
  scriptDir: string,
): Promise<ConfigWriterResult> {
  const gitDir = `${scriptDir}/.git`;
  try {
    const stat = await Deno.stat(gitDir);
    if (!stat.isDirectory) {
      return { ok: true, message: "Not in a git repository" };
    }
  } catch {
    return { ok: true, message: "Not in a git repository" };
  }

  const infoDir = `${gitDir}/info`;
  const excludeFile = `${infoDir}/exclude`;

  // Ensure info directory exists
  try {
    await Deno.mkdir(infoDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  // Check if patterns are already present
  try {
    const content = await Deno.readTextFile(excludeFile);
    if (content.includes(VIBE_HOOK_MARKER)) {
      return {
        ok: true,
        message: ".git/info/exclude already contains VibeCoder patterns",
      };
    }
    // Append patterns
    const addition = `
${VIBE_HOOK_MARKER}
# These patterns provide local protection that cannot be overridden
.config.json
.config*.json
*.secret.json
.secrets/
`;
    await Deno.writeTextFile(excludeFile, content + addition);
  } catch {
    // File doesn't exist — create it
    const content = `${VIBE_HOOK_MARKER}
# These patterns provide local protection that cannot be overridden
.config.json
.config*.json
*.secret.json
.secrets/
`;
    await Deno.writeTextFile(excludeFile, content);
  }

  return {
    ok: true,
    message: "Added config file patterns to .git/info/exclude",
  };
}

// ── Update-mode fields (Issue #626, part of #583) ───────────────────────

/**
 * The update-mode slice of `.config.json` (Issue #626).
 *
 * Every field is optional because a config written before Issue #622 carries
 * none of them: an absent `update_mode` reads as `dynamic`, which is what
 * every host did before the key existed.
 */
export interface UpdateModeSettings {
  /** `dynamic` (the default) or `frozen`. */
  update_mode?: UpdateMode;
  /** Commit SHA or tag a frozen host is held at. */
  pinned_ref?: string;
  /** Exact tool versions a frozen host installs. */
  pinned_tool_versions?: PinnedToolVersions;
}

/** The parsed config file plus the exact text it was parsed from. */
interface ConfigRecord {
  record: Record<string, unknown>;
  /** `null` when the file does not exist yet. */
  text: string | null;
}

/**
 * Read `.config.json` as a plain record, failing loud on anything that stops
 * the file meaning what it says.
 *
 * A missing file is not a failure — a first setup run has not written one yet.
 * Unreadable or malformed content is, because the alternative is overwriting
 * an operator's file on a guess.
 */
async function readConfigRecord(
  configPath: string,
): Promise<Result<ConfigRecord>> {
  let text: string;
  try {
    text = await Deno.readTextFile(configPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { ok: true, value: { record: {}, text: null } };
    }
    return {
      ok: false,
      error: new Error(
        `Cannot read ${configPath}: ` +
          (error instanceof Error ? error.message : String(error)),
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: new Error(
        `${configPath} contains invalid JSON — fix it by hand before ` +
          `setup can record the update mode.`,
      ),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: new Error(
        `${configPath} is not a JSON object — fix it by hand before setup ` +
          `can record the update mode.`,
      ),
    };
  }

  return {
    ok: true,
    value: { record: parsed as Record<string, unknown>, text },
  };
}

/** A trimmed non-empty string, or undefined for anything else. */
function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read the update-mode fields already in `.config.json` (Issue #626).
 *
 * These are what a re-run offers as its defaults, so pressing Enter through
 * every prompt is a no-op. An `update_mode` the worker does not recognise is a
 * fail-loud error rather than a silent reset to `dynamic`: a host that asked
 * to be pinned must never be un-pinned by a typo nobody saw.
 */
export async function readUpdateModeSettings(
  configPath: string,
): Promise<Result<UpdateModeSettings>> {
  const read = await readConfigRecord(configPath);
  if (!read.ok) return read;

  const record = read.value.record;
  const settings: UpdateModeSettings = {};

  const rawMode = record["update_mode"];
  if (rawMode !== undefined) {
    const mode = readString(rawMode);
    if (!mode || !(UPDATE_MODES as readonly string[]).includes(mode)) {
      return {
        ok: false,
        error: new Error(
          `Invalid update_mode ${JSON.stringify(rawMode)} in ${configPath}. ` +
            `Accepted values: ${UPDATE_MODES.join(", ")}.`,
        ),
      };
    }
    settings.update_mode = mode as UpdateMode;
  }

  const ref = readString(record["pinned_ref"]);
  if (ref) settings.pinned_ref = ref;

  const rawVersions = record["pinned_tool_versions"];
  if (
    typeof rawVersions === "object" && rawVersions !== null &&
    !Array.isArray(rawVersions)
  ) {
    const versions: PinnedToolVersions = {};
    const source = rawVersions as Record<string, unknown>;
    const claude = readString(source["claude"]);
    const gh = readString(source["gh"]);
    const deno = readString(source["deno"]);
    if (claude) versions.claude = claude;
    if (gh) versions.gh = gh;
    if (deno) versions.deno = deno;
    if (Object.keys(versions).length > 0) {
      settings.pinned_tool_versions = versions;
    }
  }

  return { ok: true, value: settings };
}

/** True when the two values serialise identically. */
function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Merge the update-mode fields into `.config.json`, leaving every other key
 * exactly as it was (Issue #626).
 *
 * A `dynamic` answer writes the mode alone: the pin fields are ignored in
 * dynamic mode, not rejected, so a host can flip back and forth without
 * retyping its pins (Issue #622). A `frozen` answer writes the ref and all
 * three tool versions alongside it, so one setup run leaves one coherent file.
 *
 * @returns True when the file was rewritten, false when it already said this
 */
export async function writeUpdateModeConfig(
  configPath: string,
  settings: UpdateModeSettings,
): Promise<Result<boolean>> {
  const read = await readConfigRecord(configPath);
  if (!read.ok) return read;

  const next: Record<string, unknown> = { ...read.value.record };
  let changed = false;

  if (settings.update_mode !== undefined) {
    if (!sameValue(next["update_mode"], settings.update_mode)) changed = true;
    next["update_mode"] = settings.update_mode;
  }

  if (settings.update_mode === "frozen") {
    if (settings.pinned_ref !== undefined) {
      if (!sameValue(next["pinned_ref"], settings.pinned_ref)) changed = true;
      next["pinned_ref"] = settings.pinned_ref;
    }
    if (settings.pinned_tool_versions !== undefined) {
      if (
        !sameValue(next["pinned_tool_versions"], settings.pinned_tool_versions)
      ) {
        changed = true;
      }
      next["pinned_tool_versions"] = settings.pinned_tool_versions;
    }
  }

  // Nothing to say that the file does not already say: leave it untouched so
  // a re-run that accepts every default cannot churn it.
  if (!changed && read.value.text !== null) return { ok: true, value: false };

  // One atomic write (Issue #691): every field lands together or none does,
  // so an interrupted upgrade can never leave a fresh pinned_ref beside stale
  // tool versions — the partial pin `pinned_tool_versions` exists to prevent.
  // A path with no directory component is written in the working directory.
  const target = configPath.includes("/") ? configPath : `./${configPath}`;
  const written = await atomicWrite({
    targetFile: target,
    content: JSON.stringify(next, null, 2) + "\n",
    mode: 0o600,
  });
  if (!written.ok) {
    return {
      ok: false,
      error: new Error(`Cannot write ${configPath}: ${written.error.message}`),
    };
  }

  return { ok: true, value: true };
}
