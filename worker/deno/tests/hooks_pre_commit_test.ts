/**
 * Tests for the `hooks/pre-commit` git hook (Issue #3660).
 *
 * The hook is the local-commit gate installed by `setup.sh`; it catches
 * secret-bearing files that were force-added past `.gitignore`, including
 * the direct-push case the PR-only gitleaks workflow never sees.
 *
 * Each test runs the real hook script against a throwaway git repo and
 * asserts on its exit code and output — no source-text inspection.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const HOOK_PATH =
  new URL("../../../hooks/pre-commit", import.meta.url).pathname;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function runGit(args: string[], cwd: string): Promise<number> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: GIT_ENV,
  }).output();
  return out.code;
}

async function makeRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "hook_pre_commit_" });
  await runGit(["init", "-q", "-b", "main"], dir);
  await runGit(["config", "commit.gpgsign", "false"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await runGit(["config", "user.name", "test"], dir);
  return dir;
}

async function stage(dir: string, path: string): Promise<void> {
  const full = `${dir}/${path}`;
  const slash = full.lastIndexOf("/");
  if (slash > -1) await Deno.mkdir(full.slice(0, slash), { recursive: true });
  await Deno.writeTextFile(full, "x\n");
  // -f so a repo .gitignore cannot mask what the hook is meant to catch.
  await runGit(["add", "-f", "--", path], dir);
}

interface HookRun {
  code: number;
  stdout: string;
}

async function runHook(dir: string): Promise<HookRun> {
  const out = await new Deno.Command("bash", {
    args: [HOOK_PATH],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
    env: GIT_ENV,
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
  };
}

/** Run the hook over one staged path in a fresh repo, then clean up. */
async function hookVerdict(path: string): Promise<HookRun> {
  const dir = await makeRepo();
  try {
    await stage(dir, path);
    return await runHook(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const windows = Deno.build.os === "windows";

Deno.test({
  name: "pre-commit hook - blocks staged private key material (Issue #3660)",
  ignore: windows,
  fn: async () => {
    for (
      const path of [
        "github-app.pem",
        "certs/server.pem",
        "private.key",
        "cert.p12",
        "cert.pfx",
        "id_rsa",
        "id_rsa.pub",
        "credentials.json",
        "service-account-prod.json",
      ]
    ) {
      const run = await hookVerdict(path);
      assertEquals(run.code, 1, `expected hook to block '${path}'`);
      assertStringIncludes(run.stdout, path);
    }
  },
});

Deno.test({
  name: "pre-commit hook - still blocks .config.json and *.secret.json",
  ignore: windows,
  fn: async () => {
    for (const path of [".config.json", "api.secret.json"]) {
      const run = await hookVerdict(path);
      assertEquals(run.code, 1, `expected hook to block '${path}'`);
    }
  },
});

Deno.test({
  name:
    "pre-commit hook - blocks force-added files under .secrets/ regardless of extension (Issue #3957)",
  ignore: windows,
  fn: async () => {
    for (
      const path of [
        ".secrets/gh_token.txt",
        ".secrets/token",
        ".secrets/nested/oauth",
        "worker/.secrets/token",
      ]
    ) {
      const run = await hookVerdict(path);
      assertEquals(run.code, 1, `expected hook to block '${path}'`);
      assertStringIncludes(run.stdout, path);
    }
  },
});

Deno.test({
  name:
    "pre-commit hook - allows extension-less files outside .secrets/ (Issue #3957)",
  ignore: windows,
  fn: async () => {
    for (
      const path of [
        "token",
        "docs/secrets-guide",
        "mysecrets/token",
        "src/secretsmanager.ts",
      ]
    ) {
      const run = await hookVerdict(path);
      assertEquals(
        run.code,
        0,
        `hook wrongly blocked '${path}': ${run.stdout}`,
      );
    }
  },
});

Deno.test({
  name: "pre-commit hook - allows ordinary source files",
  ignore: windows,
  fn: async () => {
    const dir = await makeRepo();
    try {
      await stage(dir, "src/keyboard.ts");
      await stage(dir, "docs/keys.md");
      await stage(dir, "package.json");
      await stage(dir, "src/id_rsa_helper.ts");
      const run = await runHook(dir);
      assertEquals(run.code, 0, `hook rejected safe files: ${run.stdout}`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "pre-commit hook - empty stage exits cleanly",
  ignore: windows,
  fn: async () => {
    const dir = await makeRepo();
    try {
      const run = await runHook(dir);
      assertEquals(run.code, 0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "pre-commit hook - script exists and is executable",
  ignore: windows,
  fn: async () => {
    const stat = await Deno.stat(HOOK_PATH);
    assert(stat.isFile);
    assert((stat.mode ?? 0) & 0o111, "hook must be executable");
  },
});
