/**
 * Tests for worker build/version stamping (Issue #3138).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  formatBuildBanner,
  formatBuildStamp,
  getWorkerBuildInfo,
} from "../lib/worker_build_info.ts";

Deno.test("getWorkerBuildInfo - reads commit from VIBE_BUILD_COMMIT", () => {
  const info = getWorkerBuildInfo(
    "1.2.3",
    (k) => k === "VIBE_BUILD_COMMIT" ? "abcdef0123456789" : undefined,
  );
  assertEquals(info.version, "1.2.3");
  assertEquals(info.commit, "abcdef0123456789");
});

Deno.test("getWorkerBuildInfo - unset commit is 'unknown'", () => {
  const info = getWorkerBuildInfo("1.2.3", () => undefined);
  assertEquals(info.commit, "unknown");
});

Deno.test("getWorkerBuildInfo - blank commit is 'unknown'", () => {
  const info = getWorkerBuildInfo("1.2.3", () => "   ");
  assertEquals(info.commit, "unknown");
});

Deno.test("getWorkerBuildInfo - blank version is 'unknown'", () => {
  const info = getWorkerBuildInfo("", () => "abc");
  assertEquals(info.version, "unknown");
});

Deno.test("formatBuildStamp - truncates long commit to 12 chars", () => {
  const stamp = formatBuildStamp({
    version: "1.2.3",
    commit: "abcdef0123456789deadbeef",
  });
  assertEquals(stamp, "version=1.2.3 commit=abcdef012345");
});

Deno.test("formatBuildStamp - passes through unknown commit verbatim", () => {
  const stamp = formatBuildStamp({ version: "1.2.3", commit: "unknown" });
  assertEquals(stamp, "version=1.2.3 commit=unknown");
});

Deno.test("formatBuildBanner - prefixes with [worker-build]", () => {
  const banner = formatBuildBanner({ version: "1.2.3", commit: "abc123" });
  assertEquals(banner, "[worker-build] version=1.2.3 commit=abc123");
});
