# 🔎 Security sweep — `worker/deno/lib/` delta, slices 12d–12f

**Issue:** [#2757](https://github.com/stSoftwareAU/VibeCoder/issues/2757) ·
**Parent:** #2722 (chunk 8 — lib closing-pass delta)

This is the written record for the modules in ledger slices 12d (#1217
environment / configuration / secret sinks), 12e (#1219 closing pass) and 12f
(#1325 gh-chokepoint top-up) that were added or modified since the
[#2183 record](security-sweep-2183-lib-delta-12d-12f.md) set their `sweptAt` to
`9395461966809ac1a5c7223dcf80b4e7cc1c324f`. The file list was regenerated with
`sweep-drift`, not taken from the "94 of 441" count in #2722. That count was
measured when the issue was filed, and the list has grown since.

Siblings:
[`security-sweep-2183-lib-delta-12d-12f.md`](security-sweep-2183-lib-delta-12d-12f.md)
(the record this delta is measured from) and
[`security-sweep-2755-lib-delta-12a-12c.md`](security-sweep-2755-lib-delta-12a-12c.md)
(the 12a–12c half of the same milestone).

<!-- SUMMARY -->

## Scope and method

```bash
git fetch origin main
deno run -A worker/deno/mod.ts sweep-drift
```

The command was run at `8d6e82ff` on the
`milestone/2722-docs-audits-lib-sweep-cover-security-sweep-le` branch.
`git merge-base origin/main HEAD` was `3a38b85a`. Between that commit and the
generation head exactly one `worker/deno/lib/` file changed:
`lib_sweep_coverage.ts`, which gained the #2754 `sweptAt` ancestry guard on the
milestone branch. It is in the 12e list below and its milestone hunk was read.

For a _modified_ module the hunks were read
(`git diff 9395461966809ac1a5c7223dcf80b4e7cc1c324f HEAD -- <path>`), and the
reading followed into the module wherever a hunk touched a sink. For an _added_
module the file was read in full. A ledger claim is not a sweep record. The read
was split across five parallel reviewers, balanced by diff size (about 13,000
changed lines in all). Each surviving candidate was then re-verified in code
before it was filed.

12d's sinks are environment reads and writes, configuration parsing and trust
decisions taken from config, and secret handling. 12e is the closing pass, so
**any newly introduced sink of the four slice classes counts**: subprocess and
argv, filesystem and temp files, untrusted GitHub ingestion, and
environment/config/secret.

**Nothing was skipped.** Every module `sweep-drift` reported for 12d–12f has a
triage line below, so none is listed as skipped with a citation.

Triage followed [`docs/SECURITY-SCAN.md`](../SECURITY-SCAN.md) Phase 3
(refute-unless-proven). A candidate only survives when a concrete
attacker-controlled input reaches a sink unsafely.

<!-- FINDINGS -->

## Slice 12d — environment, configuration and secret sinks

Previous `sweptAt`: `9395461966809ac1a5c7223dcf80b4e7cc1c324f` (the
[#2183 record](security-sweep-2183-lib-delta-12d-12f.md)). Drift at generation
HEAD: **2 added, 12 modified, 0 unowned**.

### Idle-task templates this slice owns

12d owns sixteen idle-task templates under
`worker/deno/lib/idle_task_templates/`. Only
`github_actions_audit_template.ts` is in this drift list, and its hunks were
read (below). The other fifteen have not changed since the #2183 record, which
still covers them.

<!-- 12D -->

## Slice 12e — closing pass over the remainder

Previous `sweptAt`: `9395461966809ac1a5c7223dcf80b4e7cc1c324f` (the #2183
record). Drift at generation HEAD: **3 added, 99 modified, 0 unowned**.

<!-- 12E -->

## Slice 12f — gh-chokepoint top-up

Previous `sweptAt`: `9395461966809ac1a5c7223dcf80b4e7cc1c324f` (the #2183
record). Drift at generation HEAD: **0 added, 0 modified, 0 unowned**.

**12f is nil, and the nil is real rather than an empty report.** The slice owns
exactly two modules, `worker/deno/lib/gh_body_file_io.ts` and
`worker/deno/lib/gh_timeout.ts`, and

```bash
git log --oneline 9395461966809ac1a5c7223dcf80b4e7cc1c324f..HEAD -- \
  worker/deno/lib/gh_body_file_io.ts worker/deno/lib/gh_timeout.ts
```

returns no commits: neither module has been touched since the #2183 record. The
[#1325 record](security-sweep-1325-gh-body-file-io-and-timeout.md) and the
earlier deltas still cover them, and nothing was re-read here.

<!-- REFUTATIONS -->

## Coverage ledger

Slices 12d, 12e and 12f now point at this file and carry
`sweptAt: 3a38b85a9de2531456c3e56784535903bf045ffa`. That is
`git merge-base origin/main HEAD` at list-generation time, following the rule in
`docs/SECURITY-SCAN.md` (#2178, #2754). It is not a branch commit, so the
`sweptAt` ancestry guard (`verifySweptAtsOnDefaultBranch`) accepts it while this
PR is open.

At the PR head, `sweep-drift` reports no drift for 12d and 12f. 12e reports
exactly one modified module, `worker/deno/lib/lib_sweep_coverage.ts`. That is
the #2754 ancestry guard, which is on the milestone branch but not yet on
`main`. So it lies between the merge-base `sweptAt` and HEAD, and no
default-branch commit can cover it: a branch commit would fail the ancestry
guard. The #2183 record left the same residue for the same reason. The hunk is
in the 12e table above and was read. The residue clears when the milestone
lands on `main` and the next record's merge-base moves past it. No module is
left unaccounted for.
