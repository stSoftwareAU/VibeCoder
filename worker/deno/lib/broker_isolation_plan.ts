/**
 * Host-owned worker/broker mount split (#3698, #3699).
 *
 * This is an integration building block, not a selectable normal launch mode.
 * Account provisioning, worker bootstrap, persisted-secret migration and write
 * policy must be connected before the ordinary launchers may call it.
 */
import {
  buildContainerLaunchPlan,
  type ContainerLaunchInputs,
  type ContainerLaunchPlan,
  containerTargetPaths,
  VOLUME_INIT_ENTRYPOINT,
} from "./container_launch.ts";
import {
  buildMountArguments,
  type ContainerMount,
} from "./container_runtime.ts";

export const BROKER_SERVICE_PATH = "/workspace/worker/deno/broker_service.ts";
export const BROKER_SOCKET_DIR = "/run/broker";
export const BROKER_CONFIG_DIR = "/run/broker-config";

export interface BrokerIsolationPlan {
  runtime: string;
  worker: ContainerLaunchPlan;
  broker: { name: string; mounts: ContainerMount[]; runArgs: string[] };
  socketVolume: string;
  privateVolume: string;
  privateRemoveArgs: string[];
  provisionArgs: string[];
  socketInitArgs: string[];
  socketRemoveArgs: string[];
  readinessArgs: string[];
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

async function canonical(path: string): Promise<string> {
  const real = (await Deno.realPath(path)).replaceAll("\\", "/").replace(
    /\/$/,
    "",
  );
  return /^[A-Za-z]:/.test(real) ? real.toLowerCase() : real;
}

/** Only trusted host inputs enter here; no worker request can build a plan. */
export async function buildBrokerIsolationPlan(
  inputs: ContainerLaunchInputs,
  options: { privateVolume: string; socketVolume: string },
): Promise<BrokerIsolationPlan> {
  inputs = structuredClone(inputs);
  options = structuredClone(options);
  if (inputs.descriptor.kind === "apple-container") {
    throw new Error("Apple broker boundary has not been validated");
  }
  if (inputs.containerName.length > 51) {
    throw new Error("Worker name leaves no room for broker lifecycle names");
  }
  const base = buildContainerLaunchPlan(inputs);
  if (
    options.socketVolume === options.privateVolume ||
    [options.socketVolume, options.privateVolume].some((volume) =>
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(volume) ||
      base.volumes.includes(volume)
    )
  ) {
    throw new Error(
      "Broker session volumes must be distinct, plain named volumes",
    );
  }
  const targets = containerTargetPaths(inputs.manifest);
  if (targets.base !== "/workspace") {
    throw new Error("Unsupported broker checkout target");
  }
  const credentials = base.mounts.filter((mount) =>
    mount.target === targets.credentials ||
    mount.target.startsWith(`${targets.credentials}/`)
  );
  const workerMounts = base.mounts.filter((mount) =>
    !credentials.includes(mount)
  );
  const originalConfig = await canonical(inputs.hostPaths.configFile);
  const privateSources = await Promise.all(
    credentials.map((mount) => canonical(mount.source)),
  );
  for (const mount of workerMounts) {
    if (mount.volume) continue;
    const source = await canonical(mount.source);
    if (overlaps(source, originalConfig)) {
      throw new Error("Original host configuration overlaps a worker mount");
    }
    if (
      privateSources.some((privateSource) => overlaps(source, privateSource))
    ) {
      throw new Error("A credential source overlaps a worker mount");
    }
  }
  const socket: ContainerMount = {
    source: options.socketVolume,
    target: BROKER_SOCKET_DIR,
    volume: true,
    readOnly: false,
  };
  // Remove the recorded mount pairs from the already-validated production
  // plan. Keep every privilege/tmpfs argument; only explicit mounts change.
  function withMounts(mounts: ContainerMount[]): string[] {
    const args = [...base.runArgs];
    for (const mount of base.mounts) {
      const parts = buildMountArguments(inputs.descriptor, mount);
      const index = args.findIndex((_, start) =>
        parts.every((part, offset) => args[start + offset] === part)
      );
      if (index < 0) {
        throw new Error("Production mount was absent from launch arguments");
      }
      args.splice(index, parts.length);
    }
    args.splice(
      -1,
      0,
      ...mounts.flatMap((mount) =>
        buildMountArguments(inputs.descriptor, mount)
      ),
    );
    return args;
  }
  const mounts = [...workerMounts, { ...socket, readOnly: true }];
  const workerArgs = withMounts(mounts);
  const network = workerArgs.indexOf("--network");
  if (network < 0) {
    throw new Error("Production OCI plan omitted its network mode");
  }
  workerArgs[network + 1] = "none";
  const privateConfig: ContainerMount = {
    source: options.privateVolume,
    target: BROKER_CONFIG_DIR,
    volume: true,
    readOnly: true,
  };
  const brokerMounts: ContainerMount[] = [
    base.mounts.find((mount) => mount.target === targets.base)!,
    privateConfig,
    socket,
  ];
  const brokerArgs = withMounts(brokerMounts);
  // The broker never runs the worker entrypoint, extension startup, config
  // loading or repository code. Its environment contains no worker settings.
  for (let i = brokerArgs.length - 2; i >= 0; i--) {
    if (brokerArgs[i] === "--env") brokerArgs.splice(i, 2);
  }
  const name = `${inputs.containerName}-broker`;
  brokerArgs[brokerArgs.indexOf("--name") + 1] = name;
  brokerArgs.splice(
    -1,
    0,
    "--entrypoint",
    "deno",
    "--env",
    "DENO_DIR=/tmp/broker-deno-cache",
    "--env",
    "DENO_NO_UPDATE_CHECK=1",
  );
  brokerArgs[brokerArgs.length - 1] = inputs.image;
  const serviceArgs = [
    "run",
    "--no-config",
    "--no-remote",
    "--allow-net",
    `--allow-read=${BROKER_CONFIG_DIR},${BROKER_SOCKET_DIR}`,
    `--allow-write=${BROKER_SOCKET_DIR}`,
    BROKER_SERVICE_PATH,
  ];
  brokerArgs.push(...serviceArgs, "serve");
  const provisionArgs = [...brokerArgs];
  const socketParts = buildMountArguments(inputs.descriptor, socket);
  const socketIndex = provisionArgs.findIndex((_, i) =>
    socketParts.every((part, offset) => provisionArgs[i + offset] === part)
  );
  provisionArgs.splice(socketIndex, socketParts.length);
  const privateParts = buildMountArguments(inputs.descriptor, privateConfig);
  const privateIndex = provisionArgs.findIndex((_, i) =>
    privateParts.every((part, offset) => provisionArgs[i + offset] === part)
  );
  provisionArgs.splice(
    privateIndex,
    privateParts.length,
    ...buildMountArguments(inputs.descriptor, {
      ...privateConfig,
      readOnly: false,
    }),
  );
  provisionArgs[provisionArgs.indexOf("--name") + 1] =
    `${inputs.containerName}-broker-stage`;
  provisionArgs[provisionArgs.indexOf("--network") + 1] = "none";
  // Deno's stdin is the only credential input, never an argument or env var.
  provisionArgs.splice(1, 0, "--interactive");
  provisionArgs.splice(provisionArgs.indexOf("--allow-net"), 1);
  provisionArgs[provisionArgs.indexOf(`--allow-write=${BROKER_SOCKET_DIR}`)] =
    `--allow-write=${BROKER_CONFIG_DIR}`;
  provisionArgs[provisionArgs.length - 1] = "stage";
  const socketInitArgs = [
    "run",
    "--rm",
    "--name",
    `${inputs.containerName}-broker-init`,
    "--network",
    "none",
    "--user",
    "0:0",
    "--entrypoint",
    VOLUME_INIT_ENTRYPOINT,
    ...buildMountArguments(inputs.descriptor, socket),
    ...buildMountArguments(inputs.descriptor, {
      ...privateConfig,
      readOnly: false,
    }),
    inputs.image,
    `${inputs.manifest.user.uid}:${inputs.manifest.user.gid}`,
    BROKER_SOCKET_DIR,
    BROKER_CONFIG_DIR,
  ];
  const workerInitArgs = [...base.initArgs];
  workerInitArgs.splice(1, 0, "--network", "none");
  return {
    runtime: base.runtime,
    worker: { ...base, mounts, runArgs: workerArgs, initArgs: workerInitArgs },
    broker: { name, mounts: brokerMounts, runArgs: brokerArgs },
    socketVolume: options.socketVolume,
    privateVolume: options.privateVolume,
    privateRemoveArgs: [
      ...inputs.descriptor.dialect.volumeRemoveArgs,
      options.privateVolume,
    ],
    provisionArgs,
    socketInitArgs,
    socketRemoveArgs: [
      ...inputs.descriptor.dialect.volumeRemoveArgs,
      options.socketVolume,
    ],
    readinessArgs: ["exec", name, "deno", ...serviceArgs, "probe"],
  };
}
