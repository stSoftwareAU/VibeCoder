/**
 * Quality gate check: every label applied at `gh issue create` time must be
 * built by `guardedLabelArgs` (Issue #1276).
 *
 * `worker_label_guard.ts` documents a whole-worker invariant — every label
 * the worker applies passes its positive allowlist — but until #1276 it was
 * wired into two call sites only, both of which label an issue that already
 * exists. The scan and idle-task templates apply theirs at *creation* time,
 * pushing `"--label", <value>` straight into the `gh issue create` argv, so
 * nothing checked them. Routing those sites through
 * `guarded_issue_labels.ts` fixed the instances; this check keeps the class
 * fixed by failing the build on any new unguarded `--label` argument.
 *
 * Like the `needs-human` chokepoint check (Issue #2689) and the `gh` spawn
 * chokepoint check (Issue #3703), this is an architectural, whole-codebase
 * invariant — a static property rather than the behaviour of a single
 * function — so it lives in the quality gate, not the unit-test runner. The
 * scanning functions are pure and exported so they can be tested
 * behaviourally against literal inputs
 * (`tests/issue_create_label_check_test.ts`).
 *
 * Scope: only *creation* labels. A `"--label"` used as a read filter
 * (`gh issue list --label x --state open`) applies nothing, so the scanner
 * ignores an argv whose subcommand verb is not `create`.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** Which rule flagged a violation. */
export type CreateLabelRule = "create-argv" | "label-push" | "label-array";

/** A single unguarded creation-label violation found during scanning. */
export interface CreateLabelViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line number of the offending `--label` argument. */
  line: number;
  /** Trimmed text of the offending line. */
  text: string;
  /** Which rule matched, for diagnostics. */
  rule: CreateLabelRule;
}

/** Result of scanning one or more directories. */
export interface CreateLabelCheckResult {
  violations: CreateLabelViolation[];
  filesScanned: number;
}

/**
 * Files permitted to build `gh issue create` label arguments by hand.
 *
 * Kept deliberately short, and every entry carries its reason:
 *   - `guarded_issue_labels.ts` — the chokepoint itself, which is where
 *     `--label` is supposed to be written;
 *   - `github.ts` — its labels come from the model's `suggest-improvements`
 *     output rather than a worker-curated constant. Externally-derived
 *     labels cannot pass a positive allowlist that enumerates worker
 *     content, so that path is guarded the other way round: by the
 *     reserved-label denylist in `filterReservedLabelsWithWarning`
 *     (Issue #2825);
 *   - `escalate_as_work.ts` — deliberately applies the configured pickup
 *     label (`work-on` by default) when the fleet files a stuck PR as work
 *     (Issue #569), which is a label the positive allowlist forbids by
 *     design.
 */
export const CREATE_LABEL_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  "worker/deno/lib/guarded_issue_labels.ts",
  "worker/deno/lib/github.ts",
  "worker/deno/lib/escalate_as_work.ts",
]);

/**
 * How far back the scanner looks for the subcommand verb that owns a
 * `--label` argument. Worker argv arrays are a dozen lines at most; 40 lines
 * is generous without reaching into an unrelated earlier statement.
 */
const VERB_LOOKBACK_LINES = 40;

/** Matches a `--label` argument pushed onto an argv array by hand. */
export const LABEL_PUSH_PATTERN = /\.push\s*\(\s*["'][-]{2}label["']/;

/** Matches a hand-built `["--label", value]` argument pair. */
export const LABEL_ARRAY_PATTERN = /\[\s*["'][-]{2}label["']\s*,/;

/** Matches a `"--label"` string literal used as an argv entry. */
const LABEL_LITERAL_PATTERN = /["'][-]{2}label["']/;

/** Matches the `gh` subcommand group an argv array opens with. */
const SUBCOMMAND_GROUP_PATTERN = /["'](issue|pr)["']\s*,/;

/** Matches the verb that follows the subcommand group. */
const VERB_PATTERN = /["']([a-z][a-z-]*)["']/;

/**
 * Strip C-style block comments, preserving newlines so line numbers stay
 * aligned.
 */
function stripBlockComments(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\//g,
    (match) => match.replace(/[^\n]/g, " "),
  );
}

/** Strip trailing `//` line comments, preserving the line count. */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Resolve the `gh` verb owning the argv entry on line `index`.
 *
 * Walks backwards for the nearest `"issue"` / `"pr"` subcommand literal and
 * returns the verb literal that follows it — on the same line for an inline
 * array, otherwise on the next non-blank line. Returns `null` when no
 * subcommand group is found within {@link VERB_LOOKBACK_LINES}.
 */
export function resolveOwningVerb(
  lines: readonly string[],
  index: number,
): string | null {
  const floor = Math.max(0, index - VERB_LOOKBACK_LINES);
  for (let i = index; i >= floor; i--) {
    const line = lines[i] ?? "";
    const group = SUBCOMMAND_GROUP_PATTERN.exec(line);
    if (group === null) continue;

    // Inline form: `["issue", "create", …]` — the verb trails on this line.
    const rest = line.slice((group.index ?? 0) + group[0].length);
    const inline = VERB_PATTERN.exec(rest);
    if (inline?.[1] !== undefined) return inline[1];

    // Multi-line form: the verb is the next non-blank line.
    for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
      const next = (lines[j] ?? "").trim();
      if (next === "") continue;
      const verb = VERB_PATTERN.exec(next);
      return verb?.[1] ?? null;
    }
    return null;
  }
  return null;
}

/**
 * Scan a file's content for `--label` arguments that skip the guard.
 *
 * Three rules, all operating on comment-stripped source so that prose
 * mentioning the pattern (including this module's own documentation) cannot
 * trip a false positive:
 *
 *   1. `create-argv` — a `"--label"` argv entry whose owning `gh` verb is
 *      `create`. A `"--label"` under `list`, `view` or any other read verb
 *      applies no label and is ignored.
 *   2. `label-push` — a `.push("--label", …)` call, the shape the scan
 *      filers used to grow extra labels onto an argv.
 *   3. `label-array` — a `["--label", value]` pair, the shape a
 *      `flatMap` label builder produces.
 *
 * @param content - The raw file text.
 * @param repoRelPath - Repo-relative path, recorded on each violation.
 * @returns One violation per offending line, ordered by line number.
 */
export function scanContentForUnguardedCreateLabels(
  content: string,
  repoRelPath: string,
): CreateLabelViolation[] {
  const rawLines = content.split("\n");
  const lines = stripLineComments(stripBlockComments(content)).split("\n");
  const byLine = new Map<number, CreateLabelViolation>();

  const record = (index: number, rule: CreateLabelRule): void => {
    const line = index + 1;
    if (byLine.has(line)) return;
    byLine.set(line, {
      file: repoRelPath,
      line,
      text: (rawLines[index] ?? "").trim(),
      rule,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!LABEL_LITERAL_PATTERN.test(line)) continue;

    if (LABEL_PUSH_PATTERN.test(line)) {
      record(i, "label-push");
      continue;
    }
    if (LABEL_ARRAY_PATTERN.test(line)) {
      record(i, "label-array");
      continue;
    }
    if (resolveOwningVerb(lines, i) === "create") {
      record(i, "create-argv");
    }
  }

  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/** Recursively walk a directory yielding `.ts` file paths (absolute). */
async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    // Directory does not exist — yield nothing.
    return;
  }
  for (const entry of entries) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkTsFiles(fullPath);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      yield fullPath;
    }
  }
}

/**
 * Scan the given repo-relative directories for `gh issue create` label
 * arguments that skip the `guardedLabelArgs` chokepoint.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param relDirs - Repo-relative directories to scan.
 * @returns Aggregated violations and the number of files scanned.
 */
export async function scanDirectoriesForUnguardedCreateLabels(
  repoRoot: string,
  relDirs: string[],
): Promise<CreateLabelCheckResult> {
  const root = repoRoot.replace(/\/$/, "");
  const violations: CreateLabelViolation[] = [];
  let filesScanned = 0;

  for (const relDir of relDirs) {
    const absDir = `${root}/${relDir}`;
    for await (const absFile of walkTsFiles(absDir)) {
      const repoRel = absFile.slice(root.length + 1);
      if (CREATE_LABEL_ALLOWLIST.has(repoRel)) continue;
      filesScanned++;
      const content = await Deno.readTextFile(absFile);
      violations.push(
        ...scanContentForUnguardedCreateLabels(content, repoRel),
      );
    }
  }

  return { violations, filesScanned };
}
