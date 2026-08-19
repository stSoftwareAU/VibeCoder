/**
 * Runtime interactive-login scanner (Issue #4064, parent #4060).
 *
 * Unattended operation forbids any interactive credential step on the runtime
 * path: no `gh auth login`, no interactive coding-agent provider login, and no
 * macOS Keychain lookup. Credentials are provisioned once, non-interactively,
 * by `setup.sh` (see `credential_preflight.ts`) and consumed read-only.
 *
 * This scanner keeps that invariant fixed the way the `gh` spawn chokepoint
 * check (Issue #3703) keeps its own: it fails on any *invocation* that would
 * prompt a human. Prose and classification strings are deliberately not
 * matched — `claude_auth.ts` legitimately contains the literal text
 * `"claude login"` as a pattern it detects in someone else's output — so the
 * patterns below key on command shapes (argument arrays, shell command
 * positions), not on mentions.
 *
 * Setup-time code (`setup.sh`, `worker/deno/setup/`, `switch-worker-identity.sh`)
 * is out of scope by design: an operator running setup at a terminal may log in
 * interactively; the worker never may.
 *
 * Australian English spelling throughout (behaviour, authorised, organisation).
 */

/** A single interactive-login violation found during scanning. */
export interface InteractiveLoginViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line number of the offending invocation. */
  line: number;
  /** Trimmed text of the offending line. */
  text: string;
  /** Which invariant the line breaks. */
  kind: "gh-auth-login" | "provider-login" | "keychain";
}

/** Result of scanning one or more runtime paths. */
export interface InteractiveLoginScanResult {
  violations: InteractiveLoginViolation[];
  filesScanned: number;
}

/**
 * Runtime paths the invariant covers — directories and individual files,
 * repo-relative. Setup-time code is intentionally absent.
 */
export const RUNTIME_SCAN_PATHS: readonly string[] = [
  "worker/deno/lib",
  "worker/deno/commands",
  "container/entrypoint.sh",
  "run.sh",
  "loop.sh",
];

/**
 * The only file exempt from the scan — this module, which must spell the
 * forbidden invocations out as patterns in order to detect them.
 */
export const INTERACTIVE_LOGIN_ALLOWLIST: ReadonlySet<string> = new Set<
  string
>(["worker/deno/lib/interactive_login_scanner.ts"]);

/** File extensions scanned, and the comment style each uses. */
const SCANNED_EXTENSIONS: Record<string, "c-style" | "hash"> = {
  ".ts": "c-style",
  ".js": "c-style",
  ".sh": "hash",
  ".bash": "hash",
  ".ps1": "hash",
};

/** `gh auth login` spelled as an argument array (`["auth", "login"]`). */
const GH_LOGIN_ARGS = /["'`]auth["'`]\s*,\s*["'`]login["'`]/;

/**
 * Start of a shell command, allowing indentation, a pipeline/`;`/subshell
 * boundary, and any number of leading `VAR=value` assignments (with or
 * without `env`) — `GH_CONFIG_DIR="$dir" gh auth login` is still an
 * invocation.
 */
const SHELL_COMMAND_START =
  "(?:^|[;&|(]|\\$\\()\\s*(?:\\w+=\\S*\\s+)*(?:env\\s+(?:\\w+=\\S*\\s+)*)?";

/** `gh auth login` in shell command position. */
const GH_LOGIN_SHELL = new RegExp(
  `${SHELL_COMMAND_START}gh\\s+auth\\s+login\\b`,
);

/** A coding-agent provider login in shell command position. */
const PROVIDER_LOGIN_SHELL = new RegExp(
  `${SHELL_COMMAND_START}claude\\s+(?:auth\\s+)?login\\b`,
);

/** A provider login spawned from code (`Deno.Command("claude", …"login")`). */
const PROVIDER_LOGIN_SPAWN =
  /Deno\.Command\(\s*["'`]claude["'`][\s\S]{0,120}?["'`]login["'`]/;

/** macOS Keychain lookups — forbidden on every path, runtime or not. */
const KEYCHAIN =
  /\bfind-generic-password\b|\bfind-internet-password\b|Deno\.Command\(\s*["'`](?:\/usr\/bin\/)?security["'`]/;

/** Line shapes that actually execute a shell string. */
const EXECUTES_SHELL =
  /Deno\.Command|bash\s+-c|sh\s+-c|\bexec\s|execSync|spawn\(/;

/** Strip block comments, preserving newlines so line numbers stay aligned. */
function stripBlockComments(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\//g,
    (match) => match.replace(/[^\n]/g, " "),
  );
}

/**
 * Scan file content for interactive-login invocations.
 *
 * @param content - Raw file text.
 * @param repoRelPath - Repo-relative path recorded on each violation.
 * @returns One violation per offending line.
 */
export function scanContentForInteractiveLogin(
  content: string,
  repoRelPath: string,
): InteractiveLoginViolation[] {
  const style = commentStyleFor(repoRelPath);
  const lines = (style === "c-style" ? stripBlockComments(content) : content)
    .split("\n");
  const violations: InteractiveLoginViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const code = style === "c-style"
      ? rawLine.replace(/\/\/.*$/, "")
      : rawLine.replace(/(^|\s)#.*$/, "");

    const kind = classifyLine(code, style);
    if (kind) {
      violations.push({
        file: repoRelPath,
        line: i + 1,
        text: rawLine.trim(),
        kind,
      });
    }
  }

  return violations;
}

/** Classify one comment-stripped line, or null when it is compliant. */
function classifyLine(
  code: string,
  style: "c-style" | "hash",
): InteractiveLoginViolation["kind"] | null {
  if (KEYCHAIN.test(code)) return "keychain";

  if (style === "hash") {
    if (GH_LOGIN_SHELL.test(code)) return "gh-auth-login";
    if (PROVIDER_LOGIN_SHELL.test(code)) return "provider-login";
    return null;
  }

  // Code: an argument array, a direct spawn, or a shell string being executed.
  if (GH_LOGIN_ARGS.test(code)) return "gh-auth-login";
  if (PROVIDER_LOGIN_SPAWN.test(code)) return "provider-login";
  if (EXECUTES_SHELL.test(code)) {
    if (/gh\s+auth\s+login\b/.test(code)) return "gh-auth-login";
    if (/claude\s+(auth\s+)?login\b/.test(code)) return "provider-login";
  }
  return null;
}

/** Comment style for a path, or null when the extension is not scanned. */
function commentStyleFor(path: string): "c-style" | "hash" {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot);
  return SCANNED_EXTENSIONS[ext] ?? "c-style";
}

/** Report whether a path has an extension this scanner reads. */
export function isScannedFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && SCANNED_EXTENSIONS[path.slice(dot)] !== undefined;
}

/** Recursively walk a directory yielding scannable file paths (absolute). */
async function* walkScannable(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return; // Missing directory — nothing to scan.
  }
  for (const entry of entries) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkScannable(fullPath);
    } else if (entry.isFile && isScannedFile(entry.name)) {
      yield fullPath;
    }
  }
}

/**
 * Scan the given repo-relative runtime paths (directories or files) for
 * interactive-login invocations.
 *
 * @param repoRoot - Absolute repo root (trailing slash optional).
 * @param relPaths - Repo-relative directories and files to scan.
 * @returns Aggregated violations and the number of files scanned.
 */
export async function scanRuntimePathsForInteractiveLogin(
  repoRoot: string,
  relPaths: readonly string[] = RUNTIME_SCAN_PATHS,
): Promise<InteractiveLoginScanResult> {
  const root = repoRoot.replace(/\/+$/, "");
  const violations: InteractiveLoginViolation[] = [];
  let filesScanned = 0;

  for (const relPath of relPaths) {
    const abs = `${root}/${relPath}`;
    let isDirectory = false;
    try {
      isDirectory = (await Deno.stat(abs)).isDirectory;
    } catch {
      continue; // Missing path — nothing to scan.
    }

    const files: string[] = [];
    if (isDirectory) {
      for await (const file of walkScannable(abs)) files.push(file);
    } else if (isScannedFile(abs)) {
      files.push(abs);
    }

    for (const file of files) {
      const repoRel = file.slice(root.length + 1);
      if (INTERACTIVE_LOGIN_ALLOWLIST.has(repoRel)) continue;
      filesScanned++;
      const content = await Deno.readTextFile(file);
      violations.push(...scanContentForInteractiveLogin(content, repoRel));
    }
  }

  return { violations, filesScanned };
}
