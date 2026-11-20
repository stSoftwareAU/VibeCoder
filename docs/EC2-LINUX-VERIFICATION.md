# 🐧 Linux Verification Host

The launcher's Linux branch probes Docker, then Podman
([Deployment](DEPLOYMENT.md#-requirements)), but the maintainer develops on
macOS — so that branch has never been confirmed on a real Linux host. This
page is the throwaway host that confirms it: one CloudFormation stack, one
Ubuntu 24.04 instance, reachable **only** through SSM Session Manager, with
the host-side prerequisites already installed.

The template is
[`infra/cloudformation/linux-verification-host.yaml`](../infra/cloudformation/linux-verification-host.yaml).
Everything below is done by hand over the session — there is no automated CI
check for this path, and that is the point: it exercises the documented manual
route in [Setup](SETUP.md#linux-debianubuntu-as-the-worked-example) exactly as
a reader would follow it.

## Testing the template against AWS Emulator (Issue #5110)

The template is tested against the official AWS Emulator. Floci no longer runs
any VibeCoder test. The reference command is
[`infra/cloudformation/test-aws-emulator.sh`](../infra/cloudformation/test-aws-emulator.sh).
Run it as `agent` in the worker container, or as any non-root account other
than `vibe`. The script re-execs itself under `aws-emulator-run --timeout 900`,
which starts a private loopback HTTPS emulator with a per-run CA, telemetry off
and emulator-only credentials. `vibe` is always refused by `aws-emulator-run`,
so the pre-push gate cannot run this check and CI is the enforcing gate.
(The gate's separate Floci check, Issue #3727, still serves a repository that
tracks `test-floci.sh`; VibeCoder no longer does.)

CI runs the same script in
[`.github/workflows/aws-emulator.yml`](../.github/workflows/aws-emulator.yml)
("AWS Emulator CloudFormation"). The workflow installs the pinned aws-emulator
1.0.385 through
[`container/toolchains/aws-emulator.sh`](../container/toolchains/aws-emulator.sh),
with its sha256 pins from [`container/tools.json`](../container/tools.json), and
installs the helper too. It also replaces the runner's own aws-cli with the
pinned one through
[`container/toolchains/aws-cli.sh`](../container/toolchains/aws-cli.sh). It is
a reusable workflow that
[`quality.yml`](../.github/workflows/quality.yml) calls as the `aws-emulator`
job, which the required `gate` job needs. There is no path filter: it runs on
every pull request to `Develop`, `main` and `milestone/*` (drafts run when
marked ready), and a failed, cancelled or skipped run turns `gate` red. It
needs no Docker socket and no service container.

The required `container` check in
[`.github/workflows/container-build.yml`](../.github/workflows/container-build.yml)
also starts a fresh container from the image it has just built and runs the
same script there as `agent` (`docker run --rm --user agent` with
`infra/cloudformation` mounted read-only as the entrypoint's directory). This
runs whenever that job builds the image: a pull request with an image-affecting
change (`.github/scripts/detect-image-changes.sh`), the scheduled sweep or a
manual run. Its exit status fails the check.
`checkContainerBuildRunsAwsEmulator` in
[`worker/deno/lib/aws_emulator_workflow_check.ts`](../worker/deno/lib/aws_emulator_workflow_check.ts)
holds that step's text to its contract. The step must use exactly one
read-only volume holding the entrypoint and no flag outside `--rm`, `--user`,
`--volume` and `--entrypoint`. The step sets no `env:`. The job and workflow
`env:` set none of `BASH_ENV`, `ENV`, `PATH` or the `DOCKER_*` connection
variables. The job takes `IMAGE_CHANGED` from the change detector, an earlier
step runs `docker build -t "${IMAGE}"`, and no step names `GITHUB_ENV` or
`GITHUB_PATH`. It is a text check, so it does not catch everything. It misses
an indirect write to those files, a step that rewrites the checked-out script
or replaces docker or its context, and a retag the check does not recognise. It
also does not check the `changes` job that sets `IMAGE_CHANGED`.

```mermaid
flowchart LR
    S["test-aws-emulator.sh"] --> R["aws-emulator-run<br/>--timeout 900"]
    R --> M["SSM round trip<br/>write, read, delete, ParameterNotFound"]
    M --> D["Deploy every template<br/>--on-failure DO_NOTHING"]
    D --> P["Property checks<br/>per created resource"]
    P --> G["UNSUPPORTED gap report<br/>not proven"]
    G --> C["Delete stack<br/>cleanup check"]
```

### What is proven

- An SSM parameter write, read and delete round trip, plus the negative case:
  reading the deleted parameter must fail with `ParameterNotFound`.
- Every template in `infra/cloudformation/` is deployed with
  `--on-failure DO_NOTHING`, so resources that do create are kept and checked
  even when a named gap fails.
- The material properties of each created resource are checked (see the
  coverage table).
- The stack is deleted and cleanup is checked.
- The script exits non-zero on any failure, on a missing runner or CLI, or when
  a named gap's observed failure changes.

### Coverage on aws-emulator 1.0.385

| Resource type | Result | Notes |
| --- | --- | --- |
| `AWS::EC2::VPC` | Created, properties checked | |
| `AWS::EC2::InternetGateway`, `AWS::EC2::VPCGatewayAttachment` | Created, properties checked | The gateway's attachment VpcId and State are checked through `describe-internet-gateways` |
| `AWS::EC2::Subnet`, `AWS::EC2::RouteTable`, `AWS::EC2::Route`, `AWS::EC2::SubnetRouteTableAssociation` | Created, properties checked | |
| `AWS::EC2::SecurityGroup` | Created, properties checked | Egress descriptions must not contain em dashes (see below) |
| `AWS::IAM::Role`, `AWS::IAM::InstanceProfile` | Created, properties checked | Permissions are not proven (real AWS only) |
| `AWS::EC2::Instance` (`VerificationHost`) | Named gap, fails | Not proven; see the next section |

| Behaviour | Status |
| --- | --- |
| SSM write, read, delete and `ParameterNotFound` | Proven |
| Public `/aws/service/...` SSM parameter | Not proven: it cannot be seeded (`ParameterPatternMismatchException`), so the test supplies the AMI parameter value itself |
| IAM and KMS permissions | Real AWS only |
| Real deployment and runtime compatibility | Real AWS only |
| Cross-account and cross-Region behaviour | Real AWS only |

### Named gap: `VerificationHost`

`VerificationHost` (`AWS::EC2::Instance`) fails on this emulator with
`this emulator does not apply the MetadataOptions property of AWS::EC2::Instance`.
The script reports it in the separate `UNSUPPORTED (not proven, named gaps)`
block and does not count it as a pass. Validate the instance another way:

- the checkov static scan in `.github/workflows/checkov.yml`;
- the repo's template tests;
- a real-AWS deployment by the manual route in [Launch](#launch).

Recheck the gap whenever the aws-emulator pin in `container/tools.json`
changes. The script fails if the observed failure changes, so a pin that fixes
or alters the gap is caught and the gap entry must then be re-assessed.

### Defect the emulator caught

The emulator found em dashes (—) in the `Description` of three security-group
egress rules, which EC2 rejects. They are fixed in this change. Floci had
accepted them, so the Floci run never showed the defect.

## 📋 Table of Contents

- [Testing the template against AWS Emulator](#testing-the-template-against-aws-emulator-issue-5110)
- [What the stack creates](#what-the-stack-creates)
- [Before you launch](#before-you-launch)
- [Launch](#launch)
- [Connect](#connect)
- [Verify the launcher](#verify-the-launcher)
- [Faults to expect, not to patch](#faults-to-expect-not-to-patch)
- [Auto-stop and tear-down](#auto-stop-and-tear-down)
- [What the template deliberately does not do](#what-the-template-deliberately-does-not-do)

## What the stack creates

| Resource | Why |
| --- | --- |
| VPC, one public subnet, internet gateway, route table | Self-contained — no dependency on a default VPC that may not exist |
| Security group with **no inbound rules** and five outbound rules (443, 80, DNS, NTP) | The SSM agent dials out; nothing dials in |
| IAM role with `AmazonSSMManagedInstanceCore`, and an instance profile | The one permission Session Manager needs, and no other |
| One `t3.large` Ubuntu 24.04 instance, 100 GiB encrypted gp3 root, IMDSv2 required | The host under test |
| User data that installs `git`, `gh`, `jq`, `podman` and Deno, then clones the checkout | The documented Linux prerequisites — nothing else. No coding-agent CLI by default: the agent runs inside the image, and a Codex-only verification requires a host with **no** Claude CLI present (`HostAgentCli=claude` installs one when you are verifying a Claude deployment) |

```mermaid
flowchart LR
    O["🧑‍💻 Operator"] -->|"aws ssm start-session"| SSM["AWS Systems Manager"]
    SSM -.->|"agent polls out<br/>over 443"| H
    H["🐧 EC2 host<br/>no inbound rules<br/>no key pair"] -->|"443 / 80 / DNS / NTP"| I["🌐 GitHub, mirrors,<br/>registries"]
    H --> P["📦 podman<br/>worker image + container"]
    style H fill:#2d6a4f,stroke:#1b4332,color:#fff
    style P fill:#1d3557,stroke:#0d1b2a,color:#fff
```

## Before you launch

- An AWS account and credentials with permission to create the stack
  (`CAPABILITY_IAM` is required — the stack creates one role).
- The [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
  for the AWS CLI, on your own machine.
- The GitHub, Anthropic (or other provider) credentials you will type into the
  session. **Nothing goes in the template**: it carries no credential, and
  neither does the user data.
- Outbound access is limited to HTTPS, HTTP, DNS and NTP — there is no
  outbound SSH, so `gh` and `git` must authenticate over HTTPS.

## Launch

Run from the repository root, so the template path resolves:

```bash
aws cloudformation deploy \
  --template-file infra/cloudformation/linux-verification-host.yaml \
  --stack-name vibe-linux-verification \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides AutoStopHours=8
```

Parameters worth overriding: `InstanceType`, `RootVolumeSizeGb`,
`AutoStopHours`, `VibeCoderRepositoryUrl` when verifying a fork, and
`HostAgentCli=claude` when the deployment under test runs Claude rather than
Codex — the default installs no agent CLI at all. Then read
the outputs — the instance id and the ready-made session command:

```bash
aws cloudformation describe-stacks \
  --stack-name vibe-linux-verification \
  --query 'Stacks[0].Outputs' --output table
```

**`VibeCoderRepositoryUrl` must be a plain HTTPS clone URL, with no
credential in it.** The template interpolates the value into the bootstrap's
`git clone` command line, so it accepts only the characters a clone URL needs
— letters, digits and `. _ ~ : / @ % + -`. A URL carrying a shell
metacharacter is refused at deploy time rather than reaching the host's root
shell. A credential embedded as `https://user:token@…` would also be visible
three ways — in `describe-stacks`, in the rendered user data, and in the
stack's history — so verify a private fork by cloning it yourself in the
session after `gh auth login`, not by putting a token in this parameter.

## Connect

```bash
aws ssm start-session --target i-0123456789abcdef0
```

The instance takes a couple of minutes to register with Systems Manager and a
few more to finish its bootstrap. **Read the bootstrap status first** — the
user data records its outcome there rather than failing silently:

```bash
cat /var/log/vibe-bootstrap.status   # RUNNING | OK | FAILED at line N
sudo tail -50 /var/log/vibe-bootstrap.log
```

Anything other than `OK` means the prerequisites are incomplete; the log names
the failing command. Then take the session's shell as the `ubuntu` user:

```bash
sudo -iu ubuntu
cd ~/vibe-coder-runtime
podman --version && deno --version && gh --version && git --version
```

## Verify the launcher

The bar is the full cycle, not just a green setup: `setup.sh` completes,
`run.sh` builds the image **with podman**, the container starts, and the worker
takes one issue end to end — with **no** manual workaround anywhere. That run is
scripted (Issue #736), so its output is comparable between attempts and a later
regression is caught by running it again against a fresh host:

```bash
# Authenticate GitHub first. Choose HTTPS when asked: the host has no outbound
# SSH, so a git-over-SSH remote would hang.
gh auth login

# The whole cycle, recorded. Run it on the session's terminal with no stdin
# redirect: every credential and configuration prompt in setup.sh is behind a
# TTY check, and the script attaches your terminal to it (through util-linux
# `script`) so you answer live and the transcript is still captured.
infra/verify/first-run.sh
```

It runs seven stages — `./setup.sh` at stage 3, `./run.sh` at stage 5 — and
records each one's output under the transcript directory, then prints
`report.md`, the table to paste onto the issue you are verifying against. The
report carries an eighth row, `volume-init`: `run.sh` swallows volume
initialisation's own output, so that row is read back from the launcher's log
and the host log directory's `run_core.log` rather than from a stage of its
own, and it is
`SKIPPED` — never a pass — when neither source shows the initialisation ran.

```mermaid
flowchart LR
    F["1 fresh-state<br/>no workaround present"] --> P["2 prerequisites"]
    P --> S["3 setup.sh"] --> C["4 .config.json<br/>Codex-only"]
    C --> L["5 run.sh<br/>build + launch"] --> I["6 image stamp<br/>+ CLI"]
    I --> W["7 claim one issue<br/>to completion"]
    L -. "run_core.log" .-> V["volume-init<br/>(read back, not run)"]
    W --> R["📄 report.md<br/>stages · expected warnings · defects"]
    V --> R
    style F fill:#1d3557,stroke:#0d1b2a,color:#fff
    style R fill:#2d6a4f,stroke:#1b4332,color:#fff
```

Four properties are worth knowing before you read a report:

- **It verifies; it never repairs.** A host already carrying one of the
  workarounds — `VIBE_SKIP_PREREQ_CHECK`, a moved disk floor, an `[aliases]`
  block or `unqualified-search-registries` in your own `registries.conf`, a
  hand-written `.config.json`, a patched checkout, **any** image already in the
  container store — is refused at stage 1, before `setup.sh` is touched. A run
  that starts from a patched host proves nothing, and a host that already holds
  the base layers resolved those names before the run began.
- **A stage that did not run is `SKIPPED`, never a pass**, and the exit status
  is non-zero whenever anything was refused, failed or skipped short.
- **It tells `setup.sh` which agent this host runs.** A bare host has no
  `.config.json` for setup to read the selection from — writing that file is
  what stage 3 is for — so the run exports `VIBE_AGENT_PROVIDER=codex`, the
  first-run selection [SETUP.md](SETUP.md) documents. It is recorded as a note
  in the report, so you can see the declaration rather than find it in a log.
- **It leaves no worker behind.** The worker runs in the foreground under
  `run.sh`, so the script stops the launcher and any `vibe-coder` container
  before it exits. The built image is deliberately left for you: re-provision
  the host (or remove the image) before running the verification a second time,
  or stage 1 will refuse it — correctly.

The script only sequences the run — it gathers facts, starts `setup.sh` and
`run.sh`, waits on the container and the worker, and captures what each stage
printed. Every judgement in the report is made by the `first-run-verify` Deno
command, so each one is unit-tested without a host
(`worker/deno/tests/first_run_verification_test.ts`).

Useful flags: `--transcript-dir DIR` to put the transcript somewhere you have
already mounted, `--claim-timeout SECONDS` for how long the worker gets to take
an issue to completion, and `--launch-timeout` / `--poll-interval` for the wait
on the container. `--help` prints them.

If you need to drive a stage by hand — to reproduce one fault, or when the
script itself is what you are debugging — the same sequence is these commands,
in this order:

```bash
deno run --allow-run --allow-env worker/deno/mod.ts container-runtime-detect
VIBE_AGENT_PROVIDER=codex ./setup.sh   # on a terminal: the prompts are TTY-gated
./run.sh
podman ps && tail -n 200 "$(deno run --allow-env --allow-read worker/deno/mod.ts log-dir)/worker.log"
```

Doing so leaves the host non-fresh, so it is a debugging path, not a
verification: only the scripted run produces a `report.md` to attach.

The scripted run is the only detection there is for the behaviour no unit test
covers — a real `podman run`, a real Podman volume, a real image build. Its
`report.md` is therefore the evidence: attach it to the issue rather than
paraphrasing it. Every line it quotes is passed through the repository's secret
redaction first; the raw stage transcripts beside it are **not**, and stage 3
captures your whole `setup.sh` terminal session, so keep the transcript
directory off public issues.

## Faults to expect, not to patch

The host stays stock Ubuntu apart from the installs above, so the podman
environment faults reported from a real Ubuntu deployment reproduce here. That
is deliberate: this host exists to confirm their fixes, so the template must
not paper over them.

| Fault | What it looks like |
| --- | --- |
| Rejected mount options | Container start rejects `tmpfs` options the Docker path accepts |
| Disk floor | The worker declines to claim work because free space is below the larger of 20 GB and 10% of the filesystem — at the default 100 GiB root, the floor is the 20 GB constant |
| Volume verbs | Recovery paths that assume Docker's spelling of a volume command |

If a fault reproduces, it belongs on the issue that owns it, with the exact
command and output from this session.

The report separates the two things a reader would otherwise have to tell apart
by hand:

| Report section | What it holds |
| --- | --- |
| **Expected warnings** | Messages that are benign and permanent — a private-repository ruleset 403, which needs GitHub Pro and is non-fatal (Issue #733), and a runtime that refuses `FITRIM`, which is stated rather than warned about and starts no recovery on its own (Issue #734) |
| **New defects** | A fault a sibling fix already removed, named with the issue that owns it — a refused `tmpfs` mount option (#727), a base image that will not resolve (#728), a volume verb the runtime rejects (#731), a refused launch (#732), a refused trim followed by a refused launch (#734), or setup demanding the Claude CLI on a Codex-only host (#730) |

Anything under **New defects** is a workaround still required, and a workaround
still required is a defect: file it as a further sub-issue rather than applying
it and declaring the run a success.

Short-name image resolution is no longer on that list: both base images in
`container/Containerfile` name `docker.io` explicitly, so podman's enforcing
short-name mode never has a registry to guess (Issue #728). A build that still
fails to resolve a base image here is a regression, not a host fault — capture
it as one.

## Auto-stop and tear-down

The instance stops itself `AutoStopHours` (default 8) after boot — enough to
monitor a run, short enough that a forgotten host stops costing money. It is a
**stop**, not a terminate: the root volume survives and the instance can be
started again.

Two consequences worth knowing:

- Reconnecting does **not** extend the window. Cancel it with
  `sudo shutdown -c`, or re-arm a longer one with
  `sudo shutdown -h +480 "extended"`.
- The user data runs once, so after a restart nothing re-arms the timer —
  schedule it again by hand with the command above.

Tear-down is manual and removes everything the stack created, including the
VPC:

```bash
aws cloudformation delete-stack --stack-name vibe-linux-verification
aws cloudformation wait stack-delete-complete --stack-name vibe-linux-verification
```

## What the template deliberately does not do

- **No credentials.** Not in the template, not in the user data. GitHub,
  Anthropic and coding-agent credentials are supplied interactively in the
  session, so nothing sensitive lands in CloudFormation.
- **No key pair and no inbound rules.** Session Manager is the only access
  path; there is no SSH port to leave open and no key to lose.
- **No Docker.** The launcher probes Docker first, so leaving it out is what
  forces the podman branch to run.
- **No podman pre-patching.** See
  [Faults to expect](#faults-to-expect-not-to-patch).
- **No coding-agent CLI by default.** The agent runs inside the image, and the
  Codex-only run of Issue #736 requires a host with no Claude CLI present, so
  installing one unconditionally would refuse the run this host exists for.
- **No automated CI check.** Verification here is manual by design: it needs a
  real host, a real Podman and a real image build. `infra/verify/first-run.sh`
  is what makes the run repeatable and its output comparable — the launcher's
  own unit tests stay runtime-free.
