/**
 * Tests for the content-approval state *deletion* half of the fail-open
 * (Issue #3717, SEC-25fca7187089).
 *
 * Issue #3651 closed the load-path half: a state file that reads back but is
 * not valid state now blocks. A *deleted* state file still looked like a
 * genuine first run — `no_snapshot` → capture current content → proceed —
 * which is wrong after `nukeWorkDir()` or an agent-driven `rm`.
 *
 * Two changes close it, and both are exercised here:
 *
 * 1. The baseline lives in a store directory *outside* the agent-writable
 *    `workDir`, so nuking `workDir` no longer destroys it.
 * 2. An initialised store (the directory exists) with no state file inside it
 *    is a deletion, not a first run, and yields the `error` verdict so the
 *    gate fails closed exactly as it does for a corrupt file.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  captureContentSnapshot,
  type ContentApprovalDeps,
  readContentApprovalState,
  verifyContentUnchanged,
} from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import { verifyWorkOnContentIntegrity } from "../lib/work_on_content_integrity.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";

const TITLE = "Fix the bug";
const BODY = "Body text";

/**
 * In-memory file system whose store directory presence is controllable, so a
 * "the file is gone but the store exists" state can be modelled without
 * touching the real filesystem.
 */
function createMemoryFs(storeExists: boolean): {
  deps: ContentApprovalDeps;
  files: Map<string, string>;
  writes: string[];
} {
  const files = new Map<string, string>();
  const writes: string[] = [];

  return {
    files,
    writes,
    deps: {
      readFile: (path: string) => {
        const content = files.get(path);
        if (content === undefined) {
          return Promise.reject(new Deno.errors.NotFound(`Not found: ${path}`));
        }
        return Promise.resolve(content);
      },
      writeFile: (path: string, content: string) => {
        writes.push(path);
        files.set(path, content);
        return Promise.resolve();
      },
      renameFile: (oldPath: string, newPath: string) => {
        files.set(newPath, files.get(oldPath) ?? "");
        files.delete(oldPath);
        return Promise.resolve();
      },
      removeFile: (path: string) => {
        files.delete(path);
        return Promise.resolve();
      },
      stateDirExists: () => Promise.resolve(storeExists),
      makeStateDir: () => Promise.resolve(),
    },
  };
}

function makeConfig(workDir: string): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: ["owner/repo"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    workDir,
  };
}

function makeIssue(): FilterableIssue {
  return {
    number: 42,
    title: TITLE,
    url: "https://github.com/owner/repo/issues/42",
    assignees: [],
    labels: ["work-on"],
    createdAt: "2026-08-01T00:00:00Z",
    author: "mallory",
    milestone: "",
  };
}

/** `gh issue view --json title,body` succeeds; everything else is empty. */
function makeGh(): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const command = args.join(" ");
    if (command.includes("issue view") && command.includes("title,body")) {
      return Promise.resolve(JSON.stringify({ title: TITLE, body: BODY }));
    }
    return Promise.resolve("");
  };
}

// ---------------------------------------------------------------------------
// The store lives outside workDir
// ---------------------------------------------------------------------------

Deno.test(
  "resolveContentApprovalStateDir - resolves outside the agent-writable workDir",
  () => {
    const workDir = "/home/vibe/auto-issue-work";
    const stateDir = resolveContentApprovalStateDir(workDir);

    assert(
      stateDir !== workDir && !stateDir.startsWith(`${workDir}/`),
      `state dir ${stateDir} must not sit inside ${workDir}`,
    );
  },
);

Deno.test(
  "resolveContentApprovalStateDir - ignores a trailing slash on workDir",
  () => {
    assertEquals(
      resolveContentApprovalStateDir("/home/vibe/auto-issue-work/"),
      resolveContentApprovalStateDir("/home/vibe/auto-issue-work"),
    );
  },
);

Deno.test(
  "resolveContentApprovalStateDir - an empty workDir yields no store",
  () => {
    assertEquals(resolveContentApprovalStateDir(""), "");
  },
);

Deno.test(
  "content approval state - survives nuking workDir (Issue #3717)",
  async () => {
    const workDir = await Deno.makeTempDir({ prefix: "approval-nuke-" });
    const stateDir = resolveContentApprovalStateDir(workDir);

    try {
      const captured = await captureContentSnapshot(
        stateDir,
        "owner/repo",
        42,
        TITLE,
        BODY,
        "alice",
      );
      assertEquals(captured.ok, true);

      // Simulate `nukeWorkDir()` / an agent-driven `rm -rf` on the work tree.
      await Deno.remove(workDir, { recursive: true });

      const verdict = await verifyContentUnchanged(
        stateDir,
        "owner/repo",
        42,
        TITLE,
        BODY,
      );
      assertEquals(
        verdict.status,
        "unchanged",
        "the approval baseline must outlive the work directory",
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true }).catch(() => {});
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "content approval state - the store directory is not world- or group-readable",
  async () => {
    const workDir = await Deno.makeTempDir({ prefix: "approval-mode-" });
    const stateDir = resolveContentApprovalStateDir(workDir);

    try {
      await captureContentSnapshot(
        stateDir,
        "owner/repo",
        1,
        "T",
        "B",
        "alice",
      );
      const info = await Deno.stat(stateDir);
      assertEquals(
        (info.mode ?? 0) & 0o077,
        0,
        "the approval store must not grant group or other access",
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true }).catch(() => {});
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  },
);

// ---------------------------------------------------------------------------
// A deleted state file is an integrity fault, not a first run
// ---------------------------------------------------------------------------

Deno.test(
  "readContentApprovalState - a deleted file in an initialised store is an error",
  async () => {
    const { deps } = createMemoryFs(true);

    const result = await readContentApprovalState("/tmp/store", deps);

    assert(!result.ok, "a deleted baseline must not read back as empty");
    assert(
      result.error.message.includes("/tmp/store"),
      `error should name the store, got: ${result.error.message}`,
    );
  },
);

Deno.test(
  "readContentApprovalState - an absent store is still a genuine first run",
  async () => {
    const { deps } = createMemoryFs(false);

    const result = await readContentApprovalState("/tmp/store", deps);

    assert(result.ok, "a store that was never created is a first run");
    assertEquals(result.value.snapshots, {});
  },
);

Deno.test(
  "readContentApprovalState - a store-existence check failure fails closed",
  async () => {
    const { deps } = createMemoryFs(false);
    deps.stateDirExists = () => Promise.reject(new Error("EIO: stat failed"));

    const result = await readContentApprovalState("/tmp/store", deps);

    assert(!result.ok, "an unverifiable store must not read back as empty");
  },
);

Deno.test(
  "verifyContentUnchanged - a deleted baseline yields error, not no_snapshot",
  async () => {
    const { deps } = createMemoryFs(true);

    const result = await verifyContentUnchanged(
      "/tmp/store",
      "owner/repo",
      42,
      TITLE,
      BODY,
      deps,
    );

    assertEquals(result.status, "error");
  },
);

Deno.test(
  "verifyWorkOnContentIntegrity - blocks when the approval state was deleted",
  async () => {
    const { deps } = createMemoryFs(true);

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      makeIssue(),
      makeConfig("/tmp/deleted-state-work"),
      makeGh(),
      undefined,
      deps,
    );

    assertEquals(result, "blocked");
  },
);

Deno.test(
  "verifyWorkOnContentIntegrity - does not re-baseline a deleted approval state",
  async () => {
    const { deps, writes } = createMemoryFs(true);

    await verifyWorkOnContentIntegrity(
      "owner/repo",
      makeIssue(),
      makeConfig("/tmp/deleted-state-work"),
      makeGh(),
      undefined,
      deps,
    );

    assertEquals(
      writes,
      [],
      "a deleted baseline must not be replaced with current content",
    );
  },
);

Deno.test(
  "verifyWorkOnContentIntegrity - a never-initialised store still proceeds",
  async () => {
    const { deps, writes } = createMemoryFs(false);

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      makeIssue(),
      makeConfig("/tmp/first-run-work"),
      makeGh(),
      undefined,
      deps,
    );

    assertEquals(result, "proceed");
    assert(writes.length > 0, "a genuine first run captures a baseline");
  },
);
