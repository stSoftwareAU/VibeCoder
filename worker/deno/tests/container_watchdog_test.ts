/**
 * Tests for the container watchdog and reaper (Issue #4173).
 *
 * A wedged container VM stops answering while the host-side `container run`
 * client waits for it for ever — which blocks `run.sh`, and the supervisor
 * behind it, indefinitely (observed on host-23: three hours of a blocked
 * `run.sh` and a leaked 1 GB VM). These tests pin the two layers that convert
 * "wedged for ever" into "one lost cycle": the deadline the launchers wait
 * under, and the reaper that kills the container and, when the record survives
 * it, the host-side processes holding it.
 *
 * Every seam is injected, so nothing here signals a real process or invokes a
 * real container runtime.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type ContainerRecord,
  DEFAULT_KILL_GRACE_SECONDS,
  dialectForExecutable,
  KILL_GRACE_SECONDS_ENV,
  launcherPidFromContainerName,
  parseContainerListing,
  parseProcessTable,
  type ProcessEntry,
  type ReapDeps,
  reapStaleContainers,
  reapWedgedContainer,
  resolveGraceSeconds,
  resolveWatchdogSeconds,
  selectContainerProcesses,
  selectLiveWorkerContainers,
  selectStaleContainers,
  WATCHDOG_MARGIN_SECONDS,
  WATCHDOG_SECONDS_ENV,
  WEDGE_SELF_HEAL_ACTION,
  WEDGE_SELF_HEAL_MODULE,
  WORKER_CONTAINER_PREFIX,
} from "../lib/container_watchdog.ts";
import type { SelfHealEvent } from "../lib/self_heal_events.ts";

// ---------------------------------------------------------------------------
// The deadline
// ---------------------------------------------------------------------------

Deno.test("resolveWatchdogSeconds - defaults to the worker's own limit plus a margin", () => {
  assertEquals(
    resolveWatchdogSeconds({ env: () => undefined, maxRunSeconds: 10_800 }),
    10_800 + WATCHDOG_MARGIN_SECONDS,
  );
});

Deno.test("resolveWatchdogSeconds - an operator override wins verbatim", () => {
  assertEquals(
    resolveWatchdogSeconds({
      env: (name) => name === WATCHDOG_SECONDS_ENV ? " 45 " : undefined,
      maxRunSeconds: 10_800,
    }),
    45,
  );
});

Deno.test("resolveWatchdogSeconds - an unusable override is reported, not obeyed", () => {
  for (const value of ["0", "-30", "soon", ""]) {
    const warnings: string[] = [];
    assertEquals(
      resolveWatchdogSeconds({
        env: (name) => name === WATCHDOG_SECONDS_ENV ? value : undefined,
        maxRunSeconds: 600,
        warn: (message) => warnings.push(message),
      }),
      600 + WATCHDOG_MARGIN_SECONDS,
      value,
    );
    // An empty variable is simply unset, so only a real value is reported.
    assertEquals(warnings.length, value === "" ? 0 : 1, value);
  }
});

Deno.test("resolveGraceSeconds - defaults, overrides, and reports nonsense", () => {
  assertEquals(
    resolveGraceSeconds(() => undefined),
    DEFAULT_KILL_GRACE_SECONDS,
  );
  assertEquals(
    resolveGraceSeconds((name) =>
      name === KILL_GRACE_SECONDS_ENV ? "5" : undefined
    ),
    5,
  );

  const warnings: string[] = [];
  assertEquals(
    resolveGraceSeconds(
      (name) => name === KILL_GRACE_SECONDS_ENV ? "none" : undefined,
      (message) => warnings.push(message),
    ),
    DEFAULT_KILL_GRACE_SECONDS,
  );
  assertEquals(warnings.length, 1);
});

// ---------------------------------------------------------------------------
// The host process table
// ---------------------------------------------------------------------------

const PROCESS_TABLE = [
  "  501 /usr/local/bin/container run --name vibe-coder-66770 --memory 16g img",
  " 9021 /usr/libexec/container-runtime-linux --name vibe-coder-66770 --debug",
  " 9022 /usr/local/bin/container run --name vibe-coder-667 --memory 16g img",
  "  777 /bin/bash ./run.sh",
  "junk without a pid",
].join("\n");

Deno.test("parseProcessTable - reads pid and argv, ignoring unparseable lines", () => {
  const entries = parseProcessTable(PROCESS_TABLE);
  assertEquals(entries.length, 4);
  assertEquals(entries[0], {
    pid: 501,
    args:
      "/usr/local/bin/container run --name vibe-coder-66770 --memory 16g img",
  });
  assertEquals(entries[3]!.pid, 777);
});

Deno.test("selectContainerProcesses - matches only processes holding this container", () => {
  const selected = selectContainerProcesses(parseProcessTable(PROCESS_TABLE), {
    containerName: "vibe-coder-66770",
    runtimeExecutable: "container",
  });

  // The runtime client and the runtime helper, and not the container whose
  // name merely shares a prefix (vibe-coder-667).
  assertEquals(selected.map((entry) => entry.pid), [501, 9021]);
});

Deno.test("selectContainerProcesses - never selects the reaper or an excluded pid", () => {
  const entries: ProcessEntry[] = [
    { pid: 11, args: "container run --name vibe-coder-1 image" },
    { pid: 12, args: "deno run mod.ts container-reap --name vibe-coder-1" },
    { pid: 13, args: "container-runtime-linux --name vibe-coder-1" },
  ];

  assertEquals(
    selectContainerProcesses(entries, {
      containerName: "vibe-coder-1",
      runtimeExecutable: "container",
      excludePids: [11],
    }).map((entry) => entry.pid),
    [13],
  );
});

Deno.test("selectContainerProcesses - a process that merely quotes the name is never killed", () => {
  // The lesson of Issue #4275: a container name is a plain string, and the
  // worker's own agent session, an editor or a log tail can all carry one.
  // Only a process started from the runtime (or a helper named after it) is a
  // SIGKILL candidate.
  const entries: ProcessEntry[] = [
    {
      pid: 21,
      args: "/usr/local/bin/claude --system-prompt reap vibe-coder-1",
    },
    { pid: 22, args: "tail -n 50 /home/vibe/logs/vibe-coder-1.log" },
    { pid: 23, args: "/usr/bin/docker run --name vibe-coder-1 image" },
  ];

  assertEquals(
    selectContainerProcesses(entries, {
      containerName: "vibe-coder-1",
      runtimeExecutable: "/usr/bin/docker",
    }).map((entry) => entry.pid),
    [23],
  );
});

// ---------------------------------------------------------------------------
// The runtime's container listing
// ---------------------------------------------------------------------------

Deno.test("parseContainerListing - reads Docker's JSON lines", () => {
  const records = parseContainerListing(
    [
      '{"Names":"vibe-coder-42","CreatedAt":"2026-08-16 04:54:01 +1000 AEST"}',
      '{"Names":"other","CreatedAt":"2026-08-16 05:00:00 +1000 AEST"}',
    ].join("\n"),
  );

  assertEquals(records.map((record) => record.name), [
    "vibe-coder-42",
    "other",
  ]);
  assertEquals(
    records[0]!.createdAt,
    Date.parse("2026-08-16 04:54:01 +1000"),
  );
});

Deno.test("parseContainerListing - reads Podman's JSON array with epoch seconds", () => {
  const created = 1_755_000_000;
  const records = parseContainerListing(
    JSON.stringify([{ Names: ["vibe-coder-7"], Created: created }]),
  );

  assertEquals(records.length, 1);
  assertEquals(records[0]!.name, "vibe-coder-7");
  assertEquals(records[0]!.createdAt, created * 1000);
});

Deno.test("parseContainerListing - reads Apple container's nested identity", () => {
  const records = parseContainerListing(
    JSON.stringify([
      { status: "running", configuration: { id: "vibe-coder-66770" } },
    ]),
  );

  assertEquals(records.length, 1);
  assertEquals(records[0]!.name, "vibe-coder-66770");
  assertEquals(records[0]!.createdAt, undefined);
});

Deno.test("parseContainerListing - a plain name list and unusable output", () => {
  assertEquals(
    parseContainerListing("vibe-coder-9\nvibe-coder-10\n").map((r) => r.name),
    ["vibe-coder-9", "vibe-coder-10"],
  );
  assertEquals(parseContainerListing(""), []);
  assertEquals(parseContainerListing("   \n\n"), []);
});

// ---------------------------------------------------------------------------
// Choosing what to reap before a launch
// ---------------------------------------------------------------------------

Deno.test("launcherPidFromContainerName - reads the launcher pid the name carries", () => {
  assertEquals(
    launcherPidFromContainerName(`${WORKER_CONTAINER_PREFIX}66770`),
    66770,
  );
  assertEquals(launcherPidFromContainerName("vibe-coder-66770-init"), null);
  assertEquals(launcherPidFromContainerName("other-1"), null);
});

Deno.test("selectStaleContainers - reaps a container older than the deadline", () => {
  const now = 1_800_000_000_000;
  const stale = selectStaleContainers({
    records: [
      { name: "vibe-coder-1", createdAt: now - 4_000_000 },
      { name: "vibe-coder-2", createdAt: now - 1_000 },
    ],
    maxAgeSeconds: 3_600,
    now,
    // Both launchers are alive, so age alone decides.
    isProcessAlive: () => true,
  });

  assertEquals(stale.map((entry) => entry.name), ["vibe-coder-1"]);
  assertEquals(stale[0]!.reason, "age");
});

Deno.test("selectLiveWorkerContainers - the complement of the stale scan: young, launcher alive, not this run's own (Issue #26)", () => {
  const now = 1_800_000_000_000;
  const live = selectLiveWorkerContainers({
    records: [
      { name: "vibe-coder-1", createdAt: now - 4_000_000 }, // stale by age
      { name: "vibe-coder-2", createdAt: now - 1_000 }, // live
      { name: "vibe-coder-3" }, // no age reported (Apple container), live
      { name: "vibe-coder-4", createdAt: now - 2_000 }, // launcher gone
      { name: "vibe-coder-5-init", createdAt: now - 500 }, // helper, not a worker
      { name: "vibe-coder-6", createdAt: now - 3_000 }, // this run's own
      { name: "postgres" }, // not ours
    ],
    maxAgeSeconds: 3_600,
    now,
    excludeNames: ["vibe-coder-6"],
    isProcessAlive: (pid) => pid !== 4,
  });

  assertEquals(
    live.map((entry) => `${entry.name}:${entry.launcherPid}`),
    ["vibe-coder-2:2", "vibe-coder-3:3"],
  );
  assertEquals(live[0]!.ageSeconds, 1);
  assertEquals(live[1]!.ageSeconds, undefined);
});

Deno.test("selectStaleContainers - reaps an orphan whose launcher is gone", () => {
  const now = 1_800_000_000_000;
  const stale = selectStaleContainers({
    records: [
      // No creation time (Apple container reports none), launcher gone.
      { name: "vibe-coder-11" },
      // Launcher still watching it — never reaped, whatever its age.
      { name: "vibe-coder-12", createdAt: now - 1_000 },
    ],
    maxAgeSeconds: 3_600,
    now,
    isProcessAlive: (pid) => pid === 12,
  });

  assertEquals(stale.map((entry) => entry.name), ["vibe-coder-11"]);
  assertEquals(stale[0]!.reason, "orphaned");
});

Deno.test("selectStaleContainers - leaves foreign and excluded containers alone", () => {
  const now = 1_800_000_000_000;
  assertEquals(
    selectStaleContainers({
      records: [
        // Not a worker container at all.
        { name: "postgres", createdAt: now - 9_000_000 },
        // This run's own container.
        { name: "vibe-coder-99", createdAt: now - 9_000_000 },
        // The volume-ownership init container of this run.
        { name: "vibe-coder-99-init" },
      ],
      maxAgeSeconds: 3_600,
      now,
      excludeNames: ["vibe-coder-99"],
      isProcessAlive: () => false,
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// The runtime's own spelling
// ---------------------------------------------------------------------------

Deno.test("dialectForExecutable - reads the listing dialect off the chosen runtime", () => {
  // Apple container spells the listing `list`; Docker and Podman spell it `ps`.
  assertEquals(
    dialectForExecutable("/usr/local/bin/container").listArgs[0],
    "list",
  );
  assertEquals(dialectForExecutable("docker").listArgs[0], "ps");
  assertEquals(
    dialectForExecutable("C:\\Program Files\\Docker\\podman.exe").listArgs[0],
    "ps",
  );
});

Deno.test("dialectForExecutable - refuses an executable that is not a supported runtime", () => {
  assertThrows(
    () => dialectForExecutable("kubectl"),
    Error,
    "not a container runtime",
  );
});

// ---------------------------------------------------------------------------
// Reaping
// ---------------------------------------------------------------------------

/** A recording set of seams, so no real process or runtime is touched. */
function stubDeps(overrides: Partial<ReapDeps> = {}): {
  deps: ReapDeps;
  runtimeCalls: string[][];
  killed: number[];
  events: Omit<SelfHealEvent, "timestamp">[];
  logs: string[];
} {
  const runtimeCalls: string[][] = [];
  const killed: number[] = [];
  const events: Omit<SelfHealEvent, "timestamp">[] = [];
  const logs: string[] = [];

  const deps: ReapDeps = {
    runtimeExecutable: "container",
    listArgs: ["ps", "--format", "json"],
    runRuntime: (args) => {
      runtimeCalls.push([...args]);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    listProcesses: () => Promise.resolve([]),
    killProcess: (pid) => {
      killed.push(pid);
      return true;
    },
    isProcessAlive: () => false,
    sleep: () => Promise.resolve(),
    now: () => 1_800_000_000_000,
    emit: (event) => {
      events.push(event);
      return Promise.resolve(true);
    },
    log: (message) => logs.push(message),
    ...overrides,
  };

  return { deps, runtimeCalls, killed, events, logs };
}

Deno.test("reapWedgedContainer - a container that dies to the runtime kill needs no SIGKILL", async () => {
  const { deps, runtimeCalls, killed, events } = stubDeps();

  const result = await reapWedgedContainer(deps, {
    containerName: "vibe-coder-5",
    clientPid: 5,
    reason: "watchdog deadline of 60s expired",
    trigger: "watchdog",
  });

  assertEquals(runtimeCalls[0], ["kill", "vibe-coder-5"]);
  assertEquals(result.runtimeKillExit, 0);
  assertEquals(killed, []);
  assertEquals(result.clientExited, true);
  assertEquals(result.stillListed, false);
  assertEquals(result.reaped, true);

  // The forced reap is fleet telemetry, not just a host log line.
  assertEquals(events.length, 1);
  assertEquals(events[0]!.module, WEDGE_SELF_HEAL_MODULE);
  assertEquals(events[0]!.action, WEDGE_SELF_HEAL_ACTION);
  assertEquals(events[0]!.result, "ok");
  assertStringIncludes(events[0]!.reason, "vibe-coder-5");
  assertEquals(
    (events[0]!.details as Record<string, unknown>)["trigger"],
    "watchdog",
  );
});

Deno.test("reapWedgedContainer - SIGKILLs the client and the runtime helper when the record survives", async () => {
  const stillAlive = new Set([501]);
  const { deps, killed, events, runtimeCalls } = stubDeps({
    // The runtime cannot reap its own container: "running and can not be
    // deleted", exactly as observed on host-23.
    runRuntime: (args) => {
      runtimeCalls.push([...args]);
      if (args[0] === "kill") {
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "running and can not be deleted",
        });
      }
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify([{ Names: "vibe-coder-66770" }]),
        stderr: "",
      });
    },
    isProcessAlive: (pid) => stillAlive.has(pid),
    listProcesses: () => Promise.resolve(parseProcessTable(PROCESS_TABLE)),
    killProcess: (pid) => {
      stillAlive.delete(pid);
      killed.push(pid);
      return true;
    },
  });

  const result = await reapWedgedContainer(deps, {
    containerName: "vibe-coder-66770",
    clientPid: 501,
    graceSeconds: 2,
    reason: "watchdog deadline of 60s expired",
    trigger: "watchdog",
  });

  assertEquals(result.runtimeKillExit, 1);
  // The client first — it is what blocks the launcher — then the runtime
  // helper process whose argv carries the container name.
  assertEquals(killed, [501, 9021]);
  assertEquals(result.clientExited, true);
  assertEquals(result.killedPids, [501, 9021]);
  assertEquals(events.length, 1);
  assertStringIncludes(
    String((events[0]!.details as Record<string, unknown>)["killedPids"]),
    "9021",
  );
});

Deno.test("reapWedgedContainer - a record that outlives every kill is reported as a failure", async () => {
  const { deps, events, logs } = stubDeps({
    runRuntime: (args) =>
      Promise.resolve(
        args[0] === "kill" ? { code: 1, stdout: "", stderr: "wedged" } : {
          code: 0,
          stdout: JSON.stringify([{ Names: "vibe-coder-3" }]),
          stderr: "",
        },
      ),
  });

  const result = await reapWedgedContainer(deps, {
    containerName: "vibe-coder-3",
    reason: "pre-launch scan found it older than 3600s",
    trigger: "pre_launch",
  });

  assertEquals(result.stillListed, true);
  assertEquals(result.reaped, false);
  // Fail loud: a reap that did not work must not be recorded as a success.
  assertEquals(events[0]!.result, "failed");
  assert(
    logs.some((line) => line.includes("vibe-coder-3")),
    `the reap must name the container on stderr: ${logs.join("\n")}`,
  );
});

Deno.test("reapWedgedContainer - refuses a container name the runtime would not accept", async () => {
  const { deps, runtimeCalls } = stubDeps();

  await assertRejects(
    () =>
      reapWedgedContainer(deps, {
        containerName: "vibe-coder-1; rm -rf /",
        reason: "watchdog",
        trigger: "watchdog",
      }),
    Error,
    "container name",
  );
  assertEquals(runtimeCalls, []);
});

Deno.test("reapWedgedContainer - the grace period defaults to the documented value", async () => {
  const slept: number[] = [];
  const { deps } = stubDeps({
    // Alive throughout, so every poll of the grace period is taken.
    isProcessAlive: () => true,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });

  await reapWedgedContainer(deps, {
    containerName: "vibe-coder-8",
    clientPid: 8,
    reason: "watchdog deadline of 60s expired",
    trigger: "watchdog",
  });

  assertEquals(
    slept.reduce((total, ms) => total + ms, 0),
    DEFAULT_KILL_GRACE_SECONDS * 1000,
  );
});

// ---------------------------------------------------------------------------
// The pre-launch scan
// ---------------------------------------------------------------------------

Deno.test("reapStaleContainers - reaps every leaked worker container it lists", async () => {
  const listing: ContainerRecord[] = [];
  const { deps, runtimeCalls, events } = stubDeps({
    runRuntime: (args) => {
      runtimeCalls.push([...args]);
      if (args[0] === "kill") {
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      }
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify(listing),
        stderr: "",
      });
    },
  });

  listing.push(
    { name: "vibe-coder-11" },
    { name: "vibe-coder-12" },
    { name: "postgres" },
  );

  const results = await reapStaleContainers(deps, {
    maxAgeSeconds: 3_600,
    excludeNames: ["vibe-coder-12"],
  });

  assertEquals(results.map((result) => result.containerName), [
    "vibe-coder-11",
  ]);
  assert(
    runtimeCalls.some((call) => call[0] === "ps"),
    "the scan must list the runtime's containers",
  );
  assertEquals(
    runtimeCalls.filter((call) => call[0] === "kill").map((call) => call[1]),
    ["vibe-coder-11"],
  );
  assertEquals(events.length, 1);
  assertStringIncludes(events[0]!.reason, "vibe-coder-11");
});

Deno.test("reapStaleContainers - a listing the runtime cannot produce is reported, not assumed empty", async () => {
  const { deps, logs } = stubDeps({
    runRuntime: () =>
      Promise.resolve({ code: 1, stdout: "", stderr: "cannot connect" }),
  });

  const results = await reapStaleContainers(deps, { maxAgeSeconds: 3_600 });

  assertEquals(results, []);
  assert(
    logs.some((line) => line.includes("cannot connect")),
    `a failed listing must be named on stderr: ${logs.join("\n")}`,
  );
});

Deno.test("reapStaleContainers - nothing leaked means no runtime kill and no event", async () => {
  const runtimeCalls: string[][] = [];
  const { deps, events } = stubDeps({
    runRuntime: (args) => {
      runtimeCalls.push([...args]);
      return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
    },
  });

  assertEquals(await reapStaleContainers(deps, { maxAgeSeconds: 3_600 }), []);
  assertEquals(runtimeCalls.length, 1);
  assertEquals(events, []);
});
