/**
 * Tests for content_approval_tracker.ts (Issue #1341).
 *
 * Tests the TOCTOU protection for work-on label approval:
 * - Content hash computation
 * - Snapshot capture and verification
 * - Untrusted author modification detection
 * - Trusted author modification (warn and proceed)
 * - Missing snapshot (legacy — warn and proceed)
 * - Stale snapshot cleanup
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  buildContentModifiedComment,
  captureContentSnapshot,
  cleanupStaleSnapshots,
  computeContentHash,
  type ContentApprovalDeps,
  isAuthorTrusted,
  loadContentApprovalState,
  removeContentSnapshot,
  verifyContentUnchanged,
} from "../lib/content_approval_tracker.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** In-memory file system for isolated tests. */
function createMemoryFs(): {
  deps: ContentApprovalDeps;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();

  const deps: ContentApprovalDeps = {
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Deno.errors.NotFound(`File not found: ${path}`);
      }
      return content;
    },
    writeFile: async (
      path: string,
      content: string,
      _options?: Deno.WriteFileOptions,
    ) => {
      files.set(path, content);
    },
    renameFile: async (oldPath: string, newPath: string) => {
      const content = files.get(oldPath);
      if (content === undefined) {
        throw new Error(`File not found: ${oldPath}`);
      }
      files.set(newPath, content);
      files.delete(oldPath);
    },
    removeFile: async (path: string) => {
      files.delete(path);
    },
  };

  return { deps, files };
}

// ---------------------------------------------------------------------------
// computeContentHash tests
// ---------------------------------------------------------------------------

Deno.test("content_approval_tracker - computeContentHash produces consistent 64-char hex", async () => {
  const hash = await computeContentHash("Test Title", "Test body content");
  assertEquals(hash.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(hash), true);
});

Deno.test("content_approval_tracker - computeContentHash is deterministic", async () => {
  const hash1 = await computeContentHash("Same title", "Same body");
  const hash2 = await computeContentHash("Same title", "Same body");
  assertEquals(hash1, hash2);
});

Deno.test("content_approval_tracker - computeContentHash differs for different content", async () => {
  const hash1 = await computeContentHash("Title A", "Body A");
  const hash2 = await computeContentHash("Title B", "Body B");
  assertNotEquals(hash1, hash2);
});

Deno.test("content_approval_tracker - computeContentHash differs when only title changes", async () => {
  const hash1 = await computeContentHash("Original title", "Same body");
  const hash2 = await computeContentHash("Modified title", "Same body");
  assertNotEquals(hash1, hash2);
});

Deno.test("content_approval_tracker - computeContentHash differs when only body changes", async () => {
  const hash1 = await computeContentHash("Same title", "Original body");
  const hash2 = await computeContentHash("Same title", "Modified body");
  assertNotEquals(hash1, hash2);
});

Deno.test("content_approval_tracker - computeContentHash handles empty strings", async () => {
  const hash = await computeContentHash("", "");
  assertEquals(hash.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(hash), true);
});

Deno.test("content_approval_tracker - computeContentHash does not collide when title/body are re-split (Issue #3878)", async () => {
  // The digest used to be `${title}\n${body}`, so any pair that concatenates
  // to the same string hashed identically — an attacker could move an
  // approved body's first line into the title (or the reverse) and keep the
  // snapshot matching. The encoding is length-prefixed, so the split point is
  // part of what is signed.
  assertNotEquals(
    await computeContentHash("A", "B\nC"),
    await computeContentHash("A\nB", "C"),
  );
  assertNotEquals(
    await computeContentHash("", "title\nbody"),
    await computeContentHash("title", "body"),
  );
  // A field-boundary shift with no newline involved must also be caught.
  assertNotEquals(
    await computeContentHash("ab", "c"),
    await computeContentHash("a", "bc"),
  );
});

Deno.test("content_approval_tracker - computeContentHash is pinned for a known fixture (Issue #3878)", async () => {
  // Pins the v2 encoding. Changing it invalidates every stored approval
  // digest — previously approved issues then verify as `changed` at pickup
  // (fail-closed, but a visible burst of blocks after deploy), so any further
  // change must be deliberate rather than incidental.
  assertEquals(
    await computeContentHash("Fix the bug", "Approved specification"),
    "8bfe0ef8d244abfba3aa34b99396de4b8b8ea2d5fc345790ee5ae28a6232ca05",
  );
});

// ---------------------------------------------------------------------------
// captureContentSnapshot tests
// ---------------------------------------------------------------------------

Deno.test("content_approval_tracker - captureContentSnapshot stores hash on disk", async () => {
  const { deps, files } = createMemoryFs();
  const workDir = "/tmp/test-work";

  const result = await captureContentSnapshot(
    workDir,
    "owner/repo",
    42,
    "Issue title",
    "Issue body",
    "untrusted-user",
    deps,
  );

  assertEquals(result.ok, true);

  // Verify state file was created
  const stateContent = files.get(`${workDir}/.content_approval_state.json`);
  assertEquals(stateContent !== undefined, true);

  const state = JSON.parse(stateContent!);
  const key = "owner/repo|42";
  assertEquals(typeof state.snapshots[key], "object");
  assertEquals(state.snapshots[key].contentHash.length, 64);
  assertEquals(state.snapshots[key].issueAuthor, "untrusted-user");
  assertEquals(typeof state.snapshots[key].capturedAt, "number");
});

Deno.test("content_approval_tracker - captureContentSnapshot overwrites existing snapshot", async () => {
  const { deps } = createMemoryFs();
  const workDir = "/tmp/test-work";

  await captureContentSnapshot(
    workDir,
    "owner/repo",
    42,
    "Title v1",
    "Body v1",
    "user1",
    deps,
  );
  await captureContentSnapshot(
    workDir,
    "owner/repo",
    42,
    "Title v2",
    "Body v2",
    "user1",
    deps,
  );

  const state = await loadContentApprovalState(workDir, deps);
  const key = "owner/repo|42";
  const expectedHash = await computeContentHash("Title v2", "Body v2");
  assertEquals(state.snapshots[key]?.contentHash, expectedHash);
});

// ---------------------------------------------------------------------------
// verifyContentUnchanged tests
// ---------------------------------------------------------------------------

Deno.test("content_approval_tracker - verifyContentUnchanged returns 'unchanged' when content matches", async () => {
  const { deps } = createMemoryFs();
  const workDir = "/tmp/test-work";

  await captureContentSnapshot(
    workDir,
    "owner/repo",
    42,
    "Title",
    "Body",
    "user",
    deps,
  );

  const result = await verifyContentUnchanged(
    workDir,
    "owner/repo",
    42,
    "Title",
    "Body",
    deps,
  );
  assertEquals(result.status, "unchanged");
});

Deno.test("content_approval_tracker - verifyContentUnchanged returns 'changed' when title differs", async () => {
  const { deps } = createMemoryFs();
  const workDir = "/tmp/test-work";

  await captureContentSnapshot(
    workDir,
    "owner/repo",
    42,
    "Original",
    "Body",
    "evil-user",
    deps,
  );

  const result = await verifyContentUnchanged(
    workDir,
    "owner/repo",
    42,
    "Modified",
    "Body",
    deps,
  );
  assertEquals(result.status, "changed");
  if (result.status === "changed") {
    assertEquals(result.issueAuthor, "evil-user");
  }
});

Deno.test("content_approval_tracker - verifyContentUnchanged returns 'changed' when body differs", async () => {
  const { deps } = createMemoryFs();
  const workDir = "/tmp/test-work";

  await captureContentSnapshot(
    workDir,
    "owner/repo",
    42,
    "Title",
    "Original body",
    "evil-user",
    deps,
  );

  const result = await verifyContentUnchanged(
    workDir,
    "owner/repo",
    42,
    "Title",
    "Modified body",
    deps,
  );
  assertEquals(result.status, "changed");
  if (result.status === "changed") {
    assertEquals(result.issueAuthor, "evil-user");
  }
});

Deno.test("content_approval_tracker - verifyContentUnchanged returns 'no_snapshot' for unknown issue", async () => {
  const { deps } = createMemoryFs();
  const workDir = "/tmp/test-work";

  const result = await verifyContentUnchanged(
    workDir,
    "owner/repo",
    99,
    "Title",
    "Body",
    deps,
  );
  assertEquals(result.status, "no_snapshot");
});

Deno.test("content_approval_tracker - verifyContentUnchanged returns 'no_snapshot' when no state file exists", async () => {
  const { deps } = createMemoryFs();
  const workDir = "/tmp/nonexistent-dir";

  const result = await verifyContentUnchanged(
    workDir,
    "owner/repo",
    42,
    "Title",
    "Body",
    deps,
  );
  assertEquals(result.status, "no_snapshot");
});

// ---------------------------------------------------------------------------
// isAuthorTrusted tests
// ---------------------------------------------------------------------------

Deno.test("content_approval_tracker - isAuthorTrusted returns true for allowed author", () => {
  assertEquals(isAuthorTrusted("alice", ["alice", "bob"]), true);
});

Deno.test("content_approval_tracker - isAuthorTrusted is case-insensitive", () => {
  assertEquals(isAuthorTrusted("Alice", ["alice"]), true);
  assertEquals(isAuthorTrusted("alice", ["ALICE"]), true);
});

Deno.test("content_approval_tracker - isAuthorTrusted returns false for untrusted author", () => {
  assertEquals(isAuthorTrusted("eve", ["alice", "bob"]), false);
});

Deno.test("content_approval_tracker - isAuthorTrusted returns false for empty allowed list", () => {
  assertEquals(isAuthorTrusted("anyone", []), false);
});

// ---------------------------------------------------------------------------
// removeContentSnapshot tests
// ---------------------------------------------------------------------------

Deno.test("content_approval_tracker - removeContentSnapshot removes existing snapshot", async () => {
  const { deps } = createMemoryFs();
  const workDir = "/tmp/test-work";

  await captureContentSnapshot(
    workDir,
    "owner/repo",
    42,
    "Title",
    "Body",
    "user",
    deps,
  );
  await removeContentSnapshot(workDir, "owner/repo", 42, deps);

  const result = await verifyContentUnchanged(
    workDir,
    "owner/repo",
    42,
    "Title",
    "Body",
    deps,
  );
  assertEquals(result.status, "no_snapshot");
});

Deno.test("content_approval_tracker - removeContentSnapshot is safe on missing snapshot", async () => {
  const { deps } = createMemoryFs();
  const workDir = "/tmp/test-work";

  const result = await removeContentSnapshot(workDir, "owner/repo", 99, deps);
  assertEquals(result.ok, true);
});

// ---------------------------------------------------------------------------
// cleanupStaleSnapshots tests
// ---------------------------------------------------------------------------

Deno.test("content_approval_tracker - cleanupStaleSnapshots removes old snapshots", async () => {
  const { deps, files } = createMemoryFs();
  const workDir = "/tmp/test-work";

  // Pre-populate with a stale snapshot (captured 8 days ago)
  const staleState = {
    snapshots: {
      "owner/repo|1": {
        contentHash: "abc123",
        capturedAt: Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60,
        issueAuthor: "user",
      },
      "owner/repo|2": {
        contentHash: "def456",
        capturedAt: Math.floor(Date.now() / 1000) - 1 * 60 * 60, // 1 hour ago (fresh)
        issueAuthor: "user",
      },
    },
  };
  files.set(
    `${workDir}/.content_approval_state.json`,
    JSON.stringify(staleState),
  );

  const result = await cleanupStaleSnapshots(
    workDir,
    new Set(),
    7 * 24 * 60 * 60,
    deps,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, 1);
  }

  // The fresh snapshot should remain
  const state = await loadContentApprovalState(workDir, deps);
  assertEquals(state.snapshots["owner/repo|2"]?.contentHash, "def456");
  assertEquals(state.snapshots["owner/repo|1"], undefined);
});

Deno.test("content_approval_tracker - cleanupStaleSnapshots removes closed issue snapshots", async () => {
  const { deps, files } = createMemoryFs();
  const workDir = "/tmp/test-work";

  const recentState = {
    snapshots: {
      "owner/repo|1": {
        contentHash: "abc123",
        capturedAt: Math.floor(Date.now() / 1000) - 60, // 1 minute ago (fresh)
        issueAuthor: "user",
      },
    },
  };
  files.set(
    `${workDir}/.content_approval_state.json`,
    JSON.stringify(recentState),
  );

  const closedKeys = new Set(["owner/repo|1"]);
  const result = await cleanupStaleSnapshots(
    workDir,
    closedKeys,
    7 * 24 * 60 * 60,
    deps,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, 1);
  }

  const state = await loadContentApprovalState(workDir, deps);
  assertEquals(state.snapshots["owner/repo|1"], undefined);
});

Deno.test("content_approval_tracker - cleanupStaleSnapshots returns 0 when nothing to clean", async () => {
  const { deps, files } = createMemoryFs();
  const workDir = "/tmp/test-work";

  const freshState = {
    snapshots: {
      "owner/repo|1": {
        contentHash: "abc123",
        capturedAt: Math.floor(Date.now() / 1000),
        issueAuthor: "user",
      },
    },
  };
  files.set(
    `${workDir}/.content_approval_state.json`,
    JSON.stringify(freshState),
  );

  const result = await cleanupStaleSnapshots(
    workDir,
    new Set(),
    7 * 24 * 60 * 60,
    deps,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, 0);
  }
});

// ---------------------------------------------------------------------------
// buildContentModifiedComment tests
// ---------------------------------------------------------------------------

Deno.test("content_approval_tracker - buildContentModifiedComment includes issue number", () => {
  const comment = buildContentModifiedComment(42);
  assertEquals(comment.includes("#42"), true);
  assertEquals(comment.includes("work-on"), true);
  assertEquals(comment.includes("re-approve"), true);
});

Deno.test(
  "content_approval_tracker - buildContentModifiedComment mentions needs-human label (Issue #1740)",
  () => {
    const comment = buildContentModifiedComment(42);
    assertEquals(
      comment.includes("needs-human"),
      true,
      "Default comment should mention the default needs-human label",
    );
  },
);

Deno.test(
  "content_approval_tracker - buildContentModifiedComment honours custom needs-human label",
  () => {
    const comment = buildContentModifiedComment(42, "escalate-me");
    assertEquals(comment.includes("escalate-me"), true);
  },
);

// ---------------------------------------------------------------------------
// loadContentApprovalState tests
// ---------------------------------------------------------------------------

Deno.test("content_approval_tracker - loadContentApprovalState returns empty on missing file", async () => {
  const { deps } = createMemoryFs();
  const state = await loadContentApprovalState("/tmp/nonexistent", deps);
  assertEquals(Object.keys(state.snapshots).length, 0);
});

Deno.test("content_approval_tracker - loadContentApprovalState returns empty on corrupt JSON", async () => {
  const { deps, files } = createMemoryFs();
  const workDir = "/tmp/test-work";
  files.set(`${workDir}/.content_approval_state.json`, "not valid json{");
  const state = await loadContentApprovalState(workDir, deps);
  assertEquals(Object.keys(state.snapshots).length, 0);
});

Deno.test("content_approval_tracker - loadContentApprovalState returns empty on invalid structure", async () => {
  const { deps, files } = createMemoryFs();
  const workDir = "/tmp/test-work";
  files.set(
    `${workDir}/.content_approval_state.json`,
    JSON.stringify({ noSnapshots: true }),
  );
  const state = await loadContentApprovalState(workDir, deps);
  assertEquals(Object.keys(state.snapshots).length, 0);
});

// ---------------------------------------------------------------------------
// Integration scenario: full workflow
// ---------------------------------------------------------------------------

Deno.test("content_approval_tracker - full workflow: capture, verify unchanged, modify, verify changed", async () => {
  const { deps } = createMemoryFs();
  const workDir = "/tmp/test-work";
  const repo = "org/project";
  const issueNumber = 100;

  // Step 1: Capture snapshot at approval time
  const captureResult = await captureContentSnapshot(
    workDir,
    repo,
    issueNumber,
    "Original title",
    "Original body",
    "untrusted-author",
    deps,
  );
  assertEquals(captureResult.ok, true);

  // Step 2: Verify content unchanged (same content)
  const verify1 = await verifyContentUnchanged(
    workDir,
    repo,
    issueNumber,
    "Original title",
    "Original body",
    deps,
  );
  assertEquals(verify1.status, "unchanged");

  // Step 3: Content gets modified by untrusted author
  const verify2 = await verifyContentUnchanged(
    workDir,
    repo,
    issueNumber,
    "Malicious title",
    "Injected instructions",
    deps,
  );
  assertEquals(verify2.status, "changed");
  if (verify2.status === "changed") {
    assertEquals(verify2.issueAuthor, "untrusted-author");
  }
});

Deno.test("content_approval_tracker - multiple issues tracked independently", async () => {
  const { deps } = createMemoryFs();
  const workDir = "/tmp/test-work";

  await captureContentSnapshot(
    workDir,
    "org/repo",
    1,
    "Title 1",
    "Body 1",
    "user-a",
    deps,
  );
  await captureContentSnapshot(
    workDir,
    "org/repo",
    2,
    "Title 2",
    "Body 2",
    "user-b",
    deps,
  );

  // Issue 1 unchanged
  const v1 = await verifyContentUnchanged(
    workDir,
    "org/repo",
    1,
    "Title 1",
    "Body 1",
    deps,
  );
  assertEquals(v1.status, "unchanged");

  // Issue 2 changed
  const v2 = await verifyContentUnchanged(
    workDir,
    "org/repo",
    2,
    "Title 2",
    "Changed body",
    deps,
  );
  assertEquals(v2.status, "changed");

  // Issue 1 still unchanged
  const v1b = await verifyContentUnchanged(
    workDir,
    "org/repo",
    1,
    "Title 1",
    "Body 1",
    deps,
  );
  assertEquals(v1b.status, "unchanged");
});
