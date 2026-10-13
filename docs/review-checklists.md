# Repository review checklists

A repository can own a short, path-scoped list of things every change to part of
it must satisfy, and have both the fleet PR reviewer and the worker's pre-PR
verifier hold each PR to it (Issue #3594). It is for rules a generic reviewer
cannot know: "money figures are never `f64`", "a release change bumps the
changelog".

## Where it lives

`review-checklists.json` at the root of the target repository.

It is read at the **base ref** of the change, never the head:

- the pre-PR verifier runs `git show <baseSha>:review-checklists.json`;
- the fleet reviewer fetches it through the GitHub contents API at the PR's base
  branch.

A PR therefore cannot weaken its own checklist. A PR that edits
`review-checklists.json` is judged against the base version; the edit takes
effect once it merges.

## Format

```json
{
  "checklists": [
    {
      "name": "Money figures",
      "paths": ["src/money/**", "**/*price*.rs"],
      "items": [
        "Every money figure uses integer cents or Decimal, never f64",
        "Rounding happens once, at the boundary, and a test pins the mode"
      ]
    },
    {
      "name": "Release",
      "paths": ["Cargo.toml", "CHANGELOG.md", ".github/workflows/release*.yml"],
      "items": [
        "The version in Cargo.toml was bumped and matches the CHANGELOG heading",
        "The CHANGELOG entry says what changed for a user, not what files moved"
      ]
    }
  ]
}
```

Each checklist needs a non-empty `name`, a non-empty `paths` array of globs and
a non-empty `items` array of strings. A glob that can never match is rejected
too: after a leading `./` is dropped, it must not start with `/`, contain `//`,
end with `/` or have a `..` segment. Anything else is a schema error (see
[Failure behaviour](#failure-behaviour)).

## How it is applied

```mermaid
flowchart LR
    L["Load review-checklists.json<br/>at the base ref"] --> M["Match each checklist's<br/>paths against the changed files"]
    M -->|"at least one file matches"| R["Add the checklist to the brief<br/>as {{REVIEW_CHECKLISTS}}"]
    M -->|"no file matches"| N["No section for that checklist"]
    R --> V["Reviewer reports every item in the<br/>checklist array: met / missing / not applicable"]
    V -->|"any item missing"| B["Blocking finding:<br/>changes_requested"]
    style L fill:#7aa8d4,stroke:#1d3f5a,color:#1a1a1a
    style B fill:#c45858,stroke:#6b2020,color:#fff
    style N fill:#adb5bd,stroke:#6c757d,color:#000
```

For every checklist with at least one changed file matching one of its `paths`,
the reviewer reports **every** item in a `checklist` array of its reply JSON as
`met`, `missing` or `not applicable`, each with a note, the same way it reports
acceptance criteria. A `missing` item is also a blocking finding, so the outcome
is `changes_requested`. A diff touching no listed path gets no checklist section
at all.

## Glob rules

| Rule         | Behaviour                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `**`         | Crosses `/`. `**/` also matches zero directories, so `**/*price*.rs` matches `price.rs` at the root                                                     |
| `*`          | Matches any run of characters except `/`                                                                                                                |
| `?`          | Matches exactly one character that is not `/`                                                                                                           |
| Case         | Case-sensitive                                                                                                                                          |
| Leading `./` | Stripped from the path and the glob before matching                                                                                                     |
| Unsafe paths | A changed path with a `..` segment, an empty segment (`//` or a trailing `/`), or a leading `/` never matches; such a glob in `paths` is a schema error |

## Failure behaviour

Apart from the two quiet rows, every failure renders a BLOCKING instruction into
the brief in place of the checklist, telling the reviewer to report a blocking
finding on `review-checklists.json`. The code does not add that finding itself:
neither reviewer checks the load state, so the finding appears in the review
output only when the model follows the instruction.

| Situation                                          | Result                                                   |
| -------------------------------------------------- | -------------------------------------------------------- |
| File absent (not found at the base ref)            | Nothing happens; no checklist section                    |
| Present, but no changed file matches any checklist | Nothing happens; no checklist section                    |
| Malformed JSON or invalid schema                   | BLOCKING instruction naming the problem                  |
| Unreadable (any fetch error other than not-found)  | BLOCKING instruction                                     |
| Changed-file list unavailable or truncated         | BLOCKING instruction, because matching cannot be trusted |

## Who consumes it

Both consumers share one loader,
[`worker/deno/lib/review_checklists.ts`](../worker/deno/lib/review_checklists.ts)
(parse, glob match, render the section, parse the verdict), and one brief,
[`prompts/pr_review_brief/prompt.md`](../prompts/pr_review_brief/prompt.md),
which takes the rendered section as its fifth field, `{{REVIEW_CHECKLISTS}}`.

- **Pre-PR verifier**
  ([`worker/deno/lib/pre_pr_verifier.ts`](../worker/deno/lib/pre_pr_verifier.ts);
  see
  [issue-processing.md](workflows/issue-processing.md#pre-pr-verifier-issue-3395)).
  A `missing` verdict blocks the PR even when the reply has no matching finding
  (`prePrVerifierBlocked`), and is listed in the block reason and in the gate
  comment that reaches the in-run recovery turn. A reply with no `checklist`
  array is read as `[]`. A checklist load failure blocks only through the
  finding the brief tells the model to report.
- **Fleet reviewer** (the `review-fleet-prs` skill under
  `.claude/skills/review-fleet-prs/`). The review comment gains a "Repository
  review checklists" section listing each item with its verdict, on approved
  reviews too. A `missing` item makes the outcome `changes_requested`.

## Testing

Tests live in `worker/deno/tests/`. Run the checklist tests (named for issue
3594) and the shared-brief test with stdin closed:

```sh
deno test --allow-all worker/deno/tests/*checklists_3594_test.ts \
  worker/deno/tests/pr_review_brief_shared_3395_test.ts \
  worker/deno/tests/pre_pr_verifier_3395_test.ts < /dev/null
```

To try a checklist by hand, put a `review-checklists.json` on a repository's
default branch, open a PR touching a matching path, and confirm the section
appears; then open one touching no listed path and confirm it does not.
