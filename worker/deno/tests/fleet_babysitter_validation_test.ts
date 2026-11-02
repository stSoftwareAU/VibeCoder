import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  babysitterValidationEnv,
  BabysitterValidationError,
  buildBabysitterValidationProfile,
  checkBabysitterValidationCapability,
  runBabysitterValidation,
  runIsolatedCommand,
  validateWithSingleRepair,
} from "../lib/fleet_babysitter_validation.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import childProcess from "node:child_process";
import { validateAndCommit } from "../commands/fleet_pr_babysitter.ts";

async function git(dir: string, ...args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args,
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

Deno.test("babysitter validation hands browser gate work to the runner before commit", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await git(dir, "init", "-q");
    await git(dir, "config", "user.name", "Test");
    await git(dir, "config", "user.email", "test@example.invalid");
    await Deno.writeTextFile(`${dir}/file.txt`, "before\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-m", "initial");
    const initialHead = await git(dir, "rev-parse", "HEAD");
    await Deno.writeTextFile(`${dir}/file.txt`, "after\n");
    let runnerCalls = 0;
    await validateAndCommit(dir, 4674, { login: "bot[bot]", id: "123" }, {
      scratch: `${dir}/scratch`,
      configPath: `${dir}/config.json`,
      home: `${dir}/host-home`,
      privateKeyPath: `${dir}/custom-app.pem`,
      runValidation: async (repoDir, scratch, configPath, home, options) => {
        runnerCalls++;
        await Deno.writeTextFile(
          `${dir}/.git/hooks/pre-commit`,
          "#!/bin/sh\nexit 99\n",
          { mode: 0o755 },
        );
        assertEquals(repoDir, dir);
        assertEquals(scratch, `${dir}/scratch`);
        assertEquals(configPath, `${dir}/config.json`);
        assertEquals(home, `${dir}/host-home`);
        assertEquals(options?.privateKeyPath, `${dir}/custom-app.pem`);
        assertEquals(await git(dir, "rev-parse", "HEAD"), initialHead);
        assert((await git(dir, "status", "--porcelain")).includes("file.txt"));
        return { kind: "passed", command: "./quality.sh" };
      },
    });
    assertEquals(runnerCalls, 1);
    assertEquals(await git(dir, "status", "--porcelain"), "");
    assertEquals(
      await git(dir, "show", "-s", "--format=%s", "HEAD"),
      "Fix PR #4674 quality issues",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a repaired runner gate passes revalidation before the repair commit", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await git(dir, "init", "-q");
    await git(dir, "config", "user.name", "Test");
    await git(dir, "config", "user.email", "test@example.invalid");
    await Deno.writeTextFile(`${dir}/file.txt`, "before\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-m", "initial");
    const initialHead = await git(dir, "rev-parse", "HEAD");
    await Deno.writeTextFile(`${dir}/file.txt`, "after\n");
    let validations = 0;
    let repairs = 0;
    await validateWithSingleRepair({
      validate: () =>
        validateAndCommit(dir, 4674, { login: "bot[bot]", id: "123" }, {
          home: dir,
          runValidation: async () => {
            validations++;
            if (validations === 1) {
              throw new BabysitterValidationError(
                "browser check failed",
                "failed",
              );
            }
            return { kind: "passed", command: "./quality.sh" };
          },
        }),
      repair: async () => {
        repairs++;
        assertEquals(await git(dir, "rev-parse", "HEAD"), initialHead);
        assert((await git(dir, "status", "--porcelain")).includes("file.txt"));
        assertEquals(await git(dir, "diff", "--cached", "--name-only"), "");
      },
    });
    assertEquals(validations, 2);
    assertEquals(repairs, 1);
    assertEquals(await git(dir, "status", "--porcelain"), "");
    assertEquals(
      await git(dir, "show", "-s", "--format=%s", "HEAD"),
      "Fix PR #4674 quality issues",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runner check failure prevents the repair commit", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await git(dir, "init", "-q");
    await git(dir, "config", "user.name", "Test");
    await git(dir, "config", "user.email", "test@example.invalid");
    await Deno.writeTextFile(`${dir}/file.txt`, "before\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-m", "initial");
    const initialHead = await git(dir, "rev-parse", "HEAD");
    await Deno.writeTextFile(`${dir}/file.txt`, "after\n");
    await assertRejects(
      () =>
        validateAndCommit(dir, 4674, { login: "bot[bot]", id: "123" }, {
          home: dir,
          runValidation: () =>
            Promise.reject(new Error("browser assertion failed")),
        }),
      Error,
      "browser assertion failed",
    );
    assertEquals(await git(dir, "rev-parse", "HEAD"), initialHead);
    assertEquals(
      (await git(dir, "status", "--porcelain")).includes("file.txt"),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runner reports unsupported host sandbox capability explicitly", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const scratch = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/bash\nexit 0\n");
    const error = await assertRejects(
      () =>
        runBabysitterValidation(dir, scratch, "", scratch, {
          platform: "windows",
          sandboxExec: null,
        }),
      BabysitterValidationError,
      "Runner validation unavailable",
    );
    assertEquals(error.kind, "unavailable");
    assertStringIncludes(error.message, "macOS sandbox is required");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
  }
});

Deno.test("missing sandbox-exec is an unavailable capability", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const scratch = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/bash\n");
    const error = await assertRejects(
      () =>
        runBabysitterValidation(dir, scratch, "", scratch, {
          platform: "darwin",
          sandboxExec: null,
        }),
      BabysitterValidationError,
      "sandbox-exec was not found",
    );
    assertEquals(error.kind, "unavailable");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
  }
});

Deno.test("runner reports sandbox process spawn failure as unavailable", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const scratch = await Deno.realPath(await Deno.makeTempDir());
  const home = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/bash\n");
    const error = await assertRejects(
      () =>
        runBabysitterValidation(
          dir,
          scratch,
          `${home}/config.json`,
          home,
          {
            platform: "darwin",
            sandboxExec: "/usr/bin/sandbox-exec",
            run: async () =>
              Promise.reject(new Error("operation not permitted")),
          },
        ),
      BabysitterValidationError,
      "could not start sandbox-exec",
    );
    assertEquals(error.kind, "unavailable");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("runner skips when a target repository has no local gate", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    const result = await runBabysitterValidation(dir, dir, "", dir, {
      platform: "darwin",
      sandboxExec: "/usr/bin/sandbox-exec",
    });
    assertEquals(result, {
      kind: "not-applicable",
      command: "./quality.sh (not present)",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runner drains long command streams while retaining only bounded output", async () => {
  const result = await runIsolatedCommand(Deno.execPath(), [
    "eval",
    `Deno.stdout.writeSync(new TextEncoder().encode("x".repeat(25_000)))`,
  ], { cwd: Deno.cwd(), env: {}, timeoutMs: 2000, signal: () => {} });
  assertEquals(result.success, true);
  const output = result.stdout;
  assertEquals(output.length, 20_000);
  assertEquals(output, "x".repeat(20_000));
});

Deno.test("runner reports a missing gate as an empty-gate error", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const scratch = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(`${dir}/quality.sh`, " \n\t");
    await assertRejects(
      () =>
        runBabysitterValidation(dir, scratch, "", scratch, {
          platform: "darwin",
        }),
      Error,
      "empty quality.sh",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
  }
});

Deno.test("successful runner check uses an isolated sandbox and environment", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const scratch = await Deno.realPath(await Deno.makeTempDir());
  const home = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/bash\n");
    const configPath = `${home}/worker-config.json`;
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({ gh_config_dir: `${home}/custom-gh` }),
    );
    let called = false;
    const result = await runBabysitterValidation(
      dir,
      scratch,
      configPath,
      home,
      {
        platform: "darwin",
        sandboxExec: "/usr/bin/sandbox-exec",
        env: {
          PATH: "/usr/bin",
          HOME: home,
          GH_TOKEN: "write-token",
          GITHUB_APP_PRIVATE_KEY: "private-key",
        },
        run: async (binary, args, options) => {
          called = true;
          assertEquals(binary, "/usr/bin/sandbox-exec");
          assertEquals(
            args.slice(2),
            args[2] === "/usr/bin/true"
              ? ["/usr/bin/true"]
              : ["/bin/bash", "./quality.sh"],
          );
          // Unset caches default inside the gate's write grant (scratch).
          for (
            const name of [
              "PLAYWRIGHT_BROWSERS_PATH",
              "CYPRESS_CACHE_FOLDER",
              "PUPPETEER_CACHE_DIR",
            ]
          ) {
            assert(options.env[name]!.startsWith(`${scratch}/`), name);
          }
          assertEquals(options.cwd, await Deno.realPath(dir));
          assertEquals(options.env.HOME, scratch);
          assertEquals(options.env.TMPDIR, scratch);
          assertEquals(options.env.DENO_DIR, `${scratch}/deno`);
          assertEquals(options.env.GH_TOKEN, undefined);
          assertEquals(options.env.GITHUB_APP_PRIVATE_KEY, undefined);
          const profile = await Deno.readTextFile(args[1]!);
          assertStringIncludes(
            profile,
            `(deny file-read* (subpath "${configPath}"))`,
          );
          assertStringIncludes(
            profile,
            `(deny file-read* (subpath "${home}/custom-gh"))`,
          );
          assertStringIncludes(
            profile,
            `(deny file-read* (subpath "${home}/Library/Keychains"))`,
          );
          assertStringIncludes(
            profile,
            `(deny file-read* (subpath "${home}/.ssh"))`,
          );
          assertStringIncludes(
            profile,
            `(deny file-read* (subpath "${home}/.aws"))`,
          );
          assertStringIncludes(
            profile,
            `(deny file-read* (subpath "${home}/.config/gcloud"))`,
          );
          assertStringIncludes(
            profile,
            '(deny mach-lookup (global-name "com.apple.securityd"))',
          );
          return { success: true, code: 0, stdout: "", stderr: "" };
        },
      },
    );
    assert(called);
    assertEquals(result.kind, "passed");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("runner policy cannot overwrite credentials through agent scratch", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const dir = `${root}/repo`;
  const scratch = `${root}/scratch`;
  const home = `${root}/home`;
  let profilePath = "";
  try {
    for (const path of [dir, scratch, home]) await Deno.mkdir(path);
    const configPath = `${home}/config.json`;
    await Deno.writeTextFile(configPath, "{}");
    const credential = `${home}/private-key.pem`;
    await Deno.writeTextFile(credential, "private key must remain unchanged");
    await Deno.symlink(credential, `${scratch}/runner-validation.sb`);
    await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/bash\nexit 0\n");
    await runBabysitterValidation(dir, scratch, configPath, home, {
      platform: "darwin",
      env: {},
      run: async (_binary, args) => {
        profilePath = args[1]!;
        assert(!profilePath.startsWith(`${scratch}/`));
        assert(!profilePath.startsWith(`${dir}/`));
        assert((await Deno.stat(profilePath)).isFile);
        assertEquals(
          await Deno.readTextFile(credential),
          "private key must remain unchanged",
        );
        return { success: true, code: 0, stdout: "", stderr: "" };
      },
    });
    assert(profilePath);
    await assertRejects(() => Deno.stat(profilePath), Deno.errors.NotFound);
    assertEquals(
      await Deno.readTextFile(credential),
      "private key must remain unchanged",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runner protects the selected babysitter App key and its symlink target", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const dir = `${root}/repo`;
  const scratch = `${root}/scratch`;
  const home = `${root}/home`;
  try {
    for (const path of [dir, scratch, home]) await Deno.mkdir(path);
    await Deno.writeTextFile(`${home}/config.json`, "{}");
    const actualKey = `${root}/custom-app-key.pem`;
    const selectedKey = `${root}/selected-app-key.pem`;
    await Deno.writeTextFile(actualKey, "private-key");
    await Deno.symlink(actualKey, selectedKey);
    await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/bash\nexit 0\n");
    let checked = false;
    await runBabysitterValidation(dir, scratch, `${home}/config.json`, home, {
      platform: "darwin",
      privateKeyPath: selectedKey,
      env: {},
      run: async (_binary, args) => {
        checked = true;
        const profile = await Deno.readTextFile(args[1]!);
        for (const key of [selectedKey, actualKey]) {
          assertStringIncludes(
            profile,
            `(deny file-read* (subpath ${JSON.stringify(key)}))`,
          );
          assertStringIncludes(
            profile,
            `(deny file-write* (subpath ${JSON.stringify(key)}))`,
          );
        }
        return { success: true, code: 0, stdout: "", stderr: "" };
      },
    });
    assert(checked);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runner failure includes bounded actionable gate output", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const scratch = await Deno.realPath(await Deno.makeTempDir());
  const home = await Deno.realPath(await Deno.makeTempDir());
  const fakeToken = ["ghp_", "A".repeat(36)].join("");
  try {
    await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/bash\n");
    await Deno.writeTextFile(`${home}/worker-config.json`, "{}");
    const error = await assertRejects(
      () =>
        runBabysitterValidation(
          dir,
          scratch,
          `${home}/worker-config.json`,
          home,
          {
            platform: "darwin",
            sandboxExec: "/usr/bin/sandbox-exec",
            run: async (_binary, args, options) => {
              if (args[2] === "/usr/bin/true") {
                return { success: true, code: 0, stdout: "", stderr: "" };
              }
              assertEquals(options.cwd, dir);
              return {
                success: false,
                code: 1,
                stdout: `${
                  "x".repeat(25_000)
                }\nbrowser assertion failed: element was outside viewport\nGH_TOKEN=${fakeToken}`,
                stderr: "",
              };
            },
          },
        ),
      BabysitterValidationError,
      "Runner validation failed (exit 1)",
    );
    assertEquals(error.kind, "failed");
    assertStringIncludes(error.message, "element was outside viewport");
    assert(error.message.length < 22_000, "runner output was not bounded");
    assert(
      !error.message.includes(fakeToken),
      "runner validation leaked a credential",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("runner sandbox and environment deny runner credentials", async () => {
  const env = babysitterValidationEnv({
    PATH: "/usr/bin",
    HOME: "/home/test",
    DENO_DIR: "/home/test/.cache/deno-with-auth",
    GH_TOKEN: "write-token",
    GITHUB_TOKEN: "app-token",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    VIBE_CREDENTIAL_DIR: "/home/test/.vibe-coder/credentials",
  });
  assertEquals(env, { PATH: "/usr/bin", HOME: "/home/test" });
  const profile = buildBabysitterValidationProfile(
    "/tmp/clone",
    "/tmp/scratch",
    ["/home/test/.config/gh", "/home/test/.vibe-coder/private-key.pem"],
  );
  assertStringIncludes(
    profile,
    '(deny file-read* (subpath "/home/test/.config/gh"))',
  );
  assertStringIncludes(
    profile,
    '(deny file-write* (subpath "/home/test/.config/gh"))',
  );
  assertStringIncludes(
    profile,
    '(deny file-read* (subpath "/home/test/.vibe-coder/private-key.pem"))',
  );
  assertStringIncludes(
    profile,
    '(allow mach-lookup (global-name "com.apple.system.logger"))',
  );
  assert(!profile.includes("(allow mach-lookup)"));
  assertEquals(
    profile.split("\n").filter((rule) =>
      rule.startsWith("(allow mach-register")
    ),
    [
      '(allow mach-register (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))',
      '(allow mach-register (global-name-prefix "com.google.Chrome.MachPortRendezvousServer."))',
      '(allow mach-register (global-name-prefix "com.google.chrome.for.testing.MachPortRendezvousServer."))',
      '(allow mach-register (global-name-prefix "org.chromium.crashpad."))',
    ],
  );
  assertStringIncludes(
    profile,
    '(deny mach-lookup (global-name "com.apple.securityd"))',
  );
  assertStringIncludes(profile, '(allow file-write* (subpath "/tmp/clone"))');
  assertStringIncludes(
    profile,
    '(deny file-write* (subpath "/tmp/clone/.git"))',
  );
});

Deno.test("runner sandbox rejects invalid or overlapping protected paths", () => {
  assertThrows(
    () =>
      buildBabysitterValidationProfile("relative/clone", "/tmp/scratch", []),
    Error,
    "absolute",
  );
  assertThrows(
    () =>
      buildBabysitterValidationProfile(
        "/tmp/credentials/clone",
        "/tmp/scratch",
        ["/tmp/credentials"],
      ),
    Error,
    "overlaps protected path",
  );
  assertThrows(
    () =>
      buildBabysitterValidationProfile(
        "/tmp/clone",
        "/tmp/scratch",
        ["/tmp/key\0file"],
      ),
    Error,
    "NUL",
  );
});

Deno.test("runner retries one failed gate after a ready repair and validates again", async () => {
  let validations = 0;
  let repairs = 0;
  const result = await validateWithSingleRepair({
    validate: async () => {
      validations++;
      if (validations === 1) {
        throw new BabysitterValidationError("browser check failed", "failed");
      }
      return "committed";
    },
    repair: async (failure) => {
      repairs++;
      assertEquals(failure.message, "browser check failed");
    },
  });
  assertEquals(result, "committed");
  assertEquals(validations, 2);
  assertEquals(repairs, 1);
});

Deno.test("runner does not repair an unavailable validation capability", async () => {
  let repairs = 0;
  const error = await assertRejects(
    () =>
      validateWithSingleRepair({
        validate: async () => {
          throw new BabysitterValidationError(
            "sandbox unavailable",
            "unavailable",
          );
        },
        repair: async () => {
          repairs++;
        },
      }),
    BabysitterValidationError,
    "sandbox unavailable",
  );
  assertEquals(error.kind, "unavailable");
  assertEquals(repairs, 0);
});

Deno.test("runner does not retry an unrelated error with a failed kind", async () => {
  const unrelated = Object.assign(new Error("git commit failed"), {
    kind: "failed",
  });
  let validations = 0;
  let repairs = 0;
  const error = await assertRejects(
    () =>
      validateWithSingleRepair({
        validate: async () => {
          validations++;
          throw unrelated;
        },
        repair: async () => {
          repairs++;
        },
      }),
    Error,
    "git commit failed",
  );
  assertEquals(error, unrelated);
  assertEquals(validations, 1);
  assertEquals(repairs, 0);
});

Deno.test("runner stops after one repair when validation still fails", async () => {
  let validations = 0;
  let repairs = 0;
  await assertRejects(
    () =>
      validateWithSingleRepair({
        validate: async () => {
          validations++;
          throw new BabysitterValidationError(
            "browser check still fails",
            "failed",
          );
        },
        repair: async () => {
          repairs++;
        },
      }),
    BabysitterValidationError,
    "browser check still fails",
  );
  assertEquals(validations, 2);
  assertEquals(repairs, 1);
});

Deno.test("runner does not revalidate after lock loss or an agent HEAD change", async () => {
  for (
    const message of [
      "PR lock renewal failed; refusing to retry agent",
      "repair agent changed HEAD; refusing to commit",
    ]
  ) {
    let validations = 0;
    let repairs = 0;
    await assertRejects(
      () =>
        validateWithSingleRepair({
          validate: async () => {
            validations++;
            throw new BabysitterValidationError("gate failed", "failed");
          },
          repair: async () => {
            repairs++;
            throw new Error(message);
          },
        }),
      Error,
      message,
    );
    assertEquals(validations, 1);
    assertEquals(repairs, 1);
  }
});

for (const shape of ["symlink", "oversized", "directory", "fifo"]) {
  Deno.test(`runner refuses ${shape} quality.sh before launching a gate`, async () => {
    const root = await Deno.realPath(await Deno.makeTempDir());
    try {
      const dir = `${root}/repo`;
      const scratch = `${root}/scratch`;
      await Deno.mkdir(dir);
      await Deno.mkdir(scratch);
      const gate = `${dir}/quality.sh`;
      if (shape === "symlink") {
        await Deno.writeTextFile(`${root}/outside.sh`, "#!/bin/bash\nexit 0\n");
        await Deno.symlink(`${root}/outside.sh`, gate);
      } else if (shape === "oversized") {
        await Deno.writeTextFile(gate, "x".repeat(64 * 1024 + 1));
      } else if (shape === "directory") {
        await Deno.mkdir(gate);
      } else {
        const result = await new Deno.Command("mkfifo", { args: [gate] })
          .output();
        assert(result.success, "mkfifo fixture creation failed");
      }
      let launched = false;
      await assertRejects(
        () =>
          runBabysitterValidation(dir, scratch, `${root}/config.json`, root, {
            platform: "darwin",
            run: () => {
              launched = true;
              return Promise.resolve({
                success: true,
                code: 0,
                stdout: "",
                stderr: "",
              });
            },
          }),
        Error,
        shape === "oversized" ? "64 KiB limit" : "regular quality.sh",
      );
      assertEquals(launched, false);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test("runner canonicalises a symlinked temporary root", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    const actual = `${root}/actual`;
    await Deno.mkdir(actual);
    await Deno.symlink(actual, `${root}/alias`);
    for (const name of ["repo", "scratch", "home"]) {
      await Deno.mkdir(`${actual}/${name}`);
    }
    await Deno.writeTextFile(
      `${actual}/repo/quality.sh`,
      "#!/bin/bash\nexit 0\n",
    );
    let called = false;
    await runBabysitterValidation(
      `${root}/alias/repo`,
      `${root}/alias/scratch`,
      `${actual}/home/config.json`,
      `${actual}/home`,
      {
        platform: "darwin",
        run: (_binary, _args, options) => {
          called = true;
          assertEquals(options.cwd, `${actual}/repo`);
          assertEquals(options.env.HOME, `${actual}/scratch`);
          return Promise.resolve({
            success: true,
            code: 0,
            stdout: "",
            stderr: "",
          });
        },
      },
    );
    assert(called);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validation denials follow every overlapping allow", () => {
  const profile = buildBabysitterValidationProfile("/clone", "/scratch", [
    "/secret",
  ]);
  assert(
    profile.indexOf(`(deny file-write* (subpath "/clone/.git"))`) >
      profile.lastIndexOf("(allow file-write*"),
  );
  assert(
    profile.indexOf(`(deny mach-lookup (global-name "com.apple.securityd"))`) >
      profile.lastIndexOf("(allow mach-lookup"),
  );
});

Deno.test("runner timeout signals the isolated group and destroys inherited pipes", async () => {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let unreferenced = false;
  Object.assign(child, {
    pid: 2147483647,
    stdout,
    stderr,
    unref: () => {
      unreferenced = true;
    },
  });
  const signals: unknown[] = [];
  const started = Date.now();
  const result = await runIsolatedCommand("/bin/bash", ["./quality.sh"], {
    cwd: Deno.cwd(),
    env: {},
    timeoutMs: 10,
    spawn: ((_executable, _args, options) => {
      assertEquals(options?.detached, true);
      queueMicrotask(() => stdout.write("descendant"));
      return child;
    }) as typeof childProcess.spawn,
    signal: (pid, signal) => {
      signals.push([pid, signal]);
    },
  });
  assert(Date.now() - started < 8000);
  assertEquals(signals, [[-2147483647, "SIGKILL"]]);
  assert(stdout.destroyed);
  assert(stderr.destroyed);
  assert(unreferenced);
  assertEquals(result.success, false);
  assertEquals(result.code, 124);
  assertStringIncludes(result.stdout, "descendant");
  assertStringIncludes(result.stderr, "timed out");
});

Deno.test("sandbox apply refusal is unavailable and never executes the gate", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    for (const name of ["repo", "scratch", "home"]) {
      await Deno.mkdir(`${root}/${name}`);
    }
    await Deno.writeTextFile(
      `${root}/repo/quality.sh`,
      "#!/bin/bash\nexit 0\n",
    );
    const calls: string[][] = [];
    const error = await assertRejects(
      () =>
        runBabysitterValidation(
          `${root}/repo`,
          `${root}/scratch`,
          `${root}/home/config.json`,
          `${root}/home`,
          {
            platform: "darwin",
            run: (_executable, args) => {
              calls.push(args.slice(2));
              return Promise.resolve({
                success: false,
                code: 71,
                stdout: "",
                stderr: "sandbox-exec: sandbox_apply: Operation not permitted",
              });
            },
          },
        ),
      BabysitterValidationError,
      "sandbox_apply: Operation not permitted",
    );
    assertEquals(error.kind, "unavailable");
    assertEquals(calls, [["/usr/bin/true"]]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validation only grants named Mach services", () => {
  const profile = buildBabysitterValidationProfile("/clone", "/scratch", []);
  const lookups = profile.split("\n").filter((line) =>
    line.startsWith("(allow mach-lookup")
  );
  assert(lookups.length > 0);
  // Named services or the browser's own rendezvous prefixes, never a blanket.
  for (const line of lookups) {
    assert(
      line.startsWith('(allow mach-lookup (global-name "') ||
        line.startsWith('(allow mach-lookup (global-name-prefix "'),
    );
  }
  for (
    const prefix of [
      "org.chromium.Chromium.MachPortRendezvousServer.",
      "com.google.Chrome.MachPortRendezvousServer.",
      "com.google.chrome.for.testing.MachPortRendezvousServer.",
      "org.chromium.crashpad.",
    ]
  ) {
    assert(
      lookups.includes(
        `(allow mach-lookup (global-name-prefix ${JSON.stringify(prefix)}))`,
      ),
      prefix,
    );
  }
  assert(!profile.includes('(global-name "com.apple.cfprefsd.agent")'));
});

Deno.test("browser cache overrides survive the environment allowlist", () => {
  const env = babysitterValidationEnv({
    PLAYWRIGHT_BROWSERS_PATH: "/installed/playwright",
    CYPRESS_CACHE_FOLDER: "/installed/cypress",
    PUPPETEER_CACHE_DIR: "/installed/puppeteer",
  });
  assertEquals(env, {
    PLAYWRIGHT_BROWSERS_PATH: "/installed/playwright",
    CYPRESS_CACHE_FOLDER: "/installed/cypress",
    PUPPETEER_CACHE_DIR: "/installed/puppeteer",
  });
});

Deno.test("default browser caches are writable scratch dirs linking the host's builds", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const scratch = await Deno.realPath(await Deno.makeTempDir());
  const home = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/bash\n");
    const playwright = `${home}/Library/Caches/ms-playwright`;
    const cypress = `${home}/Library/Caches/Cypress`;
    const puppeteer = `${home}/.cache/puppeteer`;
    await Deno.mkdir(`${playwright}/chromium-1`, { recursive: true });
    await Deno.mkdir(`${playwright}/.links`, { recursive: true });
    await Deno.mkdir(`${cypress}/13.0.0`, { recursive: true });
    await Deno.mkdir(`${puppeteer}/chrome/mac-1`, { recursive: true });
    const seen: Record<string, string>[] = [];
    await runBabysitterValidation(dir, scratch, `${home}/config.json`, home, {
      platform: "darwin",
      sandboxExec: "/usr/bin/sandbox-exec",
      env: { PATH: "/usr/bin", HOME: home },
      run: async (_binary, _args, options) => {
        const env = options.env;
        seen.push(env);
        // Writable (inside the grant) and resolving the host's installed builds.
        for (
          const [name, host, entry] of [
            ["PLAYWRIGHT_BROWSERS_PATH", playwright, "chromium-1"],
            ["CYPRESS_CACHE_FOLDER", cypress, "13.0.0"],
            ["PUPPETEER_CACHE_DIR", puppeteer, "chrome/mac-1"],
          ] as const
        ) {
          const cache = env[name]!;
          assert(cache.startsWith(`${scratch}/`), name);
          assertEquals(
            await Deno.realPath(`${cache}/${entry}`),
            await Deno.realPath(`${host}/${entry}`),
          );
          // An installer's own state is not mirrored; it can create its own.
          await Deno.writeTextFile(`${cache}/.lock`, "");
        }
        await assertRejects(() =>
          Deno.lstat(`${env.PLAYWRIGHT_BROWSERS_PATH}/.links`)
        );
        return { success: true, code: 0, stdout: "", stderr: "" };
      },
    });
    assertEquals(seen.length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("an operator browser cache value is left unchanged", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const scratch = await Deno.realPath(await Deno.makeTempDir());
  const home = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/bash\n");
    let playwright: string | undefined;
    await runBabysitterValidation(dir, scratch, `${home}/config.json`, home, {
      platform: "darwin",
      sandboxExec: "/usr/bin/sandbox-exec",
      env: {
        PATH: "/usr/bin",
        HOME: home,
        PLAYWRIGHT_BROWSERS_PATH: "/opt/operator-browsers",
      },
      run: (_binary, _args, options) => {
        playwright = options.env.PLAYWRIGHT_BROWSERS_PATH;
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "",
          stderr: "",
        });
      },
    });
    assertEquals(playwright, "/opt/operator-browsers");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("capability check runs the probe without running the gate", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  const scratch = await Deno.realPath(await Deno.makeTempDir());
  const home = await Deno.realPath(await Deno.makeTempDir());
  try {
    const commands: string[][] = [];
    const options = {
      platform: "darwin",
      sandboxExec: "/usr/bin/sandbox-exec",
      run: (_binary: string, args: string[]) => {
        commands.push(args.slice(2));
        return Promise.resolve({
          success: !args.includes("/usr/bin/true") || commands.length > 1,
          code: 71,
          stdout: `${home}/config.json`,
          stderr: "sandbox_apply: Operation not permitted",
        });
      },
    };
    // No quality.sh: nothing to run, so no probe.
    await checkBabysitterValidationCapability(
      dir,
      scratch,
      `${home}/config.json`,
      home,
      options,
    );
    assertEquals(commands, []);
    await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/bash\nexit 0\n");
    const error = await assertRejects(
      () =>
        checkBabysitterValidationCapability(
          dir,
          scratch,
          `${home}/config.json`,
          home,
          options,
        ),
      BabysitterValidationError,
      "sandbox_apply: Operation not permitted",
    );
    assertEquals(error.kind, "unavailable");
    assertEquals(commands, [["/usr/bin/true"]]);
    // A working probe passes, and still never runs quality.sh.
    commands.push([]);
    await checkBabysitterValidationCapability(
      dir,
      scratch,
      `${home}/config.json`,
      home,
      options,
    );
    assertEquals(commands.slice(2), [["/usr/bin/true"]]);
    // Linux validates in the agent; another host has no sandbox at all.
    await checkBabysitterValidationCapability(
      dir,
      scratch,
      `${home}/config.json`,
      home,
      {
        platform: "linux",
      },
    );
    const unsupported = await assertRejects(
      () =>
        checkBabysitterValidationCapability(
          dir,
          scratch,
          `${home}/config.json`,
          home,
          {
            platform: "windows",
          },
        ),
      BabysitterValidationError,
      "macOS sandbox is required",
    );
    assertEquals(unsupported.kind, "unavailable");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(scratch, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("validation permits signals only to processes in the same sandbox", () => {
  const profile = buildBabysitterValidationProfile(
    "/tmp/clone",
    "/tmp/scratch",
    [],
  );
  assertEquals(
    profile.split("\n").filter((rule) => rule.startsWith("(allow signal")),
    ["(allow signal (target same-sandbox))"],
  );
});

Deno.test("validation scopes process inspection and sysctls and permits gate resources", () => {
  const rules = buildBabysitterValidationProfile(
    "/tmp/clone",
    "/tmp/scratch",
    [],
  ).split("\n");
  assertEquals(rules.filter((rule) => rule.startsWith("(allow process")), [
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow process-info* (target same-sandbox))",
  ]);
  const sysctls = rules.filter((rule) => rule.startsWith("(allow sysctl-read"));
  for (
    const name of [
      "kern.hostname",
      "machdep.cpu.brand_string",
      "hw.model",
      "kern.argmax",
      "kern.sysv.semmns",
      "hw.machine",
      "hw.activecpu",
      "kern.osproductversion",
      "sysctl.proc_translated",
    ]
  ) {
    assert(
      sysctls.includes(`(allow sysctl-read (sysctl-name "${name}"))`),
      name,
    );
  }
  for (const rule of sysctls) {
    assertMatch(
      rule,
      /^\(allow sysctl-read \(sysctl-name "[a-zA-Z0-9_.]+"\)\)$/,
    );
  }
  for (
    const rule of [
      "(allow ipc-posix-sem*)",
      "(allow ipc-posix-shm*)",
      "(allow pseudo-tty)",
      '(allow file-read* file-write* file-ioctl (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))',
    ]
  ) assert(rules.includes(rule), rule);
});

for (const code of [0, 1]) {
  Deno.test(`runner stops descendants on gate exit ${code} before pipes close`, async () => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { pid: 2147483647, stdout, stderr, unref: () => {} });
    const signals: unknown[] = [];
    const result = await runIsolatedCommand("/bin/bash", ["./quality.sh"], {
      cwd: Deno.cwd(),
      env: {},
      timeoutMs: 2000,
      spawn: (() => {
        queueMicrotask(() => {
          stdout.write("gate output");
          child.emit("exit", code);
        });
        return child;
      }) as unknown as typeof childProcess.spawn,
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        queueMicrotask(() => child.emit("close", code));
      },
    });
    assertEquals(signals, [[-2147483647, "SIGKILL"]]);
    assertEquals(result.code, code);
    assertEquals(result.success, code === 0);
    assertEquals(result.stdout, "gate output");
  });
}
