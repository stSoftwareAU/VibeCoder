/**
 * Tests for the config integration smoke script (Issue #3490).
 *
 * `allowed_authors` is optional since #1066, so load-config may legitimately
 * render `ALLOWED_AUTHORS=()`. The smoke script must accept that, and fail
 * only when load-config never assigns ALLOWED_AUTHORS at all.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { configSmokeScript } from "../lib/quality_gate.ts";

/** Run the smoke script against a fake deno that prints `loadConfigOutput`. */
async function runSmoke(
  loadConfigOutput: string,
): Promise<{ code: number; stdout: string }> {
  const tmpDir = await Deno.makeTempDir({ prefix: "config-smoke-" });
  try {
    const fakeDeno = `${tmpDir}/fake-deno`;
    await Deno.writeTextFile(
      fakeDeno,
      `#!/usr/bin/env bash\ncat <<'EOF'\n${loadConfigOutput}\nEOF\n`,
    );
    await Deno.chmod(fakeDeno, 0o755);
    const out = await new Deno.Command("bash", {
      args: ["-c", configSmokeScript(tmpDir, fakeDeno)],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
    };
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("configSmokeScript - empty ALLOWED_AUTHORS assigned by load-config passes", async () => {
  const { code, stdout } = await runSmoke(
    'REPOS=("acme/widget")\nALLOWED_AUTHORS=()',
  );
  assertEquals(code, 0, stdout);
  assertStringIncludes(stdout, "OK: 1 repo(s), 0 author(s)");
});

Deno.test("configSmokeScript - ALLOWED_AUTHORS never assigned fails", async () => {
  const { code, stdout } = await runSmoke('REPOS=("acme/widget")');
  assertEquals(code, 1, stdout);
  assertStringIncludes(stdout, "ALLOWED_AUTHORS was not assigned");
});

Deno.test("configSmokeScript - empty REPOS fails", async () => {
  const { code, stdout } = await runSmoke(
    'REPOS=()\nALLOWED_AUTHORS=("alice")',
  );
  assertEquals(code, 1, stdout);
  assertStringIncludes(stdout, "REPOS is empty");
});

Deno.test("configSmokeScript - populated authors pass", async () => {
  const { code, stdout } = await runSmoke(
    'REPOS=("acme/widget")\nALLOWED_AUTHORS=("alice" "bob")',
  );
  assertEquals(code, 0, stdout);
  assertStringIncludes(stdout, "OK: 1 repo(s), 2 author(s)");
});

Deno.test("configSmokeScript - a single real author passes", async () => {
  const { code, stdout } = await runSmoke(
    'REPOS=("acme/widget")\nALLOWED_AUTHORS=("solo")',
  );
  assertEquals(code, 0, stdout);
  assertStringIncludes(stdout, "OK: 1 repo(s), 1 author(s)");
});
