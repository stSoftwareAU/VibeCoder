# Gemini subscription authentication

**Issue:** #5345 · **Parent:** #5313

VibeCoder's unattended Gemini path is designed for a **Google-account login**
(fixed-price), not metered Gemini API billing. The operator performs the
interactive login once during initial host setup; normal worker/container
refreshes must not require a browser or TTY.

Gemini stays opt-in. It is not in the default image: `container/tools.json`
lists it as pinned but not in `installedProviders`. A host builds it in with
`AGENT_PROVIDERS="claude,codex,gemini"` (`container/Containerfile:135`) and
enables it in `agent_providers`.

## Why `GEMINI_CLI_HOME` is persistent

The Gemini CLI resolves its home from `GEMINI_CLI_HOME` (else the OS home) and
keeps the login at `<GEMINI_CLI_HOME>/.gemini/oauth_creds.json` and user
settings at `<GEMINI_CLI_HOME>/.gemini/settings.json`. This was verified against
the pinned Gemini CLI 0.68.0, recorded in `worker/deno/lib/gemini_auth.ts`. The
CLI refreshes the access token with the stored `refresh_token`, so the directory
must be writable and survive replacement of the disposable worker container.

Put it under the persistent `vibe-agent-state` volume, for example:

```text
/home/vibe/auto-issue-work-agent-state/gemini
```

Do not use a host home mount. The read-only provider credential mount only
selects the home and holds the one-time seed; the live, refreshable login lives
in persistent agent state.

The worker reads only an explicit `GEMINI_CLI_HOME`. With it unset, no login is
probed and Gemini's billing comes from the API-key check.

## One-time login

On the host (or a trusted machine), run the CLI with the home set and choose
**Sign in with Google**:

```bash
GEMINI_CLI_HOME=/home/vibe/auto-issue-work-agent-state/gemini gemini
```

With no browser on the machine, set `NO_BROWSER=true` too. The CLI then prints a
sign-in URL and asks for the authorisation code ("Enter the authorization
code:") instead of opening a browser (upstream
`packages/core/src/code_assist/oauth2.ts`, `authWithUserCode`; read from the
upstream main branch, not re-checked against the 0.68.0 pin).

Keep the login in plain-file storage: do not set
`GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true`, because the worker's probe does not
support encrypted storage.

`settings.json` must select no other auth type: `security.auth.selectedType`
absent or `"oauth-personal"`. A value of `"gemini-api-key"` classifies as
metered; any other value is `unknown` and ineligible. The `unknown` label
holds only when no `GEMINI_API_KEY` / `GOOGLE_API_KEY` is present; with one, the
classification is `metered` (named by that variable), so still never an auto
candidate.

```json
{ "security": { "auth": { "selectedType": "oauth-personal" } } }
```

`oauth_creds.json` holds a refresh token and must be treated like a password.

## Seeding the login

Provision `~/.vibe-coder/credentials/gemini/provider.env` with exactly:

```text
GEMINI_CLI_HOME=/home/vibe/auto-issue-work-agent-state/gemini
```

`GEMINI_CLI_HOME` is a state selector (a path, not a credential). `setup.sh`
still provisions only `VIBE_LAUNCHAGENT_GEMINI_API_KEY`, so this line is written
by hand.

Place the login file beside it as `gemini/oauth_creds.json`, owner-only
(`0600`), with the directory `0700`. At startup the credential preflight
(`worker/deno/lib/credential_preflight.ts` calls `initialiseGeminiHome` in
`worker/deno/lib/gemini_auth.ts`) seeds
`<GEMINI_CLI_HOME>/.gemini/oauth_creds.json` once when it is missing. A seed
with no non-blank `refresh_token` fails startup with an error naming both the
target and the seed path; a seed that is not owner-only fails naming the seed.
An existing (refreshed) login is never overwritten, including by a concurrent
initialiser. The new `.gemini` directory is created `0700` and the file `0600`.
No interactive login or API-key fallback is attempted.

## Billing policy

A Google-account login under an explicit `GEMINI_CLI_HOME` classifies as
`fixed-subscription` (`gemini-google-login`). Free-tier and paid logins classify
the same: the file shape is the same and the probe does not tell tiers apart, so
a free-tier login counts as fixed-price.

`GEMINI_API_KEY` / `GOOGLE_API_KEY` alone are `metered`: never selected by
`agent_provider_mode: "auto"`, usable only when Gemini is pinned (or named in
the opt-in `agent_provider_fallback`). A corrupt or unreadable login is
`unknown` (`gemini-login-unreadable (<fault>)`) and ineligible for auto. That
`unknown` label holds only when no `GEMINI_API_KEY` / `GOOGLE_API_KEY` is
present; with one, the classification is `metered` (named by that variable), so
still never an auto candidate.

In `auto` a login is a candidate with passive quota: no probe, no windows, so it
ranks after providers with fresh known quota. A run-reported quota exhaustion
makes it `exhausted`, and an authentication failure makes it unavailable, until
the outage record expires (`resolveAutomaticProviderStatus` in
`worker/deno/lib/provider_auto_runtime.ts`; the passive login status is
`geminiStatus`). See
[Provider parity](PROVIDER-PARITY.md#subscription-only-billing-policy).

## Containment

When a home is selected, `buildIsolatedGeminiChildEnv`
(`worker/deno/lib/gemini_env.ts:128-150`) deletes `GEMINI_API_KEY`,
`GOOGLE_API_KEY`, `GEMINI_CLI_HOME` and `GOOGLE_GENAI_USE_GCA` from its copy,
then sets only the home and `GOOGLE_GENAI_USE_GCA=true`. An expired login
therefore fails authentication instead of becoming metered spend (this mirrors
Codex's `CODEX_HOME` guard).

Only the Gemini child sees the home: `GEMINI_CLI_HOME` is denied by name to the
Claude, Codex and DeepSeek children (`worker/deno/lib/claude_env.ts`,
`codex_env.ts`, `deepseek_env.ts`).

## A single Gemini account

The worker reads one `gemini/provider.env`. Gemini has no credential pool: only
Claude's descriptor declares a `tokenPool` of `provider-*.env` files
(`worker/deno/lib/agent_provider.ts`). There is therefore one Gemini account per
host, as for Codex in code today.

## Restart behaviour

The worker container is disposable; the Gemini home is not. A restart must have
this shape:

```text
container N                persistent agent-state volume          container N+1
    │                                  │                               │
    └── Gemini writes refreshed ──────▶│◀─ reads same oauth_creds.json ┘
        oauth_creds.json               │
                                       │ survives image/container refresh
```

No restart runs an interactive login. If the login is revoked, it classifies as
an authentication failure and auto routing marks Gemini unavailable; an
unattended worker is never prompted.

## Verification

Before enabling Gemini on a production host:

1. Perform the one-time Google-account login.
2. Confirm `oauth_creds.json` is present in the persistent Gemini home and is
   not in the repository, logs or read-only provider credential mount.
3. Run a Gemini-only smoke issue.
4. Destroy/recreate the worker container and run another smoke issue without
   logging in again.
5. Confirm no `GEMINI_API_KEY` or `GOOGLE_API_KEY` reaches a login-mode Gemini
   child.

Owner step: sign in the Google account on the host and seed the persistent
`GEMINI_CLI_HOME`.

Owner step: soak-test Gemini after merge.

## Upstream reference

Gemini CLI authentication documentation:
https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx
