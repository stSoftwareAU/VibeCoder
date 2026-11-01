/** Interactive preflight and optional macOS launch agent for the PR babysitter. */
import { loadConfig } from "../lib/config.ts";
import { installConsoleRedaction } from "../lib/console_redaction.ts";
import {
  generateAppJWT,
  getInstallationToken,
} from "../lib/github_app_auth.ts";
import { runGhCommand } from "../lib/github.ts";
import {
  configureBabysitterLockTrust,
  writeBabysitterAppConfig,
} from "../lib/fleet_babysitter_app.ts";
import { fetchWithTimeout, runWithTimeout } from "../lib/subprocess_timeout.ts";
import { escapeXml } from "../lib/xml_escape.ts";
import {
  listBabysitterRepositories,
  selectBabysitterInstallation,
  selectBabysitterRepositories,
} from "../lib/fleet_babysitter_repositories.ts";

const REQUIRED_PERMISSIONS: Readonly<Record<string, string>> = {
  actions: "read",
  checks: "read",
  contents: "write",
  issues: "write",
  pull_requests: "write",
  statuses: "read",
  workflows: "write",
};
const LABEL = "au.com.stsoftware.fleet-pr-babysitter";
/** Build a launchd job; caller decides if and when to install it. */
export function launchAgentPlist(
  input: { checkout: string; deno: string; home: string; ghConfigDir?: string },
): string {
  const e = escapeXml;
  const runner = `${input.checkout}/fleet-pr-babysitter/run.sh`;
  const path =
    `${input.home}/.deno/bin:${input.home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  const ghConfig = input.ghConfigDir
    ? `<key>GH_CONFIG_DIR</key><string>${e(input.ghConfigDir)}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array><string>/bin/bash</string><string>${
    e(runner)
  }</string></array>\n<key>WorkingDirectory</key><string>${
    e(input.checkout)
  }</string>\n<key>EnvironmentVariables</key><dict><key>HOME</key><string>${
    e(input.home)
  }</string><key>PATH</key><string>${
    e(path)
  }</string><key>DENO_EXECUTABLE</key><string>${
    e(input.deno)
  }</string>${ghConfig}</dict>\n<key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer>\n<key>StandardOutPath</key><string>/dev/null</string>\n<key>StandardErrorPath</key><string>/dev/null</string>\n</dict></plist>\n`;
}

/** List missing or insufficient App installation permissions. */
export function missingAppPermissions(
  granted: Record<string, string> | undefined,
): string[] {
  return Object.entries(REQUIRED_PERMISSIONS).filter(([name, level]) => {
    const actual = granted?.[name];
    return level === "write"
      ? actual !== "write"
      : actual !== "read" && actual !== "write";
  }).map(([name, level]) => `${name}: ${level}`);
}
async function command(name: string, args: string[]): Promise<string> {
  const result = await runWithTimeout(name, args, { timeoutMs: 30_000 });
  if (!result.ok) throw result.error;
  if (!result.value.success) {
    throw new Error(`${name} failed: ${result.value.stderr.trim()}`);
  }
  return result.value.stdout.trim();
}
function argument(name: string): string | undefined {
  return Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.slice(
    name.length + 3,
  );
}
function input(name: string, defaultValue = ""): string {
  const supplied = argument(name);
  if (supplied !== undefined) return supplied.trim();
  return (prompt(`${name}${defaultValue ? ` [${defaultValue}]` : ""}:`)
    ?.trim() || defaultValue);
}
function expandHome(path: string, home: string): string {
  return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}
async function main(): Promise<number> {
  const installFlag = Deno.args.includes("--install-launch-agent");
  const checkOnly = Deno.args.includes("--check");
  if (
    Deno.args.some((a) =>
      a !== "--install-launch-agent" && a !== "--check" &&
      !["--app-id=", "--installation-id=", "--key="].some((p) =>
        a.startsWith(p)
      )
    ) ||
    (installFlag && checkOnly)
  ) {
    throw new Error(
      "Usage: setup [--app-id=ID] [--installation-id=ID] [--key=PATH] [--check | --install-launch-agent]",
    );
  }
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME is not set");
  const checkout = decodeURIComponent(
    new URL("../../..", import.meta.url).pathname,
  ).replace(
    /\/$/,
    "",
  );
  const configPath = Deno.env.get("CONFIG_PATH") ?? `${checkout}/.config.json`;
  const config = await loadConfig(configPath);
  if (!config.repos.length) {
    throw new Error("No monitored repos in .config.json");
  }
  for (const binary of ["git", "codex", "rtk"]) {
    await command(binary, ["--version"]);
  }
  await runGhCommand(["--version"]);
  if (checkOnly && !argument("app-id")) {
    throw new Error("--check requires --app-id");
  }
  console.log(
    "Enter the App ID from the GitHub App's General settings. The installation will be discovered automatically.",
  );
  const appId = input("app-id");
  const requestedInstallation = argument("installation-id");
  const defaultKey = `${home}/.vibe-coder/fleet-pr-babysitter.private-key.pem`;
  const key = await Deno.realPath(expandHome(
    checkOnly ? argument("key") ?? defaultKey : input("key", defaultKey),
    home,
  ));
  if (
    !/^[1-9]\d*$/.test(appId) ||
    (requestedInstallation !== undefined &&
      !/^[1-9]\d*$/.test(requestedInstallation))
  ) {
    throw new Error("App ID and installation ID must be positive numbers");
  }
  const keyInfo = await Deno.stat(key);
  if (!keyInfo.isFile) throw new Error("Private key is not a file");
  if (keyInfo.mode !== null && (keyInfo.mode & 0o077) !== 0) {
    throw new Error(
      `Private key permissions are too broad: run chmod 600 on ${key}`,
    );
  }
  const jwt = await generateAppJWT(appId, await Deno.readTextFile(key));
  const appResponse = await fetchWithTimeout("https://api.github.com/app", {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "fleet-pr-babysitter-setup",
    },
  });
  if (!appResponse.ok) {
    throw new Error(`App identity check failed: HTTP ${appResponse.status}`);
  }
  const app = await appResponse.json();
  if (String(app.id) !== appId || typeof app.slug !== "string") {
    throw new Error("GitHub returned an unexpected App identity");
  }
  const installations: { id: number; account?: { login?: string } }[] = [];
  let complete = false;
  for (let page = 1; page <= 100; page++) {
    const response = await fetchWithTimeout(
      `https://api.github.com/app/installations?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "fleet-pr-babysitter-setup",
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `App installation discovery failed: HTTP ${response.status}`,
      );
    }
    const rows = await response.json();
    if (!Array.isArray(rows)) {
      throw new Error("App installation discovery returned malformed data");
    }
    installations.push(...rows);
    if (rows.length < 100) {
      complete = true;
      break;
    }
  }
  if (!complete) throw new Error("App installation list is incomplete");
  const installation = selectBabysitterInstallation(
    installations,
    config.repos,
    requestedInstallation,
  );
  const installationId = String(installation.id);
  console.log(
    `Found App installation ${installationId} for ${
      installation.account!.login
    }.`,
  );
  const minted = await getInstallationToken(jwt, installationId);
  const missing = missingAppPermissions(minted.permissions);
  if (missing.length) {
    throw new Error(
      `App installation lacks permissions: ${missing.join(", ")}`,
    );
  }
  const accessible = await listBabysitterRepositories(minted.token);
  const monitored = selectBabysitterRepositories(config.repos, accessible);
  console.log(
    `Babysitter will monitor ${monitored.length} of ${config.repos.length} configured repositories.`,
  );
  const check = await fetchWithTimeout("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${minted.token}`,
      "Content-Type": "application/json",
      "User-Agent": "fleet-pr-babysitter-setup",
    },
    body: JSON.stringify({
      query: "query { rateLimit { limit remaining resetAt } }",
    }),
  });
  if (!check.ok) {
    throw new Error(`App GraphQL check failed: HTTP ${check.status}`);
  }
  const data = await check.json();
  if (data.errors || !data.data?.rateLimit) {
    throw new Error("App GraphQL quota response was invalid");
  }
  console.log(
    `App ${app.slug}[bot]: authentication and permissions OK; GraphQL remaining ${data.data.rateLimit.remaining}/${data.data.rateLimit.limit}, resets ${data.data.rateLimit.resetAt}`,
  );
  const bot = `${app.slug}[bot]`;
  if (!checkOnly) {
    await writeBabysitterAppConfig(home, {
      appId,
      installationId,
      privateKeyPath: key,
    });
    console.log(
      "Saved babysitter App configuration; run.sh will use this App's quota.",
    );
    const updated = await configureBabysitterLockTrust(configPath, bot);
    console.log(
      updated
        ? `Configured local branch-lock trust for ${bot}.`
        : `Local branch-lock trust for ${bot} was already configured.`,
    );
  }
  const currentConfig = checkOnly ? config : await loadConfig(configPath);
  const authors = [
    ...currentConfig.fleetPrAuthors,
    ...currentConfig.serviceAccounts,
  ];
  if (!authors.some((a) => a.toLowerCase() === bot.toLowerCase())) {
    console.log(
      `ACTION: ${bot} is not trusted for branch locks on this host; check environment overrides.`,
    );
  }
  console.log(`Every fleet host must recognise ${bot} before App-based fixes.`);
  const install = installFlag ||
    (!checkOnly && Deno.build.os === "darwin" &&
      confirm(
        "Install and start a launch agent now? Choose no until you have manually tested a fix.",
      ));
  if (!install) {
    console.log(
      "No launch agent was installed or started. After a manual test, run this setup again with --install-launch-agent on the always-on Mac.",
    );
    return 0;
  }
  if (Deno.build.os !== "darwin") {
    throw new Error("Launch agents require macOS");
  }
  if (
    [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_APP_ID",
      "GITHUB_APP_INSTALLATION_ID",
      "GITHUB_APP_PRIVATE_KEY_PATH",
    ].some((k) => Deno.env.get(k))
  ) {
    throw new Error(
      "Unset temporary GitHub token/App environment variables before installing: launchd will not inherit them",
    );
  }
  if (!authors.some((a) => a.toLowerCase() === bot.toLowerCase())) {
    throw new Error(
      `App identity ${bot} is not a trusted fleet identity on this host; it must also be trusted on every other fleet host`,
    );
  }
  console.log(
    `The launch agent will run fixes as ${bot}. Confirm you have manually tested a fix and configured this App as a trusted lock author on every host.`,
  );
  if (
    prompt("Type INSTALL to create and start the launch agent:") !== "INSTALL"
  ) {
    console.log("Cancelled; no launch agent installed.");
    return 1;
  }
  const agentDir = `${home}/Library/LaunchAgents`;
  const logDir = `${home}/.vibe-coder/fleet-pr-babysitter`;
  await Deno.mkdir(agentDir, { recursive: true });
  await Deno.mkdir(logDir, { recursive: true });
  const plist = `${agentDir}/${LABEL}.plist`;
  await Deno.writeTextFile(
    plist,
    launchAgentPlist({
      checkout,
      deno: Deno.execPath(),
      home,
      ghConfigDir: Deno.env.get("GH_CONFIG_DIR"),
    }),
    { createNew: true, mode: 0o600 },
  );
  const uid = await command("id", ["-u"]);
  try {
    await command("launchctl", ["bootstrap", `gui/${uid}`, plist]);
  } catch (error) {
    throw new Error(
      `Launch agent file created at ${plist}, but bootstrap failed: ${error}`,
    );
  }
  console.log(`Installed and started ${plist}. Logs: ${logDir}/logs`);
  console.log(`Stop: launchctl bootout gui/${uid}/${LABEL}`);
  return 0;
}
if (import.meta.main) {
  installConsoleRedaction();
  try {
    Deno.exitCode = await main();
  } catch (error) {
    console.error(
      `Setup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exitCode = 1;
  }
}
