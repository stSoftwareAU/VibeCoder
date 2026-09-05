/**
 * Tests for the checked-in `Milestone` branch ruleset payload
 * (`infra/rulesets/milestone.json`, Issue #1073).
 *
 * The applied ruleset required exactly two contexts — `gitleaks` and `semgrep`
 * — so a PR into a milestone branch could merge with the whole test suite red.
 * That is how PR #1039 landed with `validate (tests 1/4)` failing and
 * resurrected `fleet_health.ts` onto a milestone branch (Issue #1042).
 *
 * Milestone branches are where a multi-PR feature is assembled, so they need
 * the same test gate as `main`, not a weaker one. These tests hold the payload
 * to that: every context `main` requires is required here too, plus the
 * milestone-only resurrection check.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  diffLiveRuleset,
  loadMainBranchRuleset,
  requiredContexts,
  ruleTypes,
} from "../lib/main_branch_ruleset.ts";
import {
  loadMilestoneBranchRuleset,
  MILESTONE_BRANCH_RULESET_PATH,
} from "../lib/committed_rulesets.ts";
import { createMilestoneBranchName } from "../lib/git_branch.ts";

/**
 * The ruleset as GitHub applied it on 2026-08-30 — ruleset `21835173`, read
 * with `gh api repos/stSoftwareAU/VibeCoder/rulesets/21835173`.
 *
 * This is the reproduction fixture for the bug: a secrets scan and a SAST scan,
 * and no test check at all.
 */
const LIVE_RULESET_2026_08_30 = {
  id: 21835173,
  name: "Milestone",
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: {
    ref_name: { exclude: [], include: ["refs/heads/milestone/**"] },
  },
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: [
          { context: "gitleaks" },
          { context: "semgrep" },
        ],
      },
    },
  ],
};

/** The `required_status_checks` parameters of a payload. */
function statusCheckParameters(
  rules: Array<{ type: string; parameters?: Record<string, unknown> }>,
): Record<string, unknown> {
  const rule = rules.find((r) => r.type === "required_status_checks");
  assert(rule?.parameters, "expected a required_status_checks rule");
  return rule.parameters;
}

Deno.test("milestone ruleset - covers milestone/** with active enforcement", async () => {
  const ruleset = await loadMilestoneBranchRuleset();
  assertEquals(ruleset.name, "Milestone");
  assertEquals(ruleset.target, "branch");
  assertEquals(ruleset.enforcement, "active");
  // No bypass actor: an admin may bypass, the fleet may not (Issue #586).
  assertEquals(ruleset.bypass_actors.length, 0);
  assertEquals(ruleset.conditions.ref_name.include, [
    "refs/heads/milestone/**",
  ]);
});

Deno.test("milestone ruleset - keeps the deletion and force-push rules", async () => {
  const types = ruleTypes(await loadMilestoneBranchRuleset());
  for (const type of ["deletion", "non_fast_forward"]) {
    assert(types.includes(type), `expected rule ${type}, got ${types}`);
  }
});

Deno.test("milestone ruleset - requires every context main requires", async () => {
  const milestone = requiredContexts(
    await loadMilestoneBranchRuleset(),
    MILESTONE_BRANCH_RULESET_PATH,
  );
  const main = requiredContexts(await loadMainBranchRuleset());
  const weaker = main.filter((context) => !milestone.includes(context));
  assertEquals(
    weaker,
    [],
    `milestone branches must not be gated more weakly than main: ${weaker}`,
  );
});

Deno.test("milestone ruleset - a test shard red blocks the merge", async () => {
  const contexts = requiredContexts(
    await loadMilestoneBranchRuleset(),
    MILESTONE_BRANCH_RULESET_PATH,
  );
  // The shard that was red when PR #1039 merged anyway (Issue #1042).
  for (const shard of [1, 2, 3, 4]) {
    assert(
      contexts.includes(`validate (tests ${shard}/4)`),
      `validate (tests ${shard}/4) must gate a milestone merge`,
    );
  }
  for (
    const context of [
      "validate",
      "validate (no-runtime)",
      "validate (container)",
      "markdownlint",
      "supply-chain-gate",
      "container",
      "changes",
    ]
  ) {
    assert(
      contexts.includes(context),
      `${context} must gate a milestone merge`,
    );
  }
});

Deno.test("milestone ruleset - requires the resurrection check main cannot", async () => {
  const contexts = requiredContexts(
    await loadMilestoneBranchRuleset(),
    MILESTONE_BRANCH_RULESET_PATH,
  );
  // The check born from the resurrection this issue traces (Issue #1048). Its
  // `if:` reports on every milestone PR and on no ordinary main PR, so it is
  // required here and exempt there.
  assert(contexts.includes("milestone-resurrection"));
  assert(
    !requiredContexts(await loadMainBranchRuleset()).includes(
      "milestone-resurrection",
    ),
  );
});

Deno.test("milestone ruleset - strict policy, and creation is not gated", async () => {
  const parameters = statusCheckParameters(
    (await loadMilestoneBranchRuleset()).rules,
  );
  assertEquals(parameters["strict_required_status_checks_policy"], true);
  // A branch created at main's tip carries no check runs — the workflows are
  // `pull_request`-triggered — so enforcing on create would refuse every new
  // milestone branch.
  assertEquals(parameters["do_not_enforce_on_create"], true);
});

Deno.test("diffLiveRuleset - the applied milestone ruleset gates no test (the bug)", async () => {
  const committed = await loadMilestoneBranchRuleset();
  const drift = diffLiveRuleset(LIVE_RULESET_2026_08_30, committed);
  const contexts = drift.filter((d) => d.field === "required_status_checks");
  const details = contexts.map((d) => d.detail).join("\n");
  for (const shard of [1, 2, 3, 4]) {
    assertStringIncludes(details, `validate (tests ${shard}/4)`);
  }
  assertStringIncludes(details, "a PR can merge with it red");
  assertEquals(
    contexts.length,
    requiredContexts(committed, MILESTONE_BRANCH_RULESET_PATH).length - 2,
    "every committed context but gitleaks and semgrep must be reported missing",
  );
});

Deno.test("diffLiveRuleset - enforcing on create is reported as drift", async () => {
  const committed = await loadMilestoneBranchRuleset();
  // The applied ruleset carries `false`, which would refuse the push that
  // creates a new milestone branch once the full context set is required.
  const drift = diffLiveRuleset(LIVE_RULESET_2026_08_30, committed);
  const found = drift.filter((d) => d.field === "do_not_enforce_on_create");
  assertEquals(found.length, 1);
  assertStringIncludes(found[0]?.detail ?? "", "has no checks yet");
});

Deno.test("milestone ruleset - the ref condition covers every branch name the fleet creates", async () => {
  // The payload covers `refs/heads/milestone/**`, while the workflows filter
  // on `milestone/*`, which matches one path segment. The two agree only
  // because `createMilestoneBranchName` replaces every non-alphanumeric
  // character, so a milestone branch can never nest — if that ever changed,
  // the nested branch would require 14 contexts no workflow reports.
  for (
    const title of [
      "CI gates and repository rulesets",
      "Feature/nested slug",
      "863: phase 2 / part b",
    ]
  ) {
    const branch = createMilestoneBranchName(title);
    assertEquals(
      branch.slice("milestone/".length).includes("/"),
      false,
      `${branch} nests, so no workflow would report on a PR into it`,
    );
  }
  assertEquals(
    (await loadMilestoneBranchRuleset()).conditions.ref_name.include,
    [
      "refs/heads/milestone/**",
    ],
  );
});

Deno.test("diffLiveRuleset - the committed milestone payload matches itself", async () => {
  const committed = await loadMilestoneBranchRuleset();
  const live = JSON.parse(JSON.stringify(committed)) as Record<string, unknown>;
  assertEquals(diffLiveRuleset(live, committed), []);
});
