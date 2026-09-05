# Bucket: `design`

Canonical guides — link, do not restate:

- Martin Fowler, _Refactoring_ (2nd ed.), ch. 3 "Bad Smells in Code" —
  <https://martinfowler.com/books/refactoring.html>
- Refactoring catalogue (smells and their named refactorings) —
  <https://refactoring.guru/refactoring/smells>
- Fowler on code smells — <https://martinfowler.com/bliki/CodeSmell.html>

This bucket reviews **design quality in any language**: the shape of the
code — naming, coupling, cohesion, delegation — rather than a language's
own idioms. It is the only bucket that scores design without naming a
language, so it runs on a repo in a language no bucket covers exactly as
it runs on one that has a bucket. Language idioms belong to that
language's bucket
(`rust`, `typescript`, `react`, `java`, `html`, `aws-cloudformation`,
`terraform`); repo-level hygiene — README, licence, CI presence,
dependency tooling — belongs to `general`.

## Two rules bind every check below

These matter more than the list of smells:

- **The repo overrides the baseline.** A convention the repository
  documents in its own `README.md`, `CONTRIBUTING.md`, `AGENTS.md`,
  `CLAUDE.md` or `docs/` always wins. Where a documented standard
  endorses the very shape a smell would flag — a deliberate façade, a
  primitive-typed public API, a switch the team keeps flat on purpose —
  the smell is **suppressed**: drop the candidate and move on. Name the
  overriding document in your notes. This baseline applies precisely
  because a repo may document no design standards of its own.
- **Every smell is a judgement call, never a violation.** A smell is a
  labelled heuristic — a hint that something _may_ be worth a second
  look, not a rule breach. Title and phrase every finding that way
  ("Possible Feature Envy in …"), state the trade-off in the body, and
  say plainly that the maintainer may reasonably disagree: the verdict
  stays theirs.

Two further limits keep the bucket honest:

- **Skip what tooling already enforces.** Where a linter, formatter,
  type checker or compiler in this repo's CI already catches the shape,
  leave it to that tool.
- **Read before you name a smell.** Every finding cites a concrete
  `file:line` range, read in context — reading first is what keeps this
  bucket from over-reporting.

## Checks

Each check is _what it is_ → _how to fix it_. Match against the code you
actually read.

1. **Mysterious name.** A function, variable, type or file whose name
   does not say what it holds or does — `data`, `tmp2`, `handle()`,
   `Manager` — so a reader must read the body to learn the intent.
   _Fix:_ rename it after what it means to the caller (Rename
   Variable / Rename Function), and delete the comment the name made
   necessary.
2. **Duplicated code.** The same logic appears in two or more places,
   so a change must be made in each. _Fix:_ extract the shared logic
   into one function, or pull it up to a common owner. **Overlap rule
   below applies** — the `duplicated_knowledge` scan owns this shape;
   file it here only when that scan cannot see it.
3. **Feature envy.** A function is more interested in another module's
   data than its own — it reaches across to read or mutate several
   fields of a neighbour to compute its answer. _Fix:_ move the
   function (or the envious part of it) to the module that owns the
   data, so the data and the behaviour travel together.
4. **Data clumps.** The same group of values travels together through
   parameter lists, records or return shapes — `host`, `port`,
   `timeout` passed side by side everywhere. _Fix:_ introduce a single
   named type or record for the clump, then let it carry the behaviour
   that operates on it.
5. **Primitive obsession.** Domain concepts are represented by bare
   primitives — an account id as a raw string, a currency as a float,
   a duration as an int — so invalid values are indistinguishable from
   valid ones. _Fix:_ introduce a small type for the concept and
   validate at its boundary, so the rest of the code cannot hold an
   invalid value.
6. **Repeated switches.** The same `switch` / `if-else` / `case` on the
   same tag is repeated in several places, so adding a variant means
   editing all of them. _Fix:_ replace the conditional with polymorphic
   dispatch, a lookup table, or one exhaustive decision function every
   caller shares.
7. **Shotgun surgery.** One conceptual change forces small edits across
   many files — adding a field means touching a parser, a validator, a
   serialiser and three callers. _Fix:_ move the scattered pieces
   together so the change has one home; cite the files a recent change
   of this shape actually touched.
8. **Divergent change.** The mirror image: one module is edited for
   several unrelated reasons — a file that changes both when the
   database schema changes and when the report format changes. _Fix:_
   split it along those axes so each part has one reason to change.
9. **Speculative generality.** Machinery built for a future that has
   not arrived — an abstraction with exactly one implementation, a
   parameter every caller passes the same value for, a hook nothing
   uses. _Fix:_ inline it and delete the unused seam; reintroduce it
   when the second case genuinely appears. **Overlap rule below
   applies** — code with no caller at all belongs to the `dead_code`
   scan, not here.
10. **Message chains.** A caller navigates a long chain to reach what
    it wants — `a.getB().getC().getD().value` — so it is coupled to
    every hop's structure. _Fix:_ ask the first object for the answer
    directly (hide the delegate), or pass the endpoint in.
11. **Middle man.** A module delegates nearly everything it is asked to
    do to another, adding no behaviour of its own. _Fix:_ let callers
    talk to the real collaborator and remove the pass-through, unless
    the indirection is a documented boundary (an anti-corruption layer,
    a published API façade, a test seam) — in which case it is not a
    finding.
12. **Refused bequest.** A subtype inherits an interface it does not
    want — it overrides inherited behaviour to throw, no-op, or reject
    it, so callers of the supertype cannot rely on the contract.
    _Fix:_ replace the inheritance with delegation, or narrow the
    supertype to what every subtype genuinely honours.

### Which checks apply to which repos

Checks 11 and 12 (and the polymorphic-dispatch fix in check 6) are
object-oriented in origin. Apply them only where the repository
**actually uses** the construct: a class or trait hierarchy for refused
bequest, an object or module whose declared purpose is delegation for
middle man. On a procedural or declarative repo — Bash, Terraform,
CloudFormation, plain C — these two stay **silent**: a wrapper script or
a module of thin functions sits outside their reach. Checks 1–10 are
structural and apply to every language.

## Reporting rules

The named smells invite over-reporting: on a real codebase "possible
Feature Envy" can be argued almost anywhere, and a scan the fleet learns
to ignore is worse than no scan. These rules are as binding as the
checks.

- **Cap this bucket at three findings per run.** Tighter than the
  orchestrator's cap of six. Keep the three strongest — the ones with
  the clearest evidence and the most concrete fix — and silently drop
  the rest. Three is a ceiling, not a quota to fill.
- **Severity floor `low`, ceiling `medium`.** A design smell is a
  maintainability judgement, not a defect: never file `severity:high`
  from this bucket. Use `medium` only when the smell already costs the
  team something you can point at (a change that touched nine files, a
  switch repeated five times); otherwise `low`.
- **Phrase the title as a judgement.** "Possible Feature Envy:
  `report.rs:88` reads five fields of `Invoice`" — not "Feature Envy
  violation".
- **One finding per root cause.** When the same smell appears at several
  sites for one reason, file one finding that lists the sites.
- **No smell without a fix.** A finding names the concrete refactoring
  and the site it applies to. "Improve the design of the parser" is not
  a finding.

### Overlap with the sibling scans — one owner per shape

`duplicated_knowledge` and `dead_code` are separate idle-task scans with
their own prompts and their own issues. A finding that arrives twice
under two names costs two triage cycles and teaches the fleet that both
scans are noisy.

- **Duplicated code (check 2).** The `duplicated_knowledge` scan owns
  duplicated logic, prose and configuration. File check 2 here **only**
  when the duplication is the evidence for a structural fix that scan
  does not propose (e.g. the copies differ enough that the real fix is
  extracting a shared type). Otherwise drop it, or cite it as supporting
  evidence inside another smell's body rather than as its own finding.
- **Speculative generality (check 9).** The `dead_code` scan owns
  unreferenced code — an abstraction with **no** caller is its finding,
  not ours. File check 9 here only for the over-general shape that _is_
  used: one implementation, one caller, a seam built for a hypothetical
  second case.
- **Check the open-issue list first.** Before filing either check,
  compare the candidate against the open issues the orchestrator
  supplied. An open issue describing the same sites — whichever scan
  filed it — means drop the candidate silently.
- **When in doubt, drop it.** A missed design smell costs nothing; a
  duplicate costs a human triage cycle and the fleet's trust in the
  scan.
