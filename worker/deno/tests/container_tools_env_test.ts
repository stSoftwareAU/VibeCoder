/**
 * Tests for container/entrypoint.sh applying the deployer-supplied tool set
 * at container start (Issue #74, parent #5).
 *
 * install-tools.sh (#70) records `PATH=<dir>` and `<KEY>=<value>` lines in
 * ${VIBE_TOOLS_PREFIX}/environment; the entrypoint prepends each bin dir to
 * PATH and exports each env var before handing off to the worker. These tests
 * run the real entrypoint with a stub `deno` that dumps the environment it was
 * exec'd with, so the application is verified rather than described.
 *
 * The file is never sourced or eval'd: a malformed line must abort loudly.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const ENTRYPOINT = new URL("../../../container/entrypoint.sh", import.meta.url)
  .pathname;

/**
 * A stub `deno` that records the environment it was launched with, so the
 * test can assert on PATH / exported vars after the entrypoint applied them.
 */
async function stubDenoDumpingEnv(dir: string): Promise<string> {
  const binDir = `${dir}/bin`;
  const dump = `${dir}/env-dump.txt`;
  await Deno.mkdir(binDir, { recursive: true });
  await Deno.writeTextFile(
    `${binDir}/deno`,
    `#!/bin/bash\n{\n` +
      `  echo "PATH=$PATH"\n` +
      `  echo "JAVA_HOME=\${JAVA_HOME:-}"\n` +
      `  echo "VIBE_IMAGE_CONTAINER_TOOLS=\${VIBE_IMAGE_CONTAINER_TOOLS:-}"\n` +
      `} > "${dump}"\nexit 0\n`,
  );
  await Deno.chmod(`${binDir}/deno`, 0o755);
  return dump;
}

async function fakeRepo(dir: string): Promise<void> {
  await Deno.mkdir(`${dir}/repo/worker/deno`, { recursive: true });
  await Deno.writeTextFile(`${dir}/repo/worker/deno/mod.ts`, "// stub\n");
  await Deno.writeTextFile(`${dir}/repo/worker/deno/deno.lock`, "{}\n");
}

async function runEntrypoint(opts: {
  dir: string;
  path: string;
  env?: Record<string, string>;
}): Promise<{ code: number; stderr: string }> {
  const env: Record<string, string> = {
    PATH: opts.path,
    HOME: `${opts.dir}/home`,
    ...(opts.env ?? {}),
  };
  const { code, stderr } = await new Deno.Command("/bin/bash", {
    args: [ENTRYPOINT],
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

/** Parse the stub's env dump into a map. */
function parseDump(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** A tools prefix holding an `environment` file and optional tool dirs. */
async function toolsPrefix(
  dir: string,
  envLines: string[],
  toolIds: string[] = [],
): Promise<string> {
  const prefix = `${dir}/opt-vibe-tools`;
  await Deno.mkdir(prefix, { recursive: true });
  for (const id of toolIds) {
    await Deno.mkdir(`${prefix}/${id}/bin`, { recursive: true });
  }
  await Deno.writeTextFile(`${prefix}/environment`, envLines.join("\n") + "\n");
  return prefix;
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-tools-env-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------

Deno.test("entrypoint tools - no environment file leaves PATH byte-identical", async () => {
  await withDir(async (dir) => {
    const dump = await stubDenoDumpingEnv(dir);
    await fakeRepo(dir);
    const { code } = await runEntrypoint({
      dir,
      path: `${dir}/bin`,
      // A prefix that has no environment file.
      env: {
        VIBE_BASE_DIR: `${dir}/repo`,
        VIBE_TOOLS_PREFIX: `${dir}/absent-tools`,
      },
    });
    assertEquals(code, 0);
    const env = parseDump(await Deno.readTextFile(dump));
    // Untouched: exactly the PATH the entrypoint was launched with.
    assertEquals(env.PATH, `${dir}/bin`);
    assertEquals(env.VIBE_IMAGE_CONTAINER_TOOLS, "");
  });
});

Deno.test("entrypoint tools - a recorded bin dir is prepended to PATH", async () => {
  await withDir(async (dir) => {
    const dump = await stubDenoDumpingEnv(dir);
    await fakeRepo(dir);
    const prefix = await toolsPrefix(dir, [
      `PATH=${dir}/opt-vibe-tools/java/bin`,
    ], [
      "java",
    ]);
    const { code } = await runEntrypoint({
      dir,
      path: `${dir}/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, VIBE_TOOLS_PREFIX: prefix },
    });
    assertEquals(code, 0);
    const env = parseDump(await Deno.readTextFile(dump));
    assertEquals(env.PATH, `${prefix}/java/bin:${dir}/bin`);
    assertEquals(env.VIBE_IMAGE_CONTAINER_TOOLS, "java");
  });
});

Deno.test("entrypoint tools - a recorded env var is exported", async () => {
  await withDir(async (dir) => {
    const dump = await stubDenoDumpingEnv(dir);
    await fakeRepo(dir);
    const prefix = await toolsPrefix(
      dir,
      [`JAVA_HOME=${dir}/opt-vibe-tools/java`],
      ["java"],
    );
    const { code } = await runEntrypoint({
      dir,
      path: `${dir}/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, VIBE_TOOLS_PREFIX: prefix },
    });
    assertEquals(code, 0);
    const env = parseDump(await Deno.readTextFile(dump));
    assertEquals(env.JAVA_HOME, `${prefix}/java`);
  });
});

Deno.test("entrypoint tools - a malformed line aborts loudly, never executed", async () => {
  await withDir(async (dir) => {
    await stubDenoDumpingEnv(dir);
    await fakeRepo(dir);
    // No '=' — must be rejected, not sourced. A payload that would delete a
    // marker file if the line were ever executed proves it is only parsed.
    const canary = `${dir}/canary`;
    await Deno.writeTextFile(canary, "alive");
    const prefix = await toolsPrefix(dir, [`rm -f ${canary}`]);
    const { code, stderr } = await runEntrypoint({
      dir,
      path: `${dir}/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, VIBE_TOOLS_PREFIX: prefix },
    });
    assert(code !== 0, "a malformed line must abort the entrypoint");
    assertStringIncludes(stderr, "malformed");
    assertEquals(await Deno.readTextFile(canary), "alive", "the line ran!");
  });
});

Deno.test("entrypoint tools - a malformed key aborts loudly", async () => {
  await withDir(async (dir) => {
    await stubDenoDumpingEnv(dir);
    await fakeRepo(dir);
    const prefix = await toolsPrefix(dir, ["1BAD=x"]);
    const { code, stderr } = await runEntrypoint({
      dir,
      path: `${dir}/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, VIBE_TOOLS_PREFIX: prefix },
    });
    assert(code !== 0, "an invalid env key must abort");
    assertStringIncludes(stderr, "malformed key");
  });
});
