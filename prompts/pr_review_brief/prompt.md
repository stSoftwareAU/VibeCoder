<!--
The review brief shared by the fleet reviewer (.claude/skills/review-fleet-prs,
"Reviewing the ready PRs") and the worker's pre-PR verifier
(worker/deno/lib/pre_pr_verifier.ts), Issue #3395. One source, so the two
cannot drift: change the review rules here, never in a copy. Each caller fills
the six {{FIELDS}}; the fleet's values are listed in SKILL.md and the
verifier's in pre_pr_verifier.ts. This comment is stripped before rendering.
-->
## Review Mode — one change against its linked issue

{{REVIEW_CONTEXT}}

1. Read the linked issue and the repo's `AGENTS.md` / `CODING-STANDARDS.md`
   if they exist.
2. Check that the change does what the issue asks and nothing unrelated.
3. Look for correctness bugs, unhandled edge cases, security problems
   (injection, secrets, unsafe permissions in workflows), race conditions
   and regressions for existing callers.
4. Check the tests against the repository's canonical testing guidance.
   New behaviour and real bug fixes usually need a test that would fail on
   the externally meaningful regression; existing coverage may suffice.
   Refactors and UI restyles may need no new test. {{NO_TEST_ADDED_NOTE}}
   A missing safety net that matters is a finding. Flag new assertions on
   incidental CSS values, DOM shape, component/private function names or
   version strings unless the linked issue makes these an explicit
   contract. Prefer user-visible browser behaviour and semantic locators
   for UI, positive and negative contracts for APIs; visual baselines are
   appropriate when appearance is an explicit requirement and the baseline
   is reviewable. When a change adds the same handling at more than one step
   of a path (a check up front and on each iteration, a limit on the connect
   and on each read), confirm that each new test named for a later step has a
   fixture that gets past every earlier step giving the same outcome; a test
   an earlier step stops leaves its own step untested, which is a finding.
   When a test pins which of two similar values the code reads, or that two
   figures agree (two bases, two parallel records, a displayed and a derived
   figure), check that its fixture gives the candidates different values; a
   fixture where they are equal passes whichever value the code reads, which
   is a finding.
   For a documentation-drift test, check each pin that names a value a module
   or checked-in config file holds (a flag, command line, function name, key,
   version or tag): it must be built from that source, not typed in, and
   changing the value at its source must turn the test red; a typed-in copy is
   a finding.
5. Judge every change to an existing test: {{TEST_CHANGES}}, plus any
   inline test module (e.g. Rust `#[cfg(test)]`) the diff touches. A change
   is **meaningful** if it removes a test case, weakens or deletes an
   assertion, changes an expected value or expected behaviour, or skips or
   loosens a test. It is **trivial** if it only reformats, renames,
   updates imports or fixture paths, or adds cases or assertions. It is
   **tightened** if an expected value or behaviour changes only to make a
   supported contract test stricter, as the issue asks: it now asserts
   more, allows less (e.g. no longer tolerates a permission or a call it
   used to allow), or pins a stricter count, and nothing it used to check
   is dropped. A change that tightens one thing and loosens another is
   **meaningful**. If a test is removed, skipped, weakened or loosened and
   the linked issue does not require it (for example it looks like it was
   changed to make the build pass), report it as a blocking **finding**
   asking for the test to be restored, not only under `testChanges`.
   Report it under `testChanges` as **meaningful** only when the issue
   requires the change. For each `testChangeNotes` entry give `kind`
   (`expected-value` for a changed expected value or behaviour,
   `removed-case`, `added-skip`, `weakened-assertion`, `removed-file` or
   `other`); `criterionQuote`, the acceptance criterion from a linked issue
   that requires the change, quoted verbatim from the issue's title or body
   (not comments), or omitted if there is none; and `failsWithoutChange`,
   `true` or a short statement that the edited test still fails without the
   code it guards.
6. {{PREVIOUS_FINDINGS}}
7. Repo review checklists: {{REVIEW_CHECKLISTS}}
   When that is empty, the repo has no checklist that applies to this
   change; do nothing more for this step. Otherwise follow it: report every
   listed item in the reply `checklist` array as `met`, `missing` or
   `not applicable` with a short note. Every `missing` item is also a
   blocking **finding**. If the section says the checklist file is
   malformed, unreadable or was not checked, report that as a blocking
   **finding** as it instructs; never treat it as "no checklist".
8. Closure entries marked `met`: {{CLOSURE_ENTRIES}}
   When that is empty, no closure entry is owed a verdict; do nothing more
   for this step. Otherwise judge each listed entry on its own against the
   change at the head, not against the entry's own evidence. `met` means
   the change delivers every case, path and test the criterion names:
   wording such as "every", "each", "all" or "the whole" names cases the
   change must cover, and a case the change, its tests or its own new docs
   leave out (an exclusion a new test pins, a path its docs say does
   nothing) makes it `partial`. A criterion the change does not deliver at
   all is `missing`. Report every listed entry in the reply `closure` array
   as `met`, `partial` or `missing`, copying the criterion text as listed,
   with a note naming what is left out. Every `partial` or `missing` entry
   is also a blocking **finding** on the PR description.
9. For Dependabot: check the changelog or release notes for breaking
   changes that affect how this repo uses the dependency, and that a major
   bump is reflected in the code where needed.
10. If, while reading, you notice an important **pre-existing** problem the
   change did not cause and is not meant to fix (a bug, a security gap,
   data loss, a broken workflow in code it passes by), report it under
   `unrelatedIssues`, not as a finding: it is recorded separately and does
   not block this change. First confirm it is pre-existing: the same
   problem must be present on the base branch (read the file at the base
   ref, as described above) and not introduced, widened or newly exposed
   by this change. Anything this change causes, even in a file it only
   touches in passing, is a blocking **finding** it must fix; when in
   doubt, it is a finding. Only real, verified problems with a file and
   line, at most 3; not style, polish or wishes. Before writing one, search
   the repo's open issues by the file path and the defect's key words, not
   only its title (as described above, where you can). If an open issue
   already covers the same defect class, including an umbrella issue for
   it, set `existingIssue` to that issue's number: the new instance is added
   there as a comment instead of filed again. Leave out an instance that
   issue already describes. Write each as a standalone issue: a title that names the defect, and a
   body saying what is wrong, the failure scenario and a suggested fix.
   Describe a security gap by class and location only (for example "the
   query is written into the page unescaped"), never with a working
   exploit or payload: some repos are public.

Only report **blocking** findings: things that are wrong, unsafe or
untested. Style preferences and optional polish are not blocking. A
meaningful test change the issue requires is not a finding; report it under
`testChanges`. Do not guess: every finding needs a file and line from the
diff and a concrete failure scenario. A problem the change introduces,
widens or newly exposes is always a finding, never an unrelated issue.

Reply with only this JSON:
`{"summary": "<one or two sentences>", "earlierFindings": [{"index": 1, "verdict": "fixed" | "partly" | "not fixed", "note": "<evidence covering every ask in this earlier finding>"}], "findings": [{"file": "...", "line": 0, "problem": "...", "fix": "...", "category": "quality_check" | "summary_incomplete"}], "testChanges": "none" | "trivial" | "tightened" | "meaningful", "testChangeNotes": [{"file": "...", "line": 0, "change": "<what changed and why it matters>", "kind": "expected-value", "criterionQuote": "<verbatim from the linked issue, or omit>", "failsWithoutChange": true}], "unrelatedIssues": [{"title": "...", "file": "...", "line": 0, "body": "<markdown>", "existingIssue": 0}], "checklist": [{"checklist": "<name>", "item": "<text>", "verdict": "met" | "missing" | "not applicable", "note": "<why>"}], "closure": [{"criterion": "<text as listed>", "verdict": "met" | "partial" | "missing", "note": "<what is left out, or why every case is delivered>"}]}` (omit `existingIssue` unless an open issue covers the same defect class)
Use `[]` for `checklist` when there is no checklist section, and for `closure` when no closure entry is listed.

For each finding, use `quality_check` for an implementation or test defect and
`summary_incomplete` only for an evidence or documentation-contract defect.
Every finding remains blocking, including evidence-only findings. Never classify
a review finding as a git, network or host failure; availability failures belong
to the tool boundary. Omitted or unsupported categories are substantive.

For each numbered earlier finding, return exactly one `earlierFindings` verdict. Check every problem and Fix ask against the current code and tests. Partial fixes, narrower wording and documented limitations are not fixed. A false-positive rebuttal counts as fixed only when you independently verify its evidence. Use `[]` when there are no earlier findings.
