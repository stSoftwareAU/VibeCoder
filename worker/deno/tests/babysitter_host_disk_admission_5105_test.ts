/**
 * Babysitter host-disk admission (Issue #5105): a repair container starts its
 * own egress proxy, so the repair is admitted against the host floor and the
 * shared reservation ledger before any egress starts, and the queue runs one
 * repair container at a time.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  BABYSITTER_REPAIR_CONTAINER_LIMIT,
  type RepairTask,
  runRepairs,
} from "../commands/fleet_pr_babysitter.ts";
import {
  type BabysitterContainerDeps,
  babysitterHostDiskAdmission,
  runBabysitterRepairContainer,
} from "../lib/fleet_babysitter_container.ts";
import { EPHEMERAL_CARGO_HEADROOM_BYTES } from "../lib/heavy_build_gate.ts";
import {
  BABYSITTER_LAUNCH_FOOTPRINT_BYTES,
  readLiveHostDiskReservations,
} from "../lib/host_disk_reservations.ts";
import {
  fakeContainer,
  repairDirs,
  repairHost,
  repairPlan,
  type RuntimeSpawn,
} from "./fixtures/babysitter_container_fakes_4770.ts";

const GIB = 1024 ** 3;
const NOW = 1_900_000_000_000;

async function withRepair(
  run: (
    ctx: {
      events: string[];
      spawns: RuntimeSpawn[];
      deps: Partial<BabysitterContainerDeps>;
      input: Parameters<typeof runBabysitterRepairContainer>[0];
    },
  ) => Promise<void>,
  options: { spawnFails?: boolean } = {},
): Promise<void> {
  const host = repairHost();
  const dirs = await repairDirs();
  try {
    const events: string[] = [];
    const spawns: RuntimeSpawn[] = [];
    const base = fakeContainer(spawns, { host });
    const deps: Partial<BabysitterContainerDeps> = {
      ...base,
      buildPlan: async (_baseDir, name) => ({
        ...(await repairPlan(host, name)),
        egressEnforced: true,
      }),
      startSidecar: () => {
        events.push("start-sidecar");
        return Promise.resolve();
      },
      stopSidecar: () => {
        events.push("stop-sidecar");
        return Promise.resolve([]);
      },
      startAppleEgress: () => {
        events.push("start-apple");
        return Promise.reject(new Error("apple helper must not start"));
      },
      spawn: (runtime, args, o) => {
        events.push("spawn");
        if (options.spawnFails) return Promise.reject(new Error("spawn boom"));
        return base.spawn!(runtime, args, o);
      },
      log: () => {},
    };
    await run({
      events,
      spawns,
      deps,
      input: {
        baseDir: host.baseDir,
        clone: dirs.dir,
        scratch: dirs.scratch,
        privateKeyPath: `${host.root}/app-key.pem`,
        token: "ghs_admission_token",
      },
    });
  } finally {
    await Deno.remove(dirs.root, { recursive: true });
    await Deno.remove(host.root, { recursive: true });
  }
}

Deno.test("a refused host-disk admission starts no egress and no container, and the error propagates", async () => {
  await withRepair(async ({ events, spawns, deps, input }) => {
    await assertRejects(
      () =>
        runBabysitterRepairContainer(input, {
          ...deps,
          hostDiskAdmission: () =>
            Promise.reject(
              new Error(
                "babysitter repair not started: too little (Issue #5105)",
              ),
            ),
        }),
      Error,
      "babysitter repair not started",
    );
    assertEquals(events, []);
    assertEquals(spawns.length, 0);
  });
});

Deno.test("an admitted repair releases once, after the sidecar stop", async () => {
  await withRepair(async ({ events, deps, input }) => {
    await runBabysitterRepairContainer(input, {
      ...deps,
      hostDiskAdmission: () => {
        events.push("admit");
        return Promise.resolve({
          release: () => {
            events.push("release");
            return Promise.resolve();
          },
        });
      },
    });
    assertEquals(events, [
      "admit",
      "start-sidecar",
      "spawn",
      "stop-sidecar",
      "release",
    ]);
  });
});

Deno.test("the reservation is released once, after the sidecar stop, when the spawn fails", async () => {
  await withRepair(async ({ events, deps, input }) => {
    await assertRejects(
      () =>
        runBabysitterRepairContainer(input, {
          ...deps,
          hostDiskAdmission: () =>
            Promise.resolve({
              release: () => {
                events.push("release");
                return Promise.resolve();
              },
            }),
        }),
      Error,
      "spawn boom",
    );
    assertEquals(events, ["start-sidecar", "spawn", "stop-sidecar", "release"]);
  }, { spawnFails: true });
});

Deno.test("a failing release is logged and does not mask the repair's error", async () => {
  await withRepair(async ({ deps, input }) => {
    const logged: string[] = [];
    await assertRejects(
      () =>
        runBabysitterRepairContainer(input, {
          ...deps,
          log: (m) => logged.push(m),
          hostDiskAdmission: () =>
            Promise.resolve({
              release: () => Promise.reject(new Error("cannot remove")),
            }),
        }),
      Error,
      "spawn boom",
    );
    assertEquals(logged.length, 1);
    assertStringIncludes(logged[0]!, "cannot remove");
  }, { spawnFails: true });
});

function admissionDeps(
  dir: string,
  over: {
    available?: number | null;
    cargo?: boolean;
  } = {},
) {
  const available = over.available === undefined ? 200 * GIB : over.available;
  const logged: string[] = [];
  return {
    logged,
    deps: {
      measure: () =>
        Promise.resolve(
          available === null ? null : {
            availableBytes: available,
            usedBytes: 800 * GIB - available,
            totalBytes: 800 * GIB,
          },
        ),
      floor: () => Promise.resolve(46 * GIB),
      reservationDir: () => Promise.resolve(dir),
      now: () => NOW,
      holdsCargo: () => Promise.resolve(over.cargo ?? false),
      log: (m: string) => logged.push(m),
    },
  };
}

const request = (name: string) => ({
  containerName: name,
  clone: "/unused",
  timeoutMs: 90 * 60_000,
});

Deno.test("admission writes a footprint reservation for a non-cargo clone and release removes it", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { deps } = admissionDeps(dir);
    const admitted = await babysitterHostDiskAdmission(
      request("vibe-babysitter-a"),
      deps,
    );
    const live = await readLiveHostDiskReservations(dir, NOW);
    assertEquals(live.length, 1);
    assertEquals(live[0]!.bytes, BABYSITTER_LAUNCH_FOOTPRINT_BYTES);
    assertEquals(live[0]!.availableAtAdmission, 200 * GIB);
    assertEquals(live[0]!.expiresAt, NOW + 100 * 60_000);
    await admitted.release();
    assertEquals(await readLiveHostDiskReservations(dir, NOW), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("admission adds the cargo headroom for a clone with a Cargo.toml", async () => {
  const dir = await Deno.makeTempDir();
  const clone = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${clone}/Cargo.toml`,
      '[package]\nname = "x"\nversion = "0.1.0"\n',
    );
    const { deps } = admissionDeps(dir);
    // Use the production cargo detection against a real manifest.
    const { holdsCargo: _unused, ...rest } = deps;
    const { findProjectManifests } = await import(
      "../lib/project_manifests.ts"
    );
    const detected = (await findProjectManifests(clone)).some((p) =>
      p.kind === "cargo"
    );
    assert(detected);
    await babysitterHostDiskAdmission(
      { ...request("vibe-babysitter-b"), clone },
      { ...rest, holdsCargo: () => Promise.resolve(detected) },
    );
    const live = await readLiveHostDiskReservations(dir, NOW);
    assertEquals(
      live[0]!.bytes,
      BABYSITTER_LAUNCH_FOOTPRINT_BYTES + EPHEMERAL_CARGO_HEADROOM_BYTES,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(clone, { recursive: true });
  }
});

Deno.test("admission refuses when a live reservation's outstanding bytes leave too little, and admits the same measurement without it", async () => {
  const control = await Deno.makeTempDir();
  const dir = await Deno.makeTempDir();
  try {
    // 70 GB free, floor 46 GB: one 16 GB request fits (70 - 16 >= 46).
    await babysitterHostDiskAdmission(
      request("vibe-babysitter-c"),
      admissionDeps(control, { available: 70 * GIB }).deps,
    );
    // An earlier repair reserved 16 GB and has consumed none yet.
    await babysitterHostDiskAdmission(
      request("vibe-babysitter-d"),
      admissionDeps(dir, { available: 70 * GIB }).deps,
    );
    const error = await assertRejects(
      () =>
        babysitterHostDiskAdmission(
          request("vibe-babysitter-e"),
          admissionDeps(dir, { available: 70 * GIB }).deps,
        ),
      Error,
      "babysitter repair not started",
    );
    assertStringIncludes(error.message, "(Issue #5105)");
    assertEquals((await readLiveHostDiskReservations(dir, NOW)).length, 1);
  } finally {
    await Deno.remove(control, { recursive: true });
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an unmeasurable host admits, writes no reservation and logs it", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { deps, logged } = admissionDeps(dir, { available: null });
    const admitted = await babysitterHostDiskAdmission(
      request("vibe-babysitter-f"),
      deps,
    );
    await admitted.release();
    assertEquals(await readLiveHostDiskReservations(dir, NOW), []);
    assertEquals(logged.length, 1);
    assertStringIncludes(logged[0]!, "could not be measured");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the production queue runs one repair container at a time", async () => {
  assertEquals(BABYSITTER_REPAIR_CONTAINER_LIMIT, 1);
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const task = (key: string): RepairTask => ({
    key,
    version: "v1",
    run: () => {
      started.push(key);
      return new Promise<void>((resolve) => gates.set(key, resolve));
    },
  });
  const done = runRepairs(
    [task("a"), task("b")],
    BABYSITTER_REPAIR_CONTAINER_LIMIT,
  );
  // Let the queue settle: the second task must not have started.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assertEquals(started, ["a"]);
  gates.get("a")!();
  while (started.length < 2) await new Promise<void>((r) => queueMicrotask(r));
  assertEquals(started, ["a", "b"]);
  gates.get("b")!();
  await done;
});
