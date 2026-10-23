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

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Compaction success is judged by something that changes when `/compact` works on an append-only transcript (a `compact_boundary` system record after the pre-run offset); file size is not used — evidence: `worker/deno/lib/stream_compaction.ts` (`scanAppendedTranscript`, `compactStreamSession`), `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - REGRESSION (Issue #4116): a transcript that grows by a compact_boundary record is compacted` — reviewer: met
- **met** — Fixture transcript where `/compact` appended a boundary (file grew) reads as `compacted`; without a boundary it reads as the fallback; the first test fails on today's code — evidence: `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - REGRESSION (Issue #4116): a transcript that grows by a compact_boundary record is compacted`, `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - a transcript that grows with ordinary records but no compact_boundary falls back (Issue #4116)` — reviewer: met
- **met** — If the verified outcome is unreachable (transcript cannot be located), skip the `/compact` turn and go straight to `--autocompact` — evidence: `worker/deno/tests/stream_compaction_test.ts::compactStreamSession - no transcript located: /compact is not run and the fallback is taken (Issue #4116)`, `worker/deno/tests/stream_compaction_test.ts::primeStreamCompaction - no transcript located: /compact is not run and exactly one warning is logged (Issue #4116)` — reviewer: met
- **unrequested** — the 16 MiB scan cap, the truncated/shrunk-while-reading guards and the multi-copy offset sum — reviewer: unrequested — reason: safety bounds on reading an untrusted-size file; every one falls back to `--autocompact`, never to a false `compacted`, and each has its own test

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **violation** — A code change owes a docs change: `docs/audits/security-sweep-2337-stream-compaction.md` still described a size-measured verdict and "size only, never bytes" — evidence: `docs/audits/security-sweep-2337-stream-compaction.md` — reason: fixed in this diff
- **violation** — Every outcome of a new branch needs a test: no test isolated the `type` / `subtype` operands, a `null` JSON line, the 16 MiB cap, or several transcript copies — evidence: `worker/deno/lib/stream_compaction.ts:305` — reason: fixed in this diff (new tests; the redundant `typeof parsed === "object"` and blank-line checks were removed as dead code)
- **violation** — KISS: spread-in-a-loop to build the snapshot list — evidence: `worker/deno/lib/stream_compaction.ts:237` — reason: fixed in this diff (`push`)
- **violation** — Parallel-safe tests: the shrink-while-reading test swaps the process-global `Deno.open` — evidence: `worker/deno/tests/stream_compaction_test.ts` (test `a transcript that shrinks while its appended bytes are being read…`) — reason: retained; no file-opening seam exists and a real file cannot be shrunk between `stat` and `read`. The swap is restored in `finally` and the suite's parallel-safety test passes
- **clean** — Australian English, fail-loud fallbacks with a recorded reason, log levels (fallback stays WARNING, verified compaction does not), no persisted reader of the renamed log fields, fixtures use `Deno.makeTempDir`, `deno fmt`/`deno lint`/`deno check` clean

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
