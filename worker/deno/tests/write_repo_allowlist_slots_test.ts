/**
 * Per-slot write-repo allowlist contexts (Issue #4175, part of #4168).
 *
 * Two concurrent slots seeded with repo A and repo B must each refuse
 * writes to the other's repo — never the union. Against the old
 * module-level singletons this test cannot pass: the second seed clobbers
 * the first, or an additive seed widens the process allowlist.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  _resetWriteRepoAllowlistSinks,
  _setWriteRepoAllowlistSinks,
  createWriteRepoAllowlistContext,
  currentWriteRepoAllowlistContext,
  enforceGhWriteAllowlist,
  isWriteRepoAllowed,
  listAllowedWriteRepos,
  noteAgentAllowlistSnapshot,
  pinWriteRepo,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
  unpinWriteRepo,
  withWriteRepoAllowlistContext,
  WriteRepoBlockedError,
} from "../lib/write_repo_allowlist.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

Deno.test("allowlist slots - two concurrent contexts each refuse the other's repo (Issue #4175)", async () => {
  _setWriteRepoAllowlistSinks({
    record: () => Promise.resolve({ ok: true, value: undefined as never }),
    log: () => undefined,
  });
  try {
    const seen: string[] = [];
    const slotA = withWriteRepoAllowlistContext(
      createWriteRepoAllowlistContext(),
      async () => {
        seedWriteRepoAllowlist("org/repo-a");
        await tick(); // interleave with slot B's seed
        seen.push(`A sees ${listAllowedWriteRepos().join(",")}`);
        assertEquals(isWriteRepoAllowed("org/repo-a"), true);
        assertEquals(isWriteRepoAllowed("org/repo-b"), false);
        await assertRejects(
          () =>
            enforceGhWriteAllowlist([
              "issue",
              "comment",
              "1",
              "--repo",
              "org/repo-b",
              "--body",
              "x",
            ]),
          WriteRepoBlockedError,
        );
        await tick();
        // Still A's after B has been busy.
        assertEquals(listAllowedWriteRepos(), ["org/repo-a"]);
      },
    );
    const slotB = withWriteRepoAllowlistContext(
      createWriteRepoAllowlistContext(),
      async () => {
        seedWriteRepoAllowlist("org/repo-b");
        await tick();
        seen.push(`B sees ${listAllowedWriteRepos().join(",")}`);
        assertEquals(isWriteRepoAllowed("org/repo-b"), true);
        assertEquals(isWriteRepoAllowed("org/repo-a"), false);
        await assertRejects(
          () =>
            enforceGhWriteAllowlist([
              "issue",
              "comment",
              "1",
              "--repo",
              "org/repo-a",
              "--body",
              "x",
            ]),
          WriteRepoBlockedError,
        );
      },
    );
    await Promise.all([slotA, slotB]);
    assertEquals(seen.sort(), ["A sees org/repo-a", "B sees org/repo-b"]);
    // The process-wide default context was never touched: inactive.
    assertEquals(currentWriteRepoAllowlistContext().active, false);
  } finally {
    _resetWriteRepoAllowlistSinks();
  }
});

Deno.test("allowlist slots - pins and the agent-snapshot flag are per context (Issue #4175)", async () => {
  const warnings: string[] = [];
  _setWriteRepoAllowlistSinks({
    record: () => Promise.resolve({ ok: true, value: undefined as never }),
    log: (m) => warnings.push(m),
  });
  try {
    await withWriteRepoAllowlistContext(
      createWriteRepoAllowlistContext(),
      async () => {
        seedWriteRepoAllowlist("org/a");
        pinWriteRepo("org/pinned-a");
        noteAgentAllowlistSnapshot();
        await tick();
        // A grant after the snapshot warns — in THIS context.
        seedWriteRepoAllowlist("org/a"); // reseed clears the flag
        noteAgentAllowlistSnapshot();
        const before = warnings.length;
        const { registerWriteRepo } = await import(
          "../lib/write_repo_allowlist.ts"
        );
        registerWriteRepo("org/late");
        assertEquals(warnings.length, before + 1);
        assertEquals(isWriteRepoAllowed("org/pinned-a"), true);
        unpinWriteRepo("org/pinned-a");
        assertEquals(isWriteRepoAllowed("org/pinned-a"), false);
      },
    );
    await withWriteRepoAllowlistContext(
      createWriteRepoAllowlistContext(),
      async () => {
        seedWriteRepoAllowlist("org/b");
        await tick();
        // Sibling's pin never leaked here.
        assertEquals(isWriteRepoAllowed("org/pinned-a"), false);
        // Sibling's snapshot flag never leaked here: no warning on grant.
        const before = warnings.length;
        const { registerWriteRepo } = await import(
          "../lib/write_repo_allowlist.ts"
        );
        registerWriteRepo("org/extra");
        assertEquals(warnings.length, before);
      },
    );
  } finally {
    _resetWriteRepoAllowlistSinks();
    resetWriteRepoAllowlist();
  }
});

Deno.test("allowlist slots - outside any slot scope the default context is used, exactly as before (Issue #4175)", () => {
  resetWriteRepoAllowlist();
  assertEquals(currentWriteRepoAllowlistContext().active, false);
  seedWriteRepoAllowlist("org/default");
  assert(currentWriteRepoAllowlistContext().active);
  assertEquals(listAllowedWriteRepos(), ["org/default"]);
  resetWriteRepoAllowlist();
  assertEquals(listAllowedWriteRepos(), []);
});
