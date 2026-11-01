## Summary

Work in progress for #4655: add policy, discovery and hold-provenance scaffolding. The current gate deliberately retries substantive test changes because a credential-free independent execution runner is not yet available. This does not complete the issue.

## Evidence

The shared review brief asks for the old and remaining contract, actual coverage and a reproducible regression check where applicable. Posting fetches governing issue contents and retries substantive test changes until execution evidence can be supplied by an isolated runner. Removed functionality can be justified without inventing a replacement test. The previous opt-in policy remains available as a per-repository override.

The replay uses the public #4645 hold through discovery and posting, with reviewer-owned and pre-existing human labels, an unjustified tautological assertion and a moved head. GitHub review and label events provide conservative cross-host label provenance; missing history or an independent change request keeps the label. An idempotent human label add to an already-labelled PR does not create a GitHub event and cannot be identified from that history.

## Test Plan

- Focused reviewer, gate, hold-replay and label tests: 65 passed.
- Replay and pre-PR verifier tests: 77 passed.
- Deno type check passed for posting, verifier and the new focused tests.
- Existing posting tests were adapted to the REST review endpoint and now assert the reviewed commit ID.
- The shared brief is used by both fleet review and the pre-PR verifier; the implementing and repair prompts and the testing standard were updated together. The new rule was applied to this diff: removed assertions in the edited test shims were replaced with checks of the same posted outcome and its commit ID.

## Limitations

The positive replay cases currently fail by design: the trusted isolated runner and its integration are not implemented. The tests do not establish a live model’s semantic judgement. The no-op human label-add limitation above remains. No PR has been opened.
