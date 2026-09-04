/**
 * Issue #971: the PowerShell suites are outside the gate, and provably so.
 *
 * `parallel_safety_cap_test.ts` records a `DENO_JOBS=4` trial of 48 failures,
 * "of which 32 were the pre-existing pwsh failures and ~16 were genuine
 * races". The 32 have been quoted since as debt the `--parallel` migration
 * (#944) must clear. They are not: they are not races, and as of #907 they are
 * not in the gate's path either.
 *
 * **Measured on a host with PowerShell 7.6.5 installed, at `ef5509c`.** The
 * three suites that drive a `.ps1`, run on their own:
 *
 * | Run | Passed | Failed |
 * |---|---:|---:|
 * | serial (`deno test`) | 38 | **18** |
 * | `deno test --parallel` | 39 | **17** |
 *
 * Not 32, and parallelism made it *fewer*, never more — the one difference is
 * a timing-sensitive test that happened to come in under its bound in the
 * parallel run. Every failure reproduced when its file was run alone, which
 * is what "not a race" means: no other test had to be running for it to fail.
 *
 * The 18 were two findings with two different owners, and lumping them
 * together is what kept them unexplained:
 *
 * - **16 were the host lacking the interpreter — on a `PATH` the test built
 *   itself.** `setup_ps1_test.ts` resolved `pwsh` against the developer's
 *   `PATH` and then spawned it with `clearEnv: true` and
 *   `PATH: "/usr/bin:/bin"`. Where PowerShell is `/usr/bin/pwsh`, as on the CI
 *   runner, that works by luck; where Homebrew puts it, every case died with
 *   `NotFound: Failed to spawn 'pwsh'`. `tests/support/pwsh.ts` now resolves
 *   the interpreter to an absolute path once, for all three suites.
 * - **2 were the test's own clock, not the launcher's.** Both `run.ps1` cases
 *   timed the whole launcher run — image inspection, store prune, two volume
 *   creations — against a bound meant for the container's watchdog deadline,
 *   and one read a five-second quiet slice as end-of-stream. Neither is a
 *   `run.ps1` defect: the launcher reaped on its 2s deadline in every run.
 *
 * None of the 18 was a race. All 18 now pass.
 *
 * What this file then pins is the second half: the gate's `deno test` stage
 * never loads these suites, so #944's batches can never be gated on them.
 * A new PowerShell-driving suite added to the gate's path fails here rather
 * than by turning a seam migration red for a reason it has nothing to do with.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  INTEGRATION_TEST_FILES,
  integrationTestIgnoreArg,
} from "../lib/integration_test_manifest.ts";

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

/** Whether `file` starts a PowerShell interpreter. */
async function drivesPowerShell(file: string): Promise<boolean> {
  const source = await Deno.readTextFile(`${TESTS_DIR}/${file}`);
  return POWERSHELL_INTERPRETER.test(source);
}

/** Every test file that starts a PowerShell interpreter, right now. */
async function powerShellSuites(): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(TESTS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    // This file names the seam in its own prose.
    if (entry.name === "pwsh_suites_outside_the_gate_test.ts") continue;
    if (await drivesPowerShell(entry.name)) found.push(`tests/${entry.name}`);
  }
  return found.sort();
}

Deno.test("pwsh suites - every one of them is excluded from the gate (Issue #971)", async () => {
  const listed = new Set(INTEGRATION_TEST_FILES);
  const inTheGate = (await powerShellSuites()).filter((f) => !listed.has(f));
  assertEquals(
    inTheGate,
    [],
    "these suites start a PowerShell interpreter but are not in " +
      "INTEGRATION_TEST_FILES, so the gate runs them on every change — and a " +
      "host without PowerShell, or with it somewhere unexpected, then fails " +
      "the gate for work that cannot reach them (Issue #907):\n" +
      inTheGate.join("\n"),
  );
});

Deno.test("pwsh suites - the gate's own --ignore names them (Issue #971)", async () => {
  // The measurement behind the claim, taken from the argument
  // `quality_gate.ts` actually passes rather than from the list behind it.
  const ignored = new Set(integrationTestIgnoreArg().split(","));
  const missing = (await powerShellSuites()).filter((f) => !ignored.has(f));
  assertEquals(
    missing,
    [],
    "the gate's `deno test --ignore` does not name these, so its unit stage " +
      "would load them:\n" + missing.join("\n"),
  );
});

Deno.test("pwsh suites - naming an interpreter is not driving one (Issue #971)", async () => {
  // The fourth file the #944 trial counted. `setup_scheduled_task_test.ts`
  // asserts on the XML a Windows scheduled task registers, which quotes a
  // PowerShell path as a string — it never starts one, which is why it is in
  // the gate and belongs there. Kept as a test because the distinction is
  // exactly the one the trial lost: a suite that grows a real spawn has to
  // move to the integration manifest, and this fails until it does.
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
    `${file} now starts a PowerShell interpreter, so it is an integration ` +
      `test: add it to INTEGRATION_TEST_FILES`,
  );
});
