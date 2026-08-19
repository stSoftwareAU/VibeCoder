/**
 * Tests for the batch-api command (Issue #1264).
 *
 * CLI-specific tests only — unit tests for batch API logic live in
 * batch_api_test.ts. Deduplicated as part of Issue #1307.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { batchApiCommand } from "../commands/batch_api.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const config = buildDefaultWorkerConfig();

// =============================================================================
// CLI-specific: input validation
// =============================================================================

Deno.test("batch-api command - estimate-savings fails without tokens", async () => {
  const result = await batchApiCommand.execute(
    { "estimate-savings": true },
    config,
  );

  assertEquals(result.success, false);
  assert(result.message.includes("input-tokens"));
});

// =============================================================================
// CLI-specific: no sub-command usage message
// =============================================================================

Deno.test("batch-api command - no sub-command returns usage message", async () => {
  const result = await batchApiCommand.execute({}, config);

  assertEquals(result.success, false);
  assert(result.message.includes("assess-phases"));
  assert(result.message.includes("estimate-savings"));
  assert(result.message.includes("check-phase"));
});
