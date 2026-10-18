# Codex transport through the credential broker

## Status and scope

This is an experimental API-key adapter for Issues #3698 and #3699. It is
not wired into the normal worker launcher. Local contract tests pass; the
actual pinned Codex client in the isolated Docker and Podman containers has
not yet been exercised. ChatGPT subscription mode is explicitly refused,
without falling back to an API key. This checkpoint does not resolve the
milestone's containment or subscription acceptance criteria.

The shared broker already permits OpenAI API-key Responses requests. The
new agent-local adapter accepts only `POST /v1/responses` and forwards it
through `/run/broker/broker.sock` to the fixed broker route
`/openai/v1/responses`. The trusted broker supplies the upstream API key.
Caller authentication, cookies and account/organisation selectors do not
select the upstream identity. Responses remain streamed and request
cancellation reaches the forwarded request.

## Pinned native-client contract

`container/tools.json` pins Codex **0.147.0**. The `rust-v0.147.0` release
tag resolves to OpenAI's source commit
`be6e8eac029b183056b7e4402879f15d2c85f61b`. The available local CLI reported
`codex-cli 0.163.0-alpha.10.2`; it was not used as evidence for the pin.

The source at that commit establishes the following contract:

| Boundary | Pinned source and consequence |
| --- | --- |
| Custom API-key provider | [Provider configuration](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/model-provider-info/src/lib.rs) accepts `base_url`, `env_key`, `wire_api = "responses"`, `requires_openai_auth = false` and `supports_websockets = false`. The adapter uses a fresh custom provider with a local opaque capability as its `env_key`. |
| HTTP transport | [Responses endpoint](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/codex-api/src/endpoint/responses.rs) posts to `responses`. [Client compression selection](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/client.rs) restricts the relevant Zstd path to first-party Codex-backend authentication; this custom API-key provider does not select it. |
| Fixture SSE | [Responses parser tests](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/codex-api/src/sse/responses.rs) accept an assistant `response.output_item.done` containing `output_text`, followed by `response.completed` with a response ID. The diagnostic uses that shape. |
| CLI arguments and output | [Exec arguments](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/exec/src/cli.rs) define the fixture's strict-config, ephemeral and JSON flags. [Exec events](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/exec/src/exec_events.rs) define `item.completed` with an `agent_message`, followed by `turn.completed`. |

The fixture creates empty `HOME` and `CODEX_HOME` directories, writes only
its generated provider configuration, and starts `/usr/local/bin/codex`
with `clearEnv: true`. It supplies neither `OPENAI_API_KEY`, `CODEX_API_KEY`
nor an `auth.json`. The only credential-like input is the broker-local
capability. It checks the installed version before requesting a synthetic
response and sets request/stream retries to zero. The CLI's inner sandbox
bypass flag matches `codex_executor.ts`; the enclosing diagnostic container
must retain the production capability, network and filesystem restrictions.

## Native probe integration and acceptance

`tests/fixtures/native_codex_client_probe.ts` exports:

- `codexNativeFixtureResponse()`: the source-backed synthetic SSE response.
- `runCodexNativeClientProbe({ capability, expectedVersion, secretHash })`:
  the actual installed CLI invocation. It refuses versions other than
  0.147.0, requires the expected assistant message and a successful completed
  turn, and checks stdout, stderr and generated configuration for the planted
  upstream credential fingerprint.

The trusted diagnostic broker must independently authenticate exactly one
new native request to `https://api.openai.com/v1/responses` before returning
the fixture SSE. A successful client output alone is insufficient. The
parent orchestrator must check this dedicated witness, run the client inside
the production `--network none` agent container, and preserve the existing
before/after connectivity and credential-visibility controls. Only synthetic
credentials may be used. The image must install the pinned Codex provider;
the test does not download an unpinned client at runtime.

## Local checks

`tests/codex_agent_gateway_test.ts` exercises the real gateway and credential
broker together. It covers fixed routing and upstream credential injection,
caller account-header removal, denied routes, sanitised transport failures,
incremental streaming and cancellation, configuration injection refusal,
subscription refusal, and native-output success/failure interpretation.
The launch test runs with environment permission denied, so reading ambient
secrets is an immediate test failure. No production account or live OpenAI
endpoint is used by these tests.

Native JSONL expectations derive from the pinned source rather than an
observed 0.147.0 run. Hosted native-client evidence is still required before
claiming the CLI configuration and SSE are accepted together. Passing these
unit tests does not establish real API billing, model entitlement, ChatGPT
subscription compatibility, token refresh or the container boundary.

## Required separate ChatGPT subscription contract

The pinned [provider configuration](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/model-provider-info/src/lib.rs)
selects `https://chatgpt.com/backend-api/codex` for ChatGPT authentication.
The [bearer provider](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/model-provider/src/bearer_auth_provider.rs)
sends the access token and `ChatGPT-Account-ID`; it can also send the
account's FedRAMP marker. These values must come from a trusted account
snapshot, never agent-selected headers. A separate mode must retain that
upstream and identity even when API-key credentials are available.

The pinned [authentication manager](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/login/src/auth/manager.rs)
refreshes through `https://auth.openai.com/oauth/token` using JSON containing
`grant_type: "refresh_token"`, the refresh token and client ID
`app_EMoamEEZ73f0CkXaXp7hrann`. It persists rotated access, refresh and ID
tokens and retains account binding. A broker implementation must own this
operation and persistence entirely outside the agent, reject account
changes and authentication failures, and never expose the token endpoint
or refresh response through an agent route. A synthetic forced-refresh
test and an actual pinned native-client subscription fixture are required;
neither is supplied by this API-key checkpoint.
