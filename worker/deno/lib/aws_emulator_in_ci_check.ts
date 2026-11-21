/**
 * AWS-emulator-in-CI check (Issue #3366, part of #3346; wiring rules Issue
 * #5112).
 *
 * A deterministic, file-based check answering two questions. First, does the
 * repo use AWS at all: a dependency manifest, a CloudFormation template, or a
 * Terraform file that names an AWS provider, resource, or module. Second, is
 * the repository's AWS test code wired to an emulator in CI? Only these earn
 * official credit, and only in a workflow that runs on `pull_request` (directly,
 * or through a `workflow_call` from one):
 *   - official-server: a status-preserving `aws-emulator-run -- <test>` in a
 *     `run:` step, directly or in a repository script that the step runs;
 *   - official-embedded (Rust only): a status-preserving `cargo test` or
 *     `cargo nextest` step with an `aws-emulator-embedded:` marker that pins
 *     the version and gives a justification.
 * Floci (`floci/floci`) is never official. A workflow that runs Floci counts
 * only with a valid recorded gap (`aws-emulator-gap:`) in an applicable workflow
 * that has an enabled Floci job without `continue-on-error`; otherwise the
 * result is floci-only, with a diagnostic saying why the gap is not credited. Installing the emulator (`container/toolchains/aws-emulator.sh`)
 * and an emulator service image with no runner step are not coverage, and a
 * `continue-on-error`, `|| true`, `!`, pipe, or `if` condition around the runner
 * stops the credit. The check reads workflow and script text only: it reports
 * configured execution, not an observed green CI run, and not test adequacy.
 * Modelled on `linter_in_ci_check.ts`:
 * no LLM judgement, just text/structure matching against files already in
 * the checkout.
 *
 * Australian English spelling used throughout.
 */

import { parse as parseYaml } from "@std/yaml/parse";
import { loadWorkflows } from "./linter_in_ci_check.ts";
import { parseCfnDocument } from "./cfn_cost_checks.ts";
import {
  commandIndex,
  type ReachableCommand,
  reachableCommands,
  readShellOptions,
  statusPreservingCommandIndex,
  stripQuotes,
} from "./shell_command_words.ts";

/**
 * How the repository's AWS tests are wired to an emulator in CI. The first
 * matching value in precedence order wins: official-server, official-embedded,
 * floci-gap, floci-only, missing.
 */
export type AwsEmulatorWiring =
  | "official-server"
  | "official-embedded"
  | "floci-gap"
  | "floci-only"
  | "missing";

/** Result of checking a repository for AWS usage and emulator wiring. */
export interface AwsEmulatorCheckResult {
  /** True iff `awsEvidence` is non-empty. */
  usesAws: boolean;
  /** Repo-relative paths ("/"-separated) of every file that triggered, sorted and deduplicated. */
  awsEvidence: string[];
  /**
   * The wiring found, by precedence (see {@link AwsEmulatorWiring}). official-embedded
   * is only credited when a `Cargo.toml` is among the AWS evidence (`awsEvidence`).
   */
  wiring: AwsEmulatorWiring;
  /** Static evidence for the credited wiring: "`<workflow file>` job `<id>`: `<the command words joined by space>`"; for floci-gap the gap record line; empty for missing and floci-only. */
  wiringEvidence: string[];
  /** Why wiring that was found was not credited, one line each, naming the workflow file and job. Also floci-only: "`ci.yml` job `x` runs floci/floci". */
  wiringDiagnostics: string[];
  /** Workflow files that failed to parse: whether they wire the emulator is unknown. */
  unreadableWorkflows: string[];
  /** False when `loadWorkflows` returned none (Issue #2880 diagnostic guard). */
  workflowsLoaded: boolean;
}

/** Directories never walked: VCS, dependencies, build output, and generated or vendored IaC trees. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "vendor",
  ".terraform",
  ".terragrunt-cache",
  "cdk.out",
  ".aws-sam",
]);

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
 * Terraform text with `#` and `//` line comments and block comments removed.
 * Double-quoted strings are kept whole, so a `//` subdirectory inside a module
 * `source` survives. Scans by index, with no regex.
 */
function stripHclComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (inString) {
      if (ch === "\\") {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "\n") inString = false;
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "#" || text.startsWith("//", i)) {
      const newline = text.indexOf("\n", i);
      if (newline === -1) break;
      i = newline;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) break;
      out += " ";
      i = end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** A `resource` or `data` block of an AWS type, on a trimmed line. */
const TF_AWS_BLOCK = /^(?:resource|data)\s+"aws_[A-Za-z0-9_]*"/;
/** The AWS provider block, on a trimmed line. */
const TF_AWS_PROVIDER = /^provider\s+"aws"/;
/** The `aws = {` entry of a `required_providers` block. */
const TF_AWS_REQUIRED_PROVIDER = /^aws\s*=\s*\{/;
/** A `source = "<value>"` line; the value is captured. */
const TF_SOURCE_LINE = /^source\s*=\s*"([^"]*)"/;
/** A provider source or registry module source that ends in `/aws`, e.g. `hashicorp/aws`. */
const TF_AWS_SOURCE = /^(?:[a-z0-9.-]+\/)?[a-z0-9-]+\/aws$/i;

/**
 * True when a Terraform `source` value names an AWS provider or registry
 * module: it ends in `/aws` (with an optional host, e.g.
 * `registry.terraform.io/hashicorp/aws`), or it contains
 * `terraform-aws-modules/`. Anything before a `//` subdirectory or a `?` is
 * compared, and a local path (`./`, `../`, `/`) is never AWS.
 */
function terraformSourceIsAws(value: string): boolean {
  if (value.includes("terraform-aws-modules/")) return true;
  let base = value.split("?")[0] ?? "";
  const scheme = base.indexOf("://");
  const subdir = base.indexOf("//", scheme === -1 ? 0 : scheme + 3);
  if (subdir !== -1) base = base.slice(0, subdir);
  if (base.startsWith(".") || base.startsWith("/")) return false;
  return TF_AWS_SOURCE.test(base);
}

/**
 * True when `text` (a Terraform file) uses AWS: an `aws_*` resource or data
 * block, the `aws` provider block, an `aws = {` required_providers entry, or a
 * `source` naming the AWS provider or an AWS registry module. Comments are
 * ignored. Other providers (`google`, `azurerm_*`) are not AWS.
 */
export function terraformUsesAws(text: string): boolean {
  for (const rawLine of stripHclComments(text).split("\n")) {
    const line = rawLine.trim();
    if (
      TF_AWS_BLOCK.test(line) || TF_AWS_PROVIDER.test(line) ||
      TF_AWS_REQUIRED_PROVIDER.test(line)
    ) {
      return true;
    }
    const source = TF_SOURCE_LINE.exec(line);
    if (source !== null && terraformSourceIsAws(source[1] ?? "")) return true;
  }
  return false;
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

/** True when one job runs `floci/floci` (service, container, `docker://` step, or `docker run`). */
function jobRunsFloci(job: Record<string, unknown>): boolean {
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
  if (typeof container === "string" && isFlociImage(container)) return true;
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
  return false;
}

/** The ids of the jobs in a parsed workflow that run `floci/floci`. */
function flociJobIds(parsedYaml: unknown): string[] {
  if (!isRecord(parsedYaml) || !isRecord(parsedYaml.jobs)) return [];
  return Object.entries(parsedYaml.jobs)
    .filter(([, job]) => isRecord(job) && jobRunsFloci(job))
    .map(([id]) => id);
}

/**
 * True when a parsed workflow document runs `floci/floci` as a service
 * container, a job container, a `docker://` step, or via a `docker run`
 * step. Floci is never official coverage; see {@link checkAwsEmulatorInCI}.
 */
export function workflowRunsFloci(parsedYaml: unknown): boolean {
  return flociJobIds(parsedYaml).length > 0;
}

const AWS_EMULATOR_RUN_COMMAND = /(?:^|\/)aws-emulator-run$/;
/** Largest repository script read for the one-level indirection check. */
const MAX_SCRIPT_BYTES = 1024 * 1024;

/** Reads a repo-relative script's text, or null when it is unavailable. */
export type ScriptReader = (relPath: string) => string | null;

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

/**
 * The repo-relative script a segment runs: its command word (see
 * {@link commandIndex}) when that is a relative path (contains `/`), or the
 * first operand of `bash`/`sh` after its options. Null when none, and for
 * a `bash`/`sh` that would not run the script: `-n` / `-o noexec` /
 * `--noexec` only checks syntax, and `-c` takes a command string.
 */
function segmentScriptPath(words: string[]): string | null {
  const i = commandIndex(words);
  const word = words[i];
  if (word === undefined) return null;
  const command = stripQuotes(word);
  if (command === "bash" || command === "sh") {
    const args = words.slice(i + 1);
    const options = readShellOptions(args);
    if (options.noexec || options.commandString) return null;
    const arg = args[options.operand];
    return arg === undefined ? null : stripQuotes(arg);
  }
  return command.includes("/") ? command : null;
}

/**
 * True when a workflow `if:` value is statically false (`false`, `${{ false }}`,
 * `0`, `''`, `null`, `!true`), so the job or step never runs. Any other
 * expression is decided at run time and keeps its credit.
 */
function ifIsStaticallyFalse(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === false || value === null || value === 0) return true;
  if (typeof value !== "string") return false;
  const text = value.trim();
  const wrapped = /^\$\{\{([^}]*)\}\}$/.exec(text);
  const expr = (wrapped?.[1] ?? text).trim().toLowerCase();
  return ["false", "0", "''", '""', "null", "!true"].includes(expr);
}

/**
 * How one `&&` term of an `if:` reads on a pull request: true or false for
 * `github.event_name == 'E'` / `!= 'E'`, null when it does not read
 * `github.event_name` (decided at run time), `"unknown"` for any other form
 * that reads it.
 */
function eventTermOnPullRequest(term: string): boolean | null | "unknown" {
  const text = term.trim();
  if (!text.includes("github.event_name")) return null;
  const m = /^github\.event_name\s*(==|!=)\s*'([A-Za-z_]+)'$/.exec(text);
  if (m === null) return "unknown";
  return (m[2] === "pull_request") === (m[1] === "==");
}

/**
 * Whether a job or step `if:` lets it run on a pull request, judged only where
 * the expression reads `github.event_name`. The expression is read as an `||`
 * of `&&` terms (see {@link eventTermOnPullRequest}); a disjunct is false on a
 * pull request when one of its terms is. Null (no refusal) when the expression
 * does not read the event or some disjunct can be true on a pull request
 * (`github.event_name != 'pull_request' || !github.event.pull_request.draft`);
 * `"excludes"` when every disjunct is false on a pull request
 * (`github.event_name == 'push'`); `"unknown"` when the event is read in another
 * form (parentheses, `contains(...)`), so it earns no credit either.
 */
function eventIfRefusal(value: unknown): "excludes" | "unknown" | null {
  if (typeof value !== "string" || !value.includes("github.event_name")) {
    return null;
  }
  const text = value.trim();
  const wrapped = /^\$\{\{(.*)\}\}$/s.exec(text);
  const expr = (wrapped?.[1] ?? text).trim();
  if (/[()]/.test(expr)) return "unknown";
  let sawUnknown = false;
  for (const disjunct of expr.split("||")) {
    let verdict: "maybe" | "false" | "unknown" = "maybe";
    for (const term of disjunct.split("&&")) {
      const onPr = eventTermOnPullRequest(term);
      if (onPr === false) {
        verdict = "false";
        break;
      }
      if (onPr === "unknown") verdict = "unknown";
    }
    if (verdict === "maybe") return null;
    if (verdict === "unknown") sawUnknown = true;
  }
  return sawUnknown ? "unknown" : "excludes";
}

/** A diagnostic for a job or step `if:` that {@link eventIfRefusal} refuses, or null. */
function eventIfDiagnostic(where: string, value: unknown): string | null {
  const refusal = eventIfRefusal(value);
  if (refusal === null) return null;
  return refusal === "excludes"
    ? `${where}: if: \`${String(value)}\` excludes pull_request events`
    : `${where}: if: \`${
      String(value)
    }\` reads the event in a form this check cannot decide, so it earns no pull_request credit`;
}

/**
 * True when a `continue-on-error` value sets failures aside: anything other
 * than absent, `false` or `"false"` (an expression is decided at run time, so
 * it earns no credit).
 */
function continueOnErrorSet(value: unknown): boolean {
  return !(value === undefined || value === false || value === "false");
}

/** A `defaults.run.shell` value, when the record has one. */
export function defaultShell(record: Record<string, unknown>): unknown {
  const defaults = record.defaults;
  if (!isRecord(defaults) || !isRecord(defaults.run)) return undefined;
  return defaults.run.shell;
}

/**
 * True when a step's `shell:` value (`bash -n {0}`, `sh -o noexec {0}`)
 * reads the `run:` body without running it. Other shells, and a missing
 * value, run it.
 */
function shellIsNoexec(shell: unknown): boolean {
  if (typeof shell !== "string") return false;
  const words = shell.trim().split(/\s+/);
  const command = (words[0] ?? "").replace(/^.*\//, "");
  if (command !== "bash" && command !== "sh") return false;
  return readShellOptions(words.slice(1)).noexec;
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

// ---------------------------------------------------------------------------
// Credit rules: applicability, status preservation, official and embedded
// ---------------------------------------------------------------------------

/** A parsed workflow: its file name, raw text and YAML document. */
interface WorkflowDoc {
  file: string;
  raw: string;
  doc: unknown;
}

/** True when a workflow's `on:` (a string, an array, or an object's keys) names `event`. */
function triggersOn(doc: unknown, event: string): boolean {
  if (!isRecord(doc)) return false;
  const on = doc.on;
  if (typeof on === "string") return on === event;
  if (Array.isArray(on)) return on.includes(event);
  return isRecord(on) && Object.hasOwn(on, event);
}

/** True when a job of `doc` (not statically disabled) `uses:` the reusable workflow `file`. */
function callsWorkflow(doc: unknown, file: string): boolean {
  if (!isRecord(doc) || !isRecord(doc.jobs)) return false;
  return Object.values(doc.jobs).some((job) =>
    isRecord(job) && !ifIsStaticallyFalse(job.if) &&
    eventIfRefusal(job.if) === null && typeof job.uses === "string" &&
    job.uses.replace(/^\.\//, "") === `.github/workflows/${file}`
  );
}

/**
 * The file names of the workflows whose jobs run on `pull_request`. A
 * workflow with `on.workflow_call` is applicable when an applicable workflow
 * has an enabled job that calls it (`uses: ./.github/workflows/<file>`),
 * transitively, with a visited set. Only jobs in applicable workflows earn
 * official credit.
 */
function applicableWorkflowFiles(docs: WorkflowDoc[]): Set<string> {
  const applicable = new Set<string>();
  const queue: WorkflowDoc[] = [];
  for (const d of docs) {
    if (triggersOn(d.doc, "pull_request")) {
      applicable.add(d.file);
      queue.push(d);
    }
  }
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const callee of docs) {
      if (
        applicable.has(callee.file) || !triggersOn(callee.doc, "workflow_call")
      ) {
        continue;
      }
      if (callsWorkflow(next.doc, callee.file)) {
        applicable.add(callee.file);
        queue.push(callee);
      }
    }
  }
  return applicable;
}

/**
 * True when a command's failure is not swallowed or inverted where it stands:
 * it runs (not in a condition), no word in front of it inverts or ignores its
 * status (`!`, `then`, ...), and the next separator does not swallow its failure
 * (`||`, `|`, `&`).
 */
function commandStatusNotSwallowed(cmd: ReachableCommand): boolean {
  return !cmd.condition &&
    statusPreservingCommandIndex(cmd.words) !== -1 &&
    cmd.next !== "||" && cmd.next !== "|" && cmd.next !== "&";
}

/** A reachable command and whether its failure fails the body (see {@link keptCommands}). */
interface KeptCommand {
  cmd: ReachableCommand;
  kept: boolean;
}

/**
 * The reachable commands of a `run:` body, in order, each with whether its
 * failure fails the body ("kept").
 *
 * `initialErrexit` says whether the body runs with `-e`; a reachable `set`
 * then updates it (`set -e`, `set -o errexit` on; `set +e`, `set +o errexit`
 * off). A command is kept when a failure always reaches an explicit failing
 * exit (`cmd || exit 1`, `if ! cmd; then ...; exit 1; fi`), or when its failure
 * is not swallowed (see {@link commandStatusNotSwallowed}) and one of these holds: it runs via `exec`;
 * every later reachable command is joined by `&&` (it is last, or the rest is an
 * `&&` chain to the end); or errexit is on and it is not followed by `&&`.
 */
function keptCommands(body: string, initialErrexit: boolean): KeptCommand[] {
  const cmds = reachableCommands(body);
  // restAllAnd[k]: every reachable command after k is joined by `&&`.
  const restAllAnd: boolean[] = [];
  let allAnd = true;
  for (let k = cmds.length - 1; k >= 0; k--) {
    restAllAnd[k] = allAnd;
    allAnd = allAnd && cmds[k]?.sep === "&&";
  }
  const out: KeptCommand[] = [];
  let errexit = initialErrexit;
  for (const [k, cmd] of cmds.entries()) {
    const at = commandIndex(cmd.words);
    const viaExec = cmd.words.slice(0, at).includes("exec");
    const kept = cmd.failureExits || (commandStatusNotSwallowed(cmd) &&
      (viaExec || restAllAnd[k] === true || (errexit && cmd.next !== "&&")));
    out.push({ cmd, kept });
    if (stripQuotes(cmd.words[at] ?? "") === "set") {
      const option = readShellOptions(cmd.words.slice(at + 1)).errexit;
      if (option !== null) errexit = option;
    }
  }
  return out;
}

/**
 * Whether GitHub runs a step's `run:` body with `-e`: an undefined shell (the
 * default), exactly `bash` or `sh`, or a shell string whose options turn errexit
 * on. Any other shell starts with errexit off.
 */
function stepStartsErrexit(shell: unknown): boolean {
  if (shell === undefined) return true;
  if (typeof shell !== "string") return false;
  const text = shell.trim();
  if (text === "bash" || text === "sh") return true;
  return readShellOptions(text.split(/\s+/).slice(1)).errexit === true;
}

/** True when the command is `cargo test` or `cargo nextest`, skipping a `+toolchain` word. */
function isCargoTestCommand(words: string[]): boolean {
  const i = commandIndex(words);
  if (stripQuotes(words[i] ?? "") !== "cargo") return false;
  let j = i + 1;
  if ((words[j] ?? "").startsWith("+")) j++;
  const subcommand = stripQuotes(words[j] ?? "");
  return subcommand === "test" || subcommand === "nextest";
}

/** Read `key=value` fields from a marker body, split on `;` and the first `=`. */
function parseFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of body.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!fields.has(key)) fields.set(key, part.slice(eq + 1).trim());
  }
  return fields;
}

/**
 * The text after `marker` when a line is a YAML or shell comment carrying it:
 * the trimmed line starts with `#`, and after `#` (trimmed) comes `marker`.
 * Null otherwise.
 */
function markerBody(line: string, marker: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("#")) return null;
  const rest = trimmed.slice(1).trim();
  return rest.startsWith(marker) ? rest.slice(marker.length) : null;
}

const EMBEDDED_MARKER = "aws-emulator-embedded:";
const VERSION_PIN = /^\d+\.\d+\.\d+$/;

/** The first `aws-emulator-embedded:` marker in a run body, or null. */
function embeddedMarker(
  run: string,
): { version: string; justification: string } | null {
  for (const line of run.split("\n")) {
    const body = markerBody(line, EMBEDDED_MARKER);
    if (body !== null) {
      const fields = parseFields(body);
      return {
        version: fields.get("version") ?? "",
        justification: fields.get("justification") ?? "",
      };
    }
  }
  return null;
}

/** A credited wiring and the static evidence line for it. */
interface Credit {
  wiring: "official-server" | "official-embedded";
  evidence: string;
}

/** Options the workflow scan needs from its caller. */
interface ScanOptions {
  readScript?: ScriptReader;
  /** The workflow runs on `pull_request`, or an applicable workflow calls it. */
  applicable: boolean;
  /** Some AWS evidence file is a `Cargo.toml`. */
  rust: boolean;
}

/** An emulator invocation found in a run body, and whether it can be credited. */
interface RunnerHit {
  label: string;
  ok: boolean;
  reason: string;
}

/**
 * Emulator invocations in a `run:` body: the direct `aws-emulator-run` commands
 * and the repository-script commands whose own status-preserving reachable
 * commands run it (one level only). `ok` is false when the invocation cannot be
 * credited because of how it is run.
 */
function serverHits(
  where: string,
  run: string,
  initialErrexit: boolean,
  readScript: ScriptReader | undefined,
): RunnerHit[] {
  const hits: RunnerHit[] = [];
  for (const { cmd, kept } of keptCommands(run, initialErrexit)) {
    const label = cmd.words.join(" ");
    if (segmentInvokesEmulatorRunner(cmd.words)) {
      hits.push({
        label,
        ok: kept,
        reason:
          `${where}: step running \`${label}\` is not status-preserving: a failure would not fail the step`,
      });
      continue;
    }
    if (readScript === undefined) continue;
    const path = segmentScriptPath(cmd.words);
    if (path === null) continue;
    const text = readScript(path);
    if (text === null) continue;
    // A repository script starts without errexit, whatever the caller's shell.
    const inner = keptCommands(text, false).filter((k) =>
      segmentInvokesEmulatorRunner(k.cmd.words)
    );
    if (inner.length === 0) continue;
    hits.push({
      label,
      ok: kept && inner.some((k) => k.kept),
      reason: kept
        ? `${where}: step running \`${label}\` runs \`${path}\`, whose emulator run is not status-preserving`
        : `${where}: step running \`${label}\` is not status-preserving: a failure would not fail the step`,
    });
  }
  return hits;
}

/** The static gate for one workflow document: credits and diagnostics. */
interface WorkflowScan {
  credits: Credit[];
  diagnostics: string[];
}

/**
 * Credit the emulator wiring of one parsed workflow. A step earns official
 * credit only when its job and step are enabled, the job and step do not set
 * `continue-on-error`, the shell runs the body, the workflow is applicable, and
 * the command is status-preserving. Every refusal of wiring that was found
 * adds a diagnostic naming the file and job.
 */
function scanWorkflowDoc(
  file: string,
  doc: unknown,
  opts: ScanOptions,
): WorkflowScan {
  const credits: Credit[] = [];
  const diagnostics: string[] = [];
  if (!isRecord(doc) || !isRecord(doc.jobs)) return { credits, diagnostics };

  const notApplicable =
    `\`${file}\`: does not run on pull_request and no pull_request workflow calls it`;
  const workflowShell = defaultShell(doc);

  for (const [jobId, job] of Object.entries(doc.jobs)) {
    if (!isRecord(job) || ifIsStaticallyFalse(job.if)) continue;
    const steps = job.steps;
    if (!Array.isArray(steps)) continue;
    const where = `\`${file}\` job \`${jobId}\``;
    const jobShell = defaultShell(job) ?? workflowShell;
    const jobSetsContinue = continueOnErrorSet(job["continue-on-error"]);

    for (const step of steps) {
      if (!isRecord(step) || typeof step.run !== "string") continue;
      if (ifIsStaticallyFalse(step.if)) continue;
      const shell = step.shell ?? jobShell;
      const stepSetsContinue = continueOnErrorSet(step["continue-on-error"]);

      // Reasons this step's wiring is refused, given the command it runs.
      const refusals = (label: string): string[] => {
        const out: string[] = [];
        if (jobSetsContinue) {
          out.push(
            `${where}: job sets continue-on-error, so its failures do not fail the run`,
          );
        }
        if (stepSetsContinue) {
          out.push(
            `${where}: step running \`${label}\` sets continue-on-error`,
          );
        }
        for (
          const diagnostic of [
            eventIfDiagnostic(where, job.if),
            eventIfDiagnostic(`${where} step running \`${label}\``, step.if),
          ]
        ) {
          if (diagnostic !== null) out.push(diagnostic);
        }
        if (shellIsNoexec(shell)) {
          out.push(
            `${where}: step shell \`${
              String(shell)
            }\` reads the run body without running it`,
          );
        }
        return out;
      };
      const grant = (
        wiring: Credit["wiring"],
        evidence: string,
        reasons: string[],
      ): void => {
        if (reasons.length > 0) {
          diagnostics.push(...reasons);
        } else if (!opts.applicable) {
          diagnostics.push(notApplicable);
        } else {
          credits.push({ wiring, evidence });
        }
      };

      const errexit = stepStartsErrexit(shell);
      for (const hit of serverHits(where, step.run, errexit, opts.readScript)) {
        const reasons = hit.ok ? [] : [hit.reason];
        reasons.push(...refusals(hit.label));
        grant("official-server", `${where}: \`${hit.label}\``, reasons);
      }

      const marker = embeddedMarker(step.run);
      if (marker !== null) {
        const cargo = keptCommands(step.run, errexit).find((k) =>
          k.kept && isCargoTestCommand(k.cmd.words)
        );
        const label = cargo?.cmd.words.join(" ") ?? "cargo test";
        const reasons: string[] = [];
        if (!opts.rust) {
          reasons.push(
            `${where}: aws-emulator-embedded marker is not credited: the repository has no Cargo.toml with AWS evidence`,
          );
        }
        if (!VERSION_PIN.test(marker.version)) {
          reasons.push(
            `${where}: aws-emulator-embedded marker is not credited: version must be an exact pin X.Y.Z`,
          );
        }
        if (marker.justification.length === 0) {
          reasons.push(
            `${where}: aws-emulator-embedded marker is not credited: justification is empty`,
          );
        }
        if (cargo === undefined) {
          reasons.push(
            `${where}: aws-emulator-embedded marker is not credited: no status-preserving cargo test or cargo nextest command in this step`,
          );
        }
        reasons.push(...refusals(label));
        grant("official-embedded", `${where}: \`${label}\``, reasons);
      }
    }
  }
  return { credits, diagnostics };
}

/**
 * True when a parsed workflow document runs tests through the official AWS
 * Emulator in a `run:` step: a status-preserving `aws-emulator-run` command,
 * directly or in a repository script (one level of indirection) that `readScript`
 * returns and that itself runs `aws-emulator-run` status-preservingly. The
 * workflow counts as applicable when it triggers on `pull_request`; use
 * {@link checkAwsEmulatorInCI} for `workflow_call` reach and the embedded and
 * Floci rules. Floci is never official, and a job or step that is statically
 * disabled, sets `continue-on-error`, or runs its body under a noexec shell
 * earns no credit.
 */
export function workflowRunsAwsEmulator(
  parsedYaml: unknown,
  readScript?: ScriptReader,
): boolean {
  return scanWorkflowDoc("workflow", parsedYaml, {
    readScript,
    applicable: triggersOn(parsedYaml, "pull_request"),
    rust: false,
  }).credits.some((c) => c.wiring === "official-server");
}

// ---------------------------------------------------------------------------
// Floci gap records
// ---------------------------------------------------------------------------

const GAP_MARKER = "aws-emulator-gap:";
const GAP_KEYS = ["version", "behaviour", "evidence", "alternative", "recheck"];

/** One `aws-emulator-gap:` record in a workflow's text, with the keys it lacks. */
interface GapRecord {
  line: string;
  missing: string[];
}

/**
 * The gap records in a workflow's raw text. A record needs all five keys
 * non-empty, and a version must contain a digit; `missing` lists what fails.
 */
function gapRecords(raw: string): GapRecord[] {
  const out: GapRecord[] = [];
  for (const line of raw.split("\n")) {
    const body = markerBody(line, GAP_MARKER);
    if (body === null) continue;
    const fields = parseFields(body);
    const missing = GAP_KEYS.filter((key) => {
      const value = fields.get(key) ?? "";
      if (value.length === 0) return true;
      return key === "version" && !/\d/.test(value);
    });
    out.push({ line: line.trim(), missing });
  }
  return out;
}

/** Words that mark a command as a test run (`npm test`, `mvn verify`, `pytest`). */
const TEST_WORD = /test|spec|jest|mocha|verify|integration/i;
/** Command words that never run a test, whatever their arguments say. */
const NON_TEST_COMMANDS = new Set([
  "echo",
  "printf",
  "true",
  ":",
  "docker",
  "sleep",
  "curl",
  "wget",
  "set",
  "export",
  "cd",
]);

/**
 * True when a command looks like a test run: its command word is not one that
 * never runs a test (`echo`, `docker`, ...), and the command word or one of the
 * next three words names a test (`npm test`, `npm run test:aws`, `cargo test`,
 * `mvn verify`, `./scripts/integration.sh`).
 */
function looksLikeTestCommand(words: string[]): boolean {
  const at = commandIndex(words);
  const head = stripQuotes(words[at] ?? "").replace(/^.*\//, "");
  if (head.length === 0 || NON_TEST_COMMANDS.has(head)) return false;
  return words.slice(at, at + 4).some((w) => TEST_WORD.test(stripQuotes(w)));
}

/**
 * True when a Floci job runs a test whose failure fails the job: an enabled
 * `run:` step (no static-false `if:`, no `if:` that excludes pull requests, no
 * `continue-on-error`, a shell that runs the body) with a reachable test
 * command (see {@link looksLikeTestCommand}) whose failure is kept (see
 * {@link keptCommands}).
 */
function flociJobRunsTest(job: Record<string, unknown>, doc: unknown): boolean {
  const steps = job.steps;
  if (!Array.isArray(steps)) return false;
  const jobShell = defaultShell(job) ??
    (isRecord(doc) ? defaultShell(doc) : undefined);
  return steps.some((step) => {
    if (!isRecord(step) || typeof step.run !== "string") return false;
    if (ifIsStaticallyFalse(step.if) || eventIfRefusal(step.if) !== null) {
      return false;
    }
    if (continueOnErrorSet(step["continue-on-error"])) return false;
    const shell = step.shell ?? jobShell;
    if (shellIsNoexec(shell)) return false;
    return keptCommands(step.run, stepStartsErrexit(shell)).some((k) =>
      k.kept && looksLikeTestCommand(k.cmd.words)
    );
  });
}

/**
 * The ids of the jobs that run Floci and could carry a gap: not statically
 * disabled by `if:`, no `if:` that excludes pull requests, not
 * `continue-on-error`, and running a failure-preserving test step (see
 * {@link flociJobRunsTest}).
 */
function creditableFlociJobIds(parsedYaml: unknown): string[] {
  if (!isRecord(parsedYaml) || !isRecord(parsedYaml.jobs)) return [];
  return Object.entries(parsedYaml.jobs)
    .filter(([, job]) =>
      isRecord(job) && jobRunsFloci(job) && !ifIsStaticallyFalse(job.if) &&
      eventIfRefusal(job.if) === null &&
      !continueOnErrorSet(job["continue-on-error"]) &&
      flociJobRunsTest(job, parsedYaml)
    )
    .map(([id]) => id);
}

/**
 * Why a workflow's valid gap record cannot credit `floci-gap`, or null when it
 * can: the workflow must be applicable (it runs on pull_request, or a
 * pull_request workflow calls it), and it must have a Floci job that
 * {@link creditableFlociJobIds} accepts.
 */
function gapRecordRefusal(d: WorkflowDoc, applicable: boolean): string | null {
  const prefix = `\`${d.file}\`: aws-emulator-gap record is not credited:`;
  if (!applicable) {
    return `${prefix} the workflow does not run on pull_request and no pull_request workflow calls it`;
  }
  if (creditableFlociJobIds(d.doc).length === 0) {
    return `${prefix} no Floci job is enabled for pull_request without continue-on-error and runs a test step whose failure fails the job`;
  }
  return null;
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
    const tf = await readFileOrSkip(path, MAX_SCRIPT_BYTES);
    if (tf !== null && terraformUsesAws(tf)) evidence.add(relPath);
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

/**
 * Read a file's text, or null when it vanished mid-walk or (when `maxBytes` is
 * given) is larger than `maxBytes`, so an oversized file is never loaded. Other
 * read errors throw, wrapped with the path.
 */
async function readFileOrSkip(
  path: string,
  maxBytes?: number,
): Promise<string | null> {
  try {
    if (maxBytes !== undefined && (await Deno.stat(path)).size > maxBytes) {
      return null;
    }
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
 * Check a repository checked out at `repoPath` for AWS usage and for emulator
 * wiring in its GitHub Actions workflows: the precedence and credit rules are
 * described on {@link AwsEmulatorWiring}. A missing or unreadable `repoPath`
 * rejects rather than reading as "no AWS" — a wrong path must never be
 * mistaken for a genuine absence. An unreadable repository script referenced
 * by a `run:` step (one that exists but cannot be read, such as permission
 * denied) rejects too; a missing one does not count. A workflow that fails to
 * parse is listed in `unreadableWorkflows`, not treated as missing wiring.
 */
export async function checkAwsEmulatorInCI(
  repoPath: string,
): Promise<AwsEmulatorCheckResult> {
  const evidence = new Set<string>();
  await walk(repoPath, repoPath, "", evidence);
  const awsEvidence = Array.from(evidence).sort();

  const unreadable = new Set<string>();
  const workflows = await loadWorkflows(repoPath, {
    onUnparseable: (filename) => unreadable.add(filename),
  });
  // loadWorkflows only keeps workflows that parsed, so a throw here would
  // be a genuine fault (not a reachable "unparseable" case) and should
  // surface rather than be swallowed.
  const docs: WorkflowDoc[] = workflows.map((w) => ({
    file: w.filename,
    raw: w.rawContent,
    doc: parseYaml(w.rawContent),
  }));
  const applicable = applicableWorkflowFiles(docs);
  const readScript = makeRepoScriptReader(repoPath);
  const rust = awsEvidence.some((p) =>
    p.slice(p.lastIndexOf("/") + 1) === "Cargo.toml"
  );

  const credits: Credit[] = [];
  const diagnostics: string[] = [];
  for (const d of docs) {
    const scan = scanWorkflowDoc(d.file, d.doc, {
      readScript,
      applicable: applicable.has(d.file),
      rust,
    });
    credits.push(...scan.credits);
    diagnostics.push(...scan.diagnostics);
  }

  let wiring: AwsEmulatorWiring = "missing";
  let wiringEvidence: string[] = [];
  const server = credits.filter((c) => c.wiring === "official-server");
  const embedded = credits.filter((c) => c.wiring === "official-embedded");
  if (server.length > 0) {
    wiring = "official-server";
    wiringEvidence = server.map((c) => c.evidence);
  } else if (embedded.length > 0) {
    wiring = "official-embedded";
    wiringEvidence = embedded.map((c) => c.evidence);
  } else {
    const floci = docs.filter((d) => workflowRunsFloci(d.doc));
    if (floci.length > 0) {
      let gap: { file: string; line: string } | null = null;
      const refusals: string[] = [];
      for (const d of floci) {
        const valid = gapRecords(d.raw).find((r) => r.missing.length === 0);
        if (valid === undefined) continue;
        const refusal = gapRecordRefusal(d, applicable.has(d.file));
        if (refusal !== null) {
          refusals.push(refusal);
        } else if (gap === null) {
          gap = { file: d.file, line: valid.line };
        }
      }
      if (gap !== null) {
        wiring = "floci-gap";
        wiringEvidence = [`\`${gap.file}\`: \`${gap.line}\``];
      } else {
        wiring = "floci-only";
        diagnostics.push(...refusals);
        for (const d of floci) {
          for (const id of flociJobIds(d.doc)) {
            diagnostics.push(`\`${d.file}\` job \`${id}\` runs floci/floci`);
          }
          for (const record of gapRecords(d.raw)) {
            if (record.missing.length > 0) {
              diagnostics.push(
                `\`${d.file}\`: aws-emulator-gap record lacks ${
                  record.missing.join(", ")
                }`,
              );
            }
          }
        }
      }
    }
  }

  return {
    usesAws: awsEvidence.length > 0,
    awsEvidence,
    wiring,
    wiringEvidence,
    wiringDiagnostics: Array.from(new Set(diagnostics)),
    unreadableWorkflows: Array.from(unreadable).sort(),
    workflowsLoaded: workflows.length > 0,
  };
}
