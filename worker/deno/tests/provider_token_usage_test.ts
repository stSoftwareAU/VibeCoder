/**
 * Tests for provider_token_usage.ts — provider-aware token extraction
 * (Issue #366, parent #357).
 *
 * The non-negotiable: a run whose usage cannot be parsed is never recorded as
 * a silent zero. Claude keeps its existing behaviour byte-for-byte, including
 * staying quiet when a run legitimately reports no usage.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { extractProviderTokenUsage } from "../lib/provider_token_usage.ts";
import { extractTokenUsage } from "../lib/token_usage.ts";

/** A Claude CLI stream-json run that reports usage on its result line. */
const CLAUDE_STREAM = [
  '{"type":"assistant","message":{"model":"claude-opus-5","content":[]}}',
  '{"type":"result","result":"done","usage":{"input_tokens":150,' +
  '"output_tokens":50,"cache_creation_input_tokens":10,' +
  '"cache_read_input_tokens":80}}',
].join("\n");

/** A Codex `--json` run: its own JSONL events, none Claude-shaped. */
const CODEX_JSONL = [
  '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
  '{"type":"turn.completed","usage":{"input_tokens":1200,' +
  '"cached_input_tokens":900,"output_tokens":300}}',
].join("\n");

/**
 * A Gemini `--output-format stream-json` run: its own event shape, as CLI
 * 0.55.1 emits it (Issue #1938).
 */
const GEMINI_STREAM = [
  '{"type":"user","content":"go"}',
  '{"type":"result","status":"success","stats":{"total_tokens":1500,' +
  '"input_tokens":1000,"output_tokens":200,"cached":400,"input":600,' +
  '"duration_ms":1234,"tool_calls":0,"models":{"gemini-2.5-pro":' +
  '{"total_tokens":1500,"input_tokens":1000,"output_tokens":200,' +
  '"cached":400,"input":600}}}}',
].join("\n");

/** A Gemini run that ended without ever reporting a stats block. */
const GEMINI_NO_STATS = [
  '{"type":"user","content":"go"}',
  '{"type":"assistant","content":"done"}',
].join("\n");

// =============================================================================
// Claude path — unchanged behaviour, never warns
// =============================================================================

Deno.test("provider_token_usage - Claude usage matches extractTokenUsage exactly", () => {
  const result = extractProviderTokenUsage(CLAUDE_STREAM, {
    provider: "claude",
    displayName: "Claude Code",
    repo: "org/repo",
    phase: "issue",
  });

  assertEquals(result.usage, extractTokenUsage(CLAUDE_STREAM));
  assertEquals(result.usage, {
    inputTokens: 150,
    outputTokens: 50,
    cacheCreationTokens: 10,
    cacheReadTokens: 80,
  });
  assertEquals(result.usageUnknown, false);
  assertEquals(result.warning, undefined);
});

Deno.test("provider_token_usage - Claude run without a usage line does not warn", () => {
  const result = extractProviderTokenUsage(
    '{"type":"assistant","message":{"model":"claude-opus-5","content":[]}}',
    { provider: "claude", displayName: "Claude Code", repo: "org/repo" },
  );

  assertEquals(result.usage, undefined);
  assertEquals(result.usageUnknown, false);
  assertEquals(result.warning, undefined);
});

// =============================================================================
// Non-Claude providers — unparseable usage is loud and marked unknown
// =============================================================================

Deno.test("provider_token_usage - Codex run with parseable usage is measured, not unknown (Issue #1701)", () => {
  const result = extractProviderTokenUsage(CODEX_JSONL, {
    provider: "codex",
    displayName: "Codex CLI",
    repo: "org/repo",
    phase: "issue",
    model: "gpt-5-codex",
  });

  assertEquals(result.usage, {
    inputTokens: 1200,
    outputTokens: 300,
    cacheCreationTokens: 0,
    cacheReadTokens: 900,
  });
  assertEquals(result.usageUnknown, false);
  assertEquals(result.warning, undefined);
});

Deno.test("provider_token_usage - Codex run with unparseable usage warns and is unknown", () => {
  const result = extractProviderTokenUsage(
    '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
    {
      provider: "codex",
      displayName: "Codex CLI",
      repo: "org/repo",
      phase: "issue",
      model: "gpt-5-codex",
    },
  );

  assertEquals(result.usage, undefined);
  assertEquals(result.usageUnknown, true);
  assert(result.warning, "a warning must name the unparseable run");
  assertStringIncludes(result.warning, "codex");
  assertStringIncludes(result.warning, "Codex CLI");
  assertStringIncludes(result.warning, "org/repo");
  assertStringIncludes(result.warning, "issue");
  assertStringIncludes(result.warning, "gpt-5-codex");
  assertStringIncludes(result.warning, "not zero");
});

Deno.test("provider_token_usage - Gemini run with parseable usage is measured, not unknown (Issue #1938)", () => {
  const result = extractProviderTokenUsage(GEMINI_STREAM, {
    provider: "gemini",
    displayName: "Gemini CLI",
    repo: "org/repo",
    phase: "planning",
    model: "gemini-2.5-pro",
  });

  assertEquals(result.usage, {
    // `input_tokens` includes the cached prefix, so the uncached figure is
    // the 600 the CLI itself reports as `input`.
    inputTokens: 600,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 400,
  });
  assertEquals(result.usageUnknown, false);
  assertEquals(result.warning, undefined);
});

Deno.test("provider_token_usage - Gemini run with unparseable usage warns and is unknown", () => {
  const result = extractProviderTokenUsage(GEMINI_NO_STATS, {
    provider: "gemini",
    displayName: "Gemini CLI",
    repo: "org/repo",
    phase: "planning",
  });

  assertEquals(result.usage, undefined);
  assertEquals(result.usageUnknown, true);
  assert(result.warning, "a warning must name the unparseable run");
  assertStringIncludes(result.warning, "gemini");
  assertStringIncludes(result.warning, "planning");
  assertStringIncludes(result.warning, "not zero");
});

Deno.test("provider_token_usage - empty Gemini output is unknown, not zero", () => {
  const result = extractProviderTokenUsage("", {
    provider: "gemini",
    displayName: "Gemini CLI",
    repo: "org/repo",
    phase: "planning",
  });

  assertEquals(result.usage, undefined);
  assertEquals(result.usageUnknown, true);
  assert(result.warning);
  assertStringIncludes(result.warning, "gemini");
});

Deno.test("provider_token_usage - empty non-Claude output is unknown, not zero", () => {
  const result = extractProviderTokenUsage("", {
    provider: "codex",
    displayName: "Codex CLI",
  });

  assertEquals(result.usage, undefined);
  assertEquals(result.usageUnknown, true);
  assert(result.warning);
  // Missing context still produces a usable message rather than "undefined".
  assertEquals(result.warning.includes("undefined"), false);
});

Deno.test("provider_token_usage - non-Claude output in a parseable shape is used and stays quiet", () => {
  // A provider whose CLI emits Claude-compatible stream-json is extracted by
  // the shared extractor — no warning, real counts.
  const result = extractProviderTokenUsage(CLAUDE_STREAM, {
    provider: "gemini",
    displayName: "Gemini CLI",
    repo: "org/repo",
    phase: "planning",
  });

  assertEquals(result.usage, {
    inputTokens: 150,
    outputTokens: 50,
    cacheCreationTokens: 10,
    cacheReadTokens: 80,
  });
  assertEquals(result.usageUnknown, false);
  assertEquals(result.warning, undefined);
});
