/**
 * Quality gate check: every published Markdown file is structurally valid
 * (Issue #1685).
 *
 * Catches the broader class of Markdown defects that the
 * `mermaid` (#1683) check misses — broken
 * heading hierarchies, malformed tables, missing-space ATX headings,
 * and empty links — by driving `markdownlint-cli2` against the same set
 * of `.md` files the published-Markdown checks cover, plus
 * `docs/**\/*.md`. The rule selection lives in `.markdownlint-cli2.jsonc`
 * at the repo root.
 *
 * The linter is invoked out-of-process; when no `markdownlint-cli2`
 * binary is available locally the check returns SKIPPED so contributors
 * without a Node toolchain are not blocked. The same holds when the repo
 * configures no `globs` (Issue #4438): markdownlint-cli2 then prints its help
 * screen and lints nothing, which is reported as SKIPPED with a reason rather
 * than FAILED. `./quality.sh --strict` promotes SKIPPED to FAILED, matching
 * the `mermaid` pattern.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */ import { commandOutputWithTimeout, isCommandTimeoutError } from "./subprocess_timeout.ts";
import { buildUntrustedCommandEnv } from "./untrusted_command_env.ts";
/** A markdownlint run. Minutes. A timeout fails the check. */ const MARKDOWNLINT_TIMEOUT_MS = 10 * 60 * 1000;
/** `--help` probe. Seconds. A timeout is not "binary absent". */ const MARKDOWNLINT_PROBE_TIMEOUT_MS = 10_000;
/**
 * Pattern matching a markdownlint-cli2 violation line.
 *
 * Tolerates both `file:line:col` and `file:line` (no column) variants —
 * MD031 and similar rules emit only file:line; MD018 etc. emit file:line:col.
 *
 * The pattern is anchored: it must start with a non-whitespace path
 * (no spaces in filenames here), digits for line, optional `:digits` for
 * column, then ` error ` (or ` warning `) and a token for the rule.
 */ const VIOLATION_PATTERN = /^(\S+?):(\d+)(?::(\d+))?\s+(?:error|warning)\s+(\S+)\s+(.*)$/;
/**
 * Parse markdownlint-cli2 stdout into structured violations.
 *
 * Lines that do not match the violation pattern (preamble, "Linting: N
 * file(s)", "Summary: N error(s)", blank lines) are silently dropped.
 */ export function parseMarkdownlintOutput(output) {
  const violations = [];
  for (const rawLine of output.split("\n")){
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
    const violation = {
      file,
      line: Number.parseInt(lineStr, 10),
      rule,
      message: (message ?? "").trim()
    };
    if (colStr !== undefined) {
      violation.column = Number.parseInt(colStr, 10);
    }
    violations.push(violation);
  }
  return violations;
}
/**
 * Pattern matching a warning-severity violation line. markdownlint-cli2 exits
 * 0 when every result is a warning (only results whose severity is not
 * `warning` set the failing exit code), so a warning line never fails the gate
 * on its own (PR #4453 review).
 */ const WARNING_LINE_PATTERN = /^\S+?:\d+(?::\d+)?\s+warning\s/;
/**
 * Parse only the error-severity violations from markdownlint-cli2 output,
 * dropping warning lines so the check follows the binary's own verdict.
 */ function parseMarkdownlintErrors(output) {
  const errorLines = output.split("\n").filter((line)=>!WARNING_LINE_PATTERN.test(line.trimEnd()));
  return parseMarkdownlintOutput(errorLines.join("\n"));
}
/**
 * Pattern that extracts the `Linting: N file(s)` header markdownlint-cli2
 * emits before listing violations. Used purely for the summary count.
 */ const LINTING_COUNT_PATTERN = /^Linting:\s+(\d+)\s+file/m;
function extractFilesChecked(output) {
  const match = LINTING_COUNT_PATTERN.exec(output);
  if (!match) return 0;
  return Number.parseInt(match[1], 10);
}
/**
 * Pattern matching the `Syntax:` line of the help screen markdownlint-cli2
 * prints when run with no globs (Issue #4438). Anchored to the line start so
 * text that merely quotes the phrase does not match.
 */ const HELP_SCREEN_PATTERN = /^Syntax:[ \t]+markdownlint-cli2[ \t]+glob0\b/m;
/**
 * Whether a run was markdownlint-cli2 printing its help screen because the
 * repo configures no `globs` (Issue #4438).
 *
 * With no positional arguments and no `globs` in the config, markdownlint-cli2
 * prints help to STDOUT, exits 2 and lints nothing. That is not a lint
 * failure. All of these must hold: exit 2, the help `Syntax:` line on stdout
 * or stderr, no `Linting:` header on stdout, and no violation lines on stdout.
 * A config error also exits 2, but it prints an `Error:` line rather than the
 * help screen, so it is not matched and stays FAILED.
 */ function isNoGlobsHelpRun(run) {
  if (run.exitCode !== 2) return false;
  if (!HELP_SCREEN_PATTERN.test(run.stdout) && !HELP_SCREEN_PATTERN.test(run.stderr)) {
    return false;
  }
  if (LINTING_COUNT_PATTERN.test(run.stdout)) return false;
  return parseMarkdownlintOutput(run.stdout).length === 0;
}
/**
 * Build a runner that invokes the given `markdownlint-cli2` binary path
 * with `cwd: scriptDir` and no explicit globs (the config's `globs`
 * field drives file selection).
 *
 * `--no-globs` is intentionally NOT passed — markdownlint-cli2 picks up
 * the `globs` array from `.markdownlint-cli2.jsonc` automatically when
 * no positional arguments are supplied. When the config has no `globs`,
 * the binary prints its help screen and exits 2; runMarkdownlintCheck
 * reports that run as SKIPPED (Issue #4438).
 */ export async function runMarkdownlintBinary(binaryPath, scriptDir, timeoutMs = MARKDOWNLINT_TIMEOUT_MS) {
  const result = await commandOutputWithTimeout(binaryPath, {
    args: [],
    cwd: scriptDir,
    // Issue #1226: the linter is Node code from this repository's own
    // `node_modules`, so a compromised dependency runs here. Its
    // environment is BUILT from the allowlist rather than inherited — no
    // credential is in scope for it to read.
    env: buildUntrustedCommandEnv(),
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
    timeoutMs
  });
  return {
    exitCode: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr)
  };
}
function makeBinaryRunner(binaryPath) {
  return (scriptDir)=>runMarkdownlintBinary(binaryPath, scriptDir);
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
 */ export async function canRunBinary(binaryPath, timeoutMs = MARKDOWNLINT_PROBE_TIMEOUT_MS) {
  try {
    await commandOutputWithTimeout(binaryPath, {
      // `--help` is a no-op for the runners considered here and — unlike
      // `--version` — cannot be mistaken for a glob and lint the tree.
      args: [
        "--help"
      ],
      // The probe starts the same untrusted binary as the run, so it gets the
      // same built environment (Issue #1226).
      env: buildUntrustedCommandEnv(),
      clearEnv: true,
      stdout: "null",
      stderr: "null",
      timeoutMs
    });
    // Exit code deliberately ignored: it reports what the binary thought of
    // its arguments, not whether the binary is there.
    return true;
  } catch (error) {
    if (isCommandTimeoutError(error)) throw error;
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
 */ export const detectMarkdownlintRunner = async (scriptDir)=>{
  const local = `${scriptDir}/node_modules/.bin/markdownlint-cli2`;
  try {
    const stat = await Deno.stat(local);
    if (stat.isFile && await canRunBinary(local)) {
      return makeBinaryRunner(local);
    }
  } catch (error) {
    if (isCommandTimeoutError(error)) throw error;
  // not present locally — fall through to PATH lookup
  }
  if (await canRunBinary("markdownlint-cli2")) {
    return makeBinaryRunner("markdownlint-cli2");
  }
  return null;
};
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
 *   5. Report SKIPPED when the repo configures no `globs`: the run printed
 *      markdownlint-cli2's help screen, exited 2 and linted nothing
 *      (Issue #4438). A config error exits 2 too but stays FAILED.
 */ export async function runMarkdownlintCheck(scriptDir, options = {}) {
  const detect = options.detectRunner ?? detectMarkdownlintRunner;
  const runner = await detect(scriptDir);
  if (runner === null) {
    const reason = "markdownlint-cli2 not available (run `npm install -g markdownlint-cli2` " + "or add it to a project's devDependencies)";
    return {
      status: "SKIPPED",
      output: `markdownlint: SKIPPED (${reason})`,
      violations: [],
      filesChecked: 0,
      skipReason: reason
    };
  }
  const run = await runner(scriptDir);
  const combined = run.stderr ? `${run.stdout}\n${run.stderr}` : run.stdout;
  // markdownlint-cli2 v0.24.0 writes violation lines to STDERR and the
  // `Linting:` / `Summary:` header to STDOUT, so violations are parsed from
  // both streams. The file count stays on stdout. Warning-severity lines are
  // dropped: the binary exits 0 on warnings alone, and the gate follows that
  // verdict (PR #4453 review).
  const violations = parseMarkdownlintErrors(combined);
  const filesChecked = extractFilesChecked(run.stdout);
  if (run.exitCode === 0 && violations.length === 0) {
    return {
      status: "PASSED",
      output: `markdownlint: PASSED (${filesChecked} file(s) checked)`,
      violations: [],
      filesChecked
    };
  }
  if (isNoGlobsHelpRun(run)) {
    const reason = "no markdown globs configured: markdownlint-cli2 printed its help and " + "linted nothing — add a `globs` array to .markdownlint-cli2.jsonc to " + "enable this check";
    return {
      status: "SKIPPED",
      output: `markdownlint: SKIPPED (${reason})`,
      violations: [],
      filesChecked: 0,
      skipReason: reason
    };
  }
  if (violations.length === 0) {
    // Runner died (e.g. config error) without emitting any parseable
    // violation lines — surface the raw stderr so the failure does not
    // disappear silently. A config error prints its `Error:` line to STDOUT,
    // so with empty stderr fall back to that line before the generic exit code.
    const stdoutError = /^Error:[^\n]*/m.exec(run.stdout)?.[0].trim();
    const detail = run.stderr.trim() || stdoutError || `markdownlint-cli2 exited with code ${run.exitCode}`;
    return {
      status: "FAILED",
      output: [
        "markdownlint: FAILED",
        "",
        detail
      ].join("\n"),
      violations: [],
      filesChecked
    };
  }
  const violationLines = violations.map((v)=>`  ${v.file}:${v.line}${v.column !== undefined ? `:${v.column}` : ""} ` + `${v.rule} ${v.message}`);
  const lines = [
    `markdownlint: FAILED (${violations.length} violation(s) in ${filesChecked} file(s) checked)`,
    "",
    "Markdown structural violations:",
    ...violationLines,
    "",
    "Rule selection lives in `.markdownlint-cli2.jsonc` at the repo root " + "(Issue #1685). Fix the offending markup or, if the rule does not " + "fit the project, propose a rule change in a follow-up."
  ];
  return {
    status: "FAILED",
    output: lines.join("\n"),
    violations,
    filesChecked,
    skipReason: combined.includes("not available") ? combined : undefined
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9tYXJrZG93bmxpbnRfY2hlY2sudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBRdWFsaXR5IGdhdGUgY2hlY2s6IGV2ZXJ5IHB1Ymxpc2hlZCBNYXJrZG93biBmaWxlIGlzIHN0cnVjdHVyYWxseSB2YWxpZFxuICogKElzc3VlICMxNjg1KS5cbiAqXG4gKiBDYXRjaGVzIHRoZSBicm9hZGVyIGNsYXNzIG9mIE1hcmtkb3duIGRlZmVjdHMgdGhhdCB0aGVcbiAqIGBtZXJtYWlkYCAoIzE2ODMpIGNoZWNrIG1pc3NlcyDigJQgYnJva2VuXG4gKiBoZWFkaW5nIGhpZXJhcmNoaWVzLCBtYWxmb3JtZWQgdGFibGVzLCBtaXNzaW5nLXNwYWNlIEFUWCBoZWFkaW5ncyxcbiAqIGFuZCBlbXB0eSBsaW5rcyDigJQgYnkgZHJpdmluZyBgbWFya2Rvd25saW50LWNsaTJgIGFnYWluc3QgdGhlIHNhbWUgc2V0XG4gKiBvZiBgLm1kYCBmaWxlcyB0aGUgcHVibGlzaGVkLU1hcmtkb3duIGNoZWNrcyBjb3ZlciwgcGx1c1xuICogYGRvY3MvKipcXC8qLm1kYC4gVGhlIHJ1bGUgc2VsZWN0aW9uIGxpdmVzIGluIGAubWFya2Rvd25saW50LWNsaTIuanNvbmNgXG4gKiBhdCB0aGUgcmVwbyByb290LlxuICpcbiAqIFRoZSBsaW50ZXIgaXMgaW52b2tlZCBvdXQtb2YtcHJvY2Vzczsgd2hlbiBubyBgbWFya2Rvd25saW50LWNsaTJgXG4gKiBiaW5hcnkgaXMgYXZhaWxhYmxlIGxvY2FsbHkgdGhlIGNoZWNrIHJldHVybnMgU0tJUFBFRCBzbyBjb250cmlidXRvcnNcbiAqIHdpdGhvdXQgYSBOb2RlIHRvb2xjaGFpbiBhcmUgbm90IGJsb2NrZWQuIFRoZSBzYW1lIGhvbGRzIHdoZW4gdGhlIHJlcG9cbiAqIGNvbmZpZ3VyZXMgbm8gYGdsb2JzYCAoSXNzdWUgIzQ0MzgpOiBtYXJrZG93bmxpbnQtY2xpMiB0aGVuIHByaW50cyBpdHMgaGVscFxuICogc2NyZWVuIGFuZCBsaW50cyBub3RoaW5nLCB3aGljaCBpcyByZXBvcnRlZCBhcyBTS0lQUEVEIHdpdGggYSByZWFzb24gcmF0aGVyXG4gKiB0aGFuIEZBSUxFRC4gYC4vcXVhbGl0eS5zaCAtLXN0cmljdGAgcHJvbW90ZXMgU0tJUFBFRCB0byBGQUlMRUQsIG1hdGNoaW5nXG4gKiB0aGUgYG1lcm1haWRgIHBhdHRlcm4uXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHVzZWQgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7XG4gIGNvbW1hbmRPdXRwdXRXaXRoVGltZW91dCxcbiAgaXNDb21tYW5kVGltZW91dEVycm9yLFxufSBmcm9tIFwiLi9zdWJwcm9jZXNzX3RpbWVvdXQudHNcIjtcbmltcG9ydCB7IGJ1aWxkVW50cnVzdGVkQ29tbWFuZEVudiB9IGZyb20gXCIuL3VudHJ1c3RlZF9jb21tYW5kX2Vudi50c1wiO1xuXG4vKiogQSBtYXJrZG93bmxpbnQgcnVuLiBNaW51dGVzLiBBIHRpbWVvdXQgZmFpbHMgdGhlIGNoZWNrLiAqL1xuY29uc3QgTUFSS0RPV05MSU5UX1RJTUVPVVRfTVMgPSAxMCAqIDYwICogMTAwMDtcblxuLyoqIGAtLWhlbHBgIHByb2JlLiBTZWNvbmRzLiBBIHRpbWVvdXQgaXMgbm90IFwiYmluYXJ5IGFic2VudFwiLiAqL1xuY29uc3QgTUFSS0RPV05MSU5UX1BST0JFX1RJTUVPVVRfTVMgPSAxMF8wMDA7XG5cbi8qKiBTdGF0dXMgb2YgdGhlIG1hcmtkb3dubGludCBjaGVjay4gKi9cbmV4cG9ydCB0eXBlIE1hcmtkb3dubGludFN0YXR1cyA9IFwiUEFTU0VEXCIgfCBcIlNLSVBQRURcIiB8IFwiRkFJTEVEXCI7XG5cbi8qKiBBIHNpbmdsZSBydWxlIHZpb2xhdGlvbiByZXBvcnRlZCBieSBtYXJrZG93bmxpbnQtY2xpMi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTWFya2Rvd25saW50VmlvbGF0aW9uIHtcbiAgLyoqIFJlcG8tcmVsYXRpdmUgcGF0aCB0byB0aGUgb2ZmZW5kaW5nIGZpbGUuICovXG4gIGZpbGU6IHN0cmluZztcbiAgLyoqIDEtYmFzZWQgbGluZSBudW1iZXIuICovXG4gIGxpbmU6IG51bWJlcjtcbiAgLyoqIDEtYmFzZWQgY29sdW1uIG51bWJlciwgd2hlbiBlbWl0dGVkIGJ5IHRoZSBsaW50ZXIuICovXG4gIGNvbHVtbj86IG51bWJlcjtcbiAgLyoqIFJ1bGUgaWRlbnRpZmllciwgZS5nLiBgTUQwNTYvdGFibGUtY29sdW1uLWNvdW50YC4gKi9cbiAgcnVsZTogc3RyaW5nO1xuICAvKiogRnJlZS1mb3JtIG1lc3NhZ2UgYWZ0ZXIgdGhlIHJ1bGUgaWRlbnRpZmllci4gKi9cbiAgbWVzc2FnZTogc3RyaW5nO1xufVxuXG4vKiogU3RydWN0dXJlZCByZXN1bHQgb2YgcnVubmluZyB0aGUgbWFya2Rvd25saW50IGNoZWNrLiAqL1xuZXhwb3J0IGludGVyZmFjZSBNYXJrZG93bmxpbnRDaGVja1Jlc3VsdCB7XG4gIHN0YXR1czogTWFya2Rvd25saW50U3RhdHVzO1xuICAvKiogSHVtYW4tcmVhZGFibGUgb3V0cHV0IGZvciB0aGUgcXVhbGl0eSBnYXRlIHN1bW1hcnkuICovXG4gIG91dHB1dDogc3RyaW5nO1xuICAvKiogUGFyc2VkIHZpb2xhdGlvbnMgKGVtcHR5IHVubGVzcyBzdGF0dXMgaXMgRkFJTEVEKS4gKi9cbiAgdmlvbGF0aW9uczogTWFya2Rvd25saW50VmlvbGF0aW9uW107XG4gIC8qKiBOdW1iZXIgb2YgZmlsZXMgcmVwb3J0ZWQgYXMgbGludGVkIGJ5IHRoZSBydW5uZXIgKFwiTGludGluZzogTiBmaWxlKHMpXCIpLiAqL1xuICBmaWxlc0NoZWNrZWQ6IG51bWJlcjtcbiAgLyoqIFJlYXNvbiBmb3IgU0tJUFBFRCwgd2hlbiBhcHBsaWNhYmxlLiAqL1xuICBza2lwUmVhc29uPzogc3RyaW5nO1xufVxuXG4vKiogU3VicHJvY2VzcyByZXN1bHQgZnJvbSBpbnZva2luZyBtYXJrZG93bmxpbnQtY2xpMi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTWFya2Rvd25saW50UnVuUmVzdWx0IHtcbiAgZXhpdENvZGU6IG51bWJlcjtcbiAgc3Rkb3V0OiBzdHJpbmc7XG4gIHN0ZGVycjogc3RyaW5nO1xufVxuXG4vKipcbiAqIFJ1bm5lciB0aGF0IGludm9rZXMgbWFya2Rvd25saW50LWNsaTIgYWdhaW5zdCB0aGUgcmVwbyBhdCBgc2NyaXB0RGlyYC5cbiAqXG4gKiBUaGUgcnVubmVyIGlzIHJlc3BvbnNpYmxlIGZvciBjaG9vc2luZyB0aGUgYmluYXJ5IChQQVRILCBsb2NhbFxuICogYG5vZGVfbW9kdWxlcy8uYmluYCkgYW5kIHNlbGVjdGluZyB0aGUgZmlsZSBnbG9icyAodHlwaWNhbGx5IGxlZnQgdG9cbiAqIGAubWFya2Rvd25saW50LWNsaTIuanNvbmNgKS5cbiAqL1xuZXhwb3J0IHR5cGUgTWFya2Rvd25saW50UnVubmVyID0gKFxuICBzY3JpcHREaXI6IHN0cmluZyxcbikgPT4gUHJvbWlzZTxNYXJrZG93bmxpbnRSdW5SZXN1bHQ+O1xuXG4vKiogRmFjdG9yeSB0aGF0IHJlc29sdmVzIGEgcnVubmVyLCBvciBudWxsIHdoZW4gbm8gdG9vbGNoYWluIGlzIGF2YWlsYWJsZS4gKi9cbmV4cG9ydCB0eXBlIERldGVjdE1hcmtkb3dubGludFJ1bm5lciA9IChcbiAgc2NyaXB0RGlyOiBzdHJpbmcsXG4pID0+IFByb21pc2U8TWFya2Rvd25saW50UnVubmVyIHwgbnVsbD47XG5cbi8qKlxuICogUGF0dGVybiBtYXRjaGluZyBhIG1hcmtkb3dubGludC1jbGkyIHZpb2xhdGlvbiBsaW5lLlxuICpcbiAqIFRvbGVyYXRlcyBib3RoIGBmaWxlOmxpbmU6Y29sYCBhbmQgYGZpbGU6bGluZWAgKG5vIGNvbHVtbikgdmFyaWFudHMg4oCUXG4gKiBNRDAzMSBhbmQgc2ltaWxhciBydWxlcyBlbWl0IG9ubHkgZmlsZTpsaW5lOyBNRDAxOCBldGMuIGVtaXQgZmlsZTpsaW5lOmNvbC5cbiAqXG4gKiBUaGUgcGF0dGVybiBpcyBhbmNob3JlZDogaXQgbXVzdCBzdGFydCB3aXRoIGEgbm9uLXdoaXRlc3BhY2UgcGF0aFxuICogKG5vIHNwYWNlcyBpbiBmaWxlbmFtZXMgaGVyZSksIGRpZ2l0cyBmb3IgbGluZSwgb3B0aW9uYWwgYDpkaWdpdHNgIGZvclxuICogY29sdW1uLCB0aGVuIGAgZXJyb3IgYCAob3IgYCB3YXJuaW5nIGApIGFuZCBhIHRva2VuIGZvciB0aGUgcnVsZS5cbiAqL1xuY29uc3QgVklPTEFUSU9OX1BBVFRFUk4gPVxuICAvXihcXFMrPyk6KFxcZCspKD86OihcXGQrKSk/XFxzKyg/OmVycm9yfHdhcm5pbmcpXFxzKyhcXFMrKVxccysoLiopJC87XG5cbi8qKlxuICogUGFyc2UgbWFya2Rvd25saW50LWNsaTIgc3Rkb3V0IGludG8gc3RydWN0dXJlZCB2aW9sYXRpb25zLlxuICpcbiAqIExpbmVzIHRoYXQgZG8gbm90IG1hdGNoIHRoZSB2aW9sYXRpb24gcGF0dGVybiAocHJlYW1ibGUsIFwiTGludGluZzogTlxuICogZmlsZShzKVwiLCBcIlN1bW1hcnk6IE4gZXJyb3IocylcIiwgYmxhbmsgbGluZXMpIGFyZSBzaWxlbnRseSBkcm9wcGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VNYXJrZG93bmxpbnRPdXRwdXQoXG4gIG91dHB1dDogc3RyaW5nLFxuKTogTWFya2Rvd25saW50VmlvbGF0aW9uW10ge1xuICBjb25zdCB2aW9sYXRpb25zOiBNYXJrZG93bmxpbnRWaW9sYXRpb25bXSA9IFtdO1xuICBmb3IgKGNvbnN0IHJhd0xpbmUgb2Ygb3V0cHV0LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgY29uc3QgbGluZSA9IHJhd0xpbmUudHJpbUVuZCgpO1xuICAgIGlmICghbGluZSkgY29udGludWU7XG4gICAgY29uc3QgbWF0Y2ggPSBWSU9MQVRJT05fUEFUVEVSTi5leGVjKGxpbmUpO1xuICAgIGlmICghbWF0Y2gpIGNvbnRpbnVlO1xuICAgIGNvbnN0IFssIGZpbGUsIGxpbmVTdHIsIGNvbFN0ciwgcnVsZSwgbWVzc2FnZV0gPSBtYXRjaDtcbiAgICAvLyBJc3N1ZSAjMjc5NTogdmFsaWRhdGUgdGhlIHJlcXVpcmVkIGNhcHR1cmVzIHJhdGhlciB0aGFuIGFzc2VydGluZyB0aGVtXG4gICAgLy8gYXdheS4gVW5kZXIgbm9VbmNoZWNrZWRJbmRleGVkQWNjZXNzIGVhY2ggY2FwdHVyZSBpcyBgc3RyaW5nIHxcbiAgICAvLyB1bmRlZmluZWRgOyBhbiBleHBsaWNpdCBndWFyZCBuYXJyb3dzIHRoZW0gdG8gYHN0cmluZ2AgYW5kIHRoZSBjb21waWxlclxuICAgIC8vIHZlcmlmaWVzIHRoZSBpbnZhcmlhbnQgKHRoZSBvcHRpb25hbCBjb2x1bW4gaXMgaGFuZGxlZCBzZXBhcmF0ZWx5IGJlbG93KS5cbiAgICBpZiAoZmlsZSA9PT0gdW5kZWZpbmVkIHx8IGxpbmVTdHIgPT09IHVuZGVmaW5lZCB8fCBydWxlID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCB2aW9sYXRpb246IE1hcmtkb3dubGludFZpb2xhdGlvbiA9IHtcbiAgICAgIGZpbGUsXG4gICAgICBsaW5lOiBOdW1iZXIucGFyc2VJbnQobGluZVN0ciwgMTApLFxuICAgICAgcnVsZSxcbiAgICAgIG1lc3NhZ2U6IChtZXNzYWdlID8/IFwiXCIpLnRyaW0oKSxcbiAgICB9O1xuICAgIGlmIChjb2xTdHIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdmlvbGF0aW9uLmNvbHVtbiA9IE51bWJlci5wYXJzZUludChjb2xTdHIsIDEwKTtcbiAgICB9XG4gICAgdmlvbGF0aW9ucy5wdXNoKHZpb2xhdGlvbik7XG4gIH1cbiAgcmV0dXJuIHZpb2xhdGlvbnM7XG59XG5cbi8qKlxuICogUGF0dGVybiBtYXRjaGluZyBhIHdhcm5pbmctc2V2ZXJpdHkgdmlvbGF0aW9uIGxpbmUuIG1hcmtkb3dubGludC1jbGkyIGV4aXRzXG4gKiAwIHdoZW4gZXZlcnkgcmVzdWx0IGlzIGEgd2FybmluZyAob25seSByZXN1bHRzIHdob3NlIHNldmVyaXR5IGlzIG5vdFxuICogYHdhcm5pbmdgIHNldCB0aGUgZmFpbGluZyBleGl0IGNvZGUpLCBzbyBhIHdhcm5pbmcgbGluZSBuZXZlciBmYWlscyB0aGUgZ2F0ZVxuICogb24gaXRzIG93biAoUFIgIzQ0NTMgcmV2aWV3KS5cbiAqL1xuY29uc3QgV0FSTklOR19MSU5FX1BBVFRFUk4gPSAvXlxcUys/OlxcZCsoPzo6XFxkKyk/XFxzK3dhcm5pbmdcXHMvO1xuXG4vKipcbiAqIFBhcnNlIG9ubHkgdGhlIGVycm9yLXNldmVyaXR5IHZpb2xhdGlvbnMgZnJvbSBtYXJrZG93bmxpbnQtY2xpMiBvdXRwdXQsXG4gKiBkcm9wcGluZyB3YXJuaW5nIGxpbmVzIHNvIHRoZSBjaGVjayBmb2xsb3dzIHRoZSBiaW5hcnkncyBvd24gdmVyZGljdC5cbiAqL1xuZnVuY3Rpb24gcGFyc2VNYXJrZG93bmxpbnRFcnJvcnMob3V0cHV0OiBzdHJpbmcpOiBNYXJrZG93bmxpbnRWaW9sYXRpb25bXSB7XG4gIGNvbnN0IGVycm9yTGluZXMgPSBvdXRwdXRcbiAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAuZmlsdGVyKChsaW5lKSA9PiAhV0FSTklOR19MSU5FX1BBVFRFUk4udGVzdChsaW5lLnRyaW1FbmQoKSkpO1xuICByZXR1cm4gcGFyc2VNYXJrZG93bmxpbnRPdXRwdXQoZXJyb3JMaW5lcy5qb2luKFwiXFxuXCIpKTtcbn1cblxuLyoqXG4gKiBQYXR0ZXJuIHRoYXQgZXh0cmFjdHMgdGhlIGBMaW50aW5nOiBOIGZpbGUocylgIGhlYWRlciBtYXJrZG93bmxpbnQtY2xpMlxuICogZW1pdHMgYmVmb3JlIGxpc3RpbmcgdmlvbGF0aW9ucy4gVXNlZCBwdXJlbHkgZm9yIHRoZSBzdW1tYXJ5IGNvdW50LlxuICovXG5jb25zdCBMSU5USU5HX0NPVU5UX1BBVFRFUk4gPSAvXkxpbnRpbmc6XFxzKyhcXGQrKVxccytmaWxlL207XG5cbmZ1bmN0aW9uIGV4dHJhY3RGaWxlc0NoZWNrZWQob3V0cHV0OiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCBtYXRjaCA9IExJTlRJTkdfQ09VTlRfUEFUVEVSTi5leGVjKG91dHB1dCk7XG4gIGlmICghbWF0Y2gpIHJldHVybiAwO1xuICByZXR1cm4gTnVtYmVyLnBhcnNlSW50KG1hdGNoWzFdISwgMTApO1xufVxuXG4vKipcbiAqIFBhdHRlcm4gbWF0Y2hpbmcgdGhlIGBTeW50YXg6YCBsaW5lIG9mIHRoZSBoZWxwIHNjcmVlbiBtYXJrZG93bmxpbnQtY2xpMlxuICogcHJpbnRzIHdoZW4gcnVuIHdpdGggbm8gZ2xvYnMgKElzc3VlICM0NDM4KS4gQW5jaG9yZWQgdG8gdGhlIGxpbmUgc3RhcnQgc29cbiAqIHRleHQgdGhhdCBtZXJlbHkgcXVvdGVzIHRoZSBwaHJhc2UgZG9lcyBub3QgbWF0Y2guXG4gKi9cbmNvbnN0IEhFTFBfU0NSRUVOX1BBVFRFUk4gPSAvXlN5bnRheDpbIFxcdF0rbWFya2Rvd25saW50LWNsaTJbIFxcdF0rZ2xvYjBcXGIvbTtcblxuLyoqXG4gKiBXaGV0aGVyIGEgcnVuIHdhcyBtYXJrZG93bmxpbnQtY2xpMiBwcmludGluZyBpdHMgaGVscCBzY3JlZW4gYmVjYXVzZSB0aGVcbiAqIHJlcG8gY29uZmlndXJlcyBubyBgZ2xvYnNgIChJc3N1ZSAjNDQzOCkuXG4gKlxuICogV2l0aCBubyBwb3NpdGlvbmFsIGFyZ3VtZW50cyBhbmQgbm8gYGdsb2JzYCBpbiB0aGUgY29uZmlnLCBtYXJrZG93bmxpbnQtY2xpMlxuICogcHJpbnRzIGhlbHAgdG8gU1RET1VULCBleGl0cyAyIGFuZCBsaW50cyBub3RoaW5nLiBUaGF0IGlzIG5vdCBhIGxpbnRcbiAqIGZhaWx1cmUuIEFsbCBvZiB0aGVzZSBtdXN0IGhvbGQ6IGV4aXQgMiwgdGhlIGhlbHAgYFN5bnRheDpgIGxpbmUgb24gc3Rkb3V0XG4gKiBvciBzdGRlcnIsIG5vIGBMaW50aW5nOmAgaGVhZGVyIG9uIHN0ZG91dCwgYW5kIG5vIHZpb2xhdGlvbiBsaW5lcyBvbiBzdGRvdXQuXG4gKiBBIGNvbmZpZyBlcnJvciBhbHNvIGV4aXRzIDIsIGJ1dCBpdCBwcmludHMgYW4gYEVycm9yOmAgbGluZSByYXRoZXIgdGhhbiB0aGVcbiAqIGhlbHAgc2NyZWVuLCBzbyBpdCBpcyBub3QgbWF0Y2hlZCBhbmQgc3RheXMgRkFJTEVELlxuICovXG5mdW5jdGlvbiBpc05vR2xvYnNIZWxwUnVuKHJ1bjogTWFya2Rvd25saW50UnVuUmVzdWx0KTogYm9vbGVhbiB7XG4gIGlmIChydW4uZXhpdENvZGUgIT09IDIpIHJldHVybiBmYWxzZTtcbiAgaWYgKFxuICAgICFIRUxQX1NDUkVFTl9QQVRURVJOLnRlc3QocnVuLnN0ZG91dCkgJiZcbiAgICAhSEVMUF9TQ1JFRU5fUEFUVEVSTi50ZXN0KHJ1bi5zdGRlcnIpXG4gICkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBpZiAoTElOVElOR19DT1VOVF9QQVRURVJOLnRlc3QocnVuLnN0ZG91dCkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHBhcnNlTWFya2Rvd25saW50T3V0cHV0KHJ1bi5zdGRvdXQpLmxlbmd0aCA9PT0gMDtcbn1cblxuLyoqXG4gKiBCdWlsZCBhIHJ1bm5lciB0aGF0IGludm9rZXMgdGhlIGdpdmVuIGBtYXJrZG93bmxpbnQtY2xpMmAgYmluYXJ5IHBhdGhcbiAqIHdpdGggYGN3ZDogc2NyaXB0RGlyYCBhbmQgbm8gZXhwbGljaXQgZ2xvYnMgKHRoZSBjb25maWcncyBgZ2xvYnNgXG4gKiBmaWVsZCBkcml2ZXMgZmlsZSBzZWxlY3Rpb24pLlxuICpcbiAqIGAtLW5vLWdsb2JzYCBpcyBpbnRlbnRpb25hbGx5IE5PVCBwYXNzZWQg4oCUIG1hcmtkb3dubGludC1jbGkyIHBpY2tzIHVwXG4gKiB0aGUgYGdsb2JzYCBhcnJheSBmcm9tIGAubWFya2Rvd25saW50LWNsaTIuanNvbmNgIGF1dG9tYXRpY2FsbHkgd2hlblxuICogbm8gcG9zaXRpb25hbCBhcmd1bWVudHMgYXJlIHN1cHBsaWVkLiBXaGVuIHRoZSBjb25maWcgaGFzIG5vIGBnbG9ic2AsXG4gKiB0aGUgYmluYXJ5IHByaW50cyBpdHMgaGVscCBzY3JlZW4gYW5kIGV4aXRzIDI7IHJ1bk1hcmtkb3dubGludENoZWNrXG4gKiByZXBvcnRzIHRoYXQgcnVuIGFzIFNLSVBQRUQgKElzc3VlICM0NDM4KS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bk1hcmtkb3dubGludEJpbmFyeShcbiAgYmluYXJ5UGF0aDogc3RyaW5nLFxuICBzY3JpcHREaXI6IHN0cmluZyxcbiAgdGltZW91dE1zOiBudW1iZXIgPSBNQVJLRE9XTkxJTlRfVElNRU9VVF9NUyxcbik6IFByb21pc2U8eyBleGl0Q29kZTogbnVtYmVyOyBzdGRvdXQ6IHN0cmluZzsgc3RkZXJyOiBzdHJpbmcgfT4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBjb21tYW5kT3V0cHV0V2l0aFRpbWVvdXQoYmluYXJ5UGF0aCwge1xuICAgIGFyZ3M6IFtdLFxuICAgIGN3ZDogc2NyaXB0RGlyLFxuICAgIC8vIElzc3VlICMxMjI2OiB0aGUgbGludGVyIGlzIE5vZGUgY29kZSBmcm9tIHRoaXMgcmVwb3NpdG9yeSdzIG93blxuICAgIC8vIGBub2RlX21vZHVsZXNgLCBzbyBhIGNvbXByb21pc2VkIGRlcGVuZGVuY3kgcnVucyBoZXJlLiBJdHNcbiAgICAvLyBlbnZpcm9ubWVudCBpcyBCVUlMVCBmcm9tIHRoZSBhbGxvd2xpc3QgcmF0aGVyIHRoYW4gaW5oZXJpdGVkIOKAlCBub1xuICAgIC8vIGNyZWRlbnRpYWwgaXMgaW4gc2NvcGUgZm9yIGl0IHRvIHJlYWQuXG4gICAgZW52OiBidWlsZFVudHJ1c3RlZENvbW1hbmRFbnYoKSxcbiAgICBjbGVhckVudjogdHJ1ZSxcbiAgICBzdGRvdXQ6IFwicGlwZWRcIixcbiAgICBzdGRlcnI6IFwicGlwZWRcIixcbiAgICB0aW1lb3V0TXMsXG4gIH0pO1xuICByZXR1cm4ge1xuICAgIGV4aXRDb2RlOiByZXN1bHQuY29kZSxcbiAgICBzdGRvdXQ6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyZXN1bHQuc3Rkb3V0KSxcbiAgICBzdGRlcnI6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyZXN1bHQuc3RkZXJyKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFrZUJpbmFyeVJ1bm5lcihiaW5hcnlQYXRoOiBzdHJpbmcpOiBNYXJrZG93bmxpbnRSdW5uZXIge1xuICByZXR1cm4gKHNjcmlwdERpcjogc3RyaW5nKSA9PiBydW5NYXJrZG93bmxpbnRCaW5hcnkoYmluYXJ5UGF0aCwgc2NyaXB0RGlyKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGBiaW5hcnlQYXRoYCBjYW4gYmUgZXhlY3V0ZWQgYXQgYWxsIChJc3N1ZSAjODk0KS5cbiAqXG4gKiBUaGUgcXVlc3Rpb24gaXMgXCJkb2VzIHRoaXMgYmluYXJ5IGV4aXN0IGFuZCBzdGFydFwiLCBub3QgXCJkb2VzIGl0IGV4aXRcbiAqIHplcm9cIi4gVGhvc2Ugd2VyZSBjb25mbGF0ZWQ6IHRoZSBwcm9iZSByYW4gdGhlIGJpbmFyeSB3aXRoIGAtLXZlcnNpb25gIGFuZFxuICogdHJlYXRlZCBhIG5vbi16ZXJvIGV4aXQgYXMgYWJzZW50LiBgbWFya2Rvd25saW50LWNsaTJgIGhhcyBubyBgLS12ZXJzaW9uYFxuICogZmxhZyDigJQgaXQgdHJlYXRzIHRoZSBhcmd1bWVudCBhcyBhICoqZ2xvYioqLCBsaW50cyB0aGUgcmVwb3NpdG9yeSBhZ2FpbnN0XG4gKiBgLm1hcmtkb3dubGludC1jbGkyLmpzb25jYCwgYW5kIGV4aXRzIDEgd2hlbiBpdCBmaW5kcyBhIHZpb2xhdGlvbi5cbiAqXG4gKiBTbyB0aGUgcHJvYmUgZmFpbGVkIHByZWNpc2VseSB3aGVuIHRoZSByZXBvc2l0b3J5IGhhZCBhIE1hcmtkb3duIHZpb2xhdGlvbjpcbiAqIHRoZSBzdGFnZSByZXBvcnRlZCBTS0lQUEVEIGFuZCB0aGUgZ2F0ZSB3ZW50IGdyZWVuIG92ZXIgdGhlIHZlcnkgdGhpbmcgdGhlXG4gKiBzdGFnZSBleGlzdHMgdG8gY2F0Y2gg4oCUIGFic2VuY2Ugb2YgYSBmYWlsdXJlIG1hcmtlciByZXBvcnRlZCBhcyBzdWNjZXNzLlxuICpcbiAqIFNwYXduaW5nIGlzIHRoZSBvbmx5IHNpZ25hbCB0aGF0IGFuc3dlcnMgdGhlIGFjdHVhbCBxdWVzdGlvbi4gQSBtaXNzaW5nIG9yXG4gKiB1bmV4ZWN1dGFibGUgYmluYXJ5IHRocm93czsgb25lIHRoYXQgcnVucyBoYXMgcHJvdmVkIGl0IGV4aXN0cywgd2hhdGV2ZXIgaXRcbiAqIHRoZW4gZGVjaWRlcyBhYm91dCB0aGUgcmVwb3NpdG9yeS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNhblJ1bkJpbmFyeShcbiAgYmluYXJ5UGF0aDogc3RyaW5nLFxuICB0aW1lb3V0TXM6IG51bWJlciA9IE1BUktET1dOTElOVF9QUk9CRV9USU1FT1VUX01TLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgYXdhaXQgY29tbWFuZE91dHB1dFdpdGhUaW1lb3V0KGJpbmFyeVBhdGgsIHtcbiAgICAgIC8vIGAtLWhlbHBgIGlzIGEgbm8tb3AgZm9yIHRoZSBydW5uZXJzIGNvbnNpZGVyZWQgaGVyZSBhbmQg4oCUIHVubGlrZVxuICAgICAgLy8gYC0tdmVyc2lvbmAg4oCUIGNhbm5vdCBiZSBtaXN0YWtlbiBmb3IgYSBnbG9iIGFuZCBsaW50IHRoZSB0cmVlLlxuICAgICAgYXJnczogW1wiLS1oZWxwXCJdLFxuICAgICAgLy8gVGhlIHByb2JlIHN0YXJ0cyB0aGUgc2FtZSB1bnRydXN0ZWQgYmluYXJ5IGFzIHRoZSBydW4sIHNvIGl0IGdldHMgdGhlXG4gICAgICAvLyBzYW1lIGJ1aWx0IGVudmlyb25tZW50IChJc3N1ZSAjMTIyNikuXG4gICAgICBlbnY6IGJ1aWxkVW50cnVzdGVkQ29tbWFuZEVudigpLFxuICAgICAgY2xlYXJFbnY6IHRydWUsXG4gICAgICBzdGRvdXQ6IFwibnVsbFwiLFxuICAgICAgc3RkZXJyOiBcIm51bGxcIixcbiAgICAgIHRpbWVvdXRNcyxcbiAgICB9KTtcbiAgICAvLyBFeGl0IGNvZGUgZGVsaWJlcmF0ZWx5IGlnbm9yZWQ6IGl0IHJlcG9ydHMgd2hhdCB0aGUgYmluYXJ5IHRob3VnaHQgb2ZcbiAgICAvLyBpdHMgYXJndW1lbnRzLCBub3Qgd2hldGhlciB0aGUgYmluYXJ5IGlzIHRoZXJlLlxuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChpc0NvbW1hbmRUaW1lb3V0RXJyb3IoZXJyb3IpKSB0aHJvdyBlcnJvcjtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqXG4gKiBEZXRlY3QgYSB1c2FibGUgYG1hcmtkb3dubGludC1jbGkyYCBpbnZvY2F0aW9uLlxuICpcbiAqIE9yZGVyOlxuICogICAxLiBMb2NhbCBgbm9kZV9tb2R1bGVzLy5iaW4vbWFya2Rvd25saW50LWNsaTJgIChwcm9qZWN0IGluc3RhbGwpLlxuICogICAyLiBgbWFya2Rvd25saW50LWNsaTJgIG9uIFBBVEggKGdsb2JhbCBpbnN0YWxsKS5cbiAqXG4gKiBBdXRvLWluc3RhbGxhdGlvbiB2aWEgYG5weGAgaXMgaW50ZW50aW9uYWxseSBub3QgYXR0ZW1wdGVkIOKAlCB0aGVcbiAqIHdvcmtlciBydW5zIHVuYXR0ZW5kZWQsIHNvIGEgbmV0d29yayByb3VuZC10cmlwIHdvdWxkIGJlIGEgaGlkZGVuXG4gKiBkZXBlbmRlbmN5LiBSZXR1cm5zIG51bGwgd2hlbiBuZWl0aGVyIGluc3RhbGwgbG9jYXRpb24geWllbGRzIGFcbiAqIHdvcmtpbmcgYmluYXJ5LlxuICovXG5leHBvcnQgY29uc3QgZGV0ZWN0TWFya2Rvd25saW50UnVubmVyOiBEZXRlY3RNYXJrZG93bmxpbnRSdW5uZXIgPSBhc3luYyAoXG4gIHNjcmlwdERpcjogc3RyaW5nLFxuKTogUHJvbWlzZTxNYXJrZG93bmxpbnRSdW5uZXIgfCBudWxsPiA9PiB7XG4gIGNvbnN0IGxvY2FsID0gYCR7c2NyaXB0RGlyfS9ub2RlX21vZHVsZXMvLmJpbi9tYXJrZG93bmxpbnQtY2xpMmA7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdCA9IGF3YWl0IERlbm8uc3RhdChsb2NhbCk7XG4gICAgaWYgKHN0YXQuaXNGaWxlICYmIGF3YWl0IGNhblJ1bkJpbmFyeShsb2NhbCkpIHtcbiAgICAgIHJldHVybiBtYWtlQmluYXJ5UnVubmVyKGxvY2FsKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKGlzQ29tbWFuZFRpbWVvdXRFcnJvcihlcnJvcikpIHRocm93IGVycm9yO1xuICAgIC8vIG5vdCBwcmVzZW50IGxvY2FsbHkg4oCUIGZhbGwgdGhyb3VnaCB0byBQQVRIIGxvb2t1cFxuICB9XG5cbiAgaWYgKGF3YWl0IGNhblJ1bkJpbmFyeShcIm1hcmtkb3dubGludC1jbGkyXCIpKSB7XG4gICAgcmV0dXJuIG1ha2VCaW5hcnlSdW5uZXIoXCJtYXJrZG93bmxpbnQtY2xpMlwiKTtcbiAgfVxuXG4gIHJldHVybiBudWxsO1xufTtcblxuLyoqIE9wdGlvbnMgZm9yIHJ1bk1hcmtkb3dubGludENoZWNrIChtb3N0bHkgZm9yIHRlc3RpbmcpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBNYXJrZG93bmxpbnRDaGVja09wdGlvbnMge1xuICAvKiogSW5qZWN0IGEgY3VzdG9tIHJ1bm5lciBkZXRlY3Rvci4gUmV0dXJuaW5nIG51bGwgZm9yY2VzIFNLSVBQRUQuICovXG4gIGRldGVjdFJ1bm5lcj86IERldGVjdE1hcmtkb3dubGludFJ1bm5lcjtcbn1cblxuLyoqXG4gKiBSdW4gdGhlIG1hcmtkb3dubGludCBxdWFsaXR5IGNoZWNrLlxuICpcbiAqIFBpcGVsaW5lOlxuICogICAxLiBEZXRlY3QgYSBtYXJrZG93bmxpbnQtY2xpMiBiaW5hcnkuIFVuYXZhaWxhYmxlIOKGkiBTS0lQUEVELlxuICogICAyLiBJbnZva2UgdGhlIGJpbmFyeSBhZ2FpbnN0IHRoZSByZXBvIChjb25maWcgZHJpdmVzIGdsb2JzKS5cbiAqICAgMy4gUGFyc2UgdmlvbGF0aW9ucyBmcm9tIHN0ZG91dC5cbiAqICAgNC4gUmVwb3J0IFBBU1NFRCwgRkFJTEVEICh3aXRoIHBlci12aW9sYXRpb24gbGluZXMpLCBvciBGQUlMRUQgd2l0aFxuICogICAgICBhIHN5bnRoZXNpc2VkIGVycm9yIGlmIHRoZSBydW5uZXIgZXhpdGVkIG5vbi16ZXJvIGJ1dCBlbWl0dGVkIG5vXG4gKiAgICAgIHBhcnNlYWJsZSB2aW9sYXRpb25zLlxuICogICA1LiBSZXBvcnQgU0tJUFBFRCB3aGVuIHRoZSByZXBvIGNvbmZpZ3VyZXMgbm8gYGdsb2JzYDogdGhlIHJ1biBwcmludGVkXG4gKiAgICAgIG1hcmtkb3dubGludC1jbGkyJ3MgaGVscCBzY3JlZW4sIGV4aXRlZCAyIGFuZCBsaW50ZWQgbm90aGluZ1xuICogICAgICAoSXNzdWUgIzQ0MzgpLiBBIGNvbmZpZyBlcnJvciBleGl0cyAyIHRvbyBidXQgc3RheXMgRkFJTEVELlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuTWFya2Rvd25saW50Q2hlY2soXG4gIHNjcmlwdERpcjogc3RyaW5nLFxuICBvcHRpb25zOiBNYXJrZG93bmxpbnRDaGVja09wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8TWFya2Rvd25saW50Q2hlY2tSZXN1bHQ+IHtcbiAgY29uc3QgZGV0ZWN0ID0gb3B0aW9ucy5kZXRlY3RSdW5uZXIgPz8gZGV0ZWN0TWFya2Rvd25saW50UnVubmVyO1xuICBjb25zdCBydW5uZXIgPSBhd2FpdCBkZXRlY3Qoc2NyaXB0RGlyKTtcbiAgaWYgKHJ1bm5lciA9PT0gbnVsbCkge1xuICAgIGNvbnN0IHJlYXNvbiA9XG4gICAgICBcIm1hcmtkb3dubGludC1jbGkyIG5vdCBhdmFpbGFibGUgKHJ1biBgbnBtIGluc3RhbGwgLWcgbWFya2Rvd25saW50LWNsaTJgIFwiICtcbiAgICAgIFwib3IgYWRkIGl0IHRvIGEgcHJvamVjdCdzIGRldkRlcGVuZGVuY2llcylcIjtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzOiBcIlNLSVBQRURcIixcbiAgICAgIG91dHB1dDogYG1hcmtkb3dubGludDogU0tJUFBFRCAoJHtyZWFzb259KWAsXG4gICAgICB2aW9sYXRpb25zOiBbXSxcbiAgICAgIGZpbGVzQ2hlY2tlZDogMCxcbiAgICAgIHNraXBSZWFzb246IHJlYXNvbixcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgcnVuID0gYXdhaXQgcnVubmVyKHNjcmlwdERpcik7XG4gIGNvbnN0IGNvbWJpbmVkID0gcnVuLnN0ZGVyciA/IGAke3J1bi5zdGRvdXR9XFxuJHtydW4uc3RkZXJyfWAgOiBydW4uc3Rkb3V0O1xuICAvLyBtYXJrZG93bmxpbnQtY2xpMiB2MC4yNC4wIHdyaXRlcyB2aW9sYXRpb24gbGluZXMgdG8gU1RERVJSIGFuZCB0aGVcbiAgLy8gYExpbnRpbmc6YCAvIGBTdW1tYXJ5OmAgaGVhZGVyIHRvIFNURE9VVCwgc28gdmlvbGF0aW9ucyBhcmUgcGFyc2VkIGZyb21cbiAgLy8gYm90aCBzdHJlYW1zLiBUaGUgZmlsZSBjb3VudCBzdGF5cyBvbiBzdGRvdXQuIFdhcm5pbmctc2V2ZXJpdHkgbGluZXMgYXJlXG4gIC8vIGRyb3BwZWQ6IHRoZSBiaW5hcnkgZXhpdHMgMCBvbiB3YXJuaW5ncyBhbG9uZSwgYW5kIHRoZSBnYXRlIGZvbGxvd3MgdGhhdFxuICAvLyB2ZXJkaWN0IChQUiAjNDQ1MyByZXZpZXcpLlxuICBjb25zdCB2aW9sYXRpb25zID0gcGFyc2VNYXJrZG93bmxpbnRFcnJvcnMoY29tYmluZWQpO1xuICBjb25zdCBmaWxlc0NoZWNrZWQgPSBleHRyYWN0RmlsZXNDaGVja2VkKHJ1bi5zdGRvdXQpO1xuXG4gIGlmIChydW4uZXhpdENvZGUgPT09IDAgJiYgdmlvbGF0aW9ucy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzOiBcIlBBU1NFRFwiLFxuICAgICAgb3V0cHV0OiBgbWFya2Rvd25saW50OiBQQVNTRUQgKCR7ZmlsZXNDaGVja2VkfSBmaWxlKHMpIGNoZWNrZWQpYCxcbiAgICAgIHZpb2xhdGlvbnM6IFtdLFxuICAgICAgZmlsZXNDaGVja2VkLFxuICAgIH07XG4gIH1cblxuICBpZiAoaXNOb0dsb2JzSGVscFJ1bihydW4pKSB7XG4gICAgY29uc3QgcmVhc29uID1cbiAgICAgIFwibm8gbWFya2Rvd24gZ2xvYnMgY29uZmlndXJlZDogbWFya2Rvd25saW50LWNsaTIgcHJpbnRlZCBpdHMgaGVscCBhbmQgXCIgK1xuICAgICAgXCJsaW50ZWQgbm90aGluZyDigJQgYWRkIGEgYGdsb2JzYCBhcnJheSB0byAubWFya2Rvd25saW50LWNsaTIuanNvbmMgdG8gXCIgK1xuICAgICAgXCJlbmFibGUgdGhpcyBjaGVja1wiO1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXM6IFwiU0tJUFBFRFwiLFxuICAgICAgb3V0cHV0OiBgbWFya2Rvd25saW50OiBTS0lQUEVEICgke3JlYXNvbn0pYCxcbiAgICAgIHZpb2xhdGlvbnM6IFtdLFxuICAgICAgZmlsZXNDaGVja2VkOiAwLFxuICAgICAgc2tpcFJlYXNvbjogcmVhc29uLFxuICAgIH07XG4gIH1cblxuICBpZiAodmlvbGF0aW9ucy5sZW5ndGggPT09IDApIHtcbiAgICAvLyBSdW5uZXIgZGllZCAoZS5nLiBjb25maWcgZXJyb3IpIHdpdGhvdXQgZW1pdHRpbmcgYW55IHBhcnNlYWJsZVxuICAgIC8vIHZpb2xhdGlvbiBsaW5lcyDigJQgc3VyZmFjZSB0aGUgcmF3IHN0ZGVyciBzbyB0aGUgZmFpbHVyZSBkb2VzIG5vdFxuICAgIC8vIGRpc2FwcGVhciBzaWxlbnRseS4gQSBjb25maWcgZXJyb3IgcHJpbnRzIGl0cyBgRXJyb3I6YCBsaW5lIHRvIFNURE9VVCxcbiAgICAvLyBzbyB3aXRoIGVtcHR5IHN0ZGVyciBmYWxsIGJhY2sgdG8gdGhhdCBsaW5lIGJlZm9yZSB0aGUgZ2VuZXJpYyBleGl0IGNvZGUuXG4gICAgY29uc3Qgc3Rkb3V0RXJyb3IgPSAvXkVycm9yOlteXFxuXSovbS5leGVjKHJ1bi5zdGRvdXQpPy5bMF0udHJpbSgpO1xuICAgIGNvbnN0IGRldGFpbCA9IHJ1bi5zdGRlcnIudHJpbSgpIHx8XG4gICAgICBzdGRvdXRFcnJvciB8fFxuICAgICAgYG1hcmtkb3dubGludC1jbGkyIGV4aXRlZCB3aXRoIGNvZGUgJHtydW4uZXhpdENvZGV9YDtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzOiBcIkZBSUxFRFwiLFxuICAgICAgb3V0cHV0OiBbXG4gICAgICAgIFwibWFya2Rvd25saW50OiBGQUlMRURcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgZGV0YWlsLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgdmlvbGF0aW9uczogW10sXG4gICAgICBmaWxlc0NoZWNrZWQsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHZpb2xhdGlvbkxpbmVzID0gdmlvbGF0aW9ucy5tYXAoKHYpID0+XG4gICAgYCAgJHt2LmZpbGV9OiR7di5saW5lfSR7di5jb2x1bW4gIT09IHVuZGVmaW5lZCA/IGA6JHt2LmNvbHVtbn1gIDogXCJcIn0gYCArXG4gICAgYCR7di5ydWxlfSAke3YubWVzc2FnZX1gXG4gICk7XG4gIGNvbnN0IGxpbmVzID0gW1xuICAgIGBtYXJrZG93bmxpbnQ6IEZBSUxFRCAoJHt2aW9sYXRpb25zLmxlbmd0aH0gdmlvbGF0aW9uKHMpIGluICR7ZmlsZXNDaGVja2VkfSBmaWxlKHMpIGNoZWNrZWQpYCxcbiAgICBcIlwiLFxuICAgIFwiTWFya2Rvd24gc3RydWN0dXJhbCB2aW9sYXRpb25zOlwiLFxuICAgIC4uLnZpb2xhdGlvbkxpbmVzLFxuICAgIFwiXCIsXG4gICAgXCJSdWxlIHNlbGVjdGlvbiBsaXZlcyBpbiBgLm1hcmtkb3dubGludC1jbGkyLmpzb25jYCBhdCB0aGUgcmVwbyByb290IFwiICtcbiAgICBcIihJc3N1ZSAjMTY4NSkuIEZpeCB0aGUgb2ZmZW5kaW5nIG1hcmt1cCBvciwgaWYgdGhlIHJ1bGUgZG9lcyBub3QgXCIgK1xuICAgIFwiZml0IHRoZSBwcm9qZWN0LCBwcm9wb3NlIGEgcnVsZSBjaGFuZ2UgaW4gYSBmb2xsb3ctdXAuXCIsXG4gIF07XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0dXM6IFwiRkFJTEVEXCIsXG4gICAgb3V0cHV0OiBsaW5lcy5qb2luKFwiXFxuXCIpLFxuICAgIHZpb2xhdGlvbnMsXG4gICAgZmlsZXNDaGVja2VkLFxuICAgIHNraXBSZWFzb246IGNvbWJpbmVkLmluY2x1ZGVzKFwibm90IGF2YWlsYWJsZVwiKSA/IGNvbWJpbmVkIDogdW5kZWZpbmVkLFxuICB9O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FxQkMsR0FFRCxTQUNFLHdCQUF3QixFQUN4QixxQkFBcUIsUUFDaEIsMEJBQTBCO0FBQ2pDLFNBQVMsd0JBQXdCLFFBQVEsNkJBQTZCO0FBRXRFLDREQUE0RCxHQUM1RCxNQUFNLDBCQUEwQixLQUFLLEtBQUs7QUFFMUMsK0RBQStELEdBQy9ELE1BQU0sZ0NBQWdDO0FBdUR0Qzs7Ozs7Ozs7O0NBU0MsR0FDRCxNQUFNLG9CQUNKO0FBRUY7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVMsd0JBQ2QsTUFBYztFQUVkLE1BQU0sYUFBc0MsRUFBRTtFQUM5QyxLQUFLLE1BQU0sV0FBVyxPQUFPLEtBQUssQ0FBQyxNQUFPO0lBQ3hDLE1BQU0sT0FBTyxRQUFRLE9BQU87SUFDNUIsSUFBSSxDQUFDLE1BQU07SUFDWCxNQUFNLFFBQVEsa0JBQWtCLElBQUksQ0FBQztJQUNyQyxJQUFJLENBQUMsT0FBTztJQUNaLE1BQU0sR0FBRyxNQUFNLFNBQVMsUUFBUSxNQUFNLFFBQVEsR0FBRztJQUNqRCx5RUFBeUU7SUFDekUsaUVBQWlFO0lBQ2pFLDBFQUEwRTtJQUMxRSw0RUFBNEU7SUFDNUUsSUFBSSxTQUFTLGFBQWEsWUFBWSxhQUFhLFNBQVMsV0FBVztNQUNyRTtJQUNGO0lBQ0EsTUFBTSxZQUFtQztNQUN2QztNQUNBLE1BQU0sT0FBTyxRQUFRLENB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
// denoCacheMetadata=7296802589212889567,13104782917824913545