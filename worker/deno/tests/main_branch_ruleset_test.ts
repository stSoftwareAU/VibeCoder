/**
 * Tests for the checked-in `main` branch ruleset payload
 * (`infra/rulesets/main.json`, Issue #858).
 *
 * `validate` was not a required status check on `main`, so auto-merge fired
 * while it was red and landed two broken commits (PRs #825 and #832). The
 * payload is the source of truth for the branch ruleset applied to
 * `stSoftwareAU/VibeCoder`; these tests hold it to the invariants that make it
 * worth having, and hold {@link diffLiveRuleset} to reporting every drift
 * direction between the applied ruleset and the file.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type BranchRuleset,
  diffLiveRuleset,
  loadMainBranchRuleset,
  parseBranchRuleset,
  requiredContexts,
  ruleTypes,
} from "../lib/main_branch_ruleset.ts";

/**
 * The ruleset as GitHub applied it on 2026-09-05 — ruleset `21019403`, read
 * with `gh api repos/stSoftwareAU/VibeCoder/rulesets/21019403`.
 *
 * This is the reproduction fixture for the bug: eleven contexts, with
 * `validate` and `validate (no-runtime)` absent.
 */
const LIVE_RULESET_2026_09_05 = {
  id: 21019403,
  name: "main",
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    { type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: true,
        required_status_checks: [
          { context: "container" },
          { context: "gitleaks" },
          { context: "markdownlint" },
          { context: "supply-chain-gate" },
          { context: "semgrep" },
          { context: "validate (container)" },
          { context: "validate (tests 1/4)" },
          { context: "validate (tests 2/4)" },
          { context: "validate (tests 3/4)" },
          { context: "validate (tests 4/4)" },
          { context: "changes" },
        ],
      },
    },
    { type: "copilot_code_review" },
  ],
};

/** The committed payload, rendered back to the live JSON shape. */
function asLive(ruleset: BranchRuleset): Record<string, unknown> {
  return JSON.parse(JSON.stringify(ruleset)) as Record<string, unknown>;
}

Deno.test("main ruleset - targets the default branch with active enforcement", async () => {
  const ruleset = await loadMainBranchRuleset();
  assertEquals(ruleset.name, "main");
  assertEquals(ruleset.target, "branch");
  assertEquals(ruleset.enforcement, "active");
  assertEquals(ruleset.bypass_actors.length, 0);
  assertEquals(ruleset.conditions.ref_name.include, ["~DEFAULT_BRANCH"]);
});

Deno.test("main ruleset - keeps the merge, deletion and force-push rules", async () => {
  const types = ruleTypes(await loadMainBranchRuleset());
  for (const type of ["deletion", "non_fast_forward", "pull_request"]) {
    assert(
      types.includes(type),
      `expected rule ${type}, got ${types.join(", ")}`,
    );
  }
});

Deno.test("main ruleset - requires validate and every validate shard", async () => {
  const contexts = requiredContexts(await loadMainBranchRuleset());
  // The regression: both of these were absent from the applied ruleset, so a
  // PR whose `deno lint` failed inside `validate` could still auto-merge.
  assert(contexts.includes("validate"), "validate must be a required check");
  assert(
    contexts.includes("validate (no-runtime)"),
    "validate (no-runtime) must be a required check",
  );
  for (const shard of [1, 2, 3, 4]) {
    assert(contexts.includes(`validate (tests ${shard}/4)`));
  }
  assert(contexts.includes("validate (container)"));
});

Deno.test("main ruleset - strict policy keeps a stale branch from merging", async () => {
  const ruleset = await loadMainBranchRuleset();
  const rule = ruleset.rules.find((r) => r.type === "required_status_checks");
  assertEquals(
    (rule?.parameters as { strict_required_status_checks_policy?: boolean })
      ?.strict_required_status_checks_policy,
    true,
  );
});

Deno.test("parseBranchRuleset - rejects a malformed payload loudly", () => {
  assertThrows(() => parseBranchRuleset("not json"), Error, "not valid JSON");
  assertThrows(() => parseBranchRuleset("[]"), Error, "must be a JSON object");
  assertThrows(
    () => parseBranchRuleset(JSON.stringify({ name: "main" })),
    Error,
    "target must be a string",
  );
  assertThrows(
    () =>
      parseBranchRuleset(
        JSON.stringify({
          name: "main",
          target: "branch",
          enforcement: "active",
          bypass_actors: [],
          conditions: { ref_name: { include: [], exclude: [] } },
          rules: [],
        }),
      ),
    Error,
    "rules must be a non-empty array",
  );
});

Deno.test("requiredContexts - fails loud when no status-check rule exists", () => {
  const ruleset = parseBranchRuleset(
    JSON.stringify({
      name: "main",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "deletion" }],
    }),
  );
  assertThrows(
    () => requiredContexts(ruleset),
    Error,
    "required_status_checks",
  );
});

Deno.test("diffLiveRuleset - the applied ruleset is missing validate (the bug)", async () => {
  const committed = await loadMainBranchRuleset();
  const drift = diffLiveRuleset(LIVE_RULESET_2026_09_05, committed);
  const contexts = drift.filter((d) => d.field === "required_status_checks");
  assertEquals(contexts.length, 2);
  const details = contexts.map((d) => d.detail).join("\n");
  assertStringIncludes(details, "validate");
  assertStringIncludes(details, "validate (no-runtime)");
  assert(details.includes("not required"), details);
});

Deno.test("diffLiveRuleset - an identical ruleset reports no drift", async () => {
  const committed = await loadMainBranchRuleset();
  assertEquals(diffLiveRuleset(asLive(committed), committed), []);
});

Deno.test("diffLiveRuleset - reports an extra required context", async () => {
  const committed = await loadMainBranchRuleset();
  const live = asLive(committed) as { rules: Array<Record<string, unknown>> };
  const rule = live.rules.find((r) => r.type === "required_status_checks") as {
    parameters: { required_status_checks: Array<{ context: string }> };
  };
  rule.parameters.required_status_checks.push({ context: "ghost-check" });
  const drift = diffLiveRuleset(live, committed);
  assertEquals(drift.length, 1);
  assertStringIncludes(drift[0]?.detail ?? "", "ghost-check");
});

Deno.test("diffLiveRuleset - reports weakened enforcement and a bypass actor", async () => {
  const committed = await loadMainBranchRuleset();
  const live = asLive(committed);
  live.enforcement = "evaluate";
  live.bypass_actors = [{ actor_type: "RepositoryRole", actor_id: 5 }];
  const fields = diffLiveRuleset(live, committed).map((d) => d.field);
  assert(fields.includes("enforcement"), fields.join(", "));
  assert(fields.includes("bypass_actors"), fields.join(", "));
});

Deno.test("diffLiveRuleset - reports a dropped rule and a loosened policy", async () => {
  const committed = await loadMainBranchRuleset();
  const live = asLive(committed) as { rules: Array<Record<string, unknown>> };
  live.rules = live.rules.filter((r) => r.type !== "non_fast_forward");
  const rule = live.rules.find((r) => r.type === "required_status_checks") as {
    parameters: { strict_required_status_checks_policy: boolean };
  };
  rule.parameters.strict_required_status_checks_policy = false;
  const fields = diffLiveRuleset(live, committed).map((d) => d.field);
  assert(fields.includes("rules"), fields.join(", "));
  assert(
    fields.includes("strict_required_status_checks_policy"),
    fields.join(", "),
  );
});

Deno.test("diffLiveRuleset - reports a changed ref condition", async () => {
  const committed = await loadMainBranchRuleset();
  const live = asLive(committed) as {
    conditions: { ref_name: { include: string[] } };
  };
  live.conditions.ref_name.include = ["refs/heads/main"];
  const fields = diffLiveRuleset(live, committed).map((d) => d.field);
  assert(fields.includes("conditions.ref_name.include"), fields.join(", "));
});
