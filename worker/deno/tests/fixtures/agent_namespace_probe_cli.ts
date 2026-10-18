/** Run the namespace prerequisite probe using the production Docker plan. */
import {
  buildContainerLaunchPlan,
  containerTargetPaths,
  resolveContainerLaunchHostPaths,
} from "../../lib/container_launch.ts";
import { CONTAINER_RUNTIMES } from "../../lib/container_runtime.ts";
import { parseContainerManifest } from "../../lib/container_manifest.ts";
import { attemptRunArgs } from "../../lib/tabletop_container_runner.ts";

const repo = new URL("../../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const image = Deno.args[0];
if (!image || Deno.build.os !== "linux") {
  throw new Error("Usage on Linux: agent_namespace_probe_cli.ts <local-image>");
}
const manifest = parseContainerManifest(
  await Deno.readTextFile(`${repo}/container/tools.json`),
);
const descriptor = {
  ...CONTAINER_RUNTIMES.docker,
  platform: "linux" as const,
  probed: [],
};
const root = await Deno.makeTempDir({ prefix: "vibe-namespace-host-" });
await Deno.chmod(root, 0o755);
const token = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const hostPaths = resolveContainerLaunchHostPaths(
  `${root}/checkout`,
  (name) => name === "HOME" ? `${root}/home` : undefined,
);
const name = `vibe-namespace-${token}`;
const plan = buildContainerLaunchPlan({
  descriptor,
  manifest,
  image,
  containerName: name,
  watchdogSeconds: 300,
  buildCommit: "unknown",
  hostPaths,
  resources: { memory: "2g", cpus: "2" },
  volumes: {
    work: `${name}-work`,
    approvalState: `${name}-approval`,
    agentState: `${name}-agent`,
  },
});

async function docker(args: string[], required = true): Promise<void> {
  const child = new Deno.Command(descriptor.executable, {
    args,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
    signal: AbortSignal.timeout(120_000),
  }).spawn();
  const result = await child.status;
  if (!result.success && required) {
    throw new Error(`Docker ${args[0]} failed (${result.code})`);
  }
}

try {
  for (
    const path of [
      hostPaths.homeDir,
      hostPaths.baseDir,
      hostPaths.workDir,
      hostPaths.logDir,
      hostPaths.configStageDir,
      hostPaths.credentialDir,
    ]
  ) {
    await Deno.mkdir(path, { recursive: true, mode: 0o755 });
  }
  await Deno.writeTextFile(`${hostPaths.configStageDir}/.config.json`, "{}");
  // Only committed probe modules are mounted. No real configuration, .git,
  // credential directory or host home is exposed to this validation run.
  for (
    const relative of [
      "lib/credential_broker.ts",
      "lib/credential_broker_policy.ts",
      "tests/support/agent_namespace_evidence.ts",
      "tests/fixtures/agent_namespace_container_probe.ts",
    ]
  ) {
    const target = `${hostPaths.baseDir}/worker/deno/${relative}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.copyFile(`${repo}/worker/deno/${relative}`, target);
  }
  await docker(["version"]);
  await docker(["info", "--format", "{{json .SecurityOptions}}"]);
  await docker(["image", "inspect", "--format", "{{.Id}}", image]);
  for (const volume of plan.volumes) await docker(["volume", "create", volume]);
  await docker(plan.initArgs);
  const targets = containerTargetPaths(manifest);
  const script =
    `${targets.base}/worker/deno/tests/fixtures/agent_namespace_container_probe.ts`;
  console.log(JSON.stringify({ productionRunArgs: plan.runArgs }));
  await docker(attemptRunArgs(plan, name, [], [
    "-c",
    'exec deno run --no-config --no-lock --allow-all "$1"',
    "probe",
    script,
  ]));
} finally {
  // Cleanup names are all per-run. A failure remains a failure even when the
  // runtime can no longer clean up; the hosted runner is disposable too.
  await docker(["rm", "--force", name], false);
  for (const volume of plan.volumes) {
    await docker(["volume", "rm", "--force", volume], false);
  }
  await Deno.remove(root, { recursive: true });
}
