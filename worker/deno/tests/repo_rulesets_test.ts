/**
 * Tests for lib/repo_rulesets.ts — repository ruleset primitives (Issue #4163).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  buildDefaultBranchRulesetBody,
  createRuleset,
  deleteRuleset,
  getBranchRules,
  type GhExec,
  hasClassicBranchProtection,
  isNotFoundError,
  isValidBranchName,
  isValidRepoSlug,
  listRepoRulesets,
  requiredContextsFromRules,
  updateRuleset,
} from "../lib/repo_rulesets.ts";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

Deno.test("repo_rulesets - slug validation rejects shell metacharacters", () => {
  assert(isValidRepoSlug("example-org/private-repo-29"));
  assertFalse(isValidRepoSlug("org/repo; rm -rf /"));
  assertFalse(isValidRepoSlug("no-slash"));
});

Deno.test("repo_rulesets - branch validation rejects traversal and metacharacters", () => {
  assert(isValidBranchName("main"));
  assert(isValidBranchName("milestone/4060-feat"));
  assertFalse(isValidBranchName("main; curl evil"));
  assertFalse(isValidBranchName("feature/../../etc/passwd"));
  assertFalse(isValidBranchName(""));
});

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

Deno.test("repo_rulesets - getBranchRules treats a 404 as no rules, not an error", async () => {
  const gh: GhExec = () =>
    Promise.reject(new Error("gh failed: Not Found (HTTP 404)"));

  const result = await getBranchRules("org/repo", "main", gh);

  assert(result.ok);
  assertEquals(result.value, []);
});

Deno.test("repo_rulesets - getBranchRules surfaces a non-404 failure", async () => {
  const gh: GhExec = () =>
    Promise.reject(new Error("gh failed: Bad credentials (HTTP 401)"));

  const result = await getBranchRules("org/repo", "main", gh);

  assertFalse(result.ok);
});

Deno.test("repo_rulesets - getBranchRules rejects an invalid branch without a gh call", async () => {
  let called = false;
  const gh: GhExec = () => {
    called = true;
    return Promise.resolve("[]");
  };

  const result = await getBranchRules("org/repo", "main;evil", gh);

  assertFalse(result.ok);
  assertFalse(called);
});

Deno.test("repo_rulesets - listRepoRulesets parses the summary list", async () => {
  const gh: GhExec = () =>
    Promise.resolve(JSON.stringify([{ id: 7, name: "Develop" }]));

  const result = await listRepoRulesets("org/repo", gh);

  assert(result.ok);
  assertEquals(result.value[0]?.name, "Develop");
});

Deno.test("repo_rulesets - hasClassicBranchProtection reports presence and absence", async () => {
  const present: GhExec = () => Promise.resolve("{}");
  const absent: GhExec = () =>
    Promise.reject(new Error("gh failed: Branch not protected (HTTP 404)"));

  assert(await hasClassicBranchProtection("org/repo", "main", present));
  assertFalse(await hasClassicBranchProtection("org/repo", "main", absent));
});

// ---------------------------------------------------------------------------
// Rule inspection
// ---------------------------------------------------------------------------

Deno.test("repo_rulesets - requiredContextsFromRules extracts and de-duplicates contexts", () => {
  const contexts = requiredContextsFromRules([
    { type: "deletion" },
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "quality" }] },
    },
    {
      type: "required_status_checks",
      parameters: {
        required_status_checks: [{ context: "quality" }, { context: "lint" }],
      },
    },
  ]);

  assertEquals(contexts, ["quality", "lint"]);
});

Deno.test("repo_rulesets - requiredContextsFromRules is empty for rules with no checks", () => {
  assertEquals(requiredContextsFromRules([{ type: "non_fast_forward" }]), []);
});

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

Deno.test("repo_rulesets - the body targets the default branch and requires up-to-date", () => {
  const body = buildDefaultBranchRulesetBody("Vibe", ["quality"]);

  assertEquals(body.target, "branch");
  assertEquals(body.enforcement, "active");
  assertEquals(body.conditions.ref_name.include, ["~DEFAULT_BRANCH"]);
  assertEquals(
    body.rules[0]?.parameters.strict_required_status_checks_policy,
    true,
  );
  assertEquals(body.rules[0]?.parameters.required_status_checks, [
    { context: "quality" },
  ]);
});

Deno.test("repo_rulesets - createRuleset POSTs the body to the rulesets endpoint", async () => {
  const calls: string[][] = [];
  const gh: GhExec = (args) => {
    calls.push(args);
    return Promise.resolve("");
  };

  const result = await createRuleset(
    "org/repo",
    buildDefaultBranchRulesetBody("Vibe", ["quality"]),
    gh,
  );

  assert(result.ok);
  assertEquals(calls[0]?.slice(0, 4), [
    "api",
    "-X",
    "POST",
    "repos/org/repo/rulesets",
  ]);
});

Deno.test("repo_rulesets - updateRuleset rejects a non-positive ruleset id", async () => {
  let called = false;
  const gh: GhExec = () => {
    called = true;
    return Promise.resolve("");
  };

  const result = await updateRuleset(
    "org/repo",
    0,
    buildDefaultBranchRulesetBody("Vibe", []),
    gh,
  );

  assertFalse(result.ok);
  assertFalse(called);
});

Deno.test("repo_rulesets - a rejected write is reported as an error, never swallowed", async () => {
  const gh: GhExec = () => Promise.reject(new Error("gh failed: HTTP 422"));

  const result = await createRuleset(
    "org/repo",
    buildDefaultBranchRulesetBody("Vibe", ["quality"]),
    gh,
  );

  assertFalse(result.ok);
});

// ---------------------------------------------------------------------------
// Delete (Issue #4356)
// ---------------------------------------------------------------------------

Deno.test("repo_rulesets - deleteRuleset issues a DELETE for the given ruleset id", async () => {
  const calls: string[][] = [];
  const gh: GhExec = (args) => {
    calls.push(args);
    return Promise.resolve("");
  };

  const result = await deleteRuleset("org/repo", 99, gh);

  assert(result.ok);
  assertEquals(calls, [["api", "-X", "DELETE", "repos/org/repo/rulesets/99"]]);
});

Deno.test("repo_rulesets - deleteRuleset rejects an invalid slug or id without a gh call", async () => {
  let called = false;
  const gh: GhExec = () => {
    called = true;
    return Promise.resolve("");
  };

  assertFalse((await deleteRuleset("bad slug", 1, gh)).ok);
  assertFalse((await deleteRuleset("org/repo", 0, gh)).ok);
  assertFalse((await deleteRuleset("org/repo", 1.5, gh)).ok);
  assertFalse(called);
});

Deno.test("repo_rulesets - a rejected delete is reported as an error, never swallowed", async () => {
  const gh: GhExec = () => Promise.reject(new Error("gh failed: HTTP 403"));
  const result = await deleteRuleset("org/repo", 1, gh);
  assertFalse(result.ok);
});

Deno.test("repo_rulesets - isNotFoundError recognises a 404 and nothing else", () => {
  assert(isNotFoundError(new Error("gh failed: Not Found (HTTP 404)")));
  assertFalse(isNotFoundError(new Error("gh failed: server error (HTTP 500)")));
  assertFalse(isNotFoundError("plain string"));
});
