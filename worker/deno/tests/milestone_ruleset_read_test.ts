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
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkMilestoneRuleset,
  createMilestoneRuleset,
  planMilestoneRuleset,
  readRulesetDetails,
  type RulesetDetail,
} from "../lib/milestone_ruleset_check.ts";

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
