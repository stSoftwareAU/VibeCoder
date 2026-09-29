/**
 * Detect a run that described a code change but made none (Issue #2687).
 *
 * A `work-on` run that ends with no commit used to be handed off as
 * "analysis-only" whenever it produced any substantial text. GRQ#4871 showed
 * the hole: the agent wrote out the fix and a RED/GREEN regression test, named
 * the files, and stopped — a failed implementation, not analysis. This module
 * recognises that shape so the no-changes phase retries the issue instead.
 *
 * The signal is one line that both names a file and says to change it in the
 * imperative ("Implement fix in `worker/shared/x.sh`"). Descriptive forms
 * ("`lib/foo.ts` adds a header") and negated lines ("no need to modify
 * `lib/foo.ts`") do not count. A false positive costs one extra run, bounded
 * by the failed-once → failed ladder; a false negative is the old hand-off.
 *
 * Pure and GitHub-free. Uses Australian English throughout.
 */

/** Most files reported, so a long plan cannot bloat a comment or reason. */
export const MAX_DESCRIBED_FILES = 10;

/** What {@link detectDescribedCodeChange} found. */
export interface DescribedCodeChange {
  /** True when some line names a file and tells the reader to change it. */
  described: boolean;
  /** The files those lines name, first-seen order, deduped and capped. */
  files: string[];
}

/** Code, config and doc extensions a fix plan names. */
const EXTENSIONS =
  "ts|tsx|js|mjs|cjs|jsx|py|rs|go|sh|bash|java|kt|rb|cs|php|swift|c|cpp|h|json|jsonc|yml|yaml|toml|md|sql|css|html";

/**
 * A path token: optional `dir/` segments, then `name.ext`, then `:line:col`.
 * The lookbehind starts a match only at a token boundary (leading slashes are
 * skipped), so each run of path characters is scanned once — linear on a long
 * hostile line rather than quadratic (Issue #2826).
 */
const PATH_RE = new RegExp(
  `(\`?)(?<![\\p{L}\\p{N}_./-])\\/*((?:[\\p{L}\\p{N}_.-]+/)*[\\p{L}\\p{N}_-][\\p{L}\\p{N}_.-]*\\.(?:${EXTENSIONS}))(?::\\d+)*(?![\\p{L}\\p{N}_])`,
  "gu",
);

/** Imperative change verbs, plus the TDD phrasing a fix plan uses. */
const INTENT_RE =
  /\b(?:fix|implement|add|write|edit|change|modify|update|refactor|create|patch|remove|delete|replace|rename|regression test|failing test)\b|\((?:RED|GREEN)\)/i;

/** A negated line describes what not to do. */
const NEGATION_RE = /\b(?:no|not|without|never)\b|n't\b/i;

const URL_RE = /\bhttps?:\/\/\S+/g;

/** File paths on one line; a bare `name.ext` needs backticks (not "Node.js"). */
function pathsOnLine(line: string): string[] {
  const paths: string[] = [];
  for (const match of line.matchAll(PATH_RE)) {
    const [, tick, path] = match;
    if (path!.includes("/") || tick === "`") paths.push(path!);
  }
  return paths;
}

/**
 * Report whether a run's output describes a code change it did not make.
 *
 * @param output - The run's final text output (redact before passing it on)
 * @returns Whether a change was described, and the files it names
 */
export function detectDescribedCodeChange(output: string): DescribedCodeChange {
  const files: string[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(URL_RE, "");
    if (!INTENT_RE.test(line) || NEGATION_RE.test(line)) continue;
    for (const path of pathsOnLine(line)) {
      if (!files.includes(path)) files.push(path);
    }
  }
  return {
    described: files.length > 0,
    files: files.slice(0, MAX_DESCRIBED_FILES),
  };
}
