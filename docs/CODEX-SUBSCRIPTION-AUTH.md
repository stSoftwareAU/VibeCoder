# Codex subscription authentication

**Issue:** #1924 · **Parent:** #1923

VibeCoder's unattended Codex path is designed for a **ChatGPT fixed-price
subscription**, not metered OpenAI API billing. The operator performs the
interactive login once during initial host setup; normal worker/container
refreshes must not require a browser, TTY or device-code confirmation.

## Why `CODEX_HOME` is persistent

Codex stores file-based login state in `auth.json` under `CODEX_HOME`. OpenAI's
authentication documentation states that ChatGPT-login tokens are refreshed
automatically during use before expiry, so the directory must remain writable
and survive replacement of the disposable worker container.

VibeCoder already has a persistent, writable `vibe-agent-state` named volume for
coding-agent configuration and session state. Use a Codex home beneath that
volume rather than making the provider credential mount writable. The provider
credential mount stays read-only; it may identify the selected `CODEX_HOME`,
while the token-bearing `auth.json` lives only in persistent agent state.

The important containment rule is unchanged: only the selected Codex invocation
receives its `CODEX_HOME`. Claude and other providers must never receive Codex
authentication state.

## One-time login

Use the Codex CLI's ChatGPT login during initial setup. On a headless host,
OpenAI recommends device-code authentication:

```bash
codex login --device-auth
```

Alternatively, log in on a trusted machine with a browser and securely seed the
resulting `auth.json` into the persistent Codex home. OpenAI documents both
methods and warns that `auth.json` contains access tokens and must be treated
like a password.

Configure Codex itself to keep credentials in the file-backed home and to reject
an API-key login method:

```toml
cli_auth_credentials_store = "file"
forced_login_method = "chatgpt"
```

For the contained worker the persistent location should be under the agent-state
volume, for example:

```text
/home/vibe/auto-issue-work-agent-state/codex
```

The exact container user/path follows the VibeCoder container manifest; do not
replace it with a mount of the host home directory.

## Billing fail-closed rule

When an invocation selects a non-blank `CODEX_HOME`, VibeCoder deliberately
removes `OPENAI_API_KEY` and `CODEX_API_KEY` from that Codex child's environment,
even if either variable exists in the parent process. A revoked or exhausted
subscription therefore fails as a subscription; it cannot silently turn into
metered API spend.

The older explicit API-key path is retained for compatibility when **no**
`CODEX_HOME` is selected. It is not eligible for the subscription-only automatic
routing introduced by #1923/#1925/#1926.

## Restart behaviour

The worker container is disposable; the Codex authentication directory is not.
A restart must therefore have this shape:

```text
container N                persistent agent-state volume          container N+1
    │                                  │                               │
    └── Codex writes refreshed ───────▶│◀──── reads same auth.json ────┘
        auth.json                      │
                                       │ survives image/container refresh
```

No restart path should execute `codex login`. If authentication is revoked or
otherwise cannot refresh, classify the provider as unavailable and let the
provider-routing layer deal with it; never prompt an unattended worker.

## Verification

Before enabling Codex on a production host:

1. Perform the one-time ChatGPT login.
2. Confirm `auth.json` is present in the persistent Codex home and is not in the
   repository, logs or read-only provider credential mount.
3. Run a Codex-only smoke issue.
4. Destroy/recreate the worker container and run another smoke issue without
   logging in again.
5. Confirm no `OPENAI_API_KEY` or `CODEX_API_KEY` reaches a subscription-mode
   Codex child.

The longer restart/token-refresh qualification belongs to #1927; this issue
establishes the persistent authentication and billing boundary it will exercise.

## Upstream reference

OpenAI Codex authentication documentation:
https://developers.openai.com/codex/auth
