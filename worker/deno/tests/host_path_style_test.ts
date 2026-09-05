/**
 * Tests for the two shared containment predicates in `lib/host_path_style.ts`
 * (Issue #978).
 *
 * `isAtOrAbove` moved here from `container_launch.ts`, where it decides which
 * host paths the launcher refuses to mount; `isConfinedRelativePath` moved
 * here from `container_tools_config.ts`, where it confines every `bin`/`env`
 * value to the install prefix. Both are now used by the `container_extension`
 * validator too, so a regression in either would loosen two trust boundaries
 * at once — and neither had a test of its own before.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import { isAtOrAbove, isConfinedRelativePath } from "../lib/host_path_style.ts";

Deno.test("isAtOrAbove - the same directory and an ancestor are both at-or-above", () => {
  assertEquals(isAtOrAbove("/home/op", "/home/op", "posix"), true);
  assertEquals(isAtOrAbove("/home", "/home/op", "posix"), true);
  assertEquals(isAtOrAbove("/", "/home/op", "posix"), false);
});

Deno.test("isAtOrAbove - a sibling or a descendant is not above", () => {
  assertEquals(isAtOrAbove("/home/op/ext", "/home/op", "posix"), false);
  assertEquals(isAtOrAbove("/home/other", "/home/op", "posix"), false);
  // A prefix that is not a path boundary must not count.
  assertEquals(isAtOrAbove("/home/o", "/home/op", "posix"), false);
});

Deno.test("isAtOrAbove - Windows paths compare case- and separator-insensitively", () => {
  assertEquals(
    isAtOrAbove("C:\\Users\\Vibe", "c:/users/vibe/ext", "windows"),
    true,
  );
  assertEquals(
    isAtOrAbove("C:\\Users\\Other", "C:\\Users\\Vibe", "windows"),
    false,
  );
});

Deno.test("isConfinedRelativePath - a relative path inside the directory is allowed", () => {
  assertEquals(isConfinedRelativePath(""), true);
  assertEquals(isConfinedRelativePath("bin"), true);
  assertEquals(isConfinedRelativePath("./bin/start.sh"), true);
  assertEquals(isConfinedRelativePath("a/../b"), true);
});

Deno.test("isConfinedRelativePath - absolute, ~-anchored and NUL values are refused", () => {
  assertEquals(isConfinedRelativePath("/etc/passwd"), false);
  assertEquals(isConfinedRelativePath("~/start.sh"), false);
  assertEquals(isConfinedRelativePath("bin\0/start.sh"), false);
});

Deno.test("isConfinedRelativePath - a value walking above the directory is refused", () => {
  assertEquals(isConfinedRelativePath("../start.sh"), false);
  assertEquals(isConfinedRelativePath("bin/../../start.sh"), false);
});

Deno.test("isConfinedRelativePath - the Windows spelling escapes the same way", () => {
  assertEquals(isConfinedRelativePath("build\\Containerfile", "windows"), true);
  assertEquals(isConfinedRelativePath("..\\..\\start.ps1", "windows"), false);
  assertEquals(isConfinedRelativePath("D:\\evil\\start.ps1", "windows"), false);
  assertEquals(isConfinedRelativePath("\\evil\\start.ps1", "windows"), false);
  // POSIX keeps its own spelling: a backslash is an ordinary character there.
  assertEquals(isConfinedRelativePath("..\\..\\start.sh", "posix"), true);
});
