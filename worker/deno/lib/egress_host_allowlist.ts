/**
 * Host-side egress allowlist reader (Issue #4051).
 *
 * The launcher runs on the host before the worker has loaded its
 * configuration, so it cannot use `loadConfig`. This module reads the same
 * `.config.json` and resolves the same list the worker resolves, through the
 * same helpers: the provider selection from `agent_provider_config.ts`, the
 * imgbb state from `imgbb_upload.ts`, and the list from `egress_allowlist.ts`.
 *
 * Fail loud (Issue #3234): a missing, unreadable or unparseable file, or one
 * that does not hold a JSON object, throws naming the file. It never yields an
 * empty or permissive list. The list also travels in one comma-separated
 * environment variable to the proxy, so an entry carrying a comma, whitespace
 * or a control character is refused by name. `validateEgressHost` already
 * refuses those in operator extras; `ANTHROPIC_BASE_URL` is not validated, so
 * it is checked here.
 *
 * Australian English spelling used throughout (behaviour, normalised).
 */

import { readConfiguredAgentProviderSet } from "./agent_provider_config.ts";
import {
  PROVIDER_EGRESS_RULES,
  resolveEgressAllowlist,
} from "./egress_allowlist.ts";
import type { EnvLookup } from "./env_lookup.ts";
import { readImgbbApiKeyFromEnv } from "./imgbb_upload.ts";

/** The resolved list and the hosts the launcher probes before the run. */
export interface HostEgressAllowlist {
  /** Every host the container may reach, in resolution order. */
  allowlist: string[];
  /** Probe targets. Always non-wildcard, and each one is in `allowlist`. */
  probeHosts: {
    github: string;
    registry: string;
    /** The first host of each enabled provider that has egress rules. */
    providers: Array<{ provider: string; host: string }>;
  };
}

/** The GitHub host the launcher probes. Must stay in the builtin rules. */
const GITHUB_PROBE_HOST = "api.github.com";

/** The package-registry host the launcher probes. Must stay builtin. */
const REGISTRY_PROBE_HOST = "registry.npmjs.org";

/** Characters an allowlist entry may not carry (the list is comma-joined). */
const UNSAFE_ENTRY_CHARACTER = /[,\s\p{Cc}]/u;

/**
 * Read `.config.json` as a JSON object, failing loud with the file named.
 *
 * @param configFile - Host path of the worker configuration file
 * @returns The parsed object
 * @throws Error naming `configFile` when it is unreadable, not JSON, or not an
 *   object
 */
async function readConfigObject(
  configFile: string,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await Deno.readTextFile(configFile);
  } catch (error) {
    throw new Error(
      `Cannot resolve the egress allowlist: ${configFile} is not readable ` +
        `(${(error as Error).message}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Cannot resolve the egress allowlist: ${configFile} is not valid JSON ` +
        `(${(error as Error).message}).`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Cannot resolve the egress allowlist: ${configFile} does not hold a ` +
        "JSON object.",
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolve the egress allowlist and probe hosts for one launch.
 *
 * @param input - The config file, the image's installed providers, and the
 *   environment lookup the launch reads through
 * @returns The allowlist and the probe hosts
 * @throws Error naming the config file or the offending entry when the file
 *   cannot be read, a key has the wrong shape, an entry is invalid or carries
 *   a comma, whitespace or a control character, or a builtin probe host is
 *   missing
 */
export async function readHostEgressAllowlist(input: {
  configFile: string;
  installedProviders: readonly string[];
  env: EnvLookup;
}): Promise<HostEgressAllowlist> {
  const { configFile, installedProviders, env } = input;
  const file = await readConfigObject(configFile);

  const providerSet = await readConfiguredAgentProviderSet(
    configFile,
    installedProviders,
    env,
  );
  const enabledProviderIds = providerSet.providers.map((provider) =>
    provider.id
  );

  // Mirrors the worker's check in config.ts: a key that is present but not a
  // string (null included) is refused here, before any coercion, rather than
  // read as "not configured". Only an absent key (undefined) is unconfigured.
  const rawImgbbKey = file.imgbb_api_key;
  if (rawImgbbKey !== undefined && typeof rawImgbbKey !== "string") {
    throw new Error(
      `Cannot resolve the egress allowlist: ${configFile} key ` +
        '"imgbb_api_key" must be a string.',
    );
  }
  const imgbbKey = rawImgbbKey ?? "";
  const imgbbConfigured = imgbbKey.trim() !== "" ||
    readImgbbApiKeyFromEnv(env) !== "";

  const allowlist = resolveEgressAllowlist({
    enabledProviderIds,
    imgbbConfigured,
    anthropicBaseUrl: env("ANTHROPIC_BASE_URL"),
    extraHosts: file.egress_allow_hosts,
  });

  for (const host of allowlist) {
    if (UNSAFE_ENTRY_CHARACTER.test(host)) {
      throw new Error(
        `egress allowlist entry ${
          JSON.stringify(host)
        } contains a comma, whitespace or a control character, so it cannot ` +
          "travel in the comma-separated proxy allowlist.",
      );
    }
  }

  for (const probe of [GITHUB_PROBE_HOST, REGISTRY_PROBE_HOST]) {
    if (!allowlist.includes(probe)) {
      throw new Error(
        `egress allowlist lacks the probe host ${probe}; the builtin egress ` +
          "rules no longer include it.",
      );
    }
  }

  const providers: Array<{ provider: string; host: string }> = [];
  for (const id of enabledProviderIds) {
    if (!Object.hasOwn(PROVIDER_EGRESS_RULES, id)) continue;
    const first = PROVIDER_EGRESS_RULES[id]?.[0];
    if (first !== undefined) providers.push({ provider: id, host: first.host });
  }

  return {
    allowlist,
    probeHosts: {
      github: GITHUB_PROBE_HOST,
      registry: REGISTRY_PROBE_HOST,
      providers,
    },
  };
}
