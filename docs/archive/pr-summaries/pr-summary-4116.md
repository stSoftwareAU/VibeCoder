# Stream /compact is verified by the `compact_boundary` record it appends, not by transcript file size

## Summary

`compactStreamSession` judged whether `/compact` worked by comparing the
session `.jsonl` **file size** before and after. Claude's transcript is
append-only, so every compaction read as "did not shrink", fell back to
`--autocompact` and paid for a `/compact` turn whose result was never trusted.
Closes #4116.

Now the transcript is located and its size recorded **before** the run (as an
offset, not a verdict); after a clean exit only the bytes appended past that
offset are read (capped at 16 MiB) and a `type: "system"`,
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
- Removed from `worker/deno/tests/stream_compaction_test.ts`, and kept in the re-laid-out tests of the same file (the `compacted`, `autocompact`, `unavailable`, `skipped` and one-line-per-run tests, and the non-zero-exit and thrown-runner tests):
  Moved to: `worker/deno/tests/stream_compaction_test.ts`
  - `assertEquals(result.action, "compacted");`
  - `assertEquals(result.message, "compaction: /compact");`
  - `assertEquals(result.autocompactTokens, undefined);`
  - `assertEquals(stub.calls.length, 1);`
  - `assertEquals(stub.calls[0]?.prompt, COMPACT_PROMPT);`
  - `assertEquals(stub.calls[0]?.sessionId, SESSION_ID);`
  - `assertEquals(result.action, "autocompact");`
  - `assertEquals(result.autocompactTokens, AUTOCOMPACT_WINDOW_TOKENS);`
  - `assertEquals(result.message, "compaction: autocompact 100000");`
  - `assertEquals(result.fields.compactExitCode, 2);`
  - `assertStringIncludes(String(result.fields.compactError), "spawn refused");`
  - `assertEquals(result.action, "unavailable");`
  - `assertStringIncludes(result.message, "compaction unavailable");`
  - `assertStringIncludes(result.message, providerId);`
  - `assertEquals(stub.calls.length, 0);`
  - `assertEquals(result.action, "skipped");`
  - `assertEquals(result.message, "compaction skipped: new stream session");`
  - `assertEquals( record.lines.length, 1, `${testCase.label}: expected one line, got ${record.lines.join(" | ")}`, );`
  - `assertStringIncludes(record.lines[0] ?? "", testCase.expected);`
  - `assertEquals(tokens, testCase.tokens, testCase.label);`
  - `assertEquals(tokens, AUTOCOMPACT_WINDOW_TOKENS);`
  - `assertEquals(record.lines.length, 1);`
  - `assertStringIncludes( String(record.fields[0]?.reason), "could not be spawned", );`
  - `assertEquals(fallback.levels, ["warn"]);`
  - `assertEquals(compacted.levels, ["info"]);`
- Changed in `worker/deno/tests/stream_session_provider_binding_2638_test.ts`: the "compaction still runs on the provider's own session" test now writes a transcript first (an unlocated transcript skips the turn); no assertion was removed.
- The old `assertEquals(stub.calls.length, 1)` after a missing `projects/` directory is now `0` (Required by: "skip the `/compact` turn and go straight to `--autocompact`"), covered by `compactStreamSession - a transcript directory that does not exist yet is not a fault`.

**Branch outcomes:**
- `worker/deno/lib/stream_compaction.ts:428` — absent (transcript not located; `/compact` turn skipped) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - no transcript located: /compact is not run and the fallback is taken (Issue #4116)` — flipped to `before === null`, test went red
- `worker/deno/lib/stream_compaction.ts:467` — error (non-zero or not-ok `/compact` run) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a non-zero /compact run falls back and never fails the issue` — flipped to `false`, test went red
- `worker/deno/lib/stream_compaction.ts:477` — error (appended bytes unreadable: rewritten shorter, deleted, shrank while reading) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a transcript rewritten shorter than its offset is not claimed as compacted (Issue #4116)` — flipped to never-unreadable, test went red
- `worker/deno/lib/stream_compaction.ts:486` — absent (no boundary appended) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a transcript that grows with ordinary records but no compact_boundary falls back (Issue #4116)` — flipped to `boundaries < 0`, test went red
- `worker/deno/lib/stream_compaction.ts:271` — error (file smaller than recorded offset) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a transcript rewritten shorter than its offset is not claimed as compacted (Issue #4116)` — flipped to never-true, test went red
- `worker/deno/lib/stream_compaction.ts:277` — success-bound (16 MiB scan cap) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a boundary beyond the scan cap is missed and falls back rather than being claimed (Issue #4116)` — cap removed, test went red
- `worker/deno/lib/stream_compaction.ts:289` — error (short read) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a transcript that shrinks while its appended bytes are being read is not claimed as compacted (Issue #4116)` — flipped to never-true, test went red
- `worker/deno/lib/stream_compaction.ts:299` — error (malformed or partial line skipped) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - malformed and partial lines among the appended bytes are skipped, and a valid boundary still counts (Issue #4116)` — skip replaced by a count, test went red
- `worker/deno/lib/stream_compaction.ts:305` — error (valid JSON that is `null`) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - malformed and partial lines among the appended bytes are skipped, and a valid boundary still counts (Issue #4116)` — null guard removed, test went red
- `worker/deno/lib/stream_compaction.ts:306` — absent (`type` is not `system`, or `subtype` is not `compact_boundary`) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - records that only resemble a boundary in one field do not count (Issue #4116)` — each operand forced true in turn, test went red
- `worker/deno/lib/stream_compaction.ts:237` — success (several transcript copies, offsets summed) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a boundary appended to any copy of the session's transcript counts, and the offsets are summed (Issue #4116)` — sum replaced by last size, test went red
- `worker/deno/lib/stream_compaction.ts:248` — absent (no copy found yields `undefined`, not an empty list) — `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - no transcript located: /compact is not run and the fallback is taken (Issue #4116)` — returned the empty list, test went red

**Mutation check:** the four surviving mutants are now killed — `stream_compaction.ts` `unreadable` (shrank-while-reading) by the shrink-while-reading test; the unlocated-transcript `providerId` by `…no transcript located: /compact is not run and the fallback is taken…`; `transcriptOffsetBefore` and `transcriptScanError` by the rewritten-shorter and cannot-be-read tests. Each was deleted in turn and a test went red.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Compaction success is judged by something that changes when /compact works on an append-only transcript. For example, a new compact boundary system record after the pre-run offset, or the context-size figure the CLI reports for the compacted session. File size is not used. — evidence: `worker/deno/lib/stream compaction.ts::scanAppendedTranscript (counts compact boundary system records after each transcript's pre-run offset); worker/deno/tests/stream compaction test.ts::compactStreamSession - a compact boundary left before the recorded offset by an earlier compaction does not count` — reviewer: met
- **met** — Test with a fixture transcript where /compact appended a boundary (file grew): it reads as compacted . Without a boundary: it reads as the fallback. The first test fails on today's code. — evidence: `worker/deno/tests/stream compaction test.ts::compactStreamSession - REGRESSION (Issue #4116): a transcript that grows by a compact boundary record is compacted; worker/deno/tests/stream compaction test.ts::compactStreamSession - a transcript that grows with ordinary records but no compact boundary f` — reviewer: met
- **met** — If the verified outcome is unreachable for a provider, skip the /compact turn and go straight to --autocompact , rather than paying for a turn whose result is never trusted. — evidence: `worker/deno/tests/stream compaction test.ts::compactStreamSession - no transcript located: /compact is not run and the fallback is taken (Issue #4116); worker/deno/tests/stream compaction test.ts::primeStreamCompaction - no transcript located: /compact is not run and exactly one warning is logged (I` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — Parallel-safe tests: the shrink-while-reading test reassigns the process-global Deno.open . The standards want an injected seam or a parameter instead. This is still a breach on a line this diff adds. This turn may not change code, so I did not fix it. The fix is an injectable file-open parameter on — evidence: `worker/deno/tests/stream compaction test.ts:412` — reason: NOT fixed in this diff: the Deno.open swap at test lines 412-453 is still there. The code change is needed before the PR is raised, because this is a breach in an added line and cannot be filed as pre-existing.
- **clean** — Checked and compliant: TDD (regression test for #4116 plus mutation-killing cases), fail-loud and never-throw fallback handling in stream compaction.ts, Australian English, and the documentation and PR summary updates in docs/CONFIGURATION.md, docs/MODEL-AND-CACHING.md and docs/archive/.
