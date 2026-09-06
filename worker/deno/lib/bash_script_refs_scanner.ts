/**
 * Native bash script-reference scanner (Issue #3228, parent #3224 —
 * layer 2 of the bash compile-equivalent checks).
 *
 * Catches the failure class behind FLEET's Discovery outage: a helper
 * deleted in a PR was still `source`d at runtime, `bash -n` passed
 * (syntax was fine), exit 127 was reconciled as success, and the worker
 * failed silently for weeks. `bash -n` cannot catch this — the file is
 * only resolved at first execution. This scanner statically resolves
 * `source` / `.` / `fleet_source_or_fail` / `bash …` references and reports
 * any whose target is not a regular file on disk.
 *
 * Design: fully deterministic and native (no LLM for the core check), and
 * **fail-loud** — a walk/read failure surfaces as a `Result` error rather
 * than a silent green. The pure core ({@link findMissingReferences},
 * {@link extractRefs}, {@link resolveCandidates}) is unit-tested with no
 * filesystem; {@link scanBashScriptRefs} adds the disk walk.
 *
 * False-positive discipline (the acceptance bar is **zero FP on FLEET
 * `Develop`**): a reference is only reported missing when it resolves
 * nowhere under **any** plausible base. Ambiguous root variables
 * (`${BASE_DIR}`, `${SHARED_DIR}`) are tried against the script's own
 * directory, every ancestor directory up to the repo root, and the repo
 * root itself, and `# shellcheck source=` annotations are honoured. Any
 * reference that stays dynamic after substitution (`$(…)`, unknown
 * `${__FLEET_*}` variables, globs) is skipped and counted as a documented
 * limitation, never a finding.
 *
 * Test harnesses (`test_*`, and anything under a `test/` directory) are
 * excluded at v1 to keep the
 * false-positive rate at zero; the exclusion can be relaxed once the rules
 * are stable.
 *
 * Australian English used throughout (behaviour, organisation, authorised).
 */

import { makeStableId } from "./workflow_scan_common.ts";
import { runGitCommand } from "./git_timeout.ts";

/** Discriminator baked into every stable id (collision-proofs the recipe). */
export const BASH_SCRIPT_REFS_DISCRIMINATOR = "bash-script-refs";

/** The kind of reference a {@link BashRef} was extracted from. */
export type BashRefKind =
  | "source"
  | "fleet_source_or_fail"
  | "bash"
  | "relative";

/** A single static script reference extracted from a shell file. */
export interface BashRef {
  /** Repo-relative path of the file the reference lives in. */
  sourceFile: string;
  /** 1-indexed line the reference sits on. */
  line: number;
  /** The literal path argument as written (quotes stripped, vars intact). */
  rawRef: string;
  /** Which line form produced the reference. */
  kind: BashRefKind;
  /**
   * Optional `# shellcheck source=<path>` annotation attached to this
   * reference (the annotation immediately above it), or `null`.
   */
  shellcheckSource: string | null;
  /**
   * `true` when a same-line `cd` command precedes the reference (e.g.
   * `(cd ../other && ./run.sh)`). The working directory the reference
   * resolves against is then dynamic — often a *sibling* checkout outside
   * this repo — so it cannot be statically checked and is treated as
   * skipped/dynamic rather than a finding. Optional; absent means `false`.
   */
  precededByCd?: boolean;
}

/** A missing-script finding: one referenced target that resolves nowhere. */
export interface BashMissingScriptFinding {
  /** Stable `BP-<12 hex>` id (keyed on repo + missing path). */
  findingId: string;
  /** Primary (script-directory) interpretation of the missing target. */
  missingPath: string;
  /** All reference sites whose target resolved nowhere. */
  references: BashRef[];
  /** Every repo-relative candidate path that was tried and found absent. */
  candidatesTried: string[];
}

/** Outcome of {@link findMissingReferences} / {@link scanBashScriptRefs}. */
export interface BashScanValue {
  /** One finding per distinct missing target. */
  findings: BashMissingScriptFinding[];
  /** Number of `*.sh` files inspected. */
  filesScanned: number;
  /** References skipped as dynamic/runtime-only (documented limitation). */
  skippedDynamic: BashRef[];
}

/** Discriminated failure mode for the fail-loud contract. */
export interface BashScanError {
  kind: "walk" | "read";
  message: string;
}

/** `{ ok: true } | { ok: false }` result. */
export type BashScanResult =
  | { ok: true; value: BashScanValue }
  | { ok: false; error: BashScanError };

// ---------------------------------------------------------------------------
// Path helpers (pure)
// ---------------------------------------------------------------------------

/** Directory portion of a repo-relative file path (`""` for a root file). */
export function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx < 0 ? "" : relPath.slice(0, idx);
}

/**
 * Join `rel` onto directory `dir` and normalise `.`/`..`/`//`.
 *
 * Returns `null` when the path is absolute (leading `/`) or escapes above
 * the repo root — neither can be existence-checked reliably, so the caller
 * treats them as dynamic and skips.
 */
export function joinRel(dir: string, rel: string): string | null {
  if (rel.startsWith("/")) return null; // absolute — outside the repo tree
  const combined = dir === "" ? rel : `${dir}/${rel}`;
  const out: string[] = [];
  for (const seg of combined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null; // escapes above repo root
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/** Ancestor directories of `dir`, most-specific first, ending with `""`. */
export function ancestorDirs(dir: string): string[] {
  const out: string[] = [];
  let cur = dir;
  for (;;) {
    out.push(cur);
    if (cur === "") break;
    cur = dirOf(cur);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reference extraction (pure)
// ---------------------------------------------------------------------------

/**
 * Read the first shell argument token from `rest`, honouring single and
 * double quotes. Returns the unquoted token, or `null` when `rest` is
 * empty. Variable syntax (`${…}`) inside the token is preserved.
 */
export function firstArgToken(rest: string): string | null {
  const s = rest.replace(/^\s+/, "");
  if (s === "") return null;
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    if (end < 0) return null; // unterminated quote — not a clean literal
    return s.slice(1, end);
  }
  const m = s.match(/^[^\s;|&)]+/);
  return m ? m[0] : null;
}

const SHELLCHECK_SOURCE_RE = /^\s*#\s*shellcheck\b.*\bsource=(\S+)/;
const SOURCE_RE = /^\s*(?:source|\.)\s+(.+)$/;
const FLEET_RE = /^\s*fleet_source_or_fail\s+(.+)$/;
// `bash <script>` / `bash -x <script>` — capture the first `.sh` token.
const BASH_RE = /\bbash\b\s+((?:-\S+\s+)*)("[^"]*\.sh"|'[^']*\.sh'|\S+\.sh)/;
// A `./foo.sh` relative invocation anywhere on the line.
const RELATIVE_RE = /(?:^|[\s"'(=])(\.\/[^\s"';|&)]+\.sh)/;
// A `cd <dir>` command at a statement boundary (line start, or after a
// separator / subshell `(`). Used to detect a directory change that
// precedes a reference on the same line.
const CD_BEFORE_RE = /(?:^|[\s;&|(])cd\s+\S/;

/**
 * True when the text preceding a reference on its line contains a `cd`
 * command — i.e. the reference runs after a directory change (`cd x &&
 * ./run.sh`, `(cd x && ./run.sh)`). The runtime working directory is then
 * dynamic (commonly a *sibling* checkout), so the reference must not be
 * resolved against this repo's tree. Pure.
 */
function precededByCd(lineBeforeRef: string): boolean {
  return CD_BEFORE_RE.test(lineBeforeRef);
}

/**
 * Extract every static script reference from `rawText`.
 *
 * Handles `source "…"`, `. "…"`, `fleet_source_or_fail "…"`,
 * `bash …/foo.sh`, and `./foo.sh` invocations. A
 * `# shellcheck source=<path>` comment attaches to the reference on the
 * next non-blank line. Pure — no I/O.
 */
export function extractRefs(rawText: string, sourceFile: string): BashRef[] {
  const refs: BashRef[] = [];
  const lines = rawText.split("\n");
  let pendingShellcheck: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const sc = line.match(SHELLCHECK_SOURCE_RE);
    if (sc) {
      pendingShellcheck = sc[1] ?? null;
      continue;
    }
    // Blank/comment lines keep a pending annotation alive; other lines
    // consume (or clear) it below.
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;

    const shellcheck = pendingShellcheck;
    pendingShellcheck = null;
    const lineNo = i + 1;

    const src = line.match(SOURCE_RE);
    if (src) {
      const tok = firstArgToken(src[1]!);
      if (tok !== null) {
        refs.push({
          sourceFile,
          line: lineNo,
          rawRef: tok,
          kind: "source",
          shellcheckSource: shellcheck,
        });
      }
      continue;
    }

    const fleet = line.match(FLEET_RE);
    if (fleet) {
      const tok = firstArgToken(fleet[1]!);
      if (tok !== null) {
        refs.push({
          sourceFile,
          line: lineNo,
          rawRef: tok,
          kind: "fleet_source_or_fail",
          shellcheckSource: shellcheck,
        });
      }
      continue;
    }

    const bash = line.match(BASH_RE);
    if (bash) {
      const tok = stripQuotes(bash[2]!);
      refs.push({
        sourceFile,
        line: lineNo,
        rawRef: tok,
        kind: "bash",
        shellcheckSource: shellcheck,
        precededByCd: precededByCd(line.slice(0, bash.index ?? 0)),
      });
      continue;
    }

    const rel = line.match(RELATIVE_RE);
    if (rel) {
      refs.push({
        sourceFile,
        line: lineNo,
        rawRef: rel[1]!,
        kind: "relative",
        shellcheckSource: null,
        precededByCd: precededByCd(line.slice(0, rel.index ?? 0)),
      });
    }
  }
  return refs;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const q = s[0];
    if ((q === '"' || q === "'") && s[s.length - 1] === q) {
      return s.slice(1, -1);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Reference resolution (pure)
// ---------------------------------------------------------------------------

/** Known root variables resolved to a single, unambiguous directory. */
const UNAMBIGUOUS_ROOTS = new Set(["SCRIPT_DIR", "REPO_DIR"]);
/** Ambiguous root variables tried against several plausible bases. */
const AMBIGUOUS_ROOTS = new Set(["BASE_DIR", "SHARED_DIR"]);

/** Outcome of resolving a single reference to candidate paths. */
export interface ResolveOutcome {
  /** `true` when the reference is dynamic/runtime-only and skipped. */
  skipped: boolean;
  /** Repo-relative candidate paths (most-specific first) when not skipped. */
  candidates: string[];
}

const LEADING_VAR_RE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(?:\/(.*))?$/;

/**
 * Resolve `ref` to the set of repo-relative candidate paths its target
 * could denote. Returns `{ skipped: true }` for any reference that stays
 * dynamic (command substitution, unknown variable, glob, absolute path).
 *
 * Ambiguous root variables expand against the script directory, every
 * ancestor up to the repo root, and the repo root; `shellcheckSource`
 * annotations add authoritative candidates. Pure — no I/O.
 */
export function resolveCandidates(ref: BashRef): ResolveOutcome {
  // A same-line `cd` before the reference changes the runtime working
  // directory (often to a sibling checkout outside this repo), so the
  // target cannot be resolved against this repo's tree. Treat as dynamic.
  if (ref.precededByCd) return { skipped: true, candidates: [] };

  const scriptDir = dirOf(ref.sourceFile);
  const candidates: string[] = [];

  const pushJoin = (root: string, rel: string) => {
    const j = joinRel(root, rel);
    if (j !== null && !candidates.includes(j)) candidates.push(j);
  };

  // shellcheck source=<path> is authoritative when present. It may be
  // relative to the script dir or the repo root — try both.
  if (ref.shellcheckSource && ref.shellcheckSource !== "/dev/null") {
    const s = ref.shellcheckSource;
    if (!s.includes("$") && !s.includes("*")) {
      pushJoin(scriptDir, s);
      pushJoin("", s);
    }
  }

  const raw = ref.rawRef;

  // Dynamic: command substitution or globs cannot be statically resolved.
  if (raw.includes("$(") || raw.includes("`") || raw.includes("*")) {
    return candidates.length > 0
      ? { skipped: false, candidates }
      : { skipped: true, candidates: [] };
  }

  const varMatch = raw.match(LEADING_VAR_RE);
  if (varMatch) {
    const varName = varMatch[1]!;
    const rest = varMatch[2] ?? "";
    // A trailing variable segment (rest still has `$`) is dynamic.
    if (rest.includes("$")) {
      return candidates.length > 0
        ? { skipped: false, candidates }
        : { skipped: true, candidates: [] };
    }
    let roots: string[] | null = null;
    if (UNAMBIGUOUS_ROOTS.has(varName)) {
      roots = varName === "REPO_DIR" ? [""] : [scriptDir];
    } else if (AMBIGUOUS_ROOTS.has(varName)) {
      roots = ancestorDirs(scriptDir);
      if (!roots.includes("")) roots.push("");
    }
    if (roots === null) {
      // Unknown variable (${HOME}, ${__FLEET_*}, …) — dynamic.
      return candidates.length > 0
        ? { skipped: false, candidates }
        : { skipped: true, candidates: [] };
    }
    for (const root of roots) pushJoin(root, rest);
    return { skipped: false, candidates };
  }

  // Any other `$` (mid-string variable) is dynamic.
  if (raw.includes("$")) {
    return candidates.length > 0
      ? { skipped: false, candidates }
      : { skipped: true, candidates: [] };
  }

  // Absolute path — outside the repo tree, cannot check.
  if (raw.startsWith("/")) {
    return candidates.length > 0
      ? { skipped: false, candidates }
      : { skipped: true, candidates: [] };
  }

  // Plain relative path (`./x.sh` or `dir/x.sh`). At runtime this resolves
  // against the current working directory, which a script commonly changes
  // (`cd` to the repo root) before invoking a helper. To keep the
  // false-positive rate at zero, treat it like an ambiguous root: try the
  // script's own directory, every ancestor up to the repo root, and the
  // repo root itself. A genuinely-missing target still resolves nowhere.
  const relRoots = ancestorDirs(scriptDir);
  if (!relRoots.includes("")) relRoots.push("");
  for (const root of relRoots) pushJoin(root, raw);

  return candidates.length > 0
    ? { skipped: false, candidates }
    : { skipped: true, candidates: [] };
}

// ---------------------------------------------------------------------------
// test-harness exclusion (pure)
// ---------------------------------------------------------------------------

/**
 * Should `relPath` be excluded from scanning at v1?
 *
 * Test harnesses (`test_*` basenames and anything under a `test/` or
 * `tests/` directory) are excluded to keep the false-positive rate at
 * zero while the resolution rules stabilise.
 */
export function isExcludedShellPath(relPath: string): boolean {
  const segs = relPath.split("/");
  const base = segs[segs.length - 1] ?? "";
  if (base.startsWith("test_")) return true;
  for (const seg of segs.slice(0, -1)) {
    if (seg === "test" || seg === "tests") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core: findMissingReferences (pure)
// ---------------------------------------------------------------------------

/** A shell file handed to the pure core. */
export interface ShellFile {
  /** Repo-relative path. */
  path: string;
  /** Raw file contents. */
  rawText: string;
}

/**
 * Pure detection core. Given the repo's shell files, an existence
 * predicate, and the repo slug, return one finding per distinct missing
 * target plus the references skipped as dynamic.
 *
 * A reference is a finding only when **none** of its candidate paths is a
 * regular file. Findings are grouped by their primary (script-directory)
 * candidate so multiple sites referencing the same missing helper cluster
 * into one finding, and sorted by that path for deterministic output.
 */
export async function findMissingReferences(
  files: readonly ShellFile[],
  fileExists: (relPath: string) => boolean,
  repo: string,
): Promise<
  { findings: BashMissingScriptFinding[]; skippedDynamic: BashRef[] }
> {
  const skippedDynamic: BashRef[] = [];
  // Group missing references by their primary candidate path.
  const groups = new Map<
    string,
    { references: BashRef[]; candidates: Set<string> }
  >();

  for (const file of files) {
    if (isExcludedShellPath(file.path)) continue;
    for (const ref of extractRefs(file.rawText, file.path)) {
      const outcome = resolveCandidates(ref);
      if (outcome.skipped || outcome.candidates.length === 0) {
        skippedDynamic.push(ref);
        continue;
      }
      const resolved = outcome.candidates.some((c) => fileExists(c));
      if (resolved) continue; // at least one interpretation exists — fine
      const primary = outcome.candidates[0]!;
      let group = groups.get(primary);
      if (!group) {
        group = { references: [], candidates: new Set() };
        groups.set(primary, group);
      }
      group.references.push(ref);
      for (const c of outcome.candidates) group.candidates.add(c);
    }
  }

  const findings: BashMissingScriptFinding[] = [];
  for (const [missingPath, group] of groups) {
    const findingId = await makeStableId([
      repo,
      BASH_SCRIPT_REFS_DISCRIMINATOR,
      missingPath,
    ]);
    findings.push({
      findingId,
      missingPath,
      references: group.references,
      candidatesTried: [...group.candidates].sort(),
    });
  }
  findings.sort((a, b) => a.missingPath.localeCompare(b.missingPath));
  return { findings, skippedDynamic };
}

// ---------------------------------------------------------------------------
// Disk walk: scanBashScriptRefs (fail-loud)
// ---------------------------------------------------------------------------

/** Directory names never descended into during the walk. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "vendor",
  "target",
  "dist",
  "build",
]);

/** Injectable dependencies for {@link scanBashScriptRefs} (tests stub I/O). */
export interface ScanBashScriptRefsDeps {
  /** Directory reader — defaults to `Deno.readDir`. */
  readDirFn?: (dir: string) => AsyncIterable<Deno.DirEntry>;
  /** File reader — defaults to `Deno.readTextFile`. */
  readTextFileFn?: (path: string) => Promise<string>;
  /** Regular-file predicate — defaults to a `Deno.statSync`-backed check. */
  fileExistsFn?: (absPath: string) => boolean;
  /**
   * List the repo-relative paths git tracks under `workDir`, or `null` when
   * the set is unavailable (`workDir` is not a git repo root, git is
   * missing, or the command fails). Defaults to
   * {@link defaultListTrackedFiles}. When a set is returned the walk is
   * confined to it (defence in depth — Issue #3292: a nested checkout or an
   * untracked scratch file inside the repo checkout can never leak a
   * finding); when `null`, no confinement is applied.
   */
  listTrackedFilesFn?: (workDir: string) => Promise<Set<string> | null>;
}

/**
 * Default git-tracked file lister. Returns `null` unless `workDir` is
 * itself a git repo root (it has a `.git` entry) so a plain fixture
 * directory — or one that merely sits *inside* an unrelated git repo — is
 * never filtered. On a real checkout it returns the repo-relative paths of
 * every tracked file via `git -C <workDir> ls-files -z`.
 */
export async function defaultListTrackedFiles(
  workDir: string,
): Promise<Set<string> | null> {
  // Only trust ls-files when workDir is the repo root itself.
  try {
    await Deno.stat(`${workDir}/.git`);
  } catch {
    return null;
  }
  try {
    // Issue #1214: every git spawn goes through the timeout chokepoint.
    const result = await runGitCommand(["-C", workDir, "ls-files", "-z"]);
    if (!result.ok) return null;
    const { code, stdout: text } = result.value;
    if (code !== 0) return null;
    const set = new Set<string>();
    for (const path of text.split("\0")) {
      if (path) set.add(path);
    }
    return set;
  } catch {
    return null;
  }
}

/**
 * Walk `workDir` for `*.sh` files and report every static reference whose
 * target is not a regular file. **Fail-loud**: a directory-walk failure or
 * a read failure on a discovered shell file returns `{ ok: false }` rather
 * than a silent empty result, so the wrapper issue records the failure
 * instead of a misleading "no findings".
 */
export async function scanBashScriptRefs(
  workDir: string,
  repo: string,
  deps: ScanBashScriptRefsDeps = {},
): Promise<BashScanResult> {
  const readDirFn = deps.readDirFn ?? ((dir) => Deno.readDir(dir));
  const readTextFileFn = deps.readTextFileFn ??
    ((path) => Deno.readTextFile(path));
  const fileExistsFn = deps.fileExistsFn ?? defaultFileExists;
  const listTrackedFilesFn = deps.listTrackedFilesFn ?? defaultListTrackedFiles;

  const shellAbsPaths: string[] = [];

  // Recursive walk — a failure to read any directory is loud.
  const walk = async (dir: string): Promise<BashScanError | null> => {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of readDirFn(dir)) entries.push(e);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        kind: "walk",
        message: `failed to read directory ${dir}: ${message}`,
      };
    }
    for (const entry of entries) {
      const abs = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const err = await walk(abs);
        if (err) return err;
      } else if (entry.isFile && entry.name.endsWith(".sh")) {
        shellAbsPaths.push(abs);
      }
    }
    return null;
  };

  const walkErr = await walk(workDir);
  if (walkErr) return { ok: false, error: walkErr };

  const prefix = workDir.endsWith("/") ? workDir : `${workDir}/`;
  const files: ShellFile[] = [];
  for (const abs of shellAbsPaths) {
    let rawText: string;
    try {
      rawText = await readTextFileFn(abs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: { kind: "read", message: `failed to read ${abs}: ${message}` },
      };
    }
    const rel = abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
    files.push({ path: rel, rawText });
  }

  // Defence in depth (Issue #3292): confine the scanned source files to
  // those git tracks under the repo checkout, so a nested checkout or an
  // untracked scratch file inside the tree can never contribute a finding.
  // When the tracked set is unavailable (`null`), no confinement applies.
  const tracked = await listTrackedFilesFn(workDir);
  const scannedFiles = tracked === null
    ? files
    : files.filter((f) => tracked.has(f.path));

  const fileExists = (rel: string): boolean => fileExistsFn(`${prefix}${rel}`);
  const { findings, skippedDynamic } = await findMissingReferences(
    scannedFiles,
    fileExists,
    repo,
  );
  return {
    ok: true,
    value: { findings, filesScanned: scannedFiles.length, skippedDynamic },
  };
}

/** Default regular-file predicate backed by `Deno.statSync`. */
function defaultFileExists(absPath: string): boolean {
  try {
    return Deno.statSync(absPath).isFile;
  } catch {
    return false;
  }
}
