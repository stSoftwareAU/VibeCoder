/**
 * Tests for the merge_conflict prompt (Issue #467).
 *
 * The template documents the deterministic dependency rules as an explicit,
 * bounded carve-out from the never-side-pick contract: the worker settles
 * dependency-version conflicts in known manifest files before the agent is
 * asked anything, regenerates lock files rather than merging them, and lists
 * only the deferred paths in `{{CONFLICTED_FILES}}`. The carve-out is limited
 * to dependency-version hunks — the contradictory-constant worked example
 * still instructs abort-and-escalate.
 *
 * Australian English is used throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildMergeConflictPrompt } from "../lib/prompt_builder.ts";
import { loadPrompt, validatePromptTemplate } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadMergeConflict(): Promise<string> {
  const result = await loadPrompt("merge_conflict", PROMPTS_DIR);
  assertEquals(result.ok, true, "merge_conflict failed to load");
  if (!result.ok) throw new Error("merge_conflict failed to load");
  return result.value;
}

// --- Loading contract ---

Deno.test("merge_conflict - loads via loadPrompt", async () => {
  const body = await loadMergeConflict();
  assert(body.length > 0);
});

Deno.test("merge_conflict - satisfies the placeholder contract", async () => {
  const body = await loadMergeConflict();
  const validation = validatePromptTemplate("merge_conflict", body);
  assertEquals(validation.ok, true, JSON.stringify(validation));
});

Deno.test("merge_conflict - carries every required placeholder plus verbosity", async () => {
  const body = await loadMergeConflict();
  for (
    const placeholder of [
      "PR_NUMBER",
      "QUALITY_INSTRUCTIONS",
      "BASE_BRANCH",
      "CONFLICTED_FILES",
      "VERBOSITY_INSTRUCTIONS",
    ]
  ) {
    assertStringIncludes(body, `{{${placeholder}}}`);
  }
});

Deno.test("merge_conflict - builds with every placeholder substituted", async () => {
  const built = await buildMergeConflictPrompt({
    repo: "stSoftwareAU/VibeCoder",
    prNumber: "4321",
    baseBranch: "main",
    conflictedFiles: ["worker/deno/lib/foo.ts"],
    qualityInstructions: "Run ./quality.sh",
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;

  const { prompt, systemPrompt } = built.value;
  assertEquals(
    /\{\{[A-Z_]+\}\}/.test(prompt),
    false,
    `unsubstituted placeholder in prompt: ${
      prompt.match(/\{\{[A-Z_]+\}\}/g)?.join(", ")
    }`,
  );
  assert(systemPrompt.length > 0);
  assertStringIncludes(prompt, "PR #4321");
  // The base branch and the conflicted paths are attacker-chosen, so they now
  // render inside this run's untrusted fence rather than inline in the prose
  // (Issue #1377) — this assertion checks the fenced rendering that replaced
  // the previous inline `main` splice.
  assertStringIncludes(prompt, "```\nmain\n```");
  assertStringIncludes(prompt, "```\nworker/deno/lib/foo.ts\n```");
  assertStringIncludes(prompt, "Run ./quality.sh");
});

// --- The never-side-pick contract survives ---

Deno.test("merge_conflict - keeps the never-side-pick contract", async () => {
  const body = await loadMergeConflict();
  assertStringIncludes(body, "Never side-pick");
  assertStringIncludes(body, "git merge -X ours");
  assertStringIncludes(body, "git checkout --ours");
  assertStringIncludes(body, "duplicate");
});

Deno.test("merge_conflict - the contradictory timeout example still aborts and escalates", async () => {
  const body = await loadMergeConflict();
  const start = body.indexOf("30s to 60s");
  assert(start >= 0, "the timeout worked example is missing");
  const end = body.indexOf("</example>", start);
  assert(end > start, "the timeout worked example is unterminated");
  const example = body.slice(start, end);
  assertStringIncludes(example, "git merge --abort");
  assertStringIncludes(example, "human");
});

// --- The bounded dependency carve-out ---

Deno.test("merge_conflict - names the carve-out in the contract section", async () => {
  const body = await loadMergeConflict();
  const start = body.indexOf("## The Contract — Both Sides Survive");
  const end = body.indexOf("## What To Do", start);
  assert(start >= 0 && end > start, "contract section missing");
  const contract = body.slice(start, end);
  assertStringIncludes(contract, "carve-out");
  assertStringIncludes(contract, "dependency-version");
});

Deno.test("merge_conflict - the carve-out is bounded to dependency-version hunks in known manifests", async () => {
  const body = await loadMergeConflict();
  assertStringIncludes(body, "only");
  for (
    const manifest of ["deno.json", "package.json", "Cargo.toml", "go.mod"]
  ) {
    assertStringIncludes(body, manifest);
  }
  // A source-code constant is explicitly outside the carve-out.
  assertStringIncludes(body, "source code");
});

Deno.test("merge_conflict - states the rules run before this prompt and take the higher version", async () => {
  const body = await loadMergeConflict();
  assertStringIncludes(body, "before");
  assertStringIncludes(body, "higher");
  assertStringIncludes(body, "semver");
});

Deno.test("merge_conflict - says lock files are regenerated, never merged", async () => {
  const body = await loadMergeConflict();
  assertStringIncludes(body, "regenerate");
  for (
    const lock of ["deno.lock", "package-lock.json", "Cargo.lock", "go.sum"]
  ) {
    assertStringIncludes(body, lock);
  }
});

Deno.test("merge_conflict - tells the agent rule-resolved files are not in the conflicted list", async () => {
  const body = await loadMergeConflict();
  const start = body.indexOf("## The Contract — Both Sides Survive");
  const end = body.indexOf("## What To Do", start);
  const contract = body.slice(start, end);
  assertStringIncludes(contract, "conflicted-file list");
  assertStringIncludes(contract, "not listed");
  // The placeholder itself is injected once, at the end of the template.
  assertEquals(body.split("{{CONFLICTED_FILES}}").length - 1, 1);
});

Deno.test("merge_conflict - gives the total-order rationale so the carve-out is not generalised", async () => {
  const body = await loadMergeConflict();
  assertStringIncludes(body, "total order");
  assertStringIncludes(body, "rule");
  assertStringIncludes(body, "judgement");
});

// --- The narrowed issue-intent carve-out (Issue #1114) ---

/** Template prose is hard-wrapped by `deno fmt`, so match on flattened text. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The intent carve-out section of the template, flattened. */
async function intentSection(): Promise<string> {
  const body = await loadMergeConflict();
  const start = body.indexOf("### The Issue-Intent Carve-Out");
  const end = body.indexOf("### Worked Examples", start);
  assert(start >= 0 && end > start, "the intent carve-out section is missing");
  return flatten(body.slice(start, end));
}

Deno.test("merge_conflict - carries the issue-context placeholder exactly once", async () => {
  const body = await loadMergeConflict();
  assertStringIncludes(body, "{{ISSUE_CONTEXT}}");
  assertEquals(body.split("{{ISSUE_CONTEXT}}").length - 1, 1);
});

Deno.test("merge_conflict - states the default contract before the intent carve-out", async () => {
  const body = await loadMergeConflict();
  const contract = body.indexOf("## The Contract — Both Sides Survive");
  const intent = body.indexOf("### The Issue-Intent Carve-Out");
  assert(contract >= 0 && intent > contract, "the carve-out precedes the rule");
  assertStringIncludes(
    flatten(body.slice(intent)),
    "The contract above is the default and it is unchanged",
  );
});

Deno.test("merge_conflict - an override needs both issues and a quotable sentence", async () => {
  const section = await intentSection();
  assertStringIncludes(section, "Both sides' originating issues are present");
  assertStringIncludes(section, "explicitly supersedes the other");
  assertStringIncludes(section, "You can quote the sentence that says so");
  assertStringIncludes(section, "One side's issue alone is not evidence");
  assertStringIncludes(section, "Intent override:");
  // Absent the evidence, the unchanged contract still applies.
  assertStringIncludes(section, "Absent that evidence, nothing changes");
  assertStringIncludes(section, "git merge --abort");
});

Deno.test("merge_conflict - an intent-justified resolution still meets the guards", async () => {
  const section = await intentSection();
  assertStringIncludes(
    section,
    "an intent-justified resolution still has to leave no unmerged path and " +
      "no conflict marker behind",
  );
  assertStringIncludes(section, "the worker still refuses the push");
});

Deno.test("merge_conflict - the built prompt fences the issue context", async () => {
  const built = await buildMergeConflictPrompt({
    repo: "stSoftwareAU/VibeCoder",
    prNumber: "4321",
    baseBranch: "main",
    conflictedFiles: ["worker/deno/lib/timeouts.ts"],
    promptsDir: PROMPTS_DIR,
    issueContext: {
      repo: "stSoftwareAU/VibeCoder",
      prNumber: 4321,
      prSide: {
        resolved: true,
        signal: "branch",
        issue: {
          number: 900,
          title: "Retune the timeout",
          state: "CLOSED",
          body: "Supersedes #812: use 10s.",
          bodyTruncated: false,
        },
      },
      baseSide: [{
        path: "worker/deno/lib/timeouts.ts",
        commitsInspected: 1,
        prNumbers: [77],
        issues: [{
          number: 812,
          title: "Raise the timeout to 60s",
          state: "CLOSED",
          body: "",
          bodyTruncated: false,
        }],
        unresolved: null,
        partial: false,
      }],
      truncation: {
        commitCapPaths: [],
        issueCapHit: false,
        textTruncatedIssues: [],
        ghCallCapHit: false,
      },
      ghCallsUsed: 4,
      warnings: [],
    },
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;

  const { prompt } = built.value;
  assertStringIncludes(prompt, `<document source="github-issues">`);
  assertStringIncludes(prompt, "Issue #900");
  assertStringIncludes(prompt, "Issue #812");
  assertStringIncludes(prompt, "the originating issues quoted below");
  assertEquals(/\{\{[A-Z_]+\}\}/.test(prompt), false);
});

Deno.test("merge_conflict - no issue context leaves no block behind", async () => {
  const built = await buildMergeConflictPrompt({
    repo: "stSoftwareAU/VibeCoder",
    prNumber: "4321",
    baseBranch: "main",
    conflictedFiles: ["worker/deno/lib/timeouts.ts"],
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  assertEquals(
    built.value.prompt.includes(`<document source="github-issues">`),
    false,
  );
  assertEquals(/\{\{[A-Z_]+\}\}/.test(built.value.prompt), false);
});
