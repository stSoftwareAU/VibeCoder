/**
 * Tests for the egress side of the babysitter repair container (Issue #4769).
 * The Apple helper and the enforced sidecar start before the repair spawn and
 * stop after it, whatever the outcome. These tests cover the order of those
 * steps, the set-up and teardown failures, the preflight that runs before any
 * egress step, the key guard on the helper's arguments, and the default Apple
 * helper, which fails fast against an empty directory. Fake deps stand in for
 * the runtime and the egress steps, and record every call in one ordered event
 * list. No test sets a process environment variable: env readers are injected.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { ContainerLaunchPlan } from "../lib/container_launch.ts";
import {
  type BabysitterContainerDeps,
  type BabysitterContainerInput,
  type BabysitterEnvReader,
  type BabysitterSpawnResult,
  babysitterStartAppleEgress,
  buildBabysitterRunArgs,
  runBabysitterRepairContainer,
} from "../lib/fleet_babysitter_container.ts";

const TOKEN = "ghs_FAKE-TOKEN-4738";
const IMAGE = "vibe-coder:test";
const HELPER_MARK = "VIBE_HELPER_MARK=1";
const PLAN_ONLY_MARK = "VIBE_PLAN_ONLY=1";
/** The helper's run arguments. Like a plan's `runArgs`, they end with the image. */
const HELPER_RUN_ARGS = [
  "run",
  "--rm",
  "--name",
  "vibe-egress-helper",
  "--env",
  HELPER_MARK,
  IMAGE,
];
const OK: BabysitterSpawnResult = {
  success: true,
  code: 0,
  stderr: "",
  timedOut: false,
};
const FAILED: BabysitterSpawnResult = {
  success: false,
  code: 1,
  stderr: "boom",
  timedOut: false,
};
const TIMED_OUT: BabysitterSpawnResult = {
  success: false,
  code: 124,
  stderr: "",
  timedOut: true,
};
const fakeEnv: BabysitterEnvReader = (name) =>
  name === "PATH" ? "/usr/bin" : undefined;

/** Which egress the fake plan needs: an Apple helper, an enforced sidecar, or neither. */
type EgressKind = "apple" | "enforced" | "none";

interface Fixture {
  root: string;
  keyDir: string;
  keyPath: string;
  clone: string;
  scratch: string;
}

/** A temp tree: a key directory holding a fake App key, plus clone and scratch. */
async function makeFixture(): Promise<Fixture> {
  const root = await Deno.makeTempDir();
  const keyDir = `${root}/home/.vibe-coder/fleet-pr-babysitter`;
  const keyPath = `${keyDir}/babysitter-app.pem`;
  await Deno.mkdir(keyDir, { recursive: true });
  await Deno.writeTextFile(
    keyPath,
    "-----BEGIN PRIVATE KEY-----\nFAKE-KEY-BODY-4769\n-----END PRIVATE KEY-----",
  );
  const clone = `${root}/clone`;
  const scratch = `${root}/scratch`;
  await Deno.mkdir(clone);
  await Deno.mkdir(scratch);
  return { root, keyDir, keyPath, clone, scratch };
}

function inputFor(f: Fixture): BabysitterContainerInput {
  return {
    baseDir: "/checkout",
    clone: f.clone,
    scratch: f.scratch,
    privateKeyPath: f.keyPath,
    token: TOKEN,
  };
}

/**
 * A launch plan shaped like the worker's. Its own run arguments carry a
 * plan-only marker, so a test can tell the plan's arguments from the helper's.
 */
function fakePlan(
  root: string,
  name: string,
  kind: EgressKind,
): ContainerLaunchPlan {
  const egress = kind === "none"
    ? { egressEnforced: false, proxyName: "" }
    : { egressEnforced: kind === "enforced", proxyName: `${name}-proxy` };
  return {
    runtime: "fake-runtime",
    image: IMAGE,
    keepImages: [IMAGE],
    containerName: name,
    watchdogSeconds: 60,
    mounts: [],
    ensureDirectories: [],
    volumes: ["vibe-work", "vibe-approval-state"],
    resettableVolumes: ["vibe-work", "vibe-agent-state"],
    initArgs: [],
    volumeRemoveArgs: [],
    imageRemoveArgs: [],
    claimFloorGb: 1,
    claimFloorPercent: 10,
    claimFloorOrigin: "default",
    imageInspectArgs: ["image", "inspect", IMAGE],
    buildArgs: [],
    extensionBuildArgs: [],
    builderStopArgs: [],
    builderAbsentPatterns: [],
    ...egress,
    networkCreateArgs: [],
    networkRemoveArgs: [],
    networkConnectArgs: [],
    proxyRunArgs: [],
    proxyStopArgs: [],
    proxyBundle: "",
    runArgs: [
      "run",
      "--rm",
      "--name",
      name,
      "--volume",
      "vibe-work:/home/vibe/auto-issue-work",
      "--volume",
      `${root}/logs:/home/vibe/logs`,
      "--env",
      PLAN_ONLY_MARK,
      IMAGE,
    ],
  };
}

interface Spawned {
  runtime: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

interface Harness {
  /** Every egress step and every spawn, in call order. */
  events: string[];
  /** Messages passed to `log`. */
  logged: string[];
  /** Each Apple helper start, with the plan and the base directory it got. */
  apple: Array<{ plan: ContainerLaunchPlan; baseDir: string }>;
  sidecarStarts: ContainerLaunchPlan[];
  sidecarStops: ContainerLaunchPlan[];
  spawns: Spawned[];
  /** The container name given to each plan build. */
  built: string[];
}

interface Options {
  kind?: EgressKind;
  /** The Apple helper's returned run arguments (default HELPER_RUN_ARGS). */
  helperRunArgs?: string[];
  /** The Apple helper's start rejects with this. */
  helperError?: Error;
  /** The enforced sidecar's start rejects with this. */
  sidecarStartError?: Error;
  /** The problems a teardown returns. */
  stopProblems?: string[];
  /** A teardown rejects with this. */
  stopError?: Error;
  /** Queued spawn outcomes; an Error is thrown instead of returned. */
  spawnResults?: Array<BabysitterSpawnResult | Error>;
  onPath?: boolean;
  imageExists?: boolean;
  /** Every egress step throws, for a plan that needs none. */
  forbidEgress?: boolean;
}

/** Fake deps that record every call, in one ordered event list. */
function harness(
  f: Fixture,
  options: Options = {},
): { deps: Partial<BabysitterContainerDeps>; h: Harness } {
  const h: Harness = {
    events: [],
    logged: [],
    apple: [],
    sidecarStarts: [],
    sidecarStops: [],
    spawns: [],
    built: [],
  };
  const queue = [...(options.spawnResults ?? [])];
  const kind = options.kind ?? "none";
  const forbidden = (step: string): void => {
    if (options.forbidEgress) {
      throw new Error(`${step} must not run for this plan`);
    }
  };
  const deps: Partial<BabysitterContainerDeps> = {
    env: fakeEnv,
    onPath: () => Promise.resolve(options.onPath ?? true),
    buildPlan: (_baseDir, containerName) => {
      h.built.push(containerName);
      return Promise.resolve(fakePlan(f.root, containerName, kind));
    },
    imageExists: () => Promise.resolve(options.imageExists ?? true),
    spawn: (runtime, args, opts) => {
      h.events.push("spawn");
      h.spawns.push({
        runtime,
        args: [...args],
        env: { ...opts.env },
        timeoutMs: opts.timeoutMs,
      });
      const next = queue.shift() ?? OK;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
    startAppleEgress: async (plan, egressOptions) => {
      h.events.push("start-apple");
      h.apple.push({ plan, baseDir: egressOptions.baseDir });
      forbidden("start-apple");
      if (options.helperError) throw options.helperError;
      return {
        runArgs: options.helperRunArgs ?? HELPER_RUN_ARGS,
        stop: async () => {
          h.events.push("stop-apple");
          if (options.stopError) throw options.stopError;
          return options.stopProblems ?? [];
        },
      };
    },
    startSidecar: async (plan) => {
      h.events.push("start-sidecar");
      h.sidecarStarts.push(plan);
      forbidden("start-sidecar");
      if (options.sidecarStartError) throw options.sidecarStartError;
    },
    stopSidecar: async (plan) => {
      h.events.push("stop-sidecar");
      h.sidecarStops.push(plan);
      forbidden("stop-sidecar");
      if (options.stopError) throw options.stopError;
      return options.stopProblems ?? [];
    },
    log: (message) => {
      h.logged.push(message);
    },
  };
  return { deps, h };
}

/** The n-th item of a recorded list, asserting it exists. */
function at<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no ${label} number ${index}`);
  return item;
}

Deno.test("apple egress: the repair runs the helper's args, starts the helper once and stops it after the spawn", async () => {
  const f = await makeFixture();
  try {
    const { deps, h } = harness(f, { kind: "apple" });
    const result = await runBabysitterRepairContainer(inputFor(f), deps);

    assertEquals(result, { containerName: at(h.built, 0, "build") });
    assertEquals(h.events, ["start-apple", "spawn", "stop-apple"]);
    assertEquals(h.apple.length, 1, "the helper starts once");
    const started = at(h.apple, 0, "helper start");
    assertEquals(started.baseDir, "/checkout");
    assertEquals(started.plan.containerName, at(h.built, 0, "build"));

    const spawn = at(h.spawns, 0, "spawn");
    assertEquals(
      spawn.args,
      buildBabysitterRunArgs(
        { ...started.plan, runArgs: HELPER_RUN_ARGS },
        { clone: f.clone, scratch: f.scratch },
      ),
      "the spawn runs the helper's arguments, not the plan's",
    );
    assert(
      spawn.args.includes(HELPER_MARK),
      "the helper's marker reaches the spawn",
    );
    assert(
      !spawn.args.includes(PLAN_ONLY_MARK),
      "the plan's own marker does not reach the spawn",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("apple egress: a failed repair stops the helper after the spawn and throws its own error", async () => {
  const f = await makeFixture();
  try {
    const cases: Array<{
      label: string;
      spawnResults: Array<BabysitterSpawnResult | Error>;
      message: string;
      spawns: number;
    }> = [
      {
        label: "a non-zero exit",
        spawnResults: [{ ...FAILED, code: 2, stderr: "bad" }],
        message: "exited with code 2",
        spawns: 1,
      },
      {
        label: "a spawn that throws",
        spawnResults: [new Error("spawn broke")],
        message: "spawn broke",
        spawns: 1,
      },
      {
        label: "a timeout, whose kill succeeds",
        spawnResults: [TIMED_OUT, OK],
        message: "timed out after 90 minutes",
        spawns: 2,
      },
    ];
    for (const c of cases) {
      const { deps, h } = harness(f, {
        kind: "apple",
        spawnResults: c.spawnResults,
      });
      await assertRejects(
        () => runBabysitterRepairContainer(inputFor(f), deps),
        Error,
        c.message,
      );
      assertEquals(
        h.events,
        ["start-apple", ...Array(c.spawns).fill("spawn"), "stop-apple"],
        `${c.label}: the helper is stopped last`,
      );
      assertEquals(h.spawns.length, c.spawns, c.label);
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("enforced egress: the sidecar starts before the spawn and stops after it, on success, a throw and a non-zero exit", async () => {
  const f = await makeFixture();
  try {
    const cases: Array<{
      label: string;
      spawnResults: Array<BabysitterSpawnResult | Error>;
      message?: string;
    }> = [
      { label: "a successful repair", spawnResults: [OK] },
      {
        label: "a spawn that throws",
        spawnResults: [new Error("spawn broke")],
        message: "spawn broke",
      },
      {
        label: "a non-zero exit",
        spawnResults: [FAILED],
        message: "exited with code 1",
      },
    ];
    for (const c of cases) {
      const { deps, h } = harness(f, {
        kind: "enforced",
        spawnResults: c.spawnResults,
      });
      if (c.message === undefined) {
        await runBabysitterRepairContainer(inputFor(f), deps);
      } else {
        await assertRejects(
          () => runBabysitterRepairContainer(inputFor(f), deps),
          Error,
          c.message,
        );
      }
      assertEquals(
        h.events,
        ["start-sidecar", "spawn", "stop-sidecar"],
        c.label,
      );
      assertEquals(h.sidecarStarts.length, 1, c.label);
      assertEquals(h.sidecarStops.length, 1, c.label);
      const stopped = at(h.sidecarStops, 0, "sidecar stop");
      assertEquals(
        stopped,
        at(h.sidecarStarts, 0, "sidecar start"),
        `${c.label}: stop is given the plan`,
      );
      assertEquals(stopped.containerName, at(h.built, 0, "build"), c.label);
      assertEquals(h.apple.length, 0, `${c.label}: no Apple helper`);
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("egress set-up failure: the repair rejects with the cause and spawns nothing", async () => {
  const f = await makeFixture();
  try {
    const apple = harness(f, {
      kind: "apple",
      helperError: new Error("egress setup failed: boom cause"),
    });
    await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), apple.deps),
      Error,
      "egress setup failed: boom cause",
    );
    assertEquals(apple.h.spawns.length, 0, "no spawn after a helper failure");

    const enforced = harness(f, {
      kind: "enforced",
      sidecarStartError: new Error("sidecar boom cause"),
    });
    await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), enforced.deps),
      Error,
      "sidecar boom cause",
    );
    assertEquals(
      enforced.h.spawns.length,
      0,
      "no spawn after a sidecar failure",
    );
    assertEquals(
      enforced.h.events,
      ["start-sidecar", "stop-sidecar"],
      "the half-started sidecar is still stopped",
    );
    assertEquals(enforced.h.sidecarStops.length, 1);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("a plan that needs neither egress starts and stops nothing, and spawns once", async () => {
  const f = await makeFixture();
  try {
    const { deps, h } = harness(f, { kind: "none", forbidEgress: true });
    await runBabysitterRepairContainer(inputFor(f), deps);
    assertEquals(h.events, ["spawn"], "no egress step runs");
    assertEquals(h.spawns.length, 1);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("egress teardown problems and throws are logged, and never hide the repair's result or error", async () => {
  const f = await makeFixture();
  try {
    for (const kind of ["apple", "enforced"] as const) {
      // Problems from a teardown on a successful repair are logged.
      {
        const { deps, h } = harness(f, {
          kind,
          stopProblems: ["could not remove the egress proxy (exit 1)"],
        });
        const result = await runBabysitterRepairContainer(inputFor(f), deps);
        assertEquals(result, { containerName: at(h.built, 0, "build") }, kind);
        assert(
          h.logged.some((m) =>
            m.includes("could not remove the egress proxy (exit 1)")
          ),
          `${kind}: the problem is logged, got ${JSON.stringify(h.logged)}`,
        );
      }

      // A teardown that throws on a successful repair is logged, not raised.
      {
        const { deps, h } = harness(f, {
          kind,
          stopError: new Error("kaboom"),
        });
        const result = await runBabysitterRepairContainer(inputFor(f), deps);
        assertEquals(result, { containerName: at(h.built, 0, "build") }, kind);
        assert(
          h.logged.some((m) => m.includes("kaboom")),
          `${kind}: the cause is logged, got ${JSON.stringify(h.logged)}`,
        );
      }

      // A teardown that throws after a failed repair leaves the repair's error.
      {
        const { deps, h } = harness(f, {
          kind,
          spawnResults: [FAILED],
          stopError: new Error("kaboom"),
        });
        const error = await assertRejects(
          () => runBabysitterRepairContainer(inputFor(f), deps),
          Error,
          "exited with code 1",
        );
        assert(
          !error.message.includes("kaboom"),
          `${kind}: the teardown's error must not be thrown`,
        );
        assert(
          h.logged.some((m) => m.includes("kaboom")),
          `${kind}: the teardown cause is logged`,
        );
      }

      // A token in a teardown problem never reaches the log.
      {
        const { deps, h } = harness(f, {
          kind,
          stopProblems: [`could not remove the egress proxy for ${TOKEN}`],
        });
        await runBabysitterRepairContainer(inputFor(f), deps);
        assert(
          h.logged.some((m) => m.includes("could not remove the egress proxy")),
          `${kind}: the problem is logged`,
        );
        assert(
          h.logged.every((m) => !m.includes(TOKEN)),
          `${kind}: the token must not be logged`,
        );
      }
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("egress preflight failures happen before any egress step, for both egress kinds", async () => {
  const f = await makeFixture();
  try {
    for (const kind of ["apple", "enforced"] as const) {
      const offPath = harness(f, { kind, onPath: false });
      await assertRejects(
        () => runBabysitterRepairContainer(inputFor(f), offPath.deps),
        Error,
        "cannot run fake-runtime: the container runtime is not on PATH",
      );
      assertEquals(
        offPath.h.events,
        [],
        `${kind}: no egress before PATH check`,
      );

      const noImage = harness(f, { kind, imageExists: false });
      await assertRejects(
        () => runBabysitterRepairContainer(inputFor(f), noImage.deps),
        Error,
        "the worker image is not built; start the Vibe Coder (./run.sh) once to build it",
      );
      assertEquals(
        noImage.h.events,
        [],
        `${kind}: no egress before image check`,
      );
      assertEquals(noImage.h.spawns.length, 0, kind);

      const control = harness(f, { kind });
      await runBabysitterRepairContainer(inputFor(f), control.deps);
      assert(control.h.events.length > 0, `${kind}: control runs egress`);
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("apple egress: helper args that mount the App key are refused, spawn nothing, and the helper is still stopped", async () => {
  const f = await makeFixture();
  try {
    const { deps, h } = harness(f, {
      kind: "apple",
      helperRunArgs: ["run", "--rm", "--volume", `${f.keyDir}:/k`, IMAGE],
    });
    const error = await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), deps),
      Error,
      "refusing to mount",
    );
    assertStringIncludes(error.message, "App private key");
    assertEquals(h.spawns.length, 0, "a refused run spawns nothing");
    assertEquals(
      h.events,
      ["start-apple", "stop-apple"],
      "the helper is stopped after the refusal",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("the default Apple helper fails fast with an egress set-up cause when its script is absent", async () => {
  const empty = await Deno.makeTempDir();
  try {
    const plan = fakePlan("/unused", "vibe-babysitter-default", "apple");
    const prefix = "egress setup failed: ";
    const error = await assertRejects(
      () =>
        babysitterStartAppleEgress(
          plan,
          { baseDir: empty, timeoutMs: 60_000 },
          { readyTimeoutMs: 30_000, pollMs: 20 },
        ),
      Error,
      prefix,
    );
    assert(error.message.startsWith(prefix), `got ${error.message}`);
    const cause = error.message.slice(prefix.length).trim();
    assert(cause !== "", "the cause after the prefix is not empty");
  } finally {
    await Deno.remove(empty, { recursive: true });
  }
});
