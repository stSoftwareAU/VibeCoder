/**
 * Tests for the guard entry-point resolution (Issue #1444).
 *
 * The `gh`/`git` wrappers re-read their guard module on every call, so the
 * module they execute must live in the read-only checkout rather than the
 * staged, agent-writable copy the worker runs from. The install-level tests
 * below prove it end to end: a stub guard module planted in a fake checkout is
 * what the wrapper actually executes, which is only true once the resolution
 * honours `VIBE_BASE_DIR`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  GUARD_MODULE_DIR,
  resolveGuardModulePath,
} from "../lib/guard_module_path.ts";
import {
  type GhGuardShim,
  type GhGuardShimOutcome,
  installGhGuardShim,
} from "../lib/gh_guard_shim.ts";
import {
  CHECKOUT_ROOT,
  checkoutEnv,
  emptyEnv,
  envFrom,
} from "./support/env_lookup.ts";

/** Unwrap an installed shim, failing the test when the install was refused. */
function expectInstalled(outcome: GhGuardShimOutcome): GhGuardShim {
  assertEquals(
    outcome.status,
    "installed",
    `expected the shim to install, got ${outcome.status}`,
  );
  assert(outcome.status === "installed");
  return outcome.shim;
}

/** The marker a planted checkout guard prints so its execution is provable. */
const STUB_MARKER = "[SECURITY] [STUB_CHECKOUT_GUARD]";

/**
 * Build a fake read-only checkout carrying stub `gh`/`git` guard entry points.
 *
 * Each stub refuses every call with {@link STUB_MARKER} and a distinctive exit
 * code, so a wrapper that runs the real (running-copy) guard instead is
 * immediately distinguishable — it would allow the command through.
 */
async function makeStubCheckout(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "vibe_checkout_" });
  const libDir = `${root}/${GUARD_MODULE_DIR}`;
  await Deno.mkdir(libDir, { recursive: true });
  for (const name of ["gh_guard_cli.ts", "git_guard_cli.ts"]) {
    await Deno.writeTextFile(
      `${libDir}/${name}`,
      `console.error("${STUB_MARKER} ${name}");\nDeno.exit(3);\n`,
    );
  }
  return root;
}

/** A stub `gh`/`git` on PATH plus the log file it appends its arguments to. */
async function makeStubBinaries(): Promise<{ dir: string; log: string }> {
  const dir = await Deno.makeTempDir({ prefix: "vibe_stub_bin_" });
  const log = `${dir}/calls.log`;
  for (const name of ["gh", "git"]) {
    await Deno.writeTextFile(
      `${dir}/${name}`,
      `#!/bin/bash\nprintf '${name}:%s\\n' "$@" >> "${log}"\n`,
    );
    await Deno.chmod(`${dir}/${name}`, 0o755);
  }
  return { dir, log };
}

/** Run a wrapper with `args` and capture its outcome. */
async function runShim(
  shimPath: string,
  env: Record<string, string>,
  args: string[],
): Promise<{ code: number; stderr: string }> {
  const { code, stderr } = await new Deno.Command(shimPath, {
    args,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

/** Read the stub binaries' call log (empty string when neither ran). */
async function readLog(log: string): Promise<string> {
  try {
    return await Deno.readTextFile(log);
  } catch {
    return "";
  }
}

Deno.test("guard-module-path - prefers the checkout copy over the running one", () => {
  const resolved = resolveGuardModulePath("gh_guard_cli.ts", {
    env: envFrom({ VIBE_BASE_DIR: "/mnt/checkout" }),
    exists: () => true,
  });
  assertEquals(
    resolved.path,
    `/mnt/checkout/${GUARD_MODULE_DIR}/gh_guard_cli.ts`,
  );
  assertEquals(resolved.degraded, undefined);
});

Deno.test("guard-module-path - trailing separators on the base dir are ignored", () => {
  const resolved = resolveGuardModulePath("git_guard_cli.ts", {
    env: envFrom({ VIBE_BASE_DIR: "/mnt/checkout//" }),
    exists: () => true,
  });
  assertEquals(
    resolved.path,
    `/mnt/checkout/${GUARD_MODULE_DIR}/git_guard_cli.ts`,
  );
});

Deno.test("guard-module-path - without VIBE_BASE_DIR the running copy is the checkout copy", () => {
  const resolved = resolveGuardModulePath("gh_guard_cli.ts", {
    env: emptyEnv,
    exists: () => {
      throw new Error("no checkout named — nothing to probe");
    },
  });
  assertStringIncludes(resolved.path, "/lib/gh_guard_cli.ts");
  assertEquals(resolved.degraded, undefined, "nothing was staged to degrade");
});

Deno.test("guard-module-path - the named checkout that carries no guard is degraded", () => {
  const resolved = resolveGuardModulePath("gh_guard_cli.ts", {
    env: envFrom({ VIBE_BASE_DIR: "/mnt/checkout" }),
    exists: () => false,
  });
  assertStringIncludes(resolved.path, "/lib/gh_guard_cli.ts");
  assertStringIncludes(resolved.degraded ?? "", "GUARD_MODULE_NOT_IN_CHECKOUT");
  assertStringIncludes(resolved.degraded ?? "", "/mnt/checkout");
});

Deno.test("guard-module-path - an unreadable VIBE_BASE_DIR is degraded, not swallowed", () => {
  const resolved = resolveGuardModulePath("gh_guard_cli.ts", {
    env: () => {
      throw new Deno.errors.NotCapable("requires env access");
    },
  });
  assertStringIncludes(resolved.path, "/lib/gh_guard_cli.ts");
  assertStringIncludes(resolved.degraded ?? "", "GUARD_MODULE_NOT_IN_CHECKOUT");
  assertStringIncludes(
    resolved.degraded ?? "",
    "VIBE_BASE_DIR could not be read",
  );
});

Deno.test("guard-module-path - the running copy inside the named checkout needs no probe", () => {
  // A host run: nothing was staged, so the two paths are the same file.
  const resolved = resolveGuardModulePath("gh_guard_cli.ts", {
    env: checkoutEnv,
    exists: () => {
      throw new Error("the identical path must not be probed");
    },
  });
  assertEquals(
    resolved.path,
    `${CHECKOUT_ROOT}/${GUARD_MODULE_DIR}/gh_guard_cli.ts`,
  );
  assertEquals(resolved.degraded, undefined);
});

Deno.test("guard-module-path - resolves both real guards against the real checkout", () => {
  // GUARD_MODULE_DIR is a hardcoded relative path, exercised here through the
  // resolution's own on-disk probe rather than a seam: a layout move that
  // broke it would otherwise degrade every run to the staged copy unnoticed.
  for (const name of ["gh_guard_cli.ts", "git_guard_cli.ts"]) {
    const resolved = resolveGuardModulePath(name, { env: checkoutEnv });
    assertEquals(resolved.degraded, undefined, `${name}: ${resolved.degraded}`);
    assertEquals(
      resolved.path,
      `${CHECKOUT_ROOT}/${GUARD_MODULE_DIR}/${name}`,
    );
  }
});

Deno.test("guard-module-path - a relative VIBE_BASE_DIR is degraded, never resolved", () => {
  // The resolved path is baked into the wrapper, which runs from the AGENT's
  // working directory — so a relative base dir would name somewhere the agent
  // chooses and can write to, which is the whole property being defended.
  const resolved = resolveGuardModulePath("gh_guard_cli.ts", {
    env: envFrom({ VIBE_BASE_DIR: "relative/checkout" }),
    exists: () => {
      throw new Error("a relative base dir must be refused before any probe");
    },
  });
  assertStringIncludes(resolved.degraded ?? "", "GUARD_MODULE_NOT_IN_CHECKOUT");
  assertStringIncludes(resolved.degraded ?? "", "not an absolute path");
});

Deno.test("guard-module-path - the real probe reports a non-absence fault rather than calling it absent", async () => {
  // Exercises the production probe, not the seam: a base dir that is a regular
  // file makes stat fail with ENOTDIR, which is a misconfiguration and not a
  // missing module. It must still fail closed, and it must say which.
  const file = await Deno.makeTempFile({ prefix: "vibe_not_a_checkout_" });
  try {
    const resolved = resolveGuardModulePath("gh_guard_cli.ts", {
      env: envFrom({ VIBE_BASE_DIR: file }),
    });
    assertStringIncludes(
      resolved.degraded ?? "",
      "GUARD_MODULE_NOT_IN_CHECKOUT",
    );
    assertStringIncludes(resolved.degraded ?? "", "could not be probed");
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("guard-module-path - a probe that fails for a reason other than absence keeps the cause", () => {
  // A denied read is not the same fault as a missing file, and reporting it as
  // "absent" would send an operator hunting for the wrong thing.
  const resolved = resolveGuardModulePath("gh_guard_cli.ts", {
    env: envFrom({ VIBE_BASE_DIR: "/mounted/checkout" }),
    exists: () => {
      throw new Deno.errors.PermissionDenied("requires read access");
    },
  });
  assertStringIncludes(resolved.degraded ?? "", "GUARD_MODULE_NOT_IN_CHECKOUT");
  assertStringIncludes(resolved.degraded ?? "", "requires read access");
});

Deno.test("guard-module-path - refuses a traversing module name", () => {
  assertThrows(
    () => resolveGuardModulePath("../../../etc/passwd", { env: emptyEnv }),
    Error,
    "bare *.ts file name",
  );
});

Deno.test({
  name:
    "gh-guard-shim - executes the checkout guard, not the writable staged copy",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const checkout = await makeStubCheckout();
    const stub = await makeStubBinaries();
    const shim = expectInstalled(
      await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
        env: envFrom({ VIBE_BASE_DIR: checkout }),
      }),
    );
    try {
      const result = await runShim(shim.shimPath, shim.env, [
        "issue",
        "comment",
        "1",
        "-R",
        "stSoftwareAU/VibeCoder",
        "--body",
        "hello",
      ]);
      assertStringIncludes(result.stderr, STUB_MARKER);
      assert(result.code !== 0, "the planted guard refuses every call");
      assertEquals(await readLog(stub.log), "", "gh must not have been run");
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
      await Deno.remove(checkout, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "git-guard-shim - executes the checkout guard, not the writable staged copy",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const checkout = await makeStubCheckout();
    const stub = await makeStubBinaries();
    const shim = expectInstalled(
      await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
        env: envFrom({ VIBE_BASE_DIR: checkout }),
      }),
    );
    try {
      assert(
        shim.gitShimPath,
        "the git wrapper is installed beside the gh one",
      );
      const result = await runShim(shim.gitShimPath, shim.env, [
        "commit",
        "-m",
        "hello",
      ]);
      assertStringIncludes(result.stderr, STUB_MARKER);
      assert(result.code !== 0, "the planted guard refuses every call");
      assertEquals(await readLog(stub.log), "", "git must not have been run");
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
      await Deno.remove(checkout, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "gh-guard-shim - the real guard still refuses an off-allowlist write from another checkout root",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // The whole guard, not a stub, reached through a checkout root it was
    // never installed under: the entry point's own import graph has to resolve
    // from wherever the launcher mounted it.
    const root = await Deno.makeTempDir({ prefix: "vibe_mounted_" });
    await Deno.mkdir(`${root}/worker`);
    await Deno.symlink(
      `${CHECKOUT_ROOT}/worker/deno`,
      `${root}/worker/deno`,
    );
    const stub = await makeStubBinaries();
    const shim = expectInstalled(
      await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
        env: envFrom({ VIBE_BASE_DIR: root }),
      }),
    );
    try {
      const result = await runShim(shim.shimPath, shim.env, [
        "issue",
        "comment",
        "1",
        "-R",
        "other-owner/other-repo",
        "--body",
        "leak",
      ]);
      assert(result.code !== 0, "expected a non-zero exit for a refused write");
      assertStringIncludes(result.stderr, "WRITE_REPO_BLOCKED");
      assertEquals(await readLog(stub.log), "", "gh must not have been run");
    } finally {
      await shim.cleanup();
      await Deno.remove(stub.dir, { recursive: true });
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "gh-guard-shim - blocks the run when the checkout carries the gh guard but not the git one",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // Both wrappers go into one directory and are installed together, so a
    // checkout that can supply only one of the two guards is still a broken
    // boundary — the `git` half would fall back to the writable staged copy.
    const checkout = await makeStubCheckout();
    await Deno.remove(`${checkout}/${GUARD_MODULE_DIR}/git_guard_cli.ts`);
    const stub = await makeStubBinaries();
    const warnings: string[] = [];
    try {
      const outcome = await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
        env: envFrom({ VIBE_BASE_DIR: checkout }),
        warn: (m) => warnings.push(m),
        allowUnguarded: false,
        record: () => Promise.resolve(),
      });
      assertEquals(outcome.status, "blocked");
      assert(outcome.status === "blocked");
      assertStringIncludes(outcome.reason, "GUARD_MODULE_NOT_IN_CHECKOUT");
      assertStringIncludes(outcome.reason, "git_guard_cli.ts");
      assertStringIncludes(warnings[0] ?? "", "GH_GUARD_SHIM_UNAVAILABLE");
    } finally {
      await Deno.remove(stub.dir, { recursive: true });
      await Deno.remove(checkout, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "gh-guard-shim - blocks the run when the named checkout carries no guard module",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const empty = await Deno.makeTempDir({ prefix: "vibe_no_guard_" });
    const stub = await makeStubBinaries();
    const warnings: string[] = [];
    try {
      const outcome = await installGhGuardShim({
        baseEnv: { ...Deno.env.toObject(), PATH: stub.dir },
        active: true,
        allowedRepos: ["stSoftwareAU/VibeCoder"],
        env: envFrom({ VIBE_BASE_DIR: empty }),
        warn: (m) => warnings.push(m),
        allowUnguarded: false,
        record: () => Promise.resolve(),
      });
      // A guard the agent could rewrite is refused like an uninstallable shim.
      assertEquals(outcome.status, "blocked");
      assert(outcome.status === "blocked");
      assertStringIncludes(outcome.reason, "GUARD_MODULE_NOT_IN_CHECKOUT");
      assertStringIncludes(warnings[0] ?? "", "GH_GUARD_SHIM_UNAVAILABLE");
    } finally {
      await Deno.remove(stub.dir, { recursive: true });
      await Deno.remove(empty, { recursive: true });
    }
  },
});
