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

/**
 * Matches a **generic argv pass-through** spawn — `new Deno.Command(cmd[0]!,
 * { args: cmd.slice(1) })` — where the binary is the head of an argv array
 * (Issue #1553).
 *
 * Such a runner spawns whatever its callers hand it, and those callers live
 * in other modules, so no same-file signal can tell whether the guarded
 * binary reaches it. {@link IndirectSpawnRules.argvHeadPattern} therefore
 * cannot see it at all: `resolve_cross_repo_dep.ts` is handed `git` argv
 * built in `cross_repo_fix.ts` and never spells the word itself. The runner
 * must delegate the guarded binary to its chokepoint instead.
 *
 * A spawn whose binary is resolved inside the module (`new
 * Deno.Command(binary, …)`, `new Deno.Command(call.bin, …)`) is not an argv
 * head and is left to the narrower indirection rule.
 */
export const PASS_THROUGH_SPAWN_PATTERN =
  /new\s+Deno\.Command\s*\(\s*[A-Za-z_$][\w$]*\s*\[\s*0\s*\]/;

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
  /**
   * Flag every {@link PASS_THROUGH_SPAWN_PATTERN} match in a file that does
   * not import the chokepoint, whatever the file's argv literals say
   * (Issue #1553). Opt-in per check.
   */
  flagArgvHeadSpawn?: boolean;
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
  /**
   * Repo-relative paths exempt from the **pass-through** rule only
   * (Issue #1553). Every other signal still applies. Each entry names a
   * module whose argv head is built locally rather than taken from a
   * caller, so the guarded binary provably cannot reach the spawn.
   */
  passThroughExempt?: ReadonlySet<string>;
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
 * Strip block comments and trailing line comments, preserving newlines so
 * every offset still maps to its original line, and so line numbers (and
 * therefore reported violations) stay aligned with the original source.
 *
 * Shared with the shared-tmp state-directory check (Issue #1242) and the
 * redact/truncate order check, both of which scan across lines and so need
 * the whole file rather than one line at a time.
 *
 * @param source - The raw file text.
 * @returns The same text with comment content blanked out.
 */
export function stripLineAndBlockComments(source: string): string {
  return stripBlockComments(source)
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
  const code = stripLineAndBlockComments(content);
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
    // Issue #1553: a pass-through runner's callers are in other modules, so
    // the argv-literal pairing above cannot see them. Delegation is the only
    // evidence that the guarded binary is routed.
    if (rules.flagArgvHeadSpawn && !delegates) {
      for (const line of matchingLines(code, PASS_THROUGH_SPAWN_PATTERN)) {
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

/**
 * Recursively walk a directory yielding `.ts` file paths (absolute).
 *
 * Exported for the sibling static checks that scan the same tree
 * (Issue #1242) — the walk is identical, so it lives here once.
 *
 * @param dir - Absolute directory to walk; a missing directory yields nothing.
 * @param excludeTests - Skip `*_test.ts` files.
 */
export async function* walkTsFiles(
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
      // argv pairing that drives the indirection rule is switched off, and
      // the pass-through rule is exempted separately (Issue #1553).
      let rules = options.rules;
      if (rules && options.indirectExempt?.has(repoRel)) {
        rules = { ...rules, argvHeadPattern: NEVER_MATCHES };
      }
      if (rules && options.passThroughExempt?.has(repoRel)) {
        rules = { ...rules, flagArgvHeadSpawn: false };
      }
      violations.push(
        ...scanContentForDirectSpawn(content, repoRel, options.pattern, rules),
      );
    }
  }

  return { violations, filesScanned };
}
