/**
 * Tests for the merge_conflict prompt (Issue #467).
 *
 * The template documents the deterministic dependency rules as an explicit,
 * bounded carve-out from the never-side-pick contract: the worker settles
 * dependency-version conflicts in known manifest files before the agent is
 * asked anything, regenerates lock files rather than merging them, and lists
 * only the deferred paths in `{{CONFLICTED_FILES}}`. The carve-out is limited
 * to dependency-version hunks — the contradictory-constant worked example is
 * resolved by judgement and named on its own line (Issue #2306).
 *
 * Issue #2306 also removed two things these tests now assert are gone: the
 * "stop and `git merge --abort`" rule, because an unresolved merge helps
 * nobody, and the quality-instructions block, because CI on the pushed merge
 * is the gate on a PR and the worker's type-check gate is the gate on a
 * milestone branch.
 *
 * The prose pins are scoped with `section()` to the heading holding each
 * rule, and assert whole sentences with `assertPins()` (Issue #3557,
 * CODING-STANDARDS.md § "Re-scoping an existing drift test").
 *
 * Australian English is used throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildMergeConflictPrompt } from "../lib/prompt_builder.ts";
import { loadPrompt, validatePromptTemplate } from "../lib/prompt_manager.ts";
import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const MERGE_CONFLICT_DOC = "prompts/merge_conflict/prompt.md";

/** Template prose is hard-wrapped by `deno fmt`, so match on flattened text. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

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
      // Issue #1767: the opening names a PR *or* a milestone branch, so the
      // template carries `TARGET_DESCRIPTION` where it once carried a bare
      // `PR_NUMBER`.
      "TARGET_DESCRIPTION",
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
    target: { kind: "pr", prNumber: 4321 },
    baseBranch: "main",
    conflictedFiles: ["worker/deno/lib/foo.ts"],
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
});

// --- The in-run quality gate is gone (Issue #2306) ---

Deno.test("merge_conflict - the template carries no quality-instructions placeholder", async () => {
  const body = await loadMergeConflict();
  assertEquals(
    body.includes("{{QUALITY_INSTRUCTIONS}}"),
    false,
    "the agent no longer runs the repository's quality gate in the run",
  );
});

Deno.test("merge_conflict - the rendered prompt withholds the gate from the agent", async () => {
  const built = await buildMergeConflictPrompt({
    repo: "stSoftwareAU/VibeCoder",
    target: { kind: "pr", prNumber: 4321 },
    baseBranch: "main",
    conflictedFiles: ["worker/deno/lib/foo.ts"],
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  const flat = flatten(built.value.prompt);
  assertStringIncludes(
    flat,
    "The repository's quality gate is not yours this merge",
  );
  // The gate that does apply is named on each path, so "do not run it" is
  // not read as "nothing checks this merge".
  assertStringIncludes(flat, "CI on the pushed merge");
  assertStringIncludes(flat, "Resolve carefully enough that those checks pass");
  assertStringIncludes(flat, "type-check gate");
});

Deno.test("merge_conflict - the rendered prompt never tells the agent to abort the merge", async () => {
  const built = await buildMergeConflictPrompt({
    repo: "stSoftwareAU/VibeCoder",
    target: { kind: "pr", prNumber: 4321 },
    baseBranch: "main",
    conflictedFiles: ["worker/deno/lib/foo.ts"],
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(built.ok, true);
  if (!built.ok) return;
  assertEquals(
    built.value.prompt.includes("merge --abort"),
    false,
    "abort-on-contradiction was removed: the agent judges every file",
  );
});

// --- Judgement on every conflicted file (Issue #2306) ---

Deno.test("merge_conflict - asks for one judgement line per conflicted file", async () => {
  const doc = await readRepoDoc(MERGE_CONFLICT_DOC);
  assertPins(section(doc, "Where Both Sides Cannot Stand"), [
    "Write into `.pr_response_message`, one line per conflicted file, in exactly this shape:",
    "`Judgement: <path> — <kept …; dropped …; because …>`",
  ]);
});

Deno.test("merge_conflict - a genuine contradiction is decided, not handed back", async () => {
  const doc = await readRepoDoc(MERGE_CONFLICT_DOC);
  // The mechanical side-pick stays forbidden — only the abort rule went.
  assertPins(section(doc, "Where Both Sides Cannot Stand"), [
    "resolve to the outcome **both intents are best served by**",
    "read the **Originating Issues** block below when one is present",
    "a side-pick is mechanical (`-X ours`, `checkout --theirs`, deleting the awkward half), and it is still forbidden",
  ]);
});

// --- The never-side-pick contract survives ---

Deno.test("merge_conflict - keeps the never-side-pick contract", async () => {
  const doc = await readRepoDoc(MERGE_CONFLICT_DOC);
  assertPins(section(doc, "The Contract — Both Sides Survive"), [
    "**Perform a real merge. Never side-pick.**",
    "`git merge -X ours` / `-X theirs`, `git checkout --ours <file>` / `--theirs <file>`, or any other whole-hunk or whole-file side-pick",
    "The one exception is a genuine **duplicate**: both sides added the *same* content",
  ]);
});

// Issue #2306 changed this example's outcome deliberately: the agent no
// longer aborts on a contradiction, it decides and names the call. The
// assertion is updated rather than deleted, so the example still has to say
// what to do with a contradictory constant.
Deno.test("merge_conflict - the contradictory timeout example is decided by judgement", async () => {
  const body = await loadMergeConflict();
  const start = body.indexOf("30s to 60s");
  assert(start >= 0, "the timeout worked example is missing");
  const end = body.indexOf("</example>", start);
  assert(end > start, "the timeout worked example is unterminated");
  const example = flatten(body.slice(start, end));
  assertEquals(
    example.includes("merge --abort"),
    false,
    "the abort worked example was removed by Issue #2306",
  );
  // The example must still say what to do with a contradictory constant: read
  // both sides, decide, and write the judgement line naming the outcome.
  assertStringIncludes(example, "Read what each side's code does");
  assertStringIncludes(
    example,
    "Judgement: worker/deno/lib/timeouts.ts — kept the 10s interactive default",
  );
  assertStringIncludes(example, ".pr_response_message");
});

// --- The bounded dependency carve-out ---

Deno.test("merge_conflict - names the carve-out in the contract section", async () => {
  const doc = await readRepoDoc(MERGE_CONFLICT_DOC);
  assertPins(section(doc, "The Contract — Both Sides Survive"), [
    "### The Dependency-Version Carve-Out — Settled Before You Ran",
  ]);
});

Deno.test("merge_conflict - the carve-out is bounded to dependency-version hunks in known manifests", async () => {
  const doc = await readRepoDoc(MERGE_CONFLICT_DOC);
  // A source-code constant is explicitly outside the carve-out.
  assertPins(section(doc, "The Dependency-Version Carve-Out"), [
    "**The carve-out is bounded to dependency-version hunks in those manifest files.** It is not licence to generalise.",
    "Do not settle a conflicting constant, config value, threshold or string anywhere else by taking the newer one",
    "A dependency-version hunk in a known manifest — `deno.json`/`deno.jsonc`, `package.json`, `Cargo.toml`, `go.mod` —",
    "A value in source code has no such order",
  ]);
});

Deno.test("merge_conflict - states the rules run before this prompt and take the higher version", async () => {
  const doc = await readRepoDoc(MERGE_CONFLICT_DOC);
  assertPins(section(doc, "The Dependency-Version Carve-Out"), [
    "settled deterministically by the worker **before** this prompt is built, so it never reaches you",
    "is resolved per dependency key by taking the **higher** published semver, whichever branch carries it",
  ]);
});

Deno.test("merge_conflict - says lock files are regenerated, never merged", async () => {
  const doc = await readRepoDoc(MERGE_CONFLICT_DOC);
  assertPins(section(doc, "The Dependency-Version Carve-Out"), [
    "**Lock files.** `deno.lock`, `package-lock.json`, `Cargo.lock` and `go.sum` are **never** text-merged.",
    "The worker regenerates them from the already-merged manifest with the ecosystem's own tool.",
  ]);
});

Deno.test("merge_conflict - tells the agent rule-resolved files are not in the conflicted list", async () => {
  const doc = await readRepoDoc(MERGE_CONFLICT_DOC);
  assertPins(section(doc, "The Dependency-Version Carve-Out"), [
    "Files the rules resolved are already staged and are **not listed** in the conflicted-file list at the end of this prompt",
  ]);
  // The placeholder itself is injected once, at the end of the template.
  assertEquals(doc.split("{{CONFLICTED_FILES}}").length - 1, 1);
});

Deno.test("merge_conflict - gives the total-order rationale so the carve-out is not generalised", async () => {
  const doc = await readRepoDoc(MERGE_CONFLICT_DOC);
  assertPins(section(doc, "The Dependency-Version Carve-Out"), [
    "**Why this is a rule and not a judgement:** dependency versions have a total order",
    "which is exactly why the timeout example below is a judgement you make by reading the code, not a rule you apply",
  ]);
});

// --- The narrowed issue-intent carve-out (Issue #1114) ---

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
  assertStringIncludes(
    section,
    "Absent that evidence, an override is just a judgement",
  );
});

Deno.test("merge_conflict - an unevidenced override is flagged, not refused", async () => {
  const section = await intentSection();
  assertStringIncludes(section, "unverified judgement");
  assertStringIncludes(section, "The merge still lands");
});

Deno.test("merge_conflict - an intent-justified resolution still meets the guards", async () => {
  const section = await intentSection();
  assertStringIncludes(
    section,
    "your resolution still has to leave no unmerged path and no conflict " +
      "marker behind",
  );
  assertStringIncludes(section, "the worker still refuses the push");
});

Deno.test("merge_conflict - the built prompt fences the issue context", async () => {
  const built = await buildMergeConflictPrompt({
    repo: "stSoftwareAU/VibeCoder",
    target: { kind: "pr", prNumber: 4321 },
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
    target: { kind: "pr", prNumber: 4321 },
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
