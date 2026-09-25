/**
 * Tests for repairing a `milestone/**` ruleset that blocks branch CREATION
 * (Issue #2067).
 *
 * The fleet created the trap itself: `buildMilestoneRulesetBody` wrote a
 * `required_status_checks` rule without `do_not_enforce_on_create`, GitHub
 * defaulted that to false, and from then on every push that would create a
 * `milestone/**` branch was declined. stSoftwareAU/GRQ-FX-validation carried
 * exactly that ruleset ("Vibe Coder milestone branches", created
 * 2026-08-31, `do_not_enforce_on_create: false`, no bypass actors) and every
 * run died inside a minute in `setup`:
 *
 * ```text
 * ! [remote rejected] Develop -> milestone/scan-20260910
 *     (push declined due to repository rule violations)
 * ```
 *
 * Fixing the builder stops new repositories being trapped; these tests cover
 * the other half — a repository already carrying the broken ruleset is
 * repaired in place the next time setup runs.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildCreateExemptRulesetBody,
  planMilestoneRulesetRepair,
  repairMilestoneRulesetCreateBlock,
  type RulesetDetail,
} from "../lib/milestone_ruleset_check.ts";
import {
  type MilestoneReportSeams,
  reportMilestoneRuleset,
  type ReportSeverity,
  type SetupIdentity,
} from "../setup/setup_cli.ts";

/** The ruleset as GRQ-FX-validation carried it — creation refused. */
const BLOCKED: RulesetDetail = {
  id: 21913326,
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
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: [
          { context: "Quality Gate" },
          { context: "gitleaks" },
        ],
      },
    },
  ],
  bypass_actors: [
    { actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" },
  ],
};

/** The same ruleset once repaired. */
const REPAIRED: RulesetDetail = {
  ...BLOCKED,
  rules: BLOCKED.rules!.map((rule) =>
    rule.type === "required_status_checks"
      ? {
        ...rule,
        parameters: { ...rule.parameters, do_not_enforce_on_create: true },
      }
      : rule
  ),
};

/** A `gh` stub recording every write it is handed. */
function ghRecording(
  details: RulesetDetail[],
  onWrite?: (args: string[], stdin?: string) => Promise<string>,
) {
  const writes: Array<{ args: string[]; body: unknown }> = [];
  const gh = (args: string[], stdin?: string): Promise<string> => {
    if (stdin !== undefined) {
      writes.push({ args, body: JSON.parse(stdin) });
      return onWrite ? onWrite(args, stdin) : Promise.resolve("ok");
    }
    const path = args[1] ?? "";
    if (/\/rulesets$/.test(path)) {
      return Promise.resolve(
        JSON.stringify(details.map((d) => ({ id: d.id, name: d.name }))),
      );
    }
    const id = Number(path.split("/").pop());
    const found = details.find((d) => d.id === id);
    if (!found) return Promise.reject(new Error("gh: Not Found (HTTP 404)"));
    return Promise.resolve(JSON.stringify(found));
  };
  return { gh, writes };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

Deno.test("planMilestoneRulesetRepair - names the ruleset that blocks creation", () => {
  assertEquals(planMilestoneRulesetRepair([BLOCKED])?.id, BLOCKED.id);
});

Deno.test("planMilestoneRulesetRepair - a rule missing the flag entirely also blocks", () => {
  // GitHub defaults the absent flag to false, which is the shape the fleet's
  // own builder wrote before this fix.
  const absent: RulesetDetail = {
    ...BLOCKED,
    rules: [{
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "quality" }] },
    }],
  };
  assertEquals(planMilestoneRulesetRepair([absent])?.id, BLOCKED.id);
});

Deno.test("planMilestoneRulesetRepair - an already-exempt ruleset needs nothing", () => {
  assertEquals(planMilestoneRulesetRepair([REPAIRED]), null);
});

Deno.test("planMilestoneRulesetRepair - a ruleset requiring no checks needs nothing", () => {
  const noChecks: RulesetDetail = { ...BLOCKED, rules: [{ type: "deletion" }] };
  assertEquals(planMilestoneRulesetRepair([noChecks]), null);
});

Deno.test("planMilestoneRulesetRepair - a ruleset that gates nothing is left alone", () => {
  const disabled: RulesetDetail = { ...BLOCKED, enforcement: "disabled" };
  assertEquals(planMilestoneRulesetRepair([disabled]), null);
});

Deno.test("planMilestoneRulesetRepair - a ruleset reaching beyond milestone branches is left alone", () => {
  // `~ALL` and a default-branch pattern cover refs this repair has no mandate
  // over: the write would change how every branch in the repository is
  // gated, so it is reported rather than applied.
  for (const include of [["~ALL"], ["~DEFAULT_BRANCH"], ["refs/heads/**"]]) {
    const wide: RulesetDetail = {
      ...BLOCKED,
      conditions: { ref_name: { include, exclude: [] } },
    };
    assertEquals(
      planMilestoneRulesetRepair([wide]),
      null,
      `expected no repair for ${include.join(",")}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

Deno.test("buildCreateExemptRulesetBody - sets the flag and preserves everything else", () => {
  const body = buildCreateExemptRulesetBody(BLOCKED) as {
    name: string;
    target: string;
    enforcement: string;
    conditions: unknown;
    bypass_actors: unknown;
    rules: Array<{ type?: string; parameters?: Record<string, unknown> }>;
  };

  assertEquals(body.name, BLOCKED.name);
  assertEquals(body.target, "branch");
  assertEquals(body.enforcement, "active");
  assertEquals(body.conditions, BLOCKED.conditions);
  assertEquals(body.bypass_actors, BLOCKED.bypass_actors);
  // Every rule survives — a ruleset write is a full-document PUT, so a body
  // rebuilt from the checks alone would silently drop `deletion` and
  // `non_fast_forward` and lose the collection branch's protection.
  assertEquals(body.rules.map((r) => r.type), [
    "deletion",
    "non_fast_forward",
    "required_status_checks",
  ]);
  const checks = body.rules.find((r) => r.type === "required_status_checks");
  assertEquals(checks?.parameters?.do_not_enforce_on_create, true);
  assertEquals(checks?.parameters?.required_status_checks, [
    { context: "Quality Gate" },
    { context: "gitleaks" },
  ]);
  assertEquals(checks?.parameters?.strict_required_status_checks_policy, true);
});

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

Deno.test("repairMilestoneRulesetCreateBlock - PUTs the exempted ruleset back", async () => {
  const { gh, writes } = ghRecording([BLOCKED]);

  const result = await repairMilestoneRulesetCreateBlock("org/repo", gh);

  assert(result.ok, "the repair must succeed");
  assert(result.repaired);
  assertEquals(result.ruleset, "Vibe Coder milestone branches");
  assertEquals(writes.length, 1);
  assertEquals(writes[0]!.args.slice(0, 5), [
    "api",
    "-X",
    "PUT",
    `repos/org/repo/rulesets/${BLOCKED.id}`,
    "--input",
  ]);
  const body = writes[0]!.body as {
    rules: Array<{ type?: string; parameters?: Record<string, unknown> }>;
  };
  assertEquals(
    body.rules.find((r) => r.type === "required_status_checks")
      ?.parameters?.do_not_enforce_on_create,
    true,
  );
});

Deno.test("repairMilestoneRulesetCreateBlock - a repaired repository is never written twice", async () => {
  const { gh, writes } = ghRecording([REPAIRED]);

  const result = await repairMilestoneRulesetCreateBlock("org/repo", gh);

  assert(result.ok);
  assert(!result.repaired);
  assertStringIncludes(result.reason, "no milestone ruleset blocks");
  assertEquals(writes.length, 0, "an idempotent pass must not write");
});

Deno.test("repairMilestoneRulesetCreateBlock - an unreadable ruleset list fails loudly", async () => {
  // "Could not read" must never be reduced to "nothing to repair": that would
  // report a broken repository as healthy (Issue #678's lesson, here).
  const result = await repairMilestoneRulesetCreateBlock(
    "org/repo",
    () => Promise.resolve(""),
  );

  assert(!result.ok);
  assertStringIncludes(result.error.message, "rulesets");
});

Deno.test("repairMilestoneRulesetCreateBlock - a 404 is explained as a permission problem", async () => {
  // GitHub answers a ruleset write from a non-admin with 404, not 403
  // (Issue #595) — the bare "Not Found" names neither cause nor fix.
  const { gh } = ghRecording(
    [BLOCKED],
    () => Promise.reject(new Error("gh: Not Found (HTTP 404)")),
  );

  const result = await repairMilestoneRulesetCreateBlock("org/repo", gh);

  assert(!result.ok);
  assertStringIncludes(result.error.message, "ADMIN on org/repo");
});

Deno.test("repairMilestoneRulesetCreateBlock - an invalid repo slug is refused before any call", async () => {
  let called = false;
  const result = await repairMilestoneRulesetCreateBlock(
    "org/repo; rm -rf /",
    () => {
      called = true;
      return Promise.resolve("[]");
    },
  );

  assert(!result.ok);
  assertStringIncludes(result.error.message, "Invalid repo");
  assert(!called, "an invalid slug must never reach `gh`");
});

// ---------------------------------------------------------------------------
// The setup wiring — the only identity that can do this write
// ---------------------------------------------------------------------------

/**
 * {@link BLOCKED} on a single-segment `milestone/*` include. Since Issue #2623
 * setup first aligns any ruleset whose include is exactly
 * `refs/heads/milestone/**`, which also clears the create block; the repair
 * below is what still reaches a milestone-only ruleset the sync does not own,
 * so these wiring tests exercise it on one.
 */
const BLOCKED_UNOWNED: RulesetDetail = {
  ...BLOCKED,
  conditions: {
    ref_name: { include: ["refs/heads/milestone/*"], exclude: [] },
  },
};

/** Seams for `reportMilestoneRuleset` recording writes and their identity. */
function reportSeams(details: RulesetDetail[]) {
  const writes: Array<{ identity: SetupIdentity; body: unknown }> = [];
  const printed: Array<{ severity: ReportSeverity; message: string }> = [];
  const { gh } = ghRecording(details);
  const seams: MilestoneReportSeams = {
    ghFor: (identity) => (args: string[], stdin?: string) => {
      if (stdin !== undefined) {
        writes.push({ identity, body: JSON.parse(stdin) });
        return Promise.resolve("ok");
      }
      // The service account reads nothing: setup reads once and passes the
      // rulesets down, so a second read under that identity is a defect.
      if (args[0] === "pr") return Promise.resolve("[]");
      if ((args[1] ?? "").includes("/rulesets")) {
        if (identity === "service-account") {
          return Promise.reject(new Error("must not re-read the rulesets"));
        }
        return gh(args);
      }
      return Promise.resolve("write");
    },
    print: (severity, message) => printed.push({ severity, message }),
  };
  return { seams, writes, printed };
}

Deno.test("reportMilestoneRuleset - a create-blocking ruleset is repaired under the OPERATOR identity", async () => {
  // The whole of Issue #2067 end to end: setup finds the ruleset that makes
  // every run on the repository die in `setup`, and clears it. A ruleset
  // write needs admin, which only the operator identity holds (Issue #595).
  const { seams, writes, printed } = reportSeams([BLOCKED_UNOWNED]);

  const errors = await reportMilestoneRuleset(
    { repo: "org/repo", branch: "Develop" },
    "VibeCoderST",
    [BLOCKED_UNOWNED],
    seams,
  );

  assertEquals(writes.length, 1);
  assertEquals(writes[0]!.identity, "operator");
  assert(
    printed.some((p) =>
      p.severity === "success" && p.message.includes("branch creation")
    ),
    `expected a success line, got: ${
      printed.map((p) => `${p.severity}:${p.message}`).join(" || ")
    }`,
  );
  // The finding it just fixed must not also be reported as an outstanding
  // error — a repaired repository is a clean one.
  assert(
    !printed.some((p) => p.severity === "error"),
    "a repaired ruleset must not still be reported as an error",
  );
  assertEquals(errors, 0);
});

Deno.test("reportMilestoneRuleset - a healthy ruleset is never written to", async () => {
  const repairedUnowned = {
    ...REPAIRED,
    conditions: BLOCKED_UNOWNED.conditions,
  };
  const { seams, writes, printed } = reportSeams([repairedUnowned]);

  const errors = await reportMilestoneRuleset(
    { repo: "org/repo", branch: "Develop" },
    "VibeCoderST",
    [repairedUnowned],
    seams,
  );

  assertEquals(writes, [], "an idempotent pass must not write");
  assertEquals(errors, 0);
  assertEquals(printed.filter((p) => p.severity === "error"), []);
});

Deno.test("reportMilestoneRuleset - a refused repair warns and still reports the fault", async () => {
  // Never fail silently: when the write is refused the repository is still
  // broken, so the error finding must survive to the operator.
  const { printed } = reportSeams([BLOCKED_UNOWNED]);
  const refusing: MilestoneReportSeams = {
    ghFor: (identity) => (args: string[], stdin?: string) => {
      if (stdin !== undefined) {
        return Promise.reject(new Error("gh: Not Found (HTTP 404)"));
      }
      if (args[0] === "pr") return Promise.resolve("[]");
      if ((args[1] ?? "").includes("/rulesets")) {
        return identity === "service-account"
          ? Promise.reject(new Error("must not re-read the rulesets"))
          : ghRecording([BLOCKED_UNOWNED]).gh(args);
      }
      return Promise.resolve("write");
    },
    print: (severity, message) => printed.push({ severity, message }),
  };

  const errors = await reportMilestoneRuleset(
    { repo: "org/repo", branch: "Develop" },
    "VibeCoderST",
    [BLOCKED_UNOWNED],
    refusing,
  );

  assert(errors > 0, "a repository still blocked must report an error");
  const warning = printed.find((p) =>
    p.severity === "warning" && p.message.includes("could not exempt")
  );
  assert(
    warning,
    `a refused repair must warn, got: ${
      printed.map((p) => `${p.severity}:${p.message}`).join(" || ")
    }`,
  );
  assertStringIncludes(warning.message, "ADMIN on org/repo");
});
