/**
 * Quality guard: the model-agnostic instruction documents must not name a
 * model generation (Issue #371).
 *
 * `CODING-STANDARDS.md` is deliberately model-generation-agnostic — which
 * model runs which phase, the fallback self-heal, and every
 * generation-specific prompt tuning belong in
 * `docs/MODEL-AND-CACHING.md`, the single source of truth. A model name
 * copied back into the standards duplicates that routing and goes stale the
 * moment routing changes, so this check fails loudly when one reappears.
 *
 * The pattern is the enforceable form of the acceptance grep:
 * `grep -inE 'opus|fable|sonnet|haiku|claude-[0-9]'`, tightened with word
 * boundaries so an unrelated word that merely contains one of the names is
 * not flagged.
 *
 * The rule is enforced by this repository's own Deno test
 * (`worker/deno/tests/coding_standards_model_agnostic_test.ts`), deliberately
 * *not* by a shared quality-gate check: the gate runs against every monitored
 * repository, and another repo's `CODING-STANDARDS.md` may legitimately name a
 * model. Repository isolation means this standard is enforced where it lives.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** Status of the model-agnostic docs check. */
export type ModelAgnosticDocsStatus = "PASSED" | "SKIPPED" | "FAILED";

/** A single model-generation name found in a model-agnostic document. */
export interface ModelGenerationNameHit {
  /** Relative path of the offending file. */
  file: string;
  /** 1-based line number of the offending name. */
  line: number;
  /** The matched text, exactly as written (e.g. `Opus 5` → `Opus`). */
  name: string;
  /** The raw line content for context. */
  content: string;
}

/** Structured result of the model-agnostic docs check. */
export interface ModelAgnosticDocsResult {
  status: ModelAgnosticDocsStatus;
  /** Human-readable output for the quality gate summary. */
  output: string;
  /** All hits found (empty when status is PASSED). */
  hits: ModelGenerationNameHit[];
  /** Number of files scanned. */
  filesScanned: number;
}

/**
 * Model-generation names and model ids that must not appear in a
 * model-agnostic document: the `opus|fable|sonnet|haiku` family and
 * `claude-<digit>` model ids.
 */
const MODEL_GENERATION_PATTERN =
  /\b(?:opus|fable|sonnet|haiku)\b|\bclaude-\d/gi;

/**
 * Documents that must stay model-generation-agnostic, relative to the
 * repository root.
 */
export const MODEL_AGNOSTIC_DOCS = ["CODING-STANDARDS.md"];

/**
 * Find every model-generation name in a document's content.
 *
 * Exposed for unit-testing the matching logic in isolation from the
 * filesystem.
 */
export function findModelGenerationNames(
  relPath: string,
  content: string,
): ModelGenerationNameHit[] {
  const hits: ModelGenerationNameHit[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    MODEL_GENERATION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MODEL_GENERATION_PATTERN.exec(line)) !== null) {
      hits.push({
        file: relPath,
        line: i + 1,
        name: match[0],
        content: line.trim(),
      });
    }
  }

  return hits;
}

/**
 * Run the model-agnostic docs check across the repository.
 *
 * SKIPPED when none of the documents are present (e.g. invoked on a
 * non-VibeCoder repo); PASSED when no model-generation name is found;
 * FAILED with the offending lines otherwise.
 */
export async function runModelAgnosticDocsCheck(
  rootDir: string,
): Promise<ModelAgnosticDocsResult> {
  const hits: ModelGenerationNameHit[] = [];
  let filesScanned = 0;

  for (const relPath of MODEL_AGNOSTIC_DOCS) {
    let content: string;
    try {
      content = await Deno.readTextFile(`${rootDir}/${relPath}`);
    } catch {
      continue;
    }
    filesScanned++;
    hits.push(...findModelGenerationNames(relPath, content));
  }

  if (filesScanned === 0) {
    return {
      status: "SKIPPED",
      output:
        "model-agnostic docs: SKIPPED (no model-agnostic documents found)",
      hits: [],
      filesScanned: 0,
    };
  }

  if (hits.length === 0) {
    return {
      status: "PASSED",
      output: `model-agnostic docs: PASSED (${filesScanned} file(s) checked)`,
      hits: [],
      filesScanned,
    };
  }

  const lines = [
    `model-agnostic docs: FAILED (${hits.length} model-generation name(s) in ${filesScanned} file(s) scanned)`,
    "",
    "These documents are model-generation-agnostic by design. Describe the",
    "routing chain, the fallback self-heal, and any generation-specific",
    "tuning in docs/MODEL-AND-CACHING.md and link to it instead.",
    "",
    ...hits.map((h) => `  ${h.file}:${h.line} names "${h.name}": ${h.content}`),
  ];

  return {
    status: "FAILED",
    output: lines.join("\n"),
    hits,
    filesScanned,
  };
}
