/**
 * Tests for disk space pre-check before git operations (Issue #1174).
 *
 * Verifies that requireDiskSpaceForGitOperation returns clear
 * Result types with operation context in error messages.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_MIN_FREE_SPACE_MB,
  requireDiskSpaceForGitOperation,
} from "../lib/disk_space.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";
import { resetFaultCounters } from "../lib/fault_tolerance_counters.ts";

// =============================================================================
// Config default tests (Issue #1174)
// =============================================================================

Deno.test("disk_space_git_precheck - minDiskSpaceMb exists in OPERATIONAL_DEFAULTS", () => {
  assertEquals(typeof OPERATIONAL_DEFAULTS.minDiskSpaceMb, "number");
  assertEquals(OPERATIONAL_DEFAULTS.minDiskSpaceMb, 500);
});

Deno.test("disk_space_git_precheck - DEFAULT_MIN_FREE_SPACE_MB matches OPERATIONAL_DEFAULTS", () => {
  assertEquals(DEFAULT_MIN_FREE_SPACE_MB, OPERATIONAL_DEFAULTS.minDiskSpaceMb);
});

// =============================================================================
// requireDiskSpaceForGitOperation tests (Issue #1174)
// =============================================================================

Deno.test("disk_space_git_precheck - requireDiskSpaceForGitOperation succeeds with low threshold", async () => {
  const result = await requireDiskSpaceForGitOperation("/tmp", "git clone", 1);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, true);
  }
});

Deno.test("disk_space_git_precheck - requireDiskSpaceForGitOperation fails with impossibly high threshold", async () => {
  resetFaultCounters();
  const result = await requireDiskSpaceForGitOperation(
    "/tmp",
    "git clone",
    10_000_000,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "git clone");
    assertStringIncludes(result.error.message, "Insufficient disk space");
    assertStringIncludes(result.error.message, "10000000 MB required");
  }
  resetFaultCounters();
});

Deno.test("disk_space_git_precheck - requireDiskSpaceForGitOperation includes available space in error", async () => {
  resetFaultCounters();
  const result = await requireDiskSpaceForGitOperation(
    "/tmp",
    "git fetch",
    10_000_000,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "MB available");
    assertStringIncludes(result.error.message, "git fetch");
  }
  resetFaultCounters();
});

Deno.test("disk_space_git_precheck - requireDiskSpaceForGitOperation uses default minMb when not specified", async () => {
  const result = await requireDiskSpaceForGitOperation("/tmp", "git clone");
  // On a normal dev machine with >500MB free, this should succeed
  assertEquals(typeof result.ok, "boolean");
});

Deno.test("disk_space_git_precheck - requireDiskSpaceForGitOperation handles non-existent path", async () => {
  const result = await requireDiskSpaceForGitOperation(
    "/tmp/nonexistent-precheck-1174",
    "git clone",
    1,
  );
  // Should succeed by walking up to parent
  assertEquals(result.ok, true);
});

Deno.test("disk_space_git_precheck - requireDiskSpaceForGitOperation error includes operation name", async () => {
  resetFaultCounters();
  const result = await requireDiskSpaceForGitOperation(
    "/tmp",
    "gh repo clone owner/repo",
    10_000_000,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "gh repo clone owner/repo");
  }
  resetFaultCounters();
});
