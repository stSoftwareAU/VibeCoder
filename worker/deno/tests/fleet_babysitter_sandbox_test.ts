import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  BABYSITTER_PERMISSIONS_PROFILE,
  babysitterProtectedPaths,
  buildBabysitterSandboxArgs,
} from "../lib/fleet_babysitter_sandbox.ts";

const PREFIX = `permissions.${BABYSITTER_PERMISSIONS_PROFILE}.filesystem`;

/** Creates three fresh temp directories and removes them afterwards. */
async function withTempDirs(
  fn: (dirs: [string, string, string]) => Promise<void> | void,
): Promise<void> {
  const dirs: string[] = [];
  const track = async (): Promise<string> => {
    const dir = await Deno.makeTempDir();
    dirs.push(dir);
    return dir;
  };
  try {
    await fn([await track(), await track(), await track()]);
  } finally {
    for (const dir of dirs) await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("babysitterProtectedPaths lists babysitter entries and the configured key only", async () => {
  await withTempDirs(async ([home, elsewhere]) => {
    const vibeDir = `${home}/.vibe-coder`;
    const keyElsewhere = `${elsewhere}/configured-key.pem`;
    await Deno.mkdir(`${vibeDir}/fleet-pr-babysitter`, { recursive: true });
    await Deno.writeTextFile(`${vibeDir}/fleet-pr-babysitter/app.json`, "{}");
    await Deno.writeTextFile(
      `${vibeDir}/fleet-pr-babysitter.private-key.pem`,
      "pem",
    );
    await Deno.writeTextFile(`${vibeDir}/fleet-pr-babysitter-extra`, "x");
    await Deno.writeTextFile(`${vibeDir}/worker-notes`, "notes");
    await Deno.writeTextFile(keyElsewhere, "pem");

    const result = await babysitterProtectedPaths(home, keyElsewhere);

    for (
      const expected of [
        `${vibeDir}/fleet-pr-babysitter`,
        `${vibeDir}/fleet-pr-babysitter.private-key.pem`,
        `${vibeDir}/fleet-pr-babysitter-extra`,
        keyElsewhere,
      ]
    ) {
      assert(result.includes(expected), `missing ${expected}`);
    }
    const unrelated = `${vibeDir}/worker-notes`;
    assert(!result.includes(unrelated), "unrelated entry must not be listed");
    assert(
      !result.includes(await Deno.realPath(unrelated)),
      "realPath of unrelated entry must not be listed",
    );
    assertEquals(result, [...result].sort());
    assertEquals(new Set(result).size, result.length);
  });
});

Deno.test("babysitterProtectedPaths includes both a symlinked key and its target", async () => {
  await withTempDirs(async ([home, targetDir, linkDir]) => {
    const target = `${targetDir}/app-key.pem`;
    const link = `${linkDir}/key-link.pem`;
    await Deno.writeTextFile(target, "pem");
    await Deno.symlink(target, link);

    const result = await babysitterProtectedPaths(home, link);

    assert(result.includes(link), "symlink path must be listed");
    assert(
      result.includes(await Deno.realPath(target)),
      "symlink target must be listed",
    );
  });
});

Deno.test("babysitterProtectedPaths tolerates a missing .vibe-coder directory", async () => {
  await withTempDirs(async ([home, elsewhere]) => {
    const keyPath = `${elsewhere}/absent-key.pem`;

    const result = await babysitterProtectedPaths(home, keyPath);

    assertEquals(result, [keyPath]);
  });
});

Deno.test("babysitterProtectedPaths rejects non-absolute home or key paths", async () => {
  await withTempDirs(async ([home]) => {
    await assertRejects(
      () => babysitterProtectedPaths("relative/home", `${home}/key.pem`),
      Error,
      "must be an absolute path",
    );
    await assertRejects(
      () => babysitterProtectedPaths(home, "key.pem"),
      Error,
      "must be an absolute path",
    );
  });
});

Deno.test("buildBabysitterSandboxArgs emits the exact profile overrides", async () => {
  await withTempDirs(([root]) => {
    const dir = `${root}/clone`;
    const scratch = `${root}/scratch`;
    const protectedPaths = [
      `${root}/.vibe-coder/fleet-pr-babysitter`,
      `${root}/.vibe-coder/fleet-pr-babysitter.private-key.pem`,
    ];

    const args = buildBabysitterSandboxArgs({ dir, scratch, protectedPaths });

    assertEquals(args, [
      "-c",
      `default_permissions="${BABYSITTER_PERMISSIONS_PROFILE}"`,
      "-c",
      `${PREFIX}."/"="read"`,
      "-c",
      `${PREFIX}."${dir}"="write"`,
      "-c",
      `${PREFIX}."${dir}/.git"="read"`,
      "-c",
      `${PREFIX}."${scratch}"="write"`,
      "-c",
      `${PREFIX}."${protectedPaths[0]}"="none"`,
      "-c",
      `${PREFIX}."${protectedPaths[1]}"="none"`,
    ]);
    for (const path of protectedPaths) {
      assert(args.includes(`${PREFIX}."${path}"="none"`));
      assert(!args.includes(`${PREFIX}."${path}"="read"`));
      assert(!args.includes(`${PREFIX}."${path}"="write"`));
    }
  });
});

Deno.test("buildBabysitterSandboxArgs refuses an empty protected list", async () => {
  await withTempDirs(([root]) => {
    const dir = `${root}/clone`;
    const scratch = `${root}/scratch`;

    assertThrows(
      () => buildBabysitterSandboxArgs({ dir, scratch, protectedPaths: [] }),
      Error,
      "no protected paths",
    );
    // Positive control: one protected path makes the same call legal.
    const args = buildBabysitterSandboxArgs({
      dir,
      scratch,
      protectedPaths: [`${root}/keys`],
    });
    assertEquals(args[0], "-c");
  });
});

Deno.test("buildBabysitterSandboxArgs refuses a clone directory equal to or inside a protected path", async () => {
  await withTempDirs(([root]) => {
    const protectedPaths = [`${root}/clone`];
    const scratch = `${root}/scratch`;

    assertThrows(
      () =>
        buildBabysitterSandboxArgs({
          dir: `${root}/clone`,
          scratch,
          protectedPaths,
        }),
      Error,
      "inside protected path",
    );
    assertThrows(
      () =>
        buildBabysitterSandboxArgs({
          dir: `${root}/clone/x`,
          scratch,
          protectedPaths,
        }),
      Error,
      "inside protected path",
    );
    // Positive control: a clone directory outside the protected path succeeds.
    const args = buildBabysitterSandboxArgs({
      dir: `${root}/elsewhere`,
      scratch,
      protectedPaths,
    });
    assertEquals(args[0], "-c");
  });
});

Deno.test("buildBabysitterSandboxArgs refuses a scratch directory equal to or inside a protected path", async () => {
  await withTempDirs(([root]) => {
    const protectedPaths = [`${root}/scratch`];
    const dir = `${root}/clone`;

    assertThrows(
      () =>
        buildBabysitterSandboxArgs({
          dir,
          scratch: `${root}/scratch`,
          protectedPaths,
        }),
      Error,
      "inside protected path",
    );
    assertThrows(
      () =>
        buildBabysitterSandboxArgs({
          dir,
          scratch: `${root}/scratch/x`,
          protectedPaths,
        }),
      Error,
      "inside protected path",
    );
    // Positive control: a scratch directory outside the protected path succeeds.
    const args = buildBabysitterSandboxArgs({
      dir,
      scratch: `${root}/other`,
      protectedPaths,
    });
    assertEquals(args[0], "-c");
  });
});

Deno.test("buildBabysitterSandboxArgs refuses non-absolute directories", async () => {
  await withTempDirs(([root]) => {
    assertThrows(
      () =>
        buildBabysitterSandboxArgs({
          dir: "clone",
          scratch: `${root}/scratch`,
          protectedPaths: [`${root}/keys`],
        }),
      Error,
      "must be an absolute path",
    );
    // Positive control: the same call with an absolute clone directory succeeds.
    const args = buildBabysitterSandboxArgs({
      dir: `${root}/clone`,
      scratch: `${root}/scratch`,
      protectedPaths: [`${root}/keys`],
    });
    assertEquals(args[0], "-c");
  });
});

Deno.test("buildBabysitterSandboxArgs escapes double quotes in protected paths", async () => {
  await withTempDirs(([root]) => {
    const protectedPath = `${root}/a/b"c`;

    const args = buildBabysitterSandboxArgs({
      dir: `${root}/clone`,
      scratch: `${root}/scratch`,
      protectedPaths: [protectedPath],
    });

    assertEquals(args.length, 12);
    assertEquals(
      args[args.length - 1],
      `${PREFIX}."${root}/a/b\\"c"="none"`,
    );
  });
});
