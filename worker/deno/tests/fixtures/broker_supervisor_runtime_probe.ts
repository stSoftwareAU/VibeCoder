/** Actual Docker/Podman supervisor + stdin provisioning; synthetic values only. */
import { buildBrokerIsolationPlan } from "../../lib/broker_isolation_plan.ts";
import { parseContainerListing } from "../../lib/container_watchdog.ts";
import { superviseBrokeredWorker } from "../../lib/broker_supervisor.ts";
import { parseContainerManifest } from "../../lib/container_manifest.ts";
import { resolveContainerLaunchHostPaths } from "../../lib/container_launch.ts";
import { containerProbeRuntime } from "../support/agent_container_plan.ts";
import {
  assertSupervisorWorkerEvidence,
  type SupervisorWorkerEvidence,
} from "../support/broker_supervisor_evidence.ts";

const image = Deno.args[0];
if (!image || Deno.build.os !== "linux") {
  throw new Error(
    "Usage on Linux: broker_supervisor_runtime_probe.ts <local-image> [docker|podman]",
  );
}
const descriptor = containerProbeRuntime(Deno.args[1]);
const repo = new URL("../../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const manifest = parseContainerManifest(
  await Deno.readTextFile(`${repo}/container/tools.json`),
);
const runtime = async (args: string[], required = true) => {
  const output = await new Deno.Command(descriptor.executable, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(20_000),
  }).output();
  if (required && !output.success) {
    throw new Error(
      `Supervisor fixture runtime ${
        args[0]
      } failed (${output.code}); no weaker retry`,
    );
  }
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
  };
};
const digest = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ).map((b) => b.toString(16).padStart(2, "0")).join("");

for (const ending of ["success", "cancel", "broker-loss"] as const) {
  const root = await Deno.makeTempDir({ prefix: "broker-supervisor-runtime-" });
  await Deno.chmod(root, 0o755);
  const name = `vibe-supervisor-${crypto.randomUUID().slice(0, 12)}`;
  const paths = resolveContainerLaunchHostPaths(
    `${root}/checkout`,
    (key) => key === "HOME" ? `${root}/home` : undefined,
  );
  paths.configFile = `${root}/original-host-config.json`;
  const controller = new AbortController();
  let running: Promise<number> | undefined;
  let complete = false;
  let runFailure: unknown;
  let scenarioFailure: unknown;
  let mayOwnWorkVolumes = false;
  const persistent = {
    work: `${name}-work`,
    approvalState: `${name}-approval`,
    agentState: `${name}-state`,
  };
  const sessionVolumes = [`${name}-socket`, `${name}-private`];
  const allVolumes = [...Object.values(persistent), ...sessionVolumes];
  try {
    for (const volume of allVolumes) {
      const found = await runtime([
        "volume",
        "ls",
        "--filter",
        `name=^${volume}$`,
        "--format",
        "{{.Name}}",
      ]);
      if (found.stdout) {
        throw new Error("Fixture volume unexpectedly pre-exists");
      }
    }
    for (
      const path of [
        paths.baseDir,
        paths.logDir,
        paths.configStageDir,
        ...["gh", "claude", "codex", "gemini", "deepseek"].map((p) =>
          `${paths.credentialDir}/${p}`
        ),
      ]
    ) {
      await Deno.mkdir(path, { recursive: true, mode: 0o755 });
    }
    // No upstream value or evidence needs a writable host bind mount. Selected
    // values enter the private volume exclusively on the stage process stdin.
    await Deno.writeTextFile(paths.configFile, "{}", { mode: 0o600 });
    await Deno.writeTextFile(`${paths.configStageDir}/.config.json`, "{}");
    // Copy only tracked TypeScript libraries and explicit runtime entrypoints.
    // This follows their local import graph without copying any host config,
    // credentials, worktrees, untracked files or symlink targets.
    const listing = await new Deno.Command("git", {
      args: ["-C", repo, "ls-files", "-z", "--", "worker/deno/lib"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!listing.success) {
      throw new Error("Could not enumerate tracked broker source");
    }
    const sources = [
      ...new TextDecoder().decode(listing.stdout).split("\0").filter((p) =>
        p.endsWith(".ts")
      ),
      "worker/deno/broker_service.ts",
      "worker/deno/types.ts",
      "worker/deno/deno.json",
      "worker/deno/deno.lock",
      "worker/deno/tests/fixtures/broker_supervisor_worker_probe.ts",
      "worker/deno/tests/support/agent_container_evidence.ts",
      "worker/deno/tests/support/agent_namespace_evidence.ts",
    ];
    for (const relative of sources) {
      if (!(await Deno.lstat(`${repo}/${relative}`)).isFile) {
        throw new Error("Broker source staging refuses symlinks and non-files");
      }
      const target = `${paths.baseDir}/${relative}`;
      await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
        recursive: true,
        mode: 0o755,
      });
      await Deno.copyFile(`${repo}/${relative}`, target);
    }
    const plan = await buildBrokerIsolationPlan({
      descriptor,
      manifest,
      image,
      containerName: name,
      watchdogSeconds: 90,
      buildCommit: "synthetic-supervisor-fixture",
      hostPaths: paths,
      resources: { memory: "1g", cpus: "1" },
      volumes: persistent,
    }, { socketVolume: sessionVolumes[0]!, privateVolume: sessionVolumes[1]! });
    const secret = `synthetic-${crypto.randomUUID()}`;
    const secretHash = await digest(secret);
    const sessionConfig = JSON.stringify({
      credentials: { claude: secret },
      repositories: ["fixture/allowed"],
      lifetimeMs: 60_000,
    });
    const artifact = "/tmp/supervisor-probe-evidence.json";
    const release = "/tmp/supervisor-probe-release";
    plan.worker.runArgs.splice(
      -1,
      0,
      "--entrypoint",
      "deno",
      "--env",
      `VIBE_PROBE_SECRET_HASH=${secretHash}`,
      "--env",
      "DENO_DIR=/tmp/supervisor-probe-cache",
    );
    plan.worker.runArgs.push(
      "run",
      "--no-config",
      "--no-remote",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      "/workspace/worker/deno/tests/fixtures/broker_supervisor_worker_probe.ts",
      artifact,
      release,
    );
    mayOwnWorkVolumes = true;
    running = superviseBrokeredWorker(plan, {
      sessionConfig,
      signal: controller.signal,
      readinessTimeoutMs: 20_000,
    });
    running.then(() => {
      complete = true;
    }, (error) => {
      complete = true;
      runFailure = error;
    });
    const deadline = Date.now() + 30_000;
    let workerEvidence: SupervisorWorkerEvidence | undefined;
    while (!workerEvidence) {
      if (complete) {
        throw new Error(
          `Supervisor ended before worker evidence (${
            runFailure instanceof Error
              ? runFailure.message
              : "no failure marker"
          })`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error("Supervisor worker evidence deadline expired");
      }
      const observed = await runtime([
        "exec",
        name,
        "deno",
        "eval",
        "--no-config",
        "console.log(await Deno.readTextFile(Deno.args[0]));",
        artifact,
      ], false);
      if (observed.code === 0) workerEvidence = JSON.parse(observed.stdout);
      if (!workerEvidence) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assertSupervisorWorkerEvidence(workerEvidence);
    // Only booleans and mode/UID are returned. Never print the selected value.
    const witnessCode =
      'const p="/run/broker-config/session.json";const s=await Deno.stat(p);const c=JSON.parse(await Deno.readTextFile(p));const h=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(c.credentials.claude)))).map(b=>b.toString(16).padStart(2,"0")).join("");console.log(JSON.stringify({matches:h===Deno.args[0],mode:s.mode&511,uid:s.uid}));';
    const witness = JSON.parse(
      (await runtime([
        "exec",
        plan.broker.name,
        "deno",
        "eval",
        "--no-config",
        witnessCode,
        secretHash,
      ])).stdout,
    ) as { matches: boolean; mode: number; uid: number };
    if (
      !witness.matches || witness.mode !== 0o600 ||
      witness.uid !== manifest.user.uid
    ) throw new Error("Private broker provisioner witness failed");
    const inspected = JSON.parse(
      (await runtime(["inspect", name])).stdout,
    )[0] as {
      HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean };
      Mounts: Array<{ Destination: string; RW: boolean }>;
    };
    if (
      inspected.HostConfig.NetworkMode !== "none" ||
      !inspected.HostConfig.ReadonlyRootfs || inspected.Mounts.some((m) =>
        m.Destination === "/run/broker-config"
      ) || inspected.Mounts.find((m) =>
          m.Destination === "/run/broker"
        )?.RW !== false
    ) throw new Error("Runtime worker mount/network inspection failed");
    const liveNames = parseContainerListing(
      (await runtime(["ps", "--all", "--format", "json"])).stdout,
    ).map((entry) => entry.name);
    if (
      !liveNames.includes(name) || !liveNames.includes(plan.broker.name) ||
      liveNames.includes(`${name}-broker-stage`)
    ) throw new Error("Runtime lifecycle positive control failed");
    const privateMount =
      (JSON.parse((await runtime(["inspect", plan.broker.name])).stdout)[0] as {
        Mounts: Array<{ Destination: string; RW: boolean }>;
      }).Mounts.find((m) => m.Destination === "/run/broker-config");
    if (!privateMount || privateMount.RW !== false) {
      throw new Error("Broker private volume must remain read-only");
    }
    if (ending === "success") {
      await runtime([
        "exec",
        name,
        "deno",
        "eval",
        "--no-config",
        'await Deno.writeTextFile(Deno.args[0], "");',
        release,
      ]);
    } else if (ending === "cancel") controller.abort();
    else await runtime(["stop", "--time", "1", plan.broker.name]);
    const outcome = await running.then(
      (code) => ({ code }),
      (error) => ({
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    if (
      ending === "success"
        ? !("code" in outcome) || outcome.code !== 0
        : !("error" in outcome) || !outcome.error.includes(
          ending === "cancel"
            ? "Broker supervisor cancelled"
            : "Broker exited while the worker was active",
        )
    ) {
      throw new Error(
        "Supervisor lifecycle outcome did not match the exercised boundary",
      );
    }
    const remainingNames = parseContainerListing(
      (await runtime(["ps", "--all", "--format", "json"])).stdout,
    ).map((entry) => entry.name);
    for (
      const role of [
        name,
        plan.broker.name,
        `${name}-broker-stage`,
        `${name}-broker-init`,
        `${name}-init`,
      ]
    ) {
      if (remainingNames.includes(role)) {
        throw new Error("Supervisor left a role container behind");
      }
    }
    const remainingVolumes =
      (await runtime(["volume", "ls", "--format", "{{.Name}}"]))
        .stdout.split("\n");
    if (
      sessionVolumes.some((volume) => remainingVolumes.includes(volume))
    ) throw new Error("Supervisor left a private session volume behind");
    console.log(
      JSON.stringify({
        runtime: descriptor.kind,
        ending,
        workerEvidence,
        privateWitness: witness,
        cleaned: true,
      }),
    );
  } catch (error) {
    scenarioFailure = error;
  }
  controller.abort();
  const cleanupFailures: unknown[] = [];
  if (running) {
    try {
      await running;
    } catch (error) {
      // These are the deliberate shutdown causes exercised above. Preserve
      // every provisioning/cleanup failure, including an earlier fixture fault.
      if (
        !(error instanceof Error) || ![
          "Broker supervisor cancelled",
          "Broker exited while the worker was active",
        ].includes(error.message)
      ) cleanupFailures.push(error);
    }
  }
  // Unique fixture work volumes only; never force removal of attached state.
  for (const volume of mayOwnWorkVolumes ? Object.values(persistent) : []) {
    try {
      const found = await runtime([
        "volume",
        "ls",
        "--filter",
        `name=^${volume}$`,
        "--format",
        "{{.Name}}",
      ]);
      if (found.stdout) {
        await runtime([...descriptor.dialect.volumeRemoveArgs, volume]);
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await Deno.remove(root, { recursive: true });
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (cleanupFailures.length) {
    throw new AggregateError([
      ...(scenarioFailure ? [scenarioFailure] : []),
      ...cleanupFailures,
    ], "Supervisor fixture cleanup failed");
  }
  if (scenarioFailure) throw scenarioFailure;
}
