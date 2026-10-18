# Rootless Podman agent boundary diagnostic

**Status: hosted rootless prerequisite passed on 2026-10-18; production
integration remains incomplete.** This result does not close Issues #3698
and #3699 or establish Milestone 122 acceptance. This is a prerequisite
diagnostic for the
[separate-container candidate](agent-egress-credential-isolation.md), not a
production launcher change or a claim that credentials and egress are isolated
in normal worker runs.

## Runtime and boundary

The temporary `codex/milestone122-validation` workflow adds an independent
`podman-prerequisite` job on `ubuntu-24.04`. It verifies the preinstalled
Podman is exactly **4.9.3** and that runtime information reports rootless
operation. The Ubuntu 24.04 runner image inventory lists that version;
this check fails if the hosted image changes. No package is installed from
a floating package source and the job never retries as root.

The same `agent_container_probe_cli.ts` takes an optional second argument,
`docker` or `podman`. Docker remains the default. The probe uses the selected
production runtime descriptor and `buildContainerLaunchPlan`, including
Podman's `U` spelling for owned tmpfs mounts. The only diagnostic launch
changes remain the previously documented separate network and credential
mount removal. Capability drops, `no-new-privileges`, read-only root and the
runtime's default security profiles stay intact.

Podman reports runtime security under JSON `host.security`; Docker reports
`SecurityOptions`. The probe logs the appropriate field and additionally
rejects Podman unless `host.security.rootless` is the boolean `true`.
The disposable internal bridge has explicit IPv4 and ULA IPv6 subnets:
Podman's automatic dual-stack allocation applies only when no subnets are
specified. Both families retain their actual before/after positive controls,
and the network-none agent must fail both direct connection attempts.
A conflicting subnet or unavailable IPv6 prerequisite fails the diagnostic.

The agent must also fail to read the planted credential or broker process
secret, and must not write to the broker socket directory, while authenticated
synthetic broker requests succeed. Broker shutdown must yield transport refusal.
Only synthetic secrets are used. No runtime socket, real provider credential,
host sysctl change or unconfined security profile enters the diagnostic.

## Reproduction and evidence

On the supported Linux runner, after building the production image with
rootless Podman, the diagnostic command is:

```sh
cd worker/deno
deno run --frozen --lock=deno.lock \
  --allow-read --allow-write --allow-env --allow-run \
  tests/fixtures/agent_container_probe_cli.ts vibe-coder:podman-probe podman
```

The workflow retains runtime information and complete probe output in the
`agent-podman-boundary-prerequisites` artifact for seven days, including
failed prerequisites. The job and probe failures propagate to the workflow.
The original Docker diagnostic remains a separate job.

### Hosted result

[Run 39091351843](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39091351843)
and its [Podman job 117568606043](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39091351843/job/117568606043)
completed successfully against immutable source
[`b608b1e2ce141e7b10ddf10956f0ab296e366fcc`](https://github.com/stSoftwareAU/VibeCoder/commit/b608b1e2ce141e7b10ddf10956f0ab296e366fcc).
The production image built by rootless Podman had image ID
`001c2a722f990a22e8dae416667a40dbb21e8845743f8772ad40a770f8d2981c`.

The runtime reported **Podman 4.9.3, rootless true, seccomp enabled** with
`/usr/share/containers/seccomp.json`. It reported AppArmor and SELinux disabled
by the hosted runner's defaults. This proves compatibility with that recorded
profile, not an AppArmor or SELinux enforcement result. No rootful fallback,
host sysctl change or unconfined profile was used.

| Observation | Recorded result |
| --- | --- |
| Disposable internal bridge | IPv4 `10.151.100.0/24` and IPv6 `fd97:64d5:1f1::/64`; `internal` and `ipv6_enabled` both true |
| Production launch arguments | Both containers retain `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` and the owned secret tmpfs `mode=0700,U`; agent network is `none` |
| Before and after controls | Both direct IPv4 and IPv6 connections succeed, and authenticated broker requests pass |
| Isolated agent | Both direct IPv4 and IPv6 connections fail; network, PID and mount namespaces differ from the broker |
| In-container hardening | Effective, permitted and bounding capabilities are zero; `noNewPrivileges: 1`, `seccomp: 2`, root and socket directory read-only |
| Credential visibility | Private credential path unreadable, zero synthetic secret matches, one process environment and one regular descriptor inspected; no proxy variables present |
| Broker credential witness | Planted file, environment and descriptor all match; exactly six authenticated synthetic requests |
| Installed Claude fixtures | Both API-key and subscription modes complete; neither exposes the upstream credential; one authenticated upstream fixture request per mode |
| Broker shutdown | A fresh isolated client records `brokerTransportUnavailable: true` |

Evidence is retained in artifact
[`agent-podman-boundary-prerequisites` (12123315137)](https://github.com/stSoftwareAU/VibeCoder/actions/runs/39091351843/artifacts/12123315137),
with SHA-256
`1f501997e8a66286bfd77aa0942484ac996290605fe42dbaacf2d2801d4a2cf5`.
The artifact contains the runtime information and full probe log, including
both controls, production arguments, native client results and broker shutdown.
The digest identifies the uploaded artifact archive; it is not a source or
container-image digest.

The separate Docker job in this same run also completed its container and
native-client probes. Its nested-namespace diagnostic recorded
`unshare: unshare failed: Operation not permitted` with exit code 1. The green
workflow does **not** mean nested user namespaces became available.

### Local regression evidence

Local test evidence on 2026-10-18:

- Selecting Podman with the old Docker-only helper failed the exact runtime
  assertion; implementing registry selection made it pass.
- Using Docker's security field for Podman failed the documented-shape test;
  recording `host.security` and requiring `rootless: true` made it pass.
- An IPv6-only explicit subnet failed the dual-stack network argument test;
  adding the independent IPv4 subnet made it pass.
- The absent Podman job failed the workflow validator. The added job passes
  the positive check and mutation cases for runtime, rootless evidence,
  failure propagation, image build, probe selection and retained artifacts.
- The shared evidence judge and launch assertions run unchanged for both
  runtime dialects. A Podman launch regression additionally checks tmpfs
  ownership uses `U`, with no raw `uid=` or `gid=` options.

The integrated checkpoint passed 39 focused tests with the workflow's actual
`--allow-read --allow-env` permissions, plus type checking, formatting, lint,
Markdown lint, actionlint and zizmor. Podman itself was exercised on the hosted
Linux runner; no container ran in the local macOS sandbox.

### Limits

This diagnostic proves the recorded separate-container prerequisite and
installed Claude inference against synthetic API-key and subscription
fixtures. It does not exercise real provider credentials or a live upstream
service, and does not prove subscription/OAuth refresh, other providers,
native git/GitHub, UDP/DNS, VM sockets or Apple runtime acceptance. The normal
worker is not switched to this boundary by the diagnostic. Production
integration and acceptance remain tracked in the
[architecture checkpoint](agent-egress-credential-isolation.md).

## References

- [Ubuntu 24.04 runner image inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)
  — preinstalled Podman version; the job checks the actual runtime too.
- [Podman info documentation](https://docs.podman.io/en/latest/markdown/podman-info.1.html)
  — `host.security.rootless` JSON and `.Host.Security.Rootless` template.
- [Podman network create documentation](https://docs.podman.io/en/latest/markdown/podman-network-create.1.html)
  — explicit dual-stack subnet flags and internal bridge behaviour.
- [Podman run documentation](https://docs.podman.io/en/latest/markdown/podman-run.1.html)
  — rootless user namespaces and production hardening options.
