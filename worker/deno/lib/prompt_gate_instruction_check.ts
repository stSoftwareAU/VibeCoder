/**
 * Gate: no prompt template may order an unconditional quality-gate run
 * (Issue #1138).
 *
 * The full gate is the most expensive thing an agent can start — a median of
 * 17 minutes across 407 observations, inside a run budget of roughly an hour.
 * Eight prompt files used to tell the agent to run it before pushing, several
 * as a hard gate, and one of them permitted three fix-and-rerun cycles: 45
 * minutes of a 60-minute budget before any work. The instruction was not
 * affordable inside the budget it was given.
 *
 * The rule this check holds is not "never run the gate". It is that the
 * instruction to run it comes from ONE place — `buildQualityInstructions`
 * (`repo_config.ts`), spliced into each template through its
 * `{{QUALITY_INSTRUCTIONS}}` placeholder — which weighs it against the
 * remaining run budget and tells the agent how to record a skip. A template
 * that hard-codes its own "run `./quality.sh` before pushing" bypasses that
 * decision, which is exactly the drift Issue #1138 measured.
 *
 * Pure scanning functions over literal text, so they are tested behaviourally
 * rather than by grepping the prompts they guard.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** One hard-coded gate instruction found in a prompt template. */
export interface GateInstructionViolation {
  /** Path as supplied to the scanner. */
  file: string;
  /** 1-based line number of the offending instruction. */
  line: number;
  /** Trimmed text of the offending line. */
  text: string;
}

/** Result of scanning a directory of prompt templates. */
export interface GateInstructionScanResult {
  violations: GateInstructionViolation[];
  filesScanned: number;
}

/**
 * Templates permitted to carry gate wording of their own, each with the
 * reason it is legitimate.
 *
 * Every entry here analyses SOMEONE ELSE'S gate — the audit prompts read a
 * target repository's CI workflow and its committed gate script — so their
 * mentions are the object of the analysis, not an instruction to spend this
 * run's budget. The issue and coding-guidelines templates carry the agent's
 * own gate rules and are the surface the placeholder is spliced into.
 */
export const GATE_INSTRUCTION_ALLOWLIST: ReadonlySet<string> = new Set([
  // Reads a target repo's CI workflow and its gate script to judge whether
  // the formatter is enforced there.
  "format_drift/prompt.md",
  // Audits whether a repo's committed bash gate script runs in CI.
  "bash_syntax_audit/prompt.md",
  // Audits a repo's GitHub Actions workflows, gate steps included.
  "github_actions_audit/prompt.md",
]);

/**
 * How a template can name the gate: the script itself, or the phrase a
 * template uses when it does not want to hard-code the command.
 * `merge_conflict` said "the repository's quality gate" and slipped past a
 * check that only knew the script's name.
 */
const GATE_NAME = String
  .raw`(?:(?:\.\/)?quality\.sh|(?:full |repository's |repo's )?quality gate)`;

/** Instruction to run the gate: an imperative verb reaching the gate name. */
const RUN_GATE_RE = new RegExp(
  String.raw`\b(?:run|re-?run|execute|invoke)\b[^\n]{0,60}?${GATE_NAME}`,
  "i",
);

/**
 * A requirement that the gate has passed — a gate order by another name.
 *
 * Deliberately narrower than "names the gate near the word pass": prose
 * *about* the gate ("a green quality gate is the signal to stop") is not an
 * instruction to spend the budget on one, and flagging it would push
 * templates into vaguer language rather than better behaviour.
 */
const GATE_PASSED_RE = new RegExp(
  String
    .raw`(?:must|confirm|ensure|make sure|verify)\b[^\n]{0,60}?${GATE_NAME}` +
    String
      .raw`|${GATE_NAME}[^\n]{0,60}?\b(?:passed locally|must pass|returns zero errors)`,
  "i",
);

/**
 * Wording that makes the instruction conditional on the run budget.
 *
 * A line carrying one of these is the budget-aware instruction this check
 * exists to protect, not the unconditional one it exists to catch.
 */
const QUALIFIED_RE = /budget|\.vibe-run-budget\.md|\bskip(?:ped|s|ping)?\b/i;

/**
 * Find every hard-coded gate instruction in one prompt template.
 *
 * Fenced code blocks are ignored: a fence is an example of output or of
 * another repository's script, never an instruction this run must obey.
 *
 * Prompt Markdown is hard-wrapped, so an instruction can straddle a newline:
 * "Run the repository's\nquality gate on the merged result" is one order and
 * neither half of it matches. Each line is therefore also tested joined to the
 * one before it — but only counted when the match genuinely *spans* the break
 * (neither line offends alone), so a clean line is never condemned for its
 * neighbour's words. A wrapped instruction is reported against its second
 * line, the one that completes it.
 *
 * @param file - Path reported in each violation.
 * @param source - The template's full text.
 * @returns One entry per offending line, in source order.
 */
export function findUnconditionalGateInstructions(
  file: string,
  source: string,
): GateInstructionViolation[] {
  const violations: GateInstructionViolation[] = [];
  let inFence = false;

  const lines = source.split("\n");
  let previous = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      previous = "";
      continue;
    }
    if (inFence) continue;

    const joined = `${previous} ${line}`.trim();
    previous = line;

    // A qualifier anywhere in the instruction excuses it, wrap included.
    if (QUALIFIED_RE.test(joined)) continue;
    // The match must live on this line, or span onto it from the one before.
    if (
      !offends(line) && !(offends(joined) && !offends(lines[index - 1] ?? ""))
    ) {
      continue;
    }

    violations.push({ file, line: index + 1, text: line.trim() });
  }
  return violations;
}

/** True when the text orders the gate or asserts it passed. */
function offends(text: string): boolean {
  return RUN_GATE_RE.test(text) || GATE_PASSED_RE.test(text);
}

/**
 * Scan every `prompt.md` under a prompts directory.
 *
 * @param promptsDir - Absolute path to the prompts directory.
 * @returns Violations across all non-allowlisted templates, and how many
 *   files were read — "nothing found" and "nothing scanned" are different
 *   failures, and only the count tells them apart.
 */
export async function scanPromptsForUnconditionalGate(
  promptsDir: string,
): Promise<GateInstructionScanResult> {
  const violations: GateInstructionViolation[] = [];
  let filesScanned = 0;

  for await (const entry of Deno.readDir(promptsDir)) {
    if (!entry.isDirectory) continue;
    const relative = `${entry.name}/prompt.md`;
    if (GATE_INSTRUCTION_ALLOWLIST.has(relative)) continue;

    let source: string;
    try {
      source = await Deno.readTextFile(`${promptsDir}/${relative}`);
    } catch (err) {
      // A prompt type without a template is not this check's business. Any
      // other read failure is: a template this check cannot read is a
      // template it cannot clear, and reporting green over it is the silent
      // pass this gate exists to prevent.
      if (err instanceof Deno.errors.NotFound) continue;
      throw err;
    }
    filesScanned++;
    violations.push(...findUnconditionalGateInstructions(relative, source));
  }

  violations.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)
  );
  return { violations, filesScanned };
}

/** Operator-facing explanation of a batch of violations. */
export function formatGateInstructionFailure(
  result: GateInstructionScanResult,
): string {
  return [
    ...result.violations.map((v) =>
      `VIOLATION: ${v.file}:${v.line}: ${v.text}`
    ),
    "",
    "A prompt template is ordering the full quality gate on its own account",
    "(Issue #1138). The gate takes ~17 minutes of a ~60-minute run budget, so",
    "the decision to run it belongs to buildQualityInstructions() in",
    "worker/deno/lib/repo_config.ts, spliced in through the template's",
    "{{QUALITY_INSTRUCTIONS}} placeholder — it weighs the gate against the",
    "budget left and tells the agent how to record a skip. Point the template",
    "at that placeholder instead of naming the gate command itself.",
  ].join("\n");
}
