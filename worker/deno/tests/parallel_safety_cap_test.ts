/**
 * Issue #880: the parallel-safety debt is capped, not growing.
 *
 * The gate's `deno test` stage ran sequentially, which put the suite at
 * 42+ minutes on a 10-core host against a 45-minute phase budget — so issues
 * died in `quality_gate` having changed nothing wrong (#805 twice, #808).
 * `--parallel` takes it to 2m23s, an 18x win that was sitting on the table.
 *
 * It could not be taken wholesale. Parallel workers share the process
 * environment, so a test that mutates it races whatever else is running:
 *
 * ```ts
 * // container_entrypoint_test.ts
 * Deno.env.set("VIBE_SCRATCH_DIR", hostScratch);
 * ```
 *
 * (The example has now moved twice. It was `commit_and_push_pending_test.ts`
 * setting `VIBE_RUN_ID` until #963 gave the run id an explicit parameter, then
 * `prompt_manager_test.ts` setting `VIBE_BASE_DIR` until #968 gave
 * `getPromptsDir` an injected environment lookup — which is the whole point of
 * the list going down.)
 *
 * Measured with `DENO_JOBS=4`: 48 failures, ~16 of them genuine races. The
 * remainder were written off as "the pre-existing pwsh failures" and quoted
 * that way ever since. They were neither pre-existing nor 32: #971 re-measured
 * the three PowerShell suites on a host with PowerShell 7.6.5 and found 18
 * failures, none of them a race — 16 were `setup_ps1_test.ts` resolving `pwsh`
 * against the developer's own `PATH` and then spawning it with a sanitised
 * one, and 2 were a test's own clock. All 18 were fixed in #988, so nothing
 * from that half is debt this cap has to carry.
 *
 * Of the races, only a handful collided — the
 * rest of the listed files are latent. Bounding the worker count reduces the
 * probability of a collision without removing it, which is the worst outcome
 * for a gate: intermittent red on unrelated work trains everyone to re-run
 * rather than read the result.
 *
 * So this test does not fix those files. It **caps them**, so the debt cannot
 * grow while it is paid down. A new test that mutates process state fails
 * here with the alternative spelled out; each existing file removed from the
 * list is one more file that runs in the gate's fast pass.
 *
 * Issue #940 moved the list itself into `lib/parallel_unsafe_test_manifest.ts`
 * so the gate can read it and run the unit suite in two passes. The list is
 * still capped here, against the same two directions, so the manifest and
 * reality cannot drift apart.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  mutatesProcessState,
  PROCESS_STATE_MUTATOR_TEST_FILES,
  reachesInTestGraph,
} from "../lib/parallel_unsafe_test_manifest.ts";
import {
  readTestSourceGraph,
  suiteFiles,
} from "./support/test_source_graph.ts";

const DENO_DIR = new URL("..", import.meta.url).pathname;

/**
 * Test files that mutate process-wide state right now, helpers included.
 *
 * The walk follows imports. #880's did not, and the 92-entry list that
 * produced was short by 43. `tests/support/repo_prompts.ts` deletes the
 * prompt-directory variables and calls `Deno.chdir(REPO_ROOT)` at module
 * scope; 35 suites import it and 33 of those mutate nothing of their own.
 * `tests/support/env.ts` is the second such helper. 39 of the 43 were hidden
 * that way; the other 4 delete a variable rather than setting one, which
 * #880's spelling did not match.
 */

async function currentMutators(): Promise<string[]> {
  const sources = await readTestSourceGraph(DENO_DIR);
  return suiteFiles(sources).filter((file) =>
    // This file names the pattern in its own prose.
    file !== "tests/parallel_safety_cap_test.ts" &&
    reachesInTestGraph(file, sources, mutatesProcessState)
  );
}

Deno.test("parallel safety - no new test mutates process-wide state (Issue #880)", async () => {
  const listed = new Set(PROCESS_STATE_MUTATOR_TEST_FILES);
  const added = (await currentMutators()).filter((f) => !listed.has(f));
  assertEquals(
    added,
    [],
    "these test files mutate `Deno.env` or `chdir`, which races under " +
      "`deno test --parallel` and pushes them into the gate's slow serial " +
      "pass. Take the value as a parameter or an injected seam instead:\n" +
      added.join("\n"),
  );
});

Deno.test("parallel safety - the list holds no files that were cleaned up (Issue #880)", async () => {
  // An exemption that outlives what it exempts is how #805 lost two runs:
  // `HOME_WORKDIR_ALLOWLIST` kept an entry for a deleted file and failed the
  // gate. Shrinking this list is the goal, so a stale entry must be noticed.
  const current = new Set(await currentMutators());
  const stale = PROCESS_STATE_MUTATOR_TEST_FILES.filter((f) => !current.has(f))
    .sort();
  assertEquals(
    stale,
    [],
    "these files no longer mutate process state — remove them from " +
      "PROCESS_STATE_MUTATOR_TEST_FILES so the list stays an exact record " +
      "and they run in the fast parallel pass:\n" + stale.join("\n"),
  );
});
