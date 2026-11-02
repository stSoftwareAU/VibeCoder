import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  BABYSITTER_FILESYSTEM_KEY,
  BABYSITTER_PERMISSIONS_PROFILE,
  babysitterHostCredentialPaths,
  babysitterProtectedPaths,
  buildBabysitterSandboxArgs,
  codexVersionMeetsFloor,
} from "../lib/fleet_babysitter_sandbox.ts";
import { emptyEnv } from "./support/env_lookup.ts";

/** The grant entry as it appears inside the inline table. */
const grant = (path: string, access: string) =>
  `${JSON.stringify(path)} = ${JSON.stringify(access)}`;

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

    const result = await babysitterProtectedPaths(home, keyElsewhere, []);

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

    const result = await babysitterProtectedPaths(home, link, []);

    assert(result.includes(link), "symlink path must be listed");
    assert(
      result.includes(await Deno.realPath(target)),
      "symlink target must be listed",
    );
  });
});

Deno.test("babysitterProtectedPaths normalises and resolves missing and symlinked credential paths", async () => {
  await withTempDirs(async ([home, targetDir, linkDir]) => {
    const target = `${targetDir}/reviewer.pem`;
    const link = `${linkDir}/reviewer-link.pem`;
    const missing = `${linkDir}/not-created/reviewer-link.pem`;
    await Deno.writeTextFile(target, "pem");
    await Deno.symlink(target, link);

    const result = await babysitterProtectedPaths(home, `${home}/key.pem`, [
      `${linkDir}/not-created/../reviewer-link.pem`,
      missing,
      `${linkDir}/not-created/../reviewer-link.pem/..`,
    ]);

    assert(result.includes(link), "normalised symlink location must be denied");
    assert(
      result.includes(await Deno.realPath(target)),
      "symlink target must be denied",
    );
    assert(
      result.includes(missing),
      "a missing path must retain its normalised location",
    );
    assert(!result.includes(`${linkDir}/not-created/../reviewer-link.pem`));
    assert(
      result.includes(`${linkDir}`),
      "normalised traversal target is protected",
    );
  });
});

Deno.test("babysitterProtectedPaths denies a symlinked credential directory and its target", async () => {
  await withTempDirs(async ([home, targetDir, linkDir]) => {
    const target = `${targetDir}/credentials`;
    const link = `${linkDir}/credential-link`;
    await Deno.mkdir(target);
    await Deno.symlink(target, link);

    const result = await babysitterProtectedPaths(home, `${home}/key.pem`, [
      link,
    ]);

    assert(result.includes(link));
    assert(result.includes(await Deno.realPath(target)));
  });
});

Deno.test("babysitterProtectedPaths denies missing credential tails beneath a directory symlink", async () => {
  await withTempDirs(async ([home, targetDir, linkDir]) => {
    const link = `${linkDir}/credentials`;
    await Deno.symlink(targetDir, link);
    const configured = `${link}/not-created/key.pem`;
    const canonical = `${await Deno.realPath(targetDir)}/not-created/key.pem`;
    await assertRejects(() => Deno.stat(configured), Deno.errors.NotFound);

    const protectedPaths = await babysitterProtectedPaths(
      home,
      `${home}/app.pem`,
      [configured],
    );
    const args = buildBabysitterSandboxArgs({
      dir: `${home}/clone`,
      scratch: `${home}/scratch`,
      protectedPaths,
    });
    assert(args[3]!.includes(grant(configured, "none")));
    assert(args[3]!.includes(grant(canonical, "none")));
  });
});

Deno.test("babysitterProtectedPaths removes dot segments and validates additional paths", async () => {
  await withTempDirs(async ([home, elsewhere]) => {
    const key = `${elsewhere}/key.pem`;
    await Deno.writeTextFile(key, "test credential");
    assertEquals(
      await babysitterProtectedPaths(home, key, [`${elsewhere}/./key.pem`]),
      [...new Set([await Deno.realPath(key), key])].sort(),
    );
    await assertRejects(
      () => babysitterProtectedPaths(home, key, ["relative/key.pem"]),
      Error,
      "A protected path must be an absolute path",
    );
  });
});

Deno.test("babysitterProtectedPaths stops when even the root cannot be resolved", async () => {
  await withTempDirs(async ([home]) => {
    const realPath = Deno.realPath;
    let calls = 0;
    Deno.realPath = () => {
      if (++calls > 1) throw new Error("resolution retried the root");
      return Promise.reject(new Deno.errors.NotFound("root unavailable"));
    };
    try {
      await assertRejects(
        () => babysitterProtectedPaths(home, "/", []),
        Error,
        "Could not resolve protected path prefix for /",
      );
      assertEquals(calls, 1);
    } finally {
      Deno.realPath = realPath;
    }
  });
});

Deno.test("babysitterHostCredentialPaths validates HOME independently of credential defaults", async () => {
  await withTempDirs(async ([home]) => {
    await assertRejects(
      () =>
        babysitterHostCredentialPaths(
          `${home}/missing.json`,
          "relative",
          () => "/credentials",
        ),
      Error,
      "HOME must be an absolute path",
    );
  });
});

for (const config of [null, false, 17, "config", []]) {
  Deno.test(`babysitterHostCredentialPaths rejects non-object configuration ${JSON.stringify(config)}`, async () => {
    await withTempDirs(async ([home]) => {
      const configPath = `${home}/config.json`;
      await Deno.writeTextFile(configPath, JSON.stringify(config));
      await assertRejects(
        () => babysitterHostCredentialPaths(configPath, home, emptyEnv),
        Error,
        "Worker configuration must be an object",
      );
    });
  });
}

Deno.test("babysitterHostCredentialPaths ignores absent reviewer keys and empty credential fields", async () => {
  await withTempDirs(async ([home]) => {
    const configPath = `${home}/config.json`;
    const expected = [
      `${home}/.vibe-coder/credentials`,
      `${home}/.config/gh`,
    ];
    for (const reviewer of [undefined, null, false, 17, "reviewer", [], {}]) {
      await Deno.writeTextFile(
        configPath,
        JSON.stringify({
          pr_reviewer_app: reviewer,
          ssh_key_path: " \t ",
          github_app_private_key_path: "",
          gh_config_dir: false,
        }),
      );
      assertEquals(
        new Set(
          await babysitterHostCredentialPaths(configPath, home, emptyEnv),
        ),
        new Set(expected),
      );
    }
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        ssh_key_path: " ~/ssh.pem ",
        pr_reviewer_app: { private_key_path: " ~/reviewer.pem " },
      }),
    );
    assertEquals(
      new Set(await babysitterHostCredentialPaths(configPath, home, emptyEnv)),
      new Set([...expected, `${home}/reviewer.pem`, `${home}/ssh.pem`]),
    );
  });
});

Deno.test("babysitterProtectedPaths fails on an unexpected symlink resolution error", async () => {
  await withTempDirs(async ([home, elsewhere]) => {
    const loop = `${elsewhere}/loop`;
    await Deno.symlink(loop, loop);

    await assertRejects(
      () => babysitterProtectedPaths(home, `${home}/key.pem`, [loop]),
      Error,
    );
  });
});

Deno.test("babysitterProtectedPaths tolerates a missing .vibe-coder directory", async () => {
  await withTempDirs(async ([home, elsewhere]) => {
    const keyPath = `${elsewhere}/absent-key.pem`;

    const result = await babysitterProtectedPaths(home, keyPath, []);

    assertEquals(result, [keyPath]);
  });
});

Deno.test("babysitterProtectedPaths rejects non-absolute home or key paths", async () => {
  await withTempDirs(async ([home]) => {
    await assertRejects(
      () => babysitterProtectedPaths("relative/home", `${home}/key.pem`, []),
      Error,
      "must be an absolute path",
    );
    await assertRejects(
      () => babysitterProtectedPaths(home, "key.pem", []),
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
      `${BABYSITTER_FILESYSTEM_KEY}={ ${
        [
          grant("/", "read"),
          grant(dir, "write"),
          grant(`${dir}/.git`, "read"),
          grant(scratch, "write"),
          grant(protectedPaths[0]!, "none"),
          grant(protectedPaths[1]!, "none"),
        ].join(", ")
      } }`,
      "-c",
      "permissions.babysitter-agent.network={ enabled = true }",
    ]);
    // Codex splits a `-c` key on every dot, so no path may sit in a key.
    assertEquals(
      BABYSITTER_FILESYSTEM_KEY,
      "permissions.babysitter-agent.filesystem",
    );
    for (const path of protectedPaths) {
      assert(args[3]!.includes(grant(path, "none")));
      assert(!args[3]!.includes(grant(path, "read")));
      assert(!args[3]!.includes(grant(path, "write")));
    }
    assertEquals(
      args.filter((arg) => arg.includes(protectedPaths[0]!)).length,
      1,
    );
    assertEquals(args[2], "-c");
    assert(!args[2]!.includes("."));
    assert(args[3]!.startsWith(`${BABYSITTER_FILESYSTEM_KEY}={ `));
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
    assertThrows(
      () =>
        buildBabysitterSandboxArgs({
          dir: `${root}/clone`,
          scratch,
          protectedPaths: [`${root}/clone/credentials`],
        }),
      Error,
      "overlaps writable path",
    );
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
    assertThrows(
      () =>
        buildBabysitterSandboxArgs({
          dir,
          scratch: `${root}/scratch`,
          protectedPaths: [`${root}/scratch/credentials`],
        }),
      Error,
      "overlaps writable path",
    );
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

    assertEquals(args.length, 6);
    assert(
      args[3]!.endsWith(`, "${root}/a/b\\"c" = "none" }`),
      args[3],
    );
  });
});

Deno.test("buildBabysitterSandboxArgs refuses a non-absolute scratch directory", async () => {
  await withTempDirs(([root]) => {
    assertThrows(
      () =>
        buildBabysitterSandboxArgs({
          dir: `${root}/clone`,
          scratch: "scratch",
          protectedPaths: [`${root}/keys`],
        }),
      Error,
      "The scratch directory must be an absolute path",
    );
    // Positive control: the same call with an absolute scratch directory succeeds.
    const args = buildBabysitterSandboxArgs({
      dir: `${root}/clone`,
      scratch: `${root}/scratch`,
      protectedPaths: [`${root}/keys`],
    });
    assertEquals(args[0], "-c");
  });
});

Deno.test("buildBabysitterSandboxArgs refuses a non-absolute protected path", async () => {
  await withTempDirs(([root]) => {
    assertThrows(
      () =>
        buildBabysitterSandboxArgs({
          dir: `${root}/clone`,
          scratch: `${root}/scratch`,
          protectedPaths: ["keys/app.pem"],
        }),
      Error,
      "A protected path must be an absolute path",
    );
    // Positive control: the same call with an absolute protected path succeeds.
    const args = buildBabysitterSandboxArgs({
      dir: `${root}/clone`,
      scratch: `${root}/scratch`,
      protectedPaths: [`${root}/keys/app.pem`],
    });
    assertEquals(args[0], "-c");
  });
});

Deno.test("path validation rejects an absolute path containing a NUL byte", async () => {
  await withTempDirs(async ([home, elsewhere]) => {
    await assertRejects(
      () => babysitterProtectedPaths(home, `${elsewhere}/key\0.pem`, []),
      Error,
      "must be an absolute path",
    );
    // Positive control: the same path without the NUL byte is accepted.
    assertEquals(
      await babysitterProtectedPaths(home, `${elsewhere}/key.pem`, []),
      [`${elsewhere}/key.pem`],
    );
  });
});

Deno.test("Codex version floor fails closed on old or unrecognised versions", () => {
  for (
    const version of [
      "codex-cli 0.110.0",
      "codex-cli 0.163.99",
      "codex-cli 0.164.0-beta.1",
      "codex-cli 0.163.0-alpha.1",
      "codex-cli 0.166.0-",
      "unknown",
    ]
  ) {
    assertEquals(codexVersionMeetsFloor(version), false, version);
  }
  for (
    const version of [
      "codex-cli 0.164.0",
      "codex-cli 0.165.0",
      "codex-cli 1.0.0",
      "codex-cli 0.166.0-alpha.5.1",
      "codex-cli 0.164.1-beta.1",
    ]
  ) {
    assertEquals(codexVersionMeetsFloor(version), true, version);
  }
});
