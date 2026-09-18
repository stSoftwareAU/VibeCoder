/**
 * Stream identity — which conversation owns an issue (Issue #2331).
 *
 * A **stream** is the unit that owns one agent conversation: one stream per
 * (repository, milestone), plus one **blank stream** per repository holding the
 * issues that carry no milestone. The repository is always part of the
 * identity, so two repositories can never share a conversation even when they
 * happen to use the same milestone title.
 *
 * This module is pure — it resolves a stream, says whether it is the blank one,
 * and renders it two ways:
 *
 * - `streamKey` — a stable, filesystem-safe **single path segment**, used
 *   wherever a stream needs a name on disk.
 * - `streamLabel` — the human form used in logs.
 *
 * ## Why a key carries a hash
 *
 * Slugging is lossy: `#2298 merge conflicts` and `#2298: merge conflicts!`
 * reduce to the same readable stem. A key that was only the stem would put two
 * milestones in one conversation, silently. So a milestone key always appends
 * the first 8 hex of a SHA-256 of the raw title — the stem stays readable, the
 * hash makes the key injective. The repository's own segments take that hash
 * only when slugging actually lost something (`my.repo` and `my_repo` both slug
 * to `my-repo`), which keeps the common `owner__name__…` form legible.
 *
 * ## Fail loud
 *
 * A repository that is not `owner/name` throws rather than resolving to some
 * best-effort key: a wrong key silently merges two conversations, which is the
 * exact failure this module exists to prevent.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { crypto as stdCrypto } from "@std/crypto";

/**
 * The stream that owns an issue's conversation.
 *
 * `repo` is always `owner/name`. `milestoneTitle` is absent for the blank
 * stream — the repository's issues that carry no milestone.
 */
export interface StreamId {
  repo: string;
  milestoneTitle?: string;
}

/** Separator between the key's segments — not produced by slugging, so it cannot be forged by a title. */
const SEGMENT_SEPARATOR = "__";

/** Suffix marking the blank stream's key. */
const BLANK_SUFFIX = "blank";

/** Prefix marking a milestone stream's key, so `m-blank` never collides with the blank stream. */
const MILESTONE_PREFIX = "m-";

/** Hex characters of the SHA-256 kept in a key — 8 is 32 bits, ample against accidental collision. */
const HASH_LENGTH = 8;

/**
 * Longest slug stem kept in a key segment, in characters.
 *
 * A milestone title has no length limit worth relying on, and a path segment
 * does (255 bytes on most filesystems). The hash, not the stem, is what keeps
 * keys distinct, so truncating the stem costs readability only.
 */
const MAX_SLUG_LENGTH = 48;

/** Stem used when slugging leaves nothing at all (a title of pure punctuation). */
const EMPTY_SLUG_STEM = "x";

const encoder = new TextEncoder();

/**
 * Reduce text to `[a-z0-9-]`: lowercased, every other character replaced by
 * `-`, runs collapsed, ends trimmed, and capped at `MAX_SLUG_LENGTH`.
 */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-$/u, "");
}

/** First `HASH_LENGTH` hex characters of the SHA-256 of `raw`. */
function shortHash(raw: string): string {
  const digest = stdCrypto.subtle.digestSync("SHA-256", encoder.encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, HASH_LENGTH);
}

/**
 * One key segment: the slug, plus the short hash when the slug alone would not
 * identify `raw`.
 *
 * `alwaysHash` is set for a milestone title, where two distinct titles slugging
 * alike is routine. A repository segment takes the hash only when slugging lost
 * something — case folding alone is not a loss, because GitHub does not allow
 * two owners or two repositories differing only in case.
 */
function keySegment(raw: string, alwaysHash: boolean): string {
  const slug = slugify(raw);
  const lossless = slug === raw.toLowerCase();
  const stem = slug === "" ? EMPTY_SLUG_STEM : slug;
  return alwaysHash || !lossless ? `${stem}-${shortHash(raw)}` : stem;
}

/**
 * Split `owner/name`, throwing when it is anything else.
 *
 * Both halves must be non-empty and neither may contain a further `/`, so a
 * key's segment count is fixed and no caller can smuggle a path into one.
 */
function splitRepo(repo: string): { owner: string; name: string } {
  const parts = repo.split("/");
  const owner = parts[0]?.trim() ?? "";
  const name = parts[1]?.trim() ?? "";
  if (parts.length !== 2 || owner === "" || name === "") {
    throw new Error(
      `stream identity requires a repository of the form owner/name, got: ${
        JSON.stringify(repo)
      }`,
    );
  }
  return { owner, name };
}

/** The milestone title of `stream`, or `undefined` when it is the blank stream. */
function effectiveMilestoneTitle(stream: StreamId): string | undefined {
  const title = stream.milestoneTitle?.trim();
  return title === undefined || title === "" ? undefined : title;
}

/**
 * Resolve an issue's `(repository, milestone)` pair to its stream.
 *
 * An absent, empty or whitespace-only milestone title resolves to the
 * repository's blank stream. Surrounding whitespace on a real title is trimmed,
 * so `" #2319 …"` and `"#2319 …"` are one stream rather than two.
 *
 * Throws when `repo` is not `owner/name`.
 */
export function resolveStreamId(
  repo: string,
  milestoneTitle: string | undefined,
): StreamId {
  splitRepo(repo);
  const title = milestoneTitle?.trim();
  return title === undefined || title === ""
    ? { repo }
    : { repo, milestoneTitle: title };
}

/** True when `stream` is a repository's blank stream — its issues with no milestone. */
export function isBlankStream(stream: StreamId): boolean {
  return effectiveMilestoneTitle(stream) === undefined;
}

/**
 * Render `stream` as a stable, filesystem-safe key:
 * `<owner>__<name>__m-<slug>-<hash>` for a milestone stream, and
 * `<owner>__<name>__blank` for the blank stream.
 *
 * The result is a single path segment — lowercase `[a-z0-9_-]` only, so it
 * carries no `/`, no `..` and no leading `.`.
 *
 * Throws when `stream.repo` is not `owner/name`.
 */
export function streamKey(stream: StreamId): string {
  const { owner, name } = splitRepo(stream.repo);
  const title = effectiveMilestoneTitle(stream);
  const tail = title === undefined
    ? BLANK_SUFFIX
    : `${MILESTONE_PREFIX}${keySegment(title, true)}`;
  return [
    keySegment(owner, false),
    keySegment(name, false),
    tail,
  ].join(SEGMENT_SEPARATOR);
}

/**
 * Render `stream` for a human reader — `stSoftwareAU/VibeCoder#2298 merge
 * conflicts` for a milestone stream, `stSoftwareAU/VibeCoder (blank)` for the
 * blank one.
 *
 * Milestone titles here conventionally open with `#<issue>`, so the title is
 * appended directly and the label reads as a GitHub reference; any other title
 * gets a separating space.
 */
export function streamLabel(stream: StreamId): string {
  const title = effectiveMilestoneTitle(stream);
  if (title === undefined) return `${stream.repo} (${BLANK_SUFFIX})`;
  return title.startsWith("#")
    ? `${stream.repo}${title}`
    : `${stream.repo} ${title}`;
}
