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
 * git verbs — `fetch`, `pull`, `push`, `checkout`, `rebase` — passed to a
 * `runGitCommand`/`Deno.Command("git", …)` call, so a new inline call site
 * cannot reintroduce the vulnerability without failing the gate. `git_ref_args.ts`
 * itself (which constructs these arrays as the sanctioned output) is allowlisted.
 *
 * The pattern is applied both per-line and to the comment-stripped file as a
 * whole (Issue #268): a multi-line `["fetch", "origin", branchName]` literal
 * evades a line-local scan because no single line holds the verb and the
 * attacker-controlled identifier.
 *
 * `push` and `rebase` join the guarded set in Issue #275. `push` was excluded
 * outright, which is how #267's unguarded `pr_ci_nudge` push of a
 * GitHub-controlled PR head branch reached main looking clean to the gate —
 * `git push origin -–evil-branch` is the same CWE-88 shape as a fetch, and
 * `buildPushArgs` has existed all along. `rebase` was already named in this
 * contract and in `buildRebaseArgs` but was missing from the pattern, so the
 * documentation promised a gate that was not there.
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
 * Matches a whole array literal whose first element is a guarded git verb,
 * e.g. `["fetch", "origin", branchName]` or `["push", "-u", …, branchName]`.
 *
 * Matching the *whole* array and then applying two predicates to its text
 * (Issue #275) replaced a single clever regex that tried to express "not
 * builder-shaped" as a lookahead. The lookahead could only check the slot
 * immediately after the verb, and the lease form
 * `["push", `--force-with-lease=${branchName}:${sha}`, "--end-of-options",
 * remote, branchName]` defeated it twice over: a flag sits between the verb
 * and the separator, and the branch name is interpolated into that flag
 * ahead of it. Two predicates over the array text say plainly what the gate
 * means, and `[^\]]` spans newlines so a multi-line literal (Issue #268) is
 * caught by the same expression.
 */
export const GIT_REF_ARGV_PATTERN = new RegExp(
  "\\[\\s*[\"'`](?:fetch|pull|push|checkout|rebase)[\"'`][^\\]]*\\]",
  "g",
);

/**
 * An attacker-controlled PR head branch identifier, in any object path.
 *
 * Safe internal refs (defaultBranch, baseBranch, milestoneBranch, remotes,
 * `--abort`, `--`) are deliberately excluded — this gate is CWE-88 (a
 * dash-leading PR head branch reaching git as a positional), not a blanket
 * ban on positional refs.
 */
export const GIT_REF_ARGV_UNTRUSTED_IDENTIFIER =
  /\b(?:head(?:Ref)?[Bb]ranch|branchName|headRefName)\b/;

/**
 * Whether one array-literal's text is an unguarded guarded-verb call.
 *
 * `--end-of-options` anywhere in the array means the author routed through
 * the builders in `git_ref_args.ts`, which validate the ref and place the
 * separator before the first positional. Everything after that separator is
 * a positional to git, so its presence is what makes the array safe —
 * wherever in the array it sits.
 */
export function isUnguardedGitRefArgv(arrayText: string): boolean {
  if (arrayText.includes("--end-of-options")) return false;
  return GIT_REF_ARGV_UNTRUSTED_IDENTIFIER.test(arrayText);
}

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
  const stripped = stripBlockComments(content);
  const lines = stripped.split("\n");
  const violations: GitRefArgvViolation[] = [];
  const seenLines = new Set<number>();

  const addViolation = (line: number, text: string) => {
    if (seenLines.has(line)) return;
    seenLines.add(line);
    violations.push({ file: repoRelPath, line, text: text.trim() });
  };

  // One pass over the comment-stripped file. `[^\]]` spans newlines, so a
  // multi-line literal (Issue #268) is found by the same expression as a
  // single-line one — no separate line-local scan is needed.
  const withoutLineComments = stripped.replace(/\/\/.*$/gm, "");
  const globalPattern = new RegExp(GIT_REF_ARGV_PATTERN.source, "g");
  for (const match of withoutLineComments.matchAll(globalPattern)) {
    if (!isUnguardedGitRefArgv(match[0])) continue;
    const index = match.index ?? 0;
    const line = withoutLineComments.slice(0, index).split("\n").length;
    addViolation(line, lines[line - 1] ?? match[0]);
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
