# Rootless Podman agent boundary diagnostic

**Status: prepared; hosted execution pending.** Issues #3698 and #3699,
Milestone 122, remain incomplete. This is a prerequisite diagnostic for the
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

The agent must also fail to read the planted credential, broker process
secret or writable broker socket directory, while authenticated synthetic
broker requests succeed. Broker shutdown must yield transport refusal.
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

These are local configuration and assertion tests. No Podman process or
container has run in the local macOS sandbox, so **there is no Podman isolation
result yet**. Hosted evidence must record the source SHA, runtime information,
production arguments, both controls, isolated probe and broker shutdown
before updating this status. Native client fixture evidence is tracked in
the main architecture checkpoint; synthetic inference never proves live
subscription/OAuth refresh, other providers, native git/GitHub, UDP/DNS,
VM sockets or Apple runtime acceptance.

## References

- [Ubuntu 24.04 runner image inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)
  — preinstalled Podman version; the job checks the actual runtime too.
- [Podman info documentation](https://docs.podman.io/en/latest/markdown/podman-info.1.html)
  — `host.security.rootless` JSON and `.Host.Security.Rootless` template.
- [Podman network create documentation](https://docs.podman.io/en/latest/markdown/podman-network-create.1.html)
  — explicit dual-stack subnet flags and internal bridge behaviour.
- [Podman run documentation](https://docs.podman.io/en/latest/markdown/podman-run.1.html)
  — rootless user namespaces and production hardening options.
