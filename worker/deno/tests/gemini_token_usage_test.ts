/**
 * Tests for gemini_token_usage.ts — Gemini CLI stream-json usage decoding
 * (Issue #1938, parent #1930).
 *
 * The non-negotiable: a Gemini run whose stats cannot be read decodes to
 * `undefined`, never to a zero that the credit log would record as free.
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import { decodeGeminiTokenUsage } from "../lib/gemini_token_usage.ts";

/** The stream-json `result` event Gemini CLI 0.55.1 actually emits. */
const GEMINI_RESULT = [
  '{"type":"user","content":"go"}',
  '{"type":"assistant","content":"done"}',
  '{"type":"result","timestamp":"2026-01-01T00:00:00.000Z","status":"success",' +
  '"stats":{"total_tokens":1500,"input_tokens":1000,"output_tokens":200,' +
  '"cached":400,"input":600,"duration_ms":1234,"tool_calls":2,' +
  '"models":{"gemini-2.5-pro":{"total_tokens":1500,"input_tokens":1000,' +
  '"output_tokens":200,"cached":400,"input":600}}}}',
].join("\n");

// =============================================================================
// The verified 0.55.1 stream-json shape
// =============================================================================

Deno.test("gemini_token_usage - decodes the stream-json result event", () => {
  assertEquals(decodeGeminiTokenUsage(GEMINI_RESULT), {
    // prompt (1000) less the cached prefix (400).
    inputTokens: 600,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 400,
  });
});

Deno.test("gemini_token_usage - sums every model under stats.models", () => {
  const raw = '{"type":"result","stats":{"models":{' +
    '"gemini-2.5-pro":{"input_tokens":1000,"output_tokens":200,' +
    '"cached":400,"input":600},' +
    '"gemini-2.5-flash":{"input_tokens":300,"output_tokens":40,' +
    '"cached":100,"input":200}}}}';

  assertEquals(decodeGeminiTokenUsage(raw), {
    inputTokens: 800,
    outputTokens: 240,
    cacheCreationTokens: 0,
    cacheReadTokens: 500,
  });
});

Deno.test("gemini_token_usage - derives input when the CLI omits the field", () => {
  // `input` is `max(0, prompt - cached)` in the CLI; an envelope without it
  // is still decodable from the two counters it did report.
  const raw = '{"type":"result","stats":{"models":{"gemini-2.5-flash":' +
    '{"input_tokens":900,"output_tokens":100,"cached":250}}}}';

  assertEquals(decodeGeminiTokenUsage(raw), {
    inputTokens: 650,
    outputTokens: 100,
    cacheCreationTokens: 0,
    cacheReadTokens: 250,
  });
});

Deno.test("gemini_token_usage - the last result event wins", () => {
  const raw = [
    '{"type":"result","stats":{"models":{"gemini-2.5-pro":' +
    '{"input_tokens":10,"output_tokens":1,"cached":0,"input":10}}}}',
    '{"type":"result","stats":{"models":{"gemini-2.5-pro":' +
    '{"input_tokens":80,"output_tokens":9,"cached":30,"input":50}}}}',
  ].join("\n");

  assertEquals(decodeGeminiTokenUsage(raw), {
    inputTokens: 50,
    outputTokens: 9,
    cacheCreationTokens: 0,
    cacheReadTokens: 30,
  });
});

// =============================================================================
// The nested `tokens` shape (`--output-format json` session metrics)
// =============================================================================

Deno.test("gemini_token_usage - decodes the nested tokens shape, thoughts billed as output", () => {
  const raw = '{"type":"result","stats":{"models":{"gemini-2.5-pro":' +
    '{"tokens":{"input":600,"prompt":1000,"candidates":200,"total":1500,' +
    '"cached":400,"thoughts":120,"tool":30}}}}}';

  assertEquals(decodeGeminiTokenUsage(raw), {
    inputTokens: 600,
    // Gemini 2.5 bills thinking as output: candidates + thoughts.
    outputTokens: 320,
    cacheCreationTokens: 0,
    cacheReadTokens: 400,
  });
});

Deno.test("gemini_token_usage - sums the nested shape across two models", () => {
  const raw = '{"type":"result","stats":{"models":{' +
    '"gemini-2.5-pro":{"tokens":{"prompt":1000,"candidates":200,' +
    '"cached":400,"thoughts":100}},' +
    '"gemini-2.5-flash":{"tokens":{"prompt":500,"candidates":60,' +
    '"cached":0,"thoughts":0}}}}}';

  assertEquals(decodeGeminiTokenUsage(raw), {
    inputTokens: 1100,
    outputTokens: 360,
    cacheCreationTokens: 0,
    cacheReadTokens: 400,
  });
});

// =============================================================================
// Nothing parseable — undefined, never a zero
// =============================================================================

Deno.test("gemini_token_usage - no result event decodes to undefined", () => {
  const raw = [
    '{"type":"user","content":"go"}',
    '{"type":"assistant","content":"done"}',
  ].join("\n");

  assertEquals(decodeGeminiTokenUsage(raw), undefined);
});

Deno.test("gemini_token_usage - empty output decodes to undefined", () => {
  assertEquals(decodeGeminiTokenUsage(""), undefined);
  assertEquals(decodeGeminiTokenUsage("   \n\n  "), undefined);
});

Deno.test("gemini_token_usage - non-numeric counters decode to undefined, not zero", () => {
  const raw = '{"type":"result","stats":{"models":{"gemini-2.5-pro":' +
    '{"input_tokens":"1000","output_tokens":"200","cached":"400"}}}}';

  assertEquals(decodeGeminiTokenUsage(raw), undefined);
});

Deno.test("gemini_token_usage - a result event with no stats decodes to undefined", () => {
  assertEquals(
    decodeGeminiTokenUsage('{"type":"result","status":"success"}'),
    undefined,
  );
});

Deno.test("gemini_token_usage - empty stats.models decodes to undefined", () => {
  assertEquals(
    decodeGeminiTokenUsage('{"type":"result","stats":{"models":{}}}'),
    undefined,
  );
});

Deno.test("gemini_token_usage - non-JSON output decodes to undefined", () => {
  assertEquals(
    decodeGeminiTokenUsage("error: the CLI fell over\nstack trace here"),
    undefined,
  );
});

Deno.test("gemini_token_usage - one unreadable counter condemns the whole model", () => {
  // The partial case: three readable counters and one string. Counting the
  // readable three would put a zero where the fourth belongs, which is the
  // silent zero this seam exists to prevent.
  const raw = '{"type":"result","stats":{"models":{"gemini-2.5-pro":' +
    '{"input_tokens":1000,"output_tokens":"200","cached":400,"input":600}}}}';

  assertEquals(decodeGeminiTokenUsage(raw), undefined);
});

Deno.test("gemini_token_usage - an unreadable nested counter condemns the model too", () => {
  const raw = '{"type":"result","stats":{"models":{"gemini-2.5-pro":' +
    '{"tokens":{"prompt":1000,"candidates":200,"cached":400,' +
    '"thoughts":"lots"}}}}}';

  assertEquals(decodeGeminiTokenUsage(raw), undefined);
});

Deno.test("gemini_token_usage - a negative counter is refused, never subtracted", () => {
  // A garbled or forged count must not reduce the day's totals or the spend
  // ceiling: it is refused, and the run is recorded UNKNOWN instead.
  const negativeInput =
    '{"type":"result","stats":{"models":{"gemini-2.5-pro":' +
    '{"input_tokens":1000,"output_tokens":10,"cached":0,"input":-50}}}}';
  const negativeOutput =
    '{"type":"result","stats":{"models":{"gemini-2.5-pro":' +
    '{"input_tokens":1000,"output_tokens":-9,"cached":0,"input":1000}}}}';

  assertEquals(decodeGeminiTokenUsage(negativeInput), undefined);
  assertEquals(decodeGeminiTokenUsage(negativeOutput), undefined);
});

Deno.test("gemini_token_usage - an entry missing a billable counter is refused", () => {
  // A prompt count with no candidates count is not a run whose output was
  // zero — it is a run whose output was never stated.
  const raw = '{"type":"result","stats":{"models":{"gemini-2.5-pro":' +
    '{"input_tokens":1000}}}}';

  assertEquals(decodeGeminiTokenUsage(raw), undefined);
});

Deno.test("gemini_token_usage - a model reporting only unreadable counters is skipped", () => {
  // The readable model still decodes; the unreadable one contributes nothing
  // rather than dragging the total down to a fabricated zero.
  const raw = '{"type":"result","stats":{"models":{' +
    '"gemini-2.5-pro":{"input_tokens":1000,"output_tokens":200,' +
    '"cached":400,"input":600},' +
    '"gemini-2.5-flash":{"input_tokens":null,"output_tokens":"nope"}}}}';

  assertEquals(decodeGeminiTokenUsage(raw), {
    inputTokens: 600,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 400,
  });
});

Deno.test("gemini_token_usage - a zero-token result event still decodes to measured zeros", () => {
  // A run that genuinely spent nothing reported it: that is a measurement,
  // not a missing count, so it decodes rather than warning.
  const raw = '{"type":"result","stats":{"models":{"gemini-2.5-flash":' +
    '{"input_tokens":0,"output_tokens":0,"cached":0,"input":0}}}}';

  assertEquals(decodeGeminiTokenUsage(raw), {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
});
