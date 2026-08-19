/**
 * Tests for issue prompt v30 (Issue #3790).
 *
 * v30 closes the seven Claude best-practice gaps the #3771 audit recorded
 * against v29: balanced code fences, a role sentence, worked examples for the
 * two hardest judgement calls, XML-delimited substitutions, named `gh`
 * commands, parallel-tool-call guidance, and the agentic-systems clauses
 * (context compaction, reversibility, delegation, scratch files, general-case
 * solutions, read-before-assert). v29 stays immutable and is used here as the
 * negative control for the fence checker.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadIssue(version: string): Promise<string> {
  const result = await loadPrompt("issue", version, PROMPTS_DIR);
  assertEquals(result.ok, true, `issue ${version} failed to load`);
  if (!result.ok) throw new Error(`issue ${version} failed to load`);
  return result.value;
}

const loadV30 = () => loadIssue("v30");

/** A fenced block: the info string on the opener and the enclosed body. */
interface Fence {
  info: string;
  body: string;
}

/**
 * Scan Markdown for fenced code blocks.
 *
 * A fence opens on a line whose first non-space characters are three or more
 * backticks, and closes only on a line of at least as many backticks with no
 * info string — the CommonMark rule the v29 tail violated.
 *
 * @returns the closed blocks, plus the info string of any fence left open
 */
function scanFences(
  markdown: string,
): { blocks: Fence[]; unterminated: string | null } {
  const blocks: Fence[] = [];
  let openTicks = 0;
  let openInfo = "";
  let body: string[] = [];

  for (const line of markdown.split("\n")) {
    const match = line.trimStart().match(/^(`{3,})(.*)$/);
    const ticks = match?.[1]?.length ?? 0;
    const info = match?.[2]?.trim() ?? "";
    if (openTicks === 0) {
      if (match) {
        openTicks = ticks;
        openInfo = info;
        body = [];
      }
      continue;
    }
    if (match && ticks >= openTicks && info === "") {
      blocks.push({ info: openInfo, body: body.join("\n") });
      openTicks = 0;
      continue;
    }
    body.push(line);
  }

  return { blocks, unterminated: openTicks === 0 ? null : openInfo };
}

// --- Baseline: the checker detects the defect v30 fixes ---

Deno.test("scanFences - v29 buries its Liquid instructions in a code block", async () => {
  const body = await loadIssue("v29");
  const { blocks } = scanFences(body);
  const fenced = blocks.map((b) => b.body).join("\n");
  assertEquals(
    fenced.includes("### Jekyll-safe markdown"),
    true,
    "expected v29 to reproduce the mis-nested fence run at :339-383",
  );
});

// --- Loading contract ---

Deno.test("issue v30 - loads via loadPrompt", async () => {
  const body = await loadV30();
  assertEquals(body.length > 0, true);
});

Deno.test("issue v30 - is the latest version", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(num >= 30, true, `expected issue >= v30, got ${result.value}`);
});

Deno.test("issue v30 - satisfies the placeholder contract", async () => {
  const body = await loadV30();
  const v = validatePromptTemplate("issue", body);
  assertEquals(v.ok, true);
});

// --- Gap 1: be clear and direct ---

Deno.test("issue v30 - Gap 1: every code fence is terminated", async () => {
  const body = await loadV30();
  const { unterminated } = scanFences(body);
  assertEquals(
    unterminated,
    null,
    `unterminated fence opened with info string: ${unterminated}`,
  );
});

Deno.test("issue v30 - Gap 1: instructions are not swallowed by a code block", async () => {
  const body = await loadV30();
  const { blocks } = scanFences(body);
  const fenced = blocks.map((b) => b.body).join("\n");
  // The Jekyll-safe rules are instructions to follow, not sample text.
  assertStringIncludes(body, "### Jekyll-safe markdown (Liquid escaping)");
  assertEquals(
    fenced.includes("### Jekyll-safe markdown"),
    false,
    "the Liquid-escaping instructions must sit outside every code block",
  );
});

Deno.test("issue v30 - Gap 1: coding guidelines are a section, not a list tail", async () => {
  const body = await loadV30();
  const lines = body.split("\n");
  const idx = lines.findIndex((l) => l.includes("{{CODING_GUIDELINES}}"));
  assertEquals(idx >= 0, true, "{{CODING_GUIDELINES}} must still be present");
  assertEquals(
    (lines[idx] ?? "").trim(),
    "{{CODING_GUIDELINES}}",
    "the 771-line block must stand alone, not ride the tail of a numbered step",
  );
  assertStringIncludes(body, "## Coding Guidelines");
  // The numbered step it used to hang off keeps its own instruction.
  assertStringIncludes(body, "referencing issue #{{ISSUE_NUMBER}}.");
});

Deno.test("issue v30 - Gap 1: the completion prohibition no longer collides", async () => {
  const body = await loadV30();
  // The required wording survives...
  assertStringIncludes(body, "The implementation is already complete");
  // ...and what is forbidden is the suggestion shape, not that string.
  assertStringIncludes(body, "someone should close this");
  assertEquals(
    body.includes('Do NOT just log that an issue "should be closed"'),
    false,
    "the v29 prohibition collided with the required wording",
  );
});

// --- Gap 2: use examples effectively ---

Deno.test("issue v30 - Gap 2: carries tagged worked examples", async () => {
  const body = await loadV30();
  assertStringIncludes(body, "<examples>");
  assertStringIncludes(body, "</examples>");
  const count = body.match(/<example>/g)?.length ?? 0;
  assertEquals(count >= 3, true, `expected >= 3 worked examples, got ${count}`);
  for (const tag of ["<situation>", "<action>", "<reason>"]) {
    assertStringIncludes(body, tag);
  }
});

Deno.test("issue v30 - Gap 2: examples cover both forks and the near miss", async () => {
  const body = await loadV30();
  const start = body.indexOf("<examples>");
  const end = body.indexOf("</examples>");
  assertEquals(start >= 0 && end > start, true);
  const examples = body.slice(start, end);
  // Internal dependency fixed cross-repo.
  assertStringIncludes(examples, "stSoftwareAU/*");
  assertStringIncludes(examples, "#2942");
  // External dependency correctly deferred.
  assertStringIncludes(examples, "external npm package");
  assertStringIncludes(examples, "#1826");
  // The negative case — big, but not out of scope.
  assertStringIncludes(examples, "Volume is not scope");
});

// --- Gap 3: structure prompts with XML tags ---

Deno.test("issue v30 - Gap 3: the quality block is XML-delimited", async () => {
  const body = await loadV30();
  assertStringIncludes(
    body,
    "<quality_instructions>\n{{QUALITY_INSTRUCTIONS}}\n</quality_instructions>",
  );
});

// --- Gap 4: give Claude a role ---

Deno.test("issue v30 - Gap 4: opens with a role sentence", async () => {
  const body = await loadV30();
  const head = body.split("## Autonomous Execution")[0] ?? "";
  assertStringIncludes(head, "You are a senior engineer on this repository");
  assertStringIncludes(head, "implementing a single GitHub issue");
});

// --- Gap 5: output and formatting ---

Deno.test("issue v30 - Gap 5: the PR-summary skeleton is shown once, fenced", async () => {
  const body = await loadV30();
  const { blocks } = scanFences(body);
  const skeletons = blocks.filter((b) => b.body.includes("## Test Plan"));
  assertEquals(
    skeletons.length,
    1,
    `expected exactly one PR-summary skeleton, got ${skeletons.length}`,
  );
  const skeleton = skeletons[0] ?? { info: "", body: "" };
  assertEquals(skeleton.info, "markdown");
  for (const heading of ["## Summary", "## Evidence", "## Test Plan"]) {
    assertStringIncludes(skeleton.body, heading);
  }
  assertStringIncludes(skeleton.body, "Closes\n#{{ISSUE_NUMBER}}.");
});

// --- Gap 6: tool use ---

Deno.test("issue v30 - Gap 6: escalation actions name their gh commands", async () => {
  const body = await loadV30();
  assertStringIncludes(
    body,
    'gh issue edit {{ISSUE_NUMBER}} --repo {{REPO}} --add-label "needs-human"',
  );
  assertStringIncludes(
    body,
    "gh issue comment {{ISSUE_NUMBER}} --repo {{REPO}}",
  );
  assertStringIncludes(body, "gh issue close {{ISSUE_NUMBER}} --repo {{REPO}}");
});

Deno.test("issue v30 - Gap 6: no CRITICAL-inflated headings", async () => {
  const body = await loadV30();
  const inflated = body
    .split("\n")
    .filter((l) => l.startsWith("#") && l.includes("CRITICAL"));
  assertEquals(
    inflated,
    [],
    `CRITICAL headings remain: ${inflated.join(" | ")}`,
  );
  // The consequence replaces the shouting.
  assertStringIncludes(body, "issue stays open after the PR merges");
});

Deno.test("issue v30 - Gap 6: gives parallel-tool-call guidance", async () => {
  const body = await loadV30();
  assertStringIncludes(body, "<use_parallel_tool_calls>");
  assertStringIncludes(body, "</use_parallel_tool_calls>");
  assertStringIncludes(body, "issue them in a single\nmessage");
  // Dependent calls are explicitly excluded.
  assertStringIncludes(body, "wait for that");
});

// --- Gap 7: agentic systems ---

Deno.test("issue v30 - Gap 7: states the context-compaction rule", async () => {
  const body = await loadV30();
  assertStringIncludes(body, "Your context is compacted automatically");
  assertStringIncludes(body, "Commit progress incrementally");
});

Deno.test("issue v30 - Gap 7: bounds irreversible actions", async () => {
  const body = await loadV30();
  for (
    const action of [
      "git push --force",
      "rm -rf",
      "git commit --no-verify",
    ]
  ) {
    assertStringIncludes(body, action);
  }
  assertStringIncludes(body, "state the\n  justification");
});

Deno.test("issue v30 - Gap 7: gives a delegation criterion", async () => {
  const body = await loadV30();
  assertStringIncludes(body, "Delegate sparingly");
  assertStringIncludes(body, "isolated parallel");
  assertStringIncludes(body, "single-file edits");
});

Deno.test("issue v30 - Gap 7: requires scratch files to be cleaned up", async () => {
  const body = await loadV30();
  assertStringIncludes(body, "Clean up scratch files");
  assertStringIncludes(body, "before committing");
});

Deno.test("issue v30 - Gap 7: forbids fitting the solution to the tests", async () => {
  const body = await loadV30();
  assertStringIncludes(body, "Solve the general case");
  assertStringIncludes(body, "not a shape fitted to the test inputs");
});

Deno.test("issue v30 - Gap 7: requires file:line evidence before asserting done", async () => {
  const body = await loadV30();
  assertStringIncludes(body, "Read before you assert");
  assertStringIncludes(body, "`file:line`");
});

// --- Carried-forward rules must survive the rewrite ---

Deno.test("issue v30 - carries forward the escape hatch and dependency rules", async () => {
  const body = await loadV30();
  for (
    const marker of [
      "Escape Hatch",
      "#1826",
      "#2943",
      "at most one",
      "gh issue list",
      "--state open",
      "#2944",
      "Human Escalation",
      "Performance Task Workflow",
      "Australian English",
    ]
  ) {
    assertStringIncludes(body, marker);
  }
});
