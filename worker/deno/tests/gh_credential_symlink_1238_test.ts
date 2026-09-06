/**
 * gh credential staging symlink-follow regression tests (Issue #1238).
 *
 * The staged `hosts.yml` — a live GitHub token — was written with a bare
 * `Deno.writeFileSync` (O_CREAT|O_TRUNC, umask mode, follows a symlink) into a
 * directory that was only tightened to 0700 *after* the credential had landed.
 * The staging candidates include the agents' scratch space and `TMPDIR`, so a
 * co-located account could:
 *
 *   1. plant a symlink at `${TMPDIR}/vibe-gh-config/hosts.yml` and have the
 *      token written straight through it to a path of its choosing; and
 *   2. read the token at 0644 from a directory it had pre-created, for the
 *      window between the write and the chmod.
 *
 * The write probe had the same defect at lower stakes: a fixed
 * `.vibe-write-probe` name that followed a link and truncated its target.
 *
 * These tests drive the real functions against a real filesystem: they fail
 * against the unfixed code and pass after the fix.
 *
 * Australian English spelling throughout (behaviour, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CREDENTIAL_DIR_MODE,
  CREDENTIAL_FILE_MODE,
  type GhCredentialStageIo,
  isGhConfigDirUsable,
  mountedHostsPath,
  restageGhConfigDir,
} from "../lib/gh_credential_stage.ts";
import { GH_HOSTS_FILE } from "../lib/credential_preflight.ts";

const TOKEN = "github.com:\n    user: VibeCoderST\n    oauth_token: s3cret\n";

function envFrom(
  values: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => values[name];
}

/** A home with the read-only mount populated, under a throwaway root. */
async function seedMount(root: string): Promise<string> {
  const home = `${root}/home`;
  const mount = mountedHostsPath(home);
  await Deno.mkdir(mount.slice(0, mount.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(mount, TOKEN);
  return home;
}

/** Permission bits of a path, without following a link at it. */
async function modeOf(path: string): Promise<number> {
  const info = await Deno.lstat(path);
  return (info.mode ?? 0) & 0o777;
}

// ---------------------------------------------------------------------------
// The credential write itself
// ---------------------------------------------------------------------------

Deno.test("restageGhConfigDir - a symlink planted at hosts.yml is replaced, never followed", async () => {
  const root = await Deno.makeTempDir();
  try {
    const home = await seedMount(root);
    const staging = `${root}/state/gh-config`;
    await Deno.mkdir(staging, { recursive: true });
    const victim = `${root}/victim.txt`;
    await Deno.writeTextFile(victim, "untouched\n");
    await Deno.symlink(victim, `${staging}/${GH_HOSTS_FILE}`);

    const staged = restageGhConfigDir({
      home,
      env: envFrom({ VIBE_STATE_DIR: `${root}/state`, TMPDIR: `${root}/tmp` }),
      warn: () => {},
    });

    assertEquals(staged, staging);
    // The token did not travel down the link.
    assertEquals(await Deno.readTextFile(victim), "untouched\n");
    const info = await Deno.lstat(`${staging}/${GH_HOSTS_FILE}`);
    assert(!info.isSymlink, "the planted link survived the staging write");
    assertEquals(await Deno.readTextFile(`${staging}/${GH_HOSTS_FILE}`), TOKEN);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("restageGhConfigDir - the credential is never readable at the umask's mode", async () => {
  const root = await Deno.makeTempDir();
  try {
    const home = await seedMount(root);
    const staging = `${root}/state/gh-config`;
    // The attacker's shape: the staging directory already exists, world
    // readable, so mkdir accepts it silently.
    await Deno.mkdir(staging, { recursive: true });
    await Deno.chmod(staging, 0o755);

    const staged = restageGhConfigDir({
      home,
      env: envFrom({ VIBE_STATE_DIR: `${root}/state`, TMPDIR: `${root}/tmp` }),
      warn: () => {},
    });

    assertEquals(staged, staging);
    assertEquals(await modeOf(staging), CREDENTIAL_DIR_MODE);
    assertEquals(
      await modeOf(`${staging}/${GH_HOSTS_FILE}`),
      CREDENTIAL_FILE_MODE,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("restageGhConfigDir - the directory is tightened before the token is written", async () => {
  // The order is the security property: a chmod after the write leaves the
  // credential readable for the width of the write, so it is asserted here
  // rather than inferred from the end state, which both orders share.
  const home = "/home/vibe";
  const mount = mountedHostsPath(home);
  const files: Record<string, string> = { [mount]: TOKEN };
  const calls: string[] = [];
  const encoder = new TextEncoder();
  const io: GhCredentialStageIo = {
    readFile: (path) => path in files ? encoder.encode(files[path]!) : null,
    writeFile: (path, data) => {
      calls.push(`write ${path}`);
      files[path] = new TextDecoder().decode(data);
    },
    mkdir: (path) => calls.push(`mkdir ${path}`),
    chmod: (path, mode) => calls.push(`chmod ${path} ${mode.toString(8)}`),
    isWritableDir: () => true,
  };

  const staged = restageGhConfigDir({
    home,
    env: envFrom({ VIBE_STATE_DIR: "/state" }),
    io,
    warn: () => {},
  });

  assertEquals(staged, "/state/gh-config");
  const tightened = calls.indexOf("chmod /state/gh-config 700");
  const written = calls.indexOf("write /state/gh-config/hosts.yml");
  assert(tightened >= 0, `the staging directory was never tightened: ${calls}`);
  assert(
    tightened < written,
    `the credential was written before the directory was tightened: ${calls}`,
  );
});

Deno.test("restageGhConfigDir - a refused candidate is reported, not swallowed", () => {
  // The chmod refusal a staging directory owned by another account produces:
  // the candidate must fail loudly and the next one serve.
  const home = "/home/vibe";
  const hostile = "/state/gh-config";
  const encoder = new TextEncoder();
  const files: Record<string, string> = { [mountedHostsPath(home)]: TOKEN };
  const io: GhCredentialStageIo = {
    readFile: (path) => path in files ? encoder.encode(files[path]!) : null,
    writeFile: (path, data) => {
      files[path] = new TextDecoder().decode(data);
    },
    mkdir: () => {},
    chmod: (path) => {
      if (path === hostile) throw new Error("Operation not permitted (os)");
    },
    isWritableDir: () => true,
  };
  const warnings: string[] = [];

  const staged = restageGhConfigDir({
    home,
    env: envFrom({ VIBE_STATE_DIR: "/state", TMPDIR: "/tmp" }),
    io,
    warn: (message) => warnings.push(message),
  });

  assertEquals(staged, "/tmp/vibe-gh-config");
  const refusal = warnings.find((w) => w.includes("cannot stage"));
  assert(refusal !== undefined, `the refusal was swallowed: ${warnings}`);
  assertStringIncludes(refusal, hostile);
  assertStringIncludes(refusal, "Operation not permitted");
  // Nothing was written into the directory the worker could not lock down.
  assertEquals(`${hostile}/${GH_HOSTS_FILE}` in files, false);
});

// ---------------------------------------------------------------------------
// The write probe
// ---------------------------------------------------------------------------

Deno.test("isGhConfigDirUsable - the write probe does not truncate a planted target", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = `${root}/gh-config`;
    await Deno.mkdir(dir);
    await Deno.writeTextFile(`${dir}/${GH_HOSTS_FILE}`, TOKEN);
    const victim = `${root}/victim.txt`;
    await Deno.writeTextFile(victim, "untouched\n");
    // The pre-#1238 probe name, which was fixed and therefore predictable.
    await Deno.symlink(victim, `${dir}/.vibe-write-probe`);

    assertEquals(isGhConfigDirUsable(dir), true);
    assertEquals(await Deno.readTextFile(victim), "untouched\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
