/**
 * Tests for container/install-tools.sh — the generic install step the
 * Containerfile drives from the `VIBE_CONTAINER_TOOLS` build argument
 * (Issue #71, parent #5).
 *
 * The download/verify/extract implementation is Issue #70; what is covered
 * here is the contract the Containerfile depends on and which survives that
 * implementation: a spec file is required, a missing one aborts, and an empty
 * selection installs nothing without failing. Every test runs the real script
 * and asserts on its exit code and output — never on its source text.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** The script the Containerfile runs for the deployer-selected tool set. */
const INSTALLER = `${REPO_ROOT}/container/install-tools.sh`;

interface InstallerRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the installer with the given arguments. */
async function runInstaller(args: string[]): Promise<InstallerRun> {
  const result = await new Deno.Command("bash", {
    args: [INSTALLER, ...args],
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();

  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

/** Write a spec file into a fresh temporary directory. */
async function specFile(contents: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-tools-" });
  const path = `${dir}/container-tools.json`;
  await Deno.writeTextFile(path, contents);
  return path;
}

Deno.test("install-tools - a missing spec argument aborts", async () => {
  const run = await runInstaller([]);

  assert(run.code !== 0, "no argument must abort rather than install nothing");
  assertStringIncludes(run.stderr, "spec file");
});

Deno.test("install-tools - a spec file that does not exist aborts", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-tools-" });
  const run = await runInstaller([`${dir}/absent.json`]);

  assert(run.code !== 0, "an absent spec must abort loudly");
  assertStringIncludes(run.stderr, "absent.json");
});

Deno.test("install-tools - an empty selection installs nothing and succeeds", async () => {
  for (const contents of ["", "  \n", "[]", " [ ]\n"]) {
    const run = await runInstaller([await specFile(contents)]);
    assertEquals(
      run.code,
      0,
      `an empty selection (${JSON.stringify(contents)}) must be a no-op: ` +
        run.stderr,
    );
  }
});

Deno.test("install-tools - a requested tool set is never silently skipped", async () => {
  const spec = await specFile(
    JSON.stringify([{ id: "java", version: "21.0.5+11" }]),
  );
  const run = await runInstaller([spec]);

  // Issue #70 replaces the stub with the real installer; either way a
  // requested tool must never leave the build reporting success without it.
  if (run.code === 0) {
    assert(
      run.stdout.includes("java"),
      `a successful run must report installing "java": ${run.stdout}`,
    );
  } else {
    assertStringIncludes(run.stderr, "java");
  }
});
