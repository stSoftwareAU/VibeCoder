/**
 * Tests for the host container-store reclamation (Issue #227).
 *
 * Nothing here runs a container runtime: every call is a seam, and the
 * assertions are about *what the launcher would have asked the runtime to
 * delete* — the production volumes must never be an argument to a removal,
 * the builder must survive on a host with room, and a failed step must be
 * reported rather than swallowed.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  builderDeleteReason,
  type FreeSpace,
  parseDfOutput,
  parseVolumeListing,
  pruneContainerStore,
  type RuntimeInvocation,
  selectThrowawayVolumes,
  type StorePruneDeps,
} from "../lib/container_store_prune.ts";
import { CONTAINER_RUNTIMES } from "../lib/container_runtime.ts";
import {
  DEFAULT_LOW_FLOOR_GB,
  DEFAULT_LOW_FLOOR_PERCENT,
  type DiskFloors,
  resolveDiskFloors,
} from "../lib/host_disk.ts";

/**
 * Free-space fixtures are in real bytes (Issue #493). The floor has a
 * gigabyte component now, so "460" cannot stand in for a 460 GB host.
 */
const GB = 1_073_741_824;

/** The floors the worker itself claims at. */
const WORKER_FLOORS: DiskFloors = {
  lowFloorGb: DEFAULT_LOW_FLOOR_GB,
  lowFloorPercent: DEFAULT_LOW_FLOOR_PERCENT,
  // Issue #732: each term now says where it came from.
  lowFloorGbSource: "default",
  lowFloorPercentSource: "default",
};

const APPLE = CONTAINER_RUNTIMES["apple-container"].dialect;
const DOCKER = CONTAINER_RUNTIMES["docker"].dialect;

const APPLE_VOLUMES = JSON.stringify([
  {
    configuration: { name: "vibe-test-work-d06df9d0" },
    id: "vibe-test-work-d06df9d0",
  },
  { configuration: { name: "vibe-approval-state" }, id: "vibe-approval-state" },
  { configuration: { name: "vibe-work" }, id: "vibe-work" },
  {
    configuration: { name: "vibe-test-approval-1234" },
    id: "vibe-test-approval-1234",
  },
]);

function makeDeps(options: {
  responses?: (args: readonly string[]) => RuntimeInvocation | undefined;
  free?: FreeSpace | null;
  /**
   * Successive free-space readings, for the before/after measurement the
   * builder delete reports (Issue #493). The last value repeats.
   */
  freeSequence?: (FreeSpace | null)[];
}): { deps: StorePruneDeps; calls: string[][]; log: string[] } {
  const calls: string[][] = [];
  const log: string[] = [];
  let reading = 0;
  const deps: StorePruneDeps = {
    runRuntime: (args) => {
      calls.push([...args]);
      return Promise.resolve(
        options.responses?.(args) ?? { code: 0, stdout: "", stderr: "" },
      );
    },
    freeSpace: () => {
      if (options.freeSequence) {
        const index = Math.min(reading++, options.freeSequence.length - 1);
        return Promise.resolve(options.freeSequence[index] ?? null);
      }
      return Promise.resolve(options.free ?? null);
    },
    log: (m) => log.push(m),
  };
  return { deps, calls, log };
}

Deno.test("parseVolumeListing - reads Apple container's JSON array", () => {
  assertEquals(parseVolumeListing(APPLE_VOLUMES), [
    "vibe-test-work-d06df9d0",
    "vibe-approval-state",
    "vibe-work",
    "vibe-test-approval-1234",
  ]);
});

Deno.test("parseVolumeListing - reads Docker's one-name-per-line and JSON-lines shapes", () => {
  assertEquals(parseVolumeListing("vibe-work\nvibe-test-work-1\n"), [
    "vibe-work",
    "vibe-test-work-1",
  ]);
  assertEquals(
    parseVolumeListing('{"Name":"vibe-work"}\n{"Name":"vibe-test-work-2"}\n'),
    ["vibe-work", "vibe-test-work-2"],
  );
  assertEquals(parseVolumeListing(""), []);
  assertEquals(parseVolumeListing("[]"), []);
});

Deno.test("selectThrowawayVolumes - only vibe-test-* names, and only names safe as arguments", () => {
  assertEquals(
    selectThrowawayVolumes([
      "vibe-work",
      "vibe-approval-state",
      "vibe-test-work-abc",
      "vibe-test-approval-abc",
      "vibe-test-work-abc;rm -rf /",
      "other",
    ]),
    ["vibe-test-work-abc", "vibe-test-approval-abc"],
  );
});

Deno.test("parseDfOutput - reads the available column of df -kP", () => {
  const out = "Filesystem 1024-blocks Used Available Capacity Mounted on\n" +
    "/dev/disk3s5 482797652 436000000 24000000 95% /System/Volumes/Data\n";
  const free = parseDfOutput(out)!;
  assertEquals(free.totalBytes, 482797652 * 1024);
  assertEquals(free.availableBytes, 24000000 * 1024);
  assertEquals(parseDfOutput("garbage"), null);
});

Deno.test("builderDeleteReason - keeps the builder with room, deletes it below the floor, keeps it when unknown", () => {
  assertEquals(
    builderDeleteReason(
      { availableBytes: 200 * GB, totalBytes: 400 * GB },
      WORKER_FLOORS,
    ),
    null,
  );
  assertStringIncludes(
    builderDeleteReason(
      { availableBytes: 5 * GB, totalBytes: 100 * GB },
      WORKER_FLOORS,
    )!,
    "below the 20.0 GB floor the worker stops claiming at",
  );
  assertEquals(builderDeleteReason(null, WORKER_FLOORS), null);
});

Deno.test("builderDeleteReason - keeps the builder on a host the worker is still claiming on (Issue #493)", () => {
  // GRQ-23 on 2026-08-28: 56.3 GB free of 460.4 GB. The worker's floor is
  // 46.0 GB, so it was claiming and running happily — and the old hardcoded
  // 20% builder floor (92.1 GB) deleted the build cache on every launch,
  // making every image-definition change pay a full cold rebuild.
  assertEquals(
    builderDeleteReason(
      { availableBytes: 56.3 * GB, totalBytes: 460.4 * GB },
      WORKER_FLOORS,
    ),
    null,
  );
});

Deno.test("builderDeleteReason - names the floor it measured against, in the worker's units (Issue #493)", () => {
  const reason = builderDeleteReason(
    { availableBytes: 30 * GB, totalBytes: 460.4 * GB },
    WORKER_FLOORS,
  )!;
  assertStringIncludes(reason, "30.0 GB free");
  assertStringIncludes(reason, "46.0 GB floor");
  assertStringIncludes(reason, "the larger of 20 GB and 10%");
});

Deno.test("builderDeleteReason - an explicit percent override still deletes earlier (Issue #493)", () => {
  const eager: DiskFloors = {
    lowFloorGb: 0,
    lowFloorPercent: 20,
    lowFloorGbSource: "config",
    lowFloorPercentSource: "config",
  };
  assertStringIncludes(
    builderDeleteReason(
      { availableBytes: 56.3 * GB, totalBytes: 460.4 * GB },
      eager,
    )!,
    "92.1 GB floor",
  );
});

Deno.test("pruneContainerStore - removes only the throwaway volumes, never vibe-work or vibe-approval-state", async () => {
  const { deps, calls } = makeDeps({
    responses: (args) =>
      args[0] === "volume" && args[1] === "ls"
        ? { code: 0, stdout: APPLE_VOLUMES, stderr: "" }
        : undefined,
    free: { availableBytes: 200 * GB, totalBytes: 400 * GB },
  });
  const outcome = await pruneContainerStore(deps, {
    dialect: APPLE,
    storePath: "/store",
  });
  const removals = calls.filter((c) => c[0] === "volume" && c[1] === "delete")
    .map((c) => c[2]);
  assertEquals(removals, [
    "vibe-test-work-d06df9d0",
    "vibe-test-approval-1234",
  ]);
  assertEquals(outcome.ok, true);
  assertEquals(outcome.steps[0]!.removed, removals);
});

Deno.test("pruneContainerStore - prunes dangling images only (never --all) and keeps the builder with room", async () => {
  const { deps, calls } = makeDeps({
    free: { availableBytes: 200 * GB, totalBytes: 400 * GB },
  });
  await pruneContainerStore(deps, { dialect: APPLE, storePath: "/store" });
  const imagePrune = calls.find((c) => c[0] === "image" && c[1] === "prune")!;
  assertEquals(imagePrune.includes("--all"), false);
  assertEquals(imagePrune.includes("-a"), false);
  assertEquals(calls.some((c) => c[0] === "builder"), false);
});

Deno.test("pruneContainerStore - deletes the builder when free space is below the floor", async () => {
  const { deps, calls } = makeDeps({
    free: { availableBytes: 23 * GB, totalBytes: 460 * GB }, // the crashed host
  });
  const outcome = await pruneContainerStore(deps, {
    dialect: APPLE,
    storePath: "/store",
  });
  assertEquals(
    calls.some((c) => c[0] === "builder" && c[1] === "delete"),
    true,
  );
  const builder = outcome.steps.find((s) => s.step === "builder")!;
  assertEquals(builder.removed, ["builder"]);
});

Deno.test("pruneContainerStore - a runtime without a builder container skips that step", async () => {
  const { deps, calls } = makeDeps({
    free: { availableBytes: 1 * GB, totalBytes: 400 * GB },
  });
  const outcome = await pruneContainerStore(deps, {
    dialect: DOCKER,
    storePath: "/store",
  });
  assertEquals(calls.some((c) => c[0] === "builder"), false);
  assertEquals(outcome.ok, true);
  // Docker's prune is non-interactive.
  const imagePrune = calls.find((c) => c[0] === "image" && c[1] === "prune")!;
  assertEquals(imagePrune.includes("-f"), true);
});

Deno.test("pruneContainerStore - a builder that is already gone is the state we wanted", async () => {
  const { deps } = makeDeps({
    responses: (args) =>
      args[0] === "builder"
        ? { code: 1, stdout: "", stderr: "Error: builder not found" }
        : undefined,
    free: { availableBytes: 1 * GB, totalBytes: 400 * GB },
  });
  const outcome = await pruneContainerStore(deps, {
    dialect: APPLE,
    storePath: "/store",
  });
  assertEquals(outcome.ok, true);
});

Deno.test("pruneContainerStore - a failed step is reported and does not stop the others", async () => {
  const { deps, calls } = makeDeps({
    responses: (args) =>
      args[0] === "volume" && args[1] === "ls"
        ? { code: 1, stdout: "", stderr: "daemon unreachable" }
        : undefined,
    free: { availableBytes: 200 * GB, totalBytes: 400 * GB },
  });
  const outcome = await pruneContainerStore(deps, {
    dialect: APPLE,
    storePath: "/store",
  });
  assertEquals(outcome.ok, false);
  assertStringIncludes(outcome.steps[0]!.detail, "daemon unreachable");
  // The image prune still ran.
  assertEquals(calls.some((c) => c[0] === "image" && c[1] === "prune"), true);
});

Deno.test("pruneContainerStore - reports what deleting the builder reclaimed (Issue #493)", async () => {
  const { deps, log } = makeDeps({
    freeSequence: [
      { availableBytes: 23 * GB, totalBytes: 460 * GB },
      { availableBytes: 36 * GB, totalBytes: 460 * GB },
    ],
  });
  const outcome = await pruneContainerStore(deps, {
    dialect: APPLE,
    storePath: "/store",
  });

  const builder = outcome.steps.find((s) => s.step === "builder")!;
  assertEquals(builder.removed, ["builder"]);
  // The reading that triggered the delete cannot answer "did it help?".
  assertStringIncludes(builder.detail!, "reclaimed 13.0 GB");
  assertStringIncludes(log.join("\n"), "reclaimed 13.0 GB");
});

Deno.test("pruneContainerStore - a builder delete that recovered nothing says so (Issue #493)", async () => {
  const { deps } = makeDeps({
    free: { availableBytes: 23 * GB, totalBytes: 460 * GB },
  });
  const outcome = await pruneContainerStore(deps, {
    dialect: APPLE,
    storePath: "/store",
  });

  const builder = outcome.steps.find((s) => s.step === "builder")!;
  assertStringIncludes(builder.detail!, "reclaimed nothing");
});

Deno.test("run.sh's work-volume heal floor does not drift from the worker's (Issues #493, #732)", async () => {
  // One host disk, one floor. `run.sh` used to resolve it from two
  // environment variables of its own, and this guard read its source to keep
  // those fallbacks in step with the constants. Since Issue #732 the floor is
  // resolved once, by `resolveDiskFloors`, and carried in the launch plan —
  // so the property is now checked on the real path rather than by reading
  // the script.
  const floors = resolveDiskFloors(() => undefined);
  assertEquals(floors.lowFloorGb, DEFAULT_LOW_FLOOR_GB);
  assertEquals(floors.lowFloorPercent, DEFAULT_LOW_FLOOR_PERCENT);

  // What `run.sh` keeps of its own is a defensive fallback for a plan value
  // it cannot parse; that must not drift from the constants either.
  const runSh = await Deno.readTextFile(
    new URL("../../../run.sh", import.meta.url),
  );
  assertStringIncludes(runSh, `|| gb=${DEFAULT_LOW_FLOOR_GB}`);
  assertStringIncludes(runSh, `|| pct=${DEFAULT_LOW_FLOOR_PERCENT}`);
});
