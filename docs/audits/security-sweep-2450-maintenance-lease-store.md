# 🔎 Security sweep — the maintenance lease store (`maintenance_lease_store.ts`)

**Issue:** [#2450](https://github.com/stSoftwareAU/VibeCoder/issues/2450)
(chunk top-up-2450) · **Parent:** #1209

This is the written record for the one module that entered
`worker/deno/lib/` under #2450:

- `worker/deno/lib/maintenance_lease_store.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2450**, and this file is the reading of it.

## `worker/deno/lib/maintenance_lease_store.ts`

The I/O half of the maintenance lease (Decision 2 of #2443): it resolves a
per-repository **anchor issue**, reads the lease marker comments on it, and
posts, patches or deletes those comments. Every GitHub call goes through the
injected `io.ghCommandFn` — the module never spawns a process itself, never
opens a socket, and touches the filesystem only to read and write the anchor
pin file under `io.workDir`.

| Input | Source | How it is handled |
| ----- | ------ | ----------------- |
| `repo` | worker configuration (`repos` / `repo_config`) | rejected unless `isValidRepoSlug` (`repo_rulesets.ts`) matches — an allowlist with no shell metacharacter, path separator beyond the single `/`, or whitespace — **before** it reaches a `gh api` endpoint or the pin file's name. A malformed slug degrades and makes no call at all |
| `host` | this host's machine id (`getMachineId`) | reduced to the install uuid by `installFromMachineId`, then sanitised again by `formatMaintenanceLeaseMarker` on the way into the marker |
| anchor issue number | config override, pin file, `gh issue list`, `gh issue create` | every path goes through `positiveIssueNumber`, a whole-string conversion: only a positive integer reaches the endpoint, so an operator typo or a corrupt pin cannot inject path segments |
| comment bodies | **attacker-writable** — anyone who can comment on a public repo's anchor | only comments whose author is in `io.trustedAuthors` (`isFleetAuthor`, case-insensitive) are parsed at all, and the parse is `parseMaintenanceLeaseMarker`'s anchored character-class regex (#2448). An outsider's marker is discarded before any field is read |
| `gh issue list` rows | GitHub search results | body must contain the exact anchor marker **and** the author must be a fleet login; the number is re-validated as a positive integer |

| Property | Result |
| -------- | ------ |
| argument injection | none reachable. Both interpolated values in every endpoint (`repo`, an integer) are validated first; no value is passed to a shell — `ghCommandFn` takes an argv array, and the comment body travels as `-f body=…` rather than inside a URL |
| path traversal | the pin path is `${workDir}/.maintenance-lease-<owner>-<repo>`, built only after the slug allowlist has passed, so neither segment can carry `/` or `..` |
| can it escalate privilege? | no. It writes one comment on one fleet-owned anchor issue and deletes only comments that carry an **expired** lease marker by a trusted author. No labels (least privilege — the anchor never gets a discovery label, so it can never be picked up as work), no issue state change, no merge, no branch write |
| can it leak a secret? | no. The only text it writes is the marker (`repo`, install uuid, epoch) plus a fixed explanatory line; the only text it logs is a `gh` error message and the repo/pin path — no token, no body content, no author login |
| prompt injection | the anchor body and the lease marker are worker-written; comment bodies it reads are never forwarded to a model, only regex-parsed for three fields. An untrusted author's comment is dropped before parsing |
| fail direction | **fail-open and loud.** A failed read, an unresolvable anchor or a failed write returns `null`/`false` and logs `maintenance-lease: degraded — …`, so the caller runs the sweep it would otherwise have skipped. The lease is an optimisation, never a lock (`stream_holder.ts` doctrine). Nothing is swallowed: `findAnchorIssue` and `readLeaseEntries` re-throw so a blind read can never read as "no anchor"/"no holder" and file a duplicate |
| denial of service | bounded by construction: the anchor search is `--limit 20`, the comment read is `fetchMarkerComments`' paginated read of one thread, and the writes are one post/patch plus one delete per expired marker. An adversary who floods the thread cannot make the store write more than that, and untrusted comments are filtered before any work is done on them |
| blast radius | wrong lease state costs a duplicated maintenance cycle (the pre-#2443 behaviour) or one skipped cycle on one repository. No data loss, no privilege change, no effect on issue selection, PR merge, or the callback contract |
