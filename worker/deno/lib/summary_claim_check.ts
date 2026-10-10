/**
 * First-run PR-summary claim check (Issue #3257).
 *
 * A first-run PR summary has repeatedly described named code wrongly —
 * quoting a function, file, test, regex or pattern and saying what it does,
 * contains, matches or covers when the head says something else
 * (VibeCoder#3252, #3132). The drift check in `pr_feedback_drift_check.ts`
 * (Issue #3143) catches exactly this shape of problem, but only on a
 * review-fix push; it never runs on the very first turn that writes the
 * summary and raises the PR. This module is that first-run counterpart,
 * called from the completion phase before the PR is raised. Its findings are
 * turned into a summary-rule block on the same `recoverFromSummaryRuleBlock`
 * path (`summary_rule_gate_retry.ts`) the completion phase's other gates
 * already use, so a bad claim gets one recovery turn rather than shipping.
 *
 * Two independent checks feed one result:
 *
 *   1. A deterministic Test Plan backstop ({@link findTestPlanClaimProblems})
 *      that needs no model call: it finds a quoted behaviour attached to a
 *      named test file in the summary's `## Test Plan` section and checks,
 *      by matching significant words, whether any test declaration in that
 *      file — or its preamble, the text before the first declaration, where
 *      a fixture shared by more than one test tends to live (Issue #3257
 *      corpus run against pr-summary-1549/3222) — actually looks like it
 *      covers the claim. A quote only attaches to a test-file reference when
 *      no other backtick span (a command, a path, an error message) sits
 *      between them in the block (Issue #3257 corpus run against
 *      pr-summary-3178/599); a quote that qualifies on neither side is not a
 *      test-coverage claim and is ignored.
 *   2. One constrained, read-only model question ({@link
 *      buildSummaryClaimQuestionPrompt}), reusing {@link
 *      renderDriftVerdictQuestion} and {@link parseDriftVerdict} from
 *      `pr_feedback_drift_check.ts`, asking the model to quote every
 *      sentence in the summary that names code and gets it wrong. A finding
 *      is confirmed only when it names the summary file and quotes it
 *      verbatim — this module never trusts a model claim about a file it
 *      never asked about, mirroring the review-fix drift check's own
 *      posture.
 *
 * The model question also covers the Markdown manuals and prompts the branch
 * changes (Issue #3347): `isManualProsePath` in `doc_prose_claims.ts` picks
 * them from the changed files, capped at `MAX_DOC_PROSE_FILES` with the rest
 * reported as not checked. It asks whether the head code that decides a
 * when / refuses-allows / absolute-word sentence agrees with it. Such a
 * finding is confirmed only when it names one of those files and quotes its
 * current text, and lands in `docFindings`, never in `findings`.
 *
 * ```mermaid
 * flowchart TD
 *     A["Completion phase, before raising the PR"] --> B["Test Plan backstop:<br/>quoted behaviour vs. named test file"]
 *     A --> C{"Base ref known?"}
 *     C -- no --> D["notChecked"]
 *     C -- yes --> E["One read-only model question:<br/>quote wrong claims about named code<br/>and changed manual and prompt prose"]
 *     E --> F["Confirm each finding against<br/>the summary's or the doc's own text"]
 *     B --> G["SummaryClaimCheckResult"]
 *     F --> G
 *     D --> G
 *     G --> H{"Any confirmed finding or<br/>Test Plan problem?"}
 *     H -- yes --> I["summary-rule block<br/>(recoverFromSummaryRuleBlock)"]
 *     H -- no --> J["clean"]
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type DriftFinding,
  parseDriftVerdict,
  renderDriftVerdictQuestion,
  sentenceFoundIn,
} from "./pr_feedback_drift_check.ts";
import { extractTestPlanSection, logicalBlocks } from "./test_plan_recount.ts";
import { isTestFilePath } from "./security_fix_gate.ts";
import { generateBoundaryId, isBoundaryId } from "./prompt_delimiter.ts";
import {
  docProseClaimInstruction,
  isManualProsePath,
  MAX_DOC_PROSE_FILES,
  selectManualProseFiles,
} from "./doc_prose_claims.ts";
import type { Logger, Result } from "../types.ts";

/** A PR's base ref: a plausible git ref, never a flag or an absolute path. */
const BASE_REF_PATTERN = /^[A-Za-z0-9._\/-]{1,200}$/;

/** The recognised shapes of a PR-summary path this check can question. */
const SUMMARY_CLAIM_PATH_PATTERNS: readonly RegExp[] = [
  /^docs\/archive\/pr-summaries\/pr-summary-\d+\.md$/,
  /^docs\/pr-summary-\d+\.md$/,
];

/** Whether `path` is a PR-summary path this check knows how to question. */
export function isSummaryClaimPath(path: string): boolean {
  if (path === ".pr_summary") return true;
  return SUMMARY_CLAIM_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** What {@link buildSummaryClaimQuestionPrompt} names its fenced block. */
const SUMMARY_CLAIM_FILE_BLOCK = "the summary file to check";

/**
 * Build the constrained, read-only summary-claim question (Issue #3257).
 *
 * Reuses {@link renderDriftVerdictQuestion}, the renderer shared with the
 * review-fix drift check (Issue #3143): one question, no file edits, the
 * summary path fenced under a per-render CSPRNG nonce.
 *
 * @param opts.repo - `owner/name` of the repo the PR is for.
 * @param opts.issueNumber - The issue this run is working, a positive
 *   integer.
 * @param opts.baseRef - The PR's base ref, named in the `git diff` command.
 *   Validated as a plausible git ref — never a flag or an absolute path.
 * @param opts.summaryPath - The PR summary's repo-relative path. Must be one
 *   of the recognised PR-summary shapes.
 * @param opts.docFiles - The manual or prompt Markdown files the branch
 *   changes (Issue #3347), at most {@link MAX_DOC_PROSE_FILES}, each passing
 *   `isManualProsePath`. Empty asks the summary question alone; otherwise the
 *   question also covers the changed lines of each file.
 * @param opts.boundaryId - Pinned nonce for tests; production mints one.
 */
export function buildSummaryClaimQuestionPrompt(opts: {
  repo: string;
  issueNumber: number;
  baseRef: string;
  summaryPath: string;
  docFiles: readonly string[];
  boundaryId?: string;
}): string {
  if (opts.docFiles.length > MAX_DOC_PROSE_FILES) {
    throw new Error(
      `buildSummaryClaimQuestionPrompt accepts at most ${MAX_DOC_PROSE_FILES} manual or prompt files, got ${opts.docFiles.length}`,
    );
  }
  for (const docFile of opts.docFiles) {
    if (!isManualProsePath(docFile)) {
      throw new Error(
        `buildSummaryClaimQuestionPrompt requires manual or prompt Markdown paths, got '${docFile}'`,
      );
    }
  }
  if (
    !BASE_REF_PATTERN.test(opts.baseRef) ||
    opts.baseRef.includes("..") ||
    opts.baseRef.startsWith("-") ||
    opts.baseRef.startsWith("/")
  ) {
    throw new Error(
      `buildSummaryClaimQuestionPrompt requires a well-formed base ref, got '${opts.baseRef}'`,
    );
  }
  if (!isSummaryClaimPath(opts.summaryPath)) {
    throw new Error(
      `buildSummaryClaimQuestionPrompt requires a recognised PR-summary path, got '${opts.summaryPath}'`,
    );
  }
  if (!Number.isInteger(opts.issueNumber) || opts.issueNumber <= 0) {
    throw new Error(
      `buildSummaryClaimQuestionPrompt requires a positive integer issue number, got '${opts.issueNumber}'`,
    );
  }

  const boundaryId = isBoundaryId(opts.boundaryId)
    ? opts.boundaryId
    : generateBoundaryId();

  const hasDocs = opts.docFiles.length > 0;
  const summaryInstruction = "Check only sentences that name a function, " +
    "file, test, regex or pattern and say what it does, contains, matches " +
    "or covers — an " +
    'illustrative example ("for example `X`") is such a claim too. ' +
    "Check each against the head with Read or Grep (open the named " +
    "code, or grep the named file for the stated property). List every " +
    "such sentence that is false at the head: the named thing does not " +
    "exist, or does not do, contain, match or cover what the sentence " +
    "says. Quote each verbatim, one per entry, `file` = the summary " +
    "path. Do not report a sentence you could not check, and do not " +
    "judge wording, style, or completeness.";
  const summaryExample = {
    file: opts.summaryPath,
    sentence:
      "`parseRow()` escapes the phrase and joins its words with `\\s+`.",
    reason: "the head's parseRow builds no regex",
  };

  return renderDriftVerdictQuestion({
    intro: [
      `The worker is about to raise the PR for ${opts.repo}#${opts.issueNumber}. ` +
      `Run \`git diff ${opts.baseRef}...HEAD\` — the whole change on this ` +
      "branch — and `git status`, then read the summary file " +
      (hasDocs
        ? "and each manual or prompt file listed below at its current " +
          "working-tree content."
        : "listed below at its current working-tree content."),
    ],
    files: hasDocs ? [opts.summaryPath, ...opts.docFiles] : [opts.summaryPath],
    filesLabel: hasDocs
      ? "The files to check (the PR summary first, then the manuals and " +
        "prompts this branch changes):"
      : "The summary file to check:",
    filesBlockName: SUMMARY_CLAIM_FILE_BLOCK,
    instruction: hasDocs
      ? "For the summary file: " + summaryInstruction.replace(/^C/, "c") +
        "\n\n" + docProseClaimInstruction("this branch's diff")
      : summaryInstruction,
    example: {
      findings: hasDocs
        ? [
          summaryExample,
          {
            file: opts.docFiles[0]!,
            sentence: "A negative `cash` on a cash account is refused.",
            reason:
              "src/capacity.rs:88 catches the error, logs it and carries on with no capacity",
          },
        ]
        : [summaryExample],
    },
    boundaryId,
  });
}

// ---------------------------------------------------------------------------
// Deterministic Test Plan backstop.
// ---------------------------------------------------------------------------

/** One Test Plan claim this check could not confirm the head supports. */
export interface TestPlanClaimProblem {
  /** The logical Test Plan block the claim was found in (truncated). */
  line: string;
  /** The test file resolved for the claim. */
  testFile: string;
  /** The quoted behaviour, verbatim. */
  quote: string;
  /** Why the claim could not be confirmed. */
  kind: "missing-file" | "no-matching-test";
}

/** Result of {@link findTestPlanClaimProblems}. */
export interface TestPlanClaimCheck {
  problems: TestPlanClaimProblem[];
  notChecked: string[];
}

/** Cap on the number of Test Plan claims this backstop will check. */
const MAX_TEST_PLAN_CLAIMS = 50;

/** Cap on the size of a test file this backstop will read and split. */
const MAX_TEST_FILE_CHARS = 1_000_000;

/** Low-signal words dropped before comparing a quote to a test's words. */
const STOPWORD_SET = new Set([
  "that",
  "this",
  "with",
  "from",
  "into",
  "when",
  "then",
  "than",
  "each",
  "every",
  "only",
  "does",
  "have",
  "were",
  "will",
  "would",
  "should",
  "also",
  "test",
  "tests",
  "asserts",
  "covers",
  "checks",
  "which",
  "what",
  "their",
  "there",
  "after",
  "before",
  "still",
  "they",
  "them",
  "more",
  "most",
  "some",
  "such",
  "other",
  "about",
  "over",
  "under",
  "case",
  "cases",
]);

/** Strip one trailing "ing" | "ed" | "es" | "s" when ≥ 3 chars would remain. */
function stemWord(word: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}

/**
 * Split camelCase, lowercase, tokenise, drop short/stopword tokens and stem
 * what remains — the comparable "significant words" of a quote or a test
 * segment's text.
 */
function significantWords(text: string, minLen: number): string[] {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const tokens = spaced.match(/[a-z0-9]+/g) ?? [];
  const out: string[] = [];
  for (const token of tokens) {
    if (token.length < minLen) continue;
    if (STOPWORD_SET.has(token)) continue;
    out.push(stemWord(token));
  }
  return out;
}

/** A quote word matches a segment token when equal, or a ≥4-char prefix. */
function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 4 && longer.startsWith(shorter);
}

/** Whether `segmentWords` covers at least half of the quote's distinct words. */
function quoteCoveredBy(
  quoteWords: readonly string[],
  segmentWords: readonly string[],
): boolean {
  const unique = [...new Set(quoteWords)];
  if (unique.length === 0) return true;
  const needed = Math.ceil(unique.length / 2);
  let matched = 0;
  for (const word of unique) {
    if (segmentWords.some((candidate) => wordsMatch(word, candidate))) {
      matched++;
    }
  }
  return matched >= needed;
}

/**
 * Split a test file's source into segments at declaration starts, one
 * multiline regex covering the shapes this backstop recognises across
 * languages. Each segment runs from one declaration start to the next (or
 * the end of the file), so its body text is available for word-matching.
 * The file's preamble — everything before the first declaration — is kept
 * separately: a shared fixture (a module-level constant quoted by more than
 * one test, Issue #3257 corpus run against pr-summary-1549/3222) lives there
 * rather than inside any single segment, and is checked as one more
 * candidate alongside the segments.
 */
const TEST_DECLARATION_RE =
  /\bDeno\.test\b|^[ \t]*(?:it|test)(?:\.(?:only|skip|ignore|each))?\s*\(|#\[(?:tokio::)?test\]|^[ \t]*(?:async\s+)?def\s+test_|^[ \t]*func\s+Test|^[ \t]*@test\b/gm;

/** A test file's source, split for the Test Plan backstop's coverage check. */
interface TestFileSplit {
  /** One segment per declaration, declaration start to the next (or EOF). */
  segments: string[];
  /** Text before the first declaration — shared fixtures live here. */
  preamble: string;
}

function splitIntoTestSegments(content: string): TestFileSplit {
  const matches = [...content.matchAll(TEST_DECLARATION_RE)];
  if (matches.length === 0) return { segments: [], preamble: "" };
  const firstStart = matches[0]!.index ?? 0;
  const preamble = content.slice(0, firstStart);
  const segments: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index ?? 0;
    const end = i + 1 < matches.length
      ? (matches[i + 1]!.index ?? content.length)
      : content.length;
    segments.push(content.slice(start, end));
  }
  return { segments, preamble };
}

/** A span of a backtick-fenced run inside a Test Plan block. */
interface Span {
  start: number;
  end: number;
}

/** A test-file reference found inside backticks, at its span in the block. */
interface TestFileRef extends Span {
  path: string;
  /**
   * False when the span names a directory (trailing `/`) or a glob (`*?[`)
   * rather than one file — a quote attached to it is recorded as not
   * checked, never as a missing file.
   */
  fileShaped: boolean;
}

/** Whether a reference names one file, not a directory or a glob. */
function isFileShaped(ref: string): boolean {
  return !ref.endsWith("/") && !/[*?[]/.test(ref);
}

/** Bounded span patterns over untrusted Test Plan text (Issue #3143 posture). */
const BACKTICK_SPAN_RE = /`([^`\n]{1,300})`/g;
const QUOTE_SPAN_RE = /"([^"\n]{1,300})"|“([^”\n]{1,300})”/g;

/**
 * Find test-file references inside backtick spans and blank those spans out
 * (same length, so later positions still align), so a quoted phrase sitting
 * inside backticks is never read as a behaviour claim. Every backtick span's
 * extent is kept too — not only the ones that resolve to a test file — so
 * {@link attachQuoteToRef} can tell whether an unrelated backtick-fenced
 * token (a shell command, a path, an error message) sits between a
 * candidate reference and the quote. A `::test` suffix, a `:line` suffix
 * and a leading `./` are stripped so the reference resolves as written.
 */
function findRefsAndBlank(
  block: string,
): { refs: TestFileRef[]; spans: Span[]; blanked: string } {
  const refs: TestFileRef[] = [];
  const spans: Span[] = [];
  let blanked = "";
  let last = 0;
  for (const m of block.matchAll(BACKTICK_SPAN_RE)) {
    const full = m[0];
    const inner = m[1] ?? "";
    const start = m.index ?? 0;
    const end = start + full.length;
    spans.push({ start, end });
    blanked += block.slice(last, start) + " ".repeat(full.length);
    last = end;

    let candidate = inner;
    const doubleColon = candidate.indexOf("::");
    if (doubleColon >= 0) candidate = candidate.slice(0, doubleColon);
    candidate = candidate.replace(/:\d+(?::\d+)?$/, "");
    if (candidate.startsWith("./")) candidate = candidate.slice(2);
    if (!/\s/.test(candidate) && isTestFilePath(candidate)) {
      refs.push({
        start,
        end,
        path: candidate,
        fileShaped: isFileShaped(candidate),
      });
    }
  }
  blanked += block.slice(last);
  return { refs, spans, blanked };
}

/** Whether no span in `spans` lies strictly between `fromEnd` and `toStart`. */
function noSpanBetween(
  fromEnd: number,
  toStart: number,
  spans: readonly Span[],
): boolean {
  if (toStart <= fromEnd) return true;
  return !spans.some((span) => span.start >= fromEnd && span.end <= toStart);
}

/**
 * Attach a quote to the nearest preceding test-file reference, or else the
 * nearest following one — but only when no other backtick span (a command,
 * a path, an error message) lies between the quote and that reference in
 * the block (Issue #3257 corpus run against pr-summary-3178/599). A quote
 * that qualifies on neither side is not a test-coverage claim.
 */
function attachQuoteToRef(
  quoteStart: number,
  quoteEnd: number,
  refs: readonly TestFileRef[],
  spans: readonly Span[],
): TestFileRef | undefined {
  let preceding: TestFileRef | undefined;
  for (const ref of refs) {
    if (ref.end <= quoteStart) {
      if (!preceding || ref.end > preceding.end) preceding = ref;
    }
  }
  if (preceding && noSpanBetween(preceding.end, quoteStart, spans)) {
    return preceding;
  }

  let following: TestFileRef | undefined;
  for (const ref of refs) {
    if (ref.start >= quoteEnd) {
      if (!following || ref.start < following.start) following = ref;
    }
  }
  if (following && noSpanBetween(quoteEnd, following.start, spans)) {
    return following;
  }

  return undefined;
}

type ResolvedRef =
  | { kind: "resolved"; path: string }
  | { kind: "ambiguous" }
  | { kind: "directory" }
  | { kind: "none" };

/**
 * Resolve a quoted test-file reference against the repo's tracked files. A
 * reference that names no tracked file but is a directory prefix of one
 * (`tests/unit`) resolves as `directory`, never as missing.
 */
function resolveTrackedPath(
  ref: string,
  trackedFiles: readonly string[],
): ResolvedRef {
  if (trackedFiles.includes(ref)) return { kind: "resolved", path: ref };
  const suffix = "/" + ref;
  const matches = trackedFiles.filter((path) => path.endsWith(suffix));
  if (matches.length === 1) return { kind: "resolved", path: matches[0]! };
  if (matches.length > 1) return { kind: "ambiguous" };
  const dir = ref + "/";
  const isDirectory = trackedFiles.some((path) =>
    path.startsWith(dir) || path.includes("/" + dir)
  );
  return isDirectory ? { kind: "directory" } : { kind: "none" };
}

/** Not-checked note for a reference that names a directory or a glob. */
function notAFileNote(ref: string): string {
  return `\`${ref}\` names a directory or pattern rather than a test file, ` +
    "so its Test Plan claims were not checked";
}

/**
 * Deterministic Test Plan backstop (Issue #3257): finds a quoted behaviour
 * attached to a named test file in the summary's `## Test Plan` section, and
 * flags one that no test declaration in that file looks like it covers.
 *
 * Never throws for an expected failure — an unresolvable, ambiguous,
 * unreadable or oversized file is reported through `notChecked` rather than
 * silently dropped.
 */
export async function findTestPlanClaimProblems(opts: {
  summary: string;
  trackedFiles: readonly string[];
  readFile: (repoRelativePath: string) => Promise<string | undefined>;
}): Promise<TestPlanClaimCheck> {
  const section = extractTestPlanSection(opts.summary);
  const blocks = logicalBlocks(section);
  const problems: TestPlanClaimProblem[] = [];
  const notChecked: string[] = [];
  const segmentCache = new Map<string, TestFileSplit | null>();
  const notedNonFiles = new Set<string>();
  let claimsChecked = 0;
  let claimsSkipped = 0;

  for (const block of blocks) {
    const { refs, spans, blanked } = findRefsAndBlank(block);
    if (refs.length === 0) continue;

    for (const m of blanked.matchAll(QUOTE_SPAN_RE)) {
      const quote = (m[1] ?? m[2] ?? "").trim();
      if (!quote) continue;
      const quoteWords = significantWords(quote, 4);
      const uniqueWords = [...new Set(quoteWords)];
      if (uniqueWords.length < 2) continue;

      const quoteStart = m.index ?? 0;
      const quoteEnd = quoteStart + m[0].length;
      const ref = attachQuoteToRef(quoteStart, quoteEnd, refs, spans);
      if (!ref) continue;

      if (claimsChecked >= MAX_TEST_PLAN_CLAIMS) {
        claimsSkipped++;
        continue;
      }
      claimsChecked++;

      const resolved = ref.fileShaped
        ? resolveTrackedPath(ref.path, opts.trackedFiles)
        : { kind: "directory" } as const;
      if (resolved.kind === "directory") {
        if (!notedNonFiles.has(ref.path)) {
          notedNonFiles.add(ref.path);
          notChecked.push(notAFileNote(ref.path));
        }
        continue;
      }
      if (resolved.kind === "none") {
        problems.push({
          line: block,
          testFile: ref.path,
          quote,
          kind: "missing-file",
        });
        continue;
      }
      if (resolved.kind === "ambiguous") {
        notChecked.push(
          `\`${ref.path}\` matches more than one tracked file, so its ` +
            "Test Plan claims were not checked",
        );
        continue;
      }
      const path = resolved.path;

      let segments = segmentCache.get(path);
      if (segments === undefined) {
        const content = await opts.readFile(path);
        if (content === undefined || content.length > MAX_TEST_FILE_CHARS) {
          notChecked.push(
            `\`${path}\` could not be read, so its Test Plan claims were ` +
              "not checked",
          );
          segments = null;
        } else {
          const split = splitIntoTestSegments(content);
          if (split.segments.length === 0) {
            notChecked.push(
              `\`${path}\` names no test declaration this check ` +
                "recognises, so its Test Plan claims were not checked",
            );
            segments = null;
          } else {
            segments = split;
          }
        }
        segmentCache.set(path, segments);
      }
      if (segments === null) continue;

      const covered = segments.segments.some((segment) =>
        quoteCoveredBy(uniqueWords, significantWords(segment, 3))
      ) || quoteCoveredBy(uniqueWords, significantWords(segments.preamble, 3));
      if (!covered) {
        problems.push({
          line: block,
          testFile: path,
          quote,
          kind: "no-matching-test",
        });
      }
    }
  }

  if (claimsSkipped > 0) {
    notChecked.push(
      `${claimsSkipped} further Test Plan claim(s) were not checked (cap ` +
        `of ${MAX_TEST_PLAN_CLAIMS} reached)`,
    );
  }

  return { problems, notChecked };
}

/** One line describing a Test Plan claim problem, in Australian English. */
export function describeTestPlanClaimProblem(p: TestPlanClaimProblem): string {
  if (p.kind === "missing-file") {
    return `Test Plan cites \`${p.testFile}\` for "${p.quote}", but ` +
      `${p.testFile} does not exist at the head`;
  }
  return `Test Plan cites \`${p.testFile}\` for "${p.quote}", but no test ` +
    `in ${p.testFile} shares the quoted words`;
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

/** What the first-run summary claim check found. */
export interface SummaryClaimCheckResult {
  /**
   * Findings confirmed against the summary's own current text. Summary-only:
   * the #3324 correction turn and carry-forward in
   * `summary_claim_correction.ts` act only on these.
   */
  findings: DriftFinding[];
  /**
   * Findings confirmed against a changed manual or prompt file's own current
   * text (Issue #3347).
   */
  docFindings: DriftFinding[];
  /** Findings the model returned that could not be confirmed — never acted on. */
  unconfirmedFindings: DriftFinding[];
  /** Deterministic Test Plan problems. */
  testPlanProblems: TestPlanClaimProblem[];
  /** Checks that could not be run, each with the reason. */
  notChecked: string[];
}

/** Whether the result should gate the PR via the summary-rule block path. */
export function summaryClaimCheckBlocked(r: SummaryClaimCheckResult): boolean {
  return r.findings.length > 0 || r.docFindings.length > 0 ||
    r.testPlanProblems.length > 0;
}

/** Git/model seams {@link runSummaryClaimCheck} needs, injected for testability. */
export interface SummaryClaimCheckDeps {
  /** Runs git in the checkout; null when git could not be run at all. */
  runGit: (
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string } | null>;
  /** Asks the one read-only model question. */
  askQuestion: (prompt: string) => Promise<Result<string>>;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

/** Input to {@link runSummaryClaimCheck}. */
export interface SummaryClaimCheckInput {
  repo: string;
  issueNumber: number;
  repoPath: string;
  /** The PR's base ref, or null when it could not be resolved. */
  baseRef: string | null;
  summaryPath: string;
  summaryContent: string;
  /**
   * The branch's changed files against the base, as the completion phase
   * listed them (Issue #3347); null when they could not be listed.
   */
  changedFiles: readonly string[] | null;
}

/**
 * Run the first-run PR-summary claim check (Issue #3257).
 *
 * Called by the completion phase before the PR is raised. Never throws for
 * an expected failure — every degradation is logged and recorded in
 * `notChecked` rather than blocking the run. A deterministic case — tracked
 * files could not be listed, the base ref is unresolvable, or the prompt
 * could not be built — logs at error level: the check itself failed. A
 * model-dependent case — the question could not be launched, or its reply
 * carried no readable verdict — logs at warn level instead, the same as
 * `runPrFeedbackDriftCheck`'s model pass (pr_feedback_drift_check.ts): an
 * unavailable or unreadable model answer is the model's or the host's
 * problem, not this check's.
 */
export async function runSummaryClaimCheck(
  input: SummaryClaimCheckInput,
  deps: SummaryClaimCheckDeps,
): Promise<SummaryClaimCheckResult> {
  const { repo, issueNumber } = input;
  const notChecked: string[] = [];
  let testPlanProblems: TestPlanClaimProblem[] = [];

  const lsFiles = await deps.runGit(["ls-files"]);
  if (!lsFiles || lsFiles.code !== 0) {
    const msg = "tracked files could not be listed; the Test Plan backstop " +
      "was skipped";
    notChecked.push(msg);
    deps.logger.error(`Summary claim check: ${msg}`, { repo, issueNumber });
  } else {
    const trackedFiles = lsFiles.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const readFile = async (
      repoRelativePath: string,
    ): Promise<string | undefined> => {
      try {
        return await Deno.readTextFile(
          `${input.repoPath}/${repoRelativePath}`,
        );
      } catch {
        return undefined;
      }
    };
    const check = await findTestPlanClaimProblems({
      summary: input.summaryContent,
      trackedFiles,
      readFile,
    });
    testPlanProblems = check.problems;
    for (const reason of check.notChecked) {
      notChecked.push(reason);
      deps.logger.error(`Summary claim check: ${reason}`, {
        repo,
        issueNumber,
      });
    }
  }

  const findings: DriftFinding[] = [];
  const docFindings: DriftFinding[] = [];
  const unconfirmedFindings: DriftFinding[] = [];

  if (input.baseRef === null) {
    const msg = "the PR's base ref could not be resolved; the model claim " +
      "check was skipped";
    notChecked.push(msg);
    deps.logger.error(`Summary claim check: ${msg}`, { repo, issueNumber });
  } else {
    const docContents = new Map<string, string>();
    if (input.changedFiles === null) {
      const msg = "the branch's changed files could not be listed; changed " +
        "manual and prompt prose was not checked";
      notChecked.push(msg);
      deps.logger.error(`Summary claim check: ${msg}`, { repo, issueNumber });
    } else {
      const selected = selectManualProseFiles(
        input.changedFiles.filter((f) => f !== input.summaryPath),
        MAX_DOC_PROSE_FILES,
      );
      if (selected.overCap.length > 0) {
        const msg =
          `${selected.overCap.length} changed manual or prompt file(s) over ` +
          `the ${MAX_DOC_PROSE_FILES}-file cap were not checked: ` +
          selected.overCap.join(", ");
        notChecked.push(msg);
        deps.logger.error(`Summary claim check: ${msg}`, {
          repo,
          issueNumber,
        });
      }
      for (const file of selected.files) {
        try {
          docContents.set(
            file,
            await Deno.readTextFile(`${input.repoPath}/${file}`),
          );
        } catch (err) {
          // Deleted on the branch: no prose left to check.
          if (err instanceof Deno.errors.NotFound) continue;
          const msg =
            `\`${file}\` could not be read; its prose was not checked`;
          notChecked.push(msg);
          deps.logger.error(`Summary claim check: ${msg}`, {
            repo,
            issueNumber,
          });
        }
      }
    }

    let prompt: string | undefined;
    try {
      prompt = buildSummaryClaimQuestionPrompt({
        repo,
        issueNumber,
        baseRef: input.baseRef,
        summaryPath: input.summaryPath,
        docFiles: [...docContents.keys()],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notChecked.push(msg);
      deps.logger.error(`Summary claim check: ${msg}`, { repo, issueNumber });
    }

    if (prompt !== undefined) {
      const result = await deps.askQuestion(prompt);
      if (!result.ok) {
        const msg = result.error.message;
        notChecked.push(msg);
        // Mirrors `runPrFeedbackDriftCheck` (pr_feedback_drift_check.ts),
        // which logs an unavailable model pass at warn: a model that could
        // not be launched is the host's or the model's problem, not a
        // deterministic check failing, and never blocks on its own.
        deps.logger.warn(
          `Summary claim check: model question failed: ${msg}`,
          { repo, issueNumber },
        );
      } else {
        const parsed = parseDriftVerdict(result.value);
        if (!parsed.ok) {
          const msg = parsed.error.message;
          notChecked.push(msg);
          // As above: an unreadable verdict is the model's problem, not a
          // deterministic check failing, so it logs at warn (Issue #3257).
          deps.logger.warn(`Summary claim check: ${msg}`, {
            repo,
            issueNumber,
          });
        } else {
          for (const finding of parsed.value) {
            const docContent = docContents.get(finding.file);
            if (
              finding.file === input.summaryPath &&
              sentenceFoundIn(finding.sentence, input.summaryContent)
            ) {
              findings.push(finding);
            } else if (
              docContent !== undefined &&
              sentenceFoundIn(finding.sentence, docContent)
            ) {
              docFindings.push(finding);
            } else {
              unconfirmedFindings.push(finding);
              deps.logger.warn(
                "Summary claim check: unconfirmed model finding, not acted on",
                {
                  repo,
                  issueNumber,
                  file: finding.file,
                  sentence: finding.sentence,
                },
              );
            }
          }
        }
      }
    }
  }

  return {
    findings,
    docFindings,
    unconfirmedFindings,
    testPlanProblems,
    notChecked,
  };
}

// ---------------------------------------------------------------------------
// PR-reply rendering.
// ---------------------------------------------------------------------------

/** Collapse whitespace and cap length, for interpolating untrusted text. */
function flatten(text: string, maxChars: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/**
 * One-line block reason for {@link summaryClaimCheckBlocked} (Issue #3257).
 */
export function summaryClaimBlockReason(r: SummaryClaimCheckResult): string {
  const first = r.findings[0]?.sentence ?? r.testPlanProblems[0]?.quote ?? "";
  const docFinding = r.docFindings[0];
  if (first === "" && r.findings.length === 0 && docFinding !== undefined) {
    return "Changed doc describes the PR's own behaviour wrongly: " +
      `\`${docFinding.file}\`: ${flatten(docFinding.sentence, 200)}`;
  }
  return `PR summary describes named code wrongly: ${flatten(first, 200)}`;
}

/**
 * Render the summary-rule gate comment for a blocked result (Issue #3257).
 */
export function buildSummaryClaimGateComment(
  r: SummaryClaimCheckResult,
): string {
  const lines: string[] = [];
  const summaryProblems = r.findings.length + r.testPlanProblems.length > 0;
  const hasDocFindings = r.docFindings.length > 0;
  if (summaryProblems) {
    lines.push("⚠️ **PR summary describes named code wrongly.**");
    lines.push("");
    lines.push(
      "Before raising the PR, the worker checked the summary's claims " +
        "about named code against the head:",
    );
    lines.push("");

    for (const f of r.findings) {
      lines.push(
        `- "${flatten(f.sentence, 500)}" — ${flatten(f.reason, 500)}`,
      );
    }
    for (const p of r.testPlanProblems) {
      lines.push(`- ${describeTestPlanClaimProblem(p)}`);
    }
    lines.push("");
  } else {
    lines.push(
      "⚠️ **A changed manual or prompt describes the PR's own behaviour " +
        "wrongly.**",
    );
    lines.push("");
  }

  if (hasDocFindings) {
    lines.push(
      "Before raising the PR, the worker checked the sentences this branch " +
        "adds or edits in its manuals and prompts against the head code " +
        "that decides them:",
    );
    lines.push("");
    for (const f of r.docFindings) {
      lines.push(
        `- \`${f.file}\`: "${flatten(f.sentence, 500)}" — ${
          flatten(f.reason, 500)
        }`,
      );
    }
    lines.push("");
  }

  const steps: string[] = [];
  if (summaryProblems) {
    steps.push(
      "Open the named function, file, or test at the head (Read or " +
        "Grep) and rewrite each sentence to say what the head actually " +
        "does, or remove it.",
      'An illustrative example ("for example `X`") is a claim too — ' +
        "grep `X` for the stated property before naming it.",
      "For a Test Plan bullet that quotes a behaviour, quote the name " +
        "of the test in that file that covers it, or drop the claim.",
    );
  }
  if (hasDocFindings) {
    steps.push(
      "For each flagged manual or prompt sentence, open the head code that " +
        "decides it (the branch condition, its callers, the list it names) " +
        "and rewrite that sentence in that file to say what the head code " +
        "does — name each condition, or scope it to the path it describes " +
        "— or remove it.",
    );
  }
  steps.push(
    !hasDocFindings
      ? "Fix the summary, not the code."
      : summaryProblems
      ? "Fix the summary and the flagged manual or prompt sentences, not " +
        "the code."
      : "Fix the flagged manual or prompt sentences, not the code.",
  );

  lines.push("Procedure:");
  steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));

  return lines.join("\n").trimEnd();
}
