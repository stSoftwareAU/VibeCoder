/**
 * Tests for the worker-private cache directory helpers (Issue #3709,
 * SEC-e70b8134af26).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  cacheDirUserSuffix,
  ensurePrivateDir,
  PRIVATE_DIR_MODE,
  resolveOwnUid,
  verifyPrivateDir,
} from "../lib/private_cache_dir.ts";

Deno.test("private_cache_dir - ensurePrivateDir creates an owner-only directory", async () => {
  const base = await Deno.makeTempDir({ prefix: "private-dir-test-" });
  const dir = `${base}/nested/cache`;
  try {
    await ensurePrivateDir(dir);
    const info = await Deno.stat(dir);
    assertEquals(info.isDirectory, true);
    if (info.mode !== null) {
      assertEquals(
        info.mode & 0o777,
        PRIVATE_DIR_MODE,
        "cache directory must be 0700",
      );
    }
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("private_cache_dir - verifyPrivateDir trusts a freshly created 0700 directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "private-dir-test-" });
  try {
    await ensurePrivateDir(dir);
    const trust = await verifyPrivateDir(dir);
    assertEquals(trust.trusted, true, trust.reason ?? "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("private_cache_dir - verifyPrivateDir rejects a world-writable directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "private-dir-test-" });
  try {
    await Deno.chmod(dir, 0o777);
    const trust = await verifyPrivateDir(dir);
    if ((await Deno.stat(dir)).mode === null) return; // platform without modes
    assertEquals(trust.trusted, false);
    assertStringIncludes(trust.reason ?? "", "group/other accessible");
  } finally {
    await Deno.chmod(dir, 0o700);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("private_cache_dir - verifyPrivateDir rejects a group-readable directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "private-dir-test-" });
  try {
    await Deno.chmod(dir, 0o750);
    const trust = await verifyPrivateDir(dir);
    if ((await Deno.stat(dir)).mode === null) return;
    assertEquals(trust.trusted, false);
  } finally {
    await Deno.chmod(dir, 0o700);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("private_cache_dir - verifyPrivateDir rejects a missing path", async () => {
  const base = await Deno.makeTempDir({ prefix: "private-dir-test-" });
  try {
    const trust = await verifyPrivateDir(`${base}/absent`);
    assertEquals(trust.trusted, false);
    assertStringIncludes(trust.reason ?? "", "cannot stat");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("private_cache_dir - verifyPrivateDir rejects a file", async () => {
  const base = await Deno.makeTempDir({ prefix: "private-dir-test-" });
  const file = `${base}/notadir`;
  try {
    await Deno.writeTextFile(file, "x");
    await Deno.chmod(file, 0o600);
    const trust = await verifyPrivateDir(file);
    assertEquals(trust.trusted, false);
    assertEquals(trust.reason, "not a directory");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("private_cache_dir - cacheDirUserSuffix is non-empty and path-safe", () => {
  const suffix = cacheDirUserSuffix();
  assertEquals(suffix.length > 0, true);
  assertEquals(
    /^[A-Za-z0-9._-]+$/.test(suffix),
    true,
    `suffix must be path-safe, got: ${suffix}`,
  );
});

Deno.test("private_cache_dir - resolveOwnUid matches the owner of a file we create", async () => {
  const base = await Deno.makeTempDir({ prefix: "private-dir-test-" });
  try {
    const uid = resolveOwnUid();
    const ownerUid = (await Deno.stat(base)).uid;
    if (uid === null || ownerUid === null) return; // platform without uids
    assertEquals(uid, ownerUid);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
