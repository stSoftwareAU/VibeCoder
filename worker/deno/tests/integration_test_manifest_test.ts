/**
 * Issue #907: the integration manifest must match reality, both ways.
 *
 * Thirteen suites copy the repository's own `.sh`/`.ps1` into a temp tree,
 * stub a `PATH` and spawn them. They cost roughly 12 of the gate's ~36
 * minutes and ran on every change — including changes that cannot reach
 * them. #891 was found exactly that way, by a diff touching only
 * `prompts/**`, which then failed on container problems it could not have
 * caused.
 *
 * The gate now excludes them by manifest. A manifest can drift, and drift
 * here is silent in the dangerous direction: a unit test wrongly listed stops
 * running on every change and nobody notices. So this test asserts the
 * manifest and the classifier agree in **both** directions — the same
 * totality trick `SKIP_REASON_CLEARING` uses, and the trap that a stale
 * `HOME_WORKDIR_ALLOWLIST` entry sprang on #805 and again on #808.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  INTEGRATION_TEST_FILES,
  integrationTestIgnoreArg,
  isIntegrationTestSource,
} from "../lib/integration_test_manifest.ts";

const TESTS_DIR = new URL(".", import.meta.url).pathname;

/** Test files that drive one of the repository's own scripts, right now. */
async function detected(): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(TESTS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    // This file names the pattern in its own prose.
    if (entry.name === "integration_test_manifest_test.ts") continue;
    const source = await Deno.readTextFile(`${TESTS_DIR}/${entry.name}`);
    if (isIntegrationTestSource(source)) found.push(`tests/${entry.name}`);
  }
  return found.sort();
}

Deno.test("integration manifest - no script-driving test is missing from it (Issue #907)", async () => {
  const listed = new Set(INTEGRATION_TEST_FILES);
  const missing = (await detected()).filter((f) => !listed.has(f));
  assertEquals(
    missing,
    [],
    "these tests drive the repository's own scripts but are not in " +
      "INTEGRATION_TEST_FILES, so the gate still pays for them on every " +
      "change:\n" + missing.join("\n"),
  );
});

Deno.test("integration manifest - it holds nothing that stopped being one (Issue #907)", async () => {
  // The dangerous direction: a unit test left in the list is excluded from
  // every gate run, silently. A stale exemption is how #805 lost two runs.
  const found = new Set(await detected());
  const stale = INTEGRATION_TEST_FILES.filter((f) => !found.has(f));
  assertEquals(
    stale,
    [],
    "these are listed as integration tests but no longer drive a repository " +
      "script — remove them so they run in the gate again:\n" +
      stale.join("\n"),
  );
});

Deno.test("integration manifest - every listed file exists (Issue #907)", async () => {
  const missing: string[] = [];
  for (const file of INTEGRATION_TEST_FILES) {
    try {
      await Deno.stat(`${TESTS_DIR}/../${file}`);
    } catch {
      missing.push(file);
    }
  }
  assertEquals(
    missing,
    [],
    "a manifest entry naming a deleted file makes `--ignore` silently " +
      "meaningless: " + missing.join(", "),
  );
});

Deno.test("integration manifest - the ignore argument is well formed (Issue #907)", () => {
  const arg = integrationTestIgnoreArg();
  assert(arg.length > 0, "an empty --ignore would exclude nothing");
  assertEquals(arg.split(",").length, INTEGRATION_TEST_FILES.length);
  for (const path of arg.split(",")) {
    assert(
      path.startsWith("tests/") && path.endsWith(".ts"),
      `paths are relative to worker/deno and must name a test file: ${path}`,
    );
  }
});
