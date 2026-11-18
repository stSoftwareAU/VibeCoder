/**
 * Guard for Issue #5245: a babysitter unit test must not reach the real
 * container-runtime probe. On a macOS host runtime detection asks for Apple
 * `container`, so a fixture that fakes only docker/podman must not depend on
 * the host OS. These tests simulate a macOS host and fail if any runtime
 * process is constructed, or if the fixture plan cannot resolve its runtime.
 */
import { assert, assertEquals } from "@std/assert";
import { checkBabysitterContainerChromium } from "../lib/fleet_babysitter_container.ts";
import {
  fakeContainer,
  repairHost,
  repairPlan,
  type RuntimeSpawn,
} from "./fixtures/babysitter_container_fakes_4770.ts";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";

const PRELOAD =
  new URL("./fixtures/linux_host_platform_preload.ts", import.meta.url)
    .pathname;

/**
 * Simulate a macOS host and make constructing a runtime command throw, until
 * the returned function restores both globals.
 */
function simulateMacHost(attempts: string[]): () => void {
  const realBuild = Object.getOwnPropertyDescriptor(Deno, "build")!;
  const RealCommand = Deno.Command;
  Object.defineProperty(Deno, "build", {
    configurable: true,
    value: Object.freeze({ ...Deno.build, os: "darwin" as const }),
  });
  class GuardedCommand extends RealCommand {
    constructor(command: string | URL, options?: Deno.CommandOptions) {
      const name = String(command).split("/").pop()!;
      // The plan builder's best-effort `version --format` query is caught and
      // is not the detection probe this guard is about, so it is tolerated.
      const versionQuery = options?.args?.[0] === "version";
      if (["container", "docker", "podman"].includes(name) && !versionQuery) {
        attempts.push(name);
        throw new Error(`unit test reached the real runtime: ${name}`);
      }
      super(command, options);
    }
  }
  Object.defineProperty(Deno, "Command", {
    configurable: true,
    writable: true,
    value: GuardedCommand,
  });
  return () => {
    Object.defineProperty(Deno, "build", realBuild);
    Object.defineProperty(Deno, "Command", {
      configurable: true,
      writable: true,
      value: RealCommand,
    });
  };
}

Deno.test("repairPlan resolves podman on a macOS host without starting a runtime process", async () => {
  const host = repairHost();
  const attempts: string[] = [];
  const restore = simulateMacHost(attempts);
  try {
    const plan = await repairPlan(host, "fixture-5245");
    assertEquals(plan.runtime, "podman");
    assertEquals(attempts, []);
  } finally {
    restore();
    await Deno.remove(host.root, { recursive: true });
  }
});

Deno.test("fakeContainer's Chromium check reaches its spawn seam on a macOS host", async () => {
  const host = repairHost();
  const attempts: string[] = [];
  const spawns: RuntimeSpawn[] = [];
  const restore = simulateMacHost(attempts);
  try {
    const deps = fakeContainer(spawns, { host });
    await checkBabysitterContainerChromium({ baseDir: host.baseDir }, {
      ...deps,
      spawn: (runtime, args, options) => {
        spawns.push({
          runtime,
          args: [...args],
          env: { ...options.env },
          timeoutMs: options.timeoutMs,
        });
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "<html><head></head><body></body></html>",
          stderr: "",
          timedOut: false,
        });
      },
    });
    assertEquals(spawns.map((spawn) => spawn.runtime), ["podman"]);
    assertEquals(attempts, []);
  } finally {
    restore();
    await Deno.remove(host.root, { recursive: true });
  }
});

// What each script prints: the platform and the Deno.Command class in force.
const REPORT = "console.log(Deno.build.os + ' ' + Deno.Command.name);";

Deno.test("the Linux preload pins a deno run child and its own deno run children", async () => {
  const root = await Deno.makeTempDir();
  try {
    const inner = `${root}/inner.ts`;
    const outer = `${root}/outer.ts`;
    await Deno.writeTextFile(inner, `${REPORT}\n`);
    await Deno.writeTextFile(
      outer,
      `${REPORT}
const out = await new Deno.Command(Deno.execPath(), {
  args: ["run", "--allow-all", "--cached-only", ${JSON.stringify(inner)}],
}).output();
console.log(new TextDecoder().decode(out.stdout).trim());
`,
    );
    const result = await runWithTimeout(Deno.execPath(), [
      "run",
      "--allow-all",
      "--cached-only",
      "--preload",
      PRELOAD,
      outer,
    ], { timeoutMs: 30_000 });
    assert(result.ok);
    assertEquals(result.value.success, true, result.value.stderr);
    assertEquals(
      result.value.stdout.trim(),
      "linux PinnedCommand\nlinux PinnedCommand",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
