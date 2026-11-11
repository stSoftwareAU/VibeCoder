/**
 * Persisted base-refresh decision counters (Issue #4943).
 *
 * The standalone pr-maintenance command and the babysitter never write the
 * per-cycle fault_tolerance_summary.json, so requestReadyBranchUpdate persists
 * its refresh-requested / refresh-skipped decisions to
 * `{counterDir}/base_refresh_counters.json` when a counterDir is given. These
 * tests drive the real function against the shared strict-base fixture: PR 10
 * is accepted and PR 11 is refused because PR 10 owns the base refresh.
 */
import { assert, assertEquals } from "@std/assert";
import type { Result } from "../types.ts";
import { requestReadyBranchUpdate } from "../lib/required_branch_checks_4613.ts";
import { BASE_REFRESH_COUNTERS_FILE } from "../lib/repair_base_merge_4943.ts";
import { strictRefreshFixture } from "./support/strict_refresh_fixture.ts";

const REPO = "owner/repo";
const BASE = "main";
const AUTHOR_OPTIONS = { fleetAuthors: ["VibeCoderST"] };
const noSleep = async () => {};

/** Ask for a refresh, silencing the one diagnostic line the call logs. */
async function ask(
  gh: (args: string[]) => Promise<string>,
  prNumber: number,
  source: string,
  counterDir?: string,
): Promise<Result<void>> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await requestReadyBranchUpdate(
      REPO,
      prNumber,
      gh,
      BASE,
      undefined,
      noSleep,
      AUTHOR_OPTIONS,
      source,
      counterDir,
    );
  } finally {
    console.warn = original;
  }
}

async function readCounters(dir: string): Promise<Record<string, number>> {
  const parsed = JSON.parse(
    await Deno.readTextFile(`${dir}/${BASE_REFRESH_COUNTERS_FILE}`),
  ) as { counters: Record<string, number> };
  return parsed.counters;
}

/**
 * The Result as a comparable value: the ok flag and any refusal message. The
 * owner's random refresh id differs between independent fleets, so it is
 * normalised away.
 */
function outcome(result: Result<void>): [boolean, string | undefined] {
  return [
    result.ok,
    result.ok
      ? undefined
      : result.error.message.replace(/refresh-[0-9a-f-]{36}/, "refresh-<id>"),
  ];
}

Deno.test("base refresh counters: an accepted and a refused decision persist to counterDir and accumulate", async () => {
  const dir = await Deno.makeTempDir({ prefix: "base_refresh_counter_" });
  try {
    const fleet = strictRefreshFixture();
    const accepted = await ask(fleet.gh, 10, "pr-maintenance", dir);
    assertEquals(accepted.ok, true);
    assertEquals(await readCounters(dir), {
      "baseRefresh.refresh-requested.pr-maintenance": 1,
    });

    const refused = await ask(fleet.gh, 11, "pr-maintenance", dir);
    assertEquals(refused.ok, false);
    assertEquals(await readCounters(dir), {
      "baseRefresh.refresh-requested.pr-maintenance": 1,
      "baseRefresh.refresh-skipped.pr-maintenance": 1,
    });

    const refusedAgain = await ask(fleet.gh, 11, "pr-maintenance", dir);
    assertEquals(refusedAgain.ok, false);
    assertEquals(await readCounters(dir), {
      "baseRefresh.refresh-requested.pr-maintenance": 1,
      "baseRefresh.refresh-skipped.pr-maintenance": 2,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("base refresh counters: without counterDir nothing is written and the Result is unchanged", async () => {
  const unused = await Deno.makeTempDir({ prefix: "base_refresh_unused_" });
  try {
    const withDir = strictRefreshFixture();
    const withDirAccepted = outcome(
      await ask(withDir.gh, 10, "pr-maintenance", unused),
    );
    const withDirRefused = outcome(
      await ask(withDir.gh, 11, "pr-maintenance", unused),
    );

    const withoutDir = strictRefreshFixture();
    const withoutDirAccepted = outcome(
      await ask(withoutDir.gh, 10, "pr-maintenance"),
    );
    const withoutDirRefused = outcome(
      await ask(withoutDir.gh, 11, "pr-maintenance"),
    );

    assertEquals(withoutDirAccepted, withDirAccepted);
    assertEquals(withoutDirRefused, withDirRefused);
    assertEquals(withoutDirAccepted, [true, undefined]);
    assert(withoutDirRefused[0] === false && withoutDirRefused[1]);

    // The run given a directory wrote exactly its counter file; the calls
    // without one wrote nothing else into that directory.
    const entries = [];
    for await (const entry of Deno.readDir(unused)) entries.push(entry.name);
    assertEquals(entries.sort(), [BASE_REFRESH_COUNTERS_FILE]);
  } finally {
    await Deno.remove(unused, { recursive: true });
  }
});

Deno.test("base refresh counters: an unwritable counterDir never changes the Result", async () => {
  const root = await Deno.makeTempDir({ prefix: "base_refresh_blocked_" });
  try {
    // A regular file where the directory should be: every counter write fails.
    const blocker = `${root}/not-a-directory`;
    await Deno.writeTextFile(blocker, "x");
    const fleet = strictRefreshFixture();
    const accepted = await ask(fleet.gh, 10, "pr-maintenance", blocker);
    assertEquals(accepted.ok, true);
    const refused = await ask(fleet.gh, 11, "pr-maintenance", blocker);
    assertEquals(refused.ok, false);
    assert(
      !refused.ok && refused.error.message.startsWith("base refresh owned by"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
