/**
 * Tests for interactive_login_scanner.ts — the "no interactive login on the
 * runtime path" invariant (Issue #4064, parent #4060).
 *
 * The scanner is exercised behaviourally: literal file contents for the
 * content scanner, a temporary fixture tree for the walk, and the real
 * production tree for the invariant itself.
 *
 * Australian English spelling throughout (behaviour, authorised).
 */

import { assertEquals } from "@std/assert";
import {
  RUNTIME_SCAN_PATHS,
  scanContentForInteractiveLogin,
  scanRuntimePathsForInteractiveLogin,
} from "../lib/interactive_login_scanner.ts";

Deno.test("scanContentForInteractiveLogin - flags a gh auth login argument array", () => {
  const violations = scanContentForInteractiveLogin(
    [
      "export async function login() {",
      '  return await spawnGh(["auth", "login"]);',
      "}",
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 2);
  assertEquals(violations[0]?.kind, "gh-auth-login");
});

Deno.test("scanContentForInteractiveLogin - flags a provider login spawn and a Keychain lookup", () => {
  const violations = scanContentForInteractiveLogin(
    [
      'const a = new Deno.Command("claude", { args: ["login"] });',
      'const b = new Deno.Command("security", {',
      '  args: ["find-generic-password", "-s", "vibe"],',
      "});",
    ].join("\n"),
    "worker/deno/lib/example.ts",
  );
  assertEquals(violations.map((v) => v.kind), [
    "provider-login",
    "keychain",
    "keychain",
  ]);
});

Deno.test("scanContentForInteractiveLogin - flags a shell login on the runtime path", () => {
  const violations = scanContentForInteractiveLogin(
    [
      "#!/bin/bash",
      "# The worker must never run gh auth login here.",
      'GH_CONFIG_DIR="$dir" gh auth login',
      "claude login || exit 1",
      "gh auth status",
    ].join("\n"),
    "run.sh",
  );
  assertEquals(violations.map((v) => v.line), [3, 4]);
  assertEquals(violations.map((v) => v.kind), [
    "gh-auth-login",
    "provider-login",
  ]);
});

Deno.test("scanContentForInteractiveLogin - classification strings and prose are not invocations", () => {
  const violations = scanContentForInteractiveLogin(
    [
      "/**",
      " * Detects when a `claude login` is required, or `gh auth login`.",
      " */",
      'const AUTH_PATTERNS = ["not logged in", "claude login"];',
      'export const fix = "Claude CLI login required — run: claude login";',
      "// legacy: gh auth login was run here",
      'const args = ["auth", "status"];',
    ].join("\n"),
    "worker/deno/lib/claude_auth.ts",
  );
  assertEquals(violations, []);
});

Deno.test("scanRuntimePathsForInteractiveLogin - walks directories and single files", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmpDir}/worker/deno/lib`, { recursive: true });
    await Deno.writeTextFile(
      `${tmpDir}/worker/deno/lib/good.ts`,
      'const args = ["auth", "status"];\n',
    );
    await Deno.writeTextFile(
      `${tmpDir}/worker/deno/lib/bad.ts`,
      'await spawnGh(["auth", "login"]);\n',
    );
    await Deno.writeTextFile(`${tmpDir}/run.sh`, "gh auth login\n");
    // Not scanned: unknown extension, and a path outside the scan set.
    await Deno.writeTextFile(`${tmpDir}/notes.md`, "gh auth login\n");
    await Deno.writeTextFile(`${tmpDir}/setup.sh`, "gh auth login\n");

    const result = await scanRuntimePathsForInteractiveLogin(tmpDir, [
      "worker/deno/lib",
      "run.sh",
      "notes.md",
      "container/entrypoint.sh",
    ]);

    assertEquals(result.filesScanned, 2 + 1);
    assertEquals(
      result.violations.map((v) => v.file).sort(),
      ["run.sh", "worker/deno/lib/bad.ts"],
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("scanRuntimePathsForInteractiveLogin - missing paths yield no violations", async () => {
  const result = await scanRuntimePathsForInteractiveLogin(
    "/nonexistent-root-xyz",
  );
  assertEquals(result.filesScanned, 0);
  assertEquals(result.violations, []);
});

// The production tree must satisfy the invariant this scanner enforces:
// no runtime code path invokes an interactive login or a Keychain lookup.
Deno.test("scanRuntimePathsForInteractiveLogin - the runtime path has no interactive logins", async () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const result = await scanRuntimePathsForInteractiveLogin(
    repoRoot,
    RUNTIME_SCAN_PATHS,
  );
  assertEquals(
    result.violations.map((v) => `${v.file}:${v.line} [${v.kind}]`),
    [],
  );
  // Guard against a silently empty scan (a moved directory would pass).
  assertEquals(result.filesScanned > 100, true);
});
