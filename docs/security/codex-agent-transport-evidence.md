# Codex transport through the credential broker

## Status and scope

This is an experimental API-key adapter for Issues #3698 and #3699. It is
not wired into the normal worker launcher. The pinned API-key native fixture
passed on Docker and rootless Podman; see the observed run below. The separate
trusted ChatGPT subscription transport has local tests, but has not been
proved with the actual native client. The API-key gateway still refuses a
subscription selection rather than silently changing billing mode. This
checkpoint does not resolve the milestone's full containment or subscription
acceptance criteria.

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

The native JSONL expectations were first derived from pinned source and then
exercised by the hosted API-key run below. Unit tests alone do not establish
real API billing, model entitlement, ChatGPT subscription compatibility,
token refresh or the container boundary.

## Observed API-key native result

[Run 39098480148](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39098480148)
tested source `210e4f8b` with the actual installed Codex 0.147.0 client.
Both [Docker](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39098480148/job/117589712287)
and [rootless Podman](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39098480148/job/117589712443)
completed the synthetic response, matched the installed version, reported
API-key mode and found no planted upstream credential in the native output.
Each broker recorded exactly one authenticated Codex request. The combined
probe also recorded one Gemini request, two native GitHub requests and one
request for each Claude authentication mode; broker shutdown refused further
transport. These are synthetic fixture results, not live provider requests
or ChatGPT subscription evidence.

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
test and an actual pinned native-client subscription fixture are required.

## Trusted subscription transport checkpoint

`worker/deno/lib/codex_subscription_transport.ts` implements only the trusted
forwarding and refresh half. Its `createCodexSubscriptionTransport` accepts a
host-selected auth JSON string, immutable expected account ID, session abort
signal and persistence callback. The outer broker must first enforce its
run capability, lease and request-body limit. The transport additionally
accepts only a POST to the fixed ChatGPT Responses URL, caps buffered request
bodies at 16 MiB, and refuses redirects. It has no API-key option or fallback.

The parser supports file-backed `chatgpt` state and its legacy omitted mode,
with `OPENAI_API_KEY` absent/null. Competing authentication modes are refused.
`tokens.account_id` and the account claims in both access and ID JWTs must
match the selected account. Missing account claims, malformed token/date
fields and snapshots over 128 KiB fail closed. These are consistency checks
on state obtained by the trusted host and fixed HTTPS refresh endpoint; they
are not JWT signature verification or a general-purpose login verifier.
The narrower supported subset does not include externally refreshed
`chatgptauthtokens`, device identity, personal access tokens or keyring loading.

Refresh follows the pinned client's five-minute access-token expiry window,
or its eight-day age threshold when the token has no expiry. One pending
refresh is shared by concurrent requests; a late 401 for an old snapshot
uses the already-persisted replacement. A request retries authentication at
most once. Refresh responses are bounded to 128 KiB and must contain a valid,
same-account replacement access token. Optional ID/refresh tokens rotate when
present and retain their previous values when absent. The trusted selected
account's FedRAMP claim controls its routing header.

The persistence callback receives `{ expectedAuthJson, authJson, signal }`.
The host must serialise writers to one account store, atomically compare the
expected snapshot, and replace it only while that signal remains live.
Returning success means the replacement is durable. The transport waits for
that result before publishing its new immutable snapshot. It rechecks
cancellation after persistence; a late callback completion after shutdown
cannot start an inference request. A refresh or persistence failure latches
the transport closed and aborts other request bodies and response streams.
The callback contract is not itself a disk-persistence implementation.

Pinned [default client headers](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/login/src/auth/default_client.rs),
[session headers](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/codex-api/src/requests/headers.rs)
and [Responses metadata](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/responses_metadata.rs)
define `CODEX_SUBSCRIPTION_METADATA_HEADERS`. Outer adapters must preserve
this exact HTTP metadata set, including originator, User-Agent, version and
session/turn identity. Returned `x-codex-turn-state` survives for sticky
routing. Authentication, account/organisation/project selection, actor
authorisation, proxy and residency headers are not taken from the agent.
The pinned client's `OpenAI-Beta` value belongs to its WebSocket handshake;
this HTTP-only checkpoint does not enable that transport or header.

Local tests cover selected-account routing, fixed refresh payloads, rotated
state, simultaneous and late 401 responses, persistence failure, cancellation
during refresh/persistence, pending-request cancellation, size bounds,
protocol metadata and refused token-bearing errors. Deliberately breaking
the account, refresh, persistence, routing, metadata or size guards makes
the relevant tests fail. Native ChatGPT configuration, authenticated outer
broker dispatch, atomic host persistence and synthetic forced-refresh proof
remain integration requirements. Subscription support must not be claimed
from the API-key native result.
