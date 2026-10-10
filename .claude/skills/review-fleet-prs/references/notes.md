# Notes

- Approval counts only because `gh` is signed in as a reviewer the repos'
  rulesets accept (`pr_reviewers` in the config). A fleet PR with auto-merge
  armed merges soon after approval, so the review is the last line of
  defence.
- PRs authored by the signed-in user are never candidates: GitHub does not
  let an author approve their own PR.
- Cost while idle: one GraphQL search (about 2 points) every 5 minutes, and
  no model tokens. Each ready PR adds one REST call for its file list; an
  `over-limit` PR adds none.
- `<logs>` is the Vibe Coder's own log directory: `.config.json` `log_dir`
  (the fleet sets `~/logs`), else the platform default. Everything this skill
  writes lives in `<logs>/review-fleet-prs/`, outside the checkout, which the
  worker resets. Each machine keeps its own; history from the old hidden
  `~/.review-fleet-prs` moves there on the first gate pass.
