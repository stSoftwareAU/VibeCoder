# SIMPLE-ON-PURPOSE debt ledger

This idle-task lists every `// SIMPLE-ON-PURPOSE:` marker in the repository.
A native scanner does the work. No model turn is involved, and nothing in
this body is work for a person or an agent to carry out. The scanner posts
one report, or refreshes the open report when one already exists. It makes
no commit and opens no pull request. Nothing is installed and nothing is
fetched while the scan runs.

## What the scanner records

Each marker is listed with its path and line, the ceiling named before
`upgrade when`, and the upgrade condition that follows. A marker with no
`upgrade when` clause is flagged. A marker that names neither a ceiling nor
an upgrade condition is flagged as malformed. A file that cannot be read, or
a directory that cannot be listed, fails the run out loud. An empty
repository still refreshes the report, so a cleared marker does not linger
as if it were still in the tree.

## What this issue is not

Picking up this issue does not edit the repository. The deliverable is the
ledger issue the scanner posts. Each repository is reported on its own.

---

{{ATTRIBUTION_FOOTER}}
