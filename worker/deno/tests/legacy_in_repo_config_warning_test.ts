/**
 * Tests for legacy in-repo config detection (Issue #2626).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  isLegacyInRepoConfigPresent,
  LEGACY_IN_REPO_CONFIG_FILENAME,
  LEGACY_IN_REPO_CONFIG_WARNING,
} from "../lib/legacy_in_repo_config_warning.ts";

Deno.test("isLegacyInRepoConfigPresent - true when .vibecoder.json exists", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/${LEGACY_IN_REPO_CONFIG_FILENAME}`,
      '{"skip_screenshot_check": true}\n',
    );
    assertEquals(await isLegacyInRepoConfigPresent(dir), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isLegacyInRepoConfigPresent - false when file absent", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await isLegacyInRepoConfigPresent(dir), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isLegacyInRepoConfigPresent - false when path is a directory not a file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/${LEGACY_IN_REPO_CONFIG_FILENAME}`);
    assertEquals(await isLegacyInRepoConfigPresent(dir), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isLegacyInRepoConfigPresent - false for non-existent repo path", async () => {
  assertEquals(
    await isLegacyInRepoConfigPresent("/no/such/path/xyz-2626"),
    false,
  );
});

Deno.test("LEGACY_IN_REPO_CONFIG_WARNING - names operator-side equivalent", () => {
  assertStringIncludes(LEGACY_IN_REPO_CONFIG_WARNING, ".config.json");
  assertStringIncludes(LEGACY_IN_REPO_CONFIG_WARNING, "repo_config");
  assert(
    LEGACY_IN_REPO_CONFIG_WARNING.includes(LEGACY_IN_REPO_CONFIG_FILENAME),
  );
});
