/**
 * Tests for the milestone-ruleset READ path and the create-or-align decision
 * setup makes from it (Issues #678, #2623).
 *
 * Issue #2623 removed setup's `[y/N]` question: a missing ruleset is now
 * created and a differing one aligned, on every run. The tests below that
 * asserted the question (asked, not asked, answered yes) were rewritten to
 * assert the write that replaced it.
 *
 * `setup.sh` kept re-asking "no ruleset covers `milestone/**` … create one?"
 * on repositories where a previous run had already answered yes. Two ways a
 * run reached that question with nothing an answer could change:
 *
 * 1. The rulesets could not be READ, and the failure was turned into an empty
 *    list — indistinguishable from "this repository has no rulesets".
 * 2. There was no default-branch ruleset to mirror, so answering yes could
 *    never create anything; the question came back every run for ever.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyMilestoneSyncOutcomes,
  checkMilestoneRuleset,
  planMilestoneRulesetSync,
  readRulesetDetails,
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

const MILESTONE: RulesetDetail = {
  id: 2,
  name: "Vibe Coder milestone branches",
  enforcement: "active",
  conditions: { ref_name: { include: ["refs/heads/milestone/**"] } },
  rules: [{
    type: "required_status_checks",
    parameters: {
      required_status_checks: [{ context: "semgrep" }],
      // A correct milestone ruleset is exempt on create (Issue #3912
      // follow-up): the checks gate the merge, but a branch that does not
      // exist yet has no check runs, so enforcing them on creation makes the
      // milestone branch impossible to open.
      do_not_enforce_on_create: true,
      // …and it requires the branch to be up to date (Issue #2461): an armed
      // child PR whose base is behind the default branch is held by this and
      // nothing else.
      strict_required_status_checks_policy: true,
    },
  }],
  bypass_actors: [
    { actor_type: "RepositoryRole", actor_id: 3, bypass_mode: "always" },
  ],
};

const DEFAULT_BRANCH: RulesetDetail = {
  id: 1,
  name: "Vibe Coder default branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
  rules: [{
    type: "required_status_checks",
    parameters: { required_status_checks: [{ context: "semgrep" }] },
  }],
  bypass_actors: [],
};

/** A `gh` stub serving the list and detail endpoints from fixtures. */
function ghServing(details: RulesetDetail[]) {
  return (args: string[]): Promise<string> => {
    const path = args[1] ?? "";
    if (/\/rulesets$/.test(path)) {
      return Promise.resolve(
        JSON.stringify(details.map((d) => ({ id: d.id, name: d.name }))),
      );
    }
    if (!path.includes("/rulesets/")) return Promise.resolve("write");
    const id = Number(path.split("/").pop());
    const found = details.find((d) => d.id === id);
    if (!found) return Promise.reject(new Error("gh: Not Found (HTTP 404)"));
    return Promise.resolve(JSON.stringify(found));
  };
}

// ---------------------------------------------------------------------------
// The read itself: a failure is a failure, never an absence
// ---------------------------------------------------------------------------

Deno.test("readRulesetDetails - returns every ruleset in detail shape", async () => {
  const read = await readRulesetDetails(
    "org/repo",
    ghServing([DEFAULT_BRANCH, MILESTONE]),
  );
  assert(read.ok);
  assertEquals(read.rulesets.map((r) => r.name), [
    "Vibe Coder default branch",
    "Vibe Coder milestone branches",
  ]);
});

Deno.test("readRulesetDetails - a failed list read is a failure, not an empty repository", async () => {
  // Reading rulesets needs administration access on some repositories, and
  // GitHub answers a read it will not serve with 404. Returning [] there said
  // "this repository has no rulesets", which is how the create question kept
  // coming back (Issue #678).
  const read = await readRulesetDetails(
    "org/repo",
    () => Promise.reject(new Error("gh: Not Found (HTTP 404)")),
  );
  assert(!read.ok, "an unreadable ruleset list must not read as empty");
  assertStringIncludes(read.error.message, "HTTP 404");
});

Deno.test("readRulesetDetails - a ruleset whose detail cannot be read fails the whole read", async () => {
  // The unreadable one could be the milestone ruleset; skipping it silently
  // would report the ruleset as missing.
  const gh = (args: string[]): Promise<string> => {
    const path = args[1] ?? "";
    if (/\/rulesets$/.test(path)) return Promise.resolve('[{"id":2}]');
    return Promise.reject(new Error("gh: Forbidden (HTTP 403)"));
  };
  const read = await readRulesetDetails("org/repo", gh);
  assert(!read.ok);
  assertStringIncludes(read.error.message, "2");
  assertStringIncludes(read.error.message, "HTTP 403");
});

Deno.test("readRulesetDetails - a non-array list body is a failure", async () => {
  const read = await readRulesetDetails(
    "org/repo",
    () => Promise.resolve('{"message":"Not Found"}'),
  );
  assert(!read.ok, "an unexpected body must never be read as no rulesets");
});

Deno.test("readRulesetDetails - an empty list body is a failure, not an empty repository", async () => {
  // `gh` prints nothing when it could not serve the read. Reading that as "no
  // rulesets" is the same silent failure one code path over (Issue #678).
  const read = await readRulesetDetails("org/repo", () => Promise.resolve(""));
  assert(!read.ok, "an empty body must never be read as no rulesets");
  assertStringIncludes(read.error.message, "empty body");
});

Deno.test("readRulesetDetails - a summary with no id fails rather than being skipped", async () => {
  // The one that could not be addressed may be the milestone ruleset.
  const read = await readRulesetDetails(
    "org/repo",
    () => Promise.resolve('[{"name":"no id here"}]'),
  );
  assert(!read.ok, "an unaddressable ruleset must not be dropped in silence");
  assertStringIncludes(read.error.message, "no id");
});

Deno.test("readRulesetDetails - an organisation-inherited ruleset is read from the org endpoint", async () => {
  // The list endpoint includes rulesets INHERITED from the organisation, and
  // GitHub answers `repos/{repo}/rulesets/{id}` for one of those with 404.
  // Reading every id from the repository path failed the whole read on any
  // repo whose org defines a ruleset — which, now that a failed read is loud,
  // would warn on every run about a repository whose `milestone/**` ruleset is
  // present and perfectly readable (Issue #678).
  const paths: string[] = [];
  const gh = (args: string[]): Promise<string> => {
    const path = args[1] ?? "";
    paths.push(path);
    if (/\/rulesets$/.test(path)) {
      return Promise.resolve(JSON.stringify([
        {
          id: 7,
          name: "org baseline",
          source_type: "Organization",
          source: "org",
        },
        { id: 2, name: MILESTONE.name, source_type: "Repository" },
      ]));
    }
    if (path === "orgs/org/rulesets/7") {
      return Promise.resolve(JSON.stringify({ id: 7, name: "org baseline" }));
    }
    if (path === "repos/org/repo/rulesets/2") {
      return Promise.resolve(JSON.stringify(MILESTONE));
    }
    return Promise.reject(new Error(`gh: Not Found (HTTP 404) for ${path}`));
  };

  const read = await readRulesetDetails("org/repo", gh);
  assert(read.ok, "an inherited ruleset must not fail the whole read");
  assertEquals(read.rulesets.map((r) => r.id), [7, 2]);
  assert(
    paths.includes("orgs/org/rulesets/7"),
    "the inherited ruleset must be fetched from the organisation endpoint",
  );
});

// ---------------------------------------------------------------------------
// The check: what setup asks its question from
// ---------------------------------------------------------------------------

Deno.test("checkMilestoneRuleset - an unreadable state is reported as unreadable, never as missing", async () => {
  const findings = await checkMilestoneRuleset(
    "org/repo",
    "VibeCoderST",
    () => Promise.reject(new Error("gh: Not Found (HTTP 404)")),
  );
  assertEquals(findings.map((f) => f.code), ["ruleset-read-failed"]);
  assertEquals(findings[0]!.severity, "warning");
  assertStringIncludes(findings[0]!.message, "HTTP 404");
});

Deno.test("checkMilestoneRuleset - an existing milestone ruleset is seen through the read path", async () => {
  // The regression: the run after the one that created the ruleset must not
  // report it missing, so setup has nothing to ask about (Issue #678).
  const findings = await checkMilestoneRuleset(
    "org/repo",
    "VibeCoderST",
    ghServing([DEFAULT_BRANCH, MILESTONE]),
  );
  assertEquals(
    findings.filter((f) => f.code === "no-milestone-ruleset").length,
    0,
    "a ruleset that exists must never be reported as missing",
  );
});

Deno.test("checkMilestoneRuleset - reuses the rulesets the caller already read", async () => {
  // Setup reads them once per repo and passes them down; no second read.
  const findings = await checkMilestoneRuleset(
    "org/repo",
    "VibeCoderST",
    (args: string[]) => {
      if ((args[1] ?? "").includes("/rulesets")) {
        return Promise.reject(new Error("must not re-read the rulesets"));
      }
      return Promise.resolve("write");
    },
    { rulesets: [DEFAULT_BRANCH, MILESTONE] },
  );
  assertEquals(
    findings.filter((f) => f.code === "no-milestone-ruleset").length,
    0,
  );
});

// ---------------------------------------------------------------------------
// The decision: create what is missing, align what differs (Issue #2623)
// ---------------------------------------------------------------------------

/** The template as setup writes it for {@link DEFAULT_BRANCH}. */
const ALIGNED: RulesetDetail = {
  id: 3,
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
        required_status_checks: [{ context: "semgrep" }],
      },
    },
  ],
  bypass_actors: [],
};

Deno.test("planMilestoneRulesetSync - a ruleset already on the template needs no write", () => {
  const plan = planMilestoneRulesetSync([DEFAULT_BRANCH, ALIGNED], "main");
  assertEquals(plan.writes, []);
  assertEquals(plan.skipped, []);
});

Deno.test("planMilestoneRulesetSync - a missing ruleset is created, active, mirroring the checks", () => {
  const plan = planMilestoneRulesetSync([DEFAULT_BRANCH], "main");
  assertEquals(plan.writes.length, 1);
  const write = plan.writes[0]!;
  assert(write.kind === "create");
  assertEquals(write.body.enforcement, "active");
  assertEquals(write.body.name, "Vibe Coder milestone branches");
});

Deno.test("planMilestoneRulesetSync - a repository with no rulesets at all still gets one", () => {
  // Nothing to mirror: deletion and force-push protection only, no bypass.
  const plan = planMilestoneRulesetSync([], "main");
  const write = plan.writes[0];
  assert(write?.kind === "create");
  assertEquals(write.body.rules.map((r) => r.type), [
    "deletion",
    "non_fast_forward",
  ]);
  assertEquals(write.body.bypass_actors, undefined);
});

Deno.test("planMilestoneRulesetSync - a hand-made ruleset is aligned: renamed, strict off, extra rules dropped", () => {
  // VibeCoder's own "Milestone" ruleset, plus a review requirement someone
  // added later — the template has no `pull_request` rule, so it goes.
  const handMade: RulesetDetail = {
    ...MILESTONE,
    name: "Milestone",
    rules: [
      ...MILESTONE.rules!,
      {
        type: "pull_request",
        parameters: { required_approving_review_count: 1 },
      },
    ],
  };
  const plan = planMilestoneRulesetSync([DEFAULT_BRANCH, handMade], "main");
  assertEquals(plan.writes.length, 1);
  const write = plan.writes[0]!;
  assert(write.kind === "align");
  assertEquals(write.id, MILESTONE.id);
  assertEquals(write.previousName, "Milestone");
  assertEquals(write.body.name, "Vibe Coder milestone branches");
  assertEquals(write.body.rules.map((r) => r.type), [
    "deletion",
    "non_fast_forward",
    "required_status_checks",
  ]);
  const checks = write.body.rules.find(isRequiredStatusChecksRule);
  assertEquals(checks?.parameters.strict_required_status_checks_policy, false);
  assertEquals(checks?.parameters.do_not_enforce_on_create, true);
  // Bypass actors mirror the default branch — sent even when empty, so the
  // full-document PUT removes the stale role-3 bypass.
  assertEquals(write.body.bypass_actors, []);
});

Deno.test("planMilestoneRulesetSync - an aligned ruleset mirrors the default branch's checks, not its own", () => {
  // GRQ: its milestone ruleset required 2 checks while its default branch
  // (an explicit `refs/heads/Develop` ruleset) requires more.
  const develop: RulesetDetail = {
    id: 10,
    name: "Develop-2",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/Develop"] } },
    rules: [{
      type: "required_status_checks",
      parameters: {
        required_status_checks: [
          { context: "gitleaks", integration_id: 15368 },
          { context: "semgrep", integration_id: 15368 },
          { context: "quality" },
        ],
      },
    }],
  };
  const plan = planMilestoneRulesetSync([develop, MILESTONE], "Develop");
  const write = plan.writes[0];
  assert(write?.kind === "align");
  assertEquals(
    write.body.rules.find(isRequiredStatusChecksRule)?.parameters
      .required_status_checks,
    [
      { context: "gitleaks", integration_id: 15368 },
      { context: "semgrep", integration_id: 15368 },
      { context: "quality" },
    ],
  );
});

Deno.test("planMilestoneRulesetSync - a later hand edit to a Vibe-named ruleset is reverted", () => {
  const edited: RulesetDetail = {
    ...ALIGNED,
    rules: ALIGNED.rules!.map((rule) =>
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
  };
  const plan = planMilestoneRulesetSync([DEFAULT_BRANCH, edited], "main");
  assertEquals(plan.writes.map((w) => w.kind), ["align"]);
});

Deno.test("planMilestoneRulesetSync - aligning never changes a human-chosen enforcement", () => {
  for (const enforcement of ["disabled", "evaluate"]) {
    const plan = planMilestoneRulesetSync(
      [DEFAULT_BRANCH, { ...MILESTONE, enforcement }],
      "main",
    );
    const write = plan.writes[0];
    assert(write?.kind === "align", enforcement);
    assertEquals(write.body.enforcement, enforcement);
  }
  // …and a disabled ruleset already on the template is left alone entirely.
  const plan = planMilestoneRulesetSync(
    [DEFAULT_BRANCH, { ...ALIGNED, enforcement: "disabled" }],
    "main",
  );
  assertEquals(plan.writes, []);
});

Deno.test("planMilestoneRulesetSync - a broader ruleset covering milestone branches is left untouched", () => {
  const broad: RulesetDetail = {
    ...MILESTONE,
    conditions: {
      ref_name: {
        include: ["refs/heads/milestone/**", "refs/heads/release/**"],
      },
    },
  };
  const plan = planMilestoneRulesetSync([DEFAULT_BRANCH, broad], "main");
  assertEquals(plan.writes, [], "covered, and not setup's to align");
});

Deno.test("planMilestoneRulesetSync - an unrecognised enforcement is skipped with a reason, never guessed", () => {
  const plan = planMilestoneRulesetSync(
    [DEFAULT_BRANCH, { ...MILESTONE, enforcement: "paused" }],
    "main",
  );
  assertEquals(plan.writes, []);
  assertEquals(plan.skipped.length, 1);
  assertStringIncludes(plan.skipped[0]!.reason, "paused");
});

Deno.test("syncMilestoneRuleset - an unreadable ruleset list fails loud instead of guessing", async () => {
  // Deciding "nothing covers milestone/**" from a read that failed could
  // create a second, conflicting ruleset.
  const result = await syncMilestoneRuleset(
    "org/repo",
    () => Promise.reject(new Error("gh: Not Found (HTTP 404)")),
  );
  assert(!result.ok, "a failed read must not be treated as no rulesets");
  assertStringIncludes(result.error.message, "HTTP 404");
});

Deno.test("syncMilestoneRuleset - aligns with a PUT to the ruleset's own id", async () => {
  const writes: Array<{ args: string[]; body: unknown }> = [];
  const serve = ghServing([DEFAULT_BRANCH, MILESTONE]);
  const result = await syncMilestoneRuleset(
    "org/repo",
    (args, stdin) => {
      if (stdin !== undefined) {
        writes.push({ args, body: JSON.parse(stdin) });
        return Promise.resolve("");
      }
      return serve(args);
    },
    { defaultBranch: "main" },
  );
  assert(result.ok);
  assertEquals(result.outcomes.map((o) => o.kind), ["aligned"]);
  assertEquals(writes.length, 1);
  assertEquals(writes[0]!.args.slice(0, 4), [
    "api",
    "-X",
    "PUT",
    "repos/org/repo/rulesets/2",
  ]);
});

Deno.test("syncMilestoneRuleset - rejects an invalid slug before reaching gh", async () => {
  let called = false;
  const result = await syncMilestoneRuleset("org/repo; rm -rf /", () => {
    called = true;
    return Promise.resolve("[]");
  });
  assert(!result.ok);
  assert(!called);
});

Deno.test("applyMilestoneSyncOutcomes - reports the repository setup leaves behind", () => {
  const plan = planMilestoneRulesetSync([DEFAULT_BRANCH, MILESTONE], "main");
  const write = plan.writes[0];
  assert(write?.kind === "align");
  const after = applyMilestoneSyncOutcomes([DEFAULT_BRANCH, MILESTONE], [{
    kind: "aligned",
    ruleset: write.body.name,
    previousName: write.previousName,
    id: write.id,
    body: write.body,
  }]);
  assertEquals(after.length, 2);
  assertEquals(planMilestoneRulesetSync(after, "main").writes, []);
});

// ---------------------------------------------------------------------------
// The wiring: what a setup run actually writes and prints (Issues #678, #2623)
// ---------------------------------------------------------------------------

/**
 * Records every line printed, every write and the identity used.
 *
 * The `service-account` runner REFUSES to read rulesets: setup reads them once
 * and passes them down, so a second read under that identity is a defect. The
 * `operator` runner serves them, because the sync deliberately re-reads under
 * the only identity holding `admin` (Issue #595).
 */
function recordingSeams(options: {
  rulesets?: RulesetDetail[];
  onWrite?: (identity: SetupIdentity) => Promise<string>;
} = {}) {
  const printed: Array<{ severity: ReportSeverity; message: string }> = [];
  const writes: Array<{ identity: SetupIdentity; body: unknown }> = [];

  const seams: MilestoneReportSeams = {
    ghFor: (identity) => (args: string[], stdin?: string) => {
      const path = args[1] ?? "";
      if (args.includes("-X") && stdin !== undefined) {
        writes.push({ identity, body: JSON.parse(stdin) });
        return options.onWrite
          ? options.onWrite(identity)
          : Promise.resolve("99");
      }
      if (args[0] === "pr") return Promise.resolve("[]");
      if (path.includes("/rulesets")) {
        if (identity === "service-account") {
          return Promise.reject(new Error("must not re-read the rulesets"));
        }
        return ghServing(options.rulesets ?? [])(args);
      }
      return Promise.resolve("write");
    },
    print: (severity, message) => printed.push({ severity, message }),
  };
  return { seams, printed, writes };
}

Deno.test("reportMilestoneRuleset - a repo whose ruleset is on the template writes nothing and says nothing", async () => {
  // The run after the one that created the ruleset: nothing to write, and no
  // `success` line for a write that did not happen (Issues #678, #2623).
  const current = [DEFAULT_BRANCH, ALIGNED];
  const { seams, printed, writes } = recordingSeams({ rulesets: current });

  const errors = await reportMilestoneRuleset(
    { repo: "org/repo", branch: "main" },
    "VibeCoderST",
    current,
    seams,
  );

  assertEquals(errors, 0);
  assertEquals(writes, [], "an aligned ruleset must not be written again");
  assertEquals(
    printed.filter((p) => p.severity === "success"),
    [],
    "no write, no success line",
  );
});

Deno.test("reportMilestoneRuleset - a missing ruleset is created without asking, under the OPERATOR identity", async () => {
  // The service-account config holds `write`; a ruleset write needs admin, and
  // GitHub reports the shortfall as 404 (Issue #595).
  const { seams, printed, writes } = recordingSeams({
    rulesets: [DEFAULT_BRANCH],
  });

  const errors = await reportMilestoneRuleset(
    { repo: "org/repo", branch: "main" },
    "VibeCoderST",
    [DEFAULT_BRANCH],
    seams,
  );

  assertEquals(writes.map((w) => w.identity), ["operator"]);
  const success = printed.filter((p) => p.severity === "success");
  assertEquals(success.length, 1, "exactly one success line per write");
  assertStringIncludes(success[0]!.message, "Vibe Coder milestone branches");
  // The findings describe the repository as setup left it: covered.
  assert(
    !printed.some((p) => p.message.includes("no ruleset covers")),
    "a ruleset just created must not be reported missing",
  );
  assertEquals(errors, 0);
});

Deno.test("reportMilestoneRuleset - an existing ruleset that differs is aligned with one success line", async () => {
  const current = [DEFAULT_BRANCH, { ...MILESTONE, name: "Milestone" }];
  const { seams, printed, writes } = recordingSeams({ rulesets: current });

  await reportMilestoneRuleset(
    { repo: "org/repo", branch: "main" },
    "VibeCoderST",
    current,
    seams,
  );

  assertEquals(writes.map((w) => w.identity), ["operator"]);
  const success = printed.filter((p) => p.severity === "success");
  assertEquals(success.length, 1);
  assertStringIncludes(success[0]!.message, "'Milestone'");
  assertStringIncludes(success[0]!.message, "Vibe Coder milestone branches");
});

Deno.test("reportMilestoneRuleset - a disabled ruleset is aligned and warned about once", async () => {
  const current = [DEFAULT_BRANCH, { ...MILESTONE, enforcement: "disabled" }];
  const { seams, printed, writes } = recordingSeams({ rulesets: current });

  await reportMilestoneRuleset(
    { repo: "org/repo", branch: "main" },
    "VibeCoderST",
    current,
    seams,
  );

  assertEquals(
    (writes[0]!.body as { enforcement: string }).enforcement,
    "disabled",
  );
  const enforcementLines = printed.filter((p) =>
    p.severity === "warning" && p.message.includes("'disabled'")
  );
  assertEquals(enforcementLines.length, 1);
  assertStringIncludes(enforcementLines[0]!.message, "Vibe Coder milestone");
});

Deno.test("reportMilestoneRuleset - a failed creation warns and is never a silent no-op", async () => {
  const { seams, printed } = recordingSeams({
    rulesets: [DEFAULT_BRANCH],
    onWrite: () => Promise.reject(new Error("gh: Not Found (HTTP 404)")),
  });

  await reportMilestoneRuleset(
    { repo: "org/repo", branch: "main" },
    "VibeCoderST",
    [DEFAULT_BRANCH],
    seams,
  );

  const warning = printed.find((p) =>
    p.severity === "warning" && p.message.includes("could not create")
  );
  assert(warning, "a failed creation must warn");
  assertStringIncludes(warning.message, "org/repo");
  assertStringIncludes(warning.message, "ADMIN on org/repo");
  // Still missing, so still reported as missing.
  assert(printed.some((p) => p.message.includes("no ruleset covers")));
  assert(!printed.some((p) => p.severity === "success"));
});

Deno.test("reportMilestoneRuleset - an unreadable operator view warns and still reports", async () => {
  const printed: Array<{ severity: ReportSeverity; message: string }> = [];
  const seams: MilestoneReportSeams = {
    ghFor: (identity) => (args: string[]) => {
      if (identity === "operator") {
        return Promise.reject(new Error("gh: Forbidden (HTTP 403)"));
      }
      if (args[0] === "pr") return Promise.resolve("[]");
      return Promise.resolve("write");
    },
    print: (severity, message) => printed.push({ severity, message }),
  };

  await reportMilestoneRuleset(
    { repo: "org/repo", branch: "main" },
    "VibeCoderST",
    [DEFAULT_BRANCH],
    seams,
  );

  const warning = printed.find((p) =>
    p.message.includes("could not create or align")
  );
  assert(warning, "an unreadable state must warn, never pass in silence");
  assertStringIncludes(warning.message, "HTTP 403");
});

Deno.test("reportMilestoneRuleset - a repo with no checks to mirror gets a check-less ruleset", async () => {
  // GRQ-www: its default branch requires no status checks. Setup creates the
  // deletion and force-push rules, and the standing `no-required-checks`
  // warning stays accurate — auto-merge cannot be armed there until checks
  // exist.
  const checkless = { ...DEFAULT_BRANCH, rules: [{ type: "deletion" }] };
  const { seams, printed, writes } = recordingSeams({ rulesets: [checkless] });

  await reportMilestoneRuleset(
    { repo: "org/repo", branch: "main" },
    "VibeCoderST",
    [checkless],
    seams,
  );

  assertEquals(writes.length, 1);
  assertEquals(
    (writes[0]!.body as { rules: { type: string }[] }).rules.map((r) => r.type),
    ["deletion", "non_fast_forward"],
  );
  const success = printed.find((p) => p.severity === "success");
  assert(success);
  assertStringIncludes(success.message, "no checks to mirror");
  assert(
    printed.some((p) =>
      p.severity === "warning" && p.message.includes("requires no status")
    ),
    "the no-required-checks warning must still be printed",
  );
});
