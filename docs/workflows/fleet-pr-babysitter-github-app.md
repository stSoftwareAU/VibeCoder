# Set up a GitHub App for the fleet PR babysitter

Create a separate App from the fleet reviewer and worker Apps. Its installation
has its own GitHub API rate limit, so babysitting does not spend the signed-in
user's GraphQL allowance. The reviewer remains a separate identity for code
review.

The babysitter uses this App for GitHub API calls and Git operations. It stops
if authentication fails rather than falling back to a signed-in user.

## Create and install the App

An owner of the GitHub organisation that owns the monitored repositories
needs to do the following:

1. In GitHub, open the organisation's **Settings → Developer settings →
   GitHub Apps**, and select **New GitHub App**. Choose a unique name such as
   `fleet-pr-babysitter`; record its App ID and slug. A homepage URL is
   required by the registration form; use your organisation's project URL.
2. Clear **Active** under **Webhook**. The babysitter polls and does not need
   inbound webhooks. Select **Only on this account** for installation scope if
   all monitored repositories belong to this organisation.
3. Under **Repository permissions**, grant:
   - **Contents: read and write** — clone and push branch fixes.
   - **Pull requests: read and write** — inspect PRs and maintain branches.
   - **Issues: read and write** — acquire, renew and release the fleet's
     comment-based PR lock.
   - **Checks: read** and **Commit statuses: read** — inspect CI results.
   - **Actions: read** — inspect GitHub Actions runs and logs for CI failures.
   - **Workflows: read and write** — needed if a fix changes a workflow file;
     omit it only if the babysitter is explicitly prohibited from pushing
     such fixes.

   Metadata read access is supplied by GitHub. Leave other permissions at
   their default unless a later implementation documents a need for them.
4. Create the App, open its **Install App** page and install it on every
   monitored repository owned by that account. If repositories belong to
   multiple accounts, the App must be installable on those accounts and each
   owner must install it. Grant access to selected repositories or all
   repositories according to your organisation's policy.
5. On the App's **General** page, generate a private key. Store the downloaded
   PEM outside the checkout, for example at
   `~/.vibe-coder/fleet-pr-babysitter.private-key.pem`, with access
   restricted to the service account (`chmod 600` on Unix). Do not commit it,
   paste it into a PR or put it in logs. Record the App ID, key path, App slug
   and installation owner for the eventual runner configuration.

If permissions are changed later, an organisation owner may need to accept the
new permission request for each installation before tokens receive them.

Run the interactive setup described in [the babysitter MVP](fleet-pr-babysitter.md)
to check the key, installation permissions, repository access and quota. It
offers to install a macOS launch agent after you have manually tested a fix.
Setup saves the App ID, installation ID and private-key path for the runner
and adds the bot to the local fleet-lock identities; it does not save an
installation token. Repeat the trust setup on every fleet host before starting
repairs.

## Coordinate with the fleet

The App's comment author is `<app-slug>[bot]`. Every fleet host must recognise
that exact login as a trusted **branch-lock author**, or another VibeCoder can
ignore the babysitter's lock and work on the same PR. Today the worker derives
that trust from `service_accounts`, `fleet_pr_authors` and its own login;
`authorized_commenters` alone is **not** sufficient for branch locks.

Adding the bot to `service_accounts` or `fleet_pr_authors` also treats it as a
fleet identity in other worker paths, including PR author and scheduling
checks. Decide whether that broader trust is appropriate before changing every
host. A dedicated lock-author setting is an alternative implementation, but
it does not exist yet. Do not add the bot to `pr_reviewers`: that setting
requests human reviewers on new PRs, and an App cannot be requested as one.

## Before using it

Setup supports monitored repositories under one owner and verifies the App's
permissions. Configure the bot as a trusted lock author on every fleet host;
setup can verify only its own host. Installation tokens are refreshed during
long passes. Keep tokens out of command-line arguments and logs.

First run a read-only scan and check GitHub's rate-limit
response for the installation identity. Then test one PR while another fleet
worker is active and verify that only one worker holds the lock and starts a
fix. See [the babysitter MVP](fleet-pr-babysitter.md) for its current commands
and limitations, and [the reviewer App setup](../CONFIGURATION.md#-reviewer-app-for-fleet-pr-reviews)
for the existing reviewer arrangement.
