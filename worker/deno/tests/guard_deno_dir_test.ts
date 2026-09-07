/**
 * Tests for guard_deno_dir.ts — which Deno cache the guard child may read
 * code back from (Issue #1448).
 *
 * The resolver is pure over its two seams (environment and directory probe),
 * so every branch is exercised without touching the filesystem; the real
 * probe gets one test of its own against real directories.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_DENO_SEED_DIR,
  DENO_SEED_DIR_ENV,
  expectsReadOnlyGuardCache,
  type GuardDenoDirState,
  realGuardDenoDirProbe,
  resolveGuardDenoDir,
} from "../lib/guard_deno_dir.ts";
import { BASE_DIR_ENV } from "../lib/guard_module_path.ts";

const FALLBACK = "/run/shim-dir/deno-cache";

function probeOf(states: Record<string, GuardDenoDirState>) {
  return (path: string): GuardDenoDirState => states[path] ?? "absent";
}

function envOf(values: Record<string, string>) {
  return (name: string): string | undefined => values[name];
}

Deno.test("guard-deno-dir - a read-only seed named by the environment wins", () => {
  const chosen = resolveGuardDenoDir(
    FALLBACK,
    envOf({ [DENO_SEED_DIR_ENV]: "/opt/custom-seed" }),
    probeOf({
      "/opt/custom-seed": "read-only",
      [DEFAULT_DENO_SEED_DIR]: "read-only",
    }),
  );
  assertEquals(chosen, {
    path: "/opt/custom-seed",
    readOnly: true,
    source: "seed-env",
  });
});

Deno.test("guard-deno-dir - the image default is used when the variable is unset", () => {
  const chosen = resolveGuardDenoDir(
    FALLBACK,
    envOf({}),
    probeOf({ [DEFAULT_DENO_SEED_DIR]: "read-only" }),
  );
  assertEquals(chosen, {
    path: DEFAULT_DENO_SEED_DIR,
    readOnly: true,
    source: "seed-default",
  });
});

Deno.test("guard-deno-dir - a WRITABLE seed is never chosen: it would be the hole, not the boundary", () => {
  const chosen = resolveGuardDenoDir(
    FALLBACK,
    envOf({ [DENO_SEED_DIR_ENV]: "/home/vibe/seed" }),
    probeOf({
      "/home/vibe/seed": "writable",
      [DEFAULT_DENO_SEED_DIR]: "writable",
    }),
  );
  assertEquals(chosen, { path: FALLBACK, readOnly: false, source: "per-run" });
});

Deno.test("guard-deno-dir - an absent seed falls back to the per-run directory, and says it is writable", () => {
  const chosen = resolveGuardDenoDir(FALLBACK, envOf({}), probeOf({}));
  assertEquals(chosen, { path: FALLBACK, readOnly: false, source: "per-run" });
});

Deno.test("guard-deno-dir - a writable env candidate does not stop the default from being tried", () => {
  const chosen = resolveGuardDenoDir(
    FALLBACK,
    envOf({ [DENO_SEED_DIR_ENV]: "/home/vibe/seed" }),
    probeOf({
      "/home/vibe/seed": "writable",
      [DEFAULT_DENO_SEED_DIR]: "read-only",
    }),
  );
  assertEquals(chosen.path, DEFAULT_DENO_SEED_DIR);
  assertEquals(chosen.readOnly, true);
});

Deno.test("guard-deno-dir - a read-only cache is expected only where the launcher marks a container", () => {
  assertEquals(expectsReadOnlyGuardCache(envOf({})), false);
  assertEquals(
    expectsReadOnlyGuardCache(envOf({ [BASE_DIR_ENV]: "  " })),
    false,
  );
  assertEquals(
    expectsReadOnlyGuardCache(envOf({ [BASE_DIR_ENV]: "/workspace" })),
    true,
  );
});

Deno.test({
  name:
    "guard-deno-dir - the real probe tells a writable directory from a read-only one and a missing one",
  permissions: { read: true, write: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "guard-deno-dir-" });
    try {
      assertEquals(realGuardDenoDirProbe(`${dir}/missing`), "absent");
      const file = `${dir}/a-file`;
      await Deno.writeTextFile(file, "");
      assertEquals(
        realGuardDenoDirProbe(file),
        "absent",
        "a file is not a cache dir",
      );
      await Deno.mkdir(`${dir}/rw`);
      assertEquals(realGuardDenoDirProbe(`${dir}/rw`), "writable");
      // root can write anything, so the read-only half is meaningful only
      // for an unprivileged uid — which is what the container runs as. The
      // probe's own answer on a 0555 directory says which we are.
      await Deno.mkdir(`${dir}/ro`);
      await Deno.chmod(`${dir}/ro`, 0o555);
      const ro = realGuardDenoDirProbe(`${dir}/ro`);
      assert(
        ro === "read-only" || ro === "writable",
        `a directory is never "absent": ${ro}`,
      );
      await Deno.chmod(`${dir}/ro`, 0o755);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
