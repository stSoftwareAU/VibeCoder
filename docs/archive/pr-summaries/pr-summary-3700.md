## Summary

Retain agent transcript evidence for 30 days with a separate 2,000-file ceiling,
scan it on the first idle opportunity every six hours, and report scrubbed
operator findings. Add an agent-incident runbook for detection, containment,
evidence preservation, credential rotation, recovery and disclosure.

Closes #3700. Closes #3702 after the required human runbook review.
The companion turn-limit change and its branch evidence are recorded in
[pr-summary-3701.md](pr-summary-3701.md).

## Spec

### Intent and Rationale

- Preserve evidence long enough to investigate an agent incident and surface
  likely egress, credential-file access and permission violations locally.
- Keep the existing worker-log retention independent from transcript evidence.

### Essential Design Decisions

- The explicit transcript cap can shorten the age window and logs when it does.
  Tiny transcripts and compressed/numbered rotations remain eligible evidence.
- Scan actual Claude/DeepSeek, Codex and Gemini tool records. Findings contain
  file, line, signal and count; commands, URLs and credential contents stay local.
- Persist schedule and changed-file fingerprints across restarts. Malformed,
  unreadable and oversized files remain retryable, with incomplete coverage
  reported to the operator. Bound decompressed input at 100 MiB per file.
- Run through production idle hooks before GitHub quota gates. Capture remains
  opt-in, and the scanner is a heuristic signal rather than an isolation boundary.

### Undiscoverable Facts

- The runbook preserves stopped Apple named volumes untouched when a supported
  host-level backup has not been confirmed; filesystem export is not assumed to
  include mounted volume evidence.
- Issue #3702 explicitly requires a human to review the finished section before
  merge. That acceptance criterion remains open; technical peer review does not
  replace it.

## Evidence

[Validation record](../../evidence/milestone121-validation.md) includes local
checks, mutation evidence, CLI limitations and exact acceptance mapping.
There is no UI change, so screenshots would not demonstrate the behaviour.

Docs sweep — grep: "3-day retention", "200-file cap", "agent-incident runbook";
updated SECURITY.md and docs/CONFIGURATION.md; section: Agent transcripts,
Scheduled security scan, Agent-incident runbook; siblings: "claude_timeout"
operational limits were checked alongside the new limit. The validation record
lists retained historical gap-analysis hits and unchanged timeout references.

## Test Plan

- Cleanup tests retain 30-day tiny/rotated/compressed evidence, remove expired
  evidence and independently enforce/report the transcript cap.
- Scanner tests cover seeded/clean fixtures, native provider schemas, malformed
  events, compression, input bounds, symlinks/directories, cursor retries,
  restart scheduling, backwards clocks and concurrent hook calls.
- Production dependency and idle-loop tests prove the scheduled scan is wired
  and missing home-directory configuration is diagnosed.
- Targeted operand/guard mutations are recorded below. Portable filesystem
  limitations are named explicitly, without claiming those probes passed.
- Complete-gate status belongs to the immutable-head validation check; no
  completed local full-gate result is claimed in this archive.

<!-- vibe-branch-outcomes -->

## Acceptance Criteria

| Issue | Criterion | Evidence and status |
| --- | --- | --- |
| #3700 | Default retention at least 30 days; cleanup unit test | Implemented; agent_transcript_retention_3700_test.ts |
| #3700 | Seeded signal flagged and clean transcript passes | Implemented; agent_transcript_scan_3700_test.ts and actual idle-loop wiring test |
| #3702 | Detection, stop/rotate/preserve, recovery/disclosure and R9/R11 links | Implemented in SECURITY.md Agent-incident runbook; links checked against local documentation |
| #3702 | Human reviews finished section before merge | **Awaiting human review. Merge and auto-merge remain held.** |
