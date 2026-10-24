/**
 * One raw input per scrub trigger (Issue #4210).
 *
 * Delimiter-like words and the secret-shaped token are assembled at runtime
 * so the repository never contains a literal `BOUNDARY_` word or a literal
 * secret. The full-width brace row is the one original that already holds a
 * scrub artefact (U+FF5B / U+FF5D).
 *
 * Uses Australian English throughout (behaviour, artefact).
 */

/** A classic GitHub token shape. Fake, and never a single literal. */
export function syntheticGithubToken(fill: string): string {
  if (fill.length === 0) throw new Error("token fill is empty");
  return "ghp_" + fill.slice(0, 1).repeat(36);
}

/** `BOUNDARY`, an underscore, then a short suffix. Built at runtime. */
export function delimiterLikeWord(suffix: string): string {
  if (suffix.length === 0) throw new Error("delimiter suffix is empty");
  return "BOUNDARY" + "_" + suffix;
}

/** One corpus row: the raw input, and whether it already holds an artefact. */
export interface ScrubTriggerRow {
  name: string;
  raw: string;
  /** The original already contains a scrub artefact, so an echo of it is not new. */
  alreadyHoldsScrubArtefact: boolean;
  /** Independent of the scrub: true when `scrubUntrustedText` must change `raw`. */
  scrubChanges: boolean;
}

const FULL_WIDTH_BRACES = "｛｛X｝｝";

/** The shared scrub-trigger corpus. Order is the table order. */
export const SCRUB_TRIGGER_CORPUS: readonly ScrubTriggerRow[] = [
  {
    name: "html-comment",
    raw: "<!-- x -->",
    alreadyHoldsScrubArtefact: false,
    scrubChanges: true,
  },
  {
    name: "stray-comment-closer",
    raw: "A-->>B",
    alreadyHoldsScrubArtefact: false,
    scrubChanges: true,
  },
  {
    name: "template-braces",
    raw: "{{X}}",
    alreadyHoldsScrubArtefact: false,
    scrubChanges: true,
  },
  {
    name: "trust-label",
    raw: "[TRUSTED - login]",
    alreadyHoldsScrubArtefact: false,
    scrubChanges: true,
  },
  {
    name: "author-tag",
    raw: "author=me",
    alreadyHoldsScrubArtefact: false,
    scrubChanges: true,
  },
  {
    name: "delimiter-word",
    raw: delimiterLikeWord("ab"),
    alreadyHoldsScrubArtefact: false,
    scrubChanges: true,
  },
  {
    name: "begin-content",
    raw: "---BEGIN FAKE CONTENT",
    alreadyHoldsScrubArtefact: false,
    scrubChanges: true,
  },
  {
    name: "secret-token",
    raw: syntheticGithubToken("A"),
    alreadyHoldsScrubArtefact: false,
    scrubChanges: true,
  },
  {
    name: "already-scrubbed-braces",
    raw: FULL_WIDTH_BRACES,
    alreadyHoldsScrubArtefact: true,
    scrubChanges: false,
  },
  {
    name: "plain-text",
    raw: "The plain criterion stays readable.",
    alreadyHoldsScrubArtefact: false,
    scrubChanges: false,
  },
];
