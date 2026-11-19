/**
 * AWS-emulator-in-CI check (Issue #3366, part of #3346).
 *
 * A deterministic, file-based check answering two questions: does the repo
 * use AWS at all (dependency manifests, CloudFormation templates, or
 * Terraform), and — independently — does any GitHub Actions workflow run
 * an emulator: the `floci/floci` image, or the official AWS Emulator
 * (a `run:` step invoking `aws-emulator-run`, directly or through a
 * repository script that itself invokes it). Merely installing the emulator
 * (`container/toolchains/aws-emulator.sh`) is not coverage.
 * Modelled on `linter_in_ci_check.ts`:
 * no LLM judgement, just text/structure matching against files already in
 * the checkout.
 *
 * Australian English spelling used throughout.
 */

import { parse as parseYaml } from "@std/yaml/parse";
import { loadWorkflows } from "./linter_in_ci_check.ts";
import { parseCfnDocument } from "./cfn_cost_checks.ts";

/** Result of checking a repository for AWS usage and emulator wiring. */
export interface AwsEmulatorCheckResult {
  /** True iff `awsEvidence` is non-empty. */
  usesAws: boolean;
  /** Repo-relative paths ("/"-separated) of every file that triggered, sorted and deduplicated. */
  awsEvidence: string[];
  /** True iff any loaded workflow runs the `floci/floci` image or tests through the official AWS Emulator (`aws-emulator-run` invoked directly or by a repo script it runs; an install-only step does not count). Computed independently of `usesAws`. */
  emulatorConfigured: boolean;
  /** False when `loadWorkflows` returned none (Issue #2880 diagnostic guard). */
  workflowsLoaded: boolean;
}

/** Directories never walked: VCS, dependencies and build output. */
const SKIP_DIRS = new Set([".git", "node_modules", "target", "vendor"]);

const REQUIREMENTS_FILE = /^requirements.*\.txt$/;
const CFN_LIKE_FILE = /\.(ya?ml|json)$/;

// ---------------------------------------------------------------------------
// Pure manifest/content detectors
// ---------------------------------------------------------------------------

/** Table headers that hold Cargo dependencies, e.g. `dependencies`, `workspace.dependencies`. */
function isCargoDependencyTable(header: string): boolean {
  if (
    header === "dependencies" ||
    header === "dev-dependencies" ||
    header === "build-dependencies"
  ) {
    return true;
  }
  return (
    header.endsWith(".dependencies") ||
    header.endsWith(".dev-dependencies") ||
    header.endsWith(".build-dependencies")
  );
}

/** Strip a trailing `#...` comment (no quote-awareness needed for our purposes). */
function stripCargoComment(line: string): string {
  const at = line.indexOf("#");
  return at === -1 ? line : line.slice(0, at);
}

/**
 * True when `text` (a `Cargo.toml`) declares an `aws-config` or
 * `aws-sdk-*` dependency, whether as a plain key, an inline `package`
 * rename, or a dotted table header (`[dependencies.aws-sdk-s3]`).
 *
 * Line-based parsing — no TOML dependency is available in this repo.
 */
export function cargoTomlUsesAws(text: string): boolean {
  let currentHeader = "";
  for (const rawLine of text.split("\n")) {
    const line = stripCargoComment(rawLine).trim();
    if (line.length === 0) continue;

    const headerMatch = line.match(/^\[(.+)\]$/);
    if (headerMatch) {
      const header = (headerMatch[1] ?? "").trim();
      currentHeader = header;
      // A dotted dependency-table header, e.g. [dependencies.aws-sdk-s3]
      // or [workspace.dependencies.aws-config].
      const lastDot = header.lastIndexOf(".");
      if (lastDot !== -1) {
        const parent = header.slice(0, lastDot);
        const leaf = header.slice(lastDot + 1).replace(/^['"]|['"]$/g, "");
        if (
          isCargoDependencyTable(parent) &&
          (leaf === "aws-config" || leaf.startsWith("aws-sdk-"))
        ) {
          return true;
        }
      }
      continue;
    }

    if (!isCargoDependencyTable(currentHeader)) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^['"]|['"]$/g, "");
    if (key === "aws-config" || key.startsWith("aws-sdk-")) return true;

    // An inline `package = "aws-sdk-..."` / `"aws-config"` rename, e.g.
    // `s3 = { package = "aws-sdk-s3", version = "1" }`.
    const packageMatch = line.match(/package\s*=\s*"([^"]+)"/);
    if (packageMatch) {
      const pkg = packageMatch[1] ?? "";
      if (pkg === "aws-config" || pkg.startsWith("aws-sdk-")) return true;
    }
  }
  return false;
}

/**
 * True when `text` (a `package.json`) lists an `aws-sdk` or `@aws-sdk/*`
 * package under any of the four dependency groups. The package's own
 * `name` does not count. Throws on invalid JSON — the caller wraps the
 * error with the file path.
 */
export function packageJsonUsesAws(text: string): boolean {
  const doc = JSON.parse(text) as Record<string, unknown>;
  const groups = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];
  for (const group of groups) {
    const deps = doc[group];
    if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
      continue;
    }
    for (const name of Object.keys(deps as Record<string, unknown>)) {
      if (name === "aws-sdk" || name.startsWith("@aws-sdk/")) return true;
    }
  }
  return false;
}

/**
 * True when `text` (a `pom.xml`) has a `<dependency>` whose `<groupId>`
 * is `software.amazon.awssdk` or `com.amazonaws`. XML comments are
 * stripped first so a commented-out dependency (or a project-level
 * `<groupId>` outside any `<dependency>`) does not count.
 */
export function pomXmlUsesAws(text: string): boolean {
  const stripped = stripXmlComments(text);
  const groupIdPattern =
    /<groupId>\s*(software\.amazon\.awssdk|com\.amazonaws)\s*<\/groupId>/;

  let from = 0;
  for (;;) {
    const start = stripped.indexOf("<dependency>", from);
    if (start === -1) break;
    const contentStart = start + "<dependency>".length;
    const end = stripped.indexOf("</dependency>", contentStart);
    const segment = end === -1
      ? stripped.slice(contentStart)
      : stripped.slice(contentStart, end);
    if (groupIdPattern.test(segment)) return true;
    from = end === -1 ? stripped.length : end + "</dependency>".length;
  }
  return false;
}

/** Strip `<!-- ... -->` XML comments using indexOf loops (no regex backtracking). */
function stripXmlComments(text: string): string {
  let result = "";
  let from = 0;
  for (;;) {
    const start = text.indexOf("<!--", from);
    if (start === -1) {
      result += text.slice(from);
      break;
    }
    result += text.slice(from, start);
    const end = text.indexOf("-->", start + 4);
    if (end === -1) break; // unterminated comment: drop the remainder
    from = end + 3;
  }
  return result;
}

const REQUIREMENTS_AWS_PACKAGE =
  /^(boto3|botocore|aiobotocore)(?![A-Za-z0-9._-])/i;

/**
 * True when `text` (a `requirements*.txt`) pins `boto3`, `botocore`, or
 * `aiobotocore`. Look-alikes such as `boto3-stubs` or bare `boto` do not
 * count.
 */
export function requirementsUsesAws(text: string): boolean {
  for (const rawLine of text.split("\n")) {
    const hashAt = rawLine.indexOf("#");
    const line = (hashAt === -1 ? rawLine : rawLine.slice(0, hashAt)).trim();
    if (line.length === 0) continue;
    if (REQUIREMENTS_AWS_PACKAGE.test(line)) return true;
  }
  return false;
}

const AWS_RESOURCE_TYPE = /^AWS::/;

/**
 * True when `text` parses as a CloudFormation template: either it has its
 * own `AWSTemplateFormatVersion` key, or `Resources` is a non-array object
 * containing some value whose `Type` is a string starting with `AWS::`.
 * A cheap textual pre-filter avoids parsing files that plainly cannot be a
 * template; unparseable text yields false.
 */
export function isCfnTemplate(text: string): boolean {
  if (
    !text.includes("AWSTemplateFormatVersion") && !text.includes("AWS::")
  ) {
    return false;
  }
  const doc = parseCfnDocument(text);
  if (doc === null) return false;
  if (Object.hasOwn(doc, "AWSTemplateFormatVersion")) return true;
  const resources = doc.Resources;
  if (
    resources === null || typeof resources !== "object" ||
    Array.isArray(resources)
  ) {
    return false;
  }
  return Object.values(resources as Record<string, unknown>).some((r) => {
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      return false;
    }
    const type = (r as Record<string, unknown>).Type;
    return typeof type === "string" && AWS_RESOURCE_TYPE.test(type);
  });
}

/**
 * True when `ref` is exactly `floci/floci`, or `floci/floci` followed by a
 * tag (`:...`) or digest (`@...`). Case-sensitive — Docker refs are
 * lowercase by convention.
 */
export function isFlociImage(ref: string): boolean {
  const trimmed = ref.trim();
  return (
    trimmed === "floci/floci" ||
    trimmed.startsWith("floci/floci:") ||
    trimmed.startsWith("floci/floci@")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const DOCKER_RUN = /\bdocker\s+run\b/;
const DOCKER_RUN_FLOCI = /(?:^|[\s"'=])floci\/floci(?=$|[\s"':@])/m;

/**
 * True when a parsed workflow document runs `floci/floci` as a service
 * container, a job container, a `docker://` step, or via a `docker run`
 * step.
 */
export function workflowRunsFloci(parsedYaml: unknown): boolean {
  if (!isRecord(parsedYaml)) return false;
  const jobs = parsedYaml.jobs;
  if (!isRecord(jobs)) return false;

  for (const job of Object.values(jobs)) {
    if (!isRecord(job)) continue;

    const services = job.services;
    if (isRecord(services)) {
      for (const service of Object.values(services)) {
        if (
          isRecord(service) && typeof service.image === "string" &&
          isFlociImage(service.image)
        ) {
          return true;
        }
      }
    }

    const container = job.container;
    if (typeof container === "string" && isFlociImage(container)) {
      return true;
    }
    if (
      isRecord(container) && typeof container.image === "string" &&
      isFlociImage(container.image)
    ) {
      return true;
    }

    const steps = job.steps;
    if (Array.isArray(steps)) {
      for (const step of steps) {
        if (!isRecord(step)) continue;
        if (
          typeof step.uses === "string" && step.uses.startsWith("docker://")
        ) {
          const remainder = step.uses.slice("docker://".length);
          if (isFlociImage(remainder)) return true;
        }
        if (
          typeof step.run === "string" && DOCKER_RUN.test(step.run) &&
          DOCKER_RUN_FLOCI.test(step.run)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

const SHELL_SEPARATORS = new Set([";", "|", "&"]);
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const AWS_EMULATOR_RUN_COMMAND = /(?:^|\/)aws-emulator-run$/;
/** Largest repository script read for the one-level indirection check. */
const MAX_SCRIPT_BYTES = 1024 * 1024;

/** Reads a repo-relative script's text, or null when it is unavailable. */
export type ScriptReader = (relPath: string) => string | null;

/**
 * Split a `run:` body into command segments, each a list of words. Quotes
 * keep a word together (`X="a b"` is one word), a backslash-newline joins
 * lines, a newline or `;`/`|`/`&` starts a new segment, and a `#` that
 * starts a word ends the line. This finds command words only; it is not a
 * shell parser.
 */
function shellSegments(script: string): string[][] {
  const text = script.replace(/\\\r?\n/g, " ");
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote !== null) {
      word += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      word += ch;
      inWord = true;
      continue;
    }
    if (ch === "\n") {
      endSegment();
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      continue;
    }
    if (ch === "#" && !inWord) {
      const newline = text.indexOf("\n", i);
      if (newline === -1) break;
      i = newline - 1; // the loop's i++ lands on the newline
      continue;
    }
    if (SHELL_SEPARATORS.has(ch)) {
      endSegment();
      if (text.charAt(i + 1) === ch) i++; // `&&` and `||`
      continue;
    }
    word += ch;
    inWord = true;
  }
  endSegment();
  return segments;
}

/**
 * Shell reserved words and plain prefix words that may sit in front of the
 * command word. A word counts only when it stands alone (`then`, not
 * `then;`, which `shellSegments` already splits).
 */
const SHELL_PREFIX_WORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "!",
  "{",
  "(",
  "sudo",
  "env",
  "exec",
]);
/** `timeout` options that take a separate value word (`-k 5`, `-s KILL`). */
const TIMEOUT_VALUE_OPTIONS = new Set([
  "-k",
  "-s",
  "--kill-after",
  "--signal",
]);

/**
 * Index of the command word. Skips shell reserved words, `sudo`, `env`,
 * `exec`, leading `VAR=value` words, and the wrappers `time` (with `-p`),
 * `nice` (with `-n N` or `-N`), `timeout` (with its options and its duration
 * word) and `command`. `command -v`/`-V` only looks a command up, so it stops
 * the scan at `command` itself. Returns `words.length` when none is found.
 */
function commandIndex(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (SHELL_PREFIX_WORDS.has(w) || SHELL_ASSIGNMENT.test(w)) {
      i++;
    } else if (w === "time") {
      i++;
      if (words[i] === "-p") i++;
    } else if (w === "nice") {
      i++;
      const next = words[i];
      if (next === "-n") i += 2;
      else if (next !== undefined && /^-n?\d+$/.test(next)) i++;
    } else if (w === "timeout") {
      i++;
      while (i < words.length && (words[i] ?? "").startsWith("-")) {
        i += TIMEOUT_VALUE_OPTIONS.has(words[i] ?? "") ? 2 : 1;
      }
      i++; // the duration
    } else if (w === "command") {
      const next = words[i + 1];
      if (next === "-v" || next === "-V") break;
      i++;
    } else {
      break;
    }
  }
  return i;
}

/** `aws-emulator-run` options that take a separate value word. */
const EMULATOR_RUN_VALUE_OPTIONS = new Set(["--ready-timeout", "--timeout"]);
/** Commands that run nothing, so `aws-emulator-run -- true` tests nothing. */
const NO_OP_COMMANDS = new Set([
  "true",
  ":",
  "/bin/true",
  "/usr/bin/true",
]);

/**
 * True when one command segment actually runs a repository test through
 * the emulator runner (#5109's usage): its command word (see
 * {@link commandIndex}, with any surrounding quotes removed) is
 * `aws-emulator-run` or a path ending `/aws-emulator-run`, followed by
 * optional `--ready-timeout N` / `--timeout N`, then `--` and a COMMAND that
 * is not a no-op (`true`, `:`). The helper's own `--smoke` self-check,
 * `--smoke-client`, `-h`/`--help`, a bare `--` and any unknown option do not
 * count; nor do `echo aws-emulator-run`, `command -v aws-emulator-run`, an
 * `install ... /usr/local/bin/aws-emulator-run` or the install fragment
 * `container/toolchains/aws-emulator.sh`: none of them runs a test.
 */
function segmentInvokesEmulatorRunner(words: string[]): boolean {
  let i = commandIndex(words);
  const command = words[i];
  if (
    command === undefined ||
    !AWS_EMULATOR_RUN_COMMAND.test(stripQuotes(command))
  ) {
    return false;
  }
  i++;
  while (i < words.length) {
    const arg = stripQuotes(words[i] ?? "");
    if (EMULATOR_RUN_VALUE_OPTIONS.has(arg)) {
      if (i + 1 >= words.length) return false;
      i += 2;
    } else if (arg === "--") {
      const testCommand = words[i + 1];
      return testCommand !== undefined &&
        stripQuotes(testCommand).length > 0 &&
        !NO_OP_COMMANDS.has(stripQuotes(testCommand));
    } else {
      return false; // --smoke, --smoke-client, -h, --help or unknown
    }
  }
  return false;
}

function stripQuotes(word: string): string {
  return word.replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * The repo-relative script a segment runs: its command word (see
 * {@link commandIndex}) when that is a relative path (contains `/`), or the
 * first non-flag argument of `bash`/`sh`. Null when none.
 */
function segmentScriptPath(words: string[]): string | null {
  const i = commandIndex(words);
  const word = words[i];
  if (word === undefined) return null;
  const command = stripQuotes(word);
  if (command === "bash" || command === "sh") {
    const arg = words.slice(i + 1).find((w) => !w.startsWith("-"));
    return arg === undefined ? null : stripQuotes(arg);
  }
  return command.includes("/") ? command : null;
}

/** True when `script` text has a segment that invokes the emulator runner. */
function scriptInvokesEmulatorRunner(script: string): boolean {
  return shellSegments(script).some((w) => segmentInvokesEmulatorRunner(w));
}

/**
 * Build a `ScriptReader` confined to `repoRoot`. Rejects absolute paths,
 * `~`, `..` segments and `$` expansions; resolves symlinks and requires the
 * real path to sit inside the real repo root. Out-of-repo, non-file or
 * over-1-MiB scripts read as null, as does a missing script (including a
 * symlink to a missing target). Any other read error (for example permission
 * denied) throws, so a script that exists but cannot be read is never
 * mistaken for one that does not count.
 */
export function makeRepoScriptReader(repoRoot: string): ScriptReader {
  return (relPath: string): string | null => {
    if (
      relPath.length === 0 || relPath.startsWith("/") ||
      relPath.startsWith("~") || relPath.includes("$") ||
      relPath.includes("\0") || relPath.split("/").includes("..")
    ) {
      return null;
    }
    try {
      const realRoot = Deno.realPathSync(repoRoot);
      const real = Deno.realPathSync(`${realRoot}/${relPath}`);
      if (!real.startsWith(realRoot.replace(/\/+$/, "") + "/")) return null;
      const info = Deno.statSync(real);
      if (!info.isFile || info.size > MAX_SCRIPT_BYTES) return null;
      return Deno.readTextFileSync(real);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `aws-emulator check: cannot read repository script ${relPath}: ${message}`,
        { cause: err },
      );
    }
  };
}

/**
 * True when a parsed workflow document runs tests through the official AWS
 * Emulator in a `run:` step: either a segment invokes `aws-emulator-run`
 * directly, or it runs a repository script (a relative path, or the first
 * argument of `bash`/`sh`) that `readScript` returns and that itself has a
 * segment invoking `aws-emulator-run` (one level of indirection only).
 * Without `readScript` only direct invocations count. Floci is detected
 * separately by `workflowRunsFloci`.
 */
export function workflowRunsAwsEmulator(
  parsedYaml: unknown,
  readScript?: ScriptReader,
): boolean {
  if (!isRecord(parsedYaml)) return false;
  const jobs = parsedYaml.jobs;
  if (!isRecord(jobs)) return false;

  for (const job of Object.values(jobs)) {
    if (!isRecord(job)) continue;
    const steps = job.steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!isRecord(step) || typeof step.run !== "string") continue;
      for (const words of shellSegments(step.run)) {
        if (segmentInvokesEmulatorRunner(words)) return true;
        if (readScript === undefined) continue;
        const path = segmentScriptPath(words);
        if (path === null) continue;
        const text = readScript(path);
        if (text !== null && scriptInvokesEmulatorRunner(text)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Local recursive walker
// ---------------------------------------------------------------------------

async function walk(
  root: string,
  dir: string,
  rel: string,
  evidence: Set<string>,
): Promise<void> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound && dir !== root) {
      // The directory vanished mid-walk: nothing left to read, skip it.
      return;
    }
    throw new Error(
      `aws-emulator-in-ci: cannot read ${dir}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;

    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, path, relPath, evidence);
      continue;
    }

    // Deno.readDir reports a symlink as neither file nor directory, so
    // symlinks are never followed here (no loops, no escape from the
    // checkout).
    if (!entry.isFile) continue;
    await checkFile(entry.name, path, relPath, evidence);
  }
}

async function checkFile(
  name: string,
  path: string,
  relPath: string,
  evidence: Set<string>,
): Promise<void> {
  if (name.endsWith(".tf")) {
    evidence.add(relPath);
    return;
  }

  const isCandidate = name === "Cargo.toml" || name === "package.json" ||
    name === "pom.xml" || REQUIREMENTS_FILE.test(name) ||
    CFN_LIKE_FILE.test(name);
  if (!isCandidate) return;

  const text = await readFileOrSkip(path);
  if (text === null) return; // vanished mid-walk: nothing left to read

  if (name === "Cargo.toml") {
    if (cargoTomlUsesAws(text)) evidence.add(relPath);
    return;
  }
  if (name === "package.json") {
    let uses: boolean;
    try {
      uses = packageJsonUsesAws(text);
    } catch (err) {
      throw new Error(
        `aws-emulator-in-ci: cannot read ${path}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    if (uses) evidence.add(relPath);
    return;
  }
  if (name === "pom.xml") {
    if (pomXmlUsesAws(text)) evidence.add(relPath);
    return;
  }
  if (REQUIREMENTS_FILE.test(name)) {
    if (requirementsUsesAws(text)) evidence.add(relPath);
    return;
  }
  if (CFN_LIKE_FILE.test(name)) {
    if (isCfnTemplate(text)) evidence.add(relPath);
    return;
  }
}

/** Read a file's text, or null when it vanished mid-walk. Other read errors throw, wrapped with the path. */
async function readFileOrSkip(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw new Error(
      `aws-emulator-in-ci: cannot read ${path}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check a repository checked out at `repoPath` for AWS usage and for a
 * GitHub Actions workflow that runs an emulator (`floci/floci`, or tests
 * through the official AWS Emulator via `aws-emulator-run`, directly or in a
 * repository script a `run:` step executes).
 * A missing or unreadable `repoPath` rejects rather than reading as "no
 * AWS" — a wrong path must never be mistaken for a genuine absence. An
 * unreadable repository script referenced by a `run:` step (one that exists
 * but cannot be read, such as permission denied) rejects too; a missing one
 * does not count.
 */
export async function checkAwsEmulatorInCI(
  repoPath: string,
): Promise<AwsEmulatorCheckResult> {
  const evidence = new Set<string>();
  await walk(repoPath, repoPath, "", evidence);

  const workflows = await loadWorkflows(repoPath);
  // loadWorkflows only keeps workflows that parsed, so a throw here would
  // be a genuine fault (not a reachable "unparseable" case) and should
  // surface rather than be swallowed.
  const readScript = makeRepoScriptReader(repoPath);
  const emulatorConfigured = workflows.some((w) => {
    const doc = parseYaml(w.rawContent);
    return workflowRunsFloci(doc) || workflowRunsAwsEmulator(doc, readScript);
  });

  const awsEvidence = Array.from(evidence).sort();
  return {
    usesAws: awsEvidence.length > 0,
    awsEvidence,
    emulatorConfigured,
    workflowsLoaded: workflows.length > 0,
  };
}
