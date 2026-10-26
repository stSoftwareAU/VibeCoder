# Notes

- Approval counts only because `gh` is signed in as a reviewer the repos'
  rulesets accept (`pr_reviewers` in the config). A fleet PR with auto-merge
  armed merges soon after approval, so the review is the last line of
  defence.
- PRs authored by the signed-in user are never candidates: GitHub does not
  let an author approve their own PR.
- Cost while idle: one GraphQL search (about 2 points) every 5 minutes, and
  no model tokens. Each PR that clears the skips before the claim check (not
  `in-flight`) adds one REST call to list its issue comments for that check
  (see [running-unattended.md](running-unattended.md#several-hosts)), including
  an `over-limit` or `claimed-elsewhere` PR. Each ready PR also adds a REST
  call for its file list and one for `review-checklists.json` at the base ref,
  plus one at the head SHA when the PR edits that file or its file list is
  unknown. A failed checklist fetch skips the PR for that pass. An
  `over-limit` PR adds only the comment call.
- `<logs>` is the Vibe Coder's own log directory: `.config.json` `log_dir`
  (the fleet sets `~/logs`), else the platform default. Everything this skill
  writes lives in `<logs>/review-fleet-prs/`, outside the checkout, which the
  worker resets. Each machine keeps its own; history from the old hidden
  `~/.review-fleet-prs` moves there on the first gate pass.
