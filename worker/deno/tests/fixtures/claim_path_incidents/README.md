# Recorded claim-path incidents

Every "the worker isn't picking up work" incident so far was found on the live
fleet, on repository state that then evaporated. Each file here is one such
state, recorded so it runs in CI for ever: `claim_path_incident_test.ts` replays
it through **both** instruments — the idle-decision census and the real claim
scan — and asserts they agree, and that they agree with what the fleet should
have done.

The corpus gets more valuable with every gate added, instead of less.

## Recording a new one

When an `[idle-census] … ALERT inversion` names a repo whose backlog the scan is
refusing, write the repo's state down here before it disappears. Add a JSON file
with this shape (the schema is `RecordedIncident` in
`../../claim_path_incident_test.ts`):

```json
{
  "incident": "stSoftwareAU/EXAMPLE 2026-08-28",
  "issue": "VibeCoder#499",
  "observed": "the [idle-census] line, verbatim",
  "note": "anything abridged, and why it is not material",
  "state": {
    "repo": "stSoftwareAU/EXAMPLE",
    "issues": [
      { "number": 48, "tier": "work-on", "gate": "merged-pr-permanent" }
    ]
  },
  "expect": { "claimable": [60, 61], "scanClaims": true }
}
```

`gate` is one of `none`, `milestone-occupied`, `pr-blocked`,
`merged-pr-permanent`, `dependency-blocked`, `cooldown` — the gates the census
models, and so the ones the two instruments can be compared over. Since Issue
#2532 `milestone-occupied` no longer refuses a `work-on` or `top-priority`
issue (those tiers share a busy stream), so a state pairing that gate with one
of them describes a claimable issue — `STREAM_SHARING_EXEMPT_GATES` in
`../claim_path_state.ts` records the exemption. Keep issue
numbers as they were in the field: the point of the corpus is that these are
real states, not invented ones.

**Never record anything sensitive.** The files hold issue numbers, tiers and
gates — no titles, no bodies, no logins beyond the fixed fleet placeholders.
