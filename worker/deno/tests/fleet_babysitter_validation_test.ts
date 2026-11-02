import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  babysitterValidationEnv,
  BabysitterValidationError,
  buildBabysitterValidationProfile,
  runBabysitterValidation,
} from "../lib/fleet_babysitter_validation.ts";
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
  const dir = await Deno.makeTempDir();
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
      validate: async () => {
        runnerCalls++;
        assertEquals(await git(dir, "rev-parse", "HEAD"), initialHead);
        assert((await git(dir, "status", "--porcelain")).includes("file.txt"));
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

Deno.test("runner check failure prevents the repair commit", async () => {
  const dir = await Deno.makeTempDir();
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
          validate: () => Promise.reject(new Error("browser assertion failed")),
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

Deno.test("runner reports missing host sandbox capability explicitly", async () => {
  const dir = await Deno.makeTempDir();
  const scratch = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/quality.sh`, "#!/bin/bash\nexit 0\n");
    const error = await assertRejects(
      () =>
        runBabysitterValidation(dir, scratch, "", scratch, {
          platform: "linux",
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
  const dir = await Deno.makeTempDir();
  const scratch = await Deno.makeTempDir();
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

Deno.test("runner skips when a target repository has no local gate", async () => {
  const dir = await Deno.makeTempDir();
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

Deno.test("successful runner check uses an isolated sandbox and environment", async () => {
  const dir = await Deno.makeTempDir();
  const scratch = await Deno.makeTempDir();
  const home = await Deno.makeTempDir();
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
          assertEquals(args.slice(-2), ["/bin/bash", "./quality.sh"]);
          assertEquals(options.cwd, dir);
          assertEquals(options.env.HOME, scratch);
          assertEquals(options.env.TMPDIR, scratch);
          assertEquals(options.env.GH_TOKEN, undefined);
          assertEquals(options.env.GITHUB_APP_PRIVATE_KEY, undefined);
          const profile = await Deno.readTextFile(args[1]!);
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

Deno.test("runner failure includes bounded actionable gate output", async () => {
  const dir = await Deno.makeTempDir();
  const scratch = await Deno.makeTempDir();
  const home = await Deno.makeTempDir();
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
            run: async (_binary, _args, options) => {
              assertEquals(options.cwd, dir);
              return {
                success: false,
                code: 1,
                stdout: `${
                  "x".repeat(25_000)
                }\nbrowser assertion failed: element was outside viewport`,
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
  assertStringIncludes(profile, "(allow mach-lookup)");
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

Deno.test({
  name: "macOS sandbox denies a credential read during runner validation",
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const root = await Deno.makeTempDir();
    try {
      const secret = `${root}/credential`;
      const profilePath = `${root}/sandbox.sb`;
      await Deno.writeTextFile(secret, "must not be readable\n");
      const profile = buildBabysitterValidationProfile(
        root,
        root,
        [secret],
      );
      await Deno.writeTextFile(profilePath, profile, { mode: 0o600 });
      const result = await new Deno.Command("/usr/bin/sandbox-exec", {
        args: ["-f", profilePath, "/bin/cat", secret],
        stdout: "null",
        stderr: "piped",
      }).output();
      assert(!result.success, "sandbox unexpectedly allowed credential read");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
