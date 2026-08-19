/**
 * Tests for security_scan prompt v9 (Issue #2184).
 *
 * v9 expands the supply-chain detections to cover the 2025–2026 wave of
 * real-world attacks (Shai-Hulud, Axios phantom dependencies, node-ipc
 * dormant republish, TanStack provenance forgery, tj-actions OIDC
 * extraction) and adds the two call-outs from the issue body:
 *
 *   - npm provenance / Sigstore attestation alone is no longer
 *     sufficient evidence of a clean release (TanStack proved a
 *     legitimate CI pipeline can be hijacked and still emit a valid
 *     provenance statement).
 *   - Coding-agent tool calls are build-time code execution and must
 *     be treated with the same egress/scope rules as install scripts.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("security_scan prompt v9 - latest version is v9 or later", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 9,
      true,
      `Expected security_scan prompt >= v9, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v9 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v9", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  },
);
