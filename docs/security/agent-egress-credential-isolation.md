# Agent egress and credential isolation — implementation checkpoint

**Status: incomplete; do not deploy as the agent containment boundary.**
Milestone 122, Issues #3698 and #3699 remain open. The experimental broker
described below is not invoked by the launchers or the coding-agent runner.
The normal worker still exposes provider credential mounts and the staged
`gh` configuration to the coding agent, and general outbound network access
is unrestricted. THREAT-MODEL R9 and R11 are **not resolved**.

## Architecture decision

Use a credential broker outside the agent's trust boundary, rather than
give the agent even a short-lived upstream token. A short-lived token in
the agent's environment would still fail #3699's acceptance criterion.

The initial candidate put the **whole provider CLI**, including every
subprocess, inside nested Linux user, mount, PID and network namespaces.
The real Docker diagnostic below refused that setup under the production
security flags. It is therefore not the implementation route: access to a
different development host alone would not establish compatibility.

The replacement candidate gives each invocation its own runtime-created
container with `--network none`, separate from the trusted worker and broker.
Only a dedicated broker Unix socket crosses that boundary. Credential mounts,
staged credentials, worker process memory and its environment must never
enter the agent container. The host owns container creation and cancellation;
neither the agent nor its workspace receives the runtime control socket.
Existing capability drops, `no-new-privileges` and security profiles stay in
place. Direct TCP, UDP, DNS and VM sockets require explicit negative tests.
Broker failure must stop the invocation without a network or token fallback.

Native `gh`, git and model clients need either a TLS-intercepting forwarding
proxy with opaque credential sentinels or supported endpoint adapters.
The proxy may replace a sentinel with a real credential only for the exact
authorised upstream and operation. A session capability is local to this
broker/run and must not itself be an upstream credential. It expires when
the broker closes and must not authorise another run's repository.

## Implemented foundation

`worker/deno/lib/credential_broker_policy.ts` is the single allowlist for the
experimental broker. It fixes the HTTPS origins in code; agent requests
cannot supply an origin, change a port or request a CONNECT tunnel.

| Service | Fixed destination | Current permitted operation |
| --- | --- | --- |
| Claude API key | `api.anthropic.com:443` | Messages and token-count POST requests |
| OpenAI API key | `api.openai.com:443` | Responses and chat-completions POST requests |
| DeepSeek API key | `api.deepseek.com:443` | Anthropic-compatible messages and chat-completions POST requests |
| Gemini API key | `generativelanguage.googleapis.com:443` | Generate and stream-generate content POST requests |
| GitHub bearer token | `api.github.com:443` | GET/HEAD under repositories selected by the trusted caller |

`credential_broker.ts` authorises a per-run broker capability before routing,
injects its own credential and discards caller-supplied authentication,
cookies and proxy headers. Request bodies have a byte bound which also applies
to chunked streams. Redirects are refused rather than followed. Upstream
exception messages and authentication response headers are not returned to
the caller. Model response bodies are streamed without whole-response
buffering. A missing credential refuses the request.

The experimental `credential-broker --experimental --port <1024–65535>
--repos <owner/name,...>` command exposes this foundation on **127.0.0.1 only**.
Its broker capability is supplied as `VIBE_BROKER_ACCESS_TOKEN`; provider API
keys and `GH_TOKEN` belong only to this trusted process. It does not print
their values. Exercise it with synthetic credentials and an instrumented
upstream before any native-client integration. Do not use it as a replacement
for the current provider transport: normal agent startup does not select it.

The command does not load subscription logins, accept arbitrary enterprise
endpoints, refresh OAuth tokens, proxy git transport, or permit GitHub writes.
It does not yet filter credential-bearing response bodies or provide a
complete resource budget. Those are explicit readiness gaps, not supported
behaviours to silently remove from the worker.

## Required integration before a milestone PR is ready

1. Implement and prove the separate agent-container lifecycle described
   below, keeping runtime security profiles intact. Pin and verify any proxy
   implementation and its dependency graph. Evaluate the standalone proxy in
   [Anthropic sandbox-runtime v0.0.80](https://github.com/anthropics/sandbox-runtime/releases/tag/v0.0.80),
   rather than assuming its nested namespace wrapper can start. Its own
   configuration is not proof that native clients, OAuth refresh or the
   container boundary work. Do not enable a weaker nested-sandbox mode or
   disable seccomp to obtain a pass.
2. Make the runner create and tear down the boundary and broker together.
   Preserve provider selection, credential-pool isolation, cancellation,
   stdout parsing, the watchdog and run-scoped GitHub policy. A broker that
   survives the invocation must not retain a usable capability.
3. Replace every selected and pooled provider credential, staged `hosts.yml`,
   token environment variable and alternate credential path with a denied
   path or opaque sentinel. Test parent `/proc` access, symlinks, alternate
   mount names, inherited file descriptors and shared state. A mask that fails
   to recognise its input must fail closed, never leave the original readable.
4. Preserve supported subscription authentication without falling back to
   metered API keys. Refresh must happen outside the boundary; renewed access
   and refresh tokens must be masked before any response reaches the agent.
   The current experimental broker intentionally does not implement this.
5. Preserve permitted `gh` and git reads/writes. Enforce the run's repository
   allowlist at the broker and retain reserved-label, publication and pre-push
   controls. Deny credential-minting/token-disclosure endpoints. An allowed
   GitHub hostname alone does not implement repository scope.
6. Establish outbound policy for the package registries and other endpoints
   actual quality gates need. Keep credential-injection destinations narrower
   than download destinations. Resolve and connect to the same validated
   address; reject private, loopback, metadata and rebinding destinations.
   This broker uses fixed HTTPS origins but does not yet pin DNS resolution.
7. Run the matrix below on each runtime, with synthetic credentials and
   harmless fixture endpoints. Record the image digest, runtime version,
   commands, result and date. Only then update C21/C22 and resolve R9/R11.

## Separate-container route under investigation

This is a source-backed design candidate, not a tested implementation.

- **Docker and Podman:** start the agent with `--network none` and share a
  dedicated named-volume directory containing only its broker socket. Run
  the broker within the same runtime VM on Docker Desktop or Podman machine;
  do not assume an arbitrary macOS host Unix socket survives a filesystem
  mount. Keep separate PID namespaces, capability drops, no-new-privileges
  and default security profiles. Rootless uid mapping, socket permissions and
  SELinux shared-volume labels still need runtime tests. The documented
  network modes leave no external network interface; that alone does not
  prove filesystem or credential isolation.
  [Docker none driver](https://docs.docker.com/engine/network/drivers/none/),
  [Podman run reference](https://docs.podman.io/en/latest/markdown/podman-run.1.html).
- **Apple 1.2.2:** its CLI turns the sole `--network none` option into an
  empty attachment list before the macOS 26 custom-network check. Its runtime
  recognises an individually mounted host socket and creates an inbound
  relay; `--publish-socket` creates the reverse relay. A broker container can
  therefore export one socket to the host for a separate agent VM to import.
  This is an inference from the pinned source, requiring a real runtime
  check. A shared directory containing a socket is not the same mechanism.
  [CLI configuration](https://github.com/apple/container/blob/1.2.2/Sources/Services/ContainerAPIService/Client/Utility.swift),
  [socket conversion](https://github.com/apple/container/blob/1.2.2/Sources/Services/RuntimeLinux/Server/RuntimeService.swift).
- **Apple VM transport:** container 1.2.2 pins containerization 0.40.1 at
  `7800b4642171561c95b5f55500b19e5dce5acd45`. Its socket relays use vsock,
  while its container namespace list omits a network namespace. The process
  configuration defaults no-new-privileges to false. Thus an empty IP
  attachment list cannot stand in for denying direct guest vsock access.
  An immutable agent entrypoint must set no-new-privileges and deny direct
  AF_VSOCK use before starting any untrusted process, with actual negative
  tests; the runtime's socket relay remains outside that process. The current
  Apple dialect predates some documented flags, so it must be probed before
  changing its capability or root-filesystem declarations.
  [Pinned dependency](https://github.com/apple/container/blob/1.2.2/Package.resolved),
  [container and relay implementation](https://github.com/apple/containerization/blob/7800b4642171561c95b5f55500b19e5dce5acd45/Sources/Containerization/LinuxContainer.swift),
  [process defaults](https://github.com/apple/containerization/blob/7800b4642171561c95b5f55500b19e5dce5acd45/Sources/Containerization/LinuxProcessConfiguration.swift).

The current host launcher creates one worker container, and `claude_runner`
spawns the provider within it. Moving only a flag cannot create the proposed
trust split. The next integration needs a host-owned invocation supervisor
that accepts bounded run requests from the trusted worker, resolves approved
workspace mounts itself, and streams stdin/stdout/cancellation to a disposable
agent container. A raw Docker socket or arbitrary host-mount request must not
become part of that interface. The agent receives its workspace, sanitised
provider state and broker transport only; the worker's credentials, logs and
private state remain separate.

For native CLIs, sandbox-runtime v0.0.80 documents a standalone TLS proxy with
an external request decider, inherited listener/lifeline descriptors and
validated DNS-address pinning. That component can be evaluated independently
of its nested namespace wrapper. Its documented protocol can authorise a
request and inject headers, but does not establish an OAuth refresh-response
redaction contract. Subscription refresh must remain trusted, and any native
refresh response or token-bearing state must be replaced with an opaque
sentinel before reaching the agent. Preserve each provider's subscription
selection rather than silently switching to API-key billing. Auth-state
format compatibility, repository-scoped GitHub writes and git transport need
native-client fixture tests before this proxy can replace the current paths.
[Standalone proxy contract](https://github.com/anthropics/sandbox-runtime/blob/v0.0.80/docs/srt-proxy.md).

Independent next checks are a two-container Linux socket probe under intact
profiles, deterministic supervisor mount/env validation, and synthetic native
client/refresh fixtures. The Apple relay/vsock checks need a permitted macOS
runtime service. None requires real account secrets, and none alone closes
the milestone.

## Boundary acceptance matrix

All checks run as the actual coding-agent process and its spawned shell,
not merely as a different test container or as the trusted worker. Use a
controlled TLS fixture that the worker can reach immediately before and
after the negative check, so a network outage cannot masquerade as isolation.

| Check | Required outcome | Docker | Podman | Apple container |
| --- | --- | --- | --- | --- |
| Direct TCP to a non-allowlisted reachable IP, with all proxy variables unset | Connection fails; outside control succeeds | Not run | Not run | Not run |
| Direct IPv6, UDP/DNS and VM-socket attempts | No path around the broker | Not run | Not run | Not run |
| Broker request to non-allowlisted origin, encoded path, redirect or private resolved address | Refused without a credential leaving | Not run | Not run | Not run |
| Allowed model request and streaming completion | Succeeds with synthetic upstream authentication; no credential in agent output | Not run | Not run | Not run |
| Supported subscription login and forced refresh | Succeeds; renewed tokens stay outside the agent | Not run | Not run | Not run |
| Permitted `gh`/git operation and cross-repository refusal | Allowed operation succeeds; out-of-scope write fails | Not run | Not run | Not run |
| Read provider mounts, staged gh config, alternate links, worker `/proc`, environment and inherited descriptors | No synthetic upstream credential readable | Not run | Not run | Not run |
| Kill broker, cancel agent and attempt capability reuse | Invocation stops; capability cannot be reused | Not run | Not run | Not run |
| Inspect capabilities, no-new-privileges and writable mounts | Existing containment controls preserved | Not run | Not run | Not run |

GitHub-hosted Linux CI can build a fixture image and exercise Docker; a
separately installed, pinned Podman can exercise its own dialect. Such jobs
need no repository secrets or live provider accounts: synthetic credentials
and controlled local TLS fixture services are sufficient for boundary tests.
They cannot prove actual provider subscription compatibility. Apple requires
a capable macOS host and its runtime service; Docker results cannot stand in
for Apple evidence.

## Evidence from this implementation session

### Observed Docker result — 18 October 2026

[Run 39087588898](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39087588898)
built the production image and passed all 15 handler/evidence tests. The
real-socket step failed at the intended namespace prerequisite:

```text
unshare: unshare failed: Operation not permitted
```

Both ordinary-child controls, before and after that attempt, connected to
the controlled IPv4 and IPv6 listeners and completed the broker's synthetic
model stream and repository-scoped GitHub read. Their effective, permitted
and bounding capability sets were zero, `NoNewPrivs` was 1 and `Seccomp` was
2. The isolated child never started. No profile was relaxed and no successful
isolation or broker-shutdown result is claimed.

Recorded versions were Docker 28.0.4, containerd 2.4.1, runc 1.5.2, Linux
6.17.0-1022-azure on x86_64, util-linux 2.41 and Deno 2.9.6. Docker reported
AppArmor, the builtin seccomp profile and cgroup namespaces. EPERM alone does
not identify which profile, kernel policy or uid-map restriction refused the
operation.

- Source commit: `106c65a8a0550ddd3bc4aaeb3389979c0fce2ac0`.
- Source tree: `cfe2905a0a6175dab82687e681816ccf58054527`.
- Image ID: `sha256:503e5a2819d5ce99e37fef9c4df0413d7ee45aae6c361e5697c466a92ea38ad9`.
- [Job log](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39087588898/job/117557308022)
  and [seven-day artifact](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39087588898/artifacts/12121865384).
- Artifact SHA-256: `9b9d83933d2df205242a6f2e2a959b684e51f6594cf73a8b0cd8bedacd4b6307`.

The result establishes working synthetic broker transport under the existing
outer Docker flags and rejects the nested-namespace prerequisite. It does
not satisfy any integrated agent acceptance row above.

### Linux CI prerequisite diagnostic

The branch-only workflow
[`agent-namespace-probe.yml`](../../.github/workflows/agent-namespace-probe.yml)
runs on a push to `codex/milestone122-validation`. It now records the nested
namespace and separate-container attempts independently, under the name
**Agent Boundary Prerequisite Probes**. It has a read-only token,
does not persist checkout credentials, accepts no repository secrets and
neither publishes an image nor deploys a worker. Its actions and Deno version
reuse the repository's existing pins. The production Containerfile supplies
the image; no unverified namespace package is downloaded for this probe.

The host harness builds the actual `buildContainerLaunchPlan` using empty
synthetic credential directories, a minimal probe-only checkout and fresh
per-run volumes. It replaces only the entrypoint, like the existing
containment/tabletop tests. The normal capability drop, no-new-privileges,
read-only filesystem, bridge mode and default Docker seccomp/AppArmor stay
in place. It records Docker/security versions, image ID, kernel, util-linux
versions, launch arguments and process security state in the CI artifact.

The probe then:

1. Starts controlled IPv4 TCP and IPv6 loopback listeners inside the outer
   container, plus the real broker handler on a Unix socket. A random,
   synthetic upstream credential exists only in the trusted fixture process.
2. Requires an ordinary child to connect directly to both listeners and to
   complete authenticated synthetic model streaming and a repository-scoped
   GitHub read through the socket. Invalid broker capabilities and routes
   must be refused without reaching the upstream fixture.
3. Attempts the same child under `unshare` with new user, mount, PID and
   network namespaces, a fresh proc mount and `setpriv` capability removal.
   If creation succeeds, both direct TCP connections must fail while broker
   operations continue. Namespace IDs must differ; effective, permitted and
   bounding capability sets must be empty; no-new-privileges and seccomp
   filtering must remain set. Proxy variables are absent in both children.
4. Repeats the reachable outside control even when namespace creation fails.
   On a successful boundary run it also stops the broker and requires the old
   capability's transport to become unusable.

An unavailable executable, refused namespace, missing control, privilege
regression or socket failure makes the job fail. There is no weaker retry.
In particular, `Operation not permitted` is evidence of an unmet prerequisite,
not evidence that an agent ran inside an enforced boundary. Docker documents
namespace creation and mounting among its default seccomp restrictions, so
a refusal under the production flags is an expected possible result, not a
reason to switch to an unconfined profile.
[Docker seccomp documentation](https://docs.docker.com/engine/security/seccomp/).

The tested namespace setup needs `unshare` for `CLONE_NEWUSER`, `CLONE_NEWNS`,
`CLONE_NEWNET` and `CLONE_NEWPID`, single-ID uid/gid map writes (with
`setgroups` denied), child creation, and private proc/mount setup. It needs
capabilities in the newly created user namespace during setup, then drops
all of them before the probe executes. Kernel user namespaces and the host
LSM must permit that setup; `no-new-privileges` remains inherited. No outer
container capability is added. This list identifies the prerequisite, not a
reviewed production seccomp allowlist: a real sandbox dependency may need
additional calls such as bind mounts, `pivot_root`, or its own seccomp
installation. The workflow changes no profiles or host sysctls.
[unshare manual](https://man7.org/linux/man-pages/man1/unshare.1.html),
[user namespace capabilities](https://man7.org/linux/man-pages/man7/user_namespaces.7.html),
[setpriv manual](https://man7.org/linux/man-pages/man1/setpriv.1.html).

Even a green result proves only this Linux prerequisite and synthetic socket
transport. It does not test the selected sandbox-runtime dependency, TLS,
DNS/rebinding, UDP, VM sockets, a hostile native CLI, hidden credential
mounts/environment/process descriptors, OAuth refresh, GitHub writes, Podman
or Apple. The fixture's local HTTP forwarding seam deliberately avoids real
provider accounts and internet requests. The milestone acceptance matrix
above remains **Not run** until the integrated production boundary is tested.

### Separate-container diagnostic — observed on Docker

The second workflow step uses the same production image and launch-plan
builder for a trusted broker and a separate agent. Its narrow, recorded
launch delta removes every provider/GitHub credential mount, changes the
agent network to `none`, and adds one dedicated socket volume. The agent
mounts that volume read-only. The two roles receive distinct synthetic
checkouts, configuration, work and state volumes; the socket is their only
shared mount. Capability drops, no-new-privileges, read-only roots, tmpfs
options and Docker's default profiles are retained.

The broker attaches to a disposable **internal**, IPv6-enabled bridge. No
port is published and no internet service is called. If that bridge or its
non-loopback IPv6 address is unavailable, the attempt fails with prerequisite
evidence; there is no host-sysctl, profile or IPv4-only fallback. The ordinary
controls run inside the broker container immediately before and after the
agent attempt and connect to the exact IPv4 and IPv6 addresses tested by the
agent. A refused or missing control cannot count as agent isolation.

The trusted launcher generates one random synthetic credential, writes it
only in the broker's private `/tmp`, and starts its server with the value in
the server's initial environment. Positive witnesses hash the private file,
`/proc/self/environ` and an open regular descriptor. Only its hash and
non-secret fixture metadata reach the agent. The agent checks the private
path and `/proc/*/root` aliases, hashes recognised fixture values in its own
environment, readable process environments and regular descriptors up to
1 MiB, and checks actual mount information for an absent credential mount
and read-only root/socket mounts. A readable source descriptor supplies a
positive control for the descriptor scan. Contents and the credential value
are never logged. This is a planted-credential probe, not an exhaustive scan
of every file, encoding, descriptor type or possible exfiltration channel.

The same production broker handler must complete synthetic model streaming
and the selected-repository GitHub read; invalid capabilities and routes must
fail before forwarding. Six authenticated fixture requests are expected:
two per outside control and two from the agent. The host then stops the
broker and starts a fresh network-none process with the old metadata; the
Unix transport must refuse connection. That last check proves transport
loss, not a production watchdog's cancellation or capability-expiry policy.

The nested namespace step retains its failure outcome and log without
skipping the separate-container step. The workflow summary records both
outcomes, and the seven-day `agent-boundary-prerequisites` artifact retains
both logs.

On 18 October 2026, [run 39090033070](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39090033070)
([job 117564637157](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39090033070/job/117564637157))
passed the separate-container diagnostic at commit
`e3d943462d1afad13e3caa881a63d933fa1097e3`, tree
`ddd8c368b27dd4c5186bbbc1a9e6199596614816`. The image was
`sha256:53044e887135332cc1ae8f34211b3529d489d5f14bbd441d843583c02c54bf6c`.
Docker's default AppArmor and seccomp profiles were retained. The log recorded:

- Reachable IPv4 and IPv6 controls before and after; both agent TCP attempts
  failed against those same addresses.
- Separate agent network, PID and mount namespaces; zero effective, permitted
  and bounding capabilities, `NoNewPrivs: 1` and `Seccomp: 2` for all roles.
  Docker's user namespace remained shared; no user-namespace separation is claimed.
- Read-only agent root and socket mount, no proxy variables, an unreadable
  broker-private path and zero recognised planted-secret matches. One readable
  process environment and one regular descriptor supplied positive scan controls.
- Positive broker file, initial-environment and descriptor witnesses, exactly
  six authenticated upstream requests and refused transport after broker stop.

The nested attempt still returned `unshare: Operation not permitted`. Its step
outcome was `failure`; `continue-on-error` changed its conclusion, not the
observed result. [Artifact 12122072765](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39090033070/artifacts/12122072765)
retains both logs until 25 October, with digest
`sha256:fdf7fb02ecdca248399cab7641c9d1cca62eb965a396edb7ee62b3a2d3ae11cc`.
This proves the recorded Docker construction with synthetic fixtures. Native
CLIs, live OAuth, TLS, DNS, UDP, VM sockets, GitHub writes, Podman and Apple
remain separate acceptance requirements, as does production integration.

### Native Anthropic adapter — prepared for runtime validation

`anthropic_agent_gateway.ts` provides a fixed Unix-socket forwarder and an
ephemeral agent-loopback endpoint for the native CLI. Its fresh environment
contains one local capability, in the variable appropriate to API-key,
subscription or bearer mode; it accepts no parent environment or upstream
credential. The trusted broker selects the upstream authentication mode and
never retries subscription authentication with an API key. Normal worker
startup has **not** adopted this adapter.

The [official gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
documents inference's `?beta=true`, required version/capability headers,
streaming and retry/usage response headers. Both hops preserve the open
`anthropic-*` request-header namespace so future capability/body pairs survive;
upstream `Authorization` and `x-api-key` remain broker-injected. The request
body is unchanged and route, origin and query policies remain closed. The
[subscription guidance](https://code.claude.com/docs/en/llm-gateway#subscriptions-and-gateways)
distinguishes a subscription login from a gateway API credential; the adapter
retains the subscription variable rather than substituting an API-key mode.
The [environment reference](https://code.claude.com/docs/en/env-vars)
states that an explicit `CLAUDE_CODE_OAUTH_TOKEN` lasts for the session and
requires replacement and restart when expired. This does not establish Codex's
separate refresh-token contract or validate a live Claude subscription.

The next diagnostic invokes the image's pinned Claude binary twice in fresh,
network-none containers: API-key mode and subscription-variable mode. Each
gets an independently configured local capability. The synthetic upstream
requires the corresponding injected authentication, and requires the native
OAuth capability header in subscription mode, before returning a complete SSE
response. The native result and upstream request witnesses must both confirm
inference. These attempts are **not yet run** and cannot prove live account
acceptance, billing, token refresh, other providers or production lifecycle.

### Remaining production integration

The host supervisor must create each agent's broker capability, dedicated
checkout/state scope and container lifecycle without exposing a runtime
control socket to either the agent or repository code. Reusing the worker's
whole work volume would expose other checkouts and state. Repository-defined
quality commands need the same credential-free execution boundary: their
current optional `sudo` account drop can fall back to the worker account.
Upstream credentials belong only to the trusted broker, including refresh
state; agent-writeable code must never execute beside them.

After that boundary, provider-specific adapters must preserve native model,
subscription, pool and resume behaviour; scoped `gh`/git operations must retain
the existing write gates without accepting arbitrary trusted-side commands.
Runner stdin/stdout, cancellation, timeouts, retries and broker expiry then
need integration tests. Docker, Podman and Apple's VM/socket transport each
need the full denial and credential-visibility matrix before fail-closed
launch becomes the default. R9 and R11 remain open until that evidence exists.

### Local evidence

- Base: `a900fa7b68486ab83562887d66675be6d5cc3535`.
- Apple CLI reports version 1.2.2. Its service probe, `container system status`,
  fails with `Operation not permitted` under the session's sandbox. No attempt
  was made to bypass that denial. Docker and Podman executables are absent.
- The npm registry cannot resolve from this shell; the namespace dependency
  has not been fetched, installed or exercised. Published source and release
  notes were inspected, which is architecture evidence only.
- A real loopback HTTP smoke test with synthetic credentials was attempted,
  but `Deno.serve` failed with `PermissionDenied: Operation not permitted`
  before the first fixture listener started. It is not a passed HTTP or
  network-isolation check; local listener access is also unavailable here.
- Broker behaviour is covered by executable Request/Response tests with
  synthetic credentials and an injected forwarding transport. These establish
  routing, header injection, repository selection, redirect refusal, body
  limits and streaming behaviour. They do **not** establish network-layer
  isolation, native CLI compatibility or the three dialects' behaviour.
- The Linux diagnostic ran on CI with the refused-namespace result above. Local validation
  passed its evidence-judge and broker tests, type checking, formatting,
  linting, actionlint, zizmor and the supply-chain gate. Removing each of the
  namespace, direct-TCP, capability, outside-control and seccomp guards made
  the evidence tests fail. Those checks validate the harness, not a running
  container or broker socket.
- The separate-container evidence, launch-delta and credential-fingerprint
  tests pass locally alongside the existing broker and namespace tests
  (18 total). Both new fixtures type-check; formatting, lint, actionlint,
  zizmor and the supply-chain gate pass. Eleven mutations removing credential
  mount removal, read-only mounts, network-none selection, reachable controls,
  hardening, secret visibility/planting, request-count or fingerprint checks
  were rejected by executable assertions in an isolated copy. These checks
  validate the diagnostic; the real Docker result is recorded separately above.
- Native transport adds seven adapter tests and one broker authentication
  regression, taking the focused suite to 26 tests. The future-header case
  first failed with a missing forwarded value, then passed after both hops
  preserved the protocol namespace. Fifteen isolated mutations of query,
  service, authentication, header, environment, cancellation and safe-error
  behaviour were rejected by assertions. Real pinned-client execution remains
  pending the next branch-only workflow run.

See the [original gap analysis](agent-containment-gap-analysis.md) and
[threat model](../THREAT-MODEL.md). Neither existing `gh` write gates nor the
experimental broker make unrestricted container egress safe on their own.
