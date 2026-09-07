/**
 * Tests for gh_credential_stage.ts — keeping the worker's writable `gh`
 * configuration alive for the length of a run (Issue #564).
 *
 * The failure being pinned: the staged copy was deleted fourteen minutes into
 * a run, every `gh` call and every `git push` failed from that moment, and the
 * run died with the intact credential still on its read-only mount. The
 * earlier fallback could not help because it copied from the directory it was
 * replacing.
 *
 * Australian English spelling throughout (behaviour, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  ensureUsableGhConfigDir,
  type GhCredentialStageIo,
  gitGlobalConfigEntries,
  isGhAuthMissingFailure,
  isGhConfigDirUsable,
  isGitAuthMissingFailure,
  mountedGitLogin,
  mountedHostsPath,
  removeStagedGhConfigDirs,
  restageGhConfigDir,
  STAGED_HOSTS_MODE,
  stagingCandidates,
  stagingDirRefusal,
} from "../lib/gh_credential_stage.ts";
import {
  cacheDirUserSuffix,
  PRIVATE_DIR_MODE,
} from "../lib/private_cache_dir.ts";

/** The uid the fake filesystem reports for everything the worker owns. */
const OWN_UID = 1000;

/**
 * An in-memory filesystem: paths to contents, plus a read-only path set.
 *
 * Records the mode every directory and file was **created** with, so a test
 * can assert the credential was never on disk at the umask default and only
 * chmod'd private afterwards (Issue #1282).
 */
function fakeIo(
  files: Record<string, string>,
  readOnlyDirs: string[] = [],
  existingDirs: string[] = [],
): GhCredentialStageIo & {
  files: Record<string, string>;
  modes: Record<string, number>;
  /** Directories owned by another local account, keyed by path to its uid. */
  foreignDirs: Record<string, number>;
} {
  const encoder = new TextEncoder();
  const dirs = new Set<string>(existingDirs);
  const modes: Record<string, number> = {};
  const foreignDirs: Record<string, number> = {};
  return {
    files,
    modes,
    foreignDirs,
    readFile: (path) => path in files ? encoder.encode(files[path]!) : null,
    writePrivateFile: (path, data, mode) => {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (!dirs.has(dir)) throw new Error(`no such directory: ${dir}`);
      if (readOnlyDirs.includes(dir)) throw new Error(`read-only: ${dir}`);
      if (path in files) throw new Error(`already exists: ${path}`);
      files[path] = new TextDecoder().decode(data);
      modes[path] = mode;
    },
    makePrivateDir: (path, mode) => {
      if (readOnlyDirs.includes(path)) throw new Error(`read-only: ${path}`);
      if (dirs.has(path)) throw new Error(`already exists: ${path}`);
      dirs.add(path);
      modes[path] = mode;
    },
    lstat: (path) => {
      if (path in files) {
        return { directory: false, uid: OWN_UID, mode: modes[path] ?? 0o600 };
      }
      if (!dirs.has(path)) return null;
      return {
        directory: true,
        uid: foreignDirs[path] ?? OWN_UID,
        mode: modes[path] ?? PRIVATE_DIR_MODE,
      };
    },
    remove: (path, recursive = false) => {
      delete files[path];
      delete modes[path];
      if (recursive) {
        dirs.delete(path);
        for (const name of Object.keys(files)) {
          if (name.startsWith(`${path}/`)) delete files[name];
        }
      }
    },
    ownerUid: () => OWN_UID,
    isWritableDir: (path) => dirs.has(path) && !readOnlyDirs.includes(path),
  };
}

function envFrom(
  values: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => values[name];
}

const HOME = "/home/vibe";
const MOUNT = mountedHostsPath(HOME);

/**
 * The `TMPDIR` candidate for this account (Issue #1282).
 *
 * `/tmp/vibe-gh-config` was the same path for every local account on the
 * host; the suffix binds it to the one running the worker.
 */
function tmpCandidate(tmp: string): string {
  return `${tmp}/vibe-gh-config-${cacheDirUserSuffix()}`;
}

Deno.test("isGhConfigDirUsable - present, non-empty and writable, or it is not usable", () => {
  const io = fakeIo({ "/staged/hosts.yml": "github.com:\n" });
  io.makePrivateDir("/staged", PRIVATE_DIR_MODE);
  assertEquals(isGhConfigDirUsable("/staged", io), true);
  assertEquals(isGhConfigDirUsable(undefined, io), false);
  assertEquals(isGhConfigDirUsable("/missing", io), false);

  // The exact residue the Issue #554 fallback left behind: a directory it
  // created and a copy that never arrived.
  const empty = fakeIo({ "/empty/hosts.yml": "" });
  empty.makePrivateDir("/empty", PRIVATE_DIR_MODE);
  assertEquals(isGhConfigDirUsable("/empty", empty), false);

  // A directory that exists and holds the credential but cannot be written:
  // the read-only credential mount itself, which gh cannot migrate into.
  const readOnly = fakeIo({ "/ro/hosts.yml": "github.com:\n" }, ["/ro"], [
    "/ro",
  ]);
  assertEquals(isGhConfigDirUsable("/ro", readOnly), false);
});

Deno.test("stagingCandidates - the durable state root before the agents' scratch", () => {
  const candidates = stagingCandidates(envFrom({
    VIBE_STATE_DIR: "/home/vibe/auto-issue-work/.container-state",
    VIBE_SCRATCH_DIR: "/tmp/vibe-scratch",
    TMPDIR: "/tmp",
  }));
  assertEquals(candidates, [
    "/home/vibe/auto-issue-work/.container-state/gh-config",
    "/tmp/vibe-scratch/gh-config",
    tmpCandidate("/tmp"),
  ]);
});

Deno.test("stagingCandidates - with no roots configured, TMPDIR still serves", () => {
  // Issue #1282: still served, but from a directory bound to this account
  // rather than the fixed `/tmp/vibe-gh-config` every local user shared.
  assertEquals(stagingCandidates(envFrom({})), [tmpCandidate("/tmp")]);
  assert(!stagingCandidates(envFrom({})).includes("/tmp/vibe-gh-config"));
});

Deno.test("restageGhConfigDir - rebuilds from the mount, not from the broken copy", () => {
  // The live shape: the staged copy is gone, the mount is intact.
  const io = fakeIo({ [MOUNT]: "github.com:\n    oauth_token: t\n" });
  const warnings: string[] = [];
  const staged = restageGhConfigDir({
    home: HOME,
    env: envFrom({ VIBE_STATE_DIR: "/state" }),
    io,
    warn: (m) => warnings.push(m),
  });

  assertEquals(staged, "/state/gh-config");
  assertEquals(io.files["/state/gh-config/hosts.yml"], io.files[MOUNT]);
  assert(warnings.some((w) => w.includes("re-staged the gh credential")));
});

Deno.test("restageGhConfigDir - an unwritable candidate falls through to the next", () => {
  const io = fakeIo(
    { [MOUNT]: "github.com:\n" },
    ["/state/gh-config"],
    ["/state/gh-config"],
  );
  const staged = restageGhConfigDir({
    home: HOME,
    env: envFrom({ VIBE_STATE_DIR: "/state", TMPDIR: "/tmp" }),
    io,
    warn: () => {},
  });

  assertEquals(staged, tmpCandidate("/tmp"));
});

Deno.test("restageGhConfigDir - an empty mount is a credential problem, reported not papered over", () => {
  const io = fakeIo({ [MOUNT]: "" });
  const warnings: string[] = [];
  const staged = restageGhConfigDir({
    home: HOME,
    env: envFrom({ TMPDIR: "/tmp" }),
    io,
    warn: (m) => warnings.push(m),
  });

  assertEquals(staged, null);
  assert(warnings.some((w) => w.includes("missing or empty")));
});

// ---------------------------------------------------------------------------
// The staging boundary (Issue #1282). On a host run neither VIBE_STATE_DIR nor
// VIBE_SCRATCH_DIR is set, so the credential is staged under TMPDIR — shared
// with every other local account. The copy must therefore be bound to this
// account before the token reaches the disk, and must not outlive the run.
// ---------------------------------------------------------------------------

Deno.test("stagingDirRefusal - only this account's own private directory is staged into", () => {
  // The worker's own: a directory, this uid, owner-only.
  assertEquals(
    stagingDirRefusal({ directory: true, uid: 1000, mode: 0o700 }, 1000),
    null,
  );
  // A symlink or a file planted where the directory should be.
  assertStringIncludes(
    stagingDirRefusal({ directory: false, uid: 1000, mode: 0o777 }, 1000) ?? "",
    "not a directory",
  );
  // A second local account got there first.
  assertStringIncludes(
    stagingDirRefusal({ directory: true, uid: 1001, mode: 0o700 }, 1000) ?? "",
    "owned by uid 1001",
  );
  // Ours, but readable — or writable — by everyone on the host.
  assertStringIncludes(
    stagingDirRefusal({ directory: true, uid: 1000, mode: 0o755 }, 1000) ?? "",
    "group/other accessible",
  );
  // A platform that reports neither uid nor mode still gets the type check.
  assertEquals(
    stagingDirRefusal({ directory: true, uid: null, mode: null }, null),
    null,
  );
});

Deno.test("restageGhConfigDir - refuses a directory another account owns, staging the credential nowhere", () => {
  // The TMPDIR candidate is unwritable here, so the refusal is what decides
  // the outcome rather than a fallback quietly succeeding elsewhere.
  const io = fakeIo({ [MOUNT]: "github.com:\n    oauth_token: t\n" }, [
    tmpCandidate("/tmp"),
  ]);
  io.makePrivateDir("/state/gh-config", PRIVATE_DIR_MODE);
  io.foreignDirs["/state/gh-config"] = 1001;
  const warnings: string[] = [];

  const staged = restageGhConfigDir({
    home: HOME,
    env: envFrom({ VIBE_STATE_DIR: "/state" }),
    io,
    warn: (m) => warnings.push(m),
  });

  assertEquals(staged, null);
  assertEquals(io.files["/state/gh-config/hosts.yml"], undefined);
  assert(
    warnings.some((w) =>
      w.includes("refusing to stage") && w.includes("owned by uid 1001")
    ),
    `no loud refusal in ${JSON.stringify(warnings)}`,
  );
});

Deno.test("restageGhConfigDir - refuses a pre-created world-writable candidate and never follows a planted hosts.yml symlink", async () => {
  // The shared-host attack: a second local account creates the staging
  // directory first and points hosts.yml at a file it can read.
  const home = await Deno.makeTempDir();
  const tmp = await Deno.makeTempDir();
  try {
    const mount = mountedHostsPath(home);
    await Deno.mkdir(mount.slice(0, mount.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(
      mount,
      "github.com:\n    oauth_token: not-a-real-token\n",
    );

    const env = envFrom({ TMPDIR: tmp });
    const candidate = stagingCandidates(env)[0]!;
    await Deno.mkdir(candidate);
    await Deno.chmod(candidate, 0o777);
    const planted = `${tmp}/planted.yml`;
    await Deno.writeTextFile(planted, "");
    await Deno.symlink(planted, `${candidate}/hosts.yml`);

    const warnings: string[] = [];
    const staged = restageGhConfigDir({
      home,
      env,
      warn: (m) => warnings.push(m),
    });

    assertEquals(staged, null);
    // The token never reached the attacker's file.
    assertEquals(await Deno.readTextFile(planted), "");
    assert(
      warnings.some((w) => w.includes("refusing to stage")),
      `no loud refusal in ${JSON.stringify(warnings)}`,
    );
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("restageGhConfigDir - creates the copy private from birth and removes it at run end", async () => {
  const home = await Deno.makeTempDir();
  const tmp = await Deno.makeTempDir();
  try {
    const mount = mountedHostsPath(home);
    await Deno.mkdir(mount.slice(0, mount.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(mount, "github.com:\n    oauth_token: t\n");

    const env = envFrom({ TMPDIR: tmp });
    const staged = restageGhConfigDir({ home, env, warn: () => {} });
    assertEquals(staged, stagingCandidates(env)[0]!);

    // 0600 at creation, not after a chmod that a reader could beat.
    const hosts = `${staged}/hosts.yml`;
    assertEquals(Deno.statSync(hosts).mode! & 0o777, STAGED_HOSTS_MODE);
    assertEquals(Deno.statSync(staged!).mode! & 0o777, PRIVATE_DIR_MODE);

    // Nothing removed the staged directory before Issue #1282.
    assert(removeStagedGhConfigDirs().includes(staged!));
    assertEquals(pathExists(staged!), false);
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(tmp, { recursive: true });
  }
});

/** Whether a path exists at all, symlinks not followed. */
function pathExists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("ensureUsableGhConfigDir - a healthy directory is left alone", () => {
  const io = fakeIo({ "/staged/hosts.yml": "github.com:\n" });
  io.makePrivateDir("/staged", PRIVATE_DIR_MODE);
  const ok = ensureUsableGhConfigDir({
    home: HOME,
    env: envFrom({ GH_CONFIG_DIR: "/staged" }),
    io,
    warn: () => {},
  });
  assertEquals(ok, true);
  // Nothing was written anywhere else.
  assertEquals(Object.keys(io.files), ["/staged/hosts.yml"]);
});

Deno.test("isGhAuthMissingFailure - recognises what gh says when it has no credential", () => {
  assertEquals(
    isGhAuthMissingFailure({
      code: 4,
      stderr: "To get started with GitHub CLI, please run: gh auth login",
    }),
    true,
  );
  assertEquals(
    isGhAuthMissingFailure({ code: 1, stderr: "no accounts configured" }),
    true,
  );
  // Not an auth problem: a 404 must never trigger a re-stage.
  assertEquals(
    isGhAuthMissingFailure({
      code: 1,
      stderr: "Could not resolve to an Issue",
    }),
    false,
  );
  assertEquals(isGhAuthMissingFailure({ code: 0, stderr: "" }), false);
});

// ---------------------------------------------------------------------------
// The git half (Issue #564, second failure). A run was found with a working
// `gh api user` and a `git fetch` that could not authenticate: `hosts.yml` was
// intact while the staged global git config had been reduced to its
// `safe.directory` line, losing the credential helper and the identity.
// ---------------------------------------------------------------------------

Deno.test("isGitAuthMissingFailure - recognises git's own ways of saying it has no credential", () => {
  const shapes = [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "fatal: could not read Username for 'https://github.com': No such device or address",
    "fatal: unable to auto-detect email address (got 'vibe@host.(none)')",
    "*** Please tell me who you are.",
    "remote: Authentication failed for 'https://github.com/org/repo.git/'",
  ];
  for (const stderr of shapes) {
    assertEquals(
      isGitAuthMissingFailure({ code: 128, stderr }),
      true,
      `not recognised: ${stderr}`,
    );
  }
  // A merge conflict is a failure, not an auth failure — it must never
  // trigger a credential rebuild and a retry.
  assertEquals(
    isGitAuthMissingFailure({
      code: 1,
      stderr: "CONFLICT (content): Merge conflict in deno.lock",
    }),
    false,
  );
  assertEquals(isGitAuthMissingFailure({ code: 0, stderr: "" }), false);
});

Deno.test("gitGlobalConfigEntries - rebuilds transport, helper and identity", () => {
  const entries = gitGlobalConfigEntries("VibeCoderST");
  const flat = entries.map((e) => e.args.join(" "));
  assert(flat.some((a) => a.includes("safe.directory")));
  assert(flat.some((a) => a.includes("insteadOf")));
  assert(flat.some((a) => a.includes("!gh auth git-credential")));
  assert(flat.some((a) => a.includes("user.name VibeCoderST")));
  assert(
    flat.some((a) =>
      a.includes("user.email VibeCoderST@users.noreply.github.com")
    ),
  );
});

Deno.test("gitGlobalConfigEntries - an unknown login contributes no identity", () => {
  // Nothing is guessed: a mount that names no user gets the transport and the
  // helper, and the identity failure stays loud.
  const flat = gitGlobalConfigEntries(null).map((e) => e.args.join(" "));
  assert(flat.some((a) => a.includes("!gh auth git-credential")));
  assertEquals(flat.some((a) => a.includes("user.email")), false);
});

Deno.test("mountedGitLogin - reads the service account out of the mounted hosts.yml", () => {
  const io = fakeIo({
    [MOUNT]: "github.com:\n    user: VibeCoderST\n    oauth_token: t\n",
  });
  assertEquals(mountedGitLogin(HOME, io), "VibeCoderST");
  assertEquals(mountedGitLogin(HOME, fakeIo({})), null);
});
