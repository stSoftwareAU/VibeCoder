/**
 * What the untrusted account is granted on the shared work volume
 * (Issue #1384).
 *
 * `container/entrypoint.sh` hands the `vibework` group — the group the
 * `agent` account runs repository-controlled code under (Issue #571) — a
 * grant over the work root at every launch. The grant used to be the same
 * for every top-level directory on the volume, so the worker's OWN state
 * directories were handed group write alongside the repository clones the
 * quality gate legitimately writes into: the hash-chained audit journal
 * (`audit/`), the self-heal log directory (`logs/`) and the lane worktree
 * root (`worktrees/`) another slot may be running out of.
 *
 * Every case runs the real script with a stub PATH and asserts on the mode
 * bits the volume actually ends up with, so the grant is verified rather
 * than described.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { RESERVED_WORKDIR_NAMES } from "../lib/stale_workdir.ts";

const ENTRYPOINT = new URL("../../../container/entrypoint.sh", import.meta.url)
  .pathname;

/** Group write, group read+execute, and the setgid bit. */
const GROUP_WRITE = 0o020;
const GROUP_READ_EXECUTE = 0o050;
const SETGID = 0o2000;

/**
 * A stub PATH the entrypoint's work-root block can actually run through.
 *
 * `getent` and `chgrp` are faked as successes — no test host owns a
 * `vibework` group, and without them the block short-circuits and there is
 * nothing to observe. `chmod` is the one that must be REAL: the assertions
 * read the mode bits off the volume afterwards, so the stub records the call
 * and then hands over to the system binary.
 */
async function stubBin(dir: string): Promise<string> {
  const binDir = `${dir}/bin`;
  await Deno.mkdir(binDir, { recursive: true });
  const write = async (name: string, body: string) => {
    await Deno.writeTextFile(`${binDir}/${name}`, body);
    await Deno.chmod(`${binDir}/${name}`, 0o755);
  };
  await write("deno", "#!/bin/bash\nexit 0\n");
  await write("getent", "#!/bin/bash\nexit 0\n");
  await write("chgrp", "#!/bin/bash\nexit 0\n");
  await write("chmod", '#!/bin/bash\nexec /bin/chmod "$@"\n');
  return binDir;
}

/** Create the throwaway worker checkout the entrypoint points at. */
async function fakeRepo(dir: string): Promise<void> {
  await Deno.mkdir(`${dir}/repo/worker/deno`, { recursive: true });
  await Deno.writeTextFile(`${dir}/repo/worker/deno/mod.ts`, "// stub\n");
  await Deno.writeTextFile(`${dir}/repo/worker/deno/deno.lock`, "{}\n");
}

/**
 * Lay out a work root that mixes tenant clones with the worker's own state,
 * run the entrypoint over it, and return the work root path.
 */
async function runOverWorkRoot(dir: string): Promise<string> {
  const binDir = await stubBin(dir);
  await fakeRepo(dir);
  const home = `${dir}/home`;
  const workRoot = `${home}/auto-issue-work`;
  for (
    const name of [
      "NEAT-AI",
      "NEAT-AI-Discovery",
      ...RESERVED_WORKDIR_NAMES,
    ]
  ) {
    await Deno.mkdir(`${workRoot}/${name}`, { recursive: true });
    await Deno.chmod(`${workRoot}/${name}`, 0o755);
  }
  await Deno.mkdir(`${dir}/tmp`, { recursive: true });

  const { success, stderr } = await new Deno.Command("/bin/bash", {
    args: [ENTRYPOINT],
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: `${dir}/tmp`,
      VIBE_BASE_DIR: `${dir}/repo`,
    },
    clearEnv: true,
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(success, new TextDecoder().decode(stderr));
  return workRoot;
}

/** The mode bits of one work-root entry after the entrypoint has run. */
async function modeOf(workRoot: string, name: string): Promise<number> {
  const stat = await Deno.stat(`${workRoot}/${name}`);
  const mode = stat.mode;
  assert(mode !== null, "no mode bits on this platform");
  return mode;
}

Deno.test("entrypoint - a repository clone stays writable by the untrusted account", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const workRoot = await runOverWorkRoot(dir);
    for (const clone of ["NEAT-AI", "NEAT-AI-Discovery"]) {
      const mode = await modeOf(workRoot, clone);
      assertEquals(
        mode & GROUP_WRITE,
        GROUP_WRITE,
        `${clone} lost the group write the quality gate needs`,
      );
      assertEquals(
        mode & SETGID,
        SETGID,
        `${clone} lost setgid, so new directories stop inheriting the group`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - the worker's own state directories are never handed group write (Issue #1384)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-work-grant-" });
  try {
    const workRoot = await runOverWorkRoot(dir);
    for (const reserved of RESERVED_WORKDIR_NAMES) {
      const mode = await modeOf(workRoot, reserved);
      assertEquals(
        mode & GROUP_WRITE,
        0,
        `${reserved} is worker state, not a place repository code writes`,
      );
      assertEquals(
        mode & GROUP_READ_EXECUTE,
        GROUP_READ_EXECUTE,
        `${reserved} must stay traversable by the untrusted account`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - withholds exactly the reserved work-root names", async () => {
  const source = await Deno.readTextFile(ENTRYPOINT);
  const match = source.match(/^[ \t]*([^)\n]+)\) # reserved work-root names$/m);
  assert(
    match,
    "the entrypoint no longer names the reserved work-root entries",
  );
  const named = match[1]!.split("|").map((p) => p.trim()).sort();
  assertEquals(
    named,
    [...RESERVED_WORKDIR_NAMES].sort(),
    "the entrypoint's reserved list drifted from RESERVED_WORKDIR_NAMES",
  );
});
