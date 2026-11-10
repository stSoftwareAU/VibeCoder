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
 */ import { createHash } from "node:crypto";
/** Separator between the key's segments — not produced by slugging, so it cannot be forged by a title. */ const SEGMENT_SEPARATOR = "__";
/** Suffix marking the blank stream's key. */ const BLANK_SUFFIX = "blank";
/** Prefix marking a milestone stream's key, so `m-blank` never collides with the blank stream. */ const MILESTONE_PREFIX = "m-";
/** Hex characters of the SHA-256 kept in a key — 8 is 32 bits, ample against accidental collision. */ const HASH_LENGTH = 8;
/**
 * Longest slug stem kept in a key segment, in characters.
 *
 * A milestone title has no length limit worth relying on, and a path segment
 * does (255 bytes on most filesystems). The hash, not the stem, is what keeps
 * keys distinct, so truncating the stem costs readability only.
 */ const MAX_SLUG_LENGTH = 48;
/** Stem used when slugging leaves nothing at all (a title of pure punctuation). */ const EMPTY_SLUG_STEM = "x";
/**
 * Reduce text to `[a-z0-9-]`: lowercased, every other character replaced by
 * `-`, runs collapsed, ends trimmed, and capped at `MAX_SLUG_LENGTH`.
 */ function slugify(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9-]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "").slice(0, MAX_SLUG_LENGTH).replace(/-$/u, "");
}
/** First `HASH_LENGTH` hex characters of the SHA-256 of `raw`. */ function shortHash(raw) {
  return createHash("sha256").update(raw).digest("hex").slice(0, HASH_LENGTH);
}
/**
 * One key segment: the slug, plus the short hash when the slug alone would not
 * identify `raw`.
 *
 * `alwaysHash` is set for a milestone title, where two distinct titles slugging
 * alike is routine. A repository segment takes the hash only when slugging lost
 * something — case folding alone is not a loss, because GitHub does not allow
 * two owners or two repositories differing only in case.
 */ function keySegment(raw, alwaysHash) {
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
 */ function splitRepo(repo) {
  const parts = repo.split("/");
  const owner = parts[0]?.trim() ?? "";
  const name = parts[1]?.trim() ?? "";
  if (parts.length !== 2 || owner === "" || name === "") {
    throw new Error(`stream identity requires a repository of the form owner/name, got: ${JSON.stringify(repo)}`);
  }
  return {
    owner,
    name
  };
}
/** The milestone title of `stream`, or `undefined` when it is the blank stream. */ function effectiveMilestoneTitle(stream) {
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
 */ export function resolveStreamId(repo, milestoneTitle) {
  splitRepo(repo);
  const title = milestoneTitle?.trim();
  return title === undefined || title === "" ? {
    repo
  } : {
    repo,
    milestoneTitle: title
  };
}
/** True when `stream` is a repository's blank stream — its issues with no milestone. */ export function isBlankStream(stream) {
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
 */ export function streamKey(stream) {
  const { owner, name } = splitRepo(stream.repo);
  const title = effectiveMilestoneTitle(stream);
  const tail = title === undefined ? BLANK_SUFFIX : `${MILESTONE_PREFIX}${keySegment(title, true)}`;
  return [
    keySegment(owner, false),
    keySegment(name, false),
    tail
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
 */ export function streamLabel(stream) {
  const title = effectiveMilestoneTitle(stream);
  if (title === undefined) return `${stream.repo} (${BLANK_SUFFIX})`;
  return title.startsWith("#") ? `${stream.repo}${title}` : `${stream.repo} ${title}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zdHJlYW1faWRlbnRpdHkudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTdHJlYW0gaWRlbnRpdHkg4oCUIHdoaWNoIGNvbnZlcnNhdGlvbiBvd25zIGFuIGlzc3VlIChJc3N1ZSAjMjMzMSkuXG4gKlxuICogQSAqKnN0cmVhbSoqIGlzIHRoZSB1bml0IHRoYXQgb3ducyBvbmUgYWdlbnQgY29udmVyc2F0aW9uOiBvbmUgc3RyZWFtIHBlclxuICogKHJlcG9zaXRvcnksIG1pbGVzdG9uZSksIHBsdXMgb25lICoqYmxhbmsgc3RyZWFtKiogcGVyIHJlcG9zaXRvcnkgaG9sZGluZyB0aGVcbiAqIGlzc3VlcyB0aGF0IGNhcnJ5IG5vIG1pbGVzdG9uZS4gVGhlIHJlcG9zaXRvcnkgaXMgYWx3YXlzIHBhcnQgb2YgdGhlXG4gKiBpZGVudGl0eSwgc28gdHdvIHJlcG9zaXRvcmllcyBjYW4gbmV2ZXIgc2hhcmUgYSBjb252ZXJzYXRpb24gZXZlbiB3aGVuIHRoZXlcbiAqIGhhcHBlbiB0byB1c2UgdGhlIHNhbWUgbWlsZXN0b25lIHRpdGxlLlxuICpcbiAqIFRoaXMgbW9kdWxlIGlzIHB1cmUg4oCUIGl0IHJlc29sdmVzIGEgc3RyZWFtLCBzYXlzIHdoZXRoZXIgaXQgaXMgdGhlIGJsYW5rIG9uZSxcbiAqIGFuZCByZW5kZXJzIGl0IHR3byB3YXlzOlxuICpcbiAqIC0gYHN0cmVhbUtleWAg4oCUIGEgc3RhYmxlLCBmaWxlc3lzdGVtLXNhZmUgKipzaW5nbGUgcGF0aCBzZWdtZW50KiosIHVzZWRcbiAqICAgd2hlcmV2ZXIgYSBzdHJlYW0gbmVlZHMgYSBuYW1lIG9uIGRpc2suXG4gKiAtIGBzdHJlYW1MYWJlbGAg4oCUIHRoZSBodW1hbiBmb3JtIHVzZWQgaW4gbG9ncy5cbiAqXG4gKiAjIyBXaHkgYSBrZXkgY2FycmllcyBhIGhhc2hcbiAqXG4gKiBTbHVnZ2luZyBpcyBsb3NzeTogYCMyMjk4IG1lcmdlIGNvbmZsaWN0c2AgYW5kIGAjMjI5ODogbWVyZ2UgY29uZmxpY3RzIWBcbiAqIHJlZHVjZSB0byB0aGUgc2FtZSByZWFkYWJsZSBzdGVtLiBBIGtleSB0aGF0IHdhcyBvbmx5IHRoZSBzdGVtIHdvdWxkIHB1dCB0d29cbiAqIG1pbGVzdG9uZXMgaW4gb25lIGNvbnZlcnNhdGlvbiwgc2lsZW50bHkuIFNvIGEgbWlsZXN0b25lIGtleSBhbHdheXMgYXBwZW5kc1xuICogdGhlIGZpcnN0IDggaGV4IG9mIGEgU0hBLTI1NiBvZiB0aGUgcmF3IHRpdGxlIOKAlCB0aGUgc3RlbSBzdGF5cyByZWFkYWJsZSwgdGhlXG4gKiBoYXNoIG1ha2VzIHRoZSBrZXkgaW5qZWN0aXZlLiBUaGUgcmVwb3NpdG9yeSdzIG93biBzZWdtZW50cyB0YWtlIHRoYXQgaGFzaFxuICogb25seSB3aGVuIHNsdWdnaW5nIGFjdHVhbGx5IGxvc3Qgc29tZXRoaW5nIChgbXkucmVwb2AgYW5kIGBteV9yZXBvYCBib3RoIHNsdWdcbiAqIHRvIGBteS1yZXBvYCksIHdoaWNoIGtlZXBzIHRoZSBjb21tb24gYG93bmVyX19uYW1lX1/igKZgIGZvcm0gbGVnaWJsZS5cbiAqXG4gKiAjIyBGYWlsIGxvdWRcbiAqXG4gKiBBIHJlcG9zaXRvcnkgdGhhdCBpcyBub3QgYG93bmVyL25hbWVgIHRocm93cyByYXRoZXIgdGhhbiByZXNvbHZpbmcgdG8gc29tZVxuICogYmVzdC1lZmZvcnQga2V5OiBhIHdyb25nIGtleSBzaWxlbnRseSBtZXJnZXMgdHdvIGNvbnZlcnNhdGlvbnMsIHdoaWNoIGlzIHRoZVxuICogZXhhY3QgZmFpbHVyZSB0aGlzIG1vZHVsZSBleGlzdHMgdG8gcHJldmVudC5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdXNlZCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuXG4vKipcbiAqIFRoZSBzdHJlYW0gdGhhdCBvd25zIGFuIGlzc3VlJ3MgY29udmVyc2F0aW9uLlxuICpcbiAqIGByZXBvYCBpcyBhbHdheXMgYG93bmVyL25hbWVgLiBgbWlsZXN0b25lVGl0bGVgIGlzIGFic2VudCBmb3IgdGhlIGJsYW5rXG4gKiBzdHJlYW0g4oCUIHRoZSByZXBvc2l0b3J5J3MgaXNzdWVzIHRoYXQgY2Fycnkgbm8gbWlsZXN0b25lLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFN0cmVhbUlkIHtcbiAgcmVwbzogc3RyaW5nO1xuICBtaWxlc3RvbmVUaXRsZT86IHN0cmluZztcbn1cblxuLyoqIFNlcGFyYXRvciBiZXR3ZWVuIHRoZSBrZXkncyBzZWdtZW50cyDigJQgbm90IHByb2R1Y2VkIGJ5IHNsdWdnaW5nLCBzbyBpdCBjYW5ub3QgYmUgZm9yZ2VkIGJ5IGEgdGl0bGUuICovXG5jb25zdCBTRUdNRU5UX1NFUEFSQVRPUiA9IFwiX19cIjtcblxuLyoqIFN1ZmZpeCBtYXJraW5nIHRoZSBibGFuayBzdHJlYW0ncyBrZXkuICovXG5jb25zdCBCTEFOS19TVUZGSVggPSBcImJsYW5rXCI7XG5cbi8qKiBQcmVmaXggbWFya2luZyBhIG1pbGVzdG9uZSBzdHJlYW0ncyBrZXksIHNvIGBtLWJsYW5rYCBuZXZlciBjb2xsaWRlcyB3aXRoIHRoZSBibGFuayBzdHJlYW0uICovXG5jb25zdCBNSUxFU1RPTkVfUFJFRklYID0gXCJtLVwiO1xuXG4vKiogSGV4IGNoYXJhY3RlcnMgb2YgdGhlIFNIQS0yNTYga2VwdCBpbiBhIGtleSDigJQgOCBpcyAzMiBiaXRzLCBhbXBsZSBhZ2FpbnN0IGFjY2lkZW50YWwgY29sbGlzaW9uLiAqL1xuY29uc3QgSEFTSF9MRU5HVEggPSA4O1xuXG4vKipcbiAqIExvbmdlc3Qgc2x1ZyBzdGVtIGtlcHQgaW4gYSBrZXkgc2VnbWVudCwgaW4gY2hhcmFjdGVycy5cbiAqXG4gKiBBIG1pbGVzdG9uZSB0aXRsZSBoYXMgbm8gbGVuZ3RoIGxpbWl0IHdvcnRoIHJlbHlpbmcgb24sIGFuZCBhIHBhdGggc2VnbWVudFxuICogZG9lcyAoMjU1IGJ5dGVzIG9uIG1vc3QgZmlsZXN5c3RlbXMpLiBUaGUgaGFzaCwgbm90IHRoZSBzdGVtLCBpcyB3aGF0IGtlZXBzXG4gKiBrZXlzIGRpc3RpbmN0LCBzbyB0cnVuY2F0aW5nIHRoZSBzdGVtIGNvc3RzIHJlYWRhYmlsaXR5IG9ubHkuXG4gKi9cbmNvbnN0IE1BWF9TTFVHX0xFTkdUSCA9IDQ4O1xuXG4vKiogU3RlbSB1c2VkIHdoZW4gc2x1Z2dpbmcgbGVhdmVzIG5vdGhpbmcgYXQgYWxsIChhIHRpdGxlIG9mIHB1cmUgcHVuY3R1YXRpb24pLiAqL1xuY29uc3QgRU1QVFlfU0xVR19TVEVNID0gXCJ4XCI7XG5cbi8qKlxuICogUmVkdWNlIHRleHQgdG8gYFthLXowLTktXWA6IGxvd2VyY2FzZWQsIGV2ZXJ5IG90aGVyIGNoYXJhY3RlciByZXBsYWNlZCBieVxuICogYC1gLCBydW5zIGNvbGxhcHNlZCwgZW5kcyB0cmltbWVkLCBhbmQgY2FwcGVkIGF0IGBNQVhfU0xVR19MRU5HVEhgLlxuICovXG5mdW5jdGlvbiBzbHVnaWZ5KHJhdzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJhd1xuICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgLnJlcGxhY2UoL1teYS16MC05LV0vZ3UsIFwiLVwiKVxuICAgIC5yZXBsYWNlKC8tKy9ndSwgXCItXCIpXG4gICAgLnJlcGxhY2UoL14tfC0kL2d1LCBcIlwiKVxuICAgIC5zbGljZSgwLCBNQVhfU0xVR19MRU5HVEgpXG4gICAgLnJlcGxhY2UoLy0kL3UsIFwiXCIpO1xufVxuXG4vKiogRmlyc3QgYEhBU0hfTEVOR1RIYCBoZXggY2hhcmFjdGVycyBvZiB0aGUgU0hBLTI1NiBvZiBgcmF3YC4gKi9cbmZ1bmN0aW9uIHNob3J0SGFzaChyYXc6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShyYXcpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCBIQVNIX0xFTkdUSCk7XG59XG5cbi8qKlxuICogT25lIGtleSBzZWdtZW50OiB0aGUgc2x1ZywgcGx1cyB0aGUgc2hvcnQgaGFzaCB3aGVuIHRoZSBzbHVnIGFsb25lIHdvdWxkIG5vdFxuICogaWRlbnRpZnkgYHJhd2AuXG4gKlxuICogYGFsd2F5c0hhc2hgIGlzIHNldCBmb3IgYSBtaWxlc3RvbmUgdGl0bGUsIHdoZXJlIHR3byBkaXN0aW5jdCB0aXRsZXMgc2x1Z2dpbmdcbiAqIGFsaWtlIGlzIHJvdXRpbmUuIEEgcmVwb3NpdG9yeSBzZWdtZW50IHRha2VzIHRoZSBoYXNoIG9ubHkgd2hlbiBzbHVnZ2luZyBsb3N0XG4gKiBzb21ldGhpbmcg4oCUIGNhc2UgZm9sZGluZyBhbG9uZSBpcyBub3QgYSBsb3NzLCBiZWNhdXNlIEdpdEh1YiBkb2VzIG5vdCBhbGxvd1xuICogdHdvIG93bmVycyBvciB0d28gcmVwb3NpdG9yaWVzIGRpZmZlcmluZyBvbmx5IGluIGNhc2UuXG4gKi9cbmZ1bmN0aW9uIGtleVNlZ21lbnQocmF3OiBzdHJpbmcsIGFsd2F5c0hhc2g6IGJvb2xlYW4pOiBzdHJpbmcge1xuICBjb25zdCBzbHVnID0gc2x1Z2lmeShyYXcpO1xuICBjb25zdCBsb3NzbGVzcyA9IHNsdWcgPT09IHJhdy50b0xvd2VyQ2FzZSgpO1xuICBjb25zdCBzdGVtID0gc2x1ZyA9PT0gXCJcIiA/IEVNUFRZX1NMVUdfU1RFTSA6IHNsdWc7XG4gIHJldHVybiBhbHdheXNIYXNoIHx8ICFsb3NzbGVzcyA/IGAke3N0ZW19LSR7c2hvcnRIYXNoKHJhdyl9YCA6IHN0ZW07XG59XG5cbi8qKlxuICogU3BsaXQgYG93bmVyL25hbWVgLCB0aHJvd2luZyB3aGVuIGl0IGlzIGFueXRoaW5nIGVsc2UuXG4gKlxuICogQm90aCBoYWx2ZXMgbXVzdCBiZSBub24tZW1wdHkgYW5kIG5laXRoZXIgbWF5IGNvbnRhaW4gYSBmdXJ0aGVyIGAvYCwgc28gYVxuICoga2V5J3Mgc2VnbWVudCBjb3VudCBpcyBmaXhlZCBhbmQgbm8gY2FsbGVyIGNhbiBzbXVnZ2xlIGEgcGF0aCBpbnRvIG9uZS5cbiAqL1xuZnVuY3Rpb24gc3BsaXRSZXBvKHJlcG86IHN0cmluZyk6IHsgb3duZXI6IHN0cmluZzsgbmFtZTogc3RyaW5nIH0ge1xuICBjb25zdCBwYXJ0cyA9IHJlcG8uc3BsaXQoXCIvXCIpO1xuICBjb25zdCBvd25lciA9IHBhcnRzWzBdPy50cmltKCkgPz8gXCJcIjtcbiAgY29uc3QgbmFtZSA9IHBhcnRzWzFdPy50cmltKCkgPz8gXCJcIjtcbiAgaWYgKHBhcnRzLmxlbmd0aCAhPT0gMiB8fCBvd25lciA9PT0gXCJcIiB8fCBuYW1lID09PSBcIlwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYHN0cmVhbSBpZGVudGl0eSByZXF1aXJlcyBhIHJlcG9zaXRvcnkgb2YgdGhlIGZvcm0gb3duZXIvbmFtZSwgZ290OiAke1xuICAgICAgICBKU09OLnN0cmluZ2lmeShyZXBvKVxuICAgICAgfWAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4geyBvd25lciwgbmFtZSB9O1xufVxuXG4vKiogVGhlIG1pbGVzdG9uZSB0aXRsZSBvZiBgc3RyZWFtYCwgb3IgYHVuZGVmaW5lZGAgd2hlbiBpdCBpcyB0aGUgYmxhbmsgc3RyZWFtLiAqL1xuZnVuY3Rpb24gZWZmZWN0aXZlTWlsZXN0b25lVGl0bGUoc3RyZWFtOiBTdHJlYW1JZCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHRpdGxlID0gc3RyZWFtLm1pbGVzdG9uZVRpdGxlPy50cmltKCk7XG4gIHJldHVybiB0aXRsZSA9PT0gdW5kZWZpbmVkIHx8IHRpdGxlID09PSBcIlwiID8gdW5kZWZpbmVkIDogdGl0bGU7XG59XG5cbi8qKlxuICogUmVzb2x2ZSBhbiBpc3N1ZSdzIGAocmVwb3NpdG9yeSwgbWlsZXN0b25lKWAgcGFpciB0byBpdHMgc3RyZWFtLlxuICpcbiAqIEFuIGFic2VudCwgZW1wdHkgb3Igd2hpdGVzcGFjZS1vbmx5IG1pbGVzdG9uZSB0aXRsZSByZXNvbHZlcyB0byB0aGVcbiAqIHJlcG9zaXRvcnkncyBibGFuayBzdHJlYW0uIFN1cnJvdW5kaW5nIHdoaXRlc3BhY2Ugb24gYSByZWFsIHRpdGxlIGlzIHRyaW1tZWQsXG4gKiBzbyBgXCIgIzIzMTkg4oCmXCJgIGFuZCBgXCIjMjMxOSDigKZcImAgYXJlIG9uZSBzdHJlYW0gcmF0aGVyIHRoYW4gdHdvLlxuICpcbiAqIFRocm93cyB3aGVuIGByZXBvYCBpcyBub3QgYG93bmVyL25hbWVgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVN0cmVhbUlkKFxuICByZXBvOiBzdHJpbmcsXG4gIG1pbGVzdG9uZVRpdGxlOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4pOiBTdHJlYW1JZCB7XG4gIHNwbGl0UmVwbyhyZXBvKTtcbiAgY29uc3QgdGl0bGUgPSBtaWxlc3RvbmVUaXRsZT8udHJpbSgpO1xuICByZXR1cm4gdGl0bGUgPT09IHVuZGVmaW5lZCB8fCB0aXRsZSA9PT0gXCJcIlxuICAgID8geyByZXBvIH1cbiAgICA6IHsgcmVwbywgbWlsZXN0b25lVGl0bGU6IHRpdGxlIH07XG59XG5cbi8qKiBUcnVlIHdoZW4gYHN0cmVhbWAgaXMgYSByZXBvc2l0b3J5J3MgYmxhbmsgc3RyZWFtIOKAlCBpdHMgaXNzdWVzIHdpdGggbm8gbWlsZXN0b25lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQmxhbmtTdHJlYW0oc3RyZWFtOiBTdHJlYW1JZCk6IGJvb2xlYW4ge1xuICByZXR1cm4gZWZmZWN0aXZlTWlsZXN0b25lVGl0bGUoc3RyZWFtKSA9PT0gdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIFJlbmRlciBgc3RyZWFtYCBhcyBhIHN0YWJsZSwgZmlsZXN5c3RlbS1zYWZlIGtleTpcbiAqIGA8b3duZXI+X188bmFtZT5fX20tPHNsdWc+LTxoYXNoPmAgZm9yIGEgbWlsZXN0b25lIHN0cmVhbSwgYW5kXG4gKiBgPG93bmVyPl9fPG5hbWU+X19ibGFua2AgZm9yIHRoZSBibGFuayBzdHJlYW0uXG4gKlxuICogVGhlIHJlc3VsdCBpcyBhIHNpbmdsZSBwYXRoIHNlZ21lbnQg4oCUIGxvd2VyY2FzZSBgW2EtejAtOV8tXWAgb25seSwgc28gaXRcbiAqIGNhcnJpZXMgbm8gYC9gLCBubyBgLi5gIGFuZCBubyBsZWFkaW5nIGAuYC5cbiAqXG4gKiBUaHJvd3Mgd2hlbiBgc3RyZWFtLnJlcG9gIGlzIG5vdCBgb3duZXIvbmFtZWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdHJlYW1LZXkoc3RyZWFtOiBTdHJlYW1JZCk6IHN0cmluZyB7XG4gIGNvbnN0IHsgb3duZXIsIG5hbWUgfSA9IHNwbGl0UmVwbyhzdHJlYW0ucmVwbyk7XG4gIGNvbnN0IHRpdGxlID0gZWZmZWN0aXZlTWlsZXN0b25lVGl0bGUoc3RyZWFtKTtcbiAgY29uc3QgdGFpbCA9IHRpdGxlID09PSB1bmRlZmluZWRcbiAgICA/IEJMQU5LX1NVRkZJWFxuICAgIDogYCR7TUlMRVNUT05FX1BSRUZJWH0ke2tleVNlZ21lbnQodGl0bGUsIHRydWUpfWA7XG4gIHJldHVybiBbXG4gICAga2V5U2VnbWVudChvd25lciwgZmFsc2UpLFxuICAgIGtleVNlZ21lbnQobmFtZSwgZmFsc2UpLFxuICAgIHRhaWwsXG4gIF0uam9pbihTRUdNRU5UX1NFUEFSQVRPUik7XG59XG5cbi8qKlxuICogUmVuZGVyIGBzdHJlYW1gIGZvciBhIGh1bWFuIHJlYWRlciDigJQgYHN0U29mdHdhcmVBVS9WaWJlQ29kZXIjMjI5OCBtZXJnZVxuICogY29uZmxpY3RzYCBmb3IgYSBtaWxlc3RvbmUgc3RyZWFtLCBgc3RTb2Z0d2FyZUFVL1ZpYmVDb2RlciAoYmxhbmspYCBmb3IgdGhlXG4gKiBibGFuayBvbmUuXG4gKlxuICogTWlsZXN0b25lIHRpdGxlcyBoZXJlIGNvbnZlbnRpb25hbGx5IG9wZW4gd2l0aCBgIzxpc3N1ZT5gLCBzbyB0aGUgdGl0bGUgaXNcbiAqIGFwcGVuZGVkIGRpcmVjdGx5IGFuZCB0aGUgbGFiZWwgcmVhZHMgYXMgYSBHaXRIdWIgcmVmZXJlbmNlOyBhbnkgb3RoZXIgdGl0bGVcbiAqIGdldHMgYSBzZXBhcmF0aW5nIHNwYWNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RyZWFtTGFiZWwoc3RyZWFtOiBTdHJlYW1JZCk6IHN0cmluZyB7XG4gIGNvbnN0IHRpdGxlID0gZWZmZWN0aXZlTWlsZXN0b25lVGl0bGUoc3RyZWFtKTtcbiAgaWYgKHRpdGxlID09PSB1bmRlZmluZWQpIHJldHVybiBgJHtzdHJlYW0ucmVwb30gKCR7QkxBTktfU1VGRklYfSlgO1xuICByZXR1cm4gdGl0bGUuc3RhcnRzV2l0aChcIiNcIilcbiAgICA/IGAke3N0cmVhbS5yZXBvfSR7dGl0bGV9YFxuICAgIDogYCR7c3RyZWFtLnJlcG99ICR7dGl0bGV9YDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBaUNDLEdBRUQsU0FBUyxVQUFVLFFBQVEsY0FBYztBQWF6Qyx3R0FBd0csR0FDeEcsTUFBTSxvQkFBb0I7QUFFMUIsMkNBQTJDLEdBQzNDLE1BQU0sZUFBZTtBQUVyQixnR0FBZ0csR0FDaEcsTUFBTSxtQkFBbUI7QUFFekIsb0dBQW9HLEdBQ3BHLE1BQU0sY0FBYztBQUVwQjs7Ozs7O0NBTUMsR0FDRCxNQUFNLGtCQUFrQjtBQUV4QixpRkFBaUYsR0FDakYsTUFBTSxrQkFBa0I7QUFFeEI7OztDQUdDLEdBQ0QsU0FBUyxRQUFRLEdBQVc7RUFDMUIsT0FBTyxJQUNKLFdBQVcsR0FDWCxPQUFPLENBQUMsZ0JBQWdCLEtBQ3hCLE9BQU8sQ0FBQyxRQUFRLEtBQ2hCLE9BQU8sQ0FBQyxXQUFXLElBQ25CLEtBQUssQ0FBQyxHQUFHLGlCQUNULE9BQU8sQ0FBQyxPQUFPO0FBQ3BCO0FBRUEsZ0VBQWdFLEdBQ2hFLFNBQVMsVUFBVSxHQUFXO0VBQzVCLE9BQU8sV0FBVyxVQUFVLE1BQU0sQ0FBQyxLQUFLLE1BQU0sQ0FBQyxPQUFPLEtBQUssQ0FBQyxHQUFHO0FBQ2pFO0FBRUE7Ozs7Ozs7O0NBUUMsR0FDRCxTQUFTLFdBQVcsR0FBVyxFQUFFLFVBQW1CO0VBQ2xELE1BQU0sT0FBTyxRQUFRO0VBQ3JCLE1BQU0sV0FBVyxTQUFTLElBQUksV0FBVztFQUN6QyxNQUFNLE9BQU8sU0FBUyxLQUFLLGtCQUFrQjtFQUM3QyxPQUFPLGNBQWMsQ0FBQyxXQUFXLEdBQUcsS0FBSyxDQUFDLEVBQUUsVUFBVSxNQUFNLEdBQUc7QUFDakU7QUFFQTs7Ozs7Q0FLQyxHQUNELFNBQVMsVUFBVSxJQUFZO0VBQzdCLE1BQU0sUUFBUSxLQUFLLEtBQUssQ0FBQztFQUN6QixNQUFNLFFBQVEsS0FBSyxDQUFDLEVBQUUsRUFBRSxVQUFVO0VBQ2xDLE1BQU0sT0FBTyxLQUFLLENBQUMsRUFBRSxFQUFFLFVBQVU7RUFDakMsSUFBSSxNQUFNLE1BQU0sS0FBSyxLQUFLLFVBQVUsTUFBTSxTQUFTLElBQUk7SUFDckQsTUFBTSxJQUFJLE1BQ1IsQ0FBQyxtRUFBbUUsRUFDbEUsS0FBSyxTQUFTLENBQUMsT0FDZjtFQUVOO0VBQ0EsT0FBTztJQUFFO0lBQU87RUFBSztBQUN2QjtBQUVBLGlGQUFpRixHQUNqRixTQUFTLHdCQUF3QixNQUFnQjtFQUMvQyxNQUFNLFFBQVEsT0FBTyxjQUFjLEVBQUU7RUFDckMsT0FBTyxVQUFVLGFBQWEsVUFBVSxLQUFLLFlBQVk7QUFDM0Q7QUFFQTs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sU0FBUyxnQkFDZCxJQUFZLEVBQ1osY0FBa0M7RUFFbEMsVUFBVTtFQUNWLE1BQU0sUUFBUSxnQkFBZ0I7RUFDOUIsT0FBTyxVQUFVLGFBQWEsVUFBVSxLQUNwQztJQUFFO0VBQUssSUFDUDtJQUFFO0lBQU0sZ0JBQWdCO0VBQU07QUFDcEM7QUFFQSxzRkFBc0YsR0FDdEYsT0FBTyxTQUFTLGNBQWMsTUFBZ0I7RUFDNUMsT0FBTyx3QkFBd0IsWUFBWTtBQUM3QztBQUVBOzs7Ozs7Ozs7Q0FTQyxHQUNELE9BQU8sU0FBUyxVQUFVLE1BQWdCO0VBQ3hDLE1BQU0sRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLEdBQUcsVUFBVSxPQUFPLElBQUk7RUFDN0MsTUFBTSxRQUFRLHdCQUF3QjtFQUN0QyxNQUFNLE9BQU8sVUFBVSxZQUNuQixlQUNBLEdBQUcsbUJBQW1CLFdBQVcsT0FBTyxPQUFPO0VBQ25ELE9BQU87SUFDTCxXQUFXLE9BQU87SUFDbEIsV0FBVyxNQUFNO0lBQ2pCO0dBQ0QsQ0FBQyxJQUFJLENBQUM7QUFDVDtBQUVBOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxTQUFTLFlBQVksTUFBZ0I7RUFDMUMsTUFBTSxRQUFRLHdCQUF3QjtFQUN0QyxJQUFJLFVBQVUsV0FBVyxPQUFPLEdBQUcsT0FBTyxJQUFJLENBQUMsRUFBRSxFQUFFLGFBQWEsQ0FBQyxDQUFDO0VBQ2xFLE9BQU8sTUFBTSxVQUFVLENBQUMsT0FDcEIsR0FBRyxPQUFPLElBQUksR0FBRyxPQUFPLEdBQ3hCLEdBQUcsT0FBTyxJQUFJLENBQUMsQ0FBQyxFQUFFLE9BQU87QUFDL0IifQ==
// denoCacheMetadata=14290684256120955781,15294303544726222509