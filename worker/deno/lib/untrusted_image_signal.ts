/**
 * Observing that an untrusted body put an image in front of the agent
 * (Refs #1385).
 *
 * Detection of an instruction-carrying image rests entirely on the model
 * flagging itself: `suspicious_image_handoff.ts` asks the agent to emit a
 * marker when it views an untrusted image that appears to carry instructions
 * aimed at an AI agent, and `detectSuspiciousImageFlag` scans the agent's own
 * output for that marker. An image can instruct the model to act on its
 * content **and** to withhold the marker, so the only detector is the party
 * being attacked, reporting on itself.
 *
 * There is no code-level way to statically analyse arbitrary image content
 * for embedded instructions, and this module does not pretend otherwise. What
 * it does is remove the model from one link of the chain:
 *
 * > The model can suppress its own self-check marker. It cannot remove the
 * > image reference from the issue body the worker already parsed.
 *
 * The body arrives as text, through TypeScript, before any of it reaches the
 * agent. So "an untrusted author put an image in front of the agent" is
 * observable independently — the same principle as
 * `sanitiseDelimiterPatterns`, which defends the text path whether or not the
 * model cooperates.
 *
 * ## This records; it does not gate
 *
 * Screenshots in bug reports are ordinary. Escalating every untrusted-author
 * image to human review would stall legitimate work constantly, and a control
 * that fires on ordinary behaviour is a control somebody switches off — which
 * is worse than not having it, because it also removes the signal. So this
 * observes and reports, and the decision about what to *do* is deferred until
 * there is evidence of how often it actually fires. `docs/THREAT-MODEL.md`
 * records what evidence would change that, so "record only" cannot become
 * permanent by default.
 *
 * ## Bounded matching
 *
 * Every pattern is bounded (Issue #3942): the URL and alt-text runs have
 * explicit upper limits rather than open `*`/`+` quantifiers, so a hostile
 * body cannot turn detection into a denial of service. Truncated counts are
 * fine — the signal is "there was at least one image", not an inventory.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

/** Longest URL run any pattern will match. Beyond this the body is not a URL. */
const MAX_URL = 2048;

/** Longest alt-text run a markdown image may carry before we stop matching. */
const MAX_ALT = 512;

/**
 * How an image reference appeared in the body.
 *
 * Kept as a shape rather than a bare count so a later gating decision can
 * distinguish a rendered attachment from a linked third-party URL without
 * re-parsing.
 */
export type ImageReferenceKind =
  /** Markdown image syntax: `![alt](url)`. */
  | "markdown"
  /** An HTML `<img>` element, which GitHub renders in issue bodies. */
  | "html"
  /** A bare GitHub attachment URL, which renders without markdown syntax. */
  | "attachment";

/** One image reference found in a body. */
export interface ImageReference {
  /** How it was written. */
  kind: ImageReferenceKind;
  /** The referenced URL, truncated to {@link MAX_URL}. */
  url: string;
}

/** `![alt](url)` — alt text and URL both bounded. */
const MARKDOWN_IMAGE = new RegExp(
  `!\\[[^\\]\\n]{0,${MAX_ALT}}\\]\\(\\s*([^)\\s]{1,${MAX_URL}})`,
  "g",
);

/** `<img … src="url" …>` — attribute order independent, quotes optional. */
const HTML_IMAGE = new RegExp(
  `<img\\b[^>]{0,${MAX_ALT}}?\\bsrc\\s*=\\s*["']?([^"'>\\s]{1,${MAX_URL}})`,
  "gi",
);

/**
 * A bare GitHub attachment URL.
 *
 * GitHub renders these as images with no markdown syntax at all, so a body
 * carrying only the raw link still shows the agent a picture.
 */
const ATTACHMENT_URL = new RegExp(
  `https://github\\.com/user-attachments/assets/[A-Za-z0-9-]{1,${MAX_ALT}}`,
  "gi",
);

/**
 * Find the image references in a body.
 *
 * Order is markdown, then HTML, then bare attachment links; duplicates of the
 * same URL are reported once, because the question is what was shown rather
 * than how many times it was written.
 *
 * @param text - The raw body text, before it reaches the agent.
 * @returns One entry per distinct referenced URL; empty when there are none.
 */
export function findImageReferences(text: string): ImageReference[] {
  if (!text) return [];

  const found: ImageReference[] = [];
  const seen = new Set<string>();

  const collect = (pattern: RegExp, kind: ImageReferenceKind): void => {
    // A fresh lastIndex per call: the patterns are module-level and global.
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const url = (match[1] ?? match[0]).trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      found.push({ kind, url });
    }
  };

  collect(MARKDOWN_IMAGE, "markdown");
  collect(HTML_IMAGE, "html");
  collect(ATTACHMENT_URL, "attachment");
  return found;
}

/**
 * The security-audit line recorded when an untrusted body carries an image.
 *
 * Deliberately reports the COUNT and kinds rather than the URLs. The line is
 * logged, and a URL lifted from attacker-controlled text is attacker-chosen
 * content in a log a human reads; the count is what the signal is actually
 * about. Anyone investigating has the issue itself.
 *
 * @param references - What {@link findImageReferences} returned.
 * @param author - The untrusted author's login, for attribution.
 * @param field - Which field carried them, e.g. `issue body`.
 * @returns The audit line, or undefined when there is nothing to report.
 */
export function describeUntrustedImages(
  references: readonly ImageReference[],
  author: string,
  field: string,
): string | undefined {
  if (references.length === 0) return undefined;
  const kinds = [...new Set(references.map((r) => r.kind))].sort().join(", ");
  return `[SECURITY] Untrusted ${field} from ${author || "(unknown author)"} ` +
    `carries ${references.length} image reference(s) (${kinds}). Recorded ` +
    `independently of the agent's own suspicious-image self-check, which an ` +
    `image can instruct the model to withhold (Refs #1385). No action is ` +
    `taken on this signal.`;
}
