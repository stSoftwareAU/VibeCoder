# Stream /compact is verified by the `compact_boundary` record it appends, not by transcript file size

## Summary

`compactStreamSession` judged whether `/compact` worked by comparing the
session `.jsonl` **file size** before and after. Claude's transcript is
append-only, so every compaction read as "did not shrink", fell back to
`--autocompact` and paid for a `/compact` turn whose result was never trusted.
Closes #4116.

Now the transcript is located and its size recorded **before** the run (as an
offset, not a verdict); after a clean exit only the bytes appended past that
offset are read (capped at 16 MiB from each copy of the transcript) and a `type: "system"`,
`subtype: "compact_boundary"` record among them is the proof. When the
transcript cannot be located, the `/compact` turn is skipped and the run goes
straight to `--autocompact`.

## Docs sweep

**Docs sweep** — grep: `did not shrink`, `transcriptBytesBefore`, `measured`, "smaller means it worked", "unmeasurable transcript"; section: `docs/CONFIGURATION.md` (the "A resumed conversation is compacted before the issue's first phase" bullet), `docs/MODEL-AND-CACHING.md` (stream compaction table), `docs/audits/security-sweep-2337-stream-compaction.md`; siblings: none — no existing set gained a member (the `compaction: …` log phrasings are unchanged); updated: `docs/CONFIGURATION.md`, `docs/MODEL-AND-CACHING.md`, `docs/audits/security-sweep-2337-stream-compaction.md`

## Test Plan

Run: `cd worker/deno && deno test -A tests/stream_compaction_test.ts tests/stream_session_provider_binding_2638_test.ts` — 41 passed.

The test fixture changed from "write N bytes of `x`" to a real append-only JSONL transcript (`append` / `overwrite` / `remove`), so the existing tests were re-laid out. Every removed assertion is accounted for:

- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(result.fields.transcriptBytesBefore, 4096);`
  Required by: "Compaction success is judged by something that changes when"
  Replaced by: `assertEquals(result.fields.transcriptOffsetBefore, before);`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(result.fields.transcriptBytesAfter, 64);`
  Required by: "Compaction success is judged by something that changes when"
  Replaced by: `assertEquals(result.fields.compactBoundaries, 1);`
The assertions below are kept, unchanged, in the re-laid-out tests of the same file (the `compacted`, `autocompact`, `unavailable`, `skipped` and one-line-per-run tests, and the non-zero-exit and thrown-runner tests):

- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(result.action, "compacted");`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(result.message, "compaction: /compact");`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(result.autocompactTokens, undefined);`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(stub.calls.length, 1);`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(stub.calls[0]?.prompt, COMPACT_PROMPT);`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(stub.calls[0]?.sessionId, SESSION_ID);`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(result.action, "autocompact");`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(result.autocompactTokens, AUTOCOMPACT_WINDOW_TOKENS);`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(result.message, "compaction: autocompact 100000");`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(result.fields.compactExitCode, 2);`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertStringIncludes(String(result.fields.compactError), "spawn refused");`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(result.action, "unavailable");`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertStringIncludes(result.message, "compaction unavailable");`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertStringIncludes(result.message, providerId);`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(stub.calls.length, 0);`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(result.action, "skipped");`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(result.message, "compaction skipped: new stream session");`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals( record.lines.length, 1, `${testCase.label}: expected one line, got ${record.lines.join(" | ")}`, );`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertStringIncludes(record.lines[0] ?? "", testCase.expected);`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(tokens, testCase.tokens, testCase.label);`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(tokens, AUTOCOMPACT_WINDOW_TOKENS);`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(record.lines.length, 1);`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertStringIncludes( String(record.fields[0]?.reason), "could not be spawned", );`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(fallback.levels, ["warn"]);`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Removed from `worker/deno/tests/stream_compaction_test.ts`: `assertEquals(compacted.levels, ["info"]);`
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
- Changed in `worker/deno/tests/stream_session_provider_binding_2638_test.ts`: the "compaction still runs on the provider's own session" test now writes a transcript first (an unlocated transcript skips the turn); no assertion was removed.
- The old `assertEquals(stub.calls.length, 1)` after a missing `projects/` directory is now `0` (Required by: "skip the `/compact` turn and go straight to `--autocompact`"), covered by `compactStreamSession - a transcript directory that does not exist yet is not a fault`.

**Branch outcomes:**
- `worker/deno/lib/stream_compaction.ts:437` — absent (transcript not located; `/compact` turn skipped) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - no transcript located: /compact is not run and the fallback is taken (Issue #4116)` — flipped to `before === null`, test went red
- `worker/deno/lib/stream_compaction.ts:476` — error (non-zero or not-ok `/compact` run) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a non-zero /compact run falls back and never fails the issue` — flipped to `false`, test went red
- `worker/deno/lib/stream_compaction.ts:486` — error (appended bytes unreadable: rewritten shorter, deleted, shrank while reading) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a transcript rewritten shorter than its offset is not claimed as compacted (Issue #4116)` — flipped to never-unreadable, test went red
- `worker/deno/lib/stream_compaction.ts:495` — absent (no boundary appended) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a transcript that grows with ordinary records but no compact_boundary falls back (Issue #4116)` — flipped to `boundaries < 0`, test went red
- `worker/deno/lib/stream_compaction.ts:280` — error (file smaller than recorded offset) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a transcript rewritten shorter than its offset is not claimed as compacted (Issue #4116)` — flipped to never-true, test went red
- `worker/deno/lib/stream_compaction.ts:286-289` — success-bound (16 MiB scan cap, applied to each transcript copy) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a boundary beyond the scan cap is missed and falls back rather than being claimed (Issue #4116)` — cap removed, test went red
- `worker/deno/lib/stream_compaction.ts:298` — error (short read) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a transcript that shrinks while its appended bytes are being read is not claimed as compacted (Issue #4116)` — flipped to never-true, test went red
- `worker/deno/lib/stream_compaction.ts:309-311` — error (malformed or partial line skipped) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - malformed and partial lines among the appended bytes are skipped, and a valid boundary still counts (Issue #4116)` — skip replaced by a count, test went red
- `worker/deno/lib/stream_compaction.ts:314` — error (valid JSON that is `null`) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - malformed and partial lines among the appended bytes are skipped, and a valid boundary still counts (Issue #4116)` — null guard removed, test went red
- `worker/deno/lib/stream_compaction.ts:315-316` — absent (`type` is not `system`, or `subtype` is not `compact_boundary`) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - records that only resemble a boundary in one field do not count (Issue #4116)` — each operand forced true in turn, test went red
- `worker/deno/lib/stream_compaction.ts:446-449` — success (several transcript copies, offsets summed) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a boundary appended to any copy of the session's transcript counts, and the offsets are summed (Issue #4116)` — sum replaced by last size, test went red
- `worker/deno/lib/stream_compaction.ts:256` — absent (no copy found yields `undefined`, not an empty list) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - no transcript located: /compact is not run and the fallback is taken (Issue #4116)` — returned the empty list, test went red

**Mutation check:** the four surviving mutants are now killed — `stream_compaction.ts` `unreadable` (shrank-while-reading) by the shrink-while-reading test; the unlocated-transcript `providerId` by `…no transcript located: /compact is not run and the fallback is taken…`; `transcriptOffsetBefore` and `transcriptScanError` by the rewritten-shorter and cannot-be-read tests. Each was deleted in turn and a test went red.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Compaction success is judged by something that changes when /compact works on an append-only transcript (a new compact boundary system record after the pre-run offset, not file size) — evidence: `worker/deno/lib/stream_compaction.ts::scanAppendedTranscript`; `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a compact_boundary left before the recorded offset by an earlier compaction does not count (Issue #4116)` — reviewer: met
- **met** — A fixture transcript where /compact appended a boundary (file grew) reads as compacted — evidence: `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - REGRESSION (Issue #4116): a transcript that grows by a compact_boundary record is compacted` — reviewer: met
- **met** — Without a boundary the run reads as the fallback — evidence: `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a transcript that grows with ordinary records but no compact_boundary falls back (Issue #4116)` — reviewer: met
- **met** — The first test fails on today's code — evidence: the regression test grows the file by a boundary; the old `after >= before` size verdict returned `autocompact` for it (judged from the diff, not run against the old code) — reviewer: met
- **met** — If the verified outcome is unreachable for a provider, skip the /compact turn and go straight to --autocompact — evidence: `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - no transcript located: /compact is not run and the fallback is taken (Issue #4116)`; `worker/deno/tests/stream_compaction_test.ts::primeStreamCompaction - no transcript located: /compact is not run and exactly one warning is logged (Issue #4116)` — reviewer: met
- **unrequested** — the 16 MiB scan cap (`MAX_APPENDED_SCAN_BYTES`) on the appended-bytes read — reviewer: unrequested — reason: a safety bound on the new read; a missed boundary only falls back to `--autocompact`
- **unrequested** — the `openTranscript` seam on `StreamCompactionOptions` — reviewer: unrequested — reason: lets the shrink-while-reading test inject a file opener instead of swapping the global `Deno.open` (Standards, parallel-safe tests)
- **unrequested** — fallbacks for a truncated file, a short read and several copies of the transcript (offsets summed) — reviewer: unrequested — reason: hardening of the new scan; each fails toward the fallback, never toward a false `compacted`
- **unrequested** — docs updates (`docs/CONFIGURATION.md`, `docs/MODEL-AND-CACHING.md`, `docs/audits/security-sweep-2337-stream-compaction.md`, `docs/MANAGER-WORKER-CONTRACT.md`, `docs/PROVIDER-FEASIBILITY.md`) and the seeded transcript in `stream_session_provider_binding_2638_test.ts` — reviewer: unrequested — reason: needed to keep docs and the #2638 test in step, because an unlocated transcript now skips the turn

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Parallel-safe tests: the shrink-while-reading test reassigned the process-global `Deno.open` — evidence: `worker/deno/tests/stream_compaction_test.ts:424` — reason: fixed in this diff (the test now passes an injected `openTranscript` opener; `Deno.open` is only called inside it, and nothing is reassigned)
- **violation** — A code change owes a docs change: `docs/MANAGER-WORKER-CONTRACT.md:253`, `:263`, `:365` and `docs/PROVIDER-FEASIBILITY.md:48` cited stale `stream_compaction.ts` line numbers — evidence: `docs/MANAGER-WORKER-CONTRACT.md:253` — reason: fixed in this diff (now `:79-82`, `:183`, `:183-185` and `:412`)
- **violation** — Documentation hard-wrap: one over-long line in the compaction bullet — evidence: `docs/CONFIGURATION.md:3823` — reason: fixed in this diff (re-wrapped)
- **clean** — Checked and compliant: parallel safety and host isolation in the tests, no test-only production code, negative fixtures contain the forbidden thing, fail-loud fallback handling in `stream_compaction.ts`, the #2638 test precondition, Australian English, `deno fmt --check` and `deno lint`, and the Test Plan entries for removed assertions.
