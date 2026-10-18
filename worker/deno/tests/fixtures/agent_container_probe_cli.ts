/** Real Docker prerequisite probe: hardened broker plus network-none agent. */
import {
  buildContainerLaunchPlan,
  type ContainerLaunchHostPaths,
  type ContainerLaunchPlan,
  containerTargetPaths,
  resolveContainerLaunchHostPaths,
} from "../../lib/container_launch.ts";
import { CONTAINER_RUNTIMES } from "../../lib/container_runtime.ts";
import { parseContainerManifest } from "../../lib/container_manifest.ts";
import { attemptRunArgs } from "../../lib/tabletop_container_runner.ts";
import { separateContainerPlan } from "../support/agent_container_plan.ts";
import {
  type AgentContainerEvidence,
  assertSeparateContainerEvidence,
  type BrokerWitness,
} from "../support/agent_container_evidence.ts";
import type { NamespaceEvidence } from "../support/agent_namespace_evidence.ts";

const repo = new URL("../../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const image = Deno.args[0];
if (!image || Deno.build.os !== "linux") {
  throw new Error("Usage on Linux: agent_container_probe_cli.ts <local-image>");
}
const manifest = parseContainerManifest(
  await Deno.readTextFile(`${repo}/container/tools.json`),
);
const descriptor = {
  ...CONTAINER_RUNTIMES.docker,
  platform: "linux" as const,
  probed: [],
};
const targets = containerTargetPaths(manifest);
const script =
  `${targets.base}/worker/deno/tests/fixtures/agent_container_process_probe.ts`;
const root = await Deno.makeTempDir({ prefix: "vibe-separated-host-" });
await Deno.chmod(root, 0o755);
const token = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const network = `vibe-container-${token}`;
const socketVolume = `${network}-socket`;
const roots: ContainerLaunchHostPaths[] = [];
const plans = ["broker", "agent"].map((role) => {
  const name = `${network}-${role}`;
  const paths = resolveContainerLaunchHostPaths(
    `${root}/${role}/checkout`,
    (key) => key === "HOME" ? `${root}/${role}/home` : undefined,
  );
  roots.push(paths);
  const base = buildContainerLaunchPlan({
    descriptor,
    manifest,
    image,
    containerName: name,
    watchdogSeconds: 300,
    buildCommit: "unknown",
    hostPaths: paths,
    resources: { memory: "2g", cpus: "1" },
    volumes: {
      work: `${name}-work`,
      approvalState: `${name}-approval`,
      agentState: `${name}-state`,
    },
  });
  return separateContainerPlan(
    base,
    descriptor,
    targets.credentials,
    socketVolume,
    role === "agent" ? "none" : network,
    role === "agent",
  );
});
const [brokerPlan, agentPlan] = plans as [
  ContainerLaunchPlan,
  ContainerLaunchPlan,
];
const shared = brokerPlan.mounts.filter((mount) =>
  agentPlan.mounts.some((other) => other.source === mount.source)
);
if (shared.length !== 1 || shared[0]?.source !== socketVolume) {
  throw new Error("Only the dedicated socket volume may be shared");
}
const volumes = [...new Set(plans.flatMap((plan) => plan.volumes))];

async function docker(
  args: string[],
  required = true,
): Promise<Deno.CommandOutput> {
  const output = await new Deno.Command(descriptor.executable, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(60_000),
  }).output();
  if (!output.success && required) {
    console.error(new TextDecoder().decode(output.stderr));
    throw new Error(
      `Docker ${
        args[0]
      } failed (${output.code}); prerequisite unavailable, no weaker retry`,
    );
  }
  return output;
}

const decode = (output: Deno.CommandOutput) =>
  new TextDecoder().decode(output.stdout).trim();
const denoArgs = (
  mode: string,
  args: string[] = [],
) => [
  "deno",
  "run",
  "--no-config",
  "--no-lock",
  "--allow-all",
  script,
  mode,
  ...args,
];
async function inside(mode: string): Promise<string> {
  return decode(
    await docker(["exec", brokerPlan.containerName, ...denoArgs(mode)]),
  );
}
function processArguments(
  plan: ContainerLaunchPlan,
  mode: string,
  args: string[],
): string[] {
  return attemptRunArgs(plan, plan.containerName, [], [
    "-c",
    'exec "$@"',
    "probe",
    ...denoArgs(mode, args),
  ]);
}
async function launch(
  plan: ContainerLaunchPlan,
  mode: string,
  args: string[],
): Promise<string> {
  return decode(await docker(processArguments(plan, mode, args)));
}

let networkCreated = false;
let brokerOutput: Promise<Deno.CommandOutput> | undefined;
let brokerResult: Deno.CommandOutput | undefined;
try {
  console.log(JSON.stringify({ date: new Date().toISOString() }));
  for (const paths of roots) {
    // Each role gets distinct, empty configuration/work/state. Credential
    // source directories are neither populated nor mounted at all.
    for (
      const path of [
        paths.homeDir,
        paths.baseDir,
        paths.workDir,
        paths.logDir,
        paths.configStageDir,
      ]
    ) {
      await Deno.mkdir(path, { recursive: true, mode: 0o755 });
    }
    await Deno.writeTextFile(`${paths.configStageDir}/.config.json`, "{}");
    for (
      const relative of [
        "lib/credential_broker.ts",
        "lib/credential_broker_policy.ts",
        "tests/support/agent_namespace_evidence.ts",
        "tests/support/agent_container_evidence.ts",
        "tests/fixtures/agent_namespace_container_probe.ts",
        "tests/fixtures/agent_container_process_probe.ts",
      ]
    ) {
      const target = `${paths.baseDir}/worker/deno/${relative}`;
      await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.copyFile(`${repo}/worker/deno/${relative}`, target);
    }
  }
  console.log(decode(await docker(["version"])));
  console.log(
    JSON.stringify({
      securityOptions: decode(
        await docker(["info", "--format", "{{json .SecurityOptions}}"]),
      ),
      image: decode(
        await docker(["image", "inspect", "--format", "{{.Id}}", image]),
      ),
    }),
  );
  // Internal bridge: fixtures need no internet. A missing IPv6 prerequisite
  // fails here; the probe never changes host sysctls or security profiles.
  const subnet = `fd${token.slice(0, 2)}:${token.slice(2, 6)}:${
    token.slice(6, 10)
  }::/64`;
  await docker([
    "network",
    "create",
    "--internal",
    "--ipv6",
    "--subnet",
    subnet,
    network,
  ]);
  networkCreated = true;
  console.log(
    JSON.stringify({
      fixtureNetwork: decode(
        await docker(["network", "inspect", network, "--format", "{{json .}}"]),
      ),
    }),
  );
  for (const volume of volumes) await docker(["volume", "create", volume]);
  for (const plan of plans) {
    await docker(plan.initArgs);
    console.log(
      JSON.stringify({
        role: plan === brokerPlan ? "broker" : "agent",
        runArgs: plan.runArgs,
      }),
    );
  }
  // Keep the Docker client attached so startup errors survive --rm. Its
  // captured output contains fixture status only, never the generated secret.
  const brokerProcess = new Deno.Command(descriptor.executable, {
    args: processArguments(brokerPlan, "broker", [targets.credentials]),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(180_000),
  }).spawn();
  brokerOutput = brokerProcess.output().then((result) => {
    brokerResult = result;
    return result;
  });
  let metadata = "";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (brokerResult) break;
    const ready = await docker([
      "exec",
      brokerPlan.containerName,
      ...denoArgs("metadata"),
    ], false);
    if (ready.success) {
      metadata = decode(ready);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!metadata) {
    throw new Error(
      "Broker did not become ready; check IPv6/socket prerequisites",
    );
  }
  const before = JSON.parse(await inside("control")) as NamespaceEvidence;
  console.log(JSON.stringify({ phase: "before-control", evidence: before }));
  let isolated: AgentContainerEvidence;
  let after: NamespaceEvidence;
  try {
    isolated = JSON.parse(
      await launch(agentPlan, "agent", [metadata]),
    ) as AgentContainerEvidence;
    console.log(
      JSON.stringify({ phase: "isolated-agent", evidence: isolated }),
    );
  } finally {
    after = JSON.parse(await inside("control")) as NamespaceEvidence;
    console.log(JSON.stringify({ phase: "after-control", evidence: after }));
  }
  const witness = JSON.parse(await inside("witness")) as BrokerWitness;
  console.log(
    JSON.stringify({ phase: "broker-credential-witness", evidence: witness }),
  );
  assertSeparateContainerEvidence(before, isolated, after, witness);
  await docker(["stop", "--time", "5", brokerPlan.containerName]);
  const stopped = JSON.parse(
    await launch(agentPlan, "broker-stopped", [metadata]),
  );
  if (stopped.brokerTransportUnavailable !== true) {
    throw new Error("Broker shutdown lacked transport refusal evidence");
  }
  console.log(JSON.stringify({ phase: "broker-stopped", evidence: stopped }));
  console.log(
    "PASS: separate hardened Docker containers deny direct IPv4/IPv6 and hide the planted credential while synthetic broker requests work; native CLI/OAuth/Apple acceptance remains unproved",
  );
} finally {
  for (const plan of plans) {
    await docker(["rm", "--force", plan.containerName], false);
  }
  if (brokerOutput) {
    const result = await brokerOutput;
    console.log(decode(result));
    const stderr = new TextDecoder().decode(result.stderr).trim();
    if (stderr) console.error(stderr);
  }
  for (const volume of volumes) {
    await docker(["volume", "rm", "--force", volume], false);
  }
  if (networkCreated) await docker(["network", "rm", network], false);
  await Deno.remove(root, { recursive: true });
}
