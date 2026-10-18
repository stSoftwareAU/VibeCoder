import { CONTAINER_RUNTIMES } from "../../lib/container_runtime.ts";
import { parseContainerManifest } from "../../lib/container_manifest.ts";
import { resolveContainerLaunchHostPaths } from "../../lib/container_launch.ts";

export async function brokerPlanFixture(
  kind: "docker" | "podman" | "apple-container" = "docker",
) {
  const root = await Deno.makeTempDir({ prefix: "broker-plan-" });
  const home = `${root}/home`;
  const paths = resolveContainerLaunchHostPaths(
    `${root}/checkout`,
    (name) => name === "HOME" ? home : undefined,
  );
  for (
    const path of [
      paths.baseDir,
      paths.logDir,
      paths.configStageDir,
      `${paths.credentialDir}/gh`,
      `${paths.credentialDir}/claude`,
      `${root}/broker-config`,
    ]
  ) {
    await Deno.mkdir(path, { recursive: true });
  }
  // A broker launch may never mount the original, unprojected host config.
  paths.configFile = `${root}/host-config.json`;
  await Deno.writeTextFile(paths.configFile, "{}");
  const manifest = parseContainerManifest(
    await Deno.readTextFile(
      new URL("../../../../container/tools.json", import.meta.url),
    ),
  );
  return {
    root,
    input: {
      descriptor: {
        ...CONTAINER_RUNTIMES[kind],
        platform: "linux" as const,
        probed: [kind],
      },
      manifest,
      image: "fixture:local",
      containerName: "fixture-worker",
      watchdogSeconds: 60,
      buildCommit: "unknown",
      hostPaths: paths,
    },
    config: `${root}/broker-config`,
    close: () => Deno.remove(root, { recursive: true }),
  };
}
