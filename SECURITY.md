# 🔒 Security Policy

Vibe Coder fetches instructions written by strangers from GitHub and executes
them, unattended, on a machine behind the operator's firewall. Security is
therefore not a feature of this project — it is the project. This page is the
**policy**: how to report a problem, what we promise in return, which versions
we support, and a summary of the threat model. The design itself lives in the
[Threat Model](docs/THREAT-MODEL.md); the boundary it enforces is described in
[Containment](docs/CONTAINMENT.md).

## 📢 Responsible Disclosure Policy

### 🐛 Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a
security vulnerability.** Use GitHub's private vulnerability reporting for
this repository:

1. Go to the repository's **Security** tab and choose **Report a
   vulnerability** — or open
   <https://github.com/stSoftwareAU/VibeCoder/security/advisories/new>
   directly.
2. Describe the vulnerability, the affected code path, step-by-step
   reproduction, a proof of concept if you have one, and your assessment of
   the impact.
3. Allow us the response window below before disclosing publicly.

The report is visible only to the repository maintainers and to you. There is
no e-mail channel; the advisory thread is the single place the conversation
happens, so nothing is lost between inboxes.

### 🤝 What we promise

Vibe Coder is maintained by a small team, and these windows are ones we can
keep rather than ones that sound good:

| Step | Within |
| --- | --- |
| Acknowledge the report | 7 days |
| Triage: confirmed / not a vulnerability / need more information | 14 days |
| Status update while a fix is in progress | every 30 days |
| Coordinated public disclosure | 90 days from the report, or on release of the fix if sooner — extended by agreement if a fix genuinely needs longer |

When a fix ships we publish a GitHub security advisory that credits the
reporter (unless you prefer anonymity) and, where a CVE is warranted, request
one through GitHub.

### 🛟 Safe harbour

Good-faith research that stays within these lines is welcome and will not be
pursued: test only against a deployment you control (this software runs on
*your* host, so that is the natural place to test it), do not access or modify
data belonging to others, do not degrade a service you do not own, and give us
the window above before going public. If you are unsure whether something is
in scope, ask through the advisory form first.

### 🎯 Scope

**In scope**

- The worker code in this repository — trust classification, prompt
  assembly, label handling, content-approval snapshots, the `gh` guard shim
  and write-repository allowlist, secret redaction, the audit journal.
- The container definition, launcher scripts (`run.sh`, `run.ps1`,
  `setup.sh`, `setup.ps1`, `loop.sh`, `loop.ps1`) and the seatbelt profile —
  anything that shapes the containment boundary.
- The shipped GitHub Actions workflows.

**Out of scope**

- Vulnerabilities in GitHub, in the coding-agent CLI or model, or in the
  container runtime itself — report those upstream.
- Behaviour that the [Threat Model](docs/THREAT-MODEL.md#-residual-risks)
  lists as an accepted residual risk. Reports that *reduce* a residual risk are
  very welcome as ordinary issues or pull requests.
- Deployments that opted into `native` run mode, which is documented as being
  outside the containment boundary.
- Social engineering of maintainers, and findings that require physical access
  to the operator's host.

## 📦 Supported versions

Vibe Coder is delivered from the default branch, not as versioned releases. Only
the current tip of the default branch is supported: security fixes land there
and are not back-ported. A deployment updates by pulling the checkout it runs
from (`loop.sh` does so between runs; a cron deployment picks up whatever is
checked out), so "supported" means "running what is on the default branch
today". If you pin to an older commit, you own the gap.

## 🧨 Threat model in one page

The full document is [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md). It is
written to stand alone; this is only its shape.

**The risky core.** The worker polls GitHub, assembles issue text into a
prompt, and spawns an agent CLI with `--dangerously-skip-permissions`. Every
input — issue body and title, comments, labels, the cloned repository's own
files, attachments and images, upstream packages — is attacker-influenceable
on a public repository.

**Assets.** Provider credentials and tokens; the host filesystem and network;
write access to monitored repositories; private repository contents; operator
telemetry (logs, audit journal, comment and PR bodies); the worker's own
integrity state.

**Three boundaries.**

1. *Inbound trust gate* — only `allowed_authors` trigger work; labels count
   only when a trusted person added them; a content-hash snapshot re-verified
   against the exact bytes sent to the model blocks edit-after-approval.
2. *Execution containment* — a disposable container with an explicit mount
   set, no host networking, no published ports; credentials as read-only
   mounts of a single provisioned directory; credential-shaped environment
   variables denied by default.
3. *Egress control* — a per-run write-repository allowlist at the worker's
   single `gh` chokepoint and again in a `gh` guard shim on the agent's
   `PATH`; reserved labels refused; every mutation classified and journalled;
   secrets redacted from every outbound body.

**The assumption the model holds under.** The agent inside the container is
treated as fully compromised. Prompt-level defences lower the probability of
an injection succeeding; the boundaries above are what must hold *after* it
has. A change that weakens one of them in exchange for a stronger prompt-level
defence is a bad trade, and the threat model exists to make that visible.

**Residual risks** are accepted and stated, not hidden — the `gh` guard is
containment rather than a sandbox, the model is not deterministic,
repository-supplied build scripts execute, a compromised trusted account has
trusted access, `native` mode has no boundary. Read
[the list](docs/THREAT-MODEL.md#-residual-risks) before deploying.

## 🏗️ Deploying it safely

The short version, for an operator:

- Run the worker under a **dedicated GitHub identity** (service account or
  GitHub App) with write access only to the repositories it should touch —
  never a human's token. The worker's identity guard refuses to run as an
  account outside its configured allowlist.
- Keep `allowed_authors` short. Every entry is a person whose issue text will
  be executed.
- Stay in the default `container` run mode. `seatbelt` (macOS) confines file
  access but not kernel attack surface; `native` has no boundary.
- Enable two-factor authentication on every trusted account, rotate tokens,
  and keep the audit journal.
- Treat every pull request the worker opens as code you are taking ownership
  of. Review it.

Details: [Containment](docs/CONTAINMENT.md),
[Configuration Reference](docs/CONFIGURATION.md),
[Usage Guide](docs/USAGE.md).
