/**
 * Direct tests for the dependency-free milestone sync-branch naming module
 * (Issue #3476).
 *
 * `SYNC_BRANCH_PREFIX`, `syncBranchFor` and `isMilestoneSyncBranch` were moved
 * out of `milestone_sync_pr.ts` into `milestone_sync_branch.ts` so callers that
 * only need to recognise a sync PR (e.g. the title-search guard) can import
 * them without pulling in the sync-landing machinery and its dependency cycle.
 * These tests import the new module directly and pin each helper's behaviour,
 * independent of the re-export from `milestone_sync_pr.ts`.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  isMilestoneSyncBranch,
  SYNC_BRANCH_PREFIX,
  syncBranchFor,
} from "../lib/milestone_sync_branch.ts";

Deno.test("milestone_sync_branch - syncBranchFor names a deterministic, ruleset-free branch", () => {
  assertEquals(
    syncBranchFor("milestone/523-idle-task-scans"),
    `${SYNC_BRANCH_PREFIX}-523-idle-task-scans`,
  );
  // Deterministic — a second run finds the branch the first one pushed.
  assertEquals(
    syncBranchFor("milestone/523-idle-task-scans"),
    syncBranchFor("milestone/523-idle-task-scans"),
  );
  // Characters a ref cannot carry are normalised to dashes.
  assertEquals(
    syncBranchFor("milestone/4340 the v116 slot"),
    `${SYNC_BRANCH_PREFIX}-4340-the-v116-slot`,
  );
});

Deno.test("milestone_sync_branch - isMilestoneSyncBranch recognises only the sync prefix", () => {
  assert(isMilestoneSyncBranch("sync/milestone-863"));
  assert(isMilestoneSyncBranch("sync/milestone-523-idle-task-scans"));
  assert(!isMilestoneSyncBranch("sync/other"));
  assert(!isMilestoneSyncBranch("milestone/863"));
  assert(!isMilestoneSyncBranch(undefined));
  assert(!isMilestoneSyncBranch(null));
});
