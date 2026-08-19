/**
 * Tests for batch_api.ts — Anthropic Batch API client (Issue #1264).
 *
 * Covers: request construction, response parsing, batch lifecycle,
 * phase eligibility, polling behaviour, error handling.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import {
  BATCH_API_BASE_URL,
  BATCH_API_VERSION,
  BATCH_ELIGIBLE_PHASES,
  type BatchRequestItem,
  buildBatchRequest,
  buildBatchRequestItem,
  estimateBatchSavings,
  getBatchEligiblePhases,
  isBatchEligiblePhase,
  parseBatchResponse,
  parseBatchResults,
} from "../lib/batch_api.ts";

// =============================================================================
// buildBatchRequestItem tests
// =============================================================================

Deno.test("batch_api - buildBatchRequestItem creates valid request item", () => {
  const item = buildBatchRequestItem({
    customId: "health-check-001",
    model: "claude-haiku-4-7",
    maxTokens: 256,
    messages: [{
      role: "user",
      content: "Respond with OK if you are working.",
    }],
  });

  assertEquals(item.custom_id, "health-check-001");
  assertEquals(item.params.model, "claude-haiku-4-7");
  assertEquals(item.params.max_tokens, 256);
  assertEquals(item.params.messages.length, 1);
  assertEquals(item.params.messages[0]!.role, "user");
  assertEquals(
    item.params.messages[0]!.content,
    "Respond with OK if you are working.",
  );
});

Deno.test("batch_api - buildBatchRequestItem includes system prompt when provided", () => {
  const item = buildBatchRequestItem({
    customId: "summarise-001",
    model: "claude-haiku-4-7",
    maxTokens: 1024,
    systemPrompt: "You are a summarisation assistant. Use Australian English.",
    messages: [{ role: "user", content: "Summarise this text: ..." }],
  });

  assertEquals(
    item.params.system,
    "You are a summarisation assistant. Use Australian English.",
  );
  assertEquals(item.params.max_tokens, 1024);
});

Deno.test("batch_api - buildBatchRequestItem omits system when not provided", () => {
  const item = buildBatchRequestItem({
    customId: "test-001",
    model: "claude-haiku-4-7",
    maxTokens: 256,
    messages: [{ role: "user", content: "Hello" }],
  });

  assertEquals(item.params.system, undefined);
});

// =============================================================================
// buildBatchRequest tests
// =============================================================================

Deno.test("batch_api - buildBatchRequest creates request with items array", () => {
  const items: BatchRequestItem[] = [
    buildBatchRequestItem({
      customId: "item-1",
      model: "claude-haiku-4-7",
      maxTokens: 256,
      messages: [{ role: "user", content: "Test 1" }],
    }),
    buildBatchRequestItem({
      customId: "item-2",
      model: "claude-haiku-4-7",
      maxTokens: 256,
      messages: [{ role: "user", content: "Test 2" }],
    }),
  ];

  const request = buildBatchRequest(items);
  assertEquals(request.requests.length, 2);
  assertEquals(request.requests[0]!.custom_id, "item-1");
  assertEquals(request.requests[1]!.custom_id, "item-2");
});

Deno.test("batch_api - buildBatchRequest preserves item order", () => {
  const ids = ["alpha", "beta", "gamma"];
  const items = ids.map((id) =>
    buildBatchRequestItem({
      customId: id,
      model: "claude-haiku-4-7",
      maxTokens: 256,
      messages: [{ role: "user", content: `Message for ${id}` }],
    })
  );

  const request = buildBatchRequest(items);
  assertEquals(request.requests.map((r) => r.custom_id), ids);
});

// =============================================================================
// parseBatchResponse tests
// =============================================================================

Deno.test("batch_api - parseBatchResponse parses valid in_progress response", () => {
  const raw = {
    id: "batch_abc123",
    type: "message_batch",
    processing_status: "in_progress",
    request_counts: {
      processing: 5,
      succeeded: 0,
      errored: 0,
      canceled: 0,
      expired: 0,
    },
    created_at: "2026-04-13T10:00:00Z",
    ended_at: null,
    results_url: null,
  };

  const result = parseBatchResponse(raw);
  assert(result.ok);
  const response = result.value;
  assertEquals(response.id, "batch_abc123");
  assertEquals(response.processingStatus, "in_progress");
  assertEquals(response.requestCounts.processing, 5);
  assertEquals(response.requestCounts.succeeded, 0);
  assertEquals(response.endedAt, null);
  assertEquals(response.resultsUrl, null);
});

Deno.test("batch_api - parseBatchResponse parses completed response with results URL", () => {
  const raw = {
    id: "batch_xyz789",
    type: "message_batch",
    processing_status: "ended",
    request_counts: {
      processing: 0,
      succeeded: 3,
      errored: 1,
      canceled: 0,
      expired: 0,
    },
    created_at: "2026-04-13T10:00:00Z",
    ended_at: "2026-04-13T10:05:00Z",
    results_url:
      "https://api.anthropic.com/v1/messages/batches/batch_xyz789/results",
  };

  const result = parseBatchResponse(raw);
  assert(result.ok);
  assertEquals(result.value.processingStatus, "ended");
  assertEquals(result.value.requestCounts.succeeded, 3);
  assertEquals(result.value.requestCounts.errored, 1);
  assertExists(result.value.resultsUrl);
  assertExists(result.value.endedAt);
});

Deno.test("batch_api - parseBatchResponse rejects missing id", () => {
  const raw = {
    type: "message_batch",
    processing_status: "in_progress",
    request_counts: {
      processing: 0,
      succeeded: 0,
      errored: 0,
      canceled: 0,
      expired: 0,
    },
    created_at: "2026-04-13T10:00:00Z",
    ended_at: null,
    results_url: null,
  };

  const result = parseBatchResponse(raw);
  assert(!result.ok);
  assert(result.error.message.includes("id"));
});

Deno.test("batch_api - parseBatchResponse rejects missing processing_status", () => {
  const raw = {
    id: "batch_123",
    type: "message_batch",
    request_counts: {
      processing: 0,
      succeeded: 0,
      errored: 0,
      canceled: 0,
      expired: 0,
    },
    created_at: "2026-04-13T10:00:00Z",
    ended_at: null,
    results_url: null,
  };

  const result = parseBatchResponse(raw);
  assert(!result.ok);
  assert(result.error.message.includes("processing_status"));
});

// =============================================================================
// parseBatchResults tests
// =============================================================================

Deno.test("batch_api - parseBatchResults parses NDJSON result lines", () => {
  const lines = [
    JSON.stringify({
      custom_id: "item-1",
      result: {
        type: "succeeded",
        message: {
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    }),
    JSON.stringify({
      custom_id: "item-2",
      result: {
        type: "succeeded",
        message: {
          content: [{ type: "text", text: "All clear" }],
          usage: { input_tokens: 15, output_tokens: 8 },
        },
      },
    }),
  ].join("\n");

  const result = parseBatchResults(lines);
  assert(result.ok);
  assertEquals(result.value.length, 2);
  assertEquals(result.value[0]!.customId, "item-1");
  assertEquals(result.value[0]!.resultType, "succeeded");
  assertEquals(result.value[0]!.text, "OK");
  assertEquals(result.value[1]!.customId, "item-2");
  assertEquals(result.value[1]!.text, "All clear");
});

Deno.test("batch_api - parseBatchResults handles errored items", () => {
  const lines = JSON.stringify({
    custom_id: "item-err",
    result: {
      type: "errored",
      error: {
        type: "invalid_request_error",
        message: "Invalid model specified",
      },
    },
  });

  const result = parseBatchResults(lines);
  assert(result.ok);
  assertEquals(result.value.length, 1);
  assertEquals(result.value[0]!.customId, "item-err");
  assertEquals(result.value[0]!.resultType, "errored");
  assertEquals(result.value[0]!.text, "");
  assertExists(result.value[0]!.errorMessage);
  assert(result.value[0]!.errorMessage!.includes("Invalid model"));
});

Deno.test("batch_api - parseBatchResults handles expired items", () => {
  const lines = JSON.stringify({
    custom_id: "item-exp",
    result: {
      type: "expired",
    },
  });

  const result = parseBatchResults(lines);
  assert(result.ok);
  assertEquals(result.value[0]!.resultType, "expired");
  assertEquals(result.value[0]!.text, "");
});

Deno.test("batch_api - parseBatchResults skips blank lines", () => {
  const lines = [
    JSON.stringify({
      custom_id: "a",
      result: {
        type: "succeeded",
        message: {
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    }),
    "",
    "  ",
    JSON.stringify({
      custom_id: "b",
      result: {
        type: "succeeded",
        message: {
          content: [{ type: "text", text: "Fine" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    }),
  ].join("\n");

  const result = parseBatchResults(lines);
  assert(result.ok);
  assertEquals(result.value.length, 2);
});

Deno.test("batch_api - parseBatchResults returns error for invalid JSON", () => {
  const lines = "not valid json at all";

  const result = parseBatchResults(lines);
  assert(!result.ok);
  assert(result.error.message.includes("parse"));
});

// =============================================================================
// Phase eligibility tests
// =============================================================================

Deno.test("batch_api - BATCH_ELIGIBLE_PHASES contains expected phases", () => {
  // These phases are non-time-sensitive and use simple output
  assert(BATCH_ELIGIBLE_PHASES.includes("health"));
  assert(BATCH_ELIGIBLE_PHASES.includes("summarise"));
  assert(BATCH_ELIGIBLE_PHASES.includes("spelling_fix"));
  assert(BATCH_ELIGIBLE_PHASES.includes("clarification"));
});

Deno.test("batch_api - BATCH_ELIGIBLE_PHASES excludes time-sensitive phases", () => {
  // These phases need immediate results
  assert(!BATCH_ELIGIBLE_PHASES.includes("execute"));
  assert(!BATCH_ELIGIBLE_PHASES.includes("planning"));
  assert(!BATCH_ELIGIBLE_PHASES.includes("ci_fix"));
});

Deno.test("batch_api - isBatchEligiblePhase returns true for eligible phase", () => {
  assert(isBatchEligiblePhase("health"));
  assert(isBatchEligiblePhase("summarise"));
});

Deno.test("batch_api - isBatchEligiblePhase returns false for ineligible phase", () => {
  assert(!isBatchEligiblePhase("execute"));
  assert(!isBatchEligiblePhase("planning"));
  assert(!isBatchEligiblePhase("unknown_phase"));
});

Deno.test("batch_api - getBatchEligiblePhases returns eligibility map", () => {
  const phases = getBatchEligiblePhases();
  assert(phases.length > 0);

  const healthPhase = phases.find((p) => p.phase === "health");
  assertExists(healthPhase);
  assertEquals(healthPhase.eligible, true);
  assertExists(healthPhase.reason);

  const executePhase = phases.find((p) => p.phase === "execute");
  assertExists(executePhase);
  assertEquals(executePhase.eligible, false);
  assertExists(executePhase.reason);
});

// =============================================================================
// Cost savings estimation tests
// =============================================================================

Deno.test("batch_api - estimateBatchSavings returns 50% discount", () => {
  const savings = estimateBatchSavings({
    inputTokens: 1000,
    outputTokens: 500,
    model: "claude-haiku-4-7",
  });

  // Batch API offers 50% discount
  assertEquals(savings.discountPercentage, 50);
  assert(savings.standardCost > 0);
  assert(savings.batchCost > 0);
  assert(savings.batchCost < savings.standardCost);
  // Batch cost should be exactly half
  assertAlmostEquals(savings.batchCost, savings.standardCost * 0.5, 0.0001);
});

Deno.test("batch_api - estimateBatchSavings handles zero tokens", () => {
  const savings = estimateBatchSavings({
    inputTokens: 0,
    outputTokens: 0,
    model: "claude-haiku-4-7",
  });

  assertEquals(savings.standardCost, 0);
  assertEquals(savings.batchCost, 0);
  assertEquals(savings.savings, 0);
});

// =============================================================================
// Constants and API configuration tests
// =============================================================================

Deno.test("batch_api - BATCH_API_BASE_URL uses Anthropic API endpoint", () => {
  assert(BATCH_API_BASE_URL.includes("anthropic.com"));
  assert(BATCH_API_BASE_URL.includes("messages/batches"));
});

Deno.test("batch_api - BATCH_API_VERSION is a valid date string", () => {
  // API version should be in YYYY-MM-DD format
  assert(/^\d{4}-\d{2}-\d{2}$/.test(BATCH_API_VERSION));
});

// =============================================================================
// Import assertion — ensure assertAlmostEquals is available
// =============================================================================

import { assertAlmostEquals } from "@std/assert";
