/** Real Docker/Podman prerequisite probe: hardened broker plus network-none agent. */
import {
  buildContainerLaunchPlan,
  type ContainerLaunchHostPaths,
  type ContainerLaunchPlan,
  containerTargetPaths,
  resolveContainerLaunchHostPaths,
} from "../../lib/container_launch.ts";
import { parseContainerManifest } from "../../lib/container_manifest.ts";
import { attemptRunArgs } from "../../lib/tabletop_container_runner.ts";
import {
  containerProbeNetworkArgs,
  containerProbeRuntime,
  containerProbeSecurityInfo,
  separateContainerPlan,
} from "../support/agent_container_plan.ts";
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
  throw new Error(
    "Usage on Linux: agent_container_probe_cli.ts <local-image> [docker|podman]",
  );
}
const manifest = parseContainerManifest(
  await Deno.readTextFile(`${repo}/container/tools.json`),
);
const descriptor = containerProbeRuntime(Deno.args[1]);
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

async function runtime(
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
      `${descriptor.displayName} ${
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
    await runtime(["exec", brokerPlan.containerName, ...denoArgs(mode)]),
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
  return decode(await runtime(processArguments(plan, mode, args)));
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
        "lib/github_broker_reads.ts",
        "lib/anthropic_agent_gateway.ts",
        "lib/github_agent_gateway.ts",
        "lib/gemini_agent_gateway.ts",
        "lib/codex_agent_gateway.ts",
        "tests/support/agent_namespace_evidence.ts",
        "tests/support/agent_container_evidence.ts",
        "tests/fixtures/agent_namespace_container_probe.ts",
        "tests/fixtures/agent_container_process_probe.ts",
        "tests/fixtures/native_github_client_probe.ts",
        "tests/fixtures/gemini_native_client_probe.ts",
        "tests/fixtures/native_codex_client_probe.ts",
        "tests/support/codex_native_evidence.ts",
      ]
    ) {
      const target = `${paths.baseDir}/worker/deno/${relative}`;
      await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.copyFile(`${repo}/worker/deno/${relative}`, target);
    }
  }
  console.log(decode(await runtime(["version"])));
  console.log(
    JSON.stringify({
      runtime: descriptor.kind,
      securityOptions: containerProbeSecurityInfo(
        descriptor,
        JSON.parse(decode(await runtime(["info", "--format", "{{json .}}"]))),
      ),
      image: decode(
        await runtime(["image", "inspect", "--format", "{{.Id}}", image]),
      ),
    }),
  );
  // Internal bridge: fixtures need no internet. A missing IPv6 prerequisite
  // fails here; the probe never changes host sysctls or security profiles.
  await runtime(containerProbeNetworkArgs(token));
  networkCreated = true;
  console.log(
    JSON.stringify({
      fixtureNetwork: decode(
        await runtime([
          "network",
          "inspect",
          network,
          "--format",
          "{{json .}}",
        ]),
      ),
    }),
  );
  for (const volume of volumes) await runtime(["volume", "create", volume]);
  for (const plan of plans) {
    await runtime(plan.initArgs);
    console.log(
      JSON.stringify({
        role: plan === brokerPlan ? "broker" : "agent",
        runArgs: plan.runArgs,
      }),
    );
  }
  // Keep the runtime client attached so startup errors survive --rm. Its
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
    const ready = await runtime([
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
  for (const mode of ["api-key", "subscription"]) {
    const result = JSON.parse(
      await launch(agentPlan, "native-client", [metadata, mode]),
    );
    if (
      result.nativeClientCompleted !== true ||
      result.upstreamCredentialVisible !== false || result.mode !== mode
    ) {
      throw new Error(
        `Native Claude ${mode} fixture lacked completion evidence`,
      );
    }
    console.log(JSON.stringify({ phase: "native-client", evidence: result }));
  }
  const github = JSON.parse(
    await launch(agentPlan, "native-github", [metadata]),
  );
  if (
    github.nativeGitHubCompleted !== true || github.readCompleted !== true ||
    github.headCompleted !== true || github.deniedRequests !== 4 ||
    github.localCapabilityOnly !== true ||
    github.upstreamCredentialVisible !== false ||
    github.startupCompleted !== true || github.paginationCompleted !== true ||
    github.repositoryReadsCompleted !== true
  ) {
    throw new Error(
      "Native GitHub fixture lacked complete read/denial evidence",
    );
  }
  console.log(JSON.stringify({ phase: "native-github", evidence: github }));
  const geminiPin = manifest.providers.find((provider) =>
    provider.id === "gemini"
  );
  if (!geminiPin) {
    throw new Error("Native Gemini fixture requires a manifest pin");
  }
  const gemini = JSON.parse(
    await launch(agentPlan, "native-gemini", [metadata, geminiPin.version]),
  );
  if (
    gemini.nativeClientCompleted !== true || gemini.versionMatched !== true ||
    gemini.upstreamCredentialVisible !== false
  ) throw new Error("Native Gemini fixture lacked completion evidence");
  console.log(JSON.stringify({ phase: "native-gemini", evidence: gemini }));
  const codexPin = manifest.providers.find((provider) =>
    provider.id === "codex"
  );
  if (!codexPin) {
    throw new Error("Native Codex fixture requires a manifest pin");
  }
  const codex = JSON.parse(
    await launch(agentPlan, "native-codex", [metadata, codexPin.version]),
  );
  if (
    codex.nativeClientCompleted !== true || codex.versionMatched !== true ||
    codex.upstreamCredentialVisible !== false ||
    codex.authenticationMode !== "api-key"
  ) {
    throw new Error("Native Codex fixture lacked completion evidence");
  }
  console.log(JSON.stringify({ phase: "native-codex", evidence: codex }));
  const nativeWitness = JSON.parse(await inside("witness"));
  if (
    nativeWitness.nativeGitHubRequests !== 2 ||
    nativeWitness.nativeCodexRequests !== 1 ||
    nativeWitness.nativeGitHubReads?.identity !== 1 ||
    nativeWitness.nativeGitHubReads?.quota !== 1 ||
    nativeWitness.nativeGitHubReads?.root !== 1 ||
    nativeWitness.nativeGitHubReads?.graphql !== 1 ||
    nativeWitness.nativeGitHubReads?.pages !== 2 ||
    nativeWitness.nativeGitHubReads?.repo !== 2 ||
    !Number.isSafeInteger(nativeWitness.nativeGeminiRequests) ||
    nativeWitness.nativeGeminiRequests < 1
  ) {
    throw new Error(
      "Native GitHub/Gemini/Codex lacked authenticated upstream evidence",
    );
  }
  for (const mode of ["api-key", "subscription"]) {
    if (
      !Number.isSafeInteger(nativeWitness.nativeRequests?.[mode]) ||
      nativeWitness.nativeRequests[mode] < 1
    ) {
      throw new Error(
        `Native Claude ${mode} fixture lacked authenticated upstream evidence`,
      );
    }
  }
  console.log(
    JSON.stringify({
      phase: "native-upstream-witness",
      evidence: {
        claude: nativeWitness.nativeRequests,
        github: nativeWitness.nativeGitHubRequests,
        githubReads: nativeWitness.nativeGitHubReads,
        gemini: nativeWitness.nativeGeminiRequests,
        codex: nativeWitness.nativeCodexRequests,
      },
    }),
  );
  await runtime(["stop", "--time", "5", brokerPlan.containerName]);
  const stopped = JSON.parse(
    await launch(agentPlan, "broker-stopped", [metadata]),
  );
  if (stopped.brokerTransportUnavailable !== true) {
    throw new Error("Broker shutdown lacked transport refusal evidence");
  }
  console.log(JSON.stringify({ phase: "broker-stopped", evidence: stopped }));
  console.log(
    `PASS: separate hardened ${descriptor.displayName} containers deny direct IPv4/IPv6 and hide the planted credential while pinned Claude/Gemini inference and native gh reads work; live OAuth/remaining providers/Apple acceptance remains unproved`,
  );
} finally {
  for (const plan of plans) {
    await runtime(["rm", "--force", plan.containerName], false);
  }
  if (brokerOutput) {
    const result = await brokerOutput;
    console.log(decode(result));
    const stderr = new TextDecoder().decode(result.stderr).trim();
    if (stderr) console.error(stderr);
  }
  for (const volume of volumes) {
    await runtime(["volume", "rm", "--force", volume], false);
  }
  if (networkCreated) await runtime(["network", "rm", network], false);
  await Deno.remove(root, { recursive: true });
}
