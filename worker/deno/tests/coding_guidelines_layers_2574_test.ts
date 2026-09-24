/**
 * Phase-scoped coding guidelines and a de-duplicated issue template
 * (Issue #2574).
 *
 * The shared `coding_guidelines` block was sent whole to every phase, so
 * `planning`, `planning_critique`, `question` and `grill_me` — none of which
 * edit, test or commit code — carried about 30 KB of code-only rules, and the
 * `issue` template repeated about 12.5 KB of the guidelines it rides beside.
 * These cases pin the fix on the rendered prompts:
 *
 * - no section of the issue template is mostly a copy of the guidelines;
 * - the non-code phases get the core layer only, `spelling_fix` gets core plus
 *   the commit layer, and the code-writing phases keep every rule they had;
 * - each phase's system prompt is byte-stable across issues, and the static
 *   prompt hash moves when either layer does.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  buildCiFixPrompt,
  buildCodingGuidelines,
  buildIssuePrompt,
  buildMergeConflictPrompt,
  buildPlanningCritiquePrompt,
  buildPlanningPrompt,
  buildPrFeedbackPrompt,
  buildQuestionPrompt,
  buildSpellingFixPrompt,
  CODING_GUIDELINES_LAYER_BY_PHASE,
} from "../lib/prompt_builder.ts";
import { selectCodingGuidelinesLayer } from "../lib/coding_guidelines_overlay.ts";
import { computeStaticPromptHash } from "../lib/prompt_hash.ts";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** `##`/`###` headings of a Markdown text, skipping fenced code blocks. */
function headingsOf(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && /^#{2,3} /.test(line)) out.push(line.trim());
  }
  return out;
}

/** Sections split on `##`/`###` headings, skipping fenced code blocks. */
function sectionsOf(text: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  let fenced = false;
  let current: { heading: string; body: string } | undefined;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^#{2,3} /.test(line)) {
      current = { heading: line.trim(), body: "" };
      out.push(current);
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  return out;
}

/** Whitespace- and emphasis-normalised words. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(/[*_`>]/g, " ").split(/\s+/).filter(
    Boolean,
  );
}

/** Shingle width: six consecutive words is a copied phrase, not a shared idiom. */
const SHINGLE = 6;

/**
 * Fraction of `section`'s words covered by a six-word run that also appears
 * in `source` — a whitespace-normalised stand-in for a `difflib` match.
 */
function duplicatedFraction(section: string, source: Set<string>): number {
  const words = wordsOf(section);
  if (words.length === 0) return 0;
  const covered = new Array<boolean>(words.length).fill(false);
  for (let i = 0; i + SHINGLE <= words.length; i++) {
    if (source.has(words.slice(i, i + SHINGLE).join(" "))) {
      covered.fill(true, i, i + SHINGLE);
    }
  }
  return covered.filter(Boolean).length / words.length;
}

/** Every six-word run of `text`. */
function shinglesOf(text: string): Set<string> {
  const words = wordsOf(text);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= words.length; i++) {
    out.add(words.slice(i, i + SHINGLE).join(" "));
  }
  return out;
}

async function promptText(name: string): Promise<string> {
  const loaded = await loadPrompt(name, PROMPTS_DIR);
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}

// --- one home per rule ---

Deno.test("issue template - no section is mostly a copy of the guidelines (Issue #2574)", async () => {
  const guidelines = shinglesOf(await promptText("coding_guidelines"));
  const offenders = sectionsOf(await promptText("issue"))
    .map((s) => ({
      heading: s.heading,
      fraction: duplicatedFraction(s.body, guidelines),
    }))
    .filter((s) => s.fraction >= 0.5)
    .map((s) => `${s.heading} (${Math.round(s.fraction * 100)}%)`);
  assertEquals(
    offenders,
    [],
    "These issue-template sections repeat the coding guidelines the run " +
      "already receives in its system prompt. Keep one copy — in the " +
      "guidelines — and leave only the issue-specific delta here.",
  );
});

Deno.test("issue template - the duplicate detector catches a pasted section (Issue #2574)", async () => {
  // The guard above is only worth having if it fires: paste a guidelines
  // section into the template and it must be flagged.
  const guidelinesText = await promptText("coding_guidelines");
  const pasted = sectionsOf(guidelinesText).find((s) =>
    s.heading === "## Commit Safety"
  );
  assert(pasted, "the guidelines lost their Commit Safety section");
  assert(
    duplicatedFraction(pasted.body, shinglesOf(guidelinesText)) >= 0.5,
  );
});

Deno.test("guidelines - the Boy Scout Rule stays inside the change (Issue #2574)", async () => {
  const rendered = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "2574",
    issueTitle: "Scope",
    issueBody: "Body",
    issueLabels: "bug",
    qualityInstructions: "Run ./quality.sh",
    promptsDir: PROMPTS_DIR,
  });
  assert(rendered.ok);
  const text = `${rendered.value.systemPrompt}\n${rendered.value.prompt}`;
  // The unconditional form licensed tidying code the change never touched,
  // which is exactly what **Stay in scope** forbids.
  assertEquals(
    text.includes("Leave the code cleaner than you found it"),
    false,
  );
  const boyScout = text.split("\n").find((l) => l.includes("Boy Scout Rule"));
  assert(boyScout, "the Boy Scout Rule was dropped rather than confined");
  assertStringIncludes(text, "never beyond them");
  assertStringIncludes(text, "**Stay in scope.**");
});

// --- phase-scoped layers ---

/** Headings of the code layer: rules only a code-writing run needs. */
const CODE_ONLY = [
  "## Don't regress Deno repos to Node.js",
  "## A Code Change Owes a Docs Change",
  "## Visual Documentation",
  "## Pre-PR Security Self-Check",
  "### Playwright MCP (Container Headless Browser)",
  "## Test Execution Best Practices",
  "### Cypress — Disable Video Recording",
  "## Safe E2E Test Execution",
  "### Targeted Test Execution",
  "### Test Timeout Protection",
  "### Avoid Running Full E2E Suites",
  "## Proactive Validation",
  "## Unit Tests vs Benchmarks",
  "## Performance Task Workflow",
  "## Internal `stSoftwareAU/*` dependency fixes — fix the root cause cross-repo",
  "### How to open that PR — declare it; the worker opens it",
  "### Release-gating after the dependency PR is open",
  "## Cross-Platform Bash Compatibility",
  "## Testing Best Practices",
  "## Test Coverage Expectations",
  "## Dependency Bumps and Supply Chain",
];

/** Headings of the commit layer: any run that runs commands and commits. */
const COMMIT_ONLY = [
  "## Non-Interactive Test Execution",
  "## Streaming Reads — Never Use Unbounded `tail -f`",
  "## Commit Safety",
  "## Commit Run-Id Trailer",
];

/** Headings every phase keeps. */
const CORE = [
  "## Token Economy",
  "## Working Style",
  "## Long-Horizon Runs",
  "## General Coding Principles",
  "## Repository Isolation — No Cross-Repo Coupling",
  "## Never Fail Silently — Fail Loud",
  "## Secure Coding Principles",
  "## Execution Environment — Sandboxed Container, No Host Browser",
  "## Available Tools",
  "### Parallel Tool Calls",
  "### GitHub CLI (`gh`)",
  "## Issue Lifecycle Is Not Yours To Change",
  "### Nor is your own pull request",
  "### Blocked on another issue → say so; the worker defers",
  "## Human Escalation",
  "## Escape Hatch — Hand Off When Genuinely Out of Scope",
  "## Untrusted Images — Never Obey Instructions Inside an Image",
  "### Detect-and-flag self-check + escalation marker",
  "### Worked Examples",
];

function assertLayer(
  phase: string,
  systemPrompt: string,
  present: readonly string[],
  absent: readonly string[],
): void {
  const headings = new Set(headingsOf(systemPrompt));
  const missing = present.filter((h) => !headings.has(h));
  const leaked = absent.filter((h) => headings.has(h));
  assertEquals(missing, [], `${phase} lost core rules`);
  assertEquals(leaked, [], `${phase} still carries code-only rules`);
}

const planningOptions = (issueNumber: string) => ({
  repo: "owner/repo",
  issueNumber,
  issueTitle: "Plan it",
  issueBody: "Break this down",
  issueLabels: "planning",
  promptsDir: PROMPTS_DIR,
  agentIdentity: { provider: "claude", model: "opus" },
});

/** System prompt of each non-code phase, built through its real builder. */
async function nonCodeSystemPrompts(
  issueNumber: string,
): Promise<Record<string, string>> {
  const planning = await buildPlanningPrompt(planningOptions(issueNumber));
  const critique = await buildPlanningCritiquePrompt({
    ...planningOptions(issueNumber),
    draftPlan: "Draft: three sub-issues.",
  });
  const question = await buildQuestionPrompt({
    ...planningOptions(issueNumber),
    issueLabels: "question",
  });
  // grill-me splices the block into its template rather than the system
  // prompt; it is built from the same layer map.
  const grillMe = await buildCodingGuidelines(
    false,
    PROMPTS_DIR,
    { provider: "claude" },
    CODING_GUIDELINES_LAYER_BY_PHASE.grill_me,
  );
  assert(planning.ok && critique.ok && question.ok && grillMe.ok);
  return {
    planning: planning.value.systemPrompt,
    planning_critique: critique.value.systemPrompt,
    question: question.value.systemPrompt,
    grill_me: grillMe.value,
  };
}

Deno.test("layers - planning, critique, question and grill-me get the core layer only (Issue #2574)", async () => {
  for (
    const [phase, systemPrompt] of Object.entries(
      await nonCodeSystemPrompts("11"),
    )
  ) {
    assertLayer(phase, systemPrompt, CORE, [...CODE_ONLY, ...COMMIT_ONLY]);
  }
});

Deno.test("layers - spelling_fix gets core plus the commit layer (Issue #2574)", async () => {
  const built = await buildSpellingFixPrompt({
    repo: "owner/repo",
    prNumber: "7",
    checkName: "cspell",
    annotationDetails: "Unknown word (teh)",
    promptsDir: PROMPTS_DIR,
  });
  assert(built.ok);
  assertLayer(
    "spelling_fix",
    built.value.systemPrompt,
    [...CORE, ...COMMIT_ONLY],
    CODE_ONLY,
  );
});

Deno.test("layers - code-writing phases get every layer, with no marker left behind (Issue #2574)", async () => {
  for (const [phase, built] of Object.entries(await codePhaseBuilds("42"))) {
    assertLayer(phase, built.systemPrompt, [
      ...CORE,
      ...COMMIT_ONLY,
      ...CODE_ONLY,
    ], []);
    assertEquals(
      built.systemPrompt.includes("guidelines-layer"),
      false,
      `${phase} leaked a layer marker into the prompt`,
    );
  }
});

// --- code phases keep every rule ---

async function codePhaseBuilds(issueNumber: string) {
  const builds = {
    issue: await buildIssuePrompt({
      repo: "owner/repo",
      issueNumber,
      issueTitle: "Fix the bug",
      issueBody: "The bug needs fixing.",
      issueLabels: "bug",
      qualityInstructions: "Run ./quality.sh",
      promptsDir: PROMPTS_DIR,
    }),
    ci_fix: await buildCiFixPrompt({
      repo: "owner/repo",
      prNumber: issueNumber,
      checkName: "test",
      annotationDetails: "test failed",
      annotations: [],
      promptsDir: PROMPTS_DIR,
    }),
    pr_feedback: await buildPrFeedbackPrompt({
      repo: "owner/repo",
      prNumber: issueNumber,
      commentBody: "please fix",
      promptsDir: PROMPTS_DIR,
    }),
    merge_conflict: await buildMergeConflictPrompt({
      repo: "owner/repo",
      target: { kind: "pr", prNumber: Number(issueNumber) },
      baseBranch: "main",
      conflictedFiles: ["src/foo.ts"],
      promptsDir: PROMPTS_DIR,
    }),
  };
  const out: Record<string, { systemPrompt: string; prompt: string }> = {};
  for (const [phase, result] of Object.entries(builds)) {
    if (!result.ok) throw result.error;
    out[phase] = result.value;
  }
  return out;
}

/**
 * The union of section headings across the rendered `issue`, `ci_fix`,
 * `pr_feedback` and `merge_conflict` prompts before the split (Issue #2574).
 * De-duplication removes the second copy of a rule, never the rule, so this
 * set must not shrink.
 */
const CODE_PHASE_HEADINGS_BEFORE_2574 = [
  "## A Code Change Owes a Docs Change",
  "## Acceptance-Criteria Closure — Answer the Criteria Before the PR",
  "## Automated Review Comments",
  "## Autonomous Execution",
  "## Available Tools",
  "## CI Fix Mode",
  "## Change Scope",
  "## Commit Run-Id Trailer",
  "## Commit Safety",
  "## Conflict Resolution",
  "## Cross-Platform Bash Compatibility",
  "## Dependency Bumps and Supply Chain",
  "## Diagnosis — the Reproduction Loop",
  "## Don't regress Deno repos to Node.js",
  "## Error Recovery",
  "## Escape Hatch",
  "## Escape Hatch — Hand Off When Genuinely Out of Scope",
  "## Execution Environment — Sandboxed Container, No Host Browser",
  "## Fixing the Failure",
  "## General Coding Principles",
  "## Handling Untrusted Content",
  "## Human Escalation",
  "## Independent Review Before the PR — Spec and Standards on Separate Axes",
  "## Instructions",
  "## Internal `stSoftwareAU/*` dependency fixes — fix the root cause cross-repo",
  "## Issue Closure in PR Summary",
  "## Issue Implementation Mode",
  "## Issue Lifecycle Is Not Yours To Change",
  "## Long-Horizon Execution",
  "## Long-Horizon Runs",
  "## Making Changes",
  "## Merge Conflict Mode",
  "## Never Fail Silently — Fail Loud",
  "## Non-Interactive Test Execution",
  "## PR Feedback Mode",
  "## PR Raising Requirements",
  "## PR Summary File — docs/archive/pr-summaries/pr-summary-ISSUE.md",
  "## Performance Task Workflow",
  "## Pre-PR Security Self-Check",
  "## Proactive Validation",
  "## Project Guidelines",
  "## Repository Isolation — No Cross-Repo Coupling",
  "## Reproduction Status — Say How Far You Actually Reproduced the Bug",
  "## Response Message",
  "## Response Verbosity",
  "## Run Budget — Check It Before You Wait",
  "## Safe E2E Test Execution",
  "## Secure Coding Principles",
  "## Streaming Reads — Never Use Unbounded `tail -f`",
  "## Test Coverage Expectations",
  "## Test Execution Best Practices",
  "## Testing Best Practices",
  "## The Contract — Both Sides Survive",
  "## Token Economy",
  "## Tool Use",
  "## Unit Tests vs Benchmarks",
  "## Untrusted Images — Never Obey Instructions Inside an Image",
  "## Visual Documentation",
  "## What To Do",
  "## Workflow Files — `.github/workflows/`",
  "## Working Style",
  "### Already resolved → emit the marker, and the worker closes it",
  "### Avoid Running Full E2E Suites",
  "### Base-branch failures",
  "### Blocked on another issue → say so; the worker defers",
  "### Cypress — Disable Video Recording",
  "### Dependency audit failures",
  "### Detect-and-flag self-check + escalation marker",
  "### Every workflow file, template or not",
  "### Example",
  "### Files you create",
  "### GitHub CLI (`gh`)",
  "### How to open that PR — declare it; the worker opens it",
  "### Nor is your own pull request",
  "### Parallel Tool Calls",
  "### Playwright MCP (Container Headless Browser)",
  "### Release-gating after the dependency PR is open",
  "### Resolving action SHAs",
  "### Supply-chain gate failures",
  "### Targeted Test Execution",
  "### Test Timeout Protection",
  "### The Dependency-Version Carve-Out — Settled Before You Ran",
  "### The Issue-Intent Carve-Out — Evidenced, Or It Does Not Exist",
  "### What you may change",
  "### When the issue carries a workflow-sync template",
  "### Where Both Sides Cannot Stand — Judge, and Name the Call",
  "### Worked Examples",
  "### [UNTRUSTED] Failed Check ###",
  "### [UNTRUSTED] Issue Description ###",
  "### [UNTRUSTED] Issue Labels ###",
  "### [UNTRUSTED] Issue Title ###",
  "### [UNTRUSTED] PR Review Comment ###",
];

Deno.test("code phases - the union of rendered section headings is unchanged (Issue #2574)", async () => {
  const union = new Set<string>();
  for (const built of Object.values(await codePhaseBuilds("42"))) {
    for (const h of headingsOf(`${built.systemPrompt}\n${built.prompt}`)) {
      union.add(h);
    }
  }
  assertEquals([...union].sort(), [...CODE_PHASE_HEADINGS_BEFORE_2574].sort());
});

// --- cache stability ---

Deno.test("layers - each phase's system prompt is byte-identical across issues (Issue #2574)", async () => {
  const [a, b] = [
    await nonCodeSystemPrompts("101"),
    await nonCodeSystemPrompts("202"),
  ];
  for (const phase of Object.keys(a)) {
    assertEquals(a[phase], b[phase], `${phase} system prompt varies by issue`);
  }
  const [c, d] = [await codePhaseBuilds("101"), await codePhaseBuilds("202")];
  for (const phase of Object.keys(c)) {
    assertEquals(
      c[phase]!.systemPrompt,
      d[phase]!.systemPrompt,
      `${phase} system prompt varies by issue`,
    );
  }
});

Deno.test("layers - the static prompt hash moves when either layer changes (Issue #2574)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cg_layers_hash_" });
  try {
    for (const name of ["coding_guidelines", "issue"]) {
      await Deno.mkdir(`${dir}/${name}`, { recursive: true });
      await Deno.copyFile(
        `${PROMPTS_DIR}/${name}/prompt.md`,
        `${dir}/${name}/prompt.md`,
      );
    }
    const file = `${dir}/coding_guidelines/prompt.md`;
    const original = await Deno.readTextFile(file);
    const hash = async () => {
      const result = await computeStaticPromptHash(dir, "owner/repo");
      if (!result.ok) throw result.error;
      return result.value;
    };
    const baseline = await hash();

    // A core-layer edit.
    await Deno.writeTextFile(
      file,
      original.replace(
        "## Token Economy\n",
        "## Token Economy\n\nCore edit.\n",
      ),
    );
    const coreEdited = await hash();
    assertNotEquals(coreEdited, baseline);

    // A code-layer edit.
    await Deno.writeTextFile(
      file,
      original.replace(
        "## Commit Safety\n",
        "## Commit Safety\n\nCode-layer edit.\n",
      ),
    );
    const codeEdited = await hash();
    assertNotEquals(codeEdited, baseline);
    assertNotEquals(codeEdited, coreEdited);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- the layer selector itself ---

Deno.test("layer selector - keeps or drops marked blocks by layer (Issue #2574)", () => {
  const text = [
    "Core.",
    "<!-- guidelines-layer: commit -->",
    "Commit.",
    "<!-- /guidelines-layer -->",
    "<!-- guidelines-layer: code -->",
    "Code.",
    "<!-- /guidelines-layer -->",
    "Tail.",
  ].join("\n");
  const pick = (layer: "core" | "commit" | "code") => {
    const result = selectCodingGuidelinesLayer(text, layer);
    if (!result.ok) throw result.error;
    return result.value;
  };
  assertEquals(pick("core"), "Core.\nTail.");
  assertEquals(pick("commit"), "Core.\nCommit.\nTail.");
  assertEquals(pick("code"), "Core.\nCommit.\nCode.\nTail.");
});

Deno.test("layer selector - an unclosed, nested or unknown marker fails loud (Issue #2574)", () => {
  for (
    const broken of [
      "<!-- guidelines-layer: code -->\nNever closed.",
      "<!-- guidelines-layer: code -->\n<!-- guidelines-layer: commit -->\nx\n<!-- /guidelines-layer -->\n<!-- /guidelines-layer -->",
      "<!-- guidelines-layer: planning -->\nx\n<!-- /guidelines-layer -->",
      "Stray close.\n<!-- /guidelines-layer -->",
    ]
  ) {
    assertEquals(selectCodingGuidelinesLayer(broken, "code").ok, false);
  }
});

Deno.test("layer map - the non-code phases load core, spelling_fix commit, the rest code (Issue #2574)", () => {
  assertEquals(CODING_GUIDELINES_LAYER_BY_PHASE, {
    issue: "code",
    ci_fix: "code",
    pr_feedback: "code",
    merge_conflict: "code",
    custom_pr: "code",
    workflow_setup: "code",
    spelling_fix: "commit",
    planning: "core",
    planning_critique: "core",
    question: "core",
    grill_me: "core",
  });
});
