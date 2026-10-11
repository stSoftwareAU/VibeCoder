# Guidance ledger

Step 3 turns recurring review findings into guidance issues. Guidance that
doesn't change behaviour only makes the instructions longer, so the loop
measures each piece of guidance it files and retires the pieces that don't
work (Issue #3539, part of #3396).

## The loop

1. **Track.** When step 3 files a guidance issue, the issue names one target
   pattern slug under `## Target pattern`, and the round records it:
   `guidance.ts track --issue=<n> --pattern=<slug>`.
2. **Hit.** When a later blocking finding matches a tracked pattern, the round
   records it: `guidance.ts hit --pattern=<slug> --pr=<owner/repo#n>`.
   Deciding that a finding matches is the model's judgement, made the same
   way step 3 already judges recurrence.
3. **Due.** Once per round, `guidance.ts due` prints one JSON line,
   `{"due": [...]}`, with one entry per tracked issue that hasn't been retired:
   - `pending`: the guidance issue is still open;
   - `dropped`: it closed as not planned;
   - `recurring`: it closed as completed at least 30 days ago
     (`--window-days`), and hits since the close come from at least two
     independent PRs (several hits on one PR count once);
   - `held`: anything else.
4. **Retire.** For each `recurring` entry the round searches first, files at
   most one issue proposing removal or a rewrite of that guidance (never an
   extension), and records it: `guidance.ts retire --issue=<n> --by=<new>`.
   A retired entry is never reported again. When a rule exists but was
   ignored, diagnosing why (#3425) suits the rewrite.

The window starts when the guidance issue closes as completed, which is when
the fix landed, not when it was filed.

## Where it lives

`<logs>/review-fleet-prs/guidance.jsonl`, next to `log.jsonl` (see
[notes.md](notes.md)). Like the rest of that directory it is per machine:
`SIMPLE-ON-PURPOSE` until the loop runs on more than one machine.

## Failures

A `gh` failure or a malformed ledger line makes `guidance.ts` exit non-zero
with the reason. It is never treated as "no recurrence". The round report
names a `due` failure, and it never changes a PR review outcome.
