/**
 * Tests for stable prompt-prefix ordering and volatility detection
 * (Issue #4282).
 *
 * Anthropic prompt caching reuses the longest byte-identical prefix, so these
 * tests assert on the rendered bytes: the canonical section order, the absence
 * of volatile tokens from the cacheable prefix, and a CLI invocation that
 * passes nothing per-turn that would bust the cache.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  describeVolatileTokens,
  findVolatilePrefixTokens,
  orderStablePrefix,
  STABLE_PREFIX_ORDER,
} from "../lib/prompt_prefix.ts";
import { buildIssuePrompt, type PromptParts } from "../lib/prompt_builder.ts";
import { resolveAgentProvider } from "../lib/agent_provider.ts";
import {
  buildCachedIssuePrompt,
  warnOnVolatileSystemPrompt,
} from "../lib/prompt_builder_cache.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

const REPO_CONTEXT = "# AGENTS.md\n\nRun ./quality.sh before pushing.";
const CUSTOM = "Use Deno tooling only.";

function unwrap(
  result: { ok: true; value: PromptParts } | { ok: false; error: Error },
): PromptParts {
  if (!result.ok) throw result.error;
  return result.value;
}

async function issueParts(
  overrides: Record<string, unknown> = {},
): Promise<PromptParts> {
  return unwrap(
    await buildIssuePrompt({
      repo: "owner/repo",
      issueNumber: "42",
      issueTitle: "Fix the parser",
      issueBody: "The date parser drops the year.",
      issueLabels: "bug",
      qualityInstructions: "Run ./quality.sh",
      promptsDir: PROMPTS_DIR,
      ...overrides,
    }),
  );
}

/** Strip this run's boundary nonce so two prompts can be compared byte-wise. */
function normaliseNonce(prompt: string): string {
  return prompt.replace(/_[0-9a-f]{12}\b/g, "_NONCE");
}

// ---------------------------------------------------------------------------
// orderStablePrefix
// ---------------------------------------------------------------------------

Deno.test("orderStablePrefix - emits sections in canonical order", () => {
  const ordered = orderStablePrefix({
    custom_instructions: "CUSTOM",
    repo_context: "CONTEXT",
    coding_guidelines: "GUIDELINES",
  });
  assertEquals(ordered, "GUIDELINES\n\nCONTEXT\n\nCUSTOM");
});

Deno.test("orderStablePrefix - key order does not change the bytes", () => {
  const a = orderStablePrefix({
    repo_context: "CONTEXT",
    custom_instructions: "CUSTOM",
  });
  const b = orderStablePrefix({
    custom_instructions: "CUSTOM",
    repo_context: "CONTEXT",
  });
  assertEquals(a, b);
});

Deno.test("orderStablePrefix - drops absent and blank sections", () => {
  assertEquals(
    orderStablePrefix({
      repo_context: "   \n ",
      custom_instructions: "CUSTOM",
    }),
    "CUSTOM",
  );
  assertEquals(orderStablePrefix({}), "");
});

Deno.test("orderStablePrefix - reserves a slot for the codebase map", () => {
  // The map (#4281) belongs in the stable prefix, after the repo context and
  // ahead of the repo-specific instructions.
  assertEquals(
    STABLE_PREFIX_ORDER.indexOf("codebase_map") >
      STABLE_PREFIX_ORDER.indexOf("repo_context"),
    true,
  );
  assertEquals(
    STABLE_PREFIX_ORDER.indexOf("codebase_map") <
      STABLE_PREFIX_ORDER.indexOf("custom_instructions"),
    true,
  );
});

// ---------------------------------------------------------------------------
// findVolatilePrefixTokens
// ---------------------------------------------------------------------------

Deno.test("findVolatilePrefixTokens - stable text yields nothing", () => {
  assertEquals(
    findVolatilePrefixTokens("Always run ./quality.sh before pushing."),
    [],
  );
});

Deno.test("findVolatilePrefixTokens - flags an ISO timestamp", () => {
  const found = findVolatilePrefixTokens("Generated at 2026-08-17T04:15:00Z.");
  assertEquals(found.length, 1);
  assertEquals(found[0]!.kind, "iso-timestamp");
  assertEquals(found[0]!.value, "2026-08-17T04:15:00Z");
});

Deno.test("findVolatilePrefixTokens - a bare date is reported once", () => {
  const found = findVolatilePrefixTokens("Today's date is 2026-08-17.");
  assertEquals(found.map((t) => t.kind), ["iso-date"]);
});

Deno.test("findVolatilePrefixTokens - flags a UUID and epoch millis", () => {
  const found = findVolatilePrefixTokens(
    "run 3f2b1c8e-4a5d-4f6b-9c1d-2e3f4a5b6c7d at 1755400000000",
  );
  assertEquals(found.map((t) => t.kind), ["uuid", "epoch-millis"]);
});

Deno.test("findVolatilePrefixTokens - flags an unexpected boundary nonce", () => {
  const found = findVolatilePrefixTokens(
    "---BEGIN UNTRUSTED USER CONTENT BOUNDARY_eb47423456a7---",
  );
  assertEquals(found.map((t) => t.kind), ["boundary-nonce"]);
  assertEquals(found[0]!.value, "eb47423456a7");
});

Deno.test("findVolatilePrefixTokens - this run's own nonce is allowed", () => {
  const text =
    "BOUNDARY_eb47423456a7 fences the issue; BOUNDARY_00112233445f does not.";
  const found = findVolatilePrefixTokens(text, {
    allowBoundaryId: "eb47423456a7",
  });
  assertEquals(found.map((t) => t.value), ["00112233445f"]);
});

Deno.test("findVolatilePrefixTokens - repeated scans do not leak state", () => {
  const text = "at 2026-08-17T04:15:00Z";
  assertEquals(
    findVolatilePrefixTokens(text).length,
    findVolatilePrefixTokens(text).length,
  );
});

Deno.test("describeVolatileTokens - names the tokens it found", () => {
  const description = describeVolatileTokens(
    findVolatilePrefixTokens("at 2026-08-17T04:15:00Z"),
  );
  assertEquals(description, "iso-timestamp=2026-08-17T04:15:00Z");
  assertEquals(describeVolatileTokens([]), "");
});

// ---------------------------------------------------------------------------
// buildIssuePrompt — the stable prefix leads, the volatile content follows
// ---------------------------------------------------------------------------

Deno.test("issue prompt - the system prompt carries no volatile token", async () => {
  const { systemPrompt } = await issueParts({
    repoContextContent: REPO_CONTEXT,
    customInstructions: CUSTOM,
  });
  assertEquals(
    describeVolatileTokens(findVolatilePrefixTokens(systemPrompt)),
    "",
  );
});

Deno.test("issue prompt - repo context and custom instructions precede the task", async () => {
  const { prompt } = await issueParts({
    repoContextContent: REPO_CONTEXT,
    customInstructions: CUSTOM,
  });
  const context = prompt.indexOf("Repository-Supplied Guidance");
  const custom = prompt.indexOf("Repository-Specific Instructions");
  const task = prompt.indexOf("I need you to fix GitHub issue #42");
  const body = prompt.indexOf("The date parser drops the year.");

  assert(context >= 0, "the repo context must be present");
  assert(custom > context, "custom instructions follow the repo context");
  assert(task > custom, "the task sentence follows the stable prefix");
  assert(body > task, "the untrusted issue body comes last");
});

Deno.test("issue prompt - custom instructions appear exactly once", async () => {
  const { prompt } = await issueParts({ customInstructions: CUSTOM });
  assertEquals(prompt.split(CUSTOM).length - 1, 1);
  assertEquals(
    prompt.split("## Repository-Specific Instructions").length - 1,
    1,
  );
});

Deno.test("issue prompt - the prefix is byte-identical across issues in one repo", async () => {
  const first = await issueParts({
    issueNumber: "42",
    issueTitle: "Fix the parser",
    issueBody: "one",
    repoContextContent: REPO_CONTEXT,
    customInstructions: CUSTOM,
  });
  const second = await issueParts({
    issueNumber: "99",
    issueTitle: "Something else entirely",
    issueBody: "two",
    repoContextContent: REPO_CONTEXT,
    customInstructions: CUSTOM,
  });

  // The system prompt is fully static — identical bytes, no normalisation.
  assertEquals(first.systemPrompt, second.systemPrompt);

  // The user turn's stable prefix (everything before the task sentence) is
  // identical too, once this run's randomised fence nonce is normalised.
  const prefixOf = (prompt: string) =>
    normaliseNonce(prompt.slice(0, prompt.indexOf("I need you to fix")));
  const firstPrefix = prefixOf(first.prompt);
  assert(firstPrefix.length > 0, "there must be a stable prefix to compare");
  assertEquals(firstPrefix, prefixOf(second.prompt));
});

Deno.test("issue prompt - the prefix holds no volatile token beyond the fence nonce", async () => {
  const { prompt } = await issueParts({
    repoContextContent: REPO_CONTEXT,
    customInstructions: CUSTOM,
  });
  const prefix = prompt.slice(0, prompt.indexOf("I need you to fix"));
  const nonce = /_([0-9a-f]{12})\b/.exec(prefix)?.[1];
  assert(nonce, "the fenced guidance must carry this run's nonce");
  assertEquals(
    describeVolatileTokens(
      findVolatilePrefixTokens(prefix, { allowBoundaryId: nonce }),
    ),
    "",
  );
});

// ---------------------------------------------------------------------------
// The cached-prompt guard
// ---------------------------------------------------------------------------

/** Minimal logger that records the warnings it is given. */
function recordingLogger(warnings: string[]) {
  return {
    info: () => {},
    warn: (msg: string) => warnings.push(msg),
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

Deno.test("prefix guard - warns and names a volatile system prompt", () => {
  const warnings: string[] = [];
  const volatileFound = warnOnVolatileSystemPrompt(
    "<coding_guidelines>\nGenerated 2026-08-17T04:15:00Z\n</coding_guidelines>",
    "owner/repo",
    recordingLogger(warnings),
  );
  assertEquals(volatileFound, true);
  assertEquals(warnings.length, 1);
  assert(warnings[0]!.includes("owner/repo"));
  assert(warnings[0]!.includes("iso-timestamp=2026-08-17T04:15:00Z"));
});

Deno.test("prefix guard - a stable system prompt warns about nothing", () => {
  const warnings: string[] = [];
  assertEquals(
    warnOnVolatileSystemPrompt(
      "<coding_guidelines>\nUse Australian English.\n</coding_guidelines>",
      "owner/repo",
      recordingLogger(warnings),
    ),
    false,
  );
  assertEquals(warnings, []);
});

Deno.test("prefix guard - the real issue prompt passes it", async () => {
  const warnings: string[] = [];
  const result = await buildCachedIssuePrompt({
    repo: "owner/repo",
    issueNumber: "42",
    issueTitle: "Fix the parser",
    issueBody: "The date parser drops the year.",
    issueLabels: "bug",
    qualityInstructions: "Run ./quality.sh",
    repoContextContent: REPO_CONTEXT,
    customInstructions: CUSTOM,
    promptsDir: PROMPTS_DIR,
    logger: recordingLogger(warnings),
  });
  assert(result.ok, "the prompt must build");
  assertEquals(warnings, []);
});

// ---------------------------------------------------------------------------
// CLI invocation — nothing per-turn busts the cache
// ---------------------------------------------------------------------------

Deno.test("claude invocation - identical requests produce identical args", () => {
  const provider = resolveAgentProvider("claude");
  const request = {
    prompt: "do the thing",
    systemPrompt: "the static guidelines",
    model: "claude-opus-4-8",
    effort: "high",
    disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
  };
  assertEquals(
    provider.buildInvocation({ ...request }),
    provider.buildInvocation({ ...request }),
  );
});

Deno.test("claude invocation - args carry no volatile token", () => {
  const provider = resolveAgentProvider("claude");
  const args = provider.buildInvocation({
    prompt: "do the thing",
    systemPrompt: "the static guidelines",
    model: "claude-opus-4-8",
    effort: "high",
  });
  assertEquals(
    describeVolatileTokens(findVolatilePrefixTokens(args.join(" "))),
    "",
  );
});

Deno.test("claude invocation - the static system prompt precedes the user prompt", () => {
  const provider = resolveAgentProvider("claude");
  const args = provider.buildInvocation({
    prompt: "do the thing",
    systemPrompt: "the static guidelines",
    model: "claude-opus-4-8",
  });
  const systemFlag = args.indexOf("--system-prompt");
  const userFlag = args.indexOf("-p");
  assert(systemFlag >= 0, "--system-prompt must be passed");
  assert(userFlag > systemFlag, "-p must come after --system-prompt");
});
