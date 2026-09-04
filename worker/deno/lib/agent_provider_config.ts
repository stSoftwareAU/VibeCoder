/**
 * The deployment's coding-agent provider selection, read from `.config.json`
 * (Issues #4108, #729).
 *
 * The launcher and the image-hash command both run on the **host**, before the
 * worker has loaded its configuration, so neither holds a config handle. This
 * module is the one place that reads the selection off disk and turns it into
 * the two things the launch needs: the descriptors whose credentials are
 * mounted, and the `AGENT_PROVIDERS` value the image build is given. Deriving
 * them together is the point — a `.config.json` that meant one provider set to
 * the mounts and another to the build is exactly the defect Issue #729 fixed,
 * and a second copy of the derivation is how it would come back.
 *
 * Fail loud (Issue #3234): an unparseable file, a key of the wrong shape, or a
 * provider that is not registered stops the launch with the offending value
 * named — never a silent fall back to the default set, which would run an
 * agent the operator did not choose.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import {
  AGENT_PROVIDER_CONFIG_KEY,
  type AgentProviderDescriptor,
  agentProvidersBuildValue,
  ENABLED_AGENT_PROVIDERS_CONFIG_KEY,
  enabledAgentProviders,
} from "./agent_provider.ts";
import type { EnvLookup } from "./env_lookup.ts";

/** A provider selection as `.config.json` spells it. */
export interface AgentProviderConfigSelection {
  /** The `agent_provider` value, when set. */
  configured?: string;
  /** The `agent_providers` value, when set. */
  configuredProviders?: string[];
}

/**
 * Read the provider selection out of `.config.json`.
 *
 * @param configFile - Host path of the worker configuration file.
 * @returns The configured active provider and enabled set, when set.
 * @throws When the file is unparseable or either key has the wrong shape —
 *   a launch must not silently fall back to the default set (Issue #3234).
 */
export async function readAgentProviderSelection(
  configFile: string,
): Promise<AgentProviderConfigSelection> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(configFile));
  } catch (error) {
    throw new Error(
      `Cannot launch: ${configFile} is not readable JSON ` +
        `(${(error as Error).message}). Fix it, or re-run ./setup.sh.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Cannot launch: ${configFile} does not hold a JSON object.`,
    );
  }

  const record = parsed as Record<string, unknown>;
  const active = record[AGENT_PROVIDER_CONFIG_KEY];
  if (active !== undefined && typeof active !== "string") {
    throw new Error(
      `Cannot launch: ${configFile} key "${AGENT_PROVIDER_CONFIG_KEY}" must ` +
        `be a string.`,
    );
  }
  const enabled = record[ENABLED_AGENT_PROVIDERS_CONFIG_KEY];
  if (
    enabled !== undefined &&
    (!Array.isArray(enabled) || enabled.some((id) => typeof id !== "string"))
  ) {
    throw new Error(
      `Cannot launch: ${configFile} key ` +
        `"${ENABLED_AGENT_PROVIDERS_CONFIG_KEY}" must be an array of ` +
        `provider ids.`,
    );
  }

  return {
    configured: active as string | undefined,
    configuredProviders: enabled as string[] | undefined,
  };
}

/** What one deployment's provider selection resolves to. */
export interface ConfiguredAgentProviderSet {
  /** The enabled descriptors, in install order — the mounts follow these. */
  providers: AgentProviderDescriptor[];
  /**
   * The `AGENT_PROVIDERS` build-argument value, or `undefined` when the set is
   * already the image default and the build takes it unchanged.
   */
  buildValue?: string;
}

/**
 * Resolve one deployment's provider set from its configuration (Issue #729).
 *
 * @param configFile - Host path of the worker configuration file.
 * @param imageDefault - The set a default image build installs, i.e.
 *   `container/tools.json` `installedProviders`.
 * @param env - Environment lookup the `VIBE_AGENT_PROVIDER(S)` overrides and
 *   the image stamp are read through (Issue #962). Defaults to the process
 *   environment, so every existing caller resolves exactly as before.
 * @returns The enabled descriptors and the build-argument value they imply.
 * @throws When the configuration is unreadable, or names a provider that is
 *   not registered, is duplicated, or the running image did not install.
 */
export async function readConfiguredAgentProviderSet(
  configFile: string,
  imageDefault: readonly string[],
  env?: EnvLookup,
): Promise<ConfiguredAgentProviderSet> {
  const selection = await readAgentProviderSelection(configFile);
  const providers = enabledAgentProviders({
    ...selection,
    ...(env ? { env } : {}),
  });
  const buildValue = agentProvidersBuildValue(
    providers.map((provider) => provider.id),
    imageDefault,
  );
  return { providers, ...(buildValue ? { buildValue } : {}) };
}
