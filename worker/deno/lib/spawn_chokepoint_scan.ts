/**
 * Shared machinery for the direct-subprocess-spawn chokepoint checks.
 *
 * Two quality-gate checks enforce the same architectural invariant against
 * different binaries — `gh` (Issue #3703) and `git` (Issue #1214): a
 * subprocess for that binary may only be constructed inside the one module
 * that owns the allowlist, the timeout and the audit journal for it. The
 * scanning half of both checks is identical, so it lives here once rather
 * than being copied per binary.
 *
 * The scanning functions are pure (or filesystem-only) and exported so each
 * check can be tested behaviourally against literal inputs.
 *
 * Each check owns its own **literal** spawn pattern rather than composing one
 * from the binary name: a `new RegExp(...)` built from a variable is a ReDoS
 * warning the gate's own semgrep stage raises, and hardcoding two short
 * regexes is both cheaper and clearer than defending a builder.
 *
 * ## Indirection (Issue #1378)
 *
 * A literal pattern only sees `new Deno.Command("gh", …)`. Four `lib/`
 * modules reached the same binary through a variable — `Deno.Command(cmd[0]!,
 * …)` fed by `runner(["gh", …])`, and `runWithTimeout("gh", …)` — so they
 * spawned `gh`/`git` outside the allowlist and the audit journal while the
 * gate reported a clean scan. {@link IndirectSpawnRules} closes that blind
 * spot with two further signals, both scanned across the whole file so a call
 * split over several lines still matches:
 *
 *  - the **generic wrapper** called with the literal binary
 *    (`runWithTimeout("gh", …)`), and
 *  - an **indirect construction** ({@link INDIRECT_SPAWN_PATTERN}) in a file
 *    that also hands the literal binary to a runner as the head of an argv
 *    (`runner(["gh", …])`, `run("git", …)`).
 *
 * The second signal is file-level and therefore approximate, so a file that
 * imports the binary's chokepoint module is taken to be routing through it
 * and is not flagged — that is what the compliant delegating runners in
 * `purge_stale_workflow_issues.ts` and `process_add_repo.ts` look like.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** A single direct-spawn violation found during scanning. */
export interface DirectSpawnViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line number of the offending spawn. */
  line: number;
  /** Trimmed text of the offending line. */
  text: string;
}

/** Result of scanning one or more directories. */
export interface DirectSpawnScanResult {
  violations: DirectSpawnViolation[];
  filesScanned: number;
}

/**
 * Matches a `Deno.Command` whose binary is an expression rather than a string
 * literal — `new Deno.Command(cmd[0]!, …)`, the shape the literal patterns
 * cannot see (Issue #1378).
 */
export const INDIRECT_SPAWN_PATTERN = /new\s+Deno\.Command\s*\(\s*[^"'`\s]/;

/** The indirection signals a check supplies for its binary (Issue #1378). */
export interface IndirectSpawnRules {
  /**
   * Matches a generic subprocess wrapper invoked with the literal binary,
   * e.g. `runWithTimeout("gh", …)`. Such a wrapper has no binary-specific
   * routing, so the call reaches the binary outside its chokepoint.
   */
  wrapperPattern: RegExp;
  /**
   * Matches the literal binary handed to a call as the head of its argv —
   * `runner(["gh", …])` or `run("git", …)`. Paired with
   * {@link INDIRECT_SPAWN_PATTERN} it identifies a module that spawns the
   * binary through a variable.
   */
  argvHeadPattern: RegExp;
  /**
   * Matches an import of the binary's chokepoint module. A file that imports
   * it delegates there, so its indirect construction is a fallback for other
   * binaries rather than a bypass.
   */
  chokepointImportPattern: RegExp;
}

/** Options for {@link scanDirectoriesForDirectSpawn}. */
export interface DirectSpawnScanOptions {
  /** Matches a direct construction of the guarded binary. */
  pattern: RegExp;
  /** Repo-relative paths permitted to spawn the binary directly. */
  allowlist: ReadonlySet<string>;
  /**
   * Skip `*_test.ts` files. Test code builds throwaway fixtures (temporary
   * git repositories, for instance) and is not a production surface.
   */
  excludeTests?: boolean;
  /** Indirection signals; omitted, only the literal pattern is enforced. */
  rules?: IndirectSpawnRules;
  /**
   * Repo-relative paths exempt from the **indirection** rule only — the
   * literal and wrapper patterns still apply. Each entry is a known gap
   * carrying its own follow-up, never a licence to spawn directly.
   */
  indirectExempt?: ReadonlySet<string>;
}

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

/**
 * The file's text with comments blanked out, newlines preserved so every
 * offset still maps to its original line.
 */
function codeOnly(content: string): string {
  return stripBlockComments(content)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Every 1-based line on which `pattern` matches, scanning the whole text so a
 * call split across lines still matches.
 *
 * The regex is used as given — never recompiled with a `g` flag — because a
 * `new RegExp(...)` built from a variable is what the gate's own semgrep
 * stage flags.
 */
function matchingLines(code: string, pattern: RegExp): number[] {
  const lines: number[] = [];
  let consumed = 0;
  let rest = code;

  while (rest.length > 0) {
    const match = pattern.exec(rest);
    if (!match) break;
    const offset = consumed + match.index;
    lines.push(code.slice(0, offset).split("\n").length);
    const advance = match.index + Math.max(1, match[0].length);
    consumed += advance;
    rest = rest.slice(advance);
  }

  return lines;
}

/**
 * Scan a file's content for direct spawns of the guarded binary.
 *
 * Block comments and trailing line comments are ignored so prose mentioning
 * the forbidden pattern (including a check module's own documentation) does
 * not trip a false positive.
 *
 * @param content - The raw file text.
 * @param repoRelPath - Repo-relative path, recorded on each violation.
 * @param pattern - The check's literal spawn pattern.
 * @param rules - Indirection signals (Issue #1378); omitted, only the literal
 *   pattern is enforced.
 * @returns One violation per offending line, in line order.
 */
export function scanContentForDirectSpawn(
  content: string,
  repoRelPath: string,
  pattern: RegExp,
  rules?: IndirectSpawnRules,
): DirectSpawnViolation[] {
  const code = codeOnly(content);
  const offending = new Set(matchingLines(code, pattern));

  if (rules) {
    for (const line of matchingLines(code, rules.wrapperPattern)) {
      offending.add(line);
    }
    const routesBinary = rules.argvHeadPattern.test(code);
    const delegates = rules.chokepointImportPattern.test(code);
    if (routesBinary && !delegates) {
      for (const line of matchingLines(code, INDIRECT_SPAWN_PATTERN)) {
        offending.add(line);
      }
    }
  }

  const lines = content.split("\n");
  return [...offending]
    .sort((a, b) => a - b)
    .map((line) => ({
      file: repoRelPath,
      line,
      text: (lines[line - 1] ?? "").trim(),
    }));
}

/** An empty negative lookahead: matches nothing, anywhere. */
const NEVER_MATCHES = /(?!)/;

/** Recursively walk a directory yielding `.ts` file paths (absolute). */
async function* walkTsFiles(
  dir: string,
  excludeTests: boolean,
): AsyncGenerator<string> {
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
      yield* walkTsFiles(fullPath, excludeTests);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      if (excludeTests && entry.name.endsWith("_test.ts")) continue;
      yield fullPath;
    }
  }
}

/**
 * Scan the given repo-relative directories for direct spawns outside the
 * allowlist.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param relDirs - Repo-relative directories to scan.
 * @param options - Pattern, allowlist and test-file handling.
 * @returns Aggregated violations and the number of files scanned.
 */
export async function scanDirectoriesForDirectSpawn(
  repoRoot: string,
  relDirs: readonly string[],
  options: DirectSpawnScanOptions,
): Promise<DirectSpawnScanResult> {
  const root = repoRoot.replace(/\/$/, "");
  const violations: DirectSpawnViolation[] = [];
  let filesScanned = 0;

  for (const relDir of relDirs) {
    for await (
      const absFile of walkTsFiles(
        `${root}/${relDir}`,
        options.excludeTests ?? false,
      )
    ) {
      const repoRel = absFile.slice(root.length + 1);
      if (options.allowlist.has(repoRel)) continue;
      filesScanned++;
      const content = await Deno.readTextFile(absFile);
      // An exempt file keeps the literal and wrapper checks; only the
      // argv pairing that drives the indirection rule is switched off.
      const rules = options.rules && options.indirectExempt?.has(repoRel)
        ? { ...options.rules, argvHeadPattern: NEVER_MATCHES }
        : options.rules;
      violations.push(
        ...scanContentForDirectSpawn(content, repoRel, options.pattern, rules),
      );
    }
  }

  return { violations, filesScanned };
}
