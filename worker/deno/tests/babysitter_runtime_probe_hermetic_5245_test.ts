/**
 * Guard for Issue #5245: a babysitter unit test must not reach the real
 * container-runtime probe. On a macOS host runtime detection asks for Apple
 * `container`, so a fixture that fakes only docker/podman must not depend on
 * the host OS. These tests simulate a macOS host and fail if any runtime
 * process is constructed, or if the fixture plan cannot resolve its runtime.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
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
      const versionQuery = options?.args?.length === 3 &&
        options.args[0] === "version" && options.args[1] === "--format" &&
        options.args[2] === "{{.Server.Version}}";
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

// What each script prints: the platform it sees.
const REPORT = "console.log(Deno.build.os);";

// A scratch preload that simulates a macOS host: it sets the platform to
// darwin and forwards itself to every `deno run` child, as a real macOS host
// would report darwin in every process.
const DARWIN_PRELOAD = `
const self = new URL(import.meta.url).pathname;
Object.defineProperty(Deno, "build", {
  configurable: true,
  value: Object.freeze({ ...Deno.build, os: "darwin" }),
});
const RealCommand = Deno.Command;
class DarwinCommand extends RealCommand {
  constructor(command, options) {
    const args = options?.args?.map(String) ?? [];
    if (
      String(command) === Deno.execPath() && args[0] === "run" &&
      !args.includes(self)
    ) {
      options = { ...options, args: ["run", "--preload", self, ...args.slice(1)] };
    }
    super(command, options);
  }
}
Object.defineProperty(Deno, "Command", {
  configurable: true,
  writable: true,
  value: DarwinCommand,
});
`;

Deno.test("the Linux preload pins a deno run child and its own deno run children", async () => {
  const root = await Deno.makeTempDir();
  try {
    const darwin = `${root}/darwin_preload.js`;
    const inner = `${root}/inner.ts`;
    const outer = `${root}/outer.ts`;
    await Deno.writeTextFile(darwin, DARWIN_PRELOAD);
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
    // The darwin simulation loads first, so only the Linux preload can make a
    // process report linux, in the child and in the grandchild alike.
    const result = await runWithTimeout(Deno.execPath(), [
      "run",
      "--allow-all",
      "--cached-only",
      "--preload",
      darwin,
      "--preload",
      PRELOAD,
      outer,
    ], { timeoutMs: 30_000 });
    assert(result.ok);
    assertEquals(result.value.success, true, result.value.stderr);
    assertEquals(result.value.stdout.trim(), "linux\nlinux");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runtime guard refuses detection probes and permits only version metadata", async () => {
  const dir = await Deno.makeTempDir();
  const attempts: string[] = [];
  let restore = () => {};
  try {
    for (const name of ["docker", "podman"]) {
      await Deno.writeTextFile(
        `${dir}/${name}`,
        "#!/bin/sh\nprintf 'fixture-version'\n",
      );
      await Deno.chmod(`${dir}/${name}`, 0o700);
    }
    restore = simulateMacHost(attempts);
    for (const name of ["docker", "podman"]) {
      assertThrows(
        () => new Deno.Command(`${dir}/${name}`, { args: ["version"] }),
        Error,
        "unit test reached the real runtime",
      );
      const result = await new Deno.Command(`${dir}/${name}`, {
        args: ["version", "--format", "{{.Server.Version}}"],
      }).output();
      assertEquals(new TextDecoder().decode(result.stdout), "fixture-version");
    }
    assertEquals(attempts, ["docker", "podman"]);
  } finally {
    restore();
    await Deno.remove(dir, { recursive: true });
  }
});
