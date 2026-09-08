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
  IN_GATE_SCRIPT_SUITES,
  INTEGRATION_TEST_FILES,
  integrationTestIgnoreArg,
  isIntegrationTestSource,
  SCRIPT_READING_UNIT_TESTS,
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
  // Issue #935: a classified file must be placed deliberately, in one list
  // or the other. Being in neither is the failure — it means the gate is
  // paying for a script-driving suite nobody decided to keep.
  const listed = new Set(INTEGRATION_TEST_FILES);
  const missing = (await detected()).filter((f) =>
    !listed.has(f) && !SCRIPT_READING_UNIT_TESTS.has(f) &&
    !IN_GATE_SCRIPT_SUITES.has(f)
  );
  assertEquals(
    missing,
    [],
    "these tests name one of the repository's own scripts but appear in " +
      "none of INTEGRATION_TEST_FILES, SCRIPT_READING_UNIT_TESTS or " +
      "IN_GATE_SCRIPT_SUITES. Add them to the first if they run the " +
      "script, to the second — with a reason — if they only read it, or to " +
      "the third — with a reason — if the gate should run them anyway " +
      "(Issue #1598):\n" + missing.join("\n"),
  );
});

Deno.test("integration manifest - the two lists are disjoint (Issue #935)", () => {
  // A file in both would be excluded from the gate while carrying a note
  // saying it should not be.
  const listed = new Set(INTEGRATION_TEST_FILES);
  const both = [...SCRIPT_READING_UNIT_TESTS.keys()].filter((f) =>
    listed.has(f)
  );
  assertEquals(both, [], "listed as both an integration test and a unit test");
});

Deno.test("integration manifest - no file carries two placements (Issue #1598)", () => {
  // Each pairing is a contradiction of its own: excluded *and* run by the
  // gate is the exception silently undone, and read-only *and* run by the
  // gate means one of the two reasons is wrong. `pwsh_suites_in_the_gate_
  // test.ts` asserts the same for the `--ignore` the gate actually passes,
  // which is derived from INTEGRATION_TEST_FILES.
  const clashes = [...IN_GATE_SCRIPT_SUITES.keys()].filter((f) =>
    INTEGRATION_TEST_FILES.includes(f) || SCRIPT_READING_UNIT_TESTS.has(f)
  );
  assertEquals(
    clashes,
    [],
    "named as a suite the gate runs and placed in another list too:\n" +
      clashes.join("\n"),
  );
});

Deno.test("integration manifest - every in-gate exception is still claimed (Issue #1598)", async () => {
  // The stale direction, as for the read-only list: a suite that stopped
  // driving a script needs no exception, and one left behind is an entry
  // nobody re-reads.
  const found = new Set(await detected());
  const stale = [...IN_GATE_SCRIPT_SUITES.keys()].filter((f) => !found.has(f));
  assertEquals(
    stale,
    [],
    "these are named as script-driving suites the gate runs, but drive no " +
      "repository script any more — drop the entry:\n" + stale.join("\n"),
  );
});

Deno.test("integration manifest - every in-gate exception gives a reason (Issue #1598)", () => {
  // The gate pays for these on every change, so the entry costs a sentence
  // saying what that buys.
  for (const [file, reason] of IN_GATE_SCRIPT_SUITES) {
    assert(
      reason.trim().length > 0,
      `${file} runs in the gate with no reason given`,
    );
  }
});

Deno.test("integration manifest - every read-only exemption is still claimed (Issue #935)", async () => {
  // The stale direction for the second list. A suite that stops naming a
  // script no longer needs an exemption, and one left behind is the same
  // kind of orphan that cost #805 and #808 four runs between them.
  const found = new Set(await detected());
  const stale = [...SCRIPT_READING_UNIT_TESTS.keys()].filter((f) =>
    !found.has(f)
  );
  assertEquals(
    stale,
    [],
    "these carry a read-only exemption but no longer name a repository " +
      "script — drop the entry:\n" + stale.join("\n"),
  );
});

Deno.test("integration manifest - every read-only exemption gives a reason (Issue #935)", () => {
  // The exemption is the dangerous one to grant, so it costs a sentence
  // saying why. An empty reason is an exemption nobody has to justify.
  for (const [file, reason] of SCRIPT_READING_UNIT_TESTS) {
    assert(
      reason.trim().length > 0,
      `${file} is exempted with no reason given`,
    );
  }
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
