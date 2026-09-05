/**
 * The coding-agent providers setup is configuring (Issue #730, part of #722).
 *
 * `setup.sh` used to demand the Claude CLI and a Claude OAuth token on every
 * host, whatever `.config.json` selected: the prerequisite probe made `claude`
 * host-fatal and the interactive credential flow prompted for
 * `CLAUDE_CODE_OAUTH_TOKEN` unconditionally. A Codex-only host therefore never
 * reached the configuration-writing stage at all.
 *
 * The selection already exists — `agent_provider` and `agent_providers` in
 * `.config.json`, with `VIBE_AGENT_PROVIDER`/`VIBE_AGENT_PROVIDERS` applying
 * when the file states none (Issue #1032) —
 * so it is resolved here, once, through the same
 * {@link resolveEnabledAgentProviderIds} the worker uses. Both consumers read
 * it from this module: the prerequisite probe (which tools are host-fatal) and
 * `setup.sh` (which credential flows run), so the two can never disagree.
 *
 * Fail loud (Issue #3234): a configuration file that exists but is broken —
 * unreadable, not JSON, not an object, or naming a provider that is not
 * registered — throws rather than falling back to the default. Provisioning
 * the wrong vendor's credential because a file could not be parsed is exactly
 * the silent failure this repository refuses. A file that does not exist yet
 * is a legitimate "nothing selected" (the first `./setup.sh` on a bare host)
 * and resolves to the default provider.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  AGENT_PROVIDER_CONFIG_KEY,
  ENABLED_AGENT_PROVIDERS_CONFIG_KEY,
  IMAGE_AGENT_PROVIDERS_ENV,
  resolveEnabledAgentProviderIds,
} from "../lib/agent_provider.ts";
import { type EnvLookup, processEnvLookup } from "../lib/env_lookup.ts";

/**
 * Environment lookup for the setup-time resolution.
 *
 * `VIBE_AGENT_PROVIDER` / `VIBE_AGENT_PROVIDERS` still select the provider on
 * a host whose file states none — an operator's explicit selection is the
 * point — though since Issue #1032 they no longer override the file. The
 * image stamp is deliberately hidden: it says which agents the *currently built* image carries, and setup
 * runs on the host precisely to configure the providers the next image build
 * will install. Enforcing it here would refuse to configure Codex on a host
 * whose existing image predates that choice; the worker still enforces it at
 * run time, inside the image, where it means something.
 *
 * Wraps whatever lookup the caller supplies (Issue #962), so the stamp stays
 * hidden whether the host environment or a test's own map is underneath.
 *
 * @param env - The lookup the host values come from.
 * @returns A lookup answering as `env` does, except for the image stamp.
 */
export function setupEnv(env: EnvLookup = processEnvLookup): EnvLookup {
  return (name) => name === IMAGE_AGENT_PROVIDERS_ENV ? undefined : env(name);
}

/** The provider selection as `.config.json` holds it. */
export interface AgentProviderSelectionFile {
  /** The `agent_provider` value, when set. */
  active?: string;
  /** The `agent_providers` value, when set. */
  enabled?: string[];
}

/**
 * Read the coding-agent provider selection out of a configuration file.
 *
 * @param configFile - Host path of the worker configuration file.
 * @returns The configured values; both absent when the file does not exist or
 *   sets neither key.
 * @throws When the file exists but is unreadable, is not JSON, does not hold
 *   an object, or sets either key to the wrong type.
 */
export async function readConfiguredAgentProviders(
  configFile: string,
): Promise<AgentProviderSelectionFile> {
  let text: string;
  try {
    text = await Deno.readTextFile(configFile);
  } catch (error) {
    // No configuration yet (the first ./setup.sh on a bare host) is a
    // legitimate "nothing selected"; anything else is a real fault.
    if (error instanceof Deno.errors.NotFound) return {};
    throw new Error(
      `Cannot resolve the coding-agent providers: ${configFile} is ` +
        `unreadable (${(error as Error).message}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Cannot resolve the coding-agent providers: ${configFile} is not ` +
        `readable JSON (${(error as Error).message}). Fix it, or re-run ` +
        `./setup.sh.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Cannot resolve the coding-agent providers: ${configFile} does not ` +
        `hold a JSON object.`,
    );
  }

  const file = parsed as Record<string, unknown>;
  const active = file[AGENT_PROVIDER_CONFIG_KEY];
  if (active !== undefined && typeof active !== "string") {
    throw new Error(
      `Cannot resolve the coding-agent providers: ${configFile} key ` +
        `"${AGENT_PROVIDER_CONFIG_KEY}" must be a string.`,
    );
  }
  const enabled = file[ENABLED_AGENT_PROVIDERS_CONFIG_KEY];
  if (
    enabled !== undefined &&
    (!Array.isArray(enabled) || enabled.some((id) => typeof id !== "string"))
  ) {
    throw new Error(
      `Cannot resolve the coding-agent providers: ${configFile} key ` +
        `"${ENABLED_AGENT_PROVIDERS_CONFIG_KEY}" must be an array of strings.`,
    );
  }

  return {
    ...(active === undefined ? {} : { active }),
    ...(enabled === undefined ? {} : { enabled: enabled as string[] }),
  };
}

/**
 * Resolve every coding-agent provider this host is configured to run.
 *
 * @param configFile - Host path of the worker configuration file.
 * @param env - Host environment the `VIBE_AGENT_PROVIDER(S)` fallbacks are
 *   read from (Issue #962). Defaults to the process environment, so setup
 *   itself resolves exactly as it did before the parameter existed.
 * @returns The enabled provider ids, active provider first when the set was
 *   left implicit — `["claude"]` on a host that configures nothing.
 * @throws When the file is broken, or the selection names a provider that is
 *   not registered (see {@link resolveEnabledAgentProviderIds}).
 */
export async function resolveSetupAgentProviderIds(
  configFile: string,
  env: EnvLookup = processEnvLookup,
): Promise<string[]> {
  const selection = await readConfiguredAgentProviders(configFile);
  return resolveEnabledAgentProviderIds({
    env: setupEnv(env),
    ...(selection.active === undefined ? {} : { configured: selection.active }),
    ...(selection.enabled === undefined
      ? {}
      : { configuredProviders: selection.enabled }),
  });
}
