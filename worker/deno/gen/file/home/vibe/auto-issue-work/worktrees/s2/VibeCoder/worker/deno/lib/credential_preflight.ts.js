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
 *   ├── <provider>/<file>        one credential per enabled provider
 *   └── <provider>/<extra file>  extra tokens, for a provider that takes a
 *                                pool of them (Issue #917, parent #902)
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
 */ import { activeAgentProvider, enabledAgentProviders, resolveAgentProvider } from "./agent_provider.ts";
import { isGhAuthError } from "./gh_auth.ts";
/** Environment variable that overrides the credential directory location. */ export const CREDENTIAL_DIR_ENV = "VIBE_CREDENTIAL_DIR";
/** Default credential directory, relative to the worker's home directory. */ export const DEFAULT_CREDENTIAL_DIR_SUFFIX = ".vibe-coder/credentials";
/** Sub-directory holding the worker's `gh` config (its `GH_CONFIG_DIR`). */ export const GH_CREDENTIAL_SUBDIR = "gh";
/**
 * Home-relative path of the WRITABLE runtime copy of the gh credential.
 *
 * The container entrypoint copies the read-only credential mount here on
 * every start: gh performs a config-migration write on first use, and each
 * run is a fresh VM, so `GH_CONFIG_DIR` must point at something writable.
 * Under `~/.config` because the runtime creates `~/.vibe-coder` root-owned
 * for the mount targets. The copy never leaves the VM.
 */ export const GH_RUNTIME_CONFIG_SUFFIX = ".config/gh-runtime";
/**
 * Environment variable naming the container's per-launch scratch root.
 *
 * Exported by `container/entrypoint.sh` (Issue #515). Since the checkout and
 * the container root filesystem became read-only (Issue #509) the entrypoint
 * stages the writable gh copy at `${VIBE_SCRATCH_DIR}/${GH_CREDENTIAL_SUBDIR}`
 * instead of {@link GH_RUNTIME_CONFIG_SUFFIX}, so any resolver looking for
 * that copy must look here first.
 */ export const SCRATCH_DIR_ENV = "VIBE_SCRATCH_DIR";
/** File inside {@link GH_CREDENTIAL_SUBDIR} holding the host token. */ export const GH_HOSTS_FILE = "hosts.yml";
/**
 * The only entries permitted directly inside the credential directory.
 *
 * Each enabled provider's own sub-directory comes from its descriptor, so
 * enabling a second provider widens the permitted set without an edit here —
 * while anything outside it is still reported (Issue #4108).
 *
 * @param providers - The enabled provider descriptors.
 * @returns The permitted entry names.
 */ export function allowedCredentialEntries(providers) {
  return [
    GH_CREDENTIAL_SUBDIR,
    ...providers.map((provider)=>provider.credentials.subdir)
  ];
}
/** Filesystem metadata that is not credential material and is ignored. */ const IGNORED_ENTRIES = [
  ".DS_Store"
];
/** Environment variables that carry a usable GitHub token. */ export const GITHUB_CREDENTIAL_ENV_VARS = [
  "GH_TOKEN",
  "GITHUB_TOKEN"
];
/**
 * Resolve the credential directory for this host.
 *
 * `VIBE_CREDENTIAL_DIR` wins so the container can point at its read-only
 * mount; otherwise the default sits under the worker's home directory.
 *
 * @param env - Environment lookup (defaults to the process environment).
 * @returns Absolute credential directory path.
 */ export function resolveCredentialDir(env = (name)=>Deno.env.get(name)) {
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
 */ export function extractGhToken(yaml) {
  if (!yaml) return null;
  const match = yaml.match(/^\s*(?:oauth_token|token):[ \t]*(.+)$/m);
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  const unquoted = raw.replace(/^["']|["']$/g, "").trim();
  return unquoted.length > 0 ? unquoted : null;
}
/** Credential material and persistent-state selectors accepted at runtime. */ function runtimeCredentialEnvVars(provider) {
  return [
    ...provider.credentials.envVars,
    ...provider.credentials.stateEnvVars ?? []
  ];
}
/**
 * Find a usable provider credential in an env-style credential file.
 *
 * @param content - Raw file content (`KEY=value` lines, `export` optional).
 * @param envVars - Credential variable names the provider recognises
 *   (defaults to the active provider's).
 * @returns The name of the recognised variable, or null when none is usable.
 */ export function parseProviderCredentials(content, envVars = runtimeCredentialEnvVars(activeAgentProvider())) {
  return parseProviderCredentialEntries(content, envVars)[0]?.name ?? null;
}
/**
 * Every usable credential entry in an env-style credential file, in order.
 *
 * @param content - Raw file content (`KEY=value` lines, `export` optional).
 * @param envVars - Credential variable names the provider recognises.
 * @returns Recognised entries with non-blank values.
 */ export function parseProviderCredentialEntries(content, envVars) {
  if (!content) return [];
  const entries = [];
  for (const line of content.split("\n")){
    const code = line.trim();
    if (!code || code.startsWith("#")) continue;
    const match = code.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    const name = match?.[1];
    if (!name || !envVars.includes(name)) continue;
    const value = (match?.[2] ?? "").trim().replace(/^["']|["']$/g, "").trim();
    if (value.length > 0) entries.push({
      name,
      value
    });
  }
  return entries;
}
/** Strip a credential file's extension to get its loggable label. */ function fileStem(name) {
  return name.replace(/\.[^.]+$/, "");
}
/** Build one token record from a file's raw content. */ function tokenFileRecord(path, fileName, content, provider, primary) {
  const entries = parseProviderCredentialEntries(content, runtimeCredentialEnvVars(provider));
  const first = entries[0] ?? null;
  const pool = provider.credentials.tokenPool;
  return {
    label: fileStem(fileName),
    path,
    name: first?.name ?? null,
    value: first?.value ?? null,
    primary,
    poolMember: first !== null && (pool?.envVars.includes(first.name) ?? false),
    entries
  };
}
/**
 * Every credential file in one provider's credential sub-directory, in a
 * deterministic order (Issue #917, parent #902).
 *
 * Order is the primary `provider.env` first, then the pool files in ascending
 * NUMERIC order of their ordinal — `provider-2`, `provider-10` — because a
 * directory listing's order is filesystem-dependent and a text sort puts
 * `provider-10.env` before `provider-2.env`. A stable order is what makes
 * "the first entry" a defensible default selection while #919 is outstanding.
 *
 * A provider with no {@link AgentProviderTokenPool} yields at most the one
 * record it has always had, so no other vendor gains a pool.
 *
 * Files that parse to no recognised variable are still returned, with a null
 * {@link ProviderTokenFile.name}: the preflight reports them by name rather
 * than skipping them silently (fail-loud, Issue #3234).
 *
 * @param dir - The credential directory.
 * @param provider - The provider whose sub-directory to list.
 * @returns The discovered token files, in selection order.
 */ export async function discoverProviderTokenFiles(dir, provider) {
  const tokens = [];
  const primaryPath = providerCredentialPath(dir, provider);
  const primary = await readIfPresent(primaryPath);
  if (primary !== null) {
    tokens.push(tokenFileRecord(primaryPath, provider.credentials.file, primary, provider, true));
  }
  const pool = provider.credentials.tokenPool;
  if (!pool) return tokens;
  const subdir = `${dir}/${provider.credentials.subdir}`;
  let entries = [];
  try {
    entries = await Array.fromAsync(Deno.readDir(subdir));
  } catch  {
    return tokens; // Absent or unreadable: already reported by the preflight.
  }
  const extras = [];
  for (const entry of entries){
    if (entry.isDirectory) continue;
    const ordinal = Number(entry.name.match(pool.fileMatch)?.[1]);
    if (!Number.isFinite(ordinal)) continue;
    extras.push({
      ordinal,
      name: entry.name
    });
  }
  extras.sort((a, b)=>a.ordinal - b.ordinal || a.name.localeCompare(b.name));
  for (const extra of extras){
    const path = `${subdir}/${extra.name}`;
    const content = await readIfPresent(path);
    if (content === null) continue;
    tokens.push(tokenFileRecord(path, extra.name, content, provider, false));
  }
  return tokens;
}
/**
 * The default selector: the first usable file in discovery order.
 *
 * Deterministic and, on a host with the single `provider.env` it has always
 * had, indistinguishable from the behaviour before Issue #917.
 *
 * @param tokens - The discovered files, in discovery order.
 * @returns The first file holding a recognised credential, or null.
 */ export const selectFirstProviderToken = (tokens)=>tokens.find((token)=>token.name !== null) ?? null;
/**
 * The discovered files that are budget-selection candidates.
 *
 * A subscription OAuth token with a value: a metered `ANTHROPIC_API_KEY` has
 * no per-token budget to weigh, and an empty file is a configuration fault
 * rather than a candidate. One spelling of the filter, shared by the budget
 * probe's three callers (Issue #1668) so they cannot drift apart on what
 * counts as a pool member.
 *
 * @param tokens - The discovered files, in discovery order.
 * @returns The pool candidates, in the same order.
 */ export function providerPoolCandidates(tokens) {
  return tokens.filter((token)=>token.poolMember && (token.value ?? "").trim().length > 0);
}
// ---------------------------------------------------------------------------
// Which credential the run environment holds
// ---------------------------------------------------------------------------
/**
 * Credential label (file stem — `provider`, `provider-2`) whose material each
 * provider's run environment currently carries (Issue #2002).
 *
 * Recorded when start-up exports a selected token file and again when the
 * credential pool switches the run to another one. It exists so a usage-limit
 * signal can name the subscription that ran out, and so a later reader can
 * tell "this subscription is spent" from "this provider is spent on this
 * host" — the difference between pausing a run that holds the spent token and
 * pausing a restart that deliberately picked a fresh one. Process-wide, like
 * the environment it describes. Never a secret value: labels are file stems.
 */ const heldProviderCredentials = new Map();
/** Record which credential file a provider's run environment now carries. */ export function recordHeldProviderCredential(providerId, label) {
  const key = providerId.trim();
  const value = label.trim();
  if (key.length === 0 || value.length === 0) return;
  heldProviderCredentials.set(key, value);
}
/**
 * The credential label a provider's run environment carries, or `undefined`
 * when this process never exported one (a single-credential host whose
 * variable was already in the environment, or a provider not enabled here).
 */ export function heldProviderCredentialLabel(providerId) {
  return heldProviderCredentials.get(providerId.trim());
}
/** Forget every held label. For tests, which share one module instance. */ export function resetHeldProviderCredentials() {
  heldProviderCredentials.clear();
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
 * Exactly ONE of a provider's token files is exported (Issue #917, parent
 * #902): a host may now hold several subscriptions with one vendor, and an
 * unselected one must never reach the coding agent's environment. Which one
 * is exported is the {@link ProviderTokenSelector}'s decision; until #919
 * lands it is the first in discovery order, so a single-token host exports
 * exactly what it did before.
 *
 * @param options - Directory, env lookup, setter, provider and selector
 *   overrides (all injectable for tests).
 * @returns The variable names exported, for names-only logging.
 */ export async function applyProviderCredentialEnv(options = {}) {
  const env = options.env ?? ((name)=>Deno.env.get(name));
  const setEnv = options.setEnv ?? ((name, value)=>Deno.env.set(name, value));
  const dir = options.dir ?? resolveCredentialDir(env);
  const providers = options.providers ?? enabledAgentProviders();
  const selectToken = options.selectToken ?? selectFirstProviderToken;
  const exported = [];
  for (const provider of providers){
    const tokens = await discoverProviderTokenFiles(dir, provider);
    // Absent files are the preflight's business, not this function's.
    const selected = await selectToken(tokens, provider);
    if (!selected) continue;
    let exportedFromSelected = false;
    for (const entry of selected.entries){
      if (env(entry.name)) continue;
      setEnv(entry.name, entry.value);
      exported.push(entry.name);
      exportedFromSelected = true;
    }
    // Issue #2002: the run environment now carries this file's credential.
    // A variable that was already in the environment came from elsewhere, so
    // its label is unknown and nothing is recorded for it.
    if (exportedFromSelected) {
      recordHeldProviderCredential(provider.id, selected.label);
    }
  }
  for (const provider of providers){
    await provider.credentials.initialiseState?.(`${dir}/${provider.credentials.subdir}`, env);
  }
  return exported;
}
/**
 * The provider credential file inside a credential directory.
 *
 * @param dir - The credential directory.
 * @param provider - The active provider descriptor.
 * @returns Absolute path to the provider's credential file.
 */ export function providerCredentialPath(dir, provider) {
  return `${dir}/${provider.credentials.subdir}/${provider.credentials.file}`;
}
/** Report whether a stat mode grants any group or other permission. */ function isTooOpen(mode) {
  if (mode === null) return false; // Windows — no POSIX mode to enforce.
  return (mode & 0o077) !== 0;
}
/** First environment variable in `names` with a non-blank value. */ function firstEnvValue(names, env) {
  for (const name of names){
    const value = env(name)?.trim();
    if (value) return name;
  }
  return null;
}
/** Read a file, returning null when it is absent or unreadable. */ async function readIfPresent(path) {
  try {
    return await Deno.readTextFile(path);
  } catch  {
    return null;
  }
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
 */ export async function checkCredentialPreflight(options = {}) {
  const env = options.env ?? ((name)=>Deno.env.get(name));
  const dir = (options.dir ?? resolveCredentialDir(env)).replace(/\/+$/, "");
  const providers = options.providers ?? enabledAgentProviders({
    env
  });
  const allowedEntries = allowedCredentialEntries(providers);
  const provisionEnvVars = providers.map((p)=>p.credentials.provisionEnvVar).join(" / ");
  const failures = [];
  let githubSource = null;
  const providerSources = new Map(providers.map((provider)=>[
      provider.id,
      null
    ]));
  // --- The directory itself -------------------------------------------------
  let dirState = "ok";
  let entries = [];
  try {
    const info = await Deno.stat(dir);
    if (!info.isDirectory) {
      dirState = "not-a-directory";
    } else {
      try {
        entries = await Array.fromAsync(Deno.readDir(dir));
      } catch  {
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
      message: `Credential path ${dir} is not a directory — remove it and re-run ./setup.sh to provision the credential directory.`
    });
  } else if (dirState === "unreadable") {
    failures.push({
      code: "credential-dir-unreadable",
      path: dir,
      message: `Credential directory ${dir} is not readable by the worker — fix its ownership and run: chmod 700 ${dir}`
    });
  }
  if (dirState === "ok") {
    const meaningful = entries.filter((e)=>!IGNORED_ENTRIES.includes(e.name));
    if (meaningful.length === 0) {
      failures.push({
        code: "credential-dir-empty",
        path: dir,
        message: `Credential directory ${dir} is empty — re-run ./setup.sh with VIBE_LAUNCHAGENT_GH_TOKEN and ${provisionEnvVars} set to provision it.`
      });
    }
    for (const entry of meaningful){
      if (allowedEntries.includes(entry.name)) continue;
      failures.push({
        code: "unexpected-credential-material",
        path: `${dir}/${entry.name}`,
        message: `Unexpected entry ${dir}/${entry.name} — the credential directory must hold only ${allowedEntries.join("/")}; move anything else out of it.`
      });
    }
    // --- GitHub material ----------------------------------------------------
    const hostsPath = `${dir}/${GH_CREDENTIAL_SUBDIR}/${GH_HOSTS_FILE}`;
    const hosts = await readIfPresent(hostsPath);
    if (hosts !== null && extractGhToken(hosts)) {
      githubSource = "directory";
      failures.push(...await permissionFailures(hostsPath));
    }
    // --- Provider material, one enabled provider at a time -------------------
    // Every discovered token file is permission-checked, not just the primary
    // one (Issue #917): the unexpected-material check above sees only the TOP
    // level of the credential directory, so an added provider-2.env inside a
    // provider's own sub-directory at mode 0644 would otherwise pass the
    // preflight entirely unexamined.
    for (const provider of providers){
      for (const token of (await discoverProviderTokenFiles(dir, provider))){
        if (token.name !== null) {
          providerSources.set(provider.id, "directory");
          failures.push(...await permissionFailures(token.path));
          continue;
        }
        // A pool file that parses to nothing is a typo an operator made by
        // hand and must hear about. The primary file keeps its long-standing
        // path: its emptiness is already reported as
        // provider-credentials-missing, so saying it twice would change what
        // a single-token host sees.
        if (token.primary) continue;
        failures.push(...await permissionFailures(token.path));
        failures.push({
          code: "provider-token-file-unrecognised",
          path: token.path,
          provider: provider.id,
          message: `Token file ${token.path} holds no credential ${provider.displayName} recognises — it must set one of ${runtimeCredentialEnvVars(provider).join("/")}. Fix the variable name or remove the file.`
        });
      }
    }
  }
  // --- Environment fallbacks ------------------------------------------------
  if (githubSource === null && firstEnvValue(GITHUB_CREDENTIAL_ENV_VARS, env)) {
    githubSource = "environment";
  }
  for (const provider of providers){
    if (providerSources.get(provider.id) === null && firstEnvValue(runtimeCredentialEnvVars(provider), env)) {
      providerSources.set(provider.id, "environment");
    }
  }
  if (githubSource === null) {
    failures.push({
      code: "github-credentials-missing",
      path: `${dir}/${GH_CREDENTIAL_SUBDIR}/${GH_HOSTS_FILE}`,
      message: `No usable GitHub credential: ${dir}/${GH_CREDENTIAL_SUBDIR}/${GH_HOSTS_FILE} holds no token and none of ${GITHUB_CREDENTIAL_ENV_VARS.join("/")} is set. Re-run ./setup.sh with VIBE_LAUNCHAGENT_GH_TOKEN set — the worker never performs an interactive login.`
    });
  }
  // Each enabled provider reports its own missing credential, naming the
  // provider and the variable that provisions it (Issue #4108).
  for (const provider of providers){
    if (providerSources.get(provider.id) !== null) continue;
    const path = providerCredentialPath(dir, provider);
    failures.push({
      code: "provider-credentials-missing",
      path,
      provider: provider.id,
      message: `Coding-agent provider authentication required for ${provider.displayName} (${provider.id}): ${path} holds no credential and none of ${runtimeCredentialEnvVars(provider).join("/")} is set. Re-run ./setup.sh with ${provider.credentials.provisionEnvVar} set — the worker never performs an interactive login.`
    });
  }
  const everyProviderFromEnvironment = providers.every((provider)=>providerSources.get(provider.id) === "environment");
  // The directory only matters when it was meant to supply what is missing.
  if (dirState === "missing" && (githubSource !== "environment" || !everyProviderFromEnvironment)) {
    failures.unshift({
      code: "credential-dir-missing",
      path: dir,
      message: `Credential directory ${dir} does not exist — run ./setup.sh with VIBE_LAUNCHAGENT_GH_TOKEN and ${provisionEnvVars} set to provision it non-interactively.`
    });
  }
  return {
    ok: failures.length === 0,
    dir,
    githubSource,
    providerSource: providerSources.get(providers[0]?.id ?? "") ?? null,
    providers: providers.map((provider)=>({
        id: provider.id,
        displayName: provider.displayName,
        source: providerSources.get(provider.id) ?? null
      })),
    failures
  };
}
/** Owner-only permission check for one credential file. */ async function permissionFailures(path) {
  try {
    const info = await Deno.stat(path);
    if (!isTooOpen(info.mode ?? null)) return [];
    const mode = (info.mode ?? 0) & 0o777;
    return [
      {
        code: "credential-permissions-too-open",
        path,
        message: `Credential file ${path} is mode ${mode.toString(8).padStart(3, "0")} — it must be owner-only. Run: chmod 600 ${path}`
      }
    ];
  } catch  {
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
 */ export function classifyCredentialFailure(failure, provider = failure.provider ? resolveAgentProvider(failure.provider) : activeAgentProvider()) {
  if (failure.code === "provider-credentials-missing" && provider.isAuthError(failure.message)) {
    return "provider-auth";
  }
  if (failure.code === "github-credentials-missing" && isGhAuthError(failure.message)) {
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
 */ export function credentialPreflightMessage(result) {
  if (result.ok) {
    const perProvider = result.providers.map((provider)=>`${provider.id}=${provider.source ?? "none"}`).join(", ");
    return `Credential preflight passed for ${result.dir} (github=${result.githubSource ?? "none"}, provider=${result.providerSource ?? "none"}, ${perProvider})`;
  }
  const lines = result.failures.map((f)=>`  - [${f.code}] ${f.message}`);
  return [
    `Credential preflight failed for ${result.dir} — ${result.failures.length} problem(s):`,
    ...lines
  ].join("\n");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jcmVkZW50aWFsX3ByZWZsaWdodC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIE5vbi1pbnRlcmFjdGl2ZSBjcmVkZW50aWFsIHByZWZsaWdodCAoSXNzdWUgIzQwNjQsIHBhcmVudCAjNDA2MCkuXG4gKlxuICogVW5hdHRlbmRlZCBvcGVyYXRpb24gaXMgYSBoYXJkIHJlcXVpcmVtZW50OiBubyBydW4gbWF5IHJlYWNoIGEgR1VJIHByb21wdCxcbiAqIGEgYnJvd3NlciBsb2dpbiwgYGdoIGF1dGggbG9naW5gLCBhbiBpbnRlcmFjdGl2ZSBwcm92aWRlciBsb2dpbiwgb3IgYSBtYWNPU1xuICogS2V5Y2hhaW4gbG9va3VwLiBUaGlzIG1vZHVsZSBkZWZpbmVzIHRoZSBzaW5nbGUgZGVkaWNhdGVkIGNyZWRlbnRpYWxcbiAqIGRpcmVjdG9yeSB0aGUgd29ya2VyIGNvbnN1bWVzIOKAlCBwcm92aXNpb25lZCBub24taW50ZXJhY3RpdmVseSBieSBgc2V0dXAuc2hgXG4gKiBhbmQgbW91bnRlZCByZWFkLW9ubHkgaW50byB0aGUgY29udGFpbmVyIOKAlCBhbmQgYXNzZXJ0cywgYmVmb3JlIGFueSB3b3JrXG4gKiBzdGFydHMsIHRoYXQgdGhlIG1hdGVyaWFsIGl0IGhvbGRzIGlzIHByZXNlbnQgYW5kIHVzYWJsZS5cbiAqXG4gKiBMYXlvdXQgKG93bmVyLW9ubHksIDA3MDAgZGlyZWN0b3JpZXMgLyAwNjAwIGZpbGVzKTpcbiAqXG4gKiAgIDxjcmVkZW50aWFsIGRpcj4vICAgICAgICAgICAgZGVmYXVsdCB+Ly52aWJlLWNvZGVyL2NyZWRlbnRpYWxzXG4gKiAgIOKUnOKUgOKUgCBnaC9ob3N0cy55bWwgICAgICAgICAgICAgdGhlIHdvcmtlcidzIEdIX0NPTkZJR19ESVIgaG9zdCBtYXRlcmlhbFxuICogICDilJzilIDilIAgPHByb3ZpZGVyPi88ZmlsZT4gICAgICAgIG9uZSBjcmVkZW50aWFsIHBlciBlbmFibGVkIHByb3ZpZGVyXG4gKiAgIOKUlOKUgOKUgCA8cHJvdmlkZXI+LzxleHRyYSBmaWxlPiAgZXh0cmEgdG9rZW5zLCBmb3IgYSBwcm92aWRlciB0aGF0IHRha2VzIGFcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwb29sIG9mIHRoZW0gKElzc3VlICM5MTcsIHBhcmVudCAjOTAyKVxuICpcbiAqIFRoZSBwcm92aWRlciBzdWItZGlyZWN0b3JpZXMsIHRoZWlyIGZpbGVzIGFuZCB0aGUgZW52aXJvbm1lbnQgdmFyaWFibGVzIHRoYXRcbiAqIGNhbiBzdGFuZCBpbiBmb3IgdGhlbSBhbGwgY29tZSBmcm9tIHRoZSBwcm92aWRlciBzZWFtIChgYWdlbnRfcHJvdmlkZXIudHNgLFxuICogSXNzdWVzICM0MDY3LCAjNDEwOCksIHNvIHRoaXMgbW9kdWxlIGhvbGRzIG5vIHByb3ZpZGVyIHNwZWNpZmljcyBvZiBpdHMgb3duXG4gKiBhbmQgYSBzZWNvbmQgcHJvdmlkZXIgbmVlZHMgbm8gZWRpdCBoZXJlLiBFdmVyeSAqZW5hYmxlZCogcHJvdmlkZXIgaXNcbiAqIGNoZWNrZWQgYW5kIHJlcG9ydGVkIHNlcGFyYXRlbHksIHNvIG9uZSB2ZW5kb3IncyBtaXNzaW5nIGNyZWRlbnRpYWwgbmFtZXNcbiAqIHRoYXQgdmVuZG9yIHJhdGhlciB0aGFuIGZhaWxpbmcgYXMgYW4gYW5vbnltb3VzIHByb3ZpZGVyIHByb2JsZW0uXG4gKlxuICogTm90aGluZyBlbHNlIGJlbG9uZ3MgaW4gdGhhdCBkaXJlY3Rvcnk6IHVucmVsYXRlZCBtYXRlcmlhbCBpcyByZXBvcnRlZCwgc29cbiAqIHRoZSByZWFkLW9ubHkgbW91bnQgc3RheXMgbGltaXRlZCB0byBleGFjdGx5IHdoYXQgdGhlIHdvcmtlciBuZWVkcy5cbiAqXG4gKiBGYWlsLWxvdWQgKElzc3VlICMzMjM0KTogYSBtaXNzaW5nLCBlbXB0eSwgdW5yZWFkYWJsZSwgb3Igb3Zlci1wZXJtaXNzaW9uZWRcbiAqIGNyZWRlbnRpYWwgZGlyZWN0b3J5IGlzIGEgbmFtZWQgZmFpbHVyZSB3aXRoIGFuIGFjdGlvbmFibGUgbWVzc2FnZSBzdWl0YWJsZVxuICogZm9yIEdpdEh1YiBlc2NhbGF0aW9uIOKAlCBuZXZlciBhIGRlZ3JhZGVkIHJ1biB0aGF0IGRpZXMgb24gYSBtaWQtcnVuIGF1dGhcbiAqIGVycm9yLiBGYWlsdXJlcyBhcmUgY2xhc3NpZmllZCB0aHJvdWdoIHRoZSBzYW1lIHByZWRpY2F0ZXMgdGhlIHJ1bnRpbWUgYXV0aFxuICogc3VyZmFjZXMgdXNlICh0aGUgcHJvdmlkZXIncyBvd24gYXV0aCBwcmVkaWNhdGUgYW5kIHtAbGluayBpc0doQXV0aEVycm9yfSksXG4gKiBzbyBib3RoIHN1cmZhY2VzIGFncmVlIG9uIHdoYXQgYW4gYXV0aCBmYWlsdXJlIGxvb2tzIGxpa2UuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgYXV0aG9yaXNlZCwgb3JnYW5pc2F0aW9uKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEVudkxvb2t1cCB9IGZyb20gXCIuL2Vudl9sb29rdXAudHNcIjtcbmltcG9ydCB7XG4gIGFjdGl2ZUFnZW50UHJvdmlkZXIsXG4gIHR5cGUgQWdlbnRQcm92aWRlckRlc2NyaXB0b3IsXG4gIGVuYWJsZWRBZ2VudFByb3ZpZGVycyxcbiAgcmVzb2x2ZUFnZW50UHJvdmlkZXIsXG59IGZyb20gXCIuL2FnZW50X3Byb3ZpZGVyLnRzXCI7XG5pbXBvcnQgeyBpc0doQXV0aEVycm9yIH0gZnJvbSBcIi4vZ2hfYXV0aC50c1wiO1xuXG4vKiogRW52aXJvbm1lbnQgdmFyaWFibGUgdGhhdCBvdmVycmlkZXMgdGhlIGNyZWRlbnRpYWwgZGlyZWN0b3J5IGxvY2F0aW9uLiAqL1xuZXhwb3J0IGNvbnN0IENSRURFTlRJQUxfRElSX0VOViA9IFwiVklCRV9DUkVERU5USUFMX0RJUlwiO1xuXG4vKiogRGVmYXVsdCBjcmVkZW50aWFsIGRpcmVjdG9yeSwgcmVsYXRpdmUgdG8gdGhlIHdvcmtlcidzIGhvbWUgZGlyZWN0b3J5LiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfQ1JFREVOVElBTF9ESVJfU1VGRklYID0gXCIudmliZS1jb2Rlci9jcmVkZW50aWFsc1wiO1xuXG4vKiogU3ViLWRpcmVjdG9yeSBob2xkaW5nIHRoZSB3b3JrZXIncyBgZ2hgIGNvbmZpZyAoaXRzIGBHSF9DT05GSUdfRElSYCkuICovXG5leHBvcnQgY29uc3QgR0hfQ1JFREVOVElBTF9TVUJESVIgPSBcImdoXCI7XG5cbi8qKlxuICogSG9tZS1yZWxhdGl2ZSBwYXRoIG9mIHRoZSBXUklUQUJMRSBydW50aW1lIGNvcHkgb2YgdGhlIGdoIGNyZWRlbnRpYWwuXG4gKlxuICogVGhlIGNvbnRhaW5lciBlbnRyeXBvaW50IGNvcGllcyB0aGUgcmVhZC1vbmx5IGNyZWRlbnRpYWwgbW91bnQgaGVyZSBvblxuICogZXZlcnkgc3RhcnQ6IGdoIHBlcmZvcm1zIGEgY29uZmlnLW1pZ3JhdGlvbiB3cml0ZSBvbiBmaXJzdCB1c2UsIGFuZCBlYWNoXG4gKiBydW4gaXMgYSBmcmVzaCBWTSwgc28gYEdIX0NPTkZJR19ESVJgIG11c3QgcG9pbnQgYXQgc29tZXRoaW5nIHdyaXRhYmxlLlxuICogVW5kZXIgYH4vLmNvbmZpZ2AgYmVjYXVzZSB0aGUgcnVudGltZSBjcmVhdGVzIGB+Ly52aWJlLWNvZGVyYCByb290LW93bmVkXG4gKiBmb3IgdGhlIG1vdW50IHRhcmdldHMuIFRoZSBjb3B5IG5ldmVyIGxlYXZlcyB0aGUgVk0uXG4gKi9cbmV4cG9ydCBjb25zdCBHSF9SVU5USU1FX0NPTkZJR19TVUZGSVggPSBcIi5jb25maWcvZ2gtcnVudGltZVwiO1xuXG4vKipcbiAqIEVudmlyb25tZW50IHZhcmlhYmxlIG5hbWluZyB0aGUgY29udGFpbmVyJ3MgcGVyLWxhdW5jaCBzY3JhdGNoIHJvb3QuXG4gKlxuICogRXhwb3J0ZWQgYnkgYGNvbnRhaW5lci9lbnRyeXBvaW50LnNoYCAoSXNzdWUgIzUxNSkuIFNpbmNlIHRoZSBjaGVja291dCBhbmRcbiAqIHRoZSBjb250YWluZXIgcm9vdCBmaWxlc3lzdGVtIGJlY2FtZSByZWFkLW9ubHkgKElzc3VlICM1MDkpIHRoZSBlbnRyeXBvaW50XG4gKiBzdGFnZXMgdGhlIHdyaXRhYmxlIGdoIGNvcHkgYXQgYCR7VklCRV9TQ1JBVENIX0RJUn0vJHtHSF9DUkVERU5USUFMX1NVQkRJUn1gXG4gKiBpbnN0ZWFkIG9mIHtAbGluayBHSF9SVU5USU1FX0NPTkZJR19TVUZGSVh9LCBzbyBhbnkgcmVzb2x2ZXIgbG9va2luZyBmb3JcbiAqIHRoYXQgY29weSBtdXN0IGxvb2sgaGVyZSBmaXJzdC5cbiAqL1xuZXhwb3J0IGNvbnN0IFNDUkFUQ0hfRElSX0VOViA9IFwiVklCRV9TQ1JBVENIX0RJUlwiO1xuXG4vKiogRmlsZSBpbnNpZGUge0BsaW5rIEdIX0NSRURFTlRJQUxfU1VCRElSfSBob2xkaW5nIHRoZSBob3N0IHRva2VuLiAqL1xuZXhwb3J0IGNvbnN0IEdIX0hPU1RTX0ZJTEUgPSBcImhvc3RzLnltbFwiO1xuXG4vKipcbiAqIFRoZSBvbmx5IGVudHJpZXMgcGVybWl0dGVkIGRpcmVjdGx5IGluc2lkZSB0aGUgY3JlZGVudGlhbCBkaXJlY3RvcnkuXG4gKlxuICogRWFjaCBlbmFibGVkIHByb3ZpZGVyJ3Mgb3duIHN1Yi1kaXJlY3RvcnkgY29tZXMgZnJvbSBpdHMgZGVzY3JpcHRvciwgc29cbiAqIGVuYWJsaW5nIGEgc2Vjb25kIHByb3ZpZGVyIHdpZGVucyB0aGUgcGVybWl0dGVkIHNldCB3aXRob3V0IGFuIGVkaXQgaGVyZSDigJRcbiAqIHdoaWxlIGFueXRoaW5nIG91dHNpZGUgaXQgaXMgc3RpbGwgcmVwb3J0ZWQgKElzc3VlICM0MTA4KS5cbiAqXG4gKiBAcGFyYW0gcHJvdmlkZXJzIC0gVGhlIGVuYWJsZWQgcHJvdmlkZXIgZGVzY3JpcHRvcnMuXG4gKiBAcmV0dXJucyBUaGUgcGVybWl0dGVkIGVudHJ5IG5hbWVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYWxsb3dlZENyZWRlbnRpYWxFbnRyaWVzKFxuICBwcm92aWRlcnM6IHJlYWRvbmx5IEFnZW50UHJvdmlkZXJEZXNjcmlwdG9yW10sXG4pOiBzdHJpbmdbXSB7XG4gIHJldHVybiBbXG4gICAgR0hfQ1JFREVOVElBTF9TVUJESVIsXG4gICAgLi4ucHJvdmlkZXJzLm1hcCgocHJvdmlkZXIpID0+IHByb3ZpZGVyLmNyZWRlbnRpYWxzLnN1YmRpciksXG4gIF07XG59XG5cbi8qKiBGaWxlc3lzdGVtIG1ldGFkYXRhIHRoYXQgaXMgbm90IGNyZWRlbnRpYWwgbWF0ZXJpYWwgYW5kIGlzIGlnbm9yZWQuICovXG5jb25zdCBJR05PUkVEX0VOVFJJRVM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1wiLkRTX1N0b3JlXCJdO1xuXG4vKiogRW52aXJvbm1lbnQgdmFyaWFibGVzIHRoYXQgY2FycnkgYSB1c2FibGUgR2l0SHViIHRva2VuLiAqL1xuZXhwb3J0IGNvbnN0IEdJVEhVQl9DUkVERU5USUFMX0VOVl9WQVJTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgXCJHSF9UT0tFTlwiLFxuICBcIkdJVEhVQl9UT0tFTlwiLFxuXTtcblxuLyoqIE5hbWVkIHJlYXNvbnMgYSBjcmVkZW50aWFsIHByZWZsaWdodCBjYW4gZmFpbC4gKi9cbmV4cG9ydCB0eXBlIENyZWRlbnRpYWxGYWlsdXJlQ29kZSA9XG4gIHwgXCJjcmVkZW50aWFsLWRpci1taXNzaW5nXCJcbiAgfCBcImNyZWRlbnRpYWwtZGlyLW5vdC1hLWRpcmVjdG9yeVwiXG4gIHwgXCJjcmVkZW50aWFsLWRpci11bnJlYWRhYmxlXCJcbiAgfCBcImNyZWRlbnRpYWwtZGlyLWVtcHR5XCJcbiAgfCBcImdpdGh1Yi1jcmVkZW50aWFscy1taXNzaW5nXCJcbiAgfCBcInByb3ZpZGVyLWNyZWRlbnRpYWxzLW1pc3NpbmdcIlxuICB8IFwiY3JlZGVudGlhbC1wZXJtaXNzaW9ucy10b28tb3BlblwiXG4gIHwgXCJwcm92aWRlci10b2tlbi1maWxlLXVucmVjb2duaXNlZFwiXG4gIHwgXCJ1bmV4cGVjdGVkLWNyZWRlbnRpYWwtbWF0ZXJpYWxcIjtcblxuLyoqIFdoZXJlIHVzYWJsZSBjcmVkZW50aWFsIG1hdGVyaWFsIHdhcyBmb3VuZC4gKi9cbmV4cG9ydCB0eXBlIENyZWRlbnRpYWxTb3VyY2UgPSBcImRpcmVjdG9yeVwiIHwgXCJlbnZpcm9ubWVudFwiO1xuXG4vKiogQSBzaW5nbGUgbmFtZWQgcHJlZmxpZ2h0IGZhaWx1cmUuICovXG5leHBvcnQgaW50ZXJmYWNlIENyZWRlbnRpYWxGYWlsdXJlIHtcbiAgLyoqIFN0YWJsZSwgZ3JlcHBhYmxlIHJlYXNvbiBjb2RlLiAqL1xuICBjb2RlOiBDcmVkZW50aWFsRmFpbHVyZUNvZGU7XG4gIC8qKiBBY3Rpb25hYmxlIG9wZXJhdG9yLWZhY2luZyBtZXNzYWdlLiAqL1xuICBtZXNzYWdlOiBzdHJpbmc7XG4gIC8qKiBQYXRoIHRoZSBmYWlsdXJlIHJlZmVycyB0bywgd2hlbiBpdCBpcyBwYXRoLXNwZWNpZmljLiAqL1xuICBwYXRoPzogc3RyaW5nO1xuICAvKiogUHJvdmlkZXIgaWQgdGhlIGZhaWx1cmUgYmVsb25ncyB0bywgd2hlbiBpdCBpcyBwcm92aWRlci1zcGVjaWZpYy4gKi9cbiAgcHJvdmlkZXI/OiBzdHJpbmc7XG59XG5cbi8qKiBUaGUgY3JlZGVudGlhbCBzdGF0dXMgb2Ygb25lIGVuYWJsZWQgcHJvdmlkZXIgKElzc3VlICM0MTA4KS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUHJvdmlkZXJDcmVkZW50aWFsU3RhdHVzIHtcbiAgLyoqIFByb3ZpZGVyIGlkLCBhcyByZWdpc3RlcmVkIGluIHRoZSBzZWFtLiAqL1xuICBpZDogc3RyaW5nO1xuICAvKiogT3BlcmF0b3ItZmFjaW5nIHByb3ZpZGVyIG5hbWUuICovXG4gIGRpc3BsYXlOYW1lOiBzdHJpbmc7XG4gIC8qKiBXaGVyZSB0aGlzIHByb3ZpZGVyJ3MgY3JlZGVudGlhbCBjYW1lIGZyb20sIG9yIG51bGwgd2hlbiB1bnVzYWJsZS4gKi9cbiAgc291cmNlOiBDcmVkZW50aWFsU291cmNlIHwgbnVsbDtcbn1cblxuLyoqIE91dGNvbWUgb2YgYSBjcmVkZW50aWFsIHByZWZsaWdodC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ3JlZGVudGlhbFByZWZsaWdodFJlc3VsdCB7XG4gIC8qKiBUcnVlIHdoZW4gbm8gZmFpbHVyZSB3YXMgcmVjb3JkZWQuICovXG4gIG9rOiBib29sZWFuO1xuICAvKiogVGhlIGNyZWRlbnRpYWwgZGlyZWN0b3J5IHRoYXQgd2FzIGluc3BlY3RlZC4gKi9cbiAgZGlyOiBzdHJpbmc7XG4gIC8qKiBXaGVyZSB0aGUgR2l0SHViIGNyZWRlbnRpYWwgY2FtZSBmcm9tLCBvciBudWxsIHdoZW4gdW51c2FibGUuICovXG4gIGdpdGh1YlNvdXJjZTogQ3JlZGVudGlhbFNvdXJjZSB8IG51bGw7XG4gIC8qKlxuICAgKiBXaGVyZSB0aGUgYWN0aXZlIHByb3ZpZGVyJ3MgY3JlZGVudGlhbCBjYW1lIGZyb20sIG9yIG51bGwgd2hlbiB1bnVzYWJsZS5cbiAgICogUGVyLXByb3ZpZGVyIGRldGFpbCBmb3IgZXZlcnkgZW5hYmxlZCBwcm92aWRlciBpcyBpbiB7QGxpbmsgcHJvdmlkZXJzfS5cbiAgICovXG4gIHByb3ZpZGVyU291cmNlOiBDcmVkZW50aWFsU291cmNlIHwgbnVsbDtcbiAgLyoqIE9uZSBlbnRyeSBwZXIgZW5hYmxlZCBwcm92aWRlciwgaW4gZW5hYmxlZCBvcmRlciAoSXNzdWUgIzQxMDgpLiAqL1xuICBwcm92aWRlcnM6IFByb3ZpZGVyQ3JlZGVudGlhbFN0YXR1c1tdO1xuICAvKiogTmFtZWQgZmFpbHVyZXMsIGluIGRldGVjdGlvbiBvcmRlci4gKi9cbiAgZmFpbHVyZXM6IENyZWRlbnRpYWxGYWlsdXJlW107XG59XG5cbi8qKlxuICogRW52aXJvbm1lbnQgbG9va3VwIHNlYW0gKHRlc3RzIGluamVjdCBhIGZpeGVkIG1hcCkuXG4gKlxuICogUmUtZXhwb3J0ZWQgZnJvbSB0aGUgY2Fub25pY2FsIHtAbGluayBtb2R1bGU6bGliL2Vudl9sb29rdXB9IHNvIHRoZSB3b3JrZXJcbiAqIGhhcyBvbmUgc3BlbGxpbmcgb2YgdGhpcyB0eXBlIChJc3N1ZSAjOTU2KTsgdGhlIG5hbWUgaXMga2VwdCBoZXJlIGJlY2F1c2VcbiAqIGV2ZXJ5IGV4aXN0aW5nIGltcG9ydGVyIHJlYWNoZXMgZm9yIGl0IGF0IHRoaXMgcGF0aC5cbiAqL1xuZXhwb3J0IHR5cGUgeyBFbnZMb29rdXAgfTtcblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBjcmVkZW50aWFsIGRpcmVjdG9yeSBmb3IgdGhpcyBob3N0LlxuICpcbiAqIGBWSUJFX0NSRURFTlRJQUxfRElSYCB3aW5zIHNvIHRoZSBjb250YWluZXIgY2FuIHBvaW50IGF0IGl0cyByZWFkLW9ubHlcbiAqIG1vdW50OyBvdGhlcndpc2UgdGhlIGRlZmF1bHQgc2l0cyB1bmRlciB0aGUgd29ya2VyJ3MgaG9tZSBkaXJlY3RvcnkuXG4gKlxuICogQHBhcmFtIGVudiAtIEVudmlyb25tZW50IGxvb2t1cCAoZGVmYXVsdHMgdG8gdGhlIHByb2Nlc3MgZW52aXJvbm1lbnQpLlxuICogQHJldHVybnMgQWJzb2x1dGUgY3JlZGVudGlhbCBkaXJlY3RvcnkgcGF0aC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVDcmVkZW50aWFsRGlyKFxuICBlbnY6IEVudkxvb2t1cCA9IChuYW1lKSA9PiBEZW5vLmVudi5nZXQobmFtZSksXG4pOiBzdHJpbmcge1xuICBjb25zdCBvdmVycmlkZSA9IGVudihDUkVERU5USUFMX0RJUl9FTlYpPy50cmltKCk7XG4gIGlmIChvdmVycmlkZSkgcmV0dXJuIG92ZXJyaWRlLnJlcGxhY2UoL1xcLyskLywgXCJcIik7XG4gIGNvbnN0IGhvbWUgPSBlbnYoXCJIT01FXCIpID8/IGVudihcIlVTRVJQUk9GSUxFXCIpID8/IFwiXCI7XG4gIHJldHVybiBgJHtob21lfS8ke0RFRkFVTFRfQ1JFREVOVElBTF9ESVJfU1VGRklYfWA7XG59XG5cbi8qKlxuICogRXh0cmFjdCB0aGUgaG9zdCB0b2tlbiBmcm9tIGBnaGAgYGhvc3RzLnltbGAgY29udGVudC5cbiAqXG4gKiBAcGFyYW0geWFtbCAtIFJhdyBmaWxlIGNvbnRlbnQuXG4gKiBAcmV0dXJucyBUaGUgdG9rZW4sIG9yIG51bGwgd2hlbiBhYnNlbnQsIGJsYW5rLCBvciBhbiBlbXB0eSBxdW90ZWQgc3RyaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdEdoVG9rZW4oeWFtbDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICgheWFtbCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IG1hdGNoID0geWFtbC5tYXRjaCgvXlxccyooPzpvYXV0aF90b2tlbnx0b2tlbik6WyBcXHRdKiguKykkL20pO1xuICBjb25zdCByYXcgPSBtYXRjaD8uWzFdPy50cmltKCk7XG4gIGlmICghcmF3KSByZXR1cm4gbnVsbDtcbiAgY29uc3QgdW5xdW90ZWQgPSByYXcucmVwbGFjZSgvXltcIiddfFtcIiddJC9nLCBcIlwiKS50cmltKCk7XG4gIHJldHVybiB1bnF1b3RlZC5sZW5ndGggPiAwID8gdW5xdW90ZWQgOiBudWxsO1xufVxuXG4vKiogQ3JlZGVudGlhbCBtYXRlcmlhbCBhbmQgcGVyc2lzdGVudC1zdGF0ZSBzZWxlY3RvcnMgYWNjZXB0ZWQgYXQgcnVudGltZS4gKi9cbmZ1bmN0aW9uIHJ1bnRpbWVDcmVkZW50aWFsRW52VmFycyhcbiAgcHJvdmlkZXI6IEFnZW50UHJvdmlkZXJEZXNjcmlwdG9yLFxuKTogcmVhZG9ubHkgc3RyaW5nW10ge1xuICByZXR1cm4gW1xuICAgIC4uLnByb3ZpZGVyLmNyZWRlbnRpYWxzLmVudlZhcnMsXG4gICAgLi4uKHByb3ZpZGVyLmNyZWRlbnRpYWxzLnN0YXRlRW52VmFycyA/PyBbXSksXG4gIF07XG59XG5cbi8qKlxuICogRmluZCBhIHVzYWJsZSBwcm92aWRlciBjcmVkZW50aWFsIGluIGFuIGVudi1zdHlsZSBjcmVkZW50aWFsIGZpbGUuXG4gKlxuICogQHBhcmFtIGNvbnRlbnQgLSBSYXcgZmlsZSBjb250ZW50IChgS0VZPXZhbHVlYCBsaW5lcywgYGV4cG9ydGAgb3B0aW9uYWwpLlxuICogQHBhcmFtIGVudlZhcnMgLSBDcmVkZW50aWFsIHZhcmlhYmxlIG5hbWVzIHRoZSBwcm92aWRlciByZWNvZ25pc2VzXG4gKiAgIChkZWZhdWx0cyB0byB0aGUgYWN0aXZlIHByb3ZpZGVyJ3MpLlxuICogQHJldHVybnMgVGhlIG5hbWUgb2YgdGhlIHJlY29nbmlzZWQgdmFyaWFibGUsIG9yIG51bGwgd2hlbiBub25lIGlzIHVzYWJsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUHJvdmlkZXJDcmVkZW50aWFscyhcbiAgY29udGVudDogc3RyaW5nLFxuICBlbnZWYXJzOiByZWFkb25seSBzdHJpbmdbXSA9IHJ1bnRpbWVDcmVkZW50aWFsRW52VmFycyhhY3RpdmVBZ2VudFByb3ZpZGVyKCkpLFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBwYXJzZVByb3ZpZGVyQ3JlZGVudGlhbEVudHJpZXMoY29udGVudCwgZW52VmFycylbMF0/Lm5hbWUgPz8gbnVsbDtcbn1cblxuLyoqIE9uZSBjcmVkZW50aWFsIGVudHJ5IHBhcnNlZCBmcm9tIGFuIGVudi1zdHlsZSBjcmVkZW50aWFsIGZpbGUuICovXG5leHBvcnQgaW50ZXJmYWNlIFByb3ZpZGVyQ3JlZGVudGlhbEVudHJ5IHtcbiAgbmFtZTogc3RyaW5nO1xuICB2YWx1ZTogc3RyaW5nO1xufVxuXG4vKipcbiAqIEV2ZXJ5IHVzYWJsZSBjcmVkZW50aWFsIGVudHJ5IGluIGFuIGVudi1zdHlsZSBjcmVkZW50aWFsIGZpbGUsIGluIG9yZGVyLlxuICpcbiAqIEBwYXJhbSBjb250ZW50IC0gUmF3IGZpbGUgY29udGVudCAoYEtFWT12YWx1ZWAgbGluZXMsIGBleHBvcnRgIG9wdGlvbmFsKS5cbiAqIEBwYXJhbSBlbnZWYXJzIC0gQ3JlZGVudGlhbCB2YXJpYWJsZSBuYW1lcyB0aGUgcHJvdmlkZXIgcmVjb2duaXNlcy5cbiAqIEByZXR1cm5zIFJlY29nbmlzZWQgZW50cmllcyB3aXRoIG5vbi1ibGFuayB2YWx1ZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVByb3ZpZGVyQ3JlZGVudGlhbEVudHJpZXMoXG4gIGNvbnRlbnQ6IHN0cmluZyxcbiAgZW52VmFyczogcmVhZG9ubHkgc3RyaW5nW10sXG4pOiBQcm92aWRlckNyZWRlbnRpYWxFbnRyeVtdIHtcbiAgaWYgKCFjb250ZW50KSByZXR1cm4gW107XG4gIGNvbnN0IGVudHJpZXM6IFByb3ZpZGVyQ3JlZGVudGlhbEVudHJ5W10gPSBbXTtcbiAgZm9yIChjb25zdCBsaW5lIG9mIGNvbnRlbnQuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCBjb2RlID0gbGluZS50cmltKCk7XG4gICAgaWYgKCFjb2RlIHx8IGNvZGUuc3RhcnRzV2l0aChcIiNcIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IG1hdGNoID0gY29kZS5tYXRjaCgvXig/OmV4cG9ydFxccyspPyhbQS1aMC05X10rKVxccyo9XFxzKiguKikkLyk7XG4gICAgY29uc3QgbmFtZSA9IG1hdGNoPy5bMV07XG4gICAgaWYgKCFuYW1lIHx8ICFlbnZWYXJzLmluY2x1ZGVzKG5hbWUpKSBjb250aW51ZTtcbiAgICBjb25zdCB2YWx1ZSA9IChtYXRjaD8uWzJdID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9eW1wiJ118W1wiJ10kL2csIFwiXCIpLnRyaW0oKTtcbiAgICBpZiAodmFsdWUubGVuZ3RoID4gMCkgZW50cmllcy5wdXNoKHsgbmFtZSwgdmFsdWUgfSk7XG4gIH1cbiAgcmV0dXJuIGVudHJpZXM7XG59XG5cbi8qKlxuICogT25lIGNyZWRlbnRpYWwgZmlsZSBmb3VuZCBpbiBhIHByb3ZpZGVyJ3MgY3JlZGVudGlhbCBzdWItZGlyZWN0b3J5XG4gKiAoSXNzdWUgIzkxNywgcGFyZW50ICM5MDIpLlxuICpcbiAqIFRoZSByZWNvcmQgaXMgc2FmZSB0byBsb2cgYXMgYSB3aG9sZSBvbmx5IGFmdGVyIHtAbGluayB2YWx1ZX0gaXMgZHJvcHBlZDpcbiAqIHtAbGluayBsYWJlbH0gZXhpc3RzIHByZWNpc2VseSBzbyBhIHJ1biBjYW4gc2F5IHdoaWNoIHRva2VuIGl0IGNob3NlXG4gKiB3aXRob3V0IHRoZSB0b2tlbiBldmVyIHJlYWNoaW5nIGEgbG9nIGxpbmUsIGEgY29tbWVudCwgb3IgYW4gZXNjYWxhdGlvbi5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBQcm92aWRlclRva2VuRmlsZSB7XG4gIC8qKiBGaWxlIHN0ZW0g4oCUIGBwcm92aWRlcmAsIGBwcm92aWRlci0yYCwg4oCmIOKAlCBzYWZlIHRvIGxvZy4gKi9cbiAgbGFiZWw6IHN0cmluZztcbiAgLyoqIEFic29sdXRlIHBhdGggdG8gdGhlIGZpbGUuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqXG4gICAqIFRoZSByZWNvZ25pc2VkIGNyZWRlbnRpYWwgdmFyaWFibGUgdGhhdCBpZGVudGlmaWVzIHRoaXMgdG9rZW4sIG9yIG51bGxcbiAgICogd2hlbiB0aGUgZmlsZSBob2xkcyBub25lLiBUaGUgZmlyc3QgcmVjb2duaXNlZCBlbnRyeSB3aW5zLCB3aGljaCBpcyB0aGVcbiAgICogc2FtZSBlbnRyeSB7QGxpbmsgcGFyc2VQcm92aWRlckNyZWRlbnRpYWxzfSByZXBvcnRzLlxuICAgKi9cbiAgbmFtZTogc3RyaW5nIHwgbnVsbDtcbiAgLyoqIFRoZSBjcmVkZW50aWFsIHZhbHVlLiBORVZFUiBsb2cgaXQuIE51bGwgd2hlbiB7QGxpbmsgbmFtZX0gaXMgbnVsbC4gKi9cbiAgdmFsdWU6IHN0cmluZyB8IG51bGw7XG4gIC8qKiBUcnVlIGZvciB0aGUgcHJvdmlkZXIncyBwcmltYXJ5IGBwcm92aWRlci5lbnZgLiAqL1xuICBwcmltYXJ5OiBib29sZWFuO1xuICAvKipcbiAgICogVHJ1ZSB3aGVuIHRoaXMgZmlsZSdzIHZhcmlhYmxlIG1ha2VzIGl0IGEgYnVkZ2V0LXNlbGVjdGlvbiBjYW5kaWRhdGUg4oCUXG4gICAqIGEgc3Vic2NyaXB0aW9uIE9BdXRoIHRva2VuIHJhdGhlciB0aGFuIGEgbWV0ZXJlZCBBUEkga2V5LiBUaGUgYnVkZ2V0XG4gICAqIHByb2JlICgjOTE4KSBhbmQgdGhlIHNlbGVjdG9yICgjOTE5KSBjb25zaWRlciB0aGVzZSBhbmQgbm8gb3RoZXJzLlxuICAgKi9cbiAgcG9vbE1lbWJlcjogYm9vbGVhbjtcbiAgLyoqXG4gICAqIEV2ZXJ5IHJlY29nbmlzZWQgZW50cnkgaW4gdGhlIGZpbGUsIGluIGZpbGUgb3JkZXIuIEV4cG9ydGluZyB0aGUgd2hvbGVcbiAgICogZmlsZSByYXRoZXIgdGhhbiB7QGxpbmsgbmFtZX0gYWxvbmUgaXMgd2hhdCBrZWVwcyBhIHNpbmdsZS10b2tlbiBob3N0XG4gICAqIGJ5dGUtZm9yLWJ5dGUgb24gaXRzIHByZXZpb3VzIGJlaGF2aW91ci5cbiAgICovXG4gIGVudHJpZXM6IFByb3ZpZGVyQ3JlZGVudGlhbEVudHJ5W107XG59XG5cbi8qKiBTdHJpcCBhIGNyZWRlbnRpYWwgZmlsZSdzIGV4dGVuc2lvbiB0byBnZXQgaXRzIGxvZ2dhYmxlIGxhYmVsLiAqL1xuZnVuY3Rpb24gZmlsZVN0ZW0obmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIG5hbWUucmVwbGFjZSgvXFwuW14uXSskLywgXCJcIik7XG59XG5cbi8qKiBCdWlsZCBvbmUgdG9rZW4gcmVjb3JkIGZyb20gYSBmaWxlJ3MgcmF3IGNvbnRlbnQuICovXG5mdW5jdGlvbiB0b2tlbkZpbGVSZWNvcmQoXG4gIHBhdGg6IHN0cmluZyxcbiAgZmlsZU5hbWU6IHN0cmluZyxcbiAgY29udGVudDogc3RyaW5nLFxuICBwcm92aWRlcjogQWdlbnRQcm92aWRlckRlc2NyaXB0b3IsXG4gIHByaW1hcnk6IGJvb2xlYW4sXG4pOiBQcm92aWRlclRva2VuRmlsZSB7XG4gIGNvbnN0IGVudHJpZXMgPSBwYXJzZVByb3ZpZGVyQ3JlZGVudGlhbEVudHJpZXMoXG4gICAgY29udGVudCxcbiAgICBydW50aW1lQ3JlZGVudGlhbEVudlZhcnMocHJvdmlkZXIpLFxuICApO1xuICBjb25zdCBmaXJzdCA9IGVudHJpZXNbMF0gPz8gbnVsbDtcbiAgY29uc3QgcG9vbCA9IHByb3ZpZGVyLmNyZWRlbnRpYWxzLnRva2VuUG9vbDtcbiAgcmV0dXJuIHtcbiAgICBsYWJlbDogZmlsZVN0ZW0oZmlsZU5hbWUpLFxuICAgIHBhdGgsXG4gICAgbmFtZTogZmlyc3Q/Lm5hbWUgPz8gbnVsbCxcbiAgICB2YWx1ZTogZmlyc3Q/LnZhbHVlID8/IG51bGwsXG4gICAgcHJpbWFyeSxcbiAgICBwb29sTWVtYmVyOiBmaXJzdCAhPT0gbnVsbCAmJiAocG9vbD8uZW52VmFycy5pbmNsdWRlcyhmaXJzdC5uYW1lKSA/PyBmYWxzZSksXG4gICAgZW50cmllcyxcbiAgfTtcbn1cblxuLyoqXG4gKiBFdmVyeSBjcmVkZW50aWFsIGZpbGUgaW4gb25lIHByb3ZpZGVyJ3MgY3JlZGVudGlhbCBzdWItZGlyZWN0b3J5LCBpbiBhXG4gKiBkZXRlcm1pbmlzdGljIG9yZGVyIChJc3N1ZSAjOTE3LCBwYXJlbnQgIzkwMikuXG4gKlxuICogT3JkZXIgaXMgdGhlIHByaW1hcnkgYHByb3ZpZGVyLmVudmAgZmlyc3QsIHRoZW4gdGhlIHBvb2wgZmlsZXMgaW4gYXNjZW5kaW5nXG4gKiBOVU1FUklDIG9yZGVyIG9mIHRoZWlyIG9yZGluYWwg4oCUIGBwcm92aWRlci0yYCwgYHByb3ZpZGVyLTEwYCDigJQgYmVjYXVzZSBhXG4gKiBkaXJlY3RvcnkgbGlzdGluZydzIG9yZGVyIGlzIGZpbGVzeXN0ZW0tZGVwZW5kZW50IGFuZCBhIHRleHQgc29ydCBwdXRzXG4gKiBgcHJvdmlkZXItMTAuZW52YCBiZWZvcmUgYHByb3ZpZGVyLTIuZW52YC4gQSBzdGFibGUgb3JkZXIgaXMgd2hhdCBtYWtlc1xuICogXCJ0aGUgZmlyc3QgZW50cnlcIiBhIGRlZmVuc2libGUgZGVmYXVsdCBzZWxlY3Rpb24gd2hpbGUgIzkxOSBpcyBvdXRzdGFuZGluZy5cbiAqXG4gKiBBIHByb3ZpZGVyIHdpdGggbm8ge0BsaW5rIEFnZW50UHJvdmlkZXJUb2tlblBvb2x9IHlpZWxkcyBhdCBtb3N0IHRoZSBvbmVcbiAqIHJlY29yZCBpdCBoYXMgYWx3YXlzIGhhZCwgc28gbm8gb3RoZXIgdmVuZG9yIGdhaW5zIGEgcG9vbC5cbiAqXG4gKiBGaWxlcyB0aGF0IHBhcnNlIHRvIG5vIHJlY29nbmlzZWQgdmFyaWFibGUgYXJlIHN0aWxsIHJldHVybmVkLCB3aXRoIGEgbnVsbFxuICoge0BsaW5rIFByb3ZpZGVyVG9rZW5GaWxlLm5hbWV9OiB0aGUgcHJlZmxpZ2h0IHJlcG9ydHMgdGhlbSBieSBuYW1lIHJhdGhlclxuICogdGhhbiBza2lwcGluZyB0aGVtIHNpbGVudGx5IChmYWlsLWxvdWQsIElzc3VlICMzMjM0KS5cbiAqXG4gKiBAcGFyYW0gZGlyIC0gVGhlIGNyZWRlbnRpYWwgZGlyZWN0b3J5LlxuICogQHBhcmFtIHByb3ZpZGVyIC0gVGhlIHByb3ZpZGVyIHdob3NlIHN1Yi1kaXJlY3RvcnkgdG8gbGlzdC5cbiAqIEByZXR1cm5zIFRoZSBkaXNjb3ZlcmVkIHRva2VuIGZpbGVzLCBpbiBzZWxlY3Rpb24gb3JkZXIuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkaXNjb3ZlclByb3ZpZGVyVG9rZW5GaWxlcyhcbiAgZGlyOiBzdHJpbmcsXG4gIHByb3ZpZGVyOiBBZ2VudFByb3ZpZGVyRGVzY3JpcHRvcixcbik6IFByb21pc2U8UHJvdmlkZXJUb2tlbkZpbGVbXT4ge1xuICBjb25zdCB0b2tlbnM6IFByb3ZpZGVyVG9rZW5GaWxlW10gPSBbXTtcbiAgY29uc3QgcHJpbWFyeVBhdGggPSBwcm92aWRlckNyZWRlbnRpYWxQYXRoKGRpciwgcHJvdmlkZXIpO1xuICBjb25zdCBwcmltYXJ5ID0gYXdhaXQgcmVhZElmUHJlc2VudChwcmltYXJ5UGF0aCk7XG4gIGlmIChwcmltYXJ5ICE9PSBudWxsKSB7XG4gICAgdG9rZW5zLnB1c2goXG4gICAgICB0b2tlbkZpbGVSZWNvcmQoXG4gICAgICAgIHByaW1hcnlQYXRoLFxuICAgICAgICBwcm92aWRlci5jcmVkZW50aWFscy5maWxlLFxuICAgICAgICBwcmltYXJ5LFxuICAgICAgICBwcm92aWRlcixcbiAgICAgICAgdHJ1ZSxcbiAgICAgICksXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHBvb2wgPSBwcm92aWRlci5jcmVkZW50aWFscy50b2tlblBvb2w7XG4gIGlmICghcG9vbCkgcmV0dXJuIHRva2VucztcblxuICBjb25zdCBzdWJkaXIgPSBgJHtkaXJ9LyR7cHJvdmlkZXIuY3JlZGVudGlhbHMuc3ViZGlyfWA7XG4gIGxldCBlbnRyaWVzOiBEZW5vLkRpckVudHJ5W10gPSBbXTtcbiAgdHJ5IHtcbiAgICBlbnRyaWVzID0gYXdhaXQgQXJyYXkuZnJvbUFzeW5jKERlbm8ucmVhZERpcihzdWJkaXIpKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHRva2VuczsgLy8gQWJzZW50IG9yIHVucmVhZGFibGU6IGFscmVhZHkgcmVwb3J0ZWQgYnkgdGhlIHByZWZsaWdodC5cbiAgfVxuXG4gIGNvbnN0IGV4dHJhczogeyBvcmRpbmFsOiBudW1iZXI7IG5hbWU6IHN0cmluZyB9W10gPSBbXTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgaWYgKGVudHJ5LmlzRGlyZWN0b3J5KSBjb250aW51ZTtcbiAgICBjb25zdCBvcmRpbmFsID0gTnVtYmVyKGVudHJ5Lm5hbWUubWF0Y2gocG9vbC5maWxlTWF0Y2gpPy5bMV0pO1xuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG9yZGluYWwpKSBjb250aW51ZTtcbiAgICBleHRyYXMucHVzaCh7IG9yZGluYWwsIG5hbWU6IGVudHJ5Lm5hbWUgfSk7XG4gIH1cbiAgZXh0cmFzLnNvcnQoKGEsIGIpID0+IGEub3JkaW5hbCAtIGIub3JkaW5hbCB8fCBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpKTtcblxuICBmb3IgKGNvbnN0IGV4dHJhIG9mIGV4dHJhcykge1xuICAgIGNvbnN0IHBhdGggPSBgJHtzdWJkaXJ9LyR7ZXh0cmEubmFtZX1gO1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCByZWFkSWZQcmVzZW50KHBhdGgpO1xuICAgIGlmIChjb250ZW50ID09PSBudWxsKSBjb250aW51ZTtcbiAgICB0b2tlbnMucHVzaCh0b2tlbkZpbGVSZWNvcmQocGF0aCwgZXh0cmEubmFtZSwgY29udGVudCwgcHJvdmlkZXIsIGZhbHNlKSk7XG4gIH1cbiAgcmV0dXJuIHRva2Vucztcbn1cblxuLyoqXG4gKiBDaG9vc2VzIHdoaWNoIGRpc2NvdmVyZWQgdG9rZW4gZmlsZSBpcyBleHBvcnRlZCBpbnRvIHRoZSBydW4gZW52aXJvbm1lbnQuXG4gKlxuICogVGhlIHNlYW0gIzkxOCAoYnVkZ2V0IHByb2JlKSBhbmQgIzkxOSAoYnVkZ2V0LWJhc2VkIHNlbGVjdGlvbikgcmVwbGFjZTogdGhlXG4gKiBjb250cmFjdCBpcyB0aGF0IGV4YWN0bHkgT05FIHRva2VuIGZpbGUgaXMgZXZlciBleHBvcnRlZCwgc28gYW4gdW5zZWxlY3RlZFxuICogc3Vic2NyaXB0aW9uIG5ldmVyIHJlYWNoZXMgdGhlIGNvZGluZyBhZ2VudCdzIGVudmlyb25tZW50IChwYXJlbnQgIzkwMikuXG4gKi9cbmV4cG9ydCB0eXBlIFByb3ZpZGVyVG9rZW5TZWxlY3RvciA9IChcbiAgdG9rZW5zOiByZWFkb25seSBQcm92aWRlclRva2VuRmlsZVtdLFxuICBwcm92aWRlcjogQWdlbnRQcm92aWRlckRlc2NyaXB0b3IsXG4pID0+IFByb3ZpZGVyVG9rZW5GaWxlIHwgbnVsbCB8IFByb21pc2U8UHJvdmlkZXJUb2tlbkZpbGUgfCBudWxsPjtcblxuLyoqXG4gKiBUaGUgZGVmYXVsdCBzZWxlY3RvcjogdGhlIGZpcnN0IHVzYWJsZSBmaWxlIGluIGRpc2NvdmVyeSBvcmRlci5cbiAqXG4gKiBEZXRlcm1pbmlzdGljIGFuZCwgb24gYSBob3N0IHdpdGggdGhlIHNpbmdsZSBgcHJvdmlkZXIuZW52YCBpdCBoYXMgYWx3YXlzXG4gKiBoYWQsIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gdGhlIGJlaGF2aW91ciBiZWZvcmUgSXNzdWUgIzkxNy5cbiAqXG4gKiBAcGFyYW0gdG9rZW5zIC0gVGhlIGRpc2NvdmVyZWQgZmlsZXMsIGluIGRpc2NvdmVyeSBvcmRlci5cbiAqIEByZXR1cm5zIFRoZSBmaXJzdCBmaWxlIGhvbGRpbmcgYSByZWNvZ25pc2VkIGNyZWRlbnRpYWwsIG9yIG51bGwuXG4gKi9cbmV4cG9ydCBjb25zdCBzZWxlY3RGaXJzdFByb3ZpZGVyVG9rZW46IFByb3ZpZGVyVG9rZW5TZWxlY3RvciA9ICh0b2tlbnMpID0+XG4gIHRva2Vucy5maW5kKCh0b2tlbikgPT4gdG9rZW4ubmFtZSAhPT0gbnVsbCkgPz8gbnVsbDtcblxuLyoqXG4gKiBUaGUgZGlzY292ZXJlZCBmaWxlcyB0aGF0IGFyZSBidWRnZXQtc2VsZWN0aW9uIGNhbmRpZGF0ZXMuXG4gKlxuICogQSBzdWJzY3JpcHRpb24gT0F1dGggdG9rZW4gd2l0aCBhIHZhbHVlOiBhIG1ldGVyZWQgYEFOVEhST1BJQ19BUElfS0VZYCBoYXNcbiAqIG5vIHBlci10b2tlbiBidWRnZXQgdG8gd2VpZ2gsIGFuZCBhbiBlbXB0eSBmaWxlIGlzIGEgY29uZmlndXJhdGlvbiBmYXVsdFxuICogcmF0aGVyIHRoYW4gYSBjYW5kaWRhdGUuIE9uZSBzcGVsbGluZyBvZiB0aGUgZmlsdGVyLCBzaGFyZWQgYnkgdGhlIGJ1ZGdldFxuICogcHJvYmUncyB0aHJlZSBjYWxsZXJzIChJc3N1ZSAjMTY2OCkgc28gdGhleSBjYW5ub3QgZHJpZnQgYXBhcnQgb24gd2hhdFxuICogY291bnRzIGFzIGEgcG9vbCBtZW1iZXIuXG4gKlxuICogQHBhcmFtIHRva2VucyAtIFRoZSBkaXNjb3ZlcmVkIGZpbGVzLCBpbiBkaXNjb3Zlcnkgb3JkZXIuXG4gKiBAcmV0dXJucyBUaGUgcG9vbCBjYW5kaWRhdGVzLCBpbiB0aGUgc2FtZSBvcmRlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByb3ZpZGVyUG9vbENhbmRpZGF0ZXMoXG4gIHRva2VuczogcmVhZG9ubHkgUHJvdmlkZXJUb2tlbkZpbGVbXSxcbik6IFByb3ZpZGVyVG9rZW5GaWxlW10ge1xuICByZXR1cm4gdG9rZW5zLmZpbHRlcihcbiAgICAodG9rZW4pID0+IHRva2VuLnBvb2xNZW1iZXIgJiYgKHRva2VuLnZhbHVlID8/IFwiXCIpLnRyaW0oKS5sZW5ndGggPiAwLFxuICApO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFdoaWNoIGNyZWRlbnRpYWwgdGhlIHJ1biBlbnZpcm9ubWVudCBob2xkc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogQ3JlZGVudGlhbCBsYWJlbCAoZmlsZSBzdGVtIOKAlCBgcHJvdmlkZXJgLCBgcHJvdmlkZXItMmApIHdob3NlIG1hdGVyaWFsIGVhY2hcbiAqIHByb3ZpZGVyJ3MgcnVuIGVudmlyb25tZW50IGN1cnJlbnRseSBjYXJyaWVzIChJc3N1ZSAjMjAwMikuXG4gKlxuICogUmVjb3JkZWQgd2hlbiBzdGFydC11cCBleHBvcnRzIGEgc2VsZWN0ZWQgdG9rZW4gZmlsZSBhbmQgYWdhaW4gd2hlbiB0aGVcbiAqIGNyZWRlbnRpYWwgcG9vbCBzd2l0Y2hlcyB0aGUgcnVuIHRvIGFub3RoZXIgb25lLiBJdCBleGlzdHMgc28gYSB1c2FnZS1saW1pdFxuICogc2lnbmFsIGNhbiBuYW1lIHRoZSBzdWJzY3JpcHRpb24gdGhhdCByYW4gb3V0LCBhbmQgc28gYSBsYXRlciByZWFkZXIgY2FuXG4gKiB0ZWxsIFwidGhpcyBzdWJzY3JpcHRpb24gaXMgc3BlbnRcIiBmcm9tIFwidGhpcyBwcm92aWRlciBpcyBzcGVudCBvbiB0aGlzXG4gKiBob3N0XCIg4oCUIHRoZSBkaWZmZXJlbmNlIGJldHdlZW4gcGF1c2luZyBhIHJ1biB0aGF0IGhvbGRzIHRoZSBzcGVudCB0b2tlbiBhbmRcbiAqIHBhdXNpbmcgYSByZXN0YXJ0IHRoYXQgZGVsaWJlcmF0ZWx5IHBpY2tlZCBhIGZyZXNoIG9uZS4gUHJvY2Vzcy13aWRlLCBsaWtlXG4gKiB0aGUgZW52aXJvbm1lbnQgaXQgZGVzY3JpYmVzLiBOZXZlciBhIHNlY3JldCB2YWx1ZTogbGFiZWxzIGFyZSBmaWxlIHN0ZW1zLlxuICovXG5jb25zdCBoZWxkUHJvdmlkZXJDcmVkZW50aWFscyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cbi8qKiBSZWNvcmQgd2hpY2ggY3JlZGVudGlhbCBmaWxlIGEgcHJvdmlkZXIncyBydW4gZW52aXJvbm1lbnQgbm93IGNhcnJpZXMuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkSGVsZFByb3ZpZGVyQ3JlZGVudGlhbChcbiAgcHJvdmlkZXJJZDogc3RyaW5nLFxuICBsYWJlbDogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGNvbnN0IGtleSA9IHByb3ZpZGVySWQudHJpbSgpO1xuICBjb25zdCB2YWx1ZSA9IGxhYmVsLnRyaW0oKTtcbiAgaWYgKGtleS5sZW5ndGggPT09IDAgfHwgdmFsdWUubGVuZ3RoID09PSAwKSByZXR1cm47XG4gIGhlbGRQcm92aWRlckNyZWRlbnRpYWxzLnNldChrZXksIHZhbHVlKTtcbn1cblxuLyoqXG4gKiBUaGUgY3JlZGVudGlhbCBsYWJlbCBhIHByb3ZpZGVyJ3MgcnVuIGVudmlyb25tZW50IGNhcnJpZXMsIG9yIGB1bmRlZmluZWRgXG4gKiB3aGVuIHRoaXMgcHJvY2VzcyBuZXZlciBleHBvcnRlZCBvbmUgKGEgc2luZ2xlLWNyZWRlbnRpYWwgaG9zdCB3aG9zZVxuICogdmFyaWFibGUgd2FzIGFscmVhZHkgaW4gdGhlIGVudmlyb25tZW50LCBvciBhIHByb3ZpZGVyIG5vdCBlbmFibGVkIGhlcmUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVsZFByb3ZpZGVyQ3JlZGVudGlhbExhYmVsKFxuICBwcm92aWRlcklkOiBzdHJpbmcsXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICByZXR1cm4gaGVsZFByb3ZpZGVyQ3JlZGVudGlhbHMuZ2V0KHByb3ZpZGVySWQudHJpbSgpKTtcbn1cblxuLyoqIEZvcmdldCBldmVyeSBoZWxkIGxhYmVsLiBGb3IgdGVzdHMsIHdoaWNoIHNoYXJlIG9uZSBtb2R1bGUgaW5zdGFuY2UuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRIZWxkUHJvdmlkZXJDcmVkZW50aWFscygpOiB2b2lkIHtcbiAgaGVsZFByb3ZpZGVyQ3JlZGVudGlhbHMuY2xlYXIoKTtcbn1cblxuLyoqXG4gKiBFeHBvcnQgZWFjaCBlbmFibGVkIHByb3ZpZGVyJ3MgZGlyZWN0b3J5IGNyZWRlbnRpYWwgaW50byB0aGUgcHJvY2Vzc1xuICogZW52aXJvbm1lbnQg4oCUIHRoZSBydW50aW1lIGhhbGYgb2YgSXNzdWUgIzQwNjQuXG4gKlxuICogVGhlIHByZWZsaWdodCBhYm92ZSBwcm92ZXMgdGhlIG1hdGVyaWFsIGV4aXN0czsgdGhpcyBtYWtlcyBpdCB1c2FibGU6XG4gKiBhZ2VudCBjaGlsZCBlbnZpcm9ubWVudHMgYXJlIGJ1aWx0IEZST00gdGhlIHBhcmVudCBlbnZcbiAqIChgYnVpbGRDaGlsZEVudmAsIGZpbHRlcmVkIHBlciB2ZW5kb3Igc28gbm8gcHJvdmlkZXIgc2VlcyBhbm90aGVyJ3NcbiAqIHNlY3JldCDigJQgSXNzdWUgIzQxMDgpLCBzbyB0aGUgcGFyZW50IHByb2Nlc3MgbXVzdCBhY3R1YWxseSBjYXJyeSB0aGVcbiAqIHZhcmlhYmxlcy4gT2JzZXJ2ZWQgbGl2ZSB3aXRob3V0IGl0OiB0aGUgY29udGFpbmVkIHdvcmtlcidzIGhlYWx0aCBjaGVja1xuICogZmFpbGVkIFwiTm90IGxvZ2dlZCBpbiDCtyBQbGVhc2UgcnVuIC9sb2dpblwiIHN0cmFpZ2h0IGFmdGVyIGEgcGFzc2luZ1xuICogcHJlZmxpZ2h0LlxuICpcbiAqIEEgdmFyaWFibGUgYWxyZWFkeSBwcmVzZW50IGluIHRoZSBlbnZpcm9ubWVudCBpcyBuZXZlciBjbG9iYmVyZWQg4oCUIGFuXG4gKiBvcGVyYXRvciBvdmVycmlkZSBvciBlbnYtcHJvdmlzaW9uZWQgY3JlZGVudGlhbCB3aW5zLlxuICpcbiAqIEV4YWN0bHkgT05FIG9mIGEgcHJvdmlkZXIncyB0b2tlbiBmaWxlcyBpcyBleHBvcnRlZCAoSXNzdWUgIzkxNywgcGFyZW50XG4gKiAjOTAyKTogYSBob3N0IG1heSBub3cgaG9sZCBzZXZlcmFsIHN1YnNjcmlwdGlvbnMgd2l0aCBvbmUgdmVuZG9yLCBhbmQgYW5cbiAqIHVuc2VsZWN0ZWQgb25lIG11c3QgbmV2ZXIgcmVhY2ggdGhlIGNvZGluZyBhZ2VudCdzIGVudmlyb25tZW50LiBXaGljaCBvbmVcbiAqIGlzIGV4cG9ydGVkIGlzIHRoZSB7QGxpbmsgUHJvdmlkZXJUb2tlblNlbGVjdG9yfSdzIGRlY2lzaW9uOyB1bnRpbCAjOTE5XG4gKiBsYW5kcyBpdCBpcyB0aGUgZmlyc3QgaW4gZGlzY292ZXJ5IG9yZGVyLCBzbyBhIHNpbmdsZS10b2tlbiBob3N0IGV4cG9ydHNcbiAqIGV4YWN0bHkgd2hhdCBpdCBkaWQgYmVmb3JlLlxuICpcbiAqIEBwYXJhbSBvcHRpb25zIC0gRGlyZWN0b3J5LCBlbnYgbG9va3VwLCBzZXR0ZXIsIHByb3ZpZGVyIGFuZCBzZWxlY3RvclxuICogICBvdmVycmlkZXMgKGFsbCBpbmplY3RhYmxlIGZvciB0ZXN0cykuXG4gKiBAcmV0dXJucyBUaGUgdmFyaWFibGUgbmFtZXMgZXhwb3J0ZWQsIGZvciBuYW1lcy1vbmx5IGxvZ2dpbmcuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhcHBseVByb3ZpZGVyQ3JlZGVudGlhbEVudihvcHRpb25zOiB7XG4gIGRpcj86IHN0cmluZztcbiAgZW52PzogRW52TG9va3VwO1xuICBzZXRFbnY/OiAobmFtZTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKSA9PiB2b2lkO1xuICBwcm92aWRlcnM/OiByZWFkb25seSBBZ2VudFByb3ZpZGVyRGVzY3JpcHRvcltdO1xuICBzZWxlY3RUb2tlbj86IFByb3ZpZGVyVG9rZW5TZWxlY3Rvcjtcbn0gPSB7fSk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgY29uc3QgZW52ID0gb3B0aW9ucy5lbnYgPz8gKChuYW1lOiBzdHJpbmcpID0+IERlbm8uZW52LmdldChuYW1lKSk7XG4gIGNvbnN0IHNldEVudiA9IG9wdGlvbnMuc2V0RW52ID8/XG4gICAgKChuYW1lOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpID0+IERlbm8uZW52LnNldChuYW1lLCB2YWx1ZSkpO1xuICBjb25zdCBkaXIgPSBvcHRpb25zLmRpciA/PyByZXNvbHZlQ3JlZGVudGlhbERpcihlbnYpO1xuICBjb25zdCBwcm92aWRlcnMgPSBvcHRpb25zLnByb3ZpZGVycyA/PyBlbmFibGVkQWdlbnRQcm92aWRlcnMoKTtcbiAgY29uc3Qgc2VsZWN0VG9rZW4gPSBvcHRpb25zLnNlbGVjdFRva2VuID8/IHNlbGVjdEZpcnN0UHJvdmlkZXJUb2tlbjtcbiAgY29uc3QgZXhwb3J0ZWQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgcHJvdmlkZXIgb2YgcHJvdmlkZXJzKSB7XG4gICAgY29uc3QgdG9rZW5zID0gYXdhaXQgZGlzY292ZXJQcm92aWRlclRva2VuRmlsZXMoZGlyLCBwcm92aWRlcik7XG4gICAgLy8gQWJzZW50IGZpbGVzIGFyZSB0aGUgcHJlZmxpZ2h0J3MgYnVzaW5lc3MsIG5vdCB0aGlzIGZ1bmN0aW9uJ3MuXG4gICAgY29uc3Qgc2VsZWN0ZWQgPSBhd2FpdCBzZWxlY3RUb2tlbih0b2tlbnMsIHByb3ZpZGVyKTtcbiAgICBpZiAoIXNlbGVjdGVkKSBjb250aW51ZTtcbiAgICBsZXQgZXhwb3J0ZWRGcm9tU2VsZWN0ZWQgPSBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHNlbGVjdGVkLmVudHJpZXMpIHtcbiAgICAgIGlmIChlbnYoZW50cnkubmFtZSkpIGNvbnRpbnVlO1xuICAgICAgc2V0RW52KGVudHJ5Lm5hbWUsIGVudHJ5LnZhbHVlKTtcbiAgICAgIGV4cG9ydGVkLnB1c2goZW50cnkubmFtZSk7XG4gICAgICBleHBvcnRlZEZyb21TZWxlY3RlZCA9IHRydWU7XG4gICAgfVxuICAgIC8vIElzc3VlICMyMDAyOiB0aGUgcnVuIGVudmlyb25tZW50IG5vdyBjYXJyaWVzIHRoaXMgZmlsZSdzIGNyZWRlbnRpYWwuXG4gICAgLy8gQSB2YXJpYWJsZSB0aGF0IHdhcyBhbHJlYWR5IGluIHRoZSBlbnZpcm9ubWVudCBjYW1lIGZyb20gZWxzZXdoZXJlLCBzb1xuICAgIC8vIGl0cyBsYWJlbCBpcyB1bmtub3duIGFuZCBub3RoaW5nIGlzIHJlY29yZGVkIGZvciBpdC5cbiAgICBpZiAoZXhwb3J0ZWRGcm9tU2VsZWN0ZWQpIHtcbiAgICAgIHJlY29yZEhlbGRQcm92aWRlckNyZWRlbnRpYWwocHJvdmlkZXIuaWQsIHNlbGVjdGVkLmxhYmVsKTtcbiAgICB9XG4gIH1cbiAgZm9yIChjb25zdCBwcm92aWRlciBvZiBwcm92aWRlcnMpIHtcbiAgICBhd2FpdCBwcm92aWRlci5jcmVkZW50aWFscy5pbml0aWFsaXNlU3RhdGU/LihcbiAgICAgIGAke2Rpcn0vJHtwcm92aWRlci5jcmVkZW50aWFscy5zdWJkaXJ9YCxcbiAgICAgIGVudixcbiAgICApO1xuICB9XG4gIHJldHVybiBleHBvcnRlZDtcbn1cblxuLyoqXG4gKiBUaGUgcHJvdmlkZXIgY3JlZGVudGlhbCBmaWxlIGluc2lkZSBhIGNyZWRlbnRpYWwgZGlyZWN0b3J5LlxuICpcbiAqIEBwYXJhbSBkaXIgLSBUaGUgY3JlZGVudGlhbCBkaXJlY3RvcnkuXG4gKiBAcGFyYW0gcHJvdmlkZXIgLSBUaGUgYWN0aXZlIHByb3ZpZGVyIGRlc2NyaXB0b3IuXG4gKiBAcmV0dXJucyBBYnNvbHV0ZSBwYXRoIHRvIHRoZSBwcm92aWRlcidzIGNyZWRlbnRpYWwgZmlsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByb3ZpZGVyQ3JlZGVudGlhbFBhdGgoXG4gIGRpcjogc3RyaW5nLFxuICBwcm92aWRlcjogQWdlbnRQcm92aWRlckRlc2NyaXB0b3IsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYCR7ZGlyfS8ke3Byb3ZpZGVyLmNyZWRlbnRpYWxzLnN1YmRpcn0vJHtwcm92aWRlci5jcmVkZW50aWFscy5maWxlfWA7XG59XG5cbi8qKiBSZXBvcnQgd2hldGhlciBhIHN0YXQgbW9kZSBncmFudHMgYW55IGdyb3VwIG9yIG90aGVyIHBlcm1pc3Npb24uICovXG5mdW5jdGlvbiBpc1Rvb09wZW4obW9kZTogbnVtYmVyIHwgbnVsbCk6IGJvb2xlYW4ge1xuICBpZiAobW9kZSA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlOyAvLyBXaW5kb3dzIOKAlCBubyBQT1NJWCBtb2RlIHRvIGVuZm9yY2UuXG4gIHJldHVybiAobW9kZSAmIDBvMDc3KSAhPT0gMDtcbn1cblxuLyoqIEZpcnN0IGVudmlyb25tZW50IHZhcmlhYmxlIGluIGBuYW1lc2Agd2l0aCBhIG5vbi1ibGFuayB2YWx1ZS4gKi9cbmZ1bmN0aW9uIGZpcnN0RW52VmFsdWUoXG4gIG5hbWVzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgZW52OiBFbnZMb29rdXAsXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgY29uc3QgdmFsdWUgPSBlbnYobmFtZSk/LnRyaW0oKTtcbiAgICBpZiAodmFsdWUpIHJldHVybiBuYW1lO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKiogUmVhZCBhIGZpbGUsIHJldHVybmluZyBudWxsIHdoZW4gaXQgaXMgYWJzZW50IG9yIHVucmVhZGFibGUuICovXG5hc3luYyBmdW5jdGlvbiByZWFkSWZQcmVzZW50KHBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShwYXRoKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLyoqIE9wdGlvbnMgZm9yIHtAbGluayBjaGVja0NyZWRlbnRpYWxQcmVmbGlnaHR9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBDcmVkZW50aWFsUHJlZmxpZ2h0T3B0aW9ucyB7XG4gIC8qKiBDcmVkZW50aWFsIGRpcmVjdG9yeSB0byBpbnNwZWN0IChkZWZhdWx0cyB0byB7QGxpbmsgcmVzb2x2ZUNyZWRlbnRpYWxEaXJ9KS4gKi9cbiAgZGlyPzogc3RyaW5nO1xuICAvKiogRW52aXJvbm1lbnQgbG9va3VwIChkZWZhdWx0cyB0byB0aGUgcHJvY2VzcyBlbnZpcm9ubWVudCkuICovXG4gIGVudj86IEVudkxvb2t1cDtcbiAgLyoqXG4gICAqIFRoZSBjb2RpbmctYWdlbnQgcHJvdmlkZXJzIGVuYWJsZWQgZm9yIHRoaXMgcnVuIChJc3N1ZSAjNDEwOCkuIERlZmF1bHRzXG4gICAqIHRvIHRoZSBjb25maWd1cmVkIGVuYWJsZWQgc2V0LCB3aGljaCBpcyB0aGUgYWN0aXZlIHByb3ZpZGVyIGFsb25lIHVubGVzc1xuICAgKiBhIGRlcGxveW1lbnQgZW5hYmxlcyBtb3JlLlxuICAgKi9cbiAgcHJvdmlkZXJzPzogcmVhZG9ubHkgQWdlbnRQcm92aWRlckRlc2NyaXB0b3JbXTtcbn1cblxuLyoqXG4gKiBBc3NlcnQgdGhlIHdvcmtlcidzIGNyZWRlbnRpYWwgbWF0ZXJpYWwgaXMgcHJlc2VudCBhbmQgdXNhYmxlLlxuICpcbiAqIENoZWNrcywgaW4gb3JkZXI6IHRoZSBkaXJlY3RvcnkgaXRzZWxmIChwcmVzZW50LCBhIGRpcmVjdG9yeSwgcmVhZGFibGUsXG4gKiBub24tZW1wdHkgYW5kIGxpbWl0ZWQgdG8gdGhlIHdvcmtlcidzIG93biBtYXRlcmlhbCksIHRoZSBHaXRIdWIgdG9rZW4sIHRoZVxuICogcHJvdmlkZXIgY3JlZGVudGlhbCwgYW5kIG93bmVyLW9ubHkgcGVybWlzc2lvbnMgb24gZXZlcnkgY3JlZGVudGlhbCBmaWxlLlxuICogQ3JlZGVudGlhbHMgc3VwcGxpZWQgdGhyb3VnaCB0aGUgZW52aXJvbm1lbnQgKHRoZSBMYXVuY2hBZ2VudCBwYXRoKSBjb3VudCBhc1xuICogdXNhYmxlIG1hdGVyaWFsLCBzbyBhIGhvc3QgdGhhdCBoYXMgbm90IHlldCBiZWVuIG1pZ3JhdGVkIHRvIHRoZSBkaXJlY3RvcnlcbiAqIHN0aWxsIHBhc3NlcyDigJQgYnV0IGEgaG9zdCB3aXRoIG5laXRoZXIgZmFpbHMgbG91ZGx5LlxuICpcbiAqIEBwYXJhbSBvcHRpb25zIC0gRGlyZWN0b3J5IGFuZCBlbnZpcm9ubWVudCBzZWFtcy5cbiAqIEByZXR1cm5zIFRoZSBuYW1lZCBmYWlsdXJlcyBmb3VuZCwgcGx1cyB3aGVyZSBlYWNoIGNyZWRlbnRpYWwgY2FtZSBmcm9tLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2hlY2tDcmVkZW50aWFsUHJlZmxpZ2h0KFxuICBvcHRpb25zOiBDcmVkZW50aWFsUHJlZmxpZ2h0T3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxDcmVkZW50aWFsUHJlZmxpZ2h0UmVzdWx0PiB7XG4gIGNvbnN0IGVudiA9IG9wdGlvbnMuZW52ID8/ICgobmFtZTogc3RyaW5nKSA9PiBEZW5vLmVudi5nZXQobmFtZSkpO1xuICBjb25zdCBkaXIgPSAob3B0aW9ucy5kaXIgPz8gcmVzb2x2ZUNyZWRlbnRpYWxEaXIoZW52KSkucmVwbGFjZSgvXFwvKyQvLCBcIlwiKTtcbiAgY29uc3QgcHJvdmlkZXJzID0gb3B0aW9ucy5wcm92aWRlcnMgPz8gZW5hYmxlZEFnZW50UHJvdmlkZXJzKHsgZW52IH0pO1xuICBjb25zdCBhbGxvd2VkRW50cmllcyA9IGFsbG93ZWRDcmVkZW50aWFsRW50cmllcyhwcm92aWRlcnMpO1xuICBjb25zdCBwcm92aXNpb25FbnZWYXJzID0gcHJvdmlkZXJzLm1hcCgocCkgPT4gcC5jcmVkZW50aWFscy5wcm92aXNpb25FbnZWYXIpXG4gICAgLmpvaW4oXCIgLyBcIik7XG4gIGNvbnN0IGZhaWx1cmVzOiBDcmVkZW50aWFsRmFpbHVyZVtdID0gW107XG5cbiAgbGV0IGdpdGh1YlNvdXJjZTogQ3JlZGVudGlhbFNvdXJjZSB8IG51bGwgPSBudWxsO1xuICBjb25zdCBwcm92aWRlclNvdXJjZXMgPSBuZXcgTWFwPHN0cmluZywgQ3JlZGVudGlhbFNvdXJjZSB8IG51bGw+KFxuICAgIHByb3ZpZGVycy5tYXAoKHByb3ZpZGVyKSA9PiBbcHJvdmlkZXIuaWQsIG51bGxdKSxcbiAgKTtcblxuICAvLyAtLS0gVGhlIGRpcmVjdG9yeSBpdHNlbGYgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBsZXQgZGlyU3RhdGU6IFwib2tcIiB8IFwibWlzc2luZ1wiIHwgXCJub3QtYS1kaXJlY3RvcnlcIiB8IFwidW5yZWFkYWJsZVwiID0gXCJva1wiO1xuICBsZXQgZW50cmllczogRGVuby5EaXJFbnRyeVtdID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgaW5mbyA9IGF3YWl0IERlbm8uc3RhdChkaXIpO1xuICAgIGlmICghaW5mby5pc0RpcmVjdG9yeSkge1xuICAgICAgZGlyU3RhdGUgPSBcIm5vdC1hLWRpcmVjdG9yeVwiO1xuICAgIH0gZWxzZSB7XG4gICAgICB0cnkge1xuICAgICAgICBlbnRyaWVzID0gYXdhaXQgQXJyYXkuZnJvbUFzeW5jKERlbm8ucmVhZERpcihkaXIpKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBkaXJTdGF0ZSA9IFwidW5yZWFkYWJsZVwiO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBkaXJTdGF0ZSA9IGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuTm90Rm91bmQgPyBcIm1pc3NpbmdcIiA6IFwidW5yZWFkYWJsZVwiO1xuICB9XG5cbiAgaWYgKGRpclN0YXRlID09PSBcIm5vdC1hLWRpcmVjdG9yeVwiKSB7XG4gICAgZmFpbHVyZXMucHVzaCh7XG4gICAgICBjb2RlOiBcImNyZWRlbnRpYWwtZGlyLW5vdC1hLWRpcmVjdG9yeVwiLFxuICAgICAgcGF0aDogZGlyLFxuICAgICAgbWVzc2FnZTpcbiAgICAgICAgYENyZWRlbnRpYWwgcGF0aCAke2Rpcn0gaXMgbm90IGEgZGlyZWN0b3J5IOKAlCByZW1vdmUgaXQgYW5kIHJlLXJ1biAuL3NldHVwLnNoIHRvIHByb3Zpc2lvbiB0aGUgY3JlZGVudGlhbCBkaXJlY3RvcnkuYCxcbiAgICB9KTtcbiAgfSBlbHNlIGlmIChkaXJTdGF0ZSA9PT0gXCJ1bnJlYWRhYmxlXCIpIHtcbiAgICBmYWlsdXJlcy5wdXNoKHtcbiAgICAgIGNvZGU6IFwiY3JlZGVudGlhbC1kaXItdW5yZWFkYWJsZVwiLFxuICAgICAgcGF0aDogZGlyLFxuICAgICAgbWVzc2FnZTpcbiAgICAgICAgYENyZWRlbnRpYWwgZGlyZWN0b3J5ICR7ZGlyfSBpcyBub3QgcmVhZGFibGUgYnkgdGhlIHdvcmtlciDigJQgZml4IGl0cyBvd25lcnNoaXAgYW5kIHJ1bjogY2htb2QgNzAwICR7ZGlyfWAsXG4gICAgfSk7XG4gIH1cblxuICBpZiAoZGlyU3RhdGUgPT09IFwib2tcIikge1xuICAgIGNvbnN0IG1lYW5pbmdmdWwgPSBlbnRyaWVzLmZpbHRlcigoZSkgPT4gIUlHTk9SRURfRU5UUklFUy5pbmNsdWRlcyhlLm5hbWUpKTtcbiAgICBpZiAobWVhbmluZ2Z1bC5sZW5ndGggPT09IDApIHtcbiAgICAgIGZhaWx1cmVzLnB1c2goe1xuICAgICAgICBjb2RlOiBcImNyZWRlbnRpYWwtZGlyLWVtcHR5XCIsXG4gICAgICAgIHBhdGg6IGRpcixcbiAgICAgICAgbWVzc2FnZTpcbiAgICAgICAgICBgQ3JlZGVudGlhbCBkaXJlY3RvcnkgJHtkaXJ9IGlzIGVtcHR5IOKAlCByZS1ydW4gLi9zZXR1cC5zaCB3aXRoIFZJQkVfTEFVTkNIQUdFTlRfR0hfVE9LRU4gYW5kICR7cHJvdmlzaW9uRW52VmFyc30gc2V0IHRvIHByb3Zpc2lvbiBpdC5gLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgbWVhbmluZ2Z1bCkge1xuICAgICAgaWYgKGFsbG93ZWRFbnRyaWVzLmluY2x1ZGVzKGVudHJ5Lm5hbWUpKSBjb250aW51ZTtcbiAgICAgIGZhaWx1cmVzLnB1c2goe1xuICAgICAgICBjb2RlOiBcInVuZXhwZWN0ZWQtY3JlZGVudGlhbC1tYXRlcmlhbFwiLFxuICAgICAgICBwYXRoOiBgJHtkaXJ9LyR7ZW50cnkubmFtZX1gLFxuICAgICAgICBtZXNzYWdlOlxuICAgICAgICAgIGBVbmV4cGVjdGVkIGVudHJ5ICR7ZGlyfS8ke2VudHJ5Lm5hbWV9IOKAlCB0aGUgY3JlZGVudGlhbCBkaXJlY3RvcnkgbXVzdCBob2xkIG9ubHkgJHtcbiAgICAgICAgICAgIGFsbG93ZWRFbnRyaWVzLmpvaW4oXCIvXCIpXG4gICAgICAgICAgfTsgbW92ZSBhbnl0aGluZyBlbHNlIG91dCBvZiBpdC5gLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gLS0tIEdpdEh1YiBtYXRlcmlhbCAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgY29uc3QgaG9zdHNQYXRoID0gYCR7ZGlyfS8ke0dIX0NSRURFTlRJQUxfU1VCRElSfS8ke0dIX0hPU1RTX0ZJTEV9YDtcbiAgICBjb25zdCBob3N0cyA9IGF3YWl0IHJlYWRJZlByZXNlbnQoaG9zdHNQYXRoKTtcbiAgICBpZiAoaG9zdHMgIT09IG51bGwgJiYgZXh0cmFjdEdoVG9rZW4oaG9zdHMpKSB7XG4gICAgICBnaXRodWJTb3VyY2UgPSBcImRpcmVjdG9yeVwiO1xuICAgICAgZmFpbHVyZXMucHVzaCguLi4oYXdhaXQgcGVybWlzc2lvbkZhaWx1cmVzKGhvc3RzUGF0aCkpKTtcbiAgICB9XG5cbiAgICAvLyAtLS0gUHJvdmlkZXIgbWF0ZXJpYWwsIG9uZSBlbmFibGVkIHByb3ZpZGVyIGF0IGEgdGltZSAtLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gRXZlcnkgZGlzY292ZXJlZCB0b2tlbiBmaWxlIGlzIHBlcm1pc3Npb24tY2hlY2tlZCwgbm90IGp1c3QgdGhlIHByaW1hcnlcbiAgICAvLyBvbmUgKElzc3VlICM5MTcpOiB0aGUgdW5leHBlY3RlZC1tYXRlcmlhbCBjaGVjayBhYm92ZSBzZWVzIG9ubHkgdGhlIFRPUFxuICAgIC8vIGxldmVsIG9mIHRoZSBjcmVkZW50aWFsIGRpcmVjdG9yeSwgc28gYW4gYWRkZWQgcHJvdmlkZXItMi5lbnYgaW5zaWRlIGFcbiAgICAvLyBwcm92aWRlcidzIG93biBzdWItZGlyZWN0b3J5IGF0IG1vZGUgMDY0NCB3b3VsZCBvdGhlcndpc2UgcGFzcyB0aGVcbiAgICAvLyBwcmVmbGlnaHQgZW50aXJlbHkgdW5leGFtaW5lZC5cbiAgICBmb3IgKGNvbnN0IHByb3ZpZGVyIG9mIHByb3ZpZGVycykge1xuICAgICAgZm9yIChjb25zdCB0b2tlbiBvZiBhd2FpdCBkaXNjb3ZlclByb3ZpZGVyVG9rZW5GaWxlcyhkaXIsIHByb3ZpZGVyKSkge1xuICAgICAgICBpZiAodG9rZW4ubmFtZSAhPT0gbnVsbCkge1xuICAgICAgICAgIHByb3ZpZGVyU291cmNlcy5zZXQocHJvdmlkZXIuaWQsIFwiZGlyZWN0b3J5XCIpO1xuICAgICAgICAgIGZhaWx1cmVzLnB1c2goLi4uKGF3YWl0IHBlcm1pc3Npb25GYWlsdXJlcyh0b2tlbi5wYXRoKSkpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIC8vIEEgcG9vbCBmaWxlIHRoYXQgcGFyc2VzIHRvIG5vdGhpbmcgaXMgYSB0eXBvIGFuIG9wZXJhdG9yIG1hZGUgYnlcbiAgICAgICAgLy8gaGFuZCBhbmQgbXVzdCBoZWFyIGFib3V0LiBUaGUgcHJpbWFyeSBmaWxlIGtlZXBzIGl0cyBsb25nLXN0YW5kaW5nXG4gICAgICAgIC8vIHBhdGg6IGl0cyBlbXB0aW5lc3MgaXMgYWxyZWFkeSByZXBvcnRlZCBhc1xuICAgICAgICAvLyBwcm92aWRlci1jcmVkZW50aWFscy1taXNzaW5nLCBzbyBzYXlpbmcgaXQgdHdpY2Ugd291bGQgY2hhbmdlIHdoYXRcbiAgICAgICAgLy8gYSBzaW5nbGUtdG9rZW4gaG9zdCBzZWVzLlxuICAgICAgICBpZiAodG9rZW4ucHJpbWFyeSkgY29udGludWU7XG4gICAgICAgIGZhaWx1cmVzLnB1c2goLi4uKGF3YWl0IHBlcm1pc3Npb25GYWlsdXJlcyh0b2tlbi5wYXRoKSkpO1xuICAgICAgICBmYWlsdXJlcy5wdXNoKHtcbiAgICAgICAgICBjb2RlOiBcInByb3ZpZGVyLXRva2VuLWZpbGUtdW5yZWNvZ25pc2VkXCIsXG4gICAgICAgICAgcGF0aDogdG9rZW4ucGF0aCxcbiAgICAgICAgICBwcm92aWRlcjogcHJvdmlkZXIuaWQsXG4gICAgICAgICAgbWVzc2FnZTpcbiAgICAgICAgICAgIGBUb2tlbiBmaWxlICR7dG9rZW4ucGF0aH0gaG9sZHMgbm8gY3JlZGVudGlhbCAke3Byb3ZpZGVyLmRpc3BsYXlOYW1lfSByZWNvZ25pc2VzIOKAlCBpdCBtdXN0IHNldCBvbmUgb2YgJHtcbiAgICAgICAgICAgICAgcnVudGltZUNyZWRlbnRpYWxFbnZWYXJzKHByb3ZpZGVyKS5qb2luKFwiL1wiKVxuICAgICAgICAgICAgfS4gRml4IHRoZSB2YXJpYWJsZSBuYW1lIG9yIHJlbW92ZSB0aGUgZmlsZS5gLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyAtLS0gRW52aXJvbm1lbnQgZmFsbGJhY2tzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBpZiAoZ2l0aHViU291cmNlID09PSBudWxsICYmIGZpcnN0RW52VmFsdWUoR0lUSFVCX0NSRURFTlRJQUxfRU5WX1ZBUlMsIGVudikpIHtcbiAgICBnaXRodWJTb3VyY2UgPSBcImVudmlyb25tZW50XCI7XG4gIH1cbiAgZm9yIChjb25zdCBwcm92aWRlciBvZiBwcm92aWRlcnMpIHtcbiAgICBpZiAoXG4gICAgICBwcm92aWRlclNvdXJjZXMuZ2V0KHByb3ZpZGVyLmlkKSA9PT0gbnVsbCAmJlxuICAgICAgZmlyc3RFbnZWYWx1ZShydW50aW1lQ3JlZGVudGlhbEVudlZhcnMocHJvdmlkZXIpLCBlbnYpXG4gICAgKSB7XG4gICAgICBwcm92aWRlclNvdXJjZXMuc2V0KHByb3ZpZGVyLmlkLCBcImVudmlyb25tZW50XCIpO1xuICAgIH1cbiAgfVxuXG4gIGlmIChnaXRodWJTb3VyY2UgPT09IG51bGwpIHtcbiAgICBmYWlsdXJlcy5wdXNoKHtcbiAgICAgIGNvZGU6IFwiZ2l0aHViLWNyZWRlbnRpYWxzLW1pc3NpbmdcIixcbiAgICAgIHBhdGg6IGAke2Rpcn0vJHtHSF9DUkVERU5USUFMX1NVQkRJUn0vJHtHSF9IT1NUU19GSUxFfWAsXG4gICAgICBtZXNzYWdlOlxuICAgICAgICBgTm8gdXNhYmxlIEdpdEh1YiBjcmVkZW50aWFsOiAke2Rpcn0vJHtHSF9DUkVERU5USUFMX1NVQkRJUn0vJHtHSF9IT1NUU19GSUxFfSBob2xkcyBubyB0b2tlbiBhbmQgbm9uZSBvZiAke1xuICAgICAgICAgIEdJVEhVQl9DUkVERU5USUFMX0VOVl9WQVJTLmpvaW4oXCIvXCIpXG4gICAgICAgIH0gaXMgc2V0LiBSZS1ydW4gLi9zZXR1cC5zaCB3aXRoIFZJQkVfTEFVTkNIQUdFTlRfR0hfVE9LRU4gc2V0IOKAlCB0aGUgd29ya2VyIG5ldmVyIHBlcmZvcm1zIGFuIGludGVyYWN0aXZlIGxvZ2luLmAsXG4gICAgfSk7XG4gIH1cbiAgLy8gRWFjaCBlbmFibGVkIHByb3ZpZGVyIHJlcG9ydHMgaXRzIG93biBtaXNzaW5nIGNyZWRlbnRpYWwsIG5hbWluZyB0aGVcbiAgLy8gcHJvdmlkZXIgYW5kIHRoZSB2YXJpYWJsZSB0aGF0IHByb3Zpc2lvbnMgaXQgKElzc3VlICM0MTA4KS5cbiAgZm9yIChjb25zdCBwcm92aWRlciBvZiBwcm92aWRlcnMpIHtcbiAgICBpZiAocHJvdmlkZXJTb3VyY2VzLmdldChwcm92aWRlci5pZCkgIT09IG51bGwpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHBhdGggPSBwcm92aWRlckNyZWRlbnRpYWxQYXRoKGRpciwgcHJvdmlkZXIpO1xuICAgIGZhaWx1cmVzLnB1c2goe1xuICAgICAgY29kZTogXCJwcm92aWRlci1jcmVkZW50aWFscy1taXNzaW5nXCIsXG4gICAgICBwYXRoLFxuICAgICAgcHJvdmlkZXI6IHByb3ZpZGVyLmlkLFxuICAgICAgbWVzc2FnZTpcbiAgICAgICAgYENvZGluZy1hZ2VudCBwcm92aWRlciBhdXRoZW50aWNhdGlvbiByZXF1aXJlZCBmb3IgJHtwcm92aWRlci5kaXNwbGF5TmFtZX0gKCR7cHJvdmlkZXIuaWR9KTogJHtwYXRofSBob2xkcyBubyBjcmVkZW50aWFsIGFuZCBub25lIG9mICR7XG4gICAgICAgICAgcnVudGltZUNyZWRlbnRpYWxFbnZWYXJzKHByb3ZpZGVyKS5qb2luKFwiL1wiKVxuICAgICAgICB9IGlzIHNldC4gUmUtcnVuIC4vc2V0dXAuc2ggd2l0aCAke3Byb3ZpZGVyLmNyZWRlbnRpYWxzLnByb3Zpc2lvbkVudlZhcn0gc2V0IOKAlCB0aGUgd29ya2VyIG5ldmVyIHBlcmZvcm1zIGFuIGludGVyYWN0aXZlIGxvZ2luLmAsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCBldmVyeVByb3ZpZGVyRnJvbUVudmlyb25tZW50ID0gcHJvdmlkZXJzLmV2ZXJ5KFxuICAgIChwcm92aWRlcikgPT4gcHJvdmlkZXJTb3VyY2VzLmdldChwcm92aWRlci5pZCkgPT09IFwiZW52aXJvbm1lbnRcIixcbiAgKTtcblxuICAvLyBUaGUgZGlyZWN0b3J5IG9ubHkgbWF0dGVycyB3aGVuIGl0IHdhcyBtZWFudCB0byBzdXBwbHkgd2hhdCBpcyBtaXNzaW5nLlxuICBpZiAoXG4gICAgZGlyU3RhdGUgPT09IFwibWlzc2luZ1wiICYmXG4gICAgKGdpdGh1YlNvdXJjZSAhPT0gXCJlbnZpcm9ubWVudFwiIHx8ICFldmVyeVByb3ZpZGVyRnJvbUVudmlyb25tZW50KVxuICApIHtcbiAgICBmYWlsdXJlcy51bnNoaWZ0KHtcbiAgICAgIGNvZGU6IFwiY3JlZGVudGlhbC1kaXItbWlzc2luZ1wiLFxuICAgICAgcGF0aDogZGlyLFxuICAgICAgbWVzc2FnZTpcbiAgICAgICAgYENyZWRlbnRpYWwgZGlyZWN0b3J5ICR7ZGlyfSBkb2VzIG5vdCBleGlzdCDigJQgcnVuIC4vc2V0dXAuc2ggd2l0aCBWSUJFX0xBVU5DSEFHRU5UX0dIX1RPS0VOIGFuZCAke3Byb3Zpc2lvbkVudlZhcnN9IHNldCB0byBwcm92aXNpb24gaXQgbm9uLWludGVyYWN0aXZlbHkuYCxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgb2s6IGZhaWx1cmVzLmxlbmd0aCA9PT0gMCxcbiAgICBkaXIsXG4gICAgZ2l0aHViU291cmNlLFxuICAgIHByb3ZpZGVyU291cmNlOiBwcm92aWRlclNvdXJjZXMuZ2V0KHByb3ZpZGVyc1swXT8uaWQgPz8gXCJcIikgPz8gbnVsbCxcbiAgICBwcm92aWRlcnM6IHByb3ZpZGVycy5tYXAoKHByb3ZpZGVyKSA9PiAoe1xuICAgICAgaWQ6IHByb3ZpZGVyLmlkLFxuICAgICAgZGlzcGxheU5hbWU6IHByb3ZpZGVyLmRpc3BsYXlOYW1lLFxuICAgICAgc291cmNlOiBwcm92aWRlclNvdXJjZXMuZ2V0KHByb3ZpZGVyLmlkKSA/PyBudWxsLFxuICAgIH0pKSxcbiAgICBmYWlsdXJlcyxcbiAgfTtcbn1cblxuLyoqIE93bmVyLW9ubHkgcGVybWlzc2lvbiBjaGVjayBmb3Igb25lIGNyZWRlbnRpYWwgZmlsZS4gKi9cbmFzeW5jIGZ1bmN0aW9uIHBlcm1pc3Npb25GYWlsdXJlcyhwYXRoOiBzdHJpbmcpOiBQcm9taXNlPENyZWRlbnRpYWxGYWlsdXJlW10+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBpbmZvID0gYXdhaXQgRGVuby5zdGF0KHBhdGgpO1xuICAgIGlmICghaXNUb29PcGVuKGluZm8ubW9kZSA/PyBudWxsKSkgcmV0dXJuIFtdO1xuICAgIGNvbnN0IG1vZGUgPSAoaW5mby5tb2RlID8/IDApICYgMG83Nzc7XG4gICAgcmV0dXJuIFt7XG4gICAgICBjb2RlOiBcImNyZWRlbnRpYWwtcGVybWlzc2lvbnMtdG9vLW9wZW5cIixcbiAgICAgIHBhdGgsXG4gICAgICBtZXNzYWdlOiBgQ3JlZGVudGlhbCBmaWxlICR7cGF0aH0gaXMgbW9kZSAke1xuICAgICAgICBtb2RlLnRvU3RyaW5nKDgpLnBhZFN0YXJ0KDMsIFwiMFwiKVxuICAgICAgfSDigJQgaXQgbXVzdCBiZSBvd25lci1vbmx5LiBSdW46IGNobW9kIDYwMCAke3BhdGh9YCxcbiAgICB9XTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbi8qKlxuICogQ2xhc3NpZnkgYSBmYWlsdXJlIGFnYWluc3QgdGhlIHJ1bnRpbWUgYXV0aCBwcmVkaWNhdGVzIHNvIHRoZSBwcmVmbGlnaHQgYW5kXG4gKiB0aGUgbWlkLXJ1biBhdXRoIHN1cmZhY2VzIGFncmVlIG9uIHdoYXQgYW4gYXV0aCBmYWlsdXJlIGlzLlxuICpcbiAqIEBwYXJhbSBmYWlsdXJlIC0gVGhlIGZhaWx1cmUgdG8gY2xhc3NpZnkuXG4gKiBAcGFyYW0gcHJvdmlkZXIgLSBUaGUgcHJvdmlkZXIgdG8gY2xhc3NpZnkgYWdhaW5zdC4gRGVmYXVsdHMgdG8gdGhlIG9uZSB0aGVcbiAqICAgZmFpbHVyZSBuYW1lcyAoSXNzdWUgIzQxMDgpLCBvciB0aGUgYWN0aXZlIHByb3ZpZGVyIHdoZW4gaXQgbmFtZXMgbm9uZS5cbiAqIEByZXR1cm5zIGBwcm92aWRlci1hdXRoYCwgYGdpdGh1Yi1hdXRoYCwgb3IgYGNyZWRlbnRpYWwtbWF0ZXJpYWxgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xhc3NpZnlDcmVkZW50aWFsRmFpbHVyZShcbiAgZmFpbHVyZTogQ3JlZGVudGlhbEZhaWx1cmUsXG4gIHByb3ZpZGVyOiBBZ2VudFByb3ZpZGVyRGVzY3JpcHRvciA9IGZhaWx1cmUucHJvdmlkZXJcbiAgICA/IHJlc29sdmVBZ2VudFByb3ZpZGVyKGZhaWx1cmUucHJvdmlkZXIpXG4gICAgOiBhY3RpdmVBZ2VudFByb3ZpZGVyKCksXG4pOiBcInByb3ZpZGVyLWF1dGhcIiB8IFwiZ2l0aHViLWF1dGhcIiB8IFwiY3JlZGVudGlhbC1tYXRlcmlhbFwiIHtcbiAgaWYgKFxuICAgIGZhaWx1cmUuY29kZSA9PT0gXCJwcm92aWRlci1jcmVkZW50aWFscy1taXNzaW5nXCIgJiZcbiAgICBwcm92aWRlci5pc0F1dGhFcnJvcihmYWlsdXJlLm1lc3NhZ2UpXG4gICkge1xuICAgIHJldHVybiBcInByb3ZpZGVyLWF1dGhcIjtcbiAgfVxuICBpZiAoXG4gICAgZmFpbHVyZS5jb2RlID09PSBcImdpdGh1Yi1jcmVkZW50aWFscy1taXNzaW5nXCIgJiZcbiAgICBpc0doQXV0aEVycm9yKGZhaWx1cmUubWVzc2FnZSlcbiAgKSB7XG4gICAgcmV0dXJuIFwiZ2l0aHViLWF1dGhcIjtcbiAgfVxuICByZXR1cm4gXCJjcmVkZW50aWFsLW1hdGVyaWFsXCI7XG59XG5cbi8qKlxuICogUmVuZGVyIGEgc2luZ2xlIG9wZXJhdG9yLWZhY2luZyBtZXNzYWdlIGZvciBhIHByZWZsaWdodCByZXN1bHQg4oCUIHRoZSB0ZXh0XG4gKiB0aGUgd29ya2VyIGxvZ3MgYW5kIGVzY2FsYXRlcyB0byBHaXRIdWIgd2l0aC5cbiAqXG4gKiBAcGFyYW0gcmVzdWx0IC0gVGhlIHByZWZsaWdodCBvdXRjb21lLlxuICogQHJldHVybnMgQSBvbmUtb3ItbW9yZS1saW5lIHN1bW1hcnkgbmFtaW5nIGV2ZXJ5IGZhaWx1cmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVkZW50aWFsUHJlZmxpZ2h0TWVzc2FnZShcbiAgcmVzdWx0OiBDcmVkZW50aWFsUHJlZmxpZ2h0UmVzdWx0LFxuKTogc3RyaW5nIHtcbiAgaWYgKHJlc3VsdC5vaykge1xuICAgIGNvbnN0IHBlclByb3ZpZGVyID0gcmVzdWx0LnByb3ZpZGVyc1xuICAgICAgLm1hcCgocHJvdmlkZXIpID0+IGAke3Byb3ZpZGVyLmlkfT0ke3Byb3ZpZGVyLnNvdXJjZSA/PyBcIm5vbmVcIn1gKVxuICAgICAgLmpvaW4oXCIsIFwiKTtcbiAgICByZXR1cm4gYENyZWRlbnRpYWwgcHJlZmxpZ2h0IHBhc3NlZCBmb3IgJHtyZXN1bHQuZGlyfSAoZ2l0aHViPSR7XG4gICAgICByZXN1bHQuZ2l0aHViU291cmNlID8/IFwibm9uZVwiXG4gICAgfSwgcHJvdmlkZXI9JHtyZXN1bHQucHJvdmlkZXJTb3VyY2UgPz8gXCJub25lXCJ9LCAke3BlclByb3ZpZGVyfSlgO1xuICB9XG4gIGNvbnN0IGxpbmVzID0gcmVzdWx0LmZhaWx1cmVzLm1hcCgoZikgPT4gYCAgLSBbJHtmLmNvZGV9XSAke2YubWVzc2FnZX1gKTtcbiAgcmV0dXJuIFtcbiAgICBgQ3JlZGVudGlhbCBwcmVmbGlnaHQgZmFpbGVkIGZvciAke3Jlc3VsdC5kaXJ9IOKAlCAke3Jlc3VsdC5mYWlsdXJlcy5sZW5ndGh9IHByb2JsZW0ocyk6YCxcbiAgICAuLi5saW5lcyxcbiAgXS5qb2luKFwiXFxuXCIpO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FvQ0MsR0FHRCxTQUNFLG1CQUFtQixFQUVuQixxQkFBcUIsRUFDckIsb0JBQW9CLFFBQ2Ysc0JBQXNCO0FBQzdCLFNBQVMsYUFBYSxRQUFRLGVBQWU7QUFFN0MsMkVBQTJFLEdBQzNFLE9BQU8sTUFBTSxxQkFBcUIsc0JBQXNCO0FBRXhELDJFQUEyRSxHQUMzRSxPQUFPLE1BQU0sZ0NBQWdDLDBCQUEwQjtBQUV2RSwwRUFBMEUsR0FDMUUsT0FBTyxNQUFNLHVCQUF1QixLQUFLO0FBRXpDOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxNQUFNLDJCQUEyQixxQkFBcUI7QUFFN0Q7Ozs7Ozs7O0NBUUMsR0FDRCxPQUFPLE1BQU0sa0JBQWtCLG1CQUFtQjtBQUVsRCxxRUFBcUUsR0FDckUsT0FBTyxNQUFNLGdCQUFnQixZQUFZO0FBRXpDOzs7Ozs7Ozs7Q0FTQyxHQUNELE9BQU8sU0FBUyx5QkFDZCxTQUE2QztFQUU3QyxPQUFPO0lBQ0w7T0FDRyxVQUFVLEdBQUcsQ0FBQyxDQUFDLFdBQWEsU0FBUyxXQUFXLENBQUMsTUFBTTtHQUMzRDtBQUNIO0FBRUEsd0VBQXdFLEdBQ3hFLE1BQU0sa0JBQXFDO0VBQUM7Q0FBWTtBQUV4RCw0REFBNEQsR0FDNUQsT0FBTyxNQUFNLDZCQUFnRDtFQUMzRDtFQUNBO0NBQ0QsQ0FBQztBQW1FRjs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sU0FBUyxxQkFDZCxNQUFpQixDQUFDLE9BQVMsS0FBSyxHQUFHLENBQUMsR0FBRyxDQUFDLEtBQUs7RUFFN0MsTUFBTSxXQUFXLElBQUkscUJBQXFCO0VBQzFDLElBQUksVUFBVSxPQUFPLFNBQVMsT0FBTyxDQUFDLFFBQVE7RUFDOUMsTUFBTSxPQUFPLElBQUksV0FBVyxJQUFJLGtCQUFrQjtFQUNsRCxPQUFPLEdBQUcsS0FBSyxDQUFDLEVBQUUsK0JBQStCO0FBQ25EO0FBRUE7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVMsZUFBZSxJQUFZO0VBQ3pDLElBQUksQ0FBQyxNQUFNLE9BQU87RUFDbEIsTUFBTSxRQUFRLEtBQUssS0FBSyxDQUFDO0VBQ3pCLE1BQU0sTUFBTSxPQUFPLENBQUMsRUFBRSxFQUFFO0VBQ3hCLElBQUksQ0FBQyxLQUFLLE9BQU87RUFDakIsTUFBTSxXQUFXLElBQUksT0FBTyxDQUFDLGdCQUFnQixJQUFJLElBQUk7RUFDckQsT0FBTyxTQUFTLE1BQU0sR0FBRyxJQUFJLFdBQVc7QUFDMUM7QUFFQSw0RUFBNEUsR0FDNUUsU0FBUyx5QkFDUCxRQUFpQztFQUVqQyxPQUFPO09BQ0YsU0FBUyxXQUFXLENBQUMsT0FBTztPQUMzQixTQUFTLFdBQVcsQ0FBQyxZQUFZLElBQUksRUFBRTtHQUM1QztBQUNIO0FBRUE7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sU0FBUyx5QkFDZCxPQUFlLEVBQ2YsVUFBNkIseUJBQXlCLHNCQUFzQjtFQUU1RSxPQUFPLCtCQUErQixTQUFTLFFBQVEsQ0FBQyxFQUFFLEVBQUUsUUFBUTtBQUN0RTtBQVFBOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUywrQkFDZCxPQUFlLEVBQ2YsT0FBMEI7RUFFMUIsSUFBSSxDQUFDLFNBQVMsT0FBTyxFQUFFO0VBQ3ZCLE1BQU0sVUFBcUMsRUFBRTtFQUM3QyxLQUFLLE1BQU0sUUFBUSxRQUFRLEtBQUssQ0FBQyxNQUFPO0lBQ3RDLE1BQU0sT0FBTyxLQUFLLElBQUk7SUFDdEIsSUFBSSxDQUFDLFFBQVEsS0FBSyxVQUFVLENBQUMsTUFBTTtJQUNuQyxNQUFNLFFBQVEsS0FBSyxLQUFLLENBQUM7SUFDekIsTUFBTSxPQUFPLE9BQU8sQ0FBQyxFQUFFO0lBQ3ZCLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxRQUFRLENBQUMsT0FBTztJQUN0QyxNQUFNLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxJQUFJLEVBQUUsRUFBRSxJQUFJLEdBQUcsT0FBTyxDQUFDLGdCQUFnQixJQUFJLElBQUk7SUFDeEUsSUFBSSxNQUFNLE1BQU0sR0FBRyxHQUFHLFFBQVEsSUFBSSxDQUFDO01BQUU7TUFBTTtJQUFNO0VBQ25EO0VBQ0EsT0FBTztBQUNUO0FBdUNBLG1FQUFtRSxHQUNuRSxTQUFTLFNBQVMsSUFBWTtFQUM1QixPQUFPLEtBQUssT0FBTyxDQUFDLFlBQVk7QUFDbEM7QUFFQSxzREFBc0QsR0FDdEQsU0FBUyxnQkFDUCxJQUFZLEVBQ1osUUFBZ0IsRUFDaEIsT0FBZSxFQUNmLFFBQWlDLEVBQ2pDLE9BQWdCO0VBRWhCLE1BQU0sVUFBVSwrQkFDZCxTQUNBLHlCQUF5QjtFQUUzQixNQUFNLFFBQVEsT0FBTyxDQUFDLEVBQUUsSUFBSTtFQUM1QixNQUFNLE9BQU8sU0FBUyxXQUFXLENBQUMsU0FBUztFQUMzQyxPQUFPO0lBQ0wsT0FBTyxTQUFTO0lBQ2hCO0lBQ0EsTUFBTSxPQUFPLFFBQVE7SUFDckIsT0FBTyxPQUFPLFNBQVM7SUFDdkI7SUFDQSxZQUFZLFVBQVUsUUFBUSxDQUFDLE1BQU0sUUFBUSxTQUFTLE1BQU0sSUFBSSxLQUFLLEtBQUs7SUFDMUU7RUFDRjtBQUNGO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0JDLEdBQ0QsT0FBTyxlQUFlLDJCQUNwQixHQUFXLEVBQ1gsUUFBaUM7RUFFakMsTUFBTSxTQUE4QixFQUFFO0VBQ3RDLE1BQU0sY0FBYyx1QkFBdUIsS0FBSztFQUNoRCxNQUFNLFVBQVUsTUFBTSxjQUFjO0VBQ3BDLElBQUksWUFBWSxNQUFNO0lBQ3BCLE9BQU8sSUFBSSxDQUNULGdCQUNFLGFBQ0EsU0FBUyxXQUFXLENBQUMsSUFBSSxFQUN6QixTQUNBLFVBQ0E7RUFHTjtFQUVBLE1BQU0sT0FBTyxTQUFTLFdBQVcsQ0FBQyxTQUFTO0VBQzNDLElBQUksQ0FBQyxNQUFNLE9BQU87RUFFbEIsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLEVBQUUsU0FBUyxXQUFXLENBQUMsTUFBTSxFQUFFO0VBQ3RELElBQUksVUFBMkIsRUFBRTtFQUNqQyxJQUFJO0lBQ0YsVUFBVSxNQUFNLE1BQU0sU0FBUyxDQUFDLEtBQUssT0FBTyxDQUFDO0VBQy9DLEVBQUUsT0FBTTtJQUNOLE9BQU8sUUFBUSwyREFBMkQ7RUFDNUU7RUFFQSxNQUFNLFNBQThDLEVBQUU7RUFDdEQsS0FBSyxNQUFNLFNBQVMsUUFBUztJQUMzQixJQUFJLE1BQU0sV0FBVyxFQUFFO0lBQ3ZCLE1BQU0sVUFBVSxPQUFPLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLFNBQVMsR0FBRyxDQUFDLEVBQUU7SUFDNUQsSUFBSSxDQUFDLE9BQU8sUUFBUSxDQUFDLFVBQVU7SUFDL0IsT0FBTyxJQUFJLENBQUM7TUFBRTtNQUFTLE1BQU0sTUFBTSxJQUFJO0lBQUM7RUFDMUM7RUFDQSxPQUFPLElBQUksQ0FBQyxDQUFDLEdBQUcsSUFBTSxFQUFFLE9BQU8sR0FBRyxFQUFFLE9BQU8sSUFBSSxFQUFFLElBQUksQ0FBQyxhQUFhLENBQUMsRUFBRSxJQUFJO0VBRTFFLEtBQUssTUFBTSxTQUFTLE9BQVE7SUFDMUIsTUFBTSxPQUFPLEdBQUcsT0FBTyxDQUFDLEVBQUUsTUFBTSxJQUFJLEVBQUU7SUFDdEMsTUFBTSxVQUFVLE1BQU0sY0FBYztJQUNwQyxJQUFJLFlBQVksTUFBTTtJQUN0QixPQUFPLElBQUksQ0FBQyxnQkFBZ0IsTUFBTSxNQUFNLElBQUksRUFBRSxTQUFTLFVBQVU7RUFDbkU7RUFDQSxPQUFPO0FBQ1Q7QUFjQTs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sTUFBTSwyQkFBa0QsQ0FBQyxTQUM5RCxPQUFPLElBQUksQ0FBQyxDQUFDLFFBQVUsTUFBTSxJQUFJLEtBQUssU0FBUyxLQUFLO0FBRXREOzs7Ozs7Ozs7OztDQVdDLEdBQ0QsT0FBTyxTQUFTLHVCQUNkLE1BQW9DO0VBRXBDLE9BQU8sT0FBTyxNQUFNLENBQ2xCLENBQUMsUUFBVSxNQUFNLFVBQVUsSUFBSSxDQUFDLE1BQU0sS0FBSyxJQUFJLEVBQUUsRUFBRSxJQUFJLEdBQUcsTUFBTSxHQUFHO0FBRXZFO0FBRUEsOEVBQThFO0FBQzlFLDZDQUE2QztBQUM3Qyw4RUFBOEU7QUFFOUU7Ozs7Ozs7Ozs7O0NBV0MsR0FDRCxNQUFNLDBCQUEwQixJQUFJO0FBRXBDLDJFQUEyRSxHQUMzRSxPQUFPLFNBQVMsNkJBQ2QsVUFBa0IsRUFDbEIsS0FBYTtFQUViLE1BQU0sTUFBTSxXQUFXLElBQUk7RUFDM0IsTUFBTSxRQUFRLE1BQU0sSUFBSTtFQUN4QixJQUFJLElBQUksTUFBTSxLQUFLLEtBQUssTUFBTSxNQUFNLEtBQUssR0FBRztFQUM1Qyx3QkFBd0IsR0FBRyxDQUFDLEtBQUs7QUFDbkM7QUFFQTs7OztDQUlDLEdBQ0QsT0FBTyxTQUFTLDRCQUNkLFVBQWtCO0VBRWxCLE9BQU8sd0JBQXdCLEdBQUcsQ0FBQyxXQUFXLElBQUk7QUFDcEQ7QUFFQSx5RUFBeUUsR0FDekUsT0FBTyxTQUFTO0VBQ2Qsd0JBQXdCLEtBQUs7QUFDL0I7QUFFQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXlCQyxHQUNELE9BQU8sZUFBZSwyQkFBMkIsVUFNN0MsQ0FBQyxDQUFDO0VBQ0osTUFBTSxNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsQ0FBQyxPQUFpQixLQUFLLEdBQUcsQ0FBQyxHQUFHLENBQUMsS0FBSztFQUNoRSxNQUFNLFNBQVMsUUFBUSxNQUFNLElBQzNCLENBQUMsQ0FBQyxNQUFjLFFBQWtCLEtBQUssR0FBRyxDQUFDLEdBQUcsQ0FBQyxNQUFNLE1BQU07RUFDN0QsTUFBTSxNQUFNLFFBQVEsR0FBRyxJQUFJLHFCQUFxQjtFQUNoRCxNQUFNLFlBQVksUUFBUSxTQUFTLElBQUk7RUFDdkMsTUFBTSxjQUFjLFFBQVEsV0FBVyxJQUFJO0VBQzNDLE1BQU0sV0FBcUIsRUFBRTtFQUM3QixLQUFLLE1BQU0sWUFBWSxVQUFXO0lBQ2hDLE1BQU0sU0FBUyxNQUFNLDJCQUEyQixLQUFLO0lBQ3JELGtFQUFrRTtJQUNsRSxNQUFNLFdBQVcsTUFBTSxZQUFZLFFBQVE7SUFDM0MsSUFBSSxDQUFDLFVBQVU7SUFDZixJQUFJLHVCQUF1QjtJQUMzQixLQUFLLE1BQU0sU0FBUyxTQUFTLE9BQU8sQ0FBRTtNQUNwQyxJQUFJLElBQUksTUFBTSxJQUFJLEdBQUc7TUFDckIsT0FBTyxNQUFNLElBQUksRUFBRSxNQUFNLEtBQUs7TUFDOUIsU0FBUyxJQUFJLENBQUMsTUFBTSxJQUFJO01BQ3hCLHVCQUF1QjtJQUN6QjtJQUNBLHVFQUF1RTtJQUN2RSx5RUFBeUU7SUFDekUsdURBQXVEO0lBQ3ZELElBQUksc0JBQXNCO01BQ3hCLDZCQUE2QixTQUFTLEVBQUUsRUFBRSxTQUFTLEtBQUs7SUFDMUQ7RUFDRjtFQUNBLEtBQUssTUFBTSxZQUFZLFVBQVc7SUFDaEMsTUFBTSxTQUFTLFdBQVcsQ0FBQyxlQUFlLEdBQ3hDLEdBQUcsSUFBSSxDQUFDLEVBQUUsU0FBUyxXQUFXLENBQUMsTUFBTSxFQUFFLEVBQ3ZDO0VBRUo7RUFDQSxPQUFPO0FBQ1Q7QUFFQTs7Ozs7O0NBTUMsR0FDRCxPQUFPLFNBQVMsdUJBQ2QsR0FBVyxFQUNYLFFBQWlDO0VBRWpDLE9BQU8sR0FBRyxJQUFJLENBQUMsRUFBRSxTQUFTLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxFQUFFLFNBQVMsV0FBVyxDQUFDLElBQUksRUFBRTtBQUM3RTtBQUVBLHFFQUFxRSxHQUNyRSxTQUFTLFVBQVUsSUFBbUI7RUFDcEMsSUFBSSxTQUFTLE1BQU0sT0FBTyxPQUFPLHNDQUFzQztFQUN2RSxPQUFPLENBQUMsT0FBTyxLQUFLLE1BQU07QUFDNUI7QUFFQSxrRUFBa0UsR0FDbEUsU0FBUyxjQUNQLEtBQXdCLEVBQ3hCLEdBQWM7RUFFZCxLQUFLLE1BQU0sUUFBUSxNQUFPO0lBQ3hCLE1BQU0sUUFBUSxJQUFJLE9BQU87SUFDekIsSUFBSSxPQUFPLE9BQU87RUFDcEI7RUFDQSxPQUFPO0FBQ1Q7QUFFQSxpRUFBaUUsR0FDakUsZUFBZSxjQUFjLElBQVk7RUFDdkMsSUFBSTtJQUNGLE9BQU8sTUFBTSxLQUFLLFlBQVksQ0FBQztFQUNqQyxFQUFFLE9BQU07SUFDTixPQUFPO0VBQ1Q7QUFDRjtBQWdCQTs7Ozs7Ozs7Ozs7O0NBWUMsR0FDRCxPQUFPLGVBQWUseUJBQ3BCLFVBQXNDLENBQUMsQ0FBQztFQUV4QyxNQUFNLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxDQUFDLE9BQWlCLEtBQUssR0FBRyxDQUFDLEdBQUcsQ0FBQyxLQUFLO0VBQ2hFLE1BQU0sTUFBTSxDQUFDLFFBQVEsR0FBRyxJQUFJLHFCQUFxQixJQUFJLEVBQUUsT0FBTyxDQUFDLFFBQVE7RUFDdkUsTUFBTSxZQUFZLFFBQVEsU0FBUyxJQUFJLHNCQUFzQjtJQUFFO0VBQUk7RUFDbkUsTUFBTSxpQkFBaUIseUJBQXlCO0VBQ2hELE1BQU0sbUJBQW1CLFVBQVUsR0FBRyxDQUFDLENBQUMsSUFBTSxFQUFFLFdBQVcsQ0FBQyxlQUFlLEVBQ3hFLElBQUksQ0FBQztFQUNSLE1BQU0sV0FBZ0MsRUFBRTtFQUV4QyxJQUFJLGVBQXdDO0VBQzVDLE1BQU0sa0JBQWtCLElBQUksSUFDMUIsVUFBVSxHQUFHLENBQUMsQ0FBQyxXQUFhO01BQUMsU0FBUyxFQUFFO01BQUU7S0FBSztFQUdqRCw2RUFBNkU7RUFDN0UsSUFBSSxXQUFnRTtFQUNwRSxJQUFJLFVBQTJCLEVBQUU7RUFDakMsSUFBSTtJQUNGLE1BQU0sT0FBTyxNQUFNLEtBQUssSUFBSSxDQUFDO0lBQzdCLElBQUksQ0FBQyxLQUFLLFdBQVcsRUFBRTtNQUNyQixXQUFXO0lBQ2IsT0FBTztNQUNMLElBQUk7UUFDRixVQUFVLE1BQU0sTUFBTSxTQUFTLENBQUMsS0FBSyxPQUFPLENBQUM7TUFDL0MsRUFBRSxPQUFNO1FBQ04sV0FBVztNQUNiO0lBQ0Y7RUFDRixFQUFFLE9BQU8sT0FBTztJQUNkLFdBQVcsaUJBQWlCLEtBQUssTUFBTSxDQUFDLFFBQVEsR0FBRyxZQUFZO0VBQ2pFO0VBRUEsSUFBSSxhQUFhLG1CQUFtQjtJQUNsQyxTQUFTLElBQUksQ0FBQztNQUNaLE1BQU07TUFDTixNQUFNO01BQ04sU0FDRSxDQUFDLGdCQUFnQixFQUFFLElBQUksNEZBQTRGLENBQUM7SUFDeEg7RUFDRixPQUFPLElBQUksYUFBYSxjQUFjO0lBQ3BDLFNBQVMsSUFBSSxDQUFDO01BQ1osTUFBTTtNQUNOLE1BQU07TUFDTixTQUNFLENBQUMscUJBQXFCLEVBQUUsSUFBSSxzRUFBc0UsRUFBRSxLQUFLO0lBQzdHO0VBQ0Y7RUFFQSxJQUFJLGFBQWEsTUFBTTtJQUNyQixNQUFNLGFBQWEsUUFBUSxNQUFNLENBQUMsQ0FBQyxJQUFNLENBQUMsZ0JBQWdCLFFBQVEsQ0FBQyxFQUFFLElBQUk7SUFDekUsSUFBSSxXQUFXLE1BQU0sS0FBSyxHQUFHO01BQzNCLFNBQVMsSUFBSSxDQUFDO1FBQ1osTUFBTTtRQUNOLE1BQU07UUFDTixTQUNFLENBQUMscUJBQXFCLEVBQUUsSUFBSSxpRUFBaUUsRUFBRSxpQkFBaUIscUJBQXFCLENBQUM7TUFDMUk7SUFDRjtJQUNBLEtBQUssTUFBTSxTQUFTLFdBQVk7TUFDOUIsSUFBSSxlQUFlLFFBQVEsQ0FBQyxNQUFNLElBQUksR0FBRztNQUN6QyxTQUFTLElBQUksQ0FBQztRQUNaLE1BQU07UUFDTixNQUFNLEdBQUcsSUFBSSxDQUFDLEVBQUUsTUFBTSxJQUFJLEVBQUU7UUFDNUIsU0FDRSxDQUFDLGlCQUFpQixFQUFFLElBQUksQ0FBQyxFQUFFLE1BQU0sSUFBSSxDQUFDLDJDQUEyQyxFQUMvRSxlQUFlLElBQUksQ0FBQyxLQUNyQiwrQkFBK0IsQ0FBQztNQUNyQztJQUNGO0lBRUEsMkVBQTJFO0lBQzNFLE1BQU0sWUFBWSxHQUFHLElBQUksQ0FBQyxFQUFFLHFCQUFxQixDQUFDLEVBQUUsZUFBZTtJQUNuRSxNQUFNLFFBQVEsTUFBTSxjQUFjO0lBQ2xDLElBQUksVUFBVSxRQUFRLGVBQWUsUUFBUTtNQUMzQyxlQUFlO01BQ2YsU0FBUyxJQUFJLElBQUssTUFBTSxtQkFBbUI7SUFDN0M7SUFFQSw0RUFBNEU7SUFDNUUsMEVBQTBFO0lBQzFFLDBFQUEwRTtJQUMxRSx5RUFBeUU7SUFDekUscUVBQXFFO0lBQ3JFLGlDQUFpQztJQUNqQyxLQUFLLE1BQU0sWUFBWSxVQUFXO01BQ2hDLEtBQUssTUFBTSxTQUFTLENBQUEsTUFBTSwyQkFBMkIsS0FBSyxTQUFRLEVBQUc7UUFDbkUsSUFBSSxNQUFNLElBQUksS0FBSyxNQUFNO1VBQ3ZCLGdCQUFnQixHQUFHLENBQUMsU0FBUyxFQUFFLEVBQUU7VUFDakMsU0FBUyxJQUFJLElBQUssTUFBTSxtQkFBbUIsTUFBTSxJQUFJO1VBQ3JEO1FBQ0Y7UUFDQSxtRUFBbUU7UUFDbkUscUVBQXFFO1FBQ3JFLDZDQUE2QztRQUM3QyxxRUFBcUU7UUFDckUsNEJBQTRCO1FBQzVCLElBQUksTUFBTSxPQUFPLEVBQUU7UUFDbkIsU0FBUyxJQUFJLElBQUssTUFBTSxtQkFBbUIsTUFBTSxJQUFJO1FBQ3JELFNBQVMsSUFBSSxDQUFDO1VBQ1osTUFBTTtVQUNOLE1BQU0sTUFBTSxJQUFJO1VBQ2hCLFVBQVUsU0FBUyxFQUFFO1VBQ3JCLFNBQ0UsQ0FBQyxXQUFXLEVBQUUsTUFBTSxJQUFJLENBQUMscUJBQXFCLEVBQUUsU0FBUyxXQUFXLENBQUMsaUNBQWlDLEVBQ3BHLHlCQUF5QixVQUFVLElBQUksQ0FBQyxLQUN6QywyQ0FBMkMsQ0FBQztRQUNqRDtNQUNGO0lBQ0Y7RUFDRjtFQUVBLDZFQUE2RTtFQUM3RSxJQUFJLGlCQUFpQixRQUFRLGNBQWMsNEJBQTRCLE1BQU07SUFDM0UsZUFBZTtFQUNqQjtFQUNBLEtBQUssTUFBTSxZQUFZLFVBQVc7SUFDaEMsSUFDRSxnQkFBZ0IsR0FBRyxDQUFDLFNBQVMsRUFBRSxNQUFNLFFBQ3JDLGNBQWMseUJBQXlCLFdBQVcsTUFDbEQ7TUFDQSxnQkFBZ0IsR0FBRyxDQUFDLFNBQVMsRUFBRSxFQUFFO0lBQ25DO0VBQ0Y7RUFFQSxJQUFJLGlCQUFpQixNQUFNO0lBQ3pCLFNBQVMsSUFBSSxDQUFDO01BQ1osTUFBTTtNQUNOLE1BQU0sR0FBRyxJQUFJLENBQUMsRUFBRSxxQkFBcUIsQ0FBQyxFQUFFLGVBQWU7TUFDdkQsU0FDRSxDQUFDLDZCQUE2QixFQUFFLElBQUksQ0FBQyxFQUFFLHFCQUFxQixDQUFDLEVBQUUsY0FBYyw0QkFBNEIsRUFDdkcsMkJBQTJCLElBQUksQ0FBQyxLQUNqQywrR0FBK0csQ0FBQztJQUNySDtFQUNGO0VBQ0EsdUVBQXVFO0VBQ3ZFLDhEQUE4RDtFQUM5RCxLQUFLLE1BQU0sWUFBWSxVQUFXO0lBQ2hDLElBQUksZ0JBQWdCLEdBQUcsQ0FBQyxTQUFTLEVBQUUsTUFBTSxNQUFNO0lBQy9DLE1BQU0sT0FBTyx1QkFBdUIsS0FBSztJQUN6QyxTQUFTLElBQUksQ0FBQztNQUNaLE1BQU07TUFDTjtNQUNBLFVBQVUsU0FBUyxFQUFFO01BQ3JCLFNBQ0UsQ0FBQyxrREFBa0QsRUFBRSxTQUFTLFdBQVcsQ0FBQyxFQUFFLEVBQUUsU0FBUyxFQUFFLENBQUMsR0FBRyxFQUFFLEtBQUssaUNBQWlDLEVBQ25JLHlCQUF5QixVQUFVLElBQUksQ0FBQyxLQUN6QyxnQ0FBZ0MsRUFBRSxTQUFTLFdBQVcsQ0FBQyxlQUFlLENBQUMsc0RBQXNELENBQUM7SUFDbkk7RUFDRjtFQUVBLE1BQU0sK0JBQStCLFVBQVUsS0FBSyxDQUNsRCxDQUFDLFdBQWEsZ0JBQWdCLEdBQUcsQ0FBQyxTQUFTLEVBQUUsTUFBTTtFQUdyRCwwRUFBMEU7RUFDMUUsSUFDRSxhQUFhLGFBQ2IsQ0FBQyxpQkFBaUIsaUJBQWlCLENBQUMsNEJBQTRCLEdBQ2hFO0lBQ0EsU0FBUyxPQUFPLENBQUM7TUFDZixNQUFNO01BQ04sTUFBTTtNQUNOLFNBQ0UsQ0FBQyxxQkFBcUIsRUFBRSxJQUFJLG9FQUFvRSxFQUFFLGlCQUFpQix1Q0FBdUMsQ0FBQztJQUMvSjtFQUNGO0VBRUEsT0FBTztJQUNMLElBQUksU0FBUyxNQUFNLEtBQUs7SUFDeEI7SUFDQTtJQUNBLGdCQUFnQixnQkFBZ0IsR0FBRyxDQUFDLFNBQVMsQ0FBQyxFQUFFLEVBQUUsTUFBTSxPQUFPO0lBQy9ELFdBQVcsVUFBVSxHQUFHLENBQUMsQ0FBQyxXQUFhLENBQUM7UUFDdEMsSUFBSSxTQUFTLEVBQUU7UUFDZixhQUFhLFNBQVMsV0FBVztRQUNqQyxRQUFRLGdCQUFnQixHQUFHLENBQUMsU0FBUyxFQUFFLEtBQUs7TUFDOUMsQ0FBQztJQUNEO0VBQ0Y7QUFDRjtBQUVBLHlEQUF5RCxHQUN6RCxlQUFlLG1CQUFtQixJQUFZO0VBQzVDLElBQUk7SUFDRixNQUFNLE9BQU8sTUFBTSxLQUFLLElBQUksQ0FBQztJQUM3QixJQUFJLENBQUMsVUFBVSxLQUFLLElBQUksSUFBSSxPQUFPLE9BQU8sRUFBRTtJQUM1QyxNQUFNLE9BQU8sQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLElBQUk7SUFDaEMsT0FBTztNQUFDO1FBQ04sTUFBTTtRQUNOO1FBQ0EsU0FBUyxDQUFDLGdCQUFnQixFQUFFLEtBQUssU0FBUyxFQUN4QyxLQUFLLFFBQVEsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxHQUFHLEtBQzlCLHlDQUF5QyxFQUFFLE1BQU07TUFDcEQ7S0FBRTtFQUNKLEVBQUUsT0FBTTtJQUNOLE9BQU8sRUFBRTtFQUNYO0FBQ0Y7QUFFQTs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sU0FBUywwQkFDZCxPQUEwQixFQUMxQixXQUFvQyxRQUFRLFFBQVEsR0FDaEQscUJBQXFCLFFBQVEsUUFBUSxJQUNyQyxxQkFBcUI7RUFFekIsSUFDRSxRQUFRLElBQUksS0FBSyxrQ0FDakIsU0FBUyxXQUFXLENBQUMsUUFBUSxPQUFPLEdBQ3BDO0lBQ0EsT0FBTztFQUNUO0VBQ0EsSUFDRSxRQUFRLElBQUksS0FBSyxnQ0FDakIsY0FBYyxRQUFRLE9BQU8sR0FDN0I7SUFDQSxPQUFPO0VBQ1Q7RUFDQSxPQUFPO0FBQ1Q7QUFFQTs7Ozs7O0NBTUMsR0FDRCxPQUFPLFNBQVMsMkJBQ2QsTUFBaUM7RUFFakMsSUFBSSxPQUFPLEVBQUUsRUFBRTtJQUNiLE1BQU0sY0FBYyxPQUFPLFNBQVMsQ0FDakMsR0FBRyxDQUFDLENBQUMsV0FBYSxHQUFHLFNBQVMsRUFBRSxDQUFDLENBQUMsRUFBRSxTQUFTLE1BQU0sSUFBSSxRQUFRLEVBQy9ELElBQUksQ0FBQztJQUNSLE9BQU8sQ0FBQyxnQ0FBZ0MsRUFBRSxPQUFPLEdBQUcsQ0FBQyxTQUFTLEVBQzVELE9BQU8sWUFBWSxJQUFJLE9BQ3hCLFdBQVcsRUFBRSxPQUFPLGNBQWMsSUFBSSxPQUFPLEVBQUUsRUFBRSxZQUFZLENBQUMsQ0FBQztFQUNsRTtFQUNBLE1BQU0sUUFBUSxPQUFPLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFNLENBQUMsS0FBSyxFQUFFLEVBQUUsSUFBSSxDQUFDLEVBQUUsRUFBRSxFQUFFLE9BQU8sRUFBRTtFQUN2RSxPQUFPO0lBQ0wsQ0FBQyxnQ0FBZ0MsRUFBRSxPQUFPLEdBQUcsQ0FBQyxHQUFHLEVBQUUsT0FBTyxRQUFRLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQztPQUNwRjtHQUNKLENBQUMsSUFBSSxDQUFDO0FBQ1QifQ==
// denoCacheMetadata=5755125920307089573,11294143843064230536