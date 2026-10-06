# PR Summary — Issue #3270

## Summary

Closes #3270. Rewrites the "🐛 Reporting a Vulnerability" subsection of
`SECURITY.md` so reporters use GitHub private vulnerability reporting first,
or email `security@stsoftware.com.au`, and never file a public issue or PR.

- [x] Rewrite the subsection (PVR first, email second, no-public-issue line)
- [x] Keep the `## 📢 Responsible Disclosure Policy` heading unchanged
- [x] Quality gate
- [x] Independent spec and standards review

## Spec

### Intent and Rationale

- Public vulnerability reports expose users before a fix exists; the old text
  only said "email the maintainers" with no address.

### Essential Design Decisions

- The PVR link points at `security/advisories/new`, the direct
  "Report a vulnerability" form, and the text also names the **Security** tab.
- The existing "Include:" list and 90-day disclosure step are kept.

### Undiscoverable Facts

None.

## Evidence

Docs-only change; no screenshot applies.

Docs sweep: grepped `Reporting a Vulnerability`, `security@` and
`private vulnerability reporting` across `*.md` (excluding the archive).
Section changed: `SECURITY.md#responsible-disclosure-policy`. Remaining hit:
`prompts/best_practices/buckets/general.md:291` — a generic check of
monitored repos' disclosure routes, still true.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- "Both private routes are named, PVR first." — `SECURITY.md` step 2 lists
  **Preferred:** GitHub private vulnerability reporting before
  **Alternative:** `security@stsoftware.com.au`. reviewer: met
- "The "no public issue" rule is stated." — step 1: "**Do not** file a public
  issue or pull request for a vulnerability." reviewer: met
- "The TOC link still lands on the section." — the heading
  `## 📢 Responsible Disclosure Policy` is unchanged, so `SECURITY.md:23`
  `#responsible-disclosure-policy` resolves. reviewer: met
- "markdownlint passes." — `./quality.sh` reports `markdownlint: PASSED`; the
  reviewer could not run the linter itself and marked it unverified.
  reviewer: partial

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- Clean: no violations; prose-only change in Australian English, minimal and
  in scope.
- Optional note (not a violation): the advisory URL hard-codes
  `stSoftwareAU/VibeCoder`; kept, because a relative link cannot reach the
  GitHub Security tab.

## Test Plan

- `./quality.sh < /dev/null` — `Result: PASSED (with skipped checks)`;
  markdownlint PASSED; only `config integration` skipped (no `.config.json` in
  the worktree).

Branch outcomes: none added
