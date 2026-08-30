/**
 * Deterministic requirements-quality rubric for grill-me (Issue #519).
 *
 * Grill-me converged whenever the model judged there was nothing meaningful
 * left to ask, and the only quality guidance on the resulting
 * `## Current Understanding` block was one line of prose in the template. That
 * is a quality escape: the same defect slips through on one run and is caught
 * on the next. Adopted from GitHub spec-kit, which frames a checklist as
 * "unit tests for English" — it validates the *requirements text*, explicitly
 * not the implementation — this module names the failure classes and decides
 * readiness deterministically so the judgement is repeatable.
 *
 * The named classes, mirroring `/speckit.analyze`'s detection passes:
 *   - `unquantified-adjective` — a vague qualifier ("fast", "appropriate")
 *     used in a sentence carrying no measurable criterion.
 *   - `unresolved-placeholder` — `TODO`, `TBD`, `???`, `<placeholder>`.
 *   - `unobservable-scope-item` — an accepted-scope bullet whose verb names an
 *     action with no observable outcome.
 *   - `terminology-drift` — a significant term in the issue title that appears
 *     nowhere in the understanding.
 *   - `missing-understanding` — no `## Current Understanding` content at all.
 *     Absence of a block is not a pass; readiness must be positively earned.
 *
 * The rubric checks the *text*, never the code — it never opens a source file
 * and never comments on the implementation.
 *
 * Cost: a fixed word list and a handful of regexes over one section of the
 * issue body, capped at {@link MAX_FINDINGS} findings, so it can run on every
 * round without lengthening it.
 *
 * {@link decideGrillMeReadiness} is the readiness decision — findings present
 * means not ready. {@link formatRubricFindings} renders the findings for the
 * grill-me prompt; every excerpt it emits is drawn from untrusted GitHub text,
 * so excerpts are character-filtered, truncated, and run through
 * `sanitiseDelimiterPatterns()` before they leave this module.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { sanitiseDelimiterPatterns } from "./prompt_delimiter.ts";

/** Marker opening the grill-me understanding block in an issue body. */
export const UNDERSTANDING_START_MARKER =
  "<!-- GRILL-ME-UNDERSTANDING-START -->";

/** Marker closing the grill-me understanding block in an issue body. */
export const UNDERSTANDING_END_MARKER = "<!-- GRILL-ME-UNDERSTANDING-END -->";

/** Upper bound on reported findings — the rubric stays cheap and bounded. */
export const MAX_FINDINGS = 8;

/** The named requirements-quality failure classes. */
export type RubricClass =
  | "missing-understanding"
  | "unquantified-adjective"
  | "unresolved-placeholder"
  | "unobservable-scope-item"
  | "terminology-drift";

/** A single flagged item in the converged understanding. */
export interface RubricFinding {
  /** Which named class tripped. */
  rubricClass: RubricClass;
  /** Sanitised, truncated fragment naming what tripped it (may be empty). */
  excerpt: string;
  /** One-line reason, safe to render into a prompt. */
  detail: string;
}

/** Input to the rubric — the issue title and body (or understanding text). */
export interface RubricInput {
  /** Issue title, untrusted GitHub text. */
  title: string;
  /**
   * Issue body, untrusted GitHub text. Only the block between the
   * understanding markers is judged; a body without them carries no
   * converged understanding and is reported as `missing-understanding`.
   */
  body: string;
}

/** The readiness decision: ready only when nothing is flagged. */
export interface ReadinessDecision {
  /** True when no class tripped — the round may report Ready. */
  ready: boolean;
  /** Everything the rubric flagged, most-specific class first. */
  findings: RubricFinding[];
}

/**
 * Vague qualifiers that need a measurable criterion beside them.
 *
 * American spellings sit beside the Australian ones deliberately — the text
 * being judged is a user's issue body, not this repository's source.
 */
export const VAGUE_TERMS: readonly string[] = [
  "acceptable",
  "adequate",
  "appropriate",
  "appropriately",
  "as needed",
  "as required",
  "easy",
  "efficient",
  "efficiently",
  "fast",
  "flexible",
  "intuitive",
  "minimal",
  "modern",
  "optimal",
  "performant",
  "proper",
  "properly",
  "quick",
  "quickly",
  "reasonable",
  "reasonably",
  "reliable",
  "responsive",
  "robust",
  "scalable",
  "seamless",
  "simple",
  "slow",
  "sufficient",
  "sufficiently",
  "timely",
  "user-friendly",
];

/** Verbs that name an action without naming its outcome. */
const VAGUE_VERBS: readonly string[] = [
  "address",
  "clean",
  "consider",
  "cover",
  "enhance",
  "handle",
  "improve",
  "investigate",
  "manage",
  "modernise",
  "modernize",
  "optimise",
  "optimize",
  "process",
  "refactor",
  "review",
  "streamline",
  "support",
  "tidy",
];

/** Words that mark an observable result on a scope item. */
const OBSERVABLE_MARKERS: readonly string[] = [
  "appears",
  "asserts",
  "displays",
  "emits",
  "equals",
  "exit",
  "exits",
  "fails",
  "logs",
  "matches",
  "must",
  "posts",
  "produces",
  "raises",
  "renders",
  "reports",
  "returns",
  "shows",
  "so that",
  "stores",
  "throws",
  "writes",
];

/** Title words too generic to count as a term the understanding must carry. */
const TITLE_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "already",
  "always",
  "because",
  "before",
  "being",
  "between",
  "chore",
  "could",
  "should",
  "still",
  "their",
  "there",
  "these",
  "thing",
  "things",
  "those",
  "under",
  "until",
  "using",
  "where",
  "which",
  "while",
  "would",
]);

/** Placeholder shapes an unfinished requirement leaves behind. */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\bTODO\b/gi,
  /\bTBD\b/gi,
  /\bFIXME\b/gi,
  /\bXXX\b/g,
  /\?{2,}/g,
  // `<placeholder>`-style gaps. The inner class excludes `:` and `!` so
  // autolinks (`<https://…>`) and HTML comments are not mistaken for gaps.
  /<[A-Za-z][A-Za-z0-9 _/-]{0,38}>/g,
];

const ANY_HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const ACCEPTED_SCOPE_HEADING_RE = /^\s{0,3}#{1,6}\s+accepted\s+scope/i;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;

/**
 * Extract the understanding text the rubric judges.
 *
 * Extraction is strict: without the opening marker the body carries no
 * grill-me understanding, and the rubric must not fall back to judging the
 * user's raw problem statement as though it were a converged requirement.
 *
 * @param body - Full issue body
 * @returns The block between the markers, or `""` when there is none
 */
export function extractUnderstanding(body: string): string {
  if (!body) return "";
  const start = body.indexOf(UNDERSTANDING_START_MARKER);
  if (start < 0) return "";
  const from = start + UNDERSTANDING_START_MARKER.length;
  const end = body.indexOf(UNDERSTANDING_END_MARKER, from);
  return (end < 0 ? body.slice(from) : body.slice(from, end)).trim();
}

/**
 * Render an untrusted fragment safe to place outside the prompt's fenced
 * untrusted region: collapse whitespace, drop every character a finding does
 * not need, truncate, then neutralise delimiter-shaped patterns.
 */
function safeExcerpt(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const filtered = collapsed.replace(/[^A-Za-z0-9 .,'?<>_-]/g, "");
  const truncated = filtered.length > 60
    ? `${filtered.slice(0, 57)}...`
    : filtered;
  return sanitiseDelimiterPatterns(truncated);
}

/** Escape a literal term for use inside a RegExp. */
function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split the understanding into the units a vague qualifier is judged in: one
 * sentence or one bullet line. A measurable criterion has to sit beside the
 * qualifier, not somewhere else in the document.
 */
function splitSegments(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?;:])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Flag vague qualifiers used with no measurable criterion beside them. */
function detectUnquantifiedAdjectives(understanding: string): RubricFinding[] {
  const findings: RubricFinding[] = [];
  const seen = new Set<string>();

  for (const segment of splitSegments(understanding)) {
    // A digit in the same sentence is the measurable criterion the class asks
    // for ("fast — under 2 seconds"), so the qualifier is grounded.
    if (/\d/.test(segment)) continue;
    for (const term of VAGUE_TERMS) {
      if (seen.has(term)) continue;
      if (!new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(segment)) {
        continue;
      }
      seen.add(term);
      findings.push({
        rubricClass: "unquantified-adjective",
        excerpt: safeExcerpt(term),
        detail:
          `"${term}" is used with no measurable criterion in the same sentence`,
      });
    }
  }
  return findings;
}

/** Flag unresolved placeholders left in the understanding. */
function detectPlaceholders(understanding: string): RubricFinding[] {
  const findings: RubricFinding[] = [];
  const seen = new Set<string>();

  for (const pattern of PLACEHOLDER_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const match of understanding.matchAll(re)) {
      const token = match[0].trim();
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        rubricClass: "unresolved-placeholder",
        excerpt: safeExcerpt(token),
        detail: `unresolved placeholder "${safeExcerpt(token)}" is still open`,
      });
    }
  }
  return findings;
}

/** Collect the bullets under the `Accepted scope` heading. */
function acceptedScopeBullets(understanding: string): string[] {
  const lines = understanding.split(/\r?\n/);
  const bullets: string[] = [];
  let inScope = false;

  for (const line of lines) {
    if (ACCEPTED_SCOPE_HEADING_RE.test(line)) {
      inScope = true;
      continue;
    }
    if (inScope && ANY_HEADING_RE.test(line)) break;
    if (!inScope) continue;
    const bullet = line.match(BULLET_RE);
    if (bullet) bullets.push(bullet[1]!.trim());
  }
  return bullets;
}

/**
 * Split a bullet into lower-case word tokens.
 *
 * Whole-word matching without a regex built from data: `new RegExp(`\\b${m}\\b`)`
 * constructs a pattern per marker per bullet, which semgrep's
 * `detect-non-literal-regexp` rule flags — correctly, since a marker list that
 * ever came from configuration would make the ReDoS surface real. Tokens do
 * the same job with a fixed pattern.
 */
function wordTokens(text: string): string[] {
  return text.match(/[a-z0-9]+/g) ?? [];
}

/**
 * Whether the text carries an observable-outcome marker as whole words.
 *
 * Multi-word markers (`so that`) match as a contiguous token run, which is
 * what the word-boundary regex did.
 */
function containsObservableMarker(lower: string): boolean {
  const tokens = wordTokens(lower);
  return OBSERVABLE_MARKERS.some((marker) => {
    const markerTokens = wordTokens(marker);
    if (markerTokens.length === 0) return false;
    return tokens.some((_, index) =>
      markerTokens.every((part, offset) => tokens[index + offset] === part)
    );
  });
}

/** Flag accepted-scope items that name an action but no observable outcome. */
function detectUnobservableScopeItems(understanding: string): RubricFinding[] {
  const findings: RubricFinding[] = [];

  for (const bullet of acceptedScopeBullets(understanding)) {
    const lower = bullet.toLowerCase();
    if (/\d/.test(lower)) continue;
    if (containsObservableMarker(lower)) continue;
    const firstWord = lower.replace(/^to\s+/, "").match(/^[a-z]+/)?.[0] ?? "";
    if (!VAGUE_VERBS.includes(firstWord)) continue;

    findings.push({
      rubricClass: "unobservable-scope-item",
      excerpt: safeExcerpt(bullet),
      detail:
        `accepted-scope item "${safeExcerpt(bullet)}" names an action with ` +
        "no observable outcome",
    });
  }
  return findings;
}

/** Reduce a word to a crude stem so plurals do not read as drift. */
function stem(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("es") && word.length > 5) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 4) return word.slice(0, -1);
  return word;
}

/** Flag significant title terms that appear nowhere in the understanding. */
function detectTerminologyDrift(
  title: string,
  understanding: string,
): RubricFinding[] {
  const haystack = understanding.toLowerCase();
  const findings: RubricFinding[] = [];
  const seen = new Set<string>();

  // Drop any conventional prefix (`bug:`, `feat:`) before tokenising.
  const stripped = title.replace(/^\s*[a-z]+\s*:\s*/i, "");
  for (const raw of stripped.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) ?? []) {
    if (TITLE_STOPWORDS.has(raw)) continue;
    const root = stem(raw);
    if (seen.has(root)) continue;
    seen.add(root);
    if (haystack.includes(root)) continue;
    findings.push({
      rubricClass: "terminology-drift",
      excerpt: safeExcerpt(raw),
      detail: `the title term "${safeExcerpt(raw)}" appears nowhere in the ` +
        "understanding — same concept renamed, or scope drifted?",
    });
    // Three drift terms are enough to act on; the class stays bounded.
    if (findings.length >= 3) break;
  }
  return findings;
}

/**
 * Run every detection class over the understanding.
 *
 * @param input - Issue title and body (or bare understanding text)
 * @returns Findings, capped at {@link MAX_FINDINGS}
 */
export function evaluateRequirementsRubric(
  input: RubricInput,
): RubricFinding[] {
  const understanding = extractUnderstanding(input.body ?? "");
  if (understanding.length === 0) {
    return [{
      rubricClass: "missing-understanding",
      excerpt: "",
      detail:
        "the issue body carries no `## Current Understanding` content to check",
    }];
  }

  const findings = [
    ...detectPlaceholders(understanding),
    ...detectUnquantifiedAdjectives(understanding),
    ...detectUnobservableScopeItems(understanding),
    ...detectTerminologyDrift(input.title ?? "", understanding),
  ];
  return findings.slice(0, MAX_FINDINGS);
}

/**
 * The readiness decision: a round may report Ready only when the rubric
 * flags nothing. A flagged item is an open question, not a silent pass.
 *
 * @param input - Issue title and body (or bare understanding text)
 * @returns Whether the round may report Ready, and why not when it may not
 */
export function decideGrillMeReadiness(input: RubricInput): ReadinessDecision {
  const findings = evaluateRequirementsRubric(input);
  return { ready: findings.length === 0, findings };
}

/**
 * Render findings for the grill-me prompt.
 *
 * @param findings - Findings from {@link evaluateRequirementsRubric}
 * @returns A bullet list, or the explicit "nothing flagged" line
 */
export function formatRubricFindings(
  findings: readonly RubricFinding[],
): string {
  if (findings.length === 0) {
    return "None — the deterministic pre-check flagged nothing in the " +
      "understanding currently in the issue body. Still run the self-check " +
      "yourself on the understanding you write this round.";
  }
  return findings
    .map((f) => `- \`${f.rubricClass}\` — ${f.detail}.`)
    .join("\n");
}
