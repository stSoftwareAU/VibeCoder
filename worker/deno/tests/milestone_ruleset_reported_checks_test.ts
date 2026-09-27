/**
 * Setup never writes a `milestone/**` ruleset requiring a check no milestone
 * PR reports (Issue #2684).
 *
 * The aligner used to mirror the default branch's required checks in full.
 * Checks whose workflows filter `pull_request.branches` to the default branch
 * (GRQ's `spellcheck`, `validate`, `unit-tests`; NEAT-AI's `update-version`)
 * or that only run against the default branch (NEAT-AI's CodeQL
 * `Analyze (javascript-typescript)`) never report on a milestone PR, so setup
 * wrote a ruleset that held every milestone PR BLOCKED for ever — and then
 * warned about the wedge it had just created.
 *
 * The fixtures below are the live shapes read on 2026-09-27.
 *
 * The owner's target spec for `milestone/**` is also pinned here: required
 * status checks, `strict_required_status_checks_policy: false`, and no
 * `pull_request` rule — whatever the default branch carries.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  fetchMilestonePrCheckNames,
  planMilestoneRulesetSync,
  type RulesetDetail,
  syncMilestoneRuleset,
} from "../lib/milestone_ruleset_check.ts";
import { isRequiredStatusChecksRule } from "../lib/repo_rulesets.ts";
import {
  type MilestoneReportSeams,
  reportMilestoneRuleset,
  type ReportSeverity,
  type SetupIdentity,
} from "../setup/setup_cli.ts";

/** A default-branch ruleset requiring `contexts`. */
function defaultBranch(
  contexts: string[],
  extra: Partial<RulesetDetail> = {},
): RulesetDetail {
  return {
    id: 10,
    name: "Develop-2",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/Develop"] } },
    rules: [{
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: contexts.map((context) => ({ context })),
      },
    }],
    bypass_actors: [
      { actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" },
    ],
    ...extra,
  };
}

/** Setup's own milestone ruleset, currently requiring `contexts`. */
function milestone(contexts: string[]): RulesetDetail {
  return {
    id: 20,
    name: "Vibe Coder milestone branches",
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: { include: ["refs/heads/milestone/**"], exclude: [] },
    },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: true,
          required_status_checks: contexts.map((context) => ({ context })),
        },
      },
    ],
    bypass_actors: [
      { actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" },
    ],
  };
}

/** The contexts a planned body requires. */
function requiredContexts(
  body: { rules: ReadonlyArray<{ type: string }> },
): string[] {
  const rule = body.rules.find(isRequiredStatusChecksRule);
  return (rule?.parameters.required_status_checks ?? []).map((c) => c.context);
}

const GRQ_DEFAULT = [
  "spellcheck",
  "audit",
  "markdownlint",
  "semgrep",
  "actionlint",
  "validate",
  "gitleaks",
  "deno-sbom",
  "rust-sbom",
  "unit-tests",
  "quality",
  "mermaid",
];
/** What GRQ's merged milestone PRs actually report. */
const GRQ_REPORTED = [
  "actionlint",
  "audit",
  "quality",
  "gitleaks",
  "markdownlint",
  "mermaid",
  "deno-sbom",
  "semgrep",
  "rust-sbom",
];

const NEAT_DEFAULT = [
  "Analyze (javascript-typescript)",
  ...Array.from({ length: 8 }, (_, i) => `Coverage shard ${i}`),
  "Lint GitHub Actions workflows",
  "Test Results",
  "update-version",
  "markdownlint",
  "Semgrep SAST scan",
  "shellcheck",
  "spellcheck",
];
const NEAT_REPORTED = [
  "Lint GitHub Actions workflows",
  "Benchmark smoke",
  "dependency-review",
  "markdownlint",
  "quality",
  "Semgrep SAST scan",
  "shellcheck",
  "spellcheck",
  ...Array.from({ length: 8 }, (_, i) => `Coverage shard ${i}`),
  "Score-per-hour regression gate",
  "push-fixes",
  "Merge coverage & results",
  "Test Results",
];

// ---------------------------------------------------------------------------
// The plan: mirror ∩ reported
// ---------------------------------------------------------------------------

Deno.test("planMilestoneRulesetSync - GRQ: drops the checks no milestone PR reports, and names them", () => {
  const plan = planMilestoneRulesetSync(
    [defaultBranch(GRQ_DEFAULT), milestone(GRQ_DEFAULT)],
    "Develop",
    GRQ_REPORTED,
  );
  const write = plan.writes[0];
  assert(write?.kind === "align");
  assertEquals(requiredContexts(write.body), [
    "audit",
    "markdownlint",
    "semgrep",
    "actionlint",
    "gitleaks",
    "deno-sbom",
    "rust-sbom",
    "quality",
    "mermaid",
  ]);
  assertEquals(plan.dropped, ["spellcheck", "validate", "unit-tests"]);
});

Deno.test("planMilestoneRulesetSync - NEAT-AI: drops CodeQL and update-version", () => {
  const plan = planMilestoneRulesetSync(
    [defaultBranch(NEAT_DEFAULT), milestone(NEAT_DEFAULT)],
    "Develop",
    NEAT_REPORTED,
  );
  const write = plan.writes[0];
  assert(write?.kind === "align");
  assertEquals(requiredContexts(write.body).length, 14);
  assertEquals(plan.dropped, [
    "Analyze (javascript-typescript)",
    "update-version",
  ]);
});

Deno.test("planMilestoneRulesetSync - GRQ-AutoTrader: `gate` is reported by merged milestone PRs, so nothing changes", () => {
  const plan = planMilestoneRulesetSync(
    [defaultBranch(["gate"]), milestone(["gate"])],
    "Develop",
    ["recheck", "gitleaks", "semgrep", "lint", "coverage", "gate"],
  );
  assertEquals(plan.writes, []);
  assertEquals(plan.dropped, []);
});

Deno.test("planMilestoneRulesetSync - a missing ruleset is created requiring only reported checks", () => {
  const plan = planMilestoneRulesetSync(
    [defaultBranch(GRQ_DEFAULT)],
    "Develop",
    GRQ_REPORTED,
  );
  const write = plan.writes[0];
  assert(write?.kind === "create");
  assertEquals(requiredContexts(write.body).includes("spellcheck"), false);
  assertEquals(requiredContexts(write.body).length, 9);
});

Deno.test("planMilestoneRulesetSync - a pinned check keeps its integration id when it is kept", () => {
  const pinned: RulesetDetail = {
    ...defaultBranch([]),
    rules: [{
      type: "required_status_checks",
      parameters: {
        required_status_checks: [
          { context: "gate", integration_id: 15368 },
          { context: "update-version" },
        ],
      },
    }],
  };
  const plan = planMilestoneRulesetSync([pinned], "Develop", ["gate"]);
  const write = plan.writes[0];
  assert(write?.kind === "create");
  assertEquals(
    write.body.rules.find(isRequiredStatusChecksRule)?.parameters
      .required_status_checks,
    [{ context: "gate", integration_id: 15368 }],
  );
  assertEquals(plan.dropped, ["update-version"]);
});

// ---------------------------------------------------------------------------
// No evidence: never add a check, never strip one
// ---------------------------------------------------------------------------

Deno.test("planMilestoneRulesetSync - with no merged milestone PR to sample, a new ruleset requires nothing", () => {
  // Requiring an unproven check could wedge the first milestone PR; requiring
  // none leaves the fleet's own merge polling to land it, and the next setup
  // run adds the checks once a PR has reported them.
  const plan = planMilestoneRulesetSync(
    [defaultBranch(GRQ_DEFAULT)],
    "Develop",
    [],
  );
  const write = plan.writes[0];
  assert(write?.kind === "create");
  assertEquals(requiredContexts(write.body), []);
  assertEquals(plan.sampled, false);
  assertEquals(plan.dropped, [], "nothing is claimed without a sample");
});

Deno.test("planMilestoneRulesetSync - with no sample, an existing ruleset keeps the checks it has and gains none", () => {
  // Stripping a gate on no evidence would let an armed PR merge unchecked.
  const plan = planMilestoneRulesetSync(
    [
      defaultBranch(["semgrep", "gitleaks", "spellcheck"]),
      { ...milestone(["semgrep", "spellcheck"]), name: "Milestone" },
    ],
    "Develop",
    [],
  );
  const write = plan.writes[0];
  assert(write?.kind === "align", "the rename still aligns");
  assertEquals(requiredContexts(write.body), ["semgrep", "spellcheck"]);
});

// ---------------------------------------------------------------------------
// The owner's spec: strict off, no pull_request rule — always
// ---------------------------------------------------------------------------

Deno.test("planMilestoneRulesetSync - never writes strict or a pull_request rule, whatever the default branch carries", () => {
  const source = defaultBranch(["semgrep"], {
    rules: [
      {
        type: "pull_request",
        parameters: { required_approving_review_count: 1 },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "semgrep" }],
        },
      },
    ],
  });
  const handMade: RulesetDetail = {
    ...milestone(["semgrep"]),
    rules: [
      ...milestone(["semgrep"]).rules!.map((rule) =>
        rule.type === "required_status_checks"
          ? {
            ...rule,
            parameters: {
              ...rule.parameters,
              strict_required_status_checks_policy: true,
            },
          }
          : rule
      ),
      {
        type: "pull_request",
        parameters: { required_approving_review_count: 1 },
      },
    ],
  };
  const created = planMilestoneRulesetSync([source], "Develop", ["semgrep"]);
  const aligned = planMilestoneRulesetSync(
    [source, handMade],
    "Develop",
    ["semgrep"],
  );
  const bodies = [...created.writes, ...aligned.writes].map((w) => w.body);
  assertEquals(bodies.length, 2);
  for (const body of bodies) {
    assertEquals(body.rules.some((r) => r.type === "pull_request"), false);
    const checks = body.rules.find(isRequiredStatusChecksRule);
    assertEquals(
      checks?.parameters.strict_required_status_checks_policy,
      false,
    );
  }
});

// ---------------------------------------------------------------------------
// The sample: merged PRs only, unioned
// ---------------------------------------------------------------------------

Deno.test("fetchMilestonePrCheckNames - samples MERGED milestone PRs and unions their checks", async () => {
  // GRQ-AutoTrader: its open milestone PR was still running, had not reported
  // `gate` yet, and was the one sampled — so setup claimed `gate` never
  // reports. A merged PR's run is complete, and the union over several is not
  // fooled by one that skipped a job.
  const calls: string[][] = [];
  const names = await fetchMilestonePrCheckNames("org/repo", (args) => {
    calls.push(args);
    return Promise.resolve(JSON.stringify([
      { statusCheckRollup: [{ name: "lint" }, { name: "gate" }] },
      { statusCheckRollup: [{ name: "lint" }, { context: "legacy" }] },
    ]));
  });
  assertEquals(names, ["lint", "gate", "legacy"]);
  assertEquals(calls.length, 1);
  const state = calls[0]![calls[0]!.indexOf("--state") + 1];
  assertEquals(state, "merged", "an in-flight open PR is never the sample");
  assert(Number(calls[0]![calls[0]!.indexOf("--limit") + 1]) > 1);
});

Deno.test("fetchMilestonePrCheckNames - an unreadable listing claims nothing", async () => {
  assertEquals(
    await fetchMilestonePrCheckNames(
      "org/repo",
      () => Promise.reject(new Error("gh: HTTP 502")),
    ),
    [],
  );
});

// ---------------------------------------------------------------------------
// Composition: what a setup run writes and prints
// ---------------------------------------------------------------------------

/** Seams serving `rulesets`, a merged-PR sample, and recording writes. */
function seamsFor(rulesets: RulesetDetail[], reported: string[]) {
  const printed: Array<{ severity: ReportSeverity; message: string }> = [];
  const writes: Array<{ identity: SetupIdentity; body: unknown }> = [];
  const seams: MilestoneReportSeams = {
    ghFor: (identity) => (args: string[], stdin?: string) => {
      const path = args[1] ?? "";
      if (args.includes("-X") && stdin !== undefined) {
        writes.push({ identity, body: JSON.parse(stdin) });
        return Promise.resolve("");
      }
      if (args[0] === "pr") {
        return Promise.resolve(JSON.stringify([{
          statusCheckRollup: reported.map((name) => ({ name })),
        }]));
      }
      if (/\/rulesets$/.test(path)) {
        return Promise.resolve(
          JSON.stringify(rulesets.map((r) => ({ id: r.id, name: r.name }))),
        );
      }
      if (path.includes("/rulesets/")) {
        const id = Number(path.split("/").pop());
        return Promise.resolve(
          JSON.stringify(rulesets.find((r) => r.id === id)),
        );
      }
      return Promise.resolve("write");
    },
    print: (severity, message) => printed.push({ severity, message }),
  };
  return { seams, printed, writes };
}

Deno.test("reportMilestoneRuleset - GRQ: aligns away the wedge, names the dropped checks, and reports no unreportable-check error", async () => {
  const current = [defaultBranch(GRQ_DEFAULT), milestone(GRQ_DEFAULT)];
  const { seams, printed, writes } = seamsFor(current, GRQ_REPORTED);

  const errors = await reportMilestoneRuleset(
    { repo: "stSoftwareAU/GRQ", branch: "Develop" },
    "VibeCoderST",
    current,
    seams,
  );

  assertEquals(writes.length, 1);
  assertEquals(
    requiredContexts(writes[0]!.body as { rules: { type: string }[] }).length,
    9,
  );
  const success = printed.find((p) => p.severity === "success");
  assert(success);
  assertStringIncludes(success.message, "requiring 9 check(s)");
  assertStringIncludes(success.message, "spellcheck, validate, unit-tests");
  assertEquals(errors, 0);
  assert(
    !printed.some((p) => p.message.includes("no milestone PR reports:")),
    "setup must not warn about a wedge it no longer writes",
  );
});

Deno.test("reportMilestoneRuleset - a ruleset already without the unreported checks still names them, as info", async () => {
  const current = [defaultBranch(GRQ_DEFAULT), milestone(GRQ_REPORTED)];
  const { seams, printed, writes } = seamsFor(current, GRQ_REPORTED);

  await reportMilestoneRuleset(
    { repo: "stSoftwareAU/GRQ", branch: "Develop" },
    "VibeCoderST",
    current,
    seams,
  );

  assertEquals(writes, []);
  const info = printed.filter((p) =>
    p.severity === "info" && p.message.includes("spellcheck")
  );
  assertEquals(info.length, 1);
});

Deno.test("reportMilestoneRuleset - the gated-but-not-bypassing state prints no stale #589 warning", async () => {
  // #589 is closed: a refused push raises (or updates) a sync PR, so "the
  // sync still pushes directly and is REJECTED" describes nothing real.
  const current = [defaultBranch(GRQ_DEFAULT), milestone(GRQ_REPORTED)];
  const { seams, printed } = seamsFor(current, GRQ_REPORTED);

  await reportMilestoneRuleset(
    { repo: "stSoftwareAU/GRQ", branch: "Develop" },
    "VibeCoderST",
    current,
    seams,
  );

  for (const line of printed) {
    assert(!line.message.includes("REJECTED"), line.message);
    assert(!line.message.includes("still pushes directly"), line.message);
  }
});

Deno.test("syncMilestoneRuleset - samples the milestone PRs itself when none are injected", async () => {
  const current = [defaultBranch(NEAT_DEFAULT), milestone(NEAT_DEFAULT)];
  const { seams, writes } = seamsFor(current, NEAT_REPORTED);
  const result = await syncMilestoneRuleset(
    "stSoftwareAU/NEAT-AI",
    seams.ghFor("operator"),
    { defaultBranch: "Develop" },
  );
  assert(result.ok);
  assertEquals(result.dropped, [
    "Analyze (javascript-typescript)",
    "update-version",
  ]);
  assertEquals(writes.length, 1);
});
