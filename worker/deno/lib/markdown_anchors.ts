/**
 * GitHub-compatible heading-anchor helpers (Issue #3424).
 *
 * GitHub Pages/GFM derives a heading's anchor slug with a fixed algorithm
 * (the same one `github-slugger` implements). Internal `#fragment` links must
 * match that slug exactly or they scroll to nothing. These helpers let tests
 * validate that in-repo anchor links resolve against the real headings rather
 * than eyeballing slugs by hand.
 *
 * Algorithm (matching GitHub):
 *   1. Lower-case the heading text.
 *   2. Remove every character that is not a Unicode letter, number, space, or
 *      ASCII hyphen — this strips emoji, em-dashes, `#`, `/`, brackets, etc.
 *   3. Replace spaces with hyphens (no trimming, no hyphen collapsing).
 *
 * Consequences worth noting, because they are the exact bugs this guards:
 *   - A leading emoji (`## 🥇 Title`) leaves a leading space that becomes a
 *     leading hyphen: `#-title`.
 *   - A space-padded em-dash or `+` (`a — b`, `a + b`) leaves two spaces that
 *     become a double hyphen: `a--b`.
 *
 * Australian English spelling used throughout (behaviour, normalise, etc.).
 */

/** Characters GitHub keeps: Unicode letters, numbers, spaces, ASCII hyphen. */
const STRIP = /[^\p{L}\p{N} -]/gu;

/**
 * Slugify a single heading's text the way GitHub does. Does not apply the
 * duplicate-heading `-1`/`-2` suffixing — use {@link headingSlugs} for a whole
 * document where duplicates matter.
 */
export function githubSlug(headingText: string): string {
  return headingText.toLowerCase().replace(STRIP, "").replace(/ /g, "-");
}

/**
 * Extract every heading slug from a Markdown document, in document order,
 * skipping fenced code blocks. Duplicate slugs get GitHub's `-1`, `-2`, …
 * suffixes so the returned list mirrors the anchors GitHub actually emits.
 */
export function headingSlugs(markdown: string): string[] {
  const slugs: string[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trimEnd();
    const fenceMatch = line.match(/^\s*(`|~)\1\1/);
    if (fenceMatch) {
      const marker = (fenceMatch[1] ?? "`").repeat(3);
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!heading) continue;

    const base = githubSlug(heading[2] ?? "");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.push(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

/** A resolvable set of anchors for one document. */
export function anchorSet(markdown: string): Set<string> {
  return new Set(headingSlugs(markdown));
}
