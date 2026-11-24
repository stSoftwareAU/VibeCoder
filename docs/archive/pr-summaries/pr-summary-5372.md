## Summary

Shortened the **A fake mirrors the production implementation it stands in for**
rule on all four surfaces it appears on. The rule now says only what an author
must do: when a test hands the changed code something one of the repository's
own producers returns or writes, take it from the producer. The trigger lists,
the example-property list, the golden-file remedy and both PR-summary lines are
gone. Nothing was added, and both blocking self-review findings stay.

Closes #5372.

## Spec

### Intent and Rationale

- After #3900 the pattern came back on 19 PRs. The three public ones fitted
  neither listed trigger (a port, a wire format), so the lists were being read
  as the rule's scope. The scope is now just the opening sentence, "this covers
  the repository's own producers".
- The PR-summary lines were dropped because a line the author writes about their
  own fixture checks nothing. In VibeCoder#4999 that line was false.

### Essential Design Decisions

- The `CODING-STANDARDS.md` / `prompts/coding_guidelines/prompt.md` paragraph is
  the issue's proposed text, word for word. It is identical on both surfaces,
  and the test enforces that.
- The issue-prompt restatement carries the same content, with the back-reference
  to the guidelines kept. The operator manual keeps the #3224/#3900 history and
  adds one passage on what #5372 removed and why.
- The next paragraph's back-reference "the repository's own ports and server
  responses" now reads "the repository's own producers", as the issue asks.
- I added one absence test so the retired obligations (the PR-summary lines, the
  golden remedy, the trigger lists) stay out of the three agent-facing surfaces.
  It has a positive control so it cannot pass by reading the wrong text.

### Undiscoverable Facts

- The recurrence figures and the reading of the private PRs come from the
  review-fleet-prs ledger and the issue body. They were not checked in this run.

## Evidence

Documentation and prompt change only, with no product code. I grepped
`README.md`, `docs/` (excluding the archive), `prompts/`, `worker/deno/lib/` and
`.claude/` for `load-bearing fake`, `golden the server`, `producer never emits`,
`exposed-headers`, `own ports and server responses` and
`across processes and languages`. The only hits were the four surfaces and the
two drift tests. `prompts/test_audit/prompt.md` mentions "golden" for an
unrelated rule.

Related existing rules I checked:

- **A stub mirrors the real callee's contract**: separate rule, unchanged.
- **A test of a third-party tool's input uses that tool's semantics**:
  back-reference reworded.
- **Observe the real tool before you rely on it**: still says to build the
  fake's fixture from observed output, which agrees with the new rule.

I applied the shortened rule to this PR's own diff. The only test this change
adds or rewrites for the rule is a documentation-drift test, and it reads the
real documents rather than a hand-built stand-in, so the rule flags nothing. The
diff also edits one unrelated test, the #5236 growth guards (see the Test Plan).

Issue numbers cited as provenance: #5372: Shorten the #3900 fake-mirrors rule
after recurrence: its lists read as its scope and its PR-summary lines check
nothing (VibeCoder#4607, #4709, #4999 and private fleet PRs).

## Test Plan

- `worker/deno/tests/fake_mirrors_production_3224_test.ts`, updated as the issue
  asks:
  - `KEY_PHRASES`, `WIRE_FORMAT_PHRASES`, `ISSUE_PROMPT_SERVER_RESPONSE_PHRASES`
    and `MANUAL_PHRASES` now pin the phrases that remain.
  - Removed pins, made untrue by the issue's "What goes" list: "which rows a
    read returns", "whether a conditional write can lose", "name the production
    implementation each load-bearing fake stands in for", the wire-format
    trigger, "a golden the server's tests produce or verify", the serialiser
    contract test, "the PR adds one", "name in the PR summary where that is set"
    and "where that deployed setting is set". The issue-prompt Evidence-naming
    assertion is removed for the same reason.
  - Still pinned, matching the issue's "What stays" list: read production first,
    fix whichever side is wrong, the contract test or adapter test, the CORS
    exposed-headers check, the red-run rule and both blocking findings.
  - Unchanged: the identical-on-both-surfaces check and the ordering check
    between the stub-contract and observe-real-tool paragraphs.
  - New:
    `the retired fake-mirrors obligations stay out of the agent-facing surfaces (Issue #5372)`.
- Red on base: the new phrases are absent from the base text
  (`take it from the producer` occurs 0 times in the base branch's
  `CODING-STANDARDS.md`) and `load-bearing fake` is present in the base issue
  prompt, so the updated pins and the absence test fail there.
- `worker/deno/tests/third_party_tool_semantics_3235_test.ts`: unchanged. It
  passes with the reworded back-reference.
- `worker/deno/tests/dummy_test_scan_growth_5236_test.ts`, an unrelated test
  edited in the same PR to harden its growth guards against CI timing noise:
  the four `assertLinearGrowth` guards change `repeats: 1` to
  `repeats: 3`. A CI run read a single 58 ms reading against the 50 ms grace;
  `fastestInterleaved` in `worker/deno/tests/support/growth.ts` keeps the
  fastest of the interleaved readings per size, so three readings make one
  busy-runner spell unable to fail the guard. Thresholds are unchanged: slack,
  grace and size factor keep their values. Protection that remains: a quadratic
  scan still fails, because the fastest of three readings of a scan that costs
  `sizeFactor` squared stays far over the allowance (`pr-summary-5236.md`
  records the unfixed scan at 210 ms to 3139 ms, about 15x, against the 1732 ms
  a linear rule allows, about 8x).
- `deno test -A tests/fake_mirrors_production_3224_test.ts tests/third_party_tool_semantics_3235_test.ts`:
  10 passed, 0 failed.
- `./quality.sh < /dev/null`: PASSED. Config integration and checkov were
  skipped by the gate itself.

Not done: I did not run the test against base files checked out on disk.
Red-on-base is inferred from the phrase counts above.
