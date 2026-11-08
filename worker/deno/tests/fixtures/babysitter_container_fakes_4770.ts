/**
 * Shared fakes for the babysitter repair tests (Issue #4770): a generated App
 * key, a fake GitHub token exchange, a clone/scratch/exchange tree, a temp
 * worker checkout and home, a REAL launch plan built by
 * `buildLaunchPlanForCommand` over them (mounts, staged config and all), and
 * container deps that record every runtime spawn. Nothing here starts a
 * runtime process or reads the host's home.
 */
import type { ContainerLaunchPlan } from "../../lib/container_launch.ts";
import type { BabysitterContainerDeps } from "../../lib/fleet_babysitter_container.ts";
import type { FetchFn } from "../../lib/github_app_auth.ts";
import { buildLaunchPlanForCommand } from "../../commands/container_launch_plan.ts";
import { REPO_ROOT } from "./launcher_harness.ts";

/** A PKCS#8 RSA key, generated for the test. */
export async function generateTestKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const lines = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!;
  const header = "-----BEGIN " + "PRIVATE KEY-----";
  const footer = "-----END " + "PRIVATE KEY-----";
  return [header, ...lines, footer].join("\n") + "\n";
}

/** Run `run` with a generated test key written to a temp file, removed afterwards. */
export async function withTestKey(
  run: (privateKeyPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const privateKeyPath = `${dir}/app-key.pem`;
    await Deno.writeTextFile(privateKeyPath, await generateTestKeyPem());
    await run(privateKeyPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Fake GitHub token exchange: records each request, answers 201 with a token
 * and the given extra response fields (e.g. the granted `permissions`).
 */
export function fakeTokenExchange(
  response: Record<string, unknown>,
  requests: Array<{ url: string; body: unknown }>,
): FetchFn {
  return (url, init) => {
    requests.push({
      url: url.toString(),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          token: "ghs_agent_token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          ...response,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
  };
}

/** A clone, scratch and exchange directory under one canonical temp root. */
export async function repairDirs(): Promise<
  { root: string; dir: string; scratch: string; exchange: string }
> {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const dirs = {
    root,
    dir: `${root}/clone`,
    scratch: `${root}/scratch`,
    exchange: `${root}/exchange`,
  };
  for (const path of [dirs.dir, dirs.scratch, dirs.exchange]) {
    await Deno.mkdir(path);
  }
  return dirs;
}

/**
 * The temp inputs a real repair plan reads: `baseDir` is a git repo with the
 * container manifests and one tracked file (so `git ls-tree HEAD` works);
 * `home` holds the babysitter's config and one enabled provider credential
 * directory (claude). `root` is removed by the test.
 */
export interface RepairHost {
  root: string;
  baseDir: string;
  home: string;
}

/** Copy a directory tree of regular files and directories, synchronously. */
function copyTreeSync(src: string, dst: string): void {
  Deno.mkdirSync(dst, { recursive: true });
  for (const entry of Deno.readDirSync(src)) {
    const from = `${src}/${entry.name}`;
    const to = `${dst}/${entry.name}`;
    if (entry.isDirectory) copyTreeSync(from, to);
    else if (entry.isFile) Deno.copyFileSync(from, to);
  }
}

function gitSync(cwd: string, args: string[]): void {
  const out = new Deno.Command("git", {
    args: [
      "-C",
      cwd,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdout: "null",
    stderr: "piped",
  }).outputSync();
  if (!out.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
}

/** Build a {@link RepairHost}; `config` is written as the babysitter's config.json. */
export function repairHost(config: Record<string, unknown> = {}): RepairHost {
  const root = Deno.realPathSync(Deno.makeTempDirSync());
  const baseDir = `${root}/checkout`;
  // The whole container/ tree: the image tag hashes every enumerated input.
  copyTreeSync(`${REPO_ROOT}/container`, `${baseDir}/container`);
  Deno.writeTextFileSync(`${baseDir}/README.md`, "tracked\n");
  gitSync(baseDir, ["init", "-q"]);
  gitSync(baseDir, ["add", "."]);
  gitSync(baseDir, ["commit", "-q", "-m", "fixture"]);

  const home = `${root}/home`;
  Deno.mkdirSync(`${home}/.vibe-coder/credentials/claude`, {
    recursive: true,
  });
  Deno.writeTextFileSync(`${home}/config.json`, JSON.stringify(config));
  return { root, baseDir, home };
}

/** The environment the real plan reads: the host home, its config and credentials. */
function hostEnvironment(host: RepairHost): Record<string, string> {
  return {
    HOME: host.home,
    VIBE_CREDENTIAL_DIR: `${host.home}/.vibe-coder/credentials`,
    CONFIG_PATH: `${host.home}/config.json`,
    WORK_DIR: `${host.home}/work`,
  };
}

/**
 * A real launch plan for the repair, built by `buildLaunchPlanForCommand` over
 * the host: the worker checkout mount, the staged config, the log mount and the
 * enabled provider credential mount, as production builds them. `extraRunArgs`
 * go before the image.
 */
export async function repairPlan(
  host: RepairHost,
  containerName: string,
  extraRunArgs: string[] = [],
): Promise<ContainerLaunchPlan> {
  const environment = hostEnvironment(host);
  const plan = await buildLaunchPlanForCommand(host.baseDir, containerName, {
    env: (name) => environment[name],
    now: () => 1_900_000_000_000,
    probe: (candidate) =>
      Promise.resolve({
        available: true,
        path: `/usr/bin/${candidate.executable}`,
      }),
  });
  const runArgs = [...plan.runArgs];
  if (extraRunArgs.length > 0) {
    runArgs.splice(runArgs.lastIndexOf(plan.image), 0, ...extraRunArgs);
  }
  return { ...plan, runArgs };
}

/** One runtime process the repair started. */
export interface RuntimeSpawn {
  runtime: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

/**
 * Container deps that record each runtime spawn and report a clean exit. The
 * plan is real (see {@link repairPlan}) over `options.host`, or a fresh host.
 * The checkout the repair snapshots is that host's worker checkout. Egress
 * starts are stubbed, so no sidecar or Apple helper runs. The host environment
 * reader returns nothing unless `env` is given.
 */
export function fakeContainer(
  spawns: RuntimeSpawn[],
  options: {
    host?: RepairHost;
    env?: BabysitterContainerDeps["env"];
    extraRunArgs?: string[];
    /** Runs in place of the clean exit; its result is returned. */
    onSpawn?: (
      spawn: RuntimeSpawn,
    ) => Promise<{
      success: boolean;
      code: number;
      stderr: string;
      timedOut: boolean;
    }>;
  } = {},
): Partial<BabysitterContainerDeps> {
  const host = options.host ?? repairHost();
  return {
    env: options.env ?? (() => undefined),
    onPath: () => Promise.resolve(true),
    checkoutDir: () => host.baseDir,
    buildPlan: (_baseDir, containerName) =>
      repairPlan(host, containerName, options.extraRunArgs),
    imageExists: () => Promise.resolve(true),
    startSidecar: () => Promise.resolve(undefined),
    stopSidecar: () => Promise.resolve([]),
    startAppleEgress: (plan) =>
      Promise.resolve({
        runArgs: plan.runArgs,
        stop: () => Promise.resolve([]),
      }),
    spawn: (runtime, args, spawnOptions) => {
      const spawn: RuntimeSpawn = {
        runtime,
        args: [...args],
        env: { ...spawnOptions.env },
        timeoutMs: spawnOptions.timeoutMs,
      };
      spawns.push(spawn);
      return options.onSpawn?.(spawn) ??
        Promise.resolve({
          success: true,
          code: 0,
          stderr: "",
          timedOut: false,
        });
    },
  };
}
