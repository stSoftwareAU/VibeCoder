## Summary

The persisted-shape rule (#3328) was skipped in fleet PRs. In one, a planner's
sub-issue told the coder to make a newly served response field required. The
client read responses through a service-worker cache that outlives a deploy,
so a body cached by the previous release failed to parse. This PR makes the
client case explicit and closes the two gaps that let the plan win over the
standard. Closes #3564.

- `CODING-STANDARDS.md` and `prompts/coding_guidelines/prompt.md`, "Changing
  the Shape of Persisted Data": a new, identical paragraph, **A cached API
  response is persisted data.** Making a newly served field required, or
  renaming one, is a shape change. Unless the cache key is bumped, the client
  reads the old shape: a renamed field under its old name too, and a newly
  served field's absence as unknown (null), never as an error or a made-up
  default. An issue or plan that says a missing value throws does not override
  this. The scope sentence in `CODING-STANDARDS.md` now includes a client's
  cached copy of its own API's responses. The issue is also added to the
  section's "Past regressions".
- `prompts/planning/prompt.md`, "Planning Guidelines": **A sub-issue's spec
  never contradicts a coding standard.** When a sub-issue adds, renames or
  removes a field a client parses, the spec says which half of the rule
  applies: bump the cache key, or read the old shape tolerantly with a test
  that seeds an old-shape body. It never dictates "missing throws" for a field
  the previous release did not serve. The pre-finish checklist gains "no
  design detail that contradicts a coding standard".
- `prompts/issue/prompt.md`, "Project Guidelines": **A coding standard outranks
  an implementation detail in the issue.** When a line of the issue contradicts
  a standard, the run follows the standard. It records the deviation in the PR
  summary under `### Essential Design Decisions`, and in the criterion's
  `reason:` when the line is an acceptance criterion. That entry's status still
  follows **Do not inflate a status**.
- `docs/workflows/issue-processing.md`: an operator note for #3564 next to the
  #3328 one.

## Spec

### Intent and Rationale

- The rule was in force but was skipped for three reasons. The planner
  dictated the opposite. The coder treated the spec as outranking the
  standard. And an API response did not read as "persisted data". Each reason
  gets its own fix, at the place where it happened.
- The planning phase is core-layer and does not receive the code-only
  persisted-shape section, which the #3328 test pins. So the planning bullet
  states the client-cache case on its own instead of pointing at a section
  the planner cannot see.

### Essential Design Decisions

- The new paragraph is word for word the same on both twin surfaces. The new
  test asserts that, as the #3328 test does for the original paragraph.
- The issue-prompt rule does not change how criteria are scored. A deviation
  is recorded honestly, so a criterion that literally asked for "missing
  throws" stays `partial` with a reason, never an inflated `met`. A line that
  only chooses among designs the standards allow is followed.

### Undiscoverable Facts

- The two triggering PRs are in a private fleet repository, cited in the issue
  body only by date and description.

## Evidence

This change touches only prompts and docs, with no runtime code. The new
drift test pins every new sentence, and for the two prompts it also checks
that the sentence reaches the rendered prompt.

```mermaid
flowchart LR
    P[Planner writes sub-issue] -->|"Planning Guidelines: spec names key bump or old-shape read"| I[Issue run]
    I -->|"Project Guidelines: standard outranks contradicting spec line"| C[Client parser]
    C -->|"Persisted-data rule: cached body from previous release reads as null, not error"| OK[Views stay available after deploy]
```

Related existing rules checked: the #3328 paragraph and its extension-contract
carve-out in `CODING-STANDARDS.md` (the scope sentence is extended, not
contradicted). `prompts/pr_feedback/prompt.md:162` ("Project conventions …
always apply regardless of feedback") agrees. The issue prompt's "A component
the issue says to reuse is a stated requirement" does not conflict: reusing a
component breaches no standard. The issue prompt's **Do not inflate a status**
is referenced, not overridden. The planning prompt's existing "authoritative
for spelling, style, and standards" sentence is unchanged.

Applied the new rules to this PR's own diff. The PR adds no parsed field and
no cache, so the persisted-shape rule does not apply to it. No line of the
issue body contradicts a standard, so there is no deviation to record.

Every restatement gives the same answer to the edge case "a newly served
field missing from a cached body". The standards paragraph, the twin
guidelines paragraph, the planning bullet, the issue-prompt example and the
operator note all read it as unknown (null) unless the key is bumped, and
none reads it as an error.

Issue numbers cited as provenance: #3564: Persisted-shape rule (#3328) is
skipped when a plan dictates a strict parse; #3328: Worker changes the shape of
cached or stored data without bumping its versioned key, so entries from the
previous release break the new code.

**Docs sweep** — grep: "persisted data", "old shape", "service-worker cache", "Project Guidelines", "Planning Guidelines"; section: `CODING-STANDARDS.md#changing-the-shape-of-persisted-data`; siblings: none — no existing set gained a member; updated: `CODING-STANDARDS.md`, `prompts/coding_guidelines/prompt.md`, `prompts/planning/prompt.md`, `prompts/issue/prompt.md`, `docs/workflows/issue-processing.md`; `docs/PROMPT-HOUSE-VOCABULARY.md:105` — still true because `### Planning Guidelines` remains guidance on how to plan; `docs/workflows/issue-processing.md:1607` — still true because the #3328 rule itself is unchanged

## Test Plan

- Added `worker/deno/tests/persisted_shape_client_cache_3564_test.ts` (4
  tests). It checks the identical client-cache paragraph on both twin surfaces
  (nine pins), the scope sentence in `CODING-STANDARDS.md`, the planning bullet
  and checklist clause (five pins, plus the rendered planning prompt), and the
  issue-prompt rule (four pins, plus the rendered issue prompt). Result on the
  head: `ok | 4 passed | 0 failed`.
- Per-pin red check: `deno task drift-pins-on-base
  origin/milestone/fleet-guidance-tests-twins-and-portability <doc> <section>
  <phrase>...` reported every pinned phrase "absent on base". That covers
  "Changing the Shape of Persisted Data" in both `CODING-STANDARDS.md` and
  `prompts/coding_guidelines/prompt.md`, "Planning Guidelines" in
  `prompts/planning/prompt.md`, and "Project Guidelines" in
  `prompts/issue/prompt.md`.
- Existing tests re-run on the head, all passing:
  `worker/deno/tests/persisted_shape_version_3328_test.ts`,
  `worker/deno/tests/coding_guidelines_twin_drift_test.ts`,
  `worker/deno/tests/coding_guidelines_layers_2574_test.ts` (24 passed); the
  planning-prompt tests (38 passed); the 19 issue-prompt tests that read
  Project Guidelines, Escape Hatch or a prompt size (189 passed).
- No existing test edited; no assertion removed.
- `./quality.sh < /dev/null` on commit `02fd40a4`: `Result: PASSED (with
  skipped checks)`. Deno tests, lint, type check, fmt, markdownlint, mermaid
  and semgrep all passed, and only "config integration" was skipped.

<!-- vibe-branch-outcomes -->
