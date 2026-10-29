import { spawnCommandWithTimeout } from "./lib/subprocess_timeout.ts";
/** Host supervisor for one Apple egress sidecar and controlled test endpoint. */
import { parseContainerLaunchPlanText } from "./lib/container_launch.ts";
import {
  appleCapabilities,
  appleChildOutput,
  appleLaunch,
  appleMode,
  type AppleOwnership,
  appleStateDirectory,
  appleWorkerArgs,
  appleWorkerEnv,
  boundedAppleChild,
  retryAppleEgress,
  staleAppleOwnership,
} from "./lib/apple_egress_launch.ts";
import {
  type EgressCommandRunner,
  packEgressSource,
  startEgressSidecar,
  stopEgressSidecar,
} from "./lib/egress_sidecar.ts";

const [planFile, readyFile, logDir, ownerText] = Deno.args;
if (!planFile || !readyFile || !logDir || !/^\d+$/.test(ownerText ?? "")) {
  throw new Error(
    "usage: apple_egress_launch_main <plan> <ready> <log-dir> <launcher-pid>",
  );
}
const owner = Number(ownerText);
const plan = parseContainerLaunchPlanText(await Deno.readTextFile(planFile));
const runtime = plan.runtime;
const decoder = new TextDecoder();
const alive = (pid: number) => {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function command(
  executable: string,
  args: readonly string[],
  stdin?: Uint8Array,
  timeoutMs = 30000,
) {
  const child = spawnCommandWithTimeout(executable, {
    args: [...args],
    stdin: stdin ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    timeoutMs,
  });
  const result = await appleChildOutput(child, stdin, timeoutMs);
  return {
    code: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}
async function requireCommand(executable: string, args: readonly string[]) {
  const result = await command(executable, args);
  if (result.code) {
    throw new Error(
      `${executable} ${args.join(" ")} exited ${result.code}: ${
        result.stderr.slice(0, 500)
      }`,
    );
  }
  return result.stdout;
}

const hostHome = Deno.env.get("HOME");
if (!hostHome) throw new Error("Apple supervisor requires the host HOME");
const stateDir = await appleStateDirectory(hostHome, plan.run);
// Only journals written after creation confer ownership. Never enumerate or
// remove arbitrary runtime resources, including any active fleet network.
for await (const entry of Deno.readDir(stateDir)) {
  if (
    !entry.isFile ||
    !/^vibe-egress-owned-[1-9]\d*-[a-f0-9]{24}\.json$/.test(entry.name)
  ) continue;
  const path = `${stateDir}/${entry.name}`;
  try {
    const previous = staleAppleOwnership(
      await Deno.readTextFile(path),
      entry.name,
      alive,
    );
    if (!previous) continue;
    if (previous.createdProxy) {
      const result = await command(runtime, [
        "delete",
        "--force",
        previous.proxy,
      ]);
      if (result.code && !/not found|does not exist/i.test(result.stderr)) {
        throw new Error(result.stderr);
      }
    }
    if (previous.createdNetwork) {
      const result = await command(runtime, [
        "network",
        "delete",
        previous.network,
      ]);
      if (result.code && !/not found|does not exist/i.test(result.stderr)) {
        throw new Error(result.stderr);
      }
    }
    await Deno.remove(path);
  } catch (error) {
    console.error(`[egress] stale cleanup retained ${entry.name}: ${error}`);
  }
}

const caps = appleCapabilities(
  await requireCommand(runtime, ["--version"]),
  await requireCommand("sw_vers", ["-productVersion"]),
  (await command(runtime, ["network", "create", "--help"])).stdout,
  await requireCommand(runtime, ["run", "--help"]),
);
const mode = appleMode(Deno.env.get("VIBE_APPLE_EGRESS_MODE"), caps);
console.error(
  `[egress] runtime=${caps.version} macOS=${caps.macOS} mode=${mode}: ${caps.reason}; host/LAN isolation is not promised`,
);
let stopped = false;
const stop = () => {
  stopped = true;
};
Deno.addSignalListener("SIGTERM", stop);
Deno.addSignalListener("SIGINT", stop);
const parentWatch = setInterval(() => {
  if (!alive(owner)) stopped = true;
}, 1000);

try {
  await retryAppleEgress(async () => {
    const launch = appleLaunch(
      plan,
      mode,
      owner,
      crypto.randomUUID().replaceAll("-", ""),
    );
    const journal = `${stateDir}/${launch.network}.json`;
    const owned: AppleOwnership = {
      owner,
      manager: Deno.pid,
      network: launch.network,
      proxy: launch.proxy,
      createdNetwork: false,
      createdProxy: false,
    };
    let proxyChild: Deno.ChildProcess | undefined;
    let listener: Deno.TcpListener | undefined;
    let listenerTask: Promise<void> | undefined;
    const run: EgressCommandRunner = async (args, stdin) => {
      if (stdin && args[0] === "run") {
        proxyChild = spawnCommandWithTimeout(runtime, {
          args: [...args],
          stdin: "piped",
          stdout: "null",
          stderr: "inherit",
          timeoutMs: 24 * 60 * 60 * 1000,
        });
        const child = proxyChild;
        const writer = child.stdin.getWriter();
        await boundedAppleChild(
          child,
          async () => {
            await writer.write(stdin);
            await writer.close();
          },
          30000,
          1000,
          () => {
            writer.abort().catch(() => {});
          },
        );
        return { code: 0, stdout: "", stderr: "" };
      }
      return await command(runtime, args);
    };
    try {
      const attachment = await startEgressSidecar(launch.sidecar, {
        apple: true,
        run,
        cancelled: () => stopped,
        created: async (resource) => {
          if (resource === "network") owned.createdNetwork = true;
          else owned.createdProxy = true;
          await Deno.writeTextFile(`${journal}.tmp`, JSON.stringify(owned), {
            mode: 0o600,
          });
          await Deno.rename(`${journal}.tmp`, journal);
        },
      });
      if (!attachment) throw new Error("Apple proxy address was not measured");
      listener = Deno.listen({ hostname: "0.0.0.0", port: 0 });
      const token = crypto.randomUUID();
      const activeListener = listener;
      listenerTask = (async () => {
        try {
          for await (const conn of activeListener) {
            try {
              await conn.write(new TextEncoder().encode(token));
            } finally {
              conn.close();
            }
          }
        } catch (error) {
          if (!stopped && listener) {
            console.error(`[egress] host probe listener: ${error}`);
          }
        }
      })();
      const addresses = new Set([
        attachment.gateway,
        ...Deno.networkInterfaces().filter((entry) =>
          entry.family === "IPv4" && !entry.address.startsWith("127.")
        ).map((entry) => entry.address),
      ]);
      const hostEnv = {
        VIBE_EGRESS_HOST_TARGETS: [...addresses].slice(0, 12).map((address) =>
          `${address}:${activeListener.addr.port}`
        ).join(","),
        VIBE_EGRESS_HOST_BANNER: token,
      };
      const controlName = `${launch.network}-control`;
      let control: Record<string, string> = {};
      try {
        // No mounts, credentials or agent: the SAME probe code on open networking.
        const result = await command(
          runtime,
          [
            "run",
            "--rm",
            "-i",
            "--name",
            controlName,
            "--cpus",
            "1",
            "--memory",
            "256M",
            "--cap-drop",
            "ALL",
            "--read-only",
            "--network",
            "default",
            ...Object.entries(hostEnv).flatMap((
              [key, value],
            ) => ["--env", `${key}=${value}`]),
            "--env",
            "HOME=/dev/shm",
            "--env",
            "DENO_DIR=/dev/shm/deno-cache",
            "--entrypoint",
            "bash",
            plan.image,
            "-c",
            "set -eu; mkdir -p /dev/shm/src; tar -xf - -C /dev/shm/src; cd /dev/shm/src; deno run --allow-net --allow-env worker/deno/apple_egress_probe_main.ts",
          ],
          await packEgressSource(plan.proxyBundle),
          45000,
        );
        if (result.code) {
          throw new Error(
            `negative control exited ${result.code}: ${
              result.stderr.slice(0, 500)
            }`,
          );
        }
        control = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      } finally {
        const removed = await command(runtime, [
          "delete",
          "--force",
          controlName,
        ]);
        if (removed.code && !/not found|does not exist/i.test(removed.stderr)) {
          console.error(`[egress] negative-control cleanup: ${removed.stderr}`);
        }
      }
      // `--dns 127.0.0.1` hides the internal network's resolver from
      // ordinary lookups; appleWorkerEnv names it for the self-check.
      const runArgs = appleWorkerArgs(
        launch.run,
        appleWorkerEnv(mode, attachment, hostEnv, {
          VIBE_RUNTIME_VERSION: caps.version,
          VIBE_EGRESS_MACOS_VERSION: caps.macOS,
          VIBE_EGRESS_NEGATIVE_CONTROL: JSON.stringify(control),
        }),
      );
      await Deno.writeTextFile(`${readyFile}.tmp`, runArgs.join("\0") + "\0", {
        mode: 0o600,
      });
      await Deno.rename(`${readyFile}.tmp`, readyFile);
      while (!stopped) await pause(250);
    } finally {
      const toClose = listener;
      listener = undefined;
      toClose?.close();
      await listenerTask;
      const problems = await stopEgressSidecar({
        ...launch.sidecar,
        proxyName: owned.createdProxy ? launch.proxy : "",
        proxyStopArgs: owned.createdProxy ? launch.sidecar.proxyStopArgs : [],
        networkRemoveArgs: owned.createdNetwork
          ? launch.sidecar.networkRemoveArgs
          : [],
      }, { apple: true, run, logFile: `${logDir}/egress-proxy.log` });
      for (const problem of problems) {
        console.error(`[egress] cleanup: ${problem}`);
      }
      if (!problems.length) {
        try {
          await Deno.remove(journal);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            console.error(
              `[egress] could not remove ownership journal: ${error}`,
            );
          }
        }
      }
      if (proxyChild) {
        const child = proxyChild;
        try {
          await boundedAppleChild(child, async () => {
            try {
              child.kill("SIGTERM");
            } catch { /* CLI exited after deletion. */ }
            await child.status;
          }, 1000);
        } catch (error) {
          console.error(`[egress] proxy client shutdown: ${error}`);
        }
      }
    }
  }, {
    cancelled: () => stopped,
    failed: (attempt, error) =>
      console.error(`[egress] attempt ${attempt}/3 failed: ${error}`),
    pause: () => pause(1000),
  });
} finally {
  clearInterval(parentWatch);
  Deno.removeSignalListener("SIGTERM", stop);
  Deno.removeSignalListener("SIGINT", stop);
}
