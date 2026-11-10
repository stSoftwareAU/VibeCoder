## Summary

Audited every entry of `CREDENTIAL_USING_ACTIONS` against the pinned action's
real credential handling and kept only the actions that push with the checkout's
persisted credential: `stefanzweifel/git-auto-commit-action` and
`endbug/add-and-commit`. Removed: `googleapis/release-please-action` and its old
name `google-github-actions/release-please-action`,
`peaceiris/actions-gh-pages`, `crazy-max/ghaction-github-pages` and
`cycjimmy/semantic-release-action` — a job using one of them whose
`actions/checkout` persists credentials is now flagged (`BP-PERSIST-CREDS-…`).
Two removed actions keep their SSH mode as a conditional signal, because that
mode pushes with the key `actions/checkout` persisted from its `ssh-key` input:
`ad-m/github-push-action` with `with.ssh` true (boolean or `"true"`) and
`jamesives/github-pages-deploy-action` with `with.ssh-key` true (boolean or
`"true"`); their other modes are flagged. `cycjimmy/semantic-release-action` is
covered by a checkout-level signal instead: a checkout that sets `ssh-key`
(non-empty) keeps the key in the git config for later SSH pushes, so the job is
skipped — semantic-release first dry-runs `git push` against that origin and
only falls back to its `GITHUB_TOKEN`/`GH_TOKEN` URL when the dry run fails.

Closes #4869.

## Spec

### Intent and Rationale

- The list's premise is "actions that push using the checkout credential". The
  fully removed actions authenticate with their own token or key and never read
  the persisted one, so treating them as a credential signal hid a real
  hardening gap (same premise #4692 fixed for `create-pull-request`). Two of
  the removed actions keep an SSH mode that does use the key checkout
  persisted, so that mode stays a signal; semantic-release instead relies on
  the checkout's `ssh-key` origin, which the checkout-level `ssh-key` signal
  covers.

### Essential Design Decisions

- Audit result, from each action's source on its default branch:
  - release-please-action: GitHub API with its own `token` input; never runs
    git → flagged.
  - `ad-m/github-push-action`: HTTPS mode (default) requires its
    `token`/`github_token` input and pushes to
    `…//oauth2:<token>@host/repo.git`, so it ignores the persisted credential.
    With `ssh: true` it pushes to `git@<host>:<repo>.git` and has no SSH key
    input, so it relies on the key `actions/checkout` persisted (its README's
    deploy-key example uses checkout `ssh-key` + `persist-credentials: true`).
    `SSH_PUSH_ACTION_INPUTS` maps the action → `ssh`, so `ssh: true` is a
    signal and HTTPS mode is flagged.
  - `jamesives/github-pages-deploy-action`: `configureSSH` skips SSH setup when
    `sshKey` is not a string; `generateRepositoryPath` returns
    `git@<host>:<repo>.git` whenever `sshKey` is truthy; `init` does not unset
    the checkout config in SSH mode. So `with.ssh-key: true` reuses the key
    `actions/checkout` persisted from its `ssh-key` input, while the
    `token`/`ssh-key` secret modes carry their own credential.
    `SSH_PUSH_ACTION_INPUTS` maps the action → `ssh-key`, so `ssh-key: true` is
    a signal and the other modes are flagged.
  - `peaceiris/actions-gh-pages`: `set-tokens.ts` builds a token or deploy-key
    URL and `git-utils.ts` clones and pushes through a separate work dir →
    flagged.
  - `crazy-max/ghaction-github-pages`: `main.ts` builds the remote URL from
    `GITHUB_TOKEN`/`GH_PAT` and clones/pushes to it → flagged.
  - `cycjimmy/semantic-release-action`: runs semantic-release, whose
    `get-git-auth-url.js` first dry-runs `git push` against the untransformed
    `repositoryUrl` (defaulting to `git config --get remote.origin.url`) and
    only falls back to a `GITHUB_TOKEN`/`GH_TOKEN` URL when that dry run fails.
    A checkout given `ssh-key` sets that origin to `git@<host>:<repo>.git` and
    persists `core.sshCommand`, so the deploy-key release job pushes with the
    key checkout persisted. The scanner therefore skips any job whose checkout
    sets `ssh-key` (a checkout-level signal, like `submodules:`); a token-only
    semantic-release job is still flagged.
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
  `scan - a job using release-please-action with persist-credentials: false is not flagged`.
- Added, for each fully removed coordinate (ad-m HTTPS, peaceiris, both casings
  of JamesIves, crazy-max, cycjimmy), a
  `scan - a job using <action> with a persisting checkout is flagged` test and a
  `jobNeedsCheckoutCredentials - <action> is not a credential signal` test;
  added a test that `endbug/add-and-commit` still skips the job.
- Added the SSH-mode signals:
  `scan - ad-m/github-push-action in SSH mode relies on the checkout ssh-key and skips the job`
  (boolean and string `true`),
  `scan - ad-m/github-push-action with ssh: false is HTTPS mode and is flagged`,
  `jobNeedsCheckoutCredentials - ad-m/github-push-action is a signal only with ssh: true`,
  `scan - JamesIves/github-pages-deploy-action with ssh-key: true relies on the checkout ssh-key and skips the job`
  (boolean and string `true`), and
  `jobNeedsCheckoutCredentials - JamesIves/github-pages-deploy-action is a signal only with ssh-key: true`.
- Added the checkout-level `ssh-key` signal:
  `scan - cycjimmy/semantic-release-action with a checkout that sets ssh-key is skipped`
  and `scan - a checkout that sets ssh-key is skipped`.
- The existing known-push-action skip test and the plain-`ad-m` positive
  assertions now use `stefanzweifel/git-auto-commit-action`; the peaceiris
  fixture in the skip test was replaced, and peaceiris jobs with a persisting
  checkout are now flagged (covered by the own-token test loop).
- Extended
  `jobNeedsCheckoutCredentials - create-pull-request alone is not a credential signal`
  with `false` assertions for both release-please coordinates.
- Red checks (each guard removed on its own, tests seen to fail, then restored):
  - Removing the checkout-level `ssh-key` signal (`checkoutSetsSshKey`) → 2
    tests fail (`scan - cycjimmy/semantic-release-action with a checkout that sets ssh-key is skipped`,
    `scan - a checkout that sets ssh-key is skipped`; 46 passed); restored, all
    48 pass.
  - Removing the JamesIves `ssh-key` map entry → 1 test fails
    (`jobNeedsCheckoutCredentials - JamesIves/github-pages-deploy-action is a signal only with ssh-key: true`;
    47 passed); restored, all 48 pass.
  - Removing the `ad-m` `ssh` map entry → 1 test fails
    (`jobNeedsCheckoutCredentials - ad-m/github-push-action is a signal only with ssh: true`;
    47 passed); restored, all 48 pass.
- Docs: `docs/GITHUB-ACTIONS-AUDIT-SCAN.md` lists the kept push actions, the
  SSH-mode signals and the checkout-level `ssh-key` signal, and names the fully
  removed actions as not signals.
- `deno fmt --check`, `deno lint` and `deno check` on the scanner and its test
  passed, the scanner unit test file passed (48 tests), and
  `markdownlint-cli2` reported 0 issues across the published Markdown.
