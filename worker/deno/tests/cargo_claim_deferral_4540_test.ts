/**
 * A cargo repository the host cannot build is not claimed (Issue #4540).
 *
 * Between the host floor and floor + the 25 GB cargo headroom, the claim gate
 * let issues in while the in-flight park refused the agent the moment it
 * started: on 2026-10-30, 42 of ~58 claims on one host were released as
 * `infrastructure-error` this way, and the same issues were claimed again on
 * the next cycle. The scan now leaves such a repository out, so the slot goes
 * to a repository without a cargo project instead. The judgement is a dry run
 * of the same budget the in-flight park applies: nothing is pruned at scan
 * time.
 *
 * Every root here is a fake, and every checkout is a temp directory removed
 * afterwards.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  cargoClaimDeferral,
  cargoClaimDeferredRepos,
  enableInFlightHostDiskGate,
  type EphemeralRootDeps,
  type EphemeralTargetDir,
  type HeavyBuildDiskReading,
  registerHeavyBuildDiskProbe,
} from "../lib/heavy_build_gate.ts";
import { cargoTargetDirForCheckout } from "../lib/ephemeral_build_cache.ts";

const GB = 1_073_741_824;
const NOW = Date.parse("2026-10-31T03:00:00Z");
const HOUR = 3_600_000;

/** A trim-refused reading with `freeGb` free against a 46 GB floor. */
function reading(freeGb: number): HeavyBuildDiskReading {
  return {
    status: {
      level: freeGb < 46 ? "low" : "ok",
      availableBytes: freeGb * GB,
      totalBytes: 460 * GB,
      source: "launch-baseline",
      detail: `${freeGb} GB free, floor 46.0 GB`,
    },
    floorBytes: 46 * GB,
    trimRefused: true,
  };
}

/** A fake ephemeral root holding `dirs`, recording every removal. */
function fakeRoot(dirs: EphemeralTargetDir[] = []) {
  const removed: string[] = [];
  const deps: EphemeralRootDeps = {
    listTargetDirs: () => Promise.resolve(dirs),
    removeDir: (path: string) => {
      removed.push(path);
      return Promise.resolve();
    },
    nowMs: () => NOW,
  };
  return { deps, removed };
}

async function armed<T>(
  r: HeavyBuildDiskReading,
  fn: () => Promise<T>,
  enabled = true,
): Promise<T> {
  enableInFlightHostDiskGate(enabled);
  registerHeavyBuildDiskProbe(() => Promise.resolve(r));
  try {
    return await fn();
  } finally {
    enableInFlightHostDiskGate(false);
    registerHeavyBuildDiskProbe(undefined);
  }
}

/** A work dir holding a cargo clone `rust` and a Deno clone `deno`. */
async function withWorkDir<T>(fn: (workDir: string) => Promise<T>) {
  const workDir = await Deno.makeTempDir({ prefix: "cargo-claim-4540-" });
  try {
    await Deno.mkdir(`${workDir}/rust`);
    await Deno.writeTextFile(
      `${workDir}/rust/Cargo.toml`,
      '[package]\nname = "fixture"\n',
    );
    await Deno.mkdir(`${workDir}/deno`);
    await Deno.writeTextFile(`${workDir}/deno/deno.json`, "{}\n");
    return await fn(workDir);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

const cloneOf = (workDir: string) => (repo: string) =>
  `${workDir}/${repo.split("/")[1]}`;

Deno.test("claim deferral - a cargo repo short of the headroom is left out while a Deno repo is claimable in the same cycle (Issue #4540)", async () => {
  await withWorkDir((workDir) =>
    armed(reading(58.6), async () => {
      const root = fakeRoot();
      const deferred = await cargoClaimDeferredRepos(
        ["o/rust", "o/deno"],
        cloneOf(workDir),
        root.deps,
      );
      assertEquals([...deferred.keys()], ["o/rust"]);
      assertStringIncludes(
        deferred.get("o/rust") ?? "",
        "ephemeral cargo root over budget",
      );
      assertEquals(root.removed, [], "a scan never prunes");
    })
  );
});

Deno.test("claim deferral - a repo with no clone yet is not deferred (Issue #4540)", async () => {
  await withWorkDir((workDir) =>
    armed(reading(58.6), async () => {
      const deferred = await cargoClaimDeferredRepos(
        ["o/not-cloned"],
        cloneOf(workDir),
        fakeRoot().deps,
      );
      assertEquals(deferred.size, 0);
    })
  );
});

Deno.test("claim deferral - within the headroom the cargo repo is claimable (Issue #4540)", async () => {
  await withWorkDir((workDir) =>
    armed(reading(80), async () => {
      assertEquals(
        await cargoClaimDeferral(`${workDir}/rust`, fakeRoot().deps),
        null,
      );
    })
  );
});

Deno.test("claim deferral - idle sibling target dirs that would cover the shortfall leave the repo claimable, and are not pruned (Issue #4540)", async () => {
  await withWorkDir((workDir) =>
    armed(reading(58.6), async () => {
      // 46 + 25 − 58.6 = 12.4 GB short; an idle 20 GB sibling covers it once
      // the agent's own admission prunes it.
      const root = fakeRoot([{
        path: cargoTargetDirForCheckout("/elsewhere/other"),
        bytes: 20 * GB,
        lastWriteMs: NOW - 2 * HOUR,
      }]);
      assertEquals(
        await cargoClaimDeferral(`${workDir}/rust`, root.deps),
        null,
      );
      assertEquals(root.removed, []);
    })
  );
});

Deno.test("claim deferral - the checkout's own cache counts towards the headroom, as the in-flight park does (Issue #4540)", async () => {
  await withWorkDir((workDir) =>
    armed(reading(58.6), async () => {
      const own = cargoTargetDirForCheckout(`${workDir}/rust`);
      const root = fakeRoot([{ path: own, bytes: 13 * GB, lastWriteMs: NOW }]);
      assertEquals(
        await cargoClaimDeferral(`${workDir}/rust`, root.deps),
        null,
      );
    })
  );
});

Deno.test("claim deferral - with the in-flight gate disarmed nothing is deferred (Issue #4540)", async () => {
  await withWorkDir((workDir) =>
    armed(reading(58.6), async () => {
      assertEquals(
        await cargoClaimDeferral(`${workDir}/rust`, fakeRoot().deps),
        null,
      );
    }, false)
  );
});

Deno.test("claim deferral - below the floor it defers nothing: the host-disk claim gate already stops every claim (Issue #4540)", async () => {
  await withWorkDir((workDir) =>
    armed(reading(40), async () => {
      assertEquals(
        await cargoClaimDeferral(`${workDir}/rust`, fakeRoot().deps),
        null,
      );
    })
  );
});
