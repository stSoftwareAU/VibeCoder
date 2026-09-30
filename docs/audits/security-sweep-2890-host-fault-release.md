# Security sweep — the host-fault failure-label release

**Issue:** [#2890](https://github.com/stSoftwareAU/VibeCoder/issues/2890) (chunk
top-up-2890) · **Parent:** #1209

This is the written record for the three modules that entered `worker/deno/lib/`
under #2890:

- `worker/deno/lib/host_fault.ts`
- `worker/deno/lib/host_fault_release.ts`
- `worker/deno/lib/issue_sweep_parse.ts`

## `worker/deno/lib/host_fault.ts`

Classifies a raw failure message into a narrow, fixed set of host/
infrastructure fault kinds (`clone-corrupt`, `clone-failed`, `disk-full`,
`container-build-failed`) and builds/parses the machine-readable marker appended
to a failure comment. Detection is deliberately conservative: an ambiguous
message returns `null` rather than being guessed at, and the clone-failed
pattern is explicitly excluded whenever the message also matches an
auth/permission/not-found wording, so a genuinely misconfigured repository or
credential is never mistaken for a host fault.

The module reads no file, spawns nothing, and reaches no environment variable —
it is pure string classification over caller-supplied text.

Shapes checked:

| Property                                             | Result                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| marker kind is allow-listed                          | `parseHostFaultMarker` only accepts a kind matching `isHostFaultKind`, which checks membership in `HOST_FAULT_KINDS` — an unrecognised or forged kind string returns `null`                                                                      |
| marker is read only from the final line              | `parseHostFaultMarker` walks the comment body from the end and considers **only** the trimmed final non-empty line; a marker-shaped string appearing earlier in an embedded raw failure message is never matched                                 |
| marker regex is anchored and non-greedy on structure | `HOST_FAULT_MARKER_PATTERN` anchors the whole trimmed line (`^...$`) and its only variable segment is `[a-z-]+`, a single linear character class with no nested quantifiers                                                                      |
| clone failures are not conflated with auth failures  | `CLONE_AUTH_OR_MISSING_PATTERN` is checked before a `CLONE_FAILED_PATTERN` match is accepted, so `Repository not found`, `Authentication failed`, `Permission denied` and HTTP 401/403 wording never classify as `clone-failed`                  |
| detection order cannot mask a corrupt-clone signal   | `brokenRefsIn`/`isObjectStoreCorruption` (from `broken_ref_repair.ts` and `object_store_repair.ts`, both already swept) are checked first, so a message describing both a broken ref and, say, disk pressure still classifies as `clone-corrupt` |

No findings.

## `worker/deno/lib/host_fault_release.ts`

Modelled closely on `lib/milestone_branch_refusal_release.ts` (Issue #2220): the
run that successfully creates a feature branch off a fresh clone is the first
witness that a worker host is healthy again, so it sweeps every
`failed-once`/`failed` issue in the repository and releases the labels on issues
whose failure records are entirely host faults. It spawns nothing itself — every
GitHub read and write goes through the injected `GhCommandFn` — and touches no
file or environment variable directly.

Untrusted inputs and how each reaches the output:

| Input                                       | Source                                                             | Handling                                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gh issue list --json number,labels` output | GitHub, for the claimed repository                                 | Parsed by `parseLabelledIssues` inside a `try`; a parse fault is pushed onto `errors`, never thrown past the sweep, and the label is kept                                                                             |
| `gh issue view --json comments` output      | GitHub; comment bodies are text any repository commenter may write | Parsed by `parseCommentRows`, then filtered through `selectFleetAuthoredComments` (`alert_dedup_authors.ts`) so only a comment authored by the configured fleet identity is read as a failure record                  |
| surviving comment bodies                    | fleet accounts only, after the filter above                        | Matched against the `## Automated Processing Failed` heading (`isFailureRecord`), then classified by `classifyFailureRecord` — the marker if present, else the narrow `clone-corrupt` fallback for pre-marker records |
| `repo`, label names, `limit`                | the run's own claim and its `WorkerConfig`                         | Passed as separate argv elements to `ghCommandFn`, never concatenated into a shell string                                                                                                                             |

Shapes checked:

| Property                                                          | Result                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no shell, no argv construction                                    | `GhCommandFn` takes a `string[]`; `repo`, the issue number and every label are individual argv elements to `gh issue list` / `gh issue view` / `gh issue edit` / `gh issue comment` — no concatenation into a command string                                                                                      |
| untrusted comment bodies are trusted only post-filter             | `selectFleetAuthoredComments` runs before any body is inspected for a failure record or a marker; an unresolvable fleet identity discards every comment (fail closed — the label is kept)                                                                                                                         |
| the host-fault marker is the only trusted classifier              | `classifyFailureRecord` prefers `parseHostFaultMarker`'s allow-listed kind; only when no marker is present does it fall back to `detectHostFault`, and even then only accepts the narrow `clone-corrupt` case, never the broader `clone-failed`/`disk-full`/`container-build-failed` kinds for markerless records |
| `JSON.parse` failures fail loud and keep the label                | both the issue-list and comment-view reads are wrapped in `try/catch`; a caught error is appended to `outcome.errors` and the issue is left alone (`continue`), never assumed to be clean                                                                                                                         |
| labels are removed only when every failure record is a host fault | the loop sets `allHostFaults = false` and `break`s on the first unclassifiable record, retaining the issue; only when every collected body classifies is `gh issue edit --remove-label` reached                                                                                                                   |
| the comment is posted only after the label edit succeeded         | `gh issue comment` is called after `ghCommandFn(args)` for the label edit returns without throwing; a comment failure is recorded in `errors` but the issue still counts as `released`, since the substantive label removal already happened                                                                      |
| one sweep per repo per process, with retry on partial failure     | `claimHostFaultReleaseSweep`/`swept` cap a clean sweep at one per repo per process; a sweep that recorded any `errors` deletes its own claim so a later call in the same process retries                                                                                                                          |
| removable labels are the configured pair only                     | `removable` is filtered to `[failedOnceLabel, failedLabel]` intersected with the labels actually present on the issue — no other label on the issue is ever touched                                                                                                                                               |

No findings.

## `worker/deno/lib/issue_sweep_parse.ts`

Shared `gh issue list` / `gh issue view` JSON parsing extracted from
`milestone_branch_refusal_release.ts` (Issue #2220), which now imports
`parseLabelledIssues` and `parseCommentRows` from here instead of duplicating
the parsing — `host_fault_release.ts` uses the same two functions. The module is
pure parsing: it does no I/O of its own, and every `JSON.parse` call is
unwrapped (it throws), by design, so both callers can decide how to record the
fault rather than this module silently defaulting to an empty result.

Shapes checked:

| Property                                                                  | Result                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| non-array top-level shape throws                                          | `parseLabelledIssues` throws when `JSON.parse` does not yield an array; `parseCommentRows` throws when `parsed?.comments` is not an array                                    |
| per-row shape checks drop rather than coerce                              | in `parseLabelledIssues`, a row with a non-numeric `number` is skipped (`continue`) and a non-string label `name` is never added to the label set                            |
| comment author normalisation matches both `gh` and the worker's own shape | `parseCommentRows` accepts both `{ login }` (as `gh` renders it) and a bare string author (as `GitHubComment` renders it), falling back to `null` when neither shape matches |
| a missing/non-string `body` drops the row silently                        | `parseCommentRows` uses `continue` for a row whose `body` is not a string, rather than substituting an empty string that might later be matched as a failure record          |

No findings.

## Test coverage

- `worker/deno/tests/host_fault_test.ts` — `host_fault.ts`.
- `worker/deno/tests/host_fault_release_test.ts` — `host_fault_release.ts`.
- `issue_sweep_parse.ts` has no dedicated unit test file; it is exercised
  indirectly through both of its callers' test suites, most directly
  `worker/deno/tests/milestone_branch_refusal_release_test.ts` (Issue #2220),
  which drives `parseLabelledIssues` and `parseCommentRows` through
  malformed-payload and comment-shape cases, and through
  `worker/deno/tests/host_fault_release_test.ts`.

No findings across the three modules.
