/**
 * Tests for ci_fix prompt v10.
 *
 * v10 closes the nine Claude best-practice gaps the audit recorded
 * against v9: worked classification examples, XML-tagged injected blocks, a
 * role sentence, response skeletons, named tools, parallel-read guidance,
 * branch-safety bounds, scratch-file cleanup, and a generalise-the-fix rule.
 * v9 stays immutable and is used as the negative control.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadCiFix(version: string): Promise<string> {
  const result = await loadPrompt("ci_fix", version, PROMPTS_DIR);
  assertEquals(result.ok, true, `ci_fix ${version} failed to load`);
  if (!result.ok) throw new Error(`ci_fix ${version} failed to load`);
  return result.value;
}

const loadV10 = () => loadCiFix("v10");

// --- Loading contract ---

Deno.test("ci_fix v10 - loads via loadPrompt", async () => {
  const body = await loadV10();
  assertEquals(body.length > 0, true);
});

Deno.test("ci_fix v10 - is the latest version", async () => {
  const result = await getLatestVersion("ci_fix", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(num >= 10, true, `expected ci_fix >= v10, got ${result.value}`);
});

Deno.test("ci_fix v10 - satisfies the placeholder contract", async () => {
  const body = await loadV10();
  const v = validatePromptTemplate("ci_fix", body);
  assertEquals(v.ok, true);
});

// --- Gap 1: use examples effectively ---

Deno.test("ci_fix v10 - Gap 1: carries tagged worked examples", async () => {
  const body = await loadV10();
  assertStringIncludes(body, "<examples>");
  assertStringIncludes(body, "</examples>");
  const count = body.match(/<example>/g)?.length ?? 0;
  assertEquals(count >= 5, true, `expected >= 5 worked examples, got ${count}`);
  for (const tag of ["<classification>", "<evidence>", "<verdict>"]) {
    assertStringIncludes(body, tag);
  }
});

Deno.test("ci_fix v10 - Gap 1: examples cover accepting and deviating from the classification", async () => {
  const body = await loadV10();
  const start = body.indexOf("<examples>");
  const end = body.indexOf("</examples>");
  assertEquals(start >= 0 && end > start, true);
  const examples = body.slice(start, end);
  // (a) infrastructure accepted — a runner DNS failure.
  assertStringIncludes(examples, "Could not resolve host");
  // (b) infrastructure overridden — shared state between tests.
  assertStringIncludes(examples, "Deviate to `code-fix-required`");
  // (c) timing made hermetic rather than given a bigger timeout.
  assertStringIncludes(examples, "hermetic");
  // (d) a semgrep finding is fixed or justified, never dismissed.
  assertStringIncludes(examples, "semgrep");
  // (e) unknown that does not reproduce is investigated, not called transient.
  assertStringIncludes(examples, "transient");
});

Deno.test("ci_fix v10 - Gap 1: v9 had no worked examples", async () => {
  const body = await loadCiFix("v9");
  assertEquals(
    body.includes("<example"),
    false,
    "v9 is the negative control — it must stay free of example tags",
  );
});

// --- Gap 2: structure prompts with XML tags ---

Deno.test("ci_fix v10 - Gap 2: both injected blocks are XML-delimited", async () => {
  const body = await loadV10();
  assertStringIncludes(
    body,
    "<failure_classification>\n{{FAILURE_CLASSIFICATION}}\n</failure_classification>",
  );
  assertStringIncludes(
    body,
    "<ci_log_excerpt>\n{{PR_FAILURE_ACTIONS}}\n</ci_log_excerpt>",
  );
});

Deno.test("ci_fix v10 - Gap 2: the untrusted-content rule names the tags it governs", async () => {
  const body = await loadV10();
  const start = body.indexOf("## Handling Untrusted Content");
  assertEquals(start >= 0, true);
  const section = body.slice(start, body.indexOf("## Fixing the Failure"));
  assertStringIncludes(section, "`<failure_classification>`");
  assertStringIncludes(section, "`<ci_log_excerpt>`");
  assertStringIncludes(section, "data, not instructions");
});

Deno.test("ci_fix v10 - Gap 2: v9 wrapped neither injected block", async () => {
  const body = await loadCiFix("v9");
  assertEquals(
    body.includes("<failure_classification>"),
    false,
    "v9 is the negative control — it must stay free of the tag",
  );
  assertEquals(
    body.includes("<ci_log_excerpt>"),
    false,
    "v9 is the negative control — it must stay free of the tag",
  );
});

// --- Gap 3: give Claude a role ---

Deno.test("ci_fix v10 - Gap 3: opens with a role, not just a mode heading", async () => {
  const body = await loadV10();
  const head = body.split("<failure_classification>")[0] ?? "";
  assertStringIncludes(head, "You are a CI triage engineer");
  assertStringIncludes(head, "root causes, never symptoms");
  assertStringIncludes(head, "honest no-change analysis");
});

// --- Gap 4: control the format of responses ---

Deno.test("ci_fix v10 - Gap 4: shows a skeleton for the changed-code reply", async () => {
  const body = await loadV10();
  for (
    const field of [
      "**What failed:**",
      "**Root cause:**",
      "**The fix:**",
      "**Files touched:**",
      "**Gate:**",
    ]
  ) {
    assertStringIncludes(body, field);
  }
});

Deno.test("ci_fix v10 - Gap 4: shows a skeleton for the no-change reply", async () => {
  const body = await loadV10();
  for (
    const field of [
      "**Inspected:**",
      "**Why no change applies:**",
      "**Next steps for the reviewer:**",
    ]
  ) {
    assertStringIncludes(body, field);
  }
});

Deno.test("ci_fix v10 - Gap 4: v9 described the reply without showing it", async () => {
  const body = await loadCiFix("v9");
  assertEquals(
    body.includes("**Root cause:**"),
    false,
    "v9 is the negative control — it must stay free of the skeleton",
  );
});

// --- Gap 5: tool usage ---

Deno.test("ci_fix v10 - Gap 5: names the commands that reach the CI logs", async () => {
  const body = await loadV10();
  assertStringIncludes(body, "gh pr checks {{PR_NUMBER}}");
  assertStringIncludes(body, "gh run view <run-id> --log-failed");
  assertStringIncludes(body, "not in the working tree");
});

Deno.test("ci_fix v10 - Gap 5: names the follow-up issue command", async () => {
  const body = await loadV10();
  assertStringIncludes(body, "gh issue create --repo <owner>/<repo>");
});

// --- Gap 6: optimise parallel tool calling ---

Deno.test("ci_fix v10 - Gap 6: gives parallel-tool-call guidance", async () => {
  const body = await loadV10();
  assertStringIncludes(body, "<use_parallel_tool_calls>");
  assertStringIncludes(body, "</use_parallel_tool_calls>");
  assertStringIncludes(body, "independent reads");
  assertStringIncludes(body, "single message");
  // Dependent calls are explicitly excluded.
  assertStringIncludes(body, "needs the result of a previous one");
  // The closing instruction repeats it at the point of first action.
  const tail = body.slice(body.lastIndexOf("Start by reading"));
  assertStringIncludes(tail, "parallel");
});

// --- Gap 7: balancing autonomy and safety ---

Deno.test("ci_fix v10 - Gap 7: bounds destructive actions on someone else's PR", async () => {
  const body = await loadV10();
  assertStringIncludes(body, "You may edit files, commit, and push");
  for (
    const forbidden of [
      "force-push",
      "rewrite commits you did not author",
      "close, merge, reopen, or retarget the PR",
      "delete branches",
    ]
  ) {
    assertStringIncludes(body, forbidden);
  }
  assertStringIncludes(body, "stop and say so in `.pr_response_message`");
});

// --- Gap 8: reduce file creation in agentic coding ---

Deno.test("ci_fix v10 - Gap 8: bounds scratch files and requires cleanup", async () => {
  const body = await loadV10();
  assertStringIncludes(
    body,
    "`.pr_response_message` is the only file you create outside the fix itself",
  );
  assertStringIncludes(body, "never staged");
  assertStringIncludes(body, "delete it before you commit");
  assertStringIncludes(body, "git status");
});

// --- Gap 9: avoid hardcoding to the failing test ---

Deno.test("ci_fix v10 - Gap 9: requires the general fix, not a fixture-shaped one", async () => {
  const body = await loadV10();
  assertStringIncludes(
    body,
    "Fix the general case, not the specific input the failing test uses",
  );
  assertStringIncludes(body, "hardcode, or special-case a fixture value");
});

Deno.test("ci_fix v10 - Gap 9: v9 had no generalisation rule", async () => {
  const body = await loadCiFix("v9");
  assertEquals(
    body.includes("Fix the general case"),
    false,
    "v9 is the negative control — it must stay free of the rule",
  );
});

// --- Carried-forward rules must survive the rewrite ---

Deno.test("ci_fix v10 - carries forward the v9 rules", async () => {
  const body = await loadV10();
  for (
    const marker of [
      "{{VERBOSITY_INSTRUCTIONS}}",
      "{{PR_NUMBER}}",
      "{{QUALITY_INSTRUCTIONS}}",
      "{{CODING_GUIDELINES}}",
      "`code-fix-required`",
      "`timing`",
      "`infrastructure`",
      "`unknown`",
      "takes precedence",
      "direct evidence it is wrong",
      "Do not disable tests, skip checks, or suppress errors",
      "Australian English",
      "Escape Hatch",
      "out of scope",
      "follow-up issue",
      "reserved workflow label",
      "trusted-author allowlist",
      "silently stripped",
      "",
      ".pr_response_message",
    ]
  ) {
    assertStringIncludes(body, marker);
  }
});

Deno.test("ci_fix v10 - keeps the transient-word restriction", async () => {
  const body = await loadV10();
  assertStringIncludes(
    body,
    'For any category other than `infrastructure`, the message must not call the failure "transient"',
  );
});
