/**
 * Tests for the ephemeral build-cache placement (Issue #2247).
 *
 * On GRQ-23 the runtime refuses FITRIM, so every block a `cargo build` ever
 * touched inside the `vibe-work` volume stays allocated on the host: 22 GB of
 * sparse image for 6.4 GB of live data, and the pool drained every hour.
 * These tests pin the decision that keeps the churn off the volume — where
 * the target directory goes, that each checkout gets its own (cargo takes a
 * file lock on it), and that a runtime which honours the trim is untouched.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildCacheEnvForCheckout,
  cargoTargetDirForCheckout,
  EPHEMERAL_CARGO_TARGET_ROOT,
  ephemeralBuildCacheEnv,
  hostDiskRefreshPath,
  readWorkVolumeTrimRefused,
  resetWorkVolumeTrimRefusedForLaunch,
  workVolumeTrimRefusedForLaunch,
} from "../lib/ephemeral_build_cache.ts";
import { untrustedAccountOf } from "../lib/quality_gate_phase.ts";
import { scanWorkVolumeUsage } from "../lib/work_volume_usage.ts";

const WORK_ROOT = "/home/vibe/auto-issue-work";

Deno.test("cargoTargetDirForCheckout - lands under the ephemeral root, not the work volume", () => {
  const dir = cargoTargetDirForCheckout(`${WORK_ROOT}/GRQ-AutoTrader`);
  assert(
    dir.startsWith(`${EPHEMERAL_CARGO_TARGET_ROOT}/`),
    `expected the ephemeral root, got ${dir}`,
  );
  assert(
    !dir.startsWith(WORK_ROOT),
    "the whole point is that the target dir is off the persistent volume",
  );
  assertStringIncludes(dir, "GRQ-AutoTrader", "the name stays legible");
});

Deno.test("cargoTargetDirForCheckout - one directory per checkout, so cargo's lock never serialises two slots", () => {
  const s1 = cargoTargetDirForCheckout(`${WORK_ROOT}/worktrees/s1/GRQ-tax`);
  const s2 = cargoTargetDirForCheckout(`${WORK_ROOT}/worktrees/s2/GRQ-tax`);
  const shared = cargoTargetDirForCheckout(`${WORK_ROOT}/GRQ-tax`);
  assert(s1 !== s2, "two slots of the same repo must not share a target dir");
  assert(
    shared !== s1 && shared !== s2,
    "the shared clone the maintenance passes build in is a checkout too",
  );
});

Deno.test("cargoTargetDirForCheckout - stable for the same checkout, so a rebuild is incremental within a launch", () => {
  const once = cargoTargetDirForCheckout(`${WORK_ROOT}/GRQ-tax`);
  const again = cargoTargetDirForCheckout(`${WORK_ROOT}/GRQ-tax/`);
  assertEquals(once, again, "a trailing slash is the same checkout");
});

Deno.test("cargoTargetDirForCheckout - a hostile checkout name cannot escape the root", () => {
  const dir = cargoTargetDirForCheckout(`${WORK_ROOT}/../../etc/../evil name`);
  assertEquals(
    dir.slice(EPHEMERAL_CARGO_TARGET_ROOT.length + 1).includes("/"),
    false,
    `the key must be a single path segment, got ${dir}`,
  );
  assert(!dir.includes(".."), `no traversal in ${dir}`);
  assert(!dir.includes(" "), `no spaces in ${dir}`);
});

Deno.test("cargoTargetDirForCheckout - an empty checkout path is refused rather than keyed to the root", () => {
  let threw = false;
  try {
    cargoTargetDirForCheckout("   ");
  } catch (err) {
    threw = true;
    assertStringIncludes(String(err), "checkout path");
  }
  assertEquals(threw, true, "an unnamed checkout must fail loudly");
});

Deno.test("cargoTargetDirForCheckout - the untrusted account gets its own directory", () => {
  const worker = cargoTargetDirForCheckout(`${WORK_ROOT}/GRQ-tax`);
  const untrusted = cargoTargetDirForCheckout(`${WORK_ROOT}/GRQ-tax`, {
    account: "agent",
  });
  assert(
    worker !== untrusted,
    "a directory one account creates is not writable by the other",
  );
  assertStringIncludes(untrusted, "agent");
  assertEquals(
    untrusted.slice(EPHEMERAL_CARGO_TARGET_ROOT.length + 1).includes("/"),
    false,
    "still a single path segment",
  );
});

Deno.test("ephemeralBuildCacheEnv - trim refused points the build at the ephemeral layer", () => {
  const env = ephemeralBuildCacheEnv({
    checkoutPath: `${WORK_ROOT}/worktrees/s1/GRQ-tax`,
    trimRefused: true,
  });
  assertEquals(
    env["CARGO_TARGET_DIR"],
    cargoTargetDirForCheckout(`${WORK_ROOT}/worktrees/s1/GRQ-tax`),
  );
  assertEquals(Object.keys(env).length, 1, "only the target dir is moved");
});

Deno.test("ephemeralBuildCacheEnv - a runtime that honours the trim is unchanged", () => {
  const env = ephemeralBuildCacheEnv({
    checkoutPath: `${WORK_ROOT}/GRQ-tax`,
    trimRefused: false,
  });
  assertEquals(env, {}, "nothing moves where guest reclaim reaches the host");
});

Deno.test("ephemeralBuildCacheEnv - no checkout means no per-checkout target dir", () => {
  assertEquals(ephemeralBuildCacheEnv({ trimRefused: true }), {});
  assertEquals(ephemeralBuildCacheEnv({ checkoutPath: "", trimRefused: true }), {});
});

Deno.test("ephemeralBuildCacheEnv - an operator's own CARGO_TARGET_DIR wins", () => {
  const env = ephemeralBuildCacheEnv({
    checkoutPath: `${WORK_ROOT}/GRQ-tax`,
    trimRefused: true,
    source: { CARGO_TARGET_DIR: "/somewhere/else" },
  });
  assertEquals(env, {}, "an explicit setting is never overridden");
});

Deno.test("ephemeralBuildCacheEnv - a custom root is honoured", () => {
  const env = ephemeralBuildCacheEnv({
    checkoutPath: `${WORK_ROOT}/GRQ-tax`,
    trimRefused: true,
    root: "/scratch/targets",
  });
  assert(env["CARGO_TARGET_DIR"]?.startsWith("/scratch/targets/"));
});

Deno.test("ephemeralBuildCacheEnv - the account reaches the directory key", () => {
  const env = ephemeralBuildCacheEnv({
    checkoutPath: `${WORK_ROOT}/GRQ-tax`,
    trimRefused: true,
    account: "agent",
  });
  assertEquals(
    env["CARGO_TARGET_DIR"],
    cargoTargetDirForCheckout(`${WORK_ROOT}/GRQ-tax`, { account: "agent" }),
  );
});

Deno.test("readWorkVolumeTrimRefused - reads the launcher's flag from host-disk.json", () => {
  const body = JSON.stringify({
    availableBytes: 43_900_000_000,
    totalBytes: 494_000_000_000,
    measuredAt: 1_758_000_000,
    workVolumeTrimRefused: true,
  });
  assertEquals(
    readWorkVolumeTrimRefused({
      path: "/home/vibe/logs/host-disk.json",
      readTextFile: () => body,
    }),
    true,
  );
});

Deno.test("readWorkVolumeTrimRefused - a launcher that trimmed the volume reports false", () => {
  const body = JSON.stringify({
    availableBytes: 43_900_000_000,
    totalBytes: 494_000_000_000,
    measuredAt: 1_758_000_000,
    workVolumeTrimRefused: false,
  });
  assertEquals(
    readWorkVolumeTrimRefused({
      path: "/home/vibe/logs/host-disk.json",
      readTextFile: () => body,
    }),
    false,
  );
});

Deno.test("readWorkVolumeTrimRefused - an older launcher writes no flag, which reads as not refused", () => {
  const body = JSON.stringify({
    availableBytes: 1,
    totalBytes: 2,
    measuredAt: 3,
  });
  assertEquals(
    readWorkVolumeTrimRefused({
      path: "/x/host-disk.json",
      readTextFile: () => body,
    }),
    false,
  );
});

Deno.test("readWorkVolumeTrimRefused - no reading at all is not a refusal", () => {
  assertEquals(
    readWorkVolumeTrimRefused({
      path: "/x/host-disk.json",
      readTextFile: () => {
        throw new Deno.errors.NotFound("no such file");
      },
    }),
    false,
  );
  assertEquals(
    readWorkVolumeTrimRefused({
      path: "/x/host-disk.json",
      readTextFile: () => "not json at all",
    }),
    false,
  );
  assertEquals(
    readWorkVolumeTrimRefused({ path: null, readTextFile: () => "{}" }),
    false,
  );
});

Deno.test("hostDiskRefreshPath - the guest reads the launcher's file under HOME", () => {
  assertEquals(
    hostDiskRefreshPath((name) => name === "HOME" ? "/home/vibe" : undefined),
    "/home/vibe/logs/host-disk.json",
  );
  assertEquals(hostDiskRefreshPath(() => undefined), null);
});

// ---------------------------------------------------------------------------
// The launch verdict, read the way production reads it
// ---------------------------------------------------------------------------

/** Run `body` with HOME pointing at a work root holding the given reading. */
async function withLauncherReading(
  refresh: Record<string, unknown> | null,
  body: (home: string) => Promise<void> | void,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "vibe-trim-" });
  const previousHome = Deno.env.get("HOME");
  try {
    if (refresh !== null) {
      await Deno.mkdir(`${home}/logs`, { recursive: true });
      await Deno.writeTextFile(
        `${home}/logs/host-disk.json`,
        JSON.stringify(refresh),
      );
    }
    Deno.env.set("HOME", home);
    resetWorkVolumeTrimRefusedForLaunch();
    await body(home);
  } finally {
    if (previousHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", previousHome);
    resetWorkVolumeTrimRefusedForLaunch();
    await Deno.remove(home, { recursive: true });
  }
}

const READING = {
  availableBytes: 43_900_000_000,
  totalBytes: 494_000_000_000,
  measuredAt: 1_758_000_000,
};

Deno.test("buildCacheEnvForCheckout - a trim-refused launch moves the build off the volume", async () => {
  await withLauncherReading(
    { ...READING, workVolumeTrimRefused: true },
    () => {
      assertEquals(workVolumeTrimRefusedForLaunch(), true);
      const env = buildCacheEnvForCheckout("/home/vibe/auto-issue-work/GRQ-tax");
      assertEquals(
        env["CARGO_TARGET_DIR"],
        cargoTargetDirForCheckout("/home/vibe/auto-issue-work/GRQ-tax"),
      );
    },
  );
});

Deno.test("buildCacheEnvForCheckout - a launch that trimmed the volume is left alone", async () => {
  await withLauncherReading(
    { ...READING, workVolumeTrimRefused: false },
    () => {
      assertEquals(workVolumeTrimRefusedForLaunch(), false);
      assertEquals(
        buildCacheEnvForCheckout("/home/vibe/auto-issue-work/GRQ-tax"),
        {},
      );
    },
  );
});

Deno.test("buildCacheEnvForCheckout - no launcher reading at all changes nothing", async () => {
  await withLauncherReading(null, () => {
    assertEquals(
      buildCacheEnvForCheckout("/home/vibe/auto-issue-work/GRQ-tax"),
      {},
      "a host with no launcher reading keeps building where it always did",
    );
  });
});

// ---------------------------------------------------------------------------
// The account the repository's own command drops to
// ---------------------------------------------------------------------------

Deno.test("untrustedAccountOf - names the account a dropped command runs as", () => {
  assertEquals(
    untrustedAccountOf(["sudo", "-n", "-u", "agent", "--", "bash", "-c", "x"]),
    "agent",
  );
});

Deno.test("untrustedAccountOf - a command the worker runs itself has no account", () => {
  assertEquals(untrustedAccountOf(["bash", "-c", "./quality.sh"]), undefined);
  assertEquals(untrustedAccountOf([]), undefined);
  assertEquals(untrustedAccountOf(["sudo", "-n", "--", "true"]), undefined);
});

// ---------------------------------------------------------------------------
// What the work-volume telemetry sees afterwards
// ---------------------------------------------------------------------------

Deno.test("scanWorkVolumeUsage - a build sent to the ephemeral layer leaves 0 build artefacts on the volume", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "vibe-work-" });
  const ephemeral = await Deno.makeTempDir({ prefix: "vibe-ephemeral-" });
  try {
    const checkout = `${workDir}/GRQ-tax`;
    await Deno.mkdir(`${checkout}/src`, { recursive: true });
    await Deno.writeTextFile(`${checkout}/src/main.rs`, "fn main() {}\n");

    // Where a cargo build goes on a trim-refused runtime: off the volume.
    const targetDir = cargoTargetDirForCheckout(checkout, { root: ephemeral });
    await Deno.mkdir(`${targetDir}/debug`, { recursive: true });
    await Deno.writeTextFile(
      `${targetDir}/debug/artefact.bin`,
      "x".repeat(200_000),
    );

    const usage = await scanWorkVolumeUsage({
      workDir,
      monitoredRepos: ["stSoftwareAU/GRQ-tax"],
    });
    assertEquals(usage.artefacts.count, 0, "no target dir on the volume");
    assertEquals(usage.artefacts.bytes, 0);
    assertEquals(usage.errors, []);
  } finally {
    await Deno.remove(workDir, { recursive: true });
    await Deno.remove(ephemeral, { recursive: true });
  }
});
