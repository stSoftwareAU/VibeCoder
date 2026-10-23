# Claim correction accepts a fenced json reply

## Summary

Closes #4115. The claim-correction turn asks the model to "Reply with JSON
only", but models often wrap the JSON in a markdown code fence, and
`applyFlaggedSentenceReplacements` fed the raw reply to `JSON.parse`, so a valid
fenced payload was rejected. A new shared helper,
`worker/deno/lib/fenced_json.ts::unwrapJsonFence`, strips one json or plain code
fence. Claim correction uses its strict default (only a reply that is entirely
one fence is unwrapped, so surrounding prose is still rejected).
`revision_processor.ts` drops its inline fence regex and calls the same helper
with `allowSurroundingProse`, which keeps its existing behaviour of taking the
first fenced block from anywhere in the output. The prompt text is untouched.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — The claim-correction reply is parsed through one shared helper that accepts bare JSON or a single fenced json / plain block, and `revision_processor.ts` uses the same helper; other surrounding prose is still rejected — evidence: `worker/deno/lib/fenced_json.ts`, `worker/deno/tests/summary_claim_correction_test.ts::manual correction - prose around a fenced reply still throws` — reviewer: met
- **met** — Tests: a fenced reply applies its replacements, and malformed JSON inside a fence is still rejected; the fenced test fails on today's code — evidence: `worker/deno/tests/summary_claim_correction_test.ts::manual correction - a json-fenced reply applies the same replacements as the bare reply`, `worker/deno/tests/summary_claim_correction_test.ts::manual correction - malformed JSON inside a fence still throws` — reviewer: met
- **met** — The prompt's "Reply with JSON only" instruction stays; the parser is tolerant but the contract is not loosened — evidence: `worker/deno/lib/summary_claim_correction.ts` (prompt text unchanged, not in the diff) — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — KISS: two stacked comments saying the same thing above the fence handling — evidence: `worker/deno/lib/revision_processor.ts:131` — reason: fixed in this diff
- **violation** — Test naming: a test name read like a regex-backtracking guard though the helper scans strings — evidence: `worker/deno/tests/fenced_json_test.ts` — reason: fixed in this diff
- **clean** — Australian English, DRY (one helper replaces the inline regex), TDD (unit, revision and correction tests), Deno/TypeScript conventions, `deno fmt`, and docs (`docs/INTERNALS.md` row added)

**Docs sweep** — grep: `summary_claim_correction`, `claim correction`, `parseRevisionResponse`, `revision_processor`, "Reply with JSON only"; section: `docs/workflows/issue-processing.md` (claim correction turn, no fence wording) and `docs/INTERNALS.md` lib table; siblings: `summary_claim_correction.ts` row in `docs/INTERNALS.md` gained a neighbouring `fenced_json.ts` row; updated: `docs/INTERNALS.md`

## Test Plan

No assertion was removed from an existing test; the diff only adds tests.

- Added `worker/deno/tests/fenced_json_test.ts` (helper unit tests).
- Added `worker/deno/tests/summary_claim_correction_test.ts` fenced-reply tests (applies, CRLF, malformed, prose, wrong count).
- Added `worker/deno/tests/revision_processor_test.ts::parseRevisionResponse - fenced JSON with surrounding prose parses the fenced block`.
- Ran `deno test -A` over the three test files with stdin from `/dev/null`: 71 passed, 0 failed.

**Branch outcomes:**
- `worker/deno/lib/fenced_json.ts:32` — allowSurroundingProse mode takes the first fenced block — `worker/deno/tests/fenced_json_test.ts::unwrapJsonFence - allowSurroundingProse unwraps the first fenced block` — flipped to never take the branch, test went red
- `worker/deno/lib/fenced_json.ts:39` — error (not a single fence: bare JSON, prose, too short) returns input unchanged — `worker/deno/tests/fenced_json_test.ts::unwrapJsonFence - prose around a fence is returned unchanged by default` — flipped to return altered text, test went red
- `worker/deno/lib/fenced_json.ts:41` — success (single fence unwrapped, json tag dropped) — `worker/deno/tests/fenced_json_test.ts::unwrapJsonFence - json-tagged fence is unwrapped` — removing the tag drop (`:55`) went red
- `worker/deno/lib/fenced_json.ts:48` — absent (no closing fence) returns trimmed input — `worker/deno/tests/fenced_json_test.ts::unwrapJsonFence - allowSurroundingProse without a fence returns the trimmed input` — flipped to return empty, test went red
- `worker/deno/lib/fenced_json.ts:50` — empty (empty fence) falls back to trimmed input — `worker/deno/tests/fenced_json_test.ts::unwrapJsonFence - empty fence yields an empty string` — flipped to return the empty inner, test went red
- `worker/deno/lib/fenced_json.ts:55` — json language tag removed only when present — `worker/deno/tests/fenced_json_test.ts::unwrapJsonFence - json-tagged fence is unwrapped` — flipped to keep the tag, test went red
- `worker/deno/lib/summary_claim_correction.ts:369` — fenced reply parses, malformed fenced JSON still throws — `worker/deno/tests/summary_claim_correction_test.ts::manual correction - malformed JSON inside a fence still throws` — reverting to bare `JSON.parse` turns the fenced-reply test red
- `worker/deno/lib/revision_processor.ts:132` — fenced block amid prose parsed via the shared helper — `worker/deno/tests/revision_processor_test.ts::parseRevisionResponse - fenced JSON with surrounding prose parses the fenced block` — flipped `allowSurroundingProse` off, test went red
