# 🔎 Security sweep — the stream identity seam (`stream_identity.ts`)

**Incident:** [#2331](https://github.com/stSoftwareAU/VibeCoder/issues/2331)
(chunk top-up-2331) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
with the stream identity seam:

- `worker/deno/lib/stream_identity.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2331**, and this file is the reading of it.

## `worker/deno/lib/stream_identity.ts`

The module maps an issue to the stream that owns its agent conversation — one
stream per (repository, milestone), plus one blank stream per repository for
issues with no milestone — and renders that stream as a filesystem-safe key and
a human label. It is pure: no I/O, no subprocess, no network.

| Input              | Source                                                                     | How it is handled                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`             | the worker's own configured repository slug                                | validated as exactly `owner/name` with both halves non-empty; anything else throws naming the value, so no caller can smuggle a path, a `..` or an empty segment into a key                  |
| `milestoneTitle`   | fetched back from GitHub — **untrusted**: anyone with write access sets it | never interpolated into a command, a path or Markdown. For a key it is reduced to `[a-z0-9-]`, run-collapsed, end-trimmed and capped at 48 characters, then tagged with a SHA-256 short hash |
| a built `StreamId` | a caller may construct one directly rather than via `resolveStreamId`      | `streamKey` re-validates the repository and re-derives blankness from the title, so a hand-built stream cannot key differently from a resolved one                                           |

| Property                   | Result                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| path safety                | a key is a single segment of `[a-z0-9_-]` only — no `/`, no `\`, no `..`, no leading `.`. `tests/stream_identity_test.ts` asserts that shape through `assertSafePathSegment`, over the blank key, a milestone key, both halves of a slug collision, a `..` repository name, a dotted/dashed/underscored repository name, a title of pure punctuation, a unicode title and a 1,000-character title |
| collisions                 | the slug is lossy by design, so a milestone key always carries the first 8 hex of a SHA-256 of the raw title; the repository's segments carry it whenever slugging lost a character. Two repositories therefore never share a key                                                                                                                                                                 |
| key forgery                | segments are joined with `__`, which slugging can never produce, and a milestone tail is prefixed `m-`, so a milestone literally titled `blank` cannot key as the blank stream                                                                                                                                                                                                                    |
| regex safety               | four replacements, each a single character class with no nested quantifier — linear in the input, no backtracking surface                                                                                                                                                                                                                                                                         |
| fail direction             | fail loud: a repository that is not `owner/name` throws rather than returning a best-effort key, because a wrong key silently merges two conversations, which is the failure this module exists to prevent                                                                                                                                                                                        |
| spawn, network, filesystem | none                                                                                                                                                                                                                                                                                                                                                                                              |
| secret surface             | holds no credential; the thrown message quotes only the repository slug it was given                                                                                                                                                                                                                                                                                                              |
| blast radius               | nothing calls it yet — this is the foundation the rest of the milestone keys off                                                                                                                                                                                                                                                                                                                  |
