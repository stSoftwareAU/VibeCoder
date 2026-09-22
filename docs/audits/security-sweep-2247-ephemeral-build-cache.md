# Security sweep — the ephemeral build-cache placement (`ephemeral_build_cache.ts`)

**Issue:** [#2247](https://github.com/stSoftwareAU/VibeCoder/issues/2247)
(chunk top-up-2247) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2247:

- `worker/deno/lib/ephemeral_build_cache.ts` — where a build's artefacts go
  when the runtime refuses to trim the work volume.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed makes
`diffCoverage` green and the record false. The module is claimed by
**top-up-2247**, and this file is the reading of it.

## `worker/deno/lib/ephemeral_build_cache.ts`

It computes one environment entry (`CARGO_TARGET_DIR`), reads the launcher's
own `host-disk.json`, and creates one directory. It spawns nothing.

| Input | Source | How it is handled |
| ----- | ------ | ----------------- |
| `checkoutPath` | the worker's own clone/worktree path — never a model or issue value | normalised (trailing and duplicated separators collapsed); only the **last** segment reaches the key, sanitised to `[A-Za-z0-9._-]` and capped at 40 chars, so no `/`, `..`, space or shell metacharacter can survive. An empty path throws rather than keying every build to the root |
| `account` | the worker's own argv for the command (`sudo -n -u <user>`) | sanitised with the same character class before it reaches the key |
| `root` | a constant in production; a parameter only for tests | interpolated as given — a caller-chosen root is worker-controlled by construction |
| `host-disk.json` | the **launcher**, on the host side, through the read-write log mount | parsed by `parseHostDiskRefresh` (`host_disk.ts`, swept under 12a–12c); only the boolean `workVolumeTrimRefused` is read, and only `=== true` engages the placement |
| `HOME` | the process environment | read, not written; used solely to locate the launcher's reading |

| Property | Result |
| -------- | ------ |
| no shell, no argv construction | none — the module spawns nothing; its output is one environment entry a caller overlays |
| environment | reads `HOME`; writes nothing into the worker's own environment |
| filesystem | reads `${HOME}/logs/host-disk.json`; creates the shared root and sets it `1777`. The root is a constant under `/var/tmp`, never derived from an untrusted value, and the sticky bit means either account may create its own directory inside it and neither may remove the other's — the same reasoning as the work root's `+t` (Issue #1442) |
| network | none |
| regex safety | three bounded, non-ambiguous patterns: `/\/+/g`, `/\/+$/` and two character-class replacements. No nested quantifier, no alternation over overlapping literals |
| secret surface | no credential is read, logged or interpolated. The value it emits is a path; the untrusted-command allowlist (`untrusted_command_env.ts`) still governs everything else the repository's own command sees, and the placement is an override on that allowlist, not a widening of it |
| resource bounds | the key is one path segment, at most 40 name characters plus an 8-hex digest plus an account name; the launch verdict is read once per process |
| fail direction | fail-loud where a wrong answer would be silent: an empty checkout path throws; a missing `--allow-env` propagates rather than being read as "the runtime trims". Two defaults are deliberate and documented — a missing or malformed `host-disk.json` reads as **not refused** (`HostDiskMonitor`'s own documented default, and the one that leaves behaviour unchanged), and a root that cannot be provisioned is **reported** to the log while the placement proceeds, because cargo itself reports the write failure it then hits |

No finding. The trust decision recorded here is that `workVolumeTrimRefused`
comes from the **launcher** — the trusted host-side process that writes
`host-disk.json` into the log mount — and that a guest process able to forge
that file could, at most, relocate its own build output to a directory it
already owns on the ephemeral layer. That is strictly less privilege than the
same process already has over the checkout it builds in.

## The call sites wired in the same change

- `worker/deno/lib/claude_runner.ts` (12a) — overlaid onto the agent's
  sanitised child environment **after** `buildChildEnv`, so it cannot restore
  a denied variable: the overlay's only key is `CARGO_TARGET_DIR`.
- `worker/deno/lib/quality_gate_phase.ts` (12a) —
  `untrustedQualityCommandEnv` places the entry under the Issue #572
  allowlist and **before** the repository's own declared credentials, so a
  repository's declaration still wins and no other variable is added.
- `worker/deno/lib/milestone_merge_gate.ts`,
  `worker/deno/lib/milestone_resolution_gate.ts` — passed as `env` to
  `runWithTimeout` without `clearEnv`, so the entry is added to the inherited
  environment and nothing is removed from it.
