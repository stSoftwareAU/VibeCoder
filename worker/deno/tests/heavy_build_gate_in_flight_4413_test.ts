/**
 * The in-flight host-disk park respects the cargo project (Issue #4413).
 *
 * A checkout with no cargo project is held to the host floor only: only cargo
 * writes to the ephemeral cargo root, so the headroom budget is not consulted
 * for it and its idle sibling target directories are not pruned. A checkout
 * holding a cargo project keeps the full budget, and the floor applies to
 * every checkout.
 *
 * The unit tests inject an empty or fake ephemeral root, so no real target
 * directory is read or pruned, and every checkout is a temp directory removed
 * afterwards. The call-site tests cover a Deno-only checkout under a merge-only
 * reading, which never reads the real root, and a cargo checkout below the
 * floor, which stops at the defer admission before any root is read. No
 * call-site test uses a merge-only cargo checkout, because that path would read
 * the real `/var/tmp/vibe-cargo-target`.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import {
  enableInFlightHostDiskGate,
  type EphemeralRootDeps,
  type EphemeralTargetDir,
  heavyBuildAdmission,
  type HeavyBuildDiskReading,
  parkInFlightBuild,
  registerHeavyBuildDiskProbe,
} from "../lib/heavy_build_gate.ts";
import type { Logger } from "../types.ts";
import { createAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const GB = 1_073_741_824;
const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-10-27T12:00:00Z");

/** A trim-refused reading with `freeGb` free against a 46 GB floor. */
function reading(freeGb: number): HeavyBuildDiskReading {
  const level = freeGb < 46 ? "low" : "ok";
  return {
    status: {
      level,
      availableBytes: freeGb * GB,
      totalBytes: 460 * GB,
      source: "launch-baseline",
      detail: `${freeGb} GB free, floor 46.0 GB`,
    },
    floorBytes: 46 * GB,
    trimRefused: true,
  };
}

/** An ephemeral cargo root with no target directories, so nothing is pruned. */
const emptyRoot: EphemeralRootDeps = {
  listTargetDirs: () => Promise.resolve([]),
  removeDir: () => Promise.resolve(),
  nowMs: () => Date.now(),
};

/**
 * A fake ephemeral root holding `dirs`. Every removal is recorded, so a test
 * can assert that nothing was pruned as well as what the list still holds.
 */
function fakeRoot(dirs: EphemeralTargetDir[]) {
  const live = new Map(dirs.map((d) => [d.path, d]));
  const removed: string[] = [];
  const deps: EphemeralRootDeps = {
    listTargetDirs: () => Promise.resolve([...live.values()]),
    removeDir: (path: string) => {
      live.delete(path);
      removed.push(path);
      return Promise.resolve();
    },
    nowMs: () => NOW,
  };
  return { deps, removed, listed: () => [...live.keys()] };
}

/**
 * An idle sibling checkout's target directory. At 55.3 GB free the shortfall
 * is 15.7 GB, and 20 GB covers it, so a budget that prunes would build.
 */
const IDLE_SIBLING: EphemeralTargetDir = {
  path: "/fake/cargo-root/sibling-idle-target",
  bytes: 20 * GB,
  lastWriteMs: NOW - HOUR_MS,
};

/** Run `fn` with the in-flight gate armed and host reading `r` registered. */
async function armed<T>(
  r: HeavyBuildDiskReading,
  fn: () => Promise<T>,
): Promise<T> {
  enableInFlightHostDiskGate(true);
  registerHeavyBuildDiskProbe(() => Promise.resolve(r));
  try {
    return await fn();
  } finally {
    enableInFlightHostDiskGate(false);
    registerHeavyBuildDiskProbe(undefined);
  }
}

/** Run `fn` in a fresh temp checkout holding `files`, removed afterwards. */
async function withCheckout<T>(
  files: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "in-flight-4413-" });
  try {
    for (const [rel, text] of Object.entries(files)) {
      const path = `${dir}/${rel}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(path, text);
    }
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const CARGO_TOML = '[package]\nname = "fixture"\n';

Deno.test("in-flight park - a merge-only Deno-only checkout is not parked (Issue #4413)", async () => {
  await withCheckout(
    { "deno.json": "{}" },
    (dir) =>
      armed(reading(55.3), async () => {
        assertEquals(
          (await heavyBuildAdmission(dir, emptyRoot)).mode,
          "merge-only",
        );
        assertEquals(await parkInFlightBuild(dir, emptyRoot), null);
      }),
  );
});

Deno.test("in-flight park - a merge-only checkout with a cargo project is parked (Issue #4413)", async () => {
  await withCheckout(
    { "Cargo.toml": CARGO_TOML },
    (dir) =>
      armed(reading(55.3), async () => {
        const parked = await parkInFlightBuild(dir, emptyRoot);
        if (parked === null) {
          throw new Error("expected the cargo checkout parked");
        }
        assertStringIncludes(parked, "Parked as infrastructure (Issue #4360).");
        assertStringIncludes(
          parked,
          "ephemeral cargo root over budget (55.3 GB free, floor 46.0 GB + headroom 25.0 GB)",
        );
      }),
  );
});

Deno.test("in-flight park - a Deno-only checkout below the floor is still parked (Issue #4413)", async () => {
  await withCheckout(
    { "deno.json": "{}" },
    (dir) =>
      armed(reading(6), async () => {
        const parked = await parkInFlightBuild(dir, emptyRoot);
        if (parked === null) {
          throw new Error("expected the below-floor checkout parked");
        }
        assertStringIncludes(parked, "Parked as infrastructure (Issue #4360).");
        assertStringIncludes(parked, "46.0 GB");
      }),
  );
});

Deno.test("in-flight park - a Cargo.toml one level down counts as a cargo project (Issue #4413)", async () => {
  await withCheckout(
    { "rust/Cargo.toml": CARGO_TOML },
    (dir) =>
      armed(reading(55.3), async () => {
        const parked = await parkInFlightBuild(dir, emptyRoot);
        if (parked === null) {
          throw new Error("expected the nested cargo checkout parked");
        }
        assertStringIncludes(parked, "Parked as infrastructure (Issue #4360).");
      }),
  );
});

Deno.test("in-flight park - an empty or missing checkout with merge-only is not parked (Issue #4413)", async () => {
  await withCheckout({}, (dir) =>
    armed(reading(55.3), async () => {
      assertEquals(await parkInFlightBuild(dir, emptyRoot), null);
      assertEquals(
        await parkInFlightBuild(`${dir}/missing-checkout`, emptyRoot),
        null,
      );
    }));
});

Deno.test("in-flight park - a Deno-only checkout prunes no idle sibling target dir (Issue #4413)", async () => {
  await withCheckout(
    { "deno.json": "{}" },
    (dir) =>
      armed(reading(55.3), async () => {
        // Precondition: a budget that prunes would cover the shortfall and build.
        const budget = fakeRoot([IDLE_SIBLING]);
        assertEquals(
          (await heavyBuildAdmission(dir, budget.deps)).mode,
          "build",
        );
        assertEquals(budget.removed, [IDLE_SIBLING.path]);

        const root = fakeRoot([IDLE_SIBLING]);
        assertEquals(await parkInFlightBuild(dir, root.deps), null);
        assertEquals(root.removed, []);
        assertEquals(root.listed(), [IDLE_SIBLING.path]);
      }),
  );
});

Deno.test("in-flight park - a cargo checkout prunes the idle sibling it needs (Issue #4413)", async () => {
  await withCheckout(
    { "Cargo.toml": CARGO_TOML },
    (dir) =>
      armed(reading(55.3), async () => {
        const root = fakeRoot([IDLE_SIBLING]);
        assertEquals(await parkInFlightBuild(dir, root.deps), null);
        assertEquals(root.removed, [IDLE_SIBLING.path]);
        assertEquals(root.listed(), []);
      }),
  );
});

/** The outcome of one agent run through the real call site. */
type AgentRun = Awaited<ReturnType<typeof runClaudeWithTimeout>>;

/**
 * Run an agent stub in `dir` under host reading `r`, through
 * `runClaudeWithTimeout` (Issue #4413). The stub prints one result line and
 * exits, so a run that is started completes; a run that is parked returns
 * `ok: false` before any process starts.
 */
async function runAgentIn(
  dir: string,
  r: HeavyBuildDiskReading,
): Promise<AgentRun> {
  const clock = fakeClock();
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  } as Logger;
  const stub = await createAgentStub(
    'printf \'%s\\n\' \'{"type":"result","result":"ok"}\'\nexit 0\n',
  );
  try {
    return await armed(r, () =>
      runClaudeWithTimeout({
        prompt: "test",
        cwd: dir,
        agentBinaryPath: stub.path,
        clock,
        logger,
        timeoutSeconds: 3600,
        killAfterSeconds: 1,
        hostDiskPollMs: 30_000,
        progressIntervalMs: 86_400_000,
        descendantSnapshotIntervalMs: 86_400_000,
      }));
  } finally {
    await stub.dispose();
  }
}

Deno.test({
  name:
    "agent start - a Deno-only checkout starts under a merge-only host reading (Issue #4413)",
  ignore: Deno.build.os === "windows",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const run = await withCheckout(
      { "deno.json": "{}" },
      (dir) => runAgentIn(dir, reading(67.6)),
    );
    assert(run.ok, "a Deno-only checkout must not be parked at 67.6 GB free");
    assertEquals(run.value.exitCode, 0);
    assertEquals(run.value.timedOut, false);
  },
});

Deno.test({
  name:
    "agent start - a Cargo checkout starts above the floor without reserving build headroom",
  ignore: Deno.build.os === "windows",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const run = await withCheckout(
      { "Cargo.toml": CARGO_TOML },
      (dir) => runAgentIn(dir, reading(50.7)),
    );
    assert(
      run.ok,
      "manager startup must not require cargo build headroom at 50.7 GB free",
    );
    assertEquals(run.value.exitCode, 0);
    assertEquals(run.value.timedOut, false);
  },
});

Deno.test({
  name:
    "agent start - a cargo checkout below the floor is parked at the call site (Issue #4360)",
  ignore: Deno.build.os === "windows",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const run = await withCheckout(
      { "Cargo.toml": CARGO_TOML },
      (dir) => runAgentIn(dir, reading(30)),
    );
    assert(!run.ok, "a cargo checkout below the floor must not start");
    assertStringIncludes(
      run.error.message,
      "Parked as infrastructure (Issue #4360).",
    );
  },
});
