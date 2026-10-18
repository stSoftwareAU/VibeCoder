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

The intended boundary is a per-invocation Linux user, mount, PID and network
namespace around the **whole provider CLI**, including every subprocess it
starts. The worker and broker remain outside that boundary. Credential
mounts, staged credentials, worker process memory and its environment must
not be reachable from the namespace. Direct TCP, UDP, DNS and VM sockets
must be blocked there; only the broker transport is exposed. Broker failure
must stop the invocation, without a direct-network or real-token fallback.

This uses the same Linux boundary inside Docker, Podman and Apple container's
VM. It does not rely on `HTTP_PROXY`, CLI tool permissions or shell shims to
enforce isolation. Existing dropped capabilities, `no-new-privileges` and
read-only mounts remain requirements; removing them to make a wrapper start
would not establish the promised boundary.

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

1. Pin and verify a namespace/proxy implementation in the image and its
   dependency graph. Evaluate
   [Anthropic sandbox-runtime v0.0.80](https://github.com/anthropics/sandbox-runtime/releases/tag/v0.0.80),
   which supplies Linux namespaces, credential masking and TLS termination.
   Its own configuration is not proof that the boundary holds on our images.
   Do not use its weaker nested-sandbox mode. The release changes namespace
   behaviour, so Chromium, nested build tools and Docker seccomp compatibility
   need explicit checks. Do not disable seccomp globally to obtain a pass.
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

### Linux CI prerequisite diagnostic

The branch-only workflow
[`agent-namespace-probe.yml`](../../.github/workflows/agent-namespace-probe.yml)
runs on a push to `codex/milestone122-validation`. It has a read-only token,
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
- The Linux diagnostic is prepared but has not run on CI. Local validation
  passed its evidence-judge and broker tests, type checking, formatting,
  linting, actionlint, zizmor and the supply-chain gate. Removing each of the
  namespace, direct-TCP, capability, outside-control and seccomp guards made
  the evidence tests fail. Those checks validate the harness, not a running
  container or broker socket.

See the [original gap analysis](agent-containment-gap-analysis.md) and
[threat model](../THREAT-MODEL.md). Neither existing `gh` write gates nor the
experimental broker make unrestricted container egress safe on their own.
