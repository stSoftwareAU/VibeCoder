# review-fleet-prs round falls back to DeepSeek when the Claude pool is exhausted (Issue #3632)

## Summary

The review round (`worker/deno/lib/review_round.ts`) ran `claude -p` on the
Claude credential pool's ranked subscription and retried once on the next
subscription with budget after a usage-limit refusal. When **every** Claude
subscription was exhausted — the 2026-10-11 weekly-limit situation — the round
logged `no other subscription has budget; the round stays failed` and fleet PR
review stopped until the window reset, even though the worker itself had
already fallen back to DeepSeek and DeepSeek was healthy.

`runReviewRound` now takes one more step when a usage-limit refusal survives
the pool rotation (no held label to rotate, no subscription with budget, or
the rotated retry hitting the limit too): it asks the new
`exportFallbackCredential` seam for the fallback provider, and when one
exports, runs the round once more —

- on **DeepSeek**, the worker's own fallback provider, with the credential
  read from the provisioned `deepseek/provider.env` exactly the way the
  worker's start-up exports every provider's;
- in DeepSeek's own pinned child environment built by
  `buildDeepSeekChildEnv` (`deepseek_env.ts`): base URL and auth token pinned,
  no Claude credential may reach the third-party endpoint, DeepSeek's own
  config dir;
- with the model argument swapped to `deepseek-v4-pro`
  (`REVIEW_FALLBACK_MODEL`) — the pinned `claude-opus-5-5` id would be
  silently remapped by the endpoint anyway;
- announced as `round fell back to provider deepseek`, so a DeepSeek review is
  never presented as an Opus one.

Fail-open: no DeepSeek credential → today's `round stays failed` line. A
non-usage-limit failure never engages the fallback. The gate and posting stay
unchanged. `createReviewRoundDeps` gains a test-scoped `credentialDir` option;
production keeps the environment-resolved directory.

## Tests

- `review_round_test.ts` additions: the fallback engages when rotation finds
  no subscription, after a rotated retry also hits the limit, and when the
  token came from no pool file; the fallback attempt runs with the swapped
  model and the fallback's own env (no Claude token); no fallback credential
  keeps today's failed line; a non-usage-limit failure never engages it.
  The two legacy rotation tests now opt the fallback out to keep testing
  rotation semantics.
- `review_round_wiring_test.ts` (new): the production seam exports the pinned
  child env from a provisioned fixture credential file, and exports nothing
  when the file is absent.

**Docs sweep** — grep: `exportFallbackCredential`, `REVIEW_FALLBACK_MODEL`,
`round fell back to provider`; section:
`.claude/skills/review-fleet-prs/references/running-unattended.md` (the
"Where a round runs, and on which Claude subscription" paragraph); siblings:
`no other subscription has budget`; updated:
`.claude/skills/review-fleet-prs/references/running-unattended.md`
