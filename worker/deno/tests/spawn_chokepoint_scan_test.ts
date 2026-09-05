/**
 * Tests for the scanning machinery shared by the `gh` and `git` spawn
 * chokepoint checks (Issue #1214).
 *
 * The two checks supply their own literal pattern and allowlist; everything
 * below is the behaviour they share, exercised directly against literal
 * content and real temporary directories.
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import {
  scanContentForDirectSpawn,
  scanDirectoriesForDirectSpawn,
} from "../lib/spawn_chokepoint_scan.ts";

const DOCKER_SPAWN = /new\s+Deno\.Command\s*\(\s*["'`]docker["'`]/;

Deno.test("scanContentForDirectSpawn - records the line and the trimmed text", () => {
  const violations = scanContentForDirectSpawn(
    [
      "export function run() {",
      '  return new Deno.Command("docker", { args: ["ps"] });',
      "}",
    ].join("\n"),
    "worker/deno/lib/example.ts",
    DOCKER_SPAWN,
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]?.line, 2);
  assertEquals(
    violations[0]?.text,
    'return new Deno.Command("docker", { args: ["ps"] });',
  );
});

Deno.test("scanContentForDirectSpawn - a pattern that does not match yields nothing", () => {
  const violations = scanContentForDirectSpawn(
    'const c = new Deno.Command("podman", { args });',
    "worker/deno/lib/example.ts",
    DOCKER_SPAWN,
  );
  assertEquals(violations, []);
});

Deno.test("scanDirectoriesForDirectSpawn - excludeTests skips co-located test files", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmpDir}/src/nested`, { recursive: true });
    const spawn = 'const c = new Deno.Command("docker", { args });\n';
    await Deno.writeTextFile(`${tmpDir}/src/a.ts`, spawn);
    await Deno.writeTextFile(`${tmpDir}/src/nested/b.ts`, spawn);
    await Deno.writeTextFile(`${tmpDir}/src/c_test.ts`, spawn);
    await Deno.writeTextFile(`${tmpDir}/src/allowed.ts`, spawn);

    const withTests = await scanDirectoriesForDirectSpawn(tmpDir, ["src"], {
      pattern: DOCKER_SPAWN,
      allowlist: new Set(["src/allowed.ts"]),
    });
    assertEquals(withTests.filesScanned, 3);
    assertEquals(withTests.violations.length, 3);

    const withoutTests = await scanDirectoriesForDirectSpawn(tmpDir, ["src"], {
      pattern: DOCKER_SPAWN,
      allowlist: new Set(["src/allowed.ts"]),
      excludeTests: true,
    });
    assertEquals(
      withoutTests.violations.map((v) => v.file).sort(),
      ["src/a.ts", "src/nested/b.ts"],
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
