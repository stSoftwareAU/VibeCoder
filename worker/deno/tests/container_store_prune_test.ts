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
}): { deps: StorePruneDeps; calls: string[][]; log: string[] } {
  const calls: string[][] = [];
  const log: string[] = [];
  const deps: StorePruneDeps = {
    runRuntime: (args) => {
      calls.push([...args]);
      return Promise.resolve(
        options.responses?.(args) ?? { code: 0, stdout: "", stderr: "" },
      );
    },
    freeSpace: () => Promise.resolve(options.free ?? null),
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
    builderDeleteReason({ availableBytes: 50, totalBytes: 100 }, 20),
    null,
  );
  assertStringIncludes(
    builderDeleteReason({ availableBytes: 5, totalBytes: 100 }, 20)!,
    "below the 20% floor",
  );
  assertEquals(builderDeleteReason(null, 20), null);
});

Deno.test("pruneContainerStore - removes only the throwaway volumes, never vibe-work or vibe-approval-state", async () => {
  const { deps, calls } = makeDeps({
    responses: (args) =>
      args[0] === "volume" && args[1] === "ls"
        ? { code: 0, stdout: APPLE_VOLUMES, stderr: "" }
        : undefined,
    free: { availableBytes: 200, totalBytes: 400 },
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
    free: { availableBytes: 200, totalBytes: 400 },
  });
  await pruneContainerStore(deps, { dialect: APPLE, storePath: "/store" });
  const imagePrune = calls.find((c) => c[0] === "image" && c[1] === "prune")!;
  assertEquals(imagePrune.includes("--all"), false);
  assertEquals(imagePrune.includes("-a"), false);
  assertEquals(calls.some((c) => c[0] === "builder"), false);
});

Deno.test("pruneContainerStore - deletes the builder when free space is below the floor", async () => {
  const { deps, calls } = makeDeps({
    free: { availableBytes: 23, totalBytes: 460 }, // 5% — the crashed host
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
    free: { availableBytes: 1, totalBytes: 400 },
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
    free: { availableBytes: 1, totalBytes: 400 },
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
    free: { availableBytes: 200, totalBytes: 400 },
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
