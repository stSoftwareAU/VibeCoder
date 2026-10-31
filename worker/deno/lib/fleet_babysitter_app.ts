/** Mandatory GitHub App authentication for the fleet babysitter. */
import { ensureValidToken, generateAppJWT } from "./github_app_auth.ts";
import { fetchWithTimeout } from "./subprocess_timeout.ts";

export interface BabysitterAppConfig {
  appId: string;
  installationId: string;
  privateKeyPath: string;
}

export function appConfigPath(home: string): string {
  return `${home}/.vibe-coder/fleet-pr-babysitter/app.json`;
}

export function parseBabysitterAppConfig(value: unknown): BabysitterAppConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid babysitter App configuration");
  }
  const config = value as Record<string, unknown>;
  if (
    typeof config.appId !== "string" || !/^[1-9]\d*$/.test(config.appId) ||
    typeof config.installationId !== "string" ||
    !/^[1-9]\d*$/.test(config.installationId) ||
    typeof config.privateKeyPath !== "string" ||
    !config.privateKeyPath.startsWith("/")
  ) {
    throw new Error(
      "Invalid babysitter App configuration: expected App ID, installation ID and absolute private-key path",
    );
  }
  return {
    appId: config.appId,
    installationId: config.installationId,
    privateKeyPath: config.privateKeyPath,
  };
}

export async function readBabysitterAppConfig(
  home: string,
): Promise<BabysitterAppConfig> {
  const path = appConfigPath(home);
  try {
    return parseBabysitterAppConfig(JSON.parse(await Deno.readTextFile(path)));
  } catch (error) {
    throw new Error(
      `Cannot read babysitter App configuration at ${path}; run fleet-pr-babysitter/setup.sh: ${error}`,
    );
  }
}

/** Save non-secret App settings after setup verifies the installation. */
export async function writeBabysitterAppConfig(
  home: string,
  config: BabysitterAppConfig,
): Promise<void> {
  const verified = parseBabysitterAppConfig(config);
  const dir = `${home}/.vibe-coder/fleet-pr-babysitter`;
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = await Deno.makeTempFile({ dir, prefix: ".app-config-" });
  try {
    await Deno.writeTextFile(
      temporary,
      `${JSON.stringify(verified, null, 2)}\n`,
      { mode: 0o600 },
    );
    await Deno.rename(temporary, appConfigPath(home));
  } finally {
    await Deno.remove(temporary).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.error(`Could not remove temporary App configuration: ${error}`);
      }
    });
  }
}

/** Verify the signing key's actual App identity before trusting its bot name. */
export async function babysitterAppIdentity(
  config: BabysitterAppConfig,
): Promise<string> {
  const info = await Deno.stat(config.privateKeyPath);
  if (!info.isFile || (info.mode !== null && (info.mode & 0o077) !== 0)) {
    throw new Error(
      "Babysitter App private key must be a file readable only by its owner",
    );
  }
  const jwt = await generateAppJWT(
    config.appId,
    await Deno.readTextFile(config.privateKeyPath),
  );
  const response = await fetchWithTimeout("https://api.github.com/app", {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "fleet-pr-babysitter",
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub App identity check failed: HTTP ${response.status}`,
    );
  }
  const app = await response.json();
  if (
    String(app.id) !== config.appId || typeof app.slug !== "string" ||
    !/^[a-zA-Z0-9-]+$/.test(app.slug)
  ) {
    throw new Error("GitHub returned an invalid babysitter App identity");
  }
  return `${app.slug}[bot]`;
}

/** Start fail-closed, refreshing the installation token before it expires. */
export async function startBabysitterAppAuth(
  config: BabysitterAppConfig,
  mint?: () => Promise<string>,
  refreshMs = 5 * 60_000,
  repositories?: readonly string[],
): Promise<() => void> {
  // Do not let the generic gh wrapper replace this token or fall back to a
  // signed-in user when its own best-effort App minting fails.
  for (
    const name of [
      "GITHUB_APP_ID",
      "GITHUB_APP_INSTALLATION_ID",
      "GITHUB_APP_PRIVATE_KEY_PATH",
      "GITHUB_TOKEN",
    ]
  ) Deno.env.delete(name);
  Deno.env.set("GH_TOKEN", "babysitter-app-auth-unavailable");
  const refresh = async () => {
    try {
      const token = await (mint ? mint() : ensureValidToken(
        config.appId,
        config.installationId,
        config.privateKeyPath,
        globalThis.fetch,
        repositories,
      ));
      if (!token) throw new Error("GitHub App token was empty");
      Deno.env.set("GH_TOKEN", token);
    } catch (error) {
      Deno.env.set("GH_TOKEN", "babysitter-app-auth-unavailable");
      throw error;
    }
  };
  await refresh();
  const timer = setInterval(() => {
    refresh().catch((error) =>
      console.error(`Babysitter App authentication refresh failed: ${error}`)
    );
  }, refreshMs);
  return () => clearInterval(timer);
}
