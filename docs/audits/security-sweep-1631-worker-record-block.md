# 🔎 Security sweep — machine-owned record block (`worker_record_block.ts`)

**Issue:** [#1631](https://github.com/stSoftwareAU/VibeCoder/issues/1631)
(chunk 12h) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
_after_ the chunk-12 slices (12a–12g) recorded their coverage:

- `worker/deno/lib/worker_record_block.ts` — added by #1631.

Siblings:
[`security-sweep-1214-subprocess-argv.md`](security-sweep-1214-subprocess-argv.md)
(12a),
[`filesystem-path-temp-sweep-1215.md`](filesystem-path-temp-sweep-1215.md)
(12b),
[`security-sweep-1216-untrusted-github-ingestion.md`](security-sweep-1216-untrusted-github-ingestion.md)
(12c),
[`security-sweep-1217-env-config-secrets.md`](security-sweep-1217-env-config-secrets.md)
(12d),
[`security-sweep-1219-lib-closing-pass.md`](security-sweep-1219-lib-closing-pass.md)
(12e),
[`security-sweep-1325-gh-body-file-io-and-timeout.md`](security-sweep-1325-gh-body-file-io-and-timeout.md)
(12f) and
[`security-sweep-1443-ignored-path-clean.md`](security-sweep-1443-ignored-path-clean.md)
(12g).

## Why a new slice rather than a line in an old one

Appending the module to a slice whose sweep ran before it existed is the
cheapest way to make `diffCoverage` green and a false record — the failure
12f's own record documents. The module is claimed by **12h**, and this file is
the reading of it.

## `worker/deno/lib/worker_record_block.ts`

The module is pure string handling over an issue body: it writes the worker's
`Depends on owner/repo#N` bookkeeping inside a delimited block, and strips that
block again so the content-approval digest is taken over the approved content
only. It spawns nothing, reads no filesystem or network, holds no state, and
has no configuration input. Its whole exposure is the untrusted issue body it
parses (12c's shape).

Shapes checked (12c's — untrusted GitHub-data ingestion):

| Property | Result |
| -------- | ------ |
| the exemption is author-blind | ✅ nothing in the module reads an author, a login or a timeline; the decision is made from the block's *content* alone, so a compromised agent running as the worker's own login gains nothing a human editor would not |
| only the machine grammar is exempt | ✅ `isMachineOwnedContent` requires **every** non-blank line to match the anchored `^Depends on (?:owner/repo)?#\d+$`; a block carrying anything else is left in place and hashed like the rest of the body, so the gate still fires. Pinned by `worker record block - a block carrying anything else is left in the hash` |
| an unterminated block cannot hide content | ✅ the block pattern needs both delimiters, so a lone opening marker matches nothing and the trailing text stays in the digest. Pinned by `content approval - an unterminated block is not exempt` |
| the worst case an exemption buys | ✅ a dependency line, whose only effect is to make the dependency gate **skip** the issue — a denial, never a path to processing unapproved content, which is the direction the gate already fails in |
| stripping cannot alter approved content | ✅ removal is byte-exact: only the block and the exact `\n\n` (or `\r\n\r\n`) separator the worker wrote are cut, so a baseline captured before any block existed still verifies. Pinned by `worker record block - stripping is the exact inverse of writing` |
| no catastrophic backtracking on an attacker-sized body | ✅ `PERMITTED_LINE` is anchored with no nested quantifier, and the block pattern's only unbounded run is a lazy `[\s\S]*?` between two literal delimiters — linear in the body |
| a hand-written block is not written into | ✅ `upsertWorkerRecordLine` extends only a block whose content is already machine-owned; anything else gets a fresh block beside it, so the worker never edits somebody's prose. Pinned by `worker record block - a non-machine block is never written into` |
| no secret reaches a sink | ✅ the module logs nothing and returns strings to its two callers (`blocked_deferral.ts`, `content_approval_tracker.ts`) |

No findings. The residual is the accepted one above: an author may write a
well-formed block containing a dependency line and have it excluded from the
digest, which can only cause their own issue to be skipped.
