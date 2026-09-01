/**
 * Tests for the milestone-ruleset READ path and the create/skip decision
 * setup makes from it (Issue #678).
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
  checkMilestoneRuleset,
  createMilestoneRuleset,
  planMilestoneRuleset,
  readRulesetDetails,
  type RulesetDetail,
} from "../lib/milestone_ruleset_check.ts";
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
    parameters: { required_status_checks: [{ context: "semgrep" }] },
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
// The decision: only ask a question an answer can change
// ---------------------------------------------------------------------------

Deno.test("planMilestoneRuleset - a covered repository has nothing to ask about", () => {
  assertEquals(
    planMilestoneRuleset([DEFAULT_BRANCH, MILESTONE]).kind,
    "covered",
  );
});

Deno.test("planMilestoneRuleset - a mirrorable default-branch gate makes the ruleset creatable", () => {
  const plan = planMilestoneRuleset([DEFAULT_BRANCH]);
  assert(plan.kind === "creatable");
  assertEquals(plan.contexts, ["semgrep"]);
  assertEquals(plan.mirror.name, "Vibe Coder default branch");
});

Deno.test("planMilestoneRuleset - nothing to mirror means the question can never be answered usefully", () => {
  // The repositories that made this issue: their default branch takes direct
  // pushes, so no ruleset requires checks, so answering yes creates nothing —
  // and the question returned on every run (Issue #678).
  const plan = planMilestoneRuleset([{
    ...DEFAULT_BRANCH,
    rules: [{ type: "deletion" }],
  }]);
  assert(plan.kind === "not-creatable");
  assertStringIncludes(plan.reason, "no check set to mirror");
});

Deno.test("planMilestoneRuleset - a repository with no rulesets at all cannot mirror one", () => {
  const plan = planMilestoneRuleset([]);
  assert(plan.kind === "not-creatable");
});

Deno.test("createMilestoneRuleset - an unreadable ruleset list fails loud instead of guessing", async () => {
  // Deciding "nothing covers milestone/**" from a read that failed could
  // create a second, conflicting ruleset.
  const result = await createMilestoneRuleset(
    "org/repo",
    () => Promise.reject(new Error("gh: Not Found (HTTP 404)")),
  );
  assert(!result.ok, "a failed read must not be treated as no rulesets");
  assertStringIncludes(result.error.message, "HTTP 404");
});

Deno.test("createMilestoneRuleset - writes nothing when the ruleset is already there", async () => {
  const result = await createMilestoneRuleset(
    "org/repo",
    ghServing([DEFAULT_BRANCH, MILESTONE]),
  );
  assert(result.ok && !result.created);
  assertStringIncludes(result.reason, "already covered");
});

// ---------------------------------------------------------------------------
// The wiring: what a setup RE-RUN actually asks and prints (Issue #678)
// ---------------------------------------------------------------------------

/**
 * Records every question asked, line printed and identity used.
 *
 * The `service-account` runner REFUSES to read rulesets: setup reads them once
 * and passes them down, so a second read under that identity is a defect. The
 * `operator` runner serves them, because the create deliberately re-reads
 * under the only identity holding `admin` (Issue #595).
 */
function recordingSeams(options: {
  answer?: boolean;
  rulesets?: RulesetDetail[];
  onCreate?: (identity: SetupIdentity) => Promise<string>;
} = {}) {
  const asked: string[] = [];
  const printed: Array<{ severity: ReportSeverity; message: string }> = [];
  const identities: SetupIdentity[] = [];

  const seams: MilestoneReportSeams = {
    ghFor: (identity) => (args: string[], stdin?: string) => {
      identities.push(identity);
      const path = args[1] ?? "";
      // The write: `gh api -X POST .../rulesets`.
      if (args.includes("-X") && stdin !== undefined) {
        return options.onCreate
          ? options.onCreate(identity)
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
    ask: (repo: string) => {
      asked.push(repo);
      return Promise.resolve(options.answer ?? false);
    },
    print: (severity, message) => printed.push({ severity, message }),
  };
  return { seams, asked, printed, identities };
}

Deno.test("reportMilestoneRuleset - a repo whose ruleset exists asks nothing and says nothing", async () => {
  // THE regression: the run after the one that created the ruleset. The
  // operator answered yes last time, the ruleset is there, and setup must have
  // nothing to ask or report about it (Issue #678).
  const { seams, asked, printed } = recordingSeams();

  const errors = await reportMilestoneRuleset(
    { repo: "org/repo", branch: "main" },
    "VibeCoderST",
    [DEFAULT_BRANCH, MILESTONE],
    seams,
  );

  assertEquals(errors, 0);
  assertEquals(asked, [], "a covered repository must never be asked again");
  assertEquals(
    printed.filter((p) => p.severity !== "info"),
    [],
    "a covered repository must print nothing for this item",
  );
});

Deno.test("reportMilestoneRuleset - a missing ruleset that CAN be mirrored is offered", async () => {
  const { seams, asked } = recordingSeams({ answer: false });

  await reportMilestoneRuleset(
    { repo: "org/repo", branch: "main" },
    "VibeCoderST",
    [DEFAULT_BRANCH],
    seams,
  );

  assertEquals(
    asked,
    ["org/repo"],
    "a creatable ruleset must still be offered",
  );
});

Deno.test("reportMilestoneRuleset - answering yes creates under the OPERATOR identity", async () => {
  // The service-account config holds `write`; a ruleset write needs admin, and
  // GitHub reports the shortfall as 404 (Issue #595). Replaces the former
  // source-text assertion on this call site with one that runs the code.
  let writeIdentity: SetupIdentity | undefined;
  const { seams, printed } = recordingSeams({
    answer: true,
    rulesets: [DEFAULT_BRANCH],
    onCreate: (identity) => {
      writeIdentity = identity;
      return Promise.resolve("99");
    },
  });

  await reportMilestoneRuleset(
    { repo: "org/repo", branch: "main" },
    "VibeCoderST",
    [DEFAULT_BRANCH],
    seams,
  );

  assertEquals(writeIdentity, "operator");
  assert(
    printed.some((p) =>
      p.severity === "success" && p.message.includes("created the")
    ),
    "a successful creation must print the success line",
  );
});

Deno.test("reportMilestoneRuleset - a failed creation warns and is never a silent no-op", async () => {
  const { seams, printed } = recordingSeams({
    answer: true,
    rulesets: [DEFAULT_BRANCH],
    onCreate: () => Promise.reject(new Error("gh: Not Found (HTTP 404)")),
  });

  await reportMilestoneRuleset(
    { repo: "org/repo", branch: "main" },
    "VibeCoderST",
    [DEFAULT_BRANCH],
    seams,
  );

  const warning = printed.find((p) => p.severity === "warning");
  assert(warning, "a failed creation must warn");
  assertStringIncludes(warning.message, "org/repo");
  assertStringIncludes(warning.message, "could not create");
});

Deno.test("reportMilestoneRuleset - a repo with nothing to mirror asks nothing and warns once", async () => {
  // The repositories in the issue's log whose default branch takes direct
  // pushes: answering yes could create nothing, so the question is not asked —
  // and the reason is folded into the standing warning rather than printed
  // beside it, which read as two contradictory lines.
  const { seams, asked, printed } = recordingSeams();

  await reportMilestoneRuleset(
    { repo: "org/repo", branch: "main" },
    "VibeCoderST",
    [{ ...DEFAULT_BRANCH, rules: [{ type: "deletion" }] }],
    seams,
  );

  assertEquals(asked, [], "an unanswerable question must not be asked");
  const milestoneLines = printed.filter((p) =>
    p.message.includes("`milestone/**`")
  );
  assertEquals(
    milestoneLines.length,
    1,
    `expected one milestone line, got: ${
      milestoneLines.map((l) => l.message).join(" || ")
    }`,
  );
  assertStringIncludes(milestoneLines[0]!.message, "no check set to mirror");
});
