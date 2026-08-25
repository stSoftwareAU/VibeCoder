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

/** A Gemini `--output-format stream-json` run: its own event shape. */
const GEMINI_STREAM = [
  '{"type":"user","content":"go"}',
  '{"type":"result","stats":{"models":{"gemini-2.5-pro":' +
  '{"tokens":{"prompt":1000,"candidates":200}}}}}',
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

Deno.test("provider_token_usage - Codex run with unparseable usage warns and is unknown", () => {
  const result = extractProviderTokenUsage(CODEX_JSONL, {
    provider: "codex",
    displayName: "Codex CLI",
    repo: "org/repo",
    phase: "issue",
    model: "gpt-5-codex",
  });

  assertEquals(result.usage, undefined);
  assertEquals(result.usageUnknown, true);
  assert(result.warning, "a warning must name the unparseable run");
  // Names the provider and the run it belongs to.
  assertStringIncludes(result.warning, "codex");
  assertStringIncludes(result.warning, "Codex CLI");
  assertStringIncludes(result.warning, "org/repo");
  assertStringIncludes(result.warning, "issue");
  assertStringIncludes(result.warning, "gpt-5-codex");
  // Says plainly that this is unknown, not zero.
  assertStringIncludes(result.warning, "not zero");
});

Deno.test("provider_token_usage - Gemini run with unparseable usage warns and is unknown", () => {
  const result = extractProviderTokenUsage(GEMINI_STREAM, {
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
