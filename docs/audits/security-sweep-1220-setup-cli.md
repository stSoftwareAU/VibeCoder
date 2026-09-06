# 🔎 Security sweep — `worker/deno/setup/` setup CLI

**Issue:** [#1220](https://github.com/stSoftwareAU/VibeCoder/issues/1220) (chunk
14) · **Parent:** #1209 `security-scan-overflow: 4 chunks not reached`

This record exists so a later run can tell a **swept** path from an unswept one.
The parent scan did not reach this tree at all — not even by the item-11 greps.
This slice read all 22 modules.

Siblings:
[`security-sweep-1214-subprocess-argv.md`](security-sweep-1214-subprocess-argv.md)
(chunk 12a),
[`filesystem-path-temp-sweep-1215.md`](filesystem-path-temp-sweep-1215.md)
(chunk 12b),
[`security-sweep-1216-untrusted-github-ingestion.md`](security-sweep-1216-untrusted-github-ingestion.md)
(chunk 12c),
[`security-sweep-1217-env-config-secrets.md`](security-sweep-1217-env-config-secrets.md)
(chunk 12d) and
[`security-sweep-1218-commands-cli.md`](security-sweep-1218-commands-cli.md)
(chunk 13).

> **This is not an empty result.** The issue asks that an empty result be stated
> explicitly; it was not empty. **Eleven** root causes survived triage — two
> fixed in this change, nine filed as `security` issues, one deduped onto an
> issue that already existed.

## Scope and method

The file list was regenerated with the command the issue specifies:

```bash
cd worker/deno && ls setup/*.ts | grep -v '_test\.ts$'
```

22 modules, 11,409 lines. Every one was read in full. Where a `setup/` module
delegates the security-relevant decision to `worker/deno/lib/`, the sweep
followed the call — a finding is recorded against the file the defect lives in,
not the file that reaches it, so two findings below cite `lib/` paths reached
from `setup/branch_protection_sync.ts`.

The 17 modules the issue names as carrying a sink were read first. The
remaining five were read to confirm they are what they claim to be; three are
frozen data tables and two are readers.

## Coverage — all 22 paths

Sinks are `Deno.Command` (spawn), `writeTextFile`/`writeFile`/`mkdir`/`remove`
(write), and `fetch` (network). Verified by grep over the same file list.

| # | Path | Sinks | Verdict |
| - | ---- | ----- | ------- |
| 1 | `setup/launchagent.ts` | spawn, write | **SEC-1220-10, SEC-1220-11 — fixed here** |
| 2 | `setup/screenshot.ts` | spawn, write | **SEC-1220-01, -05, -06 — filed** |
| 3 | `setup/setup_cli.ts` | spawn | **SEC-1220-09 — filed**; SEC-1220-04 reaches it |
| 4 | `setup/branch_protection_sync.ts` | spawn | **SEC-1220-02, -03 — filed** (defects in `lib/`) |
| 5 | `setup/config_setup.ts` | write | **SEC-1220-04, -07 — filed** |
| 6 | `setup/gitignore_sync.ts` | — (local FS via helpers) | **SEC-1220-04 — filed** |
| 7 | `setup/label_sync.ts` | spawn | **SEC-1220-08 — filed** |
| 8 | `setup/collaborator_precheck.ts` | spawn | **SEC-1220-04 — filed**; fail-closed elsewhere |
| 9 | `setup/prerequisites.ts` | spawn | recorded below (latent, no caller) |
| 10 | `setup/prerequisite_install_plan.ts` | spawn | recorded below (`PATH`, defence in depth) |
| 11 | `setup/prerequisite_installer.ts` | spawn | recorded below (`PATH`, defence in depth) |
| 12 | `setup/container_runtime_install.ts` | spawn | recorded below (delegated trust) |
| 13 | `setup/scheduled_task.ts` | spawn, write | recorded below (file mode, no credential) |
| 14 | `setup/config_writer.ts` | spawn, write | clean |
| 15 | `setup/workflow_sync.ts` | spawn | clean |
| 16 | `setup/best_practices_sync.ts` | spawn | clean — #1106 fix confirmed landed |
| 17 | `setup/best_practices_relabel.ts` | spawn | clean — author-verified |
| 18 | `setup/label_colour_reconcile.ts` | spawn | clean |
| 19 | `setup/update_mode_setup.ts` | — | clean |
| 20 | `setup/agent_providers.ts` | — | clean |
| 21 | `setup/label_definitions.ts` | — | clean — frozen data |
| 22 | `setup/content_label_definitions.ts` | — | clean — frozen data |

Grep-verified sink inventory, for the next run:

```bash
cd worker/deno
grep -ln "Deno.Command" setup/*.ts | grep -v _test          # → 16
grep -ln "writeTextFile\|writeFile\|Deno.mkdir\|Deno.remove" setup/*.ts  # → 5
grep -ln "fetch(" setup/*.ts | grep -v _test                # → 0
```

**There is no `fetch` anywhere in `setup/`.** The issue's installer questions
about TLS verification, redirect-following and download/verify/execute TOCTOU
therefore have no surface in this tree: nothing here downloads an artefact.
Installation is delegated to the host package manager (`brew`, `winget`,
`apt-get`) or to a vendor CLI, and the one remote artefact that reaches
execution is covered under "delegated trust" below.

## Findings

### Fixed in this change

**SEC-1220-10 — plist markup injection via unescaped path fields.**
`setup/launchagent.ts:66,77,80,84,86`. `generatePlist` escaped only its three
`EnvironmentVariables` values and interpolated `scriptDir` and `logsDir` raw.
Both are configuration: `logsDir` resolves from `log_dir` in `.config.json`,
then `LAUNCH_LOG_DIR` / `LOG_DIR` / `VIBE_LOGS_DIR`, and `normaliseConfiguredLogDir`
(`lib/log_dir.ts`) checks only that the value is absolute or `~`-anchored — `<`,
`>`, `&` and `"` all pass. A value carrying `</string>` closed the enclosing
element and could add a `ProgramArguments` entry, or a `<key>Program</key>`
replacing the executable outright, in a descriptor launchd runs at every login
with the operator's `GH_TOKEN` and `ANTHROPIC_API_KEY` in its environment.
An availability variant needed no attacker at all: a checkout under a directory
named `R&D` emitted a raw `&`, producing a plist `launchctl` refuses while
setup still reported success.

The Windows twin, `setup/scheduled_task.ts`, already escaped every interpolated
value. The two private `escapeXml` copies had drifted, which is the root cause
of the class rather than of the instance, so the escape now lives in
`worker/deno/lib/xml_escape.ts` with one owner and both descriptors import it.

**SEC-1220-11 — the token-bearing plist's permissions.** Two defects on the
same file. `writeSecurePlist` used `Deno.writeTextFile` + a late `chmod`, which
truncates a pre-existing 0o644 plist and fills it with both tokens *before*
narrowing the mode, and follows a symlink pre-positioned at the path; it now
goes through `lib/file_utils.ts` `atomicWrite`, which creates `O_EXCL` at 0o600
and renames into place. And `setupLaunchAgent` returned early when the rendered
plist matched the file on disk, skipping the `chmod` — the one case the
tightening exists for, a plist an older worker wrote 0o644, re-renders to
*identical* content, so re-running `./setup.sh` to pick up the #2514 fix did
nothing.

### Filed

| Finding | Issue | Severity | Where |
| ------- | ----- | -------- | ----- |
| SEC-1220-01 | [#1288](https://github.com/stSoftwareAU/VibeCoder/issues/1288) | high | `screenshot.ts:334-343` — `--deny-env` is a Deno permission check, not an environment scrub, so `--allow-run` on the next line hands every "denied" secret to any child. Reproduced on this host. |
| SEC-1220-02 | [#1289](https://github.com/stSoftwareAU/VibeCoder/issues/1289) | medium | `branch_protection_sync.ts:249` → `lib/default_branch_ruleset.ts:232-250` — an unverified `.vibe/no-default-branch-ruleset` marker deletes the existing ruleset. |
| SEC-1220-03 | [#1290](https://github.com/stSoftwareAU/VibeCoder/issues/1290) | medium | `lib/repo_rulesets.ts:255-274,339-367` — the update is a full-document PUT rebuilt from status checks alone, dropping every other rule an admin added, and reporting success. |
| SEC-1220-04 | [#1291](https://github.com/stSoftwareAU/VibeCoder/issues/1291) | medium | `config_setup.ts:459-468` — the setup CLI's own config reader validates no repo slug; `org/..` escapes the work dir in `gitignore_sync.ts:86`, and a backtick reaches an admin's paste buffer via `collaborator_precheck.ts:241`. |
| SEC-1220-05 | [#1292](https://github.com/stSoftwareAU/VibeCoder/issues/1292) | medium | `screenshot.ts:334-360` — no `--blocked-origins`, so a prompt-injected agent can screenshot the cloud metadata endpoint into a public PR. `file://` is *not* reachable (0.0.75 blocks it by default). |
| SEC-1220-06 | [#1293](https://github.com/stSoftwareAU/VibeCoder/issues/1293) | low | `screenshot.ts:383-394` — raw string prefix against a hard-coded `/`: inert on Windows, and `..` walks through it. |
| SEC-1220-07 | [#1294](https://github.com/stSoftwareAU/VibeCoder/issues/1294) | low | `config_setup.ts:459-468` — a malformed `.config.json` is silently replaced by defaults, re-granting the trusted-bot list the operator removed. |
| SEC-1220-08 | [#1295](https://github.com/stSoftwareAU/VibeCoder/issues/1295) | low | `label_sync.ts:119-142` — deletes GitHub's stock `good first issue` and `help wanted` from every monitored repo, with no dry-run. |
| SEC-1220-09 | [#1296](https://github.com/stSoftwareAU/VibeCoder/issues/1296) | low | `setup_cli.ts:176-182` — a fixed 16-byte consent read leaves the tail in the terminal buffer, so one long answer approves the next repository's ruleset. |

### Deduped

`setup/` spawning `gh` and `git` directly, outside the spawn chokepoint gate
whose `relDirs` (`lib/quality_gate.ts:416,476`) covers only
`worker/deno/lib` and `worker/deno/commands`, is already
[#1259](https://github.com/stSoftwareAU/VibeCoder/issues/1259). Not re-filed.

## The exposure-band question, answered per finding

The parent run classified this chunk **local**, which is right for the trigger —
a human runs setup — and, as the issue suspected, understates three of the
findings.

| Finding | Does the local trigger bound the impact? |
| ------- | ---------------------------------------- |
| SEC-1220-01 | **No — recalibrate up.** `generateMcpConfig` is not setup-only: `lib/agent_mcp_config.ts:126` calls it to build the per-run config the live, unattended agent gets. |
| SEC-1220-02 | **No — recalibrate up.** The trigger is local, but the *input* is remote repo content anyone can land, and the *effect* is a repository-wide protection removal. |
| SEC-1220-05 | **No — recalibrate up.** Same generator, same unattended agent path, and the navigation target is attacker-influenced through issue and PR text. |
| SEC-1220-10 | **Partly.** The injected value is configuration, so writing it needs a foothold — but what it buys is a launchd job outside the container, at every login, holding both credentials. Privileged action, bounded trigger: filed at the boundary. |
| SEC-1220-03, -04, -07, -08, -09, -11 | **Yes.** Operator-supplied input, operator-triggered, and the damage is contained to what the operator's own token can already do. SEC-1220-04's part (b) is the exception within its own finding — the pasteable command crosses to an admin — and is called out there. |

## Reviewed and not filed — with the reason

Recorded so a later run does not re-derive them.

- **`prerequisites.ts:817-859` — `git config --global user.name <remote value>`
  with no `--` separator.** `userName` / `userEmail` come from the GitHub
  profile, so a value beginning with `-` is consumed by `git config`'s
  parse-options. No file-write or exec primitive is reachable: the fixed
  `--global` earlier in argv collides with any injected `--file=`, and the
  realistic outcome is a failed identity configuration. `configureGitIdentity`
  additionally has **no production caller** — only its own definition and its
  test. Latent; worth an `--end-of-options` when a caller is wired up.
- **`PATH` resolution of `argv[0]` in elevated steps.**
  `prerequisite_install_plan.ts:170-176` and `container_runtime_install.ts:856-860`
  spawn bare `sudo` / `apt-get` / `systemctl`, executed with `stdin: "inherit"`
  (`prerequisite_installer.ts:184-192`), so a shadowing `sudo` earlier on `PATH`
  would receive the operator's typed password. Requires a pre-existing
  user-level compromise, so this is defence in depth; pinning absolute paths or
  spawning with a normalised `PATH` would close it.
- **Apple `container system kernel set --recommended`
  (`container_runtime_install.ts:314-319`).** The one step that pulls a remote
  binary artefact which is subsequently executed — as the VM kernel every worker
  container runs under. Nothing here verifies a checksum, because the CLI
  exposes no digest pin; the trust is Apple's. Recorded as **delegated**, not
  assumed-safe. The consent text does disclose the download (`:556-558`).
- **`scheduled_task.ts:288-294` — task XML written with the default mode into
  the checkout root, and not removed** by `removeScheduledTask`. Materially
  lower risk than the plist because the definition carries no credential at all
  (asserted by `tests/setup_scheduled_task_test.ts` and true by inspection —
  Task XML has no environment section), and exploiting the write-then-read
  window needs write access to the checkout root, which already implies control
  of `run.ps1`.
- **Prototype-key lookups** — `prerequisite_install_plan.ts:326-333` and
  `prerequisites.ts:746` index object literals by a lower-cased tool name, so
  `constructor` reaches `Object.prototype`. Inert at both sites (the second
  index yields `undefined`; no exec follows) and unreachable: every `tool` value
  originates in this repo's own literal probe results.
- **Full host environment cloned into every `gh` child**
  (`setup_cli.ts:128-136`, `collaborator_precheck.ts:116-121`). Standard
  practice and the same shape the rest of the fleet uses; recorded as the widest
  env grant in the tree rather than as a defect.

## What was confirmed sound

- **#1106's marker-dedup fix has landed at all four sites in this directory**,
  and no unverified issue-body marker remains. `best_practices_sync.ts:309`,
  `best_practices_relabel.ts:190`, `workflow_sync.ts:198` and
  `collaborator_precheck.ts:326` all call `selectFleetAuthoredMatches` before the
  write, re-check the body themselves rather than trusting the search, and widen
  `--limit` past one so a planted issue cannot occupy the only returned slot. An
  unresolvable fleet set discards every row, so the write becomes "file fresh",
  never "comment into a stranger's issue". SEC-1220-02 is the sibling shape the
  issue asked us to look for — the same defect in a different medium,
  repository content rather than an issue body.
- **`collaborator_precheck.ts` fails closed on every error path**, matching the
  discipline the parent run confirmed for `lib/collaborator_permissions.ts`: a
  failed `gh api user` aborts the pass rather than reporting repos as allowed
  (`:143-146` → `:356-366`); a failed or unparseable `repos/<slug>` lookup
  returns `not_visible` / `not_assignable`, never `ok` (`:161-176`); a failed
  dedup search files a fresh issue rather than commenting onto an unattributed
  one (`:319-334`); and both write failures are reported, not swallowed.
- **#599's control is intact.** `lib/worker_token_privilege_scanner.ts` is
  read-only by construction and never reports unknown scope as verified safe.
  Nothing in these 22 files modifies, bypasses or suppresses it. One structural
  observation, not a finding: `branch_protection_sync.ts` *exercises* the
  ruleset-write capability #599 says must be escalated, and a successful write
  is first-hand proof the token is ruleset-capable — yet setup prints it as an
  ordinary success and the escalation waits on a separate, optional sweep.
- **No shell, anywhere in `setup/`.** Every spawn is
  `new Deno.Command(exe, { args })` with an array argv. No `sh -c`, `bash -c`,
  `powershell -Command`, `Deno.run`, `eval`, `new Function`, or config-driven
  dynamic `import()` exists in the tree.
- **No secret is passed as argv or echoed at a prompt.** `gh` credentials travel
  through the child environment (`config_writer.ts:97-116`,
  `setup_cli.ts:128-136`); the tokens the plist embeds are read with
  `Deno.env.get` and never printed. The only interactive prompt is the y/N at
  `setup_cli.ts:168-182`.
- **Install argv is compile-time literal.** `INSTALL_TABLE`
  (`prerequisite_install_plan.ts:187-262`) and the runtime catalogue
  (`lib/container_runtime.ts:460-502`) hold every argument; a tool name is used
  only as a table *key* and never becomes an argument. The module explicitly
  refuses the two shapes that would widen the supply chain: adding Docker's apt
  repository and signing key (`:243-245`), and modelling an upstream
  `curl … | sh` (`:206-210`, which resolves to `null` instead). `winget` is
  pinned to `--source winget --exact` against source-shadowing, and install
  success is decided by a re-probe rather than by the installer's exit status.
