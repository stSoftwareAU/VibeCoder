/**
 * Tests for the content-approval state *load* path (Issue #3651).
 *
 * `readContentApprovalState` used to launder every read failure into
 * `{ snapshots: {} }`, so a state file that exists but cannot be read —
 * permission denied, an I/O fault, a directory in its place — looked exactly
 * like a legitimate first run. `verifyContentUnchanged` then reported
 * `no_snapshot` and the gate proceeded, re-baselining against whatever
 * content was in hand.
 *
 * Only a genuinely absent file (`Deno.errors.NotFound`) is a first run. Every
 * other read failure is an integrity signal and must fail closed.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  captureContentSnapshot,
  type ContentApprovalDeps,
  type ContentApprovalState,
  readContentApprovalState,
  removeContentSnapshot,
  resetContentApprovalRunState,
  verifyContentUnchanged,
} from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import { verifyWorkOnContentIntegrity } from "../lib/work_on_content_integrity.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";

const WORK_DIR = "/tmp/content-approval-read-error-test";
const STATE_PATH = `${WORK_DIR}/.content_approval_state.json`;
const RECOVERY_PATH = `${WORK_DIR}/.content_approval_state.recovered.json`;

/**
 * Deps whose read always fails with the supplied error, and which records
 * every write so a test can assert that nothing was re-baselined.
 */
function createFailingReadFs(error: Error): {
  deps: ContentApprovalDeps;
  writes: string[];
} {
  const writes: string[] = [];
  return {
    writes,
    deps: {
      readFile: () => Promise.reject(error),
      writeFile: (path: string) => {
        writes.push(path);
        return Promise.resolve();
      },
      renameFile: () => Promise.resolve(),
      removeFile: () => Promise.resolve(),
    },
  };
}

/** Three baselines an unusable read must never cost us (Issue #3875). */
function seededState(): ContentApprovalState {
  const capturedAt = 1_700_000_000;
  return {
    snapshots: {
      "owner/repo|1": {
        contentHash: "a".repeat(64),
        capturedAt,
        issueAuthor: "alice",
      },
      "owner/repo|2": {
        contentHash: "b".repeat(64),
        capturedAt,
        issueAuthor: "bob",
      },
      "owner/repo|3": {
        contentHash: "c".repeat(64),
        capturedAt,
        issueAuthor: "carol",
      },
    },
  };
}

/**
 * In-memory store holding a populated state file whose *primary* path cannot
 * be read. Every other path (the recovery sidecar, temp files) behaves
 * normally, so a test can tell "left the baseline alone and wrote elsewhere"
 * apart from "clobbered the baseline".
 */
function createUnreadablePrimaryFs(
  seeded: ContentApprovalState,
  readError: Error,
): { deps: ContentApprovalDeps; files: Map<string, string>; writes: string[] } {
  const files = new Map<string, string>([[
    STATE_PATH,
    JSON.stringify(seeded, null, 2),
  ]]);
  const writes: string[] = [];

  return {
    files,
    writes,
    deps: {
      readFile: (path: string) => {
        if (path === STATE_PATH) return Promise.reject(readError);
        const content = files.get(path);
        return content === undefined
          ? Promise.reject(new Deno.errors.NotFound(`Not found: ${path}`))
          : Promise.resolve(content);
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
      stateDirExists: () => Promise.resolve(true),
      makeStateDir: () => Promise.resolve(),
    },
  };
}

/** A store that reads back cleanly but holds no baseline for the issue. */
function createEmptyReadableFs(): {
  deps: ContentApprovalDeps;
  writes: string[];
} {
  const files = new Map<string, string>();
  const writes: string[] = [];
  return {
    writes,
    deps: {
      readFile: (path: string) => {
        const content = files.get(path);
        return content === undefined
          ? Promise.reject(new Deno.errors.NotFound(`Not found: ${path}`))
          : Promise.resolve(content);
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
      stateDirExists: () => Promise.resolve(false),
      makeStateDir: () => Promise.resolve(),
    },
  };
}

function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: ["owner/repo"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    workDir: WORK_DIR,
  };
}

function makeIssue(): FilterableIssue {
  return {
    number: 42,
    title: "Fix the bug",
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
      return Promise.resolve(
        JSON.stringify({ title: "Fix the bug", body: "Body text" }),
      );
    }
    return Promise.resolve("");
  };
}

// ---------------------------------------------------------------------------
// readContentApprovalState
// ---------------------------------------------------------------------------

Deno.test(
  "readContentApprovalState - an absent file is a first run, not an error",
  async () => {
    const { deps } = createFailingReadFs(
      new Deno.errors.NotFound(`No such file: ${STATE_PATH}`),
    );

    const result = await readContentApprovalState(WORK_DIR, deps);

    assert(result.ok, "an absent state file must load as an empty state");
    assertEquals(result.value.snapshots, {});
  },
);

Deno.test(
  "readContentApprovalState - a permission failure is an error, not an empty state",
  async () => {
    const { deps } = createFailingReadFs(
      new Deno.errors.PermissionDenied(`Permission denied: ${STATE_PATH}`),
    );

    const result = await readContentApprovalState(WORK_DIR, deps);

    assert(!result.ok, "an unreadable state file must not load as empty");
    assert(
      result.error.message.includes(STATE_PATH),
      `error should name the state path, got: ${result.error.message}`,
    );
  },
);

Deno.test(
  "readContentApprovalState - an I/O failure is an error, not an empty state",
  async () => {
    const { deps } = createFailingReadFs(new Error("EIO: read failed"));

    const result = await readContentApprovalState(WORK_DIR, deps);

    assert(!result.ok, "an I/O read failure must not load as empty");
  },
);

// ---------------------------------------------------------------------------
// verifyContentUnchanged
// ---------------------------------------------------------------------------

Deno.test(
  "verifyContentUnchanged - an unreadable state file yields error, not no_snapshot",
  async () => {
    const { deps } = createFailingReadFs(
      new Deno.errors.PermissionDenied(`Permission denied: ${STATE_PATH}`),
    );

    const result = await verifyContentUnchanged(
      WORK_DIR,
      "owner/repo",
      42,
      "Fix the bug",
      "Body text",
      deps,
    );

    assertEquals(result.status, "error");
  },
);

// ---------------------------------------------------------------------------
// The gate itself must fail closed
// ---------------------------------------------------------------------------

Deno.test(
  "verifyWorkOnContentIntegrity - blocks when the approval state is unreadable",
  async () => {
    const { deps } = createFailingReadFs(
      new Deno.errors.PermissionDenied(`Permission denied: ${STATE_PATH}`),
    );

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      makeIssue(),
      makeConfig(),
      makeGh(),
      undefined,
      deps,
    );

    assertEquals(result, "blocked");
  },
);

Deno.test(
  "verifyWorkOnContentIntegrity - does not re-baseline when the state is unreadable",
  async () => {
    const { deps, writes } = createFailingReadFs(
      new Deno.errors.PermissionDenied(`Permission denied: ${STATE_PATH}`),
    );

    await verifyWorkOnContentIntegrity(
      "owner/repo",
      makeIssue(),
      makeConfig(),
      makeGh(),
      undefined,
      deps,
    );

    assertEquals(
      writes,
      [],
      "an unreadable baseline must not be replaced with current content",
    );
  },
);

// ---------------------------------------------------------------------------
// A degraded write must not destroy the other issues' baselines (Issue #3875)
// ---------------------------------------------------------------------------

Deno.test(
  "captureContentSnapshot - an unusable state file is not overwritten with a one-entry map",
  async () => {
    resetContentApprovalRunState();
    const { deps, files, writes } = createUnreadablePrimaryFs(
      seededState(),
      new Error("EMFILE: too many open files"),
    );

    const result = await captureContentSnapshot(
      WORK_DIR,
      "owner/repo",
      4,
      "Fix the bug",
      "Body text",
      "alice",
      deps,
    );

    assert(
      !result.ok,
      "a capture over an unusable baseline must not report success",
    );

    const onDisk = JSON.parse(
      files.get(STATE_PATH) ?? "",
    ) as ContentApprovalState;
    assertEquals(
      Object.keys(onDisk.snapshots).sort(),
      ["owner/repo|1", "owner/repo|2", "owner/repo|3"],
      "the three seeded baselines must survive the degraded capture",
    );
    assert(
      writes.every((path) => path.startsWith(RECOVERY_PATH)),
      `every write must go to the recovery sidecar, got: ${writes.join(", ")}`,
    );

    const recovered = JSON.parse(
      files.get(RECOVERY_PATH) ?? "",
    ) as ContentApprovalState;
    assert(
      recovered.snapshots["owner/repo|4"],
      "the fresh snapshot must be recoverable from the sidecar",
    );
  },
);

Deno.test(
  "captureContentSnapshot - a corrupt on-disk state file is preserved byte for byte",
  async () => {
    resetContentApprovalRunState();
    const stateDir = await Deno.makeTempDir({ prefix: "approval-corrupt-" });
    const path = `${stateDir}/.content_approval_state.json`;
    // Valid state followed by truncation garbage: the three baselines are
    // still on disk, but `JSON.parse` cannot recover them.
    const corrupt = `${JSON.stringify(seededState(), null, 2)}\n{"snapsho`;

    try {
      await Deno.writeTextFile(path, corrupt);

      const result = await captureContentSnapshot(
        stateDir,
        "owner/repo",
        4,
        "Fix the bug",
        "Body text",
        "alice",
      );

      assert(
        !result.ok,
        "a corrupt baseline must not report a successful capture",
      );
      assertEquals(
        await Deno.readTextFile(path),
        corrupt,
        "the unreadable file must be preserved, not overwritten",
      );

      const recovered = JSON.parse(
        await Deno.readTextFile(
          `${stateDir}/.content_approval_state.recovered.json`,
        ),
      ) as ContentApprovalState;
      assert(
        recovered.snapshots["owner/repo|4"],
        "the fresh snapshot must land in the recovery sidecar",
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "removeContentSnapshot - refuses to rewrite an unusable state file",
  async () => {
    resetContentApprovalRunState();
    const seeded = seededState();
    const { deps, files, writes } = createUnreadablePrimaryFs(
      seeded,
      new Deno.errors.PermissionDenied(`Permission denied: ${STATE_PATH}`),
    );

    const result = await removeContentSnapshot(WORK_DIR, "owner/repo", 1, deps);

    assert(
      !result.ok,
      "removing from an unusable state must not report success",
    );
    assertEquals(writes, [], "no write may follow an unusable read");
    assertEquals(
      files.get(STATE_PATH),
      JSON.stringify(seeded, null, 2),
      "the unreadable file must be left exactly as it was",
    );
  },
);

// ---------------------------------------------------------------------------
// "State was unusable this run" is sticky (Issue #3875)
// ---------------------------------------------------------------------------

Deno.test(
  "verifyContentUnchanged - a missing snapshot is a first encounter while the store is healthy",
  async () => {
    resetContentApprovalRunState();
    const { deps } = createEmptyReadableFs();

    const result = await verifyContentUnchanged(
      WORK_DIR,
      "owner/repo",
      99,
      "Fix the bug",
      "Body text",
      deps,
    );

    assertEquals(result.status, "no_snapshot");
  },
);

Deno.test(
  "verifyContentUnchanged - a missing snapshot after an unusable read in the same run is an error",
  async () => {
    resetContentApprovalRunState();
    const { deps: failing } = createFailingReadFs(
      new Error("EIO: read failed"),
    );
    await readContentApprovalState(WORK_DIR, failing);

    // The fault clears, but this store lost its baselines: a missing snapshot
    // is no longer distinguishable from a destroyed one.
    const { deps } = createEmptyReadableFs();
    const result = await verifyContentUnchanged(
      WORK_DIR,
      "owner/repo",
      99,
      "Fix the bug",
      "Body text",
      deps,
    );

    assertEquals(result.status, "error");
    resetContentApprovalRunState();
  },
);

Deno.test(
  "verifyWorkOnContentIntegrity - a later issue is not blessed after an unusable read",
  async () => {
    resetContentApprovalRunState();
    const stateDir = resolveContentApprovalStateDir(WORK_DIR);
    const { deps: failing } = createFailingReadFs(
      new Error("EIO: read failed"),
    );
    await readContentApprovalState(stateDir, failing);

    const { deps, writes } = createEmptyReadableFs();
    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      makeIssue(),
      makeConfig(),
      makeGh(),
      undefined,
      deps,
    );

    assertEquals(result, "blocked");
    assertEquals(
      writes,
      [],
      "a store known to be unusable this run must not be re-baselined",
    );
    resetContentApprovalRunState();
  },
);
