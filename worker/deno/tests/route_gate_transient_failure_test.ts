/**
 * Behaviour tests: a transient read failure must not look like a closed
 * route (Issue #477).
 *
 * `decideMilestoneBaseMerge` refuses to merge into a milestone branch whose
 * way to the default branch has closed — its rollup PR already merged, or
 * its milestone closed (Issue #4396). Real, and worth keeping: seven fixes
 * were once merged into a dead branch and evaporated with it.
 *
 * But it returned that same `block` when it simply **could not read** the
 * answer, and `block` makes `enableAutoMerge` retarget the PR at the
 * default branch. Observed live, unattended:
 *
 *   Auto-merge failed: PR #1057 not merged into
 *   milestone/apa-tpmum-documentation-sprint-18: could not list rollup PRs
 *   …: GraphQL: API rate limit already exceeded — retarget failed
 *
 * A rate limit is certain to occur across a weekend. Under the old
 * behaviour every milestone child is refused while it lasts, and any whose
 * retarget *succeeds* is moved onto the review-gated default branch, where
 * it waits for a human who is not there. Both outcomes are the exact
 * opposite of the unattended run milestones exist for.
 *
 * "I could not read it" is not evidence. Only positive evidence — a merged
 * rollup, or a closed milestone — closes a route.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { decideMilestoneBaseMerge } from "../lib/milestone_children_gate.ts";

const REPO = "TitlePage/tp-security-centre";
const PR = 1057;
const BASE = "milestone/apa-tpmum-documentation-sprint-18";

const RATE_LIMIT =
  "gh command failed (exit 1): GraphQL: API rate limit already exceeded for user ID 23146043.";

/** gh that fails the rollup listing and answers milestones normally. */
function rollupUnreadable(): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const joined = args.join(" ");
    if (joined.includes("pr list") && joined.includes("--head")) {
      return Promise.reject(new Error(RATE_LIMIT));
    }
    if (joined.includes("/milestones?state=all")) {
      return Promise.resolve(
        JSON.stringify([{ number: 43, title: "Sprint 18", state: "open" }]),
      );
    }
    return Promise.reject(new Error(`Unexpected: ${joined}`));
  };
}

/** gh that lists rollups fine but cannot read milestones. */
function milestonesUnreadable(): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const joined = args.join(" ");
    if (joined.includes("pr list") && joined.includes("--head")) {
      return Promise.resolve("[]");
    }
    if (joined.includes("/milestones?state=all")) {
      return Promise.reject(new Error(RATE_LIMIT));
    }
    return Promise.reject(new Error(`Unexpected: ${joined}`));
  };
}

// ---------------------------------------------------------------------------
// A read failure defers; it never retargets
// ---------------------------------------------------------------------------

Deno.test("route gate - an unreadable rollup listing defers instead of blocking", async () => {
  const decision = await decideMilestoneBaseMerge({
    repo: REPO,
    prNumber: PR,
    baseRefName: BASE,
    ghCommandFn: rollupUnreadable(),
  });

  assertEquals(
    decision.decision,
    "defer",
    "a rate limit is not evidence the milestone's route has closed (Issue #477)",
  );
});

Deno.test("route gate - an unreadable milestone listing defers instead of blocking", async () => {
  const decision = await decideMilestoneBaseMerge({
    repo: REPO,
    prNumber: PR,
    baseRefName: BASE,
    ghCommandFn: milestonesUnreadable(),
  });

  assertEquals(decision.decision, "defer");
});

// ---------------------------------------------------------------------------
// Positive evidence still blocks — the #4396 protection is intact
// ---------------------------------------------------------------------------

Deno.test("route gate - a merged rollup PR still blocks the merge", async () => {
  const decision = await decideMilestoneBaseMerge({
    repo: REPO,
    prNumber: PR,
    baseRefName: BASE,
    ghCommandFn: (args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("pr list") && joined.includes("--head")) {
        return Promise.resolve(JSON.stringify([{
          number: 900,
          state: "MERGED",
          baseRefName: "Develop",
          mergedAt: "2026-08-01T00:00:00Z",
        }]));
      }
      return Promise.resolve("[]");
    },
  });

  assertEquals(
    decision.decision,
    "block",
    "a rollup that really has merged still closes the route (Issue #4396)",
  );
});

Deno.test("route gate - a closed milestone still blocks the merge", async () => {
  const decision = await decideMilestoneBaseMerge({
    repo: REPO,
    prNumber: PR,
    baseRefName: BASE,
    ghCommandFn: (args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("pr list") && joined.includes("--head")) {
        return Promise.resolve("[]");
      }
      if (joined.includes("/milestones?state=all")) {
        return Promise.resolve(JSON.stringify([{
          number: 43,
          title: "APA TPMUM Documentation – Sprint 18",
          state: "closed",
        }]));
      }
      return Promise.resolve("[]");
    },
  });

  assertEquals(decision.decision, "block");
});

Deno.test("route gate - an open milestone with no merged rollup allows the merge", async () => {
  const decision = await decideMilestoneBaseMerge({
    repo: REPO,
    prNumber: PR,
    baseRefName: BASE,
    ghCommandFn: (args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("pr list") && joined.includes("--head")) {
        return Promise.resolve("[]");
      }
      if (joined.includes("/milestones?state=all")) {
        return Promise.resolve(JSON.stringify([{
          number: 43,
          title: "APA TPMUM Documentation – Sprint 18",
          state: "open",
        }]));
      }
      return Promise.resolve("[]");
    },
  });

  assertEquals(decision.decision, "allow");
});
