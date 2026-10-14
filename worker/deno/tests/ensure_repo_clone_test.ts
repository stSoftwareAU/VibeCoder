/**
 * Tests for `ensureRepoClone` (Issue #179).
 *
 * A repo freshly added to `.config.json` has no local clone, so any consumer
 * that walks `${workDir}/<repo>` fails with ENOENT. The helper clones on
 * demand via the same `setupRepo` the setup phase uses, leaves an existing
 * clone untouched, hands a corrupt clone (bad `.git/config`) to `setupRepo`
 * for move-aside and re-clone (Issue #3708), and fails loud when the clone
 * cannot be made.
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
  "ensureRepoClone - default directory probe reuses a real clone untouched",
  async () => {
    const workDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${workDir}/widget`);
      // A real repository — a bare directory is re-cloned (Issue #2848).
      const init = await new Deno.Command("git", {
        args: ["init", "-q"],
        cwd: `${workDir}/widget`,
        stdin: "null",
      }).output();
      assertEquals(init.code, 0);
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

Deno.test(
  "ensureRepoClone - a directory holding no repository is re-cloned, not reused (Issue #2848)",
  async () => {
    const workDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${workDir}/widget`);
      const setupCalls: Array<[string, string]> = [];

      const result = await ensureRepoClone("acme/widget", workDir, {
        setupRepoFn: (repo, dir) => {
          setupCalls.push([repo, dir]);
          return Promise.resolve({ success: true, message: `${dir}/widget` });
        },
      });

      assertEquals(result, {
        ok: true,
        repoPath: `${workDir}/widget`,
        cloned: true,
      });
      assertEquals(setupCalls, [["acme/widget", workDir]]);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureRepoClone - a clone with a corrupt .git/config is handed to setupRepo, not reused (Issue #3708)",
  async () => {
    const workDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${workDir}/widget`);
      const init = await new Deno.Command("git", {
        args: ["init", "-q"],
        cwd: `${workDir}/widget`,
        stdin: "null",
      }).output();
      assertEquals(init.code, 0);
      const configPath = `${workDir}/widget/.git/config`;
      const config = await Deno.readTextFile(configPath);
      await Deno.writeTextFile(configPath, `garbage line\n${config}`);

      const setupCalls: Array<[string, string]> = [];
      const result = await ensureRepoClone("acme/widget", workDir, {
        setupRepoFn: (repo, dir) => {
          setupCalls.push([repo, dir]);
          return Promise.resolve({ success: true, message: `${dir}/widget` });
        },
      });

      assertEquals(result, {
        ok: true,
        repoPath: `${workDir}/widget`,
        cloned: true,
      });
      assertEquals(setupCalls, [["acme/widget", workDir]]);
      // setupRepo owns the move-aside; ensureRepoClone must not remove it.
      const stat = await Deno.stat(`${workDir}/widget`);
      assertEquals(stat.isDirectory, true);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureRepoClone - a corrupt clone whose recovery is refused fails loud (Issue #3708)",
  async () => {
    const workDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${workDir}/widget`);
      const init = await new Deno.Command("git", {
        args: ["init", "-q"],
        cwd: `${workDir}/widget`,
        stdin: "null",
      }).output();
      assertEquals(init.code, 0);
      const configPath = `${workDir}/widget/.git/config`;
      const config = await Deno.readTextFile(configPath);
      await Deno.writeTextFile(configPath, `garbage line\n${config}`);

      const result = await ensureRepoClone("acme/widget", workDir, {
        setupRepoFn: (): Promise<CommandResult> =>
          Promise.resolve({
            success: false,
            message:
              `The clone of acme/widget at ${workDir}/widget is corrupt (fatal: bad config line 1 in file .git/config) and was already re-cloned within 24 h`,
          }),
      });

      assertEquals(result.ok, false);
      assertEquals(result.cloned, false);
      assertStringIncludes(String(result.message), "bad config line 1");
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureRepoClone - concurrent callers on one corrupt clone recover it once, none refused as a repeat (PR #3712 review)",
  async () => {
    const workDir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${workDir}/widget`);
      const init = await new Deno.Command("git", {
        args: ["init", "-q"],
        cwd: `${workDir}/widget`,
        stdin: "null",
      }).output();
      assertEquals(init.code, 0);
      const configPath = `${workDir}/widget/.git/config`;
      const healthy = await Deno.readTextFile(configPath);
      await Deno.writeTextFile(configPath, `garbage line\n${healthy}`);

      let setupCalls = 0;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      // Mirrors setupRepo: the first call repairs the clone, any further call
      // for a clone already recovered is refused by the 24 h cap.
      const setupRepoFn = async (): Promise<CommandResult> => {
        setupCalls++;
        if (setupCalls > 1) {
          return {
            success: false,
            message: "already re-cloned within 24 h",
          };
        }
        await held;
        await Deno.writeTextFile(configPath, healthy);
        return { success: true, message: `${workDir}/widget` };
      };

      const first = ensureRepoClone("acme/widget", workDir, { setupRepoFn });
      const second = ensureRepoClone("acme/widget", workDir, { setupRepoFn });
      // Let both callers reach the point where an unserialised pair would both
      // have probed the corrupt clone, then finish the recovery.
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      const results = await Promise.all([first, second]);

      assertEquals(results.map((r) => r.ok), [true, true]);
      assertEquals(setupCalls, 1);
      assertEquals(results.map((r) => r.cloned), [true, false]);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "ensureRepoClone - a failed call does not block the next caller for the same clone path, and other paths run in parallel",
  async () => {
    let calls = 0;
    const failing = ensureRepoClone("acme/widget", "/work", {
      isDirectoryFn: () => Promise.resolve(false),
      setupRepoFn: () => {
        calls++;
        return Promise.reject(new Error("clone blew up"));
      },
    });
    // Same path, queued behind the failing call: runs after it rather than
    // inheriting its rejection.
    const retryPromise = ensureRepoClone("acme/widget", "/work", {
      isDirectoryFn: () => Promise.resolve(false),
      setupRepoFn: () => {
        calls++;
        return Promise.resolve({ success: true, message: "" });
      },
    });
    let rejected = false;
    await failing.catch(() => (rejected = true));
    assertEquals(rejected, true);
    const retry = await retryPromise;
    assertEquals(retry.ok, true);

    // A different clone path is not queued behind a held one.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = ensureRepoClone("acme/slow", "/work", {
      isDirectoryFn: () => Promise.resolve(false),
      setupRepoFn: async () => {
        await held;
        return { success: true, message: "" };
      },
    });
    const other = await ensureRepoClone("acme/other", "/work", {
      isDirectoryFn: () => Promise.resolve(false),
      setupRepoFn: () => Promise.resolve({ success: true, message: "" }),
    });
    assertEquals(other.ok, true);
    release();
    assertEquals((await slow).ok, true);
    assertEquals(calls, 2);
  },
);

Deno.test(
  "ensureRepoClone - a caller arriving after an earlier one finished still waits for the one still running (PR #3712 review)",
  async () => {
    const releases: Array<() => void> = [];
    const log: string[] = [];
    const call = (label: string) =>
      ensureRepoClone("acme/widget", "/work", {
        isDirectoryFn: () => Promise.resolve(false),
        setupRepoFn: async () => {
          log.push(`start ${label}`);
          await new Promise<void>((resolve) => releases.push(resolve));
          log.push(`end ${label}`);
          return { success: true, message: "" };
        },
      });

    const a = call("a");
    const b = call("b");
    // A starts first; B is queued behind it.
    await Promise.resolve();
    while (releases.length < 1) await Promise.resolve();
    releases[0]!();
    await a;
    // B is now running (A's queue slot is gone); D arrives while B is held.
    while (releases.length < 2) await Promise.resolve();
    const d = call("d");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assertEquals(log, ["start a", "end a", "start b"]);
    releases[1]!();
    await b;
    while (releases.length < 3) await Promise.resolve();
    releases[2]!();
    await d;
    assertEquals(log, [
      "start a",
      "end a",
      "start b",
      "end b",
      "start d",
      "end d",
    ]);
  },
);
