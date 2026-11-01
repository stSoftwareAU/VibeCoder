import { parseContainerManifest } from "./container_manifest.ts";
import type { FetchFn } from "./github_app_auth.ts";
import {
  BABYSITTER_CODEX_FLOOR,
  codexVersionMeetsFloor,
  readCodexVersion,
} from "./fleet_babysitter_sandbox.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

/**
 * Self-installing Codex CLI for the fleet PR babysitter.
 *
 * The babysitter runs unattended on a host, so a missing or too-old `codex`
 * must not stop it. When the CLI on PATH is below the floor it installs the
 * version pinned in `container/tools.json` — the same pin the container
 * build uses — from the GitHub release, verifying each archive against the
 * pinned SHA-256 before extracting it. Nothing floating is resolved.
 *
 * The install lives under `~/.vibe-coder/codex/<version>-<target>/`, outside
 * the `~/.vibe-coder/fleet-pr-babysitter*` paths the agent sandbox denies, and
 * the code-mode host is installed next to the CLI, as the container does.
 */

const RELEASES = "https://github.com/openai/codex/releases/download";
const CODE_MODE_HOST = "codex-code-mode-host";

export interface CodexInstallDeps {
  /** `<binary> --version` output; rejects when the binary cannot run. */
  readVersion: (binary: string) => Promise<string>;
  fetchFn: FetchFn;
  manifestPath: string;
  /** `Deno.build.os` and `Deno.build.arch` of the host. */
  os: string;
  arch: string;
}

function defaultDeps(): CodexInstallDeps {
  return {
    readVersion: readCodexVersion,
    fetchFn: globalThis.fetch,
    manifestPath: decodeURIComponent(
      new URL("../../../container/tools.json", import.meta.url).pathname,
    ),
    os: Deno.build.os,
    arch: Deno.build.arch,
  };
}

/** Release target and pin lookup for the host platform. */
function hostTarget(os: string, arch: string) {
  const manifestArch = arch === "x86_64"
    ? "amd64"
    : arch === "aarch64"
    ? "arm64"
    : undefined;
  if (manifestArch && os === "darwin") {
    return {
      target: `${arch}-apple-darwin`,
      pin: (
        pins: {
          sha256: Record<string, string>;
          hostSha256?: Record<string, string>;
        },
      ) => pins.hostSha256?.[`darwin-${manifestArch}`],
    };
  }
  if (manifestArch && os === "linux") {
    return {
      target: `${arch}-unknown-linux-musl`,
      pin: (pins: { sha256: Record<string, string> }) =>
        pins.sha256[manifestArch],
    };
  }
  throw new Error(
    `Cannot install Codex CLI for the babysitter on ${os}/${arch}`,
  );
}

async function versionOrUndefined(
  deps: CodexInstallDeps,
  binary: string,
): Promise<string | undefined> {
  try {
    return await deps.readVersion(binary);
  } catch {
    return undefined;
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Download, verify and extract `<name>-<target>` into `dir` as `name`. */
async function installAsset(
  deps: CodexInstallDeps,
  url: string,
  checksum: string,
  name: string,
  target: string,
  dir: string,
): Promise<void> {
  const response = await deps.fetchFn(url);
  if (!response.ok) {
    throw new Error(`Download of ${url} failed: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = await sha256Hex(bytes);
  if (actual !== checksum) {
    throw new Error(
      `Checksum mismatch for ${url}: expected ${checksum}, got ${actual}`,
    );
  }
  const archive = `${dir}/${name}.tar.gz`;
  await Deno.writeFile(archive, bytes);
  const extracted = await runWithTimeout("tar", ["-xzf", archive, "-C", dir], {
    timeoutMs: 120_000,
  });
  if (!extracted.ok) throw extracted.error;
  if (!extracted.value.success) {
    throw new Error(`tar failed for ${url}: ${extracted.value.stderr.trim()}`);
  }
  await Deno.remove(archive);
  await Deno.rename(`${dir}/${name}-${target}`, `${dir}/${name}`);
  await Deno.chmod(`${dir}/${name}`, 0o755);
}

/**
 * Return the Codex executable the babysitter should run: `codex` from PATH
 * when it meets the floor, otherwise the pinned install, downloading it first
 * when it is not already present.
 */
export async function ensureBabysitterCodex(
  home: string,
  deps: CodexInstallDeps = defaultDeps(),
): Promise<string> {
  const onPath = await versionOrUndefined(deps, "codex");
  if (onPath !== undefined && codexVersionMeetsFloor(onPath)) return "codex";

  const { target, pin } = hostTarget(deps.os, deps.arch);
  const manifest = parseContainerManifest(
    await Deno.readTextFile(deps.manifestPath),
  );
  const codex = manifest.providers.find((provider) => provider.id === "codex");
  const cliSum = codex && pin(codex);
  const hostSum = codex?.codeModeHost && pin(codex.codeModeHost);
  if (!codex || !cliSum || !hostSum) {
    throw new Error(`container/tools.json pins no Codex CLI for ${target}`);
  }
  const root = `${home}/.vibe-coder/codex`;
  const dir = `${root}/${codex.version}-${target}`;
  const installed = `${dir}/codex`;
  const existing = await versionOrUndefined(deps, installed);
  if (existing !== undefined && codexVersionMeetsFloor(existing)) {
    return installed;
  }

  console.log(
    `Codex CLI on PATH is ${
      onPath === undefined ? "missing" : JSON.stringify(onPath)
    }; installing pinned ${codex.version} for ${target}`,
  );
  await Deno.mkdir(root, { recursive: true });
  const staging = await Deno.makeTempDir({ dir: root, prefix: ".install-" });
  try {
    const base = `${RELEASES}/rust-v${codex.version}`;
    await installAsset(
      deps,
      `${base}/codex-${target}.tar.gz`,
      cliSum,
      "codex",
      target,
      staging,
    );
    await installAsset(
      deps,
      `${base}/${CODE_MODE_HOST}-${target}.tar.gz`,
      hostSum,
      CODE_MODE_HOST,
      target,
      staging,
    );
    const version = await deps.readVersion(`${staging}/codex`);
    if (!codexVersionMeetsFloor(version)) {
      throw new Error(
        `Installed Codex reports ${
          JSON.stringify(version)
        }, below ${BABYSITTER_CODEX_FLOOR}`,
      );
    }
    // A broken earlier install (or a concurrent one) may already hold the
    // directory; replace it unless a concurrent install just completed.
    const raced = await versionOrUndefined(deps, installed);
    if (raced !== undefined && codexVersionMeetsFloor(raced)) {
      return installed;
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    await Deno.rename(staging, dir);
    console.log(`Installed ${version} at ${installed}`);
    return installed;
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }
}
