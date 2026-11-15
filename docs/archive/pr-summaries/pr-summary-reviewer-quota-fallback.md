## Summary

Fleet reviewer rounds failed on the observed Fable-specific quota refusal,
because the account-wide quota detector did not recognise that message.
Recognise the exact CLI refusal in the review round and prefer Fable across
every available Claude subscription, then Astra, then Opus, then DeepSeek.
Related failure report: #5137.

## Spec

### Intent and Rationale

Use the owner's preferred model with quota before accepting a weaker model
or paid DeepSeek overflow. Three configured Claude subscriptions must all
get their Fable attempt before Astra. A Fable cap does not exhaust Opus.

### Essential Design Decisions

- Keep model-specific refusal detection in the reviewer rather than changing
  the shared account-wide exhaustion classifier.
- Exclude every subscription already refused during this round, so positive
  general subscription quota cannot send the reviewer back to a capped model.
- Preserve Codex credential isolation and authoritative quota classification.
  Missing Codex credentials skip Astra; other provider failures stop the chain.
- Opus uses the current Claude subscription after Astra is unavailable or
  quota-limited. DeepSeek remains last and receives its own environment.

### Undiscoverable Facts

The observed CLI refusal is: "You've reached your Fable limit. Switch to
another model to continue." The reviewer has its own persistent Codex home;
operators provision its login separately from the desktop login.

## Evidence

The focused regression reproduced the missing fallback and the two-subscription
limit before the fix during development. Focused validation passed 81 tests across review rounds, Claude credential
selection and Codex wiring, including the replacement production-wiring
regression. Restoring the old single-label exclusion makes that regression
fail before successful fallback; the current implementation passes. Targeted
format, lint and type checks passed. The full local quality gate was not rerun;
current-head CI must pass before approval.
Live recovery through Astra has not been verified by this PR.

## Test Plan

- Added a full sequence test: three Fable subscriptions, Astra quota refusal,
  Opus quota refusal, then successful DeepSeek. It drives the production
  credential discovery, ranking and rotation against three credential files
  and a fake budget service, then checks the persisted attempt record and
  successful result. Provider fakes reject mismatched credentials.
- Added a real credential-pool test excluding multiple previously tried
  subscriptions even while general quota remains positive.
- Updated prior order assertions because Opus before Astra is obsolete.
  Existing tests retain success short-circuiting, non-quota failure stops,
  missing credentials, environment isolation and attempt records.
- Updated all documented copies of the order: design principles, configuration,
  model guide, skill and unattended operator guide. No second implementation
  of this reviewer fallback rule was found.
