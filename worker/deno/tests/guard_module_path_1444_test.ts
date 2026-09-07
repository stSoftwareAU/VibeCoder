/**
 * The guard modules execute from the read-only checkout (Issue #1444).
 *
 * The `gh`/`git` wrappers on the agent's PATH spawn a Deno child per call,
 * executing a guard entry point by absolute path. Resolved from
 * `import.meta.url`, that path pointed into the writable copy of
 * `worker/deno` the entrypoint stages for speed — so the module enforcing the
 * write-repo allowlist, the reserved-label denylist, the endpoint host check
 * (Issue #1420) and the run-scoped credential wiring (Issue #1423) was itself
 * writable by the uid the coding agent runs as, and re-read on every call.
 *
 * The last test here is the one that matters: it does not assert that the
 * resolution changed, it puts DIFFERENT code at the two candidate paths, runs
 * the real wrapper, and observes which one actually executed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BASE_DIR_ENV,
  GUARD_MODULE_SUBDIR,
  resolveGuardModulePath,
} from "../lib/guard_module_path.ts";
import { renderGhShimScript } from "../lib/gh_guard_shim.ts";

const MODULE_URL = "file:///staged/worker/deno/lib/gh_guard_shim.ts";
const STAGED = "/staged/worker/deno/lib/gh_guard_cli.ts";

/** An environment naming a checkout, as the container launcher does. */
const withBase = (dir: string) => (name: string): string | undefined =>
  name === BASE_DIR_ENV ? dir : undefined;

const noBase = (_name: string): string | undefined => undefined;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

Deno.test("SEC-1444 - the checkout copy wins over the staged one", () => {
  const resolved = resolveGuardModulePath(
    "gh_guard_cli.ts",
    MODULE_URL,
    withBase("/workspace"),
    () => true,
  );
  assertEquals(resolved, `/workspace/${GUARD_MODULE_SUBDIR}/gh_guard_cli.ts`);
  assert(
    !resolved.startsWith("/staged"),
    "must not resolve into the staged copy",
  );
});

Deno.test("SEC-1444 - a trailing slash on the checkout path does not double up", () => {
  assertEquals(
    resolveGuardModulePath(
      "gh_guard_cli.ts",
      MODULE_URL,
      withBase("/workspace/"),
      () => true,
    ),
    `/workspace/${GUARD_MODULE_SUBDIR}/gh_guard_cli.ts`,
  );
});

Deno.test("SEC-1444 - falls back to module-relative when no checkout is named", () => {
  // Outside the container — tests, a developer host — there is no
  // VIBE_BASE_DIR, and the guard must still run.
  assertEquals(
    resolveGuardModulePath("gh_guard_cli.ts", MODULE_URL, noBase, () => true),
    STAGED,
  );
});

Deno.test("SEC-1444 - falls back when the checkout does not carry the module", () => {
  // A layout that does not have the file where expected must not break every
  // gh call the agent makes. Safe: the checkout is a read-only mount, so the
  // file an attacker would have to remove to force this branch is one they
  // cannot remove.
  assertEquals(
    resolveGuardModulePath(
      "gh_guard_cli.ts",
      MODULE_URL,
      withBase("/workspace"),
      () => false,
    ),
    STAGED,
  );
});

Deno.test("SEC-1444 - a blank checkout value is treated as unset", () => {
  assertEquals(
    resolveGuardModulePath(
      "gh_guard_cli.ts",
      MODULE_URL,
      withBase("   "),
      () => true,
    ),
    STAGED,
  );
});

Deno.test("SEC-1444 - the git guard resolves the same way", () => {
  assertEquals(
    resolveGuardModulePath(
      "git_guard_cli.ts",
      MODULE_URL,
      withBase("/workspace"),
      () => true,
    ),
    `/workspace/${GUARD_MODULE_SUBDIR}/git_guard_cli.ts`,
  );
});

// ---------------------------------------------------------------------------
// Empirical: which module does the wrapper actually run?
// ---------------------------------------------------------------------------

Deno.test("SEC-1444 - the wrapper executes the checkout module, not a rewritten staged one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-guard-path-" });
  try {
    // Two distinguishable guard modules, one at each candidate path.
    const checkoutLib = `${dir}/workspace/${GUARD_MODULE_SUBDIR}`;
    const stagedLib = `${dir}/staged/worker/deno/lib`;
    await Deno.mkdir(checkoutLib, { recursive: true });
    await Deno.mkdir(stagedLib, { recursive: true });
    // Each stub records that IT ran, by side effect, into the one directory
    // the guard child is granted write access to. A marker file is
    // unambiguous: it does not depend on the verdict protocol, so the test
    // proves which module executed rather than which one we asked for.
    const guard = (which: string) =>
      `await Deno.writeTextFile(${
        JSON.stringify(`${dir}/ran-${which}`)
      }, "");\n`;
    await Deno.writeTextFile(
      `${checkoutLib}/gh_guard_cli.ts`,
      guard("checkout"),
    );
    await Deno.writeTextFile(`${stagedLib}/gh_guard_cli.ts`, guard("staged"));

    const resolved = resolveGuardModulePath(
      "gh_guard_cli.ts",
      `file://${stagedLib}/gh_guard_shim.ts`,
      withBase(`${dir}/workspace`),
    );
    assertEquals(
      resolved,
      `${checkoutLib}/gh_guard_cli.ts`,
      "resolution must select the checkout copy",
    );

    // Render and run the real wrapper against that resolved module.
    const realGh = `${dir}/real-gh`;
    await Deno.writeTextFile(realGh, "#!/bin/bash\nprintf 'real-gh-ran\\n'\n");
    await Deno.chmod(realGh, 0o755);

    const shim = `${dir}/gh`;
    await Deno.writeTextFile(
      shim,
      renderGhShimScript({
        denoPath: Deno.execPath(),
        guardModulePath: resolved,
        realGhPath: realGh,
        active: true,
        allowedRepos: ["owner/repo"],
        verdictDir: dir,
        denoDir: `${dir}/deno-cache`,
      }),
    );
    await Deno.chmod(shim, 0o755);

    const { stderr, success } = await new Deno.Command(shim, {
      args: ["issue", "comment", "1", "--body", "hi"],
      stdout: "piped",
      stderr: "piped",
    }).output();

    const err = new TextDecoder().decode(stderr);
    const ran = async (which: string): Promise<boolean> => {
      try {
        await Deno.stat(`${dir}/ran-${which}`);
        return true;
      } catch {
        return false;
      }
    };

    // The empirical assertion: the checkout module executed and the staged
    // one did not. Rewriting the staged copy therefore changes nothing about
    // what enforces the guard.
    assertEquals(
      await ran("checkout"),
      true,
      `checkout guard did not run: ${err}`,
    );
    assertEquals(
      await ran("staged"),
      false,
      "the staged module must not execute",
    );
    // And the command was refused, since the stub returned no allow marker —
    // a guard that cannot be evaluated fails closed.
    assertEquals(
      success,
      false,
      "an unevaluated guard must refuse the command",
    );
    assertStringIncludes(err, "[SECURITY]");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
