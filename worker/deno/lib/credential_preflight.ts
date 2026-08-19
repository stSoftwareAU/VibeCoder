/**
 * Non-interactive credential preflight (Issue #4064, parent #4060).
 *
 * Unattended operation is a hard requirement: no run may reach a GUI prompt,
 * a browser login, `gh auth login`, an interactive provider login, or a macOS
 * Keychain lookup. This module defines the single dedicated credential
 * directory the worker consumes — provisioned non-interactively by `setup.sh`
 * and mounted read-only into the container — and asserts, before any work
 * starts, that the material it holds is present and usable.
 *
 * Layout (owner-only, 0700 directories / 0600 files):
 *
 *   <credential dir>/            default ~/.vibe-coder/credentials
 *   ├── gh/hosts.yml             the worker's GH_CONFIG_DIR host material
 *   └── <provider>/<file>        one credential per enabled provider
 *
 * The provider sub-directories, their files and the environment variables that
 * can stand in for them all come from the provider seam (`agent_provider.ts`,
 * Issues #4067, #4108), so this module holds no provider specifics of its own
 * and a second provider needs no edit here. Every *enabled* provider is
 * checked and reported separately, so one vendor's missing credential names
 * that vendor rather than failing as an anonymous provider problem.
 *
 * Nothing else belongs in that directory: unrelated material is reported, so
 * the read-only mount stays limited to exactly what the worker needs.
 *
 * Fail-loud (Issue #3234): a missing, empty, unreadable, or over-permissioned
 * credential directory is a named failure with an actionable message suitable
 * for GitHub escalation — never a degraded run that dies on a mid-run auth
 * error. Failures are classified through the same predicates the runtime auth
 * surfaces use (the provider's own auth predicate and {@link isGhAuthError}),
 * so both surfaces agree on what an auth failure looks like.
 *
 * Australian English spelling throughout (behaviour, authorised, organisation).
 */

import {
  activeAgentProvider,
  type AgentProviderDescriptor,
  enabledAgentProviders,
  resolveAgentProvider,
} from "./agent_provider.ts";
import { isGhAuthError } from "./gh_auth.ts";

/** Environment variable that overrides the credential directory location. */
export const CREDENTIAL_DIR_ENV = "VIBE_CREDENTIAL_DIR";

/** Default credential directory, relative to the worker's home directory. */
export const DEFAULT_CREDENTIAL_DIR_SUFFIX = ".vibe-coder/credentials";

/** Sub-directory holding the worker's `gh` config (its `GH_CONFIG_DIR`). */
export const GH_CREDENTIAL_SUBDIR = "gh";

/**
 * Home-relative path of the WRITABLE runtime copy of the gh credential.
 *
 * The container entrypoint copies the read-only credential mount here on
 * every start: gh performs a config-migration write on first use, and each
 * run is a fresh VM, so `GH_CONFIG_DIR` must point at something writable.
 * Under `~/.config` because the runtime creates `~/.vibe-coder` root-owned
 * for the mount targets. The copy never leaves the VM.
 */
export const GH_RUNTIME_CONFIG_SUFFIX = ".config/gh-runtime";

/** File inside {@link GH_CREDENTIAL_SUBDIR} holding the host token. */
export const GH_HOSTS_FILE = "hosts.yml";

/**
 * The only entries permitted directly inside the credential directory.
 *
 * Each enabled provider's own sub-directory comes from its descriptor, so
 * enabling a second provider widens the permitted set without an edit here —
 * while anything outside it is still reported (Issue #4108).
 *
 * @param providers - The enabled provider descriptors.
 * @returns The permitted entry names.
 */
export function allowedCredentialEntries(
  providers: readonly AgentProviderDescriptor[],
): string[] {
  return [
    GH_CREDENTIAL_SUBDIR,
    ...providers.map((provider) => provider.credentials.subdir),
  ];
}

/** Filesystem metadata that is not credential material and is ignored. */
const IGNORED_ENTRIES: readonly string[] = [".DS_Store"];

/** Environment variables that carry a usable GitHub token. */
export const GITHUB_CREDENTIAL_ENV_VARS: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
];

/** Named reasons a credential preflight can fail. */
export type CredentialFailureCode =
  | "credential-dir-missing"
  | "credential-dir-not-a-directory"
  | "credential-dir-unreadable"
  | "credential-dir-empty"
  | "github-credentials-missing"
  | "provider-credentials-missing"
  | "credential-permissions-too-open"
  | "unexpected-credential-material";

/** Where usable credential material was found. */
export type CredentialSource = "directory" | "environment";

/** A single named preflight failure. */
export interface CredentialFailure {
  /** Stable, greppable reason code. */
  code: CredentialFailureCode;
  /** Actionable operator-facing message. */
  message: string;
  /** Path the failure refers to, when it is path-specific. */
  path?: string;
  /** Provider id the failure belongs to, when it is provider-specific. */
  provider?: string;
}

/** The credential status of one enabled provider (Issue #4108). */
export interface ProviderCredentialStatus {
  /** Provider id, as registered in the seam. */
  id: string;
  /** Operator-facing provider name. */
  displayName: string;
  /** Where this provider's credential came from, or null when unusable. */
  source: CredentialSource | null;
}

/** Outcome of a credential preflight. */
export interface CredentialPreflightResult {
  /** True when no failure was recorded. */
  ok: boolean;
  /** The credential directory that was inspected. */
  dir: string;
  /** Where the GitHub credential came from, or null when unusable. */
  githubSource: CredentialSource | null;
  /**
   * Where the active provider's credential came from, or null when unusable.
   * Per-provider detail for every enabled provider is in {@link providers}.
   */
  providerSource: CredentialSource | null;
  /** One entry per enabled provider, in enabled order (Issue #4108). */
  providers: ProviderCredentialStatus[];
  /** Named failures, in detection order. */
  failures: CredentialFailure[];
}

/** Environment lookup seam (tests inject a fixed map). */
export type EnvLookup = (name: string) => string | undefined;

/**
 * Resolve the credential directory for this host.
 *
 * `VIBE_CREDENTIAL_DIR` wins so the container can point at its read-only
 * mount; otherwise the default sits under the worker's home directory.
 *
 * @param env - Environment lookup (defaults to the process environment).
 * @returns Absolute credential directory path.
 */
export function resolveCredentialDir(
  env: EnvLookup = (name) => Deno.env.get(name),
): string {
  const override = env(CREDENTIAL_DIR_ENV)?.trim();
  if (override) return override.replace(/\/+$/, "");
  const home = env("HOME") ?? env("USERPROFILE") ?? "";
  return `${home}/${DEFAULT_CREDENTIAL_DIR_SUFFIX}`;
}

/**
 * Extract the host token from `gh` `hosts.yml` content.
 *
 * @param yaml - Raw file content.
 * @returns The token, or null when absent, blank, or an empty quoted string.
 */
export function extractGhToken(yaml: string): string | null {
  if (!yaml) return null;
  const match = yaml.match(/^\s*(?:oauth_token|token):[ \t]*(.+)$/m);
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  const unquoted = raw.replace(/^["']|["']$/g, "").trim();
  return unquoted.length > 0 ? unquoted : null;
}

/**
 * Find a usable provider credential in an env-style credential file.
 *
 * @param content - Raw file content (`KEY=value` lines, `export` optional).
 * @param envVars - Credential variable names the provider recognises
 *   (defaults to the active provider's).
 * @returns The name of the recognised variable, or null when none is usable.
 */
export function parseProviderCredentials(
  content: string,
  envVars: readonly string[] = activeAgentProvider().credentials.envVars,
): string | null {
  return parseProviderCredentialEntries(content, envVars)[0]?.name ?? null;
}

/** One credential entry parsed from an env-style credential file. */
export interface ProviderCredentialEntry {
  name: string;
  value: string;
}

/**
 * Every usable credential entry in an env-style credential file, in order.
 *
 * @param content - Raw file content (`KEY=value` lines, `export` optional).
 * @param envVars - Credential variable names the provider recognises.
 * @returns Recognised entries with non-blank values.
 */
export function parseProviderCredentialEntries(
  content: string,
  envVars: readonly string[],
): ProviderCredentialEntry[] {
  if (!content) return [];
  const entries: ProviderCredentialEntry[] = [];
  for (const line of content.split("\n")) {
    const code = line.trim();
    if (!code || code.startsWith("#")) continue;
    const match = code.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    const name = match?.[1];
    if (!name || !envVars.includes(name)) continue;
    const value = (match?.[2] ?? "").trim().replace(/^["']|["']$/g, "").trim();
    if (value.length > 0) entries.push({ name, value });
  }
  return entries;
}

/**
 * Export each enabled provider's directory credential into the process
 * environment — the runtime half of Issue #4064.
 *
 * The preflight above proves the material exists; this makes it usable:
 * agent child environments are built FROM the parent env
 * (`buildChildEnv`, filtered per vendor so no provider sees another's
 * secret — Issue #4108), so the parent process must actually carry the
 * variables. Observed live without it: the contained worker's health check
 * failed "Not logged in · Please run /login" straight after a passing
 * preflight.
 *
 * A variable already present in the environment is never clobbered — an
 * operator override or env-provisioned credential wins.
 *
 * @param options - Directory, env lookup, setter and provider overrides
 *   (all injectable for tests).
 * @returns The variable names exported, for names-only logging.
 */
export async function applyProviderCredentialEnv(options: {
  dir?: string;
  env?: EnvLookup;
  setEnv?: (name: string, value: string) => void;
  providers?: readonly AgentProviderDescriptor[];
} = {}): Promise<string[]> {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const setEnv = options.setEnv ??
    ((name: string, value: string) => Deno.env.set(name, value));
  const dir = options.dir ?? resolveCredentialDir(env);
  const providers = options.providers ?? enabledAgentProviders();
  const exported: string[] = [];
  for (const provider of providers) {
    let content = "";
    try {
      content = await Deno.readTextFile(providerCredentialPath(dir, provider));
    } catch {
      continue; // Absent file: the preflight already reported it.
    }
    for (
      const entry of parseProviderCredentialEntries(
        content,
        provider.credentials.envVars,
      )
    ) {
      if (env(entry.name)) continue;
      setEnv(entry.name, entry.value);
      exported.push(entry.name);
    }
  }
  return exported;
}

/**
 * The provider credential file inside a credential directory.
 *
 * @param dir - The credential directory.
 * @param provider - The active provider descriptor.
 * @returns Absolute path to the provider's credential file.
 */
export function providerCredentialPath(
  dir: string,
  provider: AgentProviderDescriptor,
): string {
  return `${dir}/${provider.credentials.subdir}/${provider.credentials.file}`;
}

/** Report whether a stat mode grants any group or other permission. */
function isTooOpen(mode: number | null): boolean {
  if (mode === null) return false; // Windows — no POSIX mode to enforce.
  return (mode & 0o077) !== 0;
}

/** First environment variable in `names` with a non-blank value. */
function firstEnvValue(
  names: readonly string[],
  env: EnvLookup,
): string | null {
  for (const name of names) {
    const value = env(name)?.trim();
    if (value) return name;
  }
  return null;
}

/** Read a file, returning null when it is absent or unreadable. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** Options for {@link checkCredentialPreflight}. */
export interface CredentialPreflightOptions {
  /** Credential directory to inspect (defaults to {@link resolveCredentialDir}). */
  dir?: string;
  /** Environment lookup (defaults to the process environment). */
  env?: EnvLookup;
  /**
   * The coding-agent providers enabled for this run (Issue #4108). Defaults
   * to the configured enabled set, which is the active provider alone unless
   * a deployment enables more.
   */
  providers?: readonly AgentProviderDescriptor[];
}

/**
 * Assert the worker's credential material is present and usable.
 *
 * Checks, in order: the directory itself (present, a directory, readable,
 * non-empty and limited to the worker's own material), the GitHub token, the
 * provider credential, and owner-only permissions on every credential file.
 * Credentials supplied through the environment (the LaunchAgent path) count as
 * usable material, so a host that has not yet been migrated to the directory
 * still passes — but a host with neither fails loudly.
 *
 * @param options - Directory and environment seams.
 * @returns The named failures found, plus where each credential came from.
 */
export async function checkCredentialPreflight(
  options: CredentialPreflightOptions = {},
): Promise<CredentialPreflightResult> {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const dir = (options.dir ?? resolveCredentialDir(env)).replace(/\/+$/, "");
  const providers = options.providers ?? enabledAgentProviders({ env });
  const allowedEntries = allowedCredentialEntries(providers);
  const provisionEnvVars = providers.map((p) => p.credentials.provisionEnvVar)
    .join(" / ");
  const failures: CredentialFailure[] = [];

  let githubSource: CredentialSource | null = null;
  const providerSources = new Map<string, CredentialSource | null>(
    providers.map((provider) => [provider.id, null]),
  );

  // --- The directory itself -------------------------------------------------
  let dirState: "ok" | "missing" | "not-a-directory" | "unreadable" = "ok";
  let entries: Deno.DirEntry[] = [];
  try {
    const info = await Deno.stat(dir);
    if (!info.isDirectory) {
      dirState = "not-a-directory";
    } else {
      try {
        entries = await Array.fromAsync(Deno.readDir(dir));
      } catch {
        dirState = "unreadable";
      }
    }
  } catch (error) {
    dirState = error instanceof Deno.errors.NotFound ? "missing" : "unreadable";
  }

  if (dirState === "not-a-directory") {
    failures.push({
      code: "credential-dir-not-a-directory",
      path: dir,
      message:
        `Credential path ${dir} is not a directory — remove it and re-run ./setup.sh to provision the credential directory.`,
    });
  } else if (dirState === "unreadable") {
    failures.push({
      code: "credential-dir-unreadable",
      path: dir,
      message:
        `Credential directory ${dir} is not readable by the worker — fix its ownership and run: chmod 700 ${dir}`,
    });
  }

  if (dirState === "ok") {
    const meaningful = entries.filter((e) => !IGNORED_ENTRIES.includes(e.name));
    if (meaningful.length === 0) {
      failures.push({
        code: "credential-dir-empty",
        path: dir,
        message:
          `Credential directory ${dir} is empty — re-run ./setup.sh with VIBE_LAUNCHAGENT_GH_TOKEN and ${provisionEnvVars} set to provision it.`,
      });
    }
    for (const entry of meaningful) {
      if (allowedEntries.includes(entry.name)) continue;
      failures.push({
        code: "unexpected-credential-material",
        path: `${dir}/${entry.name}`,
        message:
          `Unexpected entry ${dir}/${entry.name} — the credential directory must hold only ${
            allowedEntries.join("/")
          }; move anything else out of it.`,
      });
    }

    // --- GitHub material ----------------------------------------------------
    const hostsPath = `${dir}/${GH_CREDENTIAL_SUBDIR}/${GH_HOSTS_FILE}`;
    const hosts = await readIfPresent(hostsPath);
    if (hosts !== null && extractGhToken(hosts)) {
      githubSource = "directory";
      failures.push(...(await permissionFailures(hostsPath)));
    }

    // --- Provider material, one enabled provider at a time -------------------
    for (const provider of providers) {
      const path = providerCredentialPath(dir, provider);
      const material = await readIfPresent(path);
      if (
        material !== null &&
        parseProviderCredentials(material, provider.credentials.envVars)
      ) {
        providerSources.set(provider.id, "directory");
        failures.push(...(await permissionFailures(path)));
      }
    }
  }

  // --- Environment fallbacks ------------------------------------------------
  if (githubSource === null && firstEnvValue(GITHUB_CREDENTIAL_ENV_VARS, env)) {
    githubSource = "environment";
  }
  for (const provider of providers) {
    if (
      providerSources.get(provider.id) === null &&
      firstEnvValue(provider.credentials.envVars, env)
    ) {
      providerSources.set(provider.id, "environment");
    }
  }

  if (githubSource === null) {
    failures.push({
      code: "github-credentials-missing",
      path: `${dir}/${GH_CREDENTIAL_SUBDIR}/${GH_HOSTS_FILE}`,
      message:
        `No usable GitHub credential: ${dir}/${GH_CREDENTIAL_SUBDIR}/${GH_HOSTS_FILE} holds no token and none of ${
          GITHUB_CREDENTIAL_ENV_VARS.join("/")
        } is set. Re-run ./setup.sh with VIBE_LAUNCHAGENT_GH_TOKEN set — the worker never performs an interactive login.`,
    });
  }
  // Each enabled provider reports its own missing credential, naming the
  // provider and the variable that provisions it (Issue #4108).
  for (const provider of providers) {
    if (providerSources.get(provider.id) !== null) continue;
    const path = providerCredentialPath(dir, provider);
    failures.push({
      code: "provider-credentials-missing",
      path,
      provider: provider.id,
      message:
        `Coding-agent provider authentication required for ${provider.displayName} (${provider.id}): ${path} holds no credential and none of ${
          provider.credentials.envVars.join("/")
        } is set. Re-run ./setup.sh with ${provider.credentials.provisionEnvVar} set — the worker never performs an interactive login.`,
    });
  }

  const everyProviderFromEnvironment = providers.every(
    (provider) => providerSources.get(provider.id) === "environment",
  );

  // The directory only matters when it was meant to supply what is missing.
  if (
    dirState === "missing" &&
    (githubSource !== "environment" || !everyProviderFromEnvironment)
  ) {
    failures.unshift({
      code: "credential-dir-missing",
      path: dir,
      message:
        `Credential directory ${dir} does not exist — run ./setup.sh with VIBE_LAUNCHAGENT_GH_TOKEN and ${provisionEnvVars} set to provision it non-interactively.`,
    });
  }

  return {
    ok: failures.length === 0,
    dir,
    githubSource,
    providerSource: providerSources.get(providers[0]?.id ?? "") ?? null,
    providers: providers.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      source: providerSources.get(provider.id) ?? null,
    })),
    failures,
  };
}

/** Owner-only permission check for one credential file. */
async function permissionFailures(path: string): Promise<CredentialFailure[]> {
  try {
    const info = await Deno.stat(path);
    if (!isTooOpen(info.mode ?? null)) return [];
    const mode = (info.mode ?? 0) & 0o777;
    return [{
      code: "credential-permissions-too-open",
      path,
      message: `Credential file ${path} is mode ${
        mode.toString(8).padStart(3, "0")
      } — it must be owner-only. Run: chmod 600 ${path}`,
    }];
  } catch {
    return [];
  }
}

/**
 * Classify a failure against the runtime auth predicates so the preflight and
 * the mid-run auth surfaces agree on what an auth failure is.
 *
 * @param failure - The failure to classify.
 * @param provider - The provider to classify against. Defaults to the one the
 *   failure names (Issue #4108), or the active provider when it names none.
 * @returns `provider-auth`, `github-auth`, or `credential-material`.
 */
export function classifyCredentialFailure(
  failure: CredentialFailure,
  provider: AgentProviderDescriptor = failure.provider
    ? resolveAgentProvider(failure.provider)
    : activeAgentProvider(),
): "provider-auth" | "github-auth" | "credential-material" {
  if (
    failure.code === "provider-credentials-missing" &&
    provider.isAuthError(failure.message)
  ) {
    return "provider-auth";
  }
  if (
    failure.code === "github-credentials-missing" &&
    isGhAuthError(failure.message)
  ) {
    return "github-auth";
  }
  return "credential-material";
}

/**
 * Render a single operator-facing message for a preflight result — the text
 * the worker logs and escalates to GitHub with.
 *
 * @param result - The preflight outcome.
 * @returns A one-or-more-line summary naming every failure.
 */
export function credentialPreflightMessage(
  result: CredentialPreflightResult,
): string {
  if (result.ok) {
    const perProvider = result.providers
      .map((provider) => `${provider.id}=${provider.source ?? "none"}`)
      .join(", ");
    return `Credential preflight passed for ${result.dir} (github=${
      result.githubSource ?? "none"
    }, provider=${result.providerSource ?? "none"}, ${perProvider})`;
  }
  const lines = result.failures.map((f) => `  - [${f.code}] ${f.message}`);
  return [
    `Credential preflight failed for ${result.dir} — ${result.failures.length} problem(s):`,
    ...lines,
  ].join("\n");
}
