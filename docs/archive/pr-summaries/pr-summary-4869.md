## Summary

Audited every entry of `CREDENTIAL_USING_ACTIONS` against the pinned action's
real credential handling and kept only the actions that push with the checkout's
persisted credential. Removed: `googleapis/release-please-action` and its old
name `google-github-actions/release-please-action`,
`peaceiris/actions-gh-pages`, `jamesives/github-pages-deploy-action`,
`crazy-max/ghaction-github-pages` and `cycjimmy/semantic-release-action`. A job
using one of them whose `actions/checkout` persists credentials is now flagged
(`BP-PERSIST-CREDS-…`). Kept: `stefanzweifel/git-auto-commit-action` and
`endbug/add-and-commit`. `ad-m/github-push-action` is a conditional signal: it
skips the job only with `with.ssh` true (boolean or `"true"`), because that mode
pushes with the SSH key `actions/checkout` persisted; its HTTPS mode is flagged.
Closes #4869.

## Spec

### Intent and Rationale

- The list's premise is "actions that push using the checkout credential". Each
  removed action authenticates with its own token or SSH key and never reads the
  persisted one, so treating it as a credential signal hid a real hardening gap
  (same premise #4692 fixed for `create-pull-request`).

### Essential Design Decisions

- Audit result, from each action's source on its default branch:
  - release-please-action: GitHub API with its own `token` input; never runs
    git.
  - `ad-m/github-push-action`: HTTPS mode (default) requires its
    `token`/`github_token` input and pushes to
    `…//oauth2:<token>@host/repo.git`, so it ignores the persisted credential.
    With `ssh: true` it pushes to `git@<host>:<repo>.git` and has no SSH key
    input, so it relies on the key `actions/checkout` persisted (its README's
    deploy-key example uses checkout `ssh-key` + `persist-credentials: true`);
    PR #4985 review corrected an earlier claim that SSH mode ignores it. Hence
    `stepUsesSshPush` in the scanner makes `ssh: true` a signal and HTTPS mode
    is flagged.
  - `peaceiris/actions-gh-pages`: `set-tokens.ts` builds a token or deploy-key
    URL and `git-utils.ts` clones and pushes through a separate work dir.
  - `JamesIves/github-pages-deploy-action`: `git.ts` unsets the checkout's
    `http.…extraheader` and adds an origin carrying its own token.
  - `crazy-max/ghaction-github-pages`: `main.ts` builds the remote URL from
    `GITHUB_TOKEN`/`GH_PAT` and clones/pushes to it.
  - `cycjimmy/semantic-release-action`: runs semantic-release, whose
    `get-git-auth-url.js` builds the push URL from `GITHUB_TOKEN`/`GH_TOKEN`;
    its own code only reads tags.
  - Kept `stefanzweifel/git-auto-commit-action` (`git push origin …`) and
    `endbug/add-and-commit` (`github_token` is documented "NOT used to make
    commits", so it pushes with the persisted credential).

### Undiscoverable Facts

- None.

## Evidence

Backend-only change; no UI. Behaviour is covered by
`worker/deno/tests/checkout_persist_credentials_scanner_test.ts`. The upstream
behaviour above was read from each action's source (raw files / GitHub API) in
this run, not taken from the issue's description.

## Test Plan

- Added
  `scan - a job using release-please-action with a persisting checkout is flagged`
  (both coordinates) and
  `scan - a job using release-please-action with persist-credentials: false is not flagged`
  in `worker/deno/tests/checkout_persist_credentials_scanner_test.ts`.
- Added, for each of the five other removed coordinates (both casings of
  JamesIves), a
  `scan - a job using <action> with a persisting checkout is
  flagged` test and
  a `jobNeedsCheckoutCredentials - <action> is not a
  credential signal` test;
  added a test that `endbug/add-and-commit` still skips the job. Added
  `scan - ad-m/github-push-action in SSH mode relies on the checkout ssh-key and skips the job`
  (boolean and string `true`),
  `scan - ad-m/github-push-action with ssh: false is HTTPS mode and is flagged`
  and
  `jobNeedsCheckoutCredentials - ad-m/github-push-action is a signal only with ssh: true`.
  The existing known-push-action skip test and the plain-`ad-m` positive
  assertions now use `stefanzweifel/git-auto-commit-action`; the peaceiris
  fixture in the skip test was replaced, and peaceiris jobs with a persisting
  checkout are now flagged (covered by the own-token test loop).
- Extended
  `jobNeedsCheckoutCredentials - create-pull-request alone is not a credential signal`
  with `false` assertions for both release-please coordinates.
- Red check: with only the `ad-m` SSH signal line removed from the head scanner,
  2 tests fail (the SSH-mode scan test and the `ssh: true` signal test; 42
  passed); with it restored all 44 pass.
- Docs: `docs/GITHUB-ACTIONS-AUDIT-SCAN.md` lists the kept push actions and
  names the removed ones as not signals.
- `deno fmt`, `deno lint` and the scanner unit test file passed.
- <!-- vibe-quality-gate-skipped reason="full ./quality.sh did not complete within bounded time in an earlier run on this repo; targeted checks passed; the worker re-runs the gate before the PR" -->
