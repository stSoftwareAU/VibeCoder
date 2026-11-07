/** Provider policy for fleet babysitter repairs (Issue #4766). */

import {
  DEEPSEEK_PROVIDER_ID,
  resolveAgentProvider,
  resolveAgentProviderId,
} from "./agent_provider.ts";
import { applyProviderCredentialEnv } from "./credential_preflight.ts";
import { buildDeepSeekChildEnv } from "./deepseek_env.ts";
import type { EnvLookup } from "./env_lookup.ts";
import {
  type AutomaticProviderStatusResolver,
  refreshAutomaticProviderRouting,
  resolveAutomaticProviderConfig,
} from "./provider_auto_runtime.ts";
import type { AutomaticProviderSelection } from "./provider_auto_selection.ts";

/** Dependencies that keep provider selection testable without host credentials. */
export interface BabysitterProviderChoiceDeps {
  readonly workDir: string;
  readonly enabledProviderIds: readonly string[];
  readonly env?: EnvLookup;
  readonly now?: number;
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly resolveStatus?: AutomaticProviderStatusResolver;
  readonly exportDeepSeekCredential?: (
    setEnv: (name: string, value: string) => void,
  ) => Promise<string[]>;
  readonly readEnvironment?: () => Record<string, string>;
  readonly log?: (message: string) => void;
}

/** Provider selected for one babysitter repair. */
export interface BabysitterProviderChoice {
  readonly providerId: string;
  readonly overflow: boolean;
  readonly env: Record<string, string>;
}

interface RawProviderModeConfig {
  agent_provider_mode?: unknown;
  agent_provider?: unknown;
  agent_providers?: unknown;
}

function parseConfig(text: string, path: string): RawProviderModeConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error(`cannot parse babysitter provider config ${path}`, {
      cause,
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `babysitter provider config ${path} must contain a JSON object`,
    );
  }
  return value as RawProviderModeConfig;
}

async function readConfig(
  path: string,
  reader: (path: string) => Promise<string>,
): Promise<string> {
  try {
    return await reader(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) {
      return "{}";
    }
    throw new Error(`cannot read babysitter provider config ${path}`, {
      cause,
    });
  }
}

async function exportDeepSeekCredential(
  setEnv: (name: string, value: string) => void,
): Promise<string[]> {
  const values = resolveAgentProvider(DEEPSEEK_PROVIDER_ID);
  return await applyProviderCredentialEnv({
    providers: [values],
    setEnv,
  });
}

function rankedExclusions(selection: AutomaticProviderSelection): string {
  return selection.ranked.map((candidate) =>
    `${candidate.provider}/${candidate.credentialLabel}:` +
    `${candidate.excluded ?? candidate.status.reason ?? "ineligible"}`
  ).join(",");
}

/**
 * Select a babysitter repair provider. Automatic mode reuses the worker's
 * subscription ranking; only a no-winner result uses logged DeepSeek overflow.
 */
export async function chooseBabysitterProvider(
  deps: BabysitterProviderChoiceDeps,
): Promise<BabysitterProviderChoice> {
  const env = deps.env ?? ((name: string) => Deno.env.get(name));
  const readTextFile = deps.readTextFile ?? ((path) => Deno.readTextFile(path));
  const path = env("CONFIG_PATH")?.trim() || ".config.json";
  const config = await readConfig(path, readTextFile);
  const raw = parseConfig(config, path);
  const pin = env("VIBE_AGENT_PROVIDER")?.trim();
  const configured = resolveAutomaticProviderConfig({
    configuredMode: raw.agent_provider_mode,
    configuredProvider: raw.agent_provider,
    configuredProviders: raw.agent_providers,
  });
  if (configured.mode !== "auto" || pin) {
    if (
      configured.mode === "auto" && pin &&
      !deps.enabledProviderIds.some((id) => id.trim() === pin)
    ) {
      throw new Error(
        `VIBE_AGENT_PROVIDER pin ${JSON.stringify(pin)} is not ` +
          `in the enabled agent_providers set`,
      );
    }
    const providerId = resolveAgentProviderId({
      configured: configured.mode === "auto"
        ? ""
        : typeof raw.agent_provider === "string"
        ? raw.agent_provider
        : "",
      env,
    });
    return {
      providerId,
      overflow: false,
      env: (deps.readEnvironment ?? (() => Deno.env.toObject()))(),
    };
  }

  const runtime = await refreshAutomaticProviderRouting({
    workDir: deps.workDir,
    enabledProviderIds: deps.enabledProviderIds,
    env,
    now: deps.now,
    readTextFile: async () => config,
    resolveStatus: deps.resolveStatus,
    log: deps.log,
  });
  const selection = runtime.selection;
  if (!runtime.shouldPause) {
    if (!selection?.winner) {
      throw new Error(
        "automatic babysitter routing returned no winner without pausing",
      );
    }
    return {
      providerId: selection.winner.provider,
      overflow: false,
      env: (deps.readEnvironment ?? (() => Deno.env.toObject()))(),
    };
  }
  if (!selection) {
    throw new Error("automatic babysitter routing paused without a selection");
  }

  const exportedValues: Record<string, string> = {};
  const exported =
    await (deps.exportDeepSeekCredential ?? exportDeepSeekCredential)(
      (name, value) => exportedValues[name] = value,
    );
  if (exported.length === 0) {
    throw new Error(
      "no subscription has budget and no DeepSeek credential is configured",
    );
  }
  const childEnv = buildDeepSeekChildEnv({
    ...(deps.readEnvironment ?? (() => Deno.env.toObject()))(),
    ...exportedValues,
  });
  (deps.log ?? ((message) => console.error(message)))(
    `[quota] babysitter paid overflow selected=${DEEPSEEK_PROVIDER_ID} ` +
      `reason=${rankedExclusions(selection)}`,
  );
  return { providerId: DEEPSEEK_PROVIDER_ID, overflow: true, env: childEnv };
}
