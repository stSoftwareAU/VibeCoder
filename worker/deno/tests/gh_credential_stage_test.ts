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

import { assert, assertEquals } from "@std/assert";
import {
  ensureUsableGhConfigDir,
  type GhCredentialStageIo,
  isGhAuthMissingFailure,
  isGhConfigDirUsable,
  mountedHostsPath,
  restageGhConfigDir,
  stagingCandidates,
} from "../lib/gh_credential_stage.ts";

/** An in-memory filesystem: paths to contents, plus a read-only path set. */
function fakeIo(
  files: Record<string, string>,
  readOnlyDirs: string[] = [],
  existingDirs: string[] = [],
): GhCredentialStageIo & { files: Record<string, string> } {
  const encoder = new TextEncoder();
  const dirs = new Set<string>(existingDirs);
  return {
    files,
    readFile: (path) => path in files ? encoder.encode(files[path]!) : null,
    writeFile: (path, data) => {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (!dirs.has(dir)) throw new Error(`no such directory: ${dir}`);
      if (readOnlyDirs.includes(dir)) throw new Error(`read-only: ${dir}`);
      files[path] = new TextDecoder().decode(data);
    },
    mkdir: (path) => {
      if (readOnlyDirs.includes(path)) throw new Error(`read-only: ${path}`);
      dirs.add(path);
    },
    chmod: () => {},
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

Deno.test("isGhConfigDirUsable - present, non-empty and writable, or it is not usable", () => {
  const io = fakeIo({ "/staged/hosts.yml": "github.com:\n" });
  io.mkdir("/staged");
  assertEquals(isGhConfigDirUsable("/staged", io), true);
  assertEquals(isGhConfigDirUsable(undefined, io), false);
  assertEquals(isGhConfigDirUsable("/missing", io), false);

  // The exact residue the Issue #554 fallback left behind: a directory it
  // created and a copy that never arrived.
  const empty = fakeIo({ "/empty/hosts.yml": "" });
  empty.mkdir("/empty");
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
    "/tmp/vibe-gh-config",
  ]);
});

Deno.test("stagingCandidates - with no roots configured, TMPDIR still serves", () => {
  assertEquals(stagingCandidates(envFrom({})), ["/tmp/vibe-gh-config"]);
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

  assertEquals(staged, "/tmp/vibe-gh-config");
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

Deno.test("ensureUsableGhConfigDir - a healthy directory is left alone", () => {
  const io = fakeIo({ "/staged/hosts.yml": "github.com:\n" });
  io.mkdir("/staged");
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
