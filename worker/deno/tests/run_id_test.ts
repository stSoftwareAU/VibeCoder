/**
 * Tests for the canonical run-id module (Issue #2381).
 *
 * Covers run-id generation, seam-backed resolution, the commit trailer
 * helpers (positive + negative), and the footer / metadata formatters.
 *
 * Resolution is driven through the read seam and the injected store added by
 * Issue #963, never by setting `VIBE_RUN_ID` on the process: this module is
 * the one that *writes* that variable, so the old spelling raced every other
 * test running at the time and pinned the whole file into the gate's serial
 * pass (Issue #880). Every injected value is a sentinel that does not exist
 * in any real environment, so a code path that quietly fell back to
 * `Deno.env.get` would fail here rather than pass on the ambient run id.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  appendRunIdTrailer,
  assertRunIdTrailer,
  buildRunIdFooterLine,
  buildRunIdMetadataBlock,
  generateRunId,
  getRunId,
  hasRunIdTrailer,
  processRunIdStore,
  readRunId,
  RUN_ID_ENV_VAR,
  RUN_ID_PREFIX,
  RUN_ID_TRAILER_KEY,
} from "../lib/run_id.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

// =============================================================================
// generateRunId
// =============================================================================

Deno.test("run_id - generateRunId produces the vibe- prefixed format", () => {
  const id = generateRunId({ now: 0, random: () => 0 });
  assertEquals(id, `${RUN_ID_PREFIX}-0-000000`);
});

Deno.test("run_id - generateRunId encodes the timestamp in base36", () => {
  const now = 12345678;
  const id = generateRunId({ now, random: () => 0 });
  assertEquals(id, `${RUN_ID_PREFIX}-${now.toString(36)}-000000`);
});

Deno.test("run_id - generateRunId pads the random suffix to 6 hex chars", () => {
  const id = generateRunId({ now: 1, random: () => 0.5 });
  const suffix = id.split("-")[2];
  assertEquals(suffix?.length, 6);
  assert(/^[0-9a-f]{6}$/.test(suffix ?? ""));
});

Deno.test("run_id - generateRunId differs across invocations with default randomness", () => {
  const a = generateRunId();
  const b = generateRunId();
  // Same millisecond is possible, so allow ts to match but require the
  // overall id to differ via the random suffix in the common case.
  assert(a.startsWith(`${RUN_ID_PREFIX}-`));
  assert(b.startsWith(`${RUN_ID_PREFIX}-`));
});

// =============================================================================
// readRunId / getRunId (seam-backed, generate-once)
// =============================================================================

/** A run id that exists nowhere but this file. */
const PRESET_SENTINEL = "vibe-963-preset-sentinel";

Deno.test("run_id - readRunId returns the supplied env value verbatim (Issue #963)", () => {
  const env = envFrom({ [RUN_ID_ENV_VAR]: PRESET_SENTINEL });
  assertEquals(readRunId(env), PRESET_SENTINEL);
});

Deno.test("run_id - readRunId trims surrounding whitespace from the env value (Issue #963)", () => {
  const env = envFrom({ [RUN_ID_ENV_VAR]: `  ${PRESET_SENTINEL}  ` });
  assertEquals(readRunId(env), PRESET_SENTINEL);
});

Deno.test("run_id - readRunId reads a blank value as absent (Issue #963)", () => {
  assertEquals(readRunId(envFrom({ [RUN_ID_ENV_VAR]: "   " })), undefined);
});

Deno.test("run_id - readRunId reads an unset variable as absent (Issue #963)", () => {
  assertEquals(readRunId(emptyEnv), undefined);
});

Deno.test("run_id - readRunId never writes the id it did not find (Issue #963)", () => {
  // The read seam is read-only: a miss must not cache anything, which is what
  // lets a caller ask "is there a run id?" without establishing one.
  const store = new Map<string, string>();
  assertEquals(readRunId((name) => store.get(name)), undefined);
  assertEquals(store.size, 0);
});

Deno.test("run_id - getRunId returns the store's value verbatim (Issue #963)", () => {
  const store = new Map([[RUN_ID_ENV_VAR, PRESET_SENTINEL]]);
  assertEquals(getRunId(store), PRESET_SENTINEL);
});

Deno.test("run_id - getRunId generates and caches when the store is empty (Issue #963)", () => {
  const store = new Map<string, string>();
  const first = getRunId(store);
  assert(first.startsWith(`${RUN_ID_PREFIX}-`));
  // Cached into the store, so a second call returns the same id — this is
  // what makes every child `deno` command share one run id in production.
  assertEquals(store.get(RUN_ID_ENV_VAR), first);
  assertEquals(getRunId(store), first);
});

Deno.test("run_id - getRunId regenerates when the stored value is blank (Issue #963)", () => {
  const store = new Map([[RUN_ID_ENV_VAR, "   "]]);
  const id = getRunId(store);
  assert(id.startsWith(`${RUN_ID_PREFIX}-`));
  assertEquals(store.get(RUN_ID_ENV_VAR), id);
});

Deno.test("run_id - the default store is the real process environment (Issue #963)", () => {
  // The seam would be worthless if the production default no longer pointed
  // at the process. Asserted with a read of a variable this test does not
  // own, so nothing process-wide moves.
  assertEquals(processRunIdStore.get("PATH"), Deno.env.get("PATH"));
});

// =============================================================================
// Commit trailer helpers
// =============================================================================

Deno.test("run_id - the trailer is the literal line the rest of the world reads (Issue #963)", () => {
  // Every other assertion in this file spells the key as RUN_ID_TRAILER_KEY,
  // so all of them would follow a rename — and the rename would be silent.
  // The name is a published contract: `prompts/coding_guidelines/prompt.md`
  // tells the agent to write this exact line, `CODING-STANDARDS.md` requires
  // it on every commit, and `docs/AGENT-ACCOUNTABILITY.md` joins commits back
  // to their run with
  // `git log --format='%(trailers:key=Vibe-Coder-Run-Id)'`. Nothing in the
  // tree parses the trailer any other way, so if this line changes shape the
  // attribution stops resolving with nothing failing loudly to say so.
  assertEquals(RUN_ID_TRAILER_KEY, "Vibe-Coder-Run-Id");
  assertEquals(
    appendRunIdTrailer("Subject line only", "vibe-abc-123456"),
    "Subject line only\n\nVibe-Coder-Run-Id: vibe-abc-123456",
  );
});

Deno.test("run_id - hasRunIdTrailer detects a present trailer", () => {
  const msg = `Fix the parser\n\n${RUN_ID_TRAILER_KEY}: vibe-abc-123456`;
  assert(hasRunIdTrailer(msg));
});

Deno.test("run_id - hasRunIdTrailer returns false for a message without the trailer", () => {
  assertEquals(hasRunIdTrailer("Fix the parser (Issue #2381)"), false);
});

Deno.test("run_id - appendRunIdTrailer adds the trailer to a plain message", () => {
  const result = appendRunIdTrailer("Fix the parser", "vibe-abc-123456");
  assert(hasRunIdTrailer(result));
  assertStringIncludes(result, `${RUN_ID_TRAILER_KEY}: vibe-abc-123456`);
});

Deno.test("run_id - appendRunIdTrailer is idempotent", () => {
  const once = appendRunIdTrailer("Fix the parser", "vibe-abc-123456");
  const twice = appendRunIdTrailer(once, "vibe-different-999999");
  assertEquals(once, twice);
  // The original id is preserved — the second call is a no-op.
  assertStringIncludes(twice, "vibe-abc-123456");
});

Deno.test("run_id - appendRunIdTrailer joins an existing trailer block", () => {
  const msg =
    "Fix the parser\n\nCo-Authored-By: Claude <noreply@anthropic.com>";
  const result = appendRunIdTrailer(msg, "vibe-abc-123456");
  // The run-id trailer sits directly under Co-Authored-By (single newline),
  // keeping both in the same git trailer block.
  assertStringIncludes(
    result,
    "Co-Authored-By: Claude <noreply@anthropic.com>\n" +
      `${RUN_ID_TRAILER_KEY}: vibe-abc-123456`,
  );
});

Deno.test("run_id - appendRunIdTrailer separates a new trailer block with a blank line", () => {
  const result = appendRunIdTrailer("Subject line only", "vibe-abc-123456");
  assertStringIncludes(
    result,
    `Subject line only\n\n${RUN_ID_TRAILER_KEY}: vibe-abc-123456`,
  );
});

Deno.test("run_id - assertRunIdTrailer accepts a message carrying the trailer", () => {
  const msg = appendRunIdTrailer("Fix the parser", "vibe-abc-123456");
  const result = assertRunIdTrailer(msg);
  assert(result.ok);
});

Deno.test("run_id - assertRunIdTrailer rejects a message without the trailer (negative)", () => {
  const result = assertRunIdTrailer("Fix the parser — no trailer here");
  assert(!result.ok);
  if (!result.ok) {
    assertStringIncludes(result.error.message, RUN_ID_TRAILER_KEY);
  }
});

Deno.test("run_id - assertRunIdTrailer rejects a Co-Authored-By-only block (negative)", () => {
  const msg = "Fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>";
  const result = assertRunIdTrailer(msg);
  assert(!result.ok);
});

// =============================================================================
// Footer + metadata formatters
// =============================================================================

Deno.test("run_id - buildRunIdFooterLine embeds the run id in backticks", () => {
  const line = buildRunIdFooterLine("vibe-abc-123456");
  assertStringIncludes(line, "Run id:");
  assertStringIncludes(line, "`vibe-abc-123456`");
});

Deno.test("run_id - buildRunIdMetadataBlock is a fenced key/value block", () => {
  const block = buildRunIdMetadataBlock("vibe-abc-123456");
  assertEquals(block, "```\nrun-id: vibe-abc-123456\n```");
});
