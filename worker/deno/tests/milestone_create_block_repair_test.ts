/**
 * Tests for the in-run repair of a milestone ruleset that refuses its own
 * branch creation (Issue #2079).
 *
 * `stSoftwareAU/GRQ-FX-validation` kept failing at `setup` inside a minute:
 *
 * ```text
 * ! [remote rejected] Develop -> milestone/scan-20260910
 *     (push declined due to repository rule violations)
 * ```
 *
 * Issue #2067 taught the operator-run `setup` command to clear that ruleset,
 * but nothing re-ran setup against the repository, so the trap stood and
 * every claim died on it. These tests cover the worker clearing it in the
 * run that meets it, and — just as important — failing loud with a note when
 * it cannot.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  isRulesetCreationRefusal,
  repairMilestoneCreateBlockAndRetry,
  resetMilestoneCreateBlockRepairsForTest,
} from "../lib/milestone_create_block_repair.ts";
import type { RepairMilestoneResult } from "../lib/milestone_ruleset_check.ts";

/** The refusal GRQ-FX-validation produced, verbatim. */
const REFUSAL = "Failed to push milestone branch milestone/scan-20260910: " +
  "git push origin Develop:refs/heads/milestone/scan-20260910 failed " +
  "(exit code 1): remote: error: GH013: Repository rule violations found " +
  "for refs/heads/milestone/scan-20260910.\n" +
  "! [remote rejected] Develop -> milestone/scan-20260910 " +
  "(push declined due to repository rule violations)";

const REPO = "stSoftwareAU/GRQ-FX-validation";
const BRANCH = "milestone/scan-20260910";

Deno.test("isRulesetCreationRefusal - the observed refusal is a ruleset refusal", () => {
  assertEquals(isRulesetCreationRefusal(REFUSAL), true);
  assertEquals(
    isRulesetCreationRefusal(
      "remote: error: GH013: Repository rule violations",
    ),
    true,
  );
});

Deno.test("isRulesetCreationRefusal - protection and permission faults are not ruleset refusals", () => {
  // Repo-level, but no ruleset flag clears them — a repair would be noise.
  assertEquals(
    isRulesetCreationRefusal("protected branch hook declined"),
    false,
  );
  assertEquals(
    isRulesetCreationRefusal("remote: Permission to org/repo.git denied"),
    false,
  );
  assertEquals(isRulesetCreationRefusal(""), false);
});

Deno.test("repairMilestoneCreateBlockAndRetry - clears the ruleset and creates the branch", async () => {
  resetMilestoneCreateBlockRepairsForTest();
  const repaired: string[] = [];
  let retries = 0;

  const outcome = await repairMilestoneCreateBlockAndRetry({
    repo: REPO,
    milestoneBranch: BRANCH,
    detail: REFUSAL,
    repair: (repo) => {
      repaired.push(repo);
      return Promise.resolve(
        {
          ok: true,
          repaired: true,
          ruleset: "Vibe Coder milestone branches",
        } as RepairMilestoneResult,
      );
    },
    retry: () => {
      retries++;
      return Promise.resolve({ ok: true, value: `${BRANCH} created` });
    },
  });

  assertEquals(outcome.kind, "recovered");
  assert(outcome.kind === "recovered");
  assertEquals(outcome.ruleset, "Vibe Coder milestone branches");
  assertStringIncludes(outcome.value, BRANCH);
  assertEquals(repaired, [REPO]);
  assertEquals(retries, 1);
});

Deno.test("repairMilestoneCreateBlockAndRetry - a non-ruleset refusal is left alone", async () => {
  resetMilestoneCreateBlockRepairsForTest();
  let repairs = 0;
  let retries = 0;

  const outcome = await repairMilestoneCreateBlockAndRetry({
    repo: REPO,
    milestoneBranch: BRANCH,
    detail: "git push failed (exit code 1): protected branch hook declined",
    repair: () => {
      repairs++;
      return Promise.resolve(
        { ok: true, repaired: false, reason: "n/a" } as RepairMilestoneResult,
      );
    },
    retry: () => {
      retries++;
      return Promise.resolve({ ok: true, value: "created" });
    },
  });

  assertEquals(outcome.kind, "not-applicable");
  assertEquals(repairs, 0);
  assertEquals(retries, 0);
});

Deno.test("repairMilestoneCreateBlockAndRetry - a refused repair fails loud with the cause", async () => {
  resetMilestoneCreateBlockRepairsForTest();
  let retries = 0;

  const outcome = await repairMilestoneCreateBlockAndRetry({
    repo: REPO,
    milestoneBranch: BRANCH,
    detail: REFUSAL,
    repair: () =>
      Promise.resolve({
        ok: false,
        error: new Error(
          "Not Found — writing a ruleset needs ADMIN on " + REPO,
        ),
      } as RepairMilestoneResult),
    retry: () => {
      retries++;
      return Promise.resolve({ ok: true, value: "created" });
    },
  });

  assertEquals(outcome.kind, "failed");
  assert(outcome.kind === "failed");
  assertStringIncludes(outcome.note, "needs ADMIN");
  // The branch is never retried against an unrepaired ruleset.
  assertEquals(retries, 0);
});

Deno.test("repairMilestoneCreateBlockAndRetry - nothing repairable is reported, not called clean", async () => {
  resetMilestoneCreateBlockRepairsForTest();

  const outcome = await repairMilestoneCreateBlockAndRetry({
    repo: REPO,
    milestoneBranch: BRANCH,
    detail: REFUSAL,
    repair: () =>
      Promise.resolve({
        ok: true,
        repaired: false,
        reason: "no milestone ruleset blocks branch creation",
      } as RepairMilestoneResult),
    retry: () => Promise.resolve({ ok: true, value: "created" }),
  });

  assertEquals(outcome.kind, "failed");
  assert(outcome.kind === "failed");
  assertStringIncludes(outcome.note, "no milestone ruleset blocks");
  assertStringIncludes(outcome.note, "cleared by hand");
});

Deno.test("repairMilestoneCreateBlockAndRetry - a repair that did not unblock the push is reported", async () => {
  resetMilestoneCreateBlockRepairsForTest();

  const outcome = await repairMilestoneCreateBlockAndRetry({
    repo: REPO,
    milestoneBranch: BRANCH,
    detail: REFUSAL,
    repair: () =>
      Promise.resolve({
        ok: true,
        repaired: true,
        ruleset: "Vibe Coder milestone branches",
      } as RepairMilestoneResult),
    retry: () =>
      Promise.resolve({
        ok: false,
        error: new Error("still refused: some other rule"),
      }),
  });

  assertEquals(outcome.kind, "failed");
  assert(outcome.kind === "failed");
  assertStringIncludes(outcome.note, "Vibe Coder milestone branches");
  assertStringIncludes(outcome.note, "still refused");
});

Deno.test("repairMilestoneCreateBlockAndRetry - one attempt per repository per run", async () => {
  resetMilestoneCreateBlockRepairsForTest();
  let repairs = 0;
  const attempt = () =>
    repairMilestoneCreateBlockAndRetry({
      repo: REPO,
      milestoneBranch: BRANCH,
      detail: REFUSAL,
      repair: () => {
        repairs++;
        return Promise.resolve({
          ok: true,
          repaired: true,
          ruleset: "Vibe Coder milestone branches",
        } as RepairMilestoneResult);
      },
      retry: () => Promise.resolve({ ok: true, value: "created" }),
    });

  assertEquals((await attempt()).kind, "recovered");
  const second = await attempt();
  assertEquals(second.kind, "not-applicable");
  assertEquals(repairs, 1);

  // A different repository is still attempted — the registry is per repo.
  resetMilestoneCreateBlockRepairsForTest();
  assertEquals((await attempt()).kind, "recovered");
  assertEquals(repairs, 2);
});
