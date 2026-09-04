/**
 * Quality gate check: no source file may build a work-dir path
 * (`…/auto-issue-work`) from `HOME`/`USERPROFILE` — or from any other base —
 * outside an explicit, commented allowlist (Issue #135, parent #118).
 *
 * #118's requirement is behavioural: no host-side VibeCoder process may
 * create `~/auto-issue-work` or `~/auto-issue-work-approval-state` on the
 * host. Issues #131/#132/#133 removed the `$HOME`-derived cache fallback that
 * did exactly that, and the behavioural guard in
 * `tests/host_workdir_guard_test.ts` runs the host entry points to prove the
 * directories are not created. This static check catches the regression class
 * in code paths the behavioural test never executes: any NEW construction of
 * a work-dir path from a home directory fails the gate before it can run.
 *
 * Like the `gh` spawn chokepoint check (Issue #3703) this is an
 * architectural, whole-codebase invariant, so it lives in the quality gate
 * rather than guarding a single function. The scanning functions are pure and
 * exported so they can be tested behaviourally against literal inputs.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** A single work-dir-construction violation found during scanning. */
export interface HomeWorkDirViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line number of the offending construction. */
  line: number;
  /** Trimmed text of the offending line. */
  text: string;
}

/** Result of scanning one or more directories. */
export interface HomeWorkDirCheckResult {
  violations: HomeWorkDirViolation[];
  /**
   * Allowlist entries whose file now carries a DIFFERENT number of
   * constructions than the allowlist records — the inventory must stay
   * exact, so both a new site in an allowlisted file and a stale entry
   * after a removal are surfaced.
   */
  staleAllowlist: string[];
  /**
   * Entries naming a file that no longer exists (Issue #883). Reported so it
   * gets tidied, but not fatal: a deleted file cannot hide a violation.
   */
  orphanedAllowlist: string[];
  filesScanned: number;
}

/**
 * The files permitted to build a work-dir path, each with the EXACT number
 * of constructions it is allowed to carry. An extra construction in an
 * allowlisted file fails the check just like a new file would; a removed
 * construction demands the allowlist be trimmed to match. Every entry
 * carries the reason it is legitimate (Issue #135):
 */
export const HOME_WORKDIR_ALLOWLIST: ReadonlyMap<string, number> = new Map<
  string,
  number
>([
  // The run driver resolving the work dir it then EXPORTS as WORK_DIR
  // (Issue #4370) — this is the single place the host default is decided,
  // and every other consumer reads WORK_DIR from it.
  ["worker/deno/lib/run_worker.ts", 1],

  // Describes the IN-CONTAINER mount target `/home/vibe/auto-issue-work` on
  // the `vibe-work` volume (one site for the volume plan, one for the
  // container-side WORK_DIR default). Deliberate and must keep working —
  // see Issue #118 "Out of scope".
  ["worker/deno/lib/container_launch.ts", 2],

  // Container-only (guarded by VIBE_IMAGE_AGENT_PROVIDERS): the in-container
  // CLAUDE_CONFIG_DIR default for durable transcripts (Issue #4170). Never
  // evaluated host-side.
  ["worker/deno/lib/claude_env.ts", 1],

  // Legacy config default: a string on the loaded WorkerConfig only — the
  // loader never creates the directory. Commands that create directories
  // must receive an explicit work dir (see commands/disk_space.ts).
  ["worker/deno/lib/config.ts", 1],

  // Path construction only, feeding the IN-CONTAINER healthDir default
  // (Issue #4165) where WORK_DIR is always set; the HOME arm is only
  // reachable host-side, where healthDir ignores it. Nothing is created.
  ["worker/deno/lib/fleet_health.ts", 1],

  // Read-only workDir hint for the setup sync auditors (workflow-sync,
  // best-practices-sync, gitignore-sync): they READ workflow files from a
  // local clone when one exists and fall back to `gh api` otherwise — none
  // of them creates the directory, and setup removes a work dir that holds
  // only its own cache (Issue #134).
  ["worker/deno/setup/setup_cli.ts", 3],
]);

/**
 * Matches a construction of a work-dir path on a single (comment-stripped)
 * line. Three shapes cover every known spelling:
 *
 * 1. A home-ish token (`HOME`, `USERPROFILE`, a `home` variable) followed by
 *    `auto-issue-work` on the same line — the classic
 *    `` `${Deno.env.get("HOME") ?? ""}/auto-issue-work` `` fallback.
 * 2. Any template interpolation immediately prefixing `/auto-issue-work` —
 *    catches the same construction routed through a renamed variable.
 * 3. `joinPath(base, "auto-issue-work", …)` — the path-join spelling.
 */
export const HOME_WORKDIR_PATTERNS: readonly RegExp[] = [
  /(\bHOME\b|\bUSERPROFILE\b|\bhome\b)[^\n]*auto-issue-work/,
  /\$\{[^}]+\}\/auto-issue-work/,
  /joinPath\s*\([^)]*["'`]auto-issue-work/,
];

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
 * Scan a file's content for work-dir path constructions.
 *
 * Block comments and trailing line comments are ignored so prose mentioning
 * the forbidden pattern (including this module's own documentation) does not
 * trip a false positive.
 *
 * @param content - The raw file text.
 * @param repoRelPath - Repo-relative path, recorded on each hit.
 * @returns One hit per offending line (allowlist NOT applied here).
 */
export function scanContentForHomeWorkDir(
  content: string,
  repoRelPath: string,
): HomeWorkDirViolation[] {
  const lines = stripBlockComments(content).split("\n");
  const hits: HomeWorkDirViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const code = rawLine.replace(/\/\/.*$/, "");
    if (HOME_WORKDIR_PATTERNS.some((pattern) => pattern.test(code))) {
      hits.push({
        file: repoRelPath,
        line: i + 1,
        text: rawLine.trim(),
      });
    }
  }

  return hits;
}

/**
 * Recursively walk a directory yielding `.ts` file paths (absolute),
 * skipping any directory named in `skipDirs` (test trees legitimately build
 * these paths in fixtures and assertions).
 */
async function* walkTsFiles(
  dir: string,
  skipDirs: ReadonlySet<string>,
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
      if (skipDirs.has(entry.name)) continue;
      yield* walkTsFiles(fullPath, skipDirs);
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      yield fullPath;
    }
  }
}

/** Directory names excluded from the scan (fixtures build these paths). */
export const HOME_WORKDIR_SKIP_DIRS: ReadonlySet<string> = new Set<string>([
  "tests",
]);

/**
 * Scan the given repo-relative directories for work-dir path constructions
 * outside {@link HOME_WORKDIR_ALLOWLIST}.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param relDirs - Repo-relative directories to scan (recursive, minus
 *   {@link HOME_WORKDIR_SKIP_DIRS}).
 * @param allowlist - Override for testing; defaults to the real allowlist.
 * @returns Violations, stale-allowlist findings, and the file count.
 */
export async function scanDirectoriesForHomeWorkDir(
  repoRoot: string,
  relDirs: string[],
  allowlist: ReadonlyMap<string, number> = HOME_WORKDIR_ALLOWLIST,
): Promise<HomeWorkDirCheckResult> {
  const root = repoRoot.replace(/\/$/, "");
  const violations: HomeWorkDirViolation[] = [];
  const countsByFile = new Map<string, number>();
  // Issue #883: which files exist at all, so an entry for a deleted file is
  // told apart from one whose file lost a construction.
  const scannedFiles = new Set<string>();
  let filesScanned = 0;

  for (const relDir of relDirs) {
    for await (
      const absFile of walkTsFiles(`${root}/${relDir}`, HOME_WORKDIR_SKIP_DIRS)
    ) {
      const repoRel = absFile.slice(root.length + 1);
      filesScanned++;
      scannedFiles.add(repoRel);
      const content = await Deno.readTextFile(absFile);
      const hits = scanContentForHomeWorkDir(content, repoRel);
      if (hits.length === 0) continue;
      countsByFile.set(repoRel, hits.length);
      const allowed = allowlist.get(repoRel) ?? 0;
      if (hits.length > allowed) {
        // Surface every hit in the file: the reviewer decides which of them
        // is the new one.
        violations.push(...hits);
      }
    }
  }

  // An entry whose file still exists but has fewer constructions than
  // recorded means the inventory no longer matches reality — demand a trim so
  // the allowlist stays an exact, reviewable record.
  //
  // Issue #883: an entry whose file is **gone** is reported separately and is
  // not fatal. It cannot mask a violation — there is no file to construct a
  // work dir in — so the safety property this check exists for is untouched,
  // and failing the gate over it costs whole runs for a hygiene nit.
  //
  // That distinction is not academic. The invariant spans two files, so a
  // branch that deletes the module and a branch that still carries its entry
  // are each internally consistent while their merge is not — git resolves
  // the deletion and the untouched entry independently, with no conflict.
  // `main` and `milestone/fleet-logs` sat in exactly that state, and it cost
  // #805 two runs and #808 two more, none of which had changed anything
  // wrong.
  const staleAllowlist: string[] = [];
  const orphanedAllowlist: string[] = [];
  for (const [file, allowed] of allowlist) {
    const found = countsByFile.get(file) ?? 0;
    if (found >= allowed) continue;
    if (!scannedFiles.has(file)) {
      orphanedAllowlist.push(
        `${file}: allowlist entry for a file that no longer exists — trim it`,
      );
      continue;
    }
    staleAllowlist.push(
      `${file}: allowlist records ${allowed} construction(s) but ${found} found — trim the allowlist entry`,
    );
  }

  return { violations, staleAllowlist, orphanedAllowlist, filesScanned };
}
