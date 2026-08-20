/**
 * Tests for pr_feedback prompt v11.
 *
 * v11 closes the five Claude best-practice gaps the audit recorded
 * against v10: worked examples for the apply/reject call, XML-delimited
 * substitution, a role sentence, parallel-tool-call guidance, and the
 * agentic-systems clauses (context compaction, reversibility, delegation,
 * scratch-file cleanup, general-case fixes). v10 stays immutable and is used
 * as the negative control.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadFeedback(version: string): Promise<string> {
  const result = await loadPrompt("pr_feedback", version, PROMPTS_DIR);
  assertEquals(result.ok, true, `pr_feedback ${version} failed to load`);
  if (!result.ok) throw new Error(`pr_feedback ${version} failed to load`);
  return result.value;
}

const loadV11 = () => loadFeedback("v11");

// --- Loading contract ---

Deno.test("pr_feedback v11 - loads via loadPrompt", async () => {
  const body = await loadV11();
  assertEquals(body.length > 0, true);
});

Deno.test("pr_feedback v11 - is the latest version", async () => {
  const result = await getLatestVersion("pr_feedback", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 11,
    true,
    `expected pr_feedback >= v11, got ${result.value}`,
  );
});

Deno.test("pr_feedback v11 - satisfies the placeholder contract", async () => {
  const body = await loadV11();
  const v = validatePromptTemplate("pr_feedback", body);
  assertEquals(v.ok, true);
});

// --- Gap 1: use examples effectively ---

Deno.test("pr_feedback v11 - Gap 1: carries tagged worked examples", async () => {
  const body = await loadV11();
  assertStringIncludes(body, "<examples>");
  assertStringIncludes(body, "</examples>");
  const count = body.match(/<example>/g)?.length ?? 0;
  assertEquals(count >= 3, true, `expected >= 3 worked examples, got ${count}`);
  for (const tag of ["<situation>", "<action>", "<reason>"]) {
    assertStringIncludes(body, tag);
  }
});

Deno.test("pr_feedback v11 - Gap 1: examples cover apply, reject and the near miss", async () => {
  const body = await loadV11();
  const start = body.indexOf("<examples>");
  const end = body.indexOf("</examples>");
  assertEquals(start >= 0 && end > start, true);
  const examples = body.slice(start, end);
  // A finding correctly applied.
  assertStringIncludes(examples, "Useless conditional");
  // A finding correctly rejected — named by file:line, bot and rule per :14.
  assertStringIncludes(examples, "config_loader.ts:88");
  assertStringIncludes(examples, "github-code-quality[bot]");
  assertStringIncludes(examples, "Redundant cast");
  // The near miss that looks like a false positive but is not.
  assertStringIncludes(examples, "Read before you reject");
});

Deno.test("pr_feedback v11 - Gap 1: v10 had no worked examples", async () => {
  const body = await loadFeedback("v10");
  assertEquals(
    body.includes("<example"),
    false,
    "v10 is the negative control — it must stay free of example tags",
  );
});

// --- Gap 2: structure prompts with XML tags ---

Deno.test("pr_feedback v11 - Gap 2: the quality block is XML-delimited", async () => {
  const body = await loadV11();
  assertStringIncludes(
    body,
    "<quality_instructions>\n{{QUALITY_INSTRUCTIONS}}\n</quality_instructions>",
  );
});

Deno.test("pr_feedback v11 - Gap 2: no substitution lands mid-paragraph", async () => {
  const body = await loadV11();
  const lines = body.split("\n");
  for (
    const placeholder of ["{{QUALITY_INSTRUCTIONS}}", "{{CODING_GUIDELINES}}"]
  ) {
    const idx = lines.findIndex((l) => l.includes(placeholder));
    assertEquals(idx >= 0, true, `${placeholder} must still be present`);
    assertEquals(
      (lines[idx] ?? "").trim(),
      placeholder,
      `${placeholder} must stand alone on its own line`,
    );
  }
  // The commit instruction is no longer split by the injected block.
  assertStringIncludes(
    body,
    "Commit with a clear message referencing PR #{{PR_NUMBER}}.",
  );
});

// --- Gap 3: give Claude a role ---

Deno.test("pr_feedback v11 - Gap 3: opens with a role, not a task restatement", async () => {
  const body = await loadV11();
  const head = body.split("## Automated Review Comments")[0] ?? "";
  assertStringIncludes(head, "You are the engineer who wrote this PR");
  assertStringIncludes(head, "why anything you did not apply is wrong here");
});

// --- Gap 4: tool use (parallel reads) ---

Deno.test("pr_feedback v11 - Gap 4: gives parallel-tool-call guidance", async () => {
  const body = await loadV11();
  assertStringIncludes(body, "<use_parallel_tool_calls>");
  assertStringIncludes(body, "</use_parallel_tool_calls>");
  assertStringIncludes(body, "issue them in a single message");
  // Dependent calls are explicitly excluded.
  assertStringIncludes(body, "wait for that result");
  // The closing instruction repeats it at the point of first action.
  const tail = body.slice(body.lastIndexOf("Start by reading"));
  assertStringIncludes(tail, "parallel read");
});

// --- Gap 5: agentic systems ---

Deno.test("pr_feedback v11 - Gap 5: states the context-compaction rule", async () => {
  const body = await loadV11();
  assertStringIncludes(body, "Your context is compacted automatically");
  assertStringIncludes(body, "Commit after each coherent group of findings");
});

Deno.test("pr_feedback v11 - Gap 5: bounds irreversible actions on a reviewed branch", async () => {
  const body = await loadV11();
  for (
    const action of [
      "git push --force",
      "git commit --amend",
      "git commit --no-verify",
    ]
  ) {
    assertStringIncludes(body, action);
  }
  assertStringIncludes(
    body,
    "state the justification in `.pr_response_message`",
  );
});

Deno.test("pr_feedback v11 - Gap 5: gives a delegation criterion", async () => {
  const body = await loadV11();
  assertStringIncludes(body, "Delegate sparingly");
  assertStringIncludes(body, "isolated exploration too large for this context");
});

Deno.test("pr_feedback v11 - Gap 5: requires scratch files to be cleaned up", async () => {
  const body = await loadV11();
  assertStringIncludes(body, "Clean up scratch files");
  assertStringIncludes(
    body,
    "`.pr_response_message` is the only file this run must add",
  );
  assertStringIncludes(body, "before committing");
});

Deno.test("pr_feedback v11 - Gap 5: forbids fitting the fix to the flagged input", async () => {
  const body = await loadV11();
  assertStringIncludes(
    body,
    "Fix the general case, not the flagged line's inputs",
  );
  assertStringIncludes(body, "special case keyed to the flagged input");
});

Deno.test("pr_feedback v11 - Gap 5: v10 had none of the agentic clauses", async () => {
  const body = await loadFeedback("v10");
  for (
    const marker of [
      "compacted",
      "--no-verify",
      "Delegate sparingly",
      "scratch",
    ]
  ) {
    assertEquals(
      body.includes(marker),
      false,
      `v10 is the negative control — it must stay free of "${marker}"`,
    );
  }
});

// --- Carried-forward rules must survive the rewrite ---

Deno.test("pr_feedback v11 - carries forward the v10 rules", async () => {
  const body = await loadV11();
  for (
    const marker of [
      "### [UNTRUSTED] Automated Review Comments ###",
      "",
      "false positive",
      "./quality.sh",
      ".pr_response_message",
      "Change Scope",
      "Conflict Resolution",
      "Escape Hatch",
      "out of scope",
      "reserved workflow label",
      "trusted-author allowlist",
      "silently stripped",
      "",
      "Australian English",
      "Response Message",
    ]
  ) {
    assertStringIncludes(body, marker);
  }
});
