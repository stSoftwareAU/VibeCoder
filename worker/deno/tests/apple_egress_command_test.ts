/**
 * Tests for the `apple-egress` command (Issue #4051).
 *
 * The bring-up, the allowlist and every side effect are injected through the
 * command's seams, so no Apple CLI runs and no socket is bound. The args file
 * is written into a fresh temporary directory.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  appleEgressCommand,
  type AppleEgressCommandSeams,
  renderAppleWorkerArgs,
} from "../commands/apple_egress.ts";
import {
  type AppleEgressDeps,
  AppleEgressError,
  type AppleEgressOptions,
  type AppleEgressUp,
} from "../lib/apple_egress.ts";
import type { RuntimeInvocation } from "../lib/container_watchdog.ts";
import type { EgressControlReport } from "../lib/egress_controls.ts";
import type { HostEgressAllowlist } from "../lib/egress_host_allowlist.ts";
import { createDefaultRegistry } from "../mod.ts";
import type { WorkerConfig } from "../types.ts";

const CONFIG = {} as WorkerConfig;
const NO_ENV = (_name: string): string | undefined => undefined;

const ALLOWLIST: HostEgressAllowlist = {
  allowlist: ["api.github.com", "registry.npmjs.org"],
  probeHosts: {
    github: "api.github.com",
    registry: "registry.npmjs.org",
    providers: [],
  },
};

/** A deps object whose `run` and `writeReport` are the test's own. */
function fakeDeps(
  options: {
    run?: (args: readonly string[]) => RuntimeInvocation;
    written?: string[];
  } = {},
): AppleEgressDeps {
  const run = options.run ?? (() => ({ code: 0, stdout: "", stderr: "" }));
  return {
    run: (args) => Promise.resolve(run(args)),
    startHostListener: () => Promise.reject(new Error("not used here")),
    newNonce: () => "0".repeat(32),
    isProcessAlive: () => false,
    sleep: () => Promise.resolve(),
    now: () => new Date(0),
    log: () => {},
    writeReport: (path) => {
      options.written?.push(path);
      return Promise.resolve();
    },
    runHost: () => Promise.reject(new Error("not used here")),
  };
}

/** Every flag `up` requires, pointing into one temporary directory. */
function upArgs(dir: string, runtime = "container"): Record<string, unknown> {
  return {
    action: "up",
    runtime,
    image: "vibe-coder:abc123",
    name: "vibe-coder-4242",
    "base-dir": dir,
    workdir: "/work/checkout",
    "report-dir": dir,
    out: `${dir}/args.bin`,
  };
}

Deno.test("apple-egress - an unknown or missing action is an argument error, exit 2", async () => {
  const none = await appleEgressCommand.execute({}, CONFIG);
  assertEquals(none.success, false);
  assertEquals(none.exitCode, 2);

  const wrong = await appleEgressCommand.execute(
    { action: "sideways" },
    CONFIG,
  );
  assertEquals(wrong.exitCode, 2);
  assertStringIncludes(wrong.message, "--action must be up or down");
});

Deno.test("apple-egress - up without a required flag is an argument error, exit 2", async () => {
  const args = { ...upArgs("/unused") };
  delete args["workdir"];
  const result = await appleEgressCommand.execute(args, CONFIG, {
    env: NO_ENV,
  });
  assertEquals(result.exitCode, 2);
  assertStringIncludes(result.message, "--workdir");
});

Deno.test("apple-egress - up resolves the host config itself, relative to the checkout (Issue #750)", async () => {
  const dir = await Deno.makeTempDir();
  let seenConfig: string | undefined;
  const result = await appleEgressCommand.execute(upArgs(dir), CONFIG, {
    env: (name) => (name === "CONFIG_FILE" ? "cfg/host.json" : undefined),
    createDeps: () => fakeDeps(),
    resolveAllowlist: (input) => {
      seenConfig = input.configFile;
      return Promise.resolve(ALLOWLIST);
    },
    bringUp: () =>
      Promise.resolve({
        report: undefined as unknown as EgressControlReport,
        workerArgs: ["--network", "vibe-egress-4242"],
        attempts: 1,
      }),
  });
  assertEquals(result.success, true);
  assertEquals(seenConfig, `${dir}/cfg/host.json`);
});

Deno.test("apple-egress - up refuses CONFIG_FILE and CONFIG_PATH naming different files: exit 2, nothing brought up (Issue #750)", async () => {
  const dir = await Deno.makeTempDir();
  let resolved = false;
  let brought = false;
  const result = await appleEgressCommand.execute(upArgs(dir), CONFIG, {
    env: (name) =>
      name === "CONFIG_FILE"
        ? `${dir}/a.json`
        : name === "CONFIG_PATH"
        ? `${dir}/b.json`
        : undefined,
    createDeps: () => fakeDeps(),
    resolveAllowlist: () => {
      resolved = true;
      return Promise.resolve(ALLOWLIST);
    },
    bringUp: () => {
      brought = true;
      return Promise.reject(new Error("must not be called"));
    },
  });
  assertEquals(result.success, false);
  assertEquals(result.exitCode, 2);
  assertFalse(result.exitCode === 10, "a conflict is not 'not applicable'");
  assertStringIncludes(result.message, "name different files");
  assertStringIncludes(result.message, `CONFIG_FILE=${dir}/a.json`);
  assertStringIncludes(result.message, `CONFIG_PATH=${dir}/b.json`);
  assertFalse(resolved);
  assertFalse(brought);
});

Deno.test("apple-egress - malformed egress settings are an argument error, exit 2", async () => {
  const dir = await Deno.makeTempDir();
  const result = await appleEgressCommand.execute(upArgs(dir), CONFIG, {
    env: (name) => name === "VIBE_APPLE_EGRESS_MODE" ? "sideways" : undefined,
    createDeps: () => fakeDeps(),
    bringUp: () => Promise.reject(new Error("must not be called")),
  });
  assertEquals(result.exitCode, 2);
  assertStringIncludes(result.message, "VIBE_APPLE_EGRESS_MODE");
});

Deno.test("apple-egress - a runtime that is not Apple container exits 10 and writes nothing", async () => {
  const dir = await Deno.makeTempDir();
  let brought = false;
  const result = await appleEgressCommand.execute(
    upArgs(dir, "docker"),
    CONFIG,
    {
      env: NO_ENV,
      createDeps: () => fakeDeps(),
      bringUp: () => {
        brought = true;
        return Promise.reject(new Error("must not be called"));
      },
    },
  );
  assertEquals(result.exitCode, 10);
  assertEquals(
    result.message,
    "[egress] apple-egress: not applicable to docker",
  );
  assertFalse(brought);
  let exists = true;
  try {
    await Deno.stat(`${dir}/args.bin`);
  } catch {
    exists = false;
  }
  assertFalse(exists);
});

Deno.test("apple-egress - a successful up writes the NUL-delimited worker arguments and exits 0", async () => {
  const dir = await Deno.makeTempDir();
  let seenOptions: AppleEgressOptions | undefined;
  const result = await appleEgressCommand.execute(upArgs(dir), CONFIG, {
    env: (name) => (name === "HOME" ? "/home/tester" : undefined),
    createDeps: (runtime) => {
      assertEquals(runtime, "container");
      return fakeDeps();
    },
    resolveAllowlist: () => Promise.resolve(ALLOWLIST),
    bringUp: (_deps, options) => {
      seenOptions = options;
      const up: AppleEgressUp = {
        report: undefined as unknown as EgressControlReport,
        workerArgs: [
          "--network",
          "vibe-egress-4242",
          "--env",
          "HTTPS_PROXY=http://10.0.0.2:3128",
        ],
        attempts: 1,
      };
      return Promise.resolve(up);
    },
  } as AppleEgressCommandSeams);

  assertEquals(result.success, true);
  assertEquals(result.exitCode, undefined);
  const text = await Deno.readTextFile(`${dir}/args.bin`);
  assertEquals(
    text,
    "arg=--network\0arg=vibe-egress-4242\0arg=--env\0arg=HTTPS_PROXY=http://10.0.0.2:3128\0",
  );
  assert(seenOptions !== undefined);
  assertEquals(seenOptions.runtime, "container");
  assertEquals(seenOptions.workerContainerName, "vibe-coder-4242");
  assertEquals(seenOptions.workdir, "/work/checkout");
  assertEquals(seenOptions.homeDir, "/home/tester");
  assertEquals(seenOptions.mode, "auto");
  assertEquals(seenOptions.allowlist, ALLOWLIST);
});

Deno.test("apple-egress - an AppleEgressError exits 1 and writes no args file", async () => {
  const dir = await Deno.makeTempDir();
  const result = await appleEgressCommand.execute(upArgs(dir), CONFIG, {
    env: NO_ENV,
    createDeps: () => fakeDeps(),
    resolveAllowlist: () => Promise.resolve(ALLOWLIST),
    bringUp: () =>
      Promise.reject(
        new AppleEgressError("containment failed", ["attempt 1 of 1 failed"]),
      ),
  });
  assertEquals(result.success, false);
  assertEquals(result.exitCode, 1);
  let exists = true;
  try {
    await Deno.stat(`${dir}/args.bin`);
  } catch {
    exists = false;
  }
  assertFalse(exists);
});

Deno.test("apple-egress - a failed args write after bring-up tears the containment down and exits 1", async () => {
  const dir = await Deno.makeTempDir();
  const calls: string[][] = [];
  const result = await appleEgressCommand.execute(
    // The directory does not exist, so the write fails after bring-up succeeds.
    { ...upArgs(dir), out: `${dir}/missing-dir/args.bin` },
    CONFIG,
    {
      env: NO_ENV,
      createDeps: () =>
        fakeDeps({
          run: (args) => {
            calls.push([...args]);
            return { code: 0, stdout: "", stderr: "" };
          },
        }),
      resolveAllowlist: () => Promise.resolve(ALLOWLIST),
      bringUp: () =>
        Promise.resolve({
          report: undefined as unknown as EgressControlReport,
          workerArgs: ["--network", "vibe-egress-4242"],
          attempts: 1,
        }),
    },
  );
  assertEquals(result.success, false);
  assertEquals(result.exitCode, 1);
  assertEquals(calls, [
    ["delete", "--force", "vibe-coder-egress-proxy-4242"],
    ["network", "delete", "vibe-egress-4242"],
  ]);
});

Deno.test("apple-egress - down always exits 0 and saves the proxy log to --proxy-log", async () => {
  const proxyDir = await Deno.makeTempDir();
  const written: string[] = [];
  const calls: string[][] = [];
  const result = await appleEgressCommand.execute(
    {
      action: "down",
      runtime: "container",
      name: "vibe-coder-4242",
      "proxy-log": `${proxyDir}/proxy.log`,
    },
    CONFIG,
    {
      createDeps: () =>
        fakeDeps({
          written,
          run: (args) => {
            calls.push([...args]);
            return { code: 0, stdout: "proxy line\n", stderr: "" };
          },
        }),
    },
  );
  assertEquals(result.success, true);
  assertEquals(result.exitCode, undefined);
  assertEquals(written, [`${proxyDir}/proxy.log`]);
  assertEquals(calls, [
    ["logs", "vibe-coder-egress-proxy-4242"],
    ["delete", "--force", "vibe-coder-egress-proxy-4242"],
    ["network", "delete", "vibe-egress-4242"],
  ]);
});

Deno.test("apple-egress - down with failing deletes still exits 0", async () => {
  const result = await appleEgressCommand.execute(
    {
      action: "down",
      runtime: "container",
      name: "vibe-coder-4242",
    },
    CONFIG,
    {
      createDeps: () =>
        fakeDeps({
          run: () => ({ code: 1, stdout: "", stderr: "boom" }),
        }),
    },
  );
  assertEquals(result.success, true);
  assertEquals(result.exitCode, undefined);
});

Deno.test("apple-egress - down with a name that is not a worker name is an argument error, exit 2", async () => {
  const result = await appleEgressCommand.execute(
    { action: "down", runtime: "container", name: "not-a-worker" },
    CONFIG,
    { createDeps: () => fakeDeps() },
  );
  assertEquals(result.exitCode, 2);
});

Deno.test("apple-egress - renderAppleWorkerArgs refuses a NUL byte", () => {
  assertThrows(
    () => renderAppleWorkerArgs(["--env", "A=b\0c"]),
    Error,
    "NUL byte",
  );
});

Deno.test("apple-egress - the command is registered in the default registry", () => {
  assert(createDefaultRegistry().has("apple-egress"));
});
