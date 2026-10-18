/** Agent-local profile; all upstream authority remains in the separate broker. */
import { assertBrokerCapability } from "./credential_broker_policy.ts";
import {
  buildBrokeredAnthropicEnvironment,
  serveAnthropicAgentGateway,
} from "./anthropic_agent_gateway.ts";
import {
  buildBrokeredCodexLaunch,
  serveCodexAgentGateway,
} from "./codex_agent_gateway.ts";
import {
  buildBrokeredGeminiEnvironment,
  serveGeminiAgentGateway,
} from "./gemini_agent_gateway.ts";
import {
  buildBrokeredGitHubEnvironment,
  githubAgentSocketConfig,
  serveGitHubAgentGateway,
} from "./github_agent_gateway.ts";
import {
  buildBrokeredGitEnvironment,
  gitAgentReadConfig,
  serveGitAgentGateway,
} from "./git_agent_gateway.ts";

export type BrokeredJobAgent =
  | { provider: "claude"; authentication: "api-key" | "subscription" }
  | { provider: "deepseek"; authentication: "bearer" }
  | { provider: "codex"; authentication: "api-key" | "chatgpt" }
  | { provider: "gemini"; authentication: "api-key" };

/** A closed public descriptor; it cannot hold credential paths or account data. */
export function parseBrokeredJobAgent(value: unknown): BrokeredJobAgent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid public agent profile");
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(fields).length !== 2 ||
    Object.values(fields).some((v) => !("value" in v))
  ) {
    throw new Error("Invalid public agent profile");
  }
  const provider = fields.provider?.value;
  const authentication = fields.authentication?.value;
  if (
    !(provider === "claude" &&
      ["api-key", "subscription"].includes(authentication)) &&
    !(provider === "deepseek" && authentication === "bearer") &&
    !(provider === "codex" &&
      ["api-key", "chatgpt"].includes(authentication)) &&
    !(provider === "gemini" && authentication === "api-key")
  ) {
    throw new Error("Invalid public agent profile");
  }
  return { provider, authentication } as BrokeredJobAgent;
}

const defaults = {
  github: serveGitHubAgentGateway,
  git: serveGitAgentGateway,
  claude: serveAnthropicAgentGateway,
  codex: serveCodexAgentGateway,
  gemini: serveGeminiAgentGateway,
};

/**
 * Prepare a new profile before launching any repository code. Nothing is read
 * from an existing HOME, provider config, Git config or the process environment.
 * Only the private broker's public session descriptor is accepted here.
 */
export async function prepareBrokeredJobEnvironment(
  metadata: unknown,
  gateways: typeof defaults = defaults,
): Promise<{ env: Record<string, string>; close: () => Promise<void> }> {
  if (
    typeof metadata !== "object" || metadata === null || Array.isArray(metadata)
  ) {
    throw new Error("Invalid broker public metadata");
  }
  const fields = Object.getOwnPropertyDescriptors(metadata);
  if (
    Object.values(fields).some((v) => !("value" in v)) ||
    Object.keys(fields).some((key) =>
      !["version", "capability", "agent"].includes(key)
    ) ||
    fields.version?.value !== 1 || typeof fields.capability?.value !== "string"
  ) {
    throw new Error("Invalid broker public metadata");
  }
  const capability = fields.capability.value as string;
  assertBrokerCapability(capability);
  const agent = fields.agent
    ? parseBrokeredJobAgent(fields.agent.value)
    : undefined;
  const home = await Deno.makeTempDir({
    dir: "/tmp",
    prefix: "vibe-isolated-job-",
  });
  const active: Array<{ close: () => Promise<void> }> = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    let failed = false;
    for (const gateway of active.reverse()) {
      try {
        await gateway.close();
      } catch {
        failed = true;
      }
    }
    try {
      await Deno.remove(home, { recursive: true });
    } catch {
      failed = true;
    }
    if (failed) throw new Error("Isolated job profile cleanup failed");
  };
  try {
    const gh = `${home}/gh`;
    await Deno.mkdir(gh, { mode: 0o700 });
    const socketPath = `${home}/gh.sock`;
    active.push(gateways.github({ capability, socketPath }));
    await Deno.writeTextFile(
      `${gh}/config.yml`,
      githubAgentSocketConfig(socketPath),
      { createNew: true, mode: 0o600 },
    );
    const git = gateways.git({ capability });
    active.push(git);
    const gitConfig = `${home}/gitconfig`;
    await Deno.writeTextFile(gitConfig, gitAgentReadConfig(git.baseUrl), {
      createNew: true,
      mode: 0o600,
    });
    const env: Record<string, string> = {
      ...buildBrokeredGitHubEnvironment({
        capability,
        homeDir: home,
        configDir: gh,
      }),
      ...buildBrokeredGitEnvironment({ homeDir: home, configFile: gitConfig }),
      TMPDIR: `${home}/tmp`,
      XDG_CONFIG_HOME: `${home}/config`,
      XDG_CACHE_HOME: `${home}/cache`,
      XDG_DATA_HOME: `${home}/data`,
      DENO_DIR: `${home}/cache/deno`,
      CI: "true",
    };
    for (
      const path of [
        env.TMPDIR!,
        env.XDG_CONFIG_HOME!,
        env.XDG_CACHE_HOME!,
        env.XDG_DATA_HOME!,
      ]
    ) {
      await Deno.mkdir(path, { mode: 0o700 });
    }
    if (agent?.provider === "claude" || agent?.provider === "deepseek") {
      const model = gateways.claude({ service: agent.provider, capability });
      active.push(model);
      const configDir = `${home}/claude`;
      await Deno.mkdir(configDir, { mode: 0o700 });
      Object.assign(
        env,
        buildBrokeredAnthropicEnvironment({
          service: agent.provider,
          mode: agent.authentication,
          capability,
          baseUrl: model.baseUrl,
          homeDir: home,
          configDir,
        }),
      );
    } else if (agent?.provider === "codex") {
      const model = gateways.codex({ mode: agent.authentication, capability });
      active.push(model);
      const codexHome = `${home}/codex`;
      await Deno.mkdir(codexHome, { mode: 0o700 });
      const profile = buildBrokeredCodexLaunch({
        mode: agent.authentication,
        capability,
        baseUrl: model.baseUrl,
        homeDir: home,
        codexHome,
      });
      await Deno.writeTextFile(`${codexHome}/config.toml`, profile.configToml, {
        createNew: true,
        mode: 0o600,
      });
      Object.assign(env, profile.env);
    } else if (agent?.provider === "gemini") {
      const model = gateways.gemini({ capability });
      active.push(model);
      Object.assign(
        env,
        buildBrokeredGeminiEnvironment({
          capability,
          baseUrl: model.baseUrl,
          homeDir: home,
        }),
      );
    }
    return { env, close };
  } catch {
    await close();
    throw new Error("Isolated job profile could not be prepared");
  }
}
