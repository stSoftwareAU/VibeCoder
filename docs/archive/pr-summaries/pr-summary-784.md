# One hidden-file allowlist, stated in three places

## Summary

The same named artefact — "the only hidden paths that may ever be
staged/tracked" — had three memberships:

| Surface | Entries |
| --- | --- |
| `gitignore_enforcer.ts` `REQUIRED_GITIGNORE_PATTERNS` | **5** — `.gitignore`, `.github`, `.vscode`, `.markdownlint-cli2.jsonc`, `.gitattributes` |
| `CODING-STANDARDS.md` | 4 — no `.vscode/` |
| `prompts/coding_guidelines/` | 3 — no `.vscode/`, no `.gitattributes` |

The enforcer is what actually writes every monitored repository's
`.gitignore`, so `.gitattributes` was written in as tracked-and-allowed while
the injected block told the agent — under "Everything below is **always
forbidden**: … any other hidden file not on the allowlist above" — that staging
it was forbidden. `.vscode/` was re-allowed by the enforcer and named in
neither document.

Both documents now restate the enforcer's five entries, and say that they are
restatements of it. The enforcer itself is untouched: dropping a re-allow would
change behaviour in every monitored repository.

The guidelines also gain the private-key class the standards already carried
(`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_rsa.*`, `credentials.json`,
`service-account*.json`). None of those begins with a dot, so the hidden-file
rule never covered them, and an agent running on the injected block alone had
no rule against staging a `.pem`.

Closes #784.

## Evidence

Documentation and prompt change with no runtime surface to screenshot. The
evidence is the drift test, which reads the membership out of the enforcer at
run time.

```mermaid
flowchart TD
    E["gitignore_enforcer.ts<br/>REQUIRED_GITIGNORE_PATTERNS"] --> W["writes each repo's .gitignore"]
    E ==> S["CODING-STANDARDS.md"]
    E ==> G["coding_guidelines v45"]
    S -.->|"before: 4 entries"| D["`.gitattributes` allowed by the enforcer,<br/>forbidden by the block"]
    G -.->|"before: 3 entries"| D
    style D fill:#9d0208,stroke:#6a040f,color:#fff
    style E fill:#b892c8,stroke:#4a2d5a,color:#1a1a1a
```

Red before, green after:

```
# unfixed
hidden allowlist - the guidelines state every entry the enforcer re-allows ... FAILED
  → coding_guidelines v44 omits `.vscode`, which the enforcer re-allows
hidden allowlist - CODING-STANDARDS states every entry the enforcer re-allows ... FAILED
hidden allowlist - both surfaces state the private-key class ... FAILED
hidden allowlist - both surfaces name the enforcer as the source ... FAILED
FAILED | 2 passed | 4 failed

# fixed
ok | 6 passed | 0 failed
```

```
ok | 49 passed | 0 failed   # the drift suite plus the enforcer, hidden-files
                            # integration and four prompt-drift suites
```

`deno fmt --check` (2025 files), `deno lint` (2019 files), `deno check` over
every file in `worker/deno/tests` (0 errors), markdownlint and the
`docs prompt versions` quality check all pass.

## Reproduction

- **symptom** — the enforcer writes `!.gitattributes` and `!.vscode` into a
  repository's `.gitignore` as tracked-and-allowed, while the injected
  guidelines tell the agent that any hidden file not on their three-entry
  allowlist is always forbidden — and neither document mentions `.vscode/`
- **status** — `verified` — the drift test reads
  `REQUIRED_GITIGNORE_PATTERNS` and was watched failing on four of six cases,
  naming `.vscode` as the missing entry in both documents
- **regression test** —
  `worker/deno/tests/hidden_allowlist_drift_test.ts::hidden allowlist - the guidelines state every entry the enforcer re-allows (Issue #784)`

## Acceptance Criteria

The issue states its scope in the grill-me understanding block; each accepted
item is closed out here. Judged in an operator review of the whole diff, not by
reviewer sub-agents.

- **met** — both documents align to the enforcer's five re-allowed entries,
  entry-for-entry; the enforcer file is not modified — evidence:
  `prompts/coding_guidelines/v45.md`, `CODING-STANDARDS.md`, and the two
  "states every entry the enforcer re-allows" cases, which derive the expected
  set from `REQUIRED_GITIGNORE_PATTERNS` rather than restating it
- **met** — the guidelines fix lands as a new immutable version;
  `CODING-STANDARDS.md` is edited in place — evidence: v44 → v45, with
  `::the retired guidelines version stays immutable (Issue #784)`
- **met** — the new guidelines version gains the private-key/credential class
  matching `CODING-STANDARDS.md` — evidence:
  `::both surfaces state the private-key class (Issue #784)`, which also
  asserts the enforcer really ignores each pattern, so the documents cannot
  forbid something the tooling permits
- **met** — a Deno test asserts every re-allow entry is stated in both
  documents and fails if any surface drifts — evidence: the six cases; the
  membership is read at run time, so a **sixth** re-allow fails the test until
  both documents name it
- **met** — `.vscode` stays in the enforcer and is added to both documents —
  evidence: the five-entry pin in
  `::the enforcer re-allows exactly the five documented entries (Issue #784)`
- **partial** — "per #792, the new file's H1 must declare its own version
  number" — evidence: `coding_guidelines` has no H1 at all; it opens with prose
  — reason: there is no H1 version declaration to keep in step here, the same
  finding as #781 and #782. Adding one is #792's sweep

- **unrequested** — both surfaces now *name* `REQUIRED_GITIGNORE_PATTERNS` as
  the source, and a test asserts they do — reason: the lists are restatements,
  and this defect happened because each read as a definition. Saying so is what
  stops the next editor changing one list on its own; without it the alignment
  is a snapshot rather than a rule
- **unrequested** — `::the enforcer re-allows exactly the five documented
  entries` pins the enforcer's own membership — reason: the other cases derive
  from it, so without this an entry silently *removed* from the enforcer would
  leave both documents over-permissive and every case still green

## Standards Review

- **clean** — prompt immutability honoured: one new version, nothing edited, and
  a case asserts v44 still reads as it did; Australian English throughout; the
  enforcer stays the single source and both documents defer to it by name
- **clean** — the test derives the expectation from the code rather than
  restating the list a fourth time, which is the failure this issue is about
- **violation** — the `.vscode/` entry is documented as allowlisted although no
  repository in the fleet tracks one — evidence:
  `prompts/coding_guidelines/v45.md`, `CODING-STANDARDS.md` — reason: stands.
  The enforcer re-allows it in every repository it touches, so the documents
  would be wrong to omit it; removing the re-allow is a behaviour change the
  issue explicitly rules out
- **violation** — the document assertions match backticked fragments, which
  reformatting could break — reason: stands. Both files are prose; the
  assertions collapse whitespace first so wrapping cannot hide a term, and each
  failure names the missing entry

## Test Plan

Added `worker/deno/tests/hidden_allowlist_drift_test.ts` (6 tests):

- `hidden allowlist - the enforcer re-allows exactly the five documented entries (Issue #784)`
- `hidden allowlist - the guidelines state every entry the enforcer re-allows (Issue #784)`
- `hidden allowlist - CODING-STANDARDS states every entry the enforcer re-allows (Issue #784)`
- `hidden allowlist - both surfaces state the private-key class (Issue #784)`
- `hidden allowlist - both surfaces name the enforcer as the source (Issue #784)`
- `hidden allowlist - the retired guidelines version stays immutable (Issue #784)`

No existing test was modified.
