# Security sweep — time deferral (`time_deferral.ts`)

**Issue:** [#2873](https://github.com/stSoftwareAU/VibeCoder/issues/2873) (chunk
top-up-2873) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12af) recorded their coverage:

- `worker/deno/lib/time_deferral.ts` — added by #2873.

## `worker/deno/lib/time_deferral.ts`

The module gives an analysis-only run a third ending — alongside
`blocked_deferral.ts` — for work that cannot proceed yet because the data it
needs has not been produced: the issue is parked open, with a "deferred until"
record, instead of being escalated to a human.

Shapes checked:

| Property                                                            | Result                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the marker is parsed only from the run's own final output           | `detectTimeDeferral` is called on the agent's output text, not on any issue/comment/PR free-text the run did not itself produce                                                                                                                   |
| `until` must be strict ISO-8601 with an explicit offset             | `STRICT_ISO_RE` requires `YYYY-MM-DDTHH:MM:SS` plus `Z` or a `±HH:MM` offset; a bare or ambiguous timestamp is rejected as `invalid` rather than silently parsed                                                                                  |
| `until` is bounded to `MAX_DEFERRAL_HORIZON_MS`                     | `detectTimeDeferral` rejects any `until` more than 30 days out, so a mistaken or malicious far-future value cannot park an issue indefinitely under a label that still reads as active                                                            |
| `reason` is length-capped before it reaches the public comment      | the captured `reason` is trimmed, whitespace-collapsed and sliced to `MAX_REASON_LENGTH` (500) before `buildDeferralComment`/`buildDeferralExhaustedComment` render it, and both also run it through `neutraliseAgentMarkers` and `redactSecrets` |
| the `Deferred until` line is read only from the machine-owned block | `parseTimeDeferralUntil` reads exclusively via `readWorkerRecordLines`, so free-text elsewhere in the issue body — including text an issue author typed that looks identical — is never read as a deferral                                        |
| the deferral count is bounded, then escalates                       | callers cap repeated deferrals at `MAX_TIME_DEFERRALS` (3); `buildDeferralExhaustedComment` hands the issue to a human once that limit is reached instead of deferring again                                                                      |
| `isIssueTimeDeferred` fails safe on a read error                    | a body-read failure is treated as **not** deferred (fails toward re-running the issue, not toward silently parking it) and is reported through the `onReadError` callback rather than swallowed                                                   |
| regexes are literals, with no dynamic construction from input       | `REQUEST_RE`, `UNTIL_RE`, `REASON_RE`, `RECORD_LINE_RE`, `STRICT_ISO_RE` and `RECORD_MARKER_RE` are all regex literals; none is built with `new RegExp` from a runtime or caller-supplied string                                                  |

No findings. The module has unit test coverage in
`worker/deno/tests/time_deferral_test.ts`,
`worker/deno/tests/handle_no_changes_time_deferral_test.ts` and
`worker/deno/tests/idle_decision_census_test.ts`.
