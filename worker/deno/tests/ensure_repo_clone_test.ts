/**
 * Tests for `ensureRepoClone` (Issue #179).
 *
 * A repo freshly added to `.config.json` has no local clone, so any consumer
 * that walks `${workDir}/<repo>` fails with ENOENT. The helper clones on
 * demand via the same `setupRepo` the setup phase uses, leaves an existing
 * clone untouched, and fails loud when the clone cannot be made.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ensureRepoClone } from "../lib/ensure_repo_clone.ts";
import type { CommandResult } from "../types.ts";

Deno.test(
  "ensureRepoClone - existing clone is left untouched (no setupRepo call)",
  async () => {
    const setupCalls: Array<[string, string]> = [];

    const result = await ensureRepoClone("acme/widget", "/work", {
      isDirectoryFn: (path) => Promise.resolve(path === "/work/widget"),
      setupRepoFn: (repo, workDir) => {
        setupCalls.push([repo, workDir]);
        return Promise.resolve({ success: true, message: "/work/widget" });
      },
    });

    assertEquals(result, {
      ok: true,
      repoPath: "/work/widget",
      cloned: false,
    });
    assertEquals(setupCalls.length, 0);
  },
);

Deno.test(
  "ensureRepoClone - missing clone is created via setupRepo",
  async () => {
    const setupCalls: Array<[string, string]> = [];

    const result = await ensureRepoClone("acme/NEAT-AI-Forests", "/work", {
      isDirectoryFn: () => Promise.resolve(false),
      setupRepoFn: (repo, workDir) => {
        setupCalls.push([repo, workDir]);
        return Promise.resolve({
          success: true,
          message: "/work/NEAT-AI-Forests",
        });
      },
    });

    assertEquals(result, {
      ok: true,
      repoPath: "/work/NEAT-AI-Forests",
      cloned: true,
    });
    assertEquals(setupCalls, [["acme/NEAT-AI-Forests", "/work"]]);
  },
);

Deno.test(
  "ensureRepoClone - a failed clone fails loud with the underlying message",
  async () => {
    const result = await ensureRepoClone("acme/widget", "/work", {
      isDirectoryFn: () => Promise.resolve(false),
      setupRepoFn: () =>
        Promise.resolve({
          success: false,
          message: "Failed to clone acme/widget: repository not found",
        }),
    });

    assertEquals(result.ok, false);
    assertEquals(result.cloned, false);
    assertEquals(result.repoPath, "/work/widget");
    assertStringIncludes(String(result.message), "repository not found");
  },
);

Deno.test(
  "ensureRepoClone - unsafe path segment is never probed, setupRepo decides",
  async () => {
    // `${workDir}/..` is a real directory, so probing it would report the
    // clone as present. The slug must reach setupRepo, which refuses it.
    const probed: string[] = [];
    const setupCalls: string[] = [];

    const result = await ensureRepoClone("acme/..", "/work", {
      isDirectoryFn: (path) => {
        probed.push(path);
        return Promise.resolve(true);
      },
      setupRepoFn: (repo): Promise<CommandResult> => {
        setupCalls.push(repo);
        return Promise.resolve({
          success: false,
          message: "Refusing to set up repo with unsafe path segment",
        });
      },
    });

    assertEquals(probed, []);
    assertEquals(setupCalls, ["acme/.."]);
    assertEquals(result.ok, false);
    assertStringIncludes(String(result.message), "unsafe path segment");
  },
);

Deno.test(
  "ensureRepoClone - default directory probe reports a real directory",
  async () => {
    const workDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${workDir}/widget`);
      let setupCalled = false;
      const result = await ensureRepoClone("acme/widget", workDir, {
        setupRepoFn: () => {
          setupCalled = true;
          return Promise.resolve({ success: true, message: "" });
        },
      });
      assertEquals(result.ok, true);
      assertEquals(result.cloned, false);
      assertEquals(setupCalled, false);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);
