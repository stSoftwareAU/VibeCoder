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

- **met** — Both private routes are named, PVR first — evidence:
  `SECURITY.md:2029` (**Preferred:** GitHub private vulnerability reporting,
  linking `security/advisories/new`) before `SECURITY.md:2032`
  (**Alternative:** `security@stsoftware.com.au`) — reviewer: met
- **met** — The "no public issue" rule is stated — evidence: `SECURITY.md:2023`
  "**Do not** file a public issue or pull request for a vulnerability." —
  reviewer: met
- **met** — The TOC link still lands on the section — evidence:
  `SECURITY.md:2017` heading `## 📢 Responsible Disclosure Policy` unchanged;
  `SECURITY.md:23` `#responsible-disclosure-policy` resolves — reviewer: met
- **met** — markdownlint passes — evidence: `markdownlint-cli2 SECURITY.md`
  with the repo's `.markdownlint-cli2.jsonc` reports 0 issues; `./quality.sh`
  reports `markdownlint: PASSED` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, KISS/minimal scope, DRY (no other non-archive
  doc repeats the old wording; `docs/THREAT-MODEL.md:357` anchor still
  resolves), link correctness (`SECURITY.md:2029` matches the `origin` remote,
  well-formed `mailto:`), and markdown list indentation and wrapping. Optional
  non-blocking note: unchanged item 3 (`SECURITY.md:2039`) has no closing full
  stop; left as is, because the issue rules out other changes.

## Test Plan

- `./quality.sh < /dev/null` — `Result: PASSED (with skipped checks)`;
  markdownlint PASSED; only `config integration` skipped (no `.config.json` in
  the worktree).

Branch outcomes: none added
