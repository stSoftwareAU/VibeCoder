## Summary

The summary correction turn reads the original file by path, refuses newly
introduced prompt-scrubbing markers before writing, and leaves the original
file and blocking finding in place after refusal. Completion and the local
summary checker also reject corrupted HTML/Mermaid delimiters. Closes #3710.

This ships with [#3715](pr-summary-3715.md), [#3731](pr-summary-3731.md) and
[#3739](pr-summary-3739.md) in milestone 111.

## Spec

### Intent and Rationale

- A scrubbed notice is evidence for a correction, never the editable source.
- A committed-summary check catches corruption from other recovery routes.

### Essential Design Decisions

- The notice retains its nonce fence; the model uses its existing read-only
  tools to read the original summary. The reply still uses the existing
  delimiter protocol and maximum size.
- The parser compares marker counts with the original, allowing existing
  literal characters without accepting newly introduced copies. The backstop
  rejects corrupted comment delimiters even in code and Mermaid blocks.

### Undiscoverable Facts

- Shell networking cannot resolve GitHub or JSR in this environment. Exact
  pinned dependencies were recovered through a separate GitHub Actions run;
  no dependency versions or lock entries changed.

## Evidence

Reproduction status: reproduced. The completion regression uses the actual
scrubber on a summary containing a Mermaid sequence arrow, HTML comment and
template braces. Before the fix it overwrites the file; after the fix it
refuses, preserves the bytes after the preceding recovery, and raises no PR.
This backend change has no UI screenshot.

**Docs sweep** — grep: `summary_claim_correction`, `summary-only correction`, `prompt-scrubbed`; section: docs/workflows/issue-processing.md the summary claim-correction section; updated: docs/workflows/issue-processing.md, docs/INTERNALS.md; siblings: none — this changes the existing correction protocol and adds a corruption backstop, not a member of a runtime set.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — Original file read by path; no fenced editable summary copy.
- **met** — New scrub markers are refused before writing, with an explicit
  error; the original summary remains intact.
- **met** — Completion and local Markdown gates reject corrupt delimiters.
- **met** — End-to-end regression covers Mermaid, HTML and template text.

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Independent implementation review checked nonce boundaries,
  refusal before writes, preserved blocking findings, both gate callers and
  exact dependency validation. No outstanding correctness finding remains.

## Test Plan

- `worker/deno/tests/summary_claim_correction_test.ts`: original-path prompt,
  marker refusal and unchanged literals, retaining existing parser failures.
- `worker/deno/tests/completion_phase_summary_claim_check_test.ts`: scrubbed
  echo cannot overwrite the file; committed corruption blocks PR creation.
- `worker/deno/tests/pr_summary_check_test.ts`: corrupt delimiters are refused
  even inside Mermaid/code; ordinary Markdown remains accepted.
- The five integrated new regression tests for correction, both prose callers
  and the local checker failed against the previous implementation. The final
  integrated scoped run passed 344 tests with the frozen lock. The manifest
  gate passed 687 tests, with one existing ignored test.
- The full `./quality.sh < /dev/null` gate passed on implementation commit
  `93f03976833f2dffaa4effd39d344b6b2a3f3bc4` in the
  [hosted validation run](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39024074189/job/117371486836).
  Parallel tests passed in 11m36s and serial tests in 3m06s. Type checking,
  lint, formatting, Markdown, Mermaid, release ruleset and structural stages
  passed. Semgrep 1.173.0 scanned 23 changed files with `p/default` and passed.
  Only configuration integration was skipped because no `.config.json` was
  supplied; the gate reported `PASSED (with skipped checks)`. The subsequent
  archive update changes validation evidence only.

- Removed from `worker/deno/tests/summary_claim_correction_test.ts`: `assertStringIncludes(prompt, PROMPT_OPTS.summaryContent.trim());`
  Required by: "Give the turn the summary by path"
  Replaced by: ```assertStringIncludes(prompt, `Read the original summary from \`${SUMMARY_PATH}\``,);```
- Removed from `worker/deno/tests/summary_claim_correction_test.ts`: `assertEquals(beginCount, 2);`
  Required by: "Do not ask for a verbatim echo of scrubbed text."
  Replaced by: `assertEquals(beginCount, 1);`
- Removed from `worker/deno/tests/summary_claim_correction_test.ts`: `assertEquals(endCount, 2);`
  Required by: "Do not ask for a verbatim echo of scrubbed text."
  Replaced by: `assertEquals(endCount, 1);`

The changed prompt expectations go red against the prior two-fence prompt.

**Branch outcomes:**

- New marker refused / existing literal preserved — `worker/deno/tests/summary_claim_correction_test.ts` — both inputs use the same marker and differ only in the original summary.
- Corrupted reply blocks writing / successful correction proceeds — `worker/deno/tests/completion_phase_summary_claim_check_test.ts` — existing success tests and the new scrubbed-echo regression.
- Corrupted committed delimiters rejected / ordinary delimiters accepted — `worker/deno/tests/pr_summary_check_test.ts`.
