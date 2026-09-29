/**
 * Argument builder for a leased force push (Issue #275, #3723).
 *
 * Push recovery no longer forces (Issue #2808); the builder still serves the
 * stale-branch lineage heal, so its argv contract stays pinned here.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertThrows } from "@std/assert";
import { buildForceWithLeaseArgs } from "../lib/git_push_lease_args.ts";

// Issue #275: the lease flag now precedes `--end-of-options`, and the remote
// and branch follow it as positionals. The old order put the branch name in
// front of the lease flag as a bare positional — a dash-leading PR head
// branch was parsed as an option (CWE-88) — and put `--force-with-lease`
// last, where git would have read it as a third refspec had the separator
// been added naively.

Deno.test("buildForceWithLeaseArgs - pins the lease to the captured baseline", () => {
  assertEquals(
    buildForceWithLeaseArgs(
      "feature",
      "0123456789abcdef0123456789abcdef01234567",
    ),
    [
      "push",
      "--force-with-lease=feature:0123456789abcdef0123456789abcdef01234567",
      "--end-of-options",
      "origin",
      "feature",
    ],
  );
});

Deno.test("buildForceWithLeaseArgs - falls back to the bare lease with no baseline", () => {
  assertEquals(buildForceWithLeaseArgs("feature", null), [
    "push",
    "--force-with-lease",
    "--end-of-options",
    "origin",
    "feature",
  ]);
});

Deno.test("buildForceWithLeaseArgs - refuses a dash-leading branch name (Issue #275)", () => {
  // The reason the separator alone is not the whole fix: routing through
  // buildPushArgs also runs assertSafeGitRef over the branch name, so a
  // hostile PR head is rejected before an argv is built at all.
  assertThrows(() => buildForceWithLeaseArgs("--upload-pack=evil", null));
});
