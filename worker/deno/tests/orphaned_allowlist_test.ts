/**
 * Issue #883: an allowlist entry for a deleted file must not fail the gate.
 *
 * `HOME_WORKDIR_ALLOWLIST` records, per file, how many HOME-based work-dir
 * constructions are sanctioned. The check was exact in both directions: an
 * entry recording more constructions than were found failed the gate, whether
 * the file had lost a construction **or had been deleted entirely**.
 *
 * Those two are not the same. A file that lost a construction is genuine
 * drift — the inventory is wrong and someone should trim it. A file that no
 * longer exists cannot construct anything, so its entry cannot hide a
 * violation; the safety property the check exists for is untouched.
 *
 * The distinction matters because the invariant spans **two files**. A branch
 * that deletes the module and a branch that still carries its entry are each
 * internally consistent, while their merge is not — git resolves the deletion
 * and the untouched entry independently, with no conflict to report. `main`
 * and `milestone/fleet-logs` sat in exactly that state over `fleet_health.ts`:
 *
 * ```text
 * main                  fleet_health.ts EXISTS   home_workdir_check.ts: 1 entry
 * milestone/fleet-logs  fleet_health.ts GONE     home_workdir_check.ts: 0 entries
 * ```
 *
 * Any branch combining them got the file gone and the entry kept, and the
 * gate failed. That cost #805 two runs and #808 two more — four runs, none of
 * which had changed anything wrong, and #808 was left `failed` and unclaimable.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { scanDirectoriesForHomeWorkDir } from "../lib/home_workdir_check.ts";

/** A tree with one real source file, and an allowlist naming it plus a ghost. */
async function fixture(
  body: string,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/lib`, { recursive: true });
  await Deno.writeTextFile(`${root}/lib/present.ts`, body);
  return {
    root,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

/** One sanctioned HOME-based work-dir construction. */
const ONE_CONSTRUCTION =
  'const dir = `${Deno.env.get("HOME")}/auto-issue-work`;\n';

Deno.test("orphaned allowlist - an entry for a deleted file is not stale (Issue #883)", async () => {
  const { root, cleanup } = await fixture(ONE_CONSTRUCTION);
  try {
    const result = await scanDirectoriesForHomeWorkDir(
      root,
      ["lib"],
      new Map([["lib/present.ts", 1], ["lib/deleted.ts", 1]]),
    );
    assertEquals(
      result.staleAllowlist,
      [],
      "a deleted file's entry must not be reported as stale — that is what " +
        "failed the gate for #805 and #808",
    );
    assertEquals(result.orphanedAllowlist.length, 1);
    assertEquals(
      result.orphanedAllowlist[0]?.includes("lib/deleted.ts"),
      true,
    );
  } finally {
    await cleanup();
  }
});

Deno.test("orphaned allowlist - a file that lost a construction is still stale (Issue #883)", async () => {
  // The fix must not blunt the check. A file that still exists and no longer
  // constructs is real drift, and stays fatal.
  const { root, cleanup } = await fixture("const x = 1;\n");
  try {
    const result = await scanDirectoriesForHomeWorkDir(
      root,
      ["lib"],
      new Map([["lib/present.ts", 1]]),
    );
    assertEquals(result.staleAllowlist.length, 1);
    assertEquals(result.orphanedAllowlist, []);
  } finally {
    await cleanup();
  }
});

Deno.test("orphaned allowlist - an unallowlisted construction is still a violation (Issue #883)", async () => {
  // The safety property: a deleted file's lingering entry must not create a
  // hole through which a real construction passes.
  const { root, cleanup } = await fixture(ONE_CONSTRUCTION);
  try {
    const result = await scanDirectoriesForHomeWorkDir(
      root,
      ["lib"],
      new Map([["lib/deleted.ts", 1]]),
    );
    assertEquals(
      result.violations.length,
      1,
      "present.ts is not allowlisted, so its construction is a violation",
    );
    assertEquals(result.orphanedAllowlist.length, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("orphaned allowlist - the #808 shape passes (Issue #883)", async () => {
  // Exactly what a branch combining the two lines produced: the module gone,
  // its entry retained, and nothing else wrong.
  const { root, cleanup } = await fixture("const x = 1;\n");
  try {
    const result = await scanDirectoriesForHomeWorkDir(
      root,
      ["lib"],
      new Map([["worker/deno/lib/fleet_health.ts", 1]]),
    );
    assertEquals(result.violations, []);
    assertEquals(
      result.staleAllowlist,
      [],
      "this is the combination that failed four runs across #805 and #808",
    );
    assertEquals(result.orphanedAllowlist.length, 1);
  } finally {
    await cleanup();
  }
});
