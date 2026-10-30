/**
 * Issue #1598: the `run.ps1` launcher suites are inside the gate, provably.
 *
 * They were outside it for a reason that has since been fixed. Issue #971
 * measured them on a host with PowerShell installed and found eighteen
 * test-side defects — sixteen of them one resolver bug, none of them a race —
 * and #907 kept every script-driving suite out of the gate because the
 * prerequisite it needs, a provisioned interpreter, is not one the gate can
 * count on. Issue #1596 baked PowerShell 7 into the container image, so the
 * worker's own gate now has that interpreter at `/usr/local/bin/pwsh` and the
 * exclusion has outlived its reason.
 *
 * What this file pins is the half a manifest cannot state on its own:
 *
 * - every suite that drives `run.ps1` is in the gate's path, not in its
 *   `--ignore` — read off the tree, never off the manifest, so re-excluding
 *   one and dropping its `IN_GATE_SCRIPT_SUITES` entry together still fails;
 * - every other suite that starts a PowerShell interpreter is placed
 *   deliberately rather than left wherever it happened to be; and
 * - a host without PowerShell **fails** here rather than letting those
 *   suites report "ignored" while the gate reports green. A skipped test is
 *   not a passed one, and the gate that cannot tell the difference is the
 *   one nobody reads.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  IN_GATE_SCRIPT_SUITES,
  INTEGRATION_TEST_FILES,
  integrationTestIgnoreArg,
} from "../lib/integration_test_manifest.ts";
import { PWSH } from "./fixtures/launcher_harness.ts";

const TESTS_DIR = new URL(".", import.meta.url).pathname;

/**
 * Naming a resolved PowerShell interpreter — the whole signal.
 *
 * Since Issue #971 there is one resolver, `tests/support/pwsh.ts`, and one
 * name for what it returns, so "does this suite drive PowerShell?" is
 * answerable by reading a file rather than by trusting a hand-kept list.
 *
 * The match is on the *interpreter*, never on the word `pwsh`: several suites
 * discuss PowerShell in prose or quote a `pwsh` path inside a string, and one
 * of them, `setup_scheduled_task_test.ts`, is a gate unit test precisely
 * because quoting a path is not starting a process. Importing the launcher
 * harness is not the signal either — `outcome_record_gate_test.ts` takes only
 * `REPO_ROOT` from it and drives nothing.
 */
const POWERSHELL_INTERPRETER =
  /\b(resolvePowerShell|POWERSHELL_LAUNCHER|PWSH)\b/;

/**
 * Naming the launcher this issue is about.
 *
 * Paired with {@link POWERSHELL_INTERPRETER} it reads "starts PowerShell to
 * drive `run.ps1`", which is the set Issue #1598 brought into the gate. It is
 * taken from the tree rather than from `IN_GATE_SCRIPT_SUITES` on purpose:
 * an assertion that only checks what the manifest names is one a change can
 * satisfy by deleting the entry it was meant to protect.
 */
const RUN_PS1 = /run\.ps1/;

/** Whether `file` starts a PowerShell interpreter. */
async function drivesPowerShell(file: string): Promise<boolean> {
  const source = await Deno.readTextFile(`${TESTS_DIR}/${file}`);
  return POWERSHELL_INTERPRETER.test(source);
}

/** Every test file that starts PowerShell to drive `run.ps1`, right now. */
async function runPs1Suites(): Promise<string[]> {
  const found: string[] = [];
  for (const file of await powerShellSuites()) {
    const source = await Deno.readTextFile(`${TESTS_DIR}/../${file}`);
    if (RUN_PS1.test(source)) found.push(file);
  }
  return found;
}

/** Every test file that starts a PowerShell interpreter, right now. */
async function powerShellSuites(): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(TESTS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    // This file names the seam in its own prose.
    if (entry.name === "pwsh_suites_in_the_gate_test.ts") continue;
    if (await drivesPowerShell(entry.name)) found.push(`tests/${entry.name}`);
  }
  return found.sort();
}

Deno.test("pwsh suites - every run.ps1 suite is in the gate (Issue #1598)", async () => {
  // The set comes off the tree, so the exclusion returning fails here even
  // if the manifest entry that named the suite goes with it. Both readings
  // of "excluded" are checked: the list, and the `--ignore` argument
  // `quality_gate.ts` actually passes.
  const suites = await runPs1Suites();
  assert(
    suites.length >= 3,
    "no suite in tests/ starts PowerShell to drive run.ps1 any more — this " +
      "file has outlived what it records, or the suites were deleted",
  );
  const excluded = new Set(INTEGRATION_TEST_FILES);
  const ignored = new Set(integrationTestIgnoreArg().split(","));
  const stillOut = suites.filter((file) =>
    excluded.has(file) || ignored.has(file)
  );
  assertEquals(
    stillOut,
    [],
    "these drive run.ps1 and the gate excludes them, so the Windows " +
      "containment boundary is verified only in a CI job that cannot block " +
      "a merge (Issue #1598):\n" + stillOut.join("\n"),
  );
});

Deno.test("pwsh suites - the manifest names exactly those suites (Issue #1598)", async () => {
  // The manifest is what carries the reason and the measured cost, so it
  // has to agree with the tree in both directions: an entry for a suite
  // that drives nothing is an exception nobody needed, and a run.ps1 suite
  // with no entry is one the gate pays for with no reason recorded.
  assertEquals(
    [...IN_GATE_SCRIPT_SUITES.keys()].sort(),
    await runPs1Suites(),
  );
});

Deno.test("pwsh suites - a host without PowerShell fails the gate (Issue #1598)", () => {
  // The exact value the three suites gate their cases on, so this cannot
  // pass while they quietly report "ignored". `resolvePowerShell` tries
  // `$env:VIBE_PWSH` first, which is the remedy for a host that keeps the
  // interpreter somewhere `PATH` does not name.
  assert(
    PWSH !== null,
    "no PowerShell 7 on this host, so the run.ps1 launcher suites would " +
      "skip and the gate would report green having verified nothing about " +
      "the Windows containment boundary. Install PowerShell 7 (the worker " +
      "container ships it at /usr/local/bin/pwsh — Issue #1596) or set " +
      "VIBE_PWSH to its absolute path.",
  );
});

Deno.test("pwsh suites - every other one is placed deliberately (Issue #1598)", async () => {
  // The `setup.ps1` suites stay out of the gate, and staying out is a
  // decision with an owner rather than a default: a new PowerShell-driving
  // suite fails here until it is put in one list or the other.
  const inGate = new Set(IN_GATE_SCRIPT_SUITES.keys());
  const excluded = new Set(INTEGRATION_TEST_FILES);
  const unplaced = (await powerShellSuites()).filter((file) =>
    !inGate.has(file) && !excluded.has(file)
  );
  assertEquals(
    unplaced,
    [],
    "these start a PowerShell interpreter and are in neither " +
      "IN_GATE_SCRIPT_SUITES nor INTEGRATION_TEST_FILES, so nobody decided " +
      "whether the gate should pay for them:\n" + unplaced.join("\n"),
  );
});

Deno.test("pwsh suites - naming an interpreter is not driving one (Issue #971)", async () => {
  // The fourth file the #944 trial counted. `setup_scheduled_task_test.ts`
  // asserts on the XML a Windows scheduled task registers, which quotes a
  // PowerShell path as a string — it never starts one, which is why it is in
  // the gate and belongs there. Kept as a test because the distinction is
  // exactly the one the trial lost: a suite that grows a real spawn has to
  // be placed deliberately, and this fails until it is.
  const file = "setup_scheduled_task_test.ts";
  const source = await Deno.readTextFile(`${TESTS_DIR}/${file}`);
  assert(
    source.includes("pwsh"),
    `${file} no longer mentions PowerShell at all — this test has outlived ` +
      `what it records and should be dropped`,
  );
  assertEquals(
    await drivesPowerShell(file),
    false,
    `${file} now starts a PowerShell interpreter, so it needs a place: ` +
      `IN_GATE_SCRIPT_SUITES or INTEGRATION_TEST_FILES`,
  );
});
