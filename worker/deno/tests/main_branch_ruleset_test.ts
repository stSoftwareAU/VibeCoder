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

Deno.test("main ruleset - requires the quality gate, and only the quality gate", async () => {
  // One required check: `gate` needs every gated workflow and fails unless
  // each reported success (.github/workflows/quality.yml). The per-job list
  // it replaced is what let a renamed or added shard go unrequired (the
  // 2026-09-05 regression: `validate` itself was missing from the applied
  // ruleset, so a PR whose `deno lint` failed could still auto-merge).
  const contexts = requiredContexts(await loadMainBranchRuleset());
  assertEquals(contexts, ["gate"]);
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

Deno.test("diffLiveRuleset - the ruleset applied on 2026-09-05 does not require the gate", async () => {
  // That snapshot predates the quality gate: it named eleven per-job
  // contexts and missed `validate` (the bug of the day). Against the
  // committed payload it now drifts on the one context that matters.
  const committed = await loadMainBranchRuleset();
  const drift = diffLiveRuleset(LIVE_RULESET_2026_09_05, committed);
  const contexts = drift.filter((d) => d.field === "required_status_checks");
  assert(contexts.length >= 1, "the old snapshot must drift");
  const details = contexts.map((d) => d.detail).join("\n");
  assertStringIncludes(details, "gate");
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

// ---------------------------------------------------------------------------
// Issue #2169 — pull_request parameters are compared, in both directions
// ---------------------------------------------------------------------------

type LiveRules = {
  rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
};

function pullRequestRule(payload: LiveRules): Record<string, unknown> {
  const rule = payload.rules.find((r) => r.type === "pull_request");
  if (!rule?.parameters) throw new Error("no pull_request rule");
  return rule.parameters;
}

Deno.test("diffLiveRuleset - a live pull_request rule weaker than the committed one is drift, not agreement (Issue #2169)", async () => {
  const committed = await loadMainBranchRuleset();
  const live = asLive(committed) as LiveRules;
  pullRequestRule(live).require_code_owner_review = false;
  const drift = diffLiveRuleset(live, committed);
  assertEquals(drift.length, 1, JSON.stringify(drift));
  assertEquals(drift[0]?.field, "rules.pull_request.require_code_owner_review");
  assertStringIncludes(drift[0]?.detail ?? "", "applied false, committed true");
});

Deno.test("diffLiveRuleset - a live pull_request rule stronger than the committed one is drift too — the PUT would downgrade it (Issue #2169)", async () => {
  // The live shape on 2026-09-16: code-owner review on, the file said off.
  const committed = JSON.parse(
    JSON.stringify(await loadMainBranchRuleset()),
  ) as Awaited<ReturnType<typeof loadMainBranchRuleset>>;
  pullRequestRule(committed as unknown as LiveRules).require_code_owner_review =
    false;
  const live = asLive(committed) as LiveRules;
  pullRequestRule(live).require_code_owner_review = true;
  pullRequestRule(live).required_approving_review_count = 1;
  const fields = diffLiveRuleset(live, committed).map((d) => d.field).sort();
  assertEquals(fields, [
    "rules.pull_request.require_code_owner_review",
    "rules.pull_request.required_approving_review_count",
  ]);
});

Deno.test("diffLiveRuleset - a parameter GitHub returns that the file does not carry is drift (Issue #2169)", async () => {
  const committed = await loadMainBranchRuleset();
  const live = asLive(committed) as LiveRules;
  pullRequestRule(live).require_future_setting = true;
  const drift = diffLiveRuleset(live, committed);
  assertEquals(drift.map((d) => d.field), [
    "rules.pull_request.require_future_setting",
  ]);
  assertStringIncludes(drift[0]?.detail ?? "", "not committed");
});

Deno.test("diffLiveRuleset - allowed_merge_methods is compared as a set, so order is not drift but a new method is (Issue #2169)", async () => {
  const committed = await loadMainBranchRuleset();
  const live = asLive(committed) as LiveRules;
  pullRequestRule(live).allowed_merge_methods = ["squash"];
  assertEquals(diffLiveRuleset(live, committed), []);
  pullRequestRule(live).allowed_merge_methods = ["merge", "squash"];
  const drift = diffLiveRuleset(live, committed);
  assertEquals(drift.map((d) => d.field), [
    "rules.pull_request.allowed_merge_methods",
  ]);
});

Deno.test("diffLiveRuleset - the committed main.json requires code-owner review and secret-scanning alert resolution, as the live ruleset does (Issue #2169)", async () => {
  const committed = await loadMainBranchRuleset();
  assertEquals(
    pullRequestRule(committed as unknown as LiveRules)
      .require_code_owner_review,
    true,
  );
  assert(
    committed.rules.some((r) =>
      r.type === "require_secret_scanning_alert_resolution"
    ),
    "the live ruleset carries the secret-scanning rule; the file must too",
  );
});
