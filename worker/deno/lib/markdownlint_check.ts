/**
 * Quality gate check: every published Markdown file is structurally valid
 * (Issue #1685).
 *
 * Catches the broader class of Markdown defects that the
 * `pages-liquid` (#1601) and `mermaid` (#1683) checks miss — broken
 * heading hierarchies, malformed tables, missing-space ATX headings,
 * and empty links — by driving `markdownlint-cli2` against the same set
 * of `.md` files the published-Markdown checks cover, plus
 * `docs/**\/*.md`. The rule selection lives in `.markdownlint-cli2.jsonc`
 * at the repo root.
 *
 * The linter is invoked out-of-process; when no `markdownlint-cli2`
 * binary is available locally the check returns SKIPPED so contributors
 * without a Node toolchain are not blocked. `./quality.sh --strict`
 * promotes SKIPPED to FAILED, matching the `pages-liquid` pattern.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** Status of the markdownlint check. */
export type MarkdownlintStatus = "PASSED" | "SKIPPED" | "FAILED";

/** A single rule violation reported by markdownlint-cli2. */
export interface MarkdownlintViolation {
  /** Repo-relative path to the offending file. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number, when emitted by the linter. */
  column?: number;
  /** Rule identifier, e.g. `MD056/table-column-count`. */
  rule: string;
  /** Free-form message after the rule identifier. */
  message: string;
}

/** Structured result of running the markdownlint check. */
export interface MarkdownlintCheckResult {
  status: MarkdownlintStatus;
  /** Human-readable output for the quality gate summary. */
  output: string;
  /** Parsed violations (empty unless status is FAILED). */
  violations: MarkdownlintViolation[];
  /** Number of files reported as linted by the runner ("Linting: N file(s)"). */
  filesChecked: number;
  /** Reason for SKIPPED, when applicable. */
  skipReason?: string;
}

/** Subprocess result from invoking markdownlint-cli2. */
export interface MarkdownlintRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runner that invokes markdownlint-cli2 against the repo at `scriptDir`.
 *
 * The runner is responsible for choosing the binary (PATH, local
 * `node_modules/.bin`) and selecting the file globs (typically left to
 * `.markdownlint-cli2.jsonc`).
 */
export type MarkdownlintRunner = (
  scriptDir: string,
) => Promise<MarkdownlintRunResult>;

/** Factory that resolves a runner, or null when no toolchain is available. */
export type DetectMarkdownlintRunner = (
  scriptDir: string,
) => Promise<MarkdownlintRunner | null>;

/**
 * Pattern matching a markdownlint-cli2 violation line.
 *
 * Tolerates both `file:line:col` and `file:line` (no column) variants —
 * MD031 and similar rules emit only file:line; MD018 etc. emit file:line:col.
 *
 * The pattern is anchored: it must start with a non-whitespace path
 * (no spaces in filenames here), digits for line, optional `:digits` for
 * column, then ` error ` (or ` warning `) and a token for the rule.
 */
const VIOLATION_PATTERN =
  /^(\S+?):(\d+)(?::(\d+))?\s+(?:error|warning)\s+(\S+)\s+(.*)$/;

/**
 * Parse markdownlint-cli2 stdout into structured violations.
 *
 * Lines that do not match the violation pattern (preamble, "Linting: N
 * file(s)", "Summary: N error(s)", blank lines) are silently dropped.
 */
export function parseMarkdownlintOutput(
  output: string,
): MarkdownlintViolation[] {
  const violations: MarkdownlintViolation[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const match = VIOLATION_PATTERN.exec(line);
    if (!match) continue;
    const [, file, lineStr, colStr, rule, message] = match;
    // Issue #2795: validate the required captures rather than asserting them
    // away. Under noUncheckedIndexedAccess each capture is `string |
    // undefined`; an explicit guard narrows them to `string` and the compiler
    // verifies the invariant (the optional column is handled separately below).
    if (file === undefined || lineStr === undefined || rule === undefined) {
      continue;
    }
    const violation: MarkdownlintViolation = {
      file,
      line: Number.parseInt(lineStr, 10),
      rule,
      message: (message ?? "").trim(),
    };
    if (colStr !== undefined) {
      violation.column = Number.parseInt(colStr, 10);
    }
    violations.push(violation);
  }
  return violations;
}

/**
 * Pattern that extracts the `Linting: N file(s)` header markdownlint-cli2
 * emits before listing violations. Used purely for the summary count.
 */
const LINTING_COUNT_PATTERN = /^Linting:\s+(\d+)\s+file/m;

function extractFilesChecked(output: string): number {
  const match = LINTING_COUNT_PATTERN.exec(output);
  if (!match) return 0;
  return Number.parseInt(match[1]!, 10);
}

/**
 * Build a runner that invokes the given `markdownlint-cli2` binary path
 * with `cwd: scriptDir` and no explicit globs (the config's `globs`
 * field drives file selection).
 *
 * `--no-globs` is intentionally NOT passed — markdownlint-cli2 picks up
 * the `globs` array from `.markdownlint-cli2.jsonc` automatically when
 * no positional arguments are supplied.
 */
function makeBinaryRunner(binaryPath: string): MarkdownlintRunner {
  return async (scriptDir: string) => {
    const command = new Deno.Command(binaryPath, {
      args: [],
      cwd: scriptDir,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    return {
      exitCode: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  };
}

/**
 * Whether `binaryPath` can be executed at all (Issue #894).
 *
 * The question is "does this binary exist and start", not "does it exit
 * zero". Those were conflated: the probe ran the binary with `--version` and
 * treated a non-zero exit as absent. `markdownlint-cli2` has no `--version`
 * flag — it treats the argument as a **glob**, lints the repository against
 * `.markdownlint-cli2.jsonc`, and exits 1 when it finds a violation.
 *
 * So the probe failed precisely when the repository had a Markdown violation:
 * the stage reported SKIPPED and the gate went green over the very thing the
 * stage exists to catch — absence of a failure marker reported as success.
 *
 * Spawning is the only signal that answers the actual question. A missing or
 * unexecutable binary throws; one that runs has proved it exists, whatever it
 * then decides about the repository.
 */
export async function canRunBinary(binaryPath: string): Promise<boolean> {
  try {
    const command = new Deno.Command(binaryPath, {
      // `--help` is a no-op for the runners considered here and — unlike
      // `--version` — cannot be mistaken for a glob and lint the tree.
      args: ["--help"],
      stdout: "null",
      stderr: "null",
    });
    await command.output();
    // Exit code deliberately ignored: it reports what the binary thought of
    // its arguments, not whether the binary is there.
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect a usable `markdownlint-cli2` invocation.
 *
 * Order:
 *   1. Local `node_modules/.bin/markdownlint-cli2` (project install).
 *   2. `markdownlint-cli2` on PATH (global install).
 *
 * Auto-installation via `npx` is intentionally not attempted — the
 * worker runs unattended, so a network round-trip would be a hidden
 * dependency. Returns null when neither install location yields a
 * working binary.
 */
export const detectMarkdownlintRunner: DetectMarkdownlintRunner = async (
  scriptDir: string,
): Promise<MarkdownlintRunner | null> => {
  const local = `${scriptDir}/node_modules/.bin/markdownlint-cli2`;
  try {
    const stat = await Deno.stat(local);
    if (stat.isFile && await canRunBinary(local)) {
      return makeBinaryRunner(local);
    }
  } catch {
    // not present locally — fall through to PATH lookup
  }

  if (await canRunBinary("markdownlint-cli2")) {
    return makeBinaryRunner("markdownlint-cli2");
  }

  return null;
};

/** Options for runMarkdownlintCheck (mostly for testing). */
export interface MarkdownlintCheckOptions {
  /** Inject a custom runner detector. Returning null forces SKIPPED. */
  detectRunner?: DetectMarkdownlintRunner;
}

/**
 * Run the markdownlint quality check.
 *
 * Pipeline:
 *   1. Detect a markdownlint-cli2 binary. Unavailable → SKIPPED.
 *   2. Invoke the binary against the repo (config drives globs).
 *   3. Parse violations from stdout.
 *   4. Report PASSED, FAILED (with per-violation lines), or FAILED with
 *      a synthesised error if the runner exited non-zero but emitted no
 *      parseable violations.
 */
export async function runMarkdownlintCheck(
  scriptDir: string,
  options: MarkdownlintCheckOptions = {},
): Promise<MarkdownlintCheckResult> {
  const detect = options.detectRunner ?? detectMarkdownlintRunner;
  const runner = await detect(scriptDir);
  if (runner === null) {
    const reason =
      "markdownlint-cli2 not available (run `npm install -g markdownlint-cli2` " +
      "or add it to a project's devDependencies)";
    return {
      status: "SKIPPED",
      output: `markdownlint: SKIPPED (${reason})`,
      violations: [],
      filesChecked: 0,
      skipReason: reason,
    };
  }

  const run = await runner(scriptDir);
  const combined = run.stderr ? `${run.stdout}\n${run.stderr}` : run.stdout;
  const violations = parseMarkdownlintOutput(run.stdout);
  const filesChecked = extractFilesChecked(run.stdout);

  if (run.exitCode === 0 && violations.length === 0) {
    return {
      status: "PASSED",
      output: `markdownlint: PASSED (${filesChecked} file(s) checked)`,
      violations: [],
      filesChecked,
    };
  }

  if (violations.length === 0) {
    // Runner died (e.g. config error) without emitting any parseable
    // violation lines — surface the raw stderr so the failure does not
    // disappear silently.
    const detail = run.stderr.trim() ||
      `markdownlint-cli2 exited with code ${run.exitCode}`;
    return {
      status: "FAILED",
      output: [
        "markdownlint: FAILED",
        "",
        detail,
      ].join("\n"),
      violations: [],
      filesChecked,
    };
  }

  const violationLines = violations.map((v) =>
    `  ${v.file}:${v.line}${v.column !== undefined ? `:${v.column}` : ""} ` +
    `${v.rule} ${v.message}`
  );
  const lines = [
    `markdownlint: FAILED (${violations.length} violation(s) in ${filesChecked} file(s) checked)`,
    "",
    "Markdown structural violations:",
    ...violationLines,
    "",
    "Rule selection lives in `.markdownlint-cli2.jsonc` at the repo root " +
    "(Issue #1685). Fix the offending markup or, if the rule does not " +
    "fit the project, propose a rule change in a follow-up.",
  ];

  return {
    status: "FAILED",
    output: lines.join("\n"),
    violations,
    filesChecked,
    skipReason: combined.includes("not available") ? combined : undefined,
  };
}
