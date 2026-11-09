import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  babysitterHostCredentialPaths,
  babysitterProtectedPaths,
} from "../lib/fleet_babysitter_paths.ts";
import { emptyEnv } from "./support/env_lookup.ts";

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
    // The configured spelling and its canonical form are both in the list, so
    // a deny built from either one covers the missing tail.
    assert(protectedPaths.includes(configured));
    assert(protectedPaths.includes(canonical));
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

    // Both the literal path and its resolved form: on macOS the temp
    // directory sits under the /var -> /private/var symlink.
    const resolved = `${await Deno.realPath(elsewhere)}/absent-key.pem`;
    assertEquals(
      [...result].sort(),
      [...new Set([resolved, keyPath])].sort(),
    );
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

Deno.test("path validation rejects an absolute path containing a NUL byte", async () => {
  await withTempDirs(async ([home, elsewhere]) => {
    await assertRejects(
      () => babysitterProtectedPaths(home, `${elsewhere}/key\0.pem`, []),
      Error,
      "must be an absolute path",
    );
    // Positive control: the same path without the NUL byte is accepted.
    const resolved = `${await Deno.realPath(elsewhere)}/key.pem`;
    assertEquals(
      [...await babysitterProtectedPaths(home, `${elsewhere}/key.pem`, [])]
        .sort(),
      [...new Set([resolved, `${elsewhere}/key.pem`])].sort(),
    );
  });
});
