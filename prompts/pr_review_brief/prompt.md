<!--
The review brief shared by the fleet reviewer (.claude/skills/review-fleet-prs,
"Reviewing the ready PRs") and the worker's pre-PR verifier
(worker/deno/lib/pre_pr_verifier.ts), Issue #3395. One source, so the two
cannot drift: change the review rules here, never in a copy. Each caller fills
the four {{FIELDS}}; the fleet's values are listed in SKILL.md and the
verifier's in pre_pr_verifier.ts. This comment is stripped before rendering.
-->
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
   is reviewable.
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
   requires the change.
6. {{PREVIOUS_FINDINGS}}
7. For Dependabot: check the changelog or release notes for breaking
   changes that affect how this repo uses the dependency, and that a major
   bump is reflected in the code where needed.
8. If, while reading, you notice an important **pre-existing** problem the
   change did not cause and is not meant to fix (a bug, a security gap,
   data loss, a broken workflow in code it passes by), report it under
   `unrelatedIssues`, not as a finding: it is recorded separately and does
   not block this change. First confirm it is pre-existing: the same
   problem must be present on the base branch (read the file at the base
   ref, as described above) and not introduced, widened or newly exposed
   by this change. Anything this change causes, even in a file it only
   touches in passing, is a blocking **finding** it must fix; when in
   doubt, it is a finding. Only real, verified problems with a file and
   line, at most 3; not style, polish or wishes. Skip any the repo's open
   issues already cover (search them as described above, where you can).
   Write each as a standalone issue: a title that names the defect, and a
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
`{"summary": "<one or two sentences>", "findings": [{"file": "...", "line": 0, "problem": "...", "fix": "..."}], "testChanges": "none" | "trivial" | "tightened" | "meaningful", "testChangeNotes": [{"file": "...", "line": 0, "change": "<what changed and why it matters>"}], "unrelatedIssues": [{"title": "...", "file": "...", "line": 0, "body": "<markdown>"}]}`
