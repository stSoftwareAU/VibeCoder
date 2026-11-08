/**
 * Shared fakes for the babysitter repair tests (Issue #4770): a generated App
 * key, a fake GitHub token exchange, a clone/scratch/exchange tree, a launch
 * plan carrying the fields the repair reads, and container deps that record
 * every runtime spawn. Nothing here starts a process or reads the host.
 */
import type { ContainerLaunchPlan } from "../../lib/container_launch.ts";
import type { BabysitterContainerDeps } from "../../lib/fleet_babysitter_container.ts";
import type { FetchFn } from "../../lib/github_app_auth.ts";

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
 * The fields of a launch plan that the repair reads (its runtime, image,
 * named volumes, run arguments and egress flags). The rest are unused here.
 */
export function repairPlan(
  containerName: string,
  extraRunArgs: string[] = [],
): ContainerLaunchPlan {
  const image = "vibe-coder:test";
  return {
    runtime: "podman",
    image,
    containerName,
    volumes: ["vibe-work"],
    resettableVolumes: [],
    imageInspectArgs: ["image", "inspect", image],
    egressEnforced: false,
    proxyName: "",
    runArgs: [
      "run",
      "--rm",
      "--name",
      containerName,
      "--volume",
      "vibe-work:/home/vibe/auto-issue-work",
      ...extraRunArgs,
      image,
    ],
  } as unknown as ContainerLaunchPlan;
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
 * host environment reader returns nothing unless `env` is given.
 */
export function fakeContainer(
  spawns: RuntimeSpawn[],
  options: {
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
  return {
    env: options.env ?? (() => undefined),
    onPath: () => Promise.resolve(true),
    buildPlan: (_baseDir, containerName) =>
      Promise.resolve(repairPlan(containerName, options.extraRunArgs)),
    imageExists: () => Promise.resolve(true),
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
