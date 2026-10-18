/** Narrow, explicit launch delta for the separate-container CI diagnostic. */
import type { ContainerLaunchPlan } from "../../lib/container_launch.ts";
import {
  buildMountArguments,
  CONTAINER_RUNTIMES,
  type ContainerMount,
  type ContainerRuntimeDescriptor,
} from "../../lib/container_runtime.ts";

/** Select the production Linux dialect for the diagnostic's runtime. */
export function containerProbeRuntime(
  kind = "docker",
): ContainerRuntimeDescriptor {
  if (kind !== "docker" && kind !== "podman") {
    throw new Error("Probe runtime must be docker or podman");
  }
  return { ...CONTAINER_RUNTIMES[kind], platform: "linux", probed: [] };
}

/** Runtime info uses different JSON fields in Docker and Podman. */
export function containerProbeSecurityInfo(
  descriptor: ContainerRuntimeDescriptor,
  info: unknown,
): unknown {
  const record = info as {
    host?: { security?: { rootless?: unknown } };
    SecurityOptions?: unknown;
  } | null;
  if (descriptor.kind === "podman") {
    if (record?.host?.security?.rootless !== true) {
      throw new Error(
        "Podman rootless prerequisite unavailable: host.security.rootless must be true",
      );
    }
    return record.host.security;
  }
  return record?.SecurityOptions;
}

/** The internal fixture bridge needs explicit address space in both families. */
export function containerProbeNetworkArgs(token: string): string[] {
  if (!/^[a-f0-9]{12}$/.test(token)) throw new Error("Invalid probe token");
  return [
    "network",
    "create",
    "--internal",
    "--ipv6",
    "--subnet",
    `10.${parseInt(token.slice(0, 2), 16)}.${
      parseInt(token.slice(2, 4), 16)
    }.0/24`,
    "--subnet",
    `fd${token.slice(0, 2)}:${token.slice(2, 6)}:${token.slice(6, 10)}::/64`,
    `vibe-container-${token}`,
  ];
}

export function separateContainerPlan(
  base: ContainerLaunchPlan,
  descriptor: ContainerRuntimeDescriptor,
  credentialRoot: string,
  socketVolume: string,
  network: string,
  readOnlySocket: boolean,
): ContainerLaunchPlan {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(socketVolume)) {
    throw new Error("Invalid probe socket volume");
  }
  if (
    readOnlySocket
      ? network !== "none"
      : !/^vibe-container-[a-f0-9]+$/.test(network)
  ) {
    throw new Error(
      "Probe network must be none for the agent or a disposable fixture bridge",
    );
  }
  const runArgs = [...base.runArgs];
  const deniedMounts = base.mounts.filter((mount) =>
    mount.target === credentialRoot ||
    mount.target.startsWith(`${credentialRoot}/`)
  );
  for (const mount of deniedMounts) {
    const parts = buildMountArguments(descriptor, mount);
    const index = runArgs.findIndex((_, start) =>
      parts.every((part, offset) => runArgs[start + offset] === part)
    );
    if (index < 0) {
      throw new Error("Credential mount was absent from the recorded plan");
    }
    runArgs.splice(index, parts.length);
  }
  const networkIndex = runArgs.indexOf("--network");
  if (networkIndex < 0 || runArgs.at(-1) !== base.image) {
    throw new Error("Unexpected production launch plan shape");
  }
  runArgs[networkIndex + 1] = network;
  const socketMount: ContainerMount = {
    source: socketVolume,
    target: "/run/broker",
    volume: true,
    readOnly: readOnlySocket,
  };
  runArgs.splice(-1, 0, ...buildMountArguments(descriptor, socketMount));
  const initArgs = [...base.initArgs];
  if (!readOnlySocket) {
    const imageIndex = initArgs.indexOf(base.image);
    if (imageIndex < 0) throw new Error("Missing volume initialisation image");
    initArgs.splice(
      imageIndex,
      0,
      ...buildMountArguments(descriptor, socketMount),
    );
    initArgs.push(socketMount.target);
  }
  return {
    ...base,
    runArgs,
    initArgs,
    mounts: [
      ...base.mounts.filter((mount) => !deniedMounts.includes(mount)),
      socketMount,
    ],
    volumes: [...base.volumes, socketVolume],
  };
}
