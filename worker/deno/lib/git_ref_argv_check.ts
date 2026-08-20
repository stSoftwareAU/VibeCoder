/**
 * CI chokepoint: no git command may take a ref as an inline positional
 * argument (Issue #12, CWE-88).
 *
 * A PR head branch name is attacker-controlled and can begin with a dash, so
 * `runGitCommand(["fetch", "origin", branchName])` lets git parse the name as
 * an option (`--upload-pack=…`) rather than a ref — argument injection. The
 * safe path is the builders in `git_ref_args.ts`
 * (`buildFetchArgs`/`buildPullArgs`/`buildCheckoutArgs`/`buildRebaseArgs`),
 * which validate the ref and insert `--end-of-options`.
 *
 * This scanner flags any array literal beginning with one of the guarded
 * git verbs — `fetch`, `pull`, `checkout`, `rebase` — passed to a
 * `runGitCommand`/`Deno.Command("git", …)` call, so a new inline call site
 * cannot reintroduce the vulnerability without failing the gate. `git_ref_args.ts`
 * itself (which constructs these arrays as the sanctioned output) is allowlisted.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

/** A git call built inline rather than through the ref-arg builders. */
export interface GitRefArgvViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Trimmed text of the offending line. */
  text: string;
}

export interface GitRefArgvCheckResult {
  violations: GitRefArgvViolation[];
  filesScanned: number;
}

/** Files permitted to build guarded-verb argv literals directly. */
export const GIT_REF_ARGV_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // The sanctioned builders — their whole purpose is to emit these arrays.
  "worker/deno/lib/git_ref_args.ts",
]);

/**
 * Matches an array literal whose first element is a guarded git verb, e.g.
 * `["fetch", "origin", branchName]` or `["checkout", branchName]`. The
 * `--end-of-options` the builders emit sits *after* the verb, so a
 * builder-shaped array (`["fetch", "--end-of-options", …]`) does not match
 * because the verb is immediately followed by the separator, which we exclude.
 */
export const GIT_REF_ARGV_PATTERN = new RegExp(
  // an array literal opening with a guarded verb …
  "\\[\\s*[\"'`](?:fetch|pull|checkout)[\"'`]\\s*,\\s*" +
    // … not already the builder-shaped `--end-of-options` form …
    "(?![\"'`]--end-of-options[\"'`])" +
    // … whose remaining tokens include an attacker-controlled PR head
    // branch identifier (branchName / headBranch / headRefName, any
    // object path). Safe internal refs (defaultBranch, baseBranch,
    // milestoneBranch, remotes, `--abort`, `--`) are deliberately excluded
    // — this gate is CWE-88 (a dash-leading PR head branch), not a blanket
    // ban on positional refs.
    "[^\\]]*\\b(?:head(?:Ref)?[Bb]ranch|branchName|headRefName)\\b",
);

/** Strip block comments to spaces, preserving line numbers. */
function stripBlockComments(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\//g,
    (match) => match.replace(/[^\n]/g, " "),
  );
}

/** Scan one file's content for inline guarded-verb git argv. */
export function scanContentForGitRefArgv(
  content: string,
  repoRelPath: string,
): GitRefArgvViolation[] {
  const lines = stripBlockComments(content).split("\n");
  const violations: GitRefArgvViolation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const code = rawLine.replace(/\/\/.*$/, "");
    if (GIT_REF_ARGV_PATTERN.test(code)) {
      violations.push({ file: repoRelPath, line: i + 1, text: rawLine.trim() });
    }
  }
  return violations;
}

/** Recursively yield `.ts` file paths under `dir` (absolute). */
async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkTsFiles(fullPath);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith("_test.ts")) {
      yield fullPath;
    }
  }
}

/**
 * Scan `worker/deno/{lib,commands}` under `root` for inline guarded-verb git
 * argv, skipping the allowlist and test files.
 */
export async function scanDirectoriesForGitRefArgv(
  root: string,
  relDirs: readonly string[] = ["worker/deno/lib", "worker/deno/commands"],
): Promise<GitRefArgvCheckResult> {
  const violations: GitRefArgvViolation[] = [];
  let filesScanned = 0;
  for (const relDir of relDirs) {
    for await (const absFile of walkTsFiles(`${root}/${relDir}`)) {
      const repoRel = absFile.slice(root.length + 1);
      if (GIT_REF_ARGV_ALLOWLIST.has(repoRel)) continue;
      filesScanned++;
      const content = await Deno.readTextFile(absFile);
      violations.push(...scanContentForGitRefArgv(content, repoRel));
    }
  }
  return { violations, filesScanned };
}
