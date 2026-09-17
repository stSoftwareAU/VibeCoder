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
  ensureEphemeralCargoRoot,
  EPHEMERAL_CARGO_TARGET_ROOT,
  ephemeralBuildCacheEnv,
  hostDiskRefreshPath,
  readWorkVolumeTrimRefused,
} from "../lib/ephemeral_build_cache.ts";
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
  assertEquals(
    ephemeralBuildCacheEnv({ checkoutPath: "", trimRefused: true }),
    {},
  );
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
// The verdict as a parameter — no process-wide state, no host inheritance
// ---------------------------------------------------------------------------

Deno.test("buildCacheEnvForCheckout - a trim-refused launch moves the build off the volume", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-ephemeral-" });
  try {
    const env = buildCacheEnvForCheckout(`${WORK_ROOT}/GRQ-tax`, {
      trimRefused: true,
      root,
      // Stated, never inherited: on the trim-refused hosts this feature is
      // for, the worker sets CARGO_TARGET_DIR on the agent that runs these
      // tests, and an inherited one would read as an operator's own setting
      // and turn the placement off (Issue #2291).
      source: {},
    });
    assertEquals(
      env["CARGO_TARGET_DIR"],
      cargoTargetDirForCheckout(`${WORK_ROOT}/GRQ-tax`, { root }),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("buildCacheEnvForCheckout - a launch that trimmed the volume is left alone", () => {
  assertEquals(
    buildCacheEnvForCheckout(`${WORK_ROOT}/GRQ-tax`, { trimRefused: false }),
    {},
  );
});

Deno.test("buildCacheEnvForCheckout - the account the command drops to reaches the key", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-ephemeral-" });
  try {
    assertEquals(
      buildCacheEnvForCheckout(`${WORK_ROOT}/GRQ-tax`, {
        trimRefused: true,
        account: "agent",
        root,
        source: {}, // Stated, not inherited — see above (Issue #2291).
      })["CARGO_TARGET_DIR"],
      cargoTargetDirForCheckout(`${WORK_ROOT}/GRQ-tax`, {
        account: "agent",
        root,
      }),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("buildCacheEnvForCheckout - a stated environment decides, not the host's own", async () => {
  // The gate ran red on exactly the hosts the feature is for: the worker sets
  // CARGO_TARGET_DIR on the agent, the agent runs `deno test`, and a test that
  // inherited that value asserted the opposite of what it meant to (#2291).
  const root = await Deno.makeTempDir({ prefix: "vibe-ephemeral-" });
  const inherited = Deno.env.get("CARGO_TARGET_DIR");
  Deno.env.set("CARGO_TARGET_DIR", "/var/tmp/vibe-cargo-target/inherited");
  try {
    assertEquals(
      buildCacheEnvForCheckout(`${WORK_ROOT}/GRQ-tax`, {
        trimRefused: true,
        root,
        source: {},
      })["CARGO_TARGET_DIR"],
      cargoTargetDirForCheckout(`${WORK_ROOT}/GRQ-tax`, { root }),
      "the stated environment names no setting, so the placement stands",
    );
  } finally {
    if (inherited === undefined) {
      Deno.env.delete("CARGO_TARGET_DIR");
    } else {
      Deno.env.set("CARGO_TARGET_DIR", inherited);
    }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ensureEphemeralCargoRoot - the shared root is writable by both accounts", async () => {
  const parent = await Deno.makeTempDir({ prefix: "vibe-ephemeral-" });
  try {
    const root = `${parent}/nested/vibe-cargo-target`;
    ensureEphemeralCargoRoot(root);
    const mode = (await Deno.stat(root)).mode ?? 0;
    assertEquals(
      mode % 0o10000,
      0o1777,
      "sticky and group/other writable, so neither account locks the other out",
    );
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("ensureEphemeralCargoRoot - a root it cannot create is reported, not swallowed", () => {
  const warnings: string[] = [];
  // A path under a regular file can never be a directory.
  const file = Deno.makeTempFileSync({ prefix: "vibe-ephemeral-" });
  try {
    ensureEphemeralCargoRoot(`${file}/impossible`, (m) => warnings.push(m));
    assertEquals(warnings.length, 1, "the failure is named");
    assertStringIncludes(warnings[0] ?? "", "impossible");
  } finally {
    Deno.removeSync(file);
  }
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

Deno.test("buildCacheEnvForCheckout - an unusable root falls back to today's behaviour", () => {
  // A path under a regular file can never be a directory, so the root cannot
  // be provisioned: the build stays on the volume rather than failing.
  const file = Deno.makeTempFileSync({ prefix: "vibe-ephemeral-" });
  try {
    assertEquals(
      buildCacheEnvForCheckout(`${WORK_ROOT}/GRQ-tax`, {
        trimRefused: true,
        root: `${file}/impossible`,
      }),
      {},
    );
  } finally {
    Deno.removeSync(file);
  }
});
